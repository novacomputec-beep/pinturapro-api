// "Desfazer escolha" (obras e reparos): o DONO desfaz o match com o profissional escolhido
// enquanto nada aconteceu — nenhum horário proposto nem combinado (chegada_pendente_em e
// chegada_prevista_em nulos), sem "Estou a caminho" nem chegada (a_caminho_em,
// chegada_declarada_em, chegada_confirmada_em nulos), demanda 'aberta' — e só depois de uma
// ESPERA contada do match: 10% do que faltava do match até o prazo (a MESMA referência de
// repetirLembreteAgendar: COALESCE(chegada_prevista_em, expira_em)), no mínimo 1h e no máximo
// 48h. Antes disso a rota responde 409 AGUARDE com liberado_em; o mesmo instante sai em GET
// /:tabela/:id como desfazer_liberado_em (só para o dono; null quando não se aplica).
//
// UMA transação com a linha da demanda travada (SELECT … FOR UPDATE): toda guarda é lida na
// linha travada, então uma proposta de horário do profissional que chegue no meio faz o pedido
// abortar com 409 HORARIO_EM_NEGOCIACAO (ou ESTADO_MUDOU) — nada é desfeito pela metade.
// Efeitos, na mesma transação:
//   - match, chegada, agenda e pedido de acordo zerados (SQL_LIMPAR_MATCH, a mesma lista do
//     cancelamento) — isso também cala os lembretes "Agende seu atendimento"; a demanda volta
//     ao feed 'aberta' com o prazo que restava (piso de 1h);
//   - o profissional entra em prestadores_bloqueados (não vê mais ESTA demanda no feed) e a sua
//     proposta vira 'cancelado' com motivo 'escolha_desfeita' (a linha continua existindo, então
//     o POST de interesse/candidatura responde 409 "já demonstrou interesse" — ele nunca volta);
//   - 1 falta em faltas_profissional com motivo "não marcou horário" (alertaService.inserirFalta);
//     a contagem/suspensão (3 em 90 dias) roda depois do commit (avaliarSuspensaoPorFaltas);
//   - as propostas rebaixadas a 'recusado' PELO MATCH (status_antes_match, utils/
//     rejeitarConcorrentes) voltam ao status que tinham; as já pendentes seguem como estão.
//     Recusa explícita do dono antes do match fica recusada.
// Depois do commit (push + e-mail, cota crítica 'aviso:', nunca lançam): ao profissional, a
// cada interessado que segue valendo e ao dono (com o nº de interessados avisados). Motivo
// 'escolha_desfeita' fica fora da contagem de cancelamentos frequentes (cancelamentoMatchService).
const { pool } = require('../utils/supabase')
const { formatarDataHoraSP } = require('../utils/agendamento')
const { SQL_LIMPAR_MATCH } = require('./cancelamentoMatchService')
const { entregarPushEEmail, inserirFaltaUnica, avaliarSuspensaoPorFaltas, MOTIVO_FALTA_SEM_HORARIO } = require('./alertaService')

const ESPERA_FRACAO = 0.10
const ESPERA_MIN = '1 hour'
const ESPERA_MAX = '48 hours'
const PISO_PRAZO_RESTANTE = '1 hour'
const MOTIVO_ESCOLHA_DESFEITA = 'escolha_desfeita'
const MOTIVO_FALTA = MOTIVO_FALTA_SEM_HORARIO // 'não marcou horário' — o mesmo do cronômetro
const STATUS_VALENDO = ['pendente', 'contraproposta_dono']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const LADOS = {
  obras:   { tabela: 'obras',   tipo: 'obra',   chave: 'obra_id',   proposta: { tabela: 'candidaturas',      coluna: 'obra_id' },   artigo: 'A obra',    naoEncontrada: 'Obra não encontrada',    tipoPushProfissional: 'candidatura_recusada', tipoPushInteressado: 'nova_obra',    tipoPushDono: 'nova_candidatura' },
  reparos: { tabela: 'reparos', tipo: 'reparo', chave: 'reparo_id', proposta: { tabela: 'interesse_reparos', coluna: 'reparo_id' }, artigo: 'O serviço', naoEncontrada: 'Serviço não encontrado', tipoPushProfissional: 'interesse_recusado',   tipoPushInteressado: 'novo_reparo',  tipoPushDono: 'novo_interesse' },
}

// p = prefixo da tabela ('' ou 'o.'). Espera = 10% de (prazo − match), entre 1h e 48h.
const sqlEspera = (p = '') =>
  `LEAST(INTERVAL '${ESPERA_MAX}', GREATEST(INTERVAL '${ESPERA_MIN}', (COALESCE(${p}chegada_prevista_em, ${p}expira_em) - ${p}match_feito_em) * ${ESPERA_FRACAO}))`
// Condições em que desfazer se aplica (fora a espera): sem isso, NULL.
const sqlPodeDesfazer = (p = '') =>
  `(${p}status = 'aberta' AND ${p}match_usuario_id IS NOT NULL AND ${p}match_feito_em IS NOT NULL
    AND ${p}chegada_pendente_em IS NULL AND ${p}chegada_prevista_em IS NULL
    AND ${p}a_caminho_em IS NULL AND ${p}chegada_declarada_em IS NULL AND ${p}chegada_confirmada_em IS NULL)`
// desfazer_liberado_em de GET /:tabela/:id (e da rota): match_feito_em + espera, ou NULL.
const sqlDesfazerLiberadoEm = (p = '') =>
  `(CASE WHEN ${sqlPodeDesfazer(p)} THEN ${p}match_feito_em + ${sqlEspera(p)} ELSE NULL END)`

const contatos = async (ids) => {
  if (!ids.length) return []
  const r = await pool.query(`SELECT id AS usuario_id, push_token, email, nome FROM usuarios WHERE id = ANY($1::uuid[])`, [ids])
  return r.rows
}
const avisar = async (u, aviso) => {
  try { return await entregarPushEEmail({ ...u, ...aviso }) } catch (err) { console.error(`[DesfazerEscolha] aviso ${aviso.rotulo}:`, err.message); return 'falha' }
}

// Guardas sobre a linha (já travada). Devolve null para seguir ou { status, corpo }.
const recusa = (lado, d, usuarioId) => {
  if (d.criado_por !== usuarioId) return { status: 403, corpo: { erro: 'Só o cliente pode desfazer a escolha' } }
  if (d.status !== 'aberta') return { status: 409, corpo: { erro: `${lado.artigo} não está mais em andamento`, codigo: 'DEMANDA_FECHADA' } }
  if (!d.match_usuario_id || !d.match_feito_em) return { status: 409, corpo: { erro: 'Não há profissional escolhido para desfazer', codigo: 'SEM_MATCH' } }
  if (d.a_caminho_em || d.chegada_declarada_em || d.chegada_confirmada_em) {
    return { status: 409, corpo: { erro: 'O profissional já está a caminho ou chegou: não dá mais para desfazer a escolha.', codigo: 'A_CAMINHO' } }
  }
  if (d.chegada_pendente_em || d.chegada_prevista_em) {
    return { status: 409, corpo: { erro: 'O profissional já propôs ou combinou um horário. Para sair do atendimento, use o cancelamento.', codigo: 'HORARIO_EM_NEGOCIACAO' } }
  }
  if (!d.liberado_em) return { status: 409, corpo: { erro: 'Não é possível desfazer a escolha agora', codigo: 'ESTADO_MUDOU' } }
  if (new Date(d.agora) < new Date(d.liberado_em)) {
    return { status: 409, corpo: { erro: `Dê um tempo ao profissional: você pode desfazer a escolha a partir de ${formatarDataHoraSP(d.liberado_em)}.`, codigo: 'AGUARDE', liberado_em: d.liberado_em } }
  }
  return null
}

// POST /:tabela/dono/:id/desfazer-match — só o dono.
const handler = (tabela) => {
  const lado = LADOS[tabela]
  if (!lado) throw new Error(`desfazerEscolhaService: lado desconhecido "${tabela}"`)
  return async (req, res) => {
    const id = String(req.params.id)
    if (!UUID_RE.test(id)) return res.status(404).json({ erro: lado.naoEncontrada })
    let client
    let d, profissionalId, interessados
    try {
      client = await pool.connect()
      await client.query('BEGIN')
      const r = await client.query(
        `SELECT id, titulo, criado_por, match_usuario_id, match_feito_em, status, a_caminho_em,
                chegada_pendente_em, chegada_prevista_em, chegada_declarada_em, chegada_confirmada_em,
                ${sqlDesfazerLiberadoEm()} AS liberado_em, NOW() AS agora
           FROM ${lado.tabela} WHERE id = $1 FOR UPDATE`,
        [id]
      )
      d = r.rows[0]
      if (!d) { await client.query('ROLLBACK'); return res.status(404).json({ erro: lado.naoEncontrada }) }
      const neg = recusa(lado, d, req.usuario.id)
      if (neg) { await client.query('ROLLBACK'); return res.status(neg.status).json(neg.corpo) }
      profissionalId = d.match_usuario_id

      // A linha está travada, mas o WHERE repete as condições (inclusive a espera pelo relógio
      // do banco): se algo mudou entre o SELECT e aqui, nada é alterado e o pedido aborta.
      const upd = await client.query(
        `UPDATE ${lado.tabela} SET ${SQL_LIMPAR_MATCH},
                expira_em = GREATEST(expira_em, NOW() + INTERVAL '${PISO_PRAZO_RESTANTE}'),
                prestadores_bloqueados = CASE WHEN $2::uuid = ANY(COALESCE(prestadores_bloqueados, '{}'))
                                              THEN prestadores_bloqueados
                                              ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid) END
          WHERE id = $1 AND match_usuario_id = $2 AND ${sqlPodeDesfazer()}
            AND NOW() >= match_feito_em + ${sqlEspera()}
          RETURNING id`,
        [d.id, profissionalId]
      )
      if (upd.rows.length === 0) { await client.query('ROLLBACK'); return res.status(409).json({ erro: 'O atendimento mudou. Atualize a tela.', codigo: 'ESTADO_MUDOU' }) }
      await client.query(
        `UPDATE ${lado.proposta.tabela}
            SET status = 'cancelado', cancelado_por = $3, cancelado_motivo = $4, cancelado_detalhe = NULL,
                cancelado_em = NOW(), cancelado_acordo = false, status_antes_match = NULL
          WHERE ${lado.proposta.coluna} = $1 AND usuario_id = $2 AND status = 'aceito'`,
        [d.id, profissionalId, req.usuario.id, MOTIVO_ESCOLHA_DESFEITA]
      )
      // Propostas rebaixadas PELO MATCH voltam ao status que tinham.
      await client.query(
        `UPDATE ${lado.proposta.tabela}
            SET status = status_antes_match, status_antes_match = NULL
          WHERE ${lado.proposta.coluna} = $1 AND usuario_id <> $2 AND status = 'recusado' AND status_antes_match IS NOT NULL`,
        [d.id, profissionalId]
      )
      interessados = (await client.query(
        `SELECT DISTINCT usuario_id FROM ${lado.proposta.tabela}
          WHERE ${lado.proposta.coluna} = $1 AND usuario_id <> $2 AND status = ANY($3::text[])`,
        [d.id, profissionalId, STATUS_VALENDO]
      )).rows.map(x => x.usuario_id)
      await inserirFaltaUnica(client, lado.tabela, d.id, profissionalId, MOTIVO_FALTA) // única por (profissional, demanda)
      await client.query('COMMIT')
    } catch (err) {
      if (client) { try { await client.query('ROLLBACK') } catch {} }
      console.error(`[DesfazerEscolha] ${tabela} ${req.params.id}:`, err.message)
      return res.status(500).json({ erro: 'Erro ao desfazer a escolha' })
    } finally {
      if (client) client.release()
    }
    console.log(`[DesfazerEscolha] ${lado.tipo} ${d.id}: dono ${req.usuario.id} desfez a escolha de ${profissionalId} (falta registrada; ${interessados.length} interessado(s) seguem valendo)`)
    res.json({ mensagem: `Escolha desfeita. ${lado.artigo} voltou ao feed.`, profissional_id: profissionalId, interessados_avisados: interessados.length })

    // Fora da transação e depois da resposta. Ordem: suspensão (pode mandar "Conta suspensa"),
    // profissional, interessados, dono. ator_id só no aviso ao profissional e aos interessados
    // (o dono é o autor e PRECISA receber o dele).
    ;(async () => {
      await avaliarSuspensaoPorFaltas(profissionalId)
      const [prof] = await contatos([profissionalId])
      if (prof) {
        await avisar(prof, {
          ator_id: req.usuario.id,
          titulo: `Você saiu do serviço "${d.titulo}"`,
          corpo: 'Você não marcou dia e horário a tempo e o cliente desfez a escolha. Isso contou como 1 falta.',
          data: { tipo: lado.tipoPushProfissional, [lado.chave]: d.id, motivo: MOTIVO_ESCOLHA_DESFEITA },
          rotulo: `escolha desfeita ${lado.tipo} ${d.id} profissional`,
        })
      }
      for (const u of await contatos(interessados)) {
        await avisar(u, {
          ator_id: req.usuario.id,
          titulo: `O pedido "${d.titulo}" reabriu`,
          corpo: 'O profissional escolhido não marcou o horário. Seu interesse continua valendo e o cliente vai escolher de novo. Ainda não há escolhido.',
          data: { tipo: lado.tipoPushInteressado, [lado.chave]: d.id, reaberta: true },
          rotulo: `escolha desfeita ${lado.tipo} ${d.id} interessado`,
        })
      }
      const [dono] = await contatos([d.criado_por])
      if (dono) {
        await avisar(dono, {
          titulo: 'Pedido reaberto',
          corpo: `Avisamos os ${interessados.length} interessados. Escolha o novo profissional quando quiser.`,
          data: { tipo: lado.tipoPushDono, [lado.chave]: d.id, reaberta: true },
          rotulo: `escolha desfeita ${lado.tipo} ${d.id} dono`,
        })
      }
    })().catch(err => console.error(`[DesfazerEscolha] avisos ${lado.tipo} ${d.id}:`, err.message))
  }
}

module.exports = { ESPERA_FRACAO, ESPERA_MIN, ESPERA_MAX, MOTIVO_ESCOLHA_DESFEITA, MOTIVO_FALTA, sqlEspera, sqlDesfazerLiberadoEm, handler }
