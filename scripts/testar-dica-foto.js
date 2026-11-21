#!/usr/bin/env node
// DICA DE FOTO (dono, 20/11/2026 — utils/dicaFoto): pergunta de profissional em pedido SEM foto/vídeo
// → o aviso ao dono (push/e-mail) termina com " · Dica: adicione uma foto ou vídeo 📸". Vale para
// toda obra e para reparo com alguma categoria de CATEGORIAS_PEDE_FOTO; com mídia ou em outra
// categoria o texto fica como era.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; handler real; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-dica-foto.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

const pushes = []
const emails = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { pushes.push(...chunk); return chunk.map((_, i) => ({ status: 'ok', id: `t${pushes.length}-${i}` })) }
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
  if (/brevoService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) }, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) } }
  return origLoad.apply(this, arguments)
}
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const erros = []
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { errOrig('unhandled', e && (e.stack || e)); process.exit(1) } })
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? (...a) => erros.push(a.map(x => x?.message || String(x)).join(' ').slice(0, 300)) : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
silenciar(false)
const DF = require(path.join(REPO, 'src/utils/dicaFoto'))
const { CATEGORIAS_SERVICO } = require(path.join(REPO, 'src/utils/categoriasApp'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const DONO = U(1), DONO_SEM_TOKEN = U(2), PRO = U(3)
const TOKEN_DONO = 'ExponentPushToken[dono]'
const handler = (caminho) => { const r = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods.post).route; return r.stack[r.stack.length - 1].handle }
const perguntar = (tabela, id) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler(`/${tabela}/:id/perguntas`)({ params: { id }, body: { pergunta: 'Qual o tamanho do serviço?' }, query: {}, headers: {}, usuario: { id: PRO, role: 'prestador', tipo_prestador: 'reparador' }, get() { return '' } }, res)
})
const DICA = ' · Dica: adicione uma foto ou vídeo 📸'
const BASE = (titulo) => `${titulo}: responda para atrair propostas`
// Pergunta e devolve o texto do aviso que saiu (push ao dono com token; e-mail ao dono sem token).
const avisoDe = async (tabela, id, via = 'push') => {
  const p0 = pushes.length, e0 = emails.length
  silenciar(true)
  const r = await perguntar(tabela, id)
  for (let i = 0; i < 40 && (via === 'push' ? pushes.length === p0 : emails.length === e0); i++) await new Promise(x => setTimeout(x, 50))
  await new Promise(x => setTimeout(x, 100))
  silenciar(false)
  const push = pushes.slice(p0).find(p => p.to === TOKEN_DONO)
  const email = emails.slice(e0)[0]
  return { status: r.status, erro: r.body?.erro, push: push?.body ?? null, email: email ? String(email.texto) : null }
}

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  for (const t of ['obras', 'reparos']) {
    await db.exec(`ALTER TABLE ${t} ALTER COLUMN status SET DEFAULT 'aberta', ALTER COLUMN status_aprovacao SET DEFAULT 'aprovada', ALTER COLUMN expira_em SET DEFAULT now() + interval '10 days'`)
  }
  // O fixture não traz as UNIQUE de produção; os ON CONFLICT da rota e do dedupe de e-mail as exigem.
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS t_perguntas_uq ON perguntas_demanda (tipo, demanda_id, autor_id);
                 CREATE UNIQUE INDEX IF NOT EXISTS t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id);`)
  const usr = (id, nome, role, cpf, token, email) => db.query(
    `INSERT INTO usuarios (id, nome, role, cpf_cnpj, push_token, email, cidade, uf) VALUES ($1, $2, $3, $4, $5, $6, 'Uberlândia', 'MG')`, [id, nome, role, cpf, token, email])
  await usr(DONO, 'Maria', 'dono_obra', '11111111111', TOKEN_DONO, 'maria@x.invalid')
  await usr(DONO_SEM_TOKEN, 'José', 'dono_obra', '22222222222', null, 'jose@x.invalid')
  await usr(PRO, 'Paulo', 'prestador', '33333333333', 'ExponentPushToken[pro]', 'paulo@x.invalid')
  let n = 1
  const reparo = async (titulo, categoria, categorias, dono = DONO) => { const id = D(n++); await db.query(
    `INSERT INTO reparos (id, titulo, categoria, categorias, criado_por, valor_estimado, cidade, uf) VALUES ($1, $2, $3, $4::text[], $5, 100, 'Uberlândia', 'MG')`, [id, titulo, categoria, categorias, dono]); return id }
  const obra = async (titulo, dono = DONO) => { const id = D(n++); await db.query(
    `INSERT INTO obras (id, titulo, categoria, criado_por, valor, cidade, uf) VALUES ($1, $2, 'residencial', $3, 3000, 'Uberlândia', 'MG')`, [id, titulo, dono]); return id }

  // ═══ 1. Constante ═════════════════════════════════════════════════════════════════════════
  const slugs = new Set(CATEGORIAS_SERVICO.map(c => c.slug))
  const ESPERADAS = ['hidraulica', 'eletrica', 'alvenaria', 'marcenaria', 'montagem_moveis', 'estofamento', 'vidraceiro',
                     'serralheria', 'gesseiro', 'climatizacao', 'eletronica', 'informatica', 'mecanica', 'jardineiro']
  ok(DF.CATEGORIAS_PEDE_FOTO.length === 15 && new Set(DF.CATEGORIAS_PEDE_FOTO).size === 15 && DF.CATEGORIAS_PEDE_FOTO.every(s => slugs.has(s)),
     'CATEGORIAS_PEDE_FOTO: 15 slugs sem repetição, todos existentes em CATEGORIAS_SERVICO', DF.CATEGORIAS_PEDE_FOTO)
  ok(ESPERADAS.every(s => DF.CATEGORIAS_PEDE_FOTO.includes(s)), 'as 14 categorias pedidas estão na lista')
  ok(DF.DICA_FOTO === DICA, 'texto exato da dica', DF.DICA_FOTO)
  ok(DF.dicaFoto('reparos', ['manicure'], true) === '' && DF.dicaFoto('reparos', ['eletrica'], false) === '' && DF.dicaFoto('reparos', ['eletrica'], true) === DICA
     && DF.dicaFoto('obras', null, true) === DICA && DF.dicaFoto('obras', null, false) === '', 'dicaFoto: só com categoria da lista (ou obra) E sem mídia')

  // ═══ 2. Reparo ════════════════════════════════════════════════════════════════════════════
  let id = await reparo('Vazamento na pia', 'hidraulica', ['hidraulica'])
  let a = await avisoDe('reparos', id)
  ok(a.status === 201 && a.push === BASE('Vazamento na pia') + DICA, 'reparo hidraulica SEM mídia → push com a dica', a)

  id = await reparo('Fazer as unhas', 'manicure', ['manicure'])
  a = await avisoDe('reparos', id)
  ok(a.status === 201 && a.push === BASE('Fazer as unhas'), 'reparo manicure sem mídia → texto de sempre (categoria fora da lista)', a)

  id = await reparo('Trocar tomada', 'eletrica', ['eletrica'])
  await db.query(`INSERT INTO midias_reparos (reparo_id, tipo, url, ordem) VALUES ($1, 'foto', 'https://res.cloudinary.com/x/image/upload/a.jpg', 1)`, [id])
  a = await avisoDe('reparos', id)
  ok(a.status === 201 && a.push === BASE('Trocar tomada'), 'reparo eletrica COM foto → sem dica', a)

  id = await reparo('Consertar portão', 'serralheria', ['serralheria'])
  await db.query(`INSERT INTO midias_reparos (reparo_id, tipo, url, ordem) VALUES ($1, 'video', 'https://res.cloudinary.com/x/video/upload/a.mp4', 1)`, [id])
  a = await avisoDe('reparos', id)
  ok(a.status === 201 && a.push === BASE('Consertar portão'), 'reparo serralheria COM vídeo → sem dica', a)

  id = await reparo('Unhas e chuveiro', 'manicure', ['manicure', 'eletrica'])
  a = await avisoDe('reparos', id)
  ok(a.status === 201 && a.push === BASE('Unhas e chuveiro') + DICA, 'reparo com várias categorias: basta UMA da lista', a)

  id = await reparo('Carro não liga', 'mecanica', null)
  a = await avisoDe('reparos', id)
  ok(a.status === 201 && a.push === BASE('Carro não liga') + DICA, 'reparo legado (só `categoria`, sem array) → com a dica', a)

  // ═══ 3. Obra (qualquer uma) ═══════════════════════════════════════════════════════════════
  id = await obra('Pintar a casa')
  a = await avisoDe('obras', id)
  ok(a.status === 201 && a.push === BASE('Pintar a casa') + DICA, 'obra SEM mídia → push com a dica', a)

  id = await obra('Pintar o galpão')
  await db.query(`INSERT INTO midias (obra_id, tipo, url, ordem) VALUES ($1, 'foto', 'https://res.cloudinary.com/x/image/upload/b.jpg', 1)`, [id])
  a = await avisoDe('obras', id)
  ok(a.status === 201 && a.push === BASE('Pintar o galpão'), 'obra COM foto → sem dica', a)

  // ═══ 4. E-mail (dono sem token de push) ═══════════════════════════════════════════════════
  id = await reparo('Montar guarda-roupa', 'montagem_moveis', ['montagem_moveis'], DONO_SEM_TOKEN)
  a = await avisoDe('reparos', id, 'email')
  ok(a.status === 201 && a.email !== null && a.email.includes(BASE('Montar guarda-roupa') + DICA), 'e-mail ao dono sem push: texto com a dica', a)

  id = await reparo('Massagem relaxante', 'massagem', ['massagem'], DONO_SEM_TOKEN)
  a = await avisoDe('reparos', id, 'email')
  ok(a.status === 201 && a.email !== null && a.email.includes(BASE('Massagem relaxante')) && !a.email.includes('Dica:'), 'e-mail em categoria fora da lista: sem dica', a)

  const errosReais = erros.filter(e => !/sem banco/.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
