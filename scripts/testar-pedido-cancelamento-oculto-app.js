#!/usr/bin/env node
// PALIATIVO (16/11/2026): o app 1.2.2/1.2.3 instalado fecha ao abrir o detalhe de um SERVIÇO com
// pedido de acordo de cancelamento pendente. Até a correção do app sair, as respostas ao app de
// REPAROS vão sem o pedido (services/cancelamentoMatchService):
//   GET  /reparos/:id                        → pedido_cancelamento: null e reparo sem cancelamento_pedido_*
//   POST /reparos/:id/cancelar-match?simular=1 → pedido_cancelamento: null
// O banco continua guardando o pedido e ele continua valendo (responder, job de expiração). OBRAS
// não mudam. Rotas REAIS sobre o esquema de produção (scripts/fixtures/esquema-producao.sql, PGlite).
//   npm i -D @electric-sql/pglite && node scripts/testar-pedido-cancelamento-oculto-app.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

const pushes = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { pushes.push(...chunk); return chunk.map((_, i) => ({ status: 'ok', id: `t${pushes.length}-${i}` })) }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
const q = async (sql, params) => {
  if (!db) throw new Error('sem banco (boot)')
  const r = await db.query(sql, params)
  if (r && r.rowCount === undefined) r.rowCount = r.rows.length || r.affectedRows || 0
  return r
}
const shim = { query: q, connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: q, release() {} } }, on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async () => {}, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async () => {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? () => {} : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const C = require(path.join(REPO, 'src/services/cancelamentoMatchService'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 200))
const mw = router.stack.find(l => !l.route && l.handle && l.handle.name === 'valorACombinarParaApp').handle
const handler = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}
// Como o Express: middleware do router → handler final; o corpo passa por JSON como na rede.
const chamar = async (metodo, padrao, { usuario, params = {}, query = {}, body = {} } = {}) => {
  silenciar(true)
  try {
    return await new Promise(resolve => {
      const caminho = padrao.replace(/:([A-Za-z_]+)/g, (_, k) => params[k])
      const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: JSON.parse(JSON.stringify(b)) }) } }
      const req = { method: metodo.toUpperCase(), path: caminho, params, query, body, usuario, get: () => '', headers: {}, ip: '127.0.0.1' }
      mw(req, res, () => Promise.resolve(handler(metodo, padrao)(req, res)).catch(e => resolve({ status: 599, body: { erro: String(e.message) } })))
    })
  } finally { await assentar(); silenciar(false) }
}
// Toda chave do pedido de acordo que aparece no corpo, em qualquer nível (fora pedido_cancelamento: null).
const vazamentos = (dado, achados = [], trilha = '$') => {
  if (dado === null || typeof dado !== 'object') return achados
  if (Array.isArray(dado)) { dado.forEach((x, i) => vazamentos(x, achados, `${trilha}[${i}]`)); return achados }
  for (const k of Object.keys(dado)) {
    if (/^cancelamento_pedido_/.test(k)) achados.push(`${trilha}.${k}`)
    if (k === 'pedido_cancelamento' && dado[k] !== null) achados.push(`${trilha}.${k}`)
    vazamentos(dado[k], achados, `${trilha}.${k}`)
  }
  return achados
}

const DONO = { id: U(900), role: 'dono_obra', nome: 'Dona', email: 'dona@x.invalid' }
const REP = { id: U(1), role: 'prestador', tipo_prestador: 'reparador' }
const PINTOR = { id: U(31), role: 'prestador', tipo_prestador: 'pintor' }
const R1 = D(1), R2 = D(2), O1 = D(11)

const main = async () => {
  ok(C.OCULTAR_PEDIDO_CANCELAMENTO_NO_APP.reparos === true && C.OCULTAR_PEDIDO_CANCELAMENTO_NO_APP.obras === false, 'paliativo ligado só para reparos')

  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  const usr = (u, nome, extra = {}) => {
    const cols = { id: u.id, nome, email: `${nome.toLowerCase().replace(/\s/g, '')}@x.invalid`, role: u.role, cidade: 'Uberlândia', uf: 'MG', cpf_cnpj: u.id.slice(-11), ativo: true, ...extra }
    const ks = Object.keys(cols)
    return db.query(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => cols[k]))
  }
  await usr(DONO, 'Dona', { push_token: 'ExponentPushToken[dona]' })
  await usr(REP, 'Rep Um', { tipo_prestador: 'reparador', especialidades: ['panfletagem'], push_token: 'ExponentPushToken[rep]' })
  await usr(PINTOR, 'Pintor Um', { tipo_prestador: 'pintor', especialidades: ['pintor'], push_token: 'ExponentPushToken[pin]' })
  await db.query(`INSERT INTO assinaturas (usuario_id, status, proximo_vencimento) SELECT id, 'ativa', now() + INTERVAL '30 days' FROM usuarios WHERE role = 'prestador'`)

  // Pedidos com profissional escolhido e um pedido de acordo PENDENTE feito pelo profissional
  // (o caso de produção: 3529D, motivo 'outro' com texto livre).
  const pedido = (t, id, titulo, prof) => db.query(
    `INSERT INTO ${t} (id, titulo, descricao, categoria, cidade, uf, bairro, criado_por, status, status_aprovacao, ${t === 'reparos' ? 'valor_estimado, prazo_atendimento_horas, categorias' : 'valor, horas_para_expirar, publicado_em'},
                       expira_em, match_usuario_id, match_feito_em,
                       cancelamento_pedido_por, cancelamento_pedido_motivo, cancelamento_pedido_detalhe, cancelamento_pedido_em, cancelamento_pedido_expira_em)
     VALUES ($1, $2, 'Detalhes', $3, 'Uberlândia', 'MG', 'Centro', $4, 'aberta', 'aprovada', 80, 72, ${t === 'reparos' ? `ARRAY['panfletagem']` : 'now()'},
             now() + INTERVAL '3 days', $5, now() - INTERVAL '3 hours', $5, 'outro', 'Preciso combinar outra coisa', now() - INTERVAL '10 minutes', now() + INTERVAL '110 minutes')`,
    [id, titulo, t === 'reparos' ? 'panfletagem' : 'residencial', DONO.id, prof.id])
  await pedido('reparos', R1, 'Entregar panfletos', REP)
  await pedido('reparos', R2, 'Entregar convites', REP)
  await pedido('obras', O1, 'Pintar a sala', PINTOR)
  for (const r of [R1, R2]) await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status, valor_proposto, mensagem) VALUES ($1, $2, 'aceito', 80, 'Posso')`, [r, REP.id])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status, valor_proposto, mensagem) VALUES ($1, $2, 'aceito', 80, 'Posso')`, [O1, PINTOR.id])
  const noBanco = async (t, id) => (await db.query(`SELECT cancelamento_pedido_por, cancelamento_pedido_motivo, cancelamento_pedido_em, match_usuario_id, status FROM ${t} WHERE id = $1`, [id])).rows[0]

  // ── GET /reparos/:id — dono e profissional ──
  for (const [quem, u] of [['dono', DONO], ['profissional escolhido', REP]]) {
    const r = await chamar('get', '/reparos/:id', { usuario: u, params: { id: R1 } })
    ok(r.status === 200 && r.body.reparo?.id === R1, `GET /reparos/:id (${quem}): 200 com o reparo`, r.status === 200 ? undefined : r.body)
    ok('pedido_cancelamento' in r.body && r.body.pedido_cancelamento === null, `GET /reparos/:id (${quem}): pedido_cancelamento presente e null`, r.body.pedido_cancelamento)
    ok(C.COLUNAS_PEDIDO_CANCELAMENTO.every(c => !(c in (r.body.reparo || {}))), `GET /reparos/:id (${quem}): reparo sem nenhuma coluna cancelamento_pedido_*`, Object.keys(r.body.reparo || {}).filter(k => /cancelamento_pedido/.test(k)))
    ok(vazamentos(r.body).length === 0, `GET /reparos/:id (${quem}): nada do pedido em nenhum nível do corpo`, vazamentos(r.body))
    ok(r.body.reparo?.match_usuario_id === REP.id && r.body.reparo?.titulo === 'Entregar panfletos', `GET /reparos/:id (${quem}): o resto do reparo segue igual`)
  }

  // ── POST /reparos/:id/cancelar-match?simular=1 — dono e profissional ──
  for (const [quem, u, papel] of [['dono', DONO, 'dono'], ['profissional', REP, 'profissional']]) {
    const r = await chamar('post', '/reparos/:id/cancelar-match', { usuario: u, params: { id: R1 }, query: { simular: '1' } })
    ok(r.status === 200 && typeof r.body.tipo === 'string' && r.body.papel === papel, `simular (${quem}): 200 com tipo e papel`, r.body)
    ok('pedido_cancelamento' in r.body && r.body.pedido_cancelamento === null, `simular (${quem}): pedido_cancelamento null`, r.body.pedido_cancelamento)
    ok(vazamentos(r.body).length === 0, `simular (${quem}): nada do pedido no corpo`, vazamentos(r.body))
  }
  const b1 = await noBanco('reparos', R1)
  ok(b1.cancelamento_pedido_por === REP.id && b1.cancelamento_pedido_motivo === 'outro' && b1.cancelamento_pedido_em !== null && b1.match_usuario_id === REP.id,
    'banco: o pedido de acordo continua gravado e o match de pé depois das leituras e da simulação', b1)

  // ── O pedido continua VALENDO: novo pedido é barrado; o dono responde; o job expira ──
  const dup = await chamar('post', '/reparos/:id/cancelamento-acordo', { usuario: DONO, params: { id: R1 }, body: { motivo: 'outro', detalhe: 'x' } })
  ok(dup.status === 409 && dup.body.codigo === 'PEDIDO_PENDENTE', 'novo pedido com um pendente: 409 PEDIDO_PENDENTE (o pedido oculto segue valendo)', dup.body.codigo)
  const rec = await chamar('post', '/reparos/:id/cancelamento-acordo/responder', { usuario: DONO, params: { id: R1 }, body: { aceitar: false } })
  const b1r = await noBanco('reparos', R1)
  ok(rec.status === 200 && b1r.cancelamento_pedido_em === null && b1r.match_usuario_id === REP.id, 'dono RECUSA o pedido: 200, pedido limpo, match mantido', { status: rec.status, b1r })

  const ac = await chamar('post', '/reparos/:id/cancelamento-acordo/responder', { usuario: DONO, params: { id: R2 }, body: { aceitar: true } })
  const b2 = await noBanco('reparos', R2)
  ok(ac.status === 200 && ac.body.acordo === true && b2.match_usuario_id === null, 'dono ACEITA o pedido: 200, acordo, match desfeito', { status: ac.status, corpo: ac.body, b2 })

  await db.query(`UPDATE reparos SET match_usuario_id = $2, match_feito_em = now(), cancelamento_pedido_por = $2, cancelamento_pedido_motivo = 'outro', cancelamento_pedido_em = now() - INTERVAL '3 hours', cancelamento_pedido_expira_em = now() - INTERVAL '1 hour' WHERE id = $1`, [R1, REP.id])
  pushes.length = 0
  silenciar(true); await C.expirarPedidosCancelamento(); await assentar(); silenciar(false)
  const b1e = await noBanco('reparos', R1)
  ok(b1e.cancelamento_pedido_em === null && b1e.match_usuario_id === REP.id, 'job de expiração: pedido vencido é limpo e o match fica', b1e)
  ok(pushes.some(p => p.data?.tipo === 'pedido_cancelamento_expirado' && p.data?.reparo_id === R1), 'job de expiração: quem pediu recebe o push de pedido expirado', pushes.map(p => p.data?.tipo))

  // ── OBRAS: nada muda ──
  for (const [quem, u] of [['dono', DONO], ['pintor escolhido', PINTOR]]) {
    const r = await chamar('get', '/obras/:id', { usuario: u, params: { id: O1 } })
    ok(r.status === 200 && r.body.pedido_cancelamento?.por === 'profissional' && r.body.pedido_cancelamento?.motivo === 'outro', `GET /obras/:id (${quem}): pedido_cancelamento continua saindo`, r.status === 200 ? r.body.pedido_cancelamento : r.body)
    ok(r.body.obra?.cancelamento_pedido_em != null && r.body.obra?.cancelamento_pedido_por === PINTOR.id, `GET /obras/:id (${quem}): obra continua com cancelamento_pedido_*`)
  }
  const so = await chamar('post', '/obras/:id/cancelar-match', { usuario: DONO, params: { id: O1 }, query: { simular: '1' } })
  ok(so.status === 200 && so.body.pedido_cancelamento?.por === 'profissional', 'simular em OBRA: pedido_cancelamento continua saindo', so.body.pedido_cancelamento)

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { silenciar(false); console.error('ERRO', e); process.exit(1) })
