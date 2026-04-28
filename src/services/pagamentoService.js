const { MercadoPagoConfig, PreApproval } = require('mercadopago')

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
})

const preApproval = new PreApproval(client)

// Cria assinatura recorrente no Mercado Pago
const criarAssinatura = async (usuario, plano) => {
  const valor = plano === 'anual' ? 83.25 : 99.90

  const dados = {
    preapproval_plan_id: null,
    payer_email: usuario.email,
    card_token_id: null,
    reason: `PinturaPro — Plano ${plano === 'anual' ? 'Anual' : 'Mensal'}`,
    external_reference: usuario.id,
    auto_recurring: {
      frequency: 1,
      frequency_type: plano === 'anual' ? 'years' : 'months',
      transaction_amount: valor,
      currency_id: 'BRL'
    },
    back_url: 'https://pinturapro-api-production.up.railway.app/api/pagamentos/callback',
    status: 'pending'
  }

  const resultado = await preApproval.create({ body: dados })
  return resultado
}

module.exports = { criarAssinatura }