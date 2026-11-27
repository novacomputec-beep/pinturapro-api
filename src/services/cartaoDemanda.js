// Cartão de COMPARTILHAMENTO de uma demanda (arte aprovada cards-fotos-previa-v2) e a legenda
// que vai junto. Servidos por routes/paginaPublica: GET /p/:codigo/cartao.png e /p/:codigo/legenda.
//
// Render: satori (layout flexbox → SVG, texto já convertido em curvas com as fontes embutidas)
// + resvg (SVG → PNG). Nada depende de fonte do sistema nem de rede: Montserrat (OFL, .woff) e
// os emojis Twemoji (CC-BY 4.0, SVG baixados por scripts/baixar-emojis-cartao.js) moram em
// src/assets/cartao/. Emoji sem arquivo some do desenho em vez de quebrar o render.
//
// Fundo: assets/cartoes/<grupo>.jpg (1080x1350) escurecendo para baixo em #0e0e10 passando pela
// cor do grupo; sem a foto do grupo, um degradê escuro na cor do grupo.
//
// O QUE NUNCA SAI DAQUI: nome, telefone e endereço do dono. Só entram título, categoria,
// bairro, cidade, valor e prazo — as mesmas colunas seguras de paginaPublica.buscarDemanda.
const fs = require('fs')
const path = require('path')
const QRCode = require('qrcode')
const { Resvg } = require('@resvg/resvg-js')
const { MARCA } = require('../utils/marca')
const { CHAVE_DO_SLUG } = require('../utils/gruposCategorias')
const { SLUGS_ELETRICOS } = require('../utils/etiquetasAvaliacao')
const { categoriasDoReparo, apresentacaoReparoLista, apresentacaoObra } = require('../utils/categoriasApp')

// satori é ESM com build CJS; o default vem em .default.
const satoriMod = require('satori')
const satori = satoriMod.default || satoriMod

const LARGURA = 1080
const ALTURA = 1350
const FUNDO = '#0e0e10'
const LARANJA = '#F5891F'
const AMARELO = '#FFD23F'
const DOMINIO = 'protudo.app.br'
const TTL_MS = 10 * 60 * 1000
const MAX_CACHE = 120
const HORAS_URGENTE = 12

const DIR_FOTOS = path.join(__dirname, '..', '..', 'assets', 'cartoes')
const DIR_CARTAO = path.join(__dirname, '..', 'assets', 'cartao')

// Grupo VISUAL do cartão (slug do arquivo de foto, rótulo, cor). É só apresentação: o casamento
// de push continua em gruposCategorias. Diferença deliberada: as especialidades elétricas
// (SLUGS_ELETRICOS) saem com a foto de "Elétrica e tecnologia", como nas etiquetas de avaliação.
const GRUPOS_CARTAO = {
  'obras-construcao-civil':   { rotulo: 'Obras de Construção Civil', cor: '#E07A2E' },
  'consertos-da-casa':        { rotulo: 'Consertos da casa',         cor: '#2F7DD1' },
  'limpeza-e-jardim':         { rotulo: 'Limpeza e jardim',          cor: '#2E9E5B' },
  'eletrica-e-tecnologia':    { rotulo: 'Elétrica e tecnologia',     cor: '#D9A400' },
  'beleza':                   { rotulo: 'Beleza',                    cor: '#D6457A' },
  'festas-e-eventos':         { rotulo: 'Festas e eventos',          cor: '#8E44D6' },
  'cuidar-de-alguem':         { rotulo: 'Cuidar de alguém',          cor: '#2FA39B' },
  'escritorio-e-aulas':       { rotulo: 'Escritório e aulas',        cor: '#4A5BD1' },
  'arte-e-criacao':           { rotulo: 'Arte e criação',            cor: '#C2459E' },
  'divulgacao-e-publicidade': { rotulo: 'Divulgação e publicidade',  cor: '#E0532E' },
  'transporte':               { rotulo: 'Transporte',                cor: '#5B7A99' },
  'seguranca':                { rotulo: 'Segurança',                 cor: '#3D5A80' },
  'outros':                   { rotulo: 'Outros serviços',           cor: LARANJA },
}
// Chave do grupo de push (CHAVE_DO_GRUPO) → slug visual.
const SLUG_DA_CHAVE = {
  reparos_casa: 'consertos-da-casa', limpeza: 'limpeza-e-jardim', beleza: 'beleza', festas: 'festas-e-eventos',
  cuidado: 'cuidar-de-alguem', transporte: 'transporte', seguranca: 'seguranca', digital_aulas: 'escritorio-e-aulas',
  arte: 'arte-e-criacao', divulgacao: 'divulgacao-e-publicidade', obras_construcao_civil: 'obras-construcao-civil',
}
const slugDoGrupoCartao = (tabela, demanda) => {
  if (tabela === 'obras') return 'obras-construcao-civil'
  const primeira = categoriasDoReparo(demanda)[0]
  if (!primeira) return 'outros'
  if (SLUGS_ELETRICOS.includes(primeira)) return 'eletrica-e-tecnologia'
  return SLUG_DA_CHAVE[CHAVE_DO_SLUG[primeira]] || 'outros'
}
const grupoDoCartao = (tabela, demanda) => {
  const slug = slugDoGrupoCartao(tabela, demanda)
  return { slug, ...GRUPOS_CARTAO[slug] }
}
// Emoji + rótulo da categoria, como no chip da página pública.
const categoriaDaDemanda = (tabela, demanda) => {
  const { emoji, rotulo } = tabela === 'reparos'
    ? apresentacaoReparoLista(demanda, '🔧')
    : apresentacaoObra(demanda?.categoria, '🎨')
  return { emoji, rotulo: rotulo || (tabela === 'obras' ? 'Obra' : 'Serviço') }
}

// ── Assets (lidos uma vez, sob demanda) ──────────────────────────────────────────────────────
let fontes = null
const carregarFontes = () => {
  if (!fontes) {
    fontes = [600, 700, 800, 900].map(weight => ({
      name: 'Montserrat', weight, style: 'normal',
      data: fs.readFileSync(path.join(DIR_CARTAO, 'fontes', `montserrat-${weight}.woff`)),
    }))
  }
  return fontes
}
// Logo: o "icon" de pinturapro-app/app.json, recortado (margem quase preta fora, folga pequena).
const ARQ_LOGO = path.join(__dirname, '..', '..', 'assets', 'cartao', 'logo-protudo.png')
// Arquivo já recortado (margem escura quase toda fora); altura fixa, largura pela proporção do PNG.
const ALTURA_LOGO = 230
let logo = null
const logoDoCartao = () => {
  if (!logo) {
    const buf = fs.readFileSync(ARQ_LOGO)
    const w = buf.readUInt32BE(16), hPng = buf.readUInt32BE(20) // IHDR
    logo = { uri: `data:image/png;base64,${buf.toString('base64')}`, largura: Math.round(ALTURA_LOGO * w / hPng), altura: ALTURA_LOGO }
  }
  return logo
}
// Versão do render: entra na chave do cache e no ?v= da URL do cartão (routes/paginaPublica
// redireciona para a URL com a versão atual). Deploy novo = versão nova = nenhum render antigo
// servido, nem do cache em memória nem de cache HTTP (WhatsApp, navegador). No Railway é o commit;
// fora dele, o instante do boot.
const VERSAO_CARTAO = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || Date.now().toString(36)
const fotos = new Map()
const fotoDoGrupo = (slug) => {
  if (!fotos.has(slug)) {
    const arq = path.join(DIR_FOTOS, `${slug}.jpg`)
    fotos.set(slug, fs.existsSync(arq) ? `data:image/jpeg;base64,${fs.readFileSync(arq).toString('base64')}` : null)
  }
  return fotos.get(slug)
}
// Nome de arquivo do Twemoji: codepoints em hex com '-', sem o FE0F (VS16) quando não há ZWJ.
const codigoTwemoji = (e) => {
  const s = e.includes('‍') ? e : e.replace(/️/g, '')
  return [...s].map(c => c.codePointAt(0).toString(16)).join('-')
}
const emojis = new Map()
const emojiDataUri = (segmento) => {
  const codigo = codigoTwemoji(segmento)
  if (!emojis.has(codigo)) {
    const arq = path.join(DIR_CARTAO, 'emoji', `${codigo}.svg`)
    emojis.set(codigo, fs.existsSync(arq) ? `data:image/svg+xml;base64,${fs.readFileSync(arq).toString('base64')}` : '')
  }
  return emojis.get(codigo)
}
const EMOJIS_FIXOS = ['💰', '📍', '⏰', '👇', '🔧', '🎨']

// ── Textos ───────────────────────────────────────────────────────────────────────────────────
// Link curto do pedido (QR e legenda). ref = código de indicação já normalizado ou null.
const linkPedido = (codigo, ref) => `${DOMINIO}/p/${codigo}${ref ? `?c=${ref}` : ''}`
const ehUrgente = (expira_em, agora = Date.now()) => new Date(expira_em).getTime() - agora <= HORAS_URGENTE * 3600 * 1000
const localDaDemanda = (d) => [d.bairro, d.cidade].map(s => (s == null ? '' : String(s).trim())).filter(Boolean).join(' · ')

// Legenda pronta para o WhatsApp (o * vira negrito lá). Bairro vazio não deixa "· ·".
const textoLegenda = ({ codigo, ref, emoji, titulo, bairro, cidade, valor, prazo }) => {
  const linha = [bairro, cidade].map(s => (s == null ? '' : String(s).trim())).filter(Boolean).join(' · ')
  return `👉 ${linkPedido(codigo, ref)}\n\n${emoji} *${String(titulo ?? '').trim()}*\n📍 ${linha} · 💰 ${valor} · ⏰ ${prazo}\n\n` +
    `Toque no link, baixe o ${MARCA} grátis e mande sua proposta. Sem comissão!`
}

// ── Layout (árvore satori; sem JSX) ──────────────────────────────────────────────────────────
const h = (type, style, ...children) => {
  const filhos = children.flat().filter(c => c !== null && c !== undefined && c !== false)
  return { type, props: { style, children: filhos.length === 0 ? undefined : filhos.length === 1 ? filhos[0] : filhos } }
}
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
const pill = (texto, { fundo = 'rgba(255,255,255,0.14)', borda = 'rgba(255,255,255,0.28)', cor = '#fff' } = {}) =>
  h('div', { display: 'flex', alignItems: 'center', background: fundo, border: `2px solid ${borda}`, borderRadius: 999,
    padding: '12px 26px', fontSize: 32, fontWeight: 700, color: cor, maxWidth: 968 }, texto)

const arvoreCartao = ({ grupo, foto, categoria, titulo, valor, local, prazo, urgente, qrDataUri }) => {
  const fundo = foto
    ? { type: 'img', props: { src: foto, width: LARGURA, height: ALTURA, style: { position: 'absolute', top: 0, left: 0, width: LARGURA, height: ALTURA, objectFit: 'cover' } } }
    : h('div', { position: 'absolute', top: 0, left: 0, width: LARGURA, height: ALTURA, display: 'flex',
        backgroundImage: `linear-gradient(160deg, ${rgba(grupo.cor, 0.95)} 0%, ${rgba(grupo.cor, 0.55)} 30%, ${FUNDO} 70%)` })
  const veu = h('div', { position: 'absolute', top: 0, left: 0, width: LARGURA, height: ALTURA, display: 'flex',
    backgroundImage: `linear-gradient(180deg, rgba(14,14,16,0.35) 0%, rgba(14,14,16,0) 18%, rgba(14,14,16,0) 30%, ${rgba(grupo.cor, 0.55)} 46%, ${rgba('#0e0e10', 0.92)} 58%, ${FUNDO} 66%, ${FUNDO} 100%)` })

  // Logo oficial 3D (o ícone do app, assets/cartao/logo-protudo.png), sem pílula atrás.
  const { uri: logoUri, largura: wLogo, altura: hLogo } = logoDoCartao()
  const logo = { type: 'img', props: { src: logoUri, width: wLogo, height: hLogo,
    style: { width: wLogo, height: hLogo, borderRadius: 40, boxShadow: '0 10px 32px rgba(0,0,0,0.5)' } } }
  const etiqueta = h('div', { display: 'flex', alignItems: 'center', background: LARANJA, color: '#fff', borderRadius: 999,
    padding: '16px 32px', fontSize: 34, fontWeight: 900, letterSpacing: 2, boxShadow: '0 6px 24px rgba(0,0,0,0.35)' },
    urgente ? 'URGENTE' : 'NOVO PEDIDO')
  const topo = h('div', { position: 'absolute', top: 48, left: 48, right: 48, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, logo, etiqueta)

  const botao = h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'center', flex: 1, background: LARANJA,
      borderRadius: 28, padding: '26px 30px', marginRight: 24, boxShadow: `0 0 44px ${rgba(LARANJA, 0.75)}` },
    h('div', { display: 'flex', fontSize: 37, fontWeight: 900, color: '#fff', lineHeight: 1.15 }, '👇 TOQUE NO LINK E MANDE SUA PROPOSTA'),
    h('div', { display: 'flex', fontSize: 23, fontWeight: 700, color: '#2a1300', marginTop: 12 }, 'É grátis · Sem comissão · Você define o preço'))
  const qr = h('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#fff', borderRadius: 24, padding: '16px 16px 12px' },
    { type: 'img', props: { src: qrDataUri, width: 196, height: 196, style: { width: 196, height: 196 } } },
    h('div', { display: 'flex', fontSize: 19, fontWeight: 700, color: '#333', marginTop: 8 }, 'ou aponte a câmera'))

  const base = h('div', { position: 'absolute', left: 56, right: 56, bottom: 52, display: 'flex', flexDirection: 'column' },
    h('div', { display: 'flex', fontSize: 40, fontWeight: 900, color: AMARELO, letterSpacing: 0.5 }, 'TEM SERVIÇO NA SUA CIDADE!'),
    h('div', { display: 'flex', fontSize: 30, fontWeight: 700, color: 'rgba(255,255,255,0.82)', marginTop: 14 },
      `${categoria.emoji} ${grupo.rotulo} · ${categoria.rotulo}`),
    h('div', { display: 'block', fontSize: 74, fontWeight: 900, color: '#fff', lineHeight: 1.1, marginTop: 14, lineClamp: 2, maxWidth: 968 }, titulo),
    h('div', { display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 26 },
      pill(`💰 ${valor}`), local ? pill(`📍 ${local}`) : null,
      pill(`⏰ ${prazo}`, { fundo: LARANJA, borda: LARANJA })),
    h('div', { display: 'flex', alignItems: 'stretch', marginTop: 32 }, botao, qr))

  return h('div', { width: LARGURA, height: ALTURA, display: 'flex', position: 'relative', background: FUNDO, fontFamily: 'Montserrat' },
    fundo, veu, topo, base)
}

// dados: { tabela, demanda (linha de buscarDemanda), codigo, ref, valor, prazo } → PNG (Buffer)
const renderizarCartao = async ({ tabela, demanda, codigo, ref, valor, prazo, agora = Date.now() }) => {
  const grupo = grupoDoCartao(tabela, demanda)
  const qrSvg = await QRCode.toString(`https://${linkPedido(codigo, ref)}`, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
  const arvore = arvoreCartao({
    grupo, foto: fotoDoGrupo(grupo.slug), categoria: categoriaDaDemanda(tabela, demanda),
    titulo: String(demanda.titulo ?? '').trim() || 'Pedido aberto', valor, local: localDaDemanda(demanda), prazo,
    urgente: ehUrgente(demanda.expira_em, agora),
    qrDataUri: `data:image/svg+xml;base64,${Buffer.from(qrSvg).toString('base64')}`,
  })
  const svg = await satori(arvore, {
    width: LARGURA, height: ALTURA, fonts: carregarFontes(),
    loadAdditionalAsset: async (code, segmento) => (code === 'emoji' ? emojiDataUri(segmento) : []),
  })
  return new Resvg(svg, { fitTo: { mode: 'width', value: LARGURA }, font: { loadSystemFonts: false } }).render().asPng()
}

// Cache em memória por (código, indicação): 10 min, no máximo MAX_CACHE entradas (a mais antiga
// sai primeiro). Guarda a PROMESSA, então pedidos simultâneos do mesmo cartão renderizam uma vez.
const cache = new Map()
const cartaoEmCache = (chave, gerar, agora = Date.now()) => {
  const item = cache.get(chave)
  if (item && item.expira > agora) return item.promessa
  for (const [k, v] of cache) if (v.expira <= agora) cache.delete(k)
  while (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
  const promessa = Promise.resolve().then(gerar)
  cache.set(chave, { expira: agora + TTL_MS, promessa })
  // Erro ou "não há cartão" (null: demanda fechada/desconhecida) não ficam no cache.
  const sair = () => { if (cache.get(chave)?.promessa === promessa) cache.delete(chave) }
  promessa.then(v => { if (v == null) sair() }, sair)
  return promessa
}

module.exports = { renderizarCartao, cartaoEmCache, textoLegenda, linkPedido, categoriaDaDemanda, grupoDoCartao, TTL_MS, VERSAO_CARTAO }
module.exports._interno = { GRUPOS_CARTAO, slugDoGrupoCartao, codigoTwemoji, EMOJIS_FIXOS, ehUrgente, cache, MAX_CACHE, fotoDoGrupo }
