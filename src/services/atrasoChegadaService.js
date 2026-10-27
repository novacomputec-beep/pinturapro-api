// Tolerância de chegada + pedido de atraso ("preciso de mais tempo") — obras e reparos.
//
// PRAZO (acordado) = COALESCE(chegada_prevista_em, expira_em), o que os crons sempre leram.
// LIMITE (quando o cron age) = prazo_chegada_extra_em (extensão aceita, já com tudo dentro)
// ou prazo + TOLERANCIA_CHEGADA (15 min). Fragmentos em utils/agendamento (sqlPrazoChegada /
// sqlLimiteChegada), usados pelos crons de cronômetro, pela vigia, pela espera da vigia e pelos
// dois expirar-match — um só lugar define o limite.
//
// No PRAZO (não no limite) avisarAtrasados avisa os dois lados UMA vez por match
// (aviso_atraso_enviado_em, claim atômico): "X está atrasado — tolerância até HH:MM" ao dono e
// "Você está atrasado — tolerância até HH:MM, depois conta como falta" ao profissional. Não sai
// quando já há extensão (o prazo acordado deixou de ser o limite) nem quando a tolerância já
// venceu (o cron desfaz o match no mesmo tique; dois avisos contraditórios não ajudam).
//
// PEDIDO DE ATRASO: profissional do match, depois do "Estou a caminho" e antes da chegada
// declarada, minutos ∈ {15, 30, 60}, motivo opcional, no máximo MAX_PEDIDOS_POR_MATCH por match
// (pedidos_atraso_usados — zerado com o match em SQL_ZERAR_AGENDA). Um pedido por vez. Enquanto
// está 'pendente' o cron NÃO expira o match. O dono aceita ou recusa; sem resposta em
// RESPOSTA_AUTO_MIN o cron autoAceitarPedidosAtraso aceita por ele ('auto_aceito') e avisa os
// dois. Aceite (manual ou automático): prazo_chegada_extra_em = GREATEST(NOW(), limite atual) +
// minutos — move DE FATO o limite do cron (o fluxo antigo somava minutos a match_feito_em, que
// nenhum cron lia) e não ganha tolerância nova. Recusa = o un-match de sempre do responder-tempo
// (match e chegada zerados, profissional na lista negra da demanda, proposta 'expirado', sem falta).
//
// COMPATIBILIDADE (apps 1.1.2/1.1.3): os quatro endpoints antigos (pedir-tempo, perguntar-tempo,
// informar-tempo, responder-tempo) caem nesta mesma lógica (handlersLegados). Enquanto um pedido
// está pendente, pedido_tempo_status/minutos/motivo são espelhados ('aguardando_aprovacao') para
// a tela antiga do dono mostrar aceitar/recusar; resolvido, voltam a NULL. Minutos fora do
// conjunto no fluxo antigo são arredondados para cima ao permitido (≤15→15, ≤30→30, senão 60).
//
// GET /:id expõe (camposAtraso): prazo_chegada, tolerancia_ate, atrasado, pedido_atraso
// {minutos, motivo, criado_em, status, respondido_em, responde_ate} e pedidos_atraso_restantes.
const { pool } = require('../utils/supabase')
const { SQL_ZERAR_AGENDA, TOLERANCIA_CHEGADA_MIN, sqlPrazoChegada, sqlLimiteChegada, formatarHoraSP, isentoDeFalta } = require('../utils/agendamento')
const { entregarPushOuEmail } = require('./alertaService')

const MINUTOS_PERMITIDOS = [15, 30, 60]
const MAX_PEDIDOS_POR_MATCH = 2
const RESPOSTA_AUTO_MIN = 10
const MOTIVO_MAX = 200
const STATUS_PENDENTE = 'pendente'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const LADOS = {
  obras: {
    tabela: 'obras', chave: 'obra_id', proposta: { tabela: 'candidaturas', coluna: 'obra_id' },
    profissional: 'pintor', nome: 'a obra', artigo: 'A obra', naoEncontrada: 'Obra não encontrada',
    disponivel: 'Obra disponível novamente.',
  },
  reparos: {
    tabela: 'reparos', chave: 'reparo_id', proposta: { tabela: 'interesse_reparos', coluna: 'reparo_id' },
    profissional: 'prestador', nome: 'o serviço', artigo: 'O serviço', naoEncontrada: 'Serviço não encontrado',
    disponivel: 'Serviço disponível novamente.',
  },
}

// prazo_timezone: fuso do dono para o HH:MM dos avisos (formatarHoraSP). chegada_recusada_em /
// chegada_pendente_em / chegada_proposta_por: isenção de falta (isentoDeFalta) no texto do aviso.
const COLUNAS = `id, titulo, criado_por, match_usuario_id, status, a_caminho_em, prazo_timezone,
         chegada_recusada_em, chegada_pendente_em, chegada_proposta_por,
         chegada_declarada_em, chegada_confirmada_em, chegada_prevista_em, expira_em, prazo_chegada_extra_em,
         pedido_atraso_minutos, pedido_atraso_motivo, pedido_atraso_em, pedido_atraso_status,
         pedido_atraso_respondido_em, pedidos_atraso_usados,
         ${sqlPrazoChegada()} AS prazo_chegada, ${sqlLimiteChegada()} AS limite_chegada`

// Limite novo ao aceitar: lê a linha ANTIGA (extensão anterior, se houver) — sem tolerância extra.
const SQL_NOVO_LIMITE = `GREATEST(NOW(), ${sqlLimiteChegada()}) + (pedido_atraso_minutos * INTERVAL '1 minute')`
const SQL_RESOLVER = `pedido_atraso_respondido_em = NOW(), notif_5min_enviada = false,
         pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL`

// ---------- puros ----------
const normalizarMinutos = (v, legado = false) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  if (MINUTOS_PERMITIDOS.includes(n)) return n
  if (!legado) return null
  return MINUTOS_PERMITIDOS.find(m => n <= m) || MINUTOS_PERMITIDOS[MINUTOS_PERMITIDOS.length - 1]
}
const lerMotivo = (v) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, MOTIVO_MAX) : null
}
const mais = (data, min) => new Date(new Date(data).getTime() + min * 60 * 1000)

const pedidoDe = (d) => {
  if (!d?.pedido_atraso_status) return null
  return {
    minutos: d.pedido_atraso_minutos,
    motivo: d.pedido_atraso_motivo,
    criado_em: d.pedido_atraso_em,
    status: d.pedido_atraso_status,
    respondido_em: d.pedido_atraso_respondido_em || null,
    responde_ate: d.pedido_atraso_status === STATUS_PENDENTE && d.pedido_atraso_em ? mais(d.pedido_atraso_em, RESPOSTA_AUTO_MIN) : null,
  }
}
const restantes = (d) => (d?.match_usuario_id ? Math.max(0, MAX_PEDIDOS_POR_MATCH - (Number(d.pedidos_atraso_usados) || 0)) : 0)

// Campos de GET /:id. Relógio do servidor (não do aparelho).
const camposAtraso = (d, agora = new Date()) => {
  const comMatch = !!d?.match_usuario_id && d.status === 'aberta'
  const base = comMatch ? (d.chegada_prevista_em || d.expira_em || null) : null
  const extra = comMatch ? (d.prazo_chegada_extra_em || null) : null
  const prazo_chegada = extra || base
  const tolerancia_ate = extra ? extra : (base ? mais(base, TOLERANCIA_CHEGADA_MIN) : null)
  const atrasado = comMatch && !d.chegada_declarada_em && !d.chegada_confirmada_em
    && !!prazo_chegada && agora.getTime() > new Date(prazo_chegada).getTime()
  return {
    prazo_chegada,
    tolerancia_ate,
    atrasado,
    pedido_atraso: comMatch ? pedidoDe(d) : null,
    pedidos_atraso_restantes: comMatch ? restantes(d) : 0,
  }
}

// ---------- banco ----------
const carregar = async (lado, id, db, lock = false) => {
  if (!UUID_RE.test(String(id))) return null
  const r = await db.query(`SELECT ${COLUNAS} FROM ${lado.tabela} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])
  return r.rows[0] || null
}
const contato = async (usuarioId, db = pool) => {
  if (!usuarioId) return null
  const r = await db.query(`SELECT push_token, email, nome FROM usuarios WHERE id = $1`, [usuarioId])
  return r.rows[0] || null
}
const primeiroNome = (nome) => (String(nome || '').trim().split(/\s+/)[0] || 'O profissional')
const entregar = (destino, campos) => {
  if (!destino) return Promise.resolve('sem contato')
  return entregarPushOuEmail({ ...destino, ...campos }).catch(() => 'falha')
}
const transacao = async (fn) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const r = await fn(client)
    await client.query('COMMIT')
    return r
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
const erro = (status, erroTexto, codigo) => ({ status, corpo: codigo ? { erro: erroTexto, codigo } : { erro: erroTexto } })

// ---------- pedir ----------
// Devolve { status, corpo }. `legado`: minutos arredondados ao permitido (apps antigos).
const pedir = async ({ tabela, id, usuarioId, minutos, motivo, legado = false }) => {
  const lado = LADOS[tabela]
  const min = normalizarMinutos(minutos, legado)
  if (!min) return erro(400, 'Informe os minutos: 15, 30 ou 60.', 'MINUTOS_INVALIDOS')
  const mot = lerMotivo(motivo)
  const feito = await transacao(async (client) => {
    const d = await carregar(lado, id, client, true)
    if (!d) return erro(404, lado.naoEncontrada)
    if (d.match_usuario_id !== usuarioId) return erro(403, `Apenas o ${lado.profissional} do match pode pedir mais tempo.`)
    if (d.status !== 'aberta') return erro(409, `${lado.artigo} não está mais em atendimento.`, 'DEMANDA_FECHADA')
    if (!d.a_caminho_em) return erro(409, 'Toque em "Estou a caminho" antes de pedir mais tempo.', 'SEM_A_CAMINHO')
    if (d.chegada_declarada_em || d.chegada_confirmada_em) return erro(409, 'A chegada já foi registrada.', 'CHEGADA_DECLARADA')
    if (d.pedido_atraso_status === STATUS_PENDENTE) return erro(409, 'Já existe um pedido aguardando a resposta do cliente.', 'PEDIDO_PENDENTE')
    if (restantes(d) <= 0) return erro(409, `Você já usou os ${MAX_PEDIDOS_POR_MATCH} pedidos de mais tempo deste atendimento.`, 'LIMITE_PEDIDOS')
    const upd = await client.query(
      `UPDATE ${lado.tabela} SET
         pedido_atraso_minutos = $3, pedido_atraso_motivo = $4, pedido_atraso_em = NOW(),
         pedido_atraso_status = '${STATUS_PENDENTE}', pedido_atraso_respondido_em = NULL,
         pedidos_atraso_usados = COALESCE(pedidos_atraso_usados, 0) + 1,
         pedido_tempo_status = 'aguardando_aprovacao', pedido_tempo_minutos = $3, pedido_tempo_motivo = $4
       WHERE id = $1 AND match_usuario_id = $2 AND status = 'aberta'
         AND pedido_atraso_status IS DISTINCT FROM '${STATUS_PENDENTE}'
       RETURNING ${COLUNAS}`,
      [id, usuarioId, min, mot]
    )
    if (upd.rowCount === 0) return erro(409, 'Já existe um pedido aguardando a resposta do cliente.', 'PEDIDO_PENDENTE')
    return { ok: true, d: upd.rows[0] }
  })
  if (!feito.ok) return feito
  const d = feito.d
  ;(async () => {
    const [dono, prof] = await Promise.all([contato(d.criado_por), contato(d.match_usuario_id)])
    const nome = primeiroNome(prof?.nome)
    const via = await entregar(dono, {
      titulo: `⏳ ${nome} pede mais ${min} minutos`,
      corpo: `${mot ? `Motivo: ${mot}. ` : ''}Para chegar em "${d.titulo}". Aceitar ou recusar? Sem resposta em ${RESPOSTA_AUTO_MIN} min, o pedido é aceito.`,
      data: { tipo: 'pedido_atraso', [lado.chave]: d.id },
      rotulo: `pedido atraso ${tabela} ${d.id}`,
    })
    console.log(`[Atraso] ${tabela} ${d.id}: pedido de ${min} min → dono via ${via}`)
  })().catch(err => console.error(`[Atraso] ${tabela} ${d.id} aviso do pedido:`, err.message))
  return {
    status: 200,
    corpo: { mensagem: 'Pedido enviado ao cliente.', pedido_atraso: pedidoDe(d), pedidos_atraso_restantes: restantes(d), ...camposAtraso(d) },
  }
}

// ---------- aceitar (dono ou automático) ----------
const aceitarNoBanco = async (client, lado, id, statusFinal) => {
  const upd = await client.query(
    `UPDATE ${lado.tabela} SET
       prazo_chegada_extra_em = ${SQL_NOVO_LIMITE},
       pedido_atraso_status = $2, ${SQL_RESOLVER}
     WHERE id = $1 AND status = 'aberta' AND match_usuario_id IS NOT NULL
       AND pedido_atraso_status = '${STATUS_PENDENTE}'
     RETURNING ${COLUNAS}`,
    [id, statusFinal]
  )
  return upd.rows[0] || null
}

const avisarAceite = async (tabela, d, automatico) => {
  const lado = LADOS[tabela]
  const hora = formatarHoraSP(d.prazo_chegada_extra_em, d.prazo_timezone)
  const [dono, prof] = await Promise.all([contato(d.criado_por), contato(d.match_usuario_id)])
  const nome = primeiroNome(prof?.nome)
  const viaProf = await entregar(prof, {
    titulo: automatico ? `✅ Mais ${d.pedido_atraso_minutos} minutos (aceito automaticamente)` : `✅ Mais ${d.pedido_atraso_minutos} minutos aceitos`,
    corpo: `${automatico ? `O cliente não respondeu em ${RESPOSTA_AUTO_MIN} min. ` : ''}Novo limite de chegada em "${d.titulo}": ${hora}. Depois disso conta como falta.`,
    data: { tipo: 'atraso_aceito', [lado.chave]: d.id },
    rotulo: `atraso aceito ${tabela} ${d.id}`,
  })
  let viaDono = 'não se aplica'
  if (automatico) {
    viaDono = await entregar(dono, {
      titulo: '⏳ Pedido de mais tempo aceito automaticamente',
      corpo: `Você não respondeu em ${RESPOSTA_AUTO_MIN} min: ${nome} tem até ${hora} para chegar em "${d.titulo}".`,
      data: { tipo: 'atraso_aceito_auto', [lado.chave]: d.id },
      rotulo: `atraso auto ${tabela} ${d.id}`,
    })
  }
  console.log(`[Atraso] ${tabela} ${d.id}: ${automatico ? 'auto-aceito' : 'aceito'} +${d.pedido_atraso_minutos} min até ${hora} → profissional via ${viaProf}, dono via ${viaDono}`)
}

// ---------- recusar = un-match de sempre ----------
const recusarNoBanco = async (client, lado, d) => {
  await client.query(
    `WITH desfeito AS (
       UPDATE ${lado.tabela} SET
         match_feito_em = NULL, match_usuario_id = NULL,
         pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL,
         chegada_janela = NULL, chegada_prevista_em = NULL, chegada_declarada_por = NULL, chegada_declarada_em = NULL,
         chegada_pendente_janela = NULL, chegada_pendente_em = NULL, chegada_recusada_em = NULL,
         chegada_confirmada_em = NULL, ${SQL_ZERAR_AGENDA},
         prestadores_bloqueados = CASE
           WHEN $2::uuid IS NULL OR $2::uuid = ANY(COALESCE(prestadores_bloqueados, '{}'))
           THEN prestadores_bloqueados
           ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid) END
       WHERE id = $1 AND match_usuario_id = $2::uuid
       RETURNING id
     )
     UPDATE ${lado.proposta.tabela} SET status = 'expirado'
      WHERE ${lado.proposta.coluna} IN (SELECT id FROM desfeito) AND usuario_id = $2::uuid AND status = 'aceito'`,
    [d.id, d.match_usuario_id]
  )
}

const responder = async ({ tabela, id, usuarioId, aceitar }) => {
  const lado = LADOS[tabela]
  const feito = await transacao(async (client) => {
    const d = await carregar(lado, id, client, true)
    if (!d) return erro(404, lado.naoEncontrada)
    if (d.criado_por !== usuarioId) return erro(403, 'Apenas o dono pode responder.')
    if (d.pedido_atraso_status !== STATUS_PENDENTE || !d.match_usuario_id || d.status !== 'aberta') {
      return erro(409, 'Não há pedido de mais tempo aguardando resposta.', 'SEM_PEDIDO')
    }
    if (aceitar) {
      const novo = await aceitarNoBanco(client, lado, d.id, 'aceito')
      if (!novo) return erro(409, 'Não há pedido de mais tempo aguardando resposta.', 'SEM_PEDIDO')
      return { ok: true, aceito: true, d: novo }
    }
    // O un-match zera pedido_atraso_* (SQL_ZERAR_AGENDA); o rastro da recusa é regravado
    // DEPOIS dele e dura até o próximo match (SQL_LIMPAR_CHEGADA zera de novo).
    await recusarNoBanco(client, lado, d)
    await client.query(
      `UPDATE ${lado.tabela} SET pedido_atraso_status = 'recusado', pedido_atraso_minutos = $2, pedido_atraso_motivo = $3,
              pedido_atraso_em = $4, pedido_atraso_respondido_em = NOW()
        WHERE id = $1`,
      [d.id, d.pedido_atraso_minutos, d.pedido_atraso_motivo, d.pedido_atraso_em]
    )
    return { ok: true, aceito: false, d }
  })
  if (!feito.ok) return feito
  const d = feito.d
  if (feito.aceito) {
    avisarAceite(tabela, d, false).catch(err => console.error(`[Atraso] ${tabela} ${d.id} aviso de aceite:`, err.message))
    return { status: 200, corpo: { mensagem: 'Mais tempo concedido.', pedido_atraso: pedidoDe(d), pedidos_atraso_restantes: restantes(d), ...camposAtraso(d) } }
  }
  ;(async () => {
    const prof = await contato(d.match_usuario_id)
    const via = await entregar(prof, {
      titulo: '❌ Tempo extra recusado',
      corpo: `O solicitante não aceitou. ${lado.artigo} voltou para disponível.`,
      data: { tipo: 'tempo_recusado', [lado.chave]: d.id },
      rotulo: `atraso recusado ${tabela} ${d.id}`,
    })
    console.log(`[Atraso] ${tabela} ${d.id}: recusado, match desfeito → profissional via ${via}`)
  })().catch(err => console.error(`[Atraso] ${tabela} ${d.id} aviso de recusa:`, err.message))
  return { status: 200, corpo: { mensagem: `Tempo recusado. ${lado.disponivel}`, pedido_atraso: null, pedidos_atraso_restantes: 0 } }
}

// ---------- crons (1 min, server.js) ----------
// Pedido pendente há RESPOSTA_AUTO_MIN sem resposta do dono: aceito por ele.
const autoAceitarPedidosAtraso = async () => {
  for (const [tabela, lado] of Object.entries(LADOS)) {
    try {
      const upd = await pool.query(
        `UPDATE ${lado.tabela} SET
           prazo_chegada_extra_em = ${SQL_NOVO_LIMITE},
           pedido_atraso_status = 'auto_aceito', ${SQL_RESOLVER}
         WHERE status = 'aberta' AND match_usuario_id IS NOT NULL
           AND pedido_atraso_status = '${STATUS_PENDENTE}'
           AND pedido_atraso_em + INTERVAL '${RESPOSTA_AUTO_MIN} minutes' <= NOW()
         RETURNING ${COLUNAS}`
      )
      for (const d of upd.rows) {
        await avisarAceite(tabela, d, true).catch(err => console.error(`[Atraso] ${tabela} ${d.id} aviso auto:`, err.message))
      }
      if (upd.rowCount > 0) console.log(`[Atraso] ${tabela}: ${upd.rowCount} pedido(s) aceito(s) automaticamente`)
    } catch (err) {
      console.error(`[Atraso] auto-aceite em ${tabela}:`, err.message)
    }
  }
}

// No PRAZO acordado, sem chegada e com o LIMITE efetivo ainda à frente (tolerância ou extensão
// já aceita — HH:MM é o limite, seja qual for): avisa os dois lados uma vez por match.
const avisarAtrasados = async () => {
  for (const [tabela, lado] of Object.entries(LADOS)) {
    try {
      const claim = await pool.query(
        `UPDATE ${lado.tabela} SET aviso_atraso_enviado_em = NOW()
         WHERE status = 'aberta' AND match_usuario_id IS NOT NULL
           AND chegada_declarada_em IS NULL AND chegada_confirmada_em IS NULL
           AND aviso_atraso_enviado_em IS NULL
           AND ${sqlPrazoChegada()} <= NOW() AND ${sqlLimiteChegada()} > NOW()
         RETURNING id, titulo, criado_por, match_usuario_id, prazo_timezone,
                   chegada_prevista_em, chegada_recusada_em, chegada_pendente_em, chegada_proposta_por,
                   ${sqlLimiteChegada()} AS limite_chegada`
      )
      for (const d of claim.rows) {
        try {
          const hora = formatarHoraSP(d.limite_chegada, d.prazo_timezone)
          // Janela recusada/sem resposta e nenhuma valendo: não há falta a cobrar, o texto não ameaça.
          const isento = isentoDeFalta(d)
          const [dono, prof] = await Promise.all([contato(d.criado_por), contato(d.match_usuario_id)])
          const nome = primeiroNome(prof?.nome)
          const viaDono = await entregar(dono, {
            titulo: `⏰ ${nome} está atrasado — tolerância até ${hora}`,
            corpo: `A chegada em "${d.titulo}" ainda não foi registrada. Até ${hora} o atendimento continua valendo.`,
            data: { tipo: 'atrasado', [lado.chave]: d.id },
            rotulo: `atrasado dono ${tabela} ${d.id}`,
          })
          const viaProf = await entregar(prof, {
            titulo: isento
              ? `⏰ Você está atrasado — tolerância até ${hora}`
              : `⏰ Você está atrasado — tolerância até ${hora}, depois conta como falta`,
            corpo: `Confirme a chegada em "${d.titulo}" no app assim que chegar, ou peça mais tempo ao cliente.`,
            data: { tipo: 'atrasado', [lado.chave]: d.id },
            rotulo: `atrasado profissional ${tabela} ${d.id}`,
          })
          console.log(`[Atraso] ${tabela} ${d.id}: atrasado, tolerância até ${hora} → dono via ${viaDono}, profissional via ${viaProf}`)
        } catch (err) {
          console.error(`[Atraso] ${tabela} ${d.id} aviso de atraso:`, err.message)
        }
      }
    } catch (err) {
      console.error(`[Atraso] aviso de atraso em ${tabela}:`, err.message)
    }
  }
}

// ---------- handlers Express ----------
const responderHttp = (res, r) => res.status(r.status).json(r.corpo)

const handlers = (tabela) => ({
  // POST /:tabela/:id/pedir-atraso { minutos: 15|30|60, motivo? }
  pedir: async (req, res) => {
    try {
      responderHttp(res, await pedir({ tabela, id: req.params.id, usuarioId: req.usuario.id, minutos: req.body?.minutos, motivo: req.body?.motivo }))
    } catch (err) {
      console.error(`[Atraso] pedir ${tabela}:`, err.message)
      res.status(500).json({ erro: 'Erro ao pedir mais tempo' })
    }
  },
  // POST /:tabela/:id/pedir-atraso/responder { aceitar: boolean }
  responder: async (req, res) => {
    try {
      responderHttp(res, await responder({ tabela, id: req.params.id, usuarioId: req.usuario.id, aceitar: req.body?.aceitar === true || req.body?.aceitar === 'true' }))
    } catch (err) {
      console.error(`[Atraso] responder ${tabela}:`, err.message)
      res.status(500).json({ erro: 'Erro ao responder pedido de mais tempo' })
    }
  },
})

// Endpoints antigos (apps 1.1.2/1.1.3), mesma lógica:
//   pedir-tempo {motivo, minutos?}  → pedido (30 min quando o app antigo não manda minutos)
//   perguntar-tempo (dono)          → só reavisa o profissional do pedido pendente
//   informar-tempo {minutos}        → ajusta os minutos do pedido pendente (ou abre um, se não há)
//   responder-tempo {aceito}        → responder
const MINUTOS_LEGADO_PADRAO = 30
const handlersLegados = (tabela) => {
  const lado = LADOS[tabela]
  return {
    pedirTempo: async (req, res) => {
      try {
        const r = await pedir({ tabela, id: req.params.id, usuarioId: req.usuario.id, minutos: req.body?.minutos ?? MINUTOS_LEGADO_PADRAO, motivo: req.body?.motivo, legado: true })
        if (r.status === 200) r.corpo = { ...r.corpo, mensagem: 'Solicitação enviada ao dono.' }
        responderHttp(res, r)
      } catch (err) {
        console.error(`[Atraso] pedir-tempo ${tabela}:`, err.message)
        res.status(500).json({ erro: 'Erro ao solicitar mais tempo' })
      }
    },
    perguntarTempo: async (req, res) => {
      try {
        const d = await carregar(lado, req.params.id, pool)
        if (!d) return res.status(404).json({ erro: lado.naoEncontrada })
        if (d.criado_por !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o dono pode responder o pedido' })
        if (d.pedido_atraso_status === STATUS_PENDENTE && d.match_usuario_id) {
          const prof = await contato(d.match_usuario_id)
          entregar(prof, {
            titulo: '⏱ Quanto tempo você precisa?',
            corpo: `O solicitante quer saber quantos minutos a mais você precisa para chegar em "${d.titulo}". Seu pedido atual: ${d.pedido_atraso_minutos} min.`,
            data: { tipo: 'perguntar_tempo', [lado.chave]: d.id },
            rotulo: `perguntar tempo ${tabela} ${d.id}`,
          }).catch(() => {})
        }
        res.json({ mensagem: `${lado.profissional === 'pintor' ? 'Pintor' : 'Prestador'} notificado para informar o tempo.`, ...camposAtraso(d) })
      } catch (err) {
        console.error(`[Atraso] perguntar-tempo ${tabela}:`, err.message)
        res.status(500).json({ erro: 'Erro ao perguntar tempo' })
      }
    },
    informarTempo: async (req, res) => {
      try {
        const min = normalizarMinutos(req.body?.minutos, true)
        if (!min) return res.status(400).json({ erro: 'Informe um tempo válido em minutos' })
        const atual = await carregar(lado, req.params.id, pool)
        if (!atual) return res.status(404).json({ erro: lado.naoEncontrada })
        if (atual.match_usuario_id !== req.usuario.id) return res.status(403).json({ erro: `Apenas o ${lado.profissional} do match pode informar o tempo` })
        if (atual.pedido_atraso_status !== STATUS_PENDENTE) {
          const r = await pedir({ tabela, id: req.params.id, usuarioId: req.usuario.id, minutos: min, motivo: atual.pedido_atraso_motivo, legado: true })
          if (r.status === 200) r.corpo = { ...r.corpo, mensagem: 'Dono notificado para aprovar o tempo.' }
          return responderHttp(res, r)
        }
        // Minutos novos = pedido novo para o dono: o relógio dos 10 min do auto-aceite recomeça.
        const upd = await pool.query(
          `UPDATE ${lado.tabela} SET pedido_atraso_minutos = $2, pedido_tempo_minutos = $2, pedido_atraso_em = NOW()
            WHERE id = $1 AND match_usuario_id = $3 AND pedido_atraso_status = '${STATUS_PENDENTE}'
            RETURNING ${COLUNAS}`,
          [req.params.id, min, req.usuario.id]
        )
        const d = upd.rows[0] || atual
        const dono = await contato(d.criado_por)
        entregar(dono, {
          titulo: `⏳ ${lado.profissional === 'pintor' ? 'Pintor' : 'Prestador'} precisa de mais tempo`,
          corpo: `Ele precisa de ${min} minuto(s) a mais para chegar em "${d.titulo}". Aceitar ou recusar? Sem resposta em ${RESPOSTA_AUTO_MIN} min, o pedido é aceito.`,
          data: { tipo: 'pedido_atraso', [lado.chave]: d.id },
          rotulo: `informar tempo ${tabela} ${d.id}`,
        }).catch(() => {})
        res.json({ mensagem: 'Dono notificado para aprovar o tempo.', pedido_atraso: pedidoDe(d), pedidos_atraso_restantes: restantes(d), ...camposAtraso(d) })
      } catch (err) {
        console.error(`[Atraso] informar-tempo ${tabela}:`, err.message)
        res.status(500).json({ erro: 'Erro ao informar tempo' })
      }
    },
    responderTempo: async (req, res) => {
      try {
        const r = await responder({ tabela, id: req.params.id, usuarioId: req.usuario.id, aceitar: !!req.body?.aceito })
        // novo_match_feito_em: campo que o app antigo lia na resposta do aceite — hoje vale o
        // limite novo de chegada (prazo_chegada), que é o que de fato mudou.
        if (r.status === 200 && r.corpo.pedido_atraso) r.corpo = { ...r.corpo, mensagem: 'Tempo extra concedido!', novo_match_feito_em: r.corpo.prazo_chegada }
        responderHttp(res, r)
      } catch (err) {
        console.error(`[Atraso] responder-tempo ${tabela}:`, err.message)
        res.status(500).json({ erro: 'Erro ao responder pedido de tempo' })
      }
    },
  }
}

module.exports = {
  MINUTOS_PERMITIDOS, MAX_PEDIDOS_POR_MATCH, RESPOSTA_AUTO_MIN, STATUS_PENDENTE,
  normalizarMinutos, camposAtraso, pedir, responder, handlers, handlersLegados,
  autoAceitarPedidosAtraso, avisarAtrasados,
}
