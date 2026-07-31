const { Pool } = require('pg')

const rawUrl = process.env.DATABASE_URL || ''
// Sanitiza espaços acidentais (ex.: valor de var do Railway com espaço → db "railway ")
const connectionString = rawUrl.trim().replace(/\s+(\?|$)/, '$1')

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 20,                      // máximo de conexões simultâneas
  // O node-postgres não mantém um piso de conexões (não existe opção "min"), então
  // toda conexão ociosa é fechada ao fim deste prazo e a próxima requisição paga o
  // custo de reabrir (TCP + TLS + auth). Com 30s, uma pausa normal de tráfego já
  // derrubava o pool inteiro. 2 min cobre esses vãos sem segurar conexões à toa.
  idleTimeoutMillis: 120000,    // fecha conexão ociosa após 2 min
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