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
//
// O canal é de UMA cidade (CIDADE_CANAL): só profissional cuja cidade/UF de cadastro casa
// com ela recebe o convite — mesma dobra do broadcast (utils/localidade: normalizar() no JS,
// sqlNormalizarCidade() no SQL, UF em caixa alta). Quem está fora é PULADO antes do claim:
// não ganha linha em convites_canal, então pode ser convidado depois se a cidade dele
// ganhar canal (ou se a dele mudar para a do canal).
const { pool } = require('../utils/supabase')
const { enviarEmail } = require('./brevoService')
const { MARCA } = require('../utils/marca')
const { normalizar, sqlNormalizarCidade } = require('../utils/localidade')

const URL_CANAL_WHATSAPP = 'https://whatsapp.com/channel/0029Vb9BoWT17En0RAOw8r1I'
// Cidade atendida pelo canal acima. Mudar o canal = mudar os dois juntos.
const CIDADE_CANAL = { cidade: 'Patos de Minas', uf: 'MG' }
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
// Cidade/UF do profissional casam com a do canal? Mesma comparação do broadcast
// (alertaService.broadcastPaginado): cidade dobrada por normalizar(), UF em caixa alta,
// e os DOIS obrigatórios — sem cidade ou sem UF não há alvo.
const cidadeDoCanal = (cidade, uf) =>
  normalizar(cidade) === normalizar(CIDADE_CANAL.cidade) &&
  String(uf || '').trim().toUpperCase() === CIDADE_CANAL.uf

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

// Devolve 'enviado' | 'falha' | 'ja_convidado' | 'invalido' | 'fora_da_cidade'. Nunca lança:
// erro de banco ou de envio vira log + resultado. Claim ANTES do envio (ver cabeçalho).
// cidade/uf: os do cadastro do profissional. Fora da cidade do canal → sai ANTES do claim,
// sem linha em convites_canal (ver cabeçalho).
const enviarConviteCanal = async (email, nome, cidade, uf) => {
  const e = normalizarEmail(email)
  if (!emailPlausivel(e)) return 'invalido'
  if (!cidadeDoCanal(cidade, uf)) return 'fora_da_cidade'
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

// Profissionais ATIVOS (reparador + pintor/construtor), não suspensos, da CIDADE DO CANAL
// (cidade dobrada por sqlNormalizarCidade + UF em caixa alta, como o broadcast), cujo e-mail
// (minúsculo) ainda não tem linha em convites_canal. Um por e-mail (fica o cadastro mais
// antigo), como na campanha original. Não olha assinatura. Devolve cidade/uf junto para o
// envio em lote repetir a checagem (enviarConviteCanal) sem segunda consulta.
const listarPendentesConviteCanal = async () => {
  const r = await pool.query(`
    SELECT DISTINCT ON (lower(btrim(u.email))) lower(btrim(u.email)) AS email, u.nome, u.cidade, u.uf
      FROM usuarios u
     WHERE u.role IN ('prestador', 'pintor')
       AND u.ativo = true
       AND u.suspenso_em IS NULL
       AND NULLIF(btrim(u.email), '') IS NOT NULL
       AND ${sqlNormalizarCidade('u.cidade')} = $1
       AND upper(btrim(u.uf)) = $2
       AND NOT EXISTS (SELECT 1 FROM convites_canal c WHERE c.email = lower(btrim(u.email)))
     ORDER BY lower(btrim(u.email)), u.criado_em ASC`,
    [normalizar(CIDADE_CANAL.cidade), CIDADE_CANAL.uf])
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
  // fora_da_cidade fica no resultado por honestidade: a lista já vem filtrada por cidade no
  // SQL, então é zero no caminho normal — só sobe se as duas dobras (SQL e JS) divergirem.
  const r = { enviados: 0, falhas: 0, invalidos: 0, ja_convidados: 0, fora_da_cidade: 0, cortados_pelo_teto: pendentes.length - alvos.length }
  for (const a of alvos) {
    const res = await enviarConviteCanal(a.email, a.nome, a.cidade, a.uf)
    if (res === 'enviado') r.enviados++
    else if (res === 'falha') r.falhas++
    else if (res === 'invalido') r.invalidos++
    else if (res === 'fora_da_cidade') r.fora_da_cidade++
    else r.ja_convidados++
  }
  console.log(`[ConviteCanal] lote | pendentes: ${pendentes.length} | enviados: ${r.enviados} | falhas: ${r.falhas} | inválidos: ${r.invalidos} | já convidados: ${r.ja_convidados} | fora da cidade: ${r.fora_da_cidade} | cortados pelo teto: ${r.cortados_pelo_teto}`)
  return r
}

module.exports = {
  URL_CANAL_WHATSAPP,
  CIDADE_CANAL,
  CONVITES_TETO_DIA,
  enviarConviteCanal,
  listarPendentesConviteCanal,
  enviarConvitesPendentes,
  mascararEmail,
}
