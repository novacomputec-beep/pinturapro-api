const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { pool } = require('../utils/supabase')

const gerarToken = (usuario) => jwt.sign(
  { id: usuario.id, role: usuario.role },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
)

const cadastrar = async (req, res) => {
  try {
    const { nome, email, telefone, senha, cidade,
            especialidades, anos_experiencia, tamanho_equipe, cpf_cnpj } = req.body

    const existente = await pool.query(
      'SELECT id FROM usuarios WHERE email = $1', [email]
    )
    if (existente.rows.length > 0) {
      return res.status(409).json({ erro: 'E-mail já cadastrado' })
    }

    const senha_hash = await bcrypt.hash(senha, 12)

    const result = await pool.query(
      `INSERT INTO usuarios (nome, email, telefone, senha_hash, cidade,
        especialidades, anos_experiencia, tamanho_equipe, cpf_cnpj, role, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'assinante',true)
       RETURNING id, nome, email, role`,
      [nome, email, telefone, senha_hash, cidade,
       especialidades || [], anos_experiencia || 0,
       tamanho_equipe || 1, cpf_cnpj]
    )

    const usuario = result.rows[0]

    // Cria assinatura ativa automaticamente
    await pool.query(
      `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status)
       VALUES ($1, 'mensal', 99.90, 'ativa')`,
      [usuario.id]
    )

    const token = gerarToken(usuario)
    res.status(201).json({ usuario, token })

  } catch (err) {
    console.error('Erro no cadastro:', err)
    res.status(500).json({ erro: 'Erro ao criar conta' })
  }
}

const login = async (req, res) => {
  try {
    const { email, senha } = req.body

    const result = await pool.query(
      'SELECT id, nome, email, role, senha_hash, ativo FROM usuarios WHERE email = $1',
      [email]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' })
    }

    const usuario = result.rows[0]

    if (!usuario.ativo) {
      return res.status(403).json({ erro: 'Conta desativada' })
    }

    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash)
    if (!senhaValida) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' })
    }

    const assinaturaResult = await pool.query(
      `SELECT status, plano, proximo_vencimento FROM assinaturas
       WHERE usuario_id = $1 AND status = 'ativa' LIMIT 1`,
      [usuario.id]
    )

    const token = gerarToken(usuario)

    res.json({
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        role: usuario.role
      },
      assinatura: assinaturaResult.rows[0] || null,
      token
    })

  } catch (err) {
    console.error('Erro no login:', err)
    res.status(500).json({ erro: 'Erro ao fazer login' })
  }
}

const perfil = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nome, email, telefone, cidade, especialidades, anos_experiencia, tamanho_equipe, role FROM usuarios WHERE id = $1',
      [req.usuario.id]
    )

    const assinaturaResult = await pool.query(
      `SELECT plano, status, proximo_vencimento FROM assinaturas
       WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [req.usuario.id]
    )

    res.json({
      usuario: result.rows[0],
      assinatura: assinaturaResult.rows[0] || null
    })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar perfil' })
  }
}

const atualizarPerfil = async (req, res) => {
  try {
    const { nome, telefone, cidade } = req.body
    const result = await pool.query(
      'UPDATE usuarios SET nome=$1, telefone=$2, cidade=$3 WHERE id=$4 RETURNING id, nome, email, cidade',
      [nome, telefone, cidade, req.usuario.id]
    )
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar perfil' })
  }
}

module.exports = { cadastrar, login, perfil, atualizarPerfil }