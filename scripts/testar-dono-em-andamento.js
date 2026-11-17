#!/usr/bin/env node
// DONO TROCA DE PROFISSIONAL / CANCELA COM O ATENDIMENTO EM ANDAMENTO (17/11/2026 — caso 3529D):
// chegada confirmada, pedido ainda aberto. Rotas REAIS sobre o ESQUEMA DE PRODUÇÃO (PGlite):
//   POST /:tabela/:id/cancelar-match  → só o DONO passa nessa fase (profissional: 409 A_CAMINHO);
//        troca (pedido volta ao feed) ou cancelamento (motivo nao_preciso / manter_aberta: false);
//   DELETE /:tabela/dono/:id          → cancelamento nessa fase (fora dela: 409 MATCH_ATIVO).
// Para o profissional: SEM falta, SEM compromisso_nao_cumprido, SEM lista negra; proposta
// 'cancelado' com motivo trocado_pelo_cliente / cancelado_pelo_cliente; push + e-mail com os
// textos aprovados (e-mail com o botão do suporte); histórico com
// encerrado_pelo_cliente_em_andamento. Fora dessa fase, tudo como antes.
//   npm i -D @electric-sql/pglite && node scripts/testar-dono-em-andamento.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

const pushes = [], emails = [], contextos = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { pushes.push(...chunk); return chunk.map((_, i) => ({ status: 'ok', id: `t${pushes.length}-${i}` })) }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
const auditoria = require(path.join(REPO, 'src/utils/auditoriaDemanda'))
const q = async (sql, params) => {
  if (!db) throw new Error('sem banco (boot)')
  // Caixa-preta: com que origem o un-match do pedido foi executado.
  if (typeof sql === 'string' && /UPDATE (reparos|obras) SET match_feito_em = NULL/.test(sql)) contextos.push(auditoria.contextoAtual())
  const r = await db.query(sql, params)
  if (r && r.rowCount === undefined) r.rowCount = r.rows.length || r.affectedRows || 0
  return r
}
const shim = { query: q, connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: q, release() {}, on() {} } }, on() {} }
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
const candidaturasCtrl = require(path.join(REPO, 'src/controllers/candidaturasController'))
const CM = require(path.join(REPO, 'src/services/cancelamentoMatchService'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 300))

const handler = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}
// Como o Express: o middleware de auditoria guarda a req (rota e usuário saem dela na hora da query).
const chamar = async (metodo, caminho, { usuario, params = {}, body = {}, query = {}, headers = {} } = {}) => {
  silenciar(true)
  try {
    const r = await new Promise(resolve => {
      const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
      const req = { method: metodo.toUpperCase(), baseUrl: '/api', route: { path: caminho }, params, query, body, usuario, headers, get: (h) => headers[String(h).toLowerCase()] || '' , ip: '127.0.0.1' }
      const h = caminho === '/candidaturas/minhas' ? candidaturasCtrl.minhas : handler(metodo, caminho)
      auditoria.middlewareAuditoria(req, res, () => Promise.resolve(h(req, res)).catch(e => resolve({ status: 599, body: { erro: String(e.message) } })))
    })
    await assentar()
    return r
  } finally { silenciar(false) }
}

const DONO = { id: U(900), role: 'dono_obra' }, OUTRO_DONO = { id: U(901), role: 'dono_obra' }
const EMILYN = { id: U(1), role: 'prestador', tipo_prestador: 'reparador' }, CARLOS = { id: U(2), role: 'prestador', tipo_prestador: 'reparador' }

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  // Em produção existe (é o alvo do ON CONFLICT do dedupe de e-mail); a fixture não traz constraints.
  await db.exec(`CREATE UNIQUE INDEX email_alertas_chave ON email_alertas (tipo, demanda_id, usuario_id)`)

  const usr = (u, nome, extra = {}) => {
    const cols = { id: u.id, nome, email: `${nome.split(' ')[0].toLowerCase()}@x.invalid`, role: u.role, cidade: 'Patos de Minas', uf: 'MG', cpf_cnpj: u.id.slice(-11), ativo: true, ...extra }
    const ks = Object.keys(cols)
    return q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => cols[k]))
  }
  await usr(DONO, 'Luiz Melo'); await usr(OUTRO_DONO, 'Maria Souza')
  await usr(EMILYN, 'Emilyn Santos', { tipo_prestador: 'reparador', push_token: 'ExponentPushToken[emilyn]' })
  await usr(CARLOS, 'Carlos Freitas', { tipo_prestador: 'reparador', push_token: 'ExponentPushToken[carlos]' })
  await q(`INSERT INTO assinaturas (usuario_id, status, proximo_vencimento) SELECT id, 'ativa', now() + INTERVAL '30 days' FROM usuarios WHERE role = 'prestador'`)

  const h = (horas) => new Date(Date.now() + horas * 3600000).toISOString()
  // fase: 'andamento' (chegada confirmada — como o 3529D), 'a_caminho' (sem chegada), 'match' (só escolhido).
  const pedido = async (t, n, titulo, fase, extra = {}) => {
    const base = { id: D(n), titulo, descricao: 'x', categoria: t === 'reparos' ? 'panfletagem' : 'residencial', cidade: 'Patos de Minas', uf: 'MG', criado_por: DONO.id,
      status: 'aberta', status_aprovacao: 'aprovada', match_usuario_id: EMILYN.id, match_feito_em: h(-21),
      ...(t === 'reparos' ? { prazo_atendimento_horas: 24, valor_estimado: 80 } : { horas_para_expirar: 24, valor: 80 }) }
    const fases = {
      match: {},
      a_caminho: { chegada_janela: 'agendado', chegada_prevista_em: h(-20), a_caminho_em: h(-20) },
      andamento: { chegada_janela: 'agendado', chegada_prevista_em: h(-20), a_caminho_em: h(-19), chegada_declarada_por: DONO.id, chegada_declarada_em: h(-19), chegada_confirmada_em: h(-19),
        comparecimento_resposta: 'sim', encerramento_solicitado_por: EMILYN.id, encerramento_solicitado_em: h(-1), lembrete_conclusao_em: h(-2) },
    }
    const cols = { ...base, ...fases[fase], ...extra }
    const ks = Object.keys(cols)
    // expira_em vencido há 15 h (prazo de escolha) — exatamente o 3529D.
    await q(`INSERT INTO ${t} (${ks.join(', ')}, expira_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, now() - INTERVAL '15 hours')`, ks.map(k => cols[k]))
    const [tp, fk] = t === 'reparos' ? ['interesse_reparos', 'reparo_id'] : ['candidaturas', 'obra_id']
    await q(`INSERT INTO ${tp} (${fk}, usuario_id, status, valor_proposto) VALUES ($1, $2, 'aceito', 80)`, [D(n), EMILYN.id])
    await q(`INSERT INTO ${tp} (${fk}, usuario_id, status, status_antes_match, valor_proposto) VALUES ($1, $2, 'recusado', 'pendente', 90)`, [D(n), CARLOS.id])
  }
  const linha = async (t, n) => (await q(`SELECT * FROM ${t} WHERE id = $1`, [D(n)])).rows[0]
  const proposta = async (t, n, u) => (await q(`SELECT * FROM ${t === 'reparos' ? 'interesse_reparos' : 'candidaturas'} WHERE ${t === 'reparos' ? 'reparo_id' : 'obra_id'} = $1 AND usuario_id = $2`, [D(n), u.id])).rows[0]
  const punicoes = async () => (await q(`SELECT (SELECT count(*)::int FROM faltas_profissional) AS faltas, (SELECT count(*)::int FROM eventos_responsabilidade) AS eventos`)).rows[0]
  const zerar = () => { pushes.length = 0; emails.length = 0; contextos.length = 0 }
  const TROCA = { titulo: 'Pedido trocado pelo cliente', corpo: (t) => `O cliente decidiu trocar de profissional no pedido "${t}". Isso não conta como falta para você.` }
  const CANCELA = { titulo: 'Pedido cancelado pelo cliente', corpo: (t) => `O cliente cancelou o pedido "${t}". Isso não conta como falta para você.` }
  const BOTAO = 'Não foi isso que aconteceu? Fale com o ProTudo'

  for (const [t, base] of [['reparos', 0], ['obras', 100]]) {
    const rota = `/${t}/:id/cancelar-match`
    const chave = t === 'reparos' ? 'reparo_id' : 'obra_id'

    // ═══ TROCA — o caso 3529D ═══
    const titulo = `Entregar panfletos (${t})`
    await pedido(t, base + 1, titulo, 'andamento')
    let r = await chamar('post', rota, { usuario: EMILYN, params: { id: D(base + 1) }, body: { motivo: 'outro' } })
    ok(r.status === 409 && r.body.codigo === 'A_CAMINHO', `${t}: o PROFISSIONAL continua sem poder cancelar em andamento (409 A_CAMINHO)`, [r.status, r.body.codigo])
    r = await chamar('post', rota, { usuario: OUTRO_DONO, params: { id: D(base + 1) }, body: { motivo: 'outro' } })
    ok(r.status === 403, `${t}: outra pessoa → 403`, r.status)
    r = await chamar('post', rota, { usuario: DONO, params: { id: D(base + 1) }, query: { simular: '1' } })
    ok(r.status === 200 && r.body.em_andamento === true && r.body.falta === false && r.body.tipo === 'livre' && r.body.papel === 'dono' && (await linha(t, base + 1)).match_usuario_id === EMILYN.id,
       `${t}: dono simula em andamento → 200, em_andamento true, sem falta, nada muda`, r.body)
    r = await chamar('post', rota, { usuario: DONO, params: { id: D(base + 1) }, body: {} })
    ok(r.status === 400, `${t}: sem motivo → 400 (contrato da rota mantido)`, r.status)

    zerar()
    process.env.SUPORTE_CONTATO_URL = 'https://wa.me/5534999990000?text=Ol%C3%A1&x=1'
    r = await chamar('post', rota, { usuario: DONO, params: { id: D(base + 1) }, body: { motivo: 'outro', detalhe: 'não gostei do serviço' } })
    let d = await linha(t, base + 1), p = await proposta(t, base + 1, EMILYN), pc = await proposta(t, base + 1, CARLOS), pun = await punicoes()
    ok(r.status === 200 && r.body.modo === 'trocado' && r.body.em_andamento === true && r.body.demanda_encerrada === false && r.body.falta === false,
       `${t}: dono TROCA em andamento → 200 modo trocado`, r.body)
    ok(d.status === 'aberta' && d.status_aprovacao === 'aprovada' && d.match_usuario_id === null && d.match_feito_em === null && d.chegada_confirmada_em === null && d.chegada_declarada_em === null
       && d.a_caminho_em === null && d.chegada_prevista_em === null && d.encerramento_solicitado_por === null && d.encerramento_solicitado_em === null && d.lembrete_conclusao_em === null
       && d.encerrado_em === null && new Date(d.expira_em) > new Date(Date.now() + 50 * 60000),
       `${t}: pedido volta ABERTO e limpo (match, chegada, a caminho, pedido de conclusão) com pelo menos 1 h de prazo`, [d.status, d.match_usuario_id, d.encerramento_solicitado_por])
    ok(!(d.prestadores_bloqueados || []).includes(EMILYN.id) && pun.faltas === 0 && pun.eventos === 0, `${t}: profissional SEM falta, SEM compromisso_nao_cumprido e FORA da lista negra do pedido`, [d.prestadores_bloqueados, pun])
    ok(p.status === 'cancelado' && p.cancelado_por === DONO.id && p.cancelado_motivo === 'trocado_pelo_cliente' && p.cancelado_detalhe === 'Outro motivo — não gostei do serviço' && p.cancelado_acordo === false && p.cancelado_em
       && pc.status === 'pendente', `${t}: proposta vira cancelado / trocado_pelo_cliente (por = dono); a do concorrente rebaixado volta a valer`, [p.status, p.cancelado_motivo, pc.status])
    const push = pushes.find(x => x.to === 'ExponentPushToken[emilyn]')
    ok(push && push.title === TROCA.titulo && push.body === TROCA.corpo(titulo) && push.data.tipo === 'match_cancelado' && push.data.em_andamento === 'trocado' && push.data[chave] === D(base + 1) && push.data.por === 'dono',
       `${t}: push ao profissional com título e texto exatos (troca)`, push && [push.title, push.body])
    const email = emails.find(x => x.para === 'emilyn@x.invalid')
    ok(email && email.assunto === TROCA.titulo && email.texto.includes(TROCA.corpo(titulo)) && email.texto.includes(`${BOTAO}: https://wa.me/5534999990000?text=Ol%C3%A1&x=1`)
       && email.html && email.html.includes(BOTAO) && email.html.includes('href="https://wa.me/5534999990000?text=Ol%C3%A1&amp;x=1"') && email.html.includes('Isso não conta como falta para você.'),
       `${t}: e-mail ao profissional com o mesmo texto e o botão do suporte`, email && [email.assunto, !!email.html])
    ok(contextos.length === 1 && contextos[0].origem === 'troca_em_andamento' && contextos[0].rota === `POST /api${rota}` && contextos[0].usuarioId === DONO.id,
       `${t}: caixa-preta — app.origem = troca_em_andamento, com a rota e o dono`, contextos)

    // ═══ histórico do profissional ═══
    if (t === 'reparos') {
      const mi = await chamar('get', '/reparos/meus-interesses', { usuario: EMILYN })
      const it = (mi.body.historico || []).find(x => x.reparo_id === D(base + 1)), itC = [...(mi.body.ativos || []), ...(mi.body.historico || [])]
      const miC = await chamar('get', '/reparos/meus-interesses', { usuario: CARLOS })
      const dC = [...(miC.body.ativos || []), ...(miC.body.historico || [])].find(x => x.reparo_id === D(base + 1))
      ok(it && it.encerrado_pelo_cliente_em_andamento === 'trocado' && it.status === 'cancelado' && itC.every(x => 'encerrado_pelo_cliente_em_andamento' in x) && dC && dC.encerrado_pelo_cliente_em_andamento === null,
         'reparos: histórico do profissional traz encerrado_pelo_cliente_em_andamento = trocado (null para os demais)', it && it.encerrado_pelo_cliente_em_andamento)
    } else {
      const mc = await chamar('get', '/candidaturas/minhas', { usuario: EMILYN })
      const it = (mc.body.candidaturas || []).find(x => x.obra_id === D(base + 1))
      ok(it && it.encerrado_pelo_cliente_em_andamento === 'trocado' && it.status === 'cancelado', 'obras: /candidaturas/minhas traz encerrado_pelo_cliente_em_andamento = trocado', it && it.encerrado_pelo_cliente_em_andamento)
    }

    // ═══ CANCELAMENTO pelo cancelar-match (motivo nao_preciso e manter_aberta: false) ═══
    for (const [n, body, rot] of [[2, { motivo: 'nao_preciso' }, 'motivo nao_preciso'], [3, { motivo: 'imprevisto', manter_aberta: false }, 'manter_aberta: false']]) {
      const tit = `Cancelar ${n} (${t})`
      await pedido(t, base + n, tit, 'andamento')
      zerar()
      delete process.env.SUPORTE_CONTATO_URL
      r = await chamar('post', rota, { usuario: DONO, params: { id: D(base + n) }, body })
      d = await linha(t, base + n); p = await proposta(t, base + n, EMILYN); pc = await proposta(t, base + n, CARLOS); pun = await punicoes()
      const ph = pushes.find(x => x.to === 'ExponentPushToken[emilyn]'), em = emails.find(x => x.para === 'emilyn@x.invalid')
      ok(r.status === 200 && r.body.modo === 'cancelado' && r.body.demanda_encerrada === true && d.status === 'cancelada' && d.status_aprovacao === 'cancelada' && d.encerrado_em && d.match_usuario_id === null
         && p.status === 'cancelado' && p.cancelado_motivo === 'cancelado_pelo_cliente' && p.cancelado_por === DONO.id && pc.status === 'recusado' && pun.faltas === 0 && pun.eventos === 0
         && !(d.prestadores_bloqueados || []).includes(EMILYN.id),
         `${t}: dono CANCELA em andamento (${rot}) → pedido cancelado, proposta cancelado_pelo_cliente, sem falta nem lista negra`, [r.status, r.body.modo, d.status, p.cancelado_motivo])
      ok(ph && ph.title === CANCELA.titulo && ph.body === CANCELA.corpo(tit) && ph.data.em_andamento === 'cancelado' && em && em.assunto === CANCELA.titulo && em.texto.includes(CANCELA.corpo(tit))
         && em.html && em.html.includes(BOTAO) && em.html.includes('href="mailto:novacomputec@gmail.com"') && em.texto.includes(`${BOTAO}: mailto:novacomputec@gmail.com`)
         && contextos[0]?.origem === 'cancelamento_em_andamento',
         `${t}: push + e-mail com título e texto exatos (cancelamento); SEM SUPORTE_CONTATO_URL o botão aparece com o contato padrão; origem cancelamento_em_andamento`, ph && [ph.title, ph.body, !!em?.html])
    }

    // ═══ CANCELAMENTO pela rota de cancelar o pedido (DELETE /:tabela/dono/:id) ═══
    const rotaDel = `/${t}/dono/:id`
    await pedido(t, base + 4, `Excluir (${t})`, 'andamento')
    zerar()
    process.env.SUPORTE_CONTATO_URL = 'mailto:suporte@x.invalid'
    r = await chamar('delete', rotaDel, { usuario: DONO, params: { id: D(base + 4) } })
    d = await linha(t, base + 4); p = await proposta(t, base + 4, EMILYN); pun = await punicoes()
    const pd = pushes.find(x => x.to === 'ExponentPushToken[emilyn]'), ed = emails.find(x => x.para === 'emilyn@x.invalid')
    ok(r.status === 200 && r.body.em_andamento === true && d.status === 'cancelada' && d.match_usuario_id === null && p.status === 'cancelado' && p.cancelado_motivo === 'cancelado_pelo_cliente' && p.cancelado_detalhe === null
       && pun.faltas === 0 && pun.eventos === 0 && pd && pd.title === CANCELA.titulo && pd.body === CANCELA.corpo(`Excluir (${t})`) && ed && ed.html.includes('href="mailto:suporte@x.invalid"')
       && contextos[0]?.origem === 'cancelamento_em_andamento' && contextos[0].rota === `DELETE /api${rotaDel}`,
       `${t}: DELETE /${t}/dono/:id em andamento → cancela do mesmo jeito (aviso, sem falta, origem na caixa-preta)`, [r.status, d.status, p.cancelado_motivo, contextos[0]?.rota])
    if (t === 'reparos') {
      const mi = await chamar('get', '/reparos/meus-interesses', { usuario: EMILYN })
      const it = (mi.body.historico || []).find(x => x.reparo_id === D(base + 4))
      ok(it && it.encerrado_pelo_cliente_em_andamento === 'cancelado' && it.reparo_status === 'cancelada', 'reparos: histórico traz encerrado_pelo_cliente_em_andamento = cancelado', it && it.encerrado_pelo_cliente_em_andamento)
    } else {
      const mc = await chamar('get', '/candidaturas/minhas', { usuario: EMILYN })
      const it = (mc.body.candidaturas || []).find(x => x.obra_id === D(base + 4))
      ok(it && it.encerrado_pelo_cliente_em_andamento === 'cancelado' && it.obra_status === 'cancelada', 'obras: histórico traz encerrado_pelo_cliente_em_andamento = cancelado', it && it.encerrado_pelo_cliente_em_andamento)
    }

    // ═══ FORA DA FASE: tudo como antes ═══
    await pedido(t, base + 5, `A caminho (${t})`, 'a_caminho')
    r = await chamar('post', rota, { usuario: DONO, params: { id: D(base + 5) }, body: { motivo: 'outro' } })
    const rDel = await chamar('delete', rotaDel, { usuario: DONO, params: { id: D(base + 5) } })
    ok(r.status === 409 && r.body.codigo === 'A_CAMINHO' && rDel.status === 409 && rDel.body.codigo === 'MATCH_ATIVO' && (await linha(t, base + 5)).match_usuario_id === EMILYN.id,
       `${t}: "a caminho" SEM chegada confirmada → cancelar-match 409 A_CAMINHO e DELETE 409 MATCH_ATIVO, como antes`, [r.status, r.body.codigo, rDel.status, rDel.body.codigo])
    await pedido(t, base + 6, `Só escolhido (${t})`, 'match')
    const rDel6 = await chamar('delete', rotaDel, { usuario: DONO, params: { id: D(base + 6) } })
    zerar()
    r = await chamar('post', rota, { usuario: DONO, params: { id: D(base + 6) }, body: { motivo: 'imprevisto' } })
    p = await proposta(t, base + 6, EMILYN)
    const p6 = pushes.find(x => x.to === 'ExponentPushToken[emilyn]')
    ok(rDel6.status === 409 && rDel6.body.codigo === 'MATCH_ATIVO' && r.status === 200 && !('em_andamento' in r.body) && p.status === 'cancelado' && p.cancelado_motivo === 'imprevisto'
       && p6 && p6.title !== TROCA.titulo && !('em_andamento' in p6.data) && contextos[0]?.origem === 'rota',
       `${t}: escolhido sem "a caminho" → cancelamento comum de sempre (motivo do dono, aviso antigo, origem rota)`, [rDel6.status, r.status, p.cancelado_motivo, p6?.title])
    await pedido(t, base + 7, `Encerrado (${t})`, 'andamento', { status: 'encerrada', status_aprovacao: 'encerrada', encerrado_em: h(-1) })
    r = await chamar('post', rota, { usuario: DONO, params: { id: D(base + 7) }, body: { motivo: 'outro' } })
    const rDel7 = await chamar('delete', rotaDel, { usuario: DONO, params: { id: D(base + 7) } })
    ok(r.status === 409 && r.body.codigo === 'DEMANDA_FECHADA' && rDel7.status === 409 && (await linha(t, base + 7)).status === 'encerrada' && (await proposta(t, base + 7, EMILYN)).status === 'aceito',
       `${t}: pedido ENCERRADO não entra (409) — nem troca nem cancelamento`, [r.status, r.body.codigo, rDel7.status])
  }

  // ═══ botão do suporte: variável inválida também cai no contato padrão ═══
  process.env.SUPORTE_CONTATO_URL = 'javascript:alert(1)'
  await pedido('reparos', 60, 'Variável inválida', 'andamento')
  zerar()
  await chamar('post', '/reparos/:id/cancelar-match', { usuario: DONO, params: { id: D(60) }, body: { motivo: 'outro' } })
  const eInv = emails.find(x => x.para === 'emilyn@x.invalid')
  ok(eInv && eInv.html.includes('href="mailto:novacomputec@gmail.com"') && !eInv.html.includes('javascript:'), 'SUPORTE_CONTATO_URL que não é https:// nem mailto: → contato padrão no botão')
  delete process.env.SUPORTE_CONTATO_URL

  // ═══ "cancelamentos frequentes" do dono: a TROCA em andamento não conta; o CANCELAMENTO conta ═══
  // Dona nova (Maria), com push: o aviso sai no 3º cancelamento que conta em 90 dias.
  await q(`UPDATE usuarios SET push_token = 'ExponentPushToken[maria]' WHERE id = $1`, [OUTRO_DONO.id])
  const daMaria = { criado_por: OUTRO_DONO.id }
  const frequentes = () => pushes.filter(x => x.to === 'ExponentPushToken[maria]' && x.data?.tipo === 'cancelamentos_frequentes')
  const acao = async (t, n, body) => {
    await pedido(t, n, `Maria ${n}`, 'andamento', daMaria)
    return chamar('post', `/${t}/:id/cancelar-match`, { usuario: OUTRO_DONO, params: { id: D(n) }, body })
  }
  zerar()
  const c1 = await acao('reparos', 71, { motivo: 'nao_preciso' })                     // cancelamento 1 (conta)
  const t1 = await acao('reparos', 72, { motivo: 'outro' })                           // troca (não conta)
  const t2 = await acao('obras', 73, { motivo: 'imprevisto' })                        // troca (não conta)
  const c2 = await acao('obras', 74, { motivo: 'imprevisto', manter_aberta: false })  // cancelamento 2 (conta)
  const t3 = await acao('reparos', 75, { motivo: 'outro' })                           // troca (não conta)
  ok([c1, c2].every(x => x.body.modo === 'cancelado') && [t1, t2, t3].every(x => x.body.modo === 'trocado') && frequentes().length === 0,
     '2 cancelamentos + 3 trocas em andamento: nenhum aviso de cancelamentos frequentes (as trocas não contam)', frequentes().length)
  const c3 = await chamar('delete', '/reparos/dono/:id', { usuario: OUTRO_DONO, params: { id: (await pedido('reparos', 76, 'Maria 76', 'andamento', daMaria), D(76)) } })
  ok(c3.status === 200 && frequentes().length === 1 && frequentes()[0].data.total === 3, '3º CANCELAMENTO em andamento (pelo DELETE do pedido): o aviso sai, contando 3', frequentes().map(x => x.data.total))
  const t4 = await acao('reparos', 77, { motivo: 'outro' })
  ok(t4.body.modo === 'trocado' && frequentes().length === 1, 'troca depois disso não dispara o aviso de novo')
  await pedido('reparos', 78, 'Maria 78', 'match', daMaria)
  const comum = await chamar('post', '/reparos/:id/cancelar-match', { usuario: OUTRO_DONO, params: { id: D(78) }, body: { motivo: 'imprevisto' } })
  const nMaria = (await q(`SELECT (SELECT count(*)::int FROM interesse_reparos WHERE cancelado_por = $1 AND cancelado_motivo <> 'trocado_pelo_cliente') + (SELECT count(*)::int FROM candidaturas WHERE cancelado_por = $1 AND cancelado_motivo <> 'trocado_pelo_cliente') AS n`, [OUTRO_DONO.id])).rows[0].n
  ok(comum.status === 200 && nMaria === 4 && frequentes().length === 1, 'cancelamento comum (fora da fase) continua contando como antes: 4º não repete o aviso', [nMaria, frequentes().length])

  // ═══ guarda de versão 1.2.4 (paliativo do pedido de acordo) intacta ═══
  const req = (v) => ({ get: (h) => (String(h).toLowerCase() === 'x-app-version' ? v : undefined) })
  ok(CM.VERSAO_APP_COM_PEDIDO_CANCELAMENTO === '1.2.4' && CM.appAntigoParaPedidoCancelamento(req('1.2.3')) === true && CM.appAntigoParaPedidoCancelamento(req('1.2.4')) === false
     && CM.appAntigoParaPedidoCancelamento(req(undefined)) === true && CM.appAntigoParaPedidoCancelamento(req('1.3.0')) === false && CM.OCULTAR_PEDIDO_CANCELAMENTO_NO_APP.reparos === true && CM.OCULTAR_PEDIDO_CANCELAMENTO_NO_APP.obras === false,
     'guarda de versão 1.2.4 (X-App-Version) inalterada')
  await pedido('reparos', 50, 'Com pedido de acordo', 'andamento', { cancelamento_pedido_por: EMILYN.id, cancelamento_pedido_motivo: 'outro', cancelamento_pedido_em: h(-0.5), cancelamento_pedido_expira_em: h(1.5) })
  const s123 = await chamar('post', '/reparos/:id/cancelar-match', { usuario: DONO, params: { id: D(50) }, query: { simular: '1' }, headers: { 'x-app-version': '1.2.3' } })
  const s124 = await chamar('post', '/reparos/:id/cancelar-match', { usuario: DONO, params: { id: D(50) }, query: { simular: '1' }, headers: { 'x-app-version': '1.2.4' } })
  ok(s123.body.em_andamento === true && s123.body.pedido_cancelamento === null && s124.body.pedido_cancelamento && s124.body.pedido_cancelamento.por === 'profissional',
     'simular em andamento respeita a guarda: app < 1.2.4 não recebe o pedido de acordo; 1.2.4 recebe', [s123.body.pedido_cancelamento, s124.body.pedido_cancelamento?.por])

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
