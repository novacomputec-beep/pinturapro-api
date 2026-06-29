const { upload, uploadParaCloudinary } = require('../services/uploadService')
const { pool } = require('../utils/supabase')

const uploadMidia = async (req, res) => {
  try {
    const { obra_id, ordem = 0 } = req.body

    if (!obra_id) {
      return res.status(400).json({ erro: 'obra_id é obrigatório' })
    }

    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo enviado' })
    }

    // Verifica se a obra existe antes de vincular a mídia
    const obraExiste = await pool.query(`SELECT id, criado_por FROM obras WHERE id = $1`, [obra_id])
    if (obraExiste.rows.length === 0) {
      return res.status(404).json({ erro: 'Obra não encontrada' })
    }
    if (obraExiste.rows[0].criado_por !== req.usuario.id && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Sem permissão para esta ação' })
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

// uploadArquivo — versão simples usada em rotas de foto de perfil e reparos
const uploadArquivo = async (file) => {
  const tipo = file.mimetype.startsWith('video/') ? 'video' : 'imagem'
  return uploadParaCloudinary(file.buffer, tipo)
}

module.exports = { upload, uploadMidia, uploadArquivo }