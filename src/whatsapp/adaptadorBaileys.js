// Adaptador BAILEYS (biblioteca não oficial, multi-device). É o ÚNICO arquivo que importa a
// biblioteca; cumpre o contrato de ./adaptador.js. A sessão fica no Postgres (./authPostgres).
// O pacote é ESM puro → import() dinâmico (o resto do repositório é CommonJS).
const { usarAuthPostgres } = require('./authPostgres')

// A biblioteca fala demais; só os erros interessam.
const criarLoggerMudo = (log) => {
  const mudo = {
    level: 'error',
    child: () => mudo,
    trace() {}, debug() {}, info() {}, warn() {},
    error: (obj, msg) => log.error('[whatsapp/baileys]', msg || '', obj?.err?.message || obj?.message || ''),
    fatal: (obj, msg) => log.error('[whatsapp/baileys]', msg || '', obj?.err?.message || obj?.message || ''),
  }
  return mudo
}

const telefoneDoJid = (jid) => {
  const d = String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '')
  return d ? `+${d}` : null
}
const conteudo = (m) => m?.ephemeralMessage?.message || m?.viewOnceMessage?.message || m?.viewOnceMessageV2?.message || m
const textoDaMensagem = (m) => {
  const c = conteudo(m)
  return c?.conversation || c?.extendedTextMessage?.text || ''
}
// 'audio' | 'imagem' | 'video' | 'documento' | 'figurinha' | 'outro' — null quando é texto.
const MIDIAS = { audioMessage: 'audio', imageMessage: 'imagem', videoMessage: 'video', documentMessage: 'documento', documentWithCaptionMessage: 'documento',
  stickerMessage: 'figurinha', ptvMessage: 'video', contactMessage: 'outro', contactsArrayMessage: 'outro', locationMessage: 'outro', liveLocationMessage: 'outro' }
const midiaDaMensagem = (m) => {
  const c = conteudo(m) || {}
  for (const chave of Object.keys(MIDIAS)) if (c[chave]) return MIDIAS[chave]
  return textoDaMensagem(m) ? null : 'outro'
}
// Id da mensagem citada (a pessoa respondeu "em cima" de uma mensagem nossa).
const citadaDaMensagem = (m) => conteudo(m)?.extendedTextMessage?.contextInfo?.stanzaId || null
const segundos = (ts) => {
  const n = ts && typeof ts === 'object' && typeof ts.toNumber === 'function' ? ts.toNumber() : Number(ts)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date()
}

const criarAdaptadorBaileys = ({ db, log = console } = {}) => {
  let lib = null, sock = null, auth = null, parado = true, tentativa = 0, timer = null
  let atual = { conexao: 'desligado', qr: null, numero: null }
  const ouvintes = { receber: [], status: [], estado: [] }
  const emitir = (lista, arg) => {
    for (const fn of lista) Promise.resolve().then(() => fn(arg)).catch(err => log.error('[whatsapp] ouvinte falhou:', err?.message || err))
  }
  const estado = () => ({ ...atual })
  const mudar = (novo) => { atual = { ...atual, ...novo }; emitir(ouvintes.estado, estado()) }
  const reabrirEm = (ms) => { clearTimeout(timer); timer = setTimeout(() => abrir().catch(err => { log.error('[whatsapp] falha ao reconectar:', err?.message || err); reabrirEm(30000) }), ms) }

  const abrir = async () => {
    if (parado) return
    lib = lib || await import('baileys')
    auth = await usarAuthPostgres(db, lib)
    mudar({ conexao: 'conectando', qr: null })
    const logger = criarLoggerMudo(log)
    let version
    try { version = (await lib.fetchLatestBaileysVersion()).version } catch { version = undefined }
    const makeWASocket = lib.makeWASocket || lib.default
    const chaves = typeof lib.makeCacheableSignalKeyStore === 'function' ? lib.makeCacheableSignalKeyStore(auth.state.keys, logger) : auth.state.keys
    const s = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: auth.state.creds, keys: chaves },
      logger,
      browser: lib.Browsers.ubuntu('ProTudo'),
      markOnlineOnConnect: false,          // o celular do robô continua recebendo notificações
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    })
    sock = s

    s.ev.on('creds.update', () => auth.salvarCreds().catch(err => log.error('[whatsapp] falha ao salvar credenciais:', err.message)))

    s.ev.on('connection.update', (u) => {
      if (s !== sock) return
      if (u.qr) mudar({ conexao: 'aguardando_qr', qr: u.qr })
      if (u.connection === 'open') {
        tentativa = 0
        mudar({ conexao: 'conectado', qr: null, numero: telefoneDoJid(s.user?.id) })
      }
      if (u.connection === 'close') {
        sock = null
        const codigo = u.lastDisconnect?.error?.output?.statusCode
        if (parado) return mudar({ conexao: 'desligado', qr: null })
        const R = lib.DisconnectReason
        if (codigo === R.loggedOut) {
          // Sessão encerrada pelo celular: apaga e recomeça (novo QR).
          log.error('[whatsapp] sessão encerrada (logout) — será preciso ler o QR de novo')
          auth.apagarTudo().catch(err => log.error('[whatsapp] falha ao apagar sessão:', err.message))
            .finally(() => { mudar({ conexao: 'conectando', qr: null, numero: null }); reabrirEm(2000) })
          return
        }
        mudar({ conexao: 'conectando', qr: null })
        if (codigo === R.restartRequired) return reabrirEm(500)       // normal logo depois de ler o QR
        if (codigo === R.connectionReplaced) {                       // outra instância abriu a mesma sessão
          log.error('[whatsapp] conexão substituída por outra instância — nova tentativa em 60 s')
          return reabrirEm(60000)
        }
        tentativa++
        reabrirEm(Math.min(60000, 2000 * 2 ** Math.min(tentativa, 5)))
      }
    })

    s.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const m of messages || []) {
        const k = m.key || {}
        if (k.fromMe || !k.remoteJid || !k.id || !m.message) continue
        // Reação, edição/apagamento e avisos de protocolo não são mensagens da pessoa.
        const c = conteudo(m.message) || {}
        if (c.protocolMessage || c.reactionMessage || c.pollUpdateMessage || c.keepInChatMessage || c.editedMessage) continue
        const jid = k.remoteJid
        if (lib.isJidGroup(jid) || lib.isJidBroadcast(jid) || jid === 'status@broadcast' || lib.isJidNewsletter?.(jid)) continue
        // Conversa identificada por LID: o número vem em remoteJidAlt (quando o WhatsApp informa).
        const jidNumero = lib.isLidUser(jid) ? (k.remoteJidAlt || null) : jid
        emitir(ouvintes.receber, {
          id: k.id, jid: jidNumero || jid, telefone: jidNumero ? telefoneDoJid(jidNumero) : null,
          texto: textoDaMensagem(m.message), quando: segundos(m.messageTimestamp),
          citada: citadaDaMensagem(m.message), midia: midiaDaMensagem(m.message),
        })
      }
    })

    // Recibos das mensagens que NÓS enviamos: 3 = entregue, 4 = lida, 5 = reproduzida.
    s.ev.on('messages.update', (lista) => {
      for (const { key, update } of lista || []) {
        if (!key?.fromMe || !key.id || update?.status == null) continue
        const n = Number(update.status)
        if (n === 3) emitir(ouvintes.status, { id: key.id, status: 'entregue' })
        else if (n >= 4) emitir(ouvintes.status, { id: key.id, status: 'lida' })
      }
    })
  }

  const exigirConectado = () => {
    if (!sock || atual.conexao !== 'conectado') throw new Error('WhatsApp desconectado')
    return sock
  }

  return {
    conectar: async () => { parado = false; await abrir() },
    // apagarSessao = true: encerra a sessão no WhatsApp e apaga as chaves (o próximo conectar pede QR).
    desconectar: async ({ apagarSessao = false } = {}) => {
      parado = true
      clearTimeout(timer)
      const s = sock
      sock = null
      if (s) {
        try { if (apagarSessao) await s.logout(); else await s.end(undefined) } catch (err) { log.error('[whatsapp] ao desconectar:', err?.message || err) }
      }
      if (apagarSessao) await db.query(`DELETE FROM whatsapp_auth`)
      mudar({ conexao: 'desligado', qr: null, ...(apagarSessao ? { numero: null } : {}) })
    },
    estado,
    existeNoWhatsapp: async (telefone) => {
      const r = await exigirConectado().onWhatsApp(telefone)
      const achado = (r || [])[0]
      return { existe: !!achado?.exists, jid: achado?.exists ? achado.jid : null }
    },
    enviarTexto: async (jid, texto) => {
      const m = await exigirConectado().sendMessage(jid, { text: texto })
      return { id: m?.key?.id || null }
    },
    aoReceber: (fn) => { ouvintes.receber.push(fn) },
    aoAtualizarStatus: (fn) => { ouvintes.status.push(fn) },
    aoMudarEstado: (fn) => { ouvintes.estado.push(fn) },
  }
}

module.exports = { criarAdaptadorBaileys, telefoneDoJid, textoDaMensagem, midiaDaMensagem, citadaDaMensagem }
