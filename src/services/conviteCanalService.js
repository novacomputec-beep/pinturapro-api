// Convite por e-mail para seguir o canal do ProTudo no WhatsApp — UMA vez por e-mail.
//
// convites_canal (migração de boot em routes/index.js): email em minúsculas é a PK. O INSERT
// ... ON CONFLICT DO NOTHING acontece ANTES do envio: quem já tem linha ('enviado' OU 'falha')
// nunca recebe de novo — nem pelo cadastro, nem pelo envio em lote do admin, nem por uma
// réplica concorrente. Falha do Brevo vira UPDATE para 'falha' (a linha fica, bloqueando
// repetição; o admin enxerga pelo status).
//
// Chamadores: authController (fire-and-forget depois do COMMIT do cadastro de profissional)
// e as rotas /admin/canal/convites/* (lista pendentes; envia em lote, sequencial, com teto
// diário). O e-mail é o mesmo da campanha de 15/10/2026 (cabeçalho laranja, botão verde).
const { pool } = require('../utils/supabase')
const { enviarEmail } = require('./brevoService')
const { MARCA } = require('../utils/marca')

const URL_CANAL_WHATSAPP = 'https://whatsapp.com/channel/0029Vb9BoWT17En0RAOw8r1I'
const ASSUNTO_CONVITE = `📋 Siga o canal do ${MARCA} no WhatsApp`
const CONVITES_TETO_DIA = 250
const CONVITE_TIMEOUT_MS = 10000

const escaparHtml = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0] || 'profissional'
const normalizarEmail = (e) => String(e || '').trim().toLowerCase()
// Só o formato mínimo: algo@algo sem espaço. Endereço fora disso nem ganha linha.
const emailPlausivel = (e) => /^[^\s@]+@[^\s@]+$/.test(e)
// "ju***@gmail.com" — para listas do admin; nunca o endereço inteiro.
const mascararEmail = (e) => String(e || '').replace(/^(.{2}).*(@.*)$/, '$1***$2')

const htmlConviteCanal = (nome) => `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: #0a0a0a; margin: 0;">${MARCA}</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
          <h2>Olá, ${escaparHtml(primeiroNome(nome))}!</h2>
          <p>Agora os pedidos abertos de Patos de Minas também saem todo dia no nosso canal do WhatsApp. Siga e não perca nenhum!</p>
          <p style="text-align: center; margin: 30px 0;">
            <a href="${URL_CANAL_WHATSAPP}" style="background: #25D366; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Seguir o canal</a>
          </p>
          <p style="color: #666; font-size: 13px;">Ative as notificações do app ${MARCA} para receber pedidos na hora</p>
        </div>
      </div>
    `

const comTimeout = (promessa, ms, rotulo) => {
  let timer
  const estouro = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${rotulo}: timeout após ${ms} ms`)), ms) })
  return Promise.race([promessa, estouro]).finally(() => clearTimeout(timer))
}

// Devolve 'enviado' | 'falha' | 'ja_convidado' | 'invalido'. Nunca lança: erro de banco ou
// de envio vira log + resultado. Claim ANTES do envio (ver cabeçalho).
const enviarConviteCanal = async (email, nome) => {
  const e = normalizarEmail(email)
  if (!emailPlausivel(e)) return 'invalido'
  try {
    const claim = await pool.query(
      `INSERT INTO convites_canal (email, status) VALUES ($1, 'enviado')
       ON CONFLICT (email) DO NOTHING RETURNING email`,
      [e]
    )
    if (claim.rowCount === 0) return 'ja_convidado'
  } catch (err) {
    console.error('[ConviteCanal] erro ao reivindicar', mascararEmail(e), '|', err.message)
    return 'falha'
  }
  try {
    await comTimeout(enviarEmail({ para: e, assunto: ASSUNTO_CONVITE, html: htmlConviteCanal(nome) }), CONVITE_TIMEOUT_MS, 'Brevo')
    return 'enviado'
  } catch (err) {
    console.error('[ConviteCanal] falha ao enviar', mascararEmail(e), '|', err.message)
    await pool.query(`UPDATE convites_canal SET status = 'falha' WHERE email = $1`, [e])
      .catch(e2 => console.error('[ConviteCanal] erro ao marcar falha:', e2.message))
    return 'falha'
  }
}

// Profissionais ATIVOS (reparador + pintor/construtor), não suspensos, qualquer cidade, cujo
// e-mail (minúsculo) ainda não tem linha em convites_canal. Um por e-mail (fica o cadastro
// mais antigo), como na campanha original. Não olha assinatura.
const listarPendentesConviteCanal = async () => {
  const r = await pool.query(`
    SELECT DISTINCT ON (lower(btrim(u.email))) lower(btrim(u.email)) AS email, u.nome
      FROM usuarios u
     WHERE u.role IN ('prestador', 'pintor')
       AND u.ativo = true
       AND u.suspenso_em IS NULL
       AND NULLIF(btrim(u.email), '') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM convites_canal c WHERE c.email = lower(btrim(u.email)))
     ORDER BY lower(btrim(u.email)), u.criado_em ASC`)
  return r.rows
}

// Envio em lote dos pendentes: sequencial, um timeout por envio, até CONVITES_TETO_DIA linhas
// criadas no dia (São Paulo) — o teto conta TODAS as linhas de hoje, inclusive as do cadastro
// e as de backfill. Devolve { enviados, falhas, invalidos, ja_convidados, cortados_pelo_teto }.
const enviarConvitesPendentes = async () => {
  const pendentes = await listarPendentesConviteCanal()
  const hoje = await pool.query(
    `SELECT count(*)::int AS n FROM convites_canal
      WHERE enviado_em >= (date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`
  )
  const restante = Math.max(0, CONVITES_TETO_DIA - hoje.rows[0].n)
  const alvos = pendentes.slice(0, restante)
  const r = { enviados: 0, falhas: 0, invalidos: 0, ja_convidados: 0, cortados_pelo_teto: pendentes.length - alvos.length }
  for (const a of alvos) {
    const res = await enviarConviteCanal(a.email, a.nome)
    if (res === 'enviado') r.enviados++
    else if (res === 'falha') r.falhas++
    else if (res === 'invalido') r.invalidos++
    else r.ja_convidados++
  }
  console.log(`[ConviteCanal] lote | pendentes: ${pendentes.length} | enviados: ${r.enviados} | falhas: ${r.falhas} | inválidos: ${r.invalidos} | já convidados: ${r.ja_convidados} | cortados pelo teto: ${r.cortados_pelo_teto}`)
  return r
}

module.exports = {
  URL_CANAL_WHATSAPP,
  CONVITES_TETO_DIA,
  enviarConviteCanal,
  listarPendentesConviteCanal,
  enviarConvitesPendentes,
  mascararEmail,
}
