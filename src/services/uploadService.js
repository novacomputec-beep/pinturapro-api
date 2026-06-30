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

const gerarAssinaturaCloudinary = (folder = 'pinturapro/videos') => {
  const timestamp = Math.round(Date.now() / 1000)
  const transformation = folder.includes('fotos') ? 'q_auto:good,w_1280' : 'q_auto:low,w_1280'
  const signature = cloudinary.utils.api_sign_request({ timestamp, folder }, process.env.CLOUDINARY_API_SECRET)
  return { signature, timestamp, cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, folder, transformation }
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

module.exports = { upload, uploadParaCloudinary, uploadArquivo, gerarAssinaturaCloudinary, extrairPublicId, deletarDoCloudinary }