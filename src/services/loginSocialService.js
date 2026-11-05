// Verificação dos tokens de login social (Google e Apple) e o ticket de cadastro.
//
// Os dois verificadores devolvem a MESMA forma — { provedor, sub, email, email_verificado, nome }
// — ou lançam ErroLoginSocial (401 no controller). Nenhum deles toca o banco: quem decide o que
// fazer com a identidade (achar conta, criar ticket) é authController.loginSocial.
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { OAuth2Client } = require('google-auth-library')
const cfg = require('../config/loginSocial')

class ErroLoginSocial extends Error {
  constructor(mensagem, codigo = 'token_social_invalido') { super(mensagem); this.codigo = codigo }
}

const normalizarEmail = (email) => (typeof email === 'string' && email.trim() ? email.toLowerCase().trim() : null)
// Apple manda email_verified como boolean OU como a string "true" (documentado); Google, boolean.
const verdadeiro = (v) => v === true || v === 'true'

// ---- Google: google-auth-library valida assinatura (JWKS do Google, com cache), iss, exp e aud.
let googleClient = null
const verificarGoogle = async (idToken) => {
  if (!googleClient) googleClient = new OAuth2Client(cfg.GOOGLE_WEB_CLIENT_ID)
  let ticket
  try {
    ticket = await googleClient.verifyIdToken({ idToken, audience: cfg.GOOGLE_WEB_CLIENT_ID })
  } catch (err) {
    throw new ErroLoginSocial(`Token do Google inválido: ${err.message}`)
  }
  const p = ticket.getPayload() || {}
  if (!p.sub) throw new ErroLoginSocial('Token do Google sem identificador (sub)')
  // Exigido: um e-mail não verificado no Google não prova a posse do e-mail, e é o e-mail que
  // vincula a uma conta já existente.
  if (!verdadeiro(p.email_verified)) throw new ErroLoginSocial('E-mail do Google não verificado', 'email_nao_verificado')
  return { provedor: 'google', sub: String(p.sub), email: normalizarEmail(p.email), email_verificado: true, nome: p.name || null }
}

// ---- Apple: identity token é um JWT RS256 assinado por uma das chaves de APPLE_KEYS_URL.
// Cache das chaves com releitura quando chega um `kid` desconhecido (rotação).
let chavesApple = { em: 0, porKid: new Map() }
const lerChavesApple = async () => {
  const r = await fetch(cfg.APPLE_KEYS_URL)
  if (!r.ok) throw new Error(`HTTP ${r.status} ao ler as chaves da Apple`)
  const { keys } = await r.json()
  const porKid = new Map()
  for (const jwk of keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue
    porKid.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }))
  }
  chavesApple = { em: Date.now(), porKid }
  return porKid
}
const chavePublicaApple = async (kid) => {
  const vencido = Date.now() - chavesApple.em > cfg.APPLE_KEYS_CACHE_MS
  if (!vencido && chavesApple.porKid.has(kid)) return chavesApple.porKid.get(kid)
  const porKid = await lerChavesApple()
  return porKid.get(kid) || null
}

const verificarApple = async (idToken) => {
  const decodificado = jwt.decode(idToken, { complete: true })
  if (!decodificado || decodificado.header?.alg !== 'RS256' || !decodificado.header.kid) {
    throw new ErroLoginSocial('Token da Apple malformado (esperado JWT RS256 com kid)')
  }
  let chave
  try {
    chave = await chavePublicaApple(decodificado.header.kid)
  } catch (err) {
    throw new ErroLoginSocial(`Não foi possível ler as chaves da Apple: ${err.message}`, 'apple_chaves_indisponiveis')
  }
  if (!chave) throw new ErroLoginSocial('Token da Apple assinado por chave desconhecida')
  let p
  try {
    // issuer + audience + exp (jsonwebtoken recusa expirado por padrão) + algoritmo fixo.
    p = jwt.verify(idToken, chave, { algorithms: ['RS256'], issuer: cfg.APPLE_ISS, audience: cfg.APPLE_AUD })
  } catch (err) {
    throw new ErroLoginSocial(`Token da Apple inválido: ${err.message}`)
  }
  if (!p.sub) throw new ErroLoginSocial('Token da Apple sem identificador (sub)')
  // A Apple só põe e-mail no token que ELA verificou (ou no relay, que é dela); quando o campo
  // vem, email_verified acompanha. Sem e-mail no token, a identidade ainda vale por `sub`.
  const email = normalizarEmail(p.email)
  return { provedor: 'apple', sub: String(p.sub), email, email_verificado: !!email && verdadeiro(p.email_verified ?? true), nome: null }
}

const verificar = (provedor, idToken) => {
  if (provedor === 'google') return verificarGoogle(idToken)
  if (provedor === 'apple') return verificarApple(idToken)
  throw new ErroLoginSocial('Provedor desconhecido', 'provedor_invalido')
}

const ehEmailRelayApple = (email) => typeof email === 'string' && email.toLowerCase().endsWith(cfg.APPLE_RELAY_SUFIXO)
const colunaSub = (provedor) => (provedor === 'google' ? 'google_sub' : 'apple_sub')

// ---- Ticket de cadastro: prova, por 15 min, que o provedor confirmou (sub, e-mail). Assinado
// com o JWT_SECRET da API e marcado com `tipo` próprio para nunca valer como sessão (o
// middleware autenticar exige id/role/tv) nem como temp_token de 2FA.
const gerarTicket = ({ provedor, sub, email, nome }) => jwt.sign(
  { tipo: cfg.TICKET_TIPO, provedor, sub, email, nome: nome || null },
  process.env.JWT_SECRET,
  { expiresIn: cfg.TICKET_EXPIRA_EM }
)
const lerTicket = (ticket) => {
  let p
  try { p = jwt.verify(String(ticket), process.env.JWT_SECRET) } catch (err) {
    throw new ErroLoginSocial('Ticket de cadastro inválido ou expirado', 'ticket_invalido')
  }
  if (p.tipo !== cfg.TICKET_TIPO || !cfg.PROVEDORES.includes(p.provedor) || !p.sub || !p.email) {
    throw new ErroLoginSocial('Ticket de cadastro inválido', 'ticket_invalido')
  }
  return { provedor: p.provedor, sub: String(p.sub), email: normalizarEmail(p.email), nome: p.nome || null }
}

module.exports = { ErroLoginSocial, verificar, verificarGoogle, verificarApple, gerarTicket, lerTicket, ehEmailRelayApple, colunaSub }
