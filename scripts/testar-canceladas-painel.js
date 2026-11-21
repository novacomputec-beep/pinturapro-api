#!/usr/bin/env node
// LISTAS "CANCELADAS" DO PAINEL (dono, 21/11/2026 — caso U94JN/H32VT: cancelados pelo cliente de
// manhã, com prazo de 24h, ficavam no meio da lista, abaixo dos de prazo longo).
//  1) GET /reparos/admin?filtro=canceladas e /obras/admin?filtro=canceladas ordenam pelo instante em
//     que o pedido saiu do ar, mais recente primeiro: encerrado_em do cancelado/recusado; expira_em
//     do que só venceu (segue 'aberta') e do cancelado antigo sem encerrado_em;
//  2) cancelada_por: 'cliente' (DELETE /reparos/dono/:id e /obras/dono/:id, inclusive com o
//     atendimento em andamento), 'admin' (POST /admin/:tabela/:id/cancelar), null no resto (recusa
//     da aprovação, vencido, histórico — sem backfill); sai nas duas listas do painel;
//  3) os filtros 'abertas' e 'finalizadas' seguem na ordem de sempre (expira_em).
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-canceladas-painel.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { return chunk.map((_, i) => ({ status: 'ok', id: `t-${i}` })) }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
const q = async (sql, params) => { if (!db) throw new Error('sem banco (boot)'); const r = await db.query(sql, params); r.rowCount = r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0); return r }
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
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const erros = []
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { errOrig('unhandled', e && (e.stack || e)); process.exit(1) } })
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? (...a) => erros.push(a.map(x => x?.message || String(x)).join(' ').slice(0, 300)) : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 300))
const ADMIN = U(1), DONO = U(10), PRO = U(20)
const SESSAO = { [ADMIN]: { role: 'admin' }, [DONO]: { role: 'dono_obra' }, [PRO]: { role: 'prestador', tipo_prestador: 'reparador' } }
const chamar = (metodo, caminho, usuarioId, { body = {}, params = {}, query = {} } = {}) => new Promise((resolve, reject) => {
  const camada = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!camada) return reject(new Error(`rota não encontrada: ${metodo} ${caminho}`))
  const handler = camada.route.stack[camada.route.stack.length - 1].handle
  const req = { params, body, query, headers: {}, usuario: { id: usuarioId, ...(SESSAO[usuarioId] || {}) }, get() { return '' } }
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  Promise.resolve(handler(req, res)).catch(reject)
})
const quieto = async (fn) => { silenciar(true); try { return await fn() } finally { await assentar(); silenciar(false) } }

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`CREATE UNIQUE INDEX t_configuracoes_uq ON configuracoes (chave); CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id)`)
  await db.query(`INSERT INTO usuarios (id, nome, email, role, cidade, uf, cpf_cnpj) VALUES
    ($1, 'Admin', 'admin@x.invalid', 'admin', NULL, NULL, '00000000001'),
    ($2, 'Thaís Cliente', 'dono@x.invalid', 'dono_obra', 'Patos de Minas', 'MG', '00000000010'),
    ($3, 'Pro Teste', 'pro@x.invalid', 'prestador', 'Patos de Minas', 'MG', '00000000020')`, [ADMIN, DONO, PRO])
  // encerradoHa / expiraEm em horas relativas a agora (negativo = passado); null = coluna NULL.
  const demanda = (tabela, id, cod, titulo, status, { encerradoHa = null, expiraEm, aprovacao = null, match = null, chegada = false } = {}) => db.query(
    `INSERT INTO ${tabela} (id, codigo_publico, titulo, categoria, criado_por, ${tabela === 'reparos' ? 'valor_estimado, prazo_atendimento_horas' : 'valor, horas_para_expirar'}, cidade, uf, status, status_aprovacao,
                            criado_em, expira_em, encerrado_em, match_usuario_id, match_feito_em, chegada_confirmada_em, push_novo_enviado_em)
     VALUES ($1, $2, $3, $4, $5, 100, 24, 'Patos de Minas', 'MG', $6, $7, now() - INTERVAL '30 days', now() + make_interval(mins => $8::int),
             CASE WHEN $9::int IS NULL THEN NULL ELSE now() - make_interval(mins => $9::int) END, $10::uuid,
             CASE WHEN $10::uuid IS NULL THEN NULL ELSE now() - INTERVAL '3 hours' END, CASE WHEN $11::boolean THEN now() - INTERVAL '1 hour' ELSE NULL END, now() - INTERVAL '30 days')`,
    [id, cod, titulo, tabela === 'reparos' ? 'salgadeiro' : 'residencial', DONO, status, aprovacao || (status === 'aberta' ? 'aprovada' : status),
     Math.round(expiraEm * 60), encerradoHa === null ? null : Math.round(encerradoHa * 60), match, chegada])
  const lista = async (tabela, filtro) => {
    const r = await quieto(() => chamar('get', `/${tabela}/admin`, ADMIN, { query: { filtro } }))
    return { status: r.status, linhas: r.body?.[tabela] || [], erro: r.body?.erro }
  }
  const codigos = (l) => l.linhas.map(x => x.codigo_publico)
  const porCodigo = (l) => Object.fromEntries(l.linhas.map(x => [x.codigo_publico, x]))
  const colunaDe = async (tabela, id) => (await db.query(`SELECT status, cancelada_por, encerrado_em FROM ${tabela} WHERE id = $1`, [id])).rows[0]

  for (const [tabela, rotaDono] of [['reparos', '/reparos/dono/:id'], ['obras', '/obras/dono/:id']]) {
    const T = tabela === 'reparos' ? 'R' : 'O'
    const base = tabela === 'reparos' ? 0 : 100
    // ═══ 1. Ordem da lista ═══════════════════════════════════════════════════════════════════
    await demanda(tabela, D(base + 1), `${T}HOJE`, 'Cancelado hoje, prazo de 24h', 'cancelada', { encerradoHa: 2, expiraEm: 1 })
    await demanda(tabela, D(base + 2), `${T}LONG`, 'Cancelado há 5 dias, prazo longo', 'cancelada', { encerradoHa: 120, expiraEm: 24 * 20 })
    await demanda(tabela, D(base + 3), `${T}VENC1`, 'Venceu ontem', 'aberta', { expiraEm: -24 })
    await demanda(tabela, D(base + 4), `${T}VENC3`, 'Venceu há 3 dias', 'aberta', { expiraEm: -72 })
    await demanda(tabela, D(base + 5), `${T}LEG`, 'Cancelado antigo sem encerrado_em', 'cancelada', { expiraEm: -48 })
    await demanda(tabela, D(base + 6), `${T}REC`, 'Recusado há 4 dias', 'cancelada', { encerradoHa: 96, expiraEm: 24 * 10, aprovacao: 'recusada' })
    let l = await lista(tabela, 'canceladas')
    ok(l.status === 200 && JSON.stringify(codigos(l)) === JSON.stringify([`${T}HOJE`, `${T}VENC1`, `${T}LEG`, `${T}VENC3`, `${T}REC`, `${T}LONG`]),
       `${tabela} canceladas: mais recente primeiro — fechamento do cancelado, expira_em do vencido e do cancelado sem encerrado_em`, { status: l.status, ordem: codigos(l), erro: l.erro })
    ok(codigos(l)[0] === `${T}HOJE` && codigos(l).indexOf(`${T}LONG`) === 5, `${tabela}: o cancelado HOJE com prazo curto sobe ao topo; o de prazo longo (antes o 1º) vai para o fim`)
    ok(l.linhas.every(x => Object.prototype.hasOwnProperty.call(x, 'cancelada_por') && x.cancelada_por === null), `${tabela}: cancelada_por sai na lista; histórico sem carimbo = null (sem backfill)`, l.linhas.map(x => x.cancelada_por))
    ok(porCodigo(l)[`${T}VENC1`].situacao_painel === 'expirada' && porCodigo(l)[`${T}HOJE`].situacao_painel === 'cancelada', `${tabela}: situacao_painel e o filtro não mudaram`)

    // ═══ 2. cancelada_por ════════════════════════════════════════════════════════════════════
    await demanda(tabela, D(base + 10), `${T}CLI`, 'Aberto que o cliente cancela', 'aberta', { expiraEm: 24 * 15 })
    await demanda(tabela, D(base + 11), `${T}ADM`, 'Aberto que o admin cancela', 'aberta', { expiraEm: 24 * 15 })
    await demanda(tabela, D(base + 12), `${T}AND`, 'Em andamento que o cliente cancela', 'aberta', { expiraEm: 24 * 15, match: PRO, chegada: true })
    const prop = tabela === 'reparos' ? ['interesse_reparos', 'reparo_id'] : ['candidaturas', 'obra_id']
    await db.query(`INSERT INTO ${prop[0]} (${prop[1]}, usuario_id, status, valor_proposto) VALUES ($1, $2, 'aceito', 90)`, [D(base + 12), PRO])
    let r = await quieto(() => chamar('delete', rotaDono, DONO, { params: { id: D(base + 10) } }))
    let c = await colunaDe(tabela, D(base + 10))
    ok(r.status === 200 && c.status === 'cancelada' && c.cancelada_por === 'cliente' && c.encerrado_em !== null, `DELETE ${rotaDono}: cancelada_por = 'cliente'`, { status: r.status, c, erro: r.body?.erro })
    r = await quieto(() => chamar('post', `/admin/${tabela}/:id/cancelar`, ADMIN, { params: { id: D(base + 11) }, body: { motivo: 'teste' } }))
    c = await colunaDe(tabela, D(base + 11))
    ok(r.status === 200 && c.status === 'cancelada' && c.cancelada_por === 'admin', `POST /admin/${tabela}/:id/cancelar: cancelada_por = 'admin'`, { status: r.status, c, erro: r.body?.erro })
    r = await quieto(() => chamar('delete', rotaDono, DONO, { params: { id: D(base + 12) } }))
    c = await colunaDe(tabela, D(base + 12))
    ok(r.status === 200 && r.body.em_andamento === true && c.status === 'cancelada' && c.cancelada_por === 'cliente', `DELETE ${rotaDono} com atendimento em andamento: também 'cliente'`, { status: r.status, body: r.body, c })
    c = await colunaDe(tabela, D(base + 1))
    ok(c.cancelada_por === null && (await colunaDe(tabela, D(base + 6))).cancelada_por === null, `${tabela}: cancelados de antes e recusa da aprovação seguem com cancelada_por NULL`)
    l = await lista(tabela, 'canceladas')
    const topo = codigos(l).slice(0, 3).sort()
    ok(JSON.stringify(topo) === JSON.stringify([`${T}ADM`, `${T}AND`, `${T}CLI`].sort()) && codigos(l)[3] === `${T}HOJE` && l.linhas.length === 9,
       `${tabela} canceladas: os 3 cancelados agora são os 3 primeiros, acima do cancelado há 2h`, codigos(l))
    const pc = porCodigo(l)
    ok(pc[`${T}CLI`].cancelada_por === 'cliente' && pc[`${T}AND`].cancelada_por === 'cliente' && pc[`${T}ADM`].cancelada_por === 'admin' && pc[`${T}HOJE`].cancelada_por === null && pc[`${T}VENC1`].cancelada_por === null,
       `${tabela}: a lista devolve cancelada_por 'cliente' | 'admin' | null`, Object.fromEntries(l.linhas.map(x => [x.codigo_publico, x.cancelada_por])))

    // ═══ 3. Demais filtros: ordem de sempre ══════════════════════════════════════════════════
    await demanda(tabela, D(base + 20), `${T}AB1`, 'Aberto, vence em 2 dias', 'aberta', { expiraEm: 48 })
    await demanda(tabela, D(base + 21), `${T}AB2`, 'Aberto, vence em 9 dias', 'aberta', { expiraEm: 216 })
    await demanda(tabela, D(base + 22), `${T}FIM1`, 'Encerrado agora, prazo antigo', 'encerrada', { encerradoHa: 0.1, expiraEm: -500 })
    await demanda(tabela, D(base + 23), `${T}FIM2`, 'Encerrado há 9 dias, prazo recente', 'encerrada', { encerradoHa: 216, expiraEm: -100 })
    l = await lista(tabela, 'abertas')
    ok(JSON.stringify(codigos(l)) === JSON.stringify([`${T}AB2`, `${T}AB1`]) && l.linhas.every(x => x.cancelada_por === null), `${tabela} abertas: ordem por expira_em (como antes); cancelada_por null`, codigos(l))
    l = await lista(tabela, 'finalizadas')
    ok(JSON.stringify(codigos(l)) === JSON.stringify([`${T}FIM2`, `${T}FIM1`]), `${tabela} finalizadas: ordem por expira_em (como antes — só 'canceladas' mudou)`, codigos(l))
  }

  const errosReais = erros.filter(e => !/sem banco|migration/i.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
