const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,                     // máximo de conexões simultâneas
  min: 2,                      // conexões mínimas mantidas abertas
  idleTimeoutMillis: 30000,    // fecha conexão ociosa após 30s
  connectionTimeoutMillis: 5000 // erro se não conectar em 5s
})

pool.on('error', (err) => {
  console.error('Erro inesperado no pool do PostgreSQL:', err.message)
})

pool.on('connect', () => {
  console.log('Nova conexão estabelecida com o PostgreSQL')
})

// Testa a conexão na inicialização
pool.query('SELECT 1').then(() => {
  console.log('PostgreSQL conectado com sucesso')
}).catch(err => {
  console.error('Falha ao conectar ao PostgreSQL:', err.message)
})

module.exports = { pool }