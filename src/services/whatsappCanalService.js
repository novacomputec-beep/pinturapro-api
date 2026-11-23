// CANAL do WhatsApp — post automático (dono, 23/11/2026). Lado da API: monta o texto e deixa a
// linha em whatsapp_canal_posts; quem fala com o WhatsApp é o worker (src/whatsapp/canal.js), que
// publica e grava o resultado na mesma linha.
//
//   18:00 (São Paulo), com canal_auto_ativo = 'true' (nasce 'false'): UM resumo dos pedidos ABERTOS
//   da cidade do canal (conviteCanalService.CIDADE_CANAL) — a MESMA consulta da aba Canal do painel
//   (utils/itensCanal: abertos, aprovados, não vencidos, sem profissional escolhido). Texto em
//   utils/canalResumo.montarPostCanal (sem nome nem telefone). Dia sem pedidos: linha 'pulado',
//   nada é publicado. No máximo UM automático por dia: índice único (dia) WHERE origem = 'auto' —
//   réplicas, restarts e o cron de 1 min nunca criam o segundo. Chave ligada depois das 18:00
//   (ou deploy às 18:30) → sai no primeiro tique, até as 21:00 (fim da janela de envio).
//   "Postar agora" (super-admin): linha 'manual', fora do dedupe diário.
const { pool } = require('../utils/supabase')
const { listarItensCanal } = require('../utils/itensCanal')
const { montarPostCanal } = require('../utils/canalResumo')
const { CIDADE_CANAL } = require('./conviteCanalService')
const { TZ, HORA_FIM, HORA_POST_CANAL, CHAVE_CANAL_AUTO, CHAVE_PAUSADO, VALIDADE_POST_MANUAL_MIN } = require('../whatsapp/config')

const WORKER_VIVO_SEGUNDOS = 90

const montarPost = async (db = pool) => {
  const itens = await listarItensCanal({ cidade: CIDADE_CANAL.cidade, uf: CIDADE_CANAL.uf, db })
  return { cidade: CIDADE_CANAL.cidade, uf: CIDADE_CANAL.uf, ...montarPostCanal({ cidade: CIDADE_CANAL.cidade, itens }) }
}

const canalAutoAtivo = async (db = pool) =>
  (await db.query(`SELECT valor FROM configuracoes WHERE chave = $1`, [CHAVE_CANAL_AUTO])).rows[0]?.valor === 'true'

// Cron de 1 min (server.js). Nunca lança. Devolve { motivo, id?, status?, total? }.
const agendarPostAutomatico = async ({ agora = new Date(), db = pool } = {}) => {
  try {
    if (!(await canalAutoAtivo(db))) return { motivo: 'desligado' }
    const iso = agora.toISOString()
    const h = (await db.query(
      `SELECT to_char(($1::timestamptz AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS dia,
              EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE '${TZ}'))::int AS hora,
              EXISTS (SELECT 1 FROM whatsapp_canal_posts WHERE origem = 'auto' AND dia = ($1::timestamptz AT TIME ZONE '${TZ}')::date) AS ja`,
      [iso])).rows[0]
    if (h.hora < HORA_POST_CANAL || h.hora >= HORA_FIM) return { motivo: 'fora_do_horario' }
    if (h.ja) return { motivo: 'ja_feito' }
    const post = await montarPost(db)
    const pulado = post.total === 0
    const r = await db.query(
      `INSERT INTO whatsapp_canal_posts (origem, dia, cidade, texto, total, status, erro, criado_em)
       VALUES ('auto', $1::date, $2, $3, $4::int, $5, $6, $7::timestamptz)
       ON CONFLICT (dia) WHERE origem = 'auto' DO NOTHING
       RETURNING id`,
      [h.dia, post.cidade, post.texto, post.total, pulado ? 'pulado' : 'pendente', pulado ? 'nenhum pedido aberto: dia pulado' : null, iso])
    if (!r.rows[0]) return { motivo: 'ja_feito' }
    console.log(`[whatsapp/canal] ${h.dia}: ${pulado ? 'nenhum pedido aberto — dia pulado' : `post automático na fila (${post.total} pedido(s))`}`)
    return { motivo: pulado ? 'pulado' : 'agendado', id: r.rows[0].id, status: pulado ? 'pulado' : 'pendente', total: post.total }
  } catch (err) {
    console.error('[whatsapp/canal] agendarPostAutomatico:', err.message)
    return { motivo: 'erro' }
  }
}

// O que o worker gravou do canal + se ele está vivo e conectado.
const estadoDoCanal = async (db = pool) => {
  const e = (await db.query(
    `SELECT conexao, canal_convite, canal_jid, canal_nome, canal_papel, canal_admin, canal_erro, canal_verificado_em,
            (heartbeat_em IS NOT NULL AND heartbeat_em > NOW() - INTERVAL '${WORKER_VIVO_SEGUNDOS} seconds') AS worker_vivo
       FROM whatsapp_estado WHERE id = 1`)).rows[0] || {}
  const pausado = (await db.query(`SELECT valor FROM configuracoes WHERE chave = $1`, [CHAVE_PAUSADO])).rows[0]?.valor === 'true'
  return {
    worker_vivo: !!e.worker_vivo,
    conectado: !!e.worker_vivo && e.conexao === 'conectado',
    pausado,
    convite: e.canal_convite || null,
    jid: e.canal_jid || null,
    nome: e.canal_nome || null,
    papel: e.canal_papel || null,
    // true = o número do robô é dono/admin do canal e pode postar; false = não é; null = ainda não verificado.
    robo_admin: e.canal_admin ?? null,
    erro: e.canal_erro || null,
    verificado_em: e.canal_verificado_em || null,
  }
}

const ultimosPosts = async (db = pool, limite = 10) => (await db.query(
  `SELECT id, origem, to_char(dia, 'YYYY-MM-DD') AS dia, cidade, status, total, texto, erro, wa_message_id, criado_em, postado_em
     FROM whatsapp_canal_posts ORDER BY id DESC LIMIT $1::int`, [limite])).rows

// POST postar-agora. Devolve { ok: true, id, texto, total } ou { ok: false, status, erro }.
const postarAgora = async ({ usuarioId = null, agora = new Date(), db = pool } = {}) => {
  const canal = await estadoDoCanal(db)
  if (!canal.conectado) return { ok: false, status: 409, erro: 'O robô não está conectado ao WhatsApp agora.' }
  if (canal.pausado) return { ok: false, status: 409, erro: 'O robô está pausado: retome para postar.' }
  if (canal.erro || !canal.jid) return { ok: false, status: 409, erro: `Canal não resolvido pelo robô: ${canal.erro || 'ainda não verificado'}.` }
  if (canal.robo_admin === false) return { ok: false, status: 409, erro: `O número do robô não é admin do canal (papel: ${canal.papel}).` }
  const iso = agora.toISOString()
  const naFila = await db.query(
    `SELECT id FROM whatsapp_canal_posts
      WHERE status = 'pendente' AND criado_em > $1::timestamptz - INTERVAL '${VALIDADE_POST_MANUAL_MIN} minutes' LIMIT 1`, [iso])
  if (naFila.rows[0]) return { ok: false, status: 409, erro: 'Já existe um post esperando o robô publicar.', id: naFila.rows[0].id }
  const post = await montarPost(db)
  if (post.total === 0) return { ok: false, status: 409, erro: `Nenhum pedido aberto em ${post.cidade}: nada para postar.` }
  const r = await db.query(
    `INSERT INTO whatsapp_canal_posts (origem, dia, cidade, texto, total, status, criado_por, criado_em)
     VALUES ('manual', ($1::timestamptz AT TIME ZONE '${TZ}')::date, $2, $3, $4::int, 'pendente', $5::uuid, $1::timestamptz)
     RETURNING id`,
    [iso, post.cidade, post.texto, post.total, usuarioId])
  return { ok: true, id: r.rows[0].id, texto: post.texto, total: post.total }
}

module.exports = { montarPost, canalAutoAtivo, agendarPostAutomatico, estadoDoCanal, ultimosPosts, postarAgora }
