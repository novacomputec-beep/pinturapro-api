#!/usr/bin/env node
// Reanúncio ÚNICO da obra 3eab5c42 (dono, 12/11/2026 — obrasInferidasService.rodarReanunciosUnicosPorObra):
// publicada 09/11 antes da regra de água/esgoto das especialidades inferidas (10/11), recebe UMA vez o
// aviso normal de obra nova (push + e-mail, mesmos textos) com o público de HOJE, só a quem ainda não foi
// avisado (push_entregas / email_alertas tipo 'obra'), mesmo alcance, suspensão e teto diário; registrado
// como um aviso normal. Claim em configuracoes ('reanuncio_obra_3eab5c42'); só entre 08h e 20h SP; obra
// que não está mais aberta/sem match é pulada em silêncio. SQL REAL em PGlite; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-reanuncio-obra-unico.js
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
  await db.exec(`SET search_path = public, pg_catalog`)
  const fixarAgora = (iso) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${iso}'::timestamptz $$`)
  const logs = []
  const comLogs = async (fn) => { silenciar(true); console.log = (...a) => logs.push(a.join(' ')); try { return await fn() } finally { await assentar(); silenciar(false) } }

  // A obra real: publicada 09/11 17:16 SP, ANTES da regra de água/esgoto; o aviso original só alcançou o pintor.
  const OBRA = '3eab5c42-d85b-4105-a8bb-5017eb2ef29f'
  ok(O.REANUNCIOS_UNICOS_OBRA.length === 1 && O.REANUNCIOS_UNICOS_OBRA[0].obraId === OBRA && O.REANUNCIOS_UNICOS_OBRA[0].chave === 'reanuncio_obra_3eab5c42', 'lista do reanúncio único: só a obra 3eab5c42, chave reanuncio_obra_3eab5c42')
  await fixarAgora('2026-11-09T20:16:00Z')
  await db.query(`INSERT INTO obras (id, codigo_publico, titulo, descricao, categoria, cidade, uf, bairro, criado_por, valor, expira_em, criado_em, publicado_em, push_novo_enviado_em, latitude, longitude, horas_para_expirar)
                  VALUES ($1, 'MJL01', 'Instalação de ponto de água e esgoto', NULL, 'residencial', 'Niterói', 'RJ', 'Residencial Monjolo', $2, 300, now() + INTERVAL '10 days', now(), now(), now(), -22.89, -43.11, 240)`, [OBRA, DONO])
  await db.query(`INSERT INTO push_entregas (tipo, demanda_id, usuario_id, resultado) VALUES ('obra', $1, $2, 'enviado')`, [OBRA, PINTOR])
  await db.query(`INSERT INTO email_alertas (tipo, demanda_id, usuario_id) VALUES ('obra', $1, $2)`, [OBRA, PINTOR])

  // 22:00 SP: fora da janela 08–20 → não reivindica, nada sai.
  await fixarAgora('2026-11-12T01:00:00Z')
  pushes.length = 0; emails.length = 0
  await comLogs(() => O.rodarReanunciosUnicosPorObra())
  const claim = async (chave = 'reanuncio_obra_3eab5c42') => (await db.query(`SELECT valor FROM configuracoes WHERE chave = $1`, [chave])).rows[0]
  ok(pushes.length === 0 && emails.length === 0 && !(await claim()), '22:00 SP: fora da janela → nada enviado, sem claim (o tique das 08h tenta de novo)')

  // 10:00 SP: reanuncia ao público NORMAL de hoje menos quem já foi avisado.
  await fixarAgora('2026-11-12T13:00:00Z')
  await comLogs(() => O.rodarReanunciosUnicosPorObra())
  const paraPush = pushes.map(p => p.to).sort()
  ok(igual(paraPush, [tok('enc'), tok('ped')].sort()), 'push: encanador e pedreiro (público de hoje); pintor (já avisado) não; eletricista, faxina, longe, suspenso não', paraPush)
  ok(pushes.every(p => p.title === '🏠 Nova obra disponível!' && p.body === '"Instalação de ponto de água e esgoto" em Niterói acabou de ser publicada! Categoria: Residencial.' && p.data?.tipo === 'nova_obra' && p.data?.obra_id === OBRA),
     'push: texto e data do aviso normal de obra nova (toque abre a obra)', pushes[0] && [pushes[0].title, pushes[0].body, pushes[0].data])
  const paraEmail = emails.map(e => e.para).sort()
  ok(igual(paraEmail, ['enc@x.invalid', 'ped@x.invalid', 'semtoken@x.invalid']), 'e-mail: encanador, pedreiro e o sem token; pintor (já tinha e-mail) não', paraEmail)
  ok(emails.every(e => e.assunto === '⏳ Pedido ainda aberto: Instalação de ponto de água e esgoto'), 'e-mail: modelo normal (obra anunciada há > 6 h → texto "ainda aberto")', emails.map(e => e.assunto))
  const entregues = (await db.query(`SELECT usuario_id FROM push_entregas WHERE tipo = 'obra' AND demanda_id = $1 AND resultado = 'enviado' ORDER BY usuario_id`, [OBRA])).rows.map(r => r.usuario_id)
  ok(igual(entregues, [PINTOR, ENCANADOR, PEDREIRO].sort()), 'push_entregas: os novos registrados como num aviso normal (tipo obra)', entregues)
  const emailsObra = (await db.query(`SELECT count(*)::int AS n FROM email_alertas WHERE tipo = 'obra' AND demanda_id = $1`, [OBRA])).rows[0].n
  ok(emailsObra === 4, 'email_alertas: 1 original + 3 novos (tipo obra)', emailsObra)
  ok(logs.includes('[reanuncio] obra 3eab5c42: 2 push, 3 e-mail'), 'log: "[reanuncio] obra 3eab5c42: 2 push, 3 e-mail"', logs.filter(x => /reanuncio/.test(x)))
  const c1 = await claim()
  ok(c1 && JSON.parse(c1.valor).push_enviados === 2, 'claim gravado em configuracoes com o resultado', c1 && c1.valor.slice(0, 80))

  // Segundo boot / tique: nada de novo.
  pushes.length = 0; emails.length = 0; logs.length = 0
  await comLogs(() => O.rodarReanunciosUnicosPorObra())
  ok(pushes.length === 0 && emails.length === 0 && !logs.some(x => /reanuncio/.test(x)), 'rodar de novo: nada enviado (claim já existe)')

  // Teto diário: pedreiro com 15 pushes de demanda hoje → sem push (vai ao resumo); e-mail segue.
  const OBRA2 = D(70)
  await db.query(`INSERT INTO obras (id, codigo_publico, titulo, categoria, cidade, uf, criado_por, valor, expira_em, publicado_em, push_novo_enviado_em, latitude, longitude)
                  VALUES ($1, 'MJL02', 'Ponto de esgoto na área', 'residencial', 'Niterói', 'RJ', $2, 300, now() + INTERVAL '5 days', now() - INTERVAL '3 days', now() - INTERVAL '3 days', -22.89, -43.11)`, [OBRA2, DONO])
  await db.query(`INSERT INTO lembretes_push_enviados (tabela, demanda_id, usuario_id, motivo) SELECT 'obras', gen_random_uuid(), $1, 'lembrete' FROM generate_series(1, 15)`, [PEDREIRO])
  pushes.length = 0; emails.length = 0; logs.length = 0
  await comLogs(() => O.rodarReanunciosUnicosPorObra([{ chave: 'teste_teto', obraId: OBRA2 }]))
  const resumo = (await db.query(`SELECT 1 FROM avisos_acima_do_teto WHERE demanda_id = $1 AND usuario_id = $2`, [OBRA2, PEDREIRO])).rows.length
  ok(pushesDe('ped').length === 0 && resumo === 1 && emails.some(e => e.para === 'ped@x.invalid'), 'teto diário: pedreiro sem push (registrado para o resumo), e-mail sai', { pushPed: pushesDe('ped').length, resumo })

  // Obra que não está mais aberta/sem match: pula em silêncio.
  const OBRA3 = D(71)
  await db.query(`INSERT INTO obras (id, codigo_publico, titulo, categoria, cidade, uf, criado_por, valor, expira_em, publicado_em, status, match_usuario_id)
                  VALUES ($1, 'MJL03', 'Esgoto do banheiro', 'residencial', 'Niterói', 'RJ', $2, 300, now() + INTERVAL '5 days', now() - INTERVAL '3 days', 'aberta', $3)`, [OBRA3, DONO, PINTOR])
  pushes.length = 0; emails.length = 0; logs.length = 0
  await comLogs(() => O.rodarReanunciosUnicosPorObra([{ chave: 'teste_casada', obraId: OBRA3 }]))
  ok(pushes.length === 0 && emails.length === 0 && !logs.some(x => /\[reanuncio\]/.test(x)) && !!(await claim('teste_casada')), 'obra casada: nada enviado, sem log de envio, claim gravado (não tenta de novo)')

  const errosReais = erros.filter(e => !/sem banco/.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
