#!/usr/bin/env node
// Testa "foto de perfil é da pessoa": PATCH e POST /auth/foto-perfil (routes/index.js) gravam a
// foto na conta que chamou E em toda conta de MESMO e-mail (dobra lower/btrim), com o SQL REAL num
// Postgres em memória (PGlite). Upload para o Cloudinary trocado por um dublê.
//   npm i -D @electric-sql/pglite && node scripts/testar-foto-por-pessoa.js
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
  if (/services[\\/]uploadService$/.test(request)) return { ...origLoad.apply(this, arguments), uploadArquivo: async () => ({ secure_url: 'https://cdn.invalid/upload.jpg' }) }
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
const chamar = (handler, { params = {}, body = {}, usuario, file } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, body, usuario, file, ip: '127.0.0.1', get() { return '' } }, res)
})
const hPatch = handlerDe('patch', '/auth/foto-perfil')
const hPost = handlerDe('post', '/auth/foto-perfil')

const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const main = async () => {
  db = new PGlite()
  await db.exec(`CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, role text, foto_url text);`)
  // Mesma pessoa em 3 contas (e-mail com caixa/espaços diferentes); outra pessoa; conta sem e-mail.
  await db.query(`INSERT INTO usuarios (id, nome, email, role, foto_url) VALUES
    ($1, 'Lu dono',  'lu@x.invalid',    'dono_obra', 'antiga-1'),
    ($2, 'Lu prof',  ' LU@X.invalid ',  'prestador', 'antiga-2'),
    ($3, 'Lu prof2', 'Lu@x.invalid',    'prestador', NULL),
    ($4, 'Outra',    'outra@x.invalid', 'dono_obra', 'antiga-4'),
    ($5, 'Sem mail', NULL,              'prestador', 'antiga-5')`, [U(1), U(2), U(3), U(4), U(5)])
  const fotos = async () => Object.fromEntries((await db.query(`SELECT id, foto_url FROM usuarios ORDER BY id`)).rows.map(u => [u.id, u.foto_url]))

  // PATCH por uma conta da pessoa → as 3 contas do e-mail; as outras intactas
  let r = await chamar(hPatch, { usuario: { id: U(1) }, body: { foto_url: 'https://cdn.invalid/nova.jpg' } })
  let f = await fotos()
  ok(r.status === 200 && r.body.foto_url === 'https://cdn.invalid/nova.jpg' && r.body.contas_atualizadas === 3, 'PATCH: 200 com contas_atualizadas = 3', r.body)
  ok(f[U(1)] === 'https://cdn.invalid/nova.jpg' && f[U(2)] === 'https://cdn.invalid/nova.jpg' && f[U(3)] === 'https://cdn.invalid/nova.jpg', 'as 3 contas do mesmo e-mail (caixa/espaços diferentes) receberam a foto', f)
  ok(f[U(4)] === 'antiga-4' && f[U(5)] === 'antiga-5', 'outra pessoa e conta sem e-mail intactas')

  // PATCH pela conta profissional → vale para a conta dono também
  r = await chamar(hPatch, { usuario: { id: U(2) }, body: { foto_url: 'https://cdn.invalid/outra.jpg' } })
  f = await fotos()
  ok(r.status === 200 && r.body.contas_atualizadas === 3 && f[U(1)] === 'https://cdn.invalid/outra.jpg', 'PATCH pela conta profissional atualiza a conta dono', { u1: f[U(1)] })

  // Conta sem e-mail: só ela
  r = await chamar(hPatch, { usuario: { id: U(5) }, body: { foto_url: 'https://cdn.invalid/solo.jpg' } })
  f = await fotos()
  ok(r.status === 200 && r.body.contas_atualizadas === 1 && f[U(5)] === 'https://cdn.invalid/solo.jpg' && f[U(1)] === 'https://cdn.invalid/outra.jpg', 'conta sem e-mail: só a própria (NULL não casa com NULL)', r.body)

  // Validação
  r = await chamar(hPatch, { usuario: { id: U(1) }, body: {} })
  ok(r.status === 400, 'PATCH sem foto_url: 400', r.body)

  // POST (upload): mesma regra
  r = await chamar(hPost, { usuario: { id: U(3) }, file: { buffer: Buffer.from('x'), mimetype: 'image/jpeg', originalname: 'a.jpg' } })
  f = await fotos()
  ok(r.status === 200 && r.body.foto_url === 'https://cdn.invalid/upload.jpg' && r.body.contas_atualizadas === 3 && f[U(1)] === 'https://cdn.invalid/upload.jpg' && f[U(2)] === 'https://cdn.invalid/upload.jpg',
     'POST (upload): as 3 contas recebem a URL enviada', r.body)
  r = await chamar(hPost, { usuario: { id: U(3) } })
  ok(r.status === 400, 'POST sem arquivo: 400', r.body)
  ok(f[U(4)] === 'antiga-4', 'outra pessoa segue intacta ao fim')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
