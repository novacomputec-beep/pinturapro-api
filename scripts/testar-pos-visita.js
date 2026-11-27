#!/usr/bin/env node
// PÓS-VISITA (utils/orcamentoVisita — arte aprovada "pos-visita-previa", dono 27/11/2026). Nos DOIS lados:
//  1) 'contratei' no …/responder (visita_aceita ou orcamento_enviado; valor_combinado opcional >= R$ 20):
//     aceite de sempre + valor acordado + origem_match 'contratado_apos_visita' + push "✅ … contratou você";
//  2) "📋 Você está na visita?" na hora da visita, uma vez, fora do silêncio noturno;
//  3) cancelamento do dono com contratou_visitante (só com visitante ativo) e visitante_ativo no detalhe do dono.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; rotas reais; Expo/Brevo falsos (harness de testar-orcamento-visita).
//   NODE_PATH=<pglite>/node_modules node scripts/testar-pos-visita.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

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
const O = require(path.join(REPO, 'src/utils/orcamentoVisita'))
const P = require(path.join(REPO, 'src/utils/penalidadesAuto'))
const { avisarUsuario } = require(path.join(REPO, 'src/services/alertaService'))
const { migrarWhatsapp } = require(path.join(REPO, 'src/whatsapp/migracao'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 250))
const rotasDe = (r) => r.stack.flatMap(l => (l.route ? [l.route] : l.handle?.stack ? rotasDe(l.handle) : []))
const ROTAS = rotasDe(router)
const rota = (metodo, caminho) => { const r = ROTAS.find(x => x.path === caminho && x.methods[metodo]); if (!r) throw new Error(`rota ${metodo} ${caminho} não encontrada`); return r }
const nomes = (metodo, caminho) => rota(metodo, caminho).stack.map(l => l.handle.name || l.name)
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

const AMANHA = new Date(Date.now() + 26 * 3600000)
const QUANDO = new Date(Date.UTC(AMANHA.getUTCFullYear(), AMANHA.getUTCMonth(), AMANHA.getUTCDate() + 1, 17, 0, 0)).toISOString() // 14:00 em São Paulo
const HOJE_SP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
const DIA = (dias) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + dias * 86400000))
const { sqlValorAcordadoReparo, sqlValorAcordadoObra } = require(path.join(REPO, 'src/utils/valorAcordado'))

const LADOS = [
  { tabela: 'obras', prop: 'candidaturas', fk: 'obra_id', criar: '/obras/:id/candidatura', responder: '/obras/:id/candidatura/:candidaturaId/responder', pid: 'candidaturaId',
    orc: '/obras/:id/candidatura/:propostaId/orcamento', detalhe: '/obras/:id', cancelar: '/obras/dono/:id', chave: 'obra_id', idPush: 'candidatura_id', acordado: sqlValorAcordadoObra },
  { tabela: 'reparos', prop: 'interesse_reparos', fk: 'reparo_id', criar: '/reparos/:id/interesse', responder: '/reparos/:id/interesse/:interesse_id/responder', pid: 'interesse_id',
    orc: '/reparos/:id/interesse/:propostaId/orcamento', detalhe: '/reparos/:id', cancelar: '/reparos/dono/:id', chave: 'reparo_id', idPush: 'interesse_id', acordado: sqlValorAcordadoReparo },
]

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`
    CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_push_entregas_uq ON push_entregas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_configuracoes_uq ON configuracoes (chave);
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true'), ('email_resumo_diario', 'false');
  `)
  await P.migrarPenalidadesAuto(shim)
  await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT')
  await O.migrarOrcamentoVisita(shim); await O.migrarOrcamentoVisita(shim)
  const cols = (await q(`SELECT table_name || '.' || column_name AS c FROM information_schema.columns
                          WHERE (table_name IN ('candidaturas', 'interesse_reparos') AND column_name IN ('visita_hora_aviso_em', 'valor_combinado'))
                             OR (table_name IN ('obras', 'reparos') AND column_name IN ('origem_match', 'contratou_visitante'))`)).rows.length
  ok(cols === 8, 'migração (2x, idempotente): visita_hora_aviso_em + valor_combinado nas propostas; origem_match + contratou_visitante nos pedidos', cols)

  let nUsr = 0
  const usr = async (nome, role, extra = {}) => {
    const n = ++nUsr
    const c = { id: U(n), nome, email: `u${n}@x.invalid`, role, cpf_cnpj: String(n).padStart(11, '0'), ativo: true, cidade: 'Patos de Minas', uf: 'MG', telefone: `349${String(90000000 + n)}`,
      push_token: `ExponentPushToken[u${n}]`, ...(role === 'prestador' ? { tipo_prestador: 'reparador', especialidades: ['eletrica'] } : { tipo_dono: 'reparo' }), ...extra }
    const ks = Object.keys(c)
    await q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => c[k]))
    if (role === 'prestador') await q(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [c.id])
    return { id: c.id, role, nome, tipo_prestador: c.tipo_prestador, token: c.push_token }
  }
  let nDem = 0
  const demanda = async (tabela, dono, titulo, extra = {}) => {
    const id = D(++nDem)
    const c = { id, titulo, descricao: 'Detalhes', criado_por: dono.id, status: 'aberta', status_aprovacao: 'aprovada', cidade: 'Patos de Minas', uf: 'MG', latitude: -18.5789, longitude: -46.5181,
      ...(tabela === 'reparos' ? { categoria: 'eletrica', categorias: ['eletrica'], valor_estimado: 300, endereco_reparo: 'Rua das Flores, 120' } : { categoria: 'residencial', valor: 3000, endereco_obra: 'Rua das Flores, 120' }), ...extra }
    const ks = Object.keys(c)
    await q(`INSERT INTO ${tabela} (${ks.join(', ')}, expira_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, NOW() + INTERVAL '10 days')`, ks.map(k => c[k]))
    return id
  }
  const pushDe = (u, re) => pushes.filter(p => p.to === u.token && re.test(p.title))
  const MEIO_DIA = new Date(`${HOJE_SP}T15:00:00Z`)   // 12:00 em São Paulo, hoje

  for (const L of LADOS) {
    logOrig(`\n── ${L.tabela} ──`)
    const dono = await usr('Carla Souza', 'dono_obra')
    const pro1 = await usr('Ana Pro', 'prestador'), pro2 = await usr('Beto Pro', 'prestador'), pro3 = await usr('Caio Pro', 'prestador'), pro4 = await usr('Duda Pro', 'prestador')
    const prop = async (id) => (await q(`SELECT * FROM ${L.prop} WHERE id = $1`, [id])).rows[0]
    const dem = async (id) => (await q(`SELECT * FROM ${L.tabela} WHERE id = $1`, [id])).rows[0]
    const enviar = (u, body, id) => chamar('post', L.criar, { usuario: u, params: { id }, body })
    const responder = (pid, body, id, u = dono) => chamar('post', L.responder, { usuario: u, params: { id, [L.pid]: pid }, body })
    const orcar = (u, pid, body, id) => chamar('post', L.orc, { usuario: u, params: { id, propostaId: pid }, body })
    const detalhe = (u, id) => chamar('get', L.detalhe, { usuario: u, params: { id } })
    const visita = async (u, id, aceitar = true) => {
      const x = await enviar(u, { suporta_orcamento: true, tipo_proposta: 'visita', visita_quando: QUANDO }, id)
      if (aceitar) await responder(x.body.id, { action: 'aceitar_visita' }, id)
      return x.body.id
    }
    const acordado = async (id) => (await q(`SELECT ${L.acordado('p', 'd')} AS v FROM ${L.prop} p JOIN ${L.tabela} d ON d.id = p.${L.fk} WHERE p.${L.fk} = $1 AND p.status = 'aceito'`, [id])).rows[0]?.v
    const ORC = { valor: 1500, prazo_dias: 5, data_inicio: DIA(6) }

    // ── 1) CONTRATEI ──
    const DEM = await demanda(L.tabela, dono, 'Reforma do banheiro')
    const P1 = await visita(pro1, DEM)                                       // visita aceita
    const P2 = await visita(pro2, DEM); await orcar(pro2, P2, ORC, DEM)      // orçamento enviado
    const P3 = (await enviar(pro3, { suporta_orcamento: true, valor_proposto: 250 }, DEM)).body.id   // proposta de valor
    const P4 = await visita(pro4, DEM, false)                                // visita pendente
    await q(`UPDATE ${L.prop} SET visita_aceita_em = NOW() - INTERVAL '2 hours' WHERE id = $1`, [P1])
    await q(`UPDATE ${L.prop} SET visita_aceita_em = NOW() - INTERVAL '1 hour' WHERE id = $1`, [P2])

    let r = await detalhe(dono, DEM)
    ok(r.status === 200 && r.body.visitante_ativo?.proposta_id === P2 && r.body.visitante_ativo.nome === 'Beto', 'detalhe do dono: visitante_ativo = visita aceita/orçamento mais recente, primeiro nome', r.body.visitante_ativo)
    r = await detalhe(pro1, DEM)
    ok(r.status === 200 && r.body.visitante_ativo === null, 'detalhe do profissional: visitante_ativo null', r.body.visitante_ativo)

    r = await responder(P4, { action: 'contratei' }, DEM)
    const rValor = await responder(P3, { action: 'contratei' }, DEM)
    ok(r.status === 409 && r.body.codigo === 'CONTRATEI_INDISPONIVEL' && rValor.status === 409 && rValor.body.codigo === 'CONTRATEI_INDISPONIVEL' && (await dem(DEM)).match_usuario_id === null,
       "'contratei' em visita pendente ou proposta de valor: 409 CONTRATEI_INDISPONIVEL, nada muda", [r.body, rValor.body])
    r = await responder(P1, { action: 'contratei' }, DEM, pro2)
    ok(r.status === 403, "'contratei' só pelo dono", r.status)
    r = await responder(P1, { action: 'contratei', valor_combinado: 19.99 }, DEM)
    ok(r.status === 400 && r.body.codigo === 'VALOR_MINIMO' && (await prop(P1)).status === 'visita_aceita' && (await dem(DEM)).match_usuario_id === null, 'valor_combinado abaixo de R$ 20: 400 VALOR_MINIMO, nada muda', r.body)

    pushes.length = 0
    r = await responder(P1, { action: 'contratei', valor_combinado: '850,50' }, DEM)
    let p = await prop(P1), d = await dem(DEM)
    ok(r.status === 200 && p.status === 'aceito' && Number(p.valor_proposto) === 850.5 && Number(p.valor_combinado) === 850.5 && d.match_usuario_id === pro1.id && !!d.match_feito_em
       && d.origem_match === 'contratado_apos_visita' && Number(await acordado(DEM)) === 850.5,
       "'contratei' com valor_combinado: aceito, match, valor acordado 850,50, origem_match contratado_apos_visita", { s: r.status, v: p.valor_proposto, o: d.origem_match })
    ok((await prop(P2)).status === 'recusado' && (await prop(P3)).status === 'recusado' && (await prop(P4)).status === 'recusado', 'demais propostas recusadas, como no aceite de sempre')
    const pc = pushDe(pro1, /registrou que contratou você/)
    ok(pc.length === 1 && pc[0].title === '✅ Carla registrou que contratou você para "Reforma do banheiro"' && pc[0].data.tipo === 'contratado_apos_visita' && pc[0].data[L.chave] === DEM && pc[0].data[L.idPush] === P1
       && pushDe(pro1, /Deu match/).length === 0 && pushDe(pro2, /Outro profissional foi selecionado/).length === 1,
       'push ✅ ao contratado (no lugar do "Deu match"); recusa aos demais', pushes.map(x => x.title))
    r = await responder(P1, { action: 'contratei' }, DEM)
    ok(r.status === 200 && pushDe(pro1, /registrou que contratou você/).length === 1, "'contratei' repetido: 200, sem novo aviso", r.body)
    r = await detalhe(dono, DEM)
    ok(r.body.visitante_ativo === null, 'depois do contratei: visitante_ativo null', r.body.visitante_ativo)

    // Orçamento enviado, sem valor_combinado → o valor do orçamento.
    const DEM2 = await demanda(L.tabela, dono, 'Pintura do muro')
    const Q1 = await visita(pro1, DEM2); await orcar(pro1, Q1, ORC, DEM2)
    r = await responder(Q1, { action: 'contratei' }, DEM2)
    p = await prop(Q1)
    ok(r.status === 200 && p.status === 'aceito' && Number(p.valor_combinado) === 1500 && Number(await acordado(DEM2)) === 1500 && (await dem(DEM2)).origem_match === 'contratado_apos_visita',
       "'contratei' com orçamento enviado e sem valor_combinado: valor acordado = orçamento (1500)", { v: p.valor_combinado })
    // Visita aceita, sem valor → sem valor próprio (o acordado cai no valor do pedido, como no aceite comum).
    const DEM3 = await demanda(L.tabela, dono, 'Troca do telhado')
    const Q2 = await visita(pro2, DEM3)
    r = await responder(Q2, { action: 'contratei' }, DEM3)
    p = await prop(Q2)
    ok(r.status === 200 && p.valor_combinado === null && p.valor_proposto === null && Number(await acordado(DEM3)) === (L.tabela === 'obras' ? 3000 : 300),
       "'contratei' sem valor e sem orçamento: valor_combinado nulo, acordado = valor do pedido", { v: await acordado(DEM3) })
    // Aceite comum: origem_match continua NULL e o push é o de sempre.
    const DEM4 = await demanda(L.tabela, dono, 'Instalar chuveiro')
    const V1 = (await enviar(pro3, { suporta_orcamento: true, valor_proposto: 200 }, DEM4)).body.id
    pushes.length = 0
    r = await responder(V1, { action: 'aceitar' }, DEM4)
    ok(r.status === 200 && (await dem(DEM4)).origem_match === null && pushDe(pro3, /Deu match/).length === 1 && pushDe(pro3, /contratou você/).length === 0, "'aceitar' comum: origem_match NULL e push de sempre", r.status)

    // ── 2) NA HORA DA VISITA ──
    const DEM5 = await demanda(L.tabela, dono, 'Conserto da calha')
    const pro5 = await usr('Enzo Pro', 'prestador'), pro6 = await usr('Fabi Pro', 'prestador')
    const H1 = await visita(pro1, DEM5), H2 = await visita(pro2, DEM5), H3 = await visita(pro3, DEM5), H4 = await visita(pro4, DEM5)
    const H5 = await visita(pro5, DEM5), H6 = await visita(pro6, DEM5)
    const quando = (id, t) => q(`UPDATE ${L.prop} SET visita_quando = $2::timestamptz WHERE id = $1`, [id, t.toISOString()])
    await quando(H1, new Date(MEIO_DIA.getTime() - 30 * 60000))                                          // 11:30 → sai ao meio-dia
    await quando(H2, new Date(MEIO_DIA.getTime() - 30 * 60000)); await orcar(pro2, H2, ORC, DEM5)        // orçamento enviado → não
    await quando(H3, new Date(MEIO_DIA.getTime() - 30 * 60000)); await responder(H3, { action: 'recusar' }, DEM5)   // visita cancelada → não
    await quando(H4, new Date(MEIO_DIA.getTime() + 60 * 60000))                                          // 13:00 → ainda não
    await quando(H5, new Date(MEIO_DIA.getTime() - 8 * 3600000))                                         // 04:00 → fora da janela de 6h
    const MADRUGADA = new Date(MEIO_DIA.getTime() + 14 * 3600000)                                        // 02:00 de amanhã
    await quando(H6, new Date(MADRUGADA.getTime() - 30 * 60000))                                         // 01:30 de amanhã
    pushes.length = 0
    let n = await O.avisarHoraDaVisita({ avisarUsuario }, shim, MEIO_DIA); await assentar()
    const ph = pushDe(pro1, /Você está na visita/)
    ok(n === 1 && ph.length === 1 && ph[0].title === '📋 Você está na visita?' && ph[0].body === 'Envie o orçamento de "Conserto da calha" agora, pelo app.' && ph[0].data.tipo === 'hora_da_visita'
       && ph[0].data[L.chave] === DEM5 && ph[0].data[L.idPush] === H1 && !!(await prop(H1)).visita_hora_aviso_em
       && [pro2, pro3, pro4, pro5, pro6].every(u => pushDe(u, /Você está na visita/).length === 0),
       'hora da visita: só a visita aceita SEM orçamento, não cancelada, já começada e dentro da janela — texto e destino da proposta', { n, b: ph[0]?.body })
    n = await O.avisarHoraDaVisita({ avisarUsuario }, shim, new Date(MEIO_DIA.getTime() + 5 * 60000))
    ok(n === 0, 'hora da visita: uma vez só', n)
    n = await O.avisarHoraDaVisita({ avisarUsuario }, shim, new Date(MEIO_DIA.getTime() + 65 * 60000)); await assentar()
    ok(n === 1 && pushDe(pro4, /Você está na visita/).length === 1, 'hora da visita: sai quando a hora chega (13:05)', n)
    n = await O.avisarHoraDaVisita({ avisarUsuario }, shim, MADRUGADA)
    ok(n === 0 && (await prop(H6)).visita_hora_aviso_em === null, 'hora da visita no silêncio noturno (02:00): não sai', n)
    n = await O.avisarHoraDaVisita({ avisarUsuario }, shim, new Date(MADRUGADA.getTime() + 5 * 3600000)); await assentar()
    ok(n === 1 && pushDe(pro6, /Você está na visita/).length === 1, 'hora da visita: a de 01:30 sai às 07:00 (dentro da janela de 6h)', n)
    const DEM6 = await demanda(L.tabela, dono, 'Pedido já com escolhido')
    const H7 = await visita(pro5, DEM6); await quando(H7, new Date(MEIO_DIA.getTime() - 10 * 60000))
    await q(`UPDATE ${L.tabela} SET match_usuario_id = $2 WHERE id = $1`, [DEM6, pro1.id])
    ok((await O.avisarHoraDaVisita({ avisarUsuario }, shim, MEIO_DIA)) === 0, 'hora da visita: pedido com escolhido não avisa')

    // ── 3) CANCELAMENTO DO DONO ──
    const cancelar = (id, body = {}, query = {}) => chamar('delete', L.cancelar, { usuario: dono, params: { id }, body, query })
    const C1 = await demanda(L.tabela, dono, 'Cancela com visitante'); await visita(pro1, C1)
    const C2 = await demanda(L.tabela, dono, 'Cancela sem visitante'); await visita(pro2, C2, false)
    const C3 = await demanda(L.tabela, dono, 'Cancela com orçamento'); const O3 = await visita(pro3, C3); await orcar(pro3, O3, ORC, C3)
    const C4 = await demanda(L.tabela, dono, 'Cancela com valor inválido'); await visita(pro4, C4)
    r = await cancelar(C1, { contratou_visitante: true })
    const r2 = await cancelar(C2, { contratou_visitante: true }), r3 = await cancelar(C3, {}, { contratou_visitante: 'false' }), r4 = await cancelar(C4, { contratou_visitante: 'talvez' })
    const cv = [await dem(C1), await dem(C2), await dem(C3), await dem(C4)]
    ok([r, r2, r3, r4].every(x => x.status === 200) && cv[0].contratou_visitante === true && cv[1].contratou_visitante === null && cv[2].contratou_visitante === false && cv[3].contratou_visitante === null
       && cv.every(x => x.status === 'cancelada'),
       'cancelar: contratou_visitante gravado só com visitante ativo (true; "false" pela query); sem visitante ou valor inválido = NULL; o cancelamento segue igual',
       cv.map(x => [x.status, x.contratou_visitante]))
  }

  const inesperados = erros.filter(x => !/ENOTFOUND|geoBusca|sem banco|PAGBANK|webhook/i.test(x))
  ok(inesperados.length === 0, 'nenhum erro inesperado no log', inesperados.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
