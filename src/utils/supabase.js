const { Pool } = require('pg')

const rawUrl = process.env.DATABASE_URL || ''
// Sanitiza espaços acidentais (ex.: valor de var do Railway com espaço → db "railway ")
const connectionString = rawUrl.trim().replace(/\s+(\?|$)/, '$1')

// ─── DBDIAG (temporário) — revela bytes ocultos no DATABASE_URL sem vazar a senha ───
;(() => {
  if (!rawUrl) { console.error('[DBDIAG] DATABASE_URL ausente/undefined'); return }
  const seg = s => { try { return s.split('/').pop().split('?')[0] } catch { return '' } }
  const rawDb = seg(rawUrl)
  console.log('[DBDIAG] urlLen=', rawUrl.length, 'cleanLen=', connectionString.length,
    'changedByTrim=', rawUrl !== connectionString)
  console.log('[DBDIAG] rawDbSeg=', JSON.stringify(rawDb), 'len=', rawDb.length,
    'hex=', Buffer.from(rawDb, 'utf8').toString('hex'))
  console.log('[DBDIAG] PGDATABASE=', JSON.stringify(process.env.PGDATABASE),
    'hex=', Buffer.from(process.env.PGDATABASE || '', 'utf8').toString('hex'))
})()

const pool = new Pool({
  connectionString,
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