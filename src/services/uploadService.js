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
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const tipos = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']
    if (tipos.includes(file.mimetype)) cb(null, true)
    else cb(new Error('Tipo de arquivo não permitido'))
  }
})

const uploadParaCloudinary = async (buffer, tipo, pasta = 'pinturapro') => {
  return new Promise((resolve, reject) => {
    const opcoes = {
      folder: pasta,
      resource_type: tipo === 'video' ? 'video' : 'image',
    }
    if (tipo === 'imagem') opcoes.transformation = [{ width: 1200, crop: 'limit', quality: 'auto' }]

    cloudinary.uploader.upload_stream(opcoes, (error, result) => {
      if (error) reject(error)
      else resolve({
        url: result.secure_url,
        thumbnail: tipo === 'video'
          ? result.secure_url.replace('/upload/', '/upload/w_400,h_300,c_fill/')
          : result.secure_url.replace('/upload/', '/upload/w_400,h_300,c_fill,q_auto/')
      })
    }).end(buffer)
  })
}

module.exports = { upload, uploadParaCloudinary }