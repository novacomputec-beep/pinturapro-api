const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const supabase = require('../utils/supabase')

const gerarToken = (usuario) => jwt.sign(
  { id: usuario.id, role: usuario.role },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
)

// POST /auth/cadastro
const cadastrar = async (req, res) => {
  try {
    const { nome, email, telefone, senha, cidade, latitude, longitude,
            especialidades, anos_experiencia, tamanho_equipe, cpf_cnpj } = req.body

    // Verifica se e-mail já existe
    const { data: existente } = await supabase
      .from('usuarios')
      .select('id')
      .eq('email', email)
      .single()

    if (existente) {
      return res.status(409).json({ erro: 'E-mail já cadastrado' })
    }

    const senha_hash = await bcrypt.hash(senha, 12)

    const { data: usuario, error } = await supabase
      .from('usuarios')
      .insert({
        nome, email, telefone, senha_hash, cidade,
        latitude, longitude,
        especialidades: especialidades || [],
        anos_experiencia: anos_experiencia || 0,
        tamanho_equipe: tamanho_equipe || 1,
        cpf_cnpj,
        role: 'assinante'
      })
      .select('id, nome, email, role')
      .single()

    if (error) throw error

    const token = gerarToken(usuario)
    res.status(201).json({ usuario, token })

  } catch (err) {
    console.error('Erro no cadastro:', err)
    res.status(500).json({ erro: 'Erro ao criar conta' })
  }
}

// POST /auth/login
const login = async (req, res) => {
  try {
    const { email, senha } = req.body

    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('id, nome, email, role, senha_hash, ativo')
      .eq('email', email)
      .single()

    if (error || !usuario) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' })
    }

    if (!usuario.ativo) {
      return res.status(403).json({ erro: 'Conta desativada' })
    }

    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash)
    if (!senhaValida) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' })
    }

    // Busca assinatura ativa
    const { data: assinatura } = await supabase
      .from('assinaturas')
      .select('status, plano, proximo_vencimento')
      .eq('usuario_id', usuario.id)
      .eq('status', 'ativa')
      .single()

    const token = gerarToken(usuario)

    res.json({
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        role: usuario.role
      },
      assinatura: assinatura || null,
      token
    })

  } catch (err) {
    console.error('Erro no login:', err)
    res.status(500).json({ erro: 'Erro ao fazer login' })
  }
}

// GET /auth/perfil
const perfil = async (req, res) => {
  try {
    const { data: usuario } = await supabase
      .from('usuarios')
      .select('id, nome, email, telefone, cidade, especialidades, anos_experiencia, tamanho_equipe, avatar_url, role')
      .eq('id', req.usuario.id)
      .single()

    const { data: assinatura } = await supabase
      .from('assinaturas')
      .select('plano, status, proximo_vencimento')
      .eq('usuario_id', req.usuario.id)
      .order('criado_em', { ascending: false })
      .limit(1)
      .single()

    res.json({ usuario, assinatura })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar perfil' })
  }
}

// PUT /auth/perfil
const atualizarPerfil = async (req, res) => {
  try {
    const campos = ['nome', 'telefone', 'cidade', 'latitude', 'longitude',
                    'especialidades', 'anos_experiencia', 'tamanho_equipe']
    const atualizacao = {}
    campos.forEach(c => { if (req.body[c] !== undefined) atualizacao[c] = req.body[c] })

    const { data, error } = await supabase
      .from('usuarios')
      .update(atualizacao)
      .eq('id', req.usuario.id)
      .select('id, nome, email, cidade')
      .single()

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar perfil' })
  }
}

module.exports = { cadastrar, login, perfil, atualizarPerfil }
