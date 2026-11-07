// "Profissional escolhido" de uma demanda — predicado ÚNICO para quem precisa saber se um
// pedido já tem alguém (canal do WhatsApp, página pública, listas do painel).
//
// Duas fontes, porque elas divergem em produção: o match (match_usuario_id, gravado no aceite)
// e a PROPOSTA ACEITA (candidaturas.status = 'aceito' em obras, interesse_reparos.status =
// 'aceito' em reparos). Todo caminho de aceite grava as duas, mas um match desfeito por
// limpeza/suporte (UPDATE ... match_usuario_id = NULL sem tocar a proposta) deixa a proposta
// 'aceito' sozinha — e ela é o que o dono e o profissional veem no app ("Alex Sander aceito").
// Um pedido assim NÃO é oferta: não entra no canal, não conta no resumo das 18:00 e a página
// pública diz "já tem um profissional escolhido". Por isso o predicado é OR, nunca só o match.
//
// Os índices parciais candidaturas_aceito_unica_idx / interesse_reparos_aceito_unico_idx
// garantem no máximo UMA proposta 'aceito' por demanda: os subselects escalares são seguros.
const LADOS = {
  obras:   { propostas: 'candidaturas',      fk: 'obra_id' },
  reparos: { propostas: 'interesse_reparos', fk: 'reparo_id' },
}

const lado = (tabela) => {
  const l = LADOS[tabela]
  if (!l) throw new Error(`profissionalEscolhido: tabela inválida ${tabela}`)
  return l
}

// Subconsulta da proposta aceita da demanda `${alias}.id` (0 ou 1 linha).
const sqlPropostaAceita = (tabela, alias, colunas = '1') => {
  const l = lado(tabela)
  return `SELECT ${colunas} FROM ${l.propostas} pa WHERE pa.${l.fk} = ${alias}.id AND pa.status = 'aceito'`
}

const sqlTemProfissionalEscolhido = (tabela, alias) =>
  `(${alias}.match_usuario_id IS NOT NULL OR EXISTS (${sqlPropostaAceita(tabela, alias)}))`

const sqlSemProfissionalEscolhido = (tabela, alias) =>
  `(${alias}.match_usuario_id IS NULL AND NOT EXISTS (${sqlPropostaAceita(tabela, alias)}))`

// id do escolhido: o match quando há; senão o autor da proposta aceita; senão NULL.
const sqlEscolhidoId = (tabela, alias) =>
  `COALESCE(${alias}.match_usuario_id, (${sqlPropostaAceita(tabela, alias, 'pa.usuario_id')} LIMIT 1))`

// Nome do escolhido (usuarios.nome) ou NULL.
const sqlEscolhidoNome = (tabela, alias) =>
  `(SELECT u.nome FROM usuarios u WHERE u.id = ${sqlEscolhidoId(tabela, alias)})`

// Quando foi escolhido: match_feito_em (gravado no aceite). Sem ele — match desfeito mas
// proposta ainda 'aceito' — cai na data da proposta, que é o único instante que a tabela de
// propostas guarda (não há coluna "aceito_em"). NULL quando não há escolhido.
const sqlEscolhidoEm = (tabela, alias) =>
  `(CASE WHEN ${sqlTemProfissionalEscolhido(tabela, alias)}
         THEN COALESCE(${alias}.match_feito_em, (${sqlPropostaAceita(tabela, alias, 'pa.criado_em')} LIMIT 1))
         ELSE NULL END)`

module.exports = { sqlTemProfissionalEscolhido, sqlSemProfissionalEscolhido, sqlEscolhidoId, sqlEscolhidoNome, sqlEscolhidoEm }
