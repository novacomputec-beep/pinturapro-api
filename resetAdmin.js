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
  const result = await pool.query(
    `UPDATE usuarios SET senha_hash = $1, role = 'admin', ativo = true WHERE email = $2 RETURNING id, nome, email, role`,
    [hash, 'admin@pinturapro.com.br']
  )
  console.log('Atualizado:', result.rows)
  process.exit(0)
}

reset().catch(err => { console.error(err); process.exit(1) })