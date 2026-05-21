const { createClient } = require('@supabase/supabase-js')
const { Pool } = require('pg')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,                // máximo de conexões simultâneas
  min: 2,                 // conexões mínimas mantidas abertas
  idleTimeoutMillis: 30000,    // fecha conexão ociosa após 30s
  connectionTimeoutMillis: 5000 // erro se não conectar em 5s
})

pool.on('error', (err) => {
  console.error('Erro inesperado no pool do PostgreSQL:', err.message)
})

module.exports = { supabase, pool }