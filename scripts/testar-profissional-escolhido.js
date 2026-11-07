#!/usr/bin/env node
// Testa "profissional escolhido = match OU proposta 'aceito'" (utils/profissionalEscolhido) nos três
// consumidores: utils/itensCanal (canal + resumo das 18:00), página pública GET /p/:codigo e as
// listas do painel GET /obras/admin e GET /reparos/admin (escolhido_nome / escolhido_em), com o SQL
// REAL num Postgres em memória (PGlite). Caso de produção: obra 'Pintura' com candidatura 'aceito'
// e obras.match_usuario_id NULL — tem profissional, não é oferta.
//   npm i -D @electric-sql/pglite && node scripts/testar-profissional-escolhido.js
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

let db = null
const shim = {
  query: (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return db.query(sql, params) },
  connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: (s, p) => db.query(s, p), release() {} } },
  on() {},
}
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error
console.log = () => {}; console.error = () => {}
const router = require(path.join(REPO, 'src/routes/index.js'))
console.log = logOrig; console.error = errOrig
const paginaPublica = require(path.join(REPO, 'src/routes/paginaPublica'))
const { TEXTO_COM_PROFISSIONAL } = paginaPublica._interno
const { listarItensCanal } = require(path.join(REPO, 'src/utils/itensCanal'))

const rota = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const chamar = (handler, { usuario, params = {}, query = {}, body = {} }) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, query, body, usuario }, res)
})
const handlerPagina = paginaPublica.stack.find(l => l.route && l.route.path === '/:codigo').route.stack[0].handle
const abrirPagina = (codigo) => new Promise(resolve => {
  const res = {
    statusCode: 200, status(c) { this.statusCode = c; return this }, set() { return this }, type() { return this },
    send(html) { resolve({ status: this.statusCode, html: String(html) }) },
  }
  handlerPagina({ params: { codigo }, protocol: 'https', get: (h) => (h === 'host' ? 'protudo.app.br' : 'Mozilla/5.0 (Linux; Android 14)') }, res)
})
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const ADMIN = { id: U(9), role: 'admin' }
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const main = async () => {
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, criado_por uuid, titulo text, categoria text, bairro text, cidade text, uf text, prazo_modo text,
      status text DEFAULT 'aberta', status_aprovacao text DEFAULT 'aprovada', expira_em timestamptz, criado_em timestamptz DEFAULT now(),
      codigo_publico text, match_usuario_id uuid, match_feito_em timestamptz, chegada_prevista_em timestamptz, prazo_chegada_extra_em timestamptz`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, telefone text);
    CREATE TABLE reparos (${colsDemanda}, categorias text[], valor_estimado numeric, prazo_atendimento_horas numeric);
    CREATE TABLE obras (${colsDemanda}, valor numeric, horas_para_expirar numeric, metragem numeric, prazo_execucao_dias int, tags text[]);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, status text DEFAULT 'pendente', criado_em timestamptz DEFAULT now());
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, status text DEFAULT 'pendente', criado_em timestamptz DEFAULT now());
    CREATE UNIQUE INDEX candidaturas_aceito_unica_idx ON candidaturas (obra_id) WHERE status = 'aceito';
    CREATE UNIQUE INDEX interesse_reparos_aceito_unico_idx ON interesse_reparos (reparo_id) WHERE status = 'aceito';
  `)
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone) VALUES
    ($1, 'Maria Nogueira', 'maria@x.invalid', '34999990000'),
    ($2, 'Alex Sander', 'alex@x.invalid', '34999990001'),
    ($3, 'Bruno Pintor', 'bruno@x.invalid', '34999990002')`, [U(1), U(2), U(3)])
  // Obras (Patos de Minas, todas abertas/aprovadas/vivas):
  //   o1 'Pintura'  — candidatura 'aceito' do Alex, match_usuario_id NULL (caso de produção)
  //   o2 'Empregada' — sem ninguém (uma candidatura pendente e uma recusada)
  //   o3 'Com match' — match_usuario_id do Bruno + candidatura aceita (caminho normal)
  //   o4 'Encerrada' — encerrada, com candidatura aceita (não é "com profissional": é encerrada)
  await db.query(`INSERT INTO obras (id, criado_por, titulo, categoria, bairro, cidade, uf, valor, horas_para_expirar, expira_em, codigo_publico, match_usuario_id, match_feito_em, status, criado_em) VALUES
    ($1, $5, 'Pintura',   'residencial', 'Copacabana', 'Patos de Minas', 'MG', 3000, 720, now() + INTERVAL '20 days', 'PNTUR', NULL, NULL, 'aberta', '2026-11-06T22:32:00-03:00'),
    ($2, $5, 'Empregada', 'residencial', 'Centro',     'Patos de Minas', 'MG', 2000, 720, now() + INTERVAL '20 days', 'EMPRE', NULL, NULL, 'aberta', '2026-11-06T10:00:00-03:00'),
    ($3, $5, 'Com match', 'residencial', 'Centro',     'Patos de Minas', 'MG', 4000, 720, now() + INTERVAL '20 days', 'MATCH', $6, '2026-11-05T09:00:00-03:00', 'aberta', '2026-11-04T10:00:00-03:00'),
    ($4, $5, 'Encerrada', 'residencial', 'Centro',     'Patos de Minas', 'MG', 1000, 720, now() + INTERVAL '20 days', 'ENCER', NULL, NULL, 'encerrada', '2026-11-01T10:00:00-03:00')`,
    [D(1), D(2), D(3), D(4), U(1), U(3)])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status, criado_em) VALUES
    ($1, $4, 'aceito',   '2026-11-07T08:00:00-03:00'),
    ($2, $4, 'pendente', now()), ($2, $5, 'recusado', now()),
    ($3, $5, 'aceito',   '2026-11-05T08:00:00-03:00'),
    ($6, $4, 'aceito',   now())`, [D(1), D(2), D(3), U(2), U(3), D(4)])
  // Reparos: r1 interesse 'aceito' sem match; r2 livre; r3 match + interesse aceito.
  await db.query(`INSERT INTO reparos (id, criado_por, titulo, categoria, categorias, bairro, cidade, uf, valor_estimado, prazo_atendimento_horas, expira_em, codigo_publico, match_usuario_id, match_feito_em, status) VALUES
    ($1, $4, 'Torneira', 'hidraulica', '{hidraulica}', 'Centro', 'Patos de Minas', 'MG', 100, 24, now() + INTERVAL '20 hours', 'TRNRA', NULL, NULL, 'aberta'),
    ($2, $4, 'Tomada',   'eletrica',   '{eletrica}',   'Lagoa',  'Patos de Minas', 'MG', 80,  24, now() + INTERVAL '20 hours', 'TMADA', NULL, NULL, 'aberta'),
    ($3, $4, 'Chuveiro', 'eletrica',   '{eletrica}',   'Lagoa',  'Patos de Minas', 'MG', 90,  24, now() + INTERVAL '20 hours', 'CHUVE', $5, '2026-11-06T12:00:00-03:00', 'aberta')`,
    [D(11), D(12), D(13), U(1), U(2)])
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status, criado_em) VALUES
    ($1, $3, 'aceito', '2026-11-06T15:00:00-03:00'), ($2, $3, 'pendente', now()), ($4, $3, 'aceito', now())`, [D(11), D(12), U(2), D(13)])

  // (1) canal + resumo das 18:00: só o que NÃO tem profissional (nem match, nem proposta aceita)
  const itens = await listarItensCanal({ cidade: 'Patos de Minas', uf: 'MG' })
  const codigos = itens.map(i => i.codigo_publico).sort().join()
  ok(codigos === 'EMPRE,TMADA', 'itensCanal: obra com candidatura aceita (sem match) e reparo com interesse aceito ficam FORA; livres entram', itens.map(i => `${i.tipo}:${i.codigo_publico}`))

  // (2) listas do painel: escolhido_nome / escolhido_em
  const obrasAdmin = await chamar(rota('get', '/obras/admin'), { usuario: ADMIN, query: { filtro: 'abertas' } })
  const porCodigo = (lista, titulo) => lista.find(x => x.titulo === titulo)
  ok(obrasAdmin.status === 200 && obrasAdmin.body.obras.length === 3, 'GET /obras/admin?filtro=abertas: 3 obras abertas', obrasAdmin.body.obras?.map(o => o.titulo))
  const pintura = porCodigo(obrasAdmin.body.obras, 'Pintura')
  ok(pintura?.escolhido_nome === 'Alex Sander' && new Date(pintura.escolhido_em).toISOString() === '2026-11-07T11:00:00.000Z',
     "obra 'Pintura' (candidatura aceita, match NULL): escolhido_nome = Alex Sander, escolhido_em = data da candidatura", { nome: pintura?.escolhido_nome, em: pintura?.escolhido_em })
  const empregada = porCodigo(obrasAdmin.body.obras, 'Empregada')
  ok(empregada && empregada.escolhido_nome === null && empregada.escolhido_em === null, "obra 'Empregada' (pendente + recusada): escolhido_nome/escolhido_em NULL", { nome: empregada?.escolhido_nome, em: empregada?.escolhido_em })
  const comMatch = porCodigo(obrasAdmin.body.obras, 'Com match')
  ok(comMatch?.escolhido_nome === 'Bruno Pintor' && new Date(comMatch.escolhido_em).toISOString() === '2026-11-05T12:00:00.000Z',
     'obra com match: escolhido_nome = usuário do match, escolhido_em = match_feito_em (prevalece sobre a data da candidatura)', { nome: comMatch?.escolhido_nome, em: comMatch?.escolhido_em })
  const finalizadas = await chamar(rota('get', '/obras/admin'), { usuario: ADMIN, query: { filtro: 'finalizadas' } })
  ok(finalizadas.body.obras.length === 1 && finalizadas.body.obras[0].escolhido_nome === 'Alex Sander', 'obra encerrada com candidatura aceita: escolhido_nome preenchido na lista de finalizadas', finalizadas.body.obras.map(o => [o.titulo, o.escolhido_nome]))

  const reparosAdmin = await chamar(rota('get', '/reparos/admin'), { usuario: ADMIN, query: { filtro: 'abertas' } })
  ok(reparosAdmin.status === 200 && reparosAdmin.body.reparos.length === 3, 'GET /reparos/admin?filtro=abertas: 3 serviços', reparosAdmin.body.reparos?.map(r => r.titulo))
  const torneira = porCodigo(reparosAdmin.body.reparos, 'Torneira')
  ok(torneira?.escolhido_nome === 'Alex Sander' && new Date(torneira.escolhido_em).toISOString() === '2026-11-06T18:00:00.000Z', 'reparo com interesse aceito sem match: escolhido_nome/escolhido_em', { nome: torneira?.escolhido_nome, em: torneira?.escolhido_em })
  const tomada = porCodigo(reparosAdmin.body.reparos, 'Tomada')
  ok(tomada && tomada.escolhido_nome === null && tomada.escolhido_em === null, 'reparo só com interesse pendente: NULL')
  const chuveiro = porCodigo(reparosAdmin.body.reparos, 'Chuveiro')
  ok(chuveiro?.escolhido_nome === 'Alex Sander' && new Date(chuveiro.escolhido_em).toISOString() === '2026-11-06T15:00:00.000Z', 'reparo com match: escolhido_em = match_feito_em')

  // (3) página pública
  let r = await abrirPagina('PNTUR')
  ok(r.status === 200 && r.html.includes(TEXTO_COM_PROFISSIONAL) && /Pintura/.test(r.html) && !/R\$ 3/.test(r.html) && !/Tem cliente esperando/.test(r.html),
     "/p/PNTUR (candidatura aceita, match NULL): \"Este pedido já tem um profissional escolhido.\", sem valor nem chamada de aberta")
  r = await abrirPagina('EMPRE')
  ok(r.status === 200 && /Tem cliente esperando/.test(r.html) && !r.html.includes(TEXTO_COM_PROFISSIONAL), '/p/EMPRE (pendente + recusada): aberta')
  r = await abrirPagina('TRNRA')
  ok(r.status === 200 && r.html.includes(TEXTO_COM_PROFISSIONAL), '/p/TRNRA (interesse aceito, match NULL): com profissional')
  r = await abrirPagina('ENCER')
  ok(r.status === 200 && /já foi atendido ou expirou/.test(r.html) && !r.html.includes(TEXTO_COM_PROFISSIONAL), '/p/ENCER (encerrada com candidatura aceita): encerrada, não "com profissional"')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
