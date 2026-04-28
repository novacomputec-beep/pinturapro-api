const bcrypt = require('bcryptjs')
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: 'postgresql://postgres:bXRBYWrPTEGQqLFMzRJIXTUpzEmzLPaS@shuttle.proxy.rlwy.net:31045/railway',
  ssl: { rejectUnauthorized: false }
})

async function reset() {
  const hash = await bcrypt.hash('Admin123', 12)
  const result = await pool.query(
    `UPDATE usuarios SET senha_hash = $1, role = 'admin', ativo = true WHERE email = $2 RETURNING id, nome, email, role`,
    [hash, 'admin@pinturapro.com.br']
  )
  console.log('Atualizado:', result.rows)
  process.exit(0)
}

reset().catch(err => { console.error(err); process.exit(1) })