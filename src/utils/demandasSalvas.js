// PEDIDOS SALVOS (dono, 24/11/2026). O profissional marca (❤️) um reparo ou uma obra do feed para
// ver depois.
//   demandas_salvas (usuario_id, tipo 'reparo' | 'obra', demanda_id, criado_em) — uma linha por
//     conta e pedido; aviso_fim_em = quando saiu o push "termina em…" (no máximo UM por linha).
//   POST /salvos { tipo, demanda_id } alterna (routes/salvos.js); GET /salvos lista.
//   Feed (GET /reparos, GET /obras): cada item sai com salvo: true/false (anexarSalvo).
//   Listas do dono (GET /reparos/minhas, GET /obras/minhas) e detalhe visto pelo dono: salvos_count
//     (anexarSalvosCount) — quantas contas salvaram, sem dizer quem.
//   Push (avisarSalvosTerminando, cron de server.js): pedido salvo ainda aberto, sem profissional
//     escolhido e com 6 h ou menos de prazo → "❤️ Um pedido que você salvou termina em {tempo}".
//     Só fora do silêncio noturno dos pushes (alertaService.SQL_FORA_SILENCIO, 22:00–07:00 SP): o
//     que venceria o limite de madrugada sai às 07:00, se o pedido ainda estiver aberto.
// anexarSalvo / anexarSalvosCount NUNCA lançam: são enfeite do card e não podem derrubar o feed.
const { pool } = require('./supabase')
const { tempoRestante } = require('../whatsapp/textos')

const TIPOS = Object.freeze({ reparo: 'reparos', obra: 'obras' })
const TIPO_DA_TABELA = Object.freeze({ reparos: 'reparo', obras: 'obra' })
const HORAS_AVISO_FIM = 6
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const tituloAvisoFim = (ms) => `❤️ Um pedido que você salvou termina em ${tempoRestante(ms)}`
// Pedido que ainda aceita proposta — o mesmo recorte do feed.
const sqlAberta = (a) => `${a}.status = 'aberta' AND ${a}.status_aprovacao = 'aprovada' AND ${a}.match_usuario_id IS NULL AND ${a}.expira_em > NOW()`

const migrarDemandasSalvas = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS demandas_salvas (
      usuario_id   UUID NOT NULL,
      tipo         TEXT NOT NULL CHECK (tipo IN ('reparo', 'obra')),
      demanda_id   UUID NOT NULL,
      criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      aviso_fim_em TIMESTAMPTZ,
      PRIMARY KEY (usuario_id, tipo, demanda_id)
    )`)
  await client.query(`CREATE INDEX IF NOT EXISTS demandas_salvas_demanda_idx ON demandas_salvas (tipo, demanda_id)`)
}

// Alterna. Devolve { ok: true, salvo } ou { ok: false, status, erro }.
const alternarSalvo = async (usuarioId, tipo, demandaId, db = pool) => {
  const tabela = TIPOS[tipo]
  if (!tabela) return { ok: false, status: 400, erro: "tipo deve ser 'reparo' ou 'obra'" }
  if (typeof demandaId !== 'string' || !RE_UUID.test(demandaId)) return { ok: false, status: 400, erro: 'demanda_id inválido' }
  const apagou = await db.query(
    `DELETE FROM demandas_salvas WHERE usuario_id = $1::uuid AND tipo = $2 AND demanda_id = $3::uuid RETURNING demanda_id`, [usuarioId, tipo, demandaId])
  if (apagou.rows.length > 0) return { ok: true, salvo: false }
  const existe = await db.query(`SELECT 1 FROM ${tabela} WHERE id = $1::uuid`, [demandaId])
  if (existe.rows.length === 0) return { ok: false, status: 404, erro: 'Pedido não encontrado' }
  await db.query(
    `INSERT INTO demandas_salvas (usuario_id, tipo, demanda_id) VALUES ($1::uuid, $2, $3::uuid)
     ON CONFLICT (usuario_id, tipo, demanda_id) DO NOTHING`, [usuarioId, tipo, demandaId])
  return { ok: true, salvo: true }
}

// Marca salvo: true/false em cada linha (que tem `id`). Devolve as mesmas linhas.
const anexarSalvo = async (tabela, linhas, usuarioId, db = pool) => {
  const lista = Array.isArray(linhas) ? linhas : []
  for (const l of lista) l.salvo = false
  if (lista.length === 0 || !TIPO_DA_TABELA[tabela] || !usuarioId) return linhas
  try {
    const r = await db.query(
      `SELECT demanda_id FROM demandas_salvas WHERE usuario_id = $1::uuid AND tipo = $2 AND demanda_id = ANY($3::uuid[])`,
      [usuarioId, TIPO_DA_TABELA[tabela], lista.map(l => l.id)])
    const salvos = new Set(r.rows.map(x => x.demanda_id))
    for (const l of lista) l.salvo = salvos.has(l.id)
  } catch (err) {
    console.error(`[Salvos] anexarSalvo ${tabela}:`, err.message)
  }
  return linhas
}

// salvos_count (inteiro) em cada linha (que tem `id`). Devolve as mesmas linhas.
const anexarSalvosCount = async (tabela, linhas, db = pool) => {
  const lista = Array.isArray(linhas) ? linhas : []
  for (const l of lista) l.salvos_count = 0
  if (lista.length === 0 || !TIPO_DA_TABELA[tabela]) return linhas
  try {
    const r = await db.query(
      `SELECT demanda_id, COUNT(*)::int AS n FROM demandas_salvas WHERE tipo = $1 AND demanda_id = ANY($2::uuid[]) GROUP BY demanda_id`,
      [TIPO_DA_TABELA[tabela], lista.map(l => l.id)])
    const porId = new Map(r.rows.map(x => [x.demanda_id, x.n]))
    for (const l of lista) l.salvos_count = porId.get(l.id) || 0
  } catch (err) {
    console.error(`[Salvos] anexarSalvosCount ${tabela}:`, err.message)
  }
  return linhas
}

// Lista do profissional, do salvo mais recente para o mais antigo. Só o que o card do feed já
// mostra (nada de endereço, descrição ou coordenadas); `aberta` diz se ainda dá para mandar proposta.
const sqlItem = (tipo, tabela, valor, midias, fk, categorias) => `
      SELECT s.criado_em AS salvo_em, '${tipo}' AS tipo, d.id, d.codigo_publico, d.titulo, d.categoria, ${categorias} AS categorias,
             ${valor} AS valor, d.valor_a_combinar, d.cidade, d.bairro, d.uf, d.status, d.expira_em,
             (${sqlAberta('d')}) AS aberta,
             (SELECT url FROM ${midias} WHERE ${fk} = d.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) AS foto_capa
        FROM demandas_salvas s JOIN ${tabela} d ON d.id = s.demanda_id
       WHERE s.usuario_id = $1::uuid AND s.tipo = '${tipo}'`
const listarSalvos = async (usuarioId, { limit = 50, offset = 0 } = {}, db = pool) => {
  const r = await db.query(
    `SELECT * FROM (${sqlItem('reparo', 'reparos', 'd.valor_estimado', 'midias_reparos', 'reparo_id', 'd.categorias')}
       UNION ALL ${sqlItem('obra', 'obras', 'd.valor', 'midias', 'obra_id', 'NULL::text[]')}) x
      ORDER BY x.salvo_em DESC, x.id LIMIT $2 OFFSET $3`, [usuarioId, limit, offset])
  return r.rows.map(l => ({ ...l, salvo: true }))
}

// Cron. Claim atômico (aviso_fim_em): réplica ou restart nunca repete. Nunca lança.
// foraDoSilencio: predicado SQL da janela de envio (padrão: a dos pushes; os testes fixam true/false).
const avisarSalvosTerminando = async (db = pool, { foraDoSilencio } = {}) => {
  const alerta = require('../services/alertaService')
  const janela = foraDoSilencio || alerta.SQL_FORA_SILENCIO
  let enviados = 0
  for (const [tipo, tabela] of Object.entries(TIPOS)) {
    try {
      const r = await db.query(
        `UPDATE demandas_salvas s SET aviso_fim_em = NOW()
           FROM ${tabela} d
          WHERE s.tipo = $1 AND d.id = s.demanda_id AND s.aviso_fim_em IS NULL
            AND ${sqlAberta('d')}
            AND d.expira_em <= NOW() + INTERVAL '${HORAS_AVISO_FIM} hours'
            AND (${janela})
        RETURNING s.usuario_id, s.demanda_id, d.titulo, d.expira_em`, [tipo])
      for (const l of r.rows) {
        const u = (await db.query(`SELECT push_token FROM usuarios WHERE id = $1::uuid AND ativo IS NOT FALSE`, [l.usuario_id])).rows[0]
        if (!u?.push_token) continue
        const resultado = await alerta.enviarPushNotificacao(
          u.push_token, tituloAvisoFim(new Date(l.expira_em).getTime() - Date.now()), `"${l.titulo}"`,
          { tipo: 'pedido_salvo_terminando', [`${tipo}_id`]: l.demanda_id }, l.usuario_id)
        if (resultado === 'enviado') enviados++
      }
    } catch (err) {
      console.error(`[Salvos] aviso de fim (${tabela}):`, err.message)
    }
  }
  if (enviados > 0) console.log(`[Salvos] ${enviados} aviso(s) "pedido salvo termina em…" enviado(s)`)
  return enviados
}

module.exports = {
  TIPOS, HORAS_AVISO_FIM, tituloAvisoFim, migrarDemandasSalvas, alternarSalvo, anexarSalvo, anexarSalvosCount, listarSalvos, avisarSalvosTerminando,
}
