const { pool } = require('../utils/supabase')
const { enviarEmail } = require('../services/brevoService')

const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN
const PAGBANK_URL = 'https://api.pagseguro.com'
const APP_URL = 'https://pinturapro-api-production.up.railway.app/api'

const limparCpfCnpj = (str) => {
  if (!str) return null
  return str.replace(/\D/g, '')
}

const ativarAssinatura = async (usuarioId, plano) => {
  const assinaturaExiste = await pool.query(
    `SELECT id FROM assinaturas WHERE usuario_id = $1`, [usuarioId]
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

// Coloca prestador como pendente de verificação após pagamento
const colocarPendentVerificacao = async (usuarioId, plano) => {
  // Registra assinatura como paga mas acesso ainda pendente verificação
  const assinaturaExiste = await pool.query(
    `SELECT id FROM assinaturas WHERE usuario_id = $1`, [usuarioId]
  )
  if (assinaturaExiste.rows.length > 0) {
    await pool.query(
      `UPDATE assinaturas SET status = 'pendente_verificacao', plano = $1, atualizado_em = NOW() WHERE usuario_id = $2`,
      [plano || 'mensal', usuarioId]
    )
  } else {
    await pool.query(
      `INSERT INTO assinaturas (usuario_id, plano, status, atualizado_em) VALUES ($1, $2, 'pendente_verificacao', NOW())`,
      [usuarioId, plano || 'mensal']
    )
  }

  // Atualiza status de verificação do usuário
  await pool.query(
    `UPDATE usuarios SET verificacao_status = 'pendente' WHERE id = $1 AND verificacao_status = 'nao_solicitada'`,
    [usuarioId]
  )

  // Busca dados do prestador para notificar
  const usuario = await pool.query(
    `SELECT nome, email FROM usuarios WHERE id = $1`, [usuarioId]
  )
  if (usuario.rows.length === 0) return

  const { nome, email } = usuario.rows[0]

  enviarEmail({
    para: email,
    assunto: 'PinturaPro — Pagamento recebido! Verificação em andamento',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: #0a0a0a; margin: 0;">PinturaPro</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
          <h2>Olá, ${nome}! 🎉</h2>
          <p>Seu pagamento foi recebido com sucesso!</p>
          <p style="background: #fff3cd; padding: 16px; border-radius: 8px; border-left: 4px solid #E8833A;">
            <strong>Seus dados estão sendo verificados.</strong><br>
            Em até <strong>1 hora</strong> você receberá a confirmação por e-mail e terá acesso completo ao PinturaPro.
          </p>
          <p>Este processo é necessário para garantir a segurança de todos os usuários da plataforma.</p>
          <p><strong>Equipe PinturaPro</strong></p>
        </div>
      </div>
    `
  }).catch(err => console.error('Erro ao enviar e-mail verificação:', err))

  const adminEmail = process.env.EMAIL_REMETENTE?.match(/^(.+?)\s*<(.+?)>$/)?.[2]
    || process.env.EMAIL_REMETENTE
    || 'novacomputec@gmail.com'

  enviarEmail({
    para: adminEmail,
    assunto: `⚠️ Novo prestador aguardando verificação: ${nome}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px;">
        <h2>Novo prestador para verificar</h2>
        <p><strong>Nome:</strong> ${nome}</p>
        <p><strong>E-mail:</strong> ${email}</p>
        <p><strong>ID:</strong> ${usuarioId}</p>
        <p>Acesse o painel para aprovar ou reprovar em até 1 hora.</p>
        <a href="https://pinturapro-painel-production.up.railway.app" style="background: #E8833A; color: #000; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Abrir Painel</a>
      </div>
    `
  }).catch(err => console.error('Erro ao notificar admin:', err))
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

    const telLimpo  = (dadosUsuario?.telefone || '').replace(/\D/g, '')
    const telArea   = telLimpo.substring(0, 2) || '34'
    const telNumero = telLimpo.substring(2)    || '999999999'

    let valor     = 9990
    let descricao = 'PinturaPro — Plano Mensal'

    if (usuario.role === 'prestador') {
      valor     = plano === 'anual' ? 49900 : 4990
      descricao = `PinturaPro Serviços — Plano ${plano === 'anual' ? 'Anual' : 'Mensal'}`
    } else {
      valor     = plano === 'anual' ? 99900 : 9990
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
      notification_urls: [`${APP_URL}/pagamentos/webhook-pagbank`]
    }

    const response = await fetch(`${PAGBANK_URL}/checkouts`, {
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
    console.log(`Redirecionamento de sucesso — ${JSON.stringify(req.query)}`)
    res.redirect('https://pinturapro-painel-production.up.railway.app')
  } catch (err) {
    res.redirect('https://pinturapro-painel-production.up.railway.app')
  }
}

const webhookPagbank = async (req, res) => {
  try {
    res.sendStatus(200)

    const { reference_id, charges } = req.body
    if (!reference_id || !charges?.length) return

    const charge = charges[0]
    if (charge.status !== 'PAID') return

    const partes = reference_id.split('|')
    if (partes.length !== 2) return

    const [usuarioId, plano] = partes

    const usuarioResult = await pool.query(
      `SELECT id, role FROM usuarios WHERE id = $1`, [usuarioId]
    )
    if (usuarioResult.rows.length === 0) return

    const usuario = usuarioResult.rows[0]

    // Prestadores ficam pendentes de verificação — donos de obra ativam direto
    if (usuario.role === 'prestador' || usuario.role === 'pintor' || usuario.role === 'assinante') {
      await colocarPendentVerificacao(usuarioId, plano)
      console.log(`Prestador ${usuarioId} aguardando verificação após pagamento`)
    } else {
      await ativarAssinatura(usuarioId, plano)
      console.log(`Assinatura ativada via PagBank — usuário: ${usuarioId}, plano: ${plano}`)
    }

  } catch (err) {
    console.error('Erro no webhook PagBank:', err.message)
  }
}

const darAcessoGratuito = async (req, res) => {
  try {
    const { usuario_id } = req.body
    if (!usuario_id) return res.status(400).json({ erro: 'usuario_id é obrigatório' })

    const usuarioExiste = await pool.query(`SELECT id FROM usuarios WHERE id = $1`, [usuario_id])
    if (usuarioExiste.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })

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

    await pool.query(
      `UPDATE usuarios SET verificacao_status = 'aprovado' WHERE id = $1`, [usuario_id]
    )

    res.json({ mensagem: 'Acesso gratuito concedido com sucesso' })
  } catch (err) {
    console.error('Erro ao conceder acesso gratuito:', err.message)
    res.status(500).json({ erro: 'Erro ao conceder acesso' })
  }
}

const listarAssinantes = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1
    const limit  = parseInt(req.query.limit) || 200
    const offset = (page - 1) * limit

    const result = await pool.query(`
      SELECT u.id, u.nome, u.email, u.telefone, u.cidade, u.role,
             u.tipo_dono, u.verificacao_status,
             a.status, a.plano, a.tipo, a.valor_mensal, a.criado_em
      FROM usuarios u
      LEFT JOIN assinaturas a ON a.usuario_id = u.id
      WHERE u.role IN ('assinante', 'prestador', 'dono_obra', 'pintor')
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