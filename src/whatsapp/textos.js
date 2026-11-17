// TEXTOS do robô de WhatsApp (Etapa 2 — pergunta sem resposta). Funções puras. Os textos foram
// aprovados pelo dono em 17/11/2026: nenhum "ele/ela" — só nomes.
const RODAPE_SAIR = '\n_Para não receber mais avisos, responda SAIR._'
const NUMEROS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣']

const primeiroNome = (nome) => String(nome ?? '').trim().split(/\s+/)[0] || ''

// itens = [{ primeiro_nome, titulo, nome_prof, pergunta, demanda_id }] (as `dados` das linhas da
// fila, na ordem em que serão numeradas). primeira = primeira mensagem que a pessoa recebe do
// robô → leva o rodapé do SAIR (só nela).
const textoPerguntas = (itens, { primeira = false } = {}) => {
  const ola = `Oi, ${itens[0].primeiro_nome}! 👋 Aqui é o *ProTudo*.`
  let corpo
  if (itens.length === 1) {
    const i = itens[0]
    corpo = `${ola}\n${i.nome_prof} fez uma pergunta no seu pedido *${i.titulo}*:\n💬 "${i.pergunta}"\n${i.nome_prof} só manda o preço depois da sua resposta.\n👉 É só *responder aqui mesmo*, que a gente entrega no app.`
  } else {
    const umPedido = new Set(itens.map(i => i.demanda_id)).size === 1
    const cabecalho = umPedido
      ? `Tem ${itens.length} perguntas esperando você no pedido *${itens[0].titulo}*:`
      : `Tem ${itens.length} perguntas esperando você nos seus pedidos:`
    // Perguntas de pedidos diferentes: o título do pedido vai em cada item.
    const linhas = itens.map((i, n) => `${NUMEROS[n]} ${i.nome_prof}${umPedido ? '' : ` (*${i.titulo}*)`}: "${i.pergunta}"`)
    corpo = `${ola}\n${cabecalho}\n${linhas.join('\n')}\n👉 Responda começando pelo número. Exemplo: *1 sim, já comprei*`
  }
  return primeira ? corpo + RODAPE_SAIR : corpo
}

// "1 ou 2", "1, 2 ou 3"…
const listaNumeros = (numeros) => {
  const ns = [...numeros].sort((a, b) => a - b)
  return ns.length <= 1 ? String(ns[0] ?? 1) : `${ns.slice(0, -1).join(', ')} ou ${ns[ns.length - 1]}`
}
const textoNaoEntendi = (numeros) => `Não entendi para quem é a resposta 😅 Comece pelo número da pergunta (${listaNumeros(numeros)}).`
// Várias perguntas pendentes vindas de mensagens SEM numeração (uma pergunta por mensagem): não
// há número para pedir — pede para responder em cima da mensagem da pergunta.
const TEXTO_NAO_ENTENDI_SEM_NUMERO = 'Não entendi para quem é a resposta 😅 Responda em cima da mensagem da pergunta (segure a mensagem e toque em Responder).'
const TEXTO_SO_ESCRITA = 'Por enquanto só consigo entregar resposta escrita ✍️ Pode digitar, por favor?'
const textoEntregue = (nomeProf) => `✅ Pronto! Sua resposta foi entregue para ${nomeProf} no app.`
const textoNaoEntregue = (erro) => `Não consegui entregar sua resposta: ${String(erro || 'tente pelo app').replace(/\.$/, '')}.`

// "2 sim, pode vir" / "2) sim" / "2 - sim" / "2️⃣ sim" → { numero: 2, resto: 'sim, pode vir' }; senão null.
const lerNumeroInicial = (texto) => {
  const m = /^\s*([1-5])(?:️?⃣)?(?!\d)\s*[).:\-–—]?\s*([\s\S]*)$/.exec(String(texto ?? ''))
  return m ? { numero: Number(m[1]), resto: m[2].trim() } : null
}

module.exports = { RODAPE_SAIR, primeiroNome, textoPerguntas, textoNaoEntendi, TEXTO_NAO_ENTENDI_SEM_NUMERO, TEXTO_SO_ESCRITA, textoEntregue, textoNaoEntregue, lerNumeroInicial, listaNumeros }
