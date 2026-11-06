// Demanda ABERTA sob trava — peça única das rotas do PROFISSIONAL que escrevem numa demanda do
// feed (interesse/candidatura nova, contraproposta/aceite/recusa de contraproposta do dono).
//
// A corrida (06/11/2026): o dono exclui o pedido (DELETE /:tabela/dono/:id → status 'cancelada')
// e, segundos depois, um profissional com o card aberto manda o interesse; sem checar o status,
// a linha entrava e o dono recebia push + e-mail de um pedido que acabara de apagar. Aqui a
// rota abre uma transação, trava a linha (SELECT … FOR UPDATE) e só segue se status = 'aberta':
// um cancelamento commitado antes é visto; um UPDATE de cancelamento concorrente espera a trava
// e só roda depois do COMMIT do interesse (aí o interesse já existia de verdade quando o dono
// excluiu — a ordem real dos eventos é respeitada). Fora de 'aberta': 409 PEDIDO_INDISPONIVEL,
// nada gravado, nenhum aviso ao dono. Linha inexistente: 404.
const ERRO_PEDIDO_INDISPONIVEL = Object.freeze({ erro: 'Este pedido não está mais disponível.', codigo: 'PEDIDO_INDISPONIVEL' })
const NAO_ENCONTRADA = { obras: 'Obra não encontrada', reparos: 'Serviço não encontrado' }

// Devolve { demanda } (id, status, titulo, criado_por — a linha travada) ou { recusa: { status, corpo } }.
const travarDemandaAberta = async (client, tabela, id) => {
  if (!NAO_ENCONTRADA[tabela]) throw new Error(`travarDemandaAberta: tabela inválida ${tabela}`)
  const r = await client.query(`SELECT id, status, titulo, criado_por FROM ${tabela} WHERE id = $1 FOR UPDATE`, [id])
  if (!r.rows[0]) return { recusa: { status: 404, corpo: { erro: NAO_ENCONTRADA[tabela] } } }
  if (r.rows[0].status !== 'aberta') return { recusa: { status: 409, corpo: ERRO_PEDIDO_INDISPONIVEL } }
  return { demanda: r.rows[0] }
}

module.exports = { ERRO_PEDIDO_INDISPONIVEL, travarDemandaAberta }
