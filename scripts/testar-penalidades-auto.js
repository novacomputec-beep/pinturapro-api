#!/usr/bin/env node
// PENALIDADES AUTOMÁTICAS (23/11/2026 — utils/penalidadesAuto). Rotas REAIS (POST /avaliacoes,
// POST /denuncias, GET /admin/denuncias, /admin/penalidades…) sobre o ESQUEMA DE PRODUÇÃO (PGlite).
//   profissional: média das 3 últimas <= 2,0 → observação (push + e-mail); de novo → 7 dias
//   suspenso (sem proposta, feed só leitura), levantado sozinho; nada retroativo;
//   cliente: 3 denúncias de 3 profissionais diferentes em 60 dias → 7 dias sem publicar (403 com a
//   data; pedidos abertos intocados); anti-revanche (denúncia depois de nota <= 2 não conta;
//   apos_nota_baixa na lista do admin); super-admin: lista, tirar-observacao, desfazer-suspensao.
//   npm i -D @electric-sql/pglite && node scripts/testar-penalidades-auto.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

const pushes = [], emails = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { pushes.push(...chunk); return chunk.map((_, i) => ({ status: 'ok', id: `t${pushes.length}-${i}` })) }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
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
  if (/brevoService$/.test(request)) return { enviarEmail: async (e) => { emails.push(e) }, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async (e) => { emails.push(e) } }
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
const P = require(path.join(REPO, 'src/utils/penalidadesAuto'))
const { exigirNaoSuspenso } = require(path.join(REPO, 'src/middlewares/auth'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 120))
// Todas as rotas do router (inclusive as dos routers montados com router.use).
const rotasDe = (r) => r.stack.flatMap(l => (l.route ? [l.route] : l.handle?.stack ? rotasDe(l.handle) : []))
const ROTAS = rotasDe(router)
const rota = (metodo, caminho) => { const r = ROTAS.find(x => x.path === caminho && x.methods[metodo]); if (!r) throw new Error(`rota ${metodo} ${caminho} não encontrada`); return r }
const nomes = (metodo, caminho) => rota(metodo, caminho).stack.map(l => l.handle.name || l.name)
// Handler final da rota, esperando também o que ele faz DEPOIS de responder (as penalidades).
const chamar = async (metodo, caminho, { usuario, params = {}, query = {}, body = {} } = {}) => {
  silenciar(true)
  try {
    let resp = null
    const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resp = resp || { status: this.statusCode, body: b }; return this } }
    const pilha = rota(metodo, caminho).stack
    await pilha[pilha.length - 1].handle({ method: metodo.toUpperCase(), path: caminho, params, query, body, usuario, get: () => '', headers: {}, ip: '127.0.0.1' }, res)
    await assentar()
    return resp
  } finally { silenciar(false) }
}
// Um middleware sozinho: { passou } ou a resposta que ele deu.
const passar = async (mw, usuario) => {
  let resp = null, passou = false
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resp = { status: this.statusCode, body: b }; return this } }
  await mw({ usuario }, res, () => { passou = true })
  return passou ? { passou: true } : resp
}

const ADM = { id: U(900), role: 'admin' }
const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  // A fixture traz colunas e defaults, não as UNIQUE que as rotas usam no ON CONFLICT (migração de boot).
  await q(`CREATE UNIQUE INDEX avaliacoes_uk ON avaliacoes (contrato_tipo, contrato_id, avaliador_id)`)
  await q(`CREATE UNIQUE INDEX denuncias_uk ON denuncias (contrato_tipo, contrato_id, denunciante_id)`)
  await P.migrarPenalidadesAuto(shim); await P.migrarPenalidadesAuto(shim)
  const marco = () => q(`SELECT valor FROM configuracoes WHERE chave = $1`, [P.CHAVE_MARCO]).then(r => r.rows[0]?.valor)
  const m0 = await marco()
  await P.migrarPenalidadesAuto(shim)
  ok(!!m0 && (await marco()) === m0, 'migração idempotente; o marco "só conta daqui em diante" é gravado uma vez', m0)

  const usr = async (n, nome, role, extra = {}) => {
    const c = { id: U(n), nome, email: `u${n}@x.invalid`, role, cpf_cnpj: String(n).padStart(11, '0'), ativo: true, push_token: `ExponentPushToken[u${n}]`, ...(role === 'prestador' ? { tipo_prestador: 'reparador' } : {}), ...extra }
    const ks = Object.keys(c)
    await q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => c[k]))
    return { id: c.id, role, nome }
  }
  let nContrato = 0
  // Reparo ENCERRADO entre dono e profissional (o contrato que se avalia e se denuncia).
  const contrato = async (dono, prof, extra = {}) => {
    const id = D(++nContrato)
    const c = { id, titulo: `Serviço ${nContrato}`, criado_por: dono.id, match_usuario_id: prof.id, status: 'encerrada', status_aprovacao: 'aprovada', categoria: 'encanador', ...extra }
    const ks = Object.keys(c)
    await q(`INSERT INTO reparos (${ks.join(', ')}, expira_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, now() + INTERVAL '30 days')`, ks.map(k => c[k]))
    return id
  }
  const avaliar = async (dono, prof, nota) => chamar('post', '/avaliacoes', { usuario: dono, body: { contrato_tipo: 'reparo', contrato_id: await contrato(dono, prof), nota } })
  const denunciar = async (prof, dono, contratoId) => chamar('post', '/denuncias', { usuario: prof, body: { contrato_tipo: 'reparo', contrato_id: contratoId || await contrato(dono, prof), categoria: 'nao_pagamento', descricao: 'Não pagou o combinado.' } })
  const u = async (x) => (await q(`SELECT * FROM usuarios WHERE id = $1`, [x.id])).rows[0]
  const pens = async (x) => (await q(`SELECT * FROM penalidades_auto WHERE usuario_id = $1 ORDER BY id`, [x.id])).rows
  const pushDe = (x, titulo) => pushes.filter(p => p.to === `ExponentPushToken[u${Number(x.id.slice(-12))}]` && p.title === titulo)
  const emailDe = (x, titulo) => emails.filter(e => e.para === `u${Number(x.id.slice(-12))}@x.invalid` && String(e.assunto || '').includes(titulo.replace(/^\S+ /, '')))

  const DONO = await usr(1, 'Dona Ana', 'dono_obra')
  const PROF = await usr(10, 'Carlos Prof', 'prestador')

  // ═══════════ 1) PROFISSIONAL ═══════════
  // Nada retroativo: 3 notas baixas de ANTES do marco não contam.
  for (let i = 0; i < 3; i++) {
    await q(`INSERT INTO avaliacoes (contrato_tipo, contrato_id, avaliador_id, avaliado_id, estrelas, criado_em) VALUES ('reparo', $1, $2, $3, 1, (NOW() - INTERVAL '2 days')::timestamp)`, [await contrato(DONO, PROF), DONO.id, PROF.id])
  }
  const r1 = await avaliar(DONO, PROF, 1)
  if (r1.status !== 201) { errOrig(JSON.stringify(r1), erros.slice(-3)) }
  ok(r1.status === 201 && !(await u(PROF)).em_observacao_em && (await pens(PROF)).length === 0, 'nada retroativo: 3 notas baixas antigas + 1 nova não põem ninguém em observação', r1.status)
  await avaliar(DONO, PROF, 3)
  ok(!(await u(PROF)).em_observacao_em, '2 notas novas: ainda não há 3 para a média')
  await avaliar(DONO, PROF, 3)
  ok(!(await u(PROF)).em_observacao_em, 'média 2,33 (1, 3, 3): acima de 2,0, nada acontece')
  await avaliar(DONO, PROF, 2); await avaliar(DONO, PROF, 1)
  const p1 = await u(PROF), l1 = await pens(PROF)
  ok(!!p1.em_observacao_em && !p1.suspenso_em && l1.length === 1 && l1[0].tipo === 'observacao' && l1[0].motivo.avaliacoes.map(a => a.estrelas).join() === '1,2,3' && l1[0].motivo.media === 2,
     'média 2,0 nas 3 últimas (3, 2, 1) → em observação, com data e as 3 notas no motivo', [p1.em_observacao_em, l1[0]?.motivo.media])
  const po = pushDe(PROF, '⚠️ Sua conta está em observação'), eo = emailDe(PROF, '⚠️ Sua conta está em observação')
  ok(po.length === 1 && po[0].body === 'Suas últimas avaliações ficaram abaixo de 3 estrelas. Capriche nos próximos serviços: se a nota continuar baixa, sua conta será suspensa por 7 dias.' && eo.length === 1,
     'push + e-mail "⚠️ Sua conta está em observação" com o texto aprovado', [po.length, eo.length, po[0]?.body])
  ok((await P.verificarPenalidadeAvaliacoes(PROF.id)) === null && !(await u(PROF)).suspenso_em, 'a mesma avaliação que abriu a observação não suspende (precisa de outra)')
  await avaliar(DONO, PROF, 5)
  ok(!(await u(PROF)).suspenso_em && !!(await u(PROF)).em_observacao_em && pushDe(PROF, '⚠️ Sua conta está em observação').length === 1, 'nota boa em observação (5, 1, 2 → 2,67): continua em observação, sem novo aviso')
  await avaliar(DONO, PROF, 1)
  ok(!(await u(PROF)).suspenso_em, 'média 2,33 (1, 5, 1): ainda não suspende')
  const antes = Date.now()
  await avaliar(DONO, PROF, 1); await avaliar(DONO, PROF, 1)
  const p2 = await u(PROF), l2 = await pens(PROF)
  const sus = l2.find(x => x.tipo === 'suspensao')
  const dias = sus ? (new Date(sus.ate).getTime() - antes) / 86400000 : 0
  ok(!!p2.suspenso_em && p2.suspenso_motivo === P.MOTIVO_SUSPENSAO_AVALIACOES && p2.em_observacao_em === null && sus && dias > 6.99 && dias < 7.01 && l2[0].encerrada_em && sus.motivo.avaliacoes.length === 3,
     'de novo com a média <= 2,0 em observação → suspenso 7 dias pelo mecanismo existente (suspenso_em + suspenso_motivo)', [p2.suspenso_motivo, dias.toFixed(2)])
  const dataFim = P.dataBR(sus.ate)
  const ps = pushDe(PROF, '⛔ Conta suspensa por 7 dias'), es = emailDe(PROF, '⛔ Conta suspensa por 7 dias')
  ok(ps.length === 1 && ps[0].body === `Suas avaliações continuaram baixas. Você volta a receber pedidos em ${dataFim}. Dúvidas? Fale com o suporte no app.` && /^\d{2}\/\d{2}\/\d{4}$/.test(dataFim) && es.length === 1,
     'push + e-mail "⛔ Conta suspensa por 7 dias" com a data de volta', [ps[0]?.body, es.length])

  // Suspenso: sem proposta, feed só leitura.
  const sessao = { id: PROF.id, role: 'prestador', suspenso_em: p2.suspenso_em, suspenso_motivo: p2.suspenso_motivo }
  const b1 = await passar(exigirNaoSuspenso, sessao), b2 = await passar(P.exigirNaoSuspensoSalvoAvaliacoes, sessao)
  const b3 = await passar(P.exigirNaoSuspensoSalvoAvaliacoes, { ...sessao, suspenso_motivo: 'Faltas' }), b4 = await passar(P.exigirNaoSuspensoSalvoAvaliacoes, { id: PROF.id, role: 'prestador' })
  ok(b1.status === 403 && b1.body.codigo === 'CONTA_SUSPENSA' && b2.passou && b3.status === 403 && b4.passou, 'suspenso por avaliações: proposta barrada (403 CONTA_SUSPENSA), feed liberado para leitura; outro motivo segue barrado no feed', [b1.status, b2, b3.status])
  const mws = { feedObras: nomes('get', '/obras'), feedReparos: nomes('get', '/reparos'), interesse: nomes('post', '/reparos/:id/interesse'), candidatura: nomes('post', '/obras/:id/candidatura'),
    candidaturas: nomes('post', '/candidaturas'), pergunta: nomes('post', '/reparos/:id/perguntas'), proximidade: nomes('post', '/feed/checar-proximidade'), obrasDono: nomes('post', '/obras/dono'), reparosDono: nomes('post', '/reparos/dono') }
  ok(mws.feedObras.includes('exigirNaoSuspensoSalvoAvaliacoes') && mws.feedReparos.includes('exigirNaoSuspensoSalvoAvaliacoes') && !mws.feedObras.includes('exigirNaoSuspenso')
     && ['interesse', 'candidatura', 'candidaturas', 'pergunta', 'proximidade'].every(k => mws[k].includes('exigirNaoSuspenso')),
     'rotas: feeds com a exceção de leitura; interesse, candidatura, pergunta e proximidade continuam com exigirNaoSuspenso')
  ok(['obrasDono', 'reparosDono'].every(k => mws[k].includes('exigirPodePublicar') && mws[k].includes('exigirNaoSuspensoSalvoAvaliacoes')), 'rotas de criar pedido: exigirPodePublicar', [mws.obrasDono, mws.reparosDono])

  await avaliar(DONO, PROF, 1)
  ok((await pens(PROF)).length === 2 && !(await u(PROF)).em_observacao_em, 'nota baixa durante a suspensão: nada novo (a contagem recomeçou na suspensão)')
  // 7 dias depois: levantada sozinha, sem mensagem.
  const c0 = await P.encerrarPenalidadesVencidas()
  await q(`UPDATE usuarios SET suspenso_em = suspenso_em - INTERVAL '7 days 1 minute' WHERE id = $1`, [PROF.id])
  await q(`UPDATE penalidades_auto SET ate = ate - INTERVAL '7 days 1 minute' WHERE usuario_id = $1 AND tipo = 'suspensao'`, [PROF.id])
  const semAviso = pushes.length
  const c1 = await P.encerrarPenalidadesVencidas()
  const p3 = await u(PROF)
  ok(c0.profissionais.length === 0 && c1.profissionais.join() === PROF.id && p3.suspenso_em === null && p3.suspenso_motivo === null && (await pens(PROF))[1].encerramento === 'cumprida' && pushes.length === semAviso,
     'vencidos os 7 dias o cron levanta a suspensão (antes disso, não), sem mensagem', [c0.profissionais.length, c1.profissionais.length])
  await q(`UPDATE usuarios SET suspenso_em = NOW(), suspenso_motivo = 'Faltas' WHERE id = $1`, [PROF.id])
  await q(`UPDATE usuarios SET suspenso_em = suspenso_em - INTERVAL '30 days' WHERE id = $1`, [PROF.id])
  await P.encerrarPenalidadesVencidas()
  ok((await u(PROF)).suspenso_motivo === 'Faltas', 'suspensão por OUTRO motivo (faltas) não é levantada por este cron')

  // Já suspenso por outro motivo quando a 2ª sequência chega: fica como está.
  const PROF2 = await usr(11, 'Bia Prof', 'prestador')
  for (const n of [1, 2, 2]) await avaliar(DONO, PROF2, n)
  await q(`UPDATE usuarios SET suspenso_em = NOW(), suspenso_motivo = 'Faltas' WHERE id = $1`, [PROF2.id])
  await avaliar(DONO, PROF2, 1)
  const p4 = await u(PROF2)
  ok(!!p4.em_observacao_em && p4.suspenso_motivo === 'Faltas' && (await pens(PROF2)).length === 1, 'já suspenso por faltas: a suspensão existente não é reescrita', p4.suspenso_motivo)

  // ═══════════ 2) CLIENTE + 3) ANTI-REVANCHE ═══════════
  const CLI = await usr(2, 'Cliente Reclamado', 'dono_obra')
  const PA = await usr(21, 'Prof A', 'prestador'), PB = await usr(22, 'Prof B', 'prestador'), PC = await usr(23, 'Prof C', 'prestador'), PD = await usr(24, 'Prof D', 'prestador'), PE = await usr(25, 'Prof E', 'prestador')
  const aberto = D(9001)
  await q(`INSERT INTO reparos (id, titulo, criado_por, status, status_aprovacao, expira_em) VALUES ($1, 'Pedido aberto do cliente', $2, 'aberta', 'aprovada', now() + INTERVAL '30 days')`, [aberto, CLI.id])
  const semPub = async (x) => (await u(x)).publicacao_suspensa_ate
  await denunciar(PA, CLI); await denunciar(PA, CLI)
  await denunciar(PB, CLI)
  ok(!(await semPub(CLI)), '3 denúncias de só 2 profissionais (A, A, B): não suspende')
  // Revanche: C levou nota 2 neste contrato ANTES de denunciar → não conta.
  const cRev = await contrato(CLI, PC)
  await chamar('post', '/avaliacoes', { usuario: CLI, body: { contrato_tipo: 'reparo', contrato_id: cRev, nota: 2 } })
  const dRev = await denunciar(PC, CLI, cRev)
  ok(dRev.status === 201 && !(await semPub(CLI)), 'ANTI-REVANCHE: denúncia de quem levou nota <= 2 antes, no mesmo contrato, não conta', dRev.status)
  // D denuncia e SÓ DEPOIS recebe nota baixa: conta. Mas arquivada pelo admin deixa de contar.
  const cD = await contrato(CLI, PD)
  const dD = await denunciar(PD, CLI, cD)
  ok(!!(await semPub(CLI)) === true, '3ª denúncia válida de um 3º profissional (A, B, D) → publicação suspensa')
  const ate = await semPub(CLI)
  const diasC = (new Date(ate).getTime() - Date.now()) / 86400000
  const lc = await pens(CLI)
  ok(diasC > 6.99 && diasC < 7.01 && lc.length === 1 && lc[0].lado === 'cliente' && lc[0].tipo === 'suspensao' && new Set(lc[0].motivo.denuncias.map(d => d.denunciante_id)).size === 3 && !(await u(CLI)).suspenso_em,
     '7 dias sem publicar (coluna própria; suspenso_em intocado), motivo com as 3 denúncias de 3 profissionais', [diasC.toFixed(2), lc[0]?.motivo.denuncias.length])
  const dataC = P.dataBR(ate)
  const pc = pushDe(CLI, '⛔ Publicação de pedidos suspensa por 7 dias'), ec = emailDe(CLI, '⛔ Publicação de pedidos suspensa por 7 dias')
  ok(pc.length === 1 && pc[0].body === `Recebemos denúncias de profissionais diferentes sobre seus pedidos. Você poderá publicar de novo em ${dataC}. Dúvidas? Fale com o suporte no app.` && ec.length === 1,
     'push + e-mail "⛔ Publicação de pedidos suspensa por 7 dias" com a data', [pc[0]?.body, ec.length])
  const g1 = await passar(P.exigirPodePublicar, { id: CLI.id, role: 'dono_obra' }), g2 = await passar(P.exigirPodePublicar, { id: DONO.id, role: 'dono_obra' }), g3 = await passar(P.exigirPodePublicar, { id: CLI.id, role: 'admin' })
  ok(g1.status === 403 && g1.body.codigo === 'PUBLICACAO_SUSPENSA' && g1.body.erro.includes(dataC) && g1.body.publicacao_suspensa_ate && g2.passou && g3.passou, 'criar pedido: 403 claro com a data para o cliente suspenso; os outros publicam', g1.body)
  ok((await q(`SELECT status FROM reparos WHERE id = $1`, [aberto])).rows[0].status === 'aberta', 'pedidos abertos do cliente não são tocados')
  await denunciar(PE, CLI)
  ok((await pens(CLI)).length === 1 && pushDe(CLI, '⛔ Publicação de pedidos suspensa por 7 dias').length === 1, 'nova denúncia durante a suspensão: nada novo')
  await chamar('post', '/avaliacoes', { usuario: CLI, body: { contrato_tipo: 'reparo', contrato_id: cD, nota: 1 } })

  // Lista do admin: apos_nota_baixa.
  const ld = await chamar('get', '/admin/denuncias', { usuario: ADM, query: { limit: '50' } })
  const linhaRev = ld.body.denuncias.find(d => d.contrato_id === cRev), linhaD = ld.body.denuncias.find(d => d.contrato_id === cD)
  ok(ld.status === 200 && linhaRev.apos_nota_baixa === true && linhaRev.apos_nota_baixa_estrelas === 2 && linhaD.apos_nota_baixa === false && linhaD.apos_nota_baixa_estrelas === null && 'descricao' in linhaD,
     'GET /admin/denuncias: apos_nota_baixa true + estrelas na denúncia de revanche; false na que veio antes da nota', [linhaRev.apos_nota_baixa, linhaRev.apos_nota_baixa_estrelas, linhaD.apos_nota_baixa])

  // Vencimento, janela de 60 dias, arquivada e retroatividade.
  await q(`UPDATE usuarios SET publicacao_suspensa_ate = NOW() - INTERVAL '1 minute' WHERE id = $1`, [CLI.id])
  ok((await passar(P.exigirPodePublicar, { id: CLI.id, role: 'dono_obra' })).passou, 'passada a data, o cliente publica de novo (mesmo antes do cron)')
  await q(`UPDATE penalidades_auto SET ate = NOW() - INTERVAL '1 minute' WHERE usuario_id = $1`, [CLI.id])
  const c2 = await P.encerrarPenalidadesVencidas()
  ok(c2.clientes.join() === CLI.id && (await semPub(CLI)) === null && (await pens(CLI))[0].encerramento === 'cumprida', 'cron limpa a suspensão de publicação vencida')
  const CLI2 = await usr(3, 'Cliente Dois', 'dono_obra')
  await q(`UPDATE configuracoes SET valor = (NOW() - INTERVAL '200 days')::text WHERE chave = $1`, [P.CHAVE_MARCO])
  const dA = await denunciar(PA, CLI2), dB = await denunciar(PB, CLI2)
  await q(`UPDATE denuncias SET criado_em = (NOW() - INTERVAL '61 days')::timestamp WHERE id = $1`, [dA.body.id])
  await denunciar(PC, CLI2)
  ok(!(await semPub(CLI2)), 'denúncia com mais de 60 dias sai da conta (A há 61 dias, B, C)')
  await q(`UPDATE denuncias SET status = 'arquivada' WHERE id = $1`, [dB.body.id])
  await denunciar(PD, CLI2)
  ok(!(await semPub(CLI2)), 'denúncia arquivada pelo admin não conta (C, D + B arquivada)')
  await denunciar(PE, CLI2)
  ok(!!(await semPub(CLI2)), 'com a 3ª válida (C, D, E) suspende')
  const CLI3 = await usr(4, 'Cliente Três', 'dono_obra')
  await q(`UPDATE configuracoes SET valor = NOW()::text WHERE chave = $1`, [P.CHAVE_MARCO])
  for (const p of [PA, PB]) { const d = await denunciar(p, CLI3); await q(`UPDATE denuncias SET criado_em = (NOW() - INTERVAL '3 days')::timestamp WHERE id = $1`, [d.body.id]) }
  await denunciar(PC, CLI3)
  ok(!(await semPub(CLI3)), 'nada retroativo: 2 denúncias de antes do marco + 1 nova não suspendem')

  // ═══════════ 4) SUPER-ADMIN ═══════════
  for (const [m, c] of [['get', '/admin/penalidades'], ['post', '/admin/penalidades/:id/tirar-observacao'], ['post', '/admin/penalidades/:id/desfazer-suspensao']]) {
    const pilha = nomes(m, c)
    ok(pilha.includes('autenticar') && pilha.includes('exigirSuperAdmin'), `${m.toUpperCase()} ${c}: autenticar + exigirSuperAdmin`)
  }
  // PROF3: observação → suspensão em vigor; PROF2 segue em observação; CLI2 suspenso.
  const PROF3 = await usr(12, 'Caio Prof', 'prestador')
  for (const n of [2, 2, 2, 1]) await avaliar(DONO, PROF3, n)
  const lista = await chamar('get', '/admin/penalidades', { usuario: ADM })
  const porUsuario = (x) => lista.body.penalidades.filter(p => p.usuario_id === x.id)
  const eObs = porUsuario(PROF2)[0], eSus = porUsuario(PROF3)[0], eCli = porUsuario(CLI2)[0]
  ok(lista.status === 200 && porUsuario(PROF).length === 0 && porUsuario(CLI).length === 0 && porUsuario(PROF3).length === 1, 'lista só o que está em vigor (cumpridas e observação que virou suspensão ficam fora)', lista.body.total)
  ok(eObs.status === 'em_observacao' && eObs.lado === 'profissional' && eObs.nome === 'Bia Prof' && eObs.ate === null && eObs.motivo.avaliacoes.length === 3 && eObs.motivo.avaliacoes.every(a => a.estrelas <= 2 && a.contrato_titulo),
     'em_observacao: pessoa, lado e as 3 avaliações', eObs.motivo.resumo)
  ok(eSus.status === 'suspenso' && eSus.lado === 'profissional' && eSus.ate && eSus.motivo.tipo === 'avaliacoes' && eSus.motivo.avaliacoes.length === 3, 'suspenso (profissional): até quando e as 3 avaliações', eSus.motivo.resumo)
  ok(eCli.status === 'suspenso' && eCli.lado === 'cliente' && eCli.ate && eCli.motivo.denuncias.length === 3 && eCli.motivo.denuncias.every(d => d.denunciante_nome && d.categoria), 'suspenso (cliente): até quando e as 3 denúncias com quem denunciou', eCli.motivo.resumo)

  const nAvisos = pushes.length + emails.length
  const t0 = await chamar('post', '/admin/penalidades/:id/tirar-observacao', { usuario: ADM, params: { id: String(eSus.id) } })
  const t1 = await chamar('post', '/admin/penalidades/:id/tirar-observacao', { usuario: ADM, params: { id: String(eObs.id) } })
  const t2 = await chamar('post', '/admin/penalidades/:id/tirar-observacao', { usuario: ADM, params: { id: String(eObs.id) } })
  const t3 = await chamar('post', '/admin/penalidades/:id/tirar-observacao', { usuario: ADM, params: { id: 'abc' } })
  ok(t0.status === 404 && t1.status === 200 && (await u(PROF2)).em_observacao_em === null && (await u(PROF2)).suspenso_motivo === 'Faltas' && t2.status === 409 && t3.status === 400,
     'tirar-observacao: limpa a observação (não mexe em outra suspensão); id de suspensão → 404; repetir → 409', [t0.status, t1.status, t2.status, t3.status])
  const f1 = await chamar('post', '/admin/penalidades/:id/desfazer-suspensao', { usuario: ADM, params: { id: String(eSus.id) } })
  const f2 = await chamar('post', '/admin/penalidades/:id/desfazer-suspensao', { usuario: ADM, params: { id: String(eCli.id) } })
  const p5 = await u(PROF3)
  ok(f1.status === 200 && p5.suspenso_em === null && p5.suspenso_motivo === null && f2.status === 200 && (await semPub(CLI2)) === null && (await passar(P.exigirPodePublicar, { id: CLI2.id, role: 'dono_obra' })).passou,
     'desfazer-suspensao: profissional volta ao normal e cliente volta a publicar', [f1.status, f2.status])
  ok(pushes.length + emails.length === nAvisos, 'tirar/desfazer não mandam mensagem ao usuário')
  const lista2 = await chamar('get', '/admin/penalidades', { usuario: ADM })
  ok(![PROF2, PROF3, CLI2].some(x => lista2.body.penalidades.some(p => p.usuario_id === x.id)), 'encerradas pelo admin saem da lista')
  await q(`UPDATE usuarios SET suspenso_em = NULL, suspenso_motivo = NULL WHERE id = $1`, [PROF2.id])
  await avaliar(DONO, PROF2, 1)
  ok(!(await u(PROF2)).em_observacao_em && !(await u(PROF2)).suspenso_em, 'depois de o admin tirar a observação a contagem recomeça (1 nota baixa nova não basta)')

  const meus = erros.filter(e => /Penalidades|penalidades/.test(e))
  ok(meus.length === 0, 'nenhum erro do módulo de penalidades no log', meus)
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
