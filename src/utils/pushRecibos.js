const { pool } = require('./supabase')

// Diagnóstico de push (push_recibos): uma linha por mensagem enviada ao Expo, com o ticket da
// resposta do envio e, ~15 s depois, o recibo (processarRecibos). Só observação: NADA no envio
// depende disto. Toda função aqui nunca lança e é chamada em fire-and-forget — falha do banco
// vira só um log. Poda de 30 dias no cron diário (purgarPushRecibosAntigos).
// demanda_id = data.reparo_id || data.obra_id quando é UUID (senão NULL); tipo = data.tipo.
// usuario_id: o do chamador quando ele sabe; senão, o dono atual do token (subselect).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PODA_DIAS = 30

const uuidOuNull = (v) => (v && UUID_RE.test(String(v)) ? String(v) : null)

// linhas: [{ usuarioId?, pushToken, data, ticket?, erroEnvio? }]
const registrarTickets = async (linhas) => {
  try {
    if (!linhas || linhas.length === 0) return
    const usuarios = [], tokens = [], tipos = [], demandas = [], tickets = [], status = [], erros = []
    for (const l of linhas) {
      const t = l.ticket
      usuarios.push(uuidOuNull(l.usuarioId))
      tokens.push(l.pushToken || null)
      tipos.push(l.data?.tipo ? String(l.data.tipo) : null)
      demandas.push(uuidOuNull(l.data?.reparo_id || l.data?.obra_id))
      tickets.push(t?.status === 'ok' && t.id ? String(t.id) : null)
      status.push(t ? String(t.status || 'desconhecido') : 'erro_http')
      erros.push(t
        ? (t.status === 'error' ? [t.details?.error, t.message].filter(Boolean).join(' | ') || null : null)
        : (l.erroEnvio ? String(l.erroEnvio) : null))
    }
    await pool.query(
      `INSERT INTO push_recibos (usuario_id, tipo, demanda_id, ticket_id, status_ticket, erro_ticket)
       SELECT COALESCE(x.usuario_id, (SELECT u.id FROM usuarios u WHERE u.push_token = x.token LIMIT 1)),
              x.tipo, x.demanda_id, x.ticket_id, x.status_ticket, x.erro_ticket
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[], $5::text[], $6::text[], $7::text[])
           AS x(usuario_id, token, tipo, demanda_id, ticket_id, status_ticket, erro_ticket)`,
      [usuarios, tokens, tipos, demandas, tickets, status, erros]
    )
  } catch (err) {
    console.error('[PushRecibos] Erro ao registrar tickets:', err.message)
  }
}

// receipts: o objeto { [ticketId]: { status, message?, details? } } do Expo.
const registrarRecibos = async (receipts) => {
  try {
    const ids = [], status = [], erros = []
    for (const [id, r] of Object.entries(receipts || {})) {
      ids.push(String(id))
      status.push(String(r?.status || 'desconhecido'))
      erros.push(r?.status === 'error' ? [r.details?.error, r.message].filter(Boolean).join(' | ') || null : null)
    }
    if (ids.length === 0) return
    await pool.query(
      `UPDATE push_recibos p
          SET status_recibo = x.status, erro_recibo = x.erro, recibo_em = NOW()
         FROM unnest($1::text[], $2::text[], $3::text[]) AS x(ticket_id, status, erro)
        WHERE p.ticket_id = x.ticket_id`,
      [ids, status, erros]
    )
  } catch (err) {
    console.error('[PushRecibos] Erro ao registrar recibos:', err.message)
  }
}

const purgarPushRecibosAntigos = async () => {
  try {
    const r = await pool.query(
      `DELETE FROM push_recibos WHERE enviado_em < NOW() - ($1::int * INTERVAL '1 day')`,
      [PODA_DIAS]
    )
    if (r.rowCount > 0) console.log(`[PushRecibos] ${r.rowCount} registro(s) com mais de ${PODA_DIAS} dias removido(s)`)
  } catch (err) {
    console.error('[PushRecibos] Erro na poda:', err.message)
  }
}

module.exports = { registrarTickets, registrarRecibos, purgarPushRecibosAntigos, PODA_DIAS }
