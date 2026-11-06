#!/usr/bin/env node
// Testa a trava "demanda aberta" (utils/demandaAberta) nas rotas do profissional: POST /reparos/:id/
// interesse, POST /obras/:id/candidatura, .../prestador-responder e .../pintor-responder, com o SQL
// REAL num Postgres em memória (PGlite). Demanda fora de 'aberta' → 409 PEDIDO_INDISPONIVEL, nada
// gravado, dono NÃO avisado (alertaService.avisarUsuario trocado por um coletor). A corrida com o
// DELETE do dono é simulada por um gancho que cancela a demanda logo ANTES do SELECT … FOR UPDATE.
//   npm i -D @electric-sql/pglite && node scripts/testar-pedido-indisponivel.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

let db = null
let corrida = null // { antesDe: RegExp, sql, params } — roda uma vez antes do statement que casar
const query = async (sql, params) => {
  if (!db) throw new Error('sem banco (boot)')
  if (corrida && corrida.antesDe.test(sql)) { const c = corrida; corrida = null; await db.query(c.sql, c.params) }
  return db.query(sql, params)
}
const shim = { query, connect: async () => ({ query, release() {} }), on() {} }
const avisos = []
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/utils[\\/]plataforma$/.test(request)) return { ...origLoad.apply(this, arguments), registrarPlataforma() {}, detectarPlataforma() { return false } }
  if (/utils[\\/]desinstalacoes$/.test(request)) return { ...origLoad.apply(this, arguments), registrarReinstalacao() {} }
  if (/services[\\/]alertaService$/.test(request)) return { enviarBoasVindas: async () => {}, avisarUsuario: async (id, a) => { avisos.push({ para: id, ...a }) }, avisarMatchFeito: async () => {} }
  if (/services[\\/]conviteCanalService$/.test(request)) return { enviarConviteCanal: async () => 'pulado' }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })

const silencio = () => {}
const logOrig = console.log, errOrig = console.error
console.log = silencio; console.error = silencio
const router = require(path.join(REPO, 'src/routes/index.js'))
console.log = logOrig; console.error = errOrig

const handlerDe = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const chamar = (handler, { params = {}, body = {}, usuario } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, body, usuario, ip: '127.0.0.1', get() { return '' } }, res)
})
const H = {
  interesse: handlerDe('post', '/reparos/:id/interesse'),
  candidatura: handlerDe('post', '/obras/:id/candidatura'),
  prestador: handlerDe('post', '/reparos/:id/interesse/:interesse_id/prestador-responder'),
  pintor: handlerDe('post', '/obras/:id/candidatura/:candidaturaId/pintor-responder'),
}
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const DONO = U(99), PRO = U(1), PRO2 = U(2)
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const INDISP = (r) => r.status === 409 && r.body.codigo === 'PEDIDO_INDISPONIVEL' && r.body.erro === 'Este pedido não está mais disponível.'

const main = async () => {
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, criado_por uuid, status text DEFAULT 'aberta', match_usuario_id uuid, match_feito_em timestamptz`
  const colsProposta = (fk) => `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${fk} uuid, usuario_id uuid, mensagem text, valor_proposto numeric, valor_contraproposta numeric,
      rodada int, status text DEFAULT 'pendente', status_antes_match text, criado_em timestamptz DEFAULT now()`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, cpf_cnpj text, suspenso_em timestamptz);
    CREATE TABLE reparos (${colsDemanda});
    CREATE TABLE obras (${colsDemanda});
    CREATE TABLE interesse_reparos (${colsProposta('reparo_id')});
    CREATE TABLE candidaturas (${colsProposta('obra_id')});
    CREATE TABLE tentativas_contato (id bigserial PRIMARY KEY, usuario_id uuid, tipo text, demanda_id uuid, campo text, conta boolean, criado_em timestamptz DEFAULT now());
  `)
  await db.query(`INSERT INTO usuarios (id, nome, email, cpf_cnpj) VALUES ($1, 'Dono', 'dono@x.invalid', '11111111111'), ($2, 'Pro', 'pro@x.invalid', '22222222222'), ($3, 'Pro2', 'pro2@x.invalid', '33333333333')`, [DONO, PRO, PRO2])
  // Reparos: 1 aberto, 2 cancelado, 3 encerrado, 4 aberto (corrida), 5 aberto com contraproposta do dono, 6 cancelado com contraproposta do dono.
  for (const [n, status] of [[1, 'aberta'], [2, 'cancelada'], [3, 'encerrada'], [4, 'aberta'], [5, 'aberta'], [6, 'cancelada']]) {
    await db.query(`INSERT INTO reparos (id, titulo, criado_por, status) VALUES ($1, $2, $3, $4)`, [D(n), `Reparo ${n}`, DONO, status])
    await db.query(`INSERT INTO obras (id, titulo, criado_por, status) VALUES ($1, $2, $3, $4)`, [D(10 + n), `Obra ${n}`, DONO, status])
  }
  for (const n of [5, 6]) {
    await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status, valor_proposto, valor_contraproposta) VALUES ($1, $2, 'contraproposta_dono', 100, 80)`, [D(n), PRO])
    await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status, valor_proposto, valor_contraproposta) VALUES ($1, $2, 'contraproposta_dono', 100, 80)`, [D(10 + n), PRO])
  }
  const interesses = async (id) => (await db.query(`SELECT usuario_id, status, valor_proposto FROM interesse_reparos WHERE reparo_id = $1`, [id])).rows
  const candidaturas = async (id) => (await db.query(`SELECT usuario_id, status, valor_proposto FROM candidaturas WHERE obra_id = $1`, [id])).rows
  const corpo = { mensagem: 'Posso ir amanhã', valor_proposto: 90 }

  // 1) interesse em reparo aberto: 201, linha gravada, dono avisado
  let r = await chamar(H.interesse, { params: { id: D(1) }, body: corpo, usuario: { id: PRO } })
  ok(r.status === 201 && r.body.reparo_id === D(1) && (await interesses(D(1))).length === 1, 'reparo aberto: 201 e interesse gravado', r.body)
  ok(avisos.length === 1 && avisos[0].para === DONO && avisos[0].data.tipo === 'novo_interesse' && avisos[0].data.interesse_id === r.body.id, 'dono avisado (novo_interesse)', avisos[0] && avisos[0].data)
  r = await chamar(H.interesse, { params: { id: D(1) }, body: corpo, usuario: { id: PRO } })
  ok(r.status === 409 && /já demonstrou/.test(r.body.erro) && avisos.length === 1, 'repetir: 409 "já demonstrou" (sob a mesma trava), sem 2º aviso', r.body)

  // 2) reparo cancelado / encerrado: 409 PEDIDO_INDISPONIVEL, nada gravado, nenhum aviso
  for (const [n, rot] of [[2, 'cancelado'], [3, 'encerrado']]) {
    r = await chamar(H.interesse, { params: { id: D(n) }, body: corpo, usuario: { id: PRO } })
    ok(INDISP(r) && (await interesses(D(n))).length === 0 && avisos.length === 1, `reparo ${rot}: 409 PEDIDO_INDISPONIVEL, sem linha, sem aviso`, r.body)
  }
  r = await chamar(H.interesse, { params: { id: D(9) }, body: corpo, usuario: { id: PRO } })
  ok(r.status === 404, 'reparo inexistente: 404', r.body)

  // 3) CORRIDA: o dono exclui (status → cancelada) entre o clique e a trava → 409, nada entra
  corrida = { antesDe: /FROM reparos WHERE id = \$1 FOR UPDATE/, sql: `UPDATE reparos SET status = 'cancelada' WHERE id = $1`, params: [D(4)] }
  r = await chamar(H.interesse, { params: { id: D(4) }, body: corpo, usuario: { id: PRO } })
  ok(INDISP(r) && corrida === null && (await interesses(D(4))).length === 0 && avisos.length === 1, 'corrida (exclusão antes da trava): 409, sem interesse, dono não avisado', r.body)

  // 4) obra aberta → 201; cancelada/encerrada → 409
  r = await chamar(H.candidatura, { params: { id: D(11) }, body: corpo, usuario: { id: PRO } })
  ok(r.status === 201 && (await candidaturas(D(11))).length === 1 && avisos.length === 2 && avisos[1].data.tipo === 'nova_candidatura', 'obra aberta: 201, candidatura gravada, dono avisado', r.body)
  for (const n of [12, 13]) {
    r = await chamar(H.candidatura, { params: { id: D(n) }, body: corpo, usuario: { id: PRO } })
    ok(INDISP(r) && (await candidaturas(D(n))).length === 0 && avisos.length === 2, `obra ${n === 12 ? 'cancelada' : 'encerrada'}: 409, sem linha, sem aviso`, r.body)
  }
  corrida = { antesDe: /FROM obras WHERE id = \$1 FOR UPDATE/, sql: `UPDATE obras SET status = 'cancelada' WHERE id = $1`, params: [D(14)] }
  r = await chamar(H.candidatura, { params: { id: D(14) }, body: corpo, usuario: { id: PRO } })
  ok(INDISP(r) && corrida === null && (await candidaturas(D(14))).length === 0 && avisos.length === 2, 'obra: corrida com a exclusão → 409, nada gravado', r.body)

  // 5) prestador responde contraproposta do dono: reparo cancelado → 409, interesse intacto; aberto → 200
  const i6 = (await interesses(D(6)))[0]
  const idI6 = (await db.query(`SELECT id FROM interesse_reparos WHERE reparo_id = $1`, [D(6)])).rows[0].id
  for (const action of ['contraproposta', 'recusar', 'aceitar']) {
    r = await chamar(H.prestador, { params: { id: D(6), interesse_id: idI6 }, body: { action, valor: 95 }, usuario: { id: PRO } })
    const depois = (await interesses(D(6)))[0]
    ok(INDISP(r) && depois.status === i6.status && Number(depois.valor_proposto) === 100 && avisos.length === 2, `prestador ${action} em reparo cancelado: 409, interesse intacto, sem aviso`, r.body)
  }
  const idI5 = (await db.query(`SELECT id FROM interesse_reparos WHERE reparo_id = $1`, [D(5)])).rows[0].id
  r = await chamar(H.prestador, { params: { id: D(5), interesse_id: idI5 }, body: { action: 'contraproposta', valor: 95 }, usuario: { id: PRO } })
  let d5 = (await interesses(D(5)))[0]
  ok(r.status === 200 && d5.status === 'pendente' && Number(d5.valor_proposto) === 95 && avisos.length === 3 && avisos[2].data.tipo === 'contra_oferta', 'prestador contraproposta em reparo aberto: 200, pendente com valor novo, dono avisado', r.body)
  r = await chamar(H.prestador, { params: { id: D(5), interesse_id: idI5 }, body: { action: 'contraproposta', valor: 90 }, usuario: { id: PRO } })
  ok(r.status === 400 && /Não há contraproposta/.test(r.body.erro), 'sem contraproposta pendente: 400 (guarda antiga preservada)', r.body)
  r = await chamar(H.prestador, { params: { id: D(5), interesse_id: idI5 }, body: { action: 'recusar' }, usuario: { id: PRO2 } })
  ok(r.status === 404, 'interesse de outro usuário: 404', r.body)

  // 6) pintor responde contraproposta do dono: obra cancelada → 409; aberta → 200 recusado
  const idC16 = (await db.query(`SELECT id FROM candidaturas WHERE obra_id = $1`, [D(16)])).rows[0].id
  r = await chamar(H.pintor, { params: { id: D(16), candidaturaId: idC16 }, body: { action: 'recusar' }, usuario: { id: PRO } })
  ok(INDISP(r) && (await candidaturas(D(16)))[0].status === 'contraproposta_dono' && avisos.length === 3, 'pintor recusar em obra cancelada: 409, candidatura intacta, sem aviso', r.body)
  const idC15 = (await db.query(`SELECT id FROM candidaturas WHERE obra_id = $1`, [D(15)])).rows[0].id
  r = await chamar(H.pintor, { params: { id: D(15), candidaturaId: idC15 }, body: { action: 'recusar' }, usuario: { id: PRO } })
  ok(r.status === 200 && (await candidaturas(D(15)))[0].status === 'recusado' && avisos.length === 4 && avisos[3].data.tipo === 'candidatura_recusada', 'pintor recusar em obra aberta: 200, recusado, dono avisado', r.body)
  r = await chamar(H.pintor, { params: { id: D(15), candidaturaId: idC15 }, body: { action: 'xyz' }, usuario: { id: PRO } })
  ok(r.status === 400, 'ação inválida: 400', r.body)
  ok((await db.query(`SELECT count(*)::int AS n FROM tentativas_contato`)).rows[0].n === 0, 'mensagem sem contato: nada em tentativas_contato')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
