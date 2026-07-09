// Load test do cadastro — dispara N registros CONCORRENTES e reporta a
// distribuição de latência. Serve para comparar ANTES vs DEPOIS do deploy da
// correção (bcrypt nativo + transação): o sintoma era timeout/ERR_NETWORK sob
// concorrência porque o event loop travava no bcryptjs.
//
// AUTO-LIMPEZA: cada usuário criado é apagado ao final via DELETE /conta/excluir
// (self-service, usa o próprio token + senha). Não deixa lixo em produção.
//
// Uso:
//   node loadtest-cadastro.js --n 20
//   node loadtest-cadastro.js --n 20 --api http://localhost:3000/api   (local)
//   node loadtest-cadastro.js --n 20 --no-cleanup                      (mantém p/ inspeção)
//
// Cada conta usa email/CPF únicos por timestamp e tipo_conta=prestador.

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--no-cleanup') { args.cleanup = false; continue }
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i]
}
const API = args.api || 'https://pinturapro-api-production.up.railway.app/api'
const N   = parseInt(args.n) || 20
const CLEANUP = args.cleanup !== false
const SENHA = 'LoadTest2024!'
const RUN = Date.now()

async function api(method, path, body, token) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (token) opts.headers['Authorization'] = `Bearer ${token}`
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(`${API}${path}`, opts)
  let data; try { data = await r.json() } catch { data = {} }
  return { status: r.status, data }
}

function pct(sorted, q) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(q / 100 * sorted.length))]
}

async function main() {
  console.log('='.repeat(64))
  console.log(`  LOAD TEST /auth/cadastro — ${N} registros concorrentes`)
  console.log(`  API: ${API}`)
  console.log(`  auto-limpeza: ${CLEANUP ? 'SIM (DELETE /conta/excluir)' : 'NÃO'}`)
  console.log('='.repeat(64))

  const t0 = process.hrtime.bigint()
  const results = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const email = `loadtest-${RUN}-${i}@teste.pinturapro.dev`
      const cpf = String(RUN + i).slice(-11)
      const s = process.hrtime.bigint()
      let status = 0, data = {}
      try {
        ({ status, data } = await api('POST', '/auth/cadastro', {
          nome: `LoadTest ${i}`, email, senha: SENHA, tipo_conta: 'prestador',
          cidade: 'Uberlândia', uf: 'MG', telefone: '34999990000', cpf_cnpj: cpf
        }))
      } catch (e) { data = { erro: 'fetch: ' + e.message } }
      const ms = Number(process.hrtime.bigint() - s) / 1e6
      return { i, email, ms, status, token: data.token, erro: data.erro }
    })
  )
  const wall = Number(process.hrtime.bigint() - t0) / 1e6

  const oks   = results.filter(r => r.status === 201)
  const errs  = results.filter(r => r.status !== 201)
  const lat   = results.map(r => r.ms).sort((a, b) => a - b)

  console.log(`\n  RESULTADO`)
  console.log(`  wall-clock total          : ${wall.toFixed(0)} ms`)
  console.log(`  sucesso (201)             : ${oks.length}/${N}`)
  console.log(`  falhas                    : ${errs.length}/${N}`)
  console.log(`  latência p50/p95/max (ms) : ${pct(lat,50).toFixed(0)} / ${pct(lat,95).toFixed(0)} / ${lat[lat.length-1].toFixed(0)}`)
  const byStatus = {}
  results.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1 })
  console.log(`  status HTTP               : ${JSON.stringify(byStatus)}`)
  if (errs.length) {
    console.log(`\n  amostra de falhas:`)
    errs.slice(0, 5).forEach(r => console.log(`    [${r.status}] ${r.email} — ${r.erro || '(sem corpo)'} (${r.ms.toFixed(0)}ms)`))
  }

  if (CLEANUP) {
    console.log(`\n  LIMPEZA — apagando ${oks.length} conta(s) criada(s)...`)
    let apagadas = 0, falhou = 0
    for (const r of oks) {
      try {
        const { status } = await api('DELETE', '/conta/excluir', { senha: SENHA }, r.token)
        if (status === 200) apagadas++
        else { falhou++; console.log(`    ⚠ ${r.email} não apagou (HTTP ${status})`) }
      } catch (e) { falhou++; console.log(`    ⚠ ${r.email} erro: ${e.message}`) }
    }
    console.log(`  apagadas: ${apagadas}  | falhas de limpeza: ${falhou}`)
    if (falhou) console.log(`  ⚠ APAGAR MANUALMENTE as contas com prefixo loadtest-${RUN}-`)
  } else {
    console.log(`\n  ⚠ --no-cleanup: contas loadtest-${RUN}-* permanecem no banco.`)
  }
  console.log('\n' + '='.repeat(64))
}

main().catch(e => { console.error('Erro fatal:', e); process.exit(1) })
