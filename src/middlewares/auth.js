const jwt = require('jsonwebtoken')
const { pool } = require('../utils/supabase')

const autenticar = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ erro: 'Token não fornecido' })
    }

    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    const result = await pool.query(
      'SELECT id, nome, email, role, ativo FROM usuarios WHERE id = $1',
      [decoded.id]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ erro: 'Usuário não encontrado' })
    }

    const usuario = result.rows[0]

    if (!usuario.ativo) {
      return res.status(403).json({ erro: 'Conta desativada' })
    }

    req.usuario = usuario
    next()
  } catch (err) {
    console.error('Erro auth:', err.message)
    return res.status(401).json({ erro: 'Token inválido ou expirado' })
  }
}

const exigirAssinaturaAtiva = async (req, res, next) => {
  if (req.usuario.role === 'admin' || req.usuario.role === 'aprovador') {
    return next()
  }

  try {
    const result = await pool.query(
      `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' LIMIT 1`,
      [req.usuario.id]
    )

    if (result.rows.length === 0) {
      return res.status(403).json({
        erro: 'Assinatura inativa. Renove seu plano para acessar as obras.',
        codigo: 'ASSINATURA_INATIVA'
      })
    }

    next()
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao verificar assinatura' })
  }
}

const exigirAdmin = (req, res, next) => {
  if (!['admin', 'aprovador'].includes(req.usuario.role)) {
    return res.status(403).json({ erro: 'Acesso negado' })
  }
  next()
}

const exigirSuperAdmin = (req, res, next) => {
  if (req.usuario.role !== 'admin') {
    return res.status(403).json({ erro: 'Acesso restrito ao administrador' })
  }
  next()
}

module.exports = { autenticar, exigirAssinaturaAtiva, exigirAdmin, exigirSuperAdmin }