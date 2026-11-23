#!/usr/bin/env node
// ROBÔ DE WHATSAPP — ETAPA 2: 'pergunta_sem_resposta' (17/11/2026). Adaptador FALSO (nada sai de
// verdade), ESQUEMA DE PRODUÇÃO (PGlite) e a função REAL do app para responder pergunta
// (routes/index.responderPergunta). Cobre:
//   gatilho (30 min sem resposta, pedido aberto, tipo ligado, trava do worker, dedupe);
//   texto de UMA pergunta (com o nome do profissional) e de VÁRIAS (numeradas, até 5, título por
//   item quando são de pedidos diferentes); rodapé do SAIR só na primeira mensagem da pessoa;
//   no máximo uma mensagem por pessoa a cada 3 h; respondida no app antes do envio → sai da fila;
//   volta: resposta citando a mensagem, por número, única pendente, ambígua, áudio, recusada —
//   entregue pela mesma função do app (o profissional recebe o push de sempre) e gravada no painel.
//   npm i -D @electric-sql/pglite && node scripts/testar-whatsapp-perguntas.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

const pushes = []
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
silenciar(true)
const rotasApp = require(path.join(REPO, 'src/routes/index.js'))
silenciar(false)
const C = require(path.join(REPO, 'src/whatsapp/config'))
const T = require(path.join(REPO, 'src/whatsapp/textos'))
const F = require(path.join(REPO, 'src/whatsapp/fila'))
const { migrarWhatsapp } = require(path.join(REPO, 'src/whatsapp/migracao'))
const { registrarRecebida } = require(path.join(REPO, 'src/whatsapp/entrada'))
const { midiaDaMensagem, citadaDaMensagem } = require(path.join(REPO, 'src/whatsapp/adaptadorBaileys'))
const S = require(path.join(REPO, 'src/services/whatsappPerguntasService'))
const rotasAdmin = require(path.join(REPO, 'src/routes/adminWhatsapp'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const P = (n) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 250))

const criarFalso = () => {
  const f = {
    enviados: [], consultas: [], n: 0,
    conectar: async () => {}, desconectar: async () => {},
    estado: () => ({ conexao: 'conectado', qr: null, numero: '+5534900000000' }),
    existeNoWhatsapp: async (tel) => { f.consultas.push(tel); const d = tel.slice(1); return { existe: true, jid: `${d.length === 13 ? d.slice(0, 4) + d.slice(5) : d}@s.whatsapp.net` } },
    enviarTexto: async (jid, texto) => { const id = `WA${++f.n}`; f.enviados.push({ jid, texto, id }); return { id } },
    aoReceber() {}, aoAtualizarStatus() {}, aoMudarEstado() {},
  }
  return f
}

const TESTE = '+5534998891747', JID = '553498891747@s.whatsapp.net', TEL_WA = '+553498891747'
const ENV = { WHATSAPP_SOMENTE_PARA: TESTE }
// 08:30 de hoje em São Paulo; cada "rodada" anda 3 h 01 min (o limite por pessoa é 3 h).
const BASE = new Date(); BASE.setUTCHours(11, 30, 0, 0)
const em = (min) => new Date(BASE.getTime() + min * 60000)
const RODADA = 181

const DONO = U(900), MARIA = U(901), CARLOS = U(1), LARISSA = U(2), GETULIO = U(3), ANA = U(4), BETO = U(5), CAIO = U(6)
const R1 = D(1), R2 = D(2), R_FECHADO = D(3), R_MARIA = D(4), O1 = D(11)

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT')

  const usr = (id, nome, role, telefone, extra = {}) => {
    const cols = { id, nome, email: `${id.slice(-4)}@x.invalid`, role, telefone, cpf_cnpj: id.slice(-11), ativo: true, cidade: 'Patos de Minas', uf: 'MG', ...extra }
    const ks = Object.keys(cols)
    return q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => cols[k]))
  }
  await usr(DONO, 'Luiz Melo', 'dono_obra', '(34) 99889-1747')
  await usr(MARIA, 'Maria Souza', 'dono_obra', '11987654321')
  for (const [id, nome] of [[CARLOS, 'Carlos Eduardo Macário'], [LARISSA, 'Larissa Andrade'], [GETULIO, 'Getúlio Freitas'], [ANA, 'Ana Lima'], [BETO, 'Beto Reis'], [CAIO, 'Caio Nunes']]) {
    await usr(id, nome, 'prestador', null, { tipo_prestador: 'reparador', push_token: `ExponentPushToken[${id.slice(-3)}]` })
  }
  const pedido = (t, id, titulo, dono, extra = {}) => {
    const cols = { id, titulo, descricao: 'x', categoria: t === 'reparos' ? 'panfletagem' : 'residencial', cidade: 'Patos de Minas', uf: 'MG', criado_por: dono, status: 'aberta', status_aprovacao: 'aprovada', ...extra }
    const ks = Object.keys(cols)
    return q(`INSERT INTO ${t} (${ks.join(', ')}, expira_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, now() + INTERVAL '30 days')`, ks.map(k => cols[k]))
  }
  await pedido('reparos', R1, 'Entregar panfletos', DONO)
  await pedido('reparos', R2, 'Pintar o portão', DONO)
  await pedido('reparos', R_FECHADO, 'Já tem escolhido', DONO, { match_usuario_id: CARLOS })
  await pedido('reparos', R_MARIA, 'Pedido da Maria', MARIA)
  await pedido('obras', O1, 'Pintar a sala', DONO)
  // min = há quantos minutos a pergunta foi feita.
  const pergunta = (n, tipo, demanda, autor, texto, min) => q(
    `INSERT INTO perguntas_demanda (id, tipo, demanda_id, autor_id, pergunta, criado_em) VALUES ($1, $2, $3, $4, $5, now() - ($6::int * INTERVAL '1 minute'))`,
    [P(n), tipo, demanda, autor, texto, min])
  const fila = async (where = 'true') => (await q(`SELECT * FROM whatsapp_mensagens WHERE ${where} ORDER BY id`)).rows
  const config = (chave, valor) => q(`WITH u AS (UPDATE configuracoes SET valor = $2 WHERE chave = $1 RETURNING 1) INSERT INTO configuracoes (chave, valor) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM u)`, [chave, valor])
  const f = criarFalso()
  let relogio = em(0)
  const passo = (agora, env = ENV) => { relogio = agora; return F.processarProxima({ db: shim, adaptador: f, agora, env }) }
  const drenar = async (agora) => { for (let i = 0; i < 6; i++) { const r = await passo(agora); if (!r.enviou) return r } }
  let nIn = 0
  // A pessoa escreve no WhatsApp → o worker guarda → o job da API processa.
  const recebe = async (extra) => {
    const id = `IN${++nIn}`
    await registrarRecebida(shim, { id, jid: JID, telefone: TEL_WA, texto: '', quando: new Date(), ...extra })
    silenciar(true)
    try {
      await S.processarRecebidas({ responder: rotasApp.responderPergunta }, shim)
      await assentar()
    } finally { silenciar(false) }
    // O teste anda com relógio simulado: a resposta automática nasce "agora" nesse relógio.
    await q(`UPDATE whatsapp_mensagens SET criado_em = $1::timestamptz WHERE tipo = 'resposta' AND status = 'fila' AND chave_dedupe = $2`,
      [relogio.toISOString(), `resposta:${(await q(`SELECT id FROM whatsapp_recebidas WHERE wa_message_id = $1`, [id])).rows[0].id}`])
    return (await q(`SELECT * FROM whatsapp_recebidas WHERE wa_message_id = $1`, [id])).rows[0]
  }
  const pq = async (n) => (await q(`SELECT resposta, respondido_em FROM perguntas_demanda WHERE id = $1`, [P(n)])).rows[0]
  const ultimo = () => f.enviados[f.enviados.length - 1]

  // ═══════════ GATILHO ═══════════
  await pergunta(1, 'reparo', R1, CARLOS, 'Qual o bairro?', 31)
  await pergunta(2, 'reparo', R1, LARISSA, 'Ainda não deu 30 min', 10)
  await pergunta(3, 'reparo', R_FECHADO, LARISSA, 'Pedido já tem escolhido', 60)
  await pergunta(4, 'reparo', R_MARIA, LARISSA, 'Dona fora da trava', 60)
  await pergunta(5, 'reparo', R2, GETULIO, 'Pergunta de anteontem', 60 * 30)
  let e = await S.enfileirarPerguntasSemResposta(shim)
  ok(e.enfileiradas === 0 && e.motivo === 'tipo_desligado' && (await fila()).length === 0, 'tipo desligado (padrão): o gatilho não põe nada na fila', e)
  await config('whatsapp_tipo_pergunta_sem_resposta', 'true')
  e = await S.enfileirarPerguntasSemResposta(shim)
  ok(e.enfileiradas === 0 && e.motivo === 'sem_trava', 'tipo ligado mas worker sem trava (WHATSAPP_SOMENTE_PARA): nada entra na fila', e)
  await q(`UPDATE whatsapp_estado SET trava = $1, conexao = 'conectado', heartbeat_em = NOW()`, [TESTE])
  e = await S.enfileirarPerguntasSemResposta(shim)
  let l = await fila()
  ok(e.enfileiradas === 1 && l.length === 1 && l[0].tipo === 'pergunta_sem_resposta' && l[0].usuario_id === DONO && l[0].telefone === TESTE && l[0].ref_tabela === 'perguntas_demanda'
     && l[0].ref_id === P(1) && l[0].chave_dedupe === `pergunta:${P(1)}` && l[0].dados.nome_prof === 'Carlos' && l[0].dados.primeiro_nome === 'Luiz',
     'só a pergunta de 31 min em pedido aberto entra (não: <30 min, pedido com escolhido, dona fora da trava, mais de 24 h)', l.map(x => x.ref_id))
  e = await S.enfileirarPerguntasSemResposta(shim)
  ok(e.enfileiradas === 0 && (await fila()).length === 1, 'rodar de novo não duplica (a mesma pergunta nunca entra duas vezes)')

  // ═══════════ UMA PERGUNTA ═══════════
  let r = await passo(em(0))
  const UMA = 'Oi, Luiz! 👋 Aqui é o *ProTudo*.\nCarlos fez uma pergunta no seu pedido *Entregar panfletos*:\n💬 "Qual o bairro?"\nCarlos só manda o preço depois da sua resposta.\n👉 É só *responder aqui mesmo*, que a gente entrega no app.'
  l = await fila()
  ok(r.enviou && f.enviados.length === 1 && f.enviados[0].jid === JID && f.enviados[0].texto === UMA + '\n_Para não receber mais avisos, responda SAIR._',
     'UMA pergunta: texto exato, com o nome do profissional (não "Larissa") e o rodapé do SAIR na primeira mensagem', f.enviados[0]?.texto)
  ok(l[0].status === 'enviada' && l[0].item_numero === null && l[0].texto === f.enviados[0].texto && l[0].wa_message_id === 'WA1', 'a linha guarda o texto que saiu; sem número em mensagem de uma pergunta só')

  // ═══════════ VOLTA: única pendente ═══════════
  pushes.length = 0
  let rec = await recebe({ texto: 'É no Centro, perto da praça' })
  l = await fila()
  const p1 = await pq(1)
  ok(rec.resultado === 'entregue' && String(rec.mensagem_ref) === String(l[0].id) && p1.resposta === 'É no Centro, perto da praça' && p1.respondido_em
     && l[0].status === 'respondida' && l[0].resposta === 'É no Centro, perto da praça' && l[0].respondida_em,
     'resposta sem citar nem numerar, com UMA pergunta pendente: entregue nela e gravada na fila (painel)', [rec.resultado, p1.resposta, l[0].status])
  ok(pushes.some(x => x.data?.tipo === 'pergunta_respondida' && x.data.pergunta_id === P(1) && x.to === `ExponentPushToken[${CARLOS.slice(-3)}]`),
     'o profissional recebe o push de sempre ("O cliente respondeu sua pergunta") — mesma função do app', pushes.map(x => x.data?.tipo))
  ok(l[1]?.tipo === 'resposta' && l[1].status === 'fila' && l[1].wa_jid === JID && l[1].texto === '✅ Pronto! Sua resposta foi entregue para Carlos no app.', 'confirmação "✅ Pronto!…" entra na fila como resposta automática', l[1]?.texto)
  const antes = f.consultas.length
  r = await passo(em(1))
  ok(r.enviou && ultimo().jid === JID && ultimo().texto === '✅ Pronto! Sua resposta foi entregue para Carlos no app.' && f.consultas.length === antes,
     'a confirmação sai na vez seguinte (sem esperar 3 h, sem consulta ao WhatsApp, número sem o nono dígito liberado pela trava)')
  rec = await recebe({ texto: 'obrigado!' })
  ok(rec.resultado === 'sem_pergunta_pendente' && (await fila(`tipo = 'resposta'`)).length === 1, 'mensagem sem pergunta pendente: guardada, sem resposta automática')

  // ═══════════ VÁRIAS + LIMITE DE 3 H ═══════════
  await pergunta(6, 'reparo', R1, LARISSA, 'Precisa de carro?', 45)
  await pergunta(7, 'reparo', R1, GETULIO, 'Pode ser sábado?', 40)
  await S.enfileirarPerguntasSemResposta(shim)
  r = await passo(em(60))
  ok(!r.enviou && r.motivo === 'fila_vazia' && f.enviados.length === 2, 'menos de 3 h depois da última mensagem à pessoa: nada sai', r.motivo)
  r = await passo(em(RODADA))
  const VARIAS = 'Oi, Luiz! 👋 Aqui é o *ProTudo*.\nTem 2 perguntas esperando você no pedido *Entregar panfletos*:\n1️⃣ Larissa: "Precisa de carro?"\n2️⃣ Getúlio: "Pode ser sábado?"\n👉 Responda começando pelo número. Exemplo: *1 sim, já comprei*'
  l = await fila(`ref_id IN ('${P(6)}', '${P(7)}')`)
  ok(r.enviou && f.enviados.length === 3 && ultimo().texto === VARIAS && l[0].item_numero === 1 && l[1].item_numero === 2 && l.every(x => x.wa_message_id === ultimo().id),
     'passadas 3 h: as 2 perguntas saem numa mensagem só, numerada, texto exato e SEM o rodapé do SAIR', ultimo().texto)
  const idVarias = ultimo().id

  // ambígua
  rec = await recebe({ texto: 'pode sim' })
  ok(rec.resultado === 'nao_entendida' && !(await pq(6)).resposta && !(await pq(7)).resposta, 'duas pendentes e resposta sem número: nada é entregue')
  await passo(em(RODADA + 1))
  ok(ultimo().texto === 'Não entendi para quem é a resposta 😅 Comece pelo número da pergunta (1 ou 2).', 'o robô pede o número (texto exato)', ultimo().texto)
  // áudio
  rec = await recebe({ texto: '', midia: 'audio' })
  await passo(em(RODADA + 2))
  ok(rec.resultado === 'midia (audio)' && ultimo().texto === 'Por enquanto só consigo entregar resposta escrita ✍️ Pode digitar, por favor?' && !(await pq(6)).resposta, 'áudio: o robô pede texto (texto exato) e nada é entregue', ultimo().texto)
  rec = await recebe({ texto: '', midia: 'outro' })
  ok(rec.resultado === 'ignorada (outro)', 'mensagem que não é texto nem mídia conhecida: ignorada, sem resposta')
  // por número
  pushes.length = 0
  rec = await recebe({ texto: '2 pode sim, de manhã' })
  await passo(em(RODADA + 3))
  l = await fila(`ref_id = '${P(7)}'`)
  ok(rec.resultado === 'entregue' && (await pq(7)).resposta === 'pode sim, de manhã' && !(await pq(6)).resposta && l[0].status === 'respondida' && l[0].resposta === 'pode sim, de manhã'
     && ultimo().texto === '✅ Pronto! Sua resposta foi entregue para Getúlio no app.' && pushes.some(x => x.data?.pergunta_id === P(7)),
     'resposta começando por "2": vai para a pergunta 2, sem o número no texto; confirmação com o nome certo', [(await pq(7)).resposta, ultimo().texto])
  // citando a mensagem numerada + número
  rec = await recebe({ texto: '1) não precisa', citada: idVarias })
  await passo(em(RODADA + 4))
  ok(rec.resultado === 'entregue' && (await pq(6)).resposta === 'não precisa' && ultimo().texto === '✅ Pronto! Sua resposta foi entregue para Larissa no app.',
     'citando a mensagem numerada e começando por "1)": entregue na pergunta 1', (await pq(6)).resposta)

  // ═══════════ CITANDO (duas mensagens de uma pergunta cada, pendentes ao mesmo tempo) ═══════════
  await pergunta(8, 'obra', O1, ANA, 'Tem escada no local?', 50)
  await S.enfileirarPerguntasSemResposta(shim)
  r = await passo(em(2 * RODADA))
  const idObra = ultimo().id
  ok(r.enviou && ultimo().texto.startsWith('Oi, Luiz! 👋 Aqui é o *ProTudo*.\nAna fez uma pergunta no seu pedido *Pintar a sala*:') && !ultimo().texto.includes('SAIR'), 'pergunta em OBRA também gera aviso (sem rodapé: não é a primeira mensagem)')
  await pergunta(9, 'reparo', R2, BETO, 'Qual a cor?', 50)
  await S.enfileirarPerguntasSemResposta(shim)
  r = await passo(em(3 * RODADA))
  const idPortao = ultimo().id
  rec = await recebe({ texto: 'branco' })
  await passo(em(3 * RODADA + 1))
  ok(r.enviou && rec.resultado === 'nao_entendida' && ultimo().texto === T.TEXTO_NAO_ENTENDI_SEM_NUMERO && !(await pq(8)).resposta && !(await pq(9)).resposta,
     'duas mensagens de uma pergunta cada, resposta sem citar: nada entregue; o robô pede para responder em cima da mensagem', ultimo().texto)
  rec = await recebe({ texto: 'Tem sim, de 3 metros', citada: idObra })
  await passo(em(3 * RODADA + 2))
  l = await fila(`ref_id = '${P(8)}'`)
  ok(rec.resultado === 'entregue' && (await pq(8)).resposta === 'Tem sim, de 3 metros' && !(await pq(9)).resposta && l[0].status === 'respondida' && ultimo().texto === '✅ Pronto! Sua resposta foi entregue para Ana no app.',
     'resposta CITANDO a mensagem: entregue na pergunta daquela mensagem (a de obra), não na mais recente', [(await pq(8)).resposta, (await pq(9)).resposta])
  // recusada pela regra do app (mais de 300 caracteres)
  rec = await recebe({ texto: 'a'.repeat(301), citada: idPortao })
  await passo(em(3 * RODADA + 3))
  ok(rec.resultado.startsWith('recusada (400)') && !(await pq(9)).resposta && ultimo().texto === 'Não consegui entregar sua resposta: resposta deve ter no máximo 300 caracteres.', 'resposta que o app recusaria (300+ caracteres): não entra, o robô avisa', ultimo().texto)
  // contato na resposta: mesmo sanitizador do app
  rec = await recebe({ texto: 'Branco. Me liga 34 99888-7766', citada: idPortao })
  await passo(em(3 * RODADA + 4))
  ok(rec.resultado === 'entregue' && /contato removido/.test((await pq(9)).resposta) && !/99888/.test((await pq(9)).resposta), 'telefone na resposta vira "[contato removido]" (mesmo sanitizador do app)', (await pq(9)).resposta)

  // ═══════════ RESPONDIDA NO APP ANTES DO ENVIO ═══════════
  await pergunta(10, 'reparo', R1, CAIO, 'Fornece o material?', 50)
  await pergunta(11, 'reparo', R2, CAIO, 'Aceita PIX?', 49)
  await S.enfileirarPerguntasSemResposta(shim)
  silenciar(true)
  const pelaApp = await rotasApp.responderPergunta({ tabela: 'reparos', demandaId: R1, perguntaId: P(10), usuarioId: DONO, resposta: 'Sim, forneço' })
  await assentar()
  silenciar(false)
  await q(`UPDATE reparos SET match_usuario_id = $1 WHERE id = $2`, [CAIO, R2])
  const nEnviados = f.enviados.length
  r = await passo(em(4 * RODADA))
  ok(pelaApp.status === 200 && !r.enviou && f.enviados.length === nEnviados && (await fila(`ref_id IN ('${P(10)}', '${P(11)}')`)).length === 0,
     'dono respondeu no app (ou o pedido ganhou escolhido) antes do envio: as linhas saem da fila e nada é enviado', r.motivo)
  await q(`UPDATE reparos SET match_usuario_id = NULL WHERE id = $1`, [R2])

  // ═══════════ ATÉ 5 POR MENSAGEM, TÍTULO POR ITEM ENTRE PEDIDOS ═══════════
  const seis = [[12, R1, CARLOS, 'P um?'], [13, R1, LARISSA, 'P dois?'], [14, R2, GETULIO, 'P três?'], [15, R2, ANA, 'P quatro?'], [16, R1, BETO, 'P cinco?'], [17, R1, CAIO, 'P seis?']]
  for (const [i, [n, d, a, t]] of seis.entries()) await pergunta(n, 'reparo', d, a, t, 90 - i)
  await S.enfileirarPerguntasSemResposta(shim)
  r = await passo(em(4 * RODADA + 1))
  const CINCO = 'Oi, Luiz! 👋 Aqui é o *ProTudo*.\nTem 5 perguntas esperando você nos seus pedidos:\n1️⃣ Carlos (*Entregar panfletos*): "P um?"\n2️⃣ Larissa (*Entregar panfletos*): "P dois?"\n3️⃣ Getúlio (*Pintar o portão*): "P três?"\n4️⃣ Ana (*Pintar o portão*): "P quatro?"\n5️⃣ Beto (*Entregar panfletos*): "P cinco?"\n👉 Responda começando pelo número. Exemplo: *1 sim, já comprei*'
  l = await fila(`ref_id = '${P(17)}'`)
  ok(r.enviou && r.ids.length === 5 && ultimo().texto === CINCO && l[0].status === 'fila', 'seis pendentes em dois pedidos: UMA mensagem com 5, numeradas, com o título do pedido em cada item; a sexta espera', ultimo().texto)
  r = await passo(em(4 * RODADA + 30))
  ok(!r.enviou, 'a sexta não sai antes de 3 h')
  rec = await recebe({ texto: '4 sim' })
  ok(rec.resultado === 'entregue' && (await pq(15)).resposta === 'sim', 'resposta "4 sim" numa mensagem de 5: pergunta 4')
  rec = await recebe({ texto: 'talvez' })
  await drenar(em(4 * RODADA + 31))
  ok(ultimo().texto === 'Não entendi para quem é a resposta 😅 Comece pelo número da pergunta (1, 2, 3 ou 5).', 'ambígua com 4 pendentes: a lista de números acompanha o que falta', ultimo().texto)

  // ═══════════ JANELA, PAUSA E VALIDADE DA RESPOSTA AUTOMÁTICA ═══════════
  const noite = new Date(BASE); noite.setUTCHours(25, 30, 0, 0)   // 22:30 em São Paulo
  await q(`UPDATE whatsapp_mensagens SET enviada_em = enviada_em - INTERVAL '1 day' WHERE tipo = 'pergunta_sem_resposta' AND enviada_em IS NOT NULL`)
  relogio = noite
  rec = await recebe({ texto: '', midia: 'imagem' })
  let n0 = f.enviados.length
  r = await passo(noite)
  ok(r.enviou && ultimo().texto === T.TEXTO_SO_ESCRITA && (await fila(`ref_id = '${P(17)}'`))[0].status === 'fila', 'fora de 08–21h: a resposta automática sai (a pessoa acabou de escrever); o aviso de pergunta espera')
  r = await passo(noite)
  ok(!r.enviou && r.motivo === 'fora_do_horario', 'fora do horário, sem resposta automática pendente: nada', r.motivo)
  relogio = em(5 * RODADA)
  rec = await recebe({ texto: '', midia: 'audio' })
  await config('whatsapp_pausado', 'true')
  n0 = f.enviados.length
  r = await passo(em(5 * RODADA))
  ok(!r.enviou && r.motivo === 'pausado' && f.enviados.length === n0, 'pausa global segura tudo, inclusive resposta automática e aviso de pergunta')
  await config('whatsapp_pausado', 'false')
  n0 = f.enviados.length
  r = await passo(em(5 * RODADA + 16), {})   // sem trava: nada sai, mas o relógio anda
  r = await passo(em(5 * RODADA + 16))
  ok(f.enviados.slice(n0).every(x => x.texto !== T.TEXTO_SO_ESCRITA), 'a resposta automática vencida não é enviada')
  l = await fila(`tipo = 'resposta' AND status = 'falha'`)
  ok(l.length === 1 && /expirada/.test(l[0].erro), 'resposta automática não enviada em 15 min é descartada (não chega atrasada)', l.map(x => x.erro))
  r = await passo(em(5 * RODADA), {})
  ok(!r.enviou && r.motivo === 'sem_trava', 'sem a trava de teste nada sai — também na Etapa 2')

  // ═══════════ OUTRA PESSOA: primeira mensagem dela leva o rodapé ═══════════
  await q(`UPDATE whatsapp_estado SET trava = 'TODOS'`)
  await pergunta(18, 'reparo', R_MARIA, LARISSA, 'Tem estacionamento?', 40)
  await S.enfileirarPerguntasSemResposta(shim)
  await q(`DELETE FROM whatsapp_mensagens WHERE status = 'fila' AND usuario_id = $1`, [DONO])
  r = await passo(em(90), { WHATSAPP_SOMENTE_PARA: 'TODOS' })   // 10:00 em São Paulo (dentro da janela)
  ok(r.enviou && ultimo().jid === '551187654321@s.whatsapp.net' && ultimo().texto.startsWith('Oi, Maria! 👋 Aqui é o *ProTudo*.\nTem 2 perguntas esperando você no pedido *Pedido da Maria*:')
     && ultimo().texto.endsWith('\n_Para não receber mais avisos, responda SAIR._'),
     'trava aberta (TODOS): a Maria recebe as dela — inclusive a que ficou de fora enquanto a trava era só o número de teste — com o rodapé (primeira mensagem DELA)', ultimo().texto.slice(0, 90))
  await registrarRecebida(shim, { id: 'SAIR1', jid: '551187654321@s.whatsapp.net', telefone: '+551187654321', texto: 'sair' })
  await pergunta(19, 'reparo', R_MARIA, CARLOS, 'Depois do SAIR', 40)
  e = await S.enfileirarPerguntasSemResposta(shim)
  const saiu = (await q(`SELECT processada_em, resultado FROM whatsapp_recebidas WHERE wa_message_id = 'SAIR1'`)).rows[0]
  ok(saiu.resultado === 'saiu' && saiu.processada_em && (await fila(`ref_id = '${P(19)}'`)).length === 0, 'quem respondeu SAIR não gera mais aviso (e o SAIR não é tratado como resposta a pergunta)', [saiu.resultado, e])

  // ═══════════ ROTA DO APP (mesma função, mesmas respostas de antes) ═══════════
  const rotaResposta = rotasApp.stack.find(x => x.route && x.route.path === '/reparos/:id/perguntas/:pid/resposta').route.stack
  const viaApp = (usuario, pid, resposta, demanda = R1) => new Promise(resolve => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
    rotaResposta[rotaResposta.length - 1].handle({ params: { id: demanda, pid }, body: { resposta }, usuario: { id: usuario } }, res)
  })
  silenciar(true)
  const a409 = await viaApp(DONO, P(1), 'de novo'), a403 = await viaApp(MARIA, P(12), 'não é minha'), a400 = await viaApp(DONO, P(12), '  ')
  const a404 = await viaApp(DONO, 'nao-e-uuid', 'x'), a200 = await viaApp(DONO, P(12), 'Respondido pelo app')
  await assentar()
  silenciar(false)
  ok(a409.status === 409 && a409.body.erro === 'Esta pergunta já foi respondida' && a403.status === 403 && a400.status === 400 && a400.body.erro === 'resposta é obrigatória' && a404.status === 404
     && a200.status === 200 && a200.body.resposta === 'Respondido pelo app' && a200.body.minha === false && !('autor_id' in a200.body) && (await pq(12)).resposta === 'Respondido pelo app',
     'POST /reparos/:id/perguntas/:pid/resposta (app) segue igual: 200 / 400 / 403 / 404 / 409', [a409.status, a403.status, a400.status, a404.status, a200.status])

  // ═══════════ PEÇAS ═══════════
  ok(JSON.stringify(T.lerNumeroInicial('2 sim')) === '{"numero":2,"resto":"sim"}' && T.lerNumeroInicial('3- ok').resto === 'ok' && T.lerNumeroInicial('1️⃣ pode').numero === 1
     && T.lerNumeroInicial('12 unidades') === null && T.lerNumeroInicial('sim') === null && T.lerNumeroInicial('6 sim') === null && T.lerNumeroInicial('2').resto === '',
     'leitura do número inicial (1–5; "12 unidades" não é número de pergunta)')
  ok(midiaDaMensagem({ audioMessage: {} }) === 'audio' && midiaDaMensagem({ imageMessage: { caption: 'x' } }) === 'imagem' && midiaDaMensagem({ conversation: 'oi' }) === null
     && citadaDaMensagem({ extendedTextMessage: { text: 'sim', contextInfo: { stanzaId: 'WA9' } } }) === 'WA9' && citadaDaMensagem({ conversation: 'oi' }) === null,
     'adaptador: tipo de mídia e mensagem citada lidos da mensagem recebida')
  ok(C.travaPermite(C.lerTrava(ENV), TEL_WA) && !C.travaPermite(C.lerTrava(ENV), '+5511987654321'), 'trava de teste compara com e sem o nono dígito')
  const pilha = (m, c) => rotasAdmin.stack.find(x => x.route && x.route.path === c && x.route.methods[m]).route.stack
  const chamar = (m, c, query = {}) => new Promise(resolve => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
    const p = pilha(m, c); p[p.length - 1].handle({ query, body: {}, params: {}, usuario: { id: U(99), role: 'admin' } }, res)
  })
  const tipos = (await chamar('get', '/admin/whatsapp/tipos')).body.tipos
  const lista = (await chamar('get', '/admin/whatsapp/mensagens', { status: 'respondida', limit: '100' })).body
  const m7 = lista.mensagens.find(x => x.itens.some(i => i.ref_id === P(7)))
  ok(tipos.map(x => x.tipo).join() === 'pergunta_sem_resposta,novo_interessado,especialidade_rara,prazo_acabando,escolhido,horario_aguardando,teste' && tipos[0].implementado === true && tipos[0].ligado === true && tipos.slice(3, 6).every(x => !x.implementado)
     && m7 && m7.itens.find(i => i.ref_id === P(7)).resposta === 'pode sim, de manhã' && m7.papel === 'dono' && m7.resumo.startsWith('Pergunta sem resposta · ') && lista.mensagens.every(x => x.resposta),
     'painel: pergunta_sem_resposta implementado = true; /mensagens traz a resposta dada pelo WhatsApp', [tipos[0], m7 && m7.itens])

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
