// Login social (Google / Apple) — POST /auth/social e o ticket de cadastro.
//
// GOOGLE_WEB_CLIENT_ID: o client ID WEB do projeto Google (é o `aud` do id_token que o app
// manda, mesmo quando o login acontece no Android/iOS com o SDK nativo). Default = o client
// de produção; a variável no Railway só sobrepõe para trocar de projeto.
// APPLE_AUD: o bundle id do app iOS — é o `aud` do identity token do Sign in with Apple.
module.exports = {
  GOOGLE_WEB_CLIENT_ID: process.env.GOOGLE_WEB_CLIENT_ID || '592909036534-mco08mbsdbsouppbqdjfesi2t1gra3he.apps.googleusercontent.com',
  APPLE_ISS: 'https://appleid.apple.com',
  APPLE_AUD: process.env.APPLE_AUD || 'com.pinturapro.app',
  APPLE_KEYS_URL: 'https://appleid.apple.com/auth/keys',
  // Chaves públicas da Apple ficam em cache por esta janela; um `kid` desconhecido força uma
  // releitura antes de recusar (rotação de chave sem reiniciar a API).
  APPLE_KEYS_CACHE_MS: 60 * 60 * 1000,
  // Ticket de cadastro: JWT curto devolvido por /auth/social quando o e-mail não tem conta;
  // POST /auth/cadastro aceita-o no lugar da senha.
  TICKET_TIPO: 'cadastro_social',
  TICKET_EXPIRA_EM: '15m',
  PROVEDORES: ['google', 'apple'],
  // E-mail de relay privado da Apple ("Ocultar meu e-mail"): nunca vincula a uma conta que já
  // existe por e-mail — só por apple_sub.
  APPLE_RELAY_SUFIXO: '@privaterelay.appleid.com',
}
