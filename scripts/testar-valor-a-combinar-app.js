#!/usr/bin/env node
// "VALOR A COMBINAR" × APP JÁ INSTALADO (16/11/2026): as versões em campo não conhecem a flag e
// podem quebrar com valor null. O banco guarda NULL; toda resposta ao APP devolve '0.01' no valor
// do pedido (valor / valor_estimado) com valor_a_combinar: true; o PAINEL continua recebendo null.
// Este teste roda as rotas REAIS do app pelo MESMO caminho do Express (middleware do router →
// handler) sobre o ESQUEMA DE PRODUÇÃO (scripts/fixtures/esquema-producao.sql, PGlite) e exige:
// nenhum objeto com valor_a_combinar = true sai com valor null/undefined — no feed, no detalhe,
// em minhas, meus-interesses, candidaturas e contratos — e o painel sai intocado.
//   npm i -D @electric-sql/pglite && node scripts/testar-valor-a-combinar-app.js
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
// PGlite não preenche rowCount (as rotas leem): mesma conta do pg.
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
const erros = []
const silenciar = (v) => {
  console.log = v ? () => {} : logOrig
  console.warn = v ? () => {} : warnOrig
  console.error = v ? (...a) => { erros.push(a.map(x => x?.message || String(x)).join(' ')) } : errOrig
}
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const candidaturasCtrl = require(path.join(REPO, 'src/controllers/candidaturasController'))
const V = require(path.join(REPO, 'src/utils/valorDemanda'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 200))

// Como o Express: middleware do router (o primeiro layer sem rota com esse nome) → handler final.
const iMw = router.stack.findIndex(l => !l.route && l.handle && l.handle.name === 'valorACombinarParaApp')
const iPrimeiraRota = router.stack.findIndex(l => l.route)
const handler = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const viaRouter = async (metodo, padrao, { usuario, params = {}, query = {}, body = {} } = {}) => {
  silenciar(true)
  try {
    return await new Promise(resolve => {
      const caminho = padrao.replace(/:([A-Za-z_]+)/g, (_, k) => params[k])
      const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
      const req = { method: metodo.toUpperCase(), path: caminho, params, query, body, usuario, get: () => '', headers: {}, ip: '127.0.0.1' }
      const h = padrao === '/candidaturas/minhas' ? candidaturasCtrl.minhas : handler(metodo, padrao)
      router.stack[iMw].handle(req, res, () => Promise.resolve(h(req, res)).catch(e => resolve({ status: 599, body: { erro: String(e.message) } })))
    })
  } finally { await assentar(); silenciar(false) }
}
// Chaves de valor do pedido null/undefined em objetos com valor_a_combinar = true (em qualquer nível).
const nulos = (dado, achados = [], trilha = '$') => {
  if (dado === null || typeof dado !== 'object') return achados
  if (Array.isArray(dado)) { dado.forEach((x, i) => nulos(x, achados, `${trilha}[${i}]`)); return achados }
  if (dado.valor_a_combinar === true) for (const c of ['valor', 'valor_estimado']) if (c in dado && (dado[c] === null || dado[c] === undefined)) achados.push(`${trilha}.${c}`)
  for (const k of Object.keys(dado)) nulos(dado[k], achados, `${trilha}.${k}`)
  return achados
}
// Os objetos do pedido `id` dentro do corpo (em qualquer nível).
const doPedido = (dado, id, achados = []) => {
  if (dado === null || typeof dado !== 'object') return achados
  if (Array.isArray(dado)) { dado.forEach(x => doPedido(x, id, achados)); return achados }
  if ((dado.id === id || dado.reparo_id === id || dado.obra_id === id) && 'valor_a_combinar' in dado) achados.push(dado)
  for (const k of Object.keys(dado)) doPedido(dado[k], id, achados)
  return achados
}

const DONO = { id: U(900), role: 'dono_obra', nome: 'Dona', email: 'dona@x.invalid' }
const ADM = { id: U(901), role: 'admin', nome: 'Admin', email: 'adm@x.invalid' }
const REP = { id: U(1), role: 'prestador', tipo_prestador: 'reparador' }   // tem proposta nos pedidos
const REP2 = { id: U(2), role: 'prestador', tipo_prestador: 'reparador' }  // só olha o feed
const PINTOR = { id: U(31), role: 'prestador', tipo_prestador: 'pintor' }  // tem candidatura
const PINTOR2 = { id: U(32), role: 'prestador', tipo_prestador: 'pintor' } // só olha o feed

const main = async () => {
  ok(iMw >= 0 && iMw < iPrimeiraRota, 'middleware de compatibilidade montado no router ANTES de qualquer rota', { iMw, iPrimeiraRota })

  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  const esquema = (await db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'valor_a_combinar'`)).rows
  ok(esquema.length === 2, 'esquema de produção carregado (valor_a_combinar em obras e reparos)', esquema.map(x => x.table_name))

  const usr = (u, nome, extra = {}) => {
    const cols = { id: u.id, nome, email: `${nome.toLowerCase().replace(/\s/g, '')}@x.invalid`, role: u.role, cidade: 'Uberlândia', uf: 'MG', cpf_cnpj: u.id.slice(-11), ativo: true, ...extra }
    const ks = Object.keys(cols)
    return db.query(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => cols[k]))
  }
  await usr(DONO, 'Dona')
  await usr(ADM, 'Admin', { cidade: null, uf: null })
  for (const [u, nome, esp] of [[REP, 'Rep Um', ['eletrica']], [REP2, 'Rep Dois', ['eletrica']], [PINTOR, 'Pintor Um', ['pintor']], [PINTOR2, 'Pintor Dois', ['pintor']]]) {
    await usr(u, nome, { tipo_prestador: u.tipo_prestador, especialidades: esp, push_token: `ExponentPushToken[${u.id.slice(-3)}]` })
  }
  await db.query(`INSERT INTO assinaturas (usuario_id, status, proximo_vencimento) SELECT id, 'ativa', now() + INTERVAL '30 days' FROM usuarios WHERE role = 'prestador'`)

  // Pedidos "a combinar" (valor NULL no banco): no feed (sem escolhido), com escolhido e encerrado.
  const pedido = (t, n, titulo, extra = {}) => {
    const cols = { id: D(n), titulo, descricao: 'Detalhes do pedido', categoria: t === 'reparos' ? 'eletrica' : 'residencial', cidade: 'Uberlândia', uf: 'MG', bairro: 'Centro', criado_por: DONO.id,
      status: 'aberta', status_aprovacao: 'aprovada', valor_a_combinar: true, [t === 'reparos' ? 'valor_estimado' : 'valor']: null, ...(t === 'reparos' ? { categorias: ['eletrica'], prazo_atendimento_horas: 240 } : { horas_para_expirar: 240 }), ...extra }
    const ks = Object.keys(cols)
    return db.query(`INSERT INTO ${t} (${ks.join(', ')}, expira_em${t === 'obras' ? ', publicado_em' : ''}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, now() + INTERVAL '10 days'${t === 'obras' ? ', now()' : ''})`, ks.map(k => cols[k]))
  }
  const RFEED = D(1), RESCOLHIDO = D(2), RFEITO = D(3), OFEED = D(11), OESCOLHIDO = D(12), OFEITO = D(13), RCOMVALOR = D(4)
  await pedido('reparos', 1, 'Trocar fiação')
  await pedido('reparos', 2, 'Instalar chuveiro', { match_usuario_id: REP.id, match_feito_em: new Date().toISOString() })
  await pedido('reparos', 3, 'Trocar disjuntor', { status: 'encerrada', match_usuario_id: REP.id, encerrado_em: new Date().toISOString() })
  await pedido('reparos', 4, 'Pedido com valor', { valor_a_combinar: false, valor_estimado: 150 })
  await pedido('obras', 11, 'Pintar a sala')
  await pedido('obras', 12, 'Pintar a fachada', { match_usuario_id: PINTOR.id, match_feito_em: new Date().toISOString() })
  await pedido('obras', 13, 'Pintar o muro', { status: 'encerrada', match_usuario_id: PINTOR.id, encerrado_em: new Date().toISOString() })
  const proposta = (t, id, u, status, valor) => db.query(
    `INSERT INTO ${t === 'reparos' ? 'interesse_reparos' : 'candidaturas'} (${t === 'reparos' ? 'reparo_id' : 'obra_id'}, usuario_id, status, valor_proposto, mensagem) VALUES ($1, $2, $3, $4, 'Posso fazer')`, [id, u.id, status, valor])
  await proposta('reparos', RFEED, REP, 'pendente', 180)
  await proposta('reparos', RESCOLHIDO, REP, 'aceito', 200)
  await proposta('reparos', RFEITO, REP, 'aceito', 220)
  await proposta('obras', OFEED, PINTOR, 'pendente', 900)
  await proposta('obras', OESCOLHIDO, PINTOR, 'aceito', 1200)
  await proposta('obras', OFEITO, PINTOR, 'aceito', 1500)

  // ═══ rotas do APP: pedido presente, valor '0.01', flag true, nenhum null ═══
  const rotasApp = [
    ['GET /reparos (feed)', 'get', '/reparos', { usuario: REP2, query: {} }, [RFEED]],
    ['GET /obras (feed)', 'get', '/obras', { usuario: PINTOR2, query: {} }, [OFEED]],
    ['GET /reparos/:id (detalhe, profissional)', 'get', '/reparos/:id', { usuario: REP2, params: { id: RFEED } }, [RFEED]],
    ['GET /reparos/:id (detalhe, dono)', 'get', '/reparos/:id', { usuario: DONO, params: { id: RESCOLHIDO } }, [RESCOLHIDO]],
    ['GET /obras/:id (detalhe, profissional)', 'get', '/obras/:id', { usuario: PINTOR2, params: { id: OFEED } }, [OFEED]],
    ['GET /obras/:id (detalhe, dono)', 'get', '/obras/:id', { usuario: DONO, params: { id: OESCOLHIDO } }, [OESCOLHIDO]],
    ['GET /reparos/minhas (dono)', 'get', '/reparos/minhas', { usuario: DONO }, [RFEED, RESCOLHIDO]],
    ['GET /obras/minhas (dono)', 'get', '/obras/minhas', { usuario: DONO }, [OFEED, OESCOLHIDO]],
    ['GET /reparos/meus-interesses (profissional)', 'get', '/reparos/meus-interesses', { usuario: REP }, [RFEED, RESCOLHIDO]],
    ['GET /candidaturas/minhas (profissional)', 'get', '/candidaturas/minhas', { usuario: PINTOR }, [OFEED, OESCOLHIDO]],
    ['GET /reparos/meus-contratos (profissional)', 'get', '/reparos/meus-contratos', { usuario: REP }, [RFEITO]],
    ['GET /reparos/meus-contratos-dono', 'get', '/reparos/meus-contratos-dono', { usuario: DONO }, [RFEITO]],
    ['GET /obras/meus-contratos (profissional)', 'get', '/obras/meus-contratos', { usuario: PINTOR }, [OFEITO]],
    ['GET /obras/meus-contratos-dono', 'get', '/obras/meus-contratos-dono', { usuario: DONO }, [OFEITO]],
  ]
  for (const [rot, metodo, padrao, opts, ids] of rotasApp) {
    erros.length = 0
    const resp = await viaRouter(metodo, padrao, opts)
    const ruins = nulos(resp.body)
    const itens = ids.map(id => doPedido(resp.body, id))
    const todosPresentes = itens.every(l => l.length > 0)
    const todosCompat = itens.flat().every(o => o.valor_a_combinar === true && ['valor', 'valor_estimado'].filter(c => c in o).every(c => o[c] === '0.01') && ['valor', 'valor_estimado'].some(c => c in o))
    ok(resp.status === 200 && todosPresentes && todosCompat && ruins.length === 0, `${rot}: pedido(s) a combinar com valor "0.01" + flag, nenhum null`,
       { status: resp.status, erro: resp.body && resp.body.erro, presentes: itens.map(l => l.length), nulos: ruins, erros: erros.slice(0, 2) })
  }
  // pedido COM valor: nada muda
  let r = await viaRouter('get', '/reparos/:id', { usuario: REP2, params: { id: RCOMVALOR } })
  const comValor = doPedido(r.body, RCOMVALOR)[0]
  ok(r.status === 200 && comValor && Number(comValor.valor_estimado) === 150 && comValor.valor_a_combinar === false, 'pedido com valor de verdade: valor e flag como estão no banco', comValor && [comValor.valor_estimado, comValor.valor_a_combinar])

  // criar pelo app devolve a linha já protegida; o banco fica com NULL
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS reparos_crid ON reparos (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
                 CREATE UNIQUE INDEX IF NOT EXISTS obras_crid ON obras (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;`)
  erros.length = 0
  r = await viaRouter('post', '/reparos/dono', { usuario: DONO, body: { titulo: 'Novo a combinar', categoria: 'eletrica', cidade: 'Uberlândia', uf: 'MG', valor_a_combinar: true } })
  const noBanco = r.body.id ? (await db.query(`SELECT valor_estimado, valor_a_combinar FROM reparos WHERE id = $1`, [r.body.id])).rows[0] : null
  ok(r.status === 201 && r.body.valor_estimado === '0.01' && r.body.valor_a_combinar === true && noBanco && noBanco.valor_estimado === null && noBanco.valor_a_combinar === true,
     'POST /reparos/dono (app): resposta com "0.01" + flag; no BANCO o valor continua NULL', { status: r.status, corpo: [r.body.valor_estimado, r.body.valor_a_combinar], banco: noBanco, erros: erros.slice(0, 2) })
  erros.length = 0
  r = await viaRouter('post', '/obras/dono', { usuario: DONO, body: { titulo: 'Obra nova a combinar', categoria: 'residencial', cidade: 'Uberlândia', uf: 'MG', valor_a_combinar: true } })
  const obraNoBanco = r.body.id ? (await db.query(`SELECT valor, valor_a_combinar FROM obras WHERE id = $1`, [r.body.id])).rows[0] : null
  ok(r.status === 201 && r.body.valor === '0.01' && r.body.valor_a_combinar === true && obraNoBanco && obraNoBanco.valor === null,
     'POST /obras/dono (app): resposta com "0.01" + flag; no BANCO o valor continua NULL', { status: r.status, corpo: [r.body.valor, r.body.valor_a_combinar], banco: obraNoBanco, erros: erros.slice(0, 2) })

  // ═══ PAINEL: mesmo router, resposta intocada (null + valor_acordado) ═══
  for (const [t, filtro, id, col, acordado] of [['reparos', 'abertas', RFEED, 'valor_estimado', null], ['reparos', 'abertas', RESCOLHIDO, 'valor_estimado', 200], ['reparos', 'finalizadas', RFEITO, 'valor_estimado', 220],
    ['obras', 'abertas', OFEED, 'valor', null], ['obras', 'abertas', OESCOLHIDO, 'valor', 1200], ['obras', 'finalizadas', OFEITO, 'valor', 1500]]) {
    erros.length = 0
    const resp = await viaRouter('get', `/${t}/admin`, { usuario: ADM, query: { filtro } })
    const item = (resp.body[t] || []).find(x => x.id === id)
    ok(resp.status === 200 && item && item[col] === null && item.valor_a_combinar === true && (acordado === null ? item.valor_acordado === null : Number(item.valor_acordado) === acordado),
       `painel GET /${t}/admin?filtro=${filtro} (${id.slice(-2)}): valor null, flag true, valor_acordado ${acordado === null ? 'null' : acordado}`,
       { status: resp.status, item: item && [item[col], item.valor_a_combinar, item.valor_acordado], erros: erros.slice(0, 2) })
  }
  erros.length = 0
  r = await viaRouter('get', '/admin/finalizadas', { usuario: ADM, query: { periodo: 'tudo' } })
  const fin = (r.body.finalizadas || []).filter(x => x.id === RFEITO || x.id === OFEITO)
  ok(r.status === 200 && fin.length === 2 && fin.every(x => Number(x.valor_acordado) > 0), 'painel GET /admin/finalizadas: valor combinado = proposta escolhida (220 e 1500)', { status: r.status, itens: fin.map(x => x.valor_acordado), erros: erros.slice(0, 2) })

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
