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

// Texto do aviso aos interessados (push + e-mail), aprovado pelo dono em 10/11/2026.
const TITULO_REABERTA = '🔄 Pedido disponível de novo'
const corpoReaberta = (titulo) => `A demanda "${titulo}" voltou a ficar disponível — o cliente pode escolher você.`
// Texto ao dono quando o match morreu sem o profissional marcar horário (substitui o genérico
// "⏰ Prazo expirado!" nesse caso; data.tipo continua 'match_expirado' → detalhe da demanda).
const TITULO_DONO_SEM_HORARIO = '⏰ O profissional não marcou horário'
const corpoDonoSemHorario = (titulo) => `Escolha outro interessado ou defina uma nova data para "${titulo}".`

const migrarReaberturaMatch = async (client) => {
  for (const t of ['obras', 'reparos']) await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS aviso_reabertura_em TIMESTAMPTZ`)
  for (const t of ['candidaturas', 'interesse_reparos']) await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS status_antes_match TEXT`)
}

module.exports = {
  STATUS_VALENDO, LADOS, TITULO_REABERTA, corpoReaberta, TITULO_DONO_SEM_HORARIO, corpoDonoSemHorario, migrarReaberturaMatch,
}
