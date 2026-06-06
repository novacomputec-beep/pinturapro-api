const { enviarEmail: enviarBrevo } = require('./brevoService')

const enviarEmail = async ({ para, assunto, html }) => {
  try {
    await enviarBrevo({ para, assunto, html })
  } catch (err) {
    console.error('Erro ao enviar e-mail:', err.message)
  }
}

module.exports = { enviarEmail }
