// Vídeo "Como funciona" (YouTube) e seus capítulos — duas chaves em configuracoes, como as
// demais (valor TEXT; aqui o id cru e um JSON). Módulo quase inerte: só a leitura toca o banco.
//
//   video_como_funciona_id        → id do vídeo no YouTube ('' = sem vídeo publicado)
//   video_como_funciona_capitulos → JSON de [{ seg, titulo }], seg = segundo inicial do capítulo
//
// Quem escreve é só o admin (PUT /admin/video-como-funciona, em routes/index.js); quem lê é a
// rota pública (GET /api/publico/video-como-funciona). O seed do boot e a validação do PUT
// saem DAQUI, para o painel e a migração nunca divergirem sobre o que é um capítulo válido.
const CHAVE_VIDEO_ID = 'video_como_funciona_id'
const CHAVE_VIDEO_CAPITULOS = 'video_como_funciona_capitulos'

// Id de vídeo do YouTube: 11 caracteres de [A-Za-z0-9_-]. '' é aceito no PUT e significa
// "sem vídeo" (o app esconde a seção).
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

const CAPITULOS_PADRAO = [
  { seg: 0,   titulo: 'O que é o ProTudo e como nasceu' },
  { seg: 120, titulo: 'Baixar e se cadastrar' },
  { seg: 240, titulo: 'Quem contrata: pedir serviço ou obra' },
  { seg: 420, titulo: 'Quem trabalha: receber pedidos e propostas' },
  { seg: 600, titulo: 'Negociação, match e "Estou a caminho"' },
  { seg: 900, titulo: 'Segurança, gratuidade e preço' },
]

const CAPITULOS_MAX = 50
const TITULO_CAPITULO_MAX = 120

// Valida e NORMALIZA a lista de capítulos. Devolve { capitulos } (já limpos: seg inteiro,
// titulo sem espaços nas pontas, ordenados por seg) ou { erro } com a mensagem do 400.
// Exige: array não-vazio, seg inteiro >= 0 sem repetição, titulo não-vazio dentro do teto.
const validarCapitulos = (entrada) => {
  if (!Array.isArray(entrada) || entrada.length === 0) {
    return { erro: 'capitulos deve ser um array não-vazio de { seg, titulo }' }
  }
  if (entrada.length > CAPITULOS_MAX) {
    return { erro: `capitulos deve ter no máximo ${CAPITULOS_MAX} itens` }
  }
  const capitulos = []
  const segsVistos = new Set()
  for (let i = 0; i < entrada.length; i++) {
    const c = entrada[i]
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      return { erro: `capitulos[${i}] deve ser um objeto { seg, titulo }` }
    }
    const seg = Number(c.seg)
    if (!Number.isInteger(seg) || seg < 0) {
      return { erro: `capitulos[${i}].seg deve ser um inteiro >= 0 (segundos)` }
    }
    if (segsVistos.has(seg)) {
      return { erro: `capitulos[${i}].seg repetido (${seg})` }
    }
    const titulo = typeof c.titulo === 'string' ? c.titulo.trim() : ''
    if (!titulo) {
      return { erro: `capitulos[${i}].titulo é obrigatório` }
    }
    if (titulo.length > TITULO_CAPITULO_MAX) {
      return { erro: `capitulos[${i}].titulo deve ter no máximo ${TITULO_CAPITULO_MAX} caracteres` }
    }
    segsVistos.add(seg)
    capitulos.push({ seg, titulo })
  }
  capitulos.sort((a, b) => a.seg - b.seg)
  return { capitulos }
}

// Leitura das duas chaves em uma ida. JSON inválido ou ausente no banco cai nos capítulos
// padrão (e fica no log): a rota pública nunca responde 500 por um valor gravado à mão.
const lerVideoComoFunciona = async (db) => {
  const r = await db.query(
    `SELECT chave, valor FROM configuracoes WHERE chave IN ($1, $2)`,
    [CHAVE_VIDEO_ID, CHAVE_VIDEO_CAPITULOS]
  )
  const porChave = Object.fromEntries(r.rows.map(x => [x.chave, x.valor]))
  const video_id = VIDEO_ID_RE.test(porChave[CHAVE_VIDEO_ID] || '') ? porChave[CHAVE_VIDEO_ID] : ''
  let capitulos = CAPITULOS_PADRAO
  if (porChave[CHAVE_VIDEO_CAPITULOS]) {
    try {
      const v = validarCapitulos(JSON.parse(porChave[CHAVE_VIDEO_CAPITULOS]))
      if (v.capitulos) capitulos = v.capitulos
      else console.warn(`[VideoComoFunciona] ${CHAVE_VIDEO_CAPITULOS} inválido no banco (${v.erro}) — usando padrão`)
    } catch (err) {
      console.warn(`[VideoComoFunciona] ${CHAVE_VIDEO_CAPITULOS} não é JSON (${err.message}) — usando padrão`)
    }
  }
  return { video_id, capitulos }
}

module.exports = {
  CHAVE_VIDEO_ID, CHAVE_VIDEO_CAPITULOS, VIDEO_ID_RE, CAPITULOS_PADRAO,
  validarCapitulos, lerVideoComoFunciona,
}
