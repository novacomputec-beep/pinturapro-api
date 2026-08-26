const crypto = require('crypto')
const { pool } = require('../utils/supabase')
const { enviarEmail } = require('../services/brevoService')
const { MARCA } = require('../utils/marca')

const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN
const PAGBANK_URL = 'https://api.pagseguro.com'
const APP_URL = 'https://pinturapro-api-production.up.railway.app/api'

// Verificação de assinatura do webhook: LIGADA por padrão. Só um WEBHOOK_ENFORCE_SIGNATURE
// explicitamente igual a 'false' desliga — qualquer outro valor (ou a ausência) enforça.
const WEBHOOK_ENFORCE = process.env.WEBHOOK_ENFORCE_SIGNATURE !== 'false'

// Aviso ALTO de boot: enforce ligado sem PAGBANK_TOKEN significa que TODO evento — inclusive
// pagamentos legítimos — será rejeitado, porque sem o segredo não há como verificar assinatura.
// Nomeia as duas variáveis para o operador saber exatamente o que configurar antes de ligar
// os pagamentos. (Hoje o livro de webhook está vazio, então isto não perde nada — é guardrail.)
if (WEBHOOK_ENFORCE && !PAGBANK_TOKEN) {
  console.warn('[webhook-pagbank][BOOT] ATENÇÃO: verificação de assinatura LIGADA (WEBHOOK_ENFORCE_SIGNATURE != "false") mas PAGBANK_TOKEN AUSENTE — todo evento de pagamento será REJEITADO até PAGBANK_TOKEN ser configurado. Configure PAGBANK_TOKEN antes de habilitar pagamentos, ou defina WEBHOOK_ENFORCE_SIGNATURE=false para desligar a verificação.')
}

const limparCpfCnpj = (str) => {
  if (!str) return null
  return str.replace(/\D/g, '')
}

// Tabela de preços da assinatura — FONTE ÚNICA, em centavos. Usada tanto para COBRAR
// (criarAssinatura) quanto para VALIDAR o valor pago no webhook, para que os dois lados
// nunca divirjam. Devolve null quando o tier não é mapeável (não dá para cobrar às cegas).
//   prestador+reparador → 4.990 / 49.900   |   prestador+pintor → 9.990 / 99.900
//   demais papéis (dono/assinante genérico) → 9.990 / 99.900
const precoAssinaturaCentavos = (role, tipoPrestador, plano) => {
  const anual = plano === 'anual'
  if (role === 'prestador') {
    if (tipoPrestador === 'reparador') return anual ? 49900 : 4990
    if (tipoPrestador === 'pintor')    return anual ? 99900 : 9990
    return null // tier não mapeado
  }
  return anual ? 99900 : 9990
}

const ativarAssinatura = async (usuarioId, plano) => {
  // Upsert atômico (Finding 4.1): evita check-then-insert race que duplicava assinaturas.
  // proximo_vencimento SOMA o período a partir de GREATEST(vencimento_atual, NOW()) — é uma
  // COMPRA, então renovar antes do vencimento empilha em vez de zerar (pagar no dia 20 de 30
  // dá 40 dias, não 30). GREATEST também impede o retrocesso: o valor nunca anda para trás.
  // Em PostgreSQL GREATEST IGNORA NULL, então linha sem vencimento cai em NOW() + período.
  await pool.query(
    `INSERT INTO assinaturas (usuario_id, plano, status, atualizado_em, proximo_vencimento)
     VALUES ($1, $2, 'ativa', NOW(),
       CASE WHEN $2 = 'anual' THEN NOW() + INTERVAL '365 days' ELSE NOW() + INTERVAL '30 days' END)
     ON CONFLICT (usuario_id) DO UPDATE SET
       status = 'ativa',
       plano = EXCLUDED.plano,
       atualizado_em = NOW(),
       proximo_vencimento = GREATEST(assinaturas.proximo_vencimento, NOW())
         + CASE WHEN EXCLUDED.plano = 'anual' THEN INTERVAL '365 days' ELSE INTERVAL '30 days' END,
       marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL`,
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

  enviarEmail({
    para: email,
    remetenteNome: MARCA,
    assunto: `${MARCA} — Pagamento recebido! Verificação em andamento`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: #0a0a0a; margin: 0;">${MARCA}</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
          <h2>Olá, ${nome}! 🎉</h2>
          <p>Seu pagamento foi recebido com sucesso!</p>
          <p style="background: #fff3cd; padding: 16px; border-radius: 8px; border-left: 4px solid #E8833A;">
            <strong>Seus dados estão sendo verificados.</strong><br>
            Em até <strong>1 hora</strong> você receberá a confirmação por e-mail e terá acesso completo ao ${MARCA}.
          </p>
          <p>Este processo é necessário para garantir a segurança de todos os usuários da plataforma.</p>
          <p><strong>Equipe ${MARCA}</strong></p>
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

// Erro tipado do checkout: status HTTP + corpo, para os DOIS chamadores (rota com JWT e link
// pela web) responderem exatamente o que a rota sempre respondeu.
class ErroCheckout extends Error {
  constructor(status, corpo) { super(corpo.erro); this.status = status; this.corpo = corpo }
}

// Núcleo do checkout PagBank, extraído de criarAssinatura SEM mudar comportamento: mesmos
// guards, mesmas mensagens, mesmo reference_id "<usuario_id>|<plano>", mesmo webhook. Recebe
// a identidade por parâmetro (a rota passa req.usuario; o link pela web passa o usuário da
// linha do link) e o redirect_url (padrão = o de sempre).
const criarCheckoutPagBank = async ({ usuarioId, role, email, plano = 'mensal', redirectUrl = `${APP_URL}/pagamentos/sucesso` }) => {
  const usuarioResult = await pool.query(
    'SELECT nome, email, cpf_cnpj, telefone, tipo_prestador FROM usuarios WHERE id = $1',
    [usuarioId]
  )
  const dadosUsuario = usuarioResult.rows[0]
  const taxId = limparCpfCnpj(dadosUsuario?.cpf_cnpj)
  if (!taxId || (taxId.length !== 11 && taxId.length !== 14)) {
    throw new ErroCheckout(400, { erro: 'CPF ou CNPJ inválido. Atualize seu perfil com um documento válido.' })
  }
  const telLimpo  = (dadosUsuario?.telefone || '').replace(/\D/g, '')
  const telArea   = telLimpo.substring(0, 2) || '34'
  const telNumero = telLimpo.substring(2)    || '999999999'
  const nomePlano = plano === 'anual' ? 'Anual' : 'Mensal'
  const tipoPrestador = dadosUsuario?.tipo_prestador
  const valor = precoAssinaturaCentavos(role, tipoPrestador, plano)
  if (valor == null) {
    console.error(`[pagamento] tipo_prestador não mapeado para preço — usuario=${usuarioId} tipo_prestador=${JSON.stringify(tipoPrestador)}`)
    throw new ErroCheckout(422, { erro: 'Tipo de prestador não reconhecido para cobrança. Atualize seu cadastro ou contate o suporte.' })
  }
  const descricao = (role === 'prestador' && tipoPrestador === 'reparador')
    ? `${MARCA} Serviços — Plano ${nomePlano}`
    : `${MARCA} — Plano ${nomePlano}`
  const body = {
    reference_id: `${usuarioId}|${plano}`,
    customer: {
      name: dadosUsuario?.nome || `Cliente ${MARCA}`,
      email: dadosUsuario?.email || email,
      tax_id: taxId,
      phones: [{ country: '55', area: telArea, number: telNumero, type: 'MOBILE' }]
    },
    items: [{ reference_id: `plano_${plano}`, name: descricao, quantity: 1, unit_amount: valor }],
    payment_methods: [{ type: 'CREDIT_CARD' }, { type: 'PIX' }],
    redirect_url: redirectUrl,
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
    throw new ErroCheckout(500, { erro: 'Erro ao criar pagamento', detalhe: data })
  }
  const linkPagamento = data.links?.find(l => l.rel === 'PAY')?.href
    || data.links?.find(l => l.rel === 'pay')?.href
    || data.links?.[0]?.href
  return { init_point: linkPagamento, order_id: data.id, status: data.status }
}

// POST /pagamentos/criar-assinatura (JWT) — fino sobre o núcleo; respostas idênticas às de antes.
const criarAssinatura = async (req, res) => {
  try {
    const { plano = 'mensal' } = req.body
    const resultado = await criarCheckoutPagBank({
      usuarioId: req.usuario.id, role: req.usuario.role, email: req.usuario.email, plano,
    })
    res.json(resultado)
  } catch (err) {
    if (err instanceof ErroCheckout) return res.status(err.status).json(err.corpo)
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

    // Verificação LIGADA por padrão (D1). Só WEBHOOK_ENFORCE_SIGNATURE='false' desliga
    // (volta ao modo MONITOR, que só loga e processa mesmo sem assinatura válida).
    const enforce = WEBHOOK_ENFORCE
    const tokenConfigurado = !!process.env.PAGBANK_TOKEN
    console.log(`[webhook-pagbank] assinatura match=${assinaturaValida} | modo=${enforce ? 'enforce' : 'monitor'} | token=${tokenConfigurado ? 'ok' : 'AUSENTE'} | content-type=${req.headers['content-type'] || '(none)'}`)

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

    if (enforce) {
      // Sem token não há como verificar: um segredo vazio é forjável (o atacante conhece o
      // algoritmo), então "assinatura válida" seria falso-positivo. Rejeita TUDO e grita.
      if (!tokenConfigurado) {
        console.error('[webhook-pagbank] REJEITADO: WEBHOOK_ENFORCE_SIGNATURE ligado mas PAGBANK_TOKEN AUSENTE — impossível verificar assinatura; nenhum evento é processado. Configure PAGBANK_TOKEN (ou WEBHOOK_ENFORCE_SIGNATURE=false para desligar).')
        return res.sendStatus(200)
      }
      if (!assinaturaValida) {
        console.warn(`[webhook-pagbank] REJEITADO: assinatura inválida ou ausente (enforce) — nada concedido | x-authenticity-token=${tamAuthenticity ?? '(ausente)'} | esperado_len=${assinaturaEsperada.length}`)
        return res.sendStatus(200)
      }
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
      `SELECT id, role, nome, tipo_prestador FROM usuarios WHERE id = $1`, [usuarioId]
    )
    if (usuarioResult.rows.length === 0) return

    const usuario = usuarioResult.rows[0]

    // D2 — o plano concedido é validado contra o valor REALMENTE pago, pela MESMA tabela
    // que cobrou (precoAssinaturaCentavos). Divergência (a menor ou a maior), tier não
    // mapeável, ou ausência do valor no payload: REJEITA e loga, não concede nada. Sem isto,
    // o acesso vinha do texto do reference_id e um pagamento parcial/forjado valia o mesmo.
    const valorEsperado = precoAssinaturaCentavos(usuario.role, usuario.tipo_prestador, plano)
    const valorPago = charge.amount?.value
    if (valorEsperado == null) {
      console.error(`[webhook-pagbank] REJEITADO: preço não mapeável — usuario=${usuarioId} role=${usuario.role} tipo_prestador=${JSON.stringify(usuario.tipo_prestador)} plano=${plano}; nada concedido`)
      return
    }
    if (valorPago == null || Number(valorPago) !== valorEsperado) {
      console.error(`[webhook-pagbank] REJEITADO: valor pago (${valorPago}) != esperado (${valorEsperado} centavos) — usuario=${usuarioId} plano=${plano}; nada concedido`)
      return
    }

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
          const texto = `💰 Novo pagamento ${MARCA}!\nUsuario: ${usuario.nome}\nPlano: ${plano}\nValor: ${valorFmt}\nAguardando aprovacao no painel`
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
    // Link de assinatura pela web: com o pagamento confirmado, fecha o link que gerou a ordem
    // (usado_em). Isolado em try/catch próprio e DEPOIS da ativação: não muda nada do que o
    // webhook já fazia — plano, datas e ativação vêm das linhas acima, inalteradas.
    // Chave primária: order_id gravado no link = id devolvido pelo POST /checkouts; a
    // notificação do PagBank pode trazer o id da ORDEM (payload.id) e/ou do checkout
    // (payload.checkout?.id), então os dois são tentados. Rede de segurança: reference_id
    // "<usuario_id>|<plano>" — fecha o link aberto desse usuário/plano mesmo que os ids não casem.
    try {
      const fechados = await pool.query(
        `UPDATE links_assinatura SET usado_em = NOW()
          WHERE usado_em IS NULL AND order_id IS NOT NULL
            AND (order_id = $3 OR order_id = $4 OR (usuario_id = $1 AND plano = $2))
          RETURNING id`,
        [usuarioId, plano, payload.id || null, payload.checkout?.id || null]
      )
      if (fechados.rowCount > 0) console.log(`[LinkAssinatura] ${fechados.rowCount} link(s) fechado(s) por pagamento confirmado | usuario=${usuarioId} plano=${plano}`)
    } catch (e) {
      console.error('[LinkAssinatura] falha ao fechar link após pagamento:', e.message)
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

    const assinaturaExiste = await pool.query(`SELECT id, status, tipo FROM assinaturas WHERE usuario_id = $1`, [usuario_id])
    if (assinaturaExiste.rows.length > 0) {
      // RECUSA em vez de converter: sobre uma assinatura PAGA ativa, este endpoint apagava o
      // caráter pago da linha (tipo='gratuito') sem registro nenhum, e a partir daí todo
      // caminho de aprovação leria tipo='gratuito' → proximo_vencimento = NULL, tornando o
      // usuário grátis para sempre. Acesso gratuito é para quem NÃO tem assinatura paga.
      // tipo NULL conta como "não gratuito" (linha paga nasce sem tipo) — !== já dá isso.
      const atual = assinaturaExiste.rows[0]
      if (atual.status === 'ativa' && atual.tipo !== 'gratuito') {
        return res.status(409).json({
          erro: 'Este usuário já tem uma assinatura paga ativa. Conceder acesso gratuito apagaria o registro pago — cancele ou aguarde o vencimento antes de conceder.',
          codigo: 'ASSINATURA_PAGA_ATIVA',
        })
      }
      // Aqui a linha ou já é gratuita, ou não está ativa (pendente/cancelada/expirada) — o
      // guard acima barrou a paga ativa, então tipo='gratuito' abaixo não apaga nada pago.
      // GREATEST: conceder acesso grátis nunca ENCURTA um vencimento já mais distante — sem
      // isto, um gratuito anual com 300 dias restantes caía para 30.
      await pool.query(
        `UPDATE assinaturas SET status = 'ativa', tipo = 'gratuito', atualizado_em = NOW(),
          proximo_vencimento = GREATEST(proximo_vencimento, NOW() + INTERVAL '30 days'),
          marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL
         WHERE usuario_id = $1`,
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

module.exports = { criarAssinatura, criarCheckoutPagBank, ErroCheckout, precoAssinaturaCentavos, sucesso, webhookPagbank, darAcessoGratuito, listarAssinantes }