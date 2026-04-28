const { upload, uploadParaCloudinary } = require('../services/uploadService')
const { pool } = require('../utils/supabase')

const uploadMidia = async (req, res) => {
  try {
    const { obra_id, ordem = 0 } = req.body

    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo enviado' })
    }

    const isVideo = req.file.mimetype.startsWith('video/')
    const tipo = isVideo ? 'video' : 'imagem'

    const { url, thumbnail } = await uploadParaCloudinary(req.file.buffer, tipo)

    const result = await pool.query(
      `INSERT INTO midias (obra_id, tipo, url, url_thumbnail, ordem)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [obra_id, isVideo ? 'video' : 'foto', url, thumbnail, parseInt(ordem)]
    )

    res.status(201).json(result.rows[0])

  } catch (err) {
    console.error('Erro no upload:', err)
    res.status(500).json({ erro: 'Erro ao fazer upload' })
  }
}

module.exports = { upload, uploadMidia }