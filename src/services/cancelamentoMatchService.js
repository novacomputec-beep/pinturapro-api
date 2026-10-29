// Cancelamento JUSTO de um match (obras e reparos), pelo dono ou pelo profissional casado,
// enquanto o profissional ainda não disse "Estou a caminho" (a_caminho_em NULL). Substitui o uso
// de POST /:id/expirar-match pelas partes (que fica para admin, cron e a contestação de chegada
// do dono).
//
// ANTECEDÊNCIA contra o horário combinado (chegada_prevista_em — é nela que o agendamento aceito
// e as janelas antigas caem):
//   sem horário combinado            → 'livre' sempre;
//   faltam >= 12h para o horário     → 'livre';
//   faixa da demanda < 24h e >= 1h   → 'livre';
//   senão                            → 'tardio' (falta para quem cancela, salvo acordo mútuo).
// ?simular=1 devolve só { tipo, ... } sem agir — o app escolhe a folha certa.
//
// AO CONFIRMAR (transação): match, agendamento e chegada zerados (SQL_ZERAR_AGENDA + chegada_*,
// pedido_tempo_*), demanda de volta ao feed com o prazo que restava (piso de 1h para não voltar
// já vencida), SEM entrar em prestadores_bloqueados; a candidatura/interesse vencedora vira
// 'cancelado' com motivo, quem cancelou e se foi por acordo. Depois, fora da transação: falta
// (faltas_profissional + suspensão 3 em 90 dias, alertaService.registrarFaltaUsuario) só no
// tardio sem acordo; push + e-mail de reserva ao outro lado; reanúncio aos profissionais que
// ainda não se manifestaram (alertaService.reanunciarDemanda) quando a demanda segue aberta;
// e o aviso de cancelamentos frequentes no 3º em 90 dias.
// Dono que cancela por 'nao_preciso' (ou manda manter_aberta: false) ENCERRA a demanda
// ('cancelada', como DELETE /:tabela/dono/:id) em vez de devolvê-la ao feed.
//
// ACORDO MÚTUO: POST /:id/cancelamento-acordo registra um pedido (colunas cancelamento_pedido_*
// na demanda, validade ACORDO_VALIDADE_HORAS) e avisa o outro lado; POST .../responder
// {aceitar} pelo OUTRO lado cancela sem falta (aceitar) ou mantém tudo (recusar). Pedido vencido
// é limpo pelo cron expirarPedidosCancelamento (server.js, 5 min) avisando quem pediu. O pedido
// pendente sai em GET /:id como pedido_cancelamento (pedidoCancelamento).
const { pool } = require('../utils/supabase')
const { SQL_ZERAR_AGENDA, formatarDataHoraSP } = require('../utils/agendamento')
const { entregarPushOuEmail, entregarPushEEmail, registrarFaltaUsuario, reanunciarDemanda } = require('./alertaService')

const MOTIVOS = ['imprevisto', 'nao_preciso', 'nao_consigo_horario', 'outro']
const ROTULO_MOTIVO = {
  imprevisto: 'Imprevisto', nao_preciso: 'Não preciso mais',
  nao_consigo_horario: 'Não consigo no horário', outro: 'Outro motivo',
}
const DETALHE_MAX = 200
const ANTECEDENCIA_LIVRE_HORAS = 12
const ANTECEDENCIA_LIVRE_FAIXA_CURTA_HORAS = 1
const FAIXA_CURTA_HORAS = 24
const PISO_PRAZO_RESTANTE = '1 hour'
const ACORDO_VALIDADE_HORAS = 2
const JANELA_CANCELAMENTOS_DIAS = 90
const AVISO_CANCELAMENTOS_N = 3
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const LADOS = {
  obras: {
    tabela: 'obras', tipo: 'obra', chave: 'obra_id', janelaCol: 'horas_para_expirar',
    proposta: { tabela: 'candidaturas', coluna: 'obra_id' },
    nome: 'a obra', artigo: 'A obra', tituloCancelado: '❌ Obra cancelada', naoEncontrada: 'Obra não encontrada',
    profissional: 'pintor',
  },
  reparos: {
    tabela: 'reparos', tipo: 'reparo', chave: 'reparo_id', janelaCol: 'prazo_atendimento_horas',
    proposta: { tabela: 'interesse_reparos', coluna: 'reparo_id' },
    nome: 'o serviço', artigo: 'O serviço', tituloCancelado: '❌ Serviço cancelado', naoEncontrada: 'Serviço não encontrado',
    profissional: 'prestador',
  },
}

// Colunas de match/chegada/agendamento zeradas no cancelamento — a MESMA lista de
// POST /:id/expirar-match, menos prestadores_bloqueados (cancelar não bloqueia ninguém).
const SQL_LIMPAR_MATCH = `match_feito_em = NULL, match_usuario_id = NULL,
       pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL,
       chegada_janela = NULL, chegada_prevista_em = NULL, chegada_declarada_por = NULL, chegada_declarada_em = NULL,
       chegada_pendente_janela = NULL, chegada_pendente_em = NULL, chegada_recusada_em = NULL, chegada_confirmada_em = NULL,
       aviso_match_enviado_em = NULL, lembrete_chegada_enviado_em = NULL, ${SQL_ZERAR_AGENDA},
       cancelamento_pedido_por = NULL, cancelamento_pedido_motivo = NULL, cancelamento_pedido_detalhe = NULL,
       cancelamento_pedido_em = NULL, cancelamento_pedido_expira_em = NULL`

// ---------- leitura e regras puras ----------
const carregar = async (lado, id, db = pool) => {
  if (!UUID_RE.test(String(id))) return null
  const r = await db.query(
    `SELECT id, titulo, criado_por, match_usuario_id, status, a_caminho_em, chegada_prevista_em, expira_em,
            COALESCE(${lado.janelaCol}, 720)::float AS janela_horas,
            CASE WHEN chegada_prevista_em IS NULL THEN NULL
                 ELSE EXTRACT(EPOCH FROM (chegada_prevista_em - NOW())) / 3600 END AS horas_ate_horario,
            cancelamento_pedido_por, cancelamento_pedido_motivo, cancelamento_pedido_detalhe,
            cancelamento_pedido_em, cancelamento_pedido_expira_em,
            (cancelamento_pedido_em IS NOT NULL AND cancelamento_pedido_expira_em > NOW()) AS pedido_vigente
       FROM ${lado.tabela} WHERE id = $1`,
    [id]
  )
  return r.rows[0] || null
}

// { tipo: 'livre' | 'tardio', limite_horas, horas_ate_horario, horario } — regra do cabeçalho.
const classificar = (d) => {
  if (!d.chegada_prevista_em) return { tipo: 'livre', limite_horas: null, horas_ate_horario: null, horario: null, regra: 'sem_horario' }
  const limite = Number(d.janela_horas) < FAIXA_CURTA_HORAS ? ANTECEDENCIA_LIVRE_FAIXA_CURTA_HORAS : ANTECEDENCIA_LIVRE_HORAS
  const horas = Number(d.horas_ate_horario)
  return {
    tipo: horas >= limite ? 'livre' : 'tardio',
    limite_horas: limite, horas_ate_horario: Math.round(horas * 100) / 100, horario: d.chegada_prevista_em,
    regra: Number(d.janela_horas) < FAIXA_CURTA_HORAS ? 'faixa_curta' : 'padrao',
  }
}

const papelDe = (d, usuarioId) => (d.criado_por === usuarioId ? 'dono' : d.match_usuario_id === usuarioId ? 'profissional' : null)
const quemFala = (papel, lado) => (papel === 'dono' ? 'O cliente' : `O ${lado.profissional}`)

// Guardas comuns às três rotas. Devolve { d, papel } ou { status, corpo } para responder.
const guardar = async (lado, req) => {
  const d = await carregar(lado, req.params.id)
  if (!d) return { status: 404, corpo: { erro: lado.naoEncontrada } }
  const papel = papelDe(d, req.usuario.id)
  if (!papel) return { status: 403, corpo: { erro: 'Só o cliente ou o profissional do atendimento podem cancelar' } }
  if (d.status !== 'aberta') return { status: 409, corpo: { erro: `${lado.artigo} não está mais em andamento`, codigo: 'DEMANDA_FECHADA' } }
  if (!d.match_usuario_id) return { status: 409, corpo: { erro: 'Não há atendimento combinado para cancelar', codigo: 'SEM_MATCH' } }
  if (d.a_caminho_em) {
    return { status: 409, corpo: { erro: 'O profissional já está a caminho: o cancelamento pelo app não é mais possível. Combine diretamente com ele.', codigo: 'A_CAMINHO' } }
  }
  return { d, papel }
}

const lerMotivo = (body) => {
  const motivo = typeof body?.motivo === 'string' ? body.motivo.trim() : ''
  if (!MOTIVOS.includes(motivo)) return { erro: `motivo deve ser um de: ${MOTIVOS.join(', ')}` }
  const bruto = body?.detalhe
  if (bruto != null && typeof bruto !== 'string') return { erro: 'detalhe deve ser texto' }
  const detalhe = (bruto || '').trim().slice(0, DETALHE_MAX) || null
  return { motivo, detalhe }
}
const textoMotivo = (motivo, detalhe) => `${ROTULO_MOTIVO[motivo] || motivo}${detalhe ? ` — ${detalhe}` : ''}`

// pedido_cancelamento de GET /:id: só para dono e profissional do match; null sem pedido vigente.
const pedidoCancelamento = (linha, leitorId) => {
  if (!linha || !linha.cancelamento_pedido_em || !linha.cancelamento_pedido_expira_em) return null
  if (new Date(linha.cancelamento_pedido_expira_em) <= new Date()) return null
  if (linha.criado_por !== leitorId && linha.match_usuario_id !== leitorId) return null
  return {
    por: linha.cancelamento_pedido_por === linha.criado_por ? 'dono' : 'profissional',
    meu: linha.cancelamento_pedido_por === leitorId,
    motivo: linha.cancelamento_pedido_motivo,
    detalhe: linha.cancelamento_pedido_detalhe,
    criado_em: linha.cancelamento_pedido_em,
    expira_em: linha.cancelamento_pedido_expira_em,
  }
}

// ---------- efeitos ----------
const contato = async (usuarioId, db = pool) => {
  const r = await db.query(`SELECT id AS usuario_id, push_token, email, nome FROM usuarios WHERE id = $1`, [usuarioId])
  return r.rows[0] || null
}
// ambos (padrão): push E e-mail (entregarPushEEmail, dedupe em email_alertas) — cancelamento,
// pedido de cancelamento, recusa e expiração do acordo são avisos críticos pós-match.
// ambos: false → push ou, sem ele, e-mail (entregarPushOuEmail): só o aviso de cancelamentos
// frequentes, que é penalidade/lembrete e não tem demanda.
// ator: quem executou a ação — a guarda dos helpers nunca avisa o próprio autor (ator_id).
const avisar = async (usuarioId, { titulo, corpo, data, rotulo }, { ambos = true, ator = null } = {}) => {
  try {
    const u = await contato(usuarioId)
    if (u) await (ambos ? entregarPushEEmail : entregarPushOuEmail)({ ...u, ator_id: ator, titulo, corpo, data, rotulo })
  } catch (err) {
    console.error(`[CancelarMatch] aviso ${rotulo}:`, err.message)
  }
}

// Cancelamentos do usuário (como quem cancelou) em 90 dias, nos dois lados; no 3º, aviso.
const avisarCancelamentosFrequentes = async (usuarioId) => {
  try {
    const r = await pool.query(
      `SELECT (SELECT COUNT(*) FROM candidaturas WHERE cancelado_por = $1 AND cancelado_em > NOW() - ($2::int * INTERVAL '1 day'))
            + (SELECT COUNT(*) FROM interesse_reparos WHERE cancelado_por = $1 AND cancelado_em > NOW() - ($2::int * INTERVAL '1 day')) AS n`,
      [usuarioId, JANELA_CANCELAMENTOS_DIAS]
    )
    const n = Number(r.rows[0]?.n || 0)
    if (n !== AVISO_CANCELAMENTOS_N) return n
    await avisar(usuarioId, {
      titulo: '⚠️ Cancelamentos frequentes',
      corpo: `Você cancelou ${n} atendimentos nos últimos ${JANELA_CANCELAMENTOS_DIAS} dias. Cancelamentos repetidos prejudicam quem conta com você e podem levar à suspensão da conta.`,
      data: { tipo: 'cancelamentos_frequentes', total: n },
      rotulo: `cancelamentos frequentes ${usuarioId}`,
    }, { ambos: false })
    return n
  } catch (err) {
    console.error('[CancelarMatch] contagem de cancelamentos:', err.message)
    return null
  }
}

// Cancela de fato. canceladoPor = quem assume o cancelamento (no acordo, quem pediu).
// Devolve { ok: true, encerrada } ou { ok: false } quando a linha mudou na corrida.
// atorId = quem executou a ação AGORA (cancelamento livre: o próprio canceladoPor; aceite de
// acordo: quem ACEITOU, que não é o canceladoPor). O aviso vai sempre à outra parte do ator:
// no aceite de acordo, ao pedinte ("aceitaram seu pedido"), nunca a quem acabou de aceitar —
// antes o aceitante recebia "O cliente/profissional cancelou…" e o pedinte não recebia nada.
const executar = async ({ lado, d, canceladoPor, atorId = canceladoPor, motivo, detalhe, acordo, tardio, manterAberta }) => {
  const papel = papelDe(d, canceladoPor)
  const profissionalId = d.match_usuario_id
  const encerrar = papel === 'dono' && (motivo === 'nao_preciso' || manterAberta === false)
  const client = await pool.connect()
  let desfeito = false
  try {
    await client.query('BEGIN')
    const upd = await client.query(
      `UPDATE ${lado.tabela} SET ${SQL_LIMPAR_MATCH},
              expira_em = GREATEST(expira_em, NOW() + INTERVAL '${PISO_PRAZO_RESTANTE}')
              ${encerrar ? `, status = 'cancelada', status_aprovacao = 'cancelada', encerrado_em = COALESCE(encerrado_em, NOW())` : ''}
        WHERE id = $1 AND match_usuario_id = $2 AND a_caminho_em IS NULL AND status = 'aberta'
        RETURNING id`,
      [d.id, profissionalId]
    )
    if (upd.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false } }
    await client.query(
      `UPDATE ${lado.proposta.tabela}
          SET status = 'cancelado', cancelado_por = $3, cancelado_motivo = $4, cancelado_detalhe = $5,
              cancelado_em = NOW(), cancelado_acordo = $6
        WHERE ${lado.proposta.coluna} = $1 AND usuario_id = $2 AND status = 'aceito'`,
      [d.id, profissionalId, canceladoPor, motivo, detalhe, !!acordo]
    )
    await client.query('COMMIT')
    desfeito = true
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
  if (!desfeito) return { ok: false }

  const comFalta = tardio && !acordo
  console.log(`[CancelarMatch] ${lado.tipo} ${d.id} cancelado por ${papel} ${canceladoPor} (${motivo}${acordo ? ', acordo' : tardio ? ', tardio' : ', livre'}${comFalta ? ', falta' : ''}${encerrar ? ', demanda encerrada' : ''})`)
  if (comFalta) registrarFaltaUsuario(lado.tabela, d.id, canceladoPor).catch(() => {})

  const outroId = papel === 'dono' ? profissionalId : d.criado_por
  const corpoOutro = papel === 'dono'
    ? `O cliente cancelou "${d.titulo}". Motivo: ${textoMotivo(motivo, detalhe)}.${acordo ? ' Cancelamento por acordo, sem penalidade.' : ''}`
    : `O ${lado.profissional} cancelou "${d.titulo}". Motivo: ${textoMotivo(motivo, detalhe)}. ${lado.artigo} voltou ao feed para outros profissionais.${acordo ? ' Cancelamento por acordo, sem penalidade.' : ''}`
  if (String(outroId) === String(atorId)) {
    // Aceite de acordo: o "outro" do cancelamento é quem acabou de aceitar. Quem precisa saber é
    // o PEDINTE (canceladoPor): o pedido dele foi aceito e o atendimento acabou.
    const papelAceitante = papelDe(d, atorId)
    avisar(canceladoPor, {
      titulo: '✅ Cancelamento aceito',
      corpo: `${quemFala(papelAceitante, lado)} aceitou cancelar "${d.titulo}" de comum acordo. Sem penalidade para ninguém.`,
      data: { tipo: 'match_cancelado', [lado.chave]: d.id, motivo, por: papelAceitante, acordo: true },
      rotulo: `acordo aceito ${lado.tipo} ${d.id}`,
    }, { ator: atorId })
  } else {
    avisar(outroId, {
      titulo: lado.tituloCancelado, corpo: corpoOutro,
      data: { tipo: 'match_cancelado', [lado.chave]: d.id, motivo, por: papel, acordo: !!acordo },
      rotulo: `match cancelado ${lado.tipo} ${d.id}`,
    }, { ator: atorId })
  }
  if (!encerrar) reanunciarDemanda(lado.tabela, d.id).catch(() => {})
  avisarCancelamentosFrequentes(canceladoPor)
  return { ok: true, encerrada: encerrar }
}

// ---------- handlers ----------
const handlers = (tabela) => {
  const lado = LADOS[tabela]
  if (!lado) throw new Error(`cancelamentoMatchService: lado desconhecido "${tabela}"`)

  // POST /:tabela/:id/cancelar-match {motivo, detalhe?, manter_aberta?} [?simular=1]
  const cancelar = async (req, res) => {
    try {
      const g = await guardar(lado, req)
      if (g.status) return res.status(g.status).json(g.corpo)
      const { d, papel } = g
      const classe = classificar(d)
      const simular = ['1', 'true'].includes(String(req.query.simular || '').toLowerCase())
      if (simular) {
        return res.json({ ...classe, papel, falta: classe.tipo === 'tardio', horario_texto: classe.horario ? formatarDataHoraSP(classe.horario) : null, pedido_cancelamento: pedidoCancelamento(d, req.usuario.id) })
      }
      const lido = lerMotivo(req.body)
      if (lido.erro) return res.status(400).json({ erro: lido.erro })
      const manterAberta = req.body?.manter_aberta === false ? false : true
      const r = await executar({ lado, d, canceladoPor: req.usuario.id, motivo: lido.motivo, detalhe: lido.detalhe, acordo: false, tardio: classe.tipo === 'tardio', manterAberta })
      if (!r.ok) return res.status(409).json({ erro: 'O atendimento mudou enquanto você cancelava. Atualize a tela.', codigo: 'ESTADO_MUDOU' })
      res.json({ mensagem: r.encerrada ? 'Atendimento cancelado e pedido encerrado.' : 'Atendimento cancelado.', ...classe, falta: classe.tipo === 'tardio', demanda_encerrada: r.encerrada })
    } catch (err) {
      console.error(`[CancelarMatch] ${tabela} ${req.params.id}:`, err.message)
      res.status(500).json({ erro: 'Erro ao cancelar o atendimento' })
    }
  }

  // POST /:tabela/:id/cancelamento-acordo {motivo, detalhe?}
  const pedirAcordo = async (req, res) => {
    try {
      const g = await guardar(lado, req)
      if (g.status) return res.status(g.status).json(g.corpo)
      const { d, papel } = g
      const lido = lerMotivo(req.body)
      if (lido.erro) return res.status(400).json({ erro: lido.erro })
      if (d.pedido_vigente) {
        return res.status(409).json({ erro: d.cancelamento_pedido_por === req.usuario.id ? 'Você já pediu o cancelamento. Aguarde a resposta.' : 'A outra parte já pediu o cancelamento: responda ao pedido.', codigo: 'PEDIDO_PENDENTE', pedido_cancelamento: pedidoCancelamento(d, req.usuario.id) })
      }
      const upd = await pool.query(
        `UPDATE ${lado.tabela}
            SET cancelamento_pedido_por = $2, cancelamento_pedido_motivo = $3, cancelamento_pedido_detalhe = $4,
                cancelamento_pedido_em = NOW(), cancelamento_pedido_expira_em = NOW() + ($5::int * INTERVAL '1 hour')
          WHERE id = $1 AND match_usuario_id IS NOT NULL AND a_caminho_em IS NULL AND status = 'aberta'
            AND (cancelamento_pedido_em IS NULL OR cancelamento_pedido_expira_em <= NOW())
          RETURNING cancelamento_pedido_expira_em`,
        [d.id, req.usuario.id, lido.motivo, lido.detalhe, ACORDO_VALIDADE_HORAS]
      )
      if (upd.rowCount === 0) return res.status(409).json({ erro: 'O atendimento mudou. Atualize a tela.', codigo: 'ESTADO_MUDOU' })
      const expiraEm = upd.rows[0].cancelamento_pedido_expira_em
      const outroId = papel === 'dono' ? d.match_usuario_id : d.criado_por
      avisar(outroId, {
        titulo: '🤝 Pedido de cancelamento',
        corpo: `${quemFala(papel, lado)} pediu para cancelar "${d.titulo}" de comum acordo. Motivo: ${textoMotivo(lido.motivo, lido.detalhe)}. Responda no app em até ${ACORDO_VALIDADE_HORAS}h.`,
        data: { tipo: 'pedido_cancelamento', [lado.chave]: d.id, motivo: lido.motivo, por: papel },
        rotulo: `pedido cancelamento ${lado.tipo} ${d.id}`,
      }, { ator: req.usuario.id })
      res.status(201).json({ mensagem: 'Pedido enviado. A outra parte tem 2 horas para responder.', expira_em: expiraEm, pedido_cancelamento: { por: papel, meu: true, motivo: lido.motivo, detalhe: lido.detalhe, expira_em: expiraEm } })
    } catch (err) {
      console.error(`[CancelarMatch] acordo ${tabela} ${req.params.id}:`, err.message)
      res.status(500).json({ erro: 'Erro ao pedir o cancelamento' })
    }
  }

  // POST /:tabela/:id/cancelamento-acordo/responder {aceitar: true|false}
  const responderAcordo = async (req, res) => {
    try {
      const g = await guardar(lado, req)
      if (g.status) return res.status(g.status).json(g.corpo)
      const { d, papel } = g
      if (typeof req.body?.aceitar !== 'boolean') return res.status(400).json({ erro: 'aceitar deve ser true ou false' })
      if (!d.pedido_vigente) return res.status(409).json({ erro: 'Não há pedido de cancelamento pendente', codigo: 'SEM_PEDIDO' })
      if (d.cancelamento_pedido_por === req.usuario.id) return res.status(403).json({ erro: 'Quem pediu o cancelamento não responde ao próprio pedido' })
      const pedidoPor = d.cancelamento_pedido_por
      const papelPedinte = papelDe(d, pedidoPor) || 'profissional'
      if (req.body.aceitar) {
        const r = await executar({ lado, d, canceladoPor: pedidoPor, atorId: req.usuario.id, motivo: d.cancelamento_pedido_motivo, detalhe: d.cancelamento_pedido_detalhe, acordo: true, tardio: false, manterAberta: true })
        if (!r.ok) return res.status(409).json({ erro: 'O atendimento mudou. Atualize a tela.', codigo: 'ESTADO_MUDOU' })
        return res.json({ mensagem: 'Cancelamento aceito. Sem penalidade para ninguém.', acordo: true, demanda_encerrada: r.encerrada })
      }
      const upd = await pool.query(
        `UPDATE ${lado.tabela}
            SET cancelamento_pedido_por = NULL, cancelamento_pedido_motivo = NULL, cancelamento_pedido_detalhe = NULL,
                cancelamento_pedido_em = NULL, cancelamento_pedido_expira_em = NULL
          WHERE id = $1 AND cancelamento_pedido_por = $2 AND cancelamento_pedido_expira_em > NOW()
          RETURNING id`,
        [d.id, pedidoPor]
      )
      if (upd.rowCount === 0) return res.status(409).json({ erro: 'Não há pedido de cancelamento pendente', codigo: 'SEM_PEDIDO' })
      avisar(pedidoPor, {
        titulo: '❌ Pedido de cancelamento recusado',
        corpo: `${quemFala(papel, lado)} não aceitou cancelar "${d.titulo}" de comum acordo. O atendimento continua valendo.`,
        data: { tipo: 'pedido_cancelamento_recusado', [lado.chave]: d.id, por: papel },
        rotulo: `acordo recusado ${lado.tipo} ${d.id}`,
      }, { ator: req.usuario.id })
      void papelPedinte
      res.json({ mensagem: 'Pedido recusado. O atendimento continua.', acordo: false })
    } catch (err) {
      console.error(`[CancelarMatch] responder ${tabela} ${req.params.id}:`, err.message)
      res.status(500).json({ erro: 'Erro ao responder o pedido' })
    }
  }

  return { cancelar, pedirAcordo, responderAcordo }
}

// Cron (5 min): pedidos de acordo vencidos são limpos e quem pediu é avisado. Nunca lança.
const expirarPedidosCancelamento = async () => {
  for (const lado of Object.values(LADOS)) {
    try {
      const r = await pool.query(
        `WITH vencidos AS (
           SELECT id, titulo, cancelamento_pedido_por AS pedinte FROM ${lado.tabela}
            WHERE cancelamento_pedido_em IS NOT NULL AND cancelamento_pedido_expira_em <= NOW()
         ), limpos AS (
           UPDATE ${lado.tabela} d
              SET cancelamento_pedido_por = NULL, cancelamento_pedido_motivo = NULL, cancelamento_pedido_detalhe = NULL,
                  cancelamento_pedido_em = NULL, cancelamento_pedido_expira_em = NULL
             FROM vencidos v WHERE d.id = v.id AND d.cancelamento_pedido_expira_em <= NOW()
            RETURNING d.id
         )
         SELECT v.id, v.titulo, v.pedinte FROM vencidos v JOIN limpos l ON l.id = v.id`
      )
      for (const row of r.rows) {
        if (!row.pedinte) continue
        await avisar(row.pedinte, {
          titulo: '⌛ Pedido de cancelamento expirou',
          corpo: `A outra parte não respondeu ao seu pedido de cancelar "${row.titulo}" em ${ACORDO_VALIDADE_HORAS}h. O atendimento continua valendo.`,
          data: { tipo: 'pedido_cancelamento_expirado', [lado.chave]: row.id },
          rotulo: `acordo expirado ${lado.tipo} ${row.id}`,
        })
      }
      if (r.rows.length > 0) console.log(`[CancelarMatch] ${r.rows.length} pedido(s) de acordo vencido(s) em ${lado.tabela}`)
    } catch (err) {
      console.error(`[CancelarMatch] expirar pedidos ${lado.tabela}:`, err.message)
    }
  }
}

// Cancelamento pelo ADMIN (POST /admin/:tabela/:id/cancelar): qualquer estado. Numa transação,
// a demanda vira 'cancelada' (como DELETE /:tabela/dono/:id) com todo o match/chegada/agenda/
// pedido zerado; se havia match REAL (proposta 'aceito' do profissional casado) ela vira
// 'cancelado' com o id do admin e o motivo, e os DOIS lados recebem push + e-mail. Match órfão
// (match_usuario_id sem proposta aceita) só é limpo. Log com admin e motivo. Devolve
// { status: 404 } ou { status: 200, ... } para a rota responder.
const ADMIN_MOTIVO_MAX = 300
const cancelarPorAdmin = async ({ tabela, id, adminId, motivo }) => {
  const lado = LADOS[tabela]
  if (!lado) throw new Error(`cancelarPorAdmin: lado desconhecido "${tabela}"`)
  if (!UUID_RE.test(String(id))) return { status: 404 }
  const motivoLimpo = typeof motivo === 'string' ? motivo.trim().slice(0, ADMIN_MOTIVO_MAX) || null : null
  const client = await pool.connect()
  let d, matchReal
  try {
    await client.query('BEGIN')
    const r = await client.query(
      `SELECT d.id, d.titulo, d.criado_por, d.match_usuario_id, d.status,
              EXISTS (SELECT 1 FROM ${lado.proposta.tabela} p
                       WHERE p.${lado.proposta.coluna} = d.id AND p.usuario_id = d.match_usuario_id AND p.status = 'aceito') AS match_real
         FROM ${lado.tabela} d WHERE d.id = $1 FOR UPDATE`,
      [id]
    )
    if (r.rows.length === 0) { await client.query('ROLLBACK'); return { status: 404 } }
    d = r.rows[0]
    matchReal = !!d.match_usuario_id && d.match_real
    await client.query(
      `UPDATE ${lado.tabela} SET ${SQL_LIMPAR_MATCH},
              status = 'cancelada', status_aprovacao = 'cancelada', encerrado_em = COALESCE(encerrado_em, NOW())
        WHERE id = $1`,
      [id]
    )
    if (matchReal) {
      await client.query(
        `UPDATE ${lado.proposta.tabela}
            SET status = 'cancelado', cancelado_por = $3, cancelado_motivo = 'outro', cancelado_detalhe = $4,
                cancelado_em = NOW(), cancelado_acordo = false
          WHERE ${lado.proposta.coluna} = $1 AND usuario_id = $2 AND status = 'aceito'`,
        [id, d.match_usuario_id, adminId, motivoLimpo ? `admin: ${motivoLimpo}` : 'admin']
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
  console.log(`[AdminCancelar] ${lado.tipo} ${id} cancelado pelo admin ${adminId}${motivoLimpo ? ` — motivo: ${motivoLimpo}` : ''} (status anterior: ${d.status}; match: ${matchReal ? 'real' : d.match_usuario_id ? 'órfão, limpo' : 'nenhum'})`)
  if (matchReal) {
    const corpo = `A equipe do ProTudo cancelou "${d.titulo}".${motivoLimpo ? ` Motivo: ${motivoLimpo}.` : ''} Dúvidas, fale com o suporte.`
    for (const alvo of [d.criado_por, d.match_usuario_id]) {
      avisar(alvo, {
        titulo: lado.tituloCancelado, corpo,
        data: { tipo: 'match_cancelado', [lado.chave]: id, por: 'admin' },
        rotulo: `admin cancelou ${lado.tipo} ${id}`,
      }, { ator: adminId })
    }
  }
  return { status: 200, status_anterior: d.status, tinha_match: matchReal, match_orfao_limpo: !!d.match_usuario_id && !matchReal, notificados: matchReal ? 2 : 0 }
}

module.exports = {
  MOTIVOS, ROTULO_MOTIVO, ANTECEDENCIA_LIVRE_HORAS, ANTECEDENCIA_LIVRE_FAIXA_CURTA_HORAS, FAIXA_CURTA_HORAS,
  ACORDO_VALIDADE_HORAS, JANELA_CANCELAMENTOS_DIAS, AVISO_CANCELAMENTOS_N, SQL_LIMPAR_MATCH,
  classificar, pedidoCancelamento, handlers, expirarPedidosCancelamento, cancelarPorAdmin,
}
