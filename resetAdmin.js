// Redefine a senha (e reativa) a conta ADMIN de um e-mail. Nada de senha ou e-mail no código: os
// dois vêm do ambiente e o script para, sem tocar no banco, se faltar algum.
//   RESET_ADMIN_EMAIL     e-mail da conta admin
//   RESET_ADMIN_PASSWORD  senha nova (mínimo 10 caracteres)
//   DATABASE_URL          banco (.env local ou variáveis da Railway)
require('dotenv').config()
const bcrypt = require('bcrypt')
const { Pool } = require('pg')

const MIN_SENHA = 10
const email = String(process.env.RESET_ADMIN_EMAIL || '').trim()
const senha = String(process.env.RESET_ADMIN_PASSWORD || '')
const faltando = [
  !process.env.DATABASE_URL && 'DATABASE_URL',
  !email && 'RESET_ADMIN_EMAIL',
  !senha && 'RESET_ADMIN_PASSWORD',
].filter(Boolean)
if (faltando.length > 0) {
  console.error(`Abortado: defina ${faltando.join(', ')} no ambiente (ou no .env local). Nada foi alterado.`)
  process.exit(1)
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Abortado: RESET_ADMIN_EMAIL não parece um e-mail válido. Nada foi alterado.')
  process.exit(1)
}
if (senha.length < MIN_SENHA) {
  console.error(`Abortado: RESET_ADMIN_PASSWORD precisa ter pelo menos ${MIN_SENHA} caracteres. Nada foi alterado.`)
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

async function reset() {
  const hash = await bcrypt.hash(senha, 10)
  // Só a linha ADMIN. Com as múltiplas contas um e-mail pode ter várias linhas, e o UPDATE
  // antigo (WHERE email, SET role='admin') promoveria TODAS a admin e trocaria a senha de
  // todas. Agora o script só REDEFINE a senha/reativa a conta que já é admin; não promove mais
  // ninguém — 0 linhas = não existe admin com este e-mail, e nada é alterado.
  const result = await pool.query(
    `UPDATE usuarios SET senha_hash = $1, ativo = true, token_version = token_version + 1
      WHERE email = $2 AND role = 'admin' RETURNING id, nome, email, role`,
    [hash, email]
  )
  if (result.rows.length === 0) {
    console.error('Nenhuma conta ADMIN com este e-mail — nada foi alterado.')
    process.exit(1)
  }
  console.log('Atualizado:', result.rows)
  process.exit(0)
}

reset().catch(err => { console.error(err); process.exit(1) })
