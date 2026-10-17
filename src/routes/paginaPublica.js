// Página PÚBLICA de uma demanda — GET /p/:codigo (montada em server.js FORA de /api, para o
// link ser curto e, no futuro, poder ganhar domínio próprio apontando para o Railway).
//
// Para que serve: o link que o canal do WhatsApp / o profissional compartilha. Quem abre vê o
// suficiente para decidir "quero esse pedido" e um botão que abre o app (Android: intent: com
// o pacote do app e browser_fallback_url para a Play Store, então abre o app instalado ou cai
// na loja; iOS: App Store). Sem JavaScript (o CSP do helmet bloqueia inline) — a escolha do
// link é por User-Agent no servidor.
//
// O QUE NUNCA SAI DAQUI: nome, telefone, endereço (rua/número), descrição e fotos do cliente.
// O SELECT lista as colunas uma a uma de propósito; não há `SELECT *`, e `bairro` é o nível
// mais fino de local exibido. Título é texto do dono: escapado antes de ir ao HTML.
//
// Estados: ABERTA (status aberta + aprovada + sem match + não expirada) → card completo, faixa
// "ninguém respondeu ainda" só quando há ZERO interesses; ENCERRADA (qualquer outro estado) e
// CÓDIGO DESCONHECIDO → variante apagada (card cinza, título riscado, só a cidade, botão "Ver
// pedidos abertos no app"). Código desconhecido responde 404 com a mesma página.
//
// OG (WhatsApp/Telegram preview): título, "Pedido aberto em <cidade> · R$ <valor>" e o logo
// servido por /p/logo.png (preview não aceita data URI). Na própria página o logo vai inline
// (base64) para o HTML ser auto-suficiente. noindex: página de demanda não é para buscador.
const express = require('express')
const fs = require('fs')
const path = require('path')
const { pool } = require('../utils/supabase')
const { MARCA } = require('../utils/marca')
const { apresentacaoReparo, apresentacaoObra } = require('../utils/categoriasApp')
const { PRAZO_MODO_HOJE } = require('../utils/faixasPrazo')

const router = express.Router()

const PACOTE_ANDROID = 'com.pinturapro.app'
const URL_PLAY = `https://play.google.com/store/apps/details?id=${PACOTE_ANDROID}`
const URL_APP_STORE = 'https://apps.apple.com/br/app/id6807459250'
// O app ainda NÃO registra URL scheme/deep link. Enquanto isso, o botão laranja é "Baixar o
// ProTudo" e vai à LOJA por aparelho; a linha abaixo dele orienta quem já tem o app. Quando o
// build com scheme sair, virar APP_TEM_SCHEME para true: o botão volta a "Abrir no app" com o
// intent: do Android (pacote + fallback para a Play Store) — o construtor fica pronto abaixo.
const APP_TEM_SCHEME = false
// Sem scheme próprio: action MAIN + category LAUNCHER abre a atividade principal do pacote se
// instalado; senão o Chrome segue S.browser_fallback_url (Play Store).
const URL_INTENT_ANDROID = `intent:#Intent;package=${PACOTE_ANDROID};action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;S.browser_fallback_url=${encodeURIComponent(URL_PLAY)};end`

// Ícone (quadrado): imagem do preview OG (/p/logo.png). Wordmark completo (ícone + "Pro" azul +
// "Tudo" laranja + tagline, versão clara para fundo escuro — a mesma do cabeçalho de
// protudo.app.br): banner da página, inline em base64.
const LOGO_PNG = fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo-protudo.png'))
const WORDMARK_DATA_URI = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo-protudo-wordmark.png')).toString('base64')}`
// Laranja da marca (o mesmo --or do site) sobre texto escuro.
const LARANJA = '#F5891F'
const TEXTO_ESCURO = '#111'

// Mesmo alfabeto de gerar_codigo_publico() (migração em routes/index.js).
const RE_CODIGO = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/
const TZ = 'America/Sao_Paulo'

const LADOS = [
  { tabela: 'reparos', colunaValor: 'valor_estimado', janelaCol: 'prazo_atendimento_horas', aba: 'Serviços',
    apresentacao: apresentacaoReparo, emojiPadrao: '🔧',
    interesses: `(SELECT count(*) FROM interesse_reparos i WHERE i.reparo_id = d.id)` },
  { tabela: 'obras', colunaValor: 'valor', janelaCol: 'horas_para_expirar', aba: 'Obras',
    apresentacao: apresentacaoObra, emojiPadrao: '🎨',
    interesses: `(SELECT count(*) FROM candidaturas c WHERE c.obra_id = d.id)` },
]

// Procura o código nos dois lados (único entre as tabelas por construção). Só colunas seguras.
// db (opcional): client/transação do chamador — o dry-run roda num BEGIN…ROLLBACK.
const buscarDemanda = async (codigo, db = pool) => {
  for (const lado of LADOS) {
    const r = await db.query(
      `SELECT d.titulo, d.categoria, d.cidade, d.uf, d.bairro, d.${lado.colunaValor} AS valor,
              d.${lado.janelaCol} AS janela_horas, d.prazo_modo, d.expira_em,
              (d.status = 'aberta' AND d.status_aprovacao = 'aprovada'
               AND d.match_usuario_id IS NULL AND d.expira_em > NOW()) AS aberta,
              ${lado.interesses}::int AS interesses
         FROM ${lado.tabela} d WHERE d.codigo_publico = $1`,
      [codigo]
    )
    if (r.rows.length > 0) return { lado, demanda: r.rows[0] }
  }
  return null
}

const escapar = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
// Chip da categoria como na lista do app: "🧹 Faxina" (emoji + rótulo de categoriasApp, nos
// dois lados). Slug fora do catálogo: emoji padrão do lado + slug cru; sem slug: só o genérico.
const chipCategoria = (lado, slug) => {
  const { emoji, rotulo } = lado.apresentacao(slug, lado.emojiPadrao)
  return `${emoji} ${rotulo || (lado.tabela === 'obras' ? 'Obra' : 'Serviço')}`
}
const formatarValor = (v) => {
  const n = Number(v)
  if (!(n > 0)) return null
  return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}
const ROTULOS_JANELA = { 1: '1 hora', 2: '2 horas', 4: '4 horas', 8: '8 horas', 12: '12 horas', 24: '1 dia', 168: '1 semana', 720: '30 dias', 1440: '60 dias', 2160: '90 dias' }
const dataCurta = (d) => new Date(d).toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' })
// Rótulo do prazo: faixa "Hoje", faixa fixa pelo nome, ou "até dd/mm" para janela calculada
// ("Defina a data") que não bate com nenhuma faixa.
const rotuloPrazo = ({ janela_horas, prazo_modo, expira_em }) => {
  if (prazo_modo === PRAZO_MODO_HOJE) return 'Hoje'
  const h = Number(janela_horas)
  if (ROTULOS_JANELA[h]) return ROTULOS_JANELA[h]
  return `até ${dataCurta(expira_em)}`
}
const tempoRestante = (expira_em) => {
  const ms = new Date(expira_em).getTime() - Date.now()
  if (ms <= 0) return 'encerrando'
  const min = Math.floor(ms / 60000), h = Math.floor(min / 60), dias = Math.floor(h / 24)
  if (dias >= 2) return `faltam ${dias} dias`
  if (dias === 1) return `falta 1 dia e ${h - 24}h`
  if (h >= 1) return `faltam ${h}h${min % 60 ? ` ${min % 60}min` : ''}`
  return `faltam ${min} min`
}
// Loja por aparelho: iOS → App Store; Android e desktop/outros → Play Store (na web).
const linkLoja = (ua = '') => (/iPhone|iPad|iPod/i.test(ua) ? URL_APP_STORE : URL_PLAY)
// Link do botão. Com scheme: Android abre o app via intent: (fallback na Play Store); iOS não
// tem fallback de loja num link só, então vai à App Store. Sem scheme: sempre a loja.
const linkAbrirApp = (ua = '') => {
  if (APP_TEM_SCHEME && /Android/i.test(ua)) return URL_INTENT_ANDROID
  return linkLoja(ua)
}
// Texto do botão e linha de apoio abaixo dele, por variante. `aba` = 'Serviços' | 'Obras' na
// aberta; null na encerrada ("veja os pedidos abertos").
const botaoEApoio = ({ ua, aba }) => {
  const href = linkAbrirApp(ua)
  const ondeVer = aba ? `veja na aba ${aba}` : 'veja os pedidos abertos'
  if (APP_TEM_SCHEME) {
    return { href, texto: aba ? `Abrir no app ${MARCA}` : 'Ver pedidos abertos no app', apoio: aba ? `O pedido está na aba ${aba}` : null }
  }
  return { href, texto: `Baixar o ${MARCA}`, apoio: `Já tem o app? Abra o ${MARCA} e ${ondeVer}` }
}

const CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f3f3f3;color:#111;-webkit-text-size-adjust:100%}
  .banner{background:#0a0a0a;padding:16px;display:flex;align-items:center;justify-content:center}
  .banner img{height:64px;width:auto;max-width:100%}
  main{max-width:520px;margin:0 auto;padding:20px 16px 32px}
  .kicker{display:inline-block;font-size:12px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:${TEXTO_ESCURO};background:${LARANJA};border-radius:6px;padding:4px 8px}
  .kicker.off{color:#fff;background:#777}
  h1{font-size:22px;line-height:1.25;margin:6px 0 16px;color:#111}
  .card{background:#fff;border-radius:14px;padding:18px 16px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
  .card.off{background:#e6e6e6;color:#666;box-shadow:none}
  .chip{display:inline-block;background:#fff1e6;color:#9a4a0a;border-radius:999px;padding:4px 10px;font-size:13px;font-weight:700}
  .card.off .chip{background:#d8d8d8;color:#666}
  .titulo{font-size:19px;font-weight:800;margin:12px 0 8px;line-height:1.3;word-break:break-word}
  .card.off .titulo{text-decoration:line-through;color:#555}
  .linha{font-size:15px;color:#444;margin:4px 0}
  .card.off .linha{color:#777}
  .valor{font-size:24px;font-weight:800;color:#111;margin-top:12px}
  .faixa{margin-top:14px;border:2px dashed ${LARANJA};border-radius:10px;padding:10px 12px;color:#9a4a0a;font-weight:700;font-size:14px;background:#fff8f2}
  .btn{display:block;text-align:center;background:${LARANJA};color:${TEXTO_ESCURO};font-weight:800;font-size:17px;text-decoration:none;border-radius:12px;padding:15px 16px;margin:20px 0 12px}
  .aba{text-align:center;color:#555;font-size:14px}
  .lojas{display:flex;gap:10px;justify-content:center;margin:18px 0 6px}
  .loja{flex:1;max-width:190px;display:flex;align-items:center;justify-content:center;gap:8px;background:#0a0a0a;color:#fff;text-decoration:none;border-radius:10px;padding:10px 12px;font-size:13px;font-weight:700}
  .loja small{display:block;font-weight:400;font-size:10px;opacity:.8}
  footer{margin-top:22px;text-align:center;color:#777;font-size:12.5px;line-height:1.45}
`

const badgesLojas = () => `
      <div class="lojas">
        <a class="loja" href="${URL_PLAY}" rel="noopener">▶ <span><small>DISPONÍVEL NO</small>Google Play</span></a>
        <a class="loja" href="${URL_APP_STORE}" rel="noopener"> <span><small>BAIXAR NA</small>App Store</span></a>
      </div>`

const paginaHtml = ({ og, kicker, kickerOff, heading, card, botao, base }) => `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapar(og.titulo)} · ${MARCA}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="${MARCA}">
<meta property="og:title" content="${escapar(og.titulo)}">
<meta property="og:description" content="${escapar(og.descricao)}">
<meta property="og:image" content="${base}/p/logo.png">
<meta property="og:url" content="${escapar(og.url)}">
<meta name="twitter:card" content="summary">
<style>${CSS}</style>
</head>
<body>
  <div class="banner"><img src="${WORDMARK_DATA_URI}" alt="${MARCA} — Profissionais para tudo"></div>
  <main>
    <div class="kicker${kickerOff ? ' off' : ''}">${escapar(kicker)}</div>
    <h1>${escapar(heading)}</h1>
    ${card}
    <a class="btn" href="${botao.href}">${escapar(botao.texto)}</a>
    ${botao.apoio ? `<p class="aba">${escapar(botao.apoio)}</p>` : ''}
    ${badgesLojas()}
    <footer>Nome, telefone e endereço do cliente só aparecem no app, depois que vocês combinarem.</footer>
  </main>
</body>
</html>`

const renderAberta = ({ lado, demanda, base, url, ua }) => {
  const valor = formatarValor(demanda.valor)
  const local = [demanda.bairro, demanda.cidade].filter(s => s && String(s).trim()).join(' · ')
  return paginaHtml({
    base,
    og: { titulo: demanda.titulo, descricao: `Pedido aberto em ${demanda.cidade} · ${valor || 'Valor a combinar'}`, url },
    kicker: `Pedido aberto · ${demanda.cidade}`,
    heading: 'Tem cliente esperando por um profissional!',
    card: `
    <div class="card">
      <span class="chip">${escapar(chipCategoria(lado, demanda.categoria))}</span>
      <div class="titulo">${escapar(demanda.titulo)}</div>
      <div class="linha">📍 ${escapar(local)}</div>
      <div class="linha">⏱ Prazo: ${escapar(rotuloPrazo(demanda))} · ${escapar(tempoRestante(demanda.expira_em))}</div>
      <div class="valor">${escapar(valor || 'Valor a combinar')}</div>
      ${demanda.interesses === 0 ? '<div class="faixa">Ninguém respondeu ainda — chegue primeiro!</div>' : ''}
    </div>`,
    botao: botaoEApoio({ ua, aba: lado.aba }),
  })
}

const renderEncerrada = ({ lado, demanda, base, url, ua }) => {
  const cidade = demanda?.cidade || ''
  const titulo = demanda?.titulo || 'Este pedido não está mais disponível'
  return paginaHtml({
    base,
    og: { titulo: 'Pedido encerrado', descricao: cidade ? `Veja os pedidos abertos em ${cidade} no app ${MARCA}` : `Veja os pedidos abertos no app ${MARCA}`, url },
    kicker: cidade ? `Pedido encerrado · ${cidade}` : 'Pedido encerrado',
    kickerOff: true,
    heading: 'Este pedido já foi atendido ou expirou.',
    card: `
    <div class="card off">
      ${lado ? `<span class="chip">${escapar(chipCategoria(lado, demanda.categoria))}</span>` : ''}
      <div class="titulo">${escapar(titulo)}</div>
      ${cidade ? `<div class="linha">📍 ${escapar(cidade)}</div>` : ''}
    </div>`,
    botao: botaoEApoio({ ua, aba: null }),
  })
}

router.get('/logo.png', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400')
  res.type('png').send(LOGO_PNG)
})

router.get('/:codigo', async (req, res) => {
  const codigo = String(req.params.codigo || '').trim().toUpperCase()
  const base = `${req.protocol}://${req.get('host')}`
  const url = `${base}/p/${encodeURIComponent(codigo)}`
  const ua = req.get('user-agent') || ''
  res.set('Cache-Control', 'no-cache')
  res.type('html')
  try {
    const achado = RE_CODIGO.test(codigo) ? await buscarDemanda(codigo) : null
    if (!achado) return res.status(404).send(renderEncerrada({ base, url, ua }))
    const { lado, demanda } = achado
    return res.send(demanda.aberta ? renderAberta({ lado, demanda, base, url, ua }) : renderEncerrada({ lado, demanda, base, url, ua }))
  } catch (err) {
    console.error(`[PaginaPublica] erro em /p/${codigo}:`, err.message)
    return res.status(500).send(renderEncerrada({ base, url, ua }))
  }
})

module.exports = router
// Só para teste/dry-run (render sem servidor): não são API pública do módulo.
module.exports._interno = { buscarDemanda, renderAberta, renderEncerrada, linkAbrirApp, botaoEApoio, RE_CODIGO, APP_TEM_SCHEME }
