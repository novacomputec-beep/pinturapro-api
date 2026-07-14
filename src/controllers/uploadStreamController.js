// uploadStreamController.js — upload de UMA mídia (imagem OU vídeo) em STREAMING para o
// Cloudinary. Usa busboy e pipa o stream do arquivo DIRETO no cloudinary.uploader
// .upload_stream: o processo NUNCA concatena o arquivo inteiro em um Buffer (memória
// O(chunk), não O(arquivo)) — foi o buffer em memória (multer.memoryStorage) que causou
// os timeouts/OOM do endpoint antigo no Railway, crítico p/ vídeos de 30s.
//
// Compatível com o cron deletarMidiasAntigas (server.js): produz secure_url padrão
// (extrairPublicId funciona p/ imagem e vídeo) e devolve resource_type p/ o app persistir
// o `tipo` correto ('video'/'foto'), do qual o cron depende p/ apagar vídeos com
// resource_type='video'. Imagens → pinturapro/fotos|verificacao; vídeos → pinturapro/videos.
//
// Aditivo: NÃO altera uploadService.js/uploadController.js, o cron, nem fluxos existentes.

const cloudinary = require('cloudinary').v2
const busboy = require('busboy')
const jwt = require('jsonwebtoken')

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

// Limites por tipo. Imagem: o app já reduz p/ ~1280px q0.6 → 10MB sobra. Vídeo: um clipe
// de 30s de celular a 1080p/H.264 costuma dar ~40-75MB (mais em 60fps/bitrate alto); 100MB
// dá folga e casa com o teto de vídeo do Cloudinary. Acima disso → 413 (nunca 500).
const IMG_MAX = 10 * 1024 * 1024
const VIDEO_MAX = 100 * 1024 * 1024
const CLOUD_TIMEOUT = 180 * 1000            // 180s no request ao Cloudinary (alinha com o timeout de vídeo do app)

const MIMES_IMG = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MIMES_VIDEO = new Set(['video/mp4', 'video/quicktime'])
// Mesmas pastas dos uploads diretos atuais (nada muda downstream p/ o cron).
const PASTAS_OK = new Set(['pinturapro/verificacao', 'pinturapro/fotos', 'pinturapro/perfil', 'pinturapro/videos'])

// Rate limit por IP — SÓ no caminho pré-auth (cadastro, sem token). 30/min: folgado p/ os
// 3 uploads de verificação de um usuário real, mesmo vários atrás do mesmo IP de CGNAT,
// mas corta flood automatizado. (Em memória: reseta no redeploy; é 1ª barreira, não muralha.)
const rate = new Map()
const RATE_LIMIT = 30
const RATE_WINDOW = 60 * 1000
const estaLimitado = (ip) => {
  const now = Date.now()
  const e = rate.get(ip) || { count: 0, windowStart: now }
  if (now - e.windowStart > RATE_WINDOW) { e.count = 0; e.windowStart = now }
  e.count++
  rate.set(ip, e)
  return e.count > RATE_LIMIT
}

const uploadMidiaStream = (req, res) => {
  const ts = new Date().toISOString()
  const ip = req.ip || req.connection?.remoteAddress || 'unknown'

  // ── Contexto de segurança ────────────────────────────────────────────────
  // Com token válido → AUTENTICADO (obra/reparo): sem rate limit, pode enviar vídeo.
  // Sem token → PRÉ-AUTH (cadastro): rate limit por IP + só imagem.
  // Token presente mas inválido → 401 (não rebaixa silenciosamente p/ pré-auth).
  let autenticado = false
  const authHeader = req.headers.authorization
  if (authHeader) {
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ erro: 'Token inválido.', codigo: 'token_invalido' })
    }
    try {
      const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET)
      if (decoded.tipo === '2fa_pendente') {
        return res.status(401).json({ erro: 'Autenticação incompleta.', codigo: 'token_invalido' })
      }
      autenticado = true
    } catch (err) {
      return res.status(401).json({ erro: 'Token inválido ou expirado.', codigo: 'token_invalido' })
    }
  }
  if (!autenticado && estaLimitado(ip)) {
    return res.status(429).json({ erro: 'Muitas tentativas de upload. Aguarde um momento e tente novamente.', codigo: 'rate_limit' })
  }

  const contentType = req.headers['content-type'] || ''
  if (!contentType.startsWith('multipart/form-data')) {
    return res.status(400).json({ erro: 'Envie a mídia como multipart/form-data (campo "arquivo").', codigo: 'formato_invalido' })
  }

  let bb
  try {
    bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: VIDEO_MAX } })
  } catch (err) {
    return res.status(400).json({ erro: 'Requisição multipart inválida.', codigo: 'multipart_invalido' })
  }

  let respondido = false
  const responder = (status, corpo) => {
    if (respondido) return
    respondido = true
    res.status(status).json(corpo)
  }

  let recebeuArquivo = false
  let uploadStream = null
  let abortado = false

  bb.on('file', (_name, file, info) => {
    recebeuArquivo = true
    const mime = info?.mimeType || ''
    const isImagem = MIMES_IMG.has(mime)
    const isVideo = MIMES_VIDEO.has(mime)

    if (!isImagem && !isVideo) {
      file.resume()
      return responder(415, { erro: 'Tipo de arquivo não permitido. Envie JPG, PNG, WEBP, MP4 ou MOV.', codigo: 'mime_invalido' })
    }
    // Vídeo só no caminho autenticado — não expor upload de 100MB a chamadas anônimas.
    if (isVideo && !autenticado) {
      file.resume()
      return responder(401, { erro: 'Envio de vídeo requer autenticação.', codigo: 'video_requer_auth' })
    }

    const resourceType = isVideo ? 'video' : 'image'
    const capTipo = isVideo ? VIDEO_MAX : IMG_MAX
    // Pasta: usa o param whitelisted; senão default compatível com o cron/estado atual.
    let pasta
    if (PASTAS_OK.has(req.query.pasta)) pasta = req.query.pasta
    else if (isVideo) pasta = 'pinturapro/videos'
    else pasta = autenticado ? 'pinturapro/fotos' : 'pinturapro/verificacao'

    const opcoes = { folder: pasta, resource_type: resourceType, timeout: CLOUD_TIMEOUT }
    if (isImagem) opcoes.transformation = [{ width: 1280, crop: 'limit', quality: 'auto:good' }]

    uploadStream = cloudinary.uploader.upload_stream(opcoes, (err, result) => {
      if (abortado) return
      if (err) {
        const timeout = /timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET/i.test(`${err.message || ''} ${err.name || ''}`)
        console.error(`[UPLOAD-MIDIA][${ts}] ✗ Cloudinary | http=${err.http_code || ''} msg="${err.message}"`)
        return responder(timeout ? 504 : 502, {
          erro: timeout ? 'O envio da mídia demorou demais. Tente novamente.' : 'Não foi possível enviar a mídia. Tente novamente.',
          codigo: timeout ? 'cloudinary_timeout' : 'cloudinary_falha',
        })
      }
      console.log(`[UPLOAD-MIDIA][${ts}] ✓ ${result.public_id} (${result.bytes}b) rt=${result.resource_type} pasta=${pasta}`)
      return responder(201, { secure_url: result.secure_url, public_id: result.public_id, resource_type: result.resource_type })
    })

    // Limite por TIPO (busboy tem só um teto global = VIDEO_MAX; imagem precisa de cap menor).
    let bytes = 0
    file.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > capTipo && !abortado) {
        abortado = true
        if (uploadStream) uploadStream.destroy(new Error('excedeu limite'))
        responder(413, {
          erro: isVideo ? 'Vídeo muito grande. O limite é 100MB.' : 'Imagem muito grande. O limite é 10MB.',
          codigo: 'muito_grande',
        })
        try { file.unpipe(uploadStream) } catch {}
        req.unpipe(bb); req.resume()
      }
    })

    // Backstop do busboy (arquivo > VIDEO_MAX): trunca e emite 'limit'.
    file.on('limit', () => {
      if (abortado) return
      abortado = true
      if (uploadStream) uploadStream.destroy(new Error('limite de tamanho excedido'))
      responder(413, { erro: 'Arquivo muito grande. Limite: imagem 10MB, vídeo 100MB.', codigo: 'muito_grande' })
      req.unpipe(bb); req.resume()
    })

    file.on('error', (err) => {
      if (abortado) return
      abortado = true
      if (uploadStream) uploadStream.destroy(err)
      console.error(`[UPLOAD-MIDIA][${ts}] ✗ leitura do arquivo | msg="${err.message}"`)
      responder(400, { erro: 'Falha ao ler o arquivo enviado.', codigo: 'leitura_falha' })
    })

    file.pipe(uploadStream)
  })

  bb.on('close', () => {
    if (!recebeuArquivo) responder(400, { erro: 'Nenhuma mídia enviada (campo "arquivo").', codigo: 'sem_arquivo' })
  })

  bb.on('error', (err) => {
    console.error(`[UPLOAD-MIDIA][${ts}] ✗ busboy | msg="${err.message}"`)
    if (uploadStream) uploadStream.destroy(err)
    abortado = true
    responder(400, { erro: 'Requisição de upload inválida.', codigo: 'upload_invalido' })
  })

  req.on('aborted', () => {
    abortado = true
    if (uploadStream) uploadStream.destroy(new Error('cliente desconectou'))
  })

  req.pipe(bb)
}

module.exports = { uploadMidiaStream }
