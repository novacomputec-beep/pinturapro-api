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
            cpf_cnpj, tipo_conta, pix_reembolso, referencias,
            verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url } = req.body

    if (!nome || !email || !senha) {
      return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' })
    }
    if (senha.length < 8) {
      return res.status(400).json({ erro: 'A senha deve ter pelo menos 8 caracteres' })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ erro: 'E-mail inválido' })
    }

    const emailNormalizado = email.toLowerCase().trim()

    const existente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [emailNormalizado])
    if (existente.rows.length > 0) {
      return res.status(409).json({ erro: 'E-mail já cadastrado' })
    }

    const senha_hash = await bcrypt.hash(senha, 12)

    let role = 'assinante'
    if (tipo_conta === 'dono_obra') role = 'dono_obra'
    else if (tipo_conta === 'prestador') role = 'prestador'

    // Define tipo_dono para distinguir donos de pintura vs reparo
    let tipo_dono = null
    if (tipo_conta === 'dono_obra') tipo_dono = 'pintura'
    else if (tipo_conta === 'dono_reparo') { role = 'dono_obra'; tipo_dono = 'reparo' }

    const result = await pool.query(
      `INSERT INTO usuarios (nome, email, telefone, senha_hash, cidade,
        especialidades, anos_experiencia, tamanho_equipe, cpf_cnpj, role, ativo,
        tipo_dono, pix_reembolso, referencias,
        verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13,$14,$15,$16)
       RETURNING id, nome, email, role`,
      [nome.trim(), emailNormalizado, telefone, senha_hash, cidade,
       especialidades || [], anos_experiencia || 0,
       tamanho_equipe || 1, cpf_cnpj, role,
       tipo_dono,
       pix_reembolso || null,
       JSON.stringify(referencias || []),
       verificacao_doc_frente_url || null,
       verificacao_doc_verso_url || null,
       verificacao_selfie_url || null]
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

    setImmediate(async () => {
      try {
        const { enviarBoasVindas } = require('../services/alertaService')
        await enviarBoasVindas(usuario.id)
      } catch (err) {
        console.error('Erro ao enviar boas-vindas:', err)
      }
    })

  } catch (err) {
    console.error('Erro no cadastro DETALHADO:', err.message, err.stack)
    res.status(500).json({ erro: err.message || 'Erro ao criar conta' })
  }
}

const login = async (req, res) => {
  try {
    const { email, senha } = req.body

    if (!email || !senha) {
      return res.status(400).json({ erro: 'E-mail e senha são obrigatórios' })
    }

    const emailNormalizado = email.toLowerCase().trim()

    const result = await pool.query(
      'SELECT id, nome, email, role, senha_hash, ativo, foto_url FROM usuarios WHERE email = $1',
      [emailNormalizado]
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
        role: usuario.role,
        foto_url: usuario.foto_url || null
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
      'SELECT id, nome, email, telefone, cidade, especialidades, anos_experiencia, tamanho_equipe, role, foto_url, tipo_dono FROM usuarios WHERE id = $1',
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

    if (!nome || !nome.trim()) {
      return res.status(400).json({ erro: 'Nome é obrigatório' })
    }

    const result = await pool.query(
      'UPDATE usuarios SET nome=$1, telefone=$2, cidade=$3 WHERE id=$4 RETURNING id, nome, email, cidade, foto_url',
      [nome.trim(), telefone, cidade, req.usuario.id]
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
    if (senha_atual === nova_senha) {
      return res.status(400).json({ erro: 'A nova senha deve ser diferente da senha atual' })
    }
    const result = await pool.query('SELECT senha_hash FROM usuarios WHERE id = $1', [req.usuario.id])
    const senhaValida = await bcrypt.compare(senha_atual, result.rows[0].senha_hash)
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha atual incorreta' })
    }
    const nova_hash = await bcrypt.hash(nova_senha, 12)
    await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [nova_hash, req.usuario.id])
    res.json({ mensagem: 'Senha alterada com sucesso' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao alterar senha' })
  }
}

const esqueciSenha = async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ erro: 'Informe o e-mail' })

    const emailNormalizado = email.toLowerCase().trim()

    res.json({ mensagem: 'Se este e-mail estiver cadastrado, você receberá as instruções em breve.' })

    const result = await pool.query('SELECT id, nome, email FROM usuarios WHERE email = $1', [emailNormalizado])
    if (result.rows.length === 0) return

    const usuario = result.rows[0]
    const tokenCompleto = crypto.randomBytes(32).toString('hex')
    const codigoExibido = tokenCompleto.substring(0, 6).toUpperCase()
    const expira = new Date(Date.now() + 3600000)

    await pool.query(
      `UPDATE usuarios SET reset_token = $1, reset_token_expira = $2 WHERE id = $3`,
      [tokenCompleto, expira, usuario.id]
    )

    await transporter.sendMail({
      from: `PinturaPro <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
      to: emailNormalizado,
      subject: 'PinturaPro — Redefinição de senha',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #0a0a0a; margin: 0;">PinturaPro</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2>Olá, ${usuario.nome}!</h2>
            <p>Seu código de redefinição é:</p>
            <div style="background: #0a0a0a; color: #E8833A; font-size: 32px; font-weight: bold; text-align: center; padding: 20px; border-radius: 8px; letter-spacing: 8px; margin: 20px 0;">
              ${codigoExibido}
            </div>
            <p style="color: #666; font-size: 13px;">Este código expira em 1 hora.</p>
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