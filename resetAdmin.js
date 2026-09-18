require('dotenv').config()
const bcrypt = require('bcrypt')
const { Pool } = require('pg')

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não definida. Configure no .env (local) ou nas variáveis de ambiente (Railway).')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

async function reset() {
  const hash = await bcrypt.hash('Admin123', 10)
  // Só a linha ADMIN. Com as múltiplas contas um e-mail pode ter várias linhas, e o UPDATE
  // antigo (WHERE email, SET role='admin') promoveria TODAS a admin e trocaria a senha de
  // todas. Agora o script só REDEFINE a senha/reativa a conta que já é admin; não promove mais
  // ninguém — 0 linhas = não existe admin com este e-mail, e nada é alterado.
  const result = await pool.query(
    `UPDATE usuarios SET senha_hash = $1, ativo = true, token_version = token_version + 1
      WHERE email = $2 AND role = 'admin' RETURNING id, nome, email, role`,
    [hash, 'admin@pinturapro.com.br']
  )
  if (result.rows.length === 0) {
    console.error('Nenhuma conta ADMIN com este e-mail — nada foi alterado.')
    process.exit(1)
  }
  console.log('Atualizado:', result.rows)
  process.exit(0)
}

reset().catch(err => { console.error(err); process.exit(1) })