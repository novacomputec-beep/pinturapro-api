const jwt = require('jsonwebtoken')
const { pool } = require('../utils/supabase')

// Cache simples em memória
const cacheUsuarios = new Map()
const cacheAssinaturas = new Map()
// 30s (era 5 min): o cache é POR PROCESSO, então invalidarCacheAssinatura só limpa a réplica
// que atendeu a requisição — com mais de uma, um prestador recém-aprovado seguiria barrado
// nas outras até o TTL vencer. 30s limita essa janela sem largar o cache. As duas consultas
// por trás dele são de uma linha por índice (usuarios_pkey e assinaturas_usuario_id_unico_idx),
// então o custo dos misses extras é baixo.
const CACHE_TTL = 30 * 1000

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

// Fonte ÚNICA da resposta "este usuário tem assinatura ativa?", com o cache por trás.
// Existia uma segunda cópia em routes/index.js (cachePrestadores) com a MESMA consulta e o
// MESMO predicado: dois mapas guardando a mesma resposta, e por isso a invalidação precisava
// lembrar de limpar os dois — que foi exatamente o esquecimento do B72-07. Agora exigirPrestador
// (routes) e exigirAssinaturaAtiva (aqui) passam os dois por esta função.
const assinaturaAtivaCacheada = async (usuarioId) => {
  // getCacheAssinatura devolve null quando não há entrada ou ela expirou; `false` cacheado é
  // resposta legítima e NÃO pode ir ao banco de novo.
  let ativa = getCacheAssinatura(usuarioId)
  if (ativa === null || ativa === undefined) {
    const result = await pool.query(
      `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' AND (proximo_vencimento IS NULL OR proximo_vencimento > NOW()) LIMIT 1`,
      [usuarioId]
    )
    ativa = result.rows.length > 0
    setCacheAssinatura(usuarioId, ativa)
  }
  return ativa
}

const autenticar = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ erro: 'Token não fornecido' })
    }
    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.tipo === '2fa_pendente') {
      return res.status(401).json({ erro: 'Autenticação incompleta — código 2FA necessário' })
    }

    // Tenta cache primeiro
    let usuario = getCacheUsuario(decoded.id)
    if (!usuario) {
      const result = await pool.query(
        'SELECT id, nome, email, role, ativo, tipo_prestador, suspenso_em, suspenso_motivo FROM usuarios WHERE id = $1',
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
    const assinaturaAtiva = await assinaturaAtivaCacheada(req.usuario.id)

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

// Suspensão por faltas (ver registrarFalta em alertaService). Fecha só a porta de ENTRADA em
// trabalho novo: feeds, proximidade e criação/aceite de proposta. Tudo que já está em
// andamento — match, chegada, encerramento, avaliação, denúncia, perfil, login — segue aberto,
// porque suspender alguém no meio de um serviço puniria o dono junto.
// admin/aprovador nunca são barrados (moderação não pode se autotrancar).
// suspenso_em vem de req.usuario, populado por autenticar — atenção ao cache de 5 min de lá.
// Corpo do 403 de conta suspensa, exportado para os pontos que checam a suspensão FORA do
// middleware (aceites, onde a decisão depende da action) não reescreverem o texto por conta
// própria e acabarem divergindo dele.
const corpoContaSuspensa = ({ suspenso_em, suspenso_motivo }) => ({
  erro: suspenso_motivo
    ? `Conta suspensa por ${suspenso_motivo}. Você não pode pegar novos trabalhos. Fale com o suporte para regularizar.`
    : 'Conta suspensa. Você não pode pegar novos trabalhos. Fale com o suporte para regularizar.',
  codigo: 'CONTA_SUSPENSA',
  suspenso_em,
})

const exigirNaoSuspenso = (req, res, next) => {
  if (req.usuario.role === 'admin' || req.usuario.role === 'aprovador') return next()
  if (req.usuario.suspenso_em) {
    return res.status(403).json(corpoContaSuspensa(req.usuario))
  }
  next()
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

module.exports = { autenticar, exigirAssinaturaAtiva, exigirNaoSuspenso, corpoContaSuspensa, exigirAdmin, exigirSuperAdmin, invalidarCacheAssinatura, assinaturaAtivaCacheada }