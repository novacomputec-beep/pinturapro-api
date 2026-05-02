const { pool } = require('../utils/supabase')

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN

const criarAssinatura = async (req, res) => {
  try {
    const { plano = 'mensal' } = req.body
    const usuario = req.usuario
    const valor = plano === 'anual' ? 999.00 : 99.90
    const descricao = `PinturaPro — Plano ${plano === 'anual' ? 'Anual' : 'Mensal'}`

    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        items: [
          {
            title: descricao,
            quantity: 1,
            unit_price: valor,
            currency_id: 'BRL'
          }
        ],
        payer: { email: usuario.email },
        external_reference: `${usuario.id}|${plano}`,
        back_urls: {
          success: 'https://pinturapro-api-production.up.railway.app/api/pagamentos/sucesso',
          failure: 'https://pinturapro-api-production.up.railway.app/api/pagamentos/falha',
          pending: 'https://pinturapro-api-production.up.railway.app/api/pagamentos/pendente'
        },
        auto_return: 'approved',
        notification_url: 'https://pinturapro-api-production.up.railway.app/api/pagamentos/webhook'
      })
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('Erro MP:', data)
      return res.status(500).json({ erro: 'Erro ao criar pagamento' })
    }

    res.json({
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
      id: data.id
    })

  } catch (err) {
    console.error('Erro ao criar preferência MP:', err)
    res.status(500).json({ erro: 'Erro ao criar assinatura' })
  }
}

const sucesso = async (req, res) => {
  try {
    const { external_reference, status } = req.query

    if (status === 'approved' && external_reference) {
      const [usuarioId, plano] = external_reference.split('|')
      await pool.query(
        `UPDATE assinaturas SET status = 'ativa', plano = $1, atualizado_em = NOW() WHERE usuario_id = $2`,
        [plano || 'mensal', usuarioId]
      )
      console.log(`Pagamento aprovado para usuário ${usuarioId}`)
    }

    res.redirect('https://pinturapro-painel-production.up.railway.app')
  } catch (err) {
    console.error('Erro no retorno de pagamento:', err)
    res.redirect('https://pinturapro-painel-production.up.railway.app')
  }
}

const webhook = async (req, res) => {
  try {
    const { type, data } = req.body

    if (type === 'payment' && data?.id) {
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
      })
      const pagamento = await response.json()

      if (pagamento.status === 'approved' && pagamento.external_reference) {
        const [usuarioId, plano] = pagamento.external_reference.split('|')
        await pool.query(
          `UPDATE assinaturas SET status = 'ativa', plano = $1, atualizado_em = NOW() WHERE usuario_id = $2`,
          [plano || 'mensal', usuarioId]
        )
        console.log(`Webhook: pagamento aprovado para ${usuarioId}`)
      }
    }

    res.sendStatus(200)
  } catch (err) {
    console.error('Erro no webhook MP:', err)
    res.sendStatus(200)
  }
}

const darAcessoGratuito = async (req, res) => {
  try {
    const { usuario_id } = req.body

    const assinaturaExiste = await pool.query(
      `SELECT id FROM assinaturas WHERE usuario_id = $1`,
      [usuario_id]
    )

    if (assinaturaExiste.rows.length > 0) {
      await pool.query(
        `UPDATE assinaturas SET status = 'ativa', tipo = 'gratuito', atualizado_em = NOW() WHERE usuario_id = $1`,
        [usuario_id]
      )
    } else {
      await pool.query(
        `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo) VALUES ($1, 'mensal', 0, 'ativa', 'gratuito')`,
        [usuario_id]
      )
    }

    res.json({ mensagem: 'Acesso gratuito concedido com sucesso' })

  } catch (err) {
    console.error('Erro ao dar acesso gratuito:', err)
    res.status(500).json({ erro: 'Erro ao conceder acesso' })
  }
}

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

module.exports = { criarAssinatura, sucesso, webhook, darAcessoGratuito, listarAssinantes }