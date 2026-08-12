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
  // 2s (era 5s): com o shedding de carga na porta (server.js) a fila do pool passou a ser
  // limitada, então a requisição rara que ainda enfileira deve falhar rápido em vez de
  // segurar um slot por 5s — que era exatamente o que amplificava a saturação.
  connectionTimeoutMillis: 2000,
  // Teto POR STATEMENT, enforçado pelo Postgres (cancela de verdade a query; o query_timeout
  // do pg é só client-side e abandona a query, que segue queimando CPU no servidor).
  // 10s dá 3–10x de folga sobre o pior caso legítimo — o DELETE FROM usuarios de
  // /admin/limpar-usuarios, que dispara checagem de FK em ~9 tabelas filhas.
  // ATENÇÃO: a migração de boot usa ESTE pool e roda antes do app.listen; um CREATE INDEX
  // grande estouraria os 10s e impediria o servidor de subir. Por isso ela se isenta com
  // `SET LOCAL statement_timeout = 0` logo após o BEGIN (ver src/routes/index.js).
  statement_timeout: 10000,
  // Recupera conexão presa em transação ABERTA e OCIOSA (handler que estourou entre o BEGIN
  // e o ROLLBACK, ou cliente que sumiu no meio). Mede o tempo PARADO entre statements, não a
  // duração de um statement — por isso não ameaça a migração, cujos statements são contíguos.
  // 30s é folgado: nenhuma transação do código espera rede entre BEGIN e COMMIT (bcrypt e
  // e-mails ficam fora da transação).
  idle_in_transaction_session_timeout: 30000
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