const jwt = require('jsonwebtoken')
const { pool } = require('../utils/supabase')

// Cache simples em memória
const cacheUsuarios = new Map()
const cacheAssinaturas = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutos

const getCacheUsuario = (id) => {
  const entry = cacheUsuarios.get(id)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cacheUsuarios.delete(id)
    return null
  }
  return entry.data
}

const setCacheUsuario = (id, data) => {
  cacheUsuarios.set(id, { data, timestamp: Date.now() })
}

const getCacheAssinatura = (id) => {
  const entry = cacheAssinaturas.get(id)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cacheAssinaturas.delete(id)
    return null
  }
  return entry.data
}

const setCacheAssinatura = (id, data) => {
  cacheAssinaturas.set(id, { data, timestamp: Date.now() })
}

// Invalida os caches em memória de um usuário. Chamado quando a assinatura muda
// de estado (ex.: aprovação manual / auto-aprovação ativa a assinatura) para que
// a próxima chamada a rota protegida releia o status real do banco em vez de
// devolver um `false` cacheado por até 5 min — o que mandava o prestador recém-
// aprovado para a tela de pagamento mesmo já tendo pago/sido aprovado (B72-07).
const invalidarCacheAssinatura = (id) => {
  cacheUsuarios.delete(id)
  cacheAssinaturas.delete(id)
}

const autenticar = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ erro: 'Token não fornecido' })
    }
    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    // Tenta cache primeiro
    let usuario = getCacheUsuario(decoded.id)
    if (!usuario) {
      const result = await pool.query(
        'SELECT id, nome, email, role, ativo FROM usuarios WHERE id = $1',
        [decoded.id]
      )
      if (result.rows.length === 0) {
        return res.status(401).json({ erro: 'Usuário não encontrado' })
      }
      usuario = result.rows[0]
      setCacheUsuario(decoded.id, usuario)
    }

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
  if (req.usuario.role === 'admin' || req.usuario.role === 'aprovador' || req.usuario.role === 'dono_obra') {
    return next()
  }
  try {
    // Correção: usar null como sentinela de "não está no cache"
    // false significa "está no cache e assinatura é inativa" — não deve ir ao banco
    let assinaturaAtiva = getCacheAssinatura(req.usuario.id)
    if (assinaturaAtiva === null || assinaturaAtiva === undefined) {
      const result = await pool.query(
        `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' AND (proximo_vencimento IS NULL OR proximo_vencimento > NOW()) LIMIT 1`,
        [req.usuario.id]
      )
      assinaturaAtiva = result.rows.length > 0
      setCacheAssinatura(req.usuario.id, assinaturaAtiva)
    }

    if (!assinaturaAtiva) {
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

module.exports = { autenticar, exigirAssinaturaAtiva, exigirAdmin, exigirSuperAdmin, invalidarCacheAssinatura }