// Assinatura pela WEB (protudo.app.br) para profissional sem acesso a caminho de pagamento no
// app. Três rotas PÚBLICAS, sem JWT — a credencial é um link de uso único enviado por e-mail.
// O desenho COPIA o de redefinição de senha (authController esqueciSenha/redefinirSenha):
//   - resposta genérica sempre 200 no pedido (nunca revela se o e-mail existe);
//   - teto por IDENTIDADE no banco (tentativas_auth), não no limitador em memória por IP;
//   - segredo de crypto.randomBytes, guardado só como HASH bcrypt, com expiração e uso único;
//   - comparação em tempo constante contra um hash fictício quando não há linha.
// Diferença inevitável: o reset recebe o E-MAIL junto com o código e por isso acha a linha por
// e-mail; o link chega sozinho na URL. Por isso o token é "<id da linha>.<segredo>": o id é o
// SELETOR (acha a linha em links_assinatura), o segredo é o VERIFICADOR (bcrypt). O id sozinho
// não vale nada sem o segredo.
const bcrypt = require('bcrypt')
const crypto = require('crypto')
const { pool } = require('../utils/supabase')
const { registrarTentativa } = require('../utils/tentativasAuth')
const { transporter } = require('./authController')
const { MARCA } = require('../utils/marca')
const { criarCheckoutPagBank, ErroCheckout, precoAssinaturaCentavos } = require('./pagamentoController')

const SITE_URL = 'https://protudo.app.br'
const VALIDADE_LINK_MINUTOS = 30
const GENERICO_SOLICITAR = { mensagem: 'Se este e-mail estiver cadastrado como profissional, você receberá o link para assinar em breve.' }
const GENERICO_INVALIDO = { erro: 'Link inválido ou expirado. Solicite um novo.' }
// Mesmo hash fictício do reset: comparação sempre roda, com ou sem linha, para não vazar existência pelo tempo.
const HASH_FICTICIO = '$2b$10$TurXFLIbHVFyg7b3h/.ame16E9jSv4PmsB5G47xyqYPM1rXeqDSda'

// "<uuid>.<48 hex>" — 24 bytes de segredo (o reset usa 3 bytes porque o código é digitado;
// aqui vai na URL, então pode e deve ser longo).
const parseToken = (t) => {
  if (typeof t !== 'string' || t.length > 120) return null
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{48})$/i.exec(t.trim())
  return m ? { id: m[1].toLowerCase(), segredo: m[2].toLowerCase() } : null
}

const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0] || 'Profissional'

// Preços em reais a partir da MESMA tabela do checkout/webhook (precoAssinaturaCentavos) —
// nenhum número novo; tier não precificável devolve null e o link não é emitido.
const precosReais = (role, tipoPrestador) => {
  const mensal = precoAssinaturaCentavos(role, tipoPrestador, 'mensal')
  const anual = precoAssinaturaCentavos(role, tipoPrestador, 'anual')
  if (mensal == null || anual == null) return null
  return { mensal: mensal / 100, anual: anual / 100 }
}

// POST /assinatura/solicitar-link — { email }
const solicitarLink = async (req, res) => {
  try {
    const { email } = req.body || {}
    if (!email || typeof email !== 'string') return res.status(400).json({ erro: 'Informe o e-mail' })
    const emailNorm = email.toLowerCase().trim()
    // Responde ANTES de qualquer consulta, sempre igual: existência do e-mail não vaza nem
    // pelo corpo nem pelo tempo de resposta (mesmo desenho de esqueciSenha).
    res.json(GENERICO_SOLICITAR)

    // Teto por identidade no BANCO (tentativas_auth): 3 pedidos por hora por e-mail. O
    // limitador em memória por IP não serve aqui — reseta a cada deploy, não é compartilhado
    // entre réplicas e um atacante troca de IP; o contador por e-mail sobrevive a tudo isso.
    const tentativa = await registrarTentativa('link_assinatura', emailNorm)
    if (tentativa.excedeu) {
      console.warn(`[LinkAssinatura] teto por identidade atingido — link não enviado (${tentativa.tentativas} pedidos na janela)`)
      return
    }
    const r = await pool.query(
      `SELECT id, nome, email, role, tipo_prestador FROM usuarios WHERE email = $1`, [emailNorm]
    )
    if (r.rows.length === 0) return
    const u = r.rows[0]
    // Só profissional com tier precificável recebe link — dono/admin não têm o que assinar.
    if (u.role !== 'prestador' || !precosReais(u.role, u.tipo_prestador)) return

    const segredo = crypto.randomBytes(24).toString('hex')
    const hash = await bcrypt.hash(segredo, 10)
    const ins = await pool.query(
      `INSERT INTO links_assinatura (usuario_id, token_hash, expira_em)
       VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 minute'))
       RETURNING id`,
      [u.id, hash, VALIDADE_LINK_MINUTOS]
    )
    const link = `${SITE_URL}/assinar?t=${ins.rows[0].id}.${segredo}`
    // MESMO caminho de e-mail do reset (SMTP/nodemailer, transporter do authController).
    await transporter.sendMail({
      from: `${MARCA} <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
      to: emailNorm,
      subject: `${MARCA} — Seu link para assinar`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #0a0a0a; margin: 0;">${MARCA}</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2>Olá, ${primeiroNome(u.nome)}!</h2>
            <p>Use o botão abaixo para escolher seu plano e pagar com segurança:</p>
            <p style="text-align: center; margin: 24px 0;">
              <a href="${link}" style="background: #0a0a0a; color: #E8833A; font-size: 18px; font-weight: bold; padding: 14px 28px; border-radius: 8px; text-decoration: none;">Assinar agora</a>
            </p>
            <p style="color: #666; font-size: 13px;">Este link expira em ${VALIDADE_LINK_MINUTOS} minutos e só pode ser usado uma vez. Se você não pediu este e-mail, ignore-o.</p>
            <p><strong>Equipe ${MARCA}</strong></p>
          </div>
        </div>
      `
    })
  } catch (err) {
    console.error('[LinkAssinatura] Erro ao solicitar link:', err.message)
  }
}

// Carrega e valida o token SEM consumir. null em qualquer falha (formato, teto, linha
// inexistente, usado, expirado, segredo errado) — o chamador responde sempre o mesmo 410.
const validarToken = async (token) => {
  const p = parseToken(token)
  if (!p) return null
  // Teto por LINK (não por e-mail, que aqui não existe): 10 tentativas em 15 min por id —
  // fecha força bruta no segredo mesmo com o id em mãos.
  const tentativa = await registrarTentativa('link_assinatura_token', p.id)
  if (tentativa.excedeu) return null
  const r = await pool.query(
    `SELECT l.id, l.token_hash, l.expira_em, l.usado_em, l.order_id, l.init_point, l.plano,
            u.id AS usuario_id, u.nome, u.email, u.role, u.tipo_prestador
       FROM links_assinatura l
       JOIN usuarios u ON u.id = l.usuario_id
      WHERE l.id = $1`,
    [p.id]
  )
  const l = r.rows[0]
  const vivo = !!l && !l.usado_em && new Date(l.expira_em) > new Date()
  const ok = await bcrypt.compare(p.segredo, vivo ? l.token_hash : HASH_FICTICIO)
  return (ok && vivo) ? l : null
}

// GET /assinatura/link/:token — só o que a página precisa: primeiro nome e os dois preços.
const consultarLink = async (req, res) => {
  try {
    const l = await validarToken(req.params.token)
    if (!l) return res.status(410).json(GENERICO_INVALIDO)
    const precos = precosReais(l.role, l.tipo_prestador)
    if (!precos) return res.status(410).json(GENERICO_INVALIDO)
    res.json({ nome: primeiroNome(l.nome), precos })
  } catch (err) {
    console.error('[LinkAssinatura] Erro ao consultar link:', err.message)
    res.status(500).json({ erro: 'Erro ao consultar link' })
  }
}

// Marcador de reserva: ocupa order_id enquanto a ordem está sendo criada no PagBank, para
// duas requisições simultâneas (duas abas, duplo clique) não abrirem duas ordens.
const MARCADOR_CRIANDO = '__criando__'

// POST /assinatura/criar-checkout — { token, plano }
// O link NÃO é consumido aqui: usado_em só é gravado pelo webhook quando o pagamento da ordem
// é confirmado. Enquanto o link vive (30 min) e não foi pago, chamar de novo devolve a MESMA
// ordem (idempotente) — abandonar a página do PagBank não queima o link nem multiplica ordens.
const criarCheckout = async (req, res) => {
  try {
    const { token, plano } = req.body || {}
    const planoNorm = plano === 'anual' ? 'anual' : 'mensal'
    const l = await validarToken(token)
    if (!l) return res.status(410).json(GENERICO_INVALIDO)
    // Já existe ordem para este link → mesmo init_point, sem tocar no PagBank. O plano da
    // ordem é o que foi fixado na criação; um `plano` diferente no corpo não abre outra ordem.
    if (l.order_id && l.order_id !== MARCADOR_CRIANDO && l.init_point) {
      return res.json({ init_point: l.init_point })
    }
    // Reserva ATÔMICA antes da chamada externa: só quem casa order_id IS NULL cria a ordem.
    const reserva = await pool.query(
      `UPDATE links_assinatura SET order_id = $2
        WHERE id = $1 AND order_id IS NULL AND usado_em IS NULL AND expira_em > NOW()
        RETURNING id`,
      [l.id, MARCADOR_CRIANDO]
    )
    if (reserva.rowCount === 0) {
      // Outra requisição está criando (ou acabou de criar) a ordem: devolve a dela se já
      // existe; senão pede para tentar de novo — nunca uma segunda ordem.
      const atual = await pool.query(`SELECT init_point, expira_em, usado_em FROM links_assinatura WHERE id = $1`, [l.id])
      const a = atual.rows[0]
      if (a?.init_point && !a.usado_em && new Date(a.expira_em) > new Date()) return res.json({ init_point: a.init_point })
      return res.status(409).json({ erro: 'Checkout em criação. Tente novamente em alguns segundos.' })
    }
    try {
      // REUSO da lógica de POST /pagamentos/criar-assinatura (criarCheckoutPagBank): mesmos
      // guards de CPF/tier, mesmo reference_id "<usuario_id>|<plano>", mesmo webhook. Só o
      // redirect_url muda: volta para o site, não para o painel.
      // expiraEm = expiração do LINK (não "30 min a partir de agora"): checkout e link morrem
      // no mesmo instante, então uma ordem abandonada nunca sobrevive ao link que a gerou.
      const resultado = await criarCheckoutPagBank({
        usuarioId: l.usuario_id, role: l.role, email: l.email, plano: planoNorm,
        redirectUrl: `${SITE_URL}/assinar/obrigado`,
        expiraEm: l.expira_em,
      })
      await pool.query(
        `UPDATE links_assinatura SET order_id = $2, init_point = $3, plano = $4 WHERE id = $1`,
        [l.id, resultado.order_id || `sem-id:${l.id}`, resultado.init_point, planoNorm]
      )
      res.json({ init_point: resultado.init_point })
    } catch (err) {
      // O checkout NÃO nasceu (CPF inválido, tier sem preço, PagBank fora): solta a reserva —
      // a falha foi nossa ou do gateway, não do usuário; o link continua válido.
      await pool.query(`UPDATE links_assinatura SET order_id = NULL WHERE id = $1 AND order_id = $2`, [l.id, MARCADOR_CRIANDO]).catch(() => {})
      if (err instanceof ErroCheckout) return res.status(err.status).json(err.corpo)
      throw err
    }
  } catch (err) {
    console.error('[LinkAssinatura] Erro ao criar checkout:', err.message)
    res.status(500).json({ erro: 'Erro ao criar checkout' })
  }
}

// Poda diária (agendada em server.js junto de limparTentativasAntigas): apaga links NUNCA
// usados com mais de 7 dias. `usado_em IS NULL` é a garantia de que linha com pagamento
// confirmado (o webhook grava usado_em) nunca é apagada — ela fica como registro; só o
// lixo de pedidos que não viraram pagamento sai. Nada é apagado no PagBank: a ordem já
// expirou sozinha (expiration_date = expiração do link).
const LINKS_PODA_DIAS = 7
const limparLinksAssinaturaAntigos = async () => {
  try {
    const r = await pool.query(
      `DELETE FROM links_assinatura WHERE usado_em IS NULL AND criado_em < NOW() - ($1::int * INTERVAL '1 day')`,
      [LINKS_PODA_DIAS]
    )
    if (r.rowCount > 0) console.log(`[LinkAssinatura] ${r.rowCount} link(s) não usado(s) com mais de ${LINKS_PODA_DIAS} dias removido(s)`)
  } catch (err) {
    console.error('[LinkAssinatura] Erro na poda de links antigos:', err.message)
  }
}

module.exports = { solicitarLink, consultarLink, criarCheckout, limparLinksAssinaturaAntigos, parseToken, precosReais, VALIDADE_LINK_MINUTOS, SITE_URL, MARCADOR_CRIANDO, LINKS_PODA_DIAS }
