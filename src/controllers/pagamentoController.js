const { MercadoPagoConfig, PreApproval, Payment } = require('mercadopago')
const { pool } = require('../utils/supabase')

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
})

const preApproval = new PreApproval(client)

// POST /pagamentos/criar-assinatura
const criarAssinatura = async (req, res) => {
  try {
    const { plano = 'mensal' } = req.body
    const usuario = req.usuario
    const valor = plano === 'anual' ? 83.25 : 99.90

    const resultado = await preApproval.create({
      body: {
        payer_email: usuario.email,
        reason: `PinturaPro — Plano ${plano === 'anual' ? 'Anual' : 'Mensal'}`,
        external_reference: usuario.id,
        auto_recurring: {
          frequency: 1,
          frequency_type: plano === 'anual' ? 'years' : 'months',
          transaction_amount: valor,
          currency_id: 'BRL'
        },
        back_url: 'https://pinturapro-painel-production.up.railway.app',
        status: 'pending'
      }
    })

    res.json({
      init_point: resultado.init_point,
      id: resultado.id
    })

  } catch (err) {
    console.error('Erro ao criar assinatura MP:', err)
    res.status(500).json({ erro: 'Erro ao criar assinatura' })
  }
}

// POST /pagamentos/webhook
const webhook = async (req, res) => {
  try {
    const { type, data } = req.body

    if (type === 'subscription_preapproval') {
      const assinatura = await preApproval.get({ id: data.id })

      const usuarioId = assinatura.external_reference
      const status = assinatura.status === 'authorized' ? 'ativa' : 'cancelada'

      await pool.query(
        `UPDATE assinaturas SET status = $1, mp_subscription_id = $2, atualizado_em = NOW()
         WHERE usuario_id = $3`,
        [status, assinatura.id, usuarioId]
      )

      console.log(`Assinatura ${data.id} atualizada para ${status}`)
    }

    res.sendStatus(200)
  } catch (err) {
    console.error('Erro no webhook MP:', err)
    res.sendStatus(200)
  }
}

// POST /pagamentos/acesso-gratuito (admin only)
const darAcessoGratuito = async (req, res) => {
  try {
    const { usuario_id } = req.body

    const assinaturaExiste = await pool.query(
      `SELECT id FROM assinaturas WHERE usuario_id = $1`,
      [usuario_id]
    )

    if (assinaturaExiste.rows.length > 0) {
      await pool.query(
        `UPDATE assinaturas SET status = 'ativa', tipo = 'gratuito', atualizado_em = NOW()
         WHERE usuario_id = $1`,
        [usuario_id]
      )
    } else {
      await pool.query(
        `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo)
         VALUES ($1, 'mensal', 0, 'ativa', 'gratuito')`,
        [usuario_id]
      )
    }

    res.json({ mensagem: 'Acesso gratuito concedido com sucesso' })

  } catch (err) {
    console.error('Erro ao dar acesso gratuito:', err)
    res.status(500).json({ erro: 'Erro ao conceder acesso' })
  }
}

// GET /pagamentos/assinantes (admin only)
const listarAssinantes = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.nome, u.email, u.telefone, u.cidade,
             a.status, a.plano, a.tipo, a.criado_em
      FROM usuarios u
      LEFT JOIN assinaturas a ON a.usuario_id = u.id
      WHERE u.role = 'assinante'
      ORDER BY a.criado_em DESC
    `)
    res.json({ assinantes: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar assinantes' })
  }
}

module.exports = { criarAssinatura, webhook, darAcessoGratuito, listarAssinantes }