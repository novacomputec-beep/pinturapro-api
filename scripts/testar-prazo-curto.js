#!/usr/bin/env node
// PRAZO CURTO (utils/prazoIncoerente, services/prazoCurtoService) — dono, 26/11/2026. Nos DOIS lados:
//  1) publicar com prazo de 4 h ou menos e texto que fala de outro dia → 409 PRAZO_INCOERENTE (só
//     com suporta_prazo_check; confirmar_prazo publica; app antigo não muda);
//  2) robô 'prazo_acabando': a 30 min do fim, com interessados e sem escolhido → um push e um
//     WhatsApp ao dono, uma vez por pedido, atrás do liga/desliga (padrão desligado);
//  3) no vencimento com interessados e sem escolhido: +24 h automáticas UMA vez, avisos ao dono e
//     aos interessados; o 2º vencimento segue as regras de sempre.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; rotas reais; Expo/Brevo falsos; adaptador falso.
//   npm i -D @electric-sql/pglite && node scripts/testar-prazo-curto.js
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
const PI = require(path.join(REPO, 'src/utils/prazoIncoerente'))
const PC = require(path.join(REPO, 'src/services/prazoCurtoService'))
const EP = require(path.join(REPO, 'src/services/escolhaPendenteService'))
const C = require(path.join(REPO, 'src/whatsapp/config'))
const T = require(path.join(REPO, 'src/whatsapp/textos'))
const F = require(path.join(REPO, 'src/whatsapp/fila'))
const P = require(path.join(REPO, 'src/utils/penalidadesAuto'))
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
const quieto = async (fn) => { silenciar(true); try { return await fn() } finally { silenciar(false) } }
const criarFalso = () => {
  const f = {
    enviados: [], n: 0,
    conectar: async () => {}, desconectar: async () => {},
    estado: () => ({ conexao: 'conectado', qr: null, numero: '+5534900000000' }),
    existeNoWhatsapp: async (tel) => { const d = tel.slice(1); return { existe: true, jid: `${d.length === 13 ? d.slice(0, 4) + d.slice(5) : d}@s.whatsapp.net` } },
    enviarTexto: async (jid, texto) => { const id = `WA${++f.n}`; f.enviados.push({ jid, texto, id }); return { id } },
    aoReceber() {}, aoAtualizarStatus() {}, aoMudarEstado() {},
  }
  return f
}
const ENV = { WHATSAPP_SOMENTE_PARA: 'TODOS' }
// Relógio do robô: um instante FUTURO dentro da janela 08–21h (amanhã, 11:30 em São Paulo); a noite
// é 23:00 em São Paulo do mesmo dia. Os pedidos da parte 2 vencem em relação a esses instantes.
const HOJE_SP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
const DIA = new Date(new Date(`${HOJE_SP}T14:30:00Z`).getTime() + 24 * 3600000)
const NOITE = new Date(DIA.getTime() + 11.5 * 3600000)

const puras = () => {
  const SIM = [['Preciso para amanhã cedo', 'amanhã'], ['Só depois de amanhã', 'depois de amanhã'], ['Festa no mês que vem', 'mês que vem'], ['para o próximo mês', 'próximo mês'],
    ['semana que vem eu viajo', 'semana que vem'], ['pintura na próxima semana', 'próxima semana'], ['só no fim de semana', 'fim de semana'], ['pode ser sábado', 'sábado'], ['DOMINGO de manhã', 'DOMINGO'],
    ['na quinta à tarde', 'na quinta'], ['sexta-feira', 'sexta-feira'], ['terça feira que vem', 'terça feira'], ['até segunda', 'até segunda'], ['dia 15 de manhã', 'dia 15'], ['entregar até 12/12', '12/12'],
    ['em dezembro', 'dezembro'], ['dia 3 de março', 'dia 3'], ['20 de janeiro', '20 de janeiro'], ['antes do Natal', 'antes do Natal'], ['para o ano novo', 'para o ano novo'], ['depois do carnaval', 'depois do carnaval'],
    ['daqui a 3 dias', 'daqui a 3 dias'], ['em 2 semanas', 'em 2 semanas'], ['ano que vem', 'ano que vem']]
  const errados = SIM.filter(([t, e]) => PI.encontrarTempoFuturo(t) !== e).map(([t]) => [t, PI.encontrarTempoFuturo(t)])
  ok(errados.length === 0, `texto que fala de outro dia: ${SIM.length} exemplos, com o trecho como foi escrito`, errados)
  const NAO = ['Trocar torneira agora', 'Segunda demão na sala', 'A quarta parede está mofada', 'Preciso hoje à noite', 'Urgente, vazamento', 'Tubo de 3/4 de polegada', 'Chácara Quinta do Sol',
    'Instalar 2 tomadas', 'Pintar a sexta porta do corredor', 'Preciso de um pintor', 'Dia de faxina', 'Maionese caseira', 'Em 2 demãos']
  const falsos = NAO.filter(t => PI.encontrarTempoFuturo(t)).map(t => [t, PI.encontrarTempoFuturo(t)])
  ok(falsos.length === 0, `não fala de outro dia: ${NAO.length} textos comuns`, falsos)
  ok(PI.encontrarTempoFuturo('Pintura urgente', 'pode vir amanhã ou sábado') === 'amanhã' && PI.encontrarTempoFuturo('Festa sábado', 'preciso amanhã') === 'sábado', 'título + descrição: o primeiro trecho do texto')
  const av = (body, extra) => PI.avaliarPrazoIncoerente({ suporta_prazo_check: true, ...body }, { horas: 2, titulo: 'Pintar o portão', descricao: 'pode ser amanhã', ...extra })
  const r = av({})
  ok(r?.codigo === 'PRAZO_INCOERENTE' && r.prazo_incoerente === true && r.trecho === 'amanhã' && r.prazo_rotulo === '2 horas' && r.prazo_horas === 2 && /2 horas/.test(r.erro) && /"amanhã"/.test(r.erro), 'prazo de 2 h + "amanhã": corpo do 409 com trecho e rótulo do prazo', r)
  ok(av({}, { horas: 1 })?.prazo_rotulo === '1 hora' && av({}, { horas: 4 })?.prazo_rotulo === '4 horas' && av({}, { horas: '4' })?.prazo_horas === 4 && av({}, { horas: 8 }) === null && av({}, { horas: undefined }) === null
     && av({}, { modo: 'hoje' }) === null && av({ confirmar_prazo: true }) === null && av({ confirmar_prazo: 'true' }) === null && av({ suporta_prazo_check: false }) === null
     && PI.avaliarPrazoIncoerente({}, { horas: 2, titulo: 'x', descricao: 'amanhã' }) === null && av({}, { descricao: 'vazamento na pia' }) === null,
     'vale só para 4 h ou menos, fora da faixa "Hoje", com suporta_prazo_check e sem confirmar_prazo; texto comum passa')
}

const main = async () => {
  puras()
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`
    CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_push_entregas_uq ON push_entregas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_configuracoes_uq ON configuracoes (chave);
    CREATE UNIQUE INDEX t_reparos_crid_uq ON reparos (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE UNIQUE INDEX t_obras_crid_uq ON obras (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true'), ('email_resumo_diario', 'false');
  `)
  await P.migrarPenalidadesAuto(shim)
  await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT')
  await PC.migrarPrazoCurto(shim); await PC.migrarPrazoCurto(shim)
  const colunas = (await q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('reparos', 'obras') AND column_name IN ('prazo_acabando_em', 'auto_extensao_em', 'auto_extensao_aviso_em')`)).rows[0].n
  ok(colunas === 6, 'migração (2x, idempotente): prazo_acabando_em, auto_extensao_em e auto_extensao_aviso_em em reparos e obras', colunas)

  let nUsr = 0
  const usr = async (nome, role, extra = {}) => {
    const n = ++nUsr
    const c = { id: U(n), nome, email: `u${n}@x.invalid`, role, cpf_cnpj: String(n).padStart(11, '0'), ativo: true, cidade: 'Patos de Minas', uf: 'MG', telefone: `349${String(90000000 + n)}`,
      push_token: `ExponentPushToken[u${n}]`, ...(role === 'prestador' ? { tipo_prestador: 'reparador', especialidades: ['eletrica'] } : { tipo_dono: 'reparo' }), ...extra }
    const ks = Object.keys(c)
    await q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => c[k]))
    if (role === 'prestador') await q(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [c.id])
    return { id: c.id, role, nome, token: c.push_token, telefone: c.telefone }
  }
  const pushDe = (u, re) => pushes.filter(p => p.to === u.token && re.test(p.title))
  let nDem = 0
  // expira = Date (instante) ou string SQL relativa a NOW().
  const demanda = async (tabela, dono, titulo, expira, extra = {}) => {
    const id = D(++nDem)
    const c = { id, titulo, descricao: 'Detalhes', criado_por: dono.id, status: 'aberta', status_aprovacao: 'aprovada', cidade: 'Patos de Minas', uf: 'MG', codigo_publico: `C${String(nDem).padStart(4, '0')}`,
      ...(tabela === 'reparos' ? { categoria: 'eletrica', categorias: ['eletrica'], valor_estimado: 300, prazo_atendimento_horas: 2 } : { categoria: 'residencial', valor: 3000, horas_para_expirar: 2 }), ...extra }
    const ks = Object.keys(c)
    const sqlExpira = expira instanceof Date ? `'${expira.toISOString()}'::timestamptz` : expira
    await q(`INSERT INTO ${tabela} (${ks.join(', ')}, criado_em, expira_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, NOW() - INTERVAL '2 hours', ${sqlExpira})`, ks.map(k => c[k]))
    return id
  }
  const PROP = { reparos: ['interesse_reparos', 'reparo_id'], obras: ['candidaturas', 'obra_id'] }
  const proposta = (tabela, demandaId, pro, status = 'pendente') => q(`INSERT INTO ${PROP[tabela][0]} (${PROP[tabela][1]}, usuario_id, mensagem, valor_proposto, status) VALUES ($1, $2, 'oi', 100, $3)`, [demandaId, pro.id, status])
  const dem = async (tabela, id) => (await q(`SELECT * FROM ${tabela} WHERE id = $1`, [id])).rows[0]

  // ═══ 1. PUBLICAR ═══════════════════════════════════════════════════════════════════════════
  const corpoReparo = (extra = {}) => ({ titulo: 'Instalar tomada na cozinha', descricao: 'Pode ser amanhã de manhã', categoria: 'eletrica', cidade: 'Patos de Minas', uf: 'MG', valor_estimado: 120, prazo_atendimento_horas: 2, ...extra })
  const corpoObra = (extra = {}) => ({ titulo: 'Pintura da casa no sábado', descricao: 'Dois quartos e sala', categoria: 'residencial', cidade: 'Patos de Minas', uf: 'MG', valor: 5000, horas_para_expirar: 4, ...extra })
  const contar = async (tabela, donoX) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE criado_por = $1`, [donoX.id])).rows[0].n
  const d1 = await usr('Dona Um', 'dono_obra'), d2 = await usr('Dona Dois', 'dono_obra'), d3 = await usr('Dona Três', 'dono_obra')
  let r = await chamar('post', '/reparos/dono', { usuario: d1, body: corpoReparo({ suporta_prazo_check: true }) })
  ok(r.status === 409 && r.body.codigo === 'PRAZO_INCOERENTE' && r.body.trecho === 'amanhã' && r.body.prazo_rotulo === '2 horas' && r.body.prazo_horas === 2 && r.body.prazo_incoerente === true && (await contar('reparos', d1)) === 0,
     'POST /reparos/dono, prazo de 2 h e "amanhã" no texto (app com suporte): 409 PRAZO_INCOERENTE com trecho e rótulo, NADA gravado', r.body)
  r = await chamar('post', '/reparos/dono', { usuario: d1, body: corpoReparo({ suporta_prazo_check: true, confirmar_prazo: true }) })
  ok(r.status === 201 && Number(r.body.prazo_atendimento_horas) === 2, 'com confirmar_prazo: true: publica com o prazo escolhido', r.status)
  r = await chamar('post', '/reparos/dono', { usuario: d2, body: corpoReparo() })
  ok(r.status === 201, 'app antigo (sem suporta_prazo_check): publica como sempre', r.status)
  r = await chamar('post', '/reparos/dono', { usuario: d3, body: corpoReparo({ suporta_prazo_check: true, prazo_atendimento_horas: 24 }) })
  const rB = await chamar('post', '/reparos/dono', { usuario: d3, body: corpoReparo({ suporta_prazo_check: true, descricao: 'Urgente, está em curto' }) })
  ok(r.status === 201 && rB.status === 201, 'prazo de 24 h com "amanhã", e prazo de 2 h com texto de urgência: publicam', [r.status, rB.status])
  r = await chamar('post', '/obras/dono', { usuario: d1, body: corpoObra({ suporta_prazo_check: true }) })
  ok(r.status === 409 && r.body.codigo === 'PRAZO_INCOERENTE' && r.body.trecho === 'sábado' && r.body.prazo_rotulo === '4 horas' && (await contar('obras', d1)) === 0, 'POST /obras/dono, prazo de 4 h e "sábado" no título: 409, nada gravado', r.body)
  r = await chamar('post', '/obras/dono', { usuario: d1, body: corpoObra({ suporta_prazo_check: true, confirmar_prazo: true }) })
  const rC = await chamar('post', '/obras/dono', { usuario: d2, body: corpoObra() })
  ok(r.status === 201 && rC.status === 201, 'obra: confirmar_prazo publica; app antigo publica', [r.status, rC.status])

  // ═══ 2. ROBÔ 'prazo_acabando' ══════════════════════════════════════════════════════════════
  const def = C.TIPOS.prazo_acabando
  ok(def.implementado === true && def.padrao === false && def.sozinho === true && C.TIPO_PRAZO === 'prazo_acabando' && C.PRAZO_ACABANDO_MIN === 30, 'tipo prazo_acabando: implementado, DESLIGADO por padrão, uma mensagem por linha', def)
  const TEXTO = '⏰ Seu pedido *"Trocar o chuveiro"* termina em 30 minutos e tem *2 interessados*. Escolha um profissional agora ou estenda o prazo no app: protudo.app.br/p/C0009'
  ok(T.textoPrazoAcabando({ titulo: 'Trocar o chuveiro', interessados: 2, codigo: 'C0009' }) === TEXTO && /\*1 interessado\*/.test(T.textoPrazoAcabando({ titulo: 'x', interessados: 1, codigo: 'y' })), 'texto do WhatsApp, exato (singular e plural)')
  const dono = await usr('Dona Carla', 'dono_obra'), donoSaiu = await usr('Dono Saiu', 'dono_obra', { whatsapp_avisos: false }), donoNoite = await usr('Dona Noite', 'dono_obra')
  const p1 = await usr('Ana Pro', 'prestador'), p2 = await usr('Beto Pro', 'prestador'), p3 = await usr('Caio Pro', 'prestador')
  const em = (min, base = DIA) => new Date(base.getTime() + min * 60000)
  const A = await demanda('reparos', dono, 'Trocar o chuveiro', em(25))
  await proposta('reparos', A, p1, 'pendente'); await proposta('reparos', A, p2, 'visita_aceita'); await proposta('reparos', A, p3, 'recusado')
  const B = await demanda('obras', dono, 'Pintar o muro', em(29))
  await proposta('obras', B, p1, 'contraproposta_dono')
  const LONGE = await demanda('reparos', dono, 'Falta 45 min', em(45)); await proposta('reparos', LONGE, p1)
  const SEM = await demanda('reparos', dono, 'Sem interessados', em(20))
  const SOREC = await demanda('reparos', dono, 'Só recusado', em(20)); await proposta('reparos', SOREC, p1, 'recusado')
  const CASADO = await demanda('obras', dono, 'Com escolhido', em(20), { match_usuario_id: p1.id }); await proposta('obras', CASADO, p1, 'aceito'); await proposta('obras', CASADO, p2, 'pendente')
  const SAIU = await demanda('reparos', donoSaiu, 'Dono respondeu SAIR', em(15)); await proposta('reparos', SAIU, p1)
  const NOT = await demanda('reparos', donoNoite, 'De noite', em(25, NOITE)); await proposta('reparos', NOT, p1)
  await q(`UPDATE whatsapp_estado SET trava = 'TODOS' WHERE id = 1`)
  const config = (chave, valor) => q(`WITH u AS (UPDATE configuracoes SET valor = $2 WHERE chave = $1 RETURNING 1) INSERT INTO configuracoes (chave, valor) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM u)`, [chave, valor])
  const fila = async (where = 'true') => (await q(`SELECT * FROM whatsapp_mensagens WHERE tipo = 'prazo_acabando' AND ${where} ORDER BY id`)).rows
  const job = (agora = DIA) => quieto(() => PC.avisarPrazoAcabando(shim, { agora }))
  pushes.length = 0
  let e = await job(); await assentar()
  ok(e.motivo === 'tipo_desligado' && e.pedidos === 0 && pushes.length === 0 && (await fila()).length === 0 && (await dem('reparos', A)).prazo_acabando_em === null, 'tipo desligado (padrão): nem push, nem WhatsApp, nada marcado', e)
  await config(C.chaveTipo('prazo_acabando'), 'true')
  e = await job(); await assentar()
  let linhas = await fila()
  ok(e.pedidos === 3 && e.whatsapp === 2 && linhas.map(l => l.ref_id).sort().join() === [A, B].sort().join(), 'tipo ligado: A, B e o do dono que saiu são avisados; fora quem falta 45 min, sem interessado, só recusado e com escolhido', e)
  const lA = linhas.find(l => l.ref_id === A)
  ok(lA.texto === TEXTO.replace('C0009', (await dem('reparos', A)).codigo_publico) && lA.usuario_id === dono.id && lA.telefone === `+55${dono.telefone}` && lA.chave_dedupe === PC.chaveDoAviso('reparos', A) && lA.dados.interessados === 2,
     'WhatsApp de A: texto exato com 2 interessados (o recusado não conta) e o link do pedido', lA.texto)
  const pa = pushDe(dono, /^⏰ Seu pedido termina em 30 minutos$/)
  ok(pa.length === 2 && pa.some(x => x.body === '"Trocar o chuveiro" tem 2 interessados. Escolha um profissional agora ou estenda o prazo.' && x.data.tipo === 'reparo_expirando_prazo_acabando' && x.data.reparo_id === A)
     && pa.some(x => x.body === '"Pintar o muro" tem 1 interessado. Escolha um profissional agora ou estenda o prazo.' && x.data.tipo === 'obra_expirando_prazo_acabando'),
     'push ao dono: um por pedido, com o número de interessados', pa.map(x => x.body))
  ok(pushDe(donoSaiu, /termina em 30 minutos/).length === 1 && (await fila(`ref_id = '${SAIU}'`)).length === 0, 'dono que respondeu SAIR: recebe o push, não o WhatsApp')
  e = await job(em(3)); await assentar()
  ok(e.pedidos === 0 && (await fila()).length === 2 && pushDe(dono, /termina em 30 minutos/).length === 2, 'job de novo: uma vez por pedido', e)
  // De noite (23:00): fora do horário do WhatsApp e no silêncio do push — o pedido só fica marcado.
  pushes.length = 0
  e = await job(NOITE); await assentar()
  ok(e.pedidos === 1 && e.pushes === 0 && e.whatsapp === 0 && pushDe(donoNoite, /./).length === 0 && (await fila(`ref_id = '${NOT}'`)).length === 0 && !!(await dem('reparos', NOT)).prazo_acabando_em, '23:00: sem push (silêncio noturno) e sem WhatsApp (fora de 08–21h)', e)
  // Pausa do robô: o push sai, o WhatsApp não.
  const PAUS = await demanda('reparos', donoNoite, 'Com o robô pausado', em(20)); await proposta('reparos', PAUS, p1)
  await config(C.CHAVE_PAUSADO, 'true')
  e = await job(); await assentar()
  ok(e.pedidos === 1 && e.whatsapp === 0 && pushDe(donoNoite, /termina em 30 minutos/).length === 1, 'robô pausado: o push sai, o WhatsApp não', e)
  await config(C.CHAVE_PAUSADO, 'false')
  // Worker: manda A; B ganhou escolhido antes do envio → sai da fila sem enviar.
  await q(`UPDATE obras SET match_usuario_id = $2 WHERE id = $1`, [B, p1.id])
  const f = criarFalso()
  const enviados = []
  for (let i = 0; i < 4; i++) { const p = await quieto(() => F.processarProxima({ db: shim, adaptador: f, agora: em(2), env: ENV })); if (p.enviou) enviados.push(p) }
  linhas = await fila()
  ok(enviados.length === 1 && f.enviados.length === 1 && f.enviados[0].texto === lA.texto && !/SAIR/.test(f.enviados[0].texto) && linhas.length === 1 && linhas[0].status === 'enviada',
     'worker: envia o texto exato (sem rodapé); o aviso do pedido que ganhou escolhido sai da fila sem enviar', { enviados: enviados.length, linhas: linhas.map(l => l.status) })

  // ═══ 3. EXTENSÃO AUTOMÁTICA DE 24 H ════════════════════════════════════════════════════════
  for (const lado of PC.LADOS) {
    const t = lado.tabela
    logOrig(`\n── extensão automática: ${t} ──`)
    const dn = await usr(`Dono ${t}`, 'dono_obra'), a = await usr('Ana', 'prestador'), b = await usr('Bia', 'prestador'), c = await usr('Caio', 'prestador')
    const X = await demanda(t, dn, 'Reforma do banheiro', `NOW() - INTERVAL '5 minutes'`, { marco_1_em: new Date().toISOString(), escolha_aviso_2h_em: new Date().toISOString() })
    await proposta(t, X, a, 'pendente'); await proposta(t, X, b, 'contraproposta_dono'); await proposta(t, X, c, 'recusado')
    const VELHO = await demanda(t, dn, 'Venceu há 2 horas', `NOW() - INTERVAL '2 hours'`); await proposta(t, VELHO, a)
    const SEMI = await demanda(t, dn, 'Venceu sem interessados', `NOW() - INTERVAL '5 minutes'`)
    const JA = await demanda(t, dn, 'Já ganhou 24 h uma vez', `NOW() - INTERVAL '5 minutes'`, { auto_extensao_em: new Date(Date.now() - 86400000).toISOString(), auto_extensao_aviso_em: new Date(Date.now() - 86400000).toISOString() }); await proposta(t, JA, a)
    const AVISADO = await demanda(t, dn, 'Já recebeu "expirou"', `NOW() - INTERVAL '5 minutes'`, { escolha_expirou_em: new Date().toISOString() }); await proposta(t, AVISADO, a)
    const VIVO = await demanda(t, dn, 'Ainda no prazo', `NOW() + INTERVAL '10 minutes'`); await proposta(t, VIVO, a)
    const CAS = await demanda(t, dn, 'Venceu com escolhido', `NOW() - INTERVAL '5 minutes'`, { match_usuario_id: a.id }); await proposta(t, CAS, b)
    const HOJE = await demanda(t, dn, 'Faixa hoje', `NOW() - INTERVAL '5 minutes'`, { prazo_modo: 'hoje', prazo_timezone: 'America/Sao_Paulo' }); await proposta(t, HOJE, a)
    const antes = Date.now()
    const n = await quieto(() => PC.estenderAutomaticamente(lado, shim))
    let x = await dem(t, X)
    const horas = (new Date(x.expira_em).getTime() - antes) / 3600000
    ok(n === 2 && horas > 23.9 && horas < 24.1 && !!x.auto_extensao_em && x.auto_extensao_aviso_em === null && x.marco_1_em === null && x.escolha_aviso_2h_em === null && Number(x.ultima_extensao_horas) === 24 && !!x.ultima_extensao_em && x.status === 'aberta',
       'venceu com interessados e sem escolhido: +24 h a partir de agora, marcos e avisos zerados, ultima_extensao_* gravados', { n, horas: Math.round(horas * 100) / 100 })
    const passou = async (id) => new Date((await dem(t, id)).expira_em).getTime() < Date.now()
    ok((await passou(VELHO)) && (await passou(SEMI)) && (await passou(JA)) && (await passou(AVISADO)) && (await passou(CAS)) && (await dem(t, SEMI)).auto_extensao_em === null,
       'não estende: vencido há 2 h, sem interessados, já estendido uma vez (2º vencimento), já avisado do vencimento, com escolhido')
    const h = await dem(t, HOJE)
    const fimSP = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(h.expira_em))
    const diaSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(h.expira_em))
    const amanhaSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + 24 * 3600000))
    ok(fimSP === '23:59' && diaSP === amanhaSP && !!h.auto_extensao_em, 'faixa "Hoje": vai para o fim do dia seguinte (São Paulo), como o estender', { fimSP, diaSP })
    ok((await quieto(() => PC.estenderAutomaticamente(lado, shim))) === 0, 'extensão automática: uma vez só')
    // Avisos: no silêncio ficam devidos; de dia saem — dono (push) e cada interessado ativo.
    pushes.length = 0
    let na = await quieto(() => PC.avisarExtensoesAutomaticas(lado, shim, new Date(new Date(`${HOJE_SP}T05:00:00Z`).getTime()))); await assentar()
    ok(na === 0 && pushes.length === 0 && (await dem(t, X)).auto_extensao_aviso_em === null, 'aviso da extensão no silêncio noturno (02:00): fica devido', na)
    na = await quieto(() => PC.avisarExtensoesAutomaticas(lado, shim, new Date())); await assentar()
    const horaSP = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).format(new Date()))
    if (!(horaSP >= 7 && horaSP < 22)) { na += await quieto(() => PC.avisarExtensoesAutomaticas(lado, shim, new Date(new Date(`${HOJE_SP}T15:00:00Z`).getTime() + 0))); await assentar() }
    const pd = pushDe(dn, /^⏳ Mais 24 horas para escolher$/)
    ok(na >= 1 && pd.some(p => p.body === 'Demos mais 24 horas ao seu pedido "Reforma do banheiro" porque ele tem 2 interessados. Escolha um profissional!' && p.data.tipo === `${lado.prefixoDono}_auto_estendido`)
       && pd.some(p => p.body === 'Demos mais 24 horas ao seu pedido "Faixa hoje" porque ele tem 1 interessado. Escolha um profissional!'),
       'push ao dono: "Demos mais 24 horas ao seu pedido … porque ele tem N interessado(s). Escolha um profissional!"', pd.map(p => p.body))
    const pa2 = pushDe(a, /^⏳ Mais 24 horas$/), pb = pushDe(b, /^⏳ Mais 24 horas$/), pc = pushDe(c, /Mais 24 horas/)
    ok(pa2.some(p => p.body === 'O pedido "Reforma do banheiro" ganhou mais 24 horas.' && p.data.tipo === lado.tipoPro) && pb.length === 1 && pc.length === 0, 'push aos interessados ativos: "O pedido … ganhou mais 24 horas." (o recusado não recebe)', { a: pa2.length, b: pb.length, c: pc.length })
    ok((await quieto(() => PC.avisarExtensoesAutomaticas(lado, shim, new Date(`${HOJE_SP}T15:00:00Z`)))) === 0, 'aviso da extensão: uma vez por pedido')
    // No job de verdade: a extensão roda ANTES do aviso de vencimento — o dono não recebe "expirou".
    const dn2 = await usr(`Dono2 ${t}`, 'dono_obra')
    const NOVO = await demanda(t, dn2, 'Pedido no job', `NOW() - INTERVAL '3 minutes'`); await proposta(t, NOVO, a)
    const SEGUNDO = await demanda(t, dn2, 'Segundo vencimento', `NOW() - INTERVAL '3 minutes'`, { auto_extensao_em: new Date(Date.now() - 86400000).toISOString(), auto_extensao_aviso_em: new Date().toISOString() }); await proposta(t, SEGUNDO, a)
    pushes.length = 0
    await quieto(() => EP.verificarEscolhaPendente()); await assentar()
    x = await dem(t, NOVO)
    ok(new Date(x.expira_em).getTime() > Date.now() + 23 * 3600000 && !!x.auto_extensao_em && x.escolha_expirou_em === null && !pushes.some(p => p.to === dn2.token && /expirou/i.test(p.title) && /Pedido no job/.test(p.body)),
       'verificarEscolhaPendente: o pedido ganha as 24 h e o dono NÃO recebe "Seu pedido expirou"', pushes.filter(p => p.to === dn2.token).map(p => p.title))
    ok(await passou(SEGUNDO), '2º vencimento (já estendido uma vez): continua vencido — regras de sempre')
  }

  const inesperados = erros.filter(x => !/ENOTFOUND|geoBusca|sem banco|PAGBANK|webhook/i.test(x))
  ok(inesperados.length === 0, 'nenhum erro inesperado no log', inesperados.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
