#!/usr/bin/env node
// ROBÔ DE WHATSAPP — ETAPA 1 (17/11/2026). Fila, travas e painel com um ADAPTADOR FALSO (nada
// sai para o WhatsApp de verdade), sobre o ESQUEMA DE PRODUÇÃO (PGlite) + src/whatsapp/migracao:
//   - sem WHATSAPP_SOMENTE_PARA nada sai; TODOS tem de ser explícito; fora da lista vira falha;
//   - pausa global, liga/desliga por tipo, janela 08–21h de São Paulo, intervalo 20–40 s;
//   - dedupe (mesma chave nunca entra duas vezes), agrupamento por pessoa, tentativas;
//   - onWhatsApp antes de enviar e envio para o JID devolvido (não para o número digitado);
//   - recibos (entregue/lida), "SAIR" (opt-out), mensagens recebidas guardadas;
//   - sessão do Baileys no Postgres (ida e volta), contrato do adaptador, rotas do painel;
//   - Watch Paths da Railway cobrem todo módulo que o worker importa.
//   npm i -D @electric-sql/pglite && node scripts/testar-whatsapp-fila.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

let db = null
const q = async (sql, params) => {
  if (!db) throw new Error('sem banco (boot)')
  const r = await db.query(sql, params)
  if (r && r.rowCount === undefined) r.rowCount = r.rows.length || r.affectedRows || 0
  return r
}
const shim = { query: q, connect: async () => ({ query: q, release() {}, on() {} }), on() {}, end: async () => {} }
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })

const C = require(path.join(REPO, 'src/whatsapp/config'))
const { migrarWhatsapp } = require(path.join(REPO, 'src/whatsapp/migracao'))
const F = require(path.join(REPO, 'src/whatsapp/fila'))
const { registrarRecebida } = require(path.join(REPO, 'src/whatsapp/entrada'))
const { validarAdaptador, METODOS } = require(path.join(REPO, 'src/whatsapp/adaptador'))
const { usarAuthPostgres } = require(path.join(REPO, 'src/whatsapp/authPostgres'))
const { criarAdaptadorBaileys, telefoneDoJid, textoDaMensagem } = require(path.join(REPO, 'src/whatsapp/adaptadorBaileys'))
const { enfileirar } = require(path.join(REPO, 'src/services/whatsappFilaService'))
const rotas = require(path.join(REPO, 'src/routes/adminWhatsapp'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`

// Adaptador FALSO: registra o que "enviaria". O WhatsApp devolve o JID SEM o nono dígito.
const criarFalso = () => {
  const f = {
    conexao: 'conectado', enviados: [], consultas: [], semWhatsapp: new Set(), falharEnvio: 0, n: 0,
    conectar: async () => {}, desconectar: async () => {},
    estado: () => ({ conexao: f.conexao, qr: null, numero: '+5534900000000' }),
    existeNoWhatsapp: async (tel) => {
      f.consultas.push(tel)
      if (f.semWhatsapp.has(tel)) return { existe: false, jid: null }
      const d = tel.slice(1)
      return { existe: true, jid: `${d.length === 13 ? d.slice(0, 4) + d.slice(5) : d}@s.whatsapp.net` }
    },
    enviarTexto: async (jid, texto) => {
      if (f.falharEnvio > 0) { f.falharEnvio--; throw new Error('falha simulada') }
      const id = `WA${++f.n}`
      f.enviados.push({ jid, texto, id })
      return { id }
    },
    aoReceber() {}, aoAtualizarStatus() {}, aoMudarEstado() {},
  }
  return f
}

const TESTE = '+5534998891747'            // o número da trava
const JID_TESTE = '553498891747@s.whatsapp.net'
const OUTRO = '+5511987654321'
const MEIO_DIA = new Date('2026-11-17T15:00:00Z')   // 12:00 em São Paulo
const env = (v) => (v === undefined ? {} : { WHATSAPP_SOMENTE_PARA: v })
const linhas = async (where = 'true') => (await q(`SELECT * FROM whatsapp_mensagens WHERE ${where} ORDER BY id`)).rows
const limpar = () => q(`DELETE FROM whatsapp_mensagens`)
const rodar = (adaptador, e, agora = MEIO_DIA) => F.processarProxima({ db: shim, adaptador, agora, env: e })

const handler = (metodo, caminho) => {
  const layer = rotas.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack
}
const chamar = (metodo, caminho, { body = {}, query = {} } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  const pilha = handler(metodo, caminho)
  Promise.resolve(pilha[pilha.length - 1].handle({ body, query, params: {}, usuario: { id: U(99), role: 'admin' } }, res)).catch(e => resolve({ status: 599, body: { erro: e.message } }))
})

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))

  // ---------- migração ----------
  for (let i = 0; i < 2; i++) { await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT') }
  const tabelas = (await q(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'whatsapp_%' ORDER BY 1`)).rows.map(r => r.table_name)
  ok(['whatsapp_auth', 'whatsapp_estado', 'whatsapp_mensagens', 'whatsapp_recebidas'].every(t => tabelas.includes(t)), 'migração idempotente cria as 4 tabelas (whatsapp_envios antiga intocada)', tabelas)
  const usr = (n, nome, telefone) => q(`INSERT INTO usuarios (id, nome, email, role, telefone, cpf_cnpj, ativo) VALUES ($1, $2, $3, 'dono_obra', $4, $5, true)`, [U(n), nome, `${nome}@x.invalid`, telefone, String(n).padStart(11, '0')])
  await usr(1, 'ana', '(34) 99889-1747'); await usr(2, 'bia', '34 99889-1747'); await usr(3, 'caio', '11987654321')
  const padrao = (await q(`SELECT whatsapp_avisos FROM usuarios WHERE id = $1`, [U(1)])).rows[0].whatsapp_avisos
  ok(padrao === true, 'usuarios.whatsapp_avisos nasce true')
  ok((await q(`SELECT valor FROM configuracoes WHERE chave = 'whatsapp_pausado'`)).rows[0]?.valor === 'false', 'pausa global nasce desligada')

  // ---------- funções puras ----------
  ok(C.normalizarTelefone('(34) 99889-1747') === TESTE && C.normalizarTelefone('+55 34 99889-1747') === TESTE && C.normalizarTelefone('123') === null, 'telefone normalizado para E.164 (+55…)')
  ok(C.lerTrava({}).modo === 'ausente' && C.lerTrava(env('  ')).modo === 'ausente' && C.lerTrava(env('abc')).modo === 'ausente', 'trava ausente/vazia/inválida → modo ausente')
  ok(C.lerTrava(env('todos')).modo === 'todos' && C.lerTrava(env(TESTE)).numeros[0] === TESTE, 'trava: TODOS explícito ou lista de números')
  const h = (iso) => C.dentroDaJanela(new Date(iso))
  ok(!h('2026-11-17T10:59:00Z') && h('2026-11-17T11:00:00Z') && h('2026-11-17T23:59:00Z') && !h('2026-11-18T00:00:00Z'), 'janela 08:00–20:59 de São Paulo')
  const amostras = Array.from({ length: 300 }, () => C.intervaloMs())
  ok(Math.min(...amostras) >= 20000 && Math.max(...amostras) <= 40000 && C.intervaloMs(() => 0) === 20000 && C.intervaloMs(() => 0.999999) === 40000, 'intervalo entre envios sorteado em 20–40 s')
  ok(C.ehPedidoDeSaida(' sair ') && C.ehPedidoDeSaida('Sair!') && !C.ehPedidoDeSaida('quero sair daqui') && !C.ehPedidoDeSaida(''), '"SAIR" reconhecido só como mensagem inteira')

  // ---------- enfileirar + dedupe ----------
  const e1 = await enfileirar({ tipo: 'teste', usuarioId: U(1), texto: 'Oi 1', chaveDedupe: 'pergunta:1' }, shim)
  const e2 = await enfileirar({ tipo: 'teste', usuarioId: U(1), texto: 'Oi 1 de novo', chaveDedupe: 'pergunta:1' }, shim)
  ok(e1.ok && e1.telefone === TESTE && e2.ok === false && e2.motivo === 'duplicada' && (await linhas()).length === 1, 'dedupe: a mesma chave não entra duas vezes; telefone vem de usuarios', [e1, e2])
  ok((await enfileirar({ tipo: 'nao_existe', telefone: TESTE, texto: 'x' }, shim)).motivo === 'tipo_desconhecido' && (await enfileirar({ tipo: 'teste', telefone: '123', texto: 'x' }, shim)).motivo === 'telefone_invalido'
     && (await enfileirar({ tipo: 'teste', telefone: TESTE, texto: '  ' }, shim)).motivo === 'texto_vazio', 'enfileirar recusa tipo desconhecido, telefone inválido e texto vazio (sem lançar)')

  // ---------- travas ----------
  let f = criarFalso()
  let r = await rodar(f, env(undefined))
  ok(r.motivo === 'sem_trava' && f.enviados.length === 0 && f.consultas.length === 0 && (await linhas())[0].status === 'fila', 'SEM WHATSAPP_SOMENTE_PARA: nada sai, nem consulta ao WhatsApp', r.motivo)
  r = await rodar(f, env('+55'))
  ok(r.motivo === 'sem_trava' && f.enviados.length === 0, 'trava inválida: nada sai')
  await q(`UPDATE configuracoes SET valor = 'true' WHERE chave = 'whatsapp_pausado'`)
  r = await rodar(f, env(TESTE))
  ok(r.motivo === 'pausado' && f.enviados.length === 0, 'pausa global: nada sai')
  await q(`UPDATE configuracoes SET valor = 'false' WHERE chave = 'whatsapp_pausado'`)
  r = await rodar(f, env(TESTE), new Date('2026-11-17T10:59:00Z'))
  const r21 = await rodar(f, env(TESTE), new Date('2026-11-18T00:00:00Z'))
  ok(r.motivo === 'fora_do_horario' && r21.motivo === 'fora_do_horario' && f.enviados.length === 0, 'fora de 08–21h: nada sai (07:59 e 21:00)')
  f.conexao = 'conectando'
  r = await rodar(f, env(TESTE))
  ok(r.motivo === 'desconectado' && f.enviados.length === 0, 'desconectado: nada sai')
  f.conexao = 'conectado'
  await q(`INSERT INTO configuracoes (chave, valor) VALUES ('whatsapp_tipo_teste', 'false')`)
  r = await rodar(f, env(TESTE))
  ok(r.motivo === 'tipos_desligados' && f.enviados.length === 0, 'tipo desligado: nada sai')
  await q(`UPDATE configuracoes SET valor = 'true' WHERE chave = 'whatsapp_tipo_teste'`)

  // ---------- envio para o JID devolvido ----------
  r = await rodar(f, env(TESTE), new Date('2026-11-17T11:00:00Z'))
  let l = await linhas()
  ok(r.enviou && r.falouComWhatsapp && f.consultas[0] === TESTE && f.enviados.length === 1 && f.enviados[0].jid === JID_TESTE
     && l[0].status === 'enviada' && l[0].wa_jid === JID_TESTE && l[0].wa_message_id === 'WA1' && l[0].telefone === TESTE && l[0].tentativas === 1 && l[0].enviando_em === null,
     'envia às 08:00 para o JID devolvido pelo onWhatsApp (sem o nono dígito) e grava wa_jid', [f.enviados[0]?.jid, l[0].status])
  r = await rodar(f, env(TESTE))
  ok(r.motivo === 'fila_vazia' && f.enviados.length === 1, 'fila vazia: nada a fazer, sem reenvio')

  // ---------- trava em lista: número de fora vira falha e não segura a fila ----------
  await limpar(); f = criarFalso()
  await enfileirar({ tipo: 'teste', usuarioId: U(3), texto: 'para outro' }, shim)
  await enfileirar({ tipo: 'teste', telefone: TESTE, texto: 'para o teste' }, shim)
  r = await rodar(f, env(TESTE))
  l = await linhas()
  ok(r.enviou && f.enviados.length === 1 && f.enviados[0].texto === 'para o teste' && !f.consultas.includes(OUTRO)
     && l[0].status === 'falha' && /trava/.test(l[0].erro) && l[1].status === 'enviada',
     'trava em lista: número de fora vira falha (sem consulta nem envio) e o da trava sai', l.map(x => [x.telefone, x.status]))
  await limpar(); f = criarFalso()
  await enfileirar({ tipo: 'teste', usuarioId: U(3), texto: 'aberto' }, shim)
  r = await rodar(f, env('TODOS'))
  ok(r.enviou && f.enviados[0].jid === '551187654321@s.whatsapp.net', 'TODOS explícito: envia para qualquer número', f.enviados[0]?.jid)

  // ---------- agrupamento ----------
  await limpar(); f = criarFalso()
  for (const t of ['Pergunta A', 'Pergunta B', 'Pergunta C']) await enfileirar({ tipo: 'teste', usuarioId: U(1), texto: t }, shim)
  await enfileirar({ tipo: 'teste', usuarioId: U(2), texto: 'De outra conta, mesmo número' }, shim)
  r = await rodar(f, env(TESTE))
  l = await linhas()
  ok(f.enviados.length === 1 && f.enviados[0].texto === 'Pergunta A\n\nPergunta B\n\nPergunta C' && r.ids.length === 3
     && l.slice(0, 3).every(x => x.status === 'enviada' && x.wa_message_id === 'WA1') && l[0].agrupada_em === null && l[1].agrupada_em === l[0].id && l[2].agrupada_em === l[0].id
     && l[3].status === 'fila',
     'agrupa os 3 itens da mesma pessoa numa mensagem só (a de outra conta fica para a próxima)', [f.enviados[0]?.texto, l.map(x => x.status)])
  r = await rodar(f, env(TESTE))
  ok(r.enviou && f.enviados.length === 2 && f.enviados[1].texto === 'De outra conta, mesmo número', 'a próxima chamada envia o item da outra conta')

  // ---------- sem WhatsApp ----------
  await limpar(); f = criarFalso(); f.semWhatsapp.add(TESTE)
  await enfileirar({ tipo: 'teste', telefone: TESTE, texto: 'x' }, shim)
  r = await rodar(f, env(TESTE))
  l = await linhas()
  ok(r.motivo === 'sem_whatsapp' && r.falouComWhatsapp && f.enviados.length === 0 && l[0].status === 'sem_whatsapp' && l[0].enviando_em === null, 'número sem WhatsApp: status sem_whatsapp, nada enviado (e conta como consulta para o intervalo)')

  // ---------- tentativas ----------
  await limpar(); f = criarFalso(); f.falharEnvio = 5
  await enfileirar({ tipo: 'teste', telefone: TESTE, texto: 'x' }, shim)
  r = await rodar(f, env(TESTE))
  l = await linhas()
  ok(r.motivo === 'erro_no_envio' && l[0].status === 'fila' && l[0].tentativas === 1 && l[0].erro === 'falha simulada' && l[0].proxima_tentativa_em && l[0].enviando_em === null, '1ª falha: volta à fila com nova tentativa agendada')
  r = await rodar(f, env(TESTE))
  ok(r.motivo === 'fila_vazia', 'antes da hora da nova tentativa: não tenta de novo')
  await rodar(f, env(TESTE), new Date(MEIO_DIA.getTime() + 6 * 60000))
  await rodar(f, env(TESTE), new Date(MEIO_DIA.getTime() + 30 * 60000))
  l = await linhas()
  ok(l[0].status === 'falha' && l[0].tentativas === 3 && f.enviados.length === 0, `depois de ${C.MAX_TENTATIVAS} tentativas: falha definitiva`, [l[0].status, l[0].tentativas])

  // ---------- interrompida no meio do envio ----------
  await limpar()
  await enfileirar({ tipo: 'teste', telefone: TESTE, texto: 'no meio' }, shim)
  await q(`UPDATE whatsapp_mensagens SET enviando_em = NOW()`)
  f = criarFalso()
  r = await rodar(f, env(TESTE))
  const rec = await F.recuperarInterrompidas(shim)
  l = await linhas()
  ok(r.motivo === 'fila_vazia' && rec === 1 && l[0].status === 'falha' && /interrompida/.test(l[0].erro) && f.enviados.length === 0, 'worker caiu no meio do envio: vira falha, nunca é reenviada')

  // ---------- recibos ----------
  await limpar(); f = criarFalso()
  await enfileirar({ tipo: 'teste', usuarioId: U(1), texto: 'A' }, shim)
  await enfileirar({ tipo: 'teste', usuarioId: U(1), texto: 'B' }, shim)
  await rodar(f, env(TESTE))
  const lida0 = await F.aplicarStatus(shim, { id: 'WA1', status: 'entregue' })
  l = await linhas()
  ok(lida0 === 2 && l.every(x => x.status === 'entregue' && x.entregue_em), 'recibo entregue marca a mensagem e as agrupadas nela')
  await F.aplicarStatus(shim, { id: 'WA1', status: 'lida' })
  await F.aplicarStatus(shim, { id: 'WA1', status: 'entregue' })
  l = await linhas()
  ok(l.every(x => x.status === 'lida' && x.lida_em) && (await F.aplicarStatus(shim, { id: 'NAO_EXISTE', status: 'lida' })) === 0, 'lida não volta para entregue; id desconhecido é ignorado')

  // ---------- recebidas + SAIR ----------
  await enfileirar({ tipo: 'teste', usuarioId: U(1), texto: 'pendente da ana' }, shim)
  await enfileirar({ tipo: 'teste', usuarioId: U(3), texto: 'pendente do caio' }, shim)
  let e = await registrarRecebida(shim, { id: 'IN1', jid: JID_TESTE, telefone: '+553498891747', texto: 'Pode vir amanhã?', quando: MEIO_DIA })
  const rcb = (await q(`SELECT * FROM whatsapp_recebidas`)).rows
  ok(e.nova && !e.saiu && rcb.length === 1 && rcb[0].usuario_id === U(1) && rcb[0].texto === 'Pode vir amanhã?' && rcb[0].mensagem_ref === null,
     'mensagem recebida é guardada e ligada à conta pelo JID do envio (sem casar com pedido — Etapa 2)')
  e = await registrarRecebida(shim, { id: 'IN1', jid: JID_TESTE, telefone: '+553498891747', texto: 'Pode vir amanhã?' })
  ok(e.nova === false && (await q(`SELECT count(*)::int AS n FROM whatsapp_recebidas`)).rows[0].n === 1, 'reentrega da mesma mensagem não duplica')
  e = await registrarRecebida(shim, { id: 'IN2', jid: JID_TESTE, telefone: '+553498891747', texto: ' Sair ' })
  const av = Object.fromEntries((await q(`SELECT id, whatsapp_avisos FROM usuarios`)).rows.map(x => [x.id, x.whatsapp_avisos]))
  l = await linhas(`texto LIKE 'pendente%'`)
  ok(e.saiu && av[U(1)] === false && av[U(2)] === false && av[U(3)] === true && l[0].status === 'saiu' && l[1].status === 'fila',
     '"SAIR" (vindo sem o nono dígito) desliga whatsapp_avisos de TODAS as contas do número e tira da fila o que era delas; outras pessoas seguem', [av, l.map(x => x.status)])
  ok(C.variantesTelefone('+553498891747').includes(TESTE) && C.variantesTelefone(TESTE).includes('+553498891747') && C.variantesTelefone('+551133334444').length === 2, 'variantes do telefone: com e sem o nono dígito')
  await q(`UPDATE usuarios SET whatsapp_avisos = false WHERE id = $1`, [U(3)])
  f = criarFalso()
  r = await rodar(f, env('TODOS'))
  l = await linhas(`texto = 'pendente do caio'`)
  ok(l[0].status === 'saiu' && f.enviados.length === 0 && f.consultas.length === 0, 'quem saiu não recebe: a linha vira saiu na hora do envio, sem consulta ao WhatsApp')

  // ---------- sessão do Baileys no Postgres + contrato do adaptador ----------
  const lib = await import('baileys')
  ok(['makeWASocket', 'fetchLatestBaileysVersion', 'initAuthCreds', 'isJidGroup', 'isLidUser', 'isJidBroadcast'].every(n => typeof lib[n] === 'function')
     && typeof lib.Browsers?.ubuntu === 'function' && lib.DisconnectReason?.loggedOut === 401 && typeof lib.BufferJSON?.reviver === 'function'
     && typeof lib.proto?.Message?.AppStateSyncKeyData?.fromObject === 'function', 'a biblioteca Baileys instalada expõe tudo o que o adaptador usa')
  const a1 = await usarAuthPostgres(shim, lib)
  await a1.salvarCreds()
  await a1.state.keys.set({ 'pre-key': { 7: { public: Buffer.from('pub'), private: Buffer.from('priv') }, 8: { public: Buffer.from('x'), private: Buffer.from('y') } }, session: { 'abc.0': Buffer.from([1, 2, 3]) } })
  await a1.state.keys.set({ 'pre-key': { 8: null } })
  const a2 = await usarAuthPostgres(shim, lib)
  const k = await a2.state.keys.get('pre-key', ['7', '8'])
  const s = await a2.state.keys.get('session', ['abc.0'])
  ok(Buffer.isBuffer(a2.state.creds.noiseKey.private) && Buffer.compare(Buffer.from(a2.state.creds.noiseKey.private), Buffer.from(a1.state.creds.noiseKey.private)) === 0
     && a2.state.creds.registrationId === a1.state.creds.registrationId && Buffer.from(k['7'].private).toString() === 'priv' && k['8'] === null && Buffer.from(s['abc.0']).length === 3,
     'sessão do Baileys vai e volta do Postgres (credenciais e chaves, com apagar)')
  await a2.apagarTudo()
  ok((await q(`SELECT count(*)::int AS n FROM whatsapp_auth`)).rows[0].n === 0, 'apagar a sessão limpa whatsapp_auth (novo QR)')
  const real = criarAdaptadorBaileys({ db: shim, log: { error() {} } })
  let lancou = false
  try { validarAdaptador(real); validarAdaptador(criarFalso()); validarAdaptador({ conectar() {} }) } catch { lancou = true }
  let semConexao = null
  try { await real.enviarTexto(JID_TESTE, 'x') } catch (err) { semConexao = err.message }
  ok(lancou && METODOS.every(m => typeof real[m] === 'function') && real.estado().conexao === 'desligado' && semConexao === 'WhatsApp desconectado',
     'adaptador Baileys cumpre o contrato (e recusa enviar desconectado); adaptador incompleto é recusado')
  ok(telefoneDoJid('553498891747:12@s.whatsapp.net') === '+553498891747' && textoDaMensagem({ extendedTextMessage: { text: 'oi' } }) === 'oi' && textoDaMensagem({ imageMessage: {} }) === '', 'leitura de JID e de texto das mensagens recebidas')

  // ---------- rotas do painel ----------
  const todas = rotas.stack.filter(x => x.route)
  ok(todas.length === 9 && todas.every(x => x.route.stack.length === 3 && x.route.stack[0].handle.name === 'autenticar' && x.route.stack[1].handle.name === 'exigirSuperAdmin'),
     'as 9 rotas /admin/whatsapp/* exigem login e super-admin', todas.map(x => x.route.path))
  await q(`UPDATE whatsapp_estado SET conexao = 'aguardando_qr', qr = 'QR-TEXTO', heartbeat_em = NOW(), trava = NULL`)
  let st = await chamar('get', '/admin/whatsapp/status')
  ok(st.status === 200 && st.body.worker_vivo && st.body.conexao === 'aguardando_qr' && st.body.qr === 'QR-TEXTO' && st.body.envio_liberado === false && st.body.pausado === false, 'status: worker vivo, QR e trava ausente', st.body)
  let t = await chamar('post', '/admin/whatsapp/teste')
  ok(t.status === 409, 'teste sem trava no worker: 409, nada entra na fila', t.status)
  await q(`UPDATE whatsapp_estado SET conexao = 'conectado', qr = NULL, numero = '+5534900000000', trava = $1`, [TESTE])
  await limpar()
  t = await chamar('post', '/admin/whatsapp/teste', { body: { telefone: OUTRO } })
  l = await linhas()
  ok(t.status === 200 && l.length === 1 && l[0].telefone === TESTE && l[0].tipo === 'teste', 'teste do painel só vai para o número da trava (ignora outro telefone informado)', [t.status, l[0]?.telefone])
  await chamar('post', '/admin/whatsapp/pausar')
  st = await chamar('get', '/admin/whatsapp/status')
  const pausou = st.body.pausado === true && st.body.na_fila === 1 && st.body.trava === TESTE
  await chamar('post', '/admin/whatsapp/retomar')
  st = await chamar('get', '/admin/whatsapp/status')
  ok(pausou && st.body.pausado === false, 'pausar / retomar refletem no status')
  const tp = await chamar('put', '/admin/whatsapp/tipos', { body: { tipo: 'teste', ligado: false } })
  const tg = await chamar('get', '/admin/whatsapp/tipos')
  const tx = await chamar('put', '/admin/whatsapp/tipos', { body: { tipo: 'constructor', ligado: true } })
  await chamar('put', '/admin/whatsapp/tipos', { body: { tipo: 'teste', ligado: true } })
  ok(tp.status === 200 && tg.body.tipos.find(x => x.tipo === 'teste').ligado === false && tx.status === 400, 'liga/desliga por tipo; tipo desconhecido → 400')
  const ct = await chamar('get', '/admin/whatsapp/contadores')
  const ls = await chamar('get', '/admin/whatsapp/mensagens', { query: { status: 'fila', telefone: '99889' } })
  const lv = await chamar('get', '/admin/whatsapp/mensagens', { query: { status: 'enviada' } })
  const li = await chamar('get', '/admin/whatsapp/mensagens', { query: { status: 'x' } })
  ok(ct.status === 200 && ct.body.hoje.fila === 1 && ct.body.por_tipo.teste.sete_dias.fila === 1 && ls.body.total === 1 && ls.body.mensagens[0].telefone === TESTE && lv.body.total === 0 && li.status === 400,
     'contadores e lista com filtros', [ct.body.hoje, ls.body.total, lv.body.total, li.status])
  const dc = await chamar('post', '/admin/whatsapp/desconectar')
  ok(dc.status === 200 && (await q(`SELECT comando FROM whatsapp_estado`)).rows[0].comando === 'desconectar', 'desconectar deixa o comando para o worker')
  await q(`UPDATE whatsapp_estado SET heartbeat_em = NOW() - INTERVAL '10 minutes'`)
  st = await chamar('get', '/admin/whatsapp/status')
  ok(st.body.worker_vivo === false && st.body.conexao === 'desligado', 'worker sem batimento há 10 min: status mostra desligado')

  // ---------- campos da aba do painel (17/11/2026) ----------
  const tg2 = await chamar('get', '/admin/whatsapp/tipos')
  ok(JSON.stringify(tg2.body.tipos.map(x => [x.tipo, x.implementado])) === JSON.stringify([['pergunta_sem_resposta', true], ['prazo_acabando', false], ['escolhido', false], ['horario_aguardando', false], ['teste', true]])
     && tg2.body.tipos.every(x => typeof x.rotulo === 'string' && typeof x.ligado === 'boolean') && tg2.body.tipos.filter(x => x.ligado).map(x => x.tipo).join() === 'teste',
     '/tipos devolve sempre os 5 slugs, na ordem, com implementado (pergunta_sem_resposta e teste) e só teste ligado por padrão', tg2.body.tipos.map(x => [x.tipo, x.implementado, x.ligado]))
  const ni = await enfileirar({ tipo: 'prazo_acabando', telefone: TESTE, texto: 'x' }, shim)
  ok(ni.ok === false && ni.motivo === 'tipo_nao_implementado', 'tipo ainda não implementado não entra na fila', ni)

  const { SQL_GRAVAR_ESTADO } = require(path.join(REPO, 'src/whatsapp/worker'))
  const gravar = (conexao) => q(SQL_GRAVAR_ESTADO, [conexao, null, '+5534900000000', TESTE])
  await gravar('conectando')
  const semConexao2 = (await chamar('get', '/admin/whatsapp/status')).body
  await gravar('conectado')
  const c1 = (await chamar('get', '/admin/whatsapp/status')).body
  await q(`UPDATE whatsapp_estado SET conectado_em = conectado_em - INTERVAL '1 hour'`)
  await gravar('conectado')
  const c2 = (await chamar('get', '/admin/whatsapp/status')).body
  await gravar('conectando'); await gravar('conectado')
  const c3 = (await chamar('get', '/admin/whatsapp/status')).body
  ok('conectado_em' in semConexao2 && semConexao2.conectado_em === null && c1.conectado_em && c2.conectado_em
     && Math.abs(new Date(c1.conectado_em) - new Date(c2.conectado_em) - 3600000) < 5000 && new Date(c3.conectado_em) - new Date(c2.conectado_em) > 3500000,
     '/status: conectado_em nulo fora de conectado, mantido entre batimentos e renovado ao reconectar', [semConexao2.conectado_em, c1.conectado_em, c2.conectado_em, c3.conectado_em])

  await limpar()
  await q(`INSERT INTO usuarios (id, nome, email, role, telefone, cpf_cnpj, ativo) VALUES ($1, 'emilyn', 'emilyn@x.invalid', 'prestador', '11987654321', '00000000004', true)`, [U(4)])
  const R1 = 'dddddddd-0000-4000-8000-000000000001', P1 = 'eeeeeeee-0000-4000-8000-000000000001'
  await q(`INSERT INTO reparos (id, titulo, criado_por, status, codigo_publico) VALUES ($1, 'Entregar panfletos 1000 unidades em todos os bairros da cidade', $2, 'aberta', '3529D')`, [R1, U(1)])
  await q(`INSERT INTO perguntas_demanda (id, tipo, demanda_id, autor_id, pergunta) VALUES ($1, 'reparo', $2, $3, 'Qual o bairro?')`, [P1, R1, U(4)])
  const ins = (tipo, usuario, tabela, ref, texto) => q(`INSERT INTO whatsapp_mensagens (tipo, usuario_id, telefone, texto, ref_tabela, ref_id) VALUES ($1, $2, $3, $4, $5, $6)`, [tipo, usuario, TESTE, texto, tabela, ref])
  await ins('pergunta_sem_resposta', U(1), 'perguntas_demanda', P1, 'Você tem uma pergunta sem resposta')
  await ins('escolhido', U(4), 'reparos', R1, 'Você foi escolhida')
  await ins('teste', U(3), null, null, 'Teste com conta')
  await ins('teste', null, null, null, 'Teste sem conta')
  const lm = (await chamar('get', '/admin/whatsapp/mensagens')).body
  const por = Object.fromEntries(lm.mensagens.map(x => [x.texto, x]))
  const m1 = por['Você tem uma pergunta sem resposta'], m2 = por['Você foi escolhida'], m3 = por['Teste com conta'], m4 = por['Teste sem conta']
  ok(lm.total === 4 && m1.papel === 'dono' && m1.codigo === '3529D' && m1.usuario_nome === 'ana' && m2.papel === 'profissional' && m2.codigo === '3529D' && m2.usuario_nome === 'emilyn',
     '/mensagens: papel (dono/profissional pela relação com o pedido), codigo e usuario_nome — via pedido e via pergunta', [m1.papel, m1.codigo, m2.papel, m2.codigo])
  ok(m3.papel === 'dono' && m3.codigo === null && m4.papel === null && m4.codigo === null && m4.usuario_nome === null, '/mensagens: sem pedido, papel vem do tipo da conta; sem conta, null')
  ok(m1.resumo === 'Pergunta sem resposta · 3529D “Entregar panfletos 1000 unidades em tod…”' && m2.resumo.startsWith('Profissional escolhido · 3529D') && m4.resumo === 'Mensagem de teste (painel)'
     && lm.mensagens.every(x => 'resposta' in x && x.resposta === null && !('_titulo' in x) && !('_total' in x)),
     '/mensagens: resumo curto (tipo · código “título”) e resposta = null até a Etapa 2', [m1.resumo, m4.resumo])

  // ---------- Watch Paths da Railway ----------
  const visto = new Set()
  const andar = (arq) => {
    if (visto.has(arq)) return
    visto.add(arq)
    for (const m of fs.readFileSync(arq, 'utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) andar(require.resolve(path.join(path.dirname(arq), m[1])))
  }
  andar(path.join(REPO, 'src/whatsapp/worker.js'))
  const rel = [...visto].map(a => path.relative(REPO, a).split(path.sep).join('/'))
  const coberto = (a) => C.WATCH_PATHS.some(w => (w.endsWith('/**') ? a.startsWith(w.slice(0, -2)) : a === w))
  const fora = rel.filter(a => !coberto(a))
  ok(fora.length === 0 && rel.includes('src/utils/supabase.js') && rel.includes('src/utils/auditoriaDemanda.js') && C.WATCH_PATHS.includes('package.json') && C.WATCH_PATHS.includes('package-lock.json'),
     'Watch Paths cobrem todo módulo que o worker importa (inclusive os compartilhados)', { fora, modulos: rel.length })
  ok(!rel.some(a => a.startsWith('src/routes/') || a.startsWith('src/services/') || a.startsWith('src/controllers/')), 'o worker não carrega rotas, controllers nem services da API')
  const pacote = require(path.join(REPO, 'package.json'))
  ok(pacote.scripts['start:whatsapp'] === 'node src/whatsapp/worker.js' && !pacote.scripts.start && /^\d/.test(pacote.dependencies.baileys), 'package.json: start:whatsapp, sem script start novo, Baileys em versão exata', pacote.dependencies.baileys)

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
