#!/usr/bin/env node
// Testa, em GET /obras/:id e GET /reparos/:id, a autoria das perguntas para o DONO
// (autor_id, autor_nome, autor_candidato) e a pergunta de cada candidato/interessado na lista do
// dono (pergunta_id, pergunta, resposta); para profissionais a pergunta segue anônima.
// SQL REAL em Postgres em memória (PGlite); handlers chamados direto.
//   npm i -D @electric-sql/pglite && node scripts/testar-perguntas-dono.js
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

const rota = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const chamar = (handler, usuario, id) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params: { id }, query: {}, body: {}, usuario, headers: {} }, res)
})
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const P = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`
const DONO = { id: U(1), role: 'dono_obra' }
const PINTOR_A = { id: U(2), role: 'prestador', tipo_prestador: 'pintor' }     // perguntou E se candidatou
const PINTOR_B = { id: U(3), role: 'prestador', tipo_prestador: 'pintor' }     // só perguntou
const PINTOR_C = { id: U(4), role: 'prestador', tipo_prestador: 'pintor' }     // candidatura RECUSADA + pergunta
const PINTOR_D = { id: U(5), role: 'prestador', tipo_prestador: 'pintor' }     // só se candidatou, sem pergunta
const REP_A = { id: U(6), role: 'prestador', tipo_prestador: 'reparador' }
const REP_B = { id: U(7), role: 'prestador', tipo_prestador: 'reparador' }
const OUTRO_DONO = { id: U(8), role: 'dono_obra' }
const ADMIN = { id: U(9), role: 'admin' }
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const semAutor = (p) => !('autor_id' in p) && !('autor_nome' in p) && !('autor_candidato' in p)

const main = async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, role text, tipo_prestador text, cidade text, bairro text, foto_url text,
      anos_experiencia int, especialidades text[], tamanho_equipe text, embaixador boolean DEFAULT false, logradouro text, numero text, telefone text, push_token text);
    CREATE TABLE assinaturas (usuario_id uuid, status text, proximo_vencimento timestamptz);
    CREATE TABLE avaliacoes (avaliado_id uuid, estrelas int);
    CREATE TABLE obras (id uuid PRIMARY KEY, titulo text, descricao text, criado_por uuid, status text DEFAULT 'aberta', status_aprovacao text DEFAULT 'aprovada',
      match_usuario_id uuid, a_caminho_em timestamptz, valor numeric, horas_para_expirar int, publicado_em timestamptz, criado_em timestamptz DEFAULT now(),
      expira_em timestamptz DEFAULT now() + interval '10 days', valor_aumentado_em timestamptz, alerta_enviado_em timestamptz,
      chegada_prevista_em timestamptz, prazo_chegada_extra_em timestamptz, endereco_obra text, ponto_referencia text,
      sugestoes_horario_dono int DEFAULT 0, sugestoes_horario_profissional int DEFAULT 0);
    CREATE TABLE reparos (id uuid PRIMARY KEY, titulo text, descricao text, criado_por uuid, status text DEFAULT 'aberta', status_aprovacao text DEFAULT 'aprovada',
      match_usuario_id uuid, a_caminho_em timestamptz, valor_estimado numeric, prazo_atendimento_horas int, criado_em timestamptz DEFAULT now(),
      expira_em timestamptz DEFAULT now() + interval '10 days', valor_aumentado_em timestamptz, alerta_enviado_em timestamptz,
      chegada_prevista_em timestamptz, prazo_chegada_extra_em timestamptz, endereco_reparo text, ponto_referencia text,
      sugestoes_horario_dono int DEFAULT 0, sugestoes_horario_profissional int DEFAULT 0);
    CREATE TABLE midias (id serial, obra_id uuid, url text, ordem int);
    CREATE TABLE midias_reparos (id serial, reparo_id uuid, url text, ordem int);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, status text DEFAULT 'pendente', valor_oferta numeric,
      mensagem_oferta text, valor_proposto numeric, mensagem text, valor_contraproposta numeric, criado_em timestamptz DEFAULT now());
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, status text DEFAULT 'pendente', mensagem text,
      valor_proposto numeric, valor_contraproposta numeric, rodada int DEFAULT 1, criado_em timestamptz DEFAULT now());
    CREATE TABLE perguntas_demanda (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tipo text, demanda_id uuid, autor_id uuid, pergunta text, resposta text,
      criado_em timestamptz DEFAULT now(), respondido_em timestamptz, UNIQUE (tipo, demanda_id, autor_id));
    CREATE TABLE push_entregas (tipo text, demanda_id uuid, usuario_id uuid, resultado text);
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid);
  `)
  const nomes = { [U(1)]: 'Dona Maria', [U(2)]: 'Pintor Alfa', [U(3)]: 'Pintor Beta', [U(4)]: 'Pintor Gama', [U(5)]: 'Pintor Delta', [U(6)]: 'Reparador Um', [U(7)]: 'Reparador Dois', [U(8)]: 'Outro Dono', [U(9)]: 'Admin' }
  for (const u of [DONO, PINTOR_A, PINTOR_B, PINTOR_C, PINTOR_D, REP_A, REP_B, OUTRO_DONO, ADMIN]) {
    await db.query(`INSERT INTO usuarios (id, nome, role, tipo_prestador, cidade, bairro, telefone) VALUES ($1, $2, $3, $4, 'Uberlândia', 'Centro', '34999990000')`, [u.id, nomes[u.id], u.role, u.tipo_prestador || null])
    await db.query(`INSERT INTO assinaturas VALUES ($1, 'ativa', NULL)`, [u.id])
  }
  // Obra do dono: A pergunta+candidata (pendente), B só pergunta, C pergunta + candidatura recusada, D só candidata.
  await db.query(`INSERT INTO obras (id, titulo, descricao, criado_por, valor, horas_para_expirar) VALUES ($1, 'Pintar sala', 'Sala 20m²', $2, 1500, 240)`, [D(1), DONO.id])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status, mensagem, criado_em) VALUES ($1, $2, 'pendente', 'Faço em 2 dias', now() - interval '3 hours')`, [D(1), PINTOR_A.id])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status, mensagem, criado_em) VALUES ($1, $2, 'recusado', 'Posso amanhã', now() - interval '2 hours')`, [D(1), PINTOR_C.id])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status, mensagem, criado_em) VALUES ($1, $2, 'pendente', 'Orçamento fechado', now() - interval '1 hour')`, [D(1), PINTOR_D.id])
  await db.query(`INSERT INTO perguntas_demanda (id, tipo, demanda_id, autor_id, pergunta, resposta, respondido_em, criado_em) VALUES ($1, 'obra', $2, $3, 'Tem andaime?', 'Sim, tem', now(), now() - interval '5 hours')`, [P(1), D(1), PINTOR_A.id])
  await db.query(`INSERT INTO perguntas_demanda (id, tipo, demanda_id, autor_id, pergunta, criado_em) VALUES ($1, 'obra', $2, $3, 'Qual a cor?', now() - interval '4 hours')`, [P(2), D(1), PINTOR_B.id])
  await db.query(`INSERT INTO perguntas_demanda (id, tipo, demanda_id, autor_id, pergunta, criado_em) VALUES ($1, 'obra', $2, $3, 'Material incluso?', now() - interval '3 hours')`, [P(3), D(1), PINTOR_C.id])
  // Reparo do dono: REP_A pergunta + interesse em contraproposta (vivo); REP_B só interesse.
  await db.query(`INSERT INTO reparos (id, titulo, descricao, criado_por, valor_estimado, prazo_atendimento_horas) VALUES ($1, 'Trocar chuveiro', 'Chuveiro 220v', $2, 150, 48)`, [D(2), DONO.id])
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status, mensagem, rodada) VALUES ($1, $2, 'contraproposta_dono', 'Vou hoje', 2)`, [D(2), REP_A.id])
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status, mensagem) VALUES ($1, $2, 'pendente', 'Posso agora')`, [D(2), REP_B.id])
  await db.query(`INSERT INTO perguntas_demanda (id, tipo, demanda_id, autor_id, pergunta) VALUES ($1, 'reparo', $2, $3, 'Já tem o chuveiro novo?')`, [P(4), D(2), REP_A.id])

  const getObra = rota('get', '/obras/:id'), getReparo = rota('get', '/reparos/:id')

  // ── OBRA, dono ──
  const o = await chamar(getObra, DONO, D(1))
  ok(o.status === 200 && o.body.perguntas.length === 3, 'obra/dono: 3 perguntas', o.body.perguntas.map(p => `${p.autor_nome}:${p.autor_candidato}`))
  const [pa, pb, pc] = o.body.perguntas
  ok(pa.autor_id === PINTOR_A.id && pa.autor_nome === 'Pintor Alfa' && pa.autor_candidato === true && pa.resposta === 'Sim, tem' && pa.minha === false, 'obra/dono: autor A identificado, candidato=true', pa)
  ok(pb.autor_id === PINTOR_B.id && pb.autor_nome === 'Pintor Beta' && pb.autor_candidato === false, 'obra/dono: autor B sem candidatura → candidato=false')
  ok(pc.autor_id === PINTOR_C.id && pc.autor_candidato === false, 'obra/dono: candidatura RECUSADA não conta como candidato')
  ok(o.body.candidatos.length === 3, 'obra/dono: 3 candidatos', o.body.candidatos.map(c => `${c.nome}:${c.pergunta}`))
  const cA = o.body.candidatos.find(c => c.usuario_id === PINTOR_A.id), cC = o.body.candidatos.find(c => c.usuario_id === PINTOR_C.id), cD = o.body.candidatos.find(c => c.usuario_id === PINTOR_D.id)
  ok(cA.pergunta_id === P(1) && cA.pergunta === 'Tem andaime?' && cA.resposta === 'Sim, tem', 'obra/dono: candidato A traz sua pergunta e resposta')
  ok(cC.pergunta_id === P(3) && cC.pergunta === 'Material incluso?' && cC.resposta === null, 'obra/dono: candidato recusado C traz pergunta sem resposta')
  ok(cD.pergunta_id === null && cD.pergunta === null && cD.resposta === null, 'obra/dono: candidato D sem pergunta → nulls')
  ok(cA.telefone === null && cA.logradouro === null, 'obra/dono: contato do candidato continua fechado sem match')

  // ── OBRA, profissionais ──
  const a = await chamar(getObra, PINTOR_A, D(1))
  ok(a.status === 200 && a.body.perguntas.length === 3 && a.body.perguntas.every(semAutor), 'obra/pintor A: perguntas sem autor_id/autor_nome/autor_candidato', a.body.perguntas.map(p => Object.keys(p)))
  ok(a.body.perguntas[0].minha === true && a.body.perguntas[1].minha === false, 'obra/pintor A: minha=true só na dele')
  ok(a.body.candidatos.length === 0, 'obra/pintor A: não vê lista de candidatos')
  const b = await chamar(getObra, PINTOR_D, D(1))
  ok(b.body.perguntas.every(semAutor) && b.body.perguntas.every(p => p.minha === false), 'obra/pintor D (sem pergunta): tudo anônimo, minha=false')
  const od = await chamar(getObra, OUTRO_DONO, D(1))
  ok(od.status === 403, 'obra/outro dono: 403')
  const ad = await chamar(getObra, ADMIN, D(1))
  ok(ad.status === 200 && ad.body.perguntas.every(semAutor) && ad.body.candidatos.length === 3 && ad.body.candidatos.find(c => c.usuario_id === PINTOR_A.id).pergunta === 'Tem andaime?', 'obra/admin: perguntas anônimas (não é o dono), lista de candidatos com pergunta')

  // ── REPARO, dono ──
  const r = await chamar(getReparo, DONO, D(2))
  ok(r.status === 200 && r.body.perguntas.length === 1, 'reparo/dono: 1 pergunta')
  const pr = r.body.perguntas[0]
  ok(pr.autor_id === REP_A.id && pr.autor_nome === 'Reparador Um' && pr.autor_candidato === true, 'reparo/dono: autor com interesse em contraproposta_dono → candidato=true', pr)
  const iA = r.body.interessados.find(i => i.usuario_id === REP_A.id), iB = r.body.interessados.find(i => i.usuario_id === REP_B.id)
  ok(iA.pergunta_id === P(4) && iA.pergunta === 'Já tem o chuveiro novo?' && iA.resposta === null, 'reparo/dono: interessado A traz pergunta (sem resposta)')
  ok(iB.pergunta_id === null && iB.pergunta === null, 'reparo/dono: interessado B sem pergunta → nulls')
  ok(r.body.interessados.length === 2 && iA.rodada === 2, 'reparo/dono: lista intacta (2 interessados, rodada preservada)')

  // ── REPARO, profissionais ──
  const ra = await chamar(getReparo, REP_A, D(2))
  ok(ra.status === 200 && ra.body.perguntas.length === 1 && semAutor(ra.body.perguntas[0]) && ra.body.perguntas[0].minha === true, 'reparo/reparador A: anônimo, minha=true')
  const rb = await chamar(getReparo, REP_B, D(2))
  ok(semAutor(rb.body.perguntas[0]) && rb.body.perguntas[0].minha === false && rb.body.interessados.length === 0, 'reparo/reparador B: anônimo, minha=false, sem lista')

  // Interesse 'expirado'/'cancelado' também não conta; novo interesse vivo volta a contar
  await db.query(`UPDATE interesse_reparos SET status = 'expirado' WHERE usuario_id = $1`, [REP_A.id])
  const r2 = await chamar(getReparo, DONO, D(2))
  ok(r2.body.perguntas[0].autor_candidato === false, 'reparo/dono: interesse expirado → candidato=false')
  await db.query(`UPDATE interesse_reparos SET status = 'aceito' WHERE usuario_id = $1`, [REP_A.id])
  const r3 = await chamar(getReparo, DONO, D(2))
  ok(r3.body.perguntas[0].autor_candidato === true, 'reparo/dono: interesse aceito → candidato=true')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
