#!/usr/bin/env node
// ACORDO ÉTICO DO CONTRATANTE + MOTIVO DO CANCELAMENTO PELO DONO (dono, 23/11/2026 — utils/acordoEtico).
//  1) usuarios.acordo_etico_aceito_em; precisa_acordo_etico no login (montarSessao) e em GET /auth/perfil,
//     só na conta contratante: true sem aceite, ou com 2+ demandas canceladas/vencidas SEM profissional
//     escolhido desde o último aceite (por PESSOA: contas contratantes do mesmo CPF);
//  2) POST /auth/acordo-etico grava now(); POST /obras/dono e /reparos/dono com acordo_etico: true gravam
//     o aceite no mesmo statement do INSERT (sem o campo — app antigo — criam como sempre);
//  3) DELETE /reparos/dono/:id e /obras/dono/:id aceitam motivo_cancelamento (4 valores; opcional; fora da
//     lista → 400 sem cancelar) e GET /:tabela/admin?filtro=canceladas devolve o campo.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-acordo-etico.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { return chunk.map((_, i) => ({ status: 'ok', id: `t-${i}` })) }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
const q = async (sql, params) => { if (!db) throw new Error('sem banco (boot)'); const r = await db.query(sql, params); r.rowCount = r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0); return r }
const shim = { query: q, connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: q, release() {} } }, on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async () => {}, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async () => {} }
  return origLoad.apply(this, arguments)
}
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const erros = []
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { errOrig('unhandled', e && (e.stack || e)); process.exit(1) } })
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? (...a) => erros.push(a.map(x => x?.message || String(x)).join(' ').slice(0, 300)) : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const authCtrl = require(path.join(REPO, 'src/controllers/authController.js'))
const acordo = require(path.join(REPO, 'src/utils/acordoEtico.js'))
const cancelamento = require(path.join(REPO, 'src/services/cancelamentoMatchService.js'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 300))
// DONO/IRMA: mesma pessoa (mesmo CPF, duas contas contratantes). NOVO: dono usado nos creates.
const ADMIN = U(1), DONO = U(10), IRMA = U(11), OUTRO = U(12), NOVO = U(13), PRO = U(20)
const SESSAO = { [ADMIN]: { role: 'admin' }, [DONO]: { role: 'dono_obra' }, [IRMA]: { role: 'dono_obra' }, [OUTRO]: { role: 'dono_obra' }, [NOVO]: { role: 'dono_obra' }, [PRO]: { role: 'prestador', tipo_prestador: 'reparador' } }
const reqFalso = (usuarioId, { body = {}, params = {}, query = {} } = {}) => ({ params, body, query, headers: {}, usuario: { id: usuarioId, ...(SESSAO[usuarioId] || {}) }, get() { return '' } })
const chamar = (metodo, caminho, usuarioId, opcoes = {}) => new Promise((resolve, reject) => {
  const camada = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!camada) return reject(new Error(`rota não encontrada: ${metodo} ${caminho}`))
  const handler = camada.route.stack[camada.route.stack.length - 1].handle
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  Promise.resolve(handler(reqFalso(usuarioId, opcoes), res)).catch(reject)
})
const quieto = async (fn) => { silenciar(true); try { return await fn() } finally { await assentar(); silenciar(false) } }

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`CREATE UNIQUE INDEX t_configuracoes_uq ON configuracoes (chave); CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id);
                 CREATE UNIQUE INDEX t_obras_crid ON obras (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
                 CREATE UNIQUE INDEX t_reparos_crid ON reparos (criado_por, client_request_id) WHERE client_request_id IS NOT NULL`)
  await db.query(`INSERT INTO usuarios (id, nome, email, role, tipo_dono, tipo_prestador, cidade, uf, cpf_cnpj) VALUES
    ($1, 'Admin', 'admin@x.invalid', 'admin', NULL, NULL, NULL, NULL, '00000000001'),
    ($2, 'Thaís Cliente', 'dono@x.invalid', 'dono_obra', 'obra', NULL, 'Patos de Minas', 'MG', '00000000010'),
    ($3, 'Thaís Cliente', 'dono@x.invalid', 'dono_obra', 'reparo', NULL, 'Patos de Minas', 'MG', '000.000.000-10'),
    ($4, 'Outro Cliente', 'outro@x.invalid', 'dono_obra', 'reparo', NULL, 'Patos de Minas', 'MG', '00000000012'),
    ($5, 'Cliente Novo', 'novo@x.invalid', 'dono_obra', 'reparo', NULL, 'Patos de Minas', 'MG', '00000000013'),
    ($6, 'Pro Teste', 'pro@x.invalid', 'prestador', NULL, 'reparador', 'Patos de Minas', 'MG', '00000000020')`, [ADMIN, DONO, IRMA, OUTRO, NOVO, PRO])

  let seq = 0
  // encerradoHa / expiraEm em MINUTOS relativos a agora (expiraEm negativo = passado); null = coluna NULL.
  const demanda = async (tabela, dono, status, { encerradoHa = null, expiraEm = 60 * 24 * 10, match = null, chegada = false, canceladaPor = null } = {}) => {
    const id = D(++seq)
    await db.query(
      `INSERT INTO ${tabela} (id, titulo, categoria, criado_por, ${tabela === 'reparos' ? 'valor_estimado, prazo_atendimento_horas' : 'valor, horas_para_expirar'}, cidade, uf, status, status_aprovacao,
                              criado_em, expira_em, encerrado_em, match_usuario_id, match_feito_em, chegada_confirmada_em, push_novo_enviado_em, cancelada_por)
       VALUES ($1, $2, $3, $4, 100, 24, 'Patos de Minas', 'MG', $5, $6, now() - INTERVAL '30 days', now() + make_interval(mins => $7::int),
               CASE WHEN $8::int IS NULL THEN NULL ELSE now() - make_interval(mins => $8::int) END, $9::uuid,
               CASE WHEN $9::uuid IS NULL THEN NULL ELSE now() - INTERVAL '3 hours' END, CASE WHEN $10::boolean THEN now() - INTERVAL '1 hour' ELSE NULL END, now() - INTERVAL '30 days', $11)`,
      [id, `Pedido ${seq}`, tabela === 'reparos' ? 'salgadeiro' : 'residencial', dono, status, status === 'aberta' ? 'aprovada' : status, expiraEm, encerradoHa, match, chegada, canceladaPor])
    return id
  }
  const proposta = (tabela, demandaId, status) => {
    const [t, fk] = tabela === 'reparos' ? ['interesse_reparos', 'reparo_id'] : ['candidaturas', 'obra_id']
    return db.query(`INSERT INTO ${t} (${fk}, usuario_id, status, valor_proposto) VALUES ($1, $2, $3, 90)`, [demandaId, PRO, status])
  }
  // aceite há N minutos (null = nunca aceitou)
  const aceitarHa = (usuarioId, mins) => db.query(`UPDATE usuarios SET acordo_etico_aceito_em = CASE WHEN $2::int IS NULL THEN NULL ELSE now() - make_interval(mins => $2::int) END WHERE id = $1`, [usuarioId, mins])
  const aceiteDe = async (usuarioId) => (await db.query('SELECT acordo_etico_aceito_em FROM usuarios WHERE id = $1', [usuarioId])).rows[0].acordo_etico_aceito_em
  const perfil = async (usuarioId) => (await quieto(() => chamar('get', '/auth/perfil', usuarioId))).body?.usuario
  const sessao = async (usuarioId) => {
    const linha = (await db.query('SELECT * FROM usuarios WHERE id = $1', [usuarioId])).rows[0]
    return (await quieto(() => authCtrl.montarSessao(linha, reqFalso(usuarioId)))).usuario
  }
  const precisa = async (usuarioId) => {
    const [p, s] = [await perfil(usuarioId), await sessao(usuarioId)]
    return p?.precisa_acordo_etico === s?.precisa_acordo_etico ? p?.precisa_acordo_etico : `DIVERGE perfil=${p?.precisa_acordo_etico} sessao=${s?.precisa_acordo_etico}`
  }
  const cancelar = (tabela, usuarioId, id, opcoes = {}) => quieto(() => chamar('delete', `/${tabela}/dono/:id`, usuarioId, { params: { id }, ...opcoes }))
  const linha = async (tabela, id) => (await db.query(`SELECT status, cancelada_por, motivo_cancelamento FROM ${tabela} WHERE id = $1`, [id])).rows[0]

  ok(acordo.MOTIVO_PROPOSTA_CANCELADA_PELO_CLIENTE === cancelamento.MOTIVO_CANCELADO_PELO_CLIENTE, 'literal do motivo da proposta = constante do cancelamentoMatchService')

  // ═══ 1. Quem recebe o campo e o "nunca aceitou" ══════════════════════════════════════════════
  ok(await precisa(DONO) === true, 'dono que nunca aceitou: precisa_acordo_etico = true (login e perfil)', await precisa(DONO))
  const pPro = await perfil(PRO), sPro = await sessao(PRO), pAdm = await perfil(ADMIN)
  ok(pPro && !('precisa_acordo_etico' in pPro) && !('precisa_acordo_etico' in sPro) && pAdm && !('precisa_acordo_etico' in pAdm), 'profissional e admin: payload sem o campo (como antes)')

  // ═══ 2. POST /auth/acordo-etico ══════════════════════════════════════════════════════════════
  let r = await quieto(() => chamar('post', '/auth/acordo-etico', DONO))
  ok(r.status === 200 && r.body.ok === true && r.body.precisa_acordo_etico === false && r.body.acordo_etico_aceito_em && (await aceiteDe(DONO)) !== null, 'POST /auth/acordo-etico: grava now() e responde precisa_acordo_etico false', { status: r.status, body: r.body })
  ok(await precisa(DONO) === false, 'depois do aceite: false')
  ok(await precisa(IRMA) === false && (await aceiteDe(IRMA)) === null, 'outra conta contratante da MESMA pessoa (mesmo CPF): já vale o aceite, sem ser perguntada de novo')
  ok(await precisa(OUTRO) === true, 'outro dono (outro CPF) segue true')

  // ═══ 3. Contagem desde o último aceite (aceite há 60 min) ════════════════════════════════════
  await aceitarHa(DONO, 60)
  // NÃO contam:
  await demanda('reparos', DONO, 'cancelada', { encerradoHa: 120 })                              // cancelada ANTES do aceite
  await demanda('obras', DONO, 'aberta', { expiraEm: -120 })                                     // venceu ANTES do aceite
  await demanda('reparos', DONO, 'cancelada', { encerradoHa: 10, expiraEm: -120 })               // venceu antes do aceite, cancelada depois
  await demanda('obras', DONO, 'cancelada', { encerradoHa: 10, canceladaPor: 'admin' })          // cancelada pelo ADMIN
  await demanda('reparos', DONO, 'aberta', { expiraEm: -10, match: PRO })                        // vencida COM match
  await proposta('obras', await demanda('obras', DONO, 'aberta', { expiraEm: -10 }), 'aceito')   // vencida com proposta aceita
  await demanda('reparos', DONO, 'encerrada', { encerradoHa: 10 })                               // concluída
  await demanda('obras', DONO, 'aberta', { expiraEm: 600 })                                      // aberta no prazo
  await demanda('reparos', OUTRO, 'cancelada', { encerradoHa: 10 })                              // de OUTRA pessoa
  for (const tabela of ['reparos', 'obras']) {                                                   // cancelada EM ANDAMENTO (havia escolhido)
    const id = await demanda(tabela, DONO, 'aberta', { match: PRO, chegada: true })
    await proposta(tabela, id, 'aceito')
    r = await cancelar(tabela, DONO, id, { body: { motivo_cancelamento: 'desisti' } })
    const c = await linha(tabela, id)
    ok(r.status === 200 && r.body.em_andamento === true && c.status === 'cancelada' && c.cancelada_por === 'cliente' && c.motivo_cancelamento === 'desisti', `DELETE /${tabela}/dono/:id em andamento: grava o motivo`, { status: r.status, c })
  }
  let sit = await acordo.situacaoAcordoEtico(DONO)
  ok(sit.sem_escolhido === 0 && await precisa(DONO) === false, 'não contam: antes do aceite, vencida-antes-e-cancelada-depois, pelo admin, com escolhido (match / proposta aceita / em andamento), concluída, no prazo, de outra pessoa', sit)

  // CONTAM: 1 cancelada pelo dono agora → ainda false; +1 vencida → true
  const aCancelar = await demanda('reparos', DONO, 'aberta')
  r = await cancelar('reparos', DONO, aCancelar, { body: { motivo_cancelamento: 'ninguem_respondeu' } })
  sit = await acordo.situacaoAcordoEtico(DONO)
  ok(r.status === 200 && sit.sem_escolhido === 1 && await precisa(DONO) === false, '1 cancelada pelo dono sem escolhido depois do aceite: ainda false', { status: r.status, sit })
  const vencida = await demanda('obras', IRMA, 'aberta', { expiraEm: -5 })
  sit = await acordo.situacaoAcordoEtico(DONO)
  ok(sit.sem_escolhido === 2 && await precisa(DONO) === true && await precisa(IRMA) === true, '+1 vencida sem escolhido (obra da outra conta da pessoa): 2 → true nas duas contas', sit)
  await db.query(`UPDATE obras SET expira_em = now() + INTERVAL '2 days' WHERE id = $1`, [vencida])
  ok(await precisa(DONO) === false, 'prazo estendido: a vencida sai da conta → false')
  await db.query(`UPDATE obras SET expira_em = now() - INTERVAL '5 minutes' WHERE id = $1`, [vencida])
  await demanda('reparos', DONO, 'cancelada', { encerradoHa: 5 })                                // histórico: cancelada_por NULL conta
  ok((await acordo.situacaoAcordoEtico(DONO)).sem_escolhido === 3 && await precisa(DONO) === true, 'cancelada sem carimbo de quem cancelou (cancelada_por NULL) conta')
  // Novo aceite (pela outra conta da pessoa) zera a contagem.
  r = await quieto(() => chamar('post', '/auth/acordo-etico', IRMA))
  sit = await acordo.situacaoAcordoEtico(DONO)
  ok(r.status === 200 && r.body.precisa_acordo_etico === false && sit.sem_escolhido === 0 && await precisa(DONO) === false && await precisa(IRMA) === false, 'novo aceite: a contagem recomeça do zero (vale para a pessoa)', sit)

  // ═══ 4. Create com acordo_etico ═════════════════════════════════════════════════════════════
  const corpoReparo = (extra = {}) => ({ titulo: 'Consertar torneira', descricao: 'Pingando na cozinha', categoria: 'hidraulica', valor_estimado: 120, cidade: 'Patos de Minas', uf: 'MG', bairro: 'Centro', prazo_atendimento_horas: 24, tera_midias: true, ...extra })
  const corpoObra = (extra = {}) => ({ titulo: 'Pintar sala', descricao: 'Sala de 20 metros', categoria: 'residencial', valor: 900, cidade: 'Patos de Minas', uf: 'MG', bairro: 'Centro', metragem: 20, prazo_execucao_dias: 3, horas_para_expirar: 48, ...extra })
  r = await quieto(() => chamar('post', '/reparos/dono', NOVO, { body: corpoReparo() }))
  ok(r.status === 201 && r.body.id && (await aceiteDe(NOVO)) === null && await precisa(NOVO) === true, 'POST /reparos/dono SEM acordo_etico (app antigo): cria 201 e não grava aceite', { status: r.status, erro: r.body?.erro })
  r = await quieto(() => chamar('post', '/reparos/dono', NOVO, { body: corpoReparo({ acordo_etico: true, tags: 'não-é-array' }) }))
  ok(r.status === 500 && (await aceiteDe(NOVO)) === null, 'POST /reparos/dono com acordo_etico: true e INSERT que falha: aceite NÃO gravado (mesmo statement)', { status: r.status })
  erros.length = 0 // o 500 acima é proposital
  r = await quieto(() => chamar('post', '/reparos/dono', NOVO, { body: corpoReparo({ acordo_etico: true }) }))
  ok(r.status === 201 && (await aceiteDe(NOVO)) !== null && await precisa(NOVO) === false, 'POST /reparos/dono com acordo_etico: true: cria e grava o aceite', { status: r.status, erro: r.body?.erro })
  await aceitarHa(NOVO, null)
  r = await quieto(() => chamar('post', '/obras/dono', NOVO, { body: corpoObra() }))
  ok(r.status === 201 && r.body.id && (await aceiteDe(NOVO)) === null, 'POST /obras/dono SEM acordo_etico: cria 201 e não grava aceite', { status: r.status, erro: r.body?.erro })
  r = await quieto(() => chamar('post', '/obras/dono', NOVO, { body: corpoObra({ acordo_etico: true, client_request_id: 'req-1' }) }))
  const aceite1 = await aceiteDe(NOVO)
  ok(r.status === 201 && aceite1 !== null && await precisa(NOVO) === false, 'POST /obras/dono com acordo_etico: true: cria e grava o aceite', { status: r.status, erro: r.body?.erro })
  const total = async () => (await db.query('SELECT COUNT(*)::int AS n FROM obras WHERE criado_por = $1', [NOVO])).rows[0].n
  const antes = await total()
  const r2 = await quieto(() => chamar('post', '/obras/dono', NOVO, { body: corpoObra({ acordo_etico: true, client_request_id: 'req-1' }) }))
  ok(r2.status === 201 && r2.body.id === r.body.id && await total() === antes, 'retry do create com a mesma client_request_id: devolve a mesma obra (ON CONFLICT segue valendo com a CTE)', { status: r2.status })

  // ═══ 5. motivo_cancelamento ═════════════════════════════════════════════════════════════════
  for (const tabela of ['reparos', 'obras']) {
    const ids = {}
    for (const m of acordo.MOTIVOS_CANCELAMENTO_DONO) {
      ids[m] = await demanda(tabela, OUTRO, 'aberta')
      r = await cancelar(tabela, OUTRO, ids[m], m === 'ja_resolvi' ? { query: { motivo_cancelamento: m } } : { body: { motivo_cancelamento: m } })
      const c = await linha(tabela, ids[m])
      ok(r.status === 200 && c.status === 'cancelada' && c.cancelada_por === 'cliente' && c.motivo_cancelamento === m, `DELETE /${tabela}/dono/:id motivo '${m}'${m === 'ja_resolvi' ? ' (na query string)' : ''}: gravado`, { status: r.status, c })
    }
    const semMotivo = await demanda(tabela, OUTRO, 'aberta')
    r = await cancelar(tabela, OUTRO, semMotivo)
    let c = await linha(tabela, semMotivo)
    ok(r.status === 200 && c.status === 'cancelada' && c.motivo_cancelamento === null, `DELETE /${tabela}/dono/:id sem motivo (app antigo): cancela como sempre, motivo NULL`, { status: r.status, c })
    const invalido = await demanda(tabela, OUTRO, 'aberta')
    r = await cancelar(tabela, OUTRO, invalido, { body: { motivo_cancelamento: 'porque sim' } })
    c = await linha(tabela, invalido)
    ok(r.status === 400 && r.body.codigo === 'MOTIVO_CANCELAMENTO_INVALIDO' && c.status === 'aberta' && c.motivo_cancelamento === null, `DELETE /${tabela}/dono/:id motivo fora da lista: 400 e nada é cancelado`, { status: r.status, c })
    const l = await quieto(() => chamar('get', `/${tabela}/admin`, ADMIN, { query: { filtro: 'canceladas' } }))
    const porId = Object.fromEntries((l.body?.[tabela] || []).map(x => [x.id, x]))
    ok(l.status === 200 && acordo.MOTIVOS_CANCELAMENTO_DONO.every(m => porId[ids[m]]?.motivo_cancelamento === m) && porId[semMotivo] && porId[semMotivo].motivo_cancelamento === null
       && (l.body[tabela]).every(x => Object.prototype.hasOwnProperty.call(x, 'motivo_cancelamento')),
       `GET /${tabela}/admin?filtro=canceladas devolve motivo_cancelamento (null sem motivo)`, { status: l.status, erro: l.body?.erro })
  }

  const errosReais = erros.filter(e => !/sem banco|migration/i.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
