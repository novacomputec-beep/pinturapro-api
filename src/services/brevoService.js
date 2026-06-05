const SibApiV3Sdk = require('sib-api-v3-sdk')

const toRecipients = (para) =>
  Array.isArray(para) ? para.map(e => ({ email: e })) : [{ email: para }]

const getApiInstance = () => {
  const defaultClient = SibApiV3Sdk.ApiClient.instance
  defaultClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY
  return new SibApiV3Sdk.TransactionalEmailsApi()
}

const enviarEmail = async ({ para, assunto, html }) => {
  const email = new SibApiV3Sdk.SendSmtpEmail()
  email.sender = { name: 'PinturaPro', email: process.env.EMAIL_REMETENTE }
  email.to = toRecipients(para)
  email.subject = assunto
  email.htmlContent = html
  await getApiInstance().sendTransacEmail(email)
}

const enviarEmailComAnexo = async ({ para, assunto, html, pdfBuffer, nomeArquivo }) => {
  const email = new SibApiV3Sdk.SendSmtpEmail()
  email.sender = { name: 'PinturaPro', email: process.env.EMAIL_REMETENTE }
  email.to = toRecipients(para)
  email.subject = assunto
  email.htmlContent = html
  if (pdfBuffer) {
    email.attachment = [{ name: nomeArquivo || 'contrato.pdf', content: pdfBuffer.toString('base64') }]
  }
  await getApiInstance().sendTransacEmail(email)
}

module.exports = { enviarEmail, enviarEmailComAnexo }
