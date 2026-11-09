// Valor de uma demanda (reparos.valor_estimado / obras.valor) — "quanto o dono quer pagar".
//
// Por que existe (09/11/2026): POST /reparos/dono e POST /obras/dono gravavam o que viesse no
// corpo sem conferir — só a moderação olhava o valor, e só para recusar ANÚNCIO (palavra de venda
// + valor vazio). Um pedido comum sem valor, com 0 ou com '' entrava e era publicado: foi assim que
// "Depilação na cera" foi ao feed com valor 0. Pedido sem valor não dá ao profissional como
// decidir, e o push/e-mail saem com "R$ 0".
//
// Regra ÚNICA para criar e editar, nos dois lados: número (ou texto numérico) FINITO e MAIOR QUE
// ZERO. Ausente, null, '', 0, negativo, NaN, booleano, lista ou objeto → erro com a mensagem que o
// app mostra tal como vem. `codigo` é a chave estável.
// Devolve { valor } (número, para gravar) OU { erro, codigo }. Nunca lança.
const MENSAGEM_VALOR_OBRIGATORIO = 'Informe quanto quer pagar'
const CODIGO_VALOR_OBRIGATORIO = 'VALOR_OBRIGATORIO'
const ERRO_VALOR_OBRIGATORIO = Object.freeze({ erro: MENSAGEM_VALOR_OBRIGATORIO, codigo: CODIGO_VALOR_OBRIGATORIO })

const validarValorDemanda = (bruto) => {
  const texto = typeof bruto === 'string' ? bruto.trim() : null
  const n = typeof bruto === 'number' ? bruto : (texto ? Number(texto) : NaN)
  if (!Number.isFinite(n) || n <= 0) return { ...ERRO_VALOR_OBRIGATORIO }
  return { valor: n }
}

module.exports = { validarValorDemanda, MENSAGEM_VALOR_OBRIGATORIO, CODIGO_VALOR_OBRIGATORIO, ERRO_VALOR_OBRIGATORIO }
