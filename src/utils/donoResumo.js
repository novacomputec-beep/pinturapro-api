// Resumo público do DONO para o profissional casado (GET /reparos/:id e GET /obras/:id):
// nome curto + avatar otimizado. Nunca telefone, e-mail ou endereço — esses continuam nas
// regras próprias de cada rota (telefone só depois do "Estou a caminho"). Módulo inerte.

// "Luiz Melo Silva" → "Luiz S."; "Luiz" → "Luiz"; vazio/null → null.
const nomeCurto = (nome) => {
  const partes = String(nome || '').trim().split(/\s+/).filter(Boolean)
  if (partes.length === 0) return null
  if (partes.length === 1) return partes[0]
  return `${partes[0]} ${partes[partes.length - 1][0].toUpperCase()}.`
}

// Avatar pequeno via transformação de entrega do Cloudinary (mesmo padrão do thumbnail em
// uploadService): recorte quadrado pelo rosto, 200px, formato/qualidade automáticos. URL que
// não é de imagem do Cloudinary (ou já carrega transformação) sai como está.
const AVATAR_TRANSFORM = 'w_200,h_200,c_fill,g_face,q_auto,f_auto'
const fotoOtimizada = (url) => {
  if (!url || typeof url !== 'string') return null
  const marcador = '/image/upload/'
  const i = url.indexOf(marcador)
  if (!/^https:\/\/res\.cloudinary\.com\//.test(url) || i < 0) return url
  const depois = url.slice(i + marcador.length)
  // Segmento de transformação do Cloudinary = parâmetros "x_valor" separados por vírgula
  // (w_400,h_300,...; t_nome); a versão é "v123..." sem underscore e o public_id vem depois.
  const jaTransformada = /^[a-z]{1,3}_/.test(depois.split('/')[0])
  if (jaTransformada) return url
  return `${url.slice(0, i + marcador.length)}${AVATAR_TRANSFORM}/${depois}`
}

module.exports = { nomeCurto, fotoOtimizada, AVATAR_TRANSFORM }
