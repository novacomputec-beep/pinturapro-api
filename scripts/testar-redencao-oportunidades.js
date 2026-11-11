// Três mudanças de 11/11/2026, com o SQL real em PGlite:
//   1. REDENÇÃO das marcas (utils/responsabilidade): compromissos_nao_cumpridos_90d e
//      cliente_nao_respondeu_90d deixam de contar um evento depois de 2 demandas SEGUIDAS
//      concluídas sem o mesmo problema (ou 90 dias); o bloqueio de 7 dias segue contando 90 dias.
//   2. especialidades_inferidas no feed (GET /obras) e no detalhe (GET /obras/:id).
//   3. GET /prestador/oportunidades-resumo → { abertos_perto, na_especialidade } com a regra de
//      alcance do aviso (mesma cidade OU até min(raio, 50 km)).
// Uso: NODE_PATH=<pglite>/node_modules node scripts/testar-redencao-oportunidades.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

let db = null
const shim = {
  query: (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return db.query(sql, params) },
  connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: (s, p) => db.query(s, p), release() {} } },
  on() {},
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: class { static isExpoPushToken() { return false } } }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async () => {}, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async () => {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error
console.log = () => {}; console.error = () => {}
const router = require(path.join(REPO, 'src/routes/index.js'))
const R = require(path.join(REPO, 'src/utils/responsabilidade'))
const O = require(path.join(REPO, 'src/utils/oportunidadesResumo'))
const obrasCtrl = require(path.join(REPO, 'src/controllers/obrasController'))
console.log = logOrig; console.error = errOrig

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const handlerDe = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const chamar = (handler, usuario, { params = {}, body = {}, query = {} } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, body, query, usuario, get() { return '' } }, res)
})
const usuarioReq = async (id) => (await db.query(`SELECT id, nome, email, role, ativo, tipo_prestador FROM usuarios WHERE id = $1`, [id])).rows[0]
// Relógio do banco: dia D (0 = 2026-11-11 12:00Z) + minutos.
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0)
const em = (dias, min = 0) => new Date(T0 + dias * 86400000 + min * 60000).toISOString()
const fixarAgora = (dias, min = 0) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${em(dias, min)}'::timestamptz $$`)

const PRO = U(1), PRO_IRMA = U(2), DONO = U(10), DONO_IRMA = U(11), OUTRO_PRO = U(3), OUTRO_DONO = U(12)
const PATOS = [-18.5789, -46.5181], LF = [-18.7786, -46.4075], UDI = [-18.9186, -48.2772]

const marcaProf = async (u) => (await db.query(`SELECT ${R.sqlCompromissosNaoCumpridos90d('$1::uuid')} AS n, ${R.sqlCumpriuTodos('$1::uuid')} AS cumpriu`, [u])).rows[0]
const marcaDono = async (u) => (await db.query(`SELECT ${R.sqlClienteNaoRespondeu90d('$1::uuid')} AS n`, [u])).rows[0].n
const evento = (tipo, usuario, tabela, demanda, dias, extra = {}) => db.query(
  `INSERT INTO eventos_responsabilidade (tipo_evento, usuario_id, outro_usuario_id, tabela, demanda_id, motivo, bloqueio_ate, criado_em)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
  [tipo, usuario, extra.outro || null, tabela, demanda, extra.motivo || 'teste', extra.bloqueio_ate || null, em(dias)])
// Demanda genérica (obras ou reparos) com os campos que a redenção e o resumo leem.
const demanda = (tabela, id, { criado_por = OUTRO_DONO, criado_dia = 0, status = 'aberta', match = null, match_dia = null, encerrado_dia = null, horario_dia = null,
                               cidade = 'Patos de Minas', uf = 'MG', em: ponto = PATOS, categoria = 'eletrica', categorias = null, inferidas = null, prazo = 72 } = {}) => {
  const comuns = [id, `${tabela} ${id.slice(-2)}`, cidade, uf, criado_por, em(criado_dia), status, status === 'encerrada' ? 'encerrada' : 'aprovada',
    match, match_dia === null ? null : em(match_dia), encerrado_dia === null ? null : em(encerrado_dia), horario_dia === null ? null : em(horario_dia),
    prazo, ponto?.[0] ?? null, ponto?.[1] ?? null]
  const colunas = `id, titulo, cidade, uf, bairro, criado_por, criado_em, publicado_em, status, status_aprovacao, match_usuario_id, match_feito_em, encerrado_em, chegada_prevista_em, expira_em, latitude, longitude`
  const valores = `$1, $2, $3, $4, 'Centro', $5, $6::timestamptz, $6::timestamptz, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12::timestamptz, $6::timestamptz + $13::numeric * INTERVAL '1 hour', $14, $15`
  if (tabela === 'reparos') {
    return db.query(`INSERT INTO reparos (${colunas}, categoria, categorias, valor_estimado, prazo_atendimento_horas) VALUES (${valores}, $16, $17, 150, $13::numeric)`,
      [...comuns, categoria, categorias || [categoria]])
  }
  return db.query(`INSERT INTO obras (${colunas}, categoria, valor, horas_para_expirar, especialidades_inferidas) VALUES (${valores}, 'residencial', 1000, $13::numeric, $16)`,
    [...comuns, inferidas])
}

const main = async () => {
  db = new PGlite()
  await db.exec(`SET search_path = public, pg_catalog`)
  await fixarAgora(0)
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, descricao text, categoria text, cidade text, uf text, estado text, bairro text, criado_por uuid, status text DEFAULT 'aberta',
      status_aprovacao text DEFAULT 'aprovada', match_usuario_id uuid, match_feito_em timestamptz, encerrado_em timestamptz, chegada_prevista_em timestamptz,
      expira_em timestamptz, criado_em timestamptz DEFAULT now(), publicado_em timestamptz, prestadores_bloqueados uuid[], codigo_publico text,
      push_novo_enviado_em timestamptz, latitude numeric, longitude numeric, tags text[], metragem numeric, prazo_execucao_dias int, prazo_modo text,
      ultima_extensao_horas numeric, coordenadas_origem text, lembretes_enviados int DEFAULT 0, lembrete_enviado_em timestamptz`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, cidade text, uf text, role text, tipo_prestador text, tipo_dono text, cpf_cnpj text, ativo boolean DEFAULT true,
      push_token text, suspenso_em timestamptz, desinstalado_em timestamptz, especialidades text[], latitude numeric, longitude numeric, raio_km_escolhido numeric);
    CREATE TABLE assinaturas (usuario_id uuid, status text, proximo_vencimento timestamptz);
    CREATE TABLE reparos (${colsDemanda}, categorias text[], valor_estimado numeric, prazo_atendimento_horas numeric);
    CREATE TABLE obras (${colsDemanda}, valor numeric, horas_para_expirar numeric, especialidades_inferidas text[]);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, status text, criado_em timestamptz DEFAULT now());
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, status text, criado_em timestamptz DEFAULT now());
    CREATE TABLE prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid);
    CREATE TABLE midias (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, tipo text, url text, url_thumbnail text, ordem int);
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz);
    CREATE TABLE eventos_responsabilidade (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tipo_evento text, usuario_id uuid, outro_usuario_id uuid, tabela text, demanda_id uuid,
      motivo text, bloqueio_ate timestamptz, credito_dias int DEFAULT 0, credito_aplicado_em timestamptz, criado_em timestamptz NOT NULL DEFAULT now());
  `)
  const pessoa = (id, nome, role, extra = {}) => db.query(
    `INSERT INTO usuarios (id, nome, email, cidade, uf, role, tipo_prestador, tipo_dono, cpf_cnpj, especialidades, latitude, longitude, raio_km_escolhido, push_token)
     VALUES ($1, $2, $3, $4, 'MG', $5, $6, $7, $8, $9, $10, $11, $12, 'ExponentPushToken[x]')`,
    [id, nome, `${id.slice(-3)}@x.invalid`, extra.cidade || 'Patos de Minas', role, extra.tipo_prestador || null, extra.tipo_dono || null, extra.cpf || id.slice(-11),
     extra.esp || null, extra.em?.[0] ?? null, extra.em?.[1] ?? null, extra.raio ?? null])
  await pessoa(PRO, 'Rafael reparador', 'prestador', { tipo_prestador: 'reparador', esp: ['eletrica'], cpf: '11111111111', em: PATOS })
  await pessoa(PRO_IRMA, 'Rafael pintor', 'prestador', { tipo_prestador: 'pintor', esp: ['pintor'], cpf: '11111111111', em: PATOS })
  await pessoa(OUTRO_PRO, 'Outro pro', 'prestador', { tipo_prestador: 'reparador', esp: ['faxina'], cpf: '33333333333', em: PATOS })
  await pessoa(DONO, 'Dona Ana', 'dono_obra', { tipo_dono: 'residencial', cpf: '22222222222' })
  await pessoa(DONO_IRMA, 'Ana condomínio', 'dono_obra', { tipo_dono: 'condominio', cpf: '22222222222' })
  await pessoa(OUTRO_DONO, 'Outro dono', 'dono_obra', { cpf: '44444444444' })
  for (const u of [PRO, PRO_IRMA, OUTRO_PRO]) await db.query(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [u])

  // ═══ 1a. PROFISSIONAL: compromisso_nao_cumprido redimido por 2 conclusões seguidas ══════════
  await fixarAgora(0)
  await evento('compromisso_nao_cumprido', PRO, 'reparos', D(1), -30, { motivo: 'escolheu_outro' })
  ok((await marcaProf(PRO)).n === 1 && (await marcaProf(PRO)).cumpriu === false, 'evento há 30 dias: conta 1, cumpriu_todos false', await marcaProf(PRO))
  // 1ª conclusão limpa depois do evento (match dia −20, horário marcado, encerrada dia −18)
  await demanda('reparos', D(2), { status: 'encerrada', match: PRO, match_dia: -20, horario_dia: -19, encerrado_dia: -18 })
  ok((await marcaProf(PRO)).n === 1, 'UMA conclusão limpa depois: ainda conta', (await marcaProf(PRO)).n)
  // conclusão SEM horário marcado não vale
  await demanda('reparos', D(3), { status: 'encerrada', match: PRO, match_dia: -16, encerrado_dia: -15 })
  ok((await marcaProf(PRO)).n === 1, 'encerrada SEM horário marcado não conta como conclusão limpa', (await marcaProf(PRO)).n)
  // 2ª conclusão limpa (pela conta IRMÃ, mesma pessoa) → redimido
  await demanda('obras', D(4), { status: 'encerrada', match: PRO_IRMA, match_dia: -12, horario_dia: -11, encerrado_dia: -10 })
  ok((await marcaProf(PRO)).n === 0 && (await marcaProf(PRO)).cumpriu === true, '2 conclusões seguidas (uma pela conta irmã): evento redimido, cumpriu_todos true', await marcaProf(PRO))
  ok((await marcaProf(PRO_IRMA)).n === 0, 'lido pela conta irmã também', (await marcaProf(PRO_IRMA)).n)
  // conclusão ANTERIOR ao evento não ajuda
  await evento('compromisso_nao_cumprido', OUTRO_PRO, 'reparos', D(5), -5)
  await demanda('reparos', D(6), { status: 'encerrada', match: OUTRO_PRO, match_dia: -40, horario_dia: -39, encerrado_dia: -38 })
  await demanda('reparos', D(7), { status: 'encerrada', match: OUTRO_PRO, match_dia: -35, horario_dia: -34, encerrado_dia: -33 })
  ok((await marcaProf(OUTRO_PRO)).n === 1, 'duas conclusões ANTES do evento não redimem', (await marcaProf(OUTRO_PRO)).n)
  // "seguidas": conclusão, novo evento, conclusão → o 1º evento NÃO é redimido (as duas limpas não são consecutivas)
  await demanda('reparos', D(8), { status: 'encerrada', match: OUTRO_PRO, match_dia: -4, horario_dia: -3.5, encerrado_dia: -3 })
  await evento('compromisso_nao_cumprido', OUTRO_PRO, 'reparos', D(9), -2)
  await demanda('reparos', D(10), { status: 'encerrada', match: OUTRO_PRO, match_dia: -1.5, horario_dia: -1.2, encerrado_dia: -1 })
  ok((await marcaProf(OUTRO_PRO)).n === 2, 'limpa, evento, limpa: nada redimido (não são seguidas) → conta 2', (await marcaProf(OUTRO_PRO)).n)
  await demanda('reparos', D(11), { status: 'encerrada', match: OUTRO_PRO, match_dia: -0.8, horario_dia: -0.6, encerrado_dia: -0.5 })
  ok((await marcaProf(OUTRO_PRO)).n === 0, 'mais uma limpa seguida: as duas últimas redimem os DOIS eventos', (await marcaProf(OUTRO_PRO)).n)
  // 90 dias: evento velho sai sozinho
  await evento('compromisso_nao_cumprido', PRO, 'obras', D(12), -89)
  ok((await marcaProf(PRO)).n === 0, 'evento de 89 dias já redimido pelas 2 conclusões posteriores', (await marcaProf(PRO)).n)
  await evento('compromisso_nao_cumprido', PRO, 'obras', D(13), -1)
  ok((await marcaProf(PRO)).n === 1, 'evento novo (ontem) conta', (await marcaProf(PRO)).n)
  await fixarAgora(91)
  ok((await marcaProf(PRO)).n === 0, '91 dias depois: saiu pela janela', (await marcaProf(PRO)).n)
  await fixarAgora(0)

  // ═══ 1b. DONO: cliente_nao_respondeu redimido; bloqueio de 7 dias conta os 90 dias cheios ═══
  await evento('cliente_nao_respondeu', DONO, 'reparos', D(20), -40, { motivo: 'proposta_vencida' })
  ok(await marcaDono(DONO) === 1 && await marcaDono(DONO_IRMA) === 1, 'dono: 1 evento há 40 dias conta (nas duas contas da pessoa)')
  // demanda posterior com horário aceito, sem evento nela
  await demanda('reparos', D(21), { criado_por: DONO, criado_dia: -30, match: OUTRO_PRO, match_dia: -29, horario_dia: -28, status: 'encerrada', encerrado_dia: -27 })
  ok(await marcaDono(DONO) === 1, 'uma demanda limpa depois: ainda conta')
  // demanda posterior que teve OUTRA proposta vencida (evento nela) não é limpa
  await demanda('reparos', D(22), { criado_por: DONO_IRMA, criado_dia: -25, match: OUTRO_PRO, match_dia: -24, horario_dia: -23 })
  await evento('cliente_nao_respondeu', DONO_IRMA, 'reparos', D(22), -24, { motivo: 'proposta_vencida', bloqueio_ate: em(-17) })
  ok(await marcaDono(DONO) === 2, 'segundo evento (pela conta irmã, com bloqueio): conta 2')
  // demanda sem nenhuma proposta respondida (aberta, sem horário) não conta como limpa
  await demanda('obras', D(23), { criado_por: DONO, criado_dia: -20 })
  ok(await marcaDono(DONO) === 2, 'demanda aberta sem horário não é conclusão limpa')
  // duas limpas seguidas depois do 2º evento → os dois redimidos
  await demanda('obras', D(24), { criado_por: DONO, criado_dia: -15, match: PRO_IRMA, match_dia: -14, horario_dia: -13 })
  await demanda('reparos', D(25), { criado_por: DONO, criado_dia: -10, match: PRO, match_dia: -9, horario_dia: -8, status: 'encerrada', encerrado_dia: -7 })
  ok(await marcaDono(DONO) === 0 && await marcaDono(DONO_IRMA) === 0, 'duas demandas seguidas com horário aceito e sem proposta vencida: marca zera')
  // o bloqueio (responsabilidadeService) conta os 90 dias cheios: um 3º evento hoje ainda é "2º+" → bloqueio
  const svc = require(path.join(REPO, 'src/services/responsabilidadeService'))
  await demanda('reparos', D(26), { criado_por: DONO, criado_dia: -1, match: OUTRO_PRO, match_dia: -1 })
  console.log = () => {}
  const ev3 = await svc.registrarClienteNaoRespondeu({ tabela: 'reparos', demandaId: D(26), donoId: DONO, profissionalId: OUTRO_PRO })
  console.log = logOrig
  const bloqueio = (await db.query(`SELECT bloqueio_ate FROM eventos_responsabilidade WHERE demanda_id = $1`, [D(26)])).rows[0]?.bloqueio_ate
  ok(!!bloqueio, 'bloqueio de 7 dias: o evento novo ainda vê os 2 anteriores dos 90 dias (redenção não alivia o bloqueio)', { bloqueio_ate: bloqueio, ev3: !!ev3 })
  ok(await marcaDono(DONO) === 1, 'marca de leitura: só o evento novo conta (os redimidos seguem fora)', await marcaDono(DONO))

  // ═══ 2. especialidades_inferidas no feed e no detalhe ═══════════════════════════════════════
  await demanda('obras', D(30), { criado_por: OUTRO_DONO, criado_dia: -1, inferidas: ['eletrica', 'pedreiro_servente'] })
  await demanda('obras', D(31), { criado_por: OUTRO_DONO, criado_dia: -1 }) // sem lista (NULL)
  const hObras = handlerDe('get', '/obras')
  let r = await chamar(hObras, await usuarioReq(PRO), { query: { raio_km: 'cidade' } })
  const porId = Object.fromEntries((r.body.obras || []).map(o => [o.id, o]))
  ok(r.status === 200 && Array.isArray(porId[D(30)]?.especialidades_inferidas) && porId[D(30)].especialidades_inferidas.includes('eletrica'),
     'GET /obras: card traz especialidades_inferidas (slugs)', porId[D(30)]?.especialidades_inferidas)
  ok(porId[D(31)] === undefined || Array.isArray(porId[D(31)].especialidades_inferidas), 'GET /obras: obra sem lista inferida sai com [] (nunca null) — ou não sai para quem só entra por inferência', porId[D(31)]?.especialidades_inferidas)
  // (o detalhe GET /obras/:id, que precisa do esquema completo, é conferido em testar-responsabilidade-pos-match.js)
  // O feed acima registrou raio "cidade" (0) para Rafael — volta ao padrão (nunca escolheu → 50 km).
  await db.query(`UPDATE usuarios SET raio_km_escolhido = NULL WHERE id = $1`, [PRO])

  // ═══ 3. GET /prestador/oportunidades-resumo ═════════════════════════════════════════════════
  // Em aberto agora (dia 0): D(30) obra Patos inferidas [eletrica,...] e D(31) obra Patos sem inferidas (D(23) já
  // expirou: 72h, criada há 20 dias). Mais: reparo de elétrica em Lagoa Formosa (25 km), reparo de faxina em Patos,
  // reparo de elétrica em Uberlândia (~200 km), reparo do PRÓPRIO Rafael (conta irmã, mesmo CPF) em Patos, reparo expirado, reparo com match.
  await demanda('reparos', D(40), { criado_por: OUTRO_DONO, criado_dia: -0.5, cidade: 'Lagoa Formosa', em: LF, categoria: 'eletrica' })
  await demanda('reparos', D(41), { criado_por: OUTRO_DONO, criado_dia: -0.5, categoria: 'faxina' })
  await demanda('reparos', D(42), { criado_por: OUTRO_DONO, criado_dia: -0.5, cidade: 'Uberlândia', em: UDI, categoria: 'eletrica' })
  await demanda('reparos', D(43), { criado_por: PRO_IRMA, criado_dia: -0.5, categoria: 'eletrica' })
  await demanda('reparos', D(44), { criado_por: OUTRO_DONO, criado_dia: -10, categoria: 'eletrica', prazo: 24 }) // expirado
  await demanda('reparos', D(45), { criado_por: OUTRO_DONO, criado_dia: -0.5, categoria: 'eletrica', match: OUTRO_PRO, match_dia: -0.2 })
  const hResumo = handlerDe('get', '/prestador/oportunidades-resumo')
  // Rafael (reparador de elétrica, Patos, raio padrão 50): perto = D30, D31 (obras Patos) + D40 (LF 25 km) + D41 (faxina Patos) = 4;
  // na especialidade: D30 (inferida eletrica), D31 (a pessoa tem conta de pintor → pode obras), D40 (elétrica) = 3; faxina fora.
  r = await chamar(hResumo, await usuarioReq(PRO))
  ok(r.status === 200 && r.body.abertos_perto === 4, 'resumo: 4 abertos ao alcance (2 obras + 2 reparos em Patos/LF; fora: Uberlândia, própria, expirada, com match)', r.body)
  ok(r.body.na_especialidade === 3, 'na_especialidade: obras (a pessoa tem conta de pintor) + reparo de elétrica; faxina fica fora', r.body)
  // Com raio "minha cidade" (0): Lagoa Formosa sai
  await db.query(`UPDATE usuarios SET raio_km_escolhido = 0 WHERE id = $1`, [PRO])
  r = await chamar(hResumo, await usuarioReq(PRO))
  ok(r.body.abertos_perto === 3 && r.body.na_especialidade === 2, 'raio "minha cidade": o reparo de Lagoa Formosa (25 km) sai dos dois números', r.body)
  // Outro pro (faxina, Patos, sem conta de pintor, outro CPF): perto 5 (raio padrão; o reparo de Rafael conta para ele),
  // na especialidade só o reparo de faxina
  r = await chamar(hResumo, await usuarioReq(OUTRO_PRO))
  ok(r.body.abertos_perto === 5 && r.body.na_especialidade === 1, 'reparador de faxina: 5 perto, 1 na especialidade', r.body)
  // Profissional sem cidade nem coordenadas: 0
  await db.query(`UPDATE usuarios SET cidade = NULL, latitude = NULL, longitude = NULL WHERE id = $1`, [OUTRO_PRO])
  r = await chamar(hResumo, await usuarioReq(OUTRO_PRO))
  ok(r.body.abertos_perto === 0 && r.body.na_especialidade === 0, 'sem cidade e sem coordenadas: 0 / 0', r.body)
  // Dono não passa (exigirPrestador): o handler final não é chamado; aqui só conferimos que a rota existe com o gate
  const layer = router.stack.find(l => l.route && l.route.path === '/prestador/oportunidades-resumo')
  ok(layer && layer.route.stack.length === 3, 'rota registrada com autenticar + exigirPrestador', layer?.route.stack.length)

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error = errOrig; console.error('ERRO', e); process.exit(1) })
