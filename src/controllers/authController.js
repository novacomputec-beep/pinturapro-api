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
    const { nome, email, telefone, senha, cidade, uf,
            especialidades, anos_experiencia, tamanho_equipe,
            cpf_cnpj, tipo_conta, plano,
            verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url,
            pix_reembolso, referencias } = req.body

    const existente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email])
    if (existente.rows.length > 0) {
      return res.status(409).json({ erro: 'E-mail já cadastrado' })
    }

    const senha_hash = await bcrypt.hash(senha, 12)

    let role = 'assinante'
    if (tipo_conta === 'dono_obra' || tipo_conta === 'dono_reparo') role = 'dono_obra'
    else if (tipo_conta === 'prestador') role = 'prestador'

    let usuario
    if (role === 'prestador') {
      const result = await pool.query(
        `INSERT INTO usuarios (nome, email, telefone, senha_hash, cidade, uf,
          especialidades, anos_experiencia, tamanho_equipe, cpf_cnpj, role, ativo,
          verificacao_status, verificacao_doc_frente_url, verificacao_doc_verso_url,
          verificacao_selfie_url, pix_reembolso, referencias)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,'pendente',$12,$13,$14,$15,$16)
         RETURNING id, nome, email, role`,
        [nome, email, telefone, senha_hash, cidade, uf || null,
         especialidades || [], anos_experiencia || 0, tamanho_equipe || 1, cpf_cnpj, role,
         verificacao_doc_frente_url || null,
         verificacao_doc_verso_url || null,
         verificacao_selfie_url || null,
         pix_reembolso || null,
         referencias ? JSON.stringify(referencias) : null]
      )
      usuario = result.rows[0]
    } else {
      const result = await pool.query(
        `INSERT INTO usuarios (nome, email, telefone, senha_hash, cidade, uf,
          especialidades, anos_experiencia, tamanho_equipe, cpf_cnpj, role, ativo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
         RETURNING id, nome, email, role`,
        [nome, email, telefone, senha_hash, cidade, uf || null,
         especialidades || [], anos_experiencia || 0, tamanho_equipe || 1, cpf_cnpj, role]
      )
      usuario = result.rows[0]
    }

    let assinaturaValor = 99.90
    let assinaturaTipo = null
    if (role === 'dono_obra') {
      await pool.query(
        `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo)
         VALUES ($1, 'mensal', 0, 'ativa', 'gratuito')`,
        [usuario.id]
      )
      assinaturaValor = 0
      assinaturaTipo = 'gratuito'
    } else if (role === 'prestador') {
      const valorPrestador = plano === 'anual' ? 499.00 : 49.90
      await pool.query(
        `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status)
         VALUES ($1, $2, $3, 'pendente')`,
        [usuario.id, plano || 'mensal', plano === 'anual' ? 499.00 : 49.90]
      )
      assinaturaValor = valorPrestador
    } else {
      const valorAssinante = plano === 'anual' ? 999.00 : 99.90
      await pool.query(
        `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status)
         VALUES ($1, $2, $3, 'pendente')`,
        [usuario.id, plano || 'mensal', valorAssinante]
      )
      assinaturaValor = valorAssinante
    }

    const assinaturaResult = await pool.query(
      `SELECT status, plano, valor_mensal FROM assinaturas WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [usuario.id]
    )

    const token = gerarToken(usuario)
    res.status(201).json({ usuario, token, assinatura: assinaturaResult.rows[0] || null })

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