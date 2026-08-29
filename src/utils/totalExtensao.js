// total_extensao_horas — horas que expira_em já foi empurrado ALÉM do vencimento original
// (âncora + janela registrada). Mesma aritmética de restanteExtensao (routes/index.js), só que
// em SQL, para sair no feed e no detalhe dos DOIS lados sem coluna nova. Envelhecer sem
// estender não conta (GREATEST 0); expira_em NULL devolve 0 (COALESCE). NULLIF(janela, 0)
// espelha o `Number(janelaHoras) || 720` da função JS. ::float8 para o node-pg entregar número.
const sqlTotalExtensaoHoras = (ancora, janela, expiraEm) =>
  `GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (${expiraEm} - (${ancora} + COALESCE(NULLIF(${janela}, 0), 720) * INTERVAL '1 hour'))) / 3600, 0))::float8`

// Obra: âncora COALESCE(publicado_em, criado_em), janela horas_para_expirar.
const sqlTotalExtensaoObra = (p = '') =>
  sqlTotalExtensaoHoras(`COALESCE(${p}publicado_em, ${p}criado_em)`, `${p}horas_para_expirar`, `${p}expira_em`)

// Reparo: âncora criado_em (publica na criação), janela prazo_atendimento_horas.
const sqlTotalExtensaoReparo = (p = '') =>
  sqlTotalExtensaoHoras(`${p}criado_em`, `${p}prazo_atendimento_horas`, `${p}expira_em`)

module.exports = { sqlTotalExtensaoObra, sqlTotalExtensaoReparo }
