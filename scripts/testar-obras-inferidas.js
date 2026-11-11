#!/usr/bin/env node
// Especialidades inferidas das obras (dono, 10/11/2026): o servidor deduz do título + descrição os
// ofícios relacionados (utils/especialidadesInferidas), grava em obras.especialidades_inferidas e
//   - ACRESCENTA ao aviso "Nova obra" (push + e-mail) quem tem alguma delas — público genérico de
//     obras inalterado, mesmo alcance (cidade ou min(raio, 50 km)), teto diário e filtros;
//   - mostra essas obras no feed GET /obras de quem só casa por elas (pode_obras vira true enquanto
//     houver uma aberta); o público genérico segue vendo tudo;
//   - backfill das abertas sem lista e reanúncio (uma vez) SÓ aos recém-casados ainda não avisados.
// SQL REAL num Postgres em memória (PGlite); Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-obras-inferidas.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

const pushes = [], emails = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { pushes.push(...chunk); return chunk.map((_, i) => ({ status: 'ok', id: `t${pushes.length}-${i}` })) }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
const shim = {
  query: (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return db.query(sql, params) },
  connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: (s, p) => db.query(s, p), release() {} } },
  on() {},
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) }, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) } }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const erros = []
const silenciar = (v) => {
  console.log = v ? () => {} : logOrig
  console.warn = v ? () => {} : warnOrig
  console.error = v ? (...a) => { erros.push(a.map(x => x?.message || String(x)).join(' ')) } : errOrig
}
silenciar(true)
require(path.join(REPO, 'src/routes/index.js'))
const A = require(path.join(REPO, 'src/services/alertaService'))
const I = require(path.join(REPO, 'src/utils/especialidadesInferidas'))
const O = require(path.join(REPO, 'src/services/obrasInferidasService'))
const { capacidadesDaPessoa } = require(path.join(REPO, 'src/utils/capacidadeObras'))
const obrasCtrl = require(path.join(REPO, 'src/controllers/obrasController'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const tok = (n) => `ExponentPushToken[${n}]`
const assentar = () => new Promise(r => setTimeout(r, 150))
const quieto = async (fn) => { silenciar(true); const n0 = erros.length; try { return await fn() } finally { await assentar(); silenciar(false); if (process.env.DEBUG_ERROS && erros.length > n0) logOrig('   [erros]', erros.slice(n0).join(' || ').slice(0, 600)) } }
const pushesDe = (n) => pushes.filter(p => p.to === tok(n))
const chamar = (handler, usuarioId, query = {}, params = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, query, body: {}, usuario: { id: usuarioId, role: 'prestador' } }, res)
})
const DONO = U(1), PINTOR = U(2), ENCANADOR = U(3), ELETRICISTA = U(4), FAXINA = U(5), PEDREIRO = U(6), LONGE = U(7), SUSPENSO = U(8), SEMTOKEN = U(9)
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const main = async () => {
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, descricao text, categoria text, cidade text, uf text, bairro text, estado text, criado_por uuid, status text DEFAULT 'aberta',
      status_aprovacao text DEFAULT 'aprovada', match_usuario_id uuid, match_feito_em timestamptz, encerrado_em timestamptz, chegada_prevista_em timestamptz, expira_em timestamptz, criado_em timestamptz DEFAULT now(), publicado_em timestamptz,
      prestadores_bloqueados uuid[], codigo_publico text, push_novo_enviado_em timestamptz, email_novo_pendente_em timestamptz, latitude numeric, longitude numeric,
      coordenadas_origem text, metragem numeric, prazo_execucao_dias int, tags text[], horas_para_expirar numeric, prazo_modo text, ultima_extensao_horas numeric,
      lembretes_enviados int DEFAULT 0, lembrete_enviado_em timestamptz`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, cidade text, uf text, role text, tipo_prestador text, cpf_cnpj text, ativo boolean DEFAULT true,
      push_token text, suspenso_em timestamptz, desinstalado_em timestamptz, especialidades text[], indicacao_pedida_em timestamptz, latitude numeric, longitude numeric,
      raio_km_escolhido numeric, avisos_todas_areas boolean DEFAULT true);
    CREATE TABLE assinaturas (usuario_id uuid, status text, proximo_vencimento timestamptz);
    CREATE TABLE obras (${colsDemanda}, valor numeric, push_aprovada_enviado_em timestamptz, enviada_por_dono boolean);
    CREATE TABLE reparos (${colsDemanda}, categorias text[], valor_estimado numeric, prazo_atendimento_horas numeric);
    CREATE TABLE midias (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, url text, ordem int);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, status text, criado_em timestamptz DEFAULT now());
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, criado_em timestamptz DEFAULT now());
    CREATE TABLE prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid);
    CREATE TABLE push_entregas (tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, primeira_tentativa_em timestamptz NOT NULL DEFAULT now(),
      ultima_tentativa_em timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tipo, demanda_id, usuario_id));
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz);
    CREATE TABLE avisos_fora_area (usuario_id uuid, tipo text, demanda_id uuid, enviado_em timestamptz DEFAULT now());
  `)
  const cliente = { query: (s, p) => db.query(s, p) }
  await require(path.join(REPO, 'src/utils/avisosPorDistancia')).migrarAvisosPorDistancia(cliente)
  await I.migrarEspecialidadesInferidas(cliente)
  await I.migrarEspecialidadesInferidas(cliente) // idempotente
  await require(path.join(REPO, 'src/utils/responsabilidade')).migrarResponsabilidade(cliente) // o feed lê cliente_nao_respondeu_90d
  // Niterói/RJ. Pintor (público genérico); encanador, eletricista, faxineira (só serviços); pedreiro
  // reparador com pedreiro_servente (público genérico pela especialidade de obra); encanador LONGE
  // (Campos, 60 km+, sem coords); encanador suspenso; encanador sem token (só e-mail).
  await db.query(`INSERT INTO usuarios (id, nome, email, cidade, uf, role, tipo_prestador, cpf_cnpj, push_token, especialidades, latitude, longitude) VALUES
    ($1, 'Dona', 'dona@x.invalid', 'Niterói', 'RJ', 'dono_obra', NULL, '111', $10, NULL, NULL, NULL),
    ($2, 'Pintor', 'pintor@x.invalid', 'Niterói', 'RJ', 'prestador', 'pintor', '222', $11, ARRAY['pintor'], -22.88, -43.10),
    ($3, 'Encanador', 'enc@x.invalid', 'Niterói', 'RJ', 'prestador', 'reparador', '333', $12, ARRAY['hidraulica'], -22.88, -43.10),
    ($4, 'Eletricista', 'ele@x.invalid', 'Niterói', 'RJ', 'prestador', 'reparador', '444', $13, ARRAY['eletrica'], NULL, NULL),
    ($5, 'Faxineira', 'fax@x.invalid', 'Niterói', 'RJ', 'prestador', 'reparador', '555', $14, ARRAY['faxina'], NULL, NULL),
    ($6, 'Pedreiro', 'ped@x.invalid', 'Niterói', 'RJ', 'prestador', 'reparador', '666', $15, ARRAY['alvenaria', 'pedreiro_servente'], NULL, NULL),
    ($7, 'Longe', 'longe@x.invalid', 'Campos dos Goytacazes', 'RJ', 'prestador', 'reparador', '777', $16, ARRAY['hidraulica'], NULL, NULL),
    ($8, 'Suspenso', 'susp@x.invalid', 'Niterói', 'RJ', 'prestador', 'reparador', '888', $17, ARRAY['hidraulica'], NULL, NULL),
    ($9, 'SemToken', 'semtoken@x.invalid', 'Niterói', 'RJ', 'prestador', 'reparador', '999', NULL, ARRAY['hidraulica'], NULL, NULL)`,
    [DONO, PINTOR, ENCANADOR, ELETRICISTA, FAXINA, PEDREIRO, LONGE, SUSPENSO, SEMTOKEN, tok('dona'), tok('pintor'), tok('enc'), tok('ele'), tok('fax'), tok('ped'), tok('longe'), tok('susp')])
  await db.query(`UPDATE usuarios SET suspenso_em = now() WHERE id = $1`, [SUSPENSO])
  await db.query(`INSERT INTO assinaturas SELECT id, 'ativa', NULL FROM usuarios WHERE role = 'prestador'`)

  // ═══ 1. Inferência ════════════════════════════════════════════════════════════════════════
  ok(igual(I.inferirEspecialidades({ titulo: 'Instalação de ponto de água e esgoto' }), ['hidraulica', 'alvenaria', 'pedreiro_servente']), 'YS5XR "Instalação de ponto de água e esgoto" → hidraulica, alvenaria, pedreiro_servente')
  ok(igual(I.inferirEspecialidades({ titulo: 'Trocar o papel de parede da sala' }), ['gesseiro', 'pintor']), 'papel de parede → pintor, gesseiro', I.inferirEspecialidades({ titulo: 'Trocar o papel de parede da sala' }))
  ok(igual(I.inferirEspecialidades({ titulo: 'Casa nova', descricao: 'Preciso de ELÉTRICA completa: tomadas e quadro de luz' }), ['eletrica']), 'descrição conta; acento/caixa não importam ("ELÉTRICA" → eletrica)')
  ok(igual(I.inferirEspecialidades({ titulo: 'Instalar câmeras e cerca elétrica' }), ['eletrica', 'seguranca_eletronica']), 'palavras de CATEGORIAS_SERVICO (câmeras, cerca elétrica) → seguranca_eletronica (+ eletrica)')
  ok(igual(I.inferirEspecialidades({ titulo: 'Manutenção geral' }), []) && igual(I.inferirEspecialidades({ titulo: 'Obra comercial' }), []) && igual(I.inferirEspecialidades({}), []), 'termo genérico ("manutenção") e título sem ofício → [] (sem falso positivo)')
  ok(igual(I.inferirEspecialidades({ titulo: 'Aguardo orçamento' }), []), '"aguardo" não casa "agua" (começo de palavra)')
  ok(igual(I.inferirEspecialidades({ titulo: 'Instalação de ponto de água e esgoto', descricao: 'Trocar o sifão e refazer o armário embaixo da pia, bancada de madeira' }), ['hidraulica', 'alvenaria', 'pedreiro_servente']),
     'texto de encanamento com "armário"/"madeira" soltos NÃO puxa marcenaria (caso YS5XR)')
  ok(igual(I.inferirEspecialidades({ titulo: 'Armários planejados e porta de madeira para a cozinha' }), ['marcenaria']), 'móvel sob medida / porta de madeira → marcenaria continua')
  ok(I.REGRAS.every(r => r.slugs.length > 0 && r.termos.every(t => t.replace(/[*]$/, '') === I.normalizar(t.replace(/[*]$/, '')))), 'regras: todas com slug válido e termos normalizados')
  ok(igual(I.inferirEspecialidades({ titulo: 'Novas tomadas e luminárias; eletricista' }), ['eletrica']), 'plural (-s) e prefixo (eletric*) casam')

  // ═══ 2. Criação grava a lista; aviso de obra nova acrescenta os casados ════════════════════
  const criar = async (n, codigo, titulo, descricao, extra = {}) => {
    await db.query(`INSERT INTO obras (id, codigo_publico, titulo, descricao, categoria, cidade, uf, criado_por, valor, expira_em, publicado_em, latitude, longitude, horas_para_expirar)
                    VALUES ($1, $2, $3, $4, 'residencial', 'Niterói', 'RJ', $5, 2500, now() + INTERVAL '10 days', now(), $6, $7, 240)`,
      [D(n), codigo, titulo, descricao, DONO, extra.lat ?? -22.89, extra.lng ?? -43.11])
    return I.gravarEspecialidadesInferidas(db, D(n), { titulo, descricao })
  }
  let slugs = await criar(1, 'YS5XR', 'Instalação de ponto de água e esgoto', null)
  let l = (await db.query(`SELECT especialidades_inferidas FROM obras WHERE id = $1`, [D(1)])).rows[0]
  ok(igual(slugs, ['hidraulica', 'alvenaria', 'pedreiro_servente']) && igual(l.especialidades_inferidas, slugs), 'gravarEspecialidadesInferidas: coluna gravada', l.especialidades_inferidas)
  pushes.length = 0; emails.length = 0
  await quieto(() => A.notificarPintoresSobreNovaObra(D(1)))
  const avisados = pushes.map(p => p.to).sort()
  ok(igual(avisados, [tok('enc'), tok('ped'), tok('pintor')].sort()), 'push "Nova obra": público genérico (pintor, pedreiro) + ENCANADOR acrescentado; eletricista/faxina não', avisados)
  ok(pushesDe('longe').length === 0 && pushesDe('susp').length === 0, 'encanador fora do alcance (Campos) e suspenso: fora, como no aviso normal')
  ok(pushes.every(p => p.title === pushesDe('pintor')[0].title && p.data?.tipo === 'nova_obra'), 'mesmo texto e data do aviso normal', pushesDe('enc')[0] && pushesDe('enc')[0].title)
  const entregas = (await db.query(`SELECT usuario_id FROM push_entregas WHERE tipo = 'obra' AND demanda_id = $1 AND resultado = 'enviado'`, [D(1)])).rows.map(r => r.usuario_id).sort()
  ok(igual(entregas, [PINTOR, ENCANADOR, PEDREIRO].sort()), 'push_entregas registra os 3 (conta em profissionais_avisados)')
  await quieto(() => A.enviarEmailsNovaDemanda('obras', D(1)))
  const paraEmail = emails.map(e => e.para).sort()
  ok(igual(paraEmail, ['enc@x.invalid', 'ped@x.invalid', 'pintor@x.invalid', 'semtoken@x.invalid'].sort()), 'e-mail "Nova obra": genéricos + encanadores (inclusive o sem token); eletricista/faxina não', paraEmail)

  // Obra sem ofício inferível: só o público genérico (comportamento de sempre)
  await criar(2, 'BR5V3', 'Obra comercial', 'Preciso de orçamento')
  pushes.length = 0; emails.length = 0
  await quieto(() => A.notificarPintoresSobreNovaObra(D(2)))
  ok(igual(pushes.map(p => p.to).sort(), [tok('ped'), tok('pintor')].sort()), 'obra sem especialidade inferida: só o público genérico (inalterado)', pushes.map(p => p.to))
  // Obra elétrica: eletricista entra, encanador não
  await criar(3, 'ELE01', 'Troca do quadro de luz e tomadas', null)
  pushes.length = 0
  await quieto(() => A.notificarPintoresSobreNovaObra(D(3)))
  ok(igual(pushes.map(p => p.to).sort(), [tok('ele'), tok('ped'), tok('pintor')].sort()), 'obra elétrica: eletricista acrescentado, encanador não', pushes.map(p => p.to))

  // ═══ 3. Feed e capacidade ═════════════════════════════════════════════════════════════════
  const feed = async (quem) => quieto(() => chamar(obrasCtrl.listar, quem, { raio_km: 'estado', uf: 'RJ', page: '1', limit: '20' }))
  let f = await feed(ENCANADOR)
  ok(f.status === 200 && igual((f.body.obras || []).map(o => o.codigo_publico || o.id).sort(), [D(1)]), 'feed do encanador: SÓ a obra de água/esgoto', { status: f.status, ids: (f.body.obras || []).map(o => o.id) })
  f = await feed(ELETRICISTA)
  ok(f.status === 200 && igual((f.body.obras || []).map(o => o.id), [D(3)]), 'feed do eletricista: só a obra elétrica')
  f = await feed(FAXINA)
  ok(f.status === 200 && (f.body.obras || []).length === 0, 'feed da faxineira: vazio')
  f = await feed(PINTOR)
  ok(f.status === 200 && (f.body.obras || []).length === 3, 'feed do pintor (público genérico): as 3 obras, como sempre', (f.body.obras || []).length)
  f = await feed(PEDREIRO)
  ok(f.status === 200 && (f.body.obras || []).length === 3, 'feed do reparador com pedreiro_servente (público genérico): as 3')
  let cap = await capacidadesDaPessoa(ENCANADOR)
  ok(cap.pode_obras === true && cap.obras_inferidas === true && cap.pode_servicos === true, 'capacidades do encanador: pode_obras TRUE (via inferidas), obras_inferidas true', cap)
  ok((await capacidadesDaPessoa(FAXINA)).pode_obras === false, 'faxineira: pode_obras false')
  cap = await capacidadesDaPessoa(PINTOR)
  ok(cap.pode_obras === true && cap.obras_inferidas === false, 'pintor: pode_obras pelo tipo, obras_inferidas false')
  await db.query(`UPDATE obras SET match_usuario_id = $2 WHERE id = $1`, [D(1), PEDREIRO])
  ok((await capacidadesDaPessoa(ENCANADOR)).pode_obras === false, 'obra casada: encanador volta a pode_obras false (a lista só vale para obra aberta no feed)')
  await db.query(`UPDATE obras SET match_usuario_id = NULL WHERE id = $1`, [D(1)])

  // ═══ 4. Backfill + reanúncio único aos recém-casados ══════════════════════════════════════
  await db.query(`INSERT INTO obras (id, codigo_publico, titulo, descricao, categoria, cidade, uf, criado_por, valor, expira_em, publicado_em) VALUES
    ($1, 'ANT01', 'Pintura externa e reparo no telhado', NULL, 'residencial', 'Niterói', 'RJ', $3, 900, now() + INTERVAL '3 days', now()),
    ($2, 'FECH1', 'Troca de cano', NULL, 'residencial', 'Niterói', 'RJ', $3, 100, now() + INTERVAL '3 days', now())`, [D(4), D(5), DONO])
  await db.query(`UPDATE obras SET status = 'encerrada' WHERE id = $1`, [D(5)])
  const n = await I.backfillEspecialidadesInferidas(db)
  const bf = (await db.query(`SELECT codigo_publico, especialidades_inferidas FROM obras WHERE id IN ($1, $2) ORDER BY codigo_publico`, [D(4), D(5)])).rows
  ok(n === 1 && igual(bf[0].especialidades_inferidas, ['alvenaria', 'pedreiro_servente', 'pintor']) && bf[1].especialidades_inferidas === null, 'backfill: só obras ABERTAS sem lista (1); a encerrada fica NULL', bf)
  ok((await I.backfillEspecialidadesInferidas(db)) === 0, 'backfill de novo: 0 (idempotente)')
  // Reanúncio de YS5XR: encanador JÁ avisado (push_entregas) não repete; um encanador NOVO recebe; público genérico não.
  await db.query(`INSERT INTO usuarios (id, nome, email, cidade, uf, role, tipo_prestador, cpf_cnpj, push_token, especialidades) VALUES ($1, 'Novo Encanador', 'novo@x.invalid', 'Niterói', 'RJ', 'prestador', 'reparador', '1010', $2, ARRAY['hidraulica'])`, [U(10), tok('novo')])
  await db.query(`INSERT INTO assinaturas VALUES ($1, 'ativa', NULL)`, [U(10)])
  pushes.length = 0; emails.length = 0
  const r1 = await quieto(() => O.reanunciarObraParaInferidos(D(1)))
  ok(r1.codigo === 'YS5XR' && igual(r1.slugs, ['hidraulica', 'alvenaria', 'pedreiro_servente']) && r1.push_enviados === 1 && igual(pushes.map(p => p.to), [tok('novo')]),
     'reanúncio YS5XR: SÓ o encanador novo recebe push (os já avisados e o público genérico não)', { r1, pushes: pushes.map(p => p.to) })
  ok(igual(emails.map(e => e.para).sort(), ['novo@x.invalid']), 'reanúncio: e-mail só ao novo (os demais já têm claim em email_alertas)', emails.map(e => e.para))
  const r2 = await quieto(() => O.reanunciarObraParaInferidos(D(2)))
  ok(r2.pulado === 'sem especialidade inferida' && igual(r2.slugs, []), 'BR5V3 ("Obra comercial"): sem ofício inferível → pulado, ninguém avisado', r2)
  // rodarBackfillEReanuncioUnico: claim em configuracoes, roda uma vez e grava o resultado
  pushes.length = 0
  await db.query(`DELETE FROM push_entregas WHERE usuario_id = $1`, [U(10)]) // simula: nunca avisado
  await db.query(`DELETE FROM email_alertas WHERE usuario_id = $1`, [U(10)])
  const res = await quieto(() => O.rodarBackfillEReanuncioUnico())
  const cfg = (await db.query(`SELECT chave, valor FROM configuracoes WHERE chave LIKE 'reanuncio_inferidas_v1%' ORDER BY chave`)).rows
  ok(Array.isArray(res) && res.length === 2 && res[0].codigo === 'YS5XR' && res[0].push_enviados === 1 && res[1].codigo === 'BR5V3' && res[1].pulado,
     'rodarBackfillEReanuncioUnico: YS5XR reanunciada (1 novo), BR5V3 pulada', res)
  ok(cfg.length === 2 && JSON.parse(cfg[1].valor).resultado.length === 2, 'resultado gravado em configuracoes (chave de claim + resultado JSON)', cfg.map(c => c.chave))
  ok((await quieto(() => O.rodarBackfillEReanuncioUnico())) === null && pushes.length === 1, 'segunda chamada (outro boot/réplica): claim já feito → nada reenviado')

  const inesperados = erros.filter(e => !/sem banco|PAGBANK|migration|geocod|fetch/i.test(e))
  ok(inesperados.length === 0, 'nenhum erro inesperado logado', inesperados.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error = errOrig; console.error('ERRO', e); process.exit(1) })
