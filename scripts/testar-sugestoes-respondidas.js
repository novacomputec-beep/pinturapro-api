#!/usr/bin/env node
// CAIXA DE SUGESTÕES COM RESPOSTA (dono, 21/11/2026). GET /admin/sugestoes passa a devolver, por
// item, respondida (bool), resposta (texto da ÚLTIMA resposta) e respondida_em, lidos de
// respostas_equipe (onde POST /admin/respostas-equipe já grava cada resposta do painel); filtro
// ?status=sem_resposta|respondidas|todas (padrão sem_resposta) e as contagens de cada um.
// Nada é inventado: sugestão sem linha em respostas_equipe sai respondida=false, resposta null.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-sugestoes-respondidas.js
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
const S = (n) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 200))
const ADMIN = U(1), ANA = U(10), BIA = U(11)
const SESSAO = { [ADMIN]: { role: 'admin' } }
const chamar = (metodo, caminho, usuarioId, { body = {}, params = {}, query = {} } = {}) => new Promise((resolve, reject) => {
  const camada = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!camada) return reject(new Error(`rota não encontrada: ${metodo} ${caminho}`))
  const handler = camada.route.stack[camada.route.stack.length - 1].handle
  const req = { params, body, query, headers: {}, usuario: { id: usuarioId, ...(SESSAO[usuarioId] || {}) }, get() { return '' } }
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  Promise.resolve(handler(req, res)).catch(reject)
})
const quieto = async (fn) => { silenciar(true); try { return await fn() } finally { await assentar(); silenciar(false) } }
const lista = (query = {}) => quieto(() => chamar('get', '/admin/sugestoes', ADMIN, { query }))
const ids = (r) => (r.body?.sugestoes || []).map(x => x.id)
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id)`)
  await db.query(`INSERT INTO usuarios (id, nome, email, role, cpf_cnpj) VALUES
    ($1, 'Admin', 'admin@x.invalid', 'admin', '00000000001'), ($2, 'Ana', 'ana@x.invalid', 'prestador', '00000000010'), ($3, 'Bia', 'bia@x.invalid', 'dono_obra', '00000000011')`, [ADMIN, ANA, BIA])
  // S1 mais antiga … S5 mais nova.
  for (const [n, autor, texto, dias] of [[1, ANA, 'Sugestão um', 5], [2, BIA, 'Sugestão dois', 4], [3, ANA, 'Sugestão três', 3], [4, BIA, 'Sugestão quatro', 2], [5, ANA, 'Sugestão cinco', 1]]) {
    await db.query(`INSERT INTO sugestoes (id, usuario_id, texto, criado_em) VALUES ($1, $2, $3, now() - make_interval(days => $4::int))`, [S(n), autor, texto, dias])
  }
  // O que JÁ estava gravado antes desta versão: S1 com duas respostas, S3 com uma; uma resposta de
  // SUPORTE com o mesmo id de S4 (não é resposta à sugestão) e uma resposta a sugestão já apagada.
  await db.query(`INSERT INTO respostas_equipe (usuario_id, origem, origem_id, pergunta, resposta, criada_em) VALUES
    ($1, 'sugestao', $3, 'Sugestão um', 'Primeira resposta', now() - INTERVAL '4 days'),
    ($1, 'sugestao', $3, 'Sugestão um', 'Segunda resposta (a última)', now() - INTERVAL '2 days'),
    ($1, 'sugestao', $4, 'Sugestão três', 'Resposta à três', now() - INTERVAL '1 day'),
    ($2, 'suporte',  $5, 'pedido de suporte', 'Resposta de SUPORTE', now() - INTERVAL '1 day'),
    ($1, 'sugestao', $6, 'Sugestão apagada', 'Resposta órfã', now() - INTERVAL '6 days')`, [ANA, BIA, S(1), S(3), S(4), S(99)])

  // ═══ 1. Padrão: só as sem resposta; contagens ══════════════════════════════════════════════
  let r = await lista()
  ok(r.status === 200 && r.body.status === 'sem_resposta' && igual(ids(r), [S(5), S(4), S(2)]), 'sem ?status: só as SEM resposta, mais novas primeiro', { status: r.status, ids: ids(r), erro: r.body?.erro })
  ok(igual(r.body.contagens, { sem_resposta: 3, respondidas: 2, todas: 5 }), 'contagens: sem_resposta 3, respondidas 2, todas 5', r.body.contagens)
  ok(r.body.sugestoes.every(x => x.respondida === false && x.resposta === null && x.respondida_em === null), 'sem resposta: respondida false, resposta e respondida_em null (nada inventado)')
  ok(r.body.sugestoes.find(x => x.id === S(4)).respondida === false, 'resposta de SUPORTE com o mesmo id não conta como resposta à sugestão')
  const x5 = r.body.sugestoes[0]
  ok(x5.texto === 'Sugestão cinco' && x5.usuario_id === ANA && x5.usuario_nome === 'Ana' && x5.usuario_email === 'ana@x.invalid' && x5.criado_em && r.body.page === 1 && r.body.limit === 20,
     'campos de sempre continuam (id, texto, criado_em, usuario_*; page, limit)', { page: r.body.page, limit: r.body.limit })

  // ═══ 2. Respondidas e todas ════════════════════════════════════════════════════════════════
  r = await lista({ status: 'respondidas' })
  ok(igual(ids(r), [S(3), S(1)]) && r.body.status === 'respondidas', '?status=respondidas: só as respondidas', ids(r))
  const x1 = r.body.sugestoes.find(x => x.id === S(1)), x3 = r.body.sugestoes.find(x => x.id === S(3))
  ok(x1.respondida === true && x1.resposta === 'Segunda resposta (a última)' && x3.resposta === 'Resposta à três', 'resposta = texto da ÚLTIMA resposta gravada', [x1.resposta, x3.resposta])
  const gravada = (await db.query(`SELECT max(criada_em) AS t FROM respostas_equipe WHERE origem = 'sugestao' AND origem_id = $1`, [S(1)])).rows[0].t
  ok(new Date(x1.respondida_em).getTime() === new Date(gravada).getTime(), 'respondida_em = criada_em da última resposta (o que já estava gravado, sem backfill inventado)')
  ok(igual(r.body.contagens, { sem_resposta: 3, respondidas: 2, todas: 5 }), 'contagens não dependem do filtro', r.body.contagens)
  r = await lista({ status: 'todas' })
  ok(igual(ids(r), [S(5), S(4), S(3), S(2), S(1)]) && igual(r.body.sugestoes.map(x => x.respondida), [false, false, true, false, true]), '?status=todas: as 5, cada uma com o seu respondida', r.body.sugestoes.map(x => x.respondida))
  r = await lista({ status: 'todas', limit: '2', page: '2' })
  ok(igual(ids(r), [S(3), S(2)]) && r.body.contagens.todas === 5, 'paginação de sempre (page/limit); contagens são do total, não da página', ids(r))
  r = await lista({ status: 'respondidas', limit: '1', page: '2' })
  ok(igual(ids(r), [S(1)]), 'paginação DENTRO do filtro', ids(r))
  r = await lista({ status: 'qualquer' })
  ok(r.status === 400 && /sem_resposta, respondidas, todas/.test(r.body.erro), 'status inválido: 400', r.body)
  r = await lista({ status: '' })
  ok(r.status === 200 && r.body.status === 'sem_resposta', 'status vazio = padrão')

  // ═══ 3. Resposta nova pelo painel: gravada com texto e hora, e a lista reflete na hora ═════
  const antes = (await db.query(`SELECT count(*)::int AS n FROM respostas_equipe`)).rows[0].n
  r = await quieto(() => chamar('post', '/admin/respostas-equipe', ADMIN, { body: { origem: 'sugestao', origem_id: S(5), resposta: '  Obrigado, vamos fazer!  ' } }))
  const linha = (await db.query(`SELECT resposta, criada_em, usuario_id, pergunta FROM respostas_equipe WHERE origem = 'sugestao' AND origem_id = $1`, [S(5)])).rows
  ok(r.status === 201 && linha.length === 1 && linha[0].resposta === 'Obrigado, vamos fazer!' && linha[0].criada_em !== null && linha[0].usuario_id === ANA && linha[0].pergunta === 'Sugestão cinco'
     && (await db.query(`SELECT count(*)::int AS n FROM respostas_equipe`)).rows[0].n === antes + 1,
     'POST /admin/respostas-equipe: grava UMA linha com texto e hora (como já fazia)', { status: r.status, linha })
  r = await lista()
  ok(igual(ids(r), [S(4), S(2)]) && igual(r.body.contagens, { sem_resposta: 2, respondidas: 3, todas: 5 }), 'a respondida sai da lista padrão; contagens atualizam', { ids: ids(r), c: r.body.contagens })
  r = await lista({ status: 'respondidas' })
  const n5 = r.body.sugestoes.find(x => x.id === S(5))
  ok(r.body.sugestoes[0].id === S(5) && n5.respondida === true && n5.resposta === 'Obrigado, vamos fazer!' && new Date(n5.respondida_em).getTime() === new Date(linha[0].criada_em).getTime(),
     'e aparece em respondidas com o texto e a hora gravados', n5 && { resposta: n5.resposta })
  r = await quieto(() => chamar('post', '/admin/respostas-equipe', ADMIN, { body: { origem: 'sugestao', origem_id: S(5), resposta: 'Complemento' } }))
  r = await lista({ status: 'respondidas' })
  ok(r.body.sugestoes.find(x => x.id === S(5)).resposta === 'Complemento' && r.body.contagens.respondidas === 3, 'segunda resposta: a lista mostra a última; a sugestão conta uma vez só', r.body.contagens)

  const errosReais = erros.filter(e => !/sem banco|migration/i.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
