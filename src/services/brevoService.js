const SibApiV3Sdk = require('sib-api-v3-sdk')

const toRecipients = (para) =>
  Array.isArray(para) ? para.map(e => ({ email: e })) : [{ email: para }]

const getApiInstance = () => {
  const defaultClient = SibApiV3Sdk.ApiClient.instance
  defaultClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY
  return new SibApiV3Sdk.TransactionalEmailsApi()
}

// Aceita "Nome <email@dominio.com>" ou apenas "email@dominio.com".
// `nomeOverride` (opcional) força o nome de exibição do remetente (ex.: marca por
// tipo de usuário), mantendo o endereço do EMAIL_REMETENTE.
const parseSender = (nomeOverride) => {
  const raw = process.env.EMAIL_REMETENTE || ''
  const match = raw.match(/^(.+?)\s*<(.+?)>$/)
  const email = match ? match[2].trim() : (raw || 'novacomputec@gmail.com')
  return { name: nomeOverride || (match ? match[1].trim() : 'PinturaPro'), email }
}

const enviarEmail = async ({ para, assunto, html, remetenteNome }) => {
  const email = new SibApiV3Sdk.SendSmtpEmail()
  email.sender = parseSender(remetenteNome)
  email.to = toRecipients(para)
  email.subject = assunto
  email.htmlContent = html
  await getApiInstance().sendTransacEmail(email)
}

const enviarEmailComAnexo = async ({ para, assunto, html, pdfBuffer, nomeArquivo, remetenteNome }) => {
  const email = new SibApiV3Sdk.SendSmtpEmail()
  email.sender = parseSender(remetenteNome)
  email.to = toRecipients(para)
  email.subject = assunto
  email.htmlContent = html
  if (pdfBuffer) {
    email.attachment = [{ name: nomeArquivo || 'contrato.pdf', content: pdfBuffer.toString('base64') }]
  }
  await getApiInstance().sendTransacEmail(email)
}

module.exports = { enviarEmail, enviarEmailComAnexo }
