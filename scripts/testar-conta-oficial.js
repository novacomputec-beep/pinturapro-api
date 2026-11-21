#!/usr/bin/env node
// CATEGORIA NOVA 'conserto_celular' + CONTA OFICIAL DO PROTUDO (dono, 21/11/2026).
//  1) 'conserto_celular' ("Conserto de celular e tablet", 📲): vocabulário de serviço, mesmo grupo
//     de 'eletronica' (push: Consertos da casa; avaliação: Elétrica e tecnologia), local de
//     atendimento e dica de foto;
//  2) usuarios.oficial (migração idempotente, DEFAULT false);
//  3) POST /admin/conta-oficial: só super-admin; marca UMA conta de contratante (a anterior sai);
//  4) POST /admin/pedidos-oficiais: só super-admin; cria um reparo NORMAL da conta oficial pelo
//     mesmo handler do POST /reparos/dono (validações, moderação, push de demanda nova);
//  5) dono_oficial no feed e no detalhe (reparos e obras);
//  6) "ProTudo" no nome: recusado no cadastro e na edição de perfil de quem não é a conta oficial.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-conta-oficial.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

const pushes = []
const emails = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { pushes.push(...chunk); return chunk.map((_, i) => ({ status: 'ok', id: `t${pushes.length}-${i}` })) }
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
  if (/brevoService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) }, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async () => {} }
  return origLoad.apply(this, arguments)
}
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const erros = []
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { errOrig('unhandled', e && (e.stack || e)); process.exit(1) } })
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? (...a) => erros.push(a.map(x => x?.message || String(x)).join(' ').slice(0, 300)) : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const CO = require(path.join(REPO, 'src/utils/contaOficial'))
const CAT = require(path.join(REPO, 'src/utils/categoriasApp'))
const ESP = require(path.join(REPO, 'src/utils/especialidades'))
const GR = require(path.join(REPO, 'src/utils/gruposCategorias'))
const ET = require(path.join(REPO, 'src/utils/etiquetasAvaliacao'))
const LA = require(path.join(REPO, 'src/utils/localAtendimento'))
const DF = require(path.join(REPO, 'src/utils/dicaFoto'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 300))
const ADMIN = U(1), APROVADOR = U(2), DONO_A = U(10), DONO_B = U(11), DONO_DUP1 = U(12), DONO_DUP2 = U(13), PRO_CEL = U(20), PRO_ELETRONICA = U(21), PRO_FAXINA = U(22), PINTOR = U(23)
const SESSAO = {
  [ADMIN]: { role: 'admin' }, [APROVADOR]: { role: 'aprovador' },
  [DONO_A]: { role: 'dono_obra' }, [DONO_B]: { role: 'dono_obra' },
  [PRO_CEL]: { role: 'prestador', tipo_prestador: 'reparador' }, [PINTOR]: { role: 'prestador', tipo_prestador: 'pintor' },
}
const tok = (id) => `ExponentPushToken[${id.slice(-3)}]`
// Roda a cadeia REAL da rota menos o primeiro middleware (autenticar): os guardas de papel
// (exigirSuperAdmin etc.) valem como em produção.
const chamar = (metodo, caminho, usuarioId, { body = {}, params = {}, query = {}, soHandler = false } = {}) => new Promise((resolve, reject) => {
  const camada = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!camada) return reject(new Error(`rota não encontrada: ${metodo} ${caminho}`))
  const pilha = camada.route.stack.map(s => s.handle)
  const cadeia = soHandler ? pilha.slice(-1) : pilha.slice(1)
  const req = { params, body, query, headers: {}, usuario: { id: usuarioId, ...(SESSAO[usuarioId] || {}) }, get() { return '' }, ip: '127.0.0.1' }
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) }, set() { return this } }
  let i = 0
  const next = (err) => { if (err) return reject(err); const h = cadeia[i++]; if (!h) return resolve({ status: 0, body: null }); Promise.resolve(h(req, res, next)).catch(reject) }
  next()
})
const quieto = async (fn) => { silenciar(true); try { return await fn() } finally { await assentar(); silenciar(false) } }

const main = async () => {
  // ═══ 1. Categoria nova ═════════════════════════════════════════════════════════════════════
  const ap = CAT.apresentacaoReparo('conserto_celular', '🔧')
  ok(ap.rotulo === 'Conserto de celular e tablet' && ap.emoji === '📲', 'categoria: rótulo "Conserto de celular e tablet", emoji 📲', ap)
  ok(ESP.ESPECIALIDADES_REPARADOR.includes('conserto_celular') && ESP.ESPECIALIDADES_REPARADOR[ESP.ESPECIALIDADES_REPARADOR.length - 1] === 'outros'
     && !ESP.validarEspecialidades(['conserto_celular'], true, 'reparador').erro,
     'especialidade válida para reparador; "outros" segue fechando a lista')
  ok(new Set(CAT.CATEGORIAS_SERVICO.map(c => c.slug)).size === CAT.CATEGORIAS_SERVICO.length && CAT.CATEGORIAS_SERVICO.length === ESP.ESPECIALIDADES_REPARADOR.length,
     'CATEGORIAS_SERVICO e ESPECIALIDADES_REPARADOR: mesmos slugs, sem repetição', [CAT.CATEGORIAS_SERVICO.length, ESP.ESPECIALIDADES_REPARADOR.length])
  const grupoDe = (slug) => Object.entries(GR.GRUPOS_RELACIONADOS).find(([, l]) => l.includes(slug))?.[0]
  ok(grupoDe('conserto_celular') === grupoDe('eletronica') && grupoDe('conserto_celular') !== undefined, 'grupo de push: o mesmo de eletronica', grupoDe('conserto_celular'))
  const gruposEtiqueta = (slug) => ET.GRUPOS_AVALIACAO.filter(g => g.especialidades.includes(slug)).map(g => g.nome)
  ok(JSON.stringify(gruposEtiqueta('conserto_celular')) === JSON.stringify(['Elétrica e tecnologia']) && JSON.stringify(gruposEtiqueta('eletronica')) === JSON.stringify(['Elétrica e tecnologia']),
     'grupo de avaliação: "Elétrica e tecnologia", como eletronica', gruposEtiqueta('conserto_celular'))
  ok(LA.CATEGORIAS_LOCAL_ATENDIMENTO.includes('conserto_celular') && LA.normalizarLocalAtendimento('local_profissional', ['conserto_celular']).valor === 'local_profissional',
     'CATEGORIAS_LOCAL_ATENDIMENTO: aceita local_atendimento')
  ok(DF.CATEGORIAS_PEDE_FOTO.includes('conserto_celular') && DF.pedeFoto('reparos', ['conserto_celular']) === true, 'CATEGORIAS_PEDE_FOTO: pede foto')

  // ═══ 2. Migração ═══════════════════════════════════════════════════════════════════════════
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`ALTER TABLE usuarios DROP COLUMN IF EXISTS oficial`)
  await CO.migrarContaOficial({ query: (s, p) => db.query(s, p) })
  await CO.migrarContaOficial({ query: (s, p) => db.query(s, p) })
  await db.exec(`
    CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_push_entregas_uq ON push_entregas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_configuracoes_uq ON configuracoes (chave);
    CREATE UNIQUE INDEX t_acima_teto_uq ON avisos_acima_do_teto (tabela, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_reparos_crid_uq ON reparos (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true'), ('email_resumo_diario', 'false');
  `)
  const usuario = (id, nome, email, role, extra = {}) => db.query(
    `INSERT INTO usuarios (id, nome, email, role, tipo_dono, tipo_prestador, cidade, uf, cpf_cnpj, push_token, especialidades, ativo, avisos_todas_areas)
     VALUES ($1, $2, $3, $4, $5, $6, 'Patos de Minas', 'MG', $7, $8, $9::text[], $10, false)`,
    [id, nome, email, role, extra.tipo_dono || null, extra.tipo_prestador || null, extra.cpf || id.slice(-11), extra.token ? tok(id) : null, extra.esp || null, extra.ativo !== false])
  await usuario(ADMIN, 'Admin', 'admin@x.invalid', 'admin')
  await usuario(APROVADOR, 'Aprovador', 'aprovador@x.invalid', 'aprovador')
  await usuario(DONO_A, 'Equipe Oficial', 'oficial@x.invalid', 'dono_obra', { tipo_dono: 'reparo' })
  await usuario(DONO_B, 'Maria Cliente', 'maria@x.invalid', 'dono_obra', { tipo_dono: 'reparo' })
  await usuario(DONO_DUP1, 'Dup Obra', 'dup@x.invalid', 'dono_obra', { tipo_dono: 'pintura', cpf: '11111111111' })
  await usuario(DONO_DUP2, 'Dup Reparo', 'dup@x.invalid', 'dono_obra', { tipo_dono: 'reparo', cpf: '11111111111' })
  for (const [id, nome, esp, tipo] of [[PRO_CEL, 'Pro Celular', ['conserto_celular'], 'reparador'], [PRO_ELETRONICA, 'Pro Eletrônica', ['eletronica'], 'reparador'], [PRO_FAXINA, 'Pro Faxina', ['faxina'], 'reparador'], [PINTOR, 'Pro Pintor', ['pintor'], 'pintor']]) {
    await usuario(id, nome, `${id.slice(-3)}@x.invalid`, 'prestador', { tipo_prestador: tipo, esp, token: true })
    await db.query(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [id])
  }
  const oficiais = async () => (await db.query(`SELECT id FROM usuarios WHERE oficial IS TRUE ORDER BY id`)).rows.map(r => r.id)
  ok((await oficiais()).length === 0 && (await db.query(`SELECT count(*)::int AS n FROM usuarios WHERE oficial IS FALSE`)).rows[0].n === 10, 'migração (2x): usuarios.oficial NOT NULL DEFAULT false — ninguém nasce oficial')

  // ═══ 3. POST /admin/pedidos-oficiais sem conta marcada; POST /admin/conta-oficial ══════════
  const pedido = { titulo: 'Trocar tela de celular', categoria: 'conserto_celular', cidade: 'Patos de Minas', uf: 'MG', valor: 250, prazo: 24, detalhes: 'Tela trincada, modelo 2023.' }
  let r = await quieto(() => chamar('post', '/admin/pedidos-oficiais', ADMIN, { body: pedido }))
  ok(r.status === 409 && r.body.codigo === 'sem_conta_oficial', 'pedido oficial sem conta marcada: 409 sem_conta_oficial', r)
  for (const [quem, id] of [['aprovador', APROVADOR], ['contratante', DONO_B], ['profissional', PRO_CEL]]) {
    const a = await quieto(() => chamar('post', '/admin/conta-oficial', id, { body: { email: 'oficial@x.invalid' } }))
    const b = await quieto(() => chamar('post', '/admin/pedidos-oficiais', id, { body: pedido }))
    ok(a.status === 403 && b.status === 403, `${quem}: 403 nos dois endpoints (só super-admin)`, [a.status, b.status])
  }
  ok((await oficiais()).length === 0, 'tentativas negadas não marcam ninguém')
  r = await quieto(() => chamar('post', '/admin/conta-oficial', ADMIN, { body: {} }))
  ok(r.status === 400, 'conta-oficial sem usuario_id nem email: 400', r)
  r = await quieto(() => chamar('post', '/admin/conta-oficial', ADMIN, { body: { usuario_id: 'abc' } }))
  ok(r.status === 400, 'usuario_id malformado: 400', r)
  r = await quieto(() => chamar('post', '/admin/conta-oficial', ADMIN, { body: { email: 'ninguem@x.invalid' } }))
  ok(r.status === 404 && r.body.codigo === 'conta_nao_encontrada', 'e-mail sem conta: 404 (o endpoint não cria conta)', r)
  r = await quieto(() => chamar('post', '/admin/conta-oficial', ADMIN, { body: { usuario_id: PRO_CEL } }))
  ok(r.status === 400 && r.body.codigo === 'nao_contratante', 'conta de profissional: 400 nao_contratante', r)
  r = await quieto(() => chamar('post', '/admin/conta-oficial', ADMIN, { body: { usuario_id: ADMIN } }))
  ok(r.status === 400 && r.body.codigo === 'nao_contratante', 'conta admin: 400 nao_contratante', r)
  r = await quieto(() => chamar('post', '/admin/conta-oficial', ADMIN, { body: { email: 'dup@x.invalid' } }))
  ok(r.status === 409 && r.body.codigo === 'mais_de_uma_conta' && r.body.contas.length === 2, 'e-mail com duas contas de contratante: 409 com a lista', r.body)
  r = await quieto(() => chamar('post', '/admin/conta-oficial', ADMIN, { body: { usuario_id: DONO_B } }))
  ok(r.status === 200 && r.body.conta.id === DONO_B && r.body.conta.oficial === true && JSON.stringify(await oficiais()) === JSON.stringify([DONO_B]), 'marca por usuario_id', r.body)
  r = await quieto(() => chamar('post', '/admin/conta-oficial', ADMIN, { body: { email: ' OFICIAL@x.invalid ' } }))
  ok(r.status === 200 && JSON.stringify(await oficiais()) === JSON.stringify([DONO_A]), 'marca por e-mail (sem diferenciar maiúsculas) e DESMARCA a anterior: uma conta oficial só', await oficiais())

  // ═══ 4. POST /admin/pedidos-oficiais ═══════════════════════════════════════════════════════
  pushes.length = 0
  r = await quieto(() => chamar('post', '/admin/pedidos-oficiais', ADMIN, { body: pedido }))
  const R1 = r.body?.id
  ok(r.status === 201 && r.body.criado_por === DONO_A && r.body.status === 'aberta' && r.body.status_aprovacao === 'aprovada', 'cria reparo normal da conta oficial (201, aberta/aprovada)', { status: r.status, body: r.body?.erro || r.body?.criado_por })
  ok(r.body?.categoria === 'conserto_celular' && JSON.stringify(r.body?.categorias) === JSON.stringify(['conserto_celular']) && Number(r.body?.valor_estimado) === 250
     && r.body?.descricao === 'Tela trincada, modelo 2023.' && Number(r.body?.prazo_atendimento_horas) === 24 && r.body?.cidade === 'Patos de Minas' && r.body?.uf === 'MG',
     'campos mapeados: categoria, valor → valor_estimado, detalhes → descricao, prazo → prazo_atendimento_horas', r.body && { c: r.body.categoria, v: r.body.valor_estimado, d: r.body.descricao, p: r.body.prazo_atendimento_horas })
  const quem = pushes.filter(p => p.data?.reparo_id === R1).map(p => p.to).sort()
  ok(JSON.stringify(quem) === JSON.stringify([tok(PRO_CEL), tok(PRO_ELETRONICA)].sort()), 'mesmo aviso de demanda nova: quem tem conserto_celular e o grupo (eletronica); faxina e pintor não', quem)
  const pc = pushes.find(p => p.to === tok(PRO_CEL))
  ok(pc?.title === '📲 Novo serviço disponível!' && pc?.body === '"Trocar tela de celular" em Patos de Minas — categoria: Conserto de celular e tablet' && pc?.data.tipo === 'novo_reparo', 'texto do push com emoji e rótulo da categoria nova', pc && [pc.title, pc.body])
  ok((await db.query(`SELECT push_novo_enviado_em FROM reparos WHERE id = $1`, [R1])).rows[0].push_novo_enviado_em !== null, 'claim do aviso carimbado, como em qualquer reparo')
  r = await quieto(() => chamar('post', '/admin/pedidos-oficiais', ADMIN, { body: { titulo: 'Tablet não liga', categorias: ['conserto_celular', 'eletronica'], cidade: 'Patos de Minas', uf: 'MG', valor_a_combinar: true, prazo: 'hoje', local_atendimento: 'local_profissional', detalhes: 'Me chama no 34 99999-1234' } }))
  ok(r.status === 201 && r.body.valor_a_combinar === true && r.body.valor_estimado === null && r.body.prazo_modo === 'hoje' && r.body.local_atendimento === 'local_profissional' && r.body.categorias.length === 2,
     'valor_a_combinar, prazo "hoje", duas categorias e local_atendimento (categoria nova aceita o campo)', r.body && { vac: r.body.valor_a_combinar, pm: r.body.prazo_modo, la: r.body.local_atendimento, erro: r.body.erro })
  ok(!/99999/.test(r.body?.descricao || ''), 'mesma moderação: contato nos detalhes é removido', r.body?.descricao)
  const R2 = r.body?.id
  // Mesmas validações do POST /reparos/dono (mesmo corpo de erro).
  const normal = await quieto(() => chamar('post', '/reparos/dono', DONO_B, { body: { titulo: 'x', categoria: 'celular', cidade: 'Patos de Minas', uf: 'MG', valor_estimado: 10 }, soHandler: true }))
  r = await quieto(() => chamar('post', '/admin/pedidos-oficiais', ADMIN, { body: { ...pedido, categoria: 'celular' } }))
  ok(r.status === 400 && normal.status === 400 && r.body.erro === normal.body.erro && /Categoria inválida/.test(r.body.erro), 'categoria inválida: o MESMO 400 do POST /reparos/dono', r.body)
  r = await quieto(() => chamar('post', '/admin/pedidos-oficiais', ADMIN, { body: { ...pedido, valor: undefined } }))
  ok(r.status === 400, 'sem valor e sem valor_a_combinar: 400 (regra de sempre)', r.body)
  r = await quieto(() => chamar('post', '/admin/pedidos-oficiais', ADMIN, { body: { ...pedido, titulo: '  ' } }))
  ok(r.status === 400 && r.body.erro === 'Título é obrigatório', 'sem título: 400', r.body)
  r = await quieto(() => chamar('post', '/admin/pedidos-oficiais', ADMIN, { body: { ...pedido, prazo: 7 } }))
  ok(r.status === 400 && r.body.codigo === 'prazo_invalido', 'prazo fora das faixas: 400 prazo_invalido', r.body)
  const antes = (await db.query(`SELECT count(*)::int AS n FROM reparos`)).rows[0].n
  ok(antes === 2 && (await db.query(`SELECT count(*)::int AS n FROM reparos WHERE criado_por <> $1`, [DONO_A])).rows[0].n === 0, 'só os 2 pedidos válidos foram gravados, todos da conta oficial', antes)
  // Teto de pedidos abertos (limite_demandas, 5 em produção): a conta OFICIAL é isenta (dono, 21/11/2026);
  // o contratante comum sem histórico segue barrado.
  await db.query(`INSERT INTO configuracoes (chave, valor) VALUES ('limite_demandas_live_sem_historico', '2') ON CONFLICT (chave) DO UPDATE SET valor = '2'`)
  r = await quieto(() => chamar('post', '/admin/pedidos-oficiais', ADMIN, { body: { ...pedido, titulo: 'Terceiro pedido' } }))
  ok(r.status === 201 && r.body.criado_por === DONO_A, 'conta oficial com o teto (2) já atingido: o 3º pedido é criado (isenta do teto)', { status: r.status, body: r.body?.erro })
  r = await quieto(() => chamar('post', '/reparos/dono', DONO_A, { body: { titulo: 'Quarto pedido', categoria: 'conserto_celular', cidade: 'Patos de Minas', uf: 'MG', valor_estimado: 80 }, soHandler: true }))
  ok(r.status === 201, 'isenção vale também quando a própria conta oficial publica pelo app (POST /reparos/dono)', { status: r.status, body: r.body?.erro })
  const comum = (titulo) => quieto(() => chamar('post', '/reparos/dono', DONO_B, { body: { titulo, categoria: 'faxina', cidade: 'Patos de Minas', uf: 'MG', valor_estimado: 80 }, soHandler: true }))
  const c1 = await comum('Faxina um'), c2 = await comum('Faxina dois'), c3 = await comum('Faxina três')
  ok(c1.status === 201 && c2.status === 201 && c3.status === 409, 'contratante comum sem histórico: teto de sempre (409 no 3º)', [c1.status, c2.status, c3.status, c3.body?.erro])
  await db.query(`UPDATE usuarios SET oficial = false WHERE id = $1`, [DONO_A])
  r = await quieto(() => chamar('post', '/reparos/dono', DONO_A, { body: { titulo: 'Quinto pedido', categoria: 'conserto_celular', cidade: 'Patos de Minas', uf: 'MG', valor_estimado: 80 }, soHandler: true }))
  ok(r.status === 409, 'a isenção é da MARCA: desmarcada, a mesma conta volta a ser barrada', { status: r.status })
  await db.query(`UPDATE usuarios SET oficial = true WHERE id = $1`, [DONO_A])
  await db.query(`UPDATE configuracoes SET valor = '5' WHERE chave = 'limite_demandas_live_sem_historico'`)

  // ═══ 5. dono_oficial no feed e no detalhe ══════════════════════════════════════════════════
  r = await quieto(() => chamar('post', '/reparos/dono', DONO_B, { body: { titulo: 'Celular molhou', categoria: 'conserto_celular', cidade: 'Patos de Minas', uf: 'MG', valor_estimado: 90 }, soHandler: true }))
  const R3 = r.body?.id
  ok(r.status === 201 && r.body.criado_por === DONO_B, 'contratante comum cria reparo da categoria nova pelo caminho de sempre', r.body?.erro)
  r = await quieto(() => chamar('get', '/reparos', PRO_CEL, { query: { raio_km: 'pais' }, soHandler: true }))
  const feed = Object.fromEntries((r.body?.reparos || []).map(x => [x.id, x.dono_oficial]))
  ok(r.status === 200 && feed[R1] === true && feed[R2] === true && feed[R3] === false, 'feed de serviços: dono_oficial true nos da conta oficial, false no comum', { status: r.status, feed, erro: r.body?.erro })
  r = await quieto(() => chamar('get', '/reparos/:id', PRO_CEL, { params: { id: R1 }, soHandler: true }))
  ok(r.status === 200 && r.body.dono_oficial === true && r.body.reparo.dono_oficial === true, 'detalhe do serviço oficial: dono_oficial true (no topo e em reparo)', { status: r.status, d: r.body?.dono_oficial, erro: r.body?.erro })
  r = await quieto(() => chamar('get', '/reparos/:id', PRO_CEL, { params: { id: R3 }, soHandler: true }))
  ok(r.status === 200 && r.body.dono_oficial === false && r.body.reparo.dono_oficial === false, 'detalhe do serviço comum: dono_oficial false', { status: r.status, d: r.body?.dono_oficial })
  r = await quieto(() => chamar('get', '/reparos/:id', DONO_A, { params: { id: R1 }, soHandler: true }))
  ok(r.status === 200 && r.body.dono_oficial === true && r.body.sou_dono === true, 'a conta oficial vê o próprio pedido como dona', { status: r.status, erro: r.body?.erro })
  const OB1 = 'b0b0b0b0-0000-4000-8000-000000000001', OB2 = 'b0b0b0b0-0000-4000-8000-000000000002'
  await db.query(
    `INSERT INTO obras (id, titulo, categoria, criado_por, valor, horas_para_expirar, cidade, uf, bairro, status, status_aprovacao, publicado_em, push_novo_enviado_em, expira_em)
     VALUES ($1, 'Pintura oficial', 'residencial', $3, 3000, 480, 'Patos de Minas', 'MG', 'Centro', 'aberta', 'aprovada', now(), now(), now() + INTERVAL '10 days'),
            ($2, 'Pintura comum', 'residencial', $4, 3000, 480, 'Patos de Minas', 'MG', 'Centro', 'aberta', 'aprovada', now(), now(), now() + INTERVAL '10 days')`,
    [OB1, OB2, DONO_A, DONO_B])
  r = await quieto(() => chamar('get', '/obras', PINTOR, { query: { raio_km: 'pais' }, soHandler: true }))
  const feedO = Object.fromEntries((r.body?.obras || []).map(x => [x.id, x.dono_oficial]))
  ok(r.status === 200 && feedO[OB1] === true && feedO[OB2] === false, 'feed de obras: dono_oficial true/false', { status: r.status, feedO, erro: r.body?.erro })
  r = await quieto(() => chamar('get', '/obras/:id', PINTOR, { params: { id: OB1 }, soHandler: true }))
  const r2 = await quieto(() => chamar('get', '/obras/:id', PINTOR, { params: { id: OB2 }, soHandler: true }))
  ok(r.status === 200 && r.body.obra?.dono_oficial === true && r2.body.obra?.dono_oficial === false, 'detalhe de obra: obra.dono_oficial true/false', { status: r.status, erro: r.body?.erro })

  // ═══ 6. "ProTudo" no nome ══════════════════════════════════════════════════════════════════
  const usam = ['ProTudo', 'protudo oficial', 'Pro Tudo', 'PRÓ-TUDO Suporte', 'Equipe pro.tudo', 'João ProTudo Silva']
  const naoUsam = ['Maria Produtos', 'Pedro Tudor', 'Protásio Duarte', '', null, undefined, 42]
  ok(usam.every(n => CO.nomeUsaMarca(n)) && naoUsam.every(n => !CO.nomeUsaMarca(n)), 'nomeUsaMarca: ignora caixa, acento, espaço e pontuação; não pega nomes parecidos', usam.filter(n => !CO.nomeUsaMarca(n)).concat(naoUsam.filter(n => CO.nomeUsaMarca(n))))
  const cadastro = (nome) => quieto(() => chamar('post', '/auth/cadastro', null, { body: { nome, email: 'novo@x.invalid', senha: '12345678', tipo_conta: 'dono_reparo', cidade: 'Patos de Minas', uf: 'MG' }, soHandler: true }))
  r = await cadastro('ProTudo Oficial')
  ok(r.status === 400 && r.body.codigo === 'nome_reservado', 'cadastro com "ProTudo" no nome: 400 nome_reservado', r.body)
  r = await cadastro('Pro Tudo Atendimento')
  ok(r.status === 400 && r.body.codigo === 'nome_reservado' && (await db.query(`SELECT count(*)::int AS n FROM usuarios WHERE email = 'novo@x.invalid'`)).rows[0].n === 0, 'variação "Pro Tudo": também recusada; nenhuma conta criada', r.body)
  const nomeDe = async (id) => (await db.query(`SELECT nome FROM usuarios WHERE id = $1`, [id])).rows[0].nome
  r = await quieto(() => chamar('put', '/auth/perfil', DONO_B, { body: { nome: 'ProTudo' }, soHandler: true }))
  ok(r.status === 400 && r.body.codigo === 'nome_reservado' && await nomeDe(DONO_B) === 'Maria Cliente', 'perfil de conta comum: "ProTudo" recusado, nome não muda', r.body)
  r = await quieto(() => chamar('put', '/auth/perfil', PRO_CEL, { body: { nome: 'Assistência PRÓ TUDO' }, soHandler: true }))
  ok(r.status === 400 && r.body.codigo === 'nome_reservado', 'perfil de profissional: recusado também', r.body)
  r = await quieto(() => chamar('put', '/auth/perfil', DONO_B, { body: { nome: 'Maria Produtos' }, soHandler: true }))
  ok(r.status === 200 && await nomeDe(DONO_B) === 'Maria Produtos', 'perfil com nome comum: continua funcionando', { status: r.status, erro: r.body?.erro })
  r = await quieto(() => chamar('put', '/auth/perfil', DONO_A, { body: { nome: 'ProTudo' }, soHandler: true }))
  ok(r.status === 200 && await nomeDe(DONO_A) === 'ProTudo', 'a conta OFICIAL pode se chamar "ProTudo"', { status: r.status, erro: r.body?.erro })

  const errosReais = erros.filter(e => !/sem banco|migration|falha simulada/i.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
