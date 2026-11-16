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

// PRAZO VENCIDO (dono, 16/11/2026 — 4DXCJ): pedido ainda 'aberta' com expira_em no passado. Aceitar
// uma proposta ali casava o profissional num pedido já vencido, e o app desfazia a escolha no mesmo
// segundo (POST /:id/expirar-match — a proposta ia a 'expirado'). Os QUATRO aceites (dono em
// …/responder; profissional em …/prestador-responder e …/pintor-responder) perguntam aqui ANTES de
// gravar qualquer coisa: vencido → 409 PRAZO_VENCIDO, nada muda; o dono aumenta o prazo e escolhe.
// Relógio do banco (NOW()), o mesmo que os crons e o expirar-match leem.
const MSG_PRAZO_VENCIDO_DONO = 'O prazo deste pedido venceu. Aumente o prazo para escolher este profissional.'
const MSG_PRAZO_VENCIDO_PROFISSIONAL = 'O prazo deste pedido venceu. O cliente precisa aumentar o prazo antes de fechar com você.'
const erroPrazoVencido = (mensagem = MSG_PRAZO_VENCIDO_DONO) => ({ erro: mensagem, codigo: 'PRAZO_VENCIDO', mensagem })
const ERRO_PRAZO_VENCIDO = Object.freeze(erroPrazoVencido())
const ERRO_PRAZO_VENCIDO_PROFISSIONAL = Object.freeze(erroPrazoVencido(MSG_PRAZO_VENCIDO_PROFISSIONAL))
// true só para pedido 'aberta', SEM profissional escolhido e com expira_em < NOW().
const prazoVencido = async (db, tabela, id) => {
  if (!NAO_ENCONTRADA[tabela]) throw new Error(`prazoVencido: tabela inválida ${tabela}`)
  const r = await db.query(
    `SELECT (status = 'aberta' AND match_usuario_id IS NULL AND expira_em < NOW()) AS vencido FROM ${tabela} WHERE id = $1`, [id])
  return !!r.rows[0]?.vencido
}

module.exports = { ERRO_PEDIDO_INDISPONIVEL, travarDemandaAberta, ERRO_PRAZO_VENCIDO, ERRO_PRAZO_VENCIDO_PROFISSIONAL, prazoVencido }
