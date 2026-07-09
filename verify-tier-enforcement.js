// Verifica a SEPARAÇÃO DE TIER server-side (pintor↔obras, reparador↔reparos)
// contra produção. Ferramenta de regressão — roda antes/depois do deploy.
//
// A API deve ENFORÇAR o tier (não só a UI):
//   reparador  → SÓ reparos   (GET /obras deve dar 403 TIER_INCORRETO)
//   pintor     → SÓ obras     (GET /reparos deve dar 403 TIER_INCORRETO)
//   admin      → ambos (bypass)
// E os feeds CORRETOS de cada tier devem continuar 200 (guardas de regressão).
//
// Credenciais só via CLI (nunca hardcoded):
//   node verify-tier-enforcement.js \
//     --reparador-email a@b.com --reparador-senha S \
//     --pintor-email    c@d.com --pintor-senha    S \
//     --admin-email     e@f.com --admin-senha     S
//
// Sobre estado: as linhas 5 e 6 tentam AGIR no feed errado e ESPERAM 403.
// Se a ação (candidatura/interesse) VINGAR, isso é uma FALHA GRAVE e o script
// grita — NÃO limpa silenciosamente, porque significa que o enforcement furou.

const API = 'https://pinturapro-api-production.up.railway.app/api'
const SEP = '='.repeat(72)

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i]
}
const need = ['reparador-email','reparador-senha','pintor-email','pintor-senha','admin-email','admin-senha']
const faltando = need.filter(k => !args[k])
if (faltando.length) {
  console.error('Faltam credenciais: ' + faltando.map(k => '--' + k).join(', '))
  console.error('Veja o cabeçalho do arquivo para uso.')
  process.exit(1)
}

async function api(method, path, body, token) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (token) opts.headers['Authorization'] = `Bearer ${token}`
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(`${API}${path}`, opts)
  let data; try { data = await r.json() } catch { data = {} }
  return { status: r.status, data }
}

async function login(email, senha, rotulo) {
  const { status, data } = await api('POST', '/auth/login', { email, senha })
  if (status !== 200 || !data.token) {
    throw new Error(`login ${rotulo} falhou (HTTP ${status}): ${JSON.stringify(data)}`)
  }
  return { token: data.token, tipo: data.usuario?.tipo_prestador, role: data.usuario?.role }
}

const linhas = []
let leakGrave = null // registra vazamento de enforcement (ação no feed errado que vingou)

function check(id, descricao, passou, detalhe) {
  linhas.push({ id, descricao, resultado: passou ? 'PASS' : 'FAIL', detalhe })
  console.log(`  [${passou ? 'PASS' : 'FAIL'}] ${id} — ${descricao}${detalhe ? '  → ' + detalhe : ''}`)
}

async function primeiroItemAberto(path, chave, token) {
  const { status, data } = await api('GET', path, null, token)
  if (status !== 200) return { erro: `GET ${path} deu ${status}` }
  const lista = data[chave] || []
  return { id: lista[0]?.id || null, total: lista.length }
}

async function run() {
  console.log(SEP)
  console.log('  VERIFICAÇÃO DE ENFORCEMENT DE TIER — produção')
  console.log(`  ${new Date().toISOString()}  |  API: ${API}`)
  console.log(SEP)

  const reparador = await login(args['reparador-email'], args['reparador-senha'], 'reparador')
  const pintor    = await login(args['pintor-email'],    args['pintor-senha'],    'pintor')
  const admin     = await login(args['admin-email'],     args['admin-senha'],     'admin')
  console.log(`  reparador: role=${reparador.role} tipo=${reparador.tipo}`)
  console.log(`  pintor   : role=${pintor.role} tipo=${pintor.tipo}`)
  console.log(`  admin    : role=${admin.role}`)
  if (reparador.tipo && reparador.tipo !== 'reparador') console.log(`  ⚠ conta "reparador" tem tipo=${reparador.tipo}`)
  if (pintor.tipo && pintor.tipo !== 'pintor')          console.log(`  ⚠ conta "pintor" tem tipo=${pintor.tipo}`)
  console.log('')

  // ── Linha 1 (GUARDA): reparador → GET /reparos deve continuar 200 ──
  {
    const { status, data } = await api('GET', '/reparos', null, reparador.token)
    check('1', 'reparador GET /reparos = 200 (feed correto funciona)',
      status === 200, `HTTP ${status}${Array.isArray(data.reparos) ? `, ${data.reparos.length} itens` : ''}`)
  }

  // ── Linha 2: reparador → GET /obras deve dar 403 TIER_INCORRETO ──
  {
    const { status, data } = await api('GET', '/obras', null, reparador.token)
    check('2', 'reparador GET /obras = 403 TIER_INCORRETO (bloqueado)',
      status === 403 && data.codigo === 'TIER_INCORRETO', `HTTP ${status} codigo=${data.codigo || '-'}`)
  }

  // ── Linha 3 (GUARDA): pintor → GET /obras deve continuar 200 ──
  {
    const { status, data } = await api('GET', '/obras', null, pintor.token)
    check('3', 'pintor GET /obras = 200 (feed correto funciona)',
      status === 200, `HTTP ${status}${Array.isArray(data.obras) ? `, ${data.obras.length} itens` : ''}`)
  }

  // ── Linha 4: pintor → GET /reparos deve dar 403 TIER_INCORRETO (o bug reportado) ──
  {
    const { status, data } = await api('GET', '/reparos', null, pintor.token)
    check('4', 'pintor GET /reparos = 403 TIER_INCORRETO (bug reportado, bloqueado)',
      status === 403 && data.codigo === 'TIER_INCORRETO', `HTTP ${status} codigo=${data.codigo || '-'}`)
  }

  // ── Linha 5: pintor tenta AGIR num reparo (id obtido pelo tier CORRETO) ──
  {
    const alvo = await primeiroItemAberto('/reparos', 'reparos', reparador.token)
    if (!alvo.id) {
      check('5', 'pintor POST /reparos/:id/interesse = 403 (bloqueado)', false,
        `SEM reparo aberto p/ testar (${alvo.erro || 'feed vazio'}) — inconclusivo`)
    } else {
      const { status, data } = await api('POST', `/reparos/${alvo.id}/interesse`,
        { mensagem: 'verificacao de tier — nao deveria passar', valor_proposto: 1 }, pintor.token)
      const bloqueado = status === 403 && data.codigo === 'TIER_INCORRETO'
      check('5', 'pintor POST /reparos/:id/interesse = 403 TIER_INCORRETO (bloqueado)',
        bloqueado, `HTTP ${status} codigo=${data.codigo || '-'} reparo=${alvo.id}`)
      if (status === 201 || status === 200) {
        leakGrave = `VAZAMENTO: pintor criou INTERESSE no reparo ${alvo.id} (HTTP ${status}). ` +
          `interesse_id=${data.id || '?'} — APAGAR MANUALMENTE. O enforcement de tier FUROU.`
      }
    }
  }

  // ── Linha 6: reparador tenta AGIR numa obra (id obtido pelo tier CORRETO) ──
  {
    const alvo = await primeiroItemAberto('/obras', 'obras', pintor.token)
    if (!alvo.id) {
      check('6', 'reparador POST /obras/:id/candidatura = 403 (bloqueado)', false,
        `SEM obra aberta p/ testar (${alvo.erro || 'feed vazio'}) — inconclusivo`)
    } else {
      const { status, data } = await api('POST', `/obras/${alvo.id}/candidatura`,
        { mensagem: 'verificacao de tier — nao deveria passar', valor_proposto: 1 }, reparador.token)
      const bloqueado = status === 403 && data.codigo === 'TIER_INCORRETO'
      check('6', 'reparador POST /obras/:id/candidatura = 403 TIER_INCORRETO (bloqueado)',
        bloqueado, `HTTP ${status} codigo=${data.codigo || '-'} obra=${alvo.id}`)
      if (status === 201 || status === 200) {
        leakGrave = `VAZAMENTO: reparador criou CANDIDATURA na obra ${alvo.id} (HTTP ${status}). ` +
          `candidatura_id=${data.id || '?'} — APAGAR MANUALMENTE. O enforcement de tier FUROU.`
      }
    }
  }

  // ── Linha 7 (GUARDA): admin → ambos os feeds = 200 (bypass intacto) ──
  {
    const o = await api('GET', '/obras', null, admin.token)
    const r = await api('GET', '/reparos', null, admin.token)
    check('7', 'admin GET /obras e GET /reparos = 200 (bypass intacto)',
      o.status === 200 && r.status === 200, `obras HTTP ${o.status} | reparos HTTP ${r.status}`)
  }

  // ── Tabela final ──
  console.log(`\n${SEP}`)
  console.log('  RESUMO')
  console.log(SEP)
  console.log('  linha  resultado  descrição')
  console.log('  ' + '-'.repeat(68))
  for (const l of linhas) {
    console.log(`  ${l.id.padEnd(6)} ${l.resultado.padEnd(10)} ${l.descricao}`)
  }
  const falhas = linhas.filter(l => l.resultado === 'FAIL').length
  console.log('  ' + '-'.repeat(68))
  console.log(`  ${linhas.length - falhas}/${linhas.length} PASS`)

  if (leakGrave) {
    console.log(`\n${'!'.repeat(72)}`)
    console.log('  ⚠⚠⚠  FALHA GRAVE DE ENFORCEMENT — ESTADO DEIXADO EM PRODUÇÃO  ⚠⚠⚠')
    console.log('  ' + leakGrave)
    console.log(`${'!'.repeat(72)}`)
  }

  console.log('')
  if (falhas > 0 || leakGrave) {
    console.log('  ❌ REPROVADO — separação de tier NÃO está garantida.')
    process.exit(1)
  }
  console.log('  ✅ APROVADO — separação de tier garantida server-side, feeds corretos intactos.')
}

run().catch(err => { console.error('\nErro fatal:', err.message); process.exit(1) })
