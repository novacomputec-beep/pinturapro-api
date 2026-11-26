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

// NOVO INTERESSADO (dono, 19/11/2026) — só para o dono SEM notificação no celular.
// itens = [{ primeiro_nome, nome_prof, titulo, demanda_id, link }] (as `dados` das linhas da fila).
// Um interesse: nome do profissional. Vários no mesmo pedido: "{n} profissionais". Pedidos
// diferentes: uma linha por pedido, cada um com o seu link.
const DICA_NOTIFICACOES = '💡 _Dica: ative as notificações do ProTudo no celular para saber na hora._'
// Link do pedido = a página pública que já existe (routes/paginaPublica: protudo.app.br/p/<codigo>).
const linkAbrir = (codigo) => `https://protudo.app.br/p/${codigo}`
const textoInteressados = (itens, { primeira = false } = {}) => {
  const ola = `Oi, ${itens[0].primeiro_nome}! 👋 Aqui é o *ProTudo*.`
  const pedidos = []
  for (const i of itens) {
    let p = pedidos.find(x => x.demanda_id === i.demanda_id)
    if (!p) pedidos.push(p = { demanda_id: i.demanda_id, titulo: i.titulo, link: i.link, itens: [] })
    p.itens.push(i)
  }
  let corpo
  if (pedidos.length === 1) {
    const p = pedidos[0]
    const quem = p.itens.length === 1
      ? `🙋 *${p.itens[0].nome_prof}* se interessou pelo seu pedido *${p.titulo}*.`
      : `🙋 *${p.itens.length} profissionais* se interessaram pelo seu pedido *${p.titulo}*.`
    corpo = `${ola}\n${quem}\n👉 Veja e escolha aqui: ${p.link}\n${DICA_NOTIFICACOES}`
  } else {
    const linhas = pedidos.map(p => `• *${p.titulo}*: ${p.itens.length} ${p.itens.length === 1 ? 'interessado' : 'interessados'}\n👉 ${p.link}`)
    corpo = `${ola}\n🙋 Seus pedidos têm novos interessados:\n${linhas.join('\n')}\n${DICA_NOTIFICACOES}`
  }
  return primeira ? corpo + RODAPE_SAIR : corpo
}
// Resposta do robô a quem responde a um aviso de novo interessado (a escolha é feita no app).
const TEXTO_RESPOSTA_INTERESSADO = 'Para escolher o profissional, toque no link acima 👆'

// ESPECIALIDADE RARA (dono, 23/11/2026) — para o PROFISSIONAL. Texto aprovado pelo dono.
// "45 min", "3 h", "3 h 20 min", "1 dia", "2 dias e 5 h" (minutos só abaixo de um dia).
const tempoRestante = (ms) => {
  const min = Math.max(1, Math.floor(Number(ms) / 60000) || 0)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
  const d = Math.floor(h / 24)
  return `${d} ${d === 1 ? 'dia' : 'dias'}${h % 24 ? ` e ${h % 24} h` : ''}`
}
// dados = { primeiro_nome, rotulo, titulo, codigo, expira_em }; agora = instante do envio.
const textoEspecialidadeRara = (dados, { primeira = false, agora = new Date() } = {}) => {
  const corpo = `Oi, ${dados.primeiro_nome}! 👋 Aqui é o *ProTudo*.\nTem um pedido de *${dados.rotulo}* perto de você ainda sem ninguém: *"${dados.titulo}"*.\n⏰ Termina em ${tempoRestante(new Date(dados.expira_em).getTime() - new Date(agora).getTime())}.\n👉 Veja e mande sua proposta: protudo.app.br/p/${dados.codigo}`
  return primeira ? corpo + RODAPE_SAIR : corpo
}

// CONTATO NO TEXTO (dono, 26/11/2026) — para o dono do pedido. Texto aprovado pelo dono: sai
// EXATAMENTE assim, sem rodapé.
const textoContatoNoTexto = (titulo) =>
  `Olá! 👋 Aqui é o *ProTudo*.\n\nVimos seu pedido *"${titulo}"* e queremos te ajudar a aproveitar melhor o app. 😊\n\nO ProTudo *tem sim* espaço para tirar dúvidas: os profissionais interessados enviam *perguntas* no seu pedido, você recebe uma notificação e responde por lá. As perguntas e respostas ficam no seu pedido e vão deixando tudo mais claro para todos.\n\nPor isso, pedimos que você *retire seu telefone da descrição*. E mesmo que combine algo com um profissional pelo WhatsApp, peça para ele *manifestar interesse dentro do app* e sigam por lá. Assim *os dois ficam protegidos* pela plataforma.\n\nNo ProTudo, conferimos a identidade, os documentos e as *referências* de cada profissional. Em breve teremos *cursos* em todas as especialidades, e quem concluir ganha o selo de *especialista*, o que ajuda você na hora de escolher.\n\nQualquer dúvida, é só responder aqui. Obrigado por usar o ProTudo! 🧡`

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

module.exports = { RODAPE_SAIR, primeiroNome, textoPerguntas, textoNaoEntendi, TEXTO_NAO_ENTENDI_SEM_NUMERO, TEXTO_SO_ESCRITA, textoEntregue, textoNaoEntregue, lerNumeroInicial, listaNumeros,
  textoContatoNoTexto, tempoRestante, textoEspecialidadeRara, textoInteressados, linkAbrir, DICA_NOTIFICACOES, TEXTO_RESPOSTA_INTERESSADO }
