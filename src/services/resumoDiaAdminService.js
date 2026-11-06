// Resumo do dia para o ADMIN (decisão do dono, 06/11/2026): todo dia às 18:00 (America/Sao_Paulo)
// o admin recebe push + e-mail "Resumo do dia pronto (N pedidos)" com o link da aba Canal do
// WhatsApp do painel (PAINEL_URL#canal), onde o texto do canal é copiado. N = pedidos ABERTOS
// (serviços + obras, aprovados, não vencidos) da cidade do canal (conviteCanalService.CIDADE_CANAL)
// — a MESMA consulta de GET /admin/canal/resumo (utils/itensCanal, única porta das duas).
//
// Agendamento: cron de 1 min (server.js) + claim em configuracoes ('resumo_dia_admin_em' = data SP
// do último envio) num só statement — INSERT ... ON CONFLICT ... WHERE valor <> hoje, só com a hora
// SP ≥ 18 —, então réplicas e restarts nunca mandam dois no mesmo dia, e um deploy às 18:30 manda
// no primeiro tique (não "pula" o dia). Quem recebe: e-mail UM para ADMIN_EMAIL; push a cada conta
// de usuarios com esse e-mail e push_token (o admin pode ter conta no app). Nunca lança.
const { pool } = require('../utils/supabase')
const { listarItensCanal } = require('../utils/itensCanal')
const { enviarEmail } = require('./brevoService')
const { enviarPushNotificacao, semSobreposicao } = require('./alertaService')
const { CIDADE_CANAL } = require('./conviteCanalService')
const { ADMIN_EMAIL, PAINEL_URL } = require('../config/admin')
const { MARCA } = require('../utils/marca')
const { TZ_AGENDA } = require('../utils/agendamento')

const CHAVE_RESUMO = 'resumo_dia_admin_em'
const HORA_ENVIO_SP = 18
const LINK_CANAL = `${PAINEL_URL}/#canal`

const tituloResumo = (n) => `Resumo do dia pronto (${n} ${n === 1 ? 'pedido' : 'pedidos'})`
const corpoResumo = (n) => `${n === 1 ? '1 pedido aberto' : `${n} pedidos abertos`} em ${CIDADE_CANAL.cidade}. Abra o painel, copie o resumo e cole no canal do WhatsApp.`
const htmlResumo = (n) => `
  <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #222;">
    <h2 style="margin: 0 0 12px;">📋 ${tituloResumo(n)}</h2>
    <p>${corpoResumo(n)}</p>
    <p style="margin: 24px 0;">
      <a href="${LINK_CANAL}" style="background: #25D366; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Abrir o Canal do WhatsApp no painel</a>
    </p>
    <p style="font-size: 12px; color: #888;">${LINK_CANAL}<br>${MARCA} · aviso automático das 18:00</p>
  </div>`

// Claim atômico do dia: devolve a data SP gravada quando ESTE tique ganhou o envio, ou nada.
const reivindicarEnvioDoDia = async (db = pool) => {
  const r = await db.query(
    `INSERT INTO configuracoes (chave, valor)
     SELECT $1, to_char(NOW() AT TIME ZONE '${TZ_AGENDA}', 'YYYY-MM-DD')
      WHERE EXTRACT(HOUR FROM (NOW() AT TIME ZONE '${TZ_AGENDA}')) >= ${HORA_ENVIO_SP}
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()
      WHERE configuracoes.valor IS DISTINCT FROM EXCLUDED.valor
     RETURNING valor`,
    [CHAVE_RESUMO]
  )
  return r.rows[0]?.valor || null
}

const enviarResumoDiaAdmin = semSobreposicao('enviarResumoDiaAdmin', async () => {
  try {
    const dia = await reivindicarEnvioDoDia()
    if (!dia) return null
    const itens = await listarItensCanal({ cidade: CIDADE_CANAL.cidade, uf: CIDADE_CANAL.uf })
    const n = itens.length
    const titulo = tituloResumo(n)
    const corpo = corpoResumo(n)
    const contas = (await pool.query(
      `SELECT id, push_token FROM usuarios WHERE lower(btrim(email)) = $1 AND push_token IS NOT NULL`, [ADMIN_EMAIL]
    )).rows
    let pushes = 0
    for (const c of contas) {
      try {
        const r = await enviarPushNotificacao(c.push_token, titulo, corpo, { tipo: 'resumo_dia_admin', url: LINK_CANAL }, c.id)
        if (r === 'enviado') pushes++
      } catch (err) { console.error(`[ResumoDiaAdmin] push conta ${c.id}:`, err.message) }
    }
    let email = 'falha'
    try {
      await enviarEmail({ para: ADMIN_EMAIL, assunto: `📋 ${titulo}`, html: htmlResumo(n), texto: `${titulo}\n\n${corpo}\n\n${LINK_CANAL}` })
      email = 'enviado'
    } catch (err) { console.error('[ResumoDiaAdmin] e-mail:', err.message) }
    console.log(`[ResumoDiaAdmin] ${dia}: ${n} pedido(s) em ${CIDADE_CANAL.cidade} → push ${pushes}/${contas.length} conta(s); e-mail ${email} (${ADMIN_EMAIL})`)
    return { dia, n, pushes, email }
  } catch (err) {
    console.error('[ResumoDiaAdmin]', err.message)
    return null
  }
})

module.exports = { enviarResumoDiaAdmin, reivindicarEnvioDoDia, tituloResumo, corpoResumo, LINK_CANAL, CHAVE_RESUMO, HORA_ENVIO_SP }
