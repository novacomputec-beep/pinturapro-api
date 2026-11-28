#!/usr/bin/env node
// AJUSTES DA VISITA (utils/orcamentoVisita — arte aprovada "visita-ajustes-previa", dono 27/11/2026). Nos DOIS lados:
//  1) POST …/orcamento antes de visita_quando − 1h (orcamento_libera_em) → 409 ORCAMENTO_ANTES_DA_VISITA
//     ("O orçamento libera em dd/mm às HHh, 1 hora antes da visita.");
//  2) 'contratei' só em visita_aceita E a partir de visita_quando; pode_enviar_orcamento / pode_contratei em cada proposta;
//  3) GET /me/pendencias (profissional: visita_aceita; dono: orcamento_recebido; mais recentes primeiro, até 3);
//  4) match que veio de visita (orçamento aceito ou 'contratei'): endereço completo já visível ao profissional.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; rotas reais; Expo/Brevo falsos (harness de testar-pos-visita).
//   NODE_PATH=<pglite>/node_modules node scripts/testar-visita-ajustes.js
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
    // Ajustes da visita: o orçamento e o 'contratei' só liberam no horário da visita → leva a visita
    // para o passado antes (o bloqueio em si está em testar-visita-ajustes.js).
    const chegou = (pid) => q(`UPDATE ${L.prop} SET visita_quando = NOW() - INTERVAL '5 minutes' WHERE id = $1 AND visita_quando > NOW()`, [pid])
    const orcar = async (u, pid, body, id) => { await chegou(pid); return chamar('post', L.orc, { usuario: u, params: { id, propostaId: pid }, body }) }
    const detalhe = (u, id) => chamar('get', L.detalhe, { usuario: u, params: { id } })
    const visita = async (u, id, aceitar = true) => {
      const x = await enviar(u, { suporta_orcamento: true, tipo_proposta: 'visita', visita_quando: QUANDO }, id)
      if (aceitar) await responder(x.body.id, { action: 'aceitar_visita' }, id)
      return x.body.id
    }
    const acordado = async (id) => (await q(`SELECT ${L.acordado('p', 'd')} AS v FROM ${L.prop} p JOIN ${L.tabela} d ON d.id = p.${L.fk} WHERE p.${L.fk} = $1 AND p.status = 'aceito'`, [id])).rows[0]?.v
    const ORC = { valor: 1500, prazo_dias: 5, data_inicio: DIA(6) }

    // quandoCurto: "dd/mm às HHh" (minutos só quando não são zero), em São Paulo.
    ok(O.quandoCurto('2026-11-28T17:00:00Z') === '28/11 às 14h' && O.quandoCurto('2026-11-28T17:30:00Z') === '28/11 às 14h30' && O.quandoCurto('2026-12-01T02:00:00Z') === '30/11 às 23h',
       'quandoCurto: 28/11 às 14h, 14h30, virada de dia em São Paulo', [O.quandoCurto('2026-11-28T17:00:00Z'), O.quandoCurto('2026-11-28T17:30:00Z'), O.quandoCurto('2026-12-01T02:00:00Z')])
    const minha = (b) => b[L.tabela === 'obras' ? 'minha_candidatura' : 'meu_interesse']
    const lista = (b) => b[L.tabela === 'obras' ? 'candidatos' : 'interessados']
    const ENDERECO = L.tabela === 'obras' ? 'endereco_obra' : 'endereco_reparo'
    const orcarJa = (u, pid, body, id) => chamar('post', L.orc, { usuario: u, params: { id, propostaId: pid }, body })   // sem mexer no horário

    // ── 1) ORÇAMENTO ANTES DA VISITA ──
    const DEM = await demanda(L.tabela, dono, 'Reforma do banheiro')
    const P1 = await visita(pro1, DEM)
    pushes.length = 0
    let r = await orcarJa(pro1, P1, ORC, DEM)
    const LIBERA = new Date(new Date(QUANDO).getTime() - 3600000).toISOString()   // 13:00 em São Paulo
    const esperado = `O orçamento libera em ${O.quandoCurto(LIBERA)}, 1 hora antes da visita.`
    ok(r.status === 409 && r.body.codigo === 'ORCAMENTO_ANTES_DA_VISITA' && r.body.erro === esperado && /^O orçamento libera em \d{2}\/\d{2} às 13h, 1 hora antes da visita\.$/.test(r.body.erro)
       && r.body.visita_quando === QUANDO && r.body.orcamento_libera_em === LIBERA && (await prop(P1)).status === 'visita_aceita' && pushes.length === 0,
       'orçamento antes da liberação: 409 ORCAMENTO_ANTES_DA_VISITA, "… às 13h, 1 hora antes da visita.", orcamento_libera_em, nada muda', r.body)
    r = await detalhe(pro1, DEM)
    ok(minha(r.body)?.pode_enviar_orcamento === false && minha(r.body)?.pode_contratei === false && minha(r.body)?.orcamento_libera_em === LIBERA,
       'antes da liberação: pode_enviar_orcamento e pode_contratei false; orcamento_libera_em = visita − 1h', minha(r.body))
    r = await detalhe(dono, DEM)
    ok(lista(r.body).find(x => x.id === P1)?.pode_contratei === false && lista(r.body).find(x => x.id === P1)?.orcamento_libera_em === LIBERA, 'antes do horário (lista do dono): pode_contratei false, orcamento_libera_em')
    r = await responder(P1, { action: 'contratei' }, DEM)
    ok(r.status === 409 && r.body.codigo === 'CONTRATEI_INDISPONIVEL' && (await dem(DEM)).match_usuario_id === null, "'contratei' antes do horário: 409 CONTRATEI_INDISPONIVEL", r.body)

    // Janela de 1h antes: visita daqui a 61 min → ainda fechado; daqui a 30 min → orçamento liberado, 'contratei' não.
    const emMin = (pid, min) => q(`UPDATE ${L.prop} SET visita_quando = NOW() + ($2::int * INTERVAL '1 minute') WHERE id = $1`, [pid, min])
    const DEMj = await demanda(L.tabela, dono, 'Janela de uma hora')
    const PJ = await visita(pro2, DEMj)
    await emMin(PJ, 61)
    r = await orcarJa(pro2, PJ, ORC, DEMj)
    const m61 = minha((await detalhe(pro2, DEMj)).body)
    ok(r.status === 409 && r.body.codigo === 'ORCAMENTO_ANTES_DA_VISITA' && m61?.pode_enviar_orcamento === false
       && m61?.orcamento_libera_em === new Date(new Date(m61.visita_quando).getTime() - 3600000).toISOString(),
       'visita daqui a 61 min: orçamento ainda 409, pode_enviar_orcamento false', { s: r.status, l: m61?.orcamento_libera_em })
    await emMin(PJ, 30)
    const m30 = minha((await detalhe(pro2, DEMj)).body)
    ok(m30?.pode_enviar_orcamento === true && m30?.pode_contratei === false && new Date(m30.orcamento_libera_em).getTime() < Date.now(),
       'visita daqui a 30 min: pode_enviar_orcamento true, pode_contratei false (contratei segue no horário)', m30 && [m30.pode_enviar_orcamento, m30.pode_contratei])
    r = await responder(PJ, { action: 'contratei' }, DEMj)
    ok(r.status === 409 && r.body.codigo === 'CONTRATEI_INDISPONIVEL', "visita daqui a 30 min: 'contratei' ainda 409", r.body)
    r = await orcarJa(pro2, PJ, ORC, DEMj)
    ok(r.status === 200 && r.body.status === 'orcamento_enviado' && r.body.pode_enviar_orcamento === false && typeof r.body.orcamento_libera_em === 'string',
       'visita daqui a 30 min: orçamento aceito (200); a resposta traz orcamento_libera_em', r.body.status)
    ok(O.orcamentoLiberaEm({ visita_quando: '2026-11-28T17:00:00Z' }) === '2026-11-28T16:00:00.000Z' && O.orcamentoLiberaEm({}) === null && O.orcamentoLiberaEm({ visita_quando: 'x' }) === null,
       'orcamentoLiberaEm: visita − 1h em ISO; sem visita_quando → null')

    await chegou(P1)
    r = await detalhe(pro1, DEM)
    ok(minha(r.body)?.pode_enviar_orcamento === true && minha(r.body)?.pode_contratei === true, 'no horário: pode_enviar_orcamento e pode_contratei true', minha(r.body))
    r = await detalhe(dono, DEM)
    ok(lista(r.body).find(x => x.id === P1)?.pode_contratei === true && lista(r.body).find(x => x.id === P1)?.pode_enviar_orcamento === true, 'no horário (lista do dono): pode_contratei true')
    r = await orcarJa(pro1, P1, ORC, DEM)
    ok(r.status === 200 && r.body.status === 'orcamento_enviado' && r.body.pode_enviar_orcamento === false && r.body.pode_contratei === false, 'no horário: orçamento aceito (200); depois dele os dois false', r.body.status)
    r = await responder(P1, { action: 'contratei' }, DEM)
    ok(r.status === 409 && r.body.codigo === 'CONTRATEI_INDISPONIVEL', "'contratei' com orçamento enviado: 409 (o dono usa o 'aceitar')", r.body)
    const PV = (await enviar(pro2, { suporta_orcamento: true, valor_proposto: 250 }, DEM)).body.id
    r = await detalhe(dono, DEM)
    const lv = lista(r.body).find(x => x.id === PV)
    ok(lv?.pode_enviar_orcamento === false && lv?.pode_contratei === false && lv?.orcamento_libera_em === null, 'proposta de valor: os dois false, orcamento_libera_em null', lv && [lv.pode_enviar_orcamento, lv.pode_contratei, lv.orcamento_libera_em])

    // ── 4) ENDEREÇO para o match que veio da visita ──
    pushes.length = 0
    r = await responder(P1, { action: 'aceitar' }, DEM)
    ok(r.status === 200 && (await dem(DEM)).match_usuario_id === pro1.id && !(await dem(DEM)).chegada_prevista_em, 'orçamento aceito: match, sem horário combinado', r.status)
    r = await detalhe(pro1, DEM)
    ok(r.body[L.tabela === 'obras' ? 'obra' : 'reparo']?.endereco_liberado === true && r.body[L.tabela === 'obras' ? 'obra' : 'reparo']?.[ENDERECO] === 'Rua das Flores, 120',
       'match por orçamento aceito: endereço completo já visível ao profissional (sem esperar o horário)', r.body[L.tabela === 'obras' ? 'obra' : 'reparo']?.endereco_liberado)
    const DEMc = await demanda(L.tabela, dono, 'Troca do telhado')
    const Pc = await visita(pro3, DEMc); await chegou(Pc)
    r = await responder(Pc, { action: 'contratei' }, DEMc)
    const dc = (await detalhe(pro3, DEMc)).body[L.tabela === 'obras' ? 'obra' : 'reparo']
    ok(r.status === 200 && dc?.endereco_liberado === true && dc?.[ENDERECO] === 'Rua das Flores, 120', "match pelo 'contratei': endereço completo já visível", dc?.endereco_liberado)
    // Match desfeito com a proposta ainda 'aceito': o endereço fecha de novo.
    await q(`UPDATE ${L.tabela} SET match_usuario_id = NULL WHERE id = $1`, [DEMc])
    const dd = (await detalhe(pro3, DEMc)).body[L.tabela === 'obras' ? 'obra' : 'reparo']
    ok(dd?.endereco_liberado === false && dd?.[ENDERECO] === null, 'proposta aceita sem ser o match: endereço continua escondido', dd?.endereco_liberado)
    // Aceite comum (proposta de valor): segue escondido até o horário.
    const DEMv = await demanda(L.tabela, dono, 'Instalar chuveiro')
    const Pv = (await enviar(pro4, { suporta_orcamento: true, valor_proposto: 200 }, DEMv)).body.id
    await responder(Pv, { action: 'aceitar' }, DEMv)
    const dv = (await detalhe(pro4, DEMv)).body[L.tabela === 'obras' ? 'obra' : 'reparo']
    ok(dv?.endereco_liberado === false && dv?.[ENDERECO] === null, 'match comum (proposta de valor): endereço só depois do horário, como antes', dv?.endereco_liberado)

    // ── 3) GET /me/pendencias ──
    const pend = async (u) => (await chamar('get', '/me/pendencias', { usuario: u })).body
    const proP = await usr('Gabi Pro', 'prestador'), donoP = await usr('Hugo Dono', 'dono_obra'), outro = await usr('Iara Pro', 'prestador')
    const E1 = await demanda(L.tabela, donoP, 'Pedido A'), E2 = await demanda(L.tabela, donoP, 'Pedido B'), E3 = await demanda(L.tabela, donoP, 'Pedido C')
    const E4 = await demanda(L.tabela, donoP, 'Pedido D'), E5 = await demanda(L.tabela, donoP, 'Pedido E')
    const visitaP = async (id, aceitar = true) => { const x = await enviar(proP, { suporta_orcamento: true, tipo_proposta: 'visita', visita_quando: QUANDO }, id); if (aceitar) await responder(x.body.id, { action: 'aceitar_visita' }, id, donoP); return x.body.id }
    const V1 = await visitaP(E1), V2 = await visitaP(E2), V3 = await visitaP(E3)
    await q(`UPDATE ${L.prop} SET visita_aceita_em = NOW() - INTERVAL '3 hours' WHERE id = $1`, [V1])
    await q(`UPDATE ${L.prop} SET visita_aceita_em = NOW() - INTERVAL '1 hour' WHERE id = $1`, [V2])
    // V3: visita de um dia que já passou (São Paulo) → fora.
    await q(`UPDATE ${L.prop} SET visita_quando = NOW() - INTERVAL '2 days' WHERE id = $1`, [V3])
    // V4: visita de hoje que já começou → dentro; V5: visita ainda pendente → fora.
    const V4 = await visitaP(E4); await q(`UPDATE ${L.prop} SET visita_quando = $2::timestamptz, visita_aceita_em = NOW() - INTERVAL '2 hours' WHERE id = $1`, [V4, new Date(Math.max(Date.now() - 60000, new Date(`${HOJE_SP}T03:01:00Z`).getTime())).toISOString()])
    await visitaP(E5, false)
    let pp = await pend(proP)
    ok(Array.isArray(pp.pendencias) && pp.pendencias.length === 3 && pp.pendencias.map(x => x.proposta_id).join() === [V2, V4, V1].join()
       && pp.pendencias.every(x => x.tipo === 'visita_aceita' && x[L.chave] && x.titulo && x.visita_quando && Object.keys(x).length === 5),
       'pendências do profissional: visitas aceitas de hoje em diante sem orçamento, mais recentes primeiro, campos exatos', pp.pendencias)
    ok(pp.pendencias[0][L.chave] === E2 && pp.pendencias[0].titulo === 'Pedido B' && pp.pendencias[0].visita_quando === QUANDO, 'pendência: obra_id|reparo_id, titulo e visita_quando', pp.pendencias[0])
    await chegou(V2); await orcarJa(proP, V2, { ...ORC, valor: 900 }, E2)
    pp = await pend(proP)
    ok(pp.pendencias.length === 2 && !pp.pendencias.some(x => x.proposta_id === V2), 'orçamento enviado: sai das pendências do profissional', pp.pendencias.map(x => x.titulo))
    const pd = await pend(donoP)
    ok(pd.pendencias.length === 1 && pd.pendencias[0].tipo === 'orcamento_recebido' && pd.pendencias[0].proposta_id === V2 && pd.pendencias[0][L.chave] === E2
       && pd.pendencias[0].titulo === 'Pedido B' && pd.pendencias[0].valor === 900 && Object.keys(pd.pendencias[0]).length === 5,
       'pendências do dono: orçamento recebido sem resposta, com valor', pd.pendencias)
    await responder(V2, { action: 'recusar' }, E2, donoP)
    ok((await pend(donoP)).pendencias.length === 0, 'orçamento respondido (recusado): sai das pendências do dono')
    ok((await pend(outro)).pendencias.length === 0, 'outro usuário: sem pendências')
  }

  ok(nomes('get', '/me/pendencias')[0] === 'autenticar', 'GET /me/pendencias: autenticar', nomes('get', '/me/pendencias'))
  const inesperados = erros.filter(x => !/ENOTFOUND|geoBusca|sem banco|PAGBANK|webhook/i.test(x))
  ok(inesperados.length === 0, 'nenhum erro inesperado no log', inesperados.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
