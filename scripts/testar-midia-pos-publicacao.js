#!/usr/bin/env node
// MÍDIA DEPOIS DA PUBLICAÇÃO (dono, 20/11/2026 — services/avisoMidiaService):
//  1) POST /upload/reparo-url, /upload/obra-url e /upload/reparo (multipart): dono continua exigido
//     (403) e pedido encerrado/cancelado → 409 { erro: 'Pedido finalizado' }; aberto, com match,
//     rascunho e aguardando aprovação seguem aceitando.
//  2) Mídia anexada em pedido COM perguntas → cada profissional que perguntou recebe um push (sem
//     token → e-mail) que abre o detalhe; no máx. um por profissional por pedido a cada 10 min.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; handlers reais; Expo/Brevo/Cloudinary falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-midia-pos-publicacao.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

const pushes = []
const emails = []
let uploadsCloudinary = 0
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
  // Módulo real (traz o multer `upload`), só o envio ao Cloudinary é falso.
  if (/services[\\/]uploadService$/.test(request)) return {
    ...origLoad.apply(this, arguments),
    uploadArquivo: async () => { uploadsCloudinary++; return { secure_url: `https://res.cloudinary.com/x/image/upload/m${uploadsCloudinary}.jpg` } },
  }
  return origLoad.apply(this, arguments)
}
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const erros = []
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { errOrig('unhandled', e && (e.stack || e)); process.exit(1) } })
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? (...a) => erros.push(a.map(x => x?.message || String(x)).join(' ').slice(0, 300)) : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
silenciar(false)
const AM = require(path.join(REPO, 'src/services/avisoMidiaService'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const DONO = U(1), OUTRO_DONO = U(2), PRO_A = U(3), PRO_B = U(4), PRO_SEM_TOKEN = U(5)
const tok = (id) => `ExponentPushToken[${id.slice(-3)}]`
const handler = (caminho) => { const r = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods.post).route; return r.stack[r.stack.length - 1].handle }
const chamar = (caminho, usuarioId, body, file) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler(caminho)({ params: {}, body, query: {}, headers: {}, file, usuario: { id: usuarioId, role: 'dono_obra' }, get() { return '' } }, res)
})
const assentar = () => new Promise(r => setTimeout(r, 250))
let seqUrl = 0
const URL = () => `https://res.cloudinary.com/x/image/upload/f${++seqUrl}.jpg`
// Sobe uma mídia e devolve { status, erro, pushes: {quem: [..]}, emails: [...] } do que saiu por causa dela.
const subir = async (caminho, usuarioId, body, file) => {
  const p0 = pushes.length, e0 = emails.length
  silenciar(true)
  const r = await chamar(caminho, usuarioId, body, file)
  await assentar()
  silenciar(false)
  return { status: r.status, erro: r.body?.erro, pushes: pushes.slice(p0), emails: emails.slice(e0) }
}
const para = (lista, u) => lista.filter(p => p.to === tok(u))

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS t_perguntas_uq ON perguntas_demanda (tipo, demanda_id, autor_id);
                 CREATE UNIQUE INDEX IF NOT EXISTS t_midias_orfas_uq ON midias_orfas (url);`)
  await AM.migrarAvisoMidia({ query: (s, p) => db.query(s, p) })
  await AM.migrarAvisoMidia({ query: (s, p) => db.query(s, p) }) // 2º boot: idempotente
  const usr = (id, nome, role, cpf, token) => db.query(
    `INSERT INTO usuarios (id, nome, role, cpf_cnpj, push_token, email, cidade, uf) VALUES ($1, $2, $3, $4, $5, $6, 'Uberlândia', 'MG')`, [id, nome, role, cpf, token, `${id.slice(-3)}@x.invalid`])
  await usr(DONO, 'Maria', 'dono_obra', '11111111111', tok(DONO))
  await usr(OUTRO_DONO, 'Outro', 'dono_obra', '22222222222', tok(OUTRO_DONO))
  await usr(PRO_A, 'Ana', 'prestador', '33333333333', tok(PRO_A))
  await usr(PRO_B, 'Bia', 'prestador', '44444444444', tok(PRO_B))
  await usr(PRO_SEM_TOKEN, 'Caio', 'prestador', '55555555555', null)
  let n = 1
  const demanda = async (tabela, titulo, status = 'aberta', aprovacao = 'aprovada', extra = '') => { const id = D(n++); await db.query(
    `INSERT INTO ${tabela} (id, titulo, criado_por, status, status_aprovacao, cidade, uf, expira_em) VALUES ($1, $2, $3, $4, $5, 'Uberlândia', 'MG', now() + interval '5 days')`, [id, titulo, DONO, status, aprovacao])
    if (extra) await db.query(`UPDATE ${tabela} SET ${extra} WHERE id = $1`, [id]); return id }
  const pergunta = (tipo, id, autor) => db.query(`INSERT INTO perguntas_demanda (tipo, demanda_id, autor_id, pergunta) VALUES ($1, $2, $3, 'Tem foto?')`, [tipo, id, autor])
  const midiasDe = async (tabela, id) => (await db.query(`SELECT count(*)::int AS n FROM ${tabela === 'obras' ? 'midias' : 'midias_reparos'} WHERE ${tabela === 'obras' ? 'obra_id' : 'reparo_id'} = $1`, [id])).rows[0].n
  const ROTAS = [
    { nome: '/upload/reparo-url', tabela: 'reparos', corpo: (id, ordem = 1) => [{ reparo_id: id, url: URL(), tipo: 'foto', ordem }] },
    { nome: '/upload/obra-url',   tabela: 'obras',   corpo: (id, ordem = 1) => [{ obra_id: id, url: URL(), tipo: 'foto', ordem }] },
    { nome: '/upload/reparo',     tabela: 'reparos', corpo: (id, ordem = 1) => [{ reparo_id: id, ordem }, { mimetype: 'image/jpeg', buffer: Buffer.from('x') }] },
  ]

  // ═══ 1. Dono + status, nas três rotas ═════════════════════════════════════════════════════
  for (const rota of ROTAS) {
    const t = rota.tabela
    let id = await demanda(t, 'Aberto')
    let r = await subir(rota.nome, OUTRO_DONO, ...rota.corpo(id))
    ok(r.status === 403 && await midiasDe(t, id) === 0, `${rota.nome}: quem não é o dono → 403, nada gravado`, { status: r.status })
    r = await subir(rota.nome, DONO, ...rota.corpo(id))
    ok(r.status === 200 && await midiasDe(t, id) === 1, `${rota.nome}: aberto e aprovado → 200`, { status: r.status, erro: r.erro })
    id = await demanda(t, 'Em aprovação', 'aberta', 'pendente')
    r = await subir(rota.nome, DONO, ...rota.corpo(id))
    ok(r.status === 200 && await midiasDe(t, id) === 1, `${rota.nome}: aguardando aprovação (upload da criação) → 200`, { status: r.status, erro: r.erro })
    id = await demanda(t, 'Rascunho', 'rascunho', 'pendente')
    r = await subir(rota.nome, DONO, ...rota.corpo(id))
    ok(r.status === 200, `${rota.nome}: rascunho → 200`, { status: r.status, erro: r.erro })
    id = await demanda(t, 'Com match', 'aberta', 'aprovada', `match_usuario_id = '${PRO_A}'`)
    r = await subir(rota.nome, DONO, ...rota.corpo(id))
    ok(r.status === 200, `${rota.nome}: aberto com profissional escolhido → 200`, { status: r.status, erro: r.erro })
    const antes = uploadsCloudinary
    for (const [status, aprov, rotulo] of [['encerrada', 'aprovada', 'finalizado'], ['cancelada', 'aprovada', 'cancelado'], ['encerrada', 'encerrada', 'encerrado (aprovação encerrada)'], ['aberta', 'cancelada', 'cancelado na aprovação']]) {
      id = await demanda(t, rotulo, status, aprov)
      r = await subir(rota.nome, DONO, ...rota.corpo(id))
      ok(r.status === 409 && r.erro === 'Pedido finalizado' && await midiasDe(t, id) === 0, `${rota.nome}: ${rotulo} → 409 Pedido finalizado, nada gravado`, { status: r.status, erro: r.erro })
    }
    ok(uploadsCloudinary === antes, `${rota.nome}: 409 não envia arquivo ao Cloudinary`)
  }

  // ═══ 2. Aviso a quem perguntou ════════════════════════════════════════════════════════════
  const TITULO = '📸 O cliente adicionou fotos ou vídeos ao pedido'
  for (const rota of ROTAS) {
    const t = rota.tabela, tipo = t === 'obras' ? 'obra' : 'reparo', chave = `${tipo}_id`
    // Sem perguntas → ninguém avisado.
    let id = await demanda(t, 'Sem perguntas')
    let r = await subir(rota.nome, DONO, ...rota.corpo(id))
    ok(r.status === 200 && r.pushes.length === 0 && r.emails.length === 0, `${rota.nome}: sem perguntas → nenhum aviso`, { pushes: r.pushes.length, emails: r.emails.length })

    id = await demanda(t, 'Vazamento na pia')
    await pergunta(tipo, id, PRO_A); await pergunta(tipo, id, PRO_B); await pergunta(tipo, id, PRO_SEM_TOKEN)
    r = await subir(rota.nome, DONO, ...rota.corpo(id, 1))
    const pa = para(r.pushes, PRO_A), pb = para(r.pushes, PRO_B)
    ok(r.status === 200 && pa.length === 1 && pb.length === 1 && r.pushes.length === 2, `${rota.nome}: A e B recebem UM push cada (dono e terceiros, nada)`, r.pushes.map(p => p.to))
    ok(pa[0]?.title === TITULO && pa[0]?.body === '"Vazamento na pia" · toque para ver', `${rota.nome}: título e corpo exatos`, [pa[0]?.title, pa[0]?.body])
    ok(pa[0]?.data?.tipo === 'midia_adicionada' && pa[0]?.data?.[chave] === id, `${rota.nome}: data abre o detalhe (${chave})`, pa[0]?.data)
    const em = r.emails.filter(e => e.para === `${PRO_SEM_TOKEN.slice(-3)}@x.invalid`)
    ok(em.length === 1 && r.emails.length === 1 && em[0].assunto === TITULO && String(em[0].texto).includes('"Vazamento na pia" · toque para ver'), `${rota.nome}: sem push → e-mail (e só ele recebe e-mail)`, r.emails.map(e => e.para))

    // Vários arquivos em sequência = um aviso só.
    let extras = 0
    for (const ordem of [2, 3, 4]) { r = await subir(rota.nome, DONO, ...rota.corpo(id, ordem)); extras += r.pushes.length + r.emails.length }
    ok(extras === 0 && await midiasDe(t, id) === 4, `${rota.nome}: mais 3 arquivos em seguida → nenhum aviso novo (4 mídias gravadas)`, { extras })

    // Quem pergunta DEPOIS do aviso recebe no próximo arquivo; os outros seguem na janela.
    await db.query(`DELETE FROM perguntas_demanda WHERE demanda_id = $1 AND autor_id = $2`, [id, PRO_B])
    await db.query(`DELETE FROM avisos_midia_adicionada WHERE demanda_id = $1 AND usuario_id = $2`, [id, PRO_B])
    await pergunta(tipo, id, PRO_B)
    r = await subir(rota.nome, DONO, ...rota.corpo(id, 5))
    ok(para(r.pushes, PRO_B).length === 1 && r.pushes.length === 1 && r.emails.length === 0, `${rota.nome}: pergunta nova dentro da janela → só o novo é avisado`, r.pushes.map(p => p.to))

    // 9 min depois: ainda na janela. 11 min depois: um aviso novo por profissional.
    await db.query(`UPDATE avisos_midia_adicionada SET enviado_em = now() - interval '9 minutes' WHERE demanda_id = $1`, [id])
    r = await subir(rota.nome, DONO, ...rota.corpo(id, 6))
    ok(r.pushes.length === 0 && r.emails.length === 0, `${rota.nome}: 9 min depois → nenhum aviso`, { pushes: r.pushes.length, emails: r.emails.length })
    await db.query(`UPDATE avisos_midia_adicionada SET enviado_em = now() - interval '11 minutes' WHERE demanda_id = $1`, [id])
    r = await subir(rota.nome, DONO, ...rota.corpo(id, 7))
    ok(para(r.pushes, PRO_A).length === 1 && para(r.pushes, PRO_B).length === 1 && r.pushes.length === 2 && r.emails.length === 1, `${rota.nome}: 11 min depois → um aviso novo por profissional`, { pushes: r.pushes.map(p => p.to), emails: r.emails.length })
  }

  // Dois arquivos subindo AO MESMO TEMPO → um aviso só; e o aviso de um pedido não segura o de outro.
  const id1 = await demanda('reparos', 'Simultâneo'), id2 = await demanda('reparos', 'Outro pedido')
  await pergunta('reparo', id1, PRO_A); await pergunta('reparo', id2, PRO_A)
  let p0 = pushes.length
  silenciar(true)
  await Promise.all([1, 2, 3].map(ordem => chamar('/upload/reparo-url', DONO, { reparo_id: id1, url: URL(), tipo: 'foto', ordem })))
  await assentar(); silenciar(false)
  ok(para(pushes.slice(p0), PRO_A).length === 1, '3 uploads simultâneos no mesmo pedido → 1 push', para(pushes.slice(p0), PRO_A).length)
  const r2 = await subir('/upload/reparo-url', DONO, { reparo_id: id2, url: URL(), tipo: 'foto', ordem: 1 })
  ok(para(r2.pushes, PRO_A).length === 1 && r2.pushes[0].body === '"Outro pedido" · toque para ver', 'a janela é por pedido: outro pedido do mesmo dono avisa normalmente')

  const errosReais = erros.filter(e => !/sem banco/.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
