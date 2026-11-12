#!/usr/bin/env node
// Testa "receber promoções é da pessoa": PATCH /auth/preferencias (routes/index.js) grava
// aceita_promocoes em TODA conta de mesmo CPF normalizado (qualquer role), conta sem CPF só nela;
// e o sync único SQL_SYNC_PROMOCOES_POR_PESSOA (pessoa mista → toda true). SQL REAL em PGlite.
//   npm i -D @electric-sql/pglite && node scripts/testar-promocoes-por-pessoa.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

let db = null
const shim = {
  query: (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return db.query(sql, params) },
  connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: (sql, params) => db.query(sql, params), release() {} } },
  on() {},
}
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/utils[\\/]plataforma$/.test(request)) return { ...origLoad.apply(this, arguments), registrarPlataforma() {}, detectarPlataforma() { return false } }
  if (/utils[\\/]desinstalacoes$/.test(request)) return { ...origLoad.apply(this, arguments), registrarReinstalacao() {} }
  if (/services[\\/]alertaService$/.test(request)) return { enviarBoasVindas: async () => {} }
  if (/services[\\/]conviteCanalService$/.test(request)) return { enviarConviteCanal: async () => 'pulado' }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })

const silencio = () => {}
const logOrig = console.log, errOrig = console.error
console.log = silencio; console.error = silencio
const router = require(path.join(REPO, 'src/routes/index.js'))
console.log = logOrig; console.error = errOrig
const { SQL_SYNC_PROMOCOES_POR_PESSOA } = require(path.join(REPO, 'src/utils/promocoesPessoa.js'))

const handlerDe = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const chamar = (handler, { body = {}, usuario } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params: {}, body, usuario, ip: '127.0.0.1', get() { return '' } }, res)
})
const hPatch = handlerDe('patch', '/auth/preferencias')

const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const seed = async (linhas) => {
  await db.exec(`DROP TABLE IF EXISTS usuarios; CREATE TABLE usuarios (id uuid PRIMARY KEY, role text, cpf_cnpj text, aceita_promocoes boolean NOT NULL DEFAULT true);`)
  for (const [n, role, cpf, val] of linhas) {
    await db.query(`INSERT INTO usuarios (id, role, cpf_cnpj, aceita_promocoes) VALUES ($1::uuid, $2, $3, $4::boolean)`, [U(n), role, cpf, val])
  }
}
const valores = async () => Object.fromEntries((await db.query(`SELECT id, aceita_promocoes FROM usuarios ORDER BY id`)).rows.map(u => [u.id, u.aceita_promocoes]))

const main = async () => {
  db = new PGlite()

  // ── PATCH ──
  // Pessoa A em 3 contas e 2 roles (CPF com e sem máscara); pessoa B; duas contas sem CPF ('' e NULL).
  await seed([
    [1, 'dono_obra', '123.456.789-00', true],
    [2, 'prestador', '12345678900',    true],
    [3, 'prestador', ' 123456789-00 ', true],
    [4, 'dono_obra', '99999999999',    true],
    [5, 'prestador', '',               true],
    [6, 'dono_obra', null,             true],
  ])
  let r = await chamar(hPatch, { usuario: { id: U(2) }, body: { aceita_promocoes: false } })
  let v = await valores()
  ok(r.status === 200 && r.body.aceita_promocoes === false && r.body.contas_atualizadas === 3, 'PATCH pela conta prestador: 200, contas_atualizadas = 3', r.body)
  ok(v[U(1)] === false && v[U(2)] === false && v[U(3)] === false, 'as 3 contas do mesmo CPF (máscara/espaços, dono e prestador) ficaram false', v)
  ok(v[U(4)] === true && v[U(5)] === true && v[U(6)] === true, 'outra pessoa e contas sem CPF intactas')

  r = await chamar(hPatch, { usuario: { id: U(1) }, body: { aceita_promocoes: true } })
  v = await valores()
  ok(r.status === 200 && r.body.contas_atualizadas === 3 && v[U(2)] === true && v[U(3)] === true, 'PATCH pela conta dono religa as contas prestador', r.body)

  r = await chamar(hPatch, { usuario: { id: U(5) }, body: { aceita_promocoes: false } })
  v = await valores()
  ok(r.status === 200 && r.body.contas_atualizadas === 1 && v[U(5)] === false && v[U(6)] === true, "conta com CPF '' : só ela (não casa com a de CPF NULL)", r.body)
  r = await chamar(hPatch, { usuario: { id: U(6) }, body: { aceita_promocoes: false } })
  v = await valores()
  ok(r.status === 200 && r.body.contas_atualizadas === 1 && v[U(6)] === false && v[U(1)] === true, 'conta com CPF NULL: só ela', r.body)

  r = await chamar(hPatch, { usuario: { id: U(1) }, body: { aceita_promocoes: 'false' } })
  ok(r.status === 400, 'body não-boolean: 400', r.body)
  r = await chamar(hPatch, { usuario: { id: U(77) }, body: { aceita_promocoes: false } })
  ok(r.status === 404, 'conta inexistente: 404', r.body)

  // ── Sync único ──
  // A mista (true/false/false) → toda true; B toda false → segue false; C toda true → nada;
  // contas sem CPF false → intactas; D mista com CPF mascarado diferente → toda true.
  await seed([
    [11, 'dono_obra', '111.111.111-11', true],
    [12, 'prestador', '11111111111',    false],
    [13, 'prestador', '11111111111',    false],
    [21, 'dono_obra', '22222222222',    false],
    [22, 'prestador', '22222222222',    false],
    [31, 'dono_obra', '33333333333',    true],
    [32, 'prestador', '33333333333',    true],
    [41, 'prestador', '',               false],
    [42, 'dono_obra', null,             false],
    [43, 'dono_obra', null,             true],
    [51, 'prestador', '44.444.444/0001-44', false],
    [52, 'dono_obra', '44444444000144',     true],
  ])
  const s = await db.query(SQL_SYNC_PROMOCOES_POR_PESSOA)
  v = await valores()
  ok(s.rows.length === 3, 'sync mudou exatamente 3 contas', s.rows.map(x => x.id))
  ok(v[U(11)] && v[U(12)] && v[U(13)], 'pessoa mista → todas true')
  ok(v[U(21)] === false && v[U(22)] === false, 'pessoa toda false segue false')
  ok(v[U(31)] && v[U(32)], 'pessoa toda true intacta')
  ok(v[U(41)] === false && v[U(42)] === false, 'contas sem CPF não são tocadas (nem pela conta NULL true)')
  ok(v[U(51)] && v[U(52)], 'CNPJ com máscara casa com o sem máscara')
  const s2 = await db.query(SQL_SYNC_PROMOCOES_POR_PESSOA)
  ok(s2.rows.length === 0, 'segunda execução não muda nada (idempotente)')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
