#!/usr/bin/env node
// "VALOR A COMBINAR" (arte aprovada, 16/11/2026 — reparos E obras), com o SQL REAL num Postgres em
// memória (PGlite), Expo/Brevo falsos e as rotas reais:
//   (1) regra de criar/editar: valor_a_combinar=true → valor NULL; senão a validação > 0 de sempre;
//   (2) migração: coluna nova, valor aceita NULL e a correção ÚNICA dos abertos com valor <= 1,00;
//   (3) POST /reparos/dono, POST /obras/dono, POST e PUT /obras (painel);
//   (4) proposta em pedido a combinar: valor_proposto obrigatório e > 0 (400 VALOR_OBRIGATORIO);
//   (5) o valor da proposta escolhida é o valor combinado (utils/valorAcordado);
//   (6) /aumentar-valor recusa (409 VALOR_A_COMBINAR); aviso de pouco interesse sem "oferta";
//   (7) lembretes e avisos dizem "Valor a combinar" no lugar de R$;
//   (8) feed, minhas, detalhe e admin devolvem valor_a_combinar; painel traz valor_acordado.
//   npm i -D @electric-sql/pglite && node scripts/testar-valor-a-combinar.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

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
const shim = {
  query: (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return db.query(sql, params) },
  connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: (s, p) => db.query(s, p), release() {} } },
  on() {},
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) }, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async () => {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const erros = []
const silenciar = (v) => {
  console.log = v ? () => {} : logOrig
  console.warn = v ? () => {} : warnOrig
  console.error = v ? (...a) => { erros.push(a.map(x => x?.message || String(x)).join(' ')) } : errOrig
}
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const alerta = require(path.join(REPO, 'src/services/alertaService'))
const obrasCtrl = require(path.join(REPO, 'src/controllers/obrasController'))
const fa = require(path.join(REPO, 'src/utils/avisosForaDaArea'))
const { validarValorDemanda } = require(path.join(REPO, 'src/utils/valorDemanda'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 250))
const ordenado = (l) => [...l].sort()
const igual = (a, b) => JSON.stringify(ordenado(a)) === JSON.stringify(ordenado(b))
const fixarAgora = (iso) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${iso}'::timestamptz $$`)
const handler = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const chamar = (h, { usuario, params = {}, query = {}, body = {} }) => new Promise(resolve => {
  const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  Promise.resolve(h({ params, query, body, usuario, get: () => '', headers: {}, ip: '127.0.0.1' }, res)).catch(e => resolve({ status: 599, body: { erro: String(e.message) } }))
})
const DONO = { id: U(900), role: 'dono_obra', nome: 'Dona', email: 'dona@x.invalid' }
const ADM = { id: U(901), role: 'admin', nome: 'Admin', email: 'adm@x.invalid' }
// 20 reparadores de elétrica: U1..U12 COM token, U13..U20 SEM token (ids maiores, para a ordem
// "sem token primeiro" não se confundir com a ordem por id). 3 pintores para a obra do painel.
const COM_TOKEN = Array.from({ length: 12 }, (_, i) => U(i + 1))
const SEM_TOKEN = Array.from({ length: 8 }, (_, i) => U(i + 13))

const main = async () => {
  db = new PGlite()
  await db.exec(`SET search_path = public, pg_catalog`)
  await fixarAgora('2026-11-10T15:00:00Z') // terça, 12:00 em São Paulo
  const colsDemanda = `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), titulo text, descricao text, categoria text, cidade text, uf text, bairro text, criado_por uuid, status text DEFAULT 'aberta',
      status_aprovacao text DEFAULT 'aprovada', match_usuario_id uuid, expira_em timestamptz, criado_em timestamptz DEFAULT now(), publicado_em timestamptz,
      prestadores_bloqueados uuid[], codigo_publico text, push_novo_enviado_em timestamptz, email_novo_pendente_em timestamptz, tags text[], latitude numeric, longitude numeric,
      lembretes_enviados int DEFAULT 0, lembrete_enviado_em timestamptz, valor_aumentado_em timestamptz`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, latitude numeric, longitude numeric, raio_km_escolhido numeric, nome text, email text, cidade text, uf text, role text, tipo_prestador text, cpf_cnpj text, ativo boolean DEFAULT true,
      push_token text, suspenso_em timestamptz, desinstalado_em timestamptz, especialidades text[], indicacao_pedida_em timestamptz);
    CREATE TABLE assinaturas (usuario_id uuid, status text, proximo_vencimento timestamptz);
    CREATE TABLE reparos (valor_a_combinar boolean NOT NULL DEFAULT false, ${colsDemanda}, categorias text[], valor_estimado numeric, prazo_atendimento_horas numeric);
    CREATE TABLE obras (valor_a_combinar boolean NOT NULL DEFAULT false, ${colsDemanda}, valor numeric, horas_para_expirar numeric, metragem numeric, prazo_execucao_dias int, push_aprovada_enviado_em timestamptz, enviada_por_dono boolean);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, criado_em timestamptz DEFAULT now());
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, criado_em timestamptz DEFAULT now());
    CREATE TABLE prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid);
    CREATE TABLE lembretes_push_enviados (tabela text, demanda_id uuid, usuario_id uuid, motivo text, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE avisos_acima_do_teto (tabela text, demanda_id uuid, usuario_id uuid, criado_em timestamptz NOT NULL DEFAULT now(), resumo_em timestamptz, PRIMARY KEY (tabela, demanda_id, usuario_id));
    CREATE TABLE push_entregas (primeira_tentativa_em timestamptz NOT NULL DEFAULT now(), tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, ultima_tentativa_em timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz);
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true');
  `)
  // Responsabilidade pós-match (eventos_responsabilidade, dias_credito_*, aviso_resposta_final_em) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/responsabilidade')).migrarResponsabilidade(db)

  // reparos.local_atendimento + usuarios.atende_* (utils/localAtendimento) — a mesma migração de boot.

  await require(path.join(REPO, 'src/utils/localAtendimento')).migrarLocalAtendimento({ query: (s, p) => db.query(s, p) })
  // obras.especialidades_inferidas (capacidadesDaPessoa / feed / aviso de obra nova leem a coluna) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/especialidadesInferidas')).migrarEspecialidadesInferidas(db)
  silenciar(true)
  await fa.migrarAvisosForaDaArea({ query: (s, p) => db.query(s, p) })
  silenciar(false)
  await db.query(`UPDATE usuarios SET avisos_todas_areas = false`)
  const usr = (id, nome, tipo, esp, token) => db.query(
    `INSERT INTO usuarios (id, nome, email, cidade, uf, role, tipo_prestador, cpf_cnpj, push_token, especialidades, avisos_todas_areas)
     VALUES ($1::uuid, $2, $3, 'Uberlândia', 'MG', 'prestador', $4, $5, $6, $7::text[], false)`,
    [id, nome, `${nome.toLowerCase().replace(/\s/g, '')}@x.invalid`, tipo, id.slice(-6), token, esp])
  for (const id of COM_TOKEN) await usr(id, `Rep ${id.slice(-2)}`, 'reparador', ['eletrica'], `ExponentPushToken[${id.slice(-3)}]`)
  for (const id of SEM_TOKEN) await usr(id, `Rep ${id.slice(-2)}`, 'reparador', ['eletrica'], null)
  for (const n of [31, 32, 33]) await usr(U(n), `Pintor ${n}`, 'pintor', ['pintor'], `ExponentPushToken[0${n}]`)
  await db.query(`INSERT INTO usuarios (id, nome, email, role, cidade, uf, cpf_cnpj) VALUES ($1, 'Dona', 'dona@x.invalid', 'dono_obra', 'Uberlândia', 'MG', '900'), ($2, 'Admin', 'adm@x.invalid', 'admin', NULL, NULL, NULL)`, [DONO.id, ADM.id])
  await db.query(`INSERT INTO assinaturas (usuario_id, status) SELECT id, 'ativa' FROM usuarios WHERE role = 'prestador'`)

  // ═══════════════════════ VALOR A COMBINAR ═══════════════════════
  const V = require(path.join(REPO, 'src/utils/valorDemanda'))
  const linha = async (t, id) => (await db.query(`SELECT * FROM ${t} WHERE id = $1`, [id])).rows[0]
  const calado = async (fn) => { silenciar(true); try { return await fn() } finally { await assentar(); silenciar(false) } }
  for (const t of ['interesse_reparos', 'candidaturas']) {
    await db.exec(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS mensagem text; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS valor_proposto numeric; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS valor_contraproposta numeric;
      ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS rodada int; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS status text DEFAULT 'pendente';`)
  }

  // Colunas que as rotas de criação gravam (todas existem em produção) e o índice do ON CONFLICT.
  for (const t of ['reparos', 'obras']) {
    for (const c of ['tags text[]', 'status_aprovacao text', 'expira_em timestamptz', 'ponto_referencia text', 'latitude numeric', 'longitude numeric', 'coordenadas_origem text',
      'client_request_id text', 'prazo_modo text', 'prazo_timezone text', 'endereco_reparo text', 'endereco_obra text', 'metragem numeric', 'prazo_execucao_dias int', 'enviada_por_dono boolean',
      'horas_para_expirar numeric', 'publicado_em timestamptz', 'criado_em timestamptz DEFAULT now()', 'match_usuario_id uuid', 'match_feito_em timestamptz', 'encerrado_em timestamptz',
      'valor_aumentado_em timestamptz', 'alerta_enviado_em timestamptz', 'total_visitas int DEFAULT 0', 'codigo_publico text',
      'chegada_prevista_em timestamptz', 'prazo_chegada_extra_em timestamptz']) {
      await db.exec(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c}`)
    }
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${t}_crid_idx ON ${t} (criado_por, client_request_id) WHERE client_request_id IS NOT NULL`)
  }

  await db.exec(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone text`)

  // ═══ (1) regra pura: criar/editar ═══
  ok(JSON.stringify(V.resolverValorDemanda({ valor_a_combinar: true }, 'valor')) === '{"valor":null,"valor_a_combinar":true}', 'valor_a_combinar=true sem valor → valor null + flag')
  ok(V.resolverValorDemanda({ valor_a_combinar: 'true', valor: 80 }, 'valor').valor === null, 'valor_a_combinar="true" com valor no corpo → valor ignorado (null)')
  ok(JSON.stringify(V.resolverValorDemanda({ valor_estimado: '120' }, 'valor_estimado')) === '{"valor":120,"valor_a_combinar":false}', 'sem a flag e com valor → valor + flag false')
  for (const corpo of [{}, { valor_a_combinar: false }, { valor_a_combinar: false, valor: 0 }, { valor_a_combinar: 'false', valor: '' }]) {
    const r = V.resolverValorDemanda(corpo, 'valor')
    ok(r.erro === 'Informe quanto quer pagar' && r.codigo === 'VALOR_OBRIGATORIO', `sem a flag e sem valor válido ${JSON.stringify(corpo)} → a validação de sempre`, r)
  }

  // ═══ (2) migração: coluna, valor aceita NULL, correção ÚNICA dos abertos com valor <= 1,00 ═══
  await db.exec(`ALTER TABLE obras ALTER COLUMN valor SET DEFAULT 1; UPDATE obras SET valor = 1 WHERE valor IS NULL; ALTER TABLE obras ALTER COLUMN valor SET NOT NULL; ALTER TABLE obras ALTER COLUMN valor DROP DEFAULT;`) // como em produção
  await db.exec(`DELETE FROM reparos; DELETE FROM obras; DELETE FROM configuracoes WHERE chave = '${V.MARCADOR_BACKFILL}'`)
  const semente = (t, n, titulo, valor, status = 'aberta') => db.query(
    `INSERT INTO ${t} (id, titulo, categoria, cidade, uf, criado_por, status, ${t === 'reparos' ? 'valor_estimado' : 'valor'}, expira_em) VALUES ($1::uuid, $2, 'eletrica', 'Uberlândia', 'MG', $3::uuid, $4, $5, now() + INTERVAL '5 days')`,
    [D(n), titulo, DONO.id, status, valor])
  await semente('reparos', 501, 'ar condicionado', 0)            // Y3VUU em produção
  await semente('reparos', 502, 'reparo de 1 real', 1)
  await semente('reparos', 503, 'reparo normal', 150)
  await semente('reparos', 504, 'cancelado de 0', 0, 'cancelada')
  await semente('reparos', 505, 'encerrado de 0,50', 0.5, 'encerrada')
  await semente('obras', 511, 'Pintura', 0.01)                   // RSPKP em produção
  await semente('obras', 512, 'obra normal', 3000)
  await semente('obras', 513, 'obra cancelada de 0,01', 0.01, 'cancelada')
  let corrigidos = await V.migrarValorACombinar(db)
  ok(igual(corrigidos.map(c => c.id), [D(501), D(502), D(511)]), 'correção única: só os ABERTOS com valor <= 1,00 (2 reparos + 1 obra)', corrigidos.map(c => [c.tabela, c.titulo, c.valor_antes]))
  for (const [t, n] of [['reparos', 501], ['reparos', 502], ['obras', 511]]) {
    const d = await linha(t, D(n))
    ok(d.valor_a_combinar === true && (t === 'reparos' ? d.valor_estimado : d.valor) === null, `${t} ${n}: valor_a_combinar = true e valor NULL`)
  }
  ok((await linha('reparos', D(503))).valor_a_combinar === false && Number((await linha('reparos', D(503))).valor_estimado) === 150 && (await linha('obras', D(512))).valor_a_combinar === false,
     'pedidos com valor de verdade: intocados (flag false por padrão)')
  ok((await linha('reparos', D(504))).valor_a_combinar === false && Number((await linha('reparos', D(505))).valor_estimado) === 0.5 && Number((await linha('obras', D(513))).valor) === 0.01,
     'cancelados/encerrados com valor <= 1: intocados (a correção é só para os abertos)')
  await semente('reparos', 506, 'novo de 1 real depois da correção', 1)
  corrigidos = await V.migrarValorACombinar(db)
  ok(corrigidos.length === 0 && (await linha('reparos', D(506))).valor_a_combinar === false && Number((await linha('reparos', D(506))).valor_estimado) === 1,
     'boot seguinte: a correção NÃO roda de novo (marcador em configuracoes)', corrigidos)

  // ═══ (3) criar e editar ═══
  const hReparoV = handler('post', '/reparos/dono'), hObraV = handler('post', '/obras/dono')
  const baseR = { titulo: 'Trocar fiação', categoria: 'eletrica', cidade: 'Uberlândia', uf: 'MG' }
  const baseO = { titulo: 'Reforma da sala', categoria: 'residencial', cidade: 'Uberlândia', uf: 'MG' }
  pushes.length = 0
  let r = await calado(() => chamar(hReparoV, { usuario: DONO, body: { ...baseR, valor_a_combinar: true } }))
  ok(r.status === 201 && r.body.valor_a_combinar === true && r.body.valor_estimado === null, 'POST /reparos/dono valor_a_combinar=true sem valor → 201, valor NULL, flag true', { status: r.status, erro: r.body.erro, erros: erros.slice(-2) })
  const RID = r.body.id
  r = await calado(() => chamar(hReparoV, { usuario: DONO, body: { ...baseR, titulo: 'Outro', valor_a_combinar: 'true', valor_estimado: 70 } }))
  ok(r.status === 201 && r.body.valor_a_combinar === true && r.body.valor_estimado === null, 'POST /reparos/dono com a flag E valor → grava a combinar (valor NULL)', r.body.erro)
  r = await calado(() => chamar(hReparoV, { usuario: DONO, body: { ...baseR, titulo: 'Sem nada' } }))
  ok(r.status === 400 && r.body.codigo === 'VALOR_OBRIGATORIO' && r.body.erro === 'Informe quanto quer pagar', 'POST /reparos/dono sem flag e sem valor → 400 de sempre', r.body)
  r = await calado(() => chamar(hReparoV, { usuario: DONO, body: { ...baseR, titulo: 'Com valor', valor_estimado: 90 } }))
  ok(r.status === 201 && r.body.valor_a_combinar === false && Number(r.body.valor_estimado) === 90, 'POST /reparos/dono com valor → como sempre, flag false', r.body.erro)
  const RNORMAL = r.body.id
  r = await calado(() => chamar(hObraV, { usuario: DONO, body: { ...baseO, valor_a_combinar: true } }))
  ok(r.status === 201 && r.body.valor_a_combinar === true && r.body.valor === null, 'POST /obras/dono valor_a_combinar=true sem valor → 201, valor NULL, flag true', { status: r.status, erro: r.body.erro, erros: erros.slice(-2) })
  const OID = r.body.id
  r = await calado(() => chamar(hObraV, { usuario: DONO, body: { ...baseO, titulo: 'Obra sem nada' } }))
  ok(r.status === 400 && r.body.codigo === 'VALOR_OBRIGATORIO', 'POST /obras/dono sem flag e sem valor → 400 de sempre', r.body)
  r = await calado(() => chamar(obrasCtrl.criar, { usuario: ADM, body: { ...baseO, titulo: 'Obra do painel', valor_a_combinar: true } }))
  ok(r.status === 201 && r.body.valor_a_combinar === true && r.body.valor === null, 'POST /obras (painel) valor_a_combinar=true → 201', { status: r.status, erro: r.body.erro, erros: erros.slice(-2) })
  const OPAINEL = r.body.id
  r = await calado(() => chamar(obrasCtrl.editar, { usuario: ADM, params: { id: OPAINEL }, body: { valor: 800 } }))
  ok(r.status === 200 && Number(r.body.valor) === 800 && r.body.valor_a_combinar === false, 'PUT /obras/:id com valor → valor gravado e flag desligada', r.body.erro)
  r = await calado(() => chamar(obrasCtrl.editar, { usuario: ADM, params: { id: OPAINEL }, body: { valor_a_combinar: true } }))
  ok(r.status === 200 && r.body.valor === null && r.body.valor_a_combinar === true, 'PUT /obras/:id valor_a_combinar=true → valor NULL e flag ligada', r.body.erro)
  r = await calado(() => chamar(obrasCtrl.editar, { usuario: ADM, params: { id: OPAINEL }, body: { valor_a_combinar: false } }))
  ok(r.status === 400 && r.body.codigo === 'VALOR_OBRIGATORIO' && (await linha('obras', OPAINEL)).valor_a_combinar === true, 'PUT /obras/:id desligando a flag sem dar valor → 400, nada muda', r.body)
  r = await calado(() => chamar(obrasCtrl.editar, { usuario: ADM, params: { id: OPAINEL }, body: { titulo: 'Obra do painel 2' } }))
  ok(r.status === 200 && r.body.valor_a_combinar === true && r.body.valor === null, 'PUT /obras/:id sem mexer em valor → flag e valor preservados', r.body.erro)

  // ═══ (4) propostas: valor_proposto obrigatório nos pedidos a combinar ═══
  const hInt = handler('post', '/reparos/:id/interesse'), hCand = handler('post', '/obras/:id/candidatura')
  await db.query(`UPDATE obras SET status = 'aberta', status_aprovacao = 'aprovada' WHERE id = $1`, [OID])
  const PRO = { id: U(1), role: 'prestador' }, PRO2 = { id: U(2), role: 'prestador' }
  const ESPERADO = { erro: 'Informe quanto você cobra por este serviço.', codigo: 'VALOR_OBRIGATORIO', mensagem: 'Informe quanto você cobra por este serviço.' }
  for (const [rot, h, id, tabela] of [['reparo', hInt, RID, 'interesse_reparos'], ['obra', hCand, OID, 'candidaturas']]) {
    const fk = tabela === 'candidaturas' ? 'obra_id' : 'reparo_id'
    for (const corpo of [{ mensagem: 'Posso ir' }, { mensagem: 'Posso ir', valor_proposto: 0 }, { valor_proposto: '' }, { valor_proposto: 'a combinar' }, { valor_proposto: -5 }]) {
      r = await calado(() => chamar(h, { usuario: PRO, params: { id }, body: corpo }))
      ok(r.status === 400 && JSON.stringify(r.body) === JSON.stringify(ESPERADO), `${rot} a combinar: proposta ${JSON.stringify(corpo)} → 400 VALOR_OBRIGATORIO`, r.body)
    }
    ok((await db.query(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${fk} = $1`, [id])).rows[0].n === 0, `${rot} a combinar: nenhuma proposta gravada nas recusas`)
    r = await calado(() => chamar(h, { usuario: PRO, params: { id }, body: { mensagem: 'Posso ir', valor_proposto: 180 } }))
    ok(r.status === 201 && Number(r.body.valor_proposto) === 180, `${rot} a combinar: proposta com valor 180 → 201`, { status: r.status, erro: r.body.erro, erros: erros.slice(-2) })
    r = await calado(() => chamar(h, { usuario: PRO2, params: { id }, body: { valor_proposto: '250.50' } }))
    ok(r.status === 201 && Number(r.body.valor_proposto) === 250.5, `${rot} a combinar: valor em texto numérico ("250.50") → 201`, r.body.erro)
  }
  r = await calado(() => chamar(hInt, { usuario: PRO, params: { id: RNORMAL }, body: { mensagem: 'Aceito o valor' } }))
  ok(r.status === 201 && r.body.valor_proposto === null, 'reparo COM valor: proposta sem valor_proposto continua valendo (aceita o valor pedido)', r.body.erro)

  // ═══ (5) o valor da proposta ESCOLHIDA é o valor combinado ═══
  await db.query(`UPDATE interesse_reparos SET status = 'aceito' WHERE reparo_id = $1 AND usuario_id = $2`, [RID, PRO.id])
  await db.query(`UPDATE candidaturas SET status = 'aceito' WHERE obra_id = $1 AND usuario_id = $2`, [OID, PRO2.id])
  const { sqlValorAcordadoReparo, sqlValorAcordadoObra } = require(path.join(REPO, 'src/utils/valorAcordado'))
  let va = (await db.query(`SELECT ${sqlValorAcordadoReparo('ir', 'r')} AS v FROM reparos r JOIN interesse_reparos ir ON ir.reparo_id = r.id AND ir.status = 'aceito' WHERE r.id = $1`, [RID])).rows[0].v
  ok(Number(va) === 180, 'reparo a combinar: valor combinado (contrato/finalizadas) = valor da proposta escolhida (180)', va)
  va = (await db.query(`SELECT ${sqlValorAcordadoObra('c', 'o')} AS v FROM obras o JOIN candidaturas c ON c.obra_id = o.id AND c.status = 'aceito' WHERE o.id = $1`, [OID])).rows[0].v
  ok(Number(va) === 250.5, 'obra a combinar: valor combinado = valor da candidatura escolhida (250,50)', va)
  await db.query(`UPDATE interesse_reparos SET valor_contraproposta = 200 WHERE reparo_id = $1 AND usuario_id = $2`, [RID, PRO.id])
  va = (await db.query(`SELECT ${sqlValorAcordadoReparo('ir', 'r')} AS v FROM reparos r JOIN interesse_reparos ir ON ir.reparo_id = r.id AND ir.status = 'aceito' WHERE r.id = $1`, [RID])).rows[0].v
  ok(Number(va) === 200, 'houve contraproposta aceita: é ela que vale (200)', va)

  // ═══ (6) aumentar valor recusa pedido a combinar; aviso de pouco interesse não fala em oferta ═══
  await db.query(`UPDATE interesse_reparos SET status = 'pendente', valor_contraproposta = NULL WHERE reparo_id = $1`, [RID])
  const hAumR = handler('post', '/reparos/:id/aumentar-valor'), hAumO = handler('post', '/obras/:id/aumentar-valor')
  for (const [rot, h, id, t, col] of [['reparo', hAumR, RID, 'reparos', 'valor_estimado'], ['obra', hAumO, OID, 'obras', 'valor']]) {
    r = await calado(() => chamar(h, { usuario: DONO, params: { id }, body: { valor: 500 } }))
    const d = await linha(t, id)
    ok(r.status === 409 && r.body.codigo === 'VALOR_A_COMBINAR' && /valor a combinar/.test(r.body.mensagem) && r.body.erro === r.body.mensagem && d[col] === null && d.valor_a_combinar === true,
       `POST /${t}/:id/aumentar-valor em pedido a combinar → 409 VALOR_A_COMBINAR, nada muda`, { status: r.status, corpo: r.body, erros: erros.slice(-1) })
  }
  ok(alerta.tituloBaixoEngajamento({ valor_a_combinar: true }) === '💡 Seu pedido ainda não teve interessados' && !/oferta|valor/i.test(alerta.tituloBaixoEngajamento({ valor_a_combinar: true })),
     'aviso de pouco interesse em pedido a combinar: título sem "oferta"/"valor"')
  ok(alerta.tituloBaixoEngajamento({ valor_a_combinar: false }) === '💡 Considere aumentar sua oferta' && alerta.tituloBaixoEngajamento({}) === '💡 Considere aumentar sua oferta',
     'aviso de pouco interesse em pedido com valor: título de sempre')

  // ═══ (7) textos: "Valor a combinar" no lugar de R$ ═══
  const lr = alerta.mensagemLembreteReparo({ titulo: 'Trocar fiação', categoria: 'eletrica', categorias: ['eletrica'], valor: null, interessados: 0 }, RID)
  const lo = alerta.mensagemLembreteObra({ titulo: 'Reforma da sala', categoria: 'residencial', valor: null, interessados: 2 }, OID)
  ok(/ · Valor a combinar · /.test(lr.corpo) && !/R\$/.test(lr.corpo), 'lembrete de serviço a combinar: "Valor a combinar", sem R$', lr.corpo)
  ok(/ · Valor a combinar · /.test(lo.corpo) && !/R\$/.test(lo.corpo), 'lembrete de obra a combinar: "Valor a combinar", sem R$', lo.corpo)
  ok(/R\$ 150/.test(alerta.mensagemLembreteReparo({ titulo: 'x', categoria: 'eletrica', valor: 150 }, RID).corpo), 'lembrete de pedido com valor: R$ como sempre')
  const fora = alerta.mensagemForaDaArea({ comCategoria: true, tipoPush: 'novo_reparo', chave: 'reparo_id' }, { id: RID, titulo: 'Trocar fiação', bairro: 'Centro', cidade: 'Uberlândia', categoria: 'eletrica', valor: null })
  ok(/Trocar fiação · Centro · Valor a combinar\./.test(fora.corpo) && !/R\$/.test(fora.corpo), 'push "fora da sua área" de pedido a combinar: "Valor a combinar"', fora.corpo)
  const nova = alerta.mensagemNovaObra({ titulo: 'Reforma da sala', cidade: 'Uberlândia', categoria: 'residencial', valor: null }, OID)
  ok(!/R\$|null|undefined|NaN/.test(nova.titulo + nova.corpo), 'push de obra nova a combinar: sem R$, sem "null"', nova.corpo)

  // ═══ (8) payloads devolvem valor_a_combinar ═══
  const coluna = async (rot, fn, extrair) => {
    const resp = await calado(fn)
    const item = extrair(resp.body)
    ok(resp.status === 200 && item && item.valor_a_combinar === true, `${rot}: devolve valor_a_combinar = true`, { status: resp.status, erro: resp.body && resp.body.erro, achou: !!item, erros: erros.slice(-1) })
  }
  await db.query(`UPDATE interesse_reparos SET status = 'aceito' WHERE reparo_id = $1 AND usuario_id = $2`, [RID, PRO.id])
  await coluna('GET /reparos/admin', () => chamar(handler('get', '/reparos/admin'), { usuario: ADM, query: { filtro: 'abertas' } }), b => (b.reparos || []).find(x => x.id === RID))
  await coluna('GET /obras/admin', () => chamar(handler('get', '/obras/admin'), { usuario: ADM, query: { filtro: 'abertas' } }), b => (b.obras || []).find(x => x.id === OID))
  const adm = await calado(() => chamar(handler('get', '/reparos/admin'), { usuario: ADM, query: { filtro: 'abertas' } }))
  const itemAdm = (adm.body.reparos || []).find(x => x.id === RID)
  ok(itemAdm && itemAdm.valor_estimado === null && Number(itemAdm.valor_acordado) === 180, 'painel: valor pedido NULL e valor_acordado = 180 (proposta escolhida)', itemAdm && [itemAdm.valor_estimado, itemAdm.valor_acordado])
  const admO = await calado(() => chamar(handler('get', '/obras/admin'), { usuario: ADM, query: { filtro: 'abertas' } }))
  const itemAdmO = (admO.body.obras || []).find(x => x.id === OID)
  ok(itemAdmO && Number(itemAdmO.valor_acordado) === 250.5, 'painel de obras: valor_acordado = 250,50', itemAdmO && itemAdmO.valor_acordado)
  // Todas as listas com colunas explícitas pedem a coluna nova (as demais usam o.* / r.* / SELECT *).
  const fonte = require('fs').readFileSync(path.join(REPO, 'src/routes/index.js'), 'utf8') + require('fs').readFileSync(path.join(REPO, 'src/controllers/obrasController.js'), 'utf8') + require('fs').readFileSync(path.join(REPO, 'src/controllers/candidaturasController.js'), 'utf8')
  const semFlag = fonte.split('\n').filter(l => /\b(o\.valor|r\.valor_estimado),/.test(l) && /SELECT|as obra_id|as reparo_id/.test(l) && !/valor_a_combinar/.test(l))
  ok(semFlag.length === 0, 'feed, meus-interesses, candidaturas, contratos e admin: toda lista explícita com o valor traz valor_a_combinar', semFlag.map(l => l.trim().slice(0, 80)))

  // ═══ (9) COMPATIBILIDADE: o app nunca recebe valor null num pedido a combinar; o painel recebe ═══
  // regra pura
  const amostra = V.protegerValorParaApp({
    reparos: [{ id: 1, valor_a_combinar: true, valor_estimado: null, valor_proposto: null }, { id: 2, valor_a_combinar: false, valor_estimado: null }, { id: 3, valor_a_combinar: true, valor_estimado: '80.00' }],
    obra: { valor_a_combinar: true, valor: undefined, valor_acordado: null, candidatos: [{ valor_proposto: null }] }, solto: { valor_a_combinar: true, titulo: 'sem a chave de valor' },
  })
  ok(amostra.reparos[0].valor_estimado === '0.01' && amostra.reparos[0].valor_proposto === null && amostra.reparos[0].valor_a_combinar === true, 'compat: a combinar + valor null → "0.01"; valor_proposto intocado; flag preservada', amostra.reparos[0])
  ok(amostra.reparos[1].valor_estimado === null && amostra.reparos[2].valor_estimado === '80.00', 'compat: sem a flag não inventa valor; valor existente não muda')
  ok(amostra.obra.valor === '0.01' && amostra.obra.valor_acordado === null && amostra.obra.candidatos[0].valor_proposto === null && !('valor' in amostra.solto), 'compat: objeto aninhado; valor_acordado e propostas intocados; chave ausente não é criada', amostra.obra)
  ok(V.protegerValorParaApp(null) === null && V.protegerValorParaApp('x') === 'x' && Array.isArray(V.protegerValorParaApp([])), 'compat: null, texto e lista vazia passam direto')
  for (const [m, p, painel] of [['GET', '/admin/finalizadas', true], ['GET', '/reparos/admin', true], ['GET', '/obras/admin', true], ['GET', '/obras-aprovacao', true], ['GET', '/reparos/aprovacao', true],
    ['POST', '/obras', true], ['PUT', `/obras/${D(1)}`, true], ['GET', '/obras', false], ['GET', `/obras/${D(1)}`, false], ['POST', '/obras/dono', false], ['GET', '/reparos', false],
    ['GET', '/reparos/minhas', false], ['GET', '/reparos/meus-interesses', false], ['GET', '/candidaturas/minhas', false], ['POST', `/obras/${D(1)}/candidatura`, false]]) {
    ok(V.ehRotaDoPainel({ method: m, path: p }) === painel, `${m} ${p}: ${painel ? 'painel (valor fica null)' : 'app (valor protegido)'}`)
  }
  // o middleware está no router ANTES de qualquer rota
  const iMw = router.stack.findIndex(l => !l.route && l.handle && l.handle.name === 'valorACombinarParaApp')
  const iRota = router.stack.findIndex(l => l.route)
  ok(iMw >= 0 && iMw < iRota, 'o middleware de compatibilidade está montado no router antes de qualquer rota', { iMw, iRota })
  // Chamada como o Express faz: middleware do router → handler final da rota.
  const mw = router.stack[iMw].handle
  const viaRouter = (metodo, padrao, { usuario, params = {}, query = {}, body = {} } = {}) => new Promise(resolve => {
    const caminho = padrao.replace(/:([A-Za-z_]+)/g, (_, k) => params[k])
    const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
    const req = { method: metodo.toUpperCase(), path: caminho, params, query, body, usuario, get: () => '', headers: {}, ip: '127.0.0.1' }
    const h = padrao === '/candidaturas/minhas' ? require(path.join(REPO, 'src/controllers/candidaturasController')).minhas : handler(metodo, padrao)
    mw(req, res, () => Promise.resolve(h(req, res)).catch(e => resolve({ status: 599, body: { erro: String(e.message) } })))
  })
  // todo objeto com valor_a_combinar = true: nenhuma chave de valor do pedido null/undefined
  const nulos = (dado, achados = [], trilha = '$') => {
    if (dado === null || typeof dado !== 'object') return achados
    if (Array.isArray(dado)) { dado.forEach((x, i) => nulos(x, achados, `${trilha}[${i}]`)); return achados }
    if (dado.valor_a_combinar === true) for (const c of ['valor', 'valor_estimado']) if (c in dado && (dado[c] === null || dado[c] === undefined)) achados.push(`${trilha}.${c}`)
    for (const k of Object.keys(dado)) nulos(dado[k], achados, `${trilha}.${k}`)
    return achados
  }
  const contem = (dado, id) => JSON.stringify(dado).includes(id)
  // Estado: RID (reparo a combinar, PRO escolhido) e OID (obra a combinar, PRO2 escolhido); + um de cada SEM escolhido para o feed.
  r = await calado(() => viaRouter('post', '/reparos/dono', { usuario: DONO, body: { ...baseR, titulo: 'Feed a combinar', valor_a_combinar: true } }))
  ok(r.status === 201 && r.body.valor_estimado === '0.01' && r.body.valor_a_combinar === true, 'POST /reparos/dono (app): resposta com valor_estimado "0.01" + flag', [r.status, r.body.valor_estimado, r.body.erro])
  const RFEED = r.body.id
  ok((await linha('reparos', RFEED)).valor_estimado === null, '…e o BANCO continua com NULL')
  r = await calado(() => viaRouter('post', '/obras/dono', { usuario: DONO, body: { ...baseO, titulo: 'Obra feed a combinar', valor_a_combinar: true } }))
  ok(r.status === 201 && r.body.valor === '0.01' && r.body.valor_a_combinar === true, 'POST /obras/dono (app): resposta com valor "0.01" + flag', [r.status, r.body.valor, r.body.erro])
  const OFEED = r.body.id
  await db.query(`UPDATE obras SET status = 'aberta', status_aprovacao = 'aprovada', publicado_em = now() WHERE id = $1`, [OFEED])
  ok((await linha('obras', OFEED)).valor === null, '…e o BANCO continua com NULL (obra)')
  // As listas do app (feed, detalhe, minhas, meus-interesses, candidaturas, contratos) rodam sobre o
  // esquema de produção em scripts/testar-valor-a-combinar-app.js.
  // PAINEL: passa pelo mesmo router e NÃO é alterado
  for (const [t, filtro, id, col] of [['reparos', 'abertas', RFEED, 'valor_estimado'], ['obras', 'abertas', OFEED, 'valor']]) {
    const resp = await calado(() => viaRouter('get', `/${t}/admin`, { usuario: ADM, query: { filtro } }))
    const item = (resp.body[t] || []).find(x => x.id === id)
    ok(resp.status === 200 && item && item[col] === null && item.valor_a_combinar === true, `painel GET /${t}/admin?filtro=${filtro}: valor continua null (com a flag)`, item && [item[col], item.valor_a_combinar, item.valor_acordado])
  }
  r = await calado(() => viaRouter('put', '/obras/:id', { usuario: ADM, params: { id: OPAINEL }, body: { titulo: 'Obra do painel 3' } }))
  ok(V.ehRotaDoPainel({ method: 'PUT', path: `/obras/${OPAINEL}` }) === true, 'PUT /obras/:id é rota do painel (resposta não é alterada)')

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
