// Teste E2E — PinturaPro API (produção Railway)
// Uso: node teste-e2e.js SEU_ADMIN_TOKEN
//   ou: defina ADMIN_TOKEN no .env
//
// Fluxo testado:
//   1  Cadastro dono_obra
//   2  Cadastro prestador (pintor)
//   3  Login de ambas as contas, confirma JWT válido
//   4  Dono publica obra via POST /obras/dono
//   4a Admin aprova a obra (torna visível no feed)
//   4b Admin concede assinatura gratuita ao prestador (habilita acesso ao feed)
//   5  Prestador busca feed GET /obras e confirma obra aparece
//   6  Prestador se candidata à obra
//   7  Dono busca GET /obras/:id e confirma candidatura do prestador
//   8  Dono aprova a candidatura (aceita)
//   9  Dono confirma obra em GET /obras/minhas (deve estar em ativos)
//   10 Limpeza: cancela obra, exclui ambas as contas via admin
//
// NOTA: ADMIN_TOKEN deve ser um JWT de role='admin' ou 'aprovador' em produção.

require('dotenv').config()

const API          = 'https://pinturapro-api-production.up.railway.app/api'
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || process.argv[2]
const TS           = Date.now()
const SEP          = '='.repeat(62)
const SEP_THIN     = '-'.repeat(62)

if (!ADMIN_TOKEN) {
  console.error('Uso: node teste-e2e.js SEU_ADMIN_TOKEN')
  console.error('  ou: defina ADMIN_TOKEN no .env')
  process.exit(1)
}

// ─── dados de teste ───────────────────────────────────────────
const DONO_EMAIL   = `e2e-dono-${TS}@teste.pinturapro.dev`
const PINTOR_EMAIL = `e2e-pintor-${TS}@teste.pinturapro.dev`
const SENHA        = 'TesteE2E2024!'
// CPFs fictícios únicos baseados no timestamp (11 dígitos)
const DONO_CPF     = String(TS).slice(-11)
const PINTOR_CPF   = String(TS + 1).slice(-11)

// ─── estado compartilhado entre passos ────────────────────────
let donoId, donoToken
let pintorId, pintorToken
let obraId, candidaturaId

// ─── contadores ───────────────────────────────────────────────
let totalPassed = 0
let totalFailed = 0
const failures   = []

// ──────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────

async function api(method, path, body, token) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (token) opts.headers['Authorization'] = `Bearer ${token}`
  if (body)  opts.body = JSON.stringify(body)
  const r = await fetch(`${API}${path}`, opts)
  let data
  try { data = await r.json() } catch { data = {} }
  return { status: r.status, data }
}

function section(n, title) {
  console.log(`\n${SEP}`)
  console.log(`  PASSO ${n} — ${title}`)
  console.log(SEP)
}

function ok(label, detail) {
  totalPassed++
  console.log(`  ✓ ${label}${detail ? '  →  ' + detail : ''}`)
}

function fail(label, status, data) {
  totalFailed++
  const msg = `✗ ${label}  HTTP ${status}  ${JSON.stringify(data)}`
  console.log(`  ${msg}`)
  failures.push(msg)
  throw new Error(`FALHA: ${label}`)
}

function assert(condition, label, status, data) {
  if (!condition) fail(label, status, data)
}

function logReq(method, path, status, data) {
  console.log(`  ${SEP_THIN}`)
  console.log(`  ${method} ${path}`)
  console.log(`  HTTP ${status}`)
  console.log(`  ${JSON.stringify(data)}`)
}

// ──────────────────────────────────────────────────────────────
// LIMPEZA (sempre executada, mesmo se o teste falhar no meio)
// ──────────────────────────────────────────────────────────────

async function cleanup() {
  console.log(`\n${SEP}`)
  console.log('  LIMPEZA')
  console.log(SEP)

  if (obraId) {
    // Cancela via rota do dono (UPDATE status='cancelada', não deleta a linha)
    if (donoToken) {
      const { status, data } = await api('DELETE', `/obras/dono/${obraId}`, null, donoToken)
      console.log(`  DELETE /obras/dono/${obraId} → ${status}`)
      if (status === 200) ok('10a', `obra ${obraId} cancelada`)
      else console.log(`  ⚠ obra não cancelada: ${JSON.stringify(data)}`)
    }
  }

  if (pintorId) {
    const { status, data } = await api('DELETE', `/usuarios/${pintorId}`, null, ADMIN_TOKEN)
    console.log(`  DELETE /usuarios/${pintorId} → ${status}`)
    if (status === 200) ok('10b', `prestador ${pintorId} excluído`)
    else console.log(`  ⚠ prestador não excluído: ${JSON.stringify(data)} — excluir manualmente: ${PINTOR_EMAIL}`)
  }

  if (donoId) {
    // NOTA: se a obra ainda existe no banco (a rota /obras/dono/:id faz UPDATE, não DELETE),
    // a exclusão do dono pode falhar por FK (obras.criado_por). Nesse caso, excluir manualmente.
    const { status, data } = await api('DELETE', `/usuarios/${donoId}`, null, ADMIN_TOKEN)
    console.log(`  DELETE /usuarios/${donoId} → ${status}`)
    if (status === 200) ok('10c', `dono ${donoId} excluído`)
    else console.log(`  ⚠ dono não excluído: ${JSON.stringify(data)} — excluir manualmente: ${DONO_EMAIL} (id=${donoId})`)
  }

  if (!donoId && !pintorId) {
    console.log('  Nenhum recurso para limpar (teste interrompido antes da criação).')
  }
}

// ──────────────────────────────────────────────────────────────
// TESTE PRINCIPAL
// ──────────────────────────────────────────────────────────────

async function run() {
  console.log(SEP)
  console.log(`  TESTE E2E — PinturaPro API`)
  console.log(`  ${new Date().toISOString()}`)
  console.log(`  API: ${API}`)
  console.log(`  dono:   ${DONO_EMAIL}`)
  console.log(`  pintor: ${PINTOR_EMAIL}`)
  console.log(SEP)

  // ── PASSO 1: Cadastro dono_obra ─────────────────────────────
  section(1, 'Cadastro dono_obra (tipo_dono=pintura)')
  {
    const { status, data } = await api('POST', '/auth/cadastro', {
      nome:          'E2E Dono Teste',
      email:         DONO_EMAIL,
      senha:         SENHA,
      tipo_conta:    'dono_obra',
      cidade:        'Uberlândia',
      uf:            'MG',
      telefone:      '34999990001',
      cpf_cnpj:      DONO_CPF
    })
    logReq('POST', '/auth/cadastro (dono)', status, data)
    assert(status === 201,         '1-status-201',     status, data)
    assert(data.token,             '1-jwt-presente',   status, data)
    assert(data.usuario,           '1-usuario-objeto', status, data)
    assert(data.usuario.role === 'dono_obra', '1-role-dono_obra', status, { role: data.usuario.role })
    donoId    = data.usuario.id
    donoToken = data.token
    ok('1', `id=${donoId}  role=${data.usuario.role}  tipo_dono=${data.usuario.tipo_dono}`)
  }

  // ── PASSO 2: Cadastro prestador (pintor) ────────────────────
  section(2, 'Cadastro prestador (tipo_conta=pintor)')
  {
    const { status, data } = await api('POST', '/auth/cadastro', {
      nome:          'E2E Pintor Teste',
      email:         PINTOR_EMAIL,
      senha:         SENHA,
      tipo_conta:    'pintor',
      cidade:        'Uberlândia',
      uf:            'MG',
      telefone:      '34999990002',
      cpf_cnpj:      PINTOR_CPF
    })
    logReq('POST', '/auth/cadastro (pintor)', status, data)
    assert(status === 201,         '2-status-201',      status, data)
    assert(data.token,             '2-jwt-presente',    status, data)
    assert(data.usuario,           '2-usuario-objeto',  status, data)
    assert(data.usuario.role === 'prestador', '2-role-prestador', status, { role: data.usuario.role })
    assert(data.usuario.tipo_prestador === 'pintor', '2-tipo_prestador-pintor', status, { tipo_prestador: data.usuario.tipo_prestador })
    pintorId    = data.usuario.id
    pintorToken = data.token
    ok('2', `id=${pintorId}  role=${data.usuario.role}  tipo_prestador=${data.usuario.tipo_prestador}`)
  }

  // ── PASSO 3: Login de ambas as contas ───────────────────────
  section(3, 'Login — confirma JWT válido para ambas as contas')
  {
    // Login dono
    const { status: s1, data: d1 } = await api('POST', '/auth/login', { email: DONO_EMAIL, senha: SENHA })
    logReq('POST', '/auth/login (dono)', s1, d1)
    assert(s1 === 200,   '3a-status-200',  s1, d1)
    assert(d1.token,     '3a-jwt-dono',    s1, d1)
    donoToken = d1.token
    ok('3a', `dono login OK — JWT ${d1.token.slice(0, 20)}...`)

    // Login pintor
    const { status: s2, data: d2 } = await api('POST', '/auth/login', { email: PINTOR_EMAIL, senha: SENHA })
    logReq('POST', '/auth/login (pintor)', s2, d2)
    assert(s2 === 200,   '3b-status-200',  s2, d2)
    assert(d2.token,     '3b-jwt-pintor',  s2, d2)
    pintorToken = d2.token
    ok('3b', `pintor login OK — JWT ${d2.token.slice(0, 20)}...`)
  }

  // ── PASSO 4: Dono publica obra ──────────────────────────────
  section(4, 'Dono publica obra de teste via POST /obras/dono')
  {
    const { status, data } = await api('POST', '/obras/dono', {
      titulo:               `[E2E-${TS}] Pintura residencial — teste automatizado`,
      categoria:            'residencial',
      valor:                5000,
      cidade:               'Uberlândia',
      bairro:               'Centro',
      uf:                   'MG',
      metragem:             100,
      prazo_execucao_dias:  10,
      horas_para_expirar:   720,
      descricao:            'Obra criada por teste E2E automatizado — pode ser excluída com segurança',
      tags:                 ['e2e', 'teste']
    }, donoToken)
    logReq('POST', '/obras/dono', status, data)
    assert(status === 201,  '4-status-201',  status, data)
    assert(data.id,         '4-obra-id',     status, data)
    obraId = data.id
    ok('4', `obra criada id=${obraId}  status=${data.status}  status_aprovacao=${data.status_aprovacao}`)
    // Espera-se: status='rascunho', status_aprovacao='pendente'
  }

  // ── PASSO 4a: Admin aprova a obra ───────────────────────────
  section('4a', 'Admin aprova a obra (habilita no feed público)')
  {
    const { status, data } = await api('POST', `/obras-aprovacao/${obraId}/aprovar`, {}, ADMIN_TOKEN)
    logReq('POST', `/obras-aprovacao/${obraId}/aprovar`, status, data)
    assert(status === 200,  '4a-status-200',  status, data)
    ok('4a', data.mensagem)
  }

  // ── PASSO 4b: Admin concede assinatura ao prestador ─────────
  section('4b', 'Admin concede assinatura gratuita ao prestador (habilita feed)')
  {
    const { status, data } = await api(
      'POST', '/pagamentos/acesso-gratuito',
      { usuario_id: pintorId },
      ADMIN_TOKEN
    )
    logReq('POST', '/pagamentos/acesso-gratuito', status, data)
    assert(status === 200,  '4b-status-200',  status, data)
    ok('4b', data.mensagem || 'assinatura ativada')
  }

  // ── PASSO 5: Prestador busca feed e encontra a obra ─────────
  section(5, 'Prestador busca GET /obras e confirma obra de teste no feed')
  {
    const { status, data } = await api('GET', '/obras', null, pintorToken)
    logReq('GET', '/obras', status, data)
    assert(status === 200,            '5-status-200',       status, data)
    assert(Array.isArray(data.obras), '5-obras-array',      status, data)
    const encontrada = data.obras.find(o => o.id === obraId)
    assert(encontrada, '5-obra-no-feed', status, {
      obraId,
      total_no_feed: data.obras.length,
      primeiros_ids: data.obras.slice(0, 3).map(o => o.id)
    })
    ok('5', `obra ${obraId} encontrada (${data.obras.length} obra(s) no feed)`)
  }

  // ── PASSO 6: Prestador se candidata ─────────────────────────
  section(6, 'Prestador submete candidatura na obra')
  {
    const { status, data } = await api('POST', `/obras/${obraId}/candidatura`, {
      mensagem:      'Candidatura de teste E2E automatizado — ignore',
      valor_proposto: 4800
    }, pintorToken)
    logReq('POST', `/obras/${obraId}/candidatura`, status, data)
    assert(status === 201,  '6-status-201',      status, data)
    assert(data.id,         '6-candidatura-id',  status, data)
    candidaturaId = data.id
    ok('6', `candidatura id=${candidaturaId}  status=${data.status}  valor_proposto=${data.valor_proposto}`)
  }

  // ── PASSO 7: Dono verifica candidatos da obra ───────────────
  section(7, 'Dono busca GET /obras/:id e confirma candidatura do prestador')
  {
    const { status, data } = await api('GET', `/obras/${obraId}`, null, donoToken)
    logReq('GET', `/obras/${obraId}`, status, data)
    assert(status === 200,           '7-status-200',     status, data)
    assert(Array.isArray(data.candidatos), '7-candidatos-array', status, data)
    const cand = data.candidatos.find(c => c.usuario_id === pintorId)
    assert(cand, '7-candidatura-na-lista', status, {
      pintorId,
      total_candidatos: data.candidatos.length,
      candidatos_ids: data.candidatos.map(c => c.usuario_id)
    })
    ok('7', `candidatura do pintor encontrada (${data.candidatos.length} candidato(s))  status=${cand.status}`)
  }

  // ── PASSO 8: Dono aprova a candidatura ──────────────────────
  section(8, 'Dono aprova a candidatura (action=aceitar)')
  {
    const { status, data } = await api(
      'POST',
      `/obras/${obraId}/candidatura/${candidaturaId}/responder`,
      { action: 'aceitar' },
      donoToken
    )
    logReq('POST', `/obras/${obraId}/candidatura/${candidaturaId}/responder`, status, data)
    assert(status === 200,  '8-status-200',  status, data)
    ok('8', data.mensagem)

    // Confirma que a candidatura realmente ficou com status 'aceito'
    const { status: s2, data: d2 } = await api('GET', `/obras/${obraId}`, null, donoToken)
    const candAtualizada = (d2.candidatos || []).find(c => c.id === candidaturaId)
    assert(candAtualizada,                            '8-candidatura-ainda-existe', s2, d2)
    assert(candAtualizada.status === 'aceito',        '8-status-aceito',            s2, { status: candAtualizada.status })
    ok('8-confirm', `candidatura ${candidaturaId} confirmada com status='aceito'`)
  }

  // ── PASSO 9: Dono verifica GET /obras/minhas ────────────────
  section(9, 'Dono confirma obra em GET /obras/minhas (deve estar em ativos)')
  {
    const { status, data } = await api('GET', '/obras/minhas', null, donoToken)
    logReq('GET', '/obras/minhas', status, data)
    assert(status === 200,           '9-status-200',     status, data)
    assert(Array.isArray(data.obras), '9-obras-array',   status, data)
    const noAtivo    = data.obras.find(o => o.id === obraId)
    const noHistorico = (data.historico || []).find(o => o.id === obraId)
    if (noHistorico && !noAtivo) {
      fail('9-obra-em-historico', status, { msg: 'obra aparece em historico em vez de ativos — encerrada prematuramente?' })
    }
    assert(noAtivo, '9-obra-em-ativos', status, {
      obraId,
      total_ativos: data.obras.length,
      total_historico: (data.historico || []).length
    })
    ok('9', `obra ${obraId} em ativos (${data.obras.length} ativo(s), ${(data.historico || []).length} histórico(s))`)
  }
}

// ──────────────────────────────────────────────────────────────
// ENTRY POINT
// ──────────────────────────────────────────────────────────────

async function main() {
  try {
    await run()
  } catch (err) {
    // fail() already recorded the failure — just stop here
  } finally {
    await cleanup()

    console.log(`\n${SEP}`)
    console.log('  RESULTADO FINAL')
    console.log(SEP)
    console.log(`  ✓ Passou : ${totalPassed}`)
    console.log(`  ✗ Falhou : ${totalFailed}`)
    if (failures.length > 0) {
      console.log('\n  Falhas:')
      failures.forEach(f => console.log(`    ${f}`))
    } else {
      console.log('\n  ✅ Todos os passos passaram!')
    }
    console.log(SEP)
    if (totalFailed > 0) process.exit(1)
  }
}

main().catch(err => {
  console.error('\nErro fatal inesperado:', err)
  process.exit(1)
})
