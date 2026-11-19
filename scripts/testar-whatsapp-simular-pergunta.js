#!/usr/bin/env node
// ROBÔ DE WHATSAPP — SIMULAÇÃO de 'pergunta_sem_resposta' (18/11/2026):
// POST /admin/whatsapp/simular-pergunta põe UMA pergunta de mentira (sandbox = true, sem pedido nem
// pergunta de verdade) para o número da trava de teste. Adaptador FALSO, ESQUEMA DE PRODUÇÃO (PGlite).
// Cobre: recusas (sem trava, trava TODOS, tipo desligado); a linha criada; uma por vez na fila;
// janela 08–21h respeitada; fora do limite de 3 h (não é barrada e não conta); nunca agrupada com
// pergunta de verdade; volta casada como as outras (única pendente, citada) SEM chamar o app — a
// resposta fica só na linha (painel) e a pessoa recebe o "✅ Pronto!…" de sempre.
//   npm i -D @electric-sql/pglite && node scripts/testar-whatsapp-simular-pergunta.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

class FakeExpo {
  static isExpoPushToken() { return false }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { return chunk.map(() => ({ status: 'ok', id: 'x' })) }
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
const shim = { query: q, connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: q, release() {}, on() {} } }, on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async () => {}, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async () => {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? () => {} : errOrig }
const F = require(path.join(REPO, 'src/whatsapp/fila'))
const { migrarWhatsapp } = require(path.join(REPO, 'src/whatsapp/migracao'))
const { registrarRecebida } = require(path.join(REPO, 'src/whatsapp/entrada'))
const S = require(path.join(REPO, 'src/services/whatsappPerguntasService'))
const { enfileirar } = require(path.join(REPO, 'src/services/whatsappFilaService'))
const rotasAdmin = require(path.join(REPO, 'src/routes/adminWhatsapp'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const P = (n) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`

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

const TESTE = '+5534998891747', JID = '553498891747@s.whatsapp.net', TEL_WA = '+553498891747'
const ENV = { WHATSAPP_SOMENTE_PARA: TESTE }
// 08:30 de hoje em São Paulo.
const BASE = new Date(); BASE.setUTCHours(11, 30, 0, 0)
const em = (min) => new Date(BASE.getTime() + min * 60000)
const DONO = U(900), CARLOS = U(1), R1 = D(1)
const TEXTO_SIMULADO = 'Oi, Luiz! 👋 Aqui é o *ProTudo*.\nCarlos fez uma pergunta no seu pedido *Teste do robô*:\n💬 "Tem tinta aí ou eu levo?"\nCarlos só manda o preço depois da sua resposta.\n👉 É só *responder aqui mesmo*, que a gente entrega no app.'
const PRONTO = '✅ Pronto! Sua resposta foi entregue para Carlos no app.'

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT')
  await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT') // idempotente

  const usr = (id, nome, role, telefone) => q(
    `INSERT INTO usuarios (id, nome, email, role, telefone, cpf_cnpj, ativo, cidade, uf) VALUES ($1, $2, $3, $4, $5, $6, true, 'Patos de Minas', 'MG')`,
    [id, nome, `${id.slice(-4)}@x.invalid`, role, telefone, id.slice(-11)])
  await usr(DONO, 'Luiz Melo', 'dono_obra', '(34) 99889-1747')
  await usr(CARLOS, 'Carlos Eduardo', 'prestador', null)
  await q(`INSERT INTO reparos (id, titulo, descricao, categoria, cidade, uf, criado_por, status, status_aprovacao, expira_em)
           VALUES ($1, 'Entregar panfletos', 'x', 'panfletagem', 'Patos de Minas', 'MG', $2, 'aberta', 'aprovada', now() + INTERVAL '30 days')`, [R1, DONO])
  const pergunta = (n, texto) => q(
    `INSERT INTO perguntas_demanda (id, tipo, demanda_id, autor_id, pergunta, criado_em) VALUES ($1, 'reparo', $2, $3, $4, now() - INTERVAL '40 minutes')`, [P(n), R1, CARLOS, texto])
  const fila = async (where = 'true') => (await q(`SELECT * FROM whatsapp_mensagens WHERE ${where} ORDER BY id`)).rows
  const config = (chave, valor) => q(`WITH u AS (UPDATE configuracoes SET valor = $2 WHERE chave = $1 RETURNING 1) INSERT INTO configuracoes (chave, valor) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM u)`, [chave, valor])
  const trava = (v) => q(`UPDATE whatsapp_estado SET trava = $1 WHERE id = 1`, [v])
  const f = criarFalso()
  let relogio = em(0)
  const passo = (agora) => { relogio = agora; return F.processarProxima({ db: shim, adaptador: f, agora, env: ENV }) }
  const ultimo = () => f.enviados[f.enviados.length - 1]
  // `responder` espião: a simulação NUNCA pode chamar a função do app.
  const chamadasApp = []
  const responder = async (a) => { chamadasApp.push(a); await q(`UPDATE perguntas_demanda SET resposta = $2, respondido_em = now() WHERE id = $1`, [a.perguntaId, a.resposta]); return { status: 200, body: { resposta: a.resposta } } }
  let nIn = 0
  const recebe = async (extra) => {
    const id = `IN${++nIn}`
    await registrarRecebida(shim, { id, jid: JID, telefone: TEL_WA, texto: '', quando: new Date(), ...extra })
    silenciar(true)
    try { await S.processarRecebidas({ responder }, shim) } finally { silenciar(false) }
    const rec = (await q(`SELECT * FROM whatsapp_recebidas WHERE wa_message_id = $1`, [id])).rows[0]
    await q(`UPDATE whatsapp_mensagens SET criado_em = $1::timestamptz WHERE tipo = 'resposta' AND status = 'fila' AND chave_dedupe = $2`, [relogio.toISOString(), `resposta:${rec.id}`])
    return rec
  }
  const pilha = (m, c) => rotasAdmin.stack.find(x => x.route && x.route.path === c && x.route.methods[m]).route.stack
  const chamar = (m, c, query = {}) => new Promise(resolve => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
    const p = pilha(m, c); p[p.length - 1].handle({ query, body: {}, params: {}, usuario: { id: U(99), role: 'admin' } }, res)
  })
  const simular = () => chamar('post', '/admin/whatsapp/simular-pergunta')

  // ═══════════ RECUSAS ═══════════
  const rota = pilha('post', '/admin/whatsapp/simular-pergunta')
  ok(rota.length === 3, 'rota POST /admin/whatsapp/simular-pergunta existe com autenticar + exigirSuperAdmin antes do handler', rota.length)
  let r = await simular()
  ok(r.status === 409 && /WHATSAPP_SOMENTE_PARA/.test(r.body.erro) && (await fila()).length === 0, 'worker sem trava → 409, nada na fila', r)
  await trava('TODOS')
  await config('whatsapp_tipo_pergunta_sem_resposta', 'true')
  r = await simular()
  ok(r.status === 409 && /TODOS/.test(r.body.erro) && (await fila()).length === 0, 'trava em TODOS → 409 (a simulação só sai para o número da trava)', r)
  await trava(TESTE)
  await config('whatsapp_tipo_pergunta_sem_resposta', 'false')
  r = await simular()
  ok(r.status === 409 && /desligado/.test(r.body.erro) && (await fila()).length === 0, 'tipo "Pergunta sem resposta" desligado → 409, nada na fila', r)
  await config('whatsapp_tipo_pergunta_sem_resposta', 'true')

  // ═══════════ A LINHA ═══════════
  r = await simular()
  let linhas = await fila()
  let s1 = linhas[0]
  ok(r.status === 200 && r.body.sandbox === true && r.body.ja_na_fila === false && r.body.telefone === TESTE && linhas.length === 1,
    'simular → 200, UMA linha na fila para o número da trava', r.body)
  ok(s1.sandbox === true && s1.tipo === 'pergunta_sem_resposta' && s1.status === 'fila' && s1.telefone === TESTE && s1.usuario_id === null && s1.ref_id === null
     && s1.ref_tabela === null && s1.chave_dedupe === null && s1.dados.sandbox === true && s1.dados.primeiro_nome === 'Luiz' && s1.dados.nome_prof === 'Carlos'
     && s1.dados.titulo === 'Teste do robô' && s1.dados.pergunta === 'Tem tinta aí ou eu levo?' && !('pergunta_id' in s1.dados) && !('demanda_id' in s1.dados),
    'linha: sandbox = true, sem ids de pedido/pergunta/usuário, dados de mentira', { sandbox: s1.sandbox, ref_id: s1.ref_id, dados: s1.dados })
  r = await simular()
  ok(r.status === 200 && r.body.ja_na_fila === true && String(r.body.id) === String(s1.id) && (await fila()).length === 1, 'simular de novo com uma na fila → não empilha', r.body)

  // ═══════════ JANELA 08–21h ═══════════
  let p = await passo(em(-60 * 9)) // 23:30 da véspera em São Paulo
  ok(!p.enviou && p.motivo === 'fora_do_horario' && f.enviados.length === 0 && (await fila(`status = 'fila'`)).length === 1, 'fora da janela 08–21h a simulação NÃO sai', p)

  // ═══════════ LIMITE DE 3 h: NÃO BARRA A SIMULAÇÃO ═══════════
  // Uma pergunta de verdade saiu para o mesmo número há 10 min.
  await pergunta(1, 'Qual o bairro?')
  await S.enfileirarPerguntasSemResposta(shim)
  await q(`UPDATE whatsapp_mensagens SET criado_em = now() - INTERVAL '1 hour' WHERE ref_id = $1`, [P(1)])
  p = await passo(em(0))
  ok(p.enviou && /Qual o bairro\?/.test(ultimo().texto) && !/Teste do robô/.test(ultimo().texto), 'pergunta de verdade sai sozinha (a simulação não entra junto)', ultimo().texto.slice(0, 80))
  // E outra de verdade entra na fila: essa fica presa pelo limite de 3 h.
  await pergunta(2, 'Tem escada?')
  await S.enfileirarPerguntasSemResposta(shim)
  p = await passo(em(10))
  ok(p.enviou && ultimo().jid === JID && ultimo().texto === TEXTO_SIMULADO, 'simulação sai 10 min depois de outra mensagem (fora do limite de 3 h), sozinha e com o texto de sempre', ultimo().texto)
  s1 = (await fila(`id = ${s1.id}`))[0]
  const real2 = (await fila(`ref_id = '${P(2)}'`))[0]
  ok(s1.status === 'enviada' && s1.wa_message_id === ultimo().id && s1.item_numero === null && s1.agrupada_em === null && real2.status === 'fila',
    'simulação enviada, não numerada/agrupada; a pergunta de verdade segue na fila (limite de 3 h vale para ela)', { s: s1.status, real2: real2.status })
  p = await passo(em(11))
  ok(!p.enviou && (await fila(`ref_id = '${P(2)}'`))[0].status === 'fila', 'pergunta de verdade continua barrada pelo limite de 3 h', p.motivo)
  p = await passo(em(182))
  ok(p.enviou && /Tem escada\?/.test(ultimo().texto), 'a simulação NÃO conta para o limite: 3 h depois da 1ª de verdade a 2ª sai', ultimo().texto.slice(0, 80))
  await q(`UPDATE perguntas_demanda SET resposta = 'ok', respondido_em = now() WHERE id = ANY($1::uuid[])`, [[P(1), P(2)]])

  // ═══════════ VOLTA: ÚNICA PENDENTE ═══════════
  let rec = await recebe({ texto: '  Pode trazer, por favor  ' })
  s1 = (await fila(`id = ${s1.id}`))[0]
  ok(rec.resultado === 'entregue (simulação)' && String(rec.mensagem_ref) === String(s1.id) && s1.status === 'respondida' && s1.resposta === 'Pode trazer, por favor' && s1.respondida_em,
    'resposta à simulação: linha vira respondida com o texto (painel)', { resultado: rec.resultado, resposta: s1.resposta })
  ok(chamadasApp.length === 0, 'NADA foi para o app (a função de responder pergunta não foi chamada)', chamadasApp.length)
  p = await passo(em(183))
  ok(p.enviou && ultimo().jid === JID && ultimo().texto === PRONTO, 'a pessoa recebe o "✅ Pronto!…" de sempre', ultimo().texto)
  rec = await recebe({ texto: 'outra coisa' })
  ok(rec.resultado === 'sem_pergunta_pendente' && chamadasApp.length === 0, 'simulação já respondida não fica pendente: mensagem seguinte não casa com nada', rec.resultado)

  // ═══════════ VOLTA: CITADA, COM PERGUNTA DE VERDADE TAMBÉM PENDENTE ═══════════
  r = await simular()
  ok(r.status === 200 && r.body.ja_na_fila === false, 'nova simulação depois da primeira respondida', r.body)
  p = await passo(em(184))
  const s2 = (await fila(`sandbox AND status = 'enviada'`))[0]
  ok(p.enviou && s2 && ultimo().texto === TEXTO_SIMULADO, '2ª simulação enviada (1 min depois da resposta automática)')
  await pergunta(3, 'Qual a cor?')
  await S.enfileirarPerguntasSemResposta(shim)
  p = await passo(em(184 + 181))
  const real3 = (await fila(`ref_id = '${P(3)}'`))[0]
  ok(p.enviou && real3.status === 'enviada', 'pergunta de verdade nº 3 enviada')
  rec = await recebe({ texto: 'eu levo' })
  ok(rec.resultado === 'nao_entendida' && chamadasApp.length === 0, 'duas pendentes (simulação + de verdade) sem citar → o robô pede para responder em cima da mensagem', rec.resultado)
  rec = await recebe({ texto: 'eu levo a tinta', citada: s2.wa_message_id })
  const s2b = (await fila(`id = ${s2.id}`))[0]
  ok(rec.resultado === 'entregue (simulação)' && s2b.status === 'respondida' && s2b.resposta === 'eu levo a tinta' && chamadasApp.length === 0
     && (await q(`SELECT respondido_em FROM perguntas_demanda WHERE id = $1`, [P(3)])).rows[0].respondido_em === null,
    'citando a simulação: casa com ela, nada vai para o app e a pergunta de verdade continua sem resposta', rec.resultado)
  rec = await recebe({ texto: 'branca', citada: real3.wa_message_id })
  ok(rec.resultado === 'entregue' && chamadasApp.length === 1 && chamadasApp[0].perguntaId === P(3) && chamadasApp[0].resposta === 'branca',
    'pergunta de VERDADE segue indo para o app pelo caminho de sempre', chamadasApp[0])

  // ═══════════ enfileirar SEM sandbox continua igual ═══════════
  const e = await enfileirar({ tipo: 'teste', telefone: TESTE, texto: 'oi' }, shim)
  ok(e.ok && (await fila(`id = ${e.id}`))[0].sandbox === false, 'enfileirar sem a flag grava sandbox = false')

  // ═══════════ PAINEL ═══════════
  const lista = (await chamar('get', '/admin/whatsapp/mensagens', { status: 'respondida', limit: '100' })).body
  const ms = lista.mensagens.find(x => String(x.id) === String(s2.id))
  const mr = lista.mensagens.find(x => x.ref_id === P(3))
  ok(ms && ms.sandbox === true && ms.resposta === 'eu levo a tinta' && ms.resumo === 'Pergunta sem resposta · “Teste do robô” (simulação)' && ms.codigo === null
     && mr && mr.sandbox === false && !/simulação/.test(mr.resumo),
    'painel: /mensagens mostra a simulação com a resposta e marcada como simulação', ms && { sandbox: ms.sandbox, resposta: ms.resposta, resumo: ms.resumo })

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
