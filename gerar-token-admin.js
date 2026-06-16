// Script temporário — gera JWT de admin via login na API de produção
// Uso: node gerar-token-admin.js [senha]
// Imprime apenas o token no stdout para poder ser capturado por scripts

const API   = 'https://pinturapro-api-production.up.railway.app/api'
const EMAIL = 'admin@pinturapro.com.br'
const SENHA = process.argv[2] || 'Admin123'

;(async () => {
  const r = await fetch(`${API}/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: EMAIL, senha: SENHA })
  })
  const data = await r.json()
  if (!data.token) {
    process.stderr.write(`Erro HTTP ${r.status}: ${JSON.stringify(data)}\n`)
    process.stderr.write(`Tente: node gerar-token-admin.js OUTRA_SENHA\n`)
    process.stderr.write(`Ou rode resetAdmin.js primeiro para redefinir para Admin123.\n`)
    process.exit(1)
  }
  process.stdout.write(data.token)
})()
