// PENALIDADES AUTOMÁTICAS (dono, 23/11/2026). Só conta o que acontece DEPOIS da implantação
// (marco em configuracoes 'penalidades_auto_desde', gravado uma vez na migração de boot) — nunca
// retroativo. Depois de uma suspensão (ou de o admin desfazer/tirar), a contagem recomeça dali.
//
// 1) PROFISSIONAL — a cada avaliação nova, média das 3 ÚLTIMAS avaliações contadas <= 2,0:
//    1ª vez  → usuarios.em_observacao_em = agora + push/e-mail "⚠️ Sua conta está em observação";
//    de novo (outra avaliação, ainda em observação) → suspensão de 7 dias pelo MESMO mecanismo das
//    faltas/contato: usuarios.suspenso_em + suspenso_motivo (MOTIVO_SUSPENSAO_AVALIACOES), por
//    pessoa (carregarUsuario), exigirNaoSuspenso barra proposta/interesse/pergunta/aceite e os
//    avisos de pedido novo param. Diferença deste motivo: o FEED continua legível
//    (exigirNaoSuspensoSalvoAvaliacoes nas listas) — só leitura. Levantada sozinha em 7 dias
//    (encerrarPenalidadesVencidas, cron de server.js), sem mensagem.
// 2) CLIENTE — 3 denúncias de 3 profissionais DIFERENTES em 60 dias → 7 dias sem publicar pedido
//    novo: usuarios.publicacao_suspensa_ate (coluna própria: suspenso_em fecharia também o lado
//    profissional da mesma conta e nada mais deve mudar). Pedidos abertos não são tocados;
//    POST /obras/dono e POST /reparos/dono respondem 403 PUBLICACAO_SUSPENSA com a data.
// 3) ANTI-REVANCHE — denúncia feita DEPOIS de o denunciante receber nota <= 2 naquele mesmo
//    contrato não conta (sqlNotaBaixaAntes; GET /admin/denuncias mostra apos_nota_baixa).
//    Denúncia arquivada pelo admin também não conta.
// penalidades_auto guarda cada observação/suspensão com o motivo (as 3 notas ou as 3 denúncias).
const { pool } = require('./supabase')
const { invalidarCacheAssinatura, exigirNaoSuspenso } = require('../middlewares/auth')
const { sqlContasDaPessoa } = require('./tipoConta')

const CHAVE_MARCO = 'penalidades_auto_desde'
const FUSO = 'America/Sao_Paulo'
const NOTAS_NA_MEDIA = 3
const MEDIA_MAXIMA = 2.0
const NOTA_BAIXA = 2
const DIAS_SUSPENSAO = 7
const DENUNCIAS_PARA_SUSPENDER = 3
const JANELA_DENUNCIAS_DIAS = 60
const MOTIVO_SUSPENSAO_AVALIACOES = 'Avaliações baixas'

const TITULO_OBSERVACAO = '⚠️ Sua conta está em observação'
const CORPO_OBSERVACAO = `Suas últimas avaliações ficaram abaixo de 3 estrelas. Capriche nos próximos serviços: se a nota continuar baixa, sua conta será suspensa por ${DIAS_SUSPENSAO} dias.`
const TITULO_SUSPENSAO = `⛔ Conta suspensa por ${DIAS_SUSPENSAO} dias`
const corpoSuspensao = (data) => `Suas avaliações continuaram baixas. Você volta a receber pedidos em ${data}. Dúvidas? Fale com o suporte no app.`
const TITULO_PUBLICACAO = `⛔ Publicação de pedidos suspensa por ${DIAS_SUSPENSAO} dias`
const corpoPublicacao = (data) => `Recebemos denúncias de profissionais diferentes sobre seus pedidos. Você poderá publicar de novo em ${data}. Dúvidas? Fale com o suporte no app.`

// "30/11/2026" no fuso de São Paulo.
const dataBR = (d) => new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d))
const entregar = (args) => require('../services/alertaService').entregarPushEEmail(args)

// Denúncia `d` feita depois de o denunciante levar nota <= 2 no MESMO contrato (subconsulta que
// devolve as estrelas dessa nota, ou nenhuma linha).
const sqlNotaBaixaAntes = (d = 'd') => `
        SELECT nb.estrelas FROM avaliacoes nb
         WHERE nb.contrato_tipo = ${d}.contrato_tipo AND nb.contrato_id = ${d}.contrato_id
           AND nb.avaliado_id = ${d}.denunciante_id AND nb.estrelas <= ${NOTA_BAIXA} AND nb.criado_em < ${d}.criado_em
         ORDER BY nb.criado_em LIMIT 1`

// Migração de boot (idempotente). O marco só é gravado na PRIMEIRA vez.
const migrarPenalidadesAuto = async (client) => {
  await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS em_observacao_em TIMESTAMPTZ`)
  await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS publicacao_suspensa_ate TIMESTAMPTZ`)
  await client.query(`
    CREATE TABLE IF NOT EXISTS penalidades_auto (
      id            BIGSERIAL PRIMARY KEY,
      usuario_id    UUID NOT NULL,
      lado          TEXT NOT NULL CHECK (lado IN ('profissional', 'cliente')),
      tipo          TEXT NOT NULL CHECK (tipo IN ('observacao', 'suspensao')),
      motivo        JSONB NOT NULL,
      criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ate           TIMESTAMPTZ,
      encerrada_em  TIMESTAMPTZ,
      encerrada_por UUID,
      encerramento  TEXT
    )`)
  await client.query(`CREATE INDEX IF NOT EXISTS penalidades_auto_usuario_idx ON penalidades_auto (usuario_id, lado)`)
  await client.query(`CREATE INDEX IF NOT EXISTS penalidades_auto_abertas_idx ON penalidades_auto (criado_em DESC) WHERE encerrada_em IS NULL`)
  await client.query(
    `INSERT INTO configuracoes (chave, valor) SELECT $1, NOW()::text WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = $1)`, [CHAVE_MARCO])
}

// De quando em diante se conta para este usuário/lado: o marco da implantação, a última suspensão
// e o último encerramento feito pelo admin. null = recurso ainda não migrado (nada é contado).
const inicioDaContagem = async (db, usuarioId, lado) => {
  const r = await db.query(
    `SELECT GREATEST(m.valor::timestamptz,
                     (SELECT MAX(p.criado_em) FROM penalidades_auto p WHERE p.usuario_id = $1 AND p.lado = $2 AND p.tipo = 'suspensao'),
                     (SELECT MAX(p.encerrada_em) FROM penalidades_auto p WHERE p.usuario_id = $1 AND p.lado = $2 AND p.encerrada_por IS NOT NULL)) AS desde
       FROM configuracoes m WHERE m.chave = $3`,
    [usuarioId, lado, CHAVE_MARCO])
  return r.rows[0]?.desde || null
}

// 1) Depois de cada avaliação nova do profissional. Nunca lança.
// Devolve 'observacao' | 'suspenso' | 'ja_suspenso' | null.
const verificarPenalidadeAvaliacoes = async (profissionalId, db = pool) => {
  try {
    const desde = await inicioDaContagem(db, profissionalId, 'profissional')
    if (!desde) return null
    const notas = (await db.query(
      `SELECT a.id, a.estrelas, a.criado_em, a.contrato_tipo, a.contrato_id
         FROM avaliacoes a
        WHERE a.avaliado_id = $1 AND a.criado_em > ($2::timestamptz)::timestamp
        ORDER BY a.criado_em DESC, a.id DESC LIMIT ${NOTAS_NA_MEDIA}`,
      [profissionalId, desde])).rows
    if (notas.length < NOTAS_NA_MEDIA) return null
    const media = notas.reduce((s, n) => s + n.estrelas, 0) / NOTAS_NA_MEDIA
    if (media > MEDIA_MAXIMA) return null
    const usuario = (await db.query(`SELECT em_observacao_em, push_token, email, nome FROM usuarios WHERE id = $1`, [profissionalId])).rows[0]
    if (!usuario) return null
    const motivo = JSON.stringify({ media: Math.round(media * 100) / 100, avaliacoes: notas })

    if (!usuario.em_observacao_em) {
      const upd = await db.query(`UPDATE usuarios SET em_observacao_em = NOW() WHERE id = $1 AND em_observacao_em IS NULL RETURNING id`, [profissionalId])
      if (upd.rows.length === 0) return null
      await db.query(`INSERT INTO penalidades_auto (usuario_id, lado, tipo, motivo) VALUES ($1, 'profissional', 'observacao', $2::jsonb)`, [profissionalId, motivo])
      console.log(`[Penalidades] profissional ${profissionalId} em observação — média ${media.toFixed(2)} nas últimas ${NOTAS_NA_MEDIA} avaliações`)
      await entregar({ usuario_id: profissionalId, ...usuario, titulo: TITULO_OBSERVACAO, corpo: CORPO_OBSERVACAO,
        data: { tipo: 'conta_em_observacao' }, rotulo: `conta em observacao ${profissionalId}` })
      return 'observacao'
    }

    // "De novo": só com uma avaliação que não é a que abriu a observação.
    const aberta = (await db.query(
      `SELECT id, motivo FROM penalidades_auto
        WHERE usuario_id = $1 AND lado = 'profissional' AND tipo = 'observacao' AND encerrada_em IS NULL
        ORDER BY id DESC LIMIT 1`, [profissionalId])).rows[0]
    if (aberta?.motivo?.avaliacoes?.[0]?.id === notas[0].id) return null
    // suspenso_em IS NULL: suspende UMA vez; quem já está suspenso por outro motivo fica como está.
    const sus = await db.query(
      `UPDATE usuarios SET suspenso_em = NOW(), suspenso_motivo = $2, em_observacao_em = NULL
        WHERE id = $1 AND suspenso_em IS NULL
        RETURNING suspenso_em + ($3::int * INTERVAL '1 day') AS ate`,
      [profissionalId, MOTIVO_SUSPENSAO_AVALIACOES, DIAS_SUSPENSAO])
    if (sus.rows.length === 0) return 'ja_suspenso'
    const ate = sus.rows[0].ate
    invalidarCacheAssinatura(profissionalId)
    await db.query(
      `UPDATE penalidades_auto SET encerrada_em = NOW(), encerramento = 'virou suspensão'
        WHERE usuario_id = $1 AND lado = 'profissional' AND tipo = 'observacao' AND encerrada_em IS NULL`, [profissionalId])
    await db.query(`INSERT INTO penalidades_auto (usuario_id, lado, tipo, motivo, ate) VALUES ($1, 'profissional', 'suspensao', $2::jsonb, $3)`, [profissionalId, motivo, ate])
    console.log(`[Penalidades] profissional ${profissionalId} suspenso por ${DIAS_SUSPENSAO} dias — avaliações continuaram baixas (média ${media.toFixed(2)})`)
    await entregar({ usuario_id: profissionalId, ...usuario, titulo: TITULO_SUSPENSAO, corpo: corpoSuspensao(dataBR(ate)),
      data: { tipo: 'conta_suspensa', motivo: 'avaliacoes', dias: DIAS_SUSPENSAO, ate }, rotulo: `suspensao avaliacoes ${profissionalId}` })
    return 'suspenso'
  } catch (err) {
    console.error(`[Penalidades] avaliações de ${profissionalId}:`, err.message)
    return null
  }
}

// 2) Depois de cada denúncia nova contra o cliente. Nunca lança. Devolve 'suspenso' | 'ja_suspenso' | null.
const verificarPenalidadeDenuncias = async (clienteId, db = pool) => {
  try {
    if (!clienteId) return null
    const desde = await inicioDaContagem(db, clienteId, 'cliente')
    if (!desde) return null
    // A denúncia mais recente de cada profissional que conta; depois, as 3 mais recentes.
    const denuncias = (await db.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (d.denunciante_id) d.id, d.denunciante_id, d.categoria, d.criado_em, d.contrato_tipo, d.contrato_id
           FROM denuncias d
          WHERE d.denunciado_id = $1 AND d.status <> 'arquivada'
            AND d.criado_em > ($2::timestamptz)::timestamp
            AND d.criado_em > (NOW() - ($3::int * INTERVAL '1 day'))::timestamp
            AND NOT EXISTS (${sqlNotaBaixaAntes('d')})
          ORDER BY d.denunciante_id, d.criado_em DESC) x
        ORDER BY x.criado_em DESC LIMIT ${DENUNCIAS_PARA_SUSPENDER}`,
      [clienteId, desde, JANELA_DENUNCIAS_DIAS])).rows
    if (denuncias.length < DENUNCIAS_PARA_SUSPENDER) return null
    const sus = await db.query(
      `UPDATE usuarios SET publicacao_suspensa_ate = NOW() + ($2::int * INTERVAL '1 day')
        WHERE id = $1 AND (publicacao_suspensa_ate IS NULL OR publicacao_suspensa_ate <= NOW())
        RETURNING publicacao_suspensa_ate AS ate, push_token, email, nome`,
      [clienteId, DIAS_SUSPENSAO])
    if (sus.rows.length === 0) return 'ja_suspenso'
    const { ate, ...usuario } = sus.rows[0]
    await db.query(`INSERT INTO penalidades_auto (usuario_id, lado, tipo, motivo, ate) VALUES ($1, 'cliente', 'suspensao', $2::jsonb, $3)`,
      [clienteId, JSON.stringify({ denuncias }), ate])
    console.log(`[Penalidades] cliente ${clienteId} sem publicar por ${DIAS_SUSPENSAO} dias — ${DENUNCIAS_PARA_SUSPENDER} denúncias de profissionais diferentes em ${JANELA_DENUNCIAS_DIAS} dias`)
    await entregar({ usuario_id: clienteId, ...usuario, titulo: TITULO_PUBLICACAO, corpo: corpoPublicacao(dataBR(ate)),
      data: { tipo: 'publicacao_suspensa', dias: DIAS_SUSPENSAO, ate }, rotulo: `publicacao suspensa ${clienteId}` })
    return 'suspenso'
  } catch (err) {
    console.error(`[Penalidades] denúncias contra ${clienteId}:`, err.message)
    return null
  }
}

// Cron (server.js): levanta, SEM mensagem, o que venceu. Só as suspensões deste módulo.
const encerrarPenalidadesVencidas = async (db = pool) => {
  try {
    const prof = await db.query(
      `UPDATE usuarios SET suspenso_em = NULL, suspenso_motivo = NULL
        WHERE suspenso_motivo = $1 AND suspenso_em <= NOW() - ($2::int * INTERVAL '1 day')
        RETURNING id`, [MOTIVO_SUSPENSAO_AVALIACOES, DIAS_SUSPENSAO])
    for (const { id } of prof.rows) invalidarCacheAssinatura(id)
    const cli = await db.query(`UPDATE usuarios SET publicacao_suspensa_ate = NULL WHERE publicacao_suspensa_ate <= NOW() RETURNING id`)
    await db.query(`UPDATE penalidades_auto SET encerrada_em = NOW(), encerramento = 'cumprida' WHERE tipo = 'suspensao' AND encerrada_em IS NULL AND ate <= NOW()`)
    const n = prof.rows.length + cli.rows.length
    if (n > 0) console.log(`[Penalidades] ${n} suspensão(ões) automática(s) vencida(s) levantada(s)`)
    return { profissionais: prof.rows.map(x => x.id), clientes: cli.rows.map(x => x.id) }
  } catch (err) {
    console.error('[Penalidades] encerrar vencidas:', err.message)
    return { profissionais: [], clientes: [] }
  }
}

// Suspensão por avaliações: o feed continua legível (só leitura) e publicar pedido como cliente
// não é afetado — nas rotas que usam este middleware no lugar de exigirNaoSuspenso. Qualquer
// outro motivo de suspensão segue barrado como sempre.
const exigirNaoSuspensoSalvoAvaliacoes = (req, res, next) =>
  (req.usuario?.suspenso_em && req.usuario.suspenso_motivo === MOTIVO_SUSPENSAO_AVALIACOES ? next() : exigirNaoSuspenso(req, res, next))

// POST /obras/dono e POST /reparos/dono: cliente com a publicação suspensa (por pessoa: qualquer
// conta do mesmo CPF) → 403 com a data. Lê do banco (rota de escrita, sem o cache de autenticar).
const corpoPublicacaoSuspensa = (ate) => ({
  erro: `Publicação de pedidos suspensa até ${dataBR(ate)}: recebemos denúncias de profissionais diferentes sobre seus pedidos. Seus pedidos abertos continuam valendo. Dúvidas? Fale com o suporte no app.`,
  codigo: 'PUBLICACAO_SUSPENSA',
  publicacao_suspensa_ate: ate,
})
const exigirPodePublicar = async (req, res, next) => {
  if (req.usuario.role === 'admin' || req.usuario.role === 'aprovador') return next()
  try {
    const r = await pool.query(
      `SELECT MAX(publicacao_suspensa_ate) AS ate FROM usuarios
        WHERE id IN (${sqlContasDaPessoa('$1')}) AND publicacao_suspensa_ate > NOW()`, [req.usuario.id])
    if (r.rows[0]?.ate) return res.status(403).json(corpoPublicacaoSuspensa(r.rows[0].ate))
    next()
  } catch (err) {
    console.error('[Penalidades] exigirPodePublicar:', err.message)
    res.status(500).json({ erro: 'Erro ao verificar a conta' })
  }
}

// ─── SUPER-ADMIN ──────────────────────────────────────────────────────────────────────────────
// Penalidades EM VIGOR: observação aberta; suspensão ainda não vencida e ainda gravada na conta.
const listarPenalidades = async (db = pool) => {
  const r = await db.query(
    `SELECT p.id, p.usuario_id, u.nome, u.email, p.lado,
            CASE p.tipo WHEN 'observacao' THEN 'em_observacao' ELSE 'suspenso' END AS status,
            p.criado_em AS desde, p.ate, p.motivo
       FROM penalidades_auto p JOIN usuarios u ON u.id = p.usuario_id
      WHERE p.encerrada_em IS NULL
        AND ((p.tipo = 'observacao' AND u.em_observacao_em IS NOT NULL)
          OR (p.tipo = 'suspensao' AND p.ate > NOW() AND p.lado = 'profissional' AND u.suspenso_em IS NOT NULL AND u.suspenso_motivo = $1)
          OR (p.tipo = 'suspensao' AND p.ate > NOW() AND p.lado = 'cliente' AND u.publicacao_suspensa_ate > NOW()))
      ORDER BY p.criado_em DESC, p.id DESC`, [MOTIVO_SUSPENSAO_AVALIACOES])
  const penalidades = []
  for (const p of r.rows) {
    const m = p.motivo || {}
    let motivo
    if (m.avaliacoes) {
      const ids = m.avaliacoes.map(a => a.id)
      const tit = (await db.query(
        `SELECT a.id, COALESCE(o.titulo, rp.titulo) AS titulo FROM avaliacoes a
           LEFT JOIN obras o ON a.contrato_tipo = 'obra' AND o.id = a.contrato_id
           LEFT JOIN reparos rp ON a.contrato_tipo = 'reparo' AND rp.id = a.contrato_id
          WHERE a.id = ANY($1::uuid[])`, [ids])).rows
      motivo = { tipo: 'avaliacoes', media: m.media, resumo: `Média ${String(m.media).replace('.', ',')} nas últimas ${ids.length} avaliações (${m.avaliacoes.map(a => `${a.estrelas}★`).join(', ')})`,
        avaliacoes: m.avaliacoes.map(a => ({ ...a, contrato_titulo: tit.find(t => t.id === a.id)?.titulo || null })) }
    } else {
      const ids = (m.denuncias || []).map(d => d.id)
      const det = (await db.query(
        `SELECT d.id, ud.nome AS denunciante_nome, d.status, COALESCE(o.titulo, rp.titulo) AS titulo FROM denuncias d
           LEFT JOIN usuarios ud ON ud.id = d.denunciante_id
           LEFT JOIN obras o ON d.contrato_tipo = 'obra' AND o.id = d.contrato_id
           LEFT JOIN reparos rp ON d.contrato_tipo = 'reparo' AND rp.id = d.contrato_id
          WHERE d.id = ANY($1::uuid[])`, [ids])).rows
      motivo = { tipo: 'denuncias', resumo: `${ids.length} denúncias de ${ids.length} profissionais diferentes em ${JANELA_DENUNCIAS_DIAS} dias`,
        denuncias: (m.denuncias || []).map(d => { const x = det.find(t => t.id === d.id) || {}; return { ...d, denunciante_nome: x.denunciante_nome || null, status: x.status || null, contrato_titulo: x.titulo || null } }) }
    }
    penalidades.push({ id: p.id, usuario_id: p.usuario_id, nome: p.nome, email: p.email, lado: p.lado, status: p.status, desde: p.desde, ate: p.ate, motivo })
  }
  return penalidades
}

// POST tirar-observacao / desfazer-suspensao. Sem mensagem ao usuário.
// Devolve { ok: true, ... } ou { ok: false, status, erro }.
const encerrarPeloAdmin = async (penalidadeId, tipo, adminId, db = pool) => {
  if (!/^\d+$/.test(String(penalidadeId))) return { ok: false, status: 400, erro: 'id inválido' }
  const p = (await db.query(`SELECT id, usuario_id, lado, tipo, encerrada_em FROM penalidades_auto WHERE id = $1::bigint`, [penalidadeId])).rows[0]
  if (!p || p.tipo !== tipo) return { ok: false, status: 404, erro: tipo === 'observacao' ? 'Observação não encontrada' : 'Suspensão não encontrada' }
  if (p.encerrada_em) return { ok: false, status: 409, erro: 'Esta penalidade já foi encerrada' }
  if (tipo === 'observacao') {
    await db.query(`UPDATE usuarios SET em_observacao_em = NULL WHERE id = $1`, [p.usuario_id])
  } else if (p.lado === 'profissional') {
    // Só a suspensão DESTE motivo: a por faltas/contato não é desfeita por aqui.
    await db.query(`UPDATE usuarios SET suspenso_em = NULL, suspenso_motivo = NULL WHERE id = $1 AND suspenso_motivo = $2`, [p.usuario_id, MOTIVO_SUSPENSAO_AVALIACOES])
    invalidarCacheAssinatura(p.usuario_id)
  } else {
    await db.query(`UPDATE usuarios SET publicacao_suspensa_ate = NULL WHERE id = $1`, [p.usuario_id])
  }
  await db.query(`UPDATE penalidades_auto SET encerrada_em = NOW(), encerrada_por = $2::uuid, encerramento = $3 WHERE id = $1::bigint`,
    [p.id, adminId || null, tipo === 'observacao' ? 'observação tirada pelo admin' : 'suspensão desfeita pelo admin'])
  console.log(`[Penalidades] admin ${adminId} encerrou ${tipo} ${p.id} (${p.lado} ${p.usuario_id})`)
  return { ok: true, id: p.id, usuario_id: p.usuario_id, lado: p.lado }
}

module.exports = {
  CHAVE_MARCO, NOTAS_NA_MEDIA, MEDIA_MAXIMA, DIAS_SUSPENSAO, DENUNCIAS_PARA_SUSPENDER, JANELA_DENUNCIAS_DIAS, MOTIVO_SUSPENSAO_AVALIACOES,
  TITULO_OBSERVACAO, CORPO_OBSERVACAO, TITULO_SUSPENSAO, corpoSuspensao, TITULO_PUBLICACAO, corpoPublicacao, dataBR,
  migrarPenalidadesAuto, verificarPenalidadeAvaliacoes, verificarPenalidadeDenuncias, encerrarPenalidadesVencidas,
  exigirNaoSuspensoSalvoAvaliacoes, exigirPodePublicar, corpoPublicacaoSuspensa, sqlNotaBaixaAntes, listarPenalidades, encerrarPeloAdmin,
}
