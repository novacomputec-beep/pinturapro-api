const { pool } = require('../utils/supabase')

const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN
const PAGBANK_URL = 'https://sandbox.api.pagseguro.com'
const APP_URL = 'https://pinturapro-api-production.up.railway.app/api'

const criarAssinatura = async (req, res) => {
  try {
    const { plano = 'mensal' } = req.body
    const usuario = req.usuario

    let valor = 9990 // em centavos
    let descricao = 'PinturaPro — Plano Mensal'

    if (usuario.role === 'prestador') {
      valor = plano === 'anual' ? 49900 : 4990
      descricao = `PinturaPro Serviços — Plano ${plano === 'anual' ? 'Anual' : 'Mensal'}`
    } else {
      valor = plano === 'anual' ? 99900 : 9990
      descricao = `PinturaPro — Plano ${plano === 'anual' ? 'Anual' : 'Mensal'}`
    }

    const body = {
      reference_id: `${usuario.id}|${plano}`,
      customer: {
        name: usuario.nome || 'Cliente PinturaPro',
        email: usuario.email,
        tax_id: '00000000000', // CPF placeholder — ideal pedir no cadastro
        phones: [{ country: '55', area: '34', number: '999999999', type: 'MOBILE' }]
      },
      items: [
        {
          reference_id: `plano_${plano}`,
          name: descricao,
          quantity: 1,
          unit_amount: valor
        }
      ],
      payment_methods: [
        { type: 'CREDIT_CARD' },
        { type: 'PIX' }
      ],
      redirect_url: `${APP_URL}/pagamentos/sucesso`,
      notification_urls: [`${APP_URL}/pagamentos/webhook-pagbank`],
      soft_descriptor: 'PinturaPro'
    }

    const response = await fetch(`${PAGBANK_URL}/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAGBANK_TOKEN}`,
        'Content-Type': 'application/json',
        'x-api-version': '4.0'
      },
      body: JSON.stringify(body)
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('Erro PagBank:', JSON.stringify(data))
      return res.status(500).json({ erro: 'Erro ao criar pagamento', detalhe: data })
    }

    // Pega o link de pagamento
    const linkPagamento = data.links?.find(l => l.rel === 'PAY')?.href
      || data.links?.find(l => l.rel === 'pay')?.href
      || data.links?.[0]?.href

    res.json({
      init_point: linkPagamento,
      order_id: data.id,
      status: data.status
    })

  } catch (err) {
    console.error('Erro ao criar preferência PagBank:', err)
    res.status(500).json({ erro: 'Erro ao criar assinatura' })
  }
}

const sucesso = async (req, res) => {
  try {
    const { reference_id, status } = req.query
    if ((status === 'PAID' || status === 'approved') && reference_id) {
      const [usuarioId, plano] = reference_id.split('|')
      await pool.query(
        `UPDATE assinaturas SET status = 'ativa', plano = $1, atualizado_em = NOW() WHERE usuario_id = $2`,
        [plano || 'mensal', usuarioId]
      )
      console.log(`Pagamento aprovado para usuário ${usuarioId}`)
    }
    res.redirect('https://pinturapro-painel-production.up.railway.app')
  } catch (err) {
    res.redirect('https://pinturapro-painel-production.up.railway.app')
  }
}

const webhookPagbank = async (req, res) => {
  try {
    const { reference_id, charges } = req.body

    if (reference_id && charges?.length > 0) {
      const charge = charges[0]
      if (charge.status === 'PAID') {
        const [usuarioId, plano] = reference_id.split('|')
        await pool.query(
          `UPDATE assinaturas SET status = 'ativa', plano = $1, atualizado_em = NOW() WHERE usuario_id = $2`,
          [plano || 'mensal', usuarioId]
        )
        console.log(`Webhook PagBank: pagamento aprovado para ${usuarioId}`)
      }
    }
    res.sendStatus(200)
  } catch (err) {
    console.error('Erro no webhook PagBank:', err)
    res.sendStatus(200)
  }
}

// Mantemos o webhook do MP por compatibilidade
const webhook = async (req, res) => {
  try {
    const { type, data } = req.body
    if (type === 'payment' && data?.id) {
      const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
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
      }
    }
    res.sendStatus(200)
  } catch (err) {
    res.sendStatus(200)
  }
}

const darAcessoGratuito = async (req, res) => {
  try {
    const { usuario_id } = req.body
    const assinaturaExiste = await pool.query(`SELECT id FROM assinaturas WHERE usuario_id = $1`, [usuario_id])
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
    res.status(500).json({ erro: 'Erro ao conceder acesso' })
  }
}

const listarAssinantes = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.nome, u.email, u.telefone, u.cidade, u.role,
             a.status, a.plano, a.tipo, a.criado_em
      FROM usuarios u
      LEFT JOIN assinaturas a ON a.usuario_id = u.id
      WHERE u.role IN ('assinante', 'prestador')
      ORDER BY a.criado_em DESC
    `)
    res.json({ assinantes: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar assinantes' })
  }
}

module.exports = { criarAssinatura, sucesso, webhook, webhookPagbank, darAcessoGratuito, listarAssinantes }