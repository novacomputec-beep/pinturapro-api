// Versões do app (aviso de atualização) — leitura, registro do que os aparelhos reportam e a
// promoção automática da versão "atual".
//
// CONFIG (tabela configuracoes, semeada na migração de boot em routes/index.js):
//   versao_app_minima_<plataforma>  abaixo dela o app OBRIGA a atualizar — sempre MANUAL.
//   versao_app_atual_<plataforma>   a publicada na loja (aviso opcional) — sobe SOZINHA (abaixo)
//                                   ou pelo painel; nunca é rebaixada automaticamente.
//   versao_app_min_usuarios         N: usuários distintos (não testadores) numa versão maior
//                                   que a atual para ela virar a atual. Padrão 3.
//   versao_app_testadores           e-mails (minúsculos, separados por vírgula) que NÃO contam
//                                   para N — além de toda conta admin/aprovador.
//   versoes_obrigatorias_<plataforma> JSON de versões (['1.1.3', ...]) que, uma vez ALCANÇADAS
//                                   pela atual, viram a minima: depois de cada promoção (e uma
//                                   vez no boot, e ao editar a lista pelo painel) a minima sobe
//                                   para a MAIOR versão da lista que seja <= atual. Só sobe.
//
// REGISTRO: toda requisição AUTENTICADA que traga X-App-Version e X-App-Platform deixa uma linha
// em versoes_app_vistas (usuario, plataforma, versao) — UPSERT fire-and-forget, fora do caminho
// da resposta, com dedupe em memória por processo (a mesma tripla volta ao banco no máximo uma
// vez por DEDUPE_MS). Header ausente/inválido é ignorado em silêncio. Nada aqui lança para a
// requisição: erro de banco vira UMA linha de log.
//
// PROMOÇÃO (cron de 5 min, promoverVersaoAtual): por plataforma, conta usuários distintos não
// testadores por versão MAIOR que a atual; a MAIOR versão com contagem >= N vira a atual. O
// UPDATE só sobe (WHERE valor < nova), então duas réplicas/tiques nunca rebaixam.
//
// Versão = N[.N[.N]] (como o endpoint sempre aceitou), normalizada para 3 partes ('1.2' → '1.2.0')
// no registro e no config, para a comparação em SQL (string_to_array(...)::int[]) ser consistente.
const { pool } = require('./supabase')

const PLATAFORMAS = ['android', 'ios']
const RE_VERSAO = /^\d{1,6}(\.\d{1,6}){0,2}$/
const VERSAO_ZERO = '0.0.0'
const MIN_USUARIOS_PADRAO = 3
const CHAVE_MIN_USUARIOS = 'versao_app_min_usuarios'
const CHAVE_TESTADORES = 'versao_app_testadores'
const chaveVersao = (tipo, plataforma) => `versao_app_${tipo}_${plataforma}`
const chaveObrigatorias = (plataforma) => `versoes_obrigatorias_${plataforma}`
// Piso da lista de obrigatórias: semente no primeiro boot e, nos seguintes, UNIDA à lista
// gravada (routes/index.js) — uma versão daqui nunca some da lista pelo painel, mas o painel
// pode acrescentar outras. A 1.1.3 já era a minima do Android; a 1.1.4 entrou em 2026-10-26.
const OBRIGATORIAS_PADRAO = ['1.1.3', '1.1.4']

const normalizarVersao = (v) => {
  const s = String(v ?? '').trim()
  if (!RE_VERSAO.test(s)) return null
  const partes = s.split('.').map(p => String(Number(p)))
  while (partes.length < 3) partes.push('0')
  return partes.join('.')
}
// -1 / 0 / 1 como comparador numérico por parte. Entradas já normalizadas.
const compararVersoes = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}
const normalizarPlataforma = (p) => {
  const s = String(p ?? '').trim().toLowerCase()
  return PLATAFORMAS.includes(s) ? s : null
}
const normalizarTestadores = (lista) => {
  const bruto = Array.isArray(lista) ? lista : String(lista ?? '').split(/[,\s;]+/)
  return [...new Set(bruto.map(e => String(e ?? '').trim().toLowerCase()).filter(e => e.includes('@')))]
}
// Lista de versões (array, ou texto separado por vírgula/espaço) → normalizada, sem repetição,
// crescente. null se algum item não for versão válida (o chamador decide o 400).
const normalizarListaVersoes = (lista) => {
  const bruto = Array.isArray(lista) ? lista : String(lista ?? '').split(/[,\s;]+/).filter(Boolean)
  const normalizadas = bruto.map(normalizarVersao)
  if (normalizadas.some(v => v === null)) return null
  return [...new Set(normalizadas)].sort(compararVersoes)
}
// JSON gravado em configuracoes → lista normalizada; lixo ou ausência viram [] (nunca lança).
const lerListaVersoes = (texto) => {
  try { return normalizarListaVersoes(JSON.parse(texto)) || [] } catch { return [] }
}
// Maior versão da lista de obrigatórias que a atual já alcançou (<= atual), ou null.
const minimaObrigatoriaPara = (obrigatorias, atual) =>
  obrigatorias.filter(v => compararVersoes(v, atual) <= 0).pop() || null
// Expressão SQL que compara uma coluna/valor de versão como int[] (lexicográfico por parte).
const SQL_VERSAO_INT = (expr) => `string_to_array(${expr}, '.')::int[]`

// ---------- registro (caminho quente) ----------
const DEDUPE_MS = 6 * 60 * 60 * 1000
const MAX_CHAVES_DEDUPE = 20000
const vistos = new Map()
let erroLogado = 0
const podarVistos = (agora) => {
  for (const [k, t] of vistos) if (agora - t > DEDUPE_MS) vistos.delete(k)
}
const registrarVersaoVista = (req) => {
  const usuarioId = req.usuario?.id
  if (!usuarioId) return
  const plataforma = normalizarPlataforma(req.get('x-app-platform'))
  const versao = normalizarVersao(req.get('x-app-version'))
  if (!plataforma || !versao) return
  const chave = `${usuarioId}:${plataforma}:${versao}`
  const agora = Date.now()
  const ultimo = vistos.get(chave)
  if (ultimo && agora - ultimo < DEDUPE_MS) return
  if (!ultimo && vistos.size >= MAX_CHAVES_DEDUPE) {
    podarVistos(agora)
    if (vistos.size >= MAX_CHAVES_DEDUPE) return // teto: não registra, não acumula
  }
  vistos.set(chave, agora)
  pool.query(
    `INSERT INTO versoes_app_vistas (usuario_id, plataforma, versao)
     VALUES ($1, $2, $3)
     ON CONFLICT (usuario_id, plataforma, versao) DO UPDATE SET ultimo_em = NOW()`,
    [usuarioId, plataforma, versao]
  ).catch(err => {
    vistos.delete(chave) // deixa tentar de novo na próxima requisição
    if (erroLogado++ % 100 === 0) console.error('[VersaoApp] registro falhou:', err.message)
  })
}

// ---------- config ----------
const lerConfigVersao = async (db = pool) => {
  const r = await db.query(`SELECT chave, valor FROM configuracoes WHERE chave LIKE 'versao_app_%' OR chave LIKE 'versoes_obrigatorias_%'`)
  const mapa = Object.fromEntries(r.rows.map(x => [x.chave, x.valor]))
  const n = Number(mapa[CHAVE_MIN_USUARIOS])
  const saida = {
    min_usuarios: Number.isInteger(n) && n > 0 ? n : MIN_USUARIOS_PADRAO,
    testadores: normalizarTestadores(mapa[CHAVE_TESTADORES]),
  }
  for (const p of PLATAFORMAS) {
    saida[p] = {
      minima: normalizarVersao(mapa[chaveVersao('minima', p)]) || VERSAO_ZERO,
      atual:  normalizarVersao(mapa[chaveVersao('atual', p)])  || VERSAO_ZERO,
      obrigatorias: lerListaVersoes(mapa[chaveObrigatorias(p)]),
    }
  }
  return saida
}

// Sobe a minima de cada plataforma pedida para a maior obrigatória <= atual. Só sobe
// (WHERE valor < nova), então réplicas, boots repetidos e listas editadas para baixo nunca
// rebaixam uma minima já gravada. Devolve [{ plataforma, de, para }] do que subiu.
const aplicarMinimaObrigatoria = async (db = pool, plataformas = PLATAFORMAS) => {
  const cfg = await lerConfigVersao(db)
  const subidas = []
  for (const p of plataformas) {
    const nova = minimaObrigatoriaPara(cfg[p].obrigatorias, cfg[p].atual)
    if (!nova || compararVersoes(nova, cfg[p].minima) <= 0) continue
    const upd = await db.query(
      `UPDATE configuracoes SET valor = $2, atualizado_em = NOW()
        WHERE chave = $1 AND ${SQL_VERSAO_INT('valor')} < ${SQL_VERSAO_INT('$2::text')}`,
      [chaveVersao('minima', p), nova]
    )
    if (upd.rowCount > 0) {
      subidas.push({ plataforma: p, de: cfg[p].minima, para: nova })
      console.log(`[VersaoApp] ${p}: minima ${cfg[p].minima} → ${nova} (obrigatória alcançada pela atual ${cfg[p].atual})`)
    }
  }
  if (subidas.length > 0) invalidarCacheVersoes()
  return subidas
}

// Painel: por plataforma, usuários ATIVOS distintos (usuarios.ativo) na versão mais recente
// que cada um reportou (versoes_app_vistas, última por ultimo_em), partidos em >= minima e
// < minima. Lê o mesmo registro que a promoção automática. Só exibição: ignora desinstalação
// provável (regra do painel, utils/desinstalacoes) — candidatosPromocao, que decide a promoção,
// não muda.
const contarUsuariosPorMinima = async (db = pool, cfg) => {
  const saida = {}
  for (const p of PLATAFORMAS) {
    const r = await db.query(
      `WITH ultima AS (
         SELECT DISTINCT ON (v.usuario_id) v.usuario_id, v.versao
           FROM versoes_app_vistas v JOIN usuarios u ON u.id = v.usuario_id
          WHERE v.plataforma = $1 AND u.ativo = true AND u.desinstalado_em IS NULL
          ORDER BY v.usuario_id, v.ultimo_em DESC)
       SELECT count(*) FILTER (WHERE ${SQL_VERSAO_INT('versao')} >= ${SQL_VERSAO_INT('$2::text')})::int AS na_minima_ou_acima,
              count(*) FILTER (WHERE ${SQL_VERSAO_INT('versao')} <  ${SQL_VERSAO_INT('$2::text')})::int AS abaixo_da_minima
         FROM ultima`,
      [p, cfg[p].minima]
    )
    saida[p] = r.rows[0]
  }
  return saida
}

// Público do GET /config/versao-app (pré-login): cache curto por processo — uma leitura por
// abertura de app seria uma consulta por launch à toa. A promoção vale em até CACHE_MS.
const CACHE_MS = 60 * 1000
let cache = { em: 0, valor: null }
const versoesPublicas = async () => {
  const agora = Date.now()
  if (cache.valor && agora - cache.em < CACHE_MS) return cache.valor
  const cfg = await lerConfigVersao()
  const valor = {}
  for (const p of PLATAFORMAS) valor[p] = { minima: cfg[p].minima, atual: cfg[p].atual }
  cache = { em: agora, valor }
  return valor
}
const invalidarCacheVersoes = () => { cache = { em: 0, valor: null } }

// Grava uma chave (UPSERT) — usado pelo painel. Devolve o valor gravado.
const gravarConfig = (db, chave, valor) => db.query(
  `INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)
   ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`,
  [chave, valor]
)

// Candidatas à promoção por plataforma: versões > atual com nº de usuários distintos NÃO
// testadores (role fora de admin/aprovador e e-mail fora da lista). `vencedora` = a maior com
// contagem >= N, ou null. Serve ao cron, ao painel (prévia) e ao dry-run.
const candidatosPromocao = async (db = pool) => {
  const cfg = await lerConfigVersao(db)
  const saida = { min_usuarios: cfg.min_usuarios, testadores: cfg.testadores }
  for (const p of PLATAFORMAS) {
    const r = await db.query(
      `SELECT v.versao, count(DISTINCT v.usuario_id)::int AS usuarios
         FROM versoes_app_vistas v JOIN usuarios u ON u.id = v.usuario_id
        WHERE v.plataforma = $1
          AND ${SQL_VERSAO_INT('v.versao')} > ${SQL_VERSAO_INT('$2::text')}
          AND u.role NOT IN ('admin', 'aprovador')
          AND lower(btrim(u.email)) <> ALL($3::text[])
        GROUP BY v.versao
        ORDER BY ${SQL_VERSAO_INT('v.versao')} DESC`,
      [p, cfg[p].atual, cfg.testadores]
    )
    const vencedora = r.rows.find(x => x.usuarios >= cfg.min_usuarios)?.versao || null
    saida[p] = { atual: cfg[p].atual, minima: cfg[p].minima, obrigatorias: cfg[p].obrigatorias, candidatas: r.rows, vencedora }
  }
  return saida
}

// Sobe a atual de cada plataforma para a vencedora, se houver. Só sobe (WHERE valor < nova).
const promoverVersaoAtual = async (db = pool) => {
  const prev = await candidatosPromocao(db)
  const promovidas = []
  for (const p of PLATAFORMAS) {
    const nova = prev[p].vencedora
    if (!nova) continue
    const upd = await db.query(
      `UPDATE configuracoes SET valor = $2, atualizado_em = NOW()
        WHERE chave = $1 AND ${SQL_VERSAO_INT('valor')} < ${SQL_VERSAO_INT('$2::text')}
    RETURNING valor`,
      [chaveVersao('atual', p), nova]
    )
    if (upd.rowCount > 0) {
      promovidas.push({ plataforma: p, de: prev[p].atual, para: nova })
      console.log(`[VersaoApp] ${p}: atual ${prev[p].atual} → ${nova} (${prev[p].candidatas.find(c => c.versao === nova)?.usuarios} usuário(s) não testadores, N=${prev.min_usuarios})`)
    }
  }
  if (promovidas.length > 0) {
    invalidarCacheVersoes()
    // A atual subiu: se alcançou uma versão obrigatória, a minima dessa plataforma sobe junto.
    await aplicarMinimaObrigatoria(db, promovidas.map(x => x.plataforma))
  }
  return promovidas
}
const cronPromoverVersaoAtual = async () => {
  try { await promoverVersaoAtual() } catch (err) { console.error('[VersaoApp] promoção falhou:', err.message) }
}

module.exports = {
  PLATAFORMAS, VERSAO_ZERO, MIN_USUARIOS_PADRAO, CHAVE_MIN_USUARIOS, CHAVE_TESTADORES, chaveVersao,
  chaveObrigatorias, OBRIGATORIAS_PADRAO,
  normalizarVersao, compararVersoes, normalizarPlataforma, normalizarTestadores, SQL_VERSAO_INT,
  normalizarListaVersoes, lerListaVersoes, minimaObrigatoriaPara,
  registrarVersaoVista, lerConfigVersao, versoesPublicas, invalidarCacheVersoes, gravarConfig,
  aplicarMinimaObrigatoria, contarUsuariosPorMinima,
  candidatosPromocao, promoverVersaoAtual, cronPromoverVersaoAtual,
}
