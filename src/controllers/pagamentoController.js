const crypto = require('crypto')
const { pool } = require('../utils/supabase')
const { enviarEmail } = require('../services/brevoService')
const { marcaPorTipo } = require('../utils/marca')

const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN
const PAGBANK_URL = 'https://api.pagseguro.com'
const APP_URL = 'https://pinturapro-api-production.up.railway.app/api'

const limparCpfCnpj = (str) => {
  if (!str) return null
  return str.replace(/\D/g, '')
}

const ativarAssinatura = async (usuarioId, plano) => {
  // Upsert atômico (Finding 4.1): evita check-then-insert race que duplicava assinaturas.
  await pool.query(
    `INSERT INTO assinaturas (usuario_id, plano, status, atualizado_em, proximo_vencimento)
     VALUES ($1, $2, 'ativa', NOW(),
       CASE WHEN $2 = 'anual' THEN NOW() + INTERVAL '365 days' ELSE NOW() + INTERVAL '30 days' END)
     ON CONFLICT (usuario_id) DO UPDATE SET
       status = 'ativa',
       plano = EXCLUDED.plano,
       atualizado_em = NOW(),
       proximo_vencimento = EXCLUDED.proximo_vencimento`,
    [usuarioId, plano || 'mensal']
  )
}

// Coloca prestador como pendente de verificação após pagamento
const colocarPendentVerificacao = async (usuarioId, plano) => {
  // Registra assinatura como paga mas acesso ainda pendente verificação (upsert atômico — Finding 4.1)
  await pool.query(
    `INSERT INTO assinaturas (usuario_id, plano, status, atualizado_em)
     VALUES ($1, $2, 'pendente_verificacao', NOW())
     ON CONFLICT (usuario_id) DO UPDATE SET
       status = 'pendente_verificacao',
       plano = EXCLUDED.plano,
       atualizado_em = NOW()`,
    [usuarioId, plano || 'mensal']
  )

  // Atualiza status de verificação do usuário
  await pool.query(
    `UPDATE usuarios SET verificacao_status = 'pendente' WHERE id = $1 AND verificacao_status = 'nao_solicitada'`,
    [usuarioId]
  )

  // Busca dados do prestador para notificar
  const usuario = await pool.query(
    `SELECT nome, email, tipo_prestador, tipo_dono FROM usuarios WHERE id = $1`, [usuarioId]
  )
  if (usuario.rows.length === 0) return

  const { nome, email } = usuario.rows[0]
  const marca = marcaPorTipo(usuario.rows[0])

  enviarEmail({
    para: email,
    remetenteNome: marca,
    assunto: `${marca} — Pagamento recebido! Verificação em andamento`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: #0a0a0a; margin: 0;">${marca}</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
          <h2>Olá, ${nome}! 🎉</h2>
          <p>Seu pagamento foi recebido com sucesso!</p>
          <p style="background: #fff3cd; padding: 16px; border-radius: 8px; border-left: 4px solid #E8833A;">
            <strong>Seus dados estão sendo verificados.</strong><br>
            Em até <strong>1 hora</strong> você receberá a confirmação por e-mail e terá acesso completo ao ${marca}.
          </p>
          <p>Este processo é necessário para garantir a segurança de todos os usuários da plataforma.</p>
          <p><strong>Equipe ${marca}</strong></p>
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
      'SELECT nome, email, cpf_cnpj, telefone, tipo_prestador FROM usuarios WHERE id = $1',
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

    const nomePlano = plano === 'anual' ? 'Anual' : 'Mensal'

    // Preço definido pelo TIER do prestador (tipo_prestador), NÃO pelo role:
    // todos os prestadores (pintor/construtor e reparador) têm role='prestador',
    // então usar role cobrava R$ 49,90 de todo mundo. O tier real é tipo_prestador.
    //   reparador           → R$ 49,90 / mês (R$ 499,00 anual)
    //   pintor (construção) → R$ 99,90 / mês (R$ 999,00 anual)
    let valor, descricao

    if (usuario.role === 'prestador') {
      const tipoPrestador = dadosUsuario?.tipo_prestador

      if (tipoPrestador === 'reparador') {
        valor     = plano === 'anual' ? 49900 : 4990
        descricao = `ArrumaPro Serviços — Plano ${nomePlano}`
      } else if (tipoPrestador === 'pintor') {
        valor     = plano === 'anual' ? 99900 : 9990
        descricao = `ArrumaPro — Plano ${nomePlano}`
      } else {
        // Tier não mapeado: falha alto em vez de cobrar silenciosamente o plano barato.
        console.error(`[pagamento] tipo_prestador não mapeado para preço — usuario=${usuario.id} tipo_prestador=${JSON.stringify(tipoPrestador)}`)
        return res.status(422).json({ erro: 'Tipo de prestador não reconhecido para cobrança. Atualize seu cadastro ou contate o suporte.' })
      }
    } else {
      // Donos de obra têm acesso gratuito; assinantes genéricos pagam o plano padrão.
      valor     = plano === 'anual' ? 99900 : 9990
      descricao = `ArrumaPro — Plano ${nomePlano}`
    }

    const body = {
      reference_id: `${usuario.id}|${plano}`,
      customer: {
        name: dadosUsuario?.nome || 'Cliente ArrumaPro',
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
    // req.body é um Buffer cru (express.raw escopado à rota do webhook em server.js).
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''

    // Autenticidade PagBank: SHA-256("{token}-{payload}") comparado em tempo
    // constante ao header x-authenticity-token.
    const assinaturaRecebida = (req.headers['x-authenticity-token'] || '').toLowerCase()
    const assinaturaEsperada = crypto
      .createHash('sha256')
      .update(`${process.env.PAGBANK_TOKEN || ''}-${rawBody}`)
      .digest('hex')
    const assinaturaValida =
      assinaturaRecebida.length === assinaturaEsperada.length &&
      crypto.timingSafeEqual(Buffer.from(assinaturaRecebida), Buffer.from(assinaturaEsperada))

    // Modo MONITOR (padrão): só loga o resultado e processa o evento mesmo assim.
    // Para REJEITAR eventos sem assinatura válida, defina WEBHOOK_ENFORCE_SIGNATURE=true
    // no ambiente (sem alteração de código).
    const enforce = process.env.WEBHOOK_ENFORCE_SIGNATURE === 'true'
    console.log(`[webhook-pagbank] assinatura match=${assinaturaValida} | modo=${enforce ? 'enforce' : 'monitor'} | content-type=${req.headers['content-type'] || '(none)'}`)

    // Diagnóstico do ESQUEMA de assinatura, para a primeira entrega real revelar o que o
    // PagBank manda de fato. Só NOMES de header e TAMANHOS — nenhum valor de header, nenhum
    // trecho de payload, nunca o token. Puramente observacional: roda antes do early-return
    // de enforce (para aparecer também quando o evento é rejeitado) e não altera o fluxo.
    const tamAuthenticity = req.headers['x-authenticity-token'] != null
      ? String(req.headers['x-authenticity-token']).length : null
    const tamPayloadSignature = req.headers['x-payload-signature'] != null
      ? String(req.headers['x-payload-signature']).length : null
    console.log(`[webhook-pagbank] headers recebidos (apenas nomes): ${Object.keys(req.headers).join(', ') || '(nenhum)'}`)
    console.log(`[webhook-pagbank] tamanhos | x-authenticity-token=${tamAuthenticity ?? '(ausente)'} | x-payload-signature=${tamPayloadSignature ?? '(ausente)'} | sha256_hex_esperado=${assinaturaEsperada.length}`)

    if (!assinaturaValida && enforce) {
      console.warn('[webhook-pagbank] assinatura inválida ou ausente — evento ignorado (enforce)')
      return res.sendStatus(200)
    }

    res.sendStatus(200)

    let payload = {}
    try { payload = JSON.parse(rawBody || '{}') } catch { payload = {} }
    const { reference_id, charges } = payload
    if (!reference_id || !charges?.length) return

    const charge = charges[0]

    // CLAIM atômico de idempotência — quem INSERE a linha ganha o direito de processar
    // (mesmo idioma do claim de contratosController). Entrega repetida do MESMO
    // (charge_id, status) não grava nada, não devolve linha e sai aqui: nenhum e-mail
    // reenviado, nenhum Telegram, nenhum proximo_vencimento empurrado de graça.
    // Fica ANTES do filtro de PAID de propósito, para o livro registrar TODO desfecho.
    // reference_id vai cru: o split continua onde estava, logo abaixo.
    if (charge.id) {
      const claim = await pool.query(
        `INSERT INTO webhook_eventos_pagbank (charge_id, status, reference_id, valor_centavos)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (charge_id, status) DO NOTHING
         RETURNING charge_id`,
        [charge.id, charge.status || '(sem status)', reference_id, charge.amount?.value ?? null]
      )
      if (claim.rowCount === 0) {
        console.log(`[webhook-pagbank] entrega duplicada ignorada | charge=${charge.id} | status=${charge.status}`)
        return
      }
    } else {
      // FALHA ABERTO: sem charge.id não existe chave de dedupe. Processar mesmo assim é
      // menos ruim que barrar um pagamento real por uma suposição errada sobre o payload —
      // este log denuncia que a suposição caiu.
      console.warn('[webhook-pagbank] charge.id ausente — sem chave de dedupe, seguindo SEM claim')
    }

    if (charge.status !== 'PAID') {
      console.log(`[webhook-pagbank] evento nao-PAID registrado | status=${charge.status} | nenhuma acao tomada`)
      return
    }

    const partes = reference_id.split('|')
    if (partes.length !== 2) return

    const [usuarioId, plano] = partes

    const usuarioResult = await pool.query(
      `SELECT id, role, nome FROM usuarios WHERE id = $1`, [usuarioId]
    )
    if (usuarioResult.rows.length === 0) return

    const usuario = usuarioResult.rows[0]

    // Prestadores ficam pendentes de verificação — donos de obra ativam direto
    if (usuario.role === 'prestador' || usuario.role === 'pintor' || usuario.role === 'assinante') {
      await colocarPendentVerificacao(usuarioId, plano)
      console.log(`Prestador ${usuarioId} aguardando verificação após pagamento`)

      const telegramToken  = process.env.TELEGRAM_BOT_TOKEN
      const telegramChatId = process.env.TELEGRAM_CHAT_ID
      if (telegramToken && telegramChatId) {
        try {
          const valorCentavos = charge.amount?.value
          const valorFmt = valorCentavos
            ? `R$ ${(valorCentavos / 100).toFixed(2).replace('.', ',')}`
            : plano
          const texto = `💰 Novo pagamento PinturaPro!\nUsuario: ${usuario.nome}\nPlano: ${plano}\nValor: ${valorFmt}\nAguardando aprovacao no painel`
          fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage?chat_id=${telegramChatId}&text=${encodeURIComponent(texto)}`)
            .catch(e => console.error('Telegram notify error:', e.message))
        } catch (e) {
          console.error('Telegram notify error:', e.message)
        }
      }
    } else {
      await ativarAssinatura(usuarioId, plano)
      console.log(`Assinatura ativada via PagBank — usuário: ${usuarioId}, plano: ${plano}`)
    }

  } catch (err) {
    console.error('Erro no webhook PagBank:', err.message)
    if (!res.headersSent) res.sendStatus(200)
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
        `UPDATE assinaturas SET status = 'ativa', tipo = 'gratuito', atualizado_em = NOW(),
          proximo_vencimento = NOW() + INTERVAL '30 days' WHERE usuario_id = $1`,
        [usuario_id]
      )
    } else {
      await pool.query(
        `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo, proximo_vencimento)
         VALUES ($1, 'mensal', 0, 'ativa', 'gratuito', NOW() + INTERVAL '30 days')`,
        [usuario_id]
      )
    }

    await pool.query(
      `UPDATE usuarios SET verificacao_status = 'aprovado', aprovado_automaticamente = false WHERE id = $1`, [usuario_id]
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
             u.tipo_dono, u.tipo_prestador, u.verificacao_status, u.aprovado_automaticamente,
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

module.exports = { criarAssinatura, sucesso, webhookPagbank, darAcessoGratuito, listarAssinantes }