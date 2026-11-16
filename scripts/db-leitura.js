// Conexão SÓ LEITURA para os scripts de auditoria/diagnóstico (nunca usada pelo app).
// De onde vem a URL, nesta ordem — o valor nunca é impresso:
//   1) variável de ambiente DATABASE_URL;
//   2) arquivo .env passado pelo chamador (compatibilidade com o uso antigo).
// TÚNEL (scripts/db-tunnel.md): se o host da URL é privado da Railway (*.railway.internal — é o
// que `railway run -s Postgres` injeta), ele é trocado por 127.0.0.1:DB_TUNNEL_PORT (padrão 15432),
// a ponta local de `railway connect Postgres --tunnel-only -P 15432`.
// SSL: desligado em localhost (o túnel SSH já cifra), ligado sem validar certificado nos demais
// hosts (igual ao app). DATABASE_SSL=1 / DATABASE_SSL=0 força um ou outro.
// Toda sessão nasce com default_transaction_read_only = on: um INSERT/UPDATE/DELETE falha no banco.
const fs = require('fs')
const { Pool } = require('pg')

const PORTA_TUNEL_PADRAO = 15432
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

const lerDoArquivo = (arq) => (fs.readFileSync(arq, 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m) || [])[1] || ''

// { url, host, porta, viaTunel } — host/porta só para o log (sem usuário nem senha).
const resolverUrl = (arquivoEnv = null) => {
  const bruta = String(process.env.DATABASE_URL || '').trim() || (arquivoEnv ? lerDoArquivo(arquivoEnv) : '')
  if (!bruta) throw new Error('DATABASE_URL ausente: defina a variável de ambiente (ver scripts/db-tunnel.md) ou passe um arquivo .env')
  const u = new URL(bruta)
  let viaTunel = false
  if (/\.railway\.internal$/i.test(u.hostname)) {
    u.hostname = '127.0.0.1'
    u.port = String(Number(process.env.DB_TUNNEL_PORT) || PORTA_TUNEL_PADRAO)
    viaTunel = true
  }
  return { url: u.toString(), host: u.hostname, porta: u.port || '5432', viaTunel }
}

const criarPoolLeitura = (arquivoEnv = null) => {
  const { url, host, porta, viaTunel } = resolverUrl(arquivoEnv)
  const forcado = process.env.DATABASE_SSL
  const comSsl = forcado === '1' ? true : forcado === '0' ? false : !LOCAL.has(host)
  const pool = new Pool({
    connectionString: url,
    ssl: comSsl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000,
    options: '-c default_transaction_read_only=on',
  })
  console.error(`[db-leitura] ${host}:${porta}${viaTunel ? ' (túnel)' : ''} ssl=${comSsl ? 'sim' : 'não'} — sessão somente leitura`)
  return pool
}

module.exports = { criarPoolLeitura, resolverUrl, PORTA_TUNEL_PADRAO }
