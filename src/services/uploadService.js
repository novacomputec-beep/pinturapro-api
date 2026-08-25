const cloudinary = require('cloudinary').v2
const multer = require('multer')

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
})

const storage = multer.memoryStorage()

const upload = multer({
  storage,
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB
  fileFilter: (req, file, cb) => {
    const tiposPermitidos = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']
    if (tiposPermitidos.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Tipo de arquivo não permitido. Use JPG, PNG, WEBP, MP4 ou MOV.'))
    }
  }
})

const uploadParaCloudinary = async (buffer, tipo, pasta = 'pinturapro') => {
  return new Promise((resolve, reject) => {
    const isVideo = tipo === 'video'

    const opcoes = {
      folder: isVideo ? `${pasta}/videos` : `${pasta}/imagens`,
      resource_type: isVideo ? 'video' : 'image',
    }

    // Redimensiona imagens para evitar armazenar arquivos gigantes
    if (!isVideo) {
      opcoes.transformation = [{ width: 1200, crop: 'limit', quality: 'auto:good' }]
    }

    cloudinary.uploader.upload_stream(opcoes, (error, result) => {
      if (error) {
        console.error('Erro Cloudinary:', error)
        reject(error)
      } else {
        resolve({
          secure_url: result.secure_url, // compatível com uploadArquivo
          url: result.secure_url,
          thumbnail: isVideo
            ? result.secure_url.replace('/upload/', '/upload/w_400,h_300,c_fill/')
            : result.secure_url.replace('/upload/', '/upload/w_400,h_300,c_fill,q_auto/')
        })
      }
    }).end(buffer)
  })
}

const uploadArquivo = async (file) => {
  const tipo = file.mimetype.startsWith('video/') ? 'video' : 'imagem'
  return uploadParaCloudinary(file.buffer, tipo)
}

// Gera a assinatura de upload direto ao Cloudinary. `restricoes` é mesclado NO conjunto
// ASSINADO (não é campo meramente informativo): tudo que entra aqui é coberto pela
// assinatura, e por isso o CLIENTE precisa reenviar EXATAMENTE estes mesmos valores no
// upload — o Cloudinary recomputa a assinatura a partir dos parâmetros recebidos e recusa
// (401 Invalid Signature) se divergirem. Use para prender formato/tamanho e impedir que a
// assinatura sirva para subir arquivo arbitrário (D61). `transformation` continua fora da
// assinatura, apenas informativo.
const gerarAssinaturaCloudinary = (folder = 'pinturapro/videos', restricoes = {}) => {
  const timestamp = Math.round(Date.now() / 1000)
  const transformation = folder.includes('fotos') ? 'q_auto:good,w_1280' : 'q_auto:low,w_1280'
  const paramsAssinados = { timestamp, folder, ...restricoes }
  const signature = cloudinary.utils.api_sign_request(paramsAssinados, process.env.CLOUDINARY_API_SECRET)
  return { signature, timestamp, cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, folder, transformation, ...restricoes }
}

// TTL da URL assinada de leitura dos documentos de verificação. 10 min: o admin revisa os
// documentos numa sessão só; prazo curto limita a exposição de uma URL vazada (histórico do
// navegador, referrer, log, tela compartilhada). A EXPIRAÇÃO real depende do token-auth do
// Cloudinary (CLOUDINARY_AUTH_TOKEN_KEY): com a chave, auth_token impõe o prazo; sem ela,
// sign_url dá acesso ASSINADO mas sem prazo rígido (limitação de plano — tratar no passo 3).
const TTL_URL_VERIFICACAO = 10 * 60

// Gera a URL de leitura ASSINADA de um asset de verificação a partir da URL ARMAZENADA. Deriva
// public_id, versão e TIPO DE ENTREGA (upload/authenticated/private) da própria URL guardada,
// então a MESMA função serve o asset público de hoje E o authenticated de depois (passo 3) —
// a URL assinada acompanha o tipo vigente. NÃO substitui a URL guardada (delete e legado ainda
// dependem dela). Formato inesperado ou falha: devolve a original, para nunca quebrar a tela.
const gerarUrlAssinadaVerificacao = (urlArmazenada, ttlSegundos = TTL_URL_VERIFICACAO) => {
  if (!urlArmazenada || typeof urlArmazenada !== 'string') return urlArmazenada || null
  const m = urlArmazenada.match(/\/(image|video|raw)\/(upload|authenticated|private)\/(?:v(\d+)\/)?(.+?)(?:\.\w+)?$/)
  if (!m) return urlArmazenada
  const [, resourceType, deliveryType, version, publicId] = m
  const opcoes = { resource_type: resourceType, type: deliveryType, secure: true, sign_url: true }
  if (version) opcoes.version = version
  const tokenKey = process.env.CLOUDINARY_AUTH_TOKEN_KEY
  if (tokenKey) opcoes.auth_token = { key: tokenKey, duration: ttlSegundos }
  try {
    return cloudinary.url(publicId, opcoes)
  } catch (err) {
    console.error('[Cloudinary] falha ao assinar URL de verificação:', err.message)
    return urlArmazenada
  }
}

const extrairPublicId = (url) => {
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/)
    return match ? match[1] : null
  } catch (err) {
    return null
  }
}

const deletarDoCloudinary = async (url, tipo = 'foto') => {
  const publicId = extrairPublicId(url)
  if (!publicId) {
    console.log('[Cloudinary] não foi possível extrair public_id de:', url)
    return false
  }
  try {
    const resourceType = tipo === 'video' ? 'video' : 'image'
    const resultado = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType })
    console.log('[Cloudinary] resultado da exclusão:', publicId, '|', resultado.result)
    return resultado.result === 'ok' || resultado.result === 'not found'
  } catch (err) {
    console.log('[Cloudinary] falha ao deletar | publicId:', publicId, '| msg:', err.message)
    return false
  }
}

module.exports = { upload, uploadParaCloudinary, uploadArquivo, gerarAssinaturaCloudinary, gerarUrlAssinadaVerificacao, extrairPublicId, deletarDoCloudinary }