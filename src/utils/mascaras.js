// CPF/CNPJ mascarado para o painel: só o miolo fica legível (***.456.789-** / **.345.678/0001-**).
// Qualquer outro tamanho: tudo oculto menos os 4 últimos dígitos. Sem valor → null.
// Único helper: usado na ficha de verificação (routes) e na lista de usuários (pagamentoController).
const mascararCpfCnpj = (valor) => {
  const d = String(valor || '').replace(/\D/g, '')
  if (!d) return null
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`
  if (d.length === 14) return `**.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-**`
  return '*'.repeat(Math.max(0, d.length - 4)) + d.slice(-4)
}

module.exports = { mascararCpfCnpj }
