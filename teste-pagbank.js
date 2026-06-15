require('dotenv').config()
const fs = require('fs')
const path = require('path')

const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN || process.argv[2]
const PAGBANK_URL   = 'https://api.pagseguro.com'
const LOG_FILE      = path.join(__dirname, 'log-pagbank-teste.txt')

if (!PAGBANK_TOKEN) {
  console.error('Uso: node teste-pagbank.js SEU_TOKEN_AQUI')
  console.error('  ou: defina PAGBANK_TOKEN no .env')
  process.exit(1)
}

const payload = {
  reference_id: 'teste-script|basic',
  customer: {
    name:   'Teste ArrumaPro',
    email:  'teste@arrumapro.com.br',
    tax_id: '11144477735',
    phones: [{ country: '55', area: '34', number: '999999999', type: 'MOBILE' }]
  },
  items: [{
    reference_id: 'plano_basic',
    name:         'ArrumaPro — Plano Basic',
    quantity:     1,
    unit_amount:  2990
  }],
  payment_methods: [{ type: 'CREDIT_CARD' }, { type: 'PIX' }],
  redirect_url:      'https://pinturapro-api-production.up.railway.app/api/pagamentos/sucesso',
  notification_urls: ['https://pinturapro-api-production.up.railway.app/api/pagamentos/webhook-pagbank']
}

const requestHeaders = {
  'Authorization':  `Bearer ${PAGBANK_TOKEN}`,
  'Content-Type':   'application/json',
  'x-api-version':  '4.0'
}

async function run() {
  const lines = []
  const log = (...args) => {
    const line = args.join(' ')
    console.log(line)
    lines.push(line)
  }

  const sep = '='.repeat(60)
  const ts  = new Date().toISOString()

  log(sep)
  log(`TESTE PAGBANK — ${ts}`)
  log(sep)

  log('\n--- REQUEST ---')
  log(`POST ${PAGBANK_URL}/checkouts`)
  log('\nHeaders:')
  for (const [k, v] of Object.entries(requestHeaders)) {
    const display = k === 'Authorization'
      ? `Bearer ${PAGBANK_TOKEN.substring(0, 8)}...[redacted]`
      : v
    log(`  ${k}: ${display}`)
  }
  log('\nBody:')
  log(JSON.stringify(payload, null, 2))

  let response, responseText
  try {
    response     = await fetch(`${PAGBANK_URL}/checkouts`, {
      method:  'POST',
      headers: requestHeaders,
      body:    JSON.stringify(payload)
    })
    responseText = await response.text()
  } catch (err) {
    log(`\nErro de rede: ${err.message}`)
    fs.writeFileSync(LOG_FILE, lines.join('\n'), 'utf8')
    console.log(`\nLog salvo em: ${LOG_FILE}`)
    return
  }

  log('\n--- RESPONSE ---')
  log(`Status: ${response.status} ${response.statusText}`)
  log('\nHeaders:')
  response.headers.forEach((v, k) => log(`  ${k}: ${v}`))

  let parsed
  try {
    parsed = JSON.parse(responseText)
    log('\nBody (JSON):')
    log(JSON.stringify(parsed, null, 2))
  } catch {
    log('\nBody (raw):')
    log(responseText)
  }

  if (parsed?.links) {
    const payLink = parsed.links.find(l => l.rel === 'PAY' || l.rel === 'pay')
    if (payLink) {
      log('\n✓ Link de pagamento:')
      log(`  ${payLink.href}`)
    }
  }

  log(`\n${sep}`)

  fs.writeFileSync(LOG_FILE, lines.join('\n'), 'utf8')
  console.log(`\nLog salvo em: ${LOG_FILE}`)
}

run().catch(err => {
  console.error('Erro fatal:', err)
  process.exit(1)
})
