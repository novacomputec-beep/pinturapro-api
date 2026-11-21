#!/usr/bin/env node
// PERGUNTA NÃO EXIGE VERIFICAÇÃO (dono, 21/11/2026). Documento + selfie (exigirVerificado →
// 403 VERIFICACAO_NECESSARIA) só é exigido para ENVIAR PROPOSTA; perguntar no pedido não.
//  1) POST /reparos/:id/perguntas e POST /obras/:id/perguntas: profissional sem verificação
//     (nao_solicitada, pendente, reprovado) pergunta normalmente (201);
//  2) POST /reparos/:id/interesse, POST /obras/:id/candidatura e POST /candidaturas seguem 403
//     VERIFICACAO_NECESSARIA para os mesmos profissionais;
//  3) as demais guardas da pergunta continuam: conta suspensa, sem assinatura, lado errado.
// Roda a cadeia REAL de middlewares de cada rota (menos autenticar). SQL REAL em PGlite com o
// ESQUEMA DE PRODUÇÃO; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-pergunta-sem-verificacao.js
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
const { exigirVerificado } = require(path.join(REPO, 'src/middlewares/auth'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 200))
const DONO = U(1)
// Reparadores (serviços) e pintores (obras), um por situação de verificação.
const P = {
  R_NAO: { n: 10, tipo: 'reparador', ver: 'nao_solicitada' }, R_PEND: { n: 11, tipo: 'reparador', ver: 'pendente' }, R_REPR: { n: 12, tipo: 'reparador', ver: 'reprovado' }, R_OK: { n: 13, tipo: 'reparador', ver: 'aprovado' },
  P_NAO: { n: 20, tipo: 'pintor', ver: 'nao_solicitada' }, P_PEND: { n: 21, tipo: 'pintor', ver: 'pendente' }, P_OK: { n: 22, tipo: 'pintor', ver: 'aprovado' },
  R_SUSP: { n: 30, tipo: 'reparador', ver: 'nao_solicitada', suspenso: true }, R_SEM_ASS: { n: 31, tipo: 'reparador', ver: 'nao_solicitada', semAssinatura: true },
}
for (const [nome, p] of Object.entries(P)) { p.nome = nome; p.id = U(p.n) }
const pilhaDe = (metodo, caminho) => {
  const camada = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!camada) throw new Error(`rota não encontrada: ${metodo} ${caminho}`)
  return camada.route.stack.map(s => s.handle)
}
// Cadeia REAL da rota menos o primeiro middleware (autenticar): req.usuario = a linha do banco.
const chamar = async (metodo, caminho, usuarioId, { body = {}, params = {} } = {}) => {
  const usuario = (await db.query(`SELECT * FROM usuarios WHERE id = $1`, [usuarioId])).rows[0]
  return new Promise((resolve, reject) => {
    const cadeia = pilhaDe(metodo, caminho).slice(1)
    const req = { params, body, query: {}, headers: {}, usuario, get() { return '' }, ip: '127.0.0.1' }
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) }, set() { return this } }
    let i = 0
    const next = (err) => { if (err) return reject(err); const h = cadeia[i++]; if (!h) return resolve({ status: 0, body: null }); Promise.resolve(h(req, res, next)).catch(reject) }
    next()
  })
}
const quieto = async (fn) => { silenciar(true); try { return await fn() } finally { await assentar(); silenciar(false) } }

const main = async () => {
  // ═══ 0. Onde a guarda está (estrutura das rotas) ═══════════════════════════════════════════
  const tem = (m, c) => pilhaDe(m, c).includes(exigirVerificado)
  ok(!tem('post', '/reparos/:id/perguntas') && !tem('post', '/obras/:id/perguntas'), 'rotas de PERGUNTA (reparo e obra): sem exigirVerificado')
  ok(tem('post', '/reparos/:id/interesse') && tem('post', '/obras/:id/candidatura') && tem('post', '/candidaturas'), 'rotas de PROPOSTA (interesse, candidatura, /candidaturas): exigirVerificado continua')
  const comGuarda = router.stack.filter(l => l.route && l.route.stack.some(s => s.handle === exigirVerificado)).map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort()
  ok(JSON.stringify(comGuarda) === JSON.stringify(['POST /candidaturas', 'POST /obras/:id/candidatura', 'POST /reparos/:id/interesse']), 'exigirVerificado só nessas três rotas', comGuarda)

  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`
    CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_perguntas_uq ON perguntas_demanda (tipo, demanda_id, autor_id);
    CREATE UNIQUE INDEX t_interesse_uq ON interesse_reparos (reparo_id, usuario_id);
    CREATE UNIQUE INDEX t_candidaturas_uq ON candidaturas (obra_id, usuario_id);
    CREATE UNIQUE INDEX t_configuracoes_uq ON configuracoes (chave);
  `)
  await db.query(`INSERT INTO usuarios (id, nome, email, role, tipo_dono, cidade, uf, cpf_cnpj) VALUES ($1, 'Dona Cliente', 'dona@x.invalid', 'dono_obra', 'reparo', 'Patos de Minas', 'MG', '90000000000')`, [DONO])
  for (const p of Object.values(P)) {
    await db.query(
      `INSERT INTO usuarios (id, nome, email, role, tipo_prestador, cidade, uf, cpf_cnpj, especialidades, verificacao_status, suspenso_em)
       VALUES ($1, $2, $3, 'prestador', $4, 'Patos de Minas', 'MG', $5, $6::text[], $7, ${p.suspenso ? 'now()' : 'NULL'})`,
      [p.id, `${p.nome} Teste`, `${p.nome.toLowerCase()}@x.invalid`, p.tipo, String(p.n).padStart(11, '7'), p.tipo === 'pintor' ? ['pintor'] : ['eletrica'], p.ver])
    if (!p.semAssinatura) await db.query(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [p.id])
  }
  const R1 = D(1), O1 = D(2)
  await db.query(`INSERT INTO reparos (id, titulo, categoria, categorias, criado_por, valor_estimado, prazo_atendimento_horas, cidade, uf, status, status_aprovacao, expira_em, push_novo_enviado_em)
                  VALUES ($1, 'Trocar tomada', 'eletrica', '{eletrica}', $2, 100, 72, 'Patos de Minas', 'MG', 'aberta', 'aprovada', now() + INTERVAL '3 days', now())`, [R1, DONO])
  await db.query(`INSERT INTO obras (id, titulo, categoria, criado_por, valor, horas_para_expirar, cidade, uf, status, status_aprovacao, publicado_em, expira_em, push_novo_enviado_em)
                  VALUES ($1, 'Pintar sala', 'residencial', $2, 2000, 480, 'Patos de Minas', 'MG', 'aberta', 'aprovada', now(), now() + INTERVAL '10 days', now())`, [O1, DONO])
  const perguntasDe = async (tipo, id) => (await db.query(`SELECT autor_id FROM perguntas_demanda WHERE tipo = $1 AND demanda_id = $2`, [tipo, id])).rows.length
  const propostas = async () => (await db.query(`SELECT (SELECT count(*) FROM interesse_reparos)::int + (SELECT count(*) FROM candidaturas)::int AS n`)).rows[0].n

  // ═══ 1. Pergunta sem verificação: passa ════════════════════════════════════════════════════
  for (const nome of ['R_NAO', 'R_PEND', 'R_REPR', 'R_OK']) {
    const r = await quieto(() => chamar('post', '/reparos/:id/perguntas', P[nome].id, { params: { id: R1 }, body: { pergunta: 'Precisa levar material?' } }))
    ok(r.status === 201 && r.body.minha === true && r.body.codigo !== 'VERIFICACAO_NECESSARIA', `reparo — ${nome} (${P[nome].ver}): pergunta enviada (201)`, { status: r.status, body: r.body?.erro || r.body?.codigo })
  }
  for (const nome of ['P_NAO', 'P_PEND', 'P_OK']) {
    const r = await quieto(() => chamar('post', '/obras/:id/perguntas', P[nome].id, { params: { id: O1 }, body: { pergunta: 'Qual a metragem?' } }))
    ok(r.status === 201 && r.body.minha === true, `obra — ${nome} (${P[nome].ver}): pergunta enviada (201)`, { status: r.status, body: r.body?.erro || r.body?.codigo })
  }
  ok(await perguntasDe('reparo', R1) === 4 && await perguntasDe('obra', O1) === 3, 'perguntas gravadas: 4 no reparo, 3 na obra')

  // ═══ 2. Proposta sem verificação: continua barrada ═════════════════════════════════════════
  for (const nome of ['R_NAO', 'R_PEND', 'R_REPR']) {
    const r = await quieto(() => chamar('post', '/reparos/:id/interesse', P[nome].id, { params: { id: R1 }, body: { valor_proposto: 90 } }))
    ok(r.status === 403 && r.body.codigo === 'VERIFICACAO_NECESSARIA' && r.body.verificacao_status === P[nome].ver, `reparo — ${nome}: PROPOSTA (interesse) segue 403 VERIFICACAO_NECESSARIA`, { status: r.status, body: r.body })
  }
  for (const nome of ['P_NAO', 'P_PEND']) {
    const a = await quieto(() => chamar('post', '/obras/:id/candidatura', P[nome].id, { params: { id: O1 }, body: { valor_proposto: 1900 } }))
    const b = await quieto(() => chamar('post', '/candidaturas', P[nome].id, { body: { obra_id: O1, valor_proposto: 1900 } }))
    ok(a.status === 403 && a.body.codigo === 'VERIFICACAO_NECESSARIA' && b.status === 403 && b.body.codigo === 'VERIFICACAO_NECESSARIA', `obra — ${nome}: PROPOSTA (candidatura, nas duas rotas) segue 403 VERIFICACAO_NECESSARIA`, [a.status, b.status])
  }
  ok(await propostas() === 0, 'nenhuma proposta de não verificado foi gravada')
  let r = await quieto(() => chamar('post', '/reparos/:id/interesse', P.R_OK.id, { params: { id: R1 }, body: { valor_proposto: 90 } }))
  ok(r.status !== 403 && r.body?.codigo !== 'VERIFICACAO_NECESSARIA', 'verificado (aprovado): a proposta passa da guarda de verificação', { status: r.status, erro: r.body?.erro })

  // ═══ 3. Demais guardas da pergunta continuam ═══════════════════════════════════════════════
  r = await quieto(() => chamar('post', '/reparos/:id/perguntas', P.R_SUSP.id, { params: { id: R1 }, body: { pergunta: 'Posso ir hoje?' } }))
  ok(r.status === 403 && r.body.codigo !== 'VERIFICACAO_NECESSARIA', 'conta suspensa: pergunta segue barrada (pela suspensão, não pela verificação)', { status: r.status, codigo: r.body?.codigo })
  r = await quieto(() => chamar('post', '/reparos/:id/perguntas', P.R_SEM_ASS.id, { params: { id: R1 }, body: { pergunta: 'Posso ir hoje?' } }))
  ok(r.status === 403 && r.body.codigo !== 'VERIFICACAO_NECESSARIA', 'sem assinatura ativa: pergunta segue barrada', { status: r.status, erro: r.body?.erro })
  r = await quieto(() => chamar('post', '/reparos/:id/perguntas', P.P_NAO.id, { params: { id: R1 }, body: { pergunta: 'Posso ir hoje?' } }))
  ok(r.status === 403 && r.body.codigo !== 'VERIFICACAO_NECESSARIA', 'pintor em pergunta de SERVIÇO (lado errado): segue barrado', { status: r.status, erro: r.body?.erro })
  r = await quieto(() => chamar('post', '/reparos/:id/perguntas', P.R_NAO.id, { params: { id: R1 }, body: { pergunta: 'Outra pergunta' } }))
  ok(r.status === 409, 'uma pergunta por profissional por pedido (409 na segunda), como sempre', { status: r.status })
  ok(await perguntasDe('reparo', R1) === 4, 'nenhuma pergunta a mais gravada pelas tentativas barradas')

  const errosReais = erros.filter(e => !/sem banco|migration/i.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
