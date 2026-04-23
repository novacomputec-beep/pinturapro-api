const jwt = require('jsonwebtoken')
const supabase = require('../utils/supabase')

// Verifica se o token JWT é válido e se o usuário tem assinatura ativa
const autenticar = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ erro: 'Token não fornecido' })
    }

    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('id, nome, email, role, ativo')
      .eq('id', decoded.id)
      .single()

    if (error || !usuario) {
      return res.status(401).json({ erro: 'Usuário não encontrado' })
    }

    if (!usuario.ativo) {
      return res.status(403).json({ erro: 'Conta desativada' })
    }

    req.usuario = usuario
    next()
  } catch (err) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' })
  }
}

// Verifica se o assinante tem assinatura ativa
const exigirAssinaturaAtiva = async (req, res, next) => {
  if (req.usuario.role === 'admin' || req.usuario.role === 'aprovador') {
    return next()
  }

  const { data: assinatura } = await supabase
    .from('assinaturas')
    .select('status')
    .eq('usuario_id', req.usuario.id)
    .eq('status', 'ativa')
    .single()

  if (!assinatura) {
    return res.status(403).json({
      erro: 'Assinatura inativa. Renove seu plano para acessar as obras.',
      codigo: 'ASSINATURA_INATIVA'
    })
  }

  next()
}

// Verifica se é admin ou aprovador
const exigirAdmin = (req, res, next) => {
  if (!['admin', 'aprovador'].includes(req.usuario.role)) {
    return res.status(403).json({ erro: 'Acesso negado' })
  }
  next()
}

// Verifica se é somente admin
const exigirSuperAdmin = (req, res, next) => {
  if (req.usuario.role !== 'admin') {
    return res.status(403).json({ erro: 'Acesso restrito ao administrador' })
  }
  next()
}

module.exports = { autenticar, exigirAssinaturaAtiva, exigirAdmin, exigirSuperAdmin }
