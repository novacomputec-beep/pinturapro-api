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
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
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

module.exports = { upload, uploadParaCloudinary }