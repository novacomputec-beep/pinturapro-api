// PRAZO CURTO × TEXTO QUE FALA DE OUTRO DIA (dono, 26/11/2026 — arte "prazo-curto-previa-v2").
// Ao publicar (POST /reparos/dono, POST /obras/dono): prazo escolhido de 4 horas ou menos E o
// título/descrição menciona um momento FUTURO ("amanhã", "semana que vem", "sábado", "dia 15",
// "12/12", "dezembro", "antes do Natal"…) → 409 PRAZO_INCOERENTE com o trecho achado e o rótulo do
// prazo escolhido, NADA gravado. Só para o app que manda suporta_prazo_check: true; com
// confirmar_prazo: true publica como escolhido. App antigo (sem o campo): nada muda.
// A faixa "Hoje" (prazo_modo 'hoje') não entra: ela é o fim do dia, não uma janela de horas.
// Funções puras, sem banco.
const { dobrar } = require('./contatoNoTexto')

const CODIGO_PRAZO_INCOERENTE = 'PRAZO_INCOERENTE'
const PRAZO_CURTO_HORAS = 4
const MAX_TRECHO = 80

const MESES = 'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro'
const SEMANA = 'segunda|terca|quarta|quinta|sexta'
// Sobre o texto DOBRADO (minúsculas, sem acento, alinhado ao original). O primeiro que casar mais
// cedo no texto é o trecho devolvido.
const PADROES = [
  /\bdepois\s+de\s+amanha\b/g, /\bamanha\b/g,
  /\b(?:mes|semana|ano)\s+que\s+vem\b/g, /\bproxim[ao]s?\s+(?:mes|semana|ano|dias?|fim\s+de\s+semana|final\s+de\s+semana|feriado)\b/g,
  /\b(?:fim|final)\s+de\s+semana\b/g, /\bfds\b/g,
  /\bsabados?\b/g, /\bdomingos?\b/g,
  // Dia útil: com "-feira", ou precedido de preposição/determinante — "segunda demão" e "quarta
  // parede" não são dia.
  new RegExp(`\\b(?:${SEMANA})[\\s-]feira\\b`, 'g'),
  new RegExp(`\\b(?:n[ao]|nest[ae]|ness[ae]|est[ae]|ess[ae]|proxim[ao]|ate|para|pra|pro|toda|todo|cada)\\s+(?:${SEMANA})\\b(?!\\s+(?:demao|mao|vez|parte|parede|etapa|camada|opcao|via|porta|andar|fase|pintura|casa|sala|unidade|feira))`, 'g'),
  // dd/mm — menos a fração de medida ("3/4 de polegada", 1/2").
  /\bdia\s+\d{1,2}\b/g, /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b(?!\s*(?:de\s+)?(?:polegadas?|pol\b|"))/g,
  new RegExp(`\\b(?:\\d{1,2}\\s+de\\s+)?(?:${MESES})\\b`, 'g'),
  /\b(?:antes|depois|ate|para|pra|pro)\s+(?:d[oa]s?\s+|o\s+|a\s+)?(?:natal|ano\s+novo|reveillon|virada|carnaval|pascoa|feriado|ferias)\b/g,
  /\b(?:natal|ano\s+novo|reveillon|carnaval|pascoa)\b/g,
  /\bdaqui\s+(?:a\s+)?(?:\d+|um|uma|dois|duas|tres|alguns|algumas|uns|umas)\s+(?:dias?|semanas?|mes|meses)\b/g,
  /\bem\s+(?:\d+|dois|duas|tres)\s+(?:dias|semanas|meses)\b/g,
]

// O primeiro trecho do texto que fala de um momento futuro (como foi escrito), ou null.
const encontrarTempoFuturo = (...textos) => {
  const original = textos.filter(t => typeof t === 'string' && t).join('\n').normalize('NFC')
  if (!original) return null
  const f = dobrar(original)
  let melhor = null
  for (const re of PADROES) {
    re.lastIndex = 0
    const m = re.exec(f)
    if (m && (!melhor || m.index < melhor.inicio || (m.index === melhor.inicio && m[0].length > melhor.fim - melhor.inicio))) melhor = { inicio: m.index, fim: m.index + m[0].length }
  }
  return melhor ? original.slice(melhor.inicio, melhor.fim).trim().slice(0, MAX_TRECHO) : null
}

const rotuloPrazo = (horas) => (Number(horas) === 1 ? '1 hora' : `${Number(horas)} horas`)
const ligado = (v) => v === true || v === 'true'

// horas = prazo escolhido (reparo: prazo_atendimento_horas; obra: horas_para_expirar); modo =
// prazo_modo. Devolve null (publica) ou o corpo do 409.
const avaliarPrazoIncoerente = (body, { horas, modo, titulo, descricao }) => {
  if (!ligado(body?.suporta_prazo_check) || ligado(body?.confirmar_prazo)) return null
  if (modo === 'hoje') return null
  const h = Number(horas)
  if (!Number.isFinite(h) || h <= 0 || h > PRAZO_CURTO_HORAS) return null
  const trecho = encontrarTempoFuturo(titulo, descricao)
  if (!trecho) return null
  const prazo_rotulo = rotuloPrazo(h)
  return {
    erro: `Você escolheu o prazo de ${prazo_rotulo}, mas o pedido fala em "${trecho}". Depois desse prazo o pedido sai do ar. Confirme o prazo ou escolha um maior.`,
    codigo: CODIGO_PRAZO_INCOERENTE, prazo_incoerente: true, trecho, prazo_rotulo, prazo_horas: h,
  }
}

module.exports = { CODIGO_PRAZO_INCOERENTE, PRAZO_CURTO_HORAS, encontrarTempoFuturo, rotuloPrazo, avaliarPrazoIncoerente }
