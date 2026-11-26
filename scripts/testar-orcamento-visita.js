#!/usr/bin/env node
// PROPOSTA DE VISITA PARA ORÇAMENTO (utils/orcamentoVisita) — dono, 26/11/2026. Nos DOIS lados
// (obras/candidaturas e reparos/interesse_reparos):
//  1) enviar: app antigo como sempre; com suporta_orcamento → valor mínimo R$ 20 (400 VALOR_MINIMO)
//     e tipo_proposta 'visita' (visita_quando futura, grátis ou com valor);
//  2) dono aceita a visita ('aceitar_visita', ou o 'aceitar' do app antigo): 'visita_aceita', pedido
//     continua aberto, endereço só para esse profissional, push "📋 Visita aceita: …";
//  3) profissional manda o orçamento → 'orcamento_enviado', push "💰 Orçamento recebido: …"; o
//     aceite do dono é o de sempre (match, demais recusadas); recusar não mexe em mais nada;
//  4) lembrete no dia seguinte ao da visita, uma vez, fora do silêncio noturno;
//  5) app antigo: mensagem legível e valor_proposto nunca nulo; 6) campos nos payloads.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-orcamento-visita.js
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

const puras = () => {
  const a = new Date('2026-11-26T12:00:00Z')
  ok(JSON.stringify(O.lerProposta({ valor_proposto: 5, tipo_proposta: 'visita' }, a)) === '{"legado":true,"tipo":"valor"}', 'sem suporta_orcamento: nada muda (tipo_proposta e mínimo ignorados)')
  const min = O.lerProposta({ suporta_orcamento: true, valor_proposto: 19.99 }, a).erro
  ok(min?.codigo === 'VALOR_MINIMO' && min.erro === 'Valor abaixo de R$ 20. Se ainda não sabe o preço, envie uma visita para orçamento.'
     && O.lerProposta({ suporta_orcamento: true, valor_proposto: '19,5' }, a).erro?.codigo === 'VALOR_MINIMO'
     && O.lerProposta({ suporta_orcamento: true, valor_proposto: 20 }, a).valor_proposto === 20
     && !O.lerProposta({ suporta_orcamento: true }, a).erro,
     'valor: mínimo de R$ 20 com a mensagem exata; 20 passa; sem valor (aceita o do pedido) passa', min)
  const v = (extra) => O.lerProposta({ suporta_orcamento: true, tipo_proposta: 'visita', ...extra }, a)
  ok(v({}).erro?.codigo === 'VISITA_QUANDO_OBRIGATORIA' && v({ visita_quando: 'amanhã' }).erro?.codigo === 'VISITA_QUANDO_OBRIGATORIA'
     && v({ visita_quando: '2026-11-26T08:00:00-03:00' }).erro?.codigo === 'VISITA_NO_PASSADO'
     && v({ visita_quando: '2026-11-28T14:00', visita_gratis: false }).erro?.codigo === 'VISITA_VALOR_OBRIGATORIO'
     && O.lerProposta({ suporta_orcamento: true, tipo_proposta: 'outra' }, a).erro?.codigo === 'TIPO_PROPOSTA_INVALIDO',
     'visita: visita_quando obrigatória e futura; não grátis exige visita_valor; tipo inválido → 400')
  const g = v({ visita_quando: '2026-11-28T14:00', visita_gratis: true, visita_valor: 80 }), pg = v({ visita_quando: '2026-11-28T17:00:00Z', visita_valor: '50,00' })
  ok(g.visita_gratis === true && g.visita_valor === null && g.visita_quando === '2026-11-28T17:00:00.000Z' && pg.visita_gratis === false && pg.visita_valor === 50,
     'visita: hora sem fuso é a de Brasília; grátis zera o valor; visita_valor sem visita_gratis = paga', { g, pg })
  ok(O.textoVisita(g, 'Levo as amostras') === '📋 Visita para orçamento (grátis) · sáb., 28/11 às 14:00. O valor do serviço vem depois da visita.\nLevo as amostras'
     && O.textoVisita(pg) === '📋 Visita para orçamento (R$ 50,00) · sáb., 28/11 às 14:00. O valor do serviço vem depois da visita.',
     'texto legível da visita (o que o app antigo mostra como mensagem)', O.textoVisita(g, 'Levo as amostras'))
  const o = O.lerOrcamento({ valor: '1500,50', prazo_dias: '5', data_inicio: '2026-12-02', observacao: ' Material incluso ' }, a)
  ok(o.valor === 1500.5 && o.prazo_dias === 5 && o.data_inicio === '2026-12-02' && o.observacao === 'Material incluso'
     && O.textoOrcamento(o) === '💰 Orçamento: R$ 1.500,50 · prazo de 5 dias · início em 02/12.\nMaterial incluso\n(Atualize o app ProTudo para aceitar ou recusar este orçamento.)', 'orçamento: leitura e texto legível (com o aviso para o app antigo)', O.textoOrcamento(o))
  const LISTA = 'arquiteto,decoracao_interiores,paisagismo,azulejista,telhados,impermeabilizacao,eletrica,eletronica,climatizacao,hidraulica,alvenaria,gesseiro,marcenaria,serralheria,vidraceiro,chaveiro,estofamento,montagem_moveis,seguranca_eletronica,conserto_celular,eletrodomesticos,desentupimento,piscineiro,faxina,dedetizacao,jardineiro,lavanderia,higienizacao,cortinas,pedreiro_servente,pintor,construtor,engenheiro,mudancas,placas_fachadas,decoracao_festas,outros'
  const pv = (cats) => O.permiteVisita('reparos', { categoria: cats[0], categorias: cats })
  ok(O.SLUGS_COM_VISITA.join() === LISTA && pv(['eletrica']) && pv(['faxina']) && pv(['arquiteto']) && pv(['mudancas']) && pv(['placas_fachadas']) && pv(['decoracao_festas']) && pv(['outros'])
     && !pv(['cabelo']) && !pv(['motorista']) && !pv(['aluguel_festas']) && !pv(['panfletagem']) && !pv(['aula_particular']) && pv(['cabelo', 'faxina']) && !pv([])
     && O.permiteVisita('reparos', { categoria: 'hidraulica' }) && O.permiteVisita('obras', { categoria: 'residencial' }) && O.permiteVisita('obras', {}),
     'quem aceita visita: toda obra; serviço com ALGUMA categoria de Obras de Construção Civil, Consertos da casa, Limpeza e jardim, ou mudancas/placas_fachadas/decoracao_festas/outros (37 slugs)', O.SLUGS_COM_VISITA.length)
  const e = (b) => O.lerOrcamento({ valor: 100, prazo_dias: 3, data_inicio: '2026-12-02', ...b }, a).erro?.codigo
  ok(e({ valor: 19 }) === 'VALOR_MINIMO' && e({ prazo_dias: 0 }) === 'PRAZO_INVALIDO' && e({ prazo_dias: 2.5 }) === 'PRAZO_INVALIDO' && e({ data_inicio: '02/12/2026' }) === 'DATA_INICIO_INVALIDA'
     && e({ data_inicio: '2026-02-31' }) === 'DATA_INICIO_INVALIDA' && e({ data_inicio: '2026-11-25' }) === 'DATA_INICIO_NO_PASSADO' && e({ data_inicio: '2026-11-26' }) === undefined && e({ observacao: 'x'.repeat(501) }) === 'OBSERVACAO_LONGA',
     'orçamento: valor mínimo, prazo inteiro de 1 a 365, data válida e não passada, observação até 500')
}

const LADOS = [
  { tabela: 'obras', prop: 'candidaturas', fk: 'obra_id', criar: '/obras/:id/candidatura', responder: '/obras/:id/candidatura/:candidaturaId/responder', pid: 'candidaturaId',
    orc: '/obras/:id/candidatura/:propostaId/orcamento', detalhe: '/obras/:id', lista: 'candidatos', minha: 'minha_candidatura', endereco: 'endereco_obra', guarda: 'exigirPodeObrasOuCandidato' },
  { tabela: 'reparos', prop: 'interesse_reparos', fk: 'reparo_id', criar: '/reparos/:id/interesse', responder: '/reparos/:id/interesse/:interesse_id/responder', pid: 'interesse_id',
    orc: '/reparos/:id/interesse/:propostaId/orcamento', detalhe: '/reparos/:id', lista: 'interessados', minha: 'meu_interesse', endereco: 'endereco_reparo', guarda: 'exigirPodeServicosOuInteressado' },
]

const main = async () => {
  puras()
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
  const colunas = (await q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('candidaturas', 'interesse_reparos')
                             AND column_name IN ('tipo_proposta','visita_gratis','visita_valor','visita_quando','visita_aceita_em','mensagem_original','orcamento_prazo_dias','orcamento_data_inicio','orcamento_observacao','orcamento_enviado_em','orcamento_lembrete_em','visita_cancelada_em','visita_cancelada_aviso_em')`)).rows[0].n
  ok(colunas === 26, 'migração (2x, idempotente): 13 colunas em candidaturas e em interesse_reparos', colunas)

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
      ponto_referencia: 'Portão azul', ...(tabela === 'reparos' ? { categoria: 'eletrica', categorias: ['eletrica'], valor_estimado: 300, endereco_reparo: 'Rua das Flores, 120' } : { categoria: 'residencial', valor: 3000, endereco_obra: 'Rua das Flores, 120' }), ...extra }
    const ks = Object.keys(c)
    await q(`INSERT INTO ${tabela} (${ks.join(', ')}, expira_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, NOW() + INTERVAL '10 days')`, ks.map(k => c[k]))
    return id
  }
  const pushDe = (u, re) => pushes.filter(p => p.to === u.token && re.test(p.title))

  for (const L of LADOS) {
    logOrig(`\n── ${L.tabela} ──`)
    const dono = await usr('Dona Carla', 'dono_obra')
    const pro1 = await usr('Ana Pro', 'prestador'), pro2 = await usr('Beto Pro', 'prestador'), pro3 = await usr('Caio Pro', 'prestador'), pro4 = await usr('Duda Pro', 'prestador'), pro5 = await usr('Enzo Pro', 'prestador')
    const DEM = await demanda(L.tabela, dono, 'Reforma do banheiro')
    const prop = async (id) => (await q(`SELECT * FROM ${L.prop} WHERE id = $1`, [id])).rows[0]
    const dem = async (id = DEM) => (await q(`SELECT * FROM ${L.tabela} WHERE id = $1`, [id])).rows[0]
    const enviar = (u, body, id = DEM) => chamar('post', L.criar, { usuario: u, params: { id }, body })
    const responder = (pid, body, u = dono, id = DEM) => chamar('post', L.responder, { usuario: u, params: { id, [L.pid]: pid }, body })
    const orcar = (u, pid, body, id = DEM) => chamar('post', L.orc, { usuario: u, params: { id, propostaId: pid }, body })
    const detalhe = async (u, id = DEM) => { const r = await chamar('get', L.detalhe, { usuario: u, params: { id } }); return r }
    // A guarda do profissional é a MESMA função (anônima) da rota …-responder do lado.
    const guardaResponder = rota('post', L.responder.replace('/responder', L.tabela === 'obras' ? '/pintor-responder' : '/prestador-responder')).stack[1].handle
    ok(nomes('post', L.orc).slice(0, 2).join() === 'autenticar,exigirNaoSuspenso' && rota('post', L.orc).stack[2].handle === guardaResponder && rota('post', L.orc).stack.length === 4,
       `POST ${L.orc}: autenticar + não suspenso + a guarda de profissional com proposta`, nomes('post', L.orc))

    // 1) ENVIAR
    let r = await enviar(pro4, { valor_proposto: 5, mensagem: 'Faço por 5', tipo_proposta: 'visita' })
    ok(r.status === 201 && r.body.tipo_proposta === 'valor' && Number(r.body.valor_proposto) === 5 && r.body.status !== 'visita_aceita', 'app antigo (sem suporta_orcamento): proposta de R$ 5 entra como sempre, tipo valor', { s: r.status, t: r.body?.tipo_proposta })
    const P4 = r.body.id
    r = await enviar(pro5, { suporta_orcamento: true, valor_proposto: 19 })
    ok(r.status === 400 && r.body.codigo === 'VALOR_MINIMO' && r.body.erro === 'Valor abaixo de R$ 20. Se ainda não sabe o preço, envie uma visita para orçamento.'
       && (await q(`SELECT count(*)::int AS n FROM ${L.prop} WHERE usuario_id = $1`, [pro5.id])).rows[0].n === 0, 'app novo, valor abaixo de R$ 20: 400 VALOR_MINIMO com a mensagem exata, nada gravado', r.body)
    r = await enviar(pro5, { suporta_orcamento: true, tipo_proposta: 'visita', visita_gratis: true })
    const semQuando = r
    r = await enviar(pro5, { suporta_orcamento: true, tipo_proposta: 'visita', visita_quando: new Date(Date.now() - 3600000).toISOString() })
    ok(semQuando.status === 400 && semQuando.body.codigo === 'VISITA_QUANDO_OBRIGATORIA' && r.status === 400 && r.body.codigo === 'VISITA_NO_PASSADO'
       && (await q(`SELECT count(*)::int AS n FROM ${L.prop} WHERE usuario_id = $1`, [pro5.id])).rows[0].n === 0, 'visita sem data ou no passado: 400, nada gravado', [semQuando.body, r.body])
    r = await enviar(pro5, { suporta_orcamento: true, tipo_proposta: 'valor', valor_proposto: 250, mensagem: 'Posso amanhã' })
    ok(r.status === 201 && r.body.tipo_proposta === 'valor' && Number(r.body.valor_proposto) === 250 && r.body.mensagem_profissional === 'Posso amanhã', 'app novo, proposta de valor: como sempre, com tipo_proposta e mensagem_profissional', r.status)
    const P5 = r.body.id

    pushes.length = 0
    r = await enviar(pro1, { suporta_orcamento: true, tipo_proposta: 'visita', visita_gratis: true, visita_quando: QUANDO, mensagem: 'Levo as amostras', valor_proposto: 999 })
    const P1 = r.body?.id
    let p = await prop(P1)
    ok(r.status === 201 && p.tipo_proposta === 'visita' && p.status === 'pendente' && p.valor_proposto === null && p.visita_gratis === true && p.visita_valor === null
       && new Date(p.visita_quando).toISOString() === QUANDO && p.mensagem_original === 'Levo as amostras' && /^📋 Visita para orçamento \(grátis\) · .+ às 14:00\. O valor do serviço vem depois da visita\.\nLevo as amostras$/.test(p.mensagem),
       'visita grátis: gravada pendente, sem valor_proposto, com o texto legível em mensagem e o original em mensagem_original', { s: r.status, m: p?.mensagem })
    ok(r.body.tipo_proposta === 'visita' && r.body.visita_gratis === true && r.body.visita_valor === null && new Date(r.body.visita_quando).toISOString() === QUANDO && r.body.status === 'pendente'
       && r.body.mensagem_profissional === 'Levo as amostras' && r.body.orcamento_valor === null && r.body.orcamento_enviado_em === null && r.body.valor_proposto === 0,
       'resposta do envio: tipo_proposta, visita_*, status, orcamento_* e mensagem_profissional', { t: r.body.tipo_proposta, v: r.body.valor_proposto })
    ok(pushDe(dono, /Proposta de visita para orçamento/).length === 1 && /quer visitar para fazer o orçamento de "Reforma do banheiro"/.test(pushDe(dono, /Proposta de visita/)[0].body), 'dono avisado da proposta de visita', pushes.map(x => x.title))
    r = await enviar(pro2, { suporta_orcamento: true, tipo_proposta: 'visita', visita_gratis: false, visita_valor: 50, visita_quando: QUANDO })
    const P2 = r.body?.id
    ok(r.status === 201 && r.body.visita_gratis === false && r.body.visita_valor === 50 && r.body.valor_proposto === 50 && r.body.mensagem_profissional === null && /\(R\$ 50,00\)/.test(r.body.mensagem), 'visita paga: visita_valor 50; sem mensagem do profissional', r.body?.mensagem)
    r = await enviar(pro3, { suporta_orcamento: true, tipo_proposta: 'visita', visita_quando: QUANDO })
    const P3 = r.body?.id
    ok(r.status === 201 && r.body.visita_gratis === true, 'visita sem visita_gratis nem valor: grátis', r.status)
    // Pedido "valor a combinar": a visita não precisa de valor_proposto; a proposta de valor continua precisando.
    const COMB = await demanda(L.tabela, dono, 'A combinar', L.tabela === 'reparos' ? { valor_estimado: null, valor_a_combinar: true } : { valor: null, valor_a_combinar: true })
    r = await enviar(pro1, { suporta_orcamento: true, tipo_proposta: 'visita', visita_quando: QUANDO }, COMB)
    const r2 = await enviar(pro2, { suporta_orcamento: true }, COMB)
    ok(r.status === 201 && r2.status === 400, 'pedido "valor a combinar": visita entra sem valor; proposta de valor sem valor continua 400', { visita: r.status, valor: r2.status })

    // 5/6) LEITURA — dono (é o que o app antigo mostra) e profissional antes do aceite.
    r = await detalhe(dono)
    let c1 = r.body[L.lista].find(x => x.id === P1), c2 = r.body[L.lista].find(x => x.id === P2), c4 = r.body[L.lista].find(x => x.id === P4)
    ok(r.status === 200 && c1.status === 'pendente' && c1.valor_proposto === 0 && c2.valor_proposto === 50 && /^📋 Visita para orçamento \(grátis\)/.test(c1.mensagem) && c1.tipo_proposta === 'visita'
       && c1.visita_gratis === true && new Date(c1.visita_quando).toISOString() === QUANDO && c1.mensagem_profissional === 'Levo as amostras' && c1.orcamento_valor === null
       && c4.tipo_proposta === 'valor' && c4.visita_quando === null && Number(c4.valor_proposto) === 5 && c4.mensagem_profissional === c4.mensagem,
       'detalhe do dono: visita com status pendente, valor_proposto = valor da visita (0 se grátis), mensagem legível e os campos novos; proposta comum intacta', { v1: c1.valor_proposto, v2: c2.valor_proposto, m: c1.mensagem })
    r = await detalhe(pro1)
    let dd = r.body.obra || r.body.reparo
    ok(r.status === 200 && dd.endereco_liberado === false && dd[L.endereco] === null && dd.ponto_referencia === null && r.body[L.minha].tipo_proposta === 'visita' && r.body[L.minha].status === 'pendente'
       && new Date(r.body[L.minha].visita_quando).toISOString() === QUANDO, 'profissional com visita ainda não aceita: sem endereço; minha proposta com os campos da visita', { lib: dd?.endereco_liberado })

    // 2) DONO ACEITA A VISITA
    r = await responder(P1, { action: 'contraproposta', valor: 100 })
    ok(r.status === 409 && r.body.codigo === 'PROPOSTA_DE_VISITA' && (await prop(P1)).status === 'pendente', 'contraproposta numa visita: 409 PROPOSTA_DE_VISITA', r.body)
    r = await responder(P4, { action: 'aceitar_visita' })
    ok(r.status === 409 && r.body.codigo === 'NAO_E_VISITA' && (await dem()).match_usuario_id === null, "'aceitar_visita' numa proposta de valor: 409, nada muda", r.body)
    pushes.length = 0
    r = await responder(P1, { action: 'aceitar_visita' }, pro2)
    ok(r.status === 403, 'só o dono aceita a visita', r.status)
    r = await responder(P1, { action: 'aceitar_visita' })
    p = await prop(P1); let d = await dem()
    ok(r.status === 200 && r.body.status === 'visita_aceita' && p.status === 'visita_aceita' && !!p.visita_aceita_em && d.status === 'aberta' && d.match_usuario_id === null
       && (await prop(P2)).status === 'pendente' && (await prop(P4)).status === 'pendente',
       'aceitar_visita: proposta vira visita_aceita; o pedido continua ABERTO, sem escolhido, e as outras propostas não mudam', { s: r.status, p: p.status, d: d.status })
    const pv = pushDe(pro1, /^📋 Visita aceita: Reforma do banheiro$/)
    ok(pv.length === 1 && /às 14:00\. O endereço completo já aparece no pedido\.$/.test(pv[0].body) && /\d{2}\/\d{2}/.test(pv[0].body) && pv[0].data.tipo === 'visita_aceita', 'push ao profissional: "📋 Visita aceita: {título}" com dia e hora', pv[0] && { t: pv[0].title, b: pv[0].body })
    r = await responder(P1, { action: 'aceitar_visita' })
    ok(r.status === 200 && pushDe(pro1, /Visita aceita/).length === 1, 'repetir o aceite: 200 sem novo aviso', r.body)
    // App antigo: o botão "aceitar" numa visita aceita a VISITA — não fecha negócio.
    r = await responder(P2, { action: 'aceitar' })
    d = await dem()
    ok(r.status === 200 && r.body.status === 'visita_aceita' && (await prop(P2)).status === 'visita_aceita' && d.match_usuario_id === null && d.status === 'aberta', "app antigo: 'aceitar' numa visita aceita a visita (duas visitas aceitas, nenhum match)", r.body)
    r = await responder(P2, { action: 'aceitar' })
    ok(r.status === 200 && (await dem()).match_usuario_id === null && (await prop(P2)).status === 'visita_aceita', "'aceitar' de novo numa visita sem orçamento: nada fecha", r.body)
    // Endereço: só para quem teve a visita aceita.
    r = await detalhe(pro1); dd = r.body.obra || r.body.reparo
    const r3 = await detalhe(pro3), d3 = r3.body.obra || r3.body.reparo, r5 = await detalhe(pro5), d5 = r5.body.obra || r5.body.reparo
    ok(dd.endereco_liberado === true && dd[L.endereco] === 'Rua das Flores, 120' && dd.ponto_referencia === 'Portão azul' && Number(dd.latitude) === -18.5789 && r.body[L.minha].status === 'visita_aceita'
       && d3.endereco_liberado === false && d3[L.endereco] === null && d5.endereco_liberado === false && d5[L.endereco] === null,
       'endereço completo: só para o profissional da visita aceita (visita pendente e proposta de valor continuam sem)', { p1: dd.endereco_liberado, p3: d3.endereco_liberado, p5: d5.endereco_liberado })
    r = await detalhe(dono)
    ok(r.body.interessados_ativos === 5, 'interessados_ativos conta as visitas aceitas', r.body.interessados_ativos)

    // 3) ORÇAMENTO
    const ORC = { valor: 1500, prazo_dias: 5, data_inicio: DIA(6), observacao: 'Material incluso, ligar 34 99881-7102' }
    r = await orcar(pro3, P3, ORC)
    ok(r.status === 409 && r.body.codigo === 'VISITA_NAO_ACEITA', 'orçamento antes de o dono aceitar a visita: 409 VISITA_NAO_ACEITA', r.body)
    r = await orcar(pro4, P4, ORC)
    ok(r.status === 409 && r.body.codigo === 'NAO_E_VISITA', 'orçamento numa proposta de valor: 409', r.body)
    r = await orcar(pro2, P1, ORC)
    ok(r.status === 404, 'orçamento na proposta de outro profissional: 404', r.status)
    r = await orcar(pro1, P1, { ...ORC, valor: 19 })
    ok(r.status === 400 && r.body.codigo === 'VALOR_MINIMO' && (await prop(P1)).status === 'visita_aceita', 'orçamento abaixo de R$ 20: 400, nada gravado', r.body)
    pushes.length = 0
    r = await orcar(pro1, P1, ORC)
    p = await prop(P1)
    ok(r.status === 200 && p.status === 'orcamento_enviado' && Number(p.valor_proposto) === 1500 && p.orcamento_prazo_dias === 5 && !!p.orcamento_enviado_em && /^Material incluso, ligar \[contato removido\]$/.test(p.orcamento_observacao)
       && /^💰 Orçamento: R\$ 1\.500,00 · prazo de 5 dias · início em \d{2}\/\d{2}\.\nMaterial incluso/.test(p.mensagem) && p.mensagem_original === 'Levo as amostras',
       'orçamento enviado: orcamento_enviado, valor_proposto = valor, prazo, data, observação (contato mascarado) e mensagem legível', { s: r.status, m: p.mensagem })
    ok(r.body.status === 'orcamento_enviado' && r.body.orcamento_valor === 1500 && r.body.orcamento_prazo_dias === 5 && r.body.orcamento_data_inicio === ORC.data_inicio && !!r.body.orcamento_enviado_em && r.body.tipo_proposta === 'visita',
       'resposta do orçamento: status e orcamento_valor / _prazo_dias / _data_inicio / _observacao / _enviado_em', { d: r.body.orcamento_data_inicio })
    const po = pushDe(dono, /^💰 Orçamento recebido: Reforma do banheiro$/)
    ok(po.length === 1 && /^R\$ 1\.500,00 · prazo de 5 dias · início em \d{2}\/\d{2}\./.test(po[0].body) && po[0].data.tipo === 'orcamento_recebido', 'push ao dono: "💰 Orçamento recebido: {título}"', po[0] && { t: po[0].title, b: po[0].body })
    r = await orcar(pro1, P1, ORC)
    ok(r.status === 409 && r.body.codigo === 'ORCAMENTO_JA_ENVIADO' && pushDe(dono, /Orçamento recebido/).length === 1, 'orçamento de novo: 409 ORCAMENTO_JA_ENVIADO, sem novo aviso', r.body)
    r = await detalhe(dono)
    c1 = r.body[L.lista].find(x => x.id === P1)
    ok(c1.status === 'orcamento_enviado' && Number(c1.valor_proposto) === 1500 && c1.orcamento_valor === 1500 && c1.orcamento_prazo_dias === 5 && c1.orcamento_data_inicio === ORC.data_inicio
       && /^Material incluso/.test(c1.orcamento_observacao) && /^💰 Orçamento: R\$ 1\.500,00/.test(c1.mensagem) && c1.mensagem_profissional === 'Levo as amostras' && r.body.interessados_ativos === 5,
       'detalhe do dono depois do orçamento: status, valor e campos do orçamento', { s: c1.status, v: c1.valor_proposto })
    r = await detalhe(pro1); dd = r.body.obra || r.body.reparo
    ok(dd.endereco_liberado === true && r.body[L.minha].status === 'orcamento_enviado' && r.body[L.minha].orcamento_valor === 1500, 'profissional com orçamento enviado: continua vendo o endereço', dd.endereco_liberado)

    // Recusar não mexe em mais nada.
    pushes.length = 0
    r = await responder(P2, { action: 'recusar' })
    d = await dem()
    ok(r.status === 200 && (await prop(P2)).status === 'recusado' && d.status === 'aberta' && d.match_usuario_id === null && (await prop(P1)).status === 'orcamento_enviado' && (await prop(P3)).status === 'pendente',
       'dono recusa uma visita aceita: só ela vira recusado; pedido e demais propostas intactos', r.body)
    // VISITA CANCELADA: aviso próprio, fora do silêncio noturno, uma vez; sem o aviso genérico de recusa.
    const DIA12 = new Date(`${HOJE_SP}T15:00:00Z`), NOITE02 = new Date(DIA12.getTime() + 14 * 3600000), MANHA08 = new Date(NOITE02.getTime() + 6 * 3600000)
    const canceladas = (u) => pushDe(u, /^📋 Visita cancelada: /)
    await O.avisarVisitasCanceladas({ avisarUsuario }, shim, DIA12); await assentar()   // se a recusa caiu no silêncio de verdade, sai aqui
    let pc = canceladas(pro2)
    ok(pc.length === 1 && pc[0].title === '📋 Visita cancelada: Reforma do banheiro' && pc[0].body === 'O cliente desistiu da visita. Obrigado pela disponibilidade!' && pc[0].data.tipo === 'visita_cancelada'
       && pushDe(pro2, /não aceita|não foi selecionad/i).length === 0 && !!(await prop(P2)).visita_cancelada_em && !!(await prop(P2)).visita_cancelada_aviso_em,
       'visita aceita recusada: "📋 Visita cancelada: {título}" com o texto pedido, no lugar do aviso genérico de recusa', pushes.filter(x => x.to === pro2.token).map(x => [x.title, x.body]))
    ok((await O.avisarVisitasCanceladas({ avisarUsuario }, shim, DIA12)) === 0 && canceladas(pro2).length === 1, 'visita cancelada: um aviso só')
    // Silêncio noturno: às 02:00 fica devido; às 08:00 sai.
    await q(`UPDATE ${L.prop} SET visita_cancelada_aviso_em = NULL WHERE id = $1`, [P2])
    let nc = await O.avisarVisitasCanceladas({ avisarUsuario }, shim, NOITE02); await assentar()
    ok(nc === 0 && canceladas(pro2).length === 1 && (await prop(P2)).visita_cancelada_aviso_em === null, 'visita cancelada no silêncio noturno (02:00): o aviso fica devido, não sai', nc)
    nc = await O.avisarVisitasCanceladas({ avisarUsuario }, shim, MANHA08); await assentar()
    ok(nc === 1 && canceladas(pro2).length === 2, 'visita cancelada: o aviso devido sai às 08:00', nc)
    // O lembrete do orçamento morre com a visita cancelada.
    await q(`UPDATE ${L.prop} SET visita_quando = $2::timestamptz WHERE id = $1`, [P2, new Date(DIA12.getTime() - 30 * 3600000).toISOString()])
    ok((await O.lembrarOrcamentos({ avisarUsuario }, shim, DIA12)) === 0 && (await prop(P2)).orcamento_lembrete_em === null && pushDe(pro2, /Falta o seu orçamento/).length === 0, 'visita cancelada: nenhum lembrete de orçamento')
    // Recusar uma visita ainda PENDENTE continua com o aviso de sempre.
    pushes.length = 0
    r = await responder(P3, { action: 'recusar' })
    await O.avisarVisitasCanceladas({ avisarUsuario }, shim, DIA12); await assentar()
    ok(r.status === 200 && (await prop(P3)).status === 'recusado' && (await prop(P3)).visita_cancelada_em === null && canceladas(pro3).length === 0 && pushDe(pro3, /não aceita/i).length === 1, 'visita ainda pendente recusada: o aviso genérico de sempre, sem "Visita cancelada"', pushes.map(x => x.title))
    await q(`UPDATE ${L.prop} SET status = 'pendente' WHERE id = $1`, [P3])   // volta à disputa para o resto do roteiro
    r = await detalhe(pro2); dd = r.body.obra || r.body.reparo
    ok(dd.endereco_liberado === false && dd[L.endereco] === null, 'visita recusada: o profissional deixa de ver o endereço', dd.endereco_liberado)
    // Orçamento recusado também não mexe em nada (em outro pedido).
    const DEM2 = await demanda(L.tabela, dono, 'Pintura do muro')
    r = await enviar(pro1, { suporta_orcamento: true, tipo_proposta: 'visita', visita_quando: QUANDO }, DEM2)
    const Q1 = r.body.id
    r = await enviar(pro2, { suporta_orcamento: true, valor_proposto: 400 }, DEM2)
    const Q2 = r.body.id
    await responder(Q1, { action: 'aceitar_visita' }, dono, DEM2)
    await orcar(pro1, Q1, ORC, DEM2)
    r = await responder(Q1, { action: 'recusar' }, dono, DEM2)
    d = await dem(DEM2)
    ok(r.status === 200 && (await prop(Q1)).status === 'recusado' && (await prop(Q2)).status === 'pendente' && d.status === 'aberta' && d.match_usuario_id === null, 'dono recusa o orçamento: só ele vira recusado; nada mais muda', r.body)
    ok((await prop(Q1)).visita_cancelada_em === null && pushDe(pro1, /^📋 Visita cancelada/).length === 0 && pushDe(pro1, /não aceita/i).length === 1, 'orçamento recusado: aviso genérico de sempre (não é visita cancelada)', pushes.filter(x => x.to === pro1.token).map(x => x.title))

    // Aceitar o orçamento = o aceite de sempre.
    pushes.length = 0
    r = await responder(P1, { action: 'aceitar' })
    d = await dem()
    ok(r.status === 200 && (await prop(P1)).status === 'aceito' && d.match_usuario_id === pro1.id && !!d.match_feito_em && (await prop(P3)).status === 'recusado' && (await prop(P4)).status === 'recusado' && (await prop(P5)).status === 'recusado'
       && (await prop(P3)).status_antes_match === 'pendente',
       'dono aceita o orçamento: match com o profissional e as demais propostas recusadas, como em qualquer aceite', { s: r.status, m: d.match_usuario_id === pro1.id })
    ok(pushDe(pro1, /Deu match/).length === 1 && pushDe(pro3, /Outro profissional foi selecionado/).length === 1, 'avisos do aceite de sempre: match ao escolhido, recusa aos demais', pushes.map(x => x.title))

    // 4) LEMBRETE
    const DEM3 = await demanda(L.tabela, dono, 'Troca do telhado')
    const visita = async (u) => { const x = await enviar(u, { suporta_orcamento: true, tipo_proposta: 'visita', visita_quando: QUANDO }, DEM3); await responder(x.body.id, { action: 'aceitar_visita' }, dono, DEM3); return x.body.id }
    const L1 = await visita(pro1), L2 = await visita(pro2), L3 = await visita(pro3), L4 = await visita(pro4)
    const MEIO_DIA = new Date(`${HOJE_SP}T15:00:00Z`)                       // 12:00 em São Paulo, hoje
    const MADRUGADA = new Date(MEIO_DIA.getTime() + 14 * 3600000)           // 02:00 em São Paulo, amanhã
    const quando = (id, t) => q(`UPDATE ${L.prop} SET visita_quando = $2::timestamptz WHERE id = $1`, [id, t.toISOString()])
    await quando(L1, new Date(MEIO_DIA.getTime() - 30 * 3600000))          // ontem
    await quando(L2, new Date(MEIO_DIA.getTime() - 2 * 3600000))           // hoje cedo
    await quando(L3, new Date(MEIO_DIA.getTime() - 30 * 3600000))          // ontem, mas com orçamento enviado
    await orcar(pro3, L3, ORC, DEM3)
    // L4: visita no futuro (QUANDO).
    pushes.length = 0
    let n = await O.lembrarOrcamentos({ avisarUsuario }, shim, MEIO_DIA); await assentar()
    const pl = pushDe(pro1, /Falta o seu orçamento/)
    ok(n === 1 && pl.length === 1 && pl[0].body === 'Mande o orçamento do pedido Troca do telhado' && pl[0].data.tipo === 'lembrete_orcamento' && !!(await prop(L1)).orcamento_lembrete_em
       && !pushes.some(x => [pro2.token, pro3.token, pro4.token].includes(x.to) && /Falta o seu orçamento/.test(x.title)),
       'lembrete: só a visita de ONTEM sem orçamento — "Mande o orçamento do pedido {título}"', { n, b: pl[0]?.body })
    n = await O.lembrarOrcamentos({ avisarUsuario }, shim, MEIO_DIA); await assentar()
    ok(n === 0 && pushDe(pro1, /Falta o seu orçamento/).length === 1, 'lembrete: uma vez só', n)
    n = await O.lembrarOrcamentos({ avisarUsuario }, shim, MADRUGADA); await assentar()
    ok(n === 0 && (await prop(L2)).orcamento_lembrete_em === null, 'lembrete: no silêncio noturno (02:00) não sai, mesmo já sendo o dia seguinte', n)
    n = await O.lembrarOrcamentos({ avisarUsuario }, shim, new Date(MADRUGADA.getTime() + 6 * 3600000)); await assentar()
    ok(n === 1 && pushDe(pro2, /Falta o seu orçamento/).length === 1, 'lembrete: sai às 08:00 do dia seguinte ao da visita', n)
    await q(`UPDATE ${L.tabela} SET status = 'encerrada' WHERE id = $1`, [DEM3])
    await quando(L4, new Date(MEIO_DIA.getTime() - 30 * 3600000))
    n = await O.lembrarOrcamentos({ avisarUsuario }, shim, MEIO_DIA)
    ok(n === 0, 'lembrete: pedido fechado não gera lembrete', n)

    // 7) VISITA SÓ NAS CATEGORIAS QUE A ACEITAM — permite_visita no detalhe e no feed.
    {
      const proV = await usr('Vera Pro', 'prestador', { especialidades: ['cabelo', 'faxina', 'eletrica'] })
      const visitaEm = (id, extra = {}) => enviar(proV, { suporta_orcamento: true, tipo_proposta: 'visita', visita_quando: QUANDO, ...extra }, id)
      if (L.tabela === 'reparos') {
        const SALAO = await demanda('reparos', dono, 'Corte e escova', { categoria: 'cabelo', categorias: ['cabelo'] })
        const MISTO = await demanda('reparos', dono, 'Cabelo e faxina', { categoria: 'cabelo', categorias: ['cabelo', 'faxina'] })
        const OUTROS = await demanda('reparos', dono, 'Um serviço diferente', { categoria: 'outros', categorias: ['outros'] })
        r = await visitaEm(SALAO)
        ok(r.status === 400 && r.body.codigo === 'VISITA_NAO_PERMITIDA' && r.body.erro === 'Este tipo de pedido aceita apenas valor fechado.'
           && (await q('SELECT count(*)::int AS n FROM interesse_reparos WHERE reparo_id = $1', [SALAO])).rows[0].n === 0, 'visita em categoria fora da lista (cabelo): 400 VISITA_NAO_PERMITIDA com a mensagem pedida, nada gravado', r.body)
        r = await enviar(proV, { tipo_proposta: 'visita', valor_proposto: 80 }, SALAO)
        ok(r.status === 201 && r.body.tipo_proposta === 'valor', 'app antigo no mesmo pedido: nada muda (proposta de valor entra)', r.status)
        r = await visitaEm(MISTO); const r2 = await visitaEm(OUTROS)
        ok(r.status === 201 && r.body.tipo_proposta === 'visita' && r2.status === 201, 'visita permitida quando ALGUMA categoria aceita (cabelo + faxina) e em "outros"', { misto: r.status, outros: r2.status })
        const d1 = await detalhe(proV, SALAO), d2 = await detalhe(dono, MISTO), d3 = await detalhe(proV, DEM)
        ok(d1.body.reparo.permite_visita === false && d2.body.reparo.permite_visita === true && d3.body.reparo.permite_visita === true, 'detalhe do reparo: permite_visita true/false', [d1.body.reparo?.permite_visita, d2.body.reparo?.permite_visita])
        r = await chamar('get', '/reparos', { usuario: proV, query: {} })
        const feed = r.body?.reparos || [], fs1 = feed.find(x => x.id === SALAO), fo = feed.find(x => x.id === OUTROS)
        ok(r.status === 200 && feed.length > 0 && feed.every(x => typeof x.permite_visita === 'boolean') && (!fs1 || fs1.permite_visita === false) && (!fo || fo.permite_visita === true) && (!!fs1 || !!fo),
           'feed de serviços: permite_visita em cada card', { n: feed.length, salao: fs1?.permite_visita, outros: fo?.permite_visita })
      } else {
        const OBRA2 = await demanda('obras', dono, 'Galpão novo', { categoria: 'galpao' })
        r = await visitaEm(OBRA2)
        const d1 = await detalhe(proV, OBRA2)
        ok(r.status === 201 && r.body.tipo_proposta === 'visita' && d1.body.obra.permite_visita === true, 'toda obra aceita visita; detalhe da obra com permite_visita true', { s: r.status, p: d1.body.obra?.permite_visita })
        r = await chamar('get', '/obras', { usuario: proV, query: {} })
        const feed = r.body?.obras || []
        ok(r.status === 200 && feed.length > 0 && feed.every(x => x.permite_visita === true), 'feed de obras: permite_visita true em cada card', { s: r.status, n: feed.length })
      }
    }

    // 6) LISTA DO PROFISSIONAL
    if (L.tabela === 'reparos') {
      r = await chamar('get', '/reparos/meus-interesses', { usuario: pro1 })
      const todos = [...(r.body.ativos || []), ...(r.body.historico || [])], m = todos.find(x => x.id === Q1), l1 = todos.find(x => x.id === L1)
      ok(r.status === 200 && m?.tipo_proposta === 'visita' && m.status === 'recusado' && m.orcamento_valor === 1500 && l1?.status === 'visita_aceita' && new Date(l1.visita_quando).getTime() > 0, 'GET /reparos/meus-interesses: tipo_proposta, visita_* e orcamento_*', m && { t: m.tipo_proposta, s: m.status })
    } else {
      r = await chamar('get', '/candidaturas/minhas', { usuario: pro1 })
      const m = (r.body.candidaturas || []).find(x => x.id === Q1), l1 = (r.body.candidaturas || []).find(x => x.id === L1)
      ok(r.status === 200 && m?.tipo_proposta === 'visita' && m.status === 'recusado' && m.orcamento_valor === 1500 && l1?.status === 'visita_aceita' && l1.visita_gratis === true, 'GET /candidaturas/minhas: tipo_proposta, visita_* e orcamento_*', m && { t: m.tipo_proposta, s: m.status })
    }
  }

  const inesperados = erros.filter(x => !/ENOTFOUND|geoBusca|sem banco|PAGBANK|webhook/i.test(x))
  ok(inesperados.length === 0, 'nenhum erro inesperado no log', inesperados.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
