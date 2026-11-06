// Identidade do ADMIN para avisos automáticos (resumo do dia — services/resumoDiaAdminService).
//   ADMIN_EMAIL: e-mail que recebe o aviso; também é o e-mail das contas que recebem o push
//                (toda linha de usuarios com esse e-mail e push_token). Padrão = o admin de
//                scripts/resetAdmin.js. Mude pela variável de ambiente, sem deploy.
//   PAINEL_URL:  o painel (painel-admin); as abas abrem por hash (#canal = Canal do WhatsApp).
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'admin@pinturapro.com.br').trim().toLowerCase()
const PAINEL_URL = String(process.env.PAINEL_URL || 'https://painel.protudo.app.br').replace(/\/+$/, '')

module.exports = { ADMIN_EMAIL, PAINEL_URL }
