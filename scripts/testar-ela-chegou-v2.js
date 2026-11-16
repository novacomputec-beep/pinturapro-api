#!/usr/bin/env node
// "ELA CHEGOU? v2" (arte aprovada, 16/11/2026 — reparos E obras):
//  1) POST /:id/confirmar-comparecimento {resposta:'remarcar'} — o dono diz que combinaram outro
//     horário: some o horário e todo o estado de chegada/atraso, o fluxo de proposta reabre, NINGUÉM
//     leva falta/marca, e o profissional recebe o push neutro "🕐 Novo horário". 'sim'/'nao' iguais.
//  2) POST /:id/liberar-whatsapp — só o dono, com profissional escolhido e antes da conclusão:
//     o detalhe do profissional passa a trazer dono_telefone como depois do "Estou a caminho";
//     pedido de cancelamento PENDENTE do profissional é retirado (sem falta) e registrado; push
//     "📱 <primeiro nome> liberou o WhatsApp para vocês combinarem."; a liberação é DO MATCH.
// Rotas REAIS sobre o esquema de produção (scripts/fixtures/esquema-producao.sql, PGlite).
//   npm i -D @electric-sql/pglite && node scripts/testar-ela-chegou-v2.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

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
  if (/brevoService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) }, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async () => {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? () => {} : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const A = require(path.join(REPO, 'src/services/alertaService'))
const W = require(path.join(REPO, 'src/services/liberarWhatsappService'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = (ms = 250) => new Promise(r => setTimeout(r, ms))
const mw = router.stack.find(l => !l.route && l.handle && l.handle.name === 'valorACombinarParaApp').handle
const handler = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}
// Como o Express: middleware do router → handler final; app NOVO (1.2.4) por padrão.
const chamar = async (metodo, padrao, { usuario, params = {}, query = {}, body = {}, versao = '1.2.4' } = {}) => {
  try {
    return await new Promise(resolve => {
      const caminho = padrao.replace(/:([A-Za-z_]+)/g, (_, k) => params[k])
      const res = { statusCode: 200, headersSent: false, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { this.headersSent = true; resolve({ status: this.statusCode, body: JSON.parse(JSON.stringify(b)) }) } }
      const req = { method: metodo.toUpperCase(), path: caminho, params, query, body, usuario, get: (h) => (String(h).toLowerCase() === 'x-app-version' ? versao : ''), headers: {}, ip: '127.0.0.1' }
      mw(req, res, () => Promise.resolve(handler(metodo, padrao)(req, res)).catch(e => resolve({ status: 599, body: { erro: String(e.message) } })))
    })
  } finally { await assentar() }
}

const DONO = { id: U(900), role: 'dono_obra', nome: 'Luiza Prado' }
const PROF = { id: U(1), role: 'prestador', tipo_prestador: 'reparador' }
const PROF2 = { id: U(2), role: 'prestador', tipo_prestador: 'reparador' }
const FONE_DONO = '34999990000'
const CFG = {
  reparos: { chave: 'reparo_id', det: 'reparo', prop: 'interesse_reparos', fk: 'reparo_id', cron: () => A.verificarCronometroReparos(), base: 0 },
  obras: { chave: 'obra_id', det: 'obra', prop: 'candidaturas', fk: 'obra_id', cron: () => A.verificarCronometroObras(), base: 100 },
}

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await W.migrarWhatsappLiberado({ query: q }); await W.migrarWhatsappLiberado({ query: q })
  const cols = (await db.query(`SELECT table_name FROM information_schema.columns WHERE column_name IN ('whatsapp_liberado_em', 'whatsapp_liberado_para') AND table_schema = 'public'`)).rows
  ok(cols.length === 4, 'migração: whatsapp_liberado_em / _para em reparos e obras (idempotente)', cols.length)

  const usr = (u, nome, extra = {}) => {
    const c = { id: u.id, nome, email: `${nome.toLowerCase().replace(/\s/g, '')}@x.invalid`, role: u.role, cidade: 'Uberlândia', uf: 'MG', cpf_cnpj: u.id.slice(-11), ativo: true, ...extra }
    const ks = Object.keys(c)
    return db.query(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => c[k]))
  }
  await usr(DONO, 'Luiza Prado', { telefone: FONE_DONO, push_token: 'ExponentPushToken[dona]' })
  await usr(PROF, 'Rep Um', { tipo_prestador: 'reparador', especialidades: ['eletrica', 'pintor'], push_token: 'ExponentPushToken[rep1]', telefone: '34988880001' })
  await usr(PROF2, 'Rep Dois', { tipo_prestador: 'reparador', especialidades: ['eletrica', 'pintor'], push_token: 'ExponentPushToken[rep2]', telefone: '34988880002' })
  await db.query(`INSERT INTO assinaturas (usuario_id, status, proximo_vencimento) SELECT id, 'ativa', now() + INTERVAL '30 days' FROM usuarios WHERE role = 'prestador'`)

  // Pedido com PROF escolhido; `extra` = colunas a mais em SQL cru (col = expr).
  const pedido = async (t, n, titulo, extra = {}, prof = PROF) => {
    const id = D(CFG[t].base + n)
    await db.query(
      `INSERT INTO ${t} (id, titulo, descricao, categoria, cidade, uf, bairro, criado_por, status, status_aprovacao, ${t === 'reparos' ? 'valor_estimado, prazo_atendimento_horas, categorias' : 'valor, horas_para_expirar, publicado_em'},
                         expira_em, match_usuario_id, match_feito_em)
       VALUES ($1, $2, 'Detalhes', $3, 'Uberlândia', 'MG', 'Centro', $4, 'aberta', 'aprovada', 80, 72, ${t === 'reparos' ? `ARRAY['eletrica']` : 'now()'},
               now() + INTERVAL '6 hours', $5, ${prof ? `now() - INTERVAL '5 hours'` : 'NULL'})`,
      [id, titulo, t === 'reparos' ? 'eletrica' : 'residencial', DONO.id, prof ? prof.id : null])
    const sets = Object.entries(extra).map(([k, v]) => `${k} = ${v}`)
    if (sets.length) await db.query(`UPDATE ${t} SET ${sets.join(', ')} WHERE id = $1`, [id])
    if (prof) await db.query(`INSERT INTO ${CFG[t].prop} (${CFG[t].fk}, usuario_id, status, valor_proposto, mensagem) VALUES ($1, $2, 'aceito', 80, 'Posso')`, [id, prof.id])
    return id
  }
  const linha = async (t, id) => (await db.query(`SELECT * FROM ${t} WHERE id = $1`, [id])).rows[0]
  const contar = async (sql, p) => Number((await db.query(sql, p)).rows[0].n)
  const penalidades = async (id) => ({
    faltas: await contar(`SELECT count(*) n FROM faltas_profissional WHERE demanda_id = $1`, [id]),
    marcas: await contar(`SELECT count(*) n FROM eventos_responsabilidade WHERE demanda_id = $1`, [id]),
    desistencias: await contar(`SELECT count(*) n FROM desistencias WHERE demanda_id = $1`, [id]),
  })
  const semPenalidade = (p) => p.faltas === 0 && p.marcas === 0 && p.desistencias === 0
  // Horário AGENDADO vencido há 1h, com atraso avisado, pedido de atraso e chegada declarada pelo profissional.
  const AGENDA_VENCIDA = {
    chegada_janela: `'agendado'`, chegada_prevista_em: `now() - INTERVAL '1 hour'`, aviso_atraso_enviado_em: `now() - INTERVAL '50 minutes'`,
    pedido_atraso_minutos: '30', pedido_atraso_motivo: `'transito'`, pedido_atraso_em: `now() - INTERVAL '40 minutes'`, pedido_atraso_status: `'recusado'`, pedidos_atraso_usados: '1',
    lembrete_agenda_hora_em: `now() - INTERVAL '1 hour'`, sugestoes_horario_profissional: '1',
  }

  for (const t of ['reparos', 'obras']) {
    const c = CFG[t]
    const rota = (sufixo) => `/${t}/:id${sufixo}`
    logOrig(`\n──── ${t.toUpperCase()} ────`)

    // ═══ 1) remarcar ═══
    const R = await pedido(t, 1, 'Trocar tomada', { ...AGENDA_VENCIDA, chegada_declarada_por: `'${PROF.id}'`, chegada_declarada_em: `now() - INTERVAL '20 minutes'`, a_caminho_em: `now() - INTERVAL '70 minutes'` })
    pushes.length = 0; emails.length = 0
    const rm = await chamar('post', rota('/confirmar-comparecimento'), { usuario: DONO, params: { id: R }, body: { resposta: 'remarcar' } })
    ok(rm.status === 200 && rm.body.resposta === 'remarcar', `${t} remarcar: 200`, rm.body)
    const l = await linha(t, R)
    ok(l.chegada_janela === null && l.chegada_prevista_em === null && l.chegada_pendente_em === null, `${t} remarcar: horário combinado limpo`)
    ok(l.chegada_declarada_por === null && l.chegada_declarada_em === null && l.chegada_confirmada_em === null && l.a_caminho_em === null && l.comparecimento_resposta === null,
      `${t} remarcar: estado de chegada limpo (declarada, confirmada, a caminho, resposta)`, { por: l.chegada_declarada_por, a: l.a_caminho_em, r: l.comparecimento_resposta })
    ok(l.aviso_atraso_enviado_em === null && l.pedido_atraso_status === null && l.pedido_atraso_minutos === null && l.pedidos_atraso_usados === 0 && l.prazo_chegada_extra_em === null,
      `${t} remarcar: estado de atraso limpo`)
    ok(l.match_usuario_id === PROF.id && l.status === 'aberta', `${t} remarcar: o profissional continua escolhido e o pedido aberto`)
    ok(new Date(l.expira_em).getTime() >= Date.now() + 23 * 3600e3, `${t} remarcar: prazo com pelo menos 24h para combinar`, l.expira_em)
    ok(l.sugestoes_horario_profissional === 0 && l.sugestoes_horario_dono === 0 && l.chegada_proposta_por === null, `${t} remarcar: propostas de horário zeradas (fluxo reaberto para os dois)`)
    ok(semPenalidade(await penalidades(R)) && !(l.prestadores_bloqueados || []).includes(PROF.id), `${t} remarcar: nenhuma falta, marca, desistência ou bloqueio`, await penalidades(R))
    const pp = pushes.filter(p => p.to === 'ExponentPushToken[rep1]')
    ok(pp.length === 1 && pp[0].title === '🕐 Novo horário' && pp[0].body === 'O cliente pediu para combinar outro dia e hora para "Trocar tomada".' && pp[0].data?.tipo === 'chegada_remarcar' && pp[0].data?.[c.chave] === R,
      `${t} remarcar: push neutro ao profissional`, pp.map(p => [p.title, p.body, p.data]))
    ok(pushes.filter(p => p.to === 'ExponentPushToken[dona]').length === 0, `${t} remarcar: nenhum push ao dono`)
    // o cron não desfaz o match nem pune depois do remarcar
    await c.cron(); await assentar(400)
    const l2 = await linha(t, R)
    ok(l2.match_usuario_id === PROF.id && semPenalidade(await penalidades(R)), `${t} remarcar: cronômetro roda e o match segue, sem falta/marca`, await penalidades(R))
    // fluxo de proposta reaberto: o profissional propõe novo horário
    const nova = await chamar('post', rota('/chegada-prevista'), { usuario: PROF, params: { id: R }, body: { data_hora: new Date(Date.now() + 5 * 3600e3).toISOString() } })
    const l3 = await linha(t, R)
    ok(nova.status < 300 && (l3.chegada_pendente_em !== null || l3.chegada_prevista_em !== null), `${t} remarcar: profissional consegue propor novo horário`, { status: nova.status, corpo: nova.status < 300 ? undefined : nova.body })
    // segundo toque: já respondido/sem horário → 409, nada muda
    const rm2 = await chamar('post', rota('/confirmar-comparecimento'), { usuario: DONO, params: { id: R }, body: { resposta: 'remarcar' } })
    ok(rm2.status === 409, `${t} remarcar: sem horário vencido não remarca de novo (409)`, rm2.status)
    const rmProf = await chamar('post', rota('/confirmar-comparecimento'), { usuario: PROF, params: { id: R }, body: { resposta: 'remarcar' } })
    ok(rmProf.status === 403, `${t} remarcar: só o dono (403 para o profissional)`, rmProf.status)

    // 'sim' e 'nao' como hoje
    const S = await pedido(t, 2, 'Instalar lustre', AGENDA_VENCIDA)
    pushes.length = 0
    const sim = await chamar('post', rota('/confirmar-comparecimento'), { usuario: DONO, params: { id: S }, body: { resposta: 'sim' } })
    const ls = await linha(t, S)
    ok(sim.status === 200 && ls.chegada_confirmada_em !== null && ls.chegada_declarada_por === DONO.id && ls.a_caminho_em !== null && ls.comparecimento_resposta === 'sim' && ls.chegada_prevista_em !== null,
      `${t} 'sim' igual: chegada declarada+confirmada pelo dono, horário mantido`)
    ok(pushes.some(p => p.to === 'ExponentPushToken[rep1]' && p.title === '✅ Chegada confirmada!' && p.data?.tipo === 'chegada_confirmada'), `${t} 'sim' igual: push "Chegada confirmada!"`, pushes.map(p => p.title))
    const N = await pedido(t, 3, 'Trocar chuveiro', AGENDA_VENCIDA)
    const nao = await chamar('post', rota('/confirmar-comparecimento'), { usuario: DONO, params: { id: N }, body: { resposta: 'nao' } })
    ok(nao.status === 200 && nao.body.resposta === 'nao' && nao.body.comparecimento_resposta === 'nao', `${t} 'nao' igual: resposta gravada`, nao.body)
    const inval = await chamar('post', rota('/confirmar-comparecimento'), { usuario: DONO, params: { id: N }, body: { resposta: 'talvez' } })
    ok(inval.status === 400, `${t} resposta inválida: 400`, inval.status)

    // ═══ 2) liberar WhatsApp ═══
    const Wp = await pedido(t, 10, 'Pintar portão', {
      cancelamento_pedido_por: `'${PROF.id}'`, cancelamento_pedido_motivo: `'outro'`, cancelamento_pedido_detalhe: `'Preciso do contato para combinar'`,
      cancelamento_pedido_em: `now() - INTERVAL '10 minutes'`, cancelamento_pedido_expira_em: `now() + INTERVAL '110 minutes'`,
    })
    const antes = await chamar('get', rota(''), { usuario: PROF, params: { id: Wp } })
    ok(antes.status === 200 && antes.body.dono_telefone === null && antes.body.whatsapp_liberado === false && antes.body.pedido_cancelamento?.meu === true,
      `${t} antes de liberar: profissional sem dono_telefone, whatsapp_liberado false, pedido pendente visível`, { tel: antes.body.dono_telefone, w: antes.body.whatsapp_liberado })
    const negProf = await chamar('post', rota('/liberar-whatsapp'), { usuario: PROF, params: { id: Wp } })
    ok(negProf.status === 403 && (await linha(t, Wp)).whatsapp_liberado_em === null, `${t} liberar: só o dono (403 para o profissional, nada gravado)`, negProf.status)
    const inexistente = await chamar('post', rota('/liberar-whatsapp'), { usuario: DONO, params: { id: D(9999) } })
    ok(inexistente.status === 404, `${t} liberar: pedido inexistente → 404`, inexistente.status)
    const SemMatch = await pedido(t, 11, 'Sem escolhido', {}, null)
    const semMatch = await chamar('post', rota('/liberar-whatsapp'), { usuario: DONO, params: { id: SemMatch } })
    ok(semMatch.status === 409 && semMatch.body.codigo === 'SEM_MATCH', `${t} liberar: sem profissional escolhido → 409 SEM_MATCH`, semMatch.body)
    const Fechado = await pedido(t, 12, 'Já concluído', { status: `'encerrada'`, encerrado_em: 'now()' })
    const fechado = await chamar('post', rota('/liberar-whatsapp'), { usuario: DONO, params: { id: Fechado } })
    ok(fechado.status === 409 && fechado.body.codigo === 'DEMANDA_FECHADA' && (await linha(t, Fechado)).whatsapp_liberado_em === null, `${t} liberar: depois da conclusão → 409 DEMANDA_FECHADA`, fechado.body)

    pushes.length = 0; emails.length = 0
    const lib = await chamar('post', rota('/liberar-whatsapp'), { usuario: DONO, params: { id: Wp } })
    const lw = await linha(t, Wp)
    ok(lib.status === 200 && lib.body.ja_liberado === false && lib.body.pedido_cancelamento_retirado === true && lib.body.whatsapp_liberado_em, `${t} liberar: 200, pedido de cancelamento retirado`, lib.body)
    ok(lw.whatsapp_liberado_em !== null && lw.whatsapp_liberado_para === PROF.id, `${t} liberar: whatsapp_liberado_em gravado para o profissional do match`)
    ok(lw.cancelamento_pedido_por === null && lw.cancelamento_pedido_motivo === null && lw.cancelamento_pedido_detalhe === null && lw.cancelamento_pedido_em === null && lw.cancelamento_pedido_expira_em === null,
      `${t} liberar: colunas do pedido de cancelamento limpas`)
    ok(lw.match_usuario_id === PROF.id && lw.status === 'aberta' && semPenalidade(await penalidades(Wp)), `${t} liberar: match de pé, sem falta/marca/desistência`, await penalidades(Wp))
    const ev = (await db.query(`SELECT campo, valor_antes, valor_depois, origem, usuario_id, rota FROM eventos_demanda WHERE demanda_id = $1 ORDER BY id`, [Wp])).rows
    const evLib = ev.find(e => e.campo === 'whatsapp_liberado_em'), evRet = ev.find(e => e.campo === 'pedido_cancelamento_retirado')
    ok(!!evLib && evLib.usuario_id === DONO.id && evLib.rota === `POST /api/${t}/:id/liberar-whatsapp` && evLib.origem === 'rota', `${t} liberar: registrado em eventos_demanda (whatsapp_liberado_em)`, evLib)
    ok(!!evRet && /"motivo":"outro"/.test(evRet.valor_antes || '') && (evRet.valor_antes || '').includes(PROF.id) && /sem falta/.test(evRet.valor_depois || ''), `${t} liberar: retirada do pedido registrada em eventos_demanda`, evRet)
    const pw = pushes.filter(p => p.to === 'ExponentPushToken[rep1]')
    ok(pw.length === 1 && `${pw[0].title} ${pw[0].body}`.includes('Luiza liberou o WhatsApp para vocês combinarem.') && pw[0].title.startsWith('📱') && pw[0].data?.tipo === 'whatsapp_liberado' && pw[0].data?.[c.chave] === Wp,
      `${t} liberar: push ao profissional com o primeiro nome do dono`, pw.map(p => [p.title, p.body, p.data]))
    ok(pushes.length === 1 && emails.length === 0, `${t} liberar: só esse push (nada ao dono, nenhum e-mail)`, { pushes: pushes.length, emails: emails.length })

    const depois = await chamar('get', rota(''), { usuario: PROF, params: { id: Wp } })
    ok(depois.body.dono_telefone === FONE_DONO && depois.body.whatsapp_liberado === true && depois.body.pedido_cancelamento === null && depois.body[c.det]?.a_caminho_em == null,
      `${t} depois de liberar: profissional recebe dono_telefone (sem "Estou a caminho") e não há mais pedido pendente`, { tel: depois.body.dono_telefone, w: depois.body.whatsapp_liberado })
    const comoDono = await chamar('get', rota(''), { usuario: DONO, params: { id: Wp } })
    ok(comoDono.body.whatsapp_liberado === true && comoDono.body.dono_telefone === null, `${t} depois de liberar: dono vê whatsapp_liberado true`)
    const outro = await chamar('get', rota(''), { usuario: PROF2, params: { id: Wp } })
    ok(!outro.body.dono_telefone && !outro.body.whatsapp_liberado, `${t} depois de liberar: outro profissional NÃO recebe o telefone`, { status: outro.status, tel: outro.body.dono_telefone, w: outro.body.whatsapp_liberado })

    pushes.length = 0
    const lib2 = await chamar('post', rota('/liberar-whatsapp'), { usuario: DONO, params: { id: Wp } })
    ok(lib2.status === 200 && lib2.body.ja_liberado === true && pushes.length === 0 && String((await linha(t, Wp)).whatsapp_liberado_em) === String(lw.whatsapp_liberado_em), `${t} liberar de novo: 200 ja_liberado, sem novo push, data mantida`, lib2.body)

    // pedido de cancelamento feito pelo DONO não é retirado; sem pedido → retirado false
    const Pd = await pedido(t, 13, 'Pedido do dono', {
      cancelamento_pedido_por: `'${DONO.id}'`, cancelamento_pedido_motivo: `'outro'`, cancelamento_pedido_em: `now() - INTERVAL '10 minutes'`, cancelamento_pedido_expira_em: `now() + INTERVAL '110 minutes'`,
    })
    const libD = await chamar('post', rota('/liberar-whatsapp'), { usuario: DONO, params: { id: Pd } })
    const lpd = await linha(t, Pd)
    ok(libD.status === 200 && libD.body.pedido_cancelamento_retirado === false && lpd.cancelamento_pedido_por === DONO.id && lpd.cancelamento_pedido_em !== null && lpd.whatsapp_liberado_em !== null,
      `${t} liberar com pedido do DONO pendente: libera e o pedido dele fica`, libD.body)
    // pedido do profissional já VENCIDO não conta como retirado (o job limpa)
    const Pv = await pedido(t, 14, 'Pedido vencido', {
      cancelamento_pedido_por: `'${PROF.id}'`, cancelamento_pedido_motivo: `'outro'`, cancelamento_pedido_em: `now() - INTERVAL '3 hours'`, cancelamento_pedido_expira_em: `now() - INTERVAL '1 hour'`,
    })
    const libV = await chamar('post', rota('/liberar-whatsapp'), { usuario: DONO, params: { id: Pv } })
    ok(libV.status === 200 && libV.body.pedido_cancelamento_retirado === false, `${t} liberar com pedido já vencido: libera, nada a retirar`, libV.body)

    // a liberação é DO MATCH: trocou o profissional → some; liberar de novo vale para o novo
    await db.query(`UPDATE ${t} SET match_usuario_id = $2, match_feito_em = now() WHERE id = $1`, [Wp, PROF2.id])
    await db.query(`INSERT INTO ${c.prop} (${c.fk}, usuario_id, status, valor_proposto, mensagem) VALUES ($1, $2, 'aceito', 90, 'Eu faço')`, [Wp, PROF2.id])
    const novoProf = await chamar('get', rota(''), { usuario: PROF2, params: { id: Wp } })
    ok(novoProf.body.dono_telefone === null && novoProf.body.whatsapp_liberado === false, `${t} match trocado: o novo profissional NÃO herda o WhatsApp`, { tel: novoProf.body.dono_telefone, w: novoProf.body.whatsapp_liberado })
    const antigo = await chamar('get', rota(''), { usuario: PROF, params: { id: Wp } })
    ok(!antigo.body.dono_telefone, `${t} match trocado: o profissional anterior perde o telefone`, antigo.body.dono_telefone)
    pushes.length = 0
    const lib3 = await chamar('post', rota('/liberar-whatsapp'), { usuario: DONO, params: { id: Wp } })
    const novoProf2 = await chamar('get', rota(''), { usuario: PROF2, params: { id: Wp } })
    ok(lib3.status === 200 && lib3.body.ja_liberado === false && novoProf2.body.dono_telefone === FONE_DONO && pushes.some(p => p.to === 'ExponentPushToken[rep2]' && p.data?.tipo === 'whatsapp_liberado'),
      `${t} match trocado: liberar de novo vale para o novo profissional (com push)`, lib3.body)
    // "Estou a caminho" continua liberando sozinho
    const Ac = await pedido(t, 15, 'A caminho', { a_caminho_em: 'now()' })
    const ac = await chamar('get', rota(''), { usuario: PROF, params: { id: Ac } })
    ok(ac.body.dono_telefone === FONE_DONO && ac.body.whatsapp_liberado === false, `${t} "Estou a caminho" segue liberando o telefone como antes`, { tel: ac.body.dono_telefone, w: ac.body.whatsapp_liberado })
  }

  silenciar(false)
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { silenciar(false); console.error('ERRO', e); process.exit(1) })
