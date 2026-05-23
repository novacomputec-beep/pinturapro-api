const { pool } = require('../utils/supabase')

const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN
const PAGBANK_URL = 'https://api.pagseguro.com'
const APP_URL = 'https://pinturapro-api-production.up.railway.app/api'

const limparCpfCnpj = (str) => {
  if (!str) return null
  return str.replace(/\D/g, '')
}

// Utilitário para ativar assinatura com segurança (evita duplicação de código)
const ativarAssinatura = async (usuarioId, plano) => {
  const assinaturaExiste = await pool.query(
    `SELECT id FROM assinaturas WHERE usuario_id = $1`,
    [usuarioId]
  )
  if (assinaturaExiste.rows.length > 0) {
    await pool.query(
      `UPDATE assinaturas SET status = 'ativa', plano = $1, atualizado_em = NOW() WHERE usuario_id = $2`,
      [plano || 'mensal', usuarioId]
    )
  } else {
    await pool.query(
      `INSERT INTO assinaturas (usuario_id, plano, status, atualizado_em) VALUES ($1, $2, 'ativa', NOW())`,
      [usuarioId, plano || 'mensal']
    )
  }
}

const criarAssinatura = async (req, res) => {
  try {
    const { plano = 'mensal' } = req.body
    const usuario = req.usuario

    const usuarioResult = await pool.query(
      'SELECT nome, email, cpf_cnpj, telefone FROM usuarios WHERE id = $1',
      [usuario.id]
    )
    const dadosUsuario = usuarioResult.rows[0]
    const taxId = limparCpfCnpj(dadosUsuario?.cpf_cnpj)

    if (!taxId || (taxId.length !== 11 && taxId.length !== 14)) {
      return res.status(400).json({ erro: 'CPF ou CNPJ inválido. Atualize seu perfil com um documento válido.' })
    }

    const telLimpo = (dadosUsuario?.telefone || '').replace(/\D/g, '')
    const telArea   = telLimpo.substring(0, 2) || '34'
    const telNumero = telLimpo.substring(2)    || '999999999'

    let valor    = 9990
    let descricao = 'PinturaPro — Plano Mensal'

    if (usuario.role === 'prestador') {
      valor    = plano === 'anual' ? 49900 : 4990
      descricao = `PinturaPro Serviços — Plano ${plano === 'anual' ? 'Anual' : 'Mensal'}`
    } else {
      valor    = plano === 'anual' ? 99900 : 9990
      descricao = `PinturaPro — Plano ${plano === 'anual' ? 'Anual' : 'Mensal'}`
    }

    const body = {
      reference_id: `${usuario.id}|${plano}`,
      customer: {
        name: dadosUsuario?.nome || 'Cliente PinturaPro',
        email: dadosUsuario?.email || usuario.email,
        tax_id: taxId,
        phones: [{ country: '55', area: telArea, number: telNumero, type: 'MOBILE' }]
      },
      items: [{ reference_id: `plano_${plano}`, name: descricao, quantity: 1, unit_amount: valor }],
      payment_methods: [{ type: 'CREDIT_CARD' }, { type: 'PIX' }],
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

    const linkPagamento = data.links?.find(l => l.rel === 'PAY')?.href
      || data.links?.find(l => l.rel === 'pay')?.href
      || data.links?.[0]?.href

    res.json({ init_point: linkPagamento, order_id: data.id, status: data.status })

  } catch (err) {
    console.error('Erro ao criar preferência PagBank:', err)
    res.status(500).json({ erro: 'Erro ao criar assinatura' })
  }
}

const sucesso = async (req, res) => {
  try {
    const { reference_id, status } = req.query

    // Correção: redirect de sucesso não deve ativar assinatura
    // A ativação deve vir exclusivamente pelo webhook (mais confiável)
    // Aqui apenas redireciona o usuário
    console.log(`Redirecionamento de sucesso — reference_id: ${reference_id}, status: ${status}`)

    res.redirect('https://pinturapro-painel-production.up.railway.app')
  } catch (err) {
    res.redirect('https://pinturapro-painel-production.up.railway.app')
  }
}

const webhookPagbank = async (req, res) => {
  try {
    // Responde 200 imediatamente para o PagBank não reenviar
    res.sendStatus(200)

    const { reference_id, charges } = req.body

    if (!reference_id || !charges?.length) return

    const charge = charges[0]
    if (charge.status !== 'PAID') return

    const partes = reference_id.split('|')
    if (partes.length !== 2) {
      console.error('Webhook PagBank: reference_id inválido:', reference_id)
      return
    }

    const [usuarioId, plano] = partes

    // Verifica se o usuário existe antes de ativar
    const usuarioExiste = await pool.query(`SELECT id FROM usuarios WHERE id = $1`, [usuarioId])
    if (usuarioExiste.rows.length === 0) {
      console.error('Webhook PagBank: usuário não encontrado:', usuarioId)
      return
    }

    await ativarAssinatura(usuarioId, plano)
    console.log(`Assinatura ativada via PagBank — usuário: ${usuarioId}, plano: ${plano}`)

  } catch (err) {
    console.error('Erro no webhook PagBank:', err.message)
  }
}

const webhook = async (req, res) => {
  try {
    // Responde 200 imediatamente para o MercadoPago não reenviar
    res.sendStatus(200)

    const { type, data } = req.body
    if (type !== 'payment' || !data?.id) return

    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
    if (!MP_ACCESS_TOKEN) {
      console.error('Webhook MP: MP_ACCESS_TOKEN não configurado')
      return
    }

    const response = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
    })
    const pagamento = await response.json()

    if (pagamento.status !== 'approved' || !pagamento.external_reference) return

    const partes = pagamento.external_reference.split('|')
    if (partes.length !== 2) {
      console.error('Webhook MP: external_reference inválido:', pagamento.external_reference)
      return
    }

    const [usuarioId, plano] = partes

    const usuarioExiste = await pool.query(`SELECT id FROM usuarios WHERE id = $1`, [usuarioId])
    if (usuarioExiste.rows.length === 0) {
      console.error('Webhook MP: usuário não encontrado:', usuarioId)
      return
    }

    await ativarAssinatura(usuarioId, plano)
    console.log(`Assinatura ativada via MercadoPago — usuário: ${usuarioId}, plano: ${plano}`)

  } catch (err) {
    console.error('Erro no webhook MercadoPago:', err.message)
  }
}

const darAcessoGratuito = async (req, res) => {
  try {
    const { usuario_id } = req.body

    if (!usuario_id) return res.status(400).json({ erro: 'usuario_id é obrigatório' })

    const usuarioExiste = await pool.query(`SELECT id FROM usuarios WHERE id = $1`, [usuario_id])
    if (usuarioExiste.rows.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' })
    }

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
    console.error('Erro ao conceder acesso gratuito:', err.message)
    res.status(500).json({ erro: 'Erro ao conceder acesso' })
  }
}

const listarAssinantes = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1
    const limit  = parseInt(req.query.limit) || 50
    const offset = (page - 1) * limit

    const result = await pool.query(`
      SELECT u.id, u.nome, u.email, u.telefone, u.cidade, u.role,
             a.status, a.plano, a.tipo, a.criado_em
      FROM usuarios u
      LEFT JOIN assinaturas a ON a.usuario_id = u.id
      WHERE u.role IN ('assinante', 'prestador', 'dono_obra')
      ORDER BY u.role ASC, u.nome ASC
      LIMIT $1 OFFSET $2
    `, [limit, offset])

    res.json({ assinantes: result.rows, page, limit })
  } catch (err) {
    console.error('Erro ao listar assinantes:', err.message)
    res.status(500).json({ erro: 'Erro ao listar assinantes' })
  }
}

module.exports = { criarAssinatura, sucesso, webhook, webhookPagbank, darAcessoGratuito, listarAssinantes }