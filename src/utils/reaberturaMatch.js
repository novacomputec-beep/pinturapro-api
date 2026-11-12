// REABERTURA PELO CRONÔMETRO (dono, 10/11/2026). Quando o match morre no cronômetro
// (alertaService.verificarCronometroObras/Reparos) porque o profissional NUNCA marcou horário, a
// demanda volta ao feed e o dono precisa poder "escolher outro interessado" — mas as propostas
// dos concorrentes tinham sido rebaixadas a 'recusado' pelo match (utils/rejeitarConcorrentes,
// status_antes_match guarda o status anterior). Aqui ficam as peças compartilhadas:
//   - migração: obras/reparos.aviso_reabertura_em (claim do aviso aos interessados, adiado para
//     fora do silêncio noturno) e candidaturas/interesse_reparos.status_antes_match (já criada no
//     boot de routes; repetida IF NOT EXISTS para os esquemas de teste);
//   - SQL que devolve as propostas rebaixadas pelo match ao status que tinham (a MESMA regra de
//     desfazerEscolhaService) e a lista de status "valendo" que recebem o aviso de reabertura.
const STATUS_VALENDO = ['pendente', 'contraproposta_dono']
const LADOS = {
  obras:   { proposta: 'candidaturas',      coluna: 'obra_id',   chave: 'obra_id',   tipoPushInteressado: 'nova_obra' },
  reparos: { proposta: 'interesse_reparos', coluna: 'reparo_id', chave: 'reparo_id', tipoPushInteressado: 'novo_reparo' },
}

// Texto do aviso aos interessados (push + e-mail) — o MESMO em todo caminho que reabre um match
// (dono, 12/11/2026; enviado só por alertaService.avisarReabertura). NEUTRO: nunca diz quem saiu,
// por quê nem quantas vezes.
const TITULO_REABERTA = '🔔 Pedido disponível de novo'
const corpoReaberta = (titulo) => `"${titulo}" está aberto e sua proposta continua valendo — o cliente pode escolher você.`
// SET de toda transação de un-match que deixa a demanda aberta: marca o aviso de reabertura como
// devido (o cron o envia fora do silêncio noturno). Usado como fragmento de UPDATE.
const SQL_MARCAR_REABERTURA = 'aviso_reabertura_em = NOW()'
// Texto ao dono quando o match morreu sem o profissional marcar horário (substitui o genérico
// "⏰ Prazo expirado!" nesse caso; data.tipo continua 'match_expirado' → detalhe da demanda).
const TITULO_DONO_SEM_HORARIO = '⏰ O profissional não marcou horário'
const corpoDonoSemHorario = (titulo) => `Escolha outro interessado ou defina uma nova data para "${titulo}".`

// ─── RESTAURAÇÃO DAS PROPOSTAS REBAIXADAS PELO MATCH (dono, 11/11/2026) ──────────────────────────
// Regra ÚNICA para TODO caminho em que o match acaba e a demanda CONTINUA ABERTA: as propostas que o
// match rebaixou a 'recusado' (utils/rejeitarConcorrentes guarda o status de antes em
// status_antes_match) voltam ao status que tinham, e o marcador é limpo. Recusa explícita do dono
// (sem marcador) continua recusada; a proposta do profissional que saiu nunca está em 'recusado'
// com marcador (ela é a 'aceito' que cada caminho trata à sua maneira), então não há o que excluir.
// Em produção o B55RT (11/11) mostrou o buraco: a desistência do profissional (cancelamentoMatch
// Service) devolvia o reparo ao feed com os 19 interessados ainda 'recusado'.
// Caminhos que usam isto: desistência do profissional e cancelamento do dono mantendo aberto
// (cancelamentoMatchService.executar), exclusão da conta do escolhido (desfazerMatchesPorExclusao),
// desfazer escolha / escolher outro (desfazerEscolhaService), expirar-match pelas partes/admin
// (routes), recusa de mais tempo (atrasoChegadaService) e os dois cronômetros (alertaService).
//
// sqlRestaurarPropostas(tabela, alvo): o UPDATE sem RETURNING, para entrar como CTE no mesmo
//   statement de quem desfaz o match. `alvo` = { igual: '$1' } (uma demanda, placeholder uuid) ou
//   { em: 'SELECT id FROM desfeito' } (ids de uma CTE anterior — lê a MESMA snapshot, então a linha
//   'aceito' que outra CTE expira não é tocada aqui).
// restaurarPropostasRebaixadas(db, tabela, demandaId): a mesma coisa como statement próprio
//   (dentro da transação de quem chama); devolve os usuario_id restaurados.
const sqlRestaurarPropostas = (tabela, alvo) => {
  const lado = LADOS[tabela]
  if (!lado) throw new Error(`sqlRestaurarPropostas: tabela inválida ${tabela}`)
  const predicado = alvo?.em ? `IN (${alvo.em})` : alvo?.igual ? `= ${alvo.igual}::uuid` : null
  if (!predicado) throw new Error('sqlRestaurarPropostas: informe alvo.igual ou alvo.em')
  return `UPDATE ${lado.proposta} rp SET status = rp.status_antes_match, status_antes_match = NULL
      WHERE rp.${lado.coluna} ${predicado} AND rp.status = 'recusado' AND rp.status_antes_match IS NOT NULL`
}
const restaurarPropostasRebaixadas = async (db, tabela, demandaId) => {
  const r = await db.query(`${sqlRestaurarPropostas(tabela, { igual: '$1' })} RETURNING rp.usuario_id`, [demandaId])
  return r.rows.map(x => x.usuario_id)
}

const migrarReaberturaMatch = async (client) => {
  for (const t of ['obras', 'reparos']) await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS aviso_reabertura_em TIMESTAMPTZ`)
  for (const t of ['candidaturas', 'interesse_reparos']) await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS status_antes_match TEXT`)
}

module.exports = {
  STATUS_VALENDO, LADOS, TITULO_REABERTA, corpoReaberta, SQL_MARCAR_REABERTURA, TITULO_DONO_SEM_HORARIO, corpoDonoSemHorario, migrarReaberturaMatch,
  sqlRestaurarPropostas, restaurarPropostasRebaixadas,
}
