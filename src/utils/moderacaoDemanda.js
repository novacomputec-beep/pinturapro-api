// Proteção anti-anúncio das demandas NOVAS (POST /reparos/dono e POST /obras/dono).
//
// Dois efeitos, nesta ordem, nos dois creates:
//   1) REJEIÇÃO (400): texto (título + descrição) com pelo menos uma PALAVRA DE VENDA
//      (PALAVRAS_VENDA, comparadas sem acento/caixa) E valor zero/vazio. É o perfil do
//      anúncio de comida/loja publicado como "serviço" — o ProTudo é para contratar serviço,
//      não para vender. Mensagem única (MENSAGEM_REJEICAO) no formato { erro } que o app já
//      exibe; `codigo` segue a convenção do cadastro (chave estável para o app classificar).
//   2) SANITIZAÇÃO: telefones (8+ dígitos, com ou sem DDD/espaços/traços/pontos/parênteses),
//      e-mails e @handles, links (http/www/domínio.com...) e frases "chame no whatsapp/zap/
//      direct" viram "[contato removido]" no título e na descrição ANTES de gravar. O contato
//      é o que transforma o feed em classificado; o resto do texto fica como o dono escreveu.
//      Valores e quantidades ("R$ 150", "R$ 1.500,00", "2 lugares", "30 pessoas") não são
//      tocados: o telefone exige 8+ dígitos no trecho, nunca precedido de R$, e o padrão de
//      CEP (5-3) fica de fora.
//
// Qualquer uma das duas ações avisa EMAIL_MODERACAO por e-mail (fire-and-forget, erro só em
// log) com o texto ORIGINAL, o lado, o dono e o que foi feito — para o admin rever e, se for
// falso positivo, ajustar as listas aqui. Sem banco, sem estado: funções puras + um envio.
const { enviarEmail } = require('../services/brevoService')
const { normalizar } = require('./localidade')
const { MARCA } = require('./marca')

const EMAIL_MODERACAO = 'professorluizmelo@gmail.com'
const MENSAGEM_REJEICAO = 'O ProTudo é para contratar serviços. Anúncios e vendas não são permitidos.'
const CODIGO_REJEICAO = 'anuncio_nao_permitido'
const MARCA_CONTATO = '[contato removido]'

// Palavras de venda — comparadas sobre o texto DOBRADO (normalizar: minúsculas, sem acento,
// espaços colapsados). Prefixo quando o plural/derivado também é venda (promocao/promocoes);
// palavra inteira quando o prefixo colide com vocabulário de obra ("combo" × combogó,
// "vendo" × "revendo"). "marmita" e "encomenda" SOZINHAS ficam de fora de propósito: pedido
// legítimo de confeiteiro/cozinheiro usa as duas ("encomenda de bolo", "fazer marmitas da
// semana"). O que denuncia venda é a FRASE voltada ao comprador: "faca sua encomenda",
// "faca seu pedido", "pedidos pelo".
const PALAVRAS_VENDA = [
  /\bcardapio/, /\bdelivery/, /\bpromoc(ao|oes)\b/, /\bcombos?\b/, /\bvendo\b/,
  /\bfaca sua encomenda\b/, /\bfaca seu pedido\b/, /\bpedidos pelo\b/,
]

// Padrões de contato, aplicados ao texto ORIGINAL (a troca precisa preservar o resto como o
// dono escreveu, então não dá para dobrar o texto antes). Ordem importa: e-mail antes do
// @handle (senão sobra "joao" + "[contato removido]" com domínio solto), URL com esquema
// antes do domínio nu.
const RE_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi
const RE_HANDLE = /(?<![\w.])@[a-z0-9_.]{2,}/gi
const RE_URL = /\bhttps?:\/\/\S+|\bwww\.\S+/gi
const RE_DOMINIO = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com(?:\.br)?|net|org|app|io|me|bio|link|site|store|shop)\b(?:\/\S*)?/gi
// "chame no whatsapp", "me chama no zap", "manda mensagem no direct", "fale pelo insta",
// "whatsapp:" / "zap:" — acentos opcionais no próprio padrão (texto não dobrado).
const CANAIS = '(?:whats\\s?app|whats|wpp|zap|direct|insta(?:gram)?|telegram|messenger|dm)'
const RE_CHAME = new RegExp(
  `\\b(?:me\\s+)?(?:chame|chama|chamar|fale|fala|falar|manda|mande|mandar|envie|envia|enviar)` +
  `(?:\\s+(?:uma\\s+)?(?:mensagem|msg|mens))?\\s+(?:no|na|pelo|pela|via|por|em)\\s+(?:o\\s+|a\\s+)?${CANAIS}\\b`, 'gi')
const RE_CANAL_DOIS_PONTOS = new RegExp(`\\b${CANAIS}\\s*[:：]`, 'gi')

// Telefone: trecho de dígitos com separadores opcionais, 8+ dígitos no total. O lookbehind
// recusa "R$ 15.000.000" (valor) e o teste de CEP recusa "38700-000".
const RE_TELEFONE = /(?<!R\$\s{0,3})(?<![\d,.])\+?\(?\d(?:[\d\s().-]*\d)?(?![\d,.])/g
const RE_CEP = /^\d{5}-?\d{3}$/
const contarDigitos = (s) => (s.match(/\d/g) || []).length

const removerContatos = (texto) => {
  let t = texto
  t = t.replace(RE_EMAIL, MARCA_CONTATO)
  t = t.replace(RE_HANDLE, MARCA_CONTATO)
  t = t.replace(RE_URL, MARCA_CONTATO)
  t = t.replace(RE_DOMINIO, MARCA_CONTATO)
  t = t.replace(RE_CHAME, MARCA_CONTATO)
  t = t.replace(RE_CANAL_DOIS_PONTOS, MARCA_CONTATO)
  t = t.replace(RE_TELEFONE, (m) => {
    const limpo = m.trim()
    if (contarDigitos(limpo) < 8) return m
    if (RE_CEP.test(limpo)) return m
    return MARCA_CONTATO
  })
  return t
}

// Só string é sanitizada; qualquer outro tipo (undefined/null/número) volta intacto para o
// create tratar como já trata (validação dos creates segue deferida, não é daqui).
const sanitizarTexto = (v) => (typeof v === 'string' ? removerContatos(v) : v)

const valorVazio = (v) => {
  if (v === undefined || v === null) return true
  if (typeof v === 'string' && !v.trim()) return true
  const n = Number(typeof v === 'string' ? v.replace(',', '.') : v)
  return !Number.isFinite(n) || n <= 0
}

const palavrasDeVenda = (texto) => {
  const dobrado = normalizar(texto)
  return PALAVRAS_VENDA.filter(re => re.test(dobrado)).map(re => re.source.replace(/\\b|\\s|[()?|]/g, '').replace('aooes', 'ao'))
}

// Avalia uma demanda nova. Devolve:
//   { rejeitar: true,  motivo, palavras }                       → responder 400
//   { rejeitar: false, titulo, descricao, sanitizado: [...] }   → gravar titulo/descricao
// sanitizado lista os campos que mudaram ([] = nada mudou, nada a avisar).
const moderarDemanda = ({ titulo, descricao, valor }) => {
  const texto = [titulo, descricao].filter(t => typeof t === 'string').join('\n')
  const palavras = palavrasDeVenda(texto)
  if (palavras.length > 0 && valorVazio(valor)) {
    return { rejeitar: true, motivo: 'palavra de venda + valor zero/vazio', palavras }
  }
  const tituloS = sanitizarTexto(titulo)
  const descricaoS = sanitizarTexto(descricao)
  const sanitizado = []
  if (tituloS !== titulo) sanitizado.push('titulo')
  if (descricaoS !== descricao) sanitizado.push('descricao')
  return { rejeitar: false, titulo: tituloS, descricao: descricaoS, sanitizado }
}

const escaparHtml = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
const pre = (s) => `<pre style="white-space:pre-wrap;background:#f4f4f4;padding:8px;border-radius:4px">${escaparHtml(s)}</pre>`

// Aviso ao moderador. Nunca lança e nunca é aguardado pelo request: erro vira log.
// original = { titulo, descricao, valor } como chegaram no body; resultado = retorno de
// moderarDemanda; lado = 'reparo' | 'obra'; dono = { id, nome, email }.
const avisarModeracao = ({ lado, dono, original, resultado }) => {
  const acao = resultado.rejeitar
    ? `REJEITADA (400) — ${resultado.motivo}: ${resultado.palavras.join(', ')}`
    : `SANITIZADA — campos alterados: ${resultado.sanitizado.join(', ')}`
  const assunto = `[${MARCA} moderação] ${resultado.rejeitar ? 'Anúncio rejeitado' : 'Contato removido'} — ${lado}`
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 700px">
      <h2>${escaparHtml(acao)}</h2>
      <p><b>Lado:</b> ${escaparHtml(lado)}<br>
         <b>Dono:</b> ${escaparHtml(dono?.nome || '')} &lt;${escaparHtml(dono?.email || '')}&gt; (${escaparHtml(dono?.id || '')})<br>
         <b>Valor informado:</b> ${escaparHtml(original.valor ?? '(vazio)')}</p>
      <p><b>Título original:</b></p>${pre(original.titulo)}
      <p><b>Descrição original:</b></p>${pre(original.descricao)}
      ${resultado.rejeitar ? '' : `<p><b>Título gravado:</b></p>${pre(resultado.titulo)}<p><b>Descrição gravada:</b></p>${pre(resultado.descricao)}`}
    </div>`
  enviarEmail({ para: EMAIL_MODERACAO, assunto, html })
    .catch(err => console.error(`[Moderacao] falha ao avisar ${EMAIL_MODERACAO} (${lado}):`, err.message))
}

module.exports = {
  moderarDemanda,
  avisarModeracao,
  sanitizarTexto,
  MENSAGEM_REJEICAO,
  CODIGO_REJEICAO,
  MARCA_CONTATO,
  EMAIL_MODERACAO,
  PALAVRAS_VENDA,
}
