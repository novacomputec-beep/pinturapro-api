const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { pool } = require('../utils/supabase')
const nodemailer = require('nodemailer')
const crypto = require('crypto')

const gerarToken = (usuario) => jwt.sign(
  { id: usuario.id, role: usuario.role },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
)

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
})

const cadastrar = async (req, res) => {
  try {
    const { nome, email, telefone, senha, cidade,
            especialidades, anos_experiencia, tamanho_equipe,
            cpf_cnpj, tipo_conta } = req.body

    const existente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email])
    if (existente.rows.length > 0) {
      return res.status(409).json({ erro: 'E-mail já cadastrado' })
    }

    const senha_hash = await bcrypt.hash(senha, 12)

    let role = 'assinante'
    if (tipo_conta === 'dono_obra') role = 'dono_obra'
    else if (tipo_conta === 'prestador') role = 'prestador'

    const result = await pool.query(
      `INSERT INTO usuarios (nome, email, telefone, senha_hash, cidade,
        especialidades, anos_experiencia, tamanho_equipe, cpf_cnpj, role, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
       RETURNING id, nome, email, role`,
      [nome, email, telefone, senha_hash, cidade,
       especialidades || [], anos_experiencia || 0,
       tamanho_equipe || 1, cpf_cnpj, role]
    )

    const usuario = result.rows[0]

    if (role === 'dono_obra') {
      await pool.query(
        `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo)
         VALUES ($1, 'mensal', 0, 'ativa', 'gratuito')`,
        [usuario.id]
      )
    } else if (role === 'prestador') {
      await pool.query(
        `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status)
         VALUES ($1, 'mensal', 49.90, 'pendente')`,
        [usuario.id]
      )
    } else {
      await pool.query(
        `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status)
         VALUES ($1, 'mensal', 99.90, 'pendente')`,
        [usuario.id]
      )
    }

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
      usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, role: usuario.role },
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
    res.json({ usuario: result.rows[0], assinatura: assinaturaResult.rows[0] || null })
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

const alterarSenha = async (req, res) => {
  try {
    const { senha_atual, nova_senha } = req.body

    if (!senha_atual || !nova_senha) {
      return res.status(400).json({ erro: 'Informe a senha atual e a nova senha' })
    }
    if (nova_senha.length < 8) {
      return res.status(400).json({ erro: 'A nova senha deve ter pelo menos 8 caracteres' })
    }

    const result = await pool.query(
      'SELECT senha_hash FROM usuarios WHERE id = $1',
      [req.usuario.id]
    )

    const senhaValida = await bcrypt.compare(senha_atual, result.rows[0].senha_hash)
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha atual incorreta' })
    }

    const nova_hash = await bcrypt.hash(nova_senha, 12)
    await pool.query(
      'UPDATE usuarios SET senha_hash = $1 WHERE id = $2',
      [nova_hash, req.usuario.id]
    )

    res.json({ mensagem: 'Senha alterada com sucesso' })
  } catch (err) {
    console.error('Erro ao alterar senha:', err)
    res.status(500).json({ erro: 'Erro ao alterar senha' })
  }
}

const esqueciSenha = async (req, res) => {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ erro: 'Informe o e-mail' })
    }

    // Sempre retorna sucesso para não revelar se o e-mail existe
    res.json({ mensagem: 'Se este e-mail estiver cadastrado, você receberá as instruções em breve.' })

    // Busca o usuário de forma assíncrona
    const result = await pool.query('SELECT id, nome, email FROM usuarios WHERE email = $1', [email])
    if (result.rows.length === 0) return

    const usuario = result.rows[0]
    const token = crypto.randomBytes(32).toString('hex')
    const expira = new Date(Date.now() + 3600000) // 1 hora

    // Salva o token de redefinição
    await pool.query(
      `UPDATE usuarios SET reset_token = $1, reset_token_expira = $2 WHERE id = $3`,
      [token, expira, usuario.id]
    )

    // Envia o e-mail
    await transporter.sendMail({
      from: `PinturaPro <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
      to: email,
      subject: 'PinturaPro — Redefinição de senha',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #0a0a0a; margin: 0;">PinturaPro</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2>Olá, ${usuario.nome}!</h2>
            <p>Recebemos uma solicitação para redefinir a senha da sua conta.</p>
            <p>Seu código de redefinição é:</p>
            <div style="background: #0a0a0a; color: #E8833A; font-size: 32px; font-weight: bold; text-align: center; padding: 20px; border-radius: 8px; letter-spacing: 8px; margin: 20px 0;">
              ${token.substring(0, 6).toUpperCase()}
            </div>
            <p style="color: #666; font-size: 13px;">Este código expira em 1 hora.</p>
            <p style="color: #666; font-size: 13px;">Se você não solicitou a redefinição, ignore este e-mail.</p>
            <p><strong>Equipe PinturaPro</strong></p>
          </div>
        </div>
      `
    })

  } catch (err) {
    console.error('Erro ao processar esqueci senha:', err)
  }
}

module.exports = { cadastrar, login, perfil, atualizarPerfil, alterarSenha, esqueciSenha }