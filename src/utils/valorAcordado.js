// Valor ACORDADO de uma demanda — fonte única para todo lugar que mostra o preço fechado
// (painel /admin/finalizadas e seus totais, listas "minhas"/"meus-contratos", contrato PDF
// e e-mail). Ordem:
//   1. valor_contraproposta — houve negociação e é ela que vale;
//   2. valor_proposto       — a proposta do profissional (o botão "Aceitar o valor proposto"
//                             do app copia o pedido para cá);
//   3. o PEDIDO da demanda  — reparos.valor_estimado / obras.valor. Proposta e contraproposta
//                             NULL = o profissional deixou vazio o campo "FAZER UMA
//                             CONTRAPROPOSTA (opcional)", ou seja, topou o valor pedido como
//                             está. Sem o 3º termo essas demandas saíam "—"/"a combinar".
// O pedido só entra quando EXISTE a proposta (p.id não nulo): num LEFT JOIN sem aceite
// (encerrada sem preço fechado em /admin/finalizadas) o resultado segue NULL, e não o pedido
// como se tivesse sido fechado. Fica NULL também quando a demanda não tem valor pedido —
// aí é mesmo "a combinar".
// `p` = alias da proposta (interesse_reparos / candidaturas); `d` = alias da demanda.
const sqlValorAcordado = (p, pedido) =>
  `(CASE WHEN ${p}.id IS NOT NULL THEN COALESCE(${p}.valor_contraproposta, ${p}.valor_proposto, ${pedido}) END)`
const sqlValorAcordadoReparo = (p, d) => sqlValorAcordado(p, `${d}.valor_estimado`)
const sqlValorAcordadoObra = (p, d) => sqlValorAcordado(p, `${d}.valor`)

module.exports = { sqlValorAcordadoReparo, sqlValorAcordadoObra }
