// Resumo de pedidos abertos de uma cidade no formato do WhatsApp (GET /admin/canal/resumo).
// Texto pronto para colar num canal/grupo: cabeçalho, um bloco por demanda, rodapé.
//
// Só entra o que já é público no feed do app e não identifica o cliente: título, categoria
// (RÓTULO do mapa de categoriasApp, nunca o slug cru), bairro, valor e o link da página
// pública (protudo.app.br/p/<codigo_publico>, routes/paginaPublica.js — que também só mostra
// o que é público). Nome, telefone, endereço, ponto de referência e descrição NUNCA passam
// por aqui — a consulta da rota nem os seleciona, e esta função só lê os campos abaixo.
//
// Emoji por categoria vem do mesmo mapa do push (categoriasApp); categoria fora do mapa
// cai no emoji padrão do lado (🔧 serviço / 🏗️ obra) e no rótulo genérico do lado.
const { apresentacaoReparo, apresentacaoObra } = require('./categoriasApp')
const { MARCA } = require('./marca')

const MAX_ITENS = 15
const FUSO = 'America/Sao_Paulo'
// Link curto da página pública da demanda, sem https:// (o WhatsApp já reconhece e o texto
// fica mais limpo). Linha omitida quando a linha do banco ainda não tem código.
const PREFIXO_LINK_PUBLICO = 'protudo.app.br/p/'
const RE_CODIGO_PUBLICO = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/

const LADOS = {
  reparo: { emojiPadrao: '🔧', rotuloPadrao: 'Serviço', apresentar: apresentacaoReparo },
  obra:   { emojiPadrao: '🏗️', rotuloPadrao: 'Obra',    apresentar: apresentacaoObra },
}

// Rótulo e emoji de uma categoria. apresentacao*() devolve o slug cru quando não conhece o
// slug; aqui isso vira o rótulo genérico do lado — slug nunca aparece no canal.
const categoriaApresentada = (tipo, slug) => {
  const lado = LADOS[tipo]
  const { emoji, rotulo } = lado.apresentar(slug, lado.emojiPadrao)
  const conhecido = rotulo != null && rotulo !== String(slug)
  return { emoji, rotulo: conhecido ? rotulo : lado.rotuloPadrao }
}

// Título numa linha só, sem asteriscos/underscores que quebrariam a formatação do WhatsApp,
// com a primeira letra em maiúscula (o resto fica como o dono digitou).
const limparTitulo = (s) => {
  const t = String(s || '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim()
  if (!t) return 'Pedido'
  return t.charAt(0).toLocaleUpperCase('pt-BR') + t.slice(1)
}
const limparBairro = (s) => String(s || '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim()

const formatarValor = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

// "quinta-feira, 15/10" no fuso de São Paulo.
const linhaData = (agora = new Date()) => {
  const dia = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: FUSO }).format(agora)
  const ddmm = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: FUSO }).format(agora)
  return `${dia}, ${ddmm}`
}

// itens: [{ tipo: 'reparo'|'obra', titulo, categoria, bairro, valor, criado_em, codigo_publico }],
// em qualquer ordem — aqui ordena por criado_em desc e corta em MAX_ITENS. Devolve
// { texto, total }, onde total é o número de pedidos abertos ENCONTRADOS (antes do corte).
// Bloco por demanda: título, linha de categoria/bairro/valor e, logo abaixo, a linha
// "👉 protudo.app.br/p/<codigo>" (só quando há codigo_publico válido).
const montarResumoCanal = ({ cidade, itens, agora = new Date() }) => {
  const ordenados = [...itens].sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em))
  const exibidos = ordenados.slice(0, MAX_ITENS)

  const linhas = [
    `📋 *Pedidos abertos hoje – ${String(cidade || '').trim()}*`,
    `_${linhaData(agora)}_`,
    '',
  ]
  if (exibidos.length === 0) {
    linhas.push('Nenhum pedido aberto no momento.', '')
  }
  for (const it of exibidos) {
    const { emoji, rotulo } = categoriaApresentada(it.tipo, it.categoria)
    const partes = [rotulo]
    const bairro = limparBairro(it.bairro)
    if (bairro) partes.push(`Bairro ${bairro}`)
    const valor = formatarValor(it.valor)
    if (valor) partes.push(`💰 R$ ${valor}`)
    linhas.push(`${emoji} *${limparTitulo(it.titulo)}*`, partes.join(' · '))
    const codigo = String(it.codigo_publico || '').trim().toUpperCase()
    if (RE_CODIGO_PUBLICO.test(codigo)) linhas.push(`👉 ${PREFIXO_LINK_PUBLICO}${codigo}`)
    linhas.push('')
  }
  linhas.push(
    `👉 Para responder, abra o app *${MARCA}* (aba Serviços ou Obras).`,
    'Ainda não tem? protudo.app.br/baixar',
  )
  return { texto: linhas.join('\n'), total: ordenados.length }
}

module.exports = { montarResumoCanal, MAX_ITENS }
