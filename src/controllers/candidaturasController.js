const { pool } = require('../utils/supabase')

const candidatar = async (req, res) => {
  try {
    const { obra_id, referencias } = req.body

    const obraResult = await pool.query(
      `SELECT id, titulo, status, expira_em FROM obras WHERE id = $1 AND status = 'aberta'`,
      [obra_id]
    )

    if (obraResult.rows.length === 0) {
      return res.status(404).json({ erro: 'Obra não encontrada ou não está disponível' })
    }

    const obra = obraResult.rows[0]

    if (new Date(obra.expira_em) < new Date()) {
      return res.status(400).json({ erro: 'O prazo para aceite desta obra expirou' })
    }

    const existente = await pool.query(
      `SELECT id, status FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2`,
      [obra_id, req.usuario.id]
    )

    if (existente.rows.length > 0) {
      return res.status(409).json({
        erro: 'Você já demonstrou interesse nesta obra',
        candidatura: existente.rows[0]
      })
    }

    const result = await pool.query(
      `INSERT INTO candidaturas (obra_id, usuario_id, referencias, status)
       VALUES ($1, $2, $3, 'pendente') RETURNING *`,
      [obra_id, req.usuario.id, referencias]
    )

    res.status(201).json(result.rows[0])

  } catch (err) {
    console.error('Erro ao candidatar:', err)
    res.status(500).json({ erro: 'Erro ao registrar candidatura' })
  }
}

const minhas = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.status, c.criado_em,
              o.id as obra_id, o.titulo, o.categoria, o.valor, o.cidade, o.status as obra_status
       FROM candidaturas c
       JOIN obras o ON c.obra_id = o.id
       WHERE c.usuario_id = $1
       ORDER BY c.criado_em DESC`,
      [req.usuario.id]
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar candidaturas' })
  }
}

const porObra = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.status, c.referencias, c.criado_em,
              u.id as usuario_id, u.nome, u.email, u.telefone, u.cidade,
              u.anos_experiencia, u.tamanho_equipe, u.especialidades
       FROM candidaturas c
       JOIN usuarios u ON c.usuario_id = u.id
       WHERE c.obra_id = $1
       ORDER BY c.criado_em ASC`,
      [req.params.obra_id]
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar candidaturas' })
  }
}

const pendentes = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.status, c.referencias, c.criado_em,
              o.id as obra_id, o.titulo, o.categoria, o.valor, o.cidade,
              u.id as pintor_id, u.nome as pintor_nome, u.email as pintor_email,
              u.telefone, u.cidade as pintor_cidade, u.anos_experiencia, u.tamanho_equipe
       FROM candidaturas c
       JOIN obras o ON c.obra_id = o.id
       JOIN usuarios u ON c.usuario_id = u.id
       WHERE c.status = 'pendente'
       ORDER BY c.criado_em ASC`
    )
    res.json({ candidaturas: result.rows })
  } catch (err) {
    console.error('Erro ao buscar candidaturas pendentes:', err)
    res.status(500).json({ erro: 'Erro ao buscar candidaturas pendentes' })
  }
}

const aprovar = async (req, res) => {
  try {
    const { id } = req.params

    const result = await pool.query(
      `UPDATE candidaturas SET status = 'aprovada', aprovado_por = $1
       WHERE id = $2 RETURNING *`,
      [req.usuario.id, id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Candidatura não encontrada' })
    }

    res.json(result.rows[0])

  } catch (err) {
    console.error('Erro ao aprovar candidatura:', err)
    res.status(500).json({ erro: 'Erro ao aprovar candidatura' })
  }
}

const recusar = async (req, res) => {
  try {
    const { id } = req.params

    const result = await pool.query(
      `UPDATE candidaturas SET status = 'recusada', aprovado_por = $1
       WHERE id = $2 RETURNING *`,
      [req.usuario.id, id]
    )

    res.json(result.rows[0])

  } catch (err) {
    res.status(500).json({ erro: 'Erro ao recusar candidatura' })
  }
}

module.exports = { candidatar, minhas, porObra, pendentes, aprovar, recusar }