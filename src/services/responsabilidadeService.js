// Responsabilidade pós-match — regras e colunas em utils/responsabilidade. Aqui: gravar os
// eventos, a compensação ao profissional, o aviso final ao dono, o bloqueio de pedidos novos e a
// lista do painel.
//
//   registrarCompromissoNaoCumprido(client, …) — DENTRO da transação do un-match
//       (desfazerEscolhaService, modos 'desfazer' e 'escolher_outro'); idempotente (índice único).
//   registrarClienteNaoRespondeu(…)            — depois do claim de expirarPropostasDeHorario
//       (alertaService), só quando a proposta vencida era do PROFISSIONAL. Grava o evento (com
//       bloqueio_ate do 2º evento da pessoa na janela em diante), credita CREDITO_DIAS_COMPENSACAO
//       dias ao profissional, aplica na hora se a assinatura dele é paga e ativa (senão fica
//       guardado) e avisa o profissional por push. Nunca lança.
//   aplicarCreditosPendentes                   — cron: aplica o crédito guardado de quem passou a
//       ter assinatura paga e ativa (fim da janela de lançamento, pagamento, aprovação).
//   avisarRespostaFinalDono                    — cron (1 min): AVISO_FINAL_ANTES_MIN antes da
//       proposta do profissional vencer, push + E-MAIL ao dono (uma vez por proposta —
//       aviso_resposta_final_em, zerado a cada proposta junto dos lembretes de resposta).
//   bloqueioDePedidos(usuarioId)               — { liberado_em } quando a pessoa do dono está
//       bloqueada para criar demanda nova; null quando não (POST /obras/dono, /reparos/dono).
//   listarEventosAdmin                         — GET /admin/eventos-responsabilidade (painel).
const { pool } = require('../utils/supabase')
const { sqlContasDaPessoa } = require('../utils/tipoConta')
const {
  JANELA_DIAS, EVENTOS_PARA_BLOQUEIO, BLOQUEIO_PEDIDOS_DIAS, CREDITO_DIAS_COMPENSACAO, TIPOS_EVENTO,
  MOTIVO_PROPOSTA_VENCIDA, AVISO_FINAL_ANTES_MIN, sqlPedidosLiberadoEm, sqlAplicarCreditoPendente,
} = require('../utils/responsabilidade')

// alertaService exige este módulo de forma tardia (dentro do job); aqui o inverso também é
// tardio, para nenhum dos dois ver o `exports` do outro pela metade no boot.
const alerta = () => require('./alertaService')

const LADOS = {
  obras:   { tabela: 'obras',   chave: 'obra_id',   tipoPushProfissional: 'nova_obra' },
  reparos: { tabela: 'reparos', chave: 'reparo_id', tipoPushProfissional: 'novo_reparo' },
}
const CHAVE = { obras: 'obra_id', reparos: 'reparo_id' }

const TITULO_AVISO_FINAL = '⚠️ Última chance de responder o horário'
const corpoAvisoFinal = (nomeProfissional) => {
  const nome = String(nomeProfissional || '').trim().split(/\s+/)[0] || 'O profissional'
  return `${nome} reservou a agenda para você. Responda ou cancele o pedido — se ignorar, sua conta fica marcada.`
}
const TITULO_CREDITO = '🎁 Você recebeu 7 dias grátis pelo cliente que não respondeu'
const corpoCredito = (aplicado) => aplicado
  ? `Sua assinatura ganhou ${CREDITO_DIAS_COMPENSACAO} dias, sem cobrança: agora vale até ${formatarData(aplicado.proximo_vencimento)}.`
  : `Os ${CREDITO_DIAS_COMPENSACAO} dias ficam guardados e entram na sua assinatura quando a cobrança começar.`
const formatarData = (d) => {
  try { return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) } catch { return String(d) }
}
const ERRO_PEDIDOS_BLOQUEADOS = `Seus pedidos novos estão bloqueados por ${BLOQUEIO_PEDIDOS_DIAS} dias: duas vezes em ${JANELA_DIAS} dias um profissional reservou a agenda e o horário venceu sem resposta. Os pedidos já abertos continuam valendo.`

// Evento do PROFISSIONAL — na transação do un-match. Devolve true quando gravou (false = já havia).
const registrarCompromissoNaoCumprido = async (client, { tabela, demandaId, profissionalId, donoId, motivo }) => {
  if (!LADOS[tabela]) throw new Error(`responsabilidadeService: tabela desconhecida "${tabela}"`)
  const r = await client.query(
    `INSERT INTO eventos_responsabilidade (tipo_evento, usuario_id, outro_usuario_id, tabela, demanda_id, motivo)
     VALUES ('compromisso_nao_cumprido', $1, $2, $3, $4, $5)
     ON CONFLICT (tabela, demanda_id, usuario_id) WHERE tipo_evento = 'compromisso_nao_cumprido' DO NOTHING
     RETURNING id`,
    [profissionalId, donoId || null, tabela, demandaId, motivo || null])
  return r.rows.length > 0
}

// Crédito pendente → vencimento, de UMA conta. Devolve a linha aplicada ou null (nada pendente
// ou assinatura não paga/ativa). Marca credito_aplicado_em nos eventos ainda não aplicados.
const aplicarCreditoCompensacao = async (usuarioId, db = pool) => {
  if (!usuarioId) return null
  const r = await db.query(sqlAplicarCreditoPendente('a.usuario_id = $1'), [usuarioId])
  const aplicado = r.rows[0] || null
  if (aplicado) {
    await db.query(
      `UPDATE eventos_responsabilidade SET credito_aplicado_em = NOW()
        WHERE outro_usuario_id = $1 AND tipo_evento = 'cliente_nao_respondeu' AND credito_dias > 0 AND credito_aplicado_em IS NULL`,
      [usuarioId])
  }
  return aplicado
}

// Evento do DONO (proposta do profissional vencida) + compensação. Nunca lança.
const registrarClienteNaoRespondeu = async ({ tabela, demandaId, donoId, profissionalId, titulo }) => {
  const lado = LADOS[tabela]
  if (!lado || !donoId || !demandaId) return null
  let evento = null
  try {
    // bloqueio_ate só do EVENTOS_PARA_BLOQUEIO-ésimo evento da PESSOA na janela em diante (os
    // anteriores contam, inclusive os das contas irmãs contratantes). Um statement: a contagem e
    // o INSERT andam juntos.
    const ins = await pool.query(
      `INSERT INTO eventos_responsabilidade (tipo_evento, usuario_id, outro_usuario_id, tabela, demanda_id, motivo, bloqueio_ate, credito_dias)
       SELECT 'cliente_nao_respondeu', $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text,
              CASE WHEN (SELECT COUNT(*) FROM eventos_responsabilidade ev
                          WHERE ev.tipo_evento = 'cliente_nao_respondeu'
                            AND ev.criado_em > NOW() - INTERVAL '${JANELA_DIAS} days'
                            AND ev.usuario_id IN (${sqlContasDaPessoa('$1')})) + 1 >= $6::int
                   THEN NOW() + ($7::int * INTERVAL '1 day') END,
              CASE WHEN $2::uuid IS NULL THEN 0 ELSE $8::int END
       RETURNING id, bloqueio_ate, credito_dias, criado_em`,
      [donoId, profissionalId || null, tabela, demandaId, MOTIVO_PROPOSTA_VENCIDA, EVENTOS_PARA_BLOQUEIO, BLOQUEIO_PEDIDOS_DIAS, CREDITO_DIAS_COMPENSACAO])
    evento = ins.rows[0]
    console.log(`[Responsabilidade] cliente_nao_respondeu ${tabela} ${demandaId}: dono ${donoId}${evento.bloqueio_ate ? ` BLOQUEADO até ${new Date(evento.bloqueio_ate).toISOString()}` : ' (1º evento: só marca)'}`)
  } catch (err) {
    console.error(`[Responsabilidade] evento cliente_nao_respondeu ${tabela} ${demandaId}:`, err.message)
    return null
  }
  if (!profissionalId || evento.credito_dias === 0) return evento
  try {
    // O crédito é do profissional (conta do match) e não cria cobrança nenhuma: só soma dias
    // ao TOTAL creditado; a aplicação ao vencimento é o UPDATE de utils/responsabilidade.
    await pool.query(`UPDATE usuarios SET dias_credito_compensacao = dias_credito_compensacao + $2 WHERE id = $1`, [profissionalId, evento.credito_dias])
    const aplicado = await aplicarCreditoCompensacao(profissionalId)
    console.log(`[Responsabilidade] crédito de ${evento.credito_dias} dias ao profissional ${profissionalId}: ${aplicado ? `aplicado, vence ${new Date(aplicado.proximo_vencimento).toISOString()}` : 'guardado (assinatura não paga/ativa)'}`)
    const { contatoDaPessoa, enviarPushNotificacao } = alerta()
    const contato = await contatoDaPessoa(profissionalId)
    if (contato?.push_token) {
      await enviarPushNotificacao(contato.push_token, TITULO_CREDITO, corpoCredito(aplicado),
        { tipo: 'chegada_prevista_recusada', [lado.chave]: demandaId, compensacao: true, dias: evento.credito_dias, aplicado: !!aplicado }, profissionalId)
    }
  } catch (err) {
    console.error(`[Responsabilidade] compensação ao profissional ${profissionalId}:`, err.message)
  }
  return evento
}

// Cron: crédito guardado de quem passou a ter assinatura paga e ativa. Nunca lança.
const aplicarCreditosPendentes = async () => {
  try {
    const r = await pool.query(sqlAplicarCreditoPendente())
    for (const a of r.rows) {
      await pool.query(
        `UPDATE eventos_responsabilidade SET credito_aplicado_em = NOW()
          WHERE outro_usuario_id = $1 AND tipo_evento = 'cliente_nao_respondeu' AND credito_dias > 0 AND credito_aplicado_em IS NULL`,
        [a.usuario_id])
      console.log(`[Responsabilidade] crédito pendente aplicado a ${a.usuario_id}: vence ${new Date(a.proximo_vencimento).toISOString()}`)
    }
    return r.rows.length
  } catch (err) {
    console.error('[Responsabilidade] aplicarCreditosPendentes:', err.message)
    return 0
  }
}

// Cron (1 min): aviso final ao DONO, AVISO_FINAL_ANTES_MIN antes da proposta do PROFISSIONAL
// vencer (chegada_pendente_em), enquanto ela ainda não venceu. Claim atômico em
// aviso_resposta_final_em; push + e-mail (evento crítico: é a última chance antes da marca).
// Guarda de autor (ator = profissional): dono e profissional na mesma conta não recebem.
const sqlClaimAvisoFinal = (tabela) => `
      UPDATE ${tabela} d SET aviso_resposta_final_em = NOW()
        FROM usuarios u, usuarios p
       WHERE d.status = 'aberta' AND d.match_usuario_id IS NOT NULL
         AND d.chegada_pendente_em IS NOT NULL AND d.chegada_proposta_em IS NOT NULL
         AND COALESCE(d.chegada_proposta_por, d.match_usuario_id) = d.match_usuario_id
         AND d.chegada_prevista_em IS NULL AND d.a_caminho_em IS NULL
         AND u.id = d.criado_por AND p.id = d.match_usuario_id
         AND d.aviso_resposta_final_em IS NULL
         AND NOW() >= d.chegada_pendente_em - INTERVAL '${AVISO_FINAL_ANTES_MIN} minutes'
         AND NOW() < d.chegada_pendente_em
   RETURNING d.id, d.titulo, d.criado_por, d.match_usuario_id, d.chegada_pendente_em,
             u.push_token, u.email, u.nome, p.nome AS nome_profissional`
const avisarRespostaFinalDono = async () => {
  for (const lado of Object.values(LADOS)) {
    try {
      const claim = await pool.query(sqlClaimAvisoFinal(lado.tabela))
      for (const d of claim.rows) {
        try {
          const via = await alerta().entregarPushEEmail({
            usuario_id: d.criado_por, ator_id: d.match_usuario_id,
            push_token: d.push_token, email: d.email, nome: d.nome,
            titulo: TITULO_AVISO_FINAL, corpo: corpoAvisoFinal(d.nome_profissional),
            data: { tipo: 'chegada_prevista_pendente', [lado.chave]: d.id, aviso_final: true },
            rotulo: `aviso final resposta ${lado.tabela} ${d.id}`,
          })
          console.log(`[AvisoFinal] ${lado.tabela} ${d.id} → dono ${d.criado_por} via ${via}`)
        } catch (err) {
          console.error(`[AvisoFinal] ${lado.tabela} ${d.id}:`, err.message)
        }
      }
    } catch (err) {
      console.error(`[AvisoFinal] erro em ${lado.tabela}:`, err.message)
    }
  }
}

// Bloqueio de pedidos novos da PESSOA do dono: { liberado_em } ou null.
const bloqueioDePedidos = async (usuarioId, db = pool) => {
  if (!usuarioId) return null
  const r = await db.query(`SELECT ${sqlPedidosLiberadoEm('$1')} AS liberado_em`, [usuarioId])
  const liberado_em = r.rows[0]?.liberado_em || null
  return liberado_em ? { liberado_em } : null
}
const corpoPedidosBloqueados = (bloqueio) => ({ erro: ERRO_PEDIDOS_BLOQUEADOS, codigo: 'PEDIDOS_BLOQUEADOS', liberado_em: bloqueio.liberado_em, dias: BLOQUEIO_PEDIDOS_DIAS })

// GET /admin/eventos-responsabilidade?tipo=&usuario_id=&page=&limit= — painel. Lista com nomes
// das duas partes, título da demanda e, no cliente_nao_respondeu, bloqueio e crédito.
const listarEventosAdmin = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50))
    const offset = (page - 1) * limit
    const tipo = TIPOS_EVENTO.includes(req.query.tipo) ? req.query.tipo : null
    const usuarioId = /^[0-9a-f-]{36}$/i.test(String(req.query.usuario_id || '')) ? req.query.usuario_id : null
    const params = [limit, offset]
    const where = []
    if (tipo) { params.push(tipo); where.push(`ev.tipo_evento = $${params.length}`) }
    if (usuarioId) { params.push(usuarioId); where.push(`(ev.usuario_id = $${params.length} OR ev.outro_usuario_id = $${params.length})`) }
    const r = await pool.query(
      `SELECT ev.id, ev.tipo_evento, ev.tabela, ev.demanda_id, ev.motivo, ev.criado_em,
              ev.bloqueio_ate, ev.credito_dias, ev.credito_aplicado_em,
              ev.usuario_id, u.nome AS usuario_nome, u.email AS usuario_email, u.role AS usuario_role,
              ev.outro_usuario_id, o.nome AS outro_nome, o.email AS outro_email,
              COALESCE((SELECT titulo FROM obras WHERE ev.tabela = 'obras' AND id = ev.demanda_id),
                       (SELECT titulo FROM reparos WHERE ev.tabela = 'reparos' AND id = ev.demanda_id)) AS demanda_titulo,
              (SELECT COUNT(*)::int FROM eventos_responsabilidade e2
                WHERE e2.tipo_evento = ev.tipo_evento AND e2.usuario_id = ev.usuario_id
                  AND e2.criado_em > NOW() - INTERVAL '${JANELA_DIAS} days') AS eventos_90d_conta,
              COUNT(*) OVER()::int AS total
         FROM eventos_responsabilidade ev
         LEFT JOIN usuarios u ON u.id = ev.usuario_id
         LEFT JOIN usuarios o ON o.id = ev.outro_usuario_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ev.criado_em DESC
        LIMIT $1 OFFSET $2`, params)
    const total = r.rows[0]?.total ?? 0
    res.json({ eventos: r.rows.map(({ total: _t, ...e }) => e), page, limit, total, janela_dias: JANELA_DIAS })
  } catch (err) {
    console.error('[Responsabilidade] GET /admin/eventos-responsabilidade:', err.message)
    res.status(500).json({ erro: 'Erro ao listar eventos' })
  }
}

module.exports = {
  registrarCompromissoNaoCumprido, registrarClienteNaoRespondeu, aplicarCreditoCompensacao, aplicarCreditosPendentes,
  avisarRespostaFinalDono, bloqueioDePedidos, corpoPedidosBloqueados, listarEventosAdmin,
  TITULO_AVISO_FINAL, corpoAvisoFinal, TITULO_CREDITO, ERRO_PEDIDOS_BLOQUEADOS, CHAVE,
}
