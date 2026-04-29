const { pool } = require('../utils/supabase')
const { notificarNovaObra } = require('../services/notificacaoService')

const listar = async (req, res) => {
  try {
    const { categoria, page = 1, limit = 20 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let query = `
      SELECT o.id, o.titulo, o.categoria, o.valor, o.cidade, o.estado, o.bairro,
             o.metragem, o.prazo_execucao_dias, o.expira_em, o.tags, o.status,
             0 as distancia_metros,
             (SELECT COUNT(*) FROM midias WHERE obra_id = o.id) as total_midias,
             (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_candidaturas,
             (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) as foto_capa
      FROM obras o
      WHERE o.status = 'aberta'
      AND o.expira_em > NOW()
    `
    const params = []

    if (categoria && categoria !== 'todas') {
      params.push(categoria)
      query += ` AND o.categoria = $${params.length}`
    }

    query += ` ORDER BY o.criado_em DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(parseInt(limit), offset)

    const result = await pool.query(query, params)

    res.json({
      obras: result.rows,
      pagina: parseInt(page),
      total: result.rows.length
    })

  } catch (err) {
    console.error('Erro ao listar obras:', err)
    res.status(500).json({ erro: 'Erro ao buscar obras' })
  }
}

const detalhe = async (req, res) => {
  try {
    const { id } = req.params

    const result = await pool.query(
      `SELECT * FROM obras WHERE id = $1 AND status = 'aberta'`,
      [id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Obra não encontrada' })
    }

    const obra = result.rows[0]

    const midiasResult = await pool.query(
      `SELECT id, tipo, url, url_thumbnail, ordem FROM midias WHERE obra_id = $1 ORDER BY ordem`,
      [id]
    )

    const candidaturaResult = await pool.query(
      `SELECT id, status FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2`,
      [id, req.usuario.id]
    )

    res.json({
      obra,
      midias: midiasResult.rows.map(m => ({ ...m, url_assinada: m.url })),
      minha_candidatura: candidaturaResult.rows[0] || null
    })

  } catch (err) {
    console.error('Erro ao buscar obra:', err)
    res.status(500).json({ erro: 'Erro ao buscar obra' })
  }
}

const criar = async (req, res) => {
  try {
    const {
      titulo, categoria, valor, cidade, bairro,
      latitude, longitude, metragem,
      prazo_execucao_dias, horas_para_expirar,
      descricao, tags
    } = req.body

    const expira_em = new Date(Date.now() + (horas_para_expirar || 48) * 3600 * 1000)

    const result = await pool.query(
      `INSERT INTO obras (criado_por, titulo, categoria, valor, cidade, bairro,
        latitude, longitude, metragem, prazo_execucao_dias, expira_em, descricao, tags, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'aberta')
       RETURNING *`,
      [req.usuario.id, titulo, categoria, valor, cidade, bairro,
       latitude, longitude, metragem, prazo_execucao_dias,
       expira_em.toISOString(), descricao, tags || []]
    )

    const obra = result.rows[0]

    // Notifica todos os pintores sobre a nova obra
    notificarNovaObra(pool, obra).catch(err =>
      console.error('Erro ao enviar notificações:', err)
    )

    res.status(201).json(obra)

  } catch (err) {
    console.error('Erro ao criar obra:', err)
    res.status(500).json({ erro: 'Erro ao criar obra' })
  }
}

const editar = async (req, res) => {
  try {
    const { titulo, categoria, valor, cidade, bairro, metragem, prazo_execucao_dias, descricao, tags, status } = req.body

    const result = await pool.query(
      `UPDATE obras SET titulo=$1, categoria=$2, valor=$3, cidade=$4, bairro=$5,
       metragem=$6, prazo_execucao_dias=$7, descricao=$8, tags=$9, status=$10
       WHERE id=$11 RETURNING *`,
      [titulo, categoria, valor, cidade, bairro, metragem, prazo_execucao_dias, descricao, tags, status, req.params.id]
    )

    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao editar obra' })
  }
}

const encerrar = async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE obras SET status='encerrada' WHERE id=$1 RETURNING id, titulo, status`,
      [req.params.id]
    )
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao encerrar obra' })
  }
}

module.exports = { listar, detalhe, criar, editar, encerrar }