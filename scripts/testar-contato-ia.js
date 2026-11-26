#!/usr/bin/env node
// ANTI-CONTATO — CAMADA 2 (IA) (services/contatoIAService) — dono, 26/11/2026. IA FALSA (nada sai
// para a rede): o que passa pelas regras vai à IA; o achado dela tem o MESMO destino da camada 1
// (409 CONTATO_NO_TEXTO ao publicar/editar no app que suporta, "••••" em pergunta e resposta, só a
// marca no app antigo); 3 s de limite e fail-open em qualquer erro, demora, recusa, resposta
// estranha ou chave ausente; contadores no log; a chave nunca é impressa.
// A chamada DE VERDADE fica em scripts/chamar-contato-ia.js (precisa da ANTHROPIC_API_KEY).
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-contato-ia.js
process.env.JWT_SECRET = 'segredo-de-teste'
delete process.env.ANTHROPIC_API_KEY
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
const erros = [], logs = []
const silenciar = (v) => {
  console.log = v ? (...a) => { logs.push(a.map(String).join(' ')) } : logOrig
  console.warn = v ? () => {} : warnOrig
  console.error = v ? (...a) => { erros.push(a.map(x => x?.message || String(x)).join(' ')) } : errOrig
}
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const K = require(path.join(REPO, 'src/utils/contatoNoTexto'))
const IA = require(path.join(REPO, 'src/services/contatoIAService'))
const P = require(path.join(REPO, 'src/utils/penalidadesAuto'))
const { migrarWhatsapp } = require(path.join(REPO, 'src/whatsapp/migracao'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 200))
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

// IA FALSA: `responder(texto)` decide o que o "modelo" devolve. Guarda cada pedido recebido.
const pedidos = []
let responder = () => ({ contato: false, trecho: '' })
const falso = {
  messages: {
    create: async (corpo, opcoes) => {
      pedidos.push({ corpo, opcoes })
      const texto = String(corpo.messages[0].content).replace(/^<texto>\n/, '').replace(/\n<\/texto>$/, '')
      const r = await responder(texto)
      if (r && r.__bruto) return r.__bruto
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(r) }] }
    },
  },
}
// "Modelo" de mentira: acha contato quando o texto fala em "meu perfil" ou "número na foto".
const modeloSimples = (texto) => {
  const m = /olha (?:o )?meu perfil[^.!?\n]*|n[uú]mero (?:est[aá] )?na foto/i.exec(texto)
  return m ? { contato: true, trecho: m[0] } : { contato: false, trecho: '' }
}

const main = async () => {
  // ═══ 1. O SERVIÇO, SOZINHO ═════════════════════════════════════════════════════════════════
  ok(IA.MODELO === 'claude-haiku-5-5' && IA.TIMEOUT_MS === 3000, 'modelo Haiku atual e limite de 3 s', { m: IA.MODELO, t: IA.TIMEOUT_MS })
  IA.definirCliente(null)
  ok(IA.iaDisponivel() === false && (await IA.verificarContatoIA('me procura no face como Zé da Pintura')) === null && pedidos.length === 0 && IA.lerContadores().chamadas === 0,
     'sem ANTHROPIC_API_KEY: não chama nada e devolve null (fail-open); nem conta como chamada')
  IA.definirCliente(falso)
  responder = modeloSimples
  let r = await quieto(() => IA.verificarContatoIA('Pintura da sala. Olha meu perfil Zé das Tintas no face. Obrigado'))
  const p0 = pedidos[0]
  ok(r?.trecho === 'Olha meu perfil Zé das Tintas no face' && p0.corpo.model === 'claude-haiku-5-5' && p0.corpo.thinking.type === 'disabled' && p0.corpo.output_config.effort === 'low'
     && p0.corpo.output_config.format.type === 'json_schema' && p0.corpo.max_tokens <= 500 && p0.opcoes.timeout === 3000 && p0.opcoes.maxRetries === 0
     && /<texto>\nPintura da sala\./.test(p0.corpo.messages[0].content) && /tenta passar ou disfarçar um CONTATO/.test(p0.corpo.system) && !('temperature' in p0.corpo),
     'pedido à IA: Haiku, sem raciocínio, JSON, 3 s sem nova tentativa; a resposta devolve o trecho como está no texto', r)
  ok((await quieto(() => IA.verificarContatoIA('Trocar a torneira da cozinha'))) === null, 'texto comum: a IA diz que não é contato → null')
  ok((await quieto(() => IA.verificarContatoIA('oi'))) === null && (await quieto(() => IA.verificarContatoIA('   '))) === null && (await quieto(() => IA.verificarContatoIA(null))) === null && pedidos.length === 2,
     'texto curto demais, vazio ou não-texto: nem chama a IA')
  // Trecho que não está no texto (inventado) → descartado; a menos de caixa/espaços → aceito, com o texto do usuário.
  responder = () => ({ contato: true, trecho: '34 99999-0000' })
  ok((await quieto(() => IA.verificarContatoIA('Preciso de um pintor para a sala'))) === null, 'trecho que NÃO está no texto: descartado (null)')
  responder = () => ({ contato: true, trecho: 'me   PROCURA no  face' })
  r = await quieto(() => IA.verificarContatoIA('Oi! Me procura no face, sou a Bia'))
  ok(r?.trecho === 'Me procura no face', 'trecho com caixa/espaços diferentes: aceito, devolvido como o usuário escreveu', r)
  // FAIL-OPEN: erro, demora, recusa, resposta estranha.
  const falhar = async (rotulo, fn) => { responder = fn; const x = await quieto(() => IA.verificarContatoIA('Olha meu perfil no face, Zé das Tintas')); ok(x === null, `fail-open: ${rotulo} → null`, x) }
  await falhar('erro da API (500)', () => { const e = new Error('Internal'); e.status = 500; throw e })
  await falhar('erro de autenticação (401)', () => { const e = new Error('x-api-key: sk-ant-SEGREDO inválida'); e.status = 401; e.name = 'AuthenticationError'; throw e })
  await falhar('tempo esgotado', () => { const e = new Error('Request timed out.'); e.name = 'APIConnectionTimeoutError'; throw e })
  await falhar('recusa do modelo', () => ({ __bruto: { stop_reason: 'refusal', content: [] } }))
  await falhar('resposta que não é JSON', () => ({ __bruto: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sim, parece contato.' }] } }))
  await falhar('JSON sem o campo contato', () => ({ foo: 1 }))
  await falhar('resposta sem bloco de texto', () => ({ __bruto: { stop_reason: 'end_turn', content: [] } }))
  const c = IA.lerContadores()
  ok(c.chamadas === 11 && c.acertos === 2 && c.limpos === 1 && c.trecho_fora_do_texto === 1 && c.timeouts === 1 && c.recusas === 1 && c.erros === 5,
     'contadores: chamadas, acertos, limpos, erros, timeouts, recusas, trecho fora do texto', c)
  const linhas = logs.filter(l => l.startsWith('[contato IA]'))
  ok(linhas.length === 11 && /^\[contato IA\] contato \d+ms — chamadas=1 acertos=1 limpos=0 erros=0/.test(linhas[0]) && linhas.some(l => /timeout/.test(l)) && linhas.some(l => /erro\(401\)/.test(l)),
     'log: uma linha por chamada, com o desfecho, o tempo e os contadores', linhas[0])
  const tudo = [...logs, ...erros].join('\n')
  ok(!/sk-ant|SEGREDO/.test(tudo) && !/Zé das Tintas|Olha meu perfil/.test(linhas.join('\n')), 'o log nunca traz a chave nem o texto do usuário')

  // ═══ 2. NAS ROTAS ══════════════════════════════════════════════════════════════════════════
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`
    CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_push_entregas_uq ON push_entregas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_configuracoes_uq ON configuracoes (chave);
    CREATE UNIQUE INDEX t_reparos_crid_uq ON reparos (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE UNIQUE INDEX t_obras_crid_uq ON obras (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE UNIQUE INDEX t_perguntas_uq ON perguntas_demanda (tipo, demanda_id, autor_id);
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true'), ('email_resumo_diario', 'false');
  `).catch(async (e) => { if (!/already exists/.test(e.message)) throw e })
  await P.migrarPenalidadesAuto(shim)
  await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT')
  let nUsr = 0
  const usr = async (nome, role, extra = {}) => {
    const n = ++nUsr
    const cc = { id: U(n), nome, email: `u${n}@x.invalid`, role, cpf_cnpj: String(n).padStart(11, '0'), ativo: true, cidade: 'Patos de Minas', uf: 'MG', telefone: `349${String(90000000 + n)}`,
      push_token: `ExponentPushToken[u${n}]`, ...(role === 'prestador' ? { tipo_prestador: 'reparador', especialidades: ['eletrica'] } : { tipo_dono: 'reparo' }), ...extra }
    const ks = Object.keys(cc)
    await q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => cc[k]))
    if (role === 'prestador') await q(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [cc.id])
    return { id: cc.id, role, nome }
  }
  const ADM = await usr('Admin', 'admin')
  const maria = await usr('Maria', 'dono_obra'), joana = await usr('Joana Antiga', 'dono_obra'), rita = await usr('Rita', 'dono_obra'), pro = await usr('Ana Pro', 'prestador')
  const corpoReparo = (extra = {}) => ({ titulo: 'Pintar a sala', descricao: 'Duas paredes', categoria: 'eletrica', cidade: 'Patos de Minas', uf: 'MG', valor_estimado: 120, ...extra })
  const corpoObra = (extra = {}) => ({ titulo: 'Reforma do banheiro', descricao: 'Trocar piso e louças', categoria: 'residencial', cidade: 'Patos de Minas', uf: 'MG', valor: 5000, ...extra })
  const contar = async (tabela, donoX) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE criado_por = $1`, [donoX.id])).rows[0].n
  responder = modeloSimples
  IA.zerarContadores(); pedidos.length = 0

  r = await chamar('post', '/reparos/dono', { usuario: maria, body: corpoReparo({ descricao: 'Duas paredes. Olha meu perfil Maria Tintas no face', suporta_contato_no_texto: true }) })
  ok(r.status === 409 && r.body.codigo === 'CONTATO_NO_TEXTO' && r.body.tipo === 'ia' && r.body.trecho === 'Olha meu perfil Maria Tintas no face' && r.body.campo === 'texto' && /Olha meu perfil/.test(r.body.erro) && (await contar('reparos', maria)) === 0,
     'publicar (app com suporte), contato que só a IA pega: 409 CONTATO_NO_TEXTO com o trecho, NADA gravado', r.body)
  const antes = pedidos.length
  r = await chamar('post', '/reparos/dono', { usuario: maria, body: corpoReparo({ descricao: 'me chama no zap 34 99881-7102', suporta_contato_no_texto: true }) })
  ok(r.status === 409 && r.body.tipo !== 'ia' && pedidos.length === antes, 'o que as REGRAS já pegam não vai à IA (nenhuma chamada)', { tipo: r.body?.tipo, chamadas: pedidos.length - antes })
  r = await chamar('post', '/reparos/dono', { usuario: maria, body: corpoReparo({ suporta_contato_no_texto: true }) })
  ok(r.status === 201 && r.body.contato_no_texto === false && pedidos.length === antes + 1 && /Pintar a sala\nDuas paredes/.test(pedidos[pedidos.length - 1].corpo.messages[0].content),
     'pedido limpo: passa pelas regras, vai à IA (uma chamada com título + descrição) e publica', r.status)
  r = await chamar('post', '/reparos/dono', { usuario: joana, body: corpoReparo({ descricao: 'O número está na foto do perfil' }) })
  let d = (await q(`SELECT * FROM reparos WHERE criado_por = $1`, [joana.id])).rows[0]
  ok(r.status === 201 && d.contato_no_texto === true && d.contato_no_texto_trecho === 'número está na foto' && d.contato_no_texto_telefone === null, 'app antigo: publica e fica MARCADO com o trecho da IA', { s: r.status, t: d?.contato_no_texto_trecho })
  r = await chamar('post', '/obras/dono', { usuario: maria, body: corpoObra({ ponto_referencia: 'Perto da padaria, olha meu perfil Maria Obras', suporta_contato_no_texto: true }) })
  ok(r.status === 409 && r.body.tipo === 'ia' && r.body.campo === 'ponto_referencia' && (await contar('obras', maria)) === 0, 'obra, contato no ponto de referência que só a IA pega: 409 com o campo certo', r.body)
  r = await chamar('post', '/obras/dono', { usuario: maria, body: corpoObra({ suporta_contato_no_texto: true }) })
  ok(r.status === 201, 'obra limpa: publica', r.status)
  const OBRA = r.body.id
  r = await chamar('put', '/obras/:id', { usuario: ADM, params: { id: OBRA }, body: { descricao: 'Trocar piso. Número na foto' } })
  ok(r.status === 409 && r.body.codigo === 'CONTATO_NO_TEXTO' && r.body.tipo === 'ia' && (await q(`SELECT descricao FROM obras WHERE id = $1`, [OBRA])).rows[0].descricao === 'Trocar piso e louças', 'editar (PUT /obras/:id): contato que só a IA pega → 409, nada gravado', r.body?.trecho)
  r = await chamar('patch', '/obras/dono/:id/ponto-referencia', { usuario: maria, params: { id: OBRA }, body: { ponto_referencia: 'Portão azul, olha meu perfil Maria', suporta_contato_no_texto: true } })
  ok(r.status === 409 && r.body.campo === 'ponto_referencia' && r.body.tipo === 'ia', 'PATCH do ponto de referência: idem', r.body?.trecho)

  // Pergunta e resposta: o trecho da IA vira "••••".
  const REP = (await q(`SELECT id FROM reparos WHERE criado_por = $1 LIMIT 1`, [maria.id])).rows[0].id
  r = await chamar('post', '/reparos/:id/perguntas', { usuario: pro, params: { id: REP }, body: { pergunta: 'Posso ir hoje? Olha meu perfil Ana Elétrica no insta' } })
  ok(r.status === 201 && r.body.pergunta === 'Posso ir hoje? Olha meu perfil Ana Elétrica no ••••', 'pergunta em que as REGRAS já mascaram algo ("insta"): fica com a máscara das regras, a IA não é consultada', r.body?.pergunta)
  const pro2 = await usr('Beto Pro', 'prestador')
  r = await chamar('post', '/reparos/:id/perguntas', { usuario: pro2, params: { id: REP }, body: { pergunta: 'Posso ir hoje? Olha meu perfil Beto Elétrica. Abraço' } })
  let pq = (await q(`SELECT * FROM perguntas_demanda WHERE autor_id = $1`, [pro2.id])).rows[0]
  ok(r.status === 201 && r.body.pergunta === 'Posso ir hoje? ••••. Abraço' && pq.pergunta === r.body.pergunta, 'pergunta que só a IA pega: o trecho vira "••••" e o resto fica', r.body?.pergunta)
  r = await chamar('post', '/reparos/:id/perguntas/:pid/resposta', { usuario: maria, params: { id: REP, pid: pq.id }, body: { resposta: 'Pode sim. O número está na foto' } })
  ok(r.status === 200 && r.body.resposta === 'Pode sim. O ••••', 'resposta que só a IA pega: mascarada e gravada', r.body?.resposta)
  const pro3 = await usr('Caio Pro', 'prestador')
  r = await chamar('post', '/reparos/:id/perguntas', { usuario: pro3, params: { id: REP }, body: { pergunta: 'A tinta é por sua conta?' } })
  ok(r.status === 201 && r.body.pergunta === 'A tinta é por sua conta?', 'pergunta comum: gravada como foi escrita', r.body?.pergunta)

  // FAIL-OPEN nas rotas: IA fora do ar, lenta ou sem chave → publica/grava como se a IA não existisse.
  responder = () => { const e = new Error('boom'); e.status = 529; throw e }
  r = await chamar('post', '/reparos/dono', { usuario: rita, body: corpoReparo({ descricao: 'Olha meu perfil Rita no face', suporta_contato_no_texto: true }) })
  ok(r.status === 201 && r.body.contato_no_texto === false, 'IA com erro: o pedido publica (nunca bloqueia por falha da IA)', r.status)
  responder = () => new Promise((_, rej) => setTimeout(() => { const e = new Error('Request timed out.'); e.name = 'APIConnectionTimeoutError'; rej(e) }, 50))
  const pro4 = await usr('Duda Pro', 'prestador')
  r = await chamar('post', '/reparos/:id/perguntas', { usuario: pro4, params: { id: REP }, body: { pergunta: 'Olha meu perfil Duda no face' } })
  ok(r.status === 201 && r.body.pergunta === 'Olha meu perfil Duda no face', 'IA sem responder a tempo: a pergunta é gravada como veio', r.body?.pergunta)
  IA.definirCliente(null)
  const n0 = pedidos.length
  r = await chamar('post', '/obras/dono', { usuario: rita, body: corpoObra({ descricao: 'Olha meu perfil Rita Obras', suporta_contato_no_texto: true }) })
  ok(r.status === 201 && pedidos.length === n0, 'sem chave: só a camada 1 — publica sem chamar a IA', r.status)

  const inesperados = erros.filter(x => !/ENOTFOUND|geoBusca|sem banco|PAGBANK|webhook/i.test(x))
  ok(inesperados.length === 0, 'nenhum erro inesperado no log', inesperados.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
