#!/usr/bin/env node
// ANTI-CONTATO (utils/contatoNoTexto) — dono, 26/11/2026. Camada 1 (regras):
//  1) detector: telefones disfarçados (por extenso, "meia", O no lugar de 0, espaços/pontos/traços/
//     emojis no meio, até 3 linhas), e-mail (inclusive "arroba … ponto com"), @perfil, link, wa.me e
//     frases de convite; e o que NÃO é contato (valor, CEP, CPF, medidas, anos, texto comum);
//  2) publicar: app com suporta_contato_no_texto → 409 CONTATO_NO_TEXTO com o trecho, nada gravado;
//     app antigo → publica marcado (contato_no_texto + trecho); editar obra (PUT /obras/:id);
//  3) pergunta e resposta: o trecho vira "••••" e é gravado;
//  4) varredura única dos pedidos abertos (migração); listas do painel com a marca e o trecho;
//  5) robô de WhatsApp 'contato_no_texto': desligado por padrão, janela 08–21h, SAIR, uma vez por
//     pedido, telefone da conta ou o do texto, texto exato.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; rotas reais; Expo/Brevo falsos; adaptador falso.
//   npm i -D @electric-sql/pglite && node scripts/testar-contato-no-texto.js
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
const K = require(path.join(REPO, 'src/utils/contatoNoTexto'))
const C = require(path.join(REPO, 'src/whatsapp/config'))
const T = require(path.join(REPO, 'src/whatsapp/textos'))
const F = require(path.join(REPO, 'src/whatsapp/fila'))
const { migrarWhatsapp } = require(path.join(REPO, 'src/whatsapp/migracao'))
const { registrarRecebida } = require(path.join(REPO, 'src/whatsapp/entrada'))
const SC = require(path.join(REPO, 'src/services/whatsappContatoNoTextoService'))
const SP = require(path.join(REPO, 'src/services/whatsappPerguntasService'))
const P = require(path.join(REPO, 'src/utils/penalidadesAuto'))
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
const REAL = new Date()
let AGORA = REAL
if (!C.dentroDaJanela(REAL)) { AGORA = new Date(REAL); AGORA.setUTCHours(11, 30, 0, 0); if (AGORA <= REAL) AGORA = new Date(AGORA.getTime() + 24 * 3600000) }
const NOITE = new Date(AGORA); NOITE.setUTCHours(2, 0, 0, 0) // 23:00 em São Paulo

// ═══ 1. DETECTOR (funções puras) ═══════════════════════════════════════════════════════════════
const detector = () => {
  const TELEFONES = [
    '3quatro nove999 cinco 8dois meia 2',
    '34 99881-7102', '(34) 99881-7102', '+55 34 9 9881 7102', '34.99881.7102', '9 9 8 8 1 7 1 0 2', '99881 7102',
    'três quatro nove nove oito oito um sete um zero dois',
    'TRES QUATRO NOVE NOVE OITO OITO UM SETE UM ZERO DOIS',
    'nove nove oito oito um sete um zero dois',
    'meia meia 9 9 8 8 meia 1 0 2',
    '34 nove nove 881 7102',
    '9988O71O2', '99 88 O 71 O2',
    '9-9-8-8-1-7-1-0-2', '9.9.8.8.1.7.1.0.2', '9_9_8_8_1_7_1_0_2',
    '9️⃣9️⃣8️⃣8️⃣1️⃣7️⃣1️⃣0️⃣2️⃣', '34😀9😀9881😀7102', '34 ✨ 99881 ✨ 7102',
    'meu numero:\n34 9988\n1 7102',
    '34\n99881\n7102',
    'trinta nao, mas 3 4 nove 9 oito 8 um 7 um zero 2',
    'Preciso de pintor. Falar com Zé 349988-17102 a tarde',
    '３４９９８８１７１０２',
    '0 34 99881 7102',
    'duas duas nove nove oito oito uma sete',
  ]
  const naoAchou = TELEFONES.filter(t => K.detectarContato(t)?.tipo !== 'telefone' && !(K.detectarContato(t)?.trechos || []).length)
  ok(naoAchou.length === 0, `telefones disfarçados: os ${TELEFONES.length} exemplos são pegos`, naoAchou)
  const semTel = TELEFONES.filter(t => !K.encontrarContatos(t).some(a => a.tipo === 'telefone'))
  ok(semTel.length === 0, 'todos classificados como telefone', semTel)
  const a = K.detectarContato('3quatro nove999 cinco 8dois meia 2')
  ok(a.trecho === '3quatro nove999 cinco 8dois meia 2' && a.telefone === '+5534999958262', 'exemplo do dono: trecho inteiro e o número lido (34 99995-8262)', a)
  ok(K.detectarContato('Trocar torneira', 'ligar 34 9988\n1 7102 depois das 18h').trecho === '34 9988\n1 7102', 'número partido em duas linhas: um trecho só')
  ok(K.detectarContato('Pintura 34 9988', '1 7102 urgente')?.tipo === 'telefone', 'número partido entre o título e a descrição')
  ok(K.detectarContato('1\n2\n3\n4\n5\n6\n7\n8\n9') === null, 'um dígito por linha em 9 linhas: passa de 3 linhas, não emenda')

  const OUTROS = [
    ['joao.silva@gmail.com', 'email'], ['joao arroba gmail ponto com', 'email'], ['joao (at) hotmail.com', 'email'], ['joao @ gmail ponto com ponto br', 'email'],
    ['manda no gmail ponto com do joao', 'email'], ['JOAO@EMPRESA.COM.BR', 'email'],
    ['me segue @joao_pinta', 'perfil'], ['insta: @ze.reformas', 'convite'],
    ['https://meusite.com/orcamento', 'link'], ['www.reformas.net', 'link'], ['wa.me/message/ABCDEF', 'link'], ['veja em reformasdoze.com.br', 'link'],
    ['meusite ponto com', 'link'], ['api.whatsapp.com/send?phone=55', 'link'], ['t.me/zepintor', 'link'],
    ['me chama no zap', 'convite'], ['chama no whats', 'convite'], ['Tem WhatsApp?', 'convite'], ['me chame por favor', 'convite'], ['passo meu número', 'convite'],
    ['liga pra mim', 'convite'], ['liga para mim hoje', 'convite'], ['me liga depois', 'convite'], ['falo pelo wpp', 'convite'], ['zapzap', 'convite'], ['telegram', 'convite'],
  ]
  const errados = OUTROS.filter(([t, tipo]) => K.detectarContato(t)?.tipo !== tipo).map(([t]) => [t, K.detectarContato(t)?.tipo ?? null])
  ok(errados.length === 0, `e-mail, @perfil, link, wa.me e frases de convite: ${OUTROS.length} exemplos`, errados)

  const LIMPOS = [
    'Pintar sala 3x4 e dois quartos, R$ 1.500,00', 'Orçamento entre 10.000 - 15.000', 'R$ 15.000.000', 'Valor 12.500.000,00',
    'CEP 38700-000, casa 120', 'Rua 15 de Novembro, 1234, apto 301', 'CPF 123.456.789-09', 'reforma 2025-2026',
    'Instalar ar de 12000 btus em 2 quartos', 'Preciso de um pintor para dois quartos e três banheiros', 'Aula particular de matemática 9º ano',
    'Trocar 12 portas, 20 janelas e 10 m de rodapé', 'Dia 25/11/2026 às 14:30', 'Casa de 120 m², 3 quartos, 2 banheiros, 1 sala',
    'Instalar tomada na cozinha', 'Conserto do meu celular que caiu', 'Instalação de chuveiro', 'A campainha não chama', 'Formatar computador e instalar programas',
    'Uma parede de 2,50 x 3,00 e outra de 4,00 x 2,80', 'Medidas: 2 por 3, depois 4 por 5, depois 6 por 7 e 8 por 9', '[contato removido]', '••••',
    'Montar 1 guarda-roupa de 6 portas e 2 camas', 'Preciso para hoje, entre 8 e 18 horas',
  ]
  const falsos = LIMPOS.filter(t => K.detectarContato(t)).map(t => [t, K.detectarContato(t).trecho])
  ok(falsos.length === 0, `não é contato: ${LIMPOS.length} textos comuns (valor, CEP, CPF, medidas, datas, anos)`, falsos)

  ok(K.detectarContato('fala em wa.me/5534998817102 ok').trecho === 'wa.me/5534998817102', 'wa.me com o número: um trecho só, com o link inteiro')
  let m = K.mascararContatos('Oi, me chama no zap 34 9 9881-7102 ok?')
  ok(m.removido && m.texto === 'Oi, •••• no •••• •••• ok?' && m.trechos.length === 3, 'máscara: cada trecho vira "••••", o resto fica', m)
  m = K.mascararContatos('A tinta é por sua conta?')
  ok(m.removido === false && m.texto === 'A tinta é por sua conta?', 'máscara: texto sem contato volta igual')
  m = K.mascararContatos('meu e-mail é ze arroba gmail ponto com, obrigado')
  ok(m.texto === 'meu e-mail é ••••, obrigado', 'máscara: e-mail falado', m.texto)
  ok(K.decidirContato({ suporta_contato_no_texto: true }, K.detectarContato('zap')).barrar?.codigo === 'CONTATO_NO_TEXTO'
     && K.decidirContato({ suporta_contato_no_texto: 'true' }, K.detectarContato('zap')).barrar?.trecho === 'zap'
     && K.decidirContato({}, K.detectarContato('zap')).marcar?.trecho === 'zap'
     && K.decidirContato({ suporta_contato_no_texto: false }, K.detectarContato('zap')).marcar
     && JSON.stringify(K.decidirContato({ suporta_contato_no_texto: true }, null)) === '{}',
     'decisão: app com suporte → barra (409); sem o campo (app antigo) → marca; sem contato → nada')
}

const main = async () => {
  detector()

  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`
    CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_push_entregas_uq ON push_entregas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_configuracoes_uq ON configuracoes (chave);
    CREATE UNIQUE INDEX t_acima_teto_uq ON avisos_acima_do_teto (tabela, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_fora_area_uq ON avisos_fora_area (tabela, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_reparos_crid_uq ON reparos (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE UNIQUE INDEX t_obras_crid_uq ON obras (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE UNIQUE INDEX t_perguntas_uq ON perguntas_demanda (tipo, demanda_id, autor_id);
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true'), ('email_resumo_diario', 'false');
  `).catch(async (e) => { if (!/already exists/.test(e.message)) throw e })
  await P.migrarPenalidadesAuto(shim)
  await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT')
  // A fixture já traz as colunas: aqui valem as da migração de boot.
  await db.exec(`ALTER TABLE reparos DROP COLUMN contato_no_texto, DROP COLUMN contato_no_texto_trecho, DROP COLUMN contato_no_texto_telefone, DROP COLUMN contato_no_texto_em;
    ALTER TABLE obras DROP COLUMN contato_no_texto, DROP COLUMN contato_no_texto_trecho, DROP COLUMN contato_no_texto_telefone, DROP COLUMN contato_no_texto_em;`)

  const usr = async (n, nome, role, extra = {}) => {
    const c = { id: U(n), nome, email: `u${n}@x.invalid`, role, cpf_cnpj: String(n).padStart(11, '0'), ativo: true, cidade: 'Patos de Minas', uf: 'MG', telefone: `349${String(90000000 + n)}`,
      push_token: `ExponentPushToken[u${n}]`, ...(role === 'prestador' ? { tipo_prestador: 'reparador', especialidades: ['eletrica'] } : { tipo_dono: 'reparo' }), ...extra }
    const ks = Object.keys(c)
    await q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => c[k]))
    if (role === 'prestador') await q(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [c.id])
    return { id: c.id, role, nome, tipo_prestador: c.tipo_prestador }
  }
  const ADM = await usr(900, 'Admin', 'admin')
  const maria = await usr(1, 'Maria Cliente', 'dono_obra')
  const joana = await usr(2, 'Joana Antiga', 'dono_obra')
  const semTel = await usr(3, 'Íris Sem Telefone', 'dono_obra', { telefone: null })
  const saiu = await usr(4, 'Pedro Saiu', 'dono_obra', { whatsapp_avisos: false })
  const velho = await usr(5, 'Vera Varredura', 'dono_obra')
  const pro = await usr(10, 'Ana Pro', 'prestador')

  let nDemanda = 0
  const demanda = async (tabela, criadoPor, titulo, extra = {}) => {
    const id = D(++nDemanda)
    const c = { id, titulo, criado_por: criadoPor.id, status: 'aberta', status_aprovacao: 'aprovada', cidade: 'Patos de Minas', uf: 'MG',
      ...(tabela === 'reparos' ? { categoria: 'eletrica', categorias: ['eletrica'], valor_estimado: 100 } : { categoria: 'residencial', valor: 1000 }), ...extra }
    const ks = Object.keys(c)
    await q(`INSERT INTO ${tabela} (${ks.join(', ')}, expira_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, NOW() + INTERVAL '48 hours')`, ks.map(k => c[k]))
    return id
  }
  const linha = async (tabela, id) => (await q(`SELECT * FROM ${tabela} WHERE id = $1`, [id])).rows[0]

  // ═══ 4. VARREDURA ÚNICA (antes de tudo: é a migração de boot) ═══════════════════════════════
  const V1 = await demanda('reparos', velho, 'Trocar chuveiro', { descricao: 'falar no tres quatro nove nove oito oito um sete um zero dois' })
  const V2 = await demanda('obras', velho, 'Reforma zap 3498817102')
  const V3 = await demanda('reparos', velho, 'Instalar tomada', { descricao: 'Na cozinha, 2 pontos' })
  const V4 = await demanda('reparos', velho, 'Fechado com telefone 34 99881-7102', { status: 'encerrada' })
  const V5 = await demanda('obras', velho, 'Pendente me chama no whats', { status: 'rascunho', status_aprovacao: 'pendente', enviada_por_dono: true })
  silenciar(true)
  const v1 = await K.migrarContatoNoTexto(shim)
  const v2 = await K.migrarContatoNoTexto(shim)
  silenciar(false)
  const colunas = (await q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE column_name LIKE 'contato_no_texto%' AND table_name IN ('reparos', 'obras')`)).rows[0].n
  ok(colunas === 8 && v1 && v1.analisados === 4 && v1.marcados === 3 && v1.reparos === 1 && v1.obras === 2 && v2 === null,
     'migração: 4 colunas em reparos e obras; varredura única dos abertos — 3 de 4 marcados; a 2ª chamada não varre de novo', { colunas, v1, v2 })
  const cfg = (await q(`SELECT valor FROM configuracoes WHERE chave = $1`, [K.CHAVE_VARREDURA])).rows[0]
  ok(JSON.parse(cfg.valor).marcados === 3, 'resultado da varredura guardado em configuracoes', cfg.valor)
  let d = await linha('reparos', V1)
  ok(d.contato_no_texto === true && d.contato_no_texto_trecho === 'tres quatro nove nove oito oito um sete um zero dois' && d.contato_no_texto_telefone === '+5534998817102' && !!d.contato_no_texto_em,
     'pedido aberto com telefone por extenso: marcado, com o trecho e o número lido', { t: d.contato_no_texto_trecho, tel: d.contato_no_texto_telefone })
  ok((await linha('obras', V2)).contato_no_texto === true && (await linha('reparos', V3)).contato_no_texto === false && (await linha('reparos', V4)).contato_no_texto === false && (await linha('obras', V5)).contato_no_texto === true,
     'obra aberta e obra esperando aprovação: marcadas; pedido limpo e pedido fechado: não')

  // ═══ 2. PUBLICAR E EDITAR ═══════════════════════════════════════════════════════════════════
  const corpoReparo = (extra = {}) => ({ titulo: 'Instalar tomada na cozinha', categoria: 'eletrica', cidade: 'Patos de Minas', uf: 'MG', valor_estimado: 120, ...extra })
  const corpoObra = (extra = {}) => ({ titulo: 'Reforma do banheiro', descricao: 'Trocar piso e louças', categoria: 'residencial', cidade: 'Patos de Minas', uf: 'MG', valor: 5000, ...extra })
  const contar = async (tabela, donoX) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE criado_por = $1`, [donoX.id])).rows[0].n
  const DISFARCADO = 'Qualquer coisa 3quatro nove999 cinco 8dois meia 2'
  let r = await chamar('post', '/reparos/dono', { usuario: maria, body: corpoReparo({ descricao: DISFARCADO, suporta_contato_no_texto: true }) })
  ok(r.status === 409 && r.body.codigo === 'CONTATO_NO_TEXTO' && r.body.contato_no_texto === true && r.body.trecho === '3quatro nove999 cinco 8dois meia 2' && r.body.tipo === 'telefone'
     && /3quatro nove999/.test(r.body.erro) && (await contar('reparos', maria)) === 0,
     'POST /reparos/dono com telefone disfarçado (app com suporte): 409 CONTATO_NO_TEXTO com o trecho, NADA gravado', r)
  r = await chamar('post', '/reparos/dono', { usuario: maria, body: corpoReparo({ titulo: 'Eletricista, me chama no zap', suporta_contato_no_texto: true }) })
  ok(r.status === 409 && r.body.codigo === 'CONTATO_NO_TEXTO' && r.body.tipo === 'convite' && r.body.trechos.length === 2 && (await contar('reparos', maria)) === 0, 'frase de convite no título: 409, nada gravado', r.body)
  r = await chamar('post', '/reparos/dono', { usuario: maria, body: corpoReparo({ descricao: 'Duas tomadas, R$ 120 cada, CEP 38700-000', suporta_contato_no_texto: true }) })
  ok(r.status === 201 && r.body.contato_no_texto === false && r.body.contato_no_texto_trecho == null, 'pedido limpo (com valor e CEP): publica, sem marca', r.status)
  r = await chamar('post', '/obras/dono', { usuario: maria, body: corpoObra({ descricao: 'orçamento no email maria arroba gmail ponto com', suporta_contato_no_texto: true }) })
  ok(r.status === 409 && r.body.codigo === 'CONTATO_NO_TEXTO' && r.body.tipo === 'email' && r.body.trecho === 'maria arroba gmail ponto com' && (await contar('obras', maria)) === 0, 'POST /obras/dono com e-mail falado: 409, nada gravado', r.body)
  r = await chamar('post', '/obras/dono', { usuario: maria, body: corpoObra({ suporta_contato_no_texto: true }) })
  ok(r.status === 201 && r.body.contato_no_texto === false, 'obra limpa: publica', r.status)
  const OBRA_MARIA = r.body.id
  // Venda com valor zero continua sendo o 400 da moderação (antes do anti-contato).
  r = await chamar('post', '/reparos/dono', { usuario: maria, body: corpoReparo({ titulo: 'Vendo marmita, peça no zap', valor_estimado: 0, suporta_contato_no_texto: true }) })
  ok(r.status === 400 && r.body.codigo === 'anuncio_nao_permitido', 'anúncio de venda com valor zero: continua 400 da moderação', r.body)

  // App antigo: publica como sempre (a moderação mascara o que pega) e MARCA.
  r = await chamar('post', '/reparos/dono', { usuario: joana, body: corpoReparo({ descricao: DISFARCADO }) })
  d = (await q(`SELECT * FROM reparos WHERE criado_por = $1`, [joana.id])).rows[0]
  ok(r.status === 201 && r.body.contato_no_texto === true && r.body.contato_no_texto_trecho === '3quatro nove999 cinco 8dois meia 2' && d.contato_no_texto === true
     && d.contato_no_texto_telefone === '+5534999958262' && d.status === 'aberta',
     'app antigo (sem o campo): publica e fica MARCADO com o trecho e o número, para o painel', { status: r.status, trecho: d?.contato_no_texto_trecho })
  const R_JOANA = d.id
  r = await chamar('post', '/obras/dono', { usuario: semTel, body: corpoObra({ titulo: 'Pintura da casa', descricao: 'Falar comigo: 34 99777-1234' }) })
  d = (await q(`SELECT * FROM obras WHERE criado_por = $1`, [semTel.id])).rows[0]
  ok(r.status === 201 && d.contato_no_texto === true && d.contato_no_texto_trecho === '34 99777-1234' && d.contato_no_texto_telefone === '+5534997771234' && /\[contato removido\]/.test(d.descricao),
     'obra de app antigo: marcada pelo texto ORIGINAL; a moderação segue mascarando o que grava', { desc: d?.descricao, trecho: d?.contato_no_texto_trecho })
  const O_SEMTEL = d.id
  await q(`UPDATE obras SET status = 'aberta', status_aprovacao = 'aprovada' WHERE id = $1`, [O_SEMTEL])

  // Editar (PUT /obras/:id — a única rota que edita título/descrição).
  r = await chamar('put', '/obras/:id', { usuario: ADM, params: { id: OBRA_MARIA }, body: { descricao: 'Trocar piso. whats nove nove oito oito um sete um zero dois' } })
  d = await linha('obras', OBRA_MARIA)
  ok(r.status === 409 && r.body.codigo === 'CONTATO_NO_TEXTO' && d.descricao === 'Trocar piso e louças', 'PUT /obras/:id com contato: 409, nada gravado', r.body)
  r = await chamar('put', '/obras/:id', { usuario: ADM, params: { id: OBRA_MARIA }, body: { titulo: 'Reforma 34 9988' } })
  ok(r.status === 200 && r.body.titulo === 'Reforma 34 9988', 'editar com número curto: passa', r.status)
  r = await chamar('put', '/obras/:id', { usuario: ADM, params: { id: OBRA_MARIA }, body: { descricao: '1 7102 urgente' } })
  ok(r.status === 409 && r.body.tipo === 'telefone', 'editar só a descrição completando o número do título gravado: 409', r.body?.trecho)
  r = await chamar('put', '/obras/:id', { usuario: ADM, params: { id: V2 }, body: { titulo: 'Reforma da cozinha' } })
  d = await linha('obras', V2)
  ok(r.status === 200 && d.contato_no_texto === false && d.contato_no_texto_trecho === null && d.contato_no_texto_telefone === null, 'editar tirando o contato: a marca do pedido sai', { s: r.status, m: d.contato_no_texto })
  r = await chamar('put', '/obras/:id', { usuario: ADM, params: { id: V5 }, body: { valor: 2000 } })
  ok(r.status === 200 && (await linha('obras', V5)).contato_no_texto === true, 'editar outro campo (valor): não mexe na marca', r.status)

  // ═══ 3. PERGUNTA E RESPOSTA ═════════════════════════════════════════════════════════════════
  r = await chamar('post', '/reparos/:id/perguntas', { usuario: pro, params: { id: V3 }, body: { pergunta: 'Posso ver hoje? me chama no zap tres quatro 99881 sete um zero dois' } })
  let pq = (await q(`SELECT * FROM perguntas_demanda WHERE demanda_id = $1`, [V3])).rows[0]
  ok(r.status === 201 && r.body.pergunta === 'Posso ver hoje? •••• no •••• ••••' && pq.pergunta === r.body.pergunta, 'pergunta com contato: o trecho vira "••••" e é gravada', r.body?.pergunta)
  r = await chamar('post', '/reparos/:id/perguntas/:pid/resposta', { usuario: velho, params: { id: V3, pid: pq.id }, body: { resposta: 'Pode sim, meu email é vera arroba gmail ponto com' } })
  pq = (await q(`SELECT * FROM perguntas_demanda WHERE id = $1`, [pq.id])).rows[0]
  ok(r.status === 200 && r.body.resposta === 'Pode sim, meu email é ••••' && pq.resposta === r.body.resposta, 'resposta com contato: mascarada e gravada', r.body?.resposta)
  r = await chamar('post', '/obras/:id/perguntas', { usuario: pro, params: { id: O_SEMTEL }, body: { pergunta: 'A tinta é por sua conta? São 3 quartos de 12 m²?' } })
  ok(r.status === 201 && r.body.pergunta === 'A tinta é por sua conta? São 3 quartos de 12 m²?', 'pergunta sem contato: gravada como foi escrita', r.body?.pergunta)

  // ═══ 4b. PAINEL ═════════════════════════════════════════════════════════════════════════════
  r = await chamar('get', '/reparos/admin', { usuario: ADM, query: { filtro: 'abertas' } })
  let noPainel = (r.body?.reparos || []).find(x => x.id === R_JOANA)
  ok(noPainel?.contato_no_texto === true && noPainel.contato_no_texto_trecho === '3quatro nove999 cinco 8dois meia 2' && (r.body.reparos.find(x => x.id === V3)?.contato_no_texto === false),
     'GET /reparos/admin: contato_no_texto e o trecho na linha', noPainel && { m: noPainel.contato_no_texto, t: noPainel.contato_no_texto_trecho })
  r = await chamar('get', '/obras/admin', { usuario: ADM, query: { filtro: 'abertas' } })
  noPainel = (r.body?.obras || []).find(x => x.id === O_SEMTEL)
  ok(noPainel?.contato_no_texto === true && noPainel.contato_no_texto_trecho === '34 99777-1234', 'GET /obras/admin: contato_no_texto e o trecho na linha', noPainel && { m: noPainel.contato_no_texto, t: noPainel.contato_no_texto_trecho })
  r = await chamar('get', '/obras-aprovacao', { usuario: ADM })
  noPainel = (r.body?.obras || []).find(x => x.id === V5)
  ok(noPainel?.contato_no_texto === true && typeof noPainel.contato_no_texto_trecho === 'string', 'GET /obras-aprovacao: a marca e o trecho também', noPainel && noPainel.contato_no_texto_trecho)

  // ═══ 5. ROBÔ DE WHATSAPP ════════════════════════════════════════════════════════════════════
  const def = C.TIPOS.contato_no_texto
  ok(def && def.padrao === false && def.implementado === true && def.sozinho === true && !def.sempreLigado && C.TIPO_CONTATO === 'contato_no_texto', 'tipo contato_no_texto: desligado por padrão, implementado, uma mensagem por linha', def)
  const TEXTO = 'Olá! 👋 Aqui é o *ProTudo*.\n\nVimos seu pedido *"Trocar chuveiro"* e queremos te ajudar a aproveitar melhor o app. 😊\n\nO ProTudo *tem sim* espaço para tirar dúvidas: os profissionais interessados enviam *perguntas* no seu pedido, você recebe uma notificação e responde por lá. As perguntas e respostas ficam no seu pedido e vão deixando tudo mais claro para todos.\n\nPor isso, pedimos que você *retire seu telefone da descrição*. E mesmo que combine algo com um profissional pelo WhatsApp, peça para ele *manifestar interesse dentro do app* e sigam por lá. Assim *os dois ficam protegidos* pela plataforma.\n\nNo ProTudo, conferimos a identidade, os documentos e as *referências* de cada profissional. Em breve teremos *cursos* em todas as especialidades, e quem concluir ganha o selo de *especialista*, o que ajuda você na hora de escolher.\n\nQualquer dúvida, é só responder aqui. Obrigado por usar o ProTudo! 🧡'
  ok(T.textoContatoNoTexto('Trocar chuveiro') === TEXTO, 'texto aprovado pelo dono, exato')
  const fila = async (where = 'true') => (await q(`SELECT * FROM whatsapp_mensagens WHERE tipo = 'contato_no_texto' AND ${where} ORDER BY id`)).rows
  const config = (chave, valor) => q(`WITH u AS (UPDATE configuracoes SET valor = $2 WHERE chave = $1 RETURNING 1) INSERT INTO configuracoes (chave, valor) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM u)`, [chave, valor])
  const f = criarFalso()
  const passo = (agora = AGORA) => F.processarProxima({ db: shim, adaptador: f, agora, env: ENV })
  const job = (agora = AGORA) => SC.enfileirarContatoNoTexto(shim, { agora })
  // Pedido marcado de quem respondeu SAIR.
  const R_SAIU = await demanda('reparos', saiu, 'Pintar portão zap 34 99555-0000', { contato_no_texto: true, contato_no_texto_trecho: 'zap', contato_no_texto_telefone: '+5534995550000' })
  await q(`UPDATE whatsapp_estado SET trava = 'TODOS' WHERE id = 1`)
  let e = await job()
  ok(e.enfileiradas === 0 && e.motivo === 'tipo_desligado' && (await fila()).length === 0, 'tipo desligado (padrão): nada entra na fila', e)
  await config(C.chaveTipo('contato_no_texto'), 'true')
  e = await job(NOITE)
  ok(e.enfileiradas === 0 && e.motivo === 'fora_do_horario', 'fora da janela 08–21h: nada entra', e)
  await config(C.CHAVE_PAUSADO, 'true')
  e = await job()
  ok(e.enfileiradas === 0 && e.motivo === 'pausado', 'robô pausado: nada entra', e)
  await config(C.CHAVE_PAUSADO, 'false')
  e = await job()
  let linhas = await fila()
  // Marcados e abertos: V1 (velho), R_JOANA (joana), O_SEMTEL (sem telefone na conta). Fora: V5 (não aprovada), R_SAIU (SAIR), V2 (marca saiu).
  ok(e.enfileiradas === 3 && linhas.map(l => l.ref_id).sort().join() === [V1, R_JOANA, O_SEMTEL].sort().join(), 'tipo ligado: um aviso por pedido marcado e aberto — fora o de quem respondeu SAIR e a obra ainda não aprovada', { e, n: linhas.length })
  const lV1 = linhas.find(l => l.ref_id === V1), lSem = linhas.find(l => l.ref_id === O_SEMTEL)
  ok(lV1.usuario_id === velho.id && lV1.telefone === '+5534990000005' && lV1.chave_dedupe === SC.chaveDoAviso('reparos', V1) && lV1.texto === TEXTO && lV1.dados.telefone_do_texto === false,
     'conta com telefone: vai para o telefone da CONTA, com o texto exato', { tel: lV1.telefone })
  ok(lSem.usuario_id === semTel.id && lSem.telefone === '+5534997771234' && lSem.dados.telefone_do_texto === true, 'conta SEM telefone: vai para o número achado no texto do pedido', { tel: lSem.telefone })
  e = await job()
  ok(e.enfileiradas === 0 && (await fila()).length === 3, 'job de novo: uma vez por pedido — nada novo', e)
  // Segundo pedido marcado da mesma pessoa: espera 24 h.
  const V6 = await demanda('reparos', velho, 'Outro com zap', { contato_no_texto: true, contato_no_texto_trecho: 'zap' })
  e = await job()
  ok(e.enfileiradas === 0, 'outro pedido marcado da mesma pessoa: no máximo um aviso deste tipo a cada 24 h', e)

  // Worker: fora da janela não sai; dentro, sai sozinha com o texto exato (sem rodapé).
  let p = await passo(NOITE)
  ok(p.enviou === false && p.motivo === 'fora_do_horario' && f.enviados.length === 0, 'worker fora da janela: não envia', p.motivo)
  // O pedido de Joana fecha antes do envio: sai da fila sem enviar.
  await q(`UPDATE reparos SET status = 'encerrada' WHERE id = $1`, [R_JOANA])
  const enviados = []
  for (let i = 0; i < 6; i++) { p = await passo(); if (p.enviou) enviados.push(p) }
  linhas = await fila()
  ok(enviados.length === 2 && f.enviados.length === 2 && f.enviados[0].texto === TEXTO && !/SAIR/.test(f.enviados[0].texto) && /\*"Pintura da casa"\*/.test(f.enviados[1].texto)
     && linhas.filter(l => l.status === 'enviada').length === 2 && !linhas.some(l => l.ref_id === R_JOANA),
     'worker: uma mensagem por pedido, texto exato e sem rodapé; o aviso do pedido que fechou sai da fila sem enviar', { enviadas: enviados.length, linhas: linhas.map(l => l.status) })
  ok(f.enviados[1].jid === '553497771234@s.whatsapp.net', 'o aviso da conta sem telefone saiu para o número do texto', f.enviados[1].jid)

  // Resposta do dono ao aviso ("Qualquer dúvida, é só responder aqui"): fica na linha, não vai para o app.
  await demanda('reparos', velho, 'Pedido com pergunta')
  await registrarRecebida(shim, { id: 'IN1', jid: '553490000005@s.whatsapp.net', telefone: '+553490000005', texto: 'Ok, vou tirar o telefone', quando: new Date() })
  let chamouResponder = false
  await SP.processarRecebidas({ responder: async () => { chamouResponder = true; return { status: 200, body: {} } } }, shim)
  const rec = (await q(`SELECT resultado FROM whatsapp_recebidas WHERE wa_message_id = 'IN1'`)).rows[0]
  const lResp = (await fila(`ref_id = '${V1}'`))[0]
  ok(rec.resultado === 'contato_no_texto (guardada)' && lResp.status === 'respondida' && lResp.resposta === 'Ok, vou tirar o telefone' && chamouResponder === false,
     'resposta ao aviso: guardada na linha (painel), nunca entregue no app como resposta a pergunta', { rec, s: lResp.status })

  // SAIR vale para o número tirado do texto: a conta deixa de receber avisos.
  await registrarRecebida(shim, { id: 'IN2', jid: '553497771234@s.whatsapp.net', telefone: '+553497771234', texto: 'sair', quando: new Date() })
  ok((await q(`SELECT whatsapp_avisos FROM usuarios WHERE id = $1`, [semTel.id])).rows[0].whatsapp_avisos === false, 'SAIR respondido pelo número do texto: a conta do pedido sai dos avisos')
  const O2 = await demanda('obras', semTel, 'Outra obra', { contato_no_texto: true, contato_no_texto_trecho: '34 99777-1234', contato_no_texto_telefone: '+5534997771234' })
  await q(`UPDATE whatsapp_mensagens SET enviada_em = now() - INTERVAL '25 hours' WHERE tipo = 'contato_no_texto'`)
  e = await job()
  linhas = await fila(`status = 'fila'`)
  ok(e.enfileiradas === 1 && linhas.length === 1 && linhas[0].ref_id === V6 && !(await fila(`ref_id = '${O2}'`)).length, 'depois de 24 h: o 2º pedido da mesma pessoa entra; quem respondeu SAIR não recebe mais', { e, refs: linhas.map(l => l.ref_id) })
  // A marca sai (o texto foi corrigido) antes do envio: o worker descarta.
  await q(`UPDATE reparos SET contato_no_texto = false WHERE id = $1`, [V6])
  for (let i = 0; i < 3; i++) await passo()
  ok(f.enviados.length === 2 && (await fila(`ref_id = '${V6}'`)).length === 0, 'pedido que deixou de estar marcado antes do envio: sai da fila sem enviar')

  // ═══ 6. AJUSTES DE 27/11/2026 ═══════════════════════════════════════════════════════════════
  // 6a. Ponto de referência, bairro e tags: mesma regra do título/descrição.
  const ana = await usr(20, 'Ana Campos', 'dono_obra')
  const bia = await usr(21, 'Bia Antiga', 'dono_obra')
  ok(K.detectarContatoNoPedido({ titulo: 'Pintar 3 portas', descricao: 'sala de 12 m2', ponto_referencia: 'Próximo à escola, casa 120', bairro: 'Setor 2', tags: ['urgente', '2 quartos'] }) === null
     && K.detectarContatoNoPedido({ titulo: 'Pintar', ponto_referencia: '9 9 7190304' })?.campo === 'ponto_referencia'
     && K.detectarContatoNoPedido({ titulo: 'Pintar 34 9988', ponto_referencia: '1 7102' }) === null
     && K.detectarContatoNoPedido({ titulo: 'me chama', ponto_referencia: '9 9 7190304' })?.campo === 'texto',
     'detector por campo: título+descrição juntos; ponto de referência, bairro e tags um a um (campos diferentes não emendam)')
  r = await chamar('post', '/reparos/dono', { usuario: ana, body: corpoReparo({ ponto_referencia: 'Perto da padaria, 9 9 7190304', suporta_contato_no_texto: true }) })
  ok(r.status === 409 && r.body.codigo === 'CONTATO_NO_TEXTO' && r.body.campo === 'ponto_referencia' && r.body.trecho === '9 9 7190304' && /ponto de referência/.test(r.body.erro) && (await contar('reparos', ana)) === 0,
     'POST /reparos/dono com telefone no ponto de referência (app com suporte): 409 com o trecho e o campo, nada gravado', r.body)
  r = await chamar('post', '/obras/dono', { usuario: ana, body: corpoObra({ bairro: 'Centro zap 34998817102', suporta_contato_no_texto: true }) })
  ok(r.status === 409 && r.body.campo === 'bairro' && (await contar('obras', ana)) === 0, 'POST /obras/dono com contato no bairro: 409, nada gravado', r.body?.trecho)
  r = await chamar('post', '/reparos/dono', { usuario: ana, body: corpoReparo({ tags: ['urgente', 'whats 34998817102'], suporta_contato_no_texto: true }) })
  ok(r.status === 409 && r.body.campo === 'tags' && (await contar('reparos', ana)) === 0, 'contato nas tags: 409, nada gravado', r.body?.trecho)
  r = await chamar('post', '/reparos/dono', { usuario: ana, body: corpoReparo({ ponto_referencia: 'Perto da padaria, casa 120', bairro: 'Setor 2', tags: ['urgente'], suporta_contato_no_texto: true }) })
  ok(r.status === 201 && r.body.contato_no_texto === false, 'ponto de referência, bairro e tags comuns: publica sem marca', r.status)
  const R_ANA = r.body.id
  r = await chamar('post', '/reparos/dono', { usuario: bia, body: corpoReparo({ ponto_referencia: 'Perto da padaria, 9 9 7190304' }) })
  d = (await q(`SELECT * FROM reparos WHERE criado_por = $1`, [bia.id])).rows[0]
  ok(r.status === 201 && d.contato_no_texto === true && d.contato_no_texto_trecho === '9 9 7190304' && d.ponto_referencia === 'Perto da padaria, 9 9 7190304', 'app antigo com telefone no ponto de referência: publica e fica marcado', { s: r.status, t: d?.contato_no_texto_trecho })
  // PATCH do ponto de referência (reparo e obra).
  const PR = '/reparos/dono/:id/ponto-referencia', PO = '/obras/dono/:id/ponto-referencia'
  r = await chamar('patch', PR, { usuario: ana, params: { id: R_ANA }, body: { ponto_referencia: 'me chama no zap', suporta_contato_no_texto: true } })
  d = await linha('reparos', R_ANA)
  ok(r.status === 409 && r.body.codigo === 'CONTATO_NO_TEXTO' && r.body.campo === 'ponto_referencia' && d.ponto_referencia === 'Perto da padaria, casa 120' && d.contato_no_texto === false, 'PATCH ponto de referência com contato (app com suporte): 409, nada gravado', r.body)
  r = await chamar('patch', PR, { usuario: ana, params: { id: R_ANA }, body: { ponto_referencia: 'Em frente ao mercado, portão azul', suporta_contato_no_texto: true } })
  ok(r.status === 200 && r.body.ponto_referencia === 'Em frente ao mercado, portão azul' && (await linha('reparos', R_ANA)).contato_no_texto === false, 'PATCH com ponto de referência comum: grava, sem marca', r.status)
  r = await chamar('patch', PR, { usuario: ana, params: { id: R_ANA }, body: { ponto_referencia: 'ligar tres quatro 99881 sete um zero dois' } })
  d = await linha('reparos', R_ANA)
  ok(r.status === 200 && d.contato_no_texto === true && d.contato_no_texto_trecho === 'tres quatro 99881 sete um zero dois' && d.contato_no_texto_telefone === '+5534998817102', 'PATCH de app antigo com contato: grava e o pedido fica marcado', { s: r.status, t: d.contato_no_texto_trecho })
  r = await chamar('patch', PR, { usuario: bia, params: { id: R_ANA }, body: { ponto_referencia: 'zap 34998817102' } })
  ok(r.status === 404 && (await linha('reparos', R_ANA)).contato_no_texto_trecho === 'tres quatro 99881 sete um zero dois', 'PATCH de quem não é o dono: 404 e a marca do pedido não muda', r.status)
  r = await chamar('patch', PO, { usuario: maria, params: { id: OBRA_MARIA }, body: { ponto_referencia: 'meu email maria arroba gmail ponto com', suporta_contato_no_texto: true } })
  const r2 = await chamar('patch', PO, { usuario: maria, params: { id: OBRA_MARIA }, body: { ponto_referencia: 'whats 34998817102' } })
  d = await linha('obras', OBRA_MARIA)
  ok(r.status === 409 && r.body.campo === 'ponto_referencia' && r2.status === 200 && d.contato_no_texto === true && d.contato_no_texto_trecho === 'whats', 'PATCH da obra: 409 com suporte; app antigo grava e marca', { a: r.status, b: r2.status })
  r = await chamar('put', '/obras/:id', { usuario: ADM, params: { id: V5 }, body: { bairro: 'Centro, insta @ze.obras' } })
  ok(r.status === 409 && r.body.campo === 'bairro', 'PUT /obras/:id com contato no bairro: 409', r.body?.trecho)
  r = await chamar('put', '/obras/:id', { usuario: ADM, params: { id: V5 }, body: { bairro: 'Centro' } })
  ok(r.status === 200 && r.body.bairro === 'Centro' && (await linha('obras', V5)).contato_no_texto === true, 'PUT só do bairro em obra já marcada pelo título: grava, e a marca fica', r.status)

  // 6b. 2ª varredura única: ponto de referência, bairro e tags dos abertos ainda não marcados.
  const cfgCampos = (await q(`SELECT valor FROM configuracoes WHERE chave = $1`, [K.CHAVE_VARREDURA_CAMPOS])).rows[0]
  ok(!!cfgCampos && JSON.parse(cfgCampos.valor).marcados === 0, 'a migração já tinha feito a 2ª varredura (nada a marcar naquele momento)', cfgCampos?.valor)
  await q(`DELETE FROM configuracoes WHERE chave = $1`, [K.CHAVE_VARREDURA_CAMPOS])
  const C1 = await demanda('reparos', ana, 'Trocar fechadura', { ponto_referencia: 'Ao lado da igreja 9 9 7190304' })
  const C2 = await demanda('obras', ana, 'Muro novo', { ponto_referencia: 'Ao lado da igreja', bairro: 'Centro', tags: ['muro'] })
  silenciar(true)
  const v3 = await K.migrarContatoNoTexto(shim); const v4 = await K.migrarContatoNoTexto(shim)
  silenciar(false)
  const feita = JSON.parse((await q(`SELECT valor FROM configuracoes WHERE chave = $1`, [K.CHAVE_VARREDURA_CAMPOS])).rows[0].valor)
  ok(v3 === null && v4 === null && feita.marcados === 1 && (await linha('reparos', C1)).contato_no_texto_trecho === '9 9 7190304' && (await linha('obras', C2)).contato_no_texto === false,
     '2ª varredura única: marca o pedido aberto com telefone no ponto de referência; roda uma vez só', feita)

  // 6c. Aviso manual (avulsa) vale como o aviso do robô: nunca manda de novo.
  const leo = await usr(22, 'Leo Manual', 'dono_obra')
  const MANUAL = await demanda('reparos', leo, 'Infiltração na laje', { codigo_publico: 'B4YYD', contato_no_texto: true, contato_no_texto_trecho: 'WhatsApp' })
  await q(`INSERT INTO whatsapp_mensagens (tipo, usuario_id, telefone, texto, ref_tabela, ref_id, status, enviada_em, entregue_em)
           VALUES ('avulsa', $1, '+5534990000022', 'Olá! 👋 Aqui é o *ProTudo*.', 'reparos', $2, 'entregue', '2026-11-26T11:00:00Z', '2026-11-26T11:00:05Z')`, [leo.id, MANUAL])
  silenciar(true)
  const m1 = await K.migrarAvisosManuais(shim); const m2 = await K.migrarAvisosManuais(shim)
  silenciar(false)
  const avulsa = (await q(`SELECT tipo, chave_dedupe, status FROM whatsapp_mensagens WHERE ref_id = $1`, [MANUAL])).rows
  ok(m1 === 1 && m2 === 0 && avulsa.length === 1 && avulsa[0].tipo === 'avulsa' && avulsa[0].chave_dedupe === SC.chaveDoAviso('reparos', MANUAL), 'B4YYD: a avulsa enviada à mão ganha a chave do aviso (idempotente)', avulsa)
  e = await job()
  ok((await q(`SELECT count(*)::int AS n FROM whatsapp_mensagens WHERE ref_id = $1`, [MANUAL])).rows[0].n === 1 && e.enfileiradas >= 1, 'robô ligado: os outros marcados entram na fila, B4YYD nunca mais', e)

  // 6d. Painel: contato_no_texto_aviso { status, em } nas quatro listas.
  r = await chamar('get', '/reparos/admin', { usuario: ADM, query: { filtro: 'abertas' } })
  const lista = r.body?.reparos || []
  const aV1 = lista.find(x => x.id === V1)?.contato_no_texto_aviso, aManual = lista.find(x => x.id === MANUAL)?.contato_no_texto_aviso
  ok(aV1?.status === 'respondida' && !!aV1.em && Object.keys(aV1).sort().join() === 'em,status' && lista.find(x => x.id === V3)?.contato_no_texto_aviso === null,
     'GET /reparos/admin: contato_no_texto_aviso = { status, em } da mensagem do robô; null sem aviso', aV1)
  ok(aManual?.status === 'entregue' && new Date(aManual.em).toISOString() === '2026-11-26T11:00:00.000Z', 'B4YYD no painel: o aviso manual aparece como o aviso do pedido (status e hora do envio)', aManual)
  const naFila = lista.find(x => x.contato_no_texto_aviso?.status === 'fila')
  ok(!!naFila && !!naFila.contato_no_texto_aviso.em, 'aviso ainda na fila: status "fila" e a hora em que entrou', naFila?.contato_no_texto_aviso)
  r = await chamar('get', '/obras/admin', { usuario: ADM, query: { filtro: 'abertas' } })
  ok((r.body?.obras || []).find(x => x.id === O_SEMTEL)?.contato_no_texto_aviso?.status === 'enviada' && (r.body.obras.find(x => x.id === C2)?.contato_no_texto_aviso === null), 'GET /obras/admin: idem', (r.body?.obras || []).find(x => x.id === O_SEMTEL)?.contato_no_texto_aviso)
  r = await chamar('get', '/obras-aprovacao', { usuario: ADM })
  const r3 = await chamar('get', '/reparos/aprovacao', { usuario: ADM })
  ok((r.body?.obras || []).length > 0 && r.body.obras.every(x => x.contato_no_texto_aviso === null) && r3.status === 200 && (r3.body.reparos || []).every(x => 'contato_no_texto_aviso' in x),
     'GET /obras-aprovacao e /reparos/aprovacao: o campo vem (null sem aviso)', { obras: r.body?.obras?.length, reparos: r3.body?.reparos?.length })

  ok(erros.filter(x => !/ENOTFOUND|geoBusca|sem banco/.test(x)).length === 0, 'nenhum erro inesperado no log', erros.filter(x => !/ENOTFOUND|geoBusca|sem banco/.test(x)).slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
