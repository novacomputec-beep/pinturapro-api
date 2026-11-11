// "Desfazer escolha" (obras e reparos): o DONO desfaz o match com o profissional escolhido
// enquanto nada aconteceu — nenhum horário proposto nem combinado (chegada_pendente_em e
// chegada_prevista_em nulos), sem "Estou a caminho" nem chegada (a_caminho_em,
// chegada_declarada_em, chegada_confirmada_em nulos), demanda 'aberta' — e só quando o que
// RESTA do prazo é ≤ 25% do que havia do match até o prazo (LIBERA_FRACAO_RESTANTE): libera em
// match_feito_em + 75% de (expira_em − match_feito_em). Regra do dono (06/11/2026), no lugar da
// espera de 10% (1h–48h). Como nenhum horário pode ter sido proposto, o prazo é expira_em.
// Antes disso a rota responde 409 AGUARDE com liberado_em; o mesmo instante sai em GET
// /:tabela/:id como desfazer_liberado_em (só para o dono; null quando não se aplica), junto de
// lembretes_agendar_enviados e proximo_lembrete_agendar_em (alertaService.sqlProximoLembreteAgendar).
// Quando libera, avisarDesfazerLiberado (cron de 1 min) manda ao dono push + e-mail "Falta pouco
// e <Nome> ainda não marcou o horário…" UMA vez por match (claim desfazer_aviso_em, zerado em
// SQL_ZERAR_AGENDA), só enquanto o prazo não venceu e as condições acima seguem valendo.
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
//
// "ESCOLHER OUTRO" (dono, 10/11/2026) — o MESMO caminho, em outro modo (handler(tabela,
// 'escolher_outro'), POST /:tabela/dono/:id/escolher-outro): libera quando o escolhido deixou
// LEMBRETES_PARA_ESCOLHER_OUTRO (2) lembretes "Agende" SEGUIDOS sem propor horário
// (lembrete_agendar_sem_proposta, contado em alertaService e zerado na proposta), sem esperar os
// 75% do prazo; sai em GET /:id como pode_escolher_outro (só dono). Diferenças: motivo
// 'escolheu_outro' na proposta cancelada (também fora da contagem de cancelamentos frequentes) e
// o aviso ao profissional "O cliente escolheu outro profissional". O resto é igual: match zerado,
// demanda de volta ao feed com candidaturas, interesses, perguntas e respostas intactos,
// profissional bloqueado nesta demanda. 409 ESCOLHER_OUTRO_INDISPONIVEL quando pode_escolher_outro é false.
//
// RESPONSABILIDADE (dono, 10/11/2026 — utils/responsabilidade): nos DOIS modos o profissional
// que ignorou os lembretes "Agende" leva a falta de sempre (faltas_profissional + suspensão por
// faltas) E um evento compromisso_nao_cumprido (contado por pessoa, 90 dias; sai ao dono nas
// candidaturas/interesses como compromissos_nao_cumpridos_90d / cumpriu_todos). O 1º lembrete
// "Agende" já avisa: desistir pelo "Não vou conseguir" antes do horário é sem penalidade.
const { pool } = require('../utils/supabase')
const { registrarCompromissoNaoCumprido } = require('./responsabilidadeService')
const { formatarDataHoraSP } = require('../utils/agendamento')
const { SQL_LIMPAR_MATCH } = require('./cancelamentoMatchService')
// Restauração das propostas rebaixadas pelo match — regra única de utils/reaberturaMatch.
const { restaurarPropostasRebaixadas } = require('../utils/reaberturaMatch')
const { entregarPushEEmail, inserirFaltaUnica, avaliarSuspensaoPorFaltas, MOTIVO_FALTA_SEM_HORARIO, semSobreposicao, contatoDaPessoa } = require('./alertaService')
const { ehMesmaPessoa } = require('../utils/tipoConta')

// Fração do intervalo match→prazo que ainda pode restar quando o desfazer libera.
const LIBERA_FRACAO_RESTANTE = 0.25
const PISO_PRAZO_RESTANTE = '1 hour'
const MOTIVO_ESCOLHA_DESFEITA = 'escolha_desfeita'
const MOTIVO_ESCOLHEU_OUTRO = 'escolheu_outro'
const LEMBRETES_PARA_ESCOLHER_OUTRO = 2
const MODOS = ['desfazer', 'escolher_outro']
const MOTIVO_FALTA = MOTIVO_FALTA_SEM_HORARIO // 'não marcou horário' — o mesmo do cronômetro
const STATUS_VALENDO = ['pendente', 'contraproposta_dono']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const LADOS = {
  obras:   { tabela: 'obras',   tipo: 'obra',   chave: 'obra_id',   proposta: { tabela: 'candidaturas',      coluna: 'obra_id' },   artigo: 'A obra',    naoEncontrada: 'Obra não encontrada',    tipoPushProfissional: 'candidatura_recusada', tipoPushInteressado: 'nova_obra',    tipoPushDono: 'nova_candidatura' },
  reparos: { tabela: 'reparos', tipo: 'reparo', chave: 'reparo_id', proposta: { tabela: 'interesse_reparos', coluna: 'reparo_id' }, artigo: 'O serviço', naoEncontrada: 'Serviço não encontrado', tipoPushProfissional: 'interesse_recusado',   tipoPushInteressado: 'novo_reparo',  tipoPushDono: 'novo_interesse' },
}

// p = prefixo da tabela ('' ou 'o.'). Espera = 75% de (expira_em − match): libera quando resta
// ≤ 25%. Prazo já vencido no match (expira_em ≤ match_feito_em): espera ≤ 0, libera na hora.
const sqlEspera = (p = '') =>
  `((${p}expira_em - ${p}match_feito_em) * ${1 - LIBERA_FRACAO_RESTANTE})`
// Condições em que desfazer se aplica (fora a espera): sem isso, NULL.
const sqlPodeDesfazer = (p = '') =>
  `(${p}status = 'aberta' AND ${p}match_usuario_id IS NOT NULL AND ${p}match_feito_em IS NOT NULL
    AND ${p}chegada_pendente_em IS NULL AND ${p}chegada_prevista_em IS NULL
    AND ${p}a_caminho_em IS NULL AND ${p}chegada_declarada_em IS NULL AND ${p}chegada_confirmada_em IS NULL)`
// O escolhido DESINSTALOU o app (usuarios.desinstalado_em, marcado pelo recibo DeviceNotRegistered —
// utils/desinstalacoes). Volta a false sozinho quando ele reinstala (registrarReinstalacao limpa).
const sqlEscolhidoDesinstalou = (p = '') =>
  `EXISTS (SELECT 1 FROM usuarios pd WHERE pd.id = ${p}match_usuario_id AND pd.desinstalado_em IS NOT NULL)`
// pode_escolher_outro de GET /:tabela/:id (e da rota): as mesmas condições do desfazer + 2
// lembretes "Agende" seguidos sem proposta OU (dono, 11/11/2026) o escolhido desinstalou o app.
// Booleano (false quando não se aplica).
const sqlPodeEscolherOutro = (p = '') =>
  `COALESCE(${sqlPodeDesfazer(p)} AND (${p}lembrete_agendar_sem_proposta >= ${LEMBRETES_PARA_ESCOLHER_OUTRO} OR ${sqlEscolhidoDesinstalou(p)}), false)`
// motivo_escolher_outro de GET /:tabela/:id (só dono): por que pode_escolher_outro está true —
// 'desinstalou' (sem falta nem evento para o profissional: ele não vê os avisos) ou
// 'avisos_ignorados' (a regra dos 2 lembretes, com falta + compromisso_nao_cumprido). Com os dois ao
// mesmo tempo vale 'desinstalou' — quem desinstalou não recebeu os lembretes. NULL quando false.
const MOTIVO_ESCOLHER_OUTRO_DESINSTALOU = 'desinstalou'
const MOTIVO_ESCOLHER_OUTRO_AVISOS = 'avisos_ignorados'
const sqlMotivoEscolherOutro = (p = '') =>
  `(CASE WHEN NOT ${sqlPodeEscolherOutro(p)} THEN NULL
         WHEN ${sqlEscolhidoDesinstalou(p)} THEN '${MOTIVO_ESCOLHER_OUTRO_DESINSTALOU}'
         ELSE '${MOTIVO_ESCOLHER_OUTRO_AVISOS}' END)`
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
// ehDono: posse por PESSOA, resolvida pelo handler (utils/tipoConta.ehMesmaPessoa) na transação.
const recusa = (lado, d, ehDono, modo = 'desfazer') => {
  if (!ehDono) return { status: 403, corpo: { erro: modo === 'escolher_outro' ? 'Só o cliente pode escolher outro profissional' : 'Só o cliente pode desfazer a escolha' } }
  if (d.status !== 'aberta') return { status: 409, corpo: { erro: `${lado.artigo} não está mais em andamento`, codigo: 'DEMANDA_FECHADA' } }
  if (!d.match_usuario_id || !d.match_feito_em) return { status: 409, corpo: { erro: 'Não há profissional escolhido para desfazer', codigo: 'SEM_MATCH' } }
  if (d.a_caminho_em || d.chegada_declarada_em || d.chegada_confirmada_em) {
    return { status: 409, corpo: { erro: 'O profissional já está a caminho ou chegou: não dá mais para desfazer a escolha.', codigo: 'A_CAMINHO' } }
  }
  if (d.chegada_pendente_em || d.chegada_prevista_em) {
    return { status: 409, corpo: { erro: 'O profissional já propôs ou combinou um horário. Para sair do atendimento, use o cancelamento.', codigo: 'HORARIO_EM_NEGOCIACAO' } }
  }
  if (modo === 'escolher_outro') {
    if (d.pode_escolher_outro !== true) {
      return { status: 409, corpo: {
        erro: `Escolher outro profissional libera depois de ${LEMBRETES_PARA_ESCOLHER_OUTRO} lembretes de agendamento sem resposta.`,
        codigo: 'ESCOLHER_OUTRO_INDISPONIVEL', lembretes_sem_proposta: Number(d.lembrete_agendar_sem_proposta || 0), necessarios: LEMBRETES_PARA_ESCOLHER_OUTRO,
      } }
    }
    return null
  }
  if (!d.liberado_em) return { status: 409, corpo: { erro: 'Não é possível desfazer a escolha agora', codigo: 'ESTADO_MUDOU' } }
  if (new Date(d.agora) < new Date(d.liberado_em)) {
    return { status: 409, corpo: { erro: `Dê um tempo ao profissional: você pode desfazer a escolha a partir de ${formatarDataHoraSP(d.liberado_em)}.`, codigo: 'AGUARDE', liberado_em: d.liberado_em } }
  }
  return null
}

// POST /:tabela/dono/:id/desfazer-match (modo 'desfazer') e /:tabela/dono/:id/escolher-outro
// (modo 'escolher_outro') — só o dono.
const handler = (tabela, modo = 'desfazer') => {
  const lado = LADOS[tabela]
  if (!lado) throw new Error(`desfazerEscolhaService: lado desconhecido "${tabela}"`)
  if (!MODOS.includes(modo)) throw new Error(`desfazerEscolhaService: modo desconhecido "${modo}"`)
  const escolherOutro = modo === 'escolher_outro'
  const motivo = escolherOutro ? MOTIVO_ESCOLHEU_OUTRO : MOTIVO_ESCOLHA_DESFEITA
  const rotuloLog = escolherOutro ? 'EscolherOutro' : 'DesfazerEscolha'
  return async (req, res) => {
    const id = String(req.params.id)
    if (!UUID_RE.test(id)) return res.status(404).json({ erro: lado.naoEncontrada })
    let client
    let d, profissionalId, interessados, semPenalidade = false
    try {
      client = await pool.connect()
      await client.query('BEGIN')
      const r = await client.query(
        `SELECT id, titulo, criado_por, match_usuario_id, match_feito_em, status, a_caminho_em,
                chegada_pendente_em, chegada_prevista_em, chegada_declarada_em, chegada_confirmada_em,
                lembrete_agendar_sem_proposta, ${sqlPodeEscolherOutro()} AS pode_escolher_outro,
                ${sqlMotivoEscolherOutro()} AS motivo_escolher_outro,
                ${sqlDesfazerLiberadoEm()} AS liberado_em, NOW() AS agora
           FROM ${lado.tabela} WHERE id = $1 FOR UPDATE`,
        [id]
      )
      d = r.rows[0]
      if (!d) { await client.query('ROLLBACK'); return res.status(404).json({ erro: lado.naoEncontrada }) }
      const neg = recusa(lado, d, await ehMesmaPessoa(d.criado_por, req.usuario.id, client), modo)
      if (neg) { await client.query('ROLLBACK'); return res.status(neg.status).json(neg.corpo) }
      profissionalId = d.match_usuario_id
      // Escolher outro porque o escolhido DESINSTALOU o app: sem falta, sem compromisso_nao_cumprido,
      // sem "contou como 1 falta" no aviso — ele não viu os lembretes. A proposta dele guarda o
      // motivo em cancelado_detalhe. Decidido na linha travada (sqlMotivoEscolherOutro).
      semPenalidade = escolherOutro && d.motivo_escolher_outro === MOTIVO_ESCOLHER_OUTRO_DESINSTALOU

      // A linha está travada, mas o WHERE repete as condições (inclusive a espera pelo relógio
      // do banco): se algo mudou entre o SELECT e aqui, nada é alterado e o pedido aborta.
      const upd = await client.query(
        `UPDATE ${lado.tabela} SET ${SQL_LIMPAR_MATCH},
                expira_em = GREATEST(expira_em, NOW() + INTERVAL '${PISO_PRAZO_RESTANTE}'),
                prestadores_bloqueados = CASE WHEN $2::uuid = ANY(COALESCE(prestadores_bloqueados, '{}'))
                                              THEN prestadores_bloqueados
                                              ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid) END
          WHERE id = $1 AND match_usuario_id = $2 AND ${sqlPodeDesfazer()}
            AND ${escolherOutro ? sqlPodeEscolherOutro() : `NOW() >= match_feito_em + ${sqlEspera()}`}
          RETURNING id`,
        [d.id, profissionalId]
      )
      if (upd.rows.length === 0) { await client.query('ROLLBACK'); return res.status(409).json({ erro: 'O atendimento mudou. Atualize a tela.', codigo: 'ESTADO_MUDOU' }) }
      await client.query(
        `UPDATE ${lado.proposta.tabela}
            SET status = 'cancelado', cancelado_por = $3, cancelado_motivo = $4, cancelado_detalhe = $5,
                cancelado_em = NOW(), cancelado_acordo = false, status_antes_match = NULL
          WHERE ${lado.proposta.coluna} = $1 AND usuario_id = $2 AND status = 'aceito'`,
        [d.id, profissionalId, req.usuario.id, motivo, semPenalidade ? MOTIVO_ESCOLHER_OUTRO_DESINSTALOU : null]
      )
      // Propostas rebaixadas PELO MATCH voltam ao status que tinham (regra única: utils/reaberturaMatch).
      await restaurarPropostasRebaixadas(client, lado.tabela, d.id)
      interessados = (await client.query(
        `SELECT DISTINCT usuario_id FROM ${lado.proposta.tabela}
          WHERE ${lado.proposta.coluna} = $1 AND usuario_id <> $2 AND status = ANY($3::text[])`,
        [d.id, profissionalId, STATUS_VALENDO]
      )).rows.map(x => x.usuario_id)
      // Falta nos dois modos (única por profissional × demanda) + evento compromisso_nao_cumprido
      // (idempotente), na MESMA transação do un-match — salvo 'desinstalou' (sem penalidade).
      if (!semPenalidade) {
        await inserirFaltaUnica(client, lado.tabela, d.id, profissionalId, MOTIVO_FALTA)
        await registrarCompromissoNaoCumprido(client, { tabela: lado.tabela, demandaId: d.id, profissionalId, donoId: d.criado_por, motivo })
      }
      await client.query('COMMIT')
    } catch (err) {
      if (client) { try { await client.query('ROLLBACK') } catch {} }
      console.error(`[${rotuloLog}] ${tabela} ${req.params.id}:`, err.message)
      return res.status(500).json({ erro: escolherOutro ? 'Erro ao escolher outro profissional' : 'Erro ao desfazer a escolha' })
    } finally {
      if (client) client.release()
    }
    console.log(`[${rotuloLog}] ${lado.tipo} ${d.id}: dono ${req.usuario.id} desfez a escolha de ${profissionalId} (${semPenalidade ? 'profissional desinstalou: SEM falta/evento' : 'falta + compromisso_nao_cumprido registrados'}; ${interessados.length} interessado(s) seguem valendo)`)
    res.json({ mensagem: `Escolha desfeita. ${lado.artigo} voltou ao feed.`, profissional_id: profissionalId, interessados_avisados: interessados.length, modo, ...(escolherOutro ? { motivo_escolher_outro: d.motivo_escolher_outro } : {}) })

    // Fora da transação e depois da resposta. Ordem: suspensão (pode mandar "Conta suspensa"),
    // profissional, interessados, dono. ator_id só no aviso ao profissional e aos interessados
    // (o dono é o autor e PRECISA receber o dele).
    ;(async () => {
      if (!semPenalidade) await avaliarSuspensaoPorFaltas(profissionalId)
      const [prof] = await contatos([profissionalId])
      if (prof) {
        await avisar(prof, semPenalidade ? {
          ator_id: req.usuario.id,
          titulo: 'O cliente escolheu outro profissional',
          corpo: `"${d.titulo}": o cliente escolheu outro profissional porque você desinstalou o app. Sem penalidade.`,
          data: { tipo: lado.tipoPushProfissional, [lado.chave]: d.id, motivo: MOTIVO_ESCOLHEU_OUTRO, desinstalou: true },
          rotulo: `escolheu outro ${lado.tipo} ${d.id} profissional`,
        } : escolherOutro ? {
          ator_id: req.usuario.id,
          titulo: 'O cliente escolheu outro profissional',
          corpo: `"${d.titulo}": o cliente escolheu outro profissional porque o horário não foi marcado. Isso contou como 1 falta.`,
          data: { tipo: lado.tipoPushProfissional, [lado.chave]: d.id, motivo: MOTIVO_ESCOLHEU_OUTRO },
          rotulo: `escolheu outro ${lado.tipo} ${d.id} profissional`,
        } : {
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
      // Dono UMA vez por pessoa (alertaService.contatoDaPessoa): token/e-mail da conta irmã se a dele está vazio.
      const dono = await contatoDaPessoa(d.criado_por)
      if (dono) {
        await avisar(dono, {
          titulo: 'Pedido reaberto',
          corpo: `Avisamos os ${interessados.length} interessados. Escolha o novo profissional quando quiser.`,
          data: { tipo: lado.tipoPushDono, [lado.chave]: d.id, reaberta: true },
          rotulo: `escolha desfeita ${lado.tipo} ${d.id} dono`,
        })
      }
    })().catch(err => console.error(`[${rotuloLog}] avisos ${lado.tipo} ${d.id}:`, err.message))
  }
}

// Cron (1 min): quando o desfazer LIBERA (NOW() ≥ liberado_em) e o prazo ainda não venceu, avisa o
// dono UMA vez por match — claim desfazer_aviso_em no mesmo UPDATE (réplicas/restarts não
// repetem; SQL_ZERAR_AGENDA zera em match novo/un-match). Evento crítico: push + e-mail sempre
// (entregarPushEEmail). Sem silêncio noturno, como os lembretes de agenda do dono. Toque: tipo
// 'chegada_prevista' (o app abre o detalhe da demanda nos dois lados).
const TITULO_LIBERADO = '🔓 Você já pode escolher outro profissional'
const corpoLiberado = (d) => `Falta pouco e ${primeiroNome(d.profissional_nome)} ainda não marcou o horário de "${d.titulo}". Você já pode escolher outro profissional.`
const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0] || 'O profissional'
const avisarDesfazerLiberado = semSobreposicao('avisarDesfazerLiberado', async () => {
  for (const lado of Object.values(LADOS)) {
    try {
      const claim = await pool.query(
        `UPDATE ${lado.tabela} d SET desfazer_aviso_em = NOW()
           FROM usuarios u, usuarios p
          WHERE u.id = d.criado_por AND p.id = d.match_usuario_id
            AND ${sqlPodeDesfazer('d.')} AND d.desfazer_aviso_em IS NULL
            AND NOW() >= d.match_feito_em + ${sqlEspera('d.')} AND d.expira_em > NOW()
      RETURNING d.id, d.titulo, d.criado_por, u.push_token, u.email, u.nome, p.nome AS profissional_nome`
      )
      for (const d of claim.rows) {
        const via = await avisar({ usuario_id: d.criado_por, push_token: d.push_token, email: d.email, nome: d.nome }, {
          titulo: TITULO_LIBERADO, corpo: corpoLiberado(d),
          data: { tipo: 'chegada_prevista', [lado.chave]: d.id, desfazer_liberado: true },
          rotulo: `desfazer liberado ${lado.tipo} ${d.id}`,
        })
        console.log(`[DesfazerEscolha] ${lado.tipo} ${d.id}: desfazer liberado → dono ${d.criado_por} via ${via}`)
      }
    } catch (err) {
      console.error(`[DesfazerEscolha] aviso de liberação ${lado.tabela}:`, err.message)
    }
  }
})

// Escolhido DESINSTALOU o app (dono, 11/11/2026): o dono de cada obra/reparo ABERTO em que ele é o
// match, SEM horário combinado, recebe push + e-mail UMA vez por match (claim aviso_desinstalou_em,
// zerado em SQL_ZERAR_AGENDA no match novo). Roda logo depois de marcarDesinstalados (alertaService)
// e no cron de 1 min (junto de avisarDesfazerLiberado), para nada ficar sem aviso. Se ele reinstalar
// antes do aviso, desinstalado_em volta a NULL e nada sai. Nunca lança.
const tituloDesinstalou = (nome) => `${primeiroNome(nome)} desinstalou o app e pode não ver os avisos`
const corpoDesinstalou = (titulo) => `Você pode escolher outro profissional para "${titulo}" sem penalidade, ou esperar.`
const avisarDonosProfissionalDesinstalou = async () => {
  let total = 0
  for (const lado of Object.values(LADOS)) {
    try {
      const claim = await pool.query(
        `UPDATE ${lado.tabela} d SET aviso_desinstalou_em = NOW()
           FROM usuarios p
          WHERE p.id = d.match_usuario_id AND p.desinstalado_em IS NOT NULL
            AND d.status = 'aberta' AND d.chegada_prevista_em IS NULL AND d.aviso_desinstalou_em IS NULL
      RETURNING d.id, d.titulo, d.criado_por, p.nome AS profissional_nome`
      )
      for (const d of claim.rows) {
        const dono = await contatoDaPessoa(d.criado_por)
        if (!dono) continue
        const via = await avisar(dono, {
          titulo: tituloDesinstalou(d.profissional_nome), corpo: corpoDesinstalou(d.titulo),
          data: { tipo: 'chegada_prevista', [lado.chave]: d.id, escolher_outro: true, motivo_escolher_outro: MOTIVO_ESCOLHER_OUTRO_DESINSTALOU },
          rotulo: `profissional desinstalou ${lado.tipo} ${d.id}`,
        })
        total++
        console.log(`[EscolherOutro] ${lado.tipo} ${d.id}: escolhido desinstalou o app → dono ${d.criado_por} via ${via}`)
      }
    } catch (err) {
      console.error(`[EscolherOutro] aviso de desinstalação ${lado.tabela}:`, err.message)
    }
  }
  return total
}

module.exports = {
  LIBERA_FRACAO_RESTANTE, MOTIVO_ESCOLHA_DESFEITA, MOTIVO_ESCOLHEU_OUTRO, LEMBRETES_PARA_ESCOLHER_OUTRO, MOTIVO_FALTA,
  MOTIVO_ESCOLHER_OUTRO_DESINSTALOU, MOTIVO_ESCOLHER_OUTRO_AVISOS,
  sqlEspera, sqlDesfazerLiberadoEm, sqlPodeEscolherOutro, sqlMotivoEscolherOutro, sqlEscolhidoDesinstalou,
  handler, avisarDesfazerLiberado, avisarDonosProfissionalDesinstalou, TITULO_LIBERADO, corpoLiberado, tituloDesinstalou, corpoDesinstalou,
}
