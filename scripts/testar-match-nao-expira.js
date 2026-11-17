#!/usr/bin/env node
// PEDIDO COM PROFISSIONAL ESCOLHIDO NÃO EXPIRA POR expira_em (dono, 17/11/2026 — caso 3529D):
// expira_em é só o prazo de ESCOLHA. Reparo/obra 'aberta' com match_usuario_id e expira_em no
// passado continua em "Em aberto" (GET /reparos/minhas e /obras/minhas: fora de `historico`, com
// expirada = false) e, no painel (GET /reparos/admin e /obras/admin), fica no filtro 'abertas'
// com situacao_painel = 'aberta' e expirada = false. Do lado do PROFISSIONAL escolhido, o mesmo:
// GET /reparos/meus-interesses mantém o serviço em `ativos` com reparo_expirada = false e
// GET /candidaturas/minhas devolve obra_expirada = false. SEM match, tudo como antes: vencido
// vai para o histórico / 'canceladas' como 'expirada'.
// Rotas REAIS sobre o ESQUEMA DE PRODUÇÃO (scripts/fixtures/esquema-producao.sql, PGlite).
//   npm i -D @electric-sql/pglite && node scripts/testar-match-nao-expira.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

class FakeExpo {
  static isExpoPushToken() { return true }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { return chunk.map(() => ({ status: 'ok', id: 't' })) }
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
const silenciar = (v) => {
  console.log = v ? () => {} : logOrig
  console.warn = v ? () => {} : warnOrig
  console.error = v ? () => {} : errOrig
}
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`

const handler = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const chamar = async (metodo, caminho, { usuario, query = {} } = {}) => {
  silenciar(true)
  try {
    return await new Promise(resolve => {
      const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
      const req = { method: metodo.toUpperCase(), path: caminho, params: {}, query, body: {}, usuario, get: () => '', headers: {}, ip: '127.0.0.1' }
      Promise.resolve(handler(metodo, caminho)(req, res)).catch(e => resolve({ status: 599, body: { erro: String(e.message) } }))
    })
  } finally { silenciar(false) }
}

const DONO = { id: U(900), role: 'dono_obra' }
const ADM = { id: U(901), role: 'admin' }
const PROF = { id: U(1), role: 'prestador' }
const OUTRO = { id: U(2), role: 'prestador' }

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))

  const usr = (u, nome) => db.query(
    `INSERT INTO usuarios (id, nome, email, role, cidade, uf, cpf_cnpj, ativo) VALUES ($1, $2, $3, $4, 'Patos de Minas', 'MG', $5, true)`,
    [u.id, nome, `${nome.toLowerCase()}@x.invalid`, u.role, u.id.slice(-11)])
  await usr(DONO, 'Dono'); await usr(ADM, 'Admin'); await usr(PROF, 'Emilyn'); await usr(OUTRO, 'Outro')

  // expira = expressão SQL do expira_em; extra = colunas a mais (valores JS).
  const pedido = (t, n, titulo, expira, extra = {}) => {
    const cols = { id: D(n), titulo, descricao: 'x', categoria: t === 'reparos' ? 'panfletagem' : 'residencial', cidade: 'Patos de Minas', uf: 'MG', bairro: 'Centro',
      criado_por: DONO.id, status: 'aberta', status_aprovacao: 'aprovada', [t === 'reparos' ? 'valor_estimado' : 'valor']: 80,
      ...(t === 'reparos' ? { prazo_atendimento_horas: 24 } : { horas_para_expirar: 24 }), ...extra }
    const ks = Object.keys(cols)
    return db.query(`INSERT INTO ${t} (${ks.join(', ')}, expira_em${t === 'obras' ? ', publicado_em' : ''}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, ${expira}${t === 'obras' ? ', now()' : ''})`, ks.map(k => cols[k]))
  }
  const h = (horas) => new Date(Date.now() + horas * 3600000).toISOString()
  const match = { match_usuario_id: PROF.id, match_feito_em: h(-21) }

  for (const [t, base, chaveAtivos] of [['reparos', 0, 'reparos'], ['obras', 100, 'obras']]) {
    // 1: como o 3529D — escolhido, horário combinado já passado, chegada confirmada, expira_em vencido há 15h.
    await pedido(t, base + 1, `${t} tipo 3529D`, `now() - INTERVAL '15 hours'`, { ...match, chegada_janela: 'agendado', chegada_prevista_em: h(-20),
      chegada_declarada_por: DONO.id, chegada_declarada_em: h(-19), chegada_confirmada_em: h(-19) })
    // 2: escolhido, SEM horário combinado, expira_em vencido.
    await pedido(t, base + 2, `${t} match sem horario`, `now() - INTERVAL '2 hours'`, match)
    // 3: SEM escolhido, expira_em vencido → expirado como sempre.
    await pedido(t, base + 3, `${t} vencido sem match`, `now() - INTERVAL '2 hours'`)
    // 4: SEM escolhido, no prazo.
    await pedido(t, base + 4, `${t} no prazo`, `now() + INTERVAL '5 hours'`)
    // 5: encerrado com profissional.
    await pedido(t, base + 5, `${t} feito`, `now() - INTERVAL '30 hours'`, { ...match, status: 'encerrada', status_aprovacao: 'encerrada', encerrado_em: h(-1) })

    const m = await chamar('get', `/${t}/minhas`, { usuario: DONO })
    const ativos = Object.fromEntries((m.body[chaveAtivos] || []).map(x => [x.id, x]))
    const hist = Object.fromEntries((m.body.historico || []).map(x => [x.id, x]))
    ok(m.status === 200, `GET /${t}/minhas 200`, m.body?.erro)
    ok(!!ativos[D(base + 1)] && !hist[D(base + 1)] && ativos[D(base + 1)].expirada === false,
      `${t}/minhas: tipo 3529D (match + chegada confirmada + expira_em vencido) fica em "Em aberto", expirada=false`, ativos[D(base + 1)]?.expirada)
    ok(!!ativos[D(base + 2)] && !hist[D(base + 2)] && ativos[D(base + 2)].expirada === false,
      `${t}/minhas: match sem horário e expira_em vencido fica em "Em aberto", expirada=false`, ativos[D(base + 2)]?.expirada)
    ok(!!hist[D(base + 3)] && !ativos[D(base + 3)] && hist[D(base + 3)].expirada === true,
      `${t}/minhas: SEM match e vencido continua no histórico, expirada=true`, hist[D(base + 3)]?.expirada)
    ok(!!ativos[D(base + 4)] && ativos[D(base + 4)].expirada === false, `${t}/minhas: sem match no prazo fica em "Em aberto"`)
    ok(!!hist[D(base + 5)] && hist[D(base + 5)].expirada === false, `${t}/minhas: encerrado fica no histórico, expirada=false`)

    const painel = async (filtro) => {
      const r = await chamar('get', `/${t}/admin`, { usuario: ADM, query: { filtro } })
      return Object.fromEntries((r.body[t] || []).map(x => [x.id, x]))
    }
    const ab = await painel('abertas'), ca = await painel('canceladas'), fi = await painel('finalizadas')
    for (const [n, rot] of [[1, 'tipo 3529D'], [2, 'match sem horário']]) {
      const x = ab[D(base + n)]
      ok(!!x && x.situacao_painel === 'aberta' && x.expirada === false && !ca[D(base + n)],
        `${t}/admin: ${rot} está em 'abertas' (situacao_painel aberta, expirada=false) e fora de 'canceladas'`, x && [x.situacao_painel, x.expirada])
    }
    ok(ca[D(base + 3)]?.situacao_painel === 'expirada' && ca[D(base + 3)].expirada === true && !ab[D(base + 3)],
      `${t}/admin: SEM match e vencido continua em 'canceladas' como expirada`, ca[D(base + 3)] && [ca[D(base + 3)].situacao_painel, ca[D(base + 3)].expirada])
    ok(ab[D(base + 4)]?.situacao_painel === 'aberta' && !ca[D(base + 4)], `${t}/admin: sem match no prazo em 'abertas'`)
    ok(fi[D(base + 5)]?.situacao_painel === 'encerrada' && !ab[D(base + 5)] && !ca[D(base + 5)], `${t}/admin: encerrado com profissional só em 'finalizadas', situacao_painel encerrada`)
    const inv = await chamar('get', `/${t}/admin`, { usuario: ADM, query: { filtro: 'toString' } })
    ok(inv.status === 400, `${t}/admin: filtro inválido → 400`, inv.status)

    // ---- LADO DO PROFISSIONAL (a Emilyn do 3529D): GET /reparos/meus-interesses e /candidaturas/minhas ----
    const [tp, fk] = t === 'reparos' ? ['interesse_reparos', 'reparo_id'] : ['candidaturas', 'obra_id']
    const proposta = (n, u, status) => db.query(`INSERT INTO ${tp} (${fk}, usuario_id, status, valor_proposto) VALUES ($1, $2, $3, 80)`, [D(base + n), u.id, status])
    await proposta(1, PROF, 'aceito'); await proposta(2, PROF, 'aceito'); await proposta(3, PROF, 'pendente')
    await proposta(4, PROF, 'pendente'); await proposta(5, PROF, 'aceito')
    await proposta(1, OUTRO, 'recusado') // concorrente rebaixado pelo match do pedido 1
    if (t === 'reparos') {
      const mi = await chamar('get', '/reparos/meus-interesses', { usuario: PROF })
      const at = Object.fromEntries((mi.body.ativos || []).map(x => [x.reparo_id, x]))
      const hi = Object.fromEntries((mi.body.historico || []).map(x => [x.reparo_id, x]))
      ok(mi.status === 200, 'GET /reparos/meus-interesses 200', mi.body?.erro)
      for (const [n, rot] of [[1, 'tipo 3529D'], [2, 'match sem horário']]) {
        ok(!!at[D(n)] && !hi[D(n)] && at[D(n)].reparo_expirada === false && at[D(n)].match_da_pessoa === true,
          `meus-interesses (escolhida): ${rot} com expira_em vencido fica em ativos, reparo_expirada=false`, at[D(n)] && [at[D(n)].reparo_expirada, at[D(n)].match_da_pessoa])
      }
      ok(!!hi[D(3)] && !at[D(3)] && hi[D(3)].reparo_expirada === true, 'meus-interesses: SEM match e vencido continua no histórico, reparo_expirada=true', hi[D(3)]?.reparo_expirada)
      ok(!!at[D(4)] && at[D(4)].reparo_expirada === false, 'meus-interesses: sem match no prazo fica em ativos')
      ok(!!hi[D(5)] && hi[D(5)].reparo_expirada === false, 'meus-interesses: encerrado fica no histórico, reparo_expirada=false')
      const mo = await chamar('get', '/reparos/meus-interesses', { usuario: OUTRO })
      const hio = (mo.body.historico || []).find(x => x.reparo_id === D(1))
      ok(!!hio && !(mo.body.ativos || []).some(x => x.reparo_id === D(1)) && hio.reparo_expirada === false,
        'meus-interesses (concorrente recusado no pedido com match): segue no histórico pelo status do interesse', hio && [hio.status, hio.reparo_expirada])
    } else {
      const mc = await chamar('get', '/candidaturas/minhas', { usuario: PROF })
      const c = Object.fromEntries((mc.body.candidaturas || []).map(x => [x.obra_id, x]))
      ok(mc.status === 200 && Object.keys(c).length === 5, 'GET /candidaturas/minhas 200 com as 5 candidaturas', mc.body?.erro || Object.keys(c).length)
      for (const [n, rot] of [[1, 'tipo 3529D'], [2, 'match sem horário']]) {
        ok(c[D(base + n)]?.obra_expirada === false && c[D(base + n)].match_da_pessoa === true,
          `candidaturas/minhas (escolhido): ${rot} com expira_em vencido tem obra_expirada=false`, c[D(base + n)] && [c[D(base + n)].obra_expirada, c[D(base + n)].match_da_pessoa])
      }
      ok(c[D(base + 3)]?.obra_expirada === true, 'candidaturas/minhas: SEM match e vencida continua obra_expirada=true', c[D(base + 3)]?.obra_expirada)
      ok(c[D(base + 4)]?.obra_expirada === false, 'candidaturas/minhas: sem match no prazo, obra_expirada=false')
      ok(c[D(base + 5)]?.obra_expirada === false && c[D(base + 5)].obra_status === 'encerrada', 'candidaturas/minhas: encerrada, obra_expirada=false')
    }
  }

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
