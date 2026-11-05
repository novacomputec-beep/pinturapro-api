#!/usr/bin/env node
// Testa lembrarPerguntasSemResposta (alertaService) com o SQL REAL num Postgres em memória (PGlite):
// pool trocado por um shim, Expo e Brevo trocados por fakes que só coletam as mensagens,
// NOW() sombreado por public.now() para andar o relógio (hora de São Paulo).
// Cadência esperada: 1º ciclo 30 min após a pergunta sem resposta mais antiga; depois pelo tempo
// RESTANTE até expira_em, reavaliado a cada tique: > 3 d → 12h · 1–3 d → 6h · 6–24h → 2h · < 6h → 30 min.
// Pergunta nova depois do último ciclo reinicia (30 min depois dela).
//   npm i -D @electric-sql/pglite && node scripts/testar-perguntas-sem-resposta.js
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

let db
const shim = {
  query: (sql, params) => db.query(sql, params),
  connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }),
  on() {},
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) }, enviarEmailComAnexo: async () => {} }
  return origLoad.apply(this, arguments)
}

const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
// T0 = 05/11/2026 10:00 São Paulo (13:00Z). Relógio em minutos a partir de T0.
const T0 = Date.parse('2026-11-05T13:00:00Z')
const emMin = (min) => new RealDate(T0 + min * 60000).toISOString()
// O relógio do JS (diaSP, chave do e-mail diário) anda junto com o NOW() do banco.
let relogio = T0
const RealDate = Date
global.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [relogio])) }
  static now() { return relogio }
}
const fixarAgora = (min) => {
  relogio = T0 + min * 60000
  return db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${emMin(min)}'::timestamptz $$`)
}

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const main = async () => {
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, criado_por uuid, status text, status_aprovacao text, match_usuario_id uuid,
      expira_em timestamptz, criado_em timestamptz,
      lembrete_perguntas_ultimo_em timestamptz, lembrete_perguntas_ciclo int NOT NULL DEFAULT 0`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text, desinstalado_em timestamptz);
    CREATE TABLE reparos (${colsDemanda});
    CREATE TABLE obras (${colsDemanda});
    CREATE TABLE perguntas_demanda (id uuid PRIMARY KEY, tipo text, demanda_id uuid, autor_id uuid, pergunta text, resposta text,
      criado_em timestamptz DEFAULT now(), respondido_em timestamptz, UNIQUE (tipo, demanda_id, autor_id));
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    SET search_path = public, pg_catalog;
  `)
  await db.query(`INSERT INTO usuarios VALUES ($1, 'Dono Silva', 'dono@x.invalid', 'ExponentPushToken[dono]')`, [U(99)])
  for (const n of [1, 2, 3]) await db.query(`INSERT INTO usuarios VALUES ($1, $2, $3, $4)`, [U(n), `Prof ${n}`, `p${n}@x.invalid`, `ExponentPushToken[p${n}]`])
  await fixarAgora(0)
  // Quatro demandas abertas sem match; "restante" até expira_em contado de T0. Perguntas às 09:30 SP (T0 − 30 min).
  const cenarios = [
    { n: 1, tabela: 'reparos', tipo: 'reparo', rotulo: '10 dias', restanteMin: 10 * 1440 },
    { n: 2, tabela: 'obras',   tipo: 'obra',   rotulo: '2 dias',  restanteMin: 2 * 1440 },
    { n: 3, tabela: 'reparos', tipo: 'reparo', rotulo: '12 horas', restanteMin: 12 * 60 },
    { n: 4, tabela: 'reparos', tipo: 'reparo', rotulo: '3 horas',  restanteMin: 3 * 60 },
  ]
  let seqPergunta = 0
  const perguntar = (c, autor, minAtras, respondida = false) => db.query(
    `INSERT INTO perguntas_demanda (id, tipo, demanda_id, autor_id, pergunta, criado_em, respondido_em)
     VALUES ($1, $2, $3, $4, 'Faz no sábado?', now() - ($5 * INTERVAL '1 minute'), CASE WHEN $6 THEN now() ELSE NULL END)`,
    [`eeeeeeee-0000-4000-8000-${String(++seqPergunta).padStart(12, '0')}`, c.tipo, D(c.n), autor, minAtras, respondida])
  for (const c of cenarios) {
    await db.query(
      `INSERT INTO ${c.tabela} (id, titulo, criado_por, status, status_aprovacao, match_usuario_id, expira_em, criado_em)
       VALUES ($1, $2, $3, 'aberta', 'aprovada', NULL, now() + ($4 * INTERVAL '1 minute'), now() - INTERVAL '3 hours')`,
      [D(c.n), `Demanda ${c.rotulo}`, U(99), c.restanteMin])
    await perguntar(c, U(1), 30)
  }
  // Na de 10 dias: 2ª pergunta (mais nova, 10 min) e uma já respondida → conta 2.
  await perguntar(cenarios[0], U(2), 10)
  await perguntar(cenarios[0], U(3), 40, true)
  // Demanda casada com pergunta sem resposta: nunca avisa.
  await db.query(`INSERT INTO reparos (id, titulo, criado_por, status, status_aprovacao, match_usuario_id, expira_em, criado_em)
                  VALUES ($1, 'Casada', $2, 'aberta', 'aprovada', $3, now() + INTERVAL '5 days', now() - INTERVAL '3 hours')`, [D(5), U(99), U(2)])
  await perguntar({ tipo: 'reparo', n: 5 }, U(1), 120)

  const A = require(path.join(REPO, 'src/services/alertaService'))
  const ciclo = async (c) => (await db.query(`SELECT lembrete_perguntas_ciclo AS n FROM ${c.tabela} WHERE id = $1`, [D(c.n)])).rows[0].n
  const ciclos = async () => { const r = {}; for (const c of cenarios) r[c.rotulo] = await ciclo(c); return r }
  const tique = async (min) => { await fixarAgora(min); await A.lembrarPerguntasSemResposta() }
  const [c10d, c2d, c12h, c3h] = cenarios
  const pushesDe = (token) => pushes.filter(p => p.to === `ExponentPushToken[${token}]`)
  const emailsDono = async (c) => (await db.query(`SELECT tipo FROM email_alertas WHERE demanda_id = $1 AND usuario_id = $2 ORDER BY tipo`, [D(c.n), U(99)])).rows.map(r => r.tipo)

  // 1) 29 min após a pergunta mais antiga: nada
  await tique(-1)
  ok(Object.values(await ciclos()).every(n => n === 0) && pushes.length === 0, '09:59 (pergunta + 29 min): nenhum ciclo', await ciclos())
  // 2) 30 min: 1º ciclo nas quatro (a de 10 dias conta pela mais ANTIGA, não pela de 10 min), push + e-mail ao dono
  await tique(0)
  ok(Object.values(await ciclos()).every(n => n === 1), '10:00 (pergunta mais antiga + 30 min): 1º ciclo nas 4 demandas', await ciclos())
  ok(pushesDe('dono').length === 4 && pushes.length === 4, '1º ciclo: 4 pushes ao dono, nenhum a profissional', pushes.length)
  ok(emails.length === 4 && emails.every(e => e.para === 'dono@x.invalid'), '1º ciclo: 1 e-mail por demanda ao dono', emails.length)
  const p1 = pushesDe('dono').find(p => p.data.reparo_id === D(1))
  ok(p1.title === '❓ 2 perguntas aguardam sua resposta' && p1.body === 'Demanda 10 dias: responda para atrair propostas', 'plural: 2 sem resposta (a respondida não conta)', [p1.title, p1.body])
  const p2 = pushesDe('dono').find(p => p.data.obra_id === D(2))
  ok(p2.title === '❓ 1 pergunta aguarda sua resposta', 'singular', p2.title)
  ok(p1.data.tipo === 'nova_pergunta' && !('pergunta_id' in p1.data) && p2.data.tipo === 'nova_pergunta', 'data: nova_pergunta + id da demanda, sem pergunta_id', [p1.data, p2.data])
  const casada = await db.query(`SELECT lembrete_perguntas_ciclo AS n FROM reparos WHERE id = $1`, [D(5)])
  ok(casada.rows[0].n === 0, 'demanda casada: nunca avisa')
  // 3) 29 min depois: nada; 30 min: só a de 3h (< 6h → 30 min); e-mail do dia já enviado
  await tique(29)
  ok(JSON.stringify(await ciclos()) === JSON.stringify({ '10 dias': 1, '2 dias': 1, '12 horas': 1, '3 horas': 1 }), '10:29: nenhum ciclo novo', await ciclos())
  await tique(30)
  ok(await ciclo(c3h) === 2 && await ciclo(c12h) === 1, '10:30: 3h → 2º ciclo (30 min); 12h ainda no 1º', await ciclos())
  ok((await emailsDono(c3h)).length === 1 && emails.length === 4, 'dono: 1 e-mail/dia por demanda (2º ciclo só push)', [await emailsDono(c3h), emails.length])
  // 4) 12h: 2h de intervalo (6–24h restantes)
  await tique(119); ok(await ciclo(c12h) === 1, '11:59: 12h ainda no 1º ciclo')
  await tique(120); ok(await ciclo(c12h) === 2, '12:00: 12h → 2º ciclo (2h)')
  // 5) 3h: expira às 13:00 → para
  const antes3h = await ciclo(c3h)
  await tique(180); ok(await ciclo(c3h) === antes3h, '13:00: 3h venceu → parou', [antes3h, await ciclo(c3h)])
  // 6) 2 dias: 6h (1–3 dias restantes)
  await tique(359); ok(await ciclo(c2d) === 1 && await ciclo(c10d) === 1, '15:59: 2d e 10d ainda no 1º ciclo', await ciclos())
  await tique(360); ok(await ciclo(c2d) === 2 && await ciclo(c10d) === 1, '16:00: 2d → 2º ciclo (6h); 10d não (12h)', await ciclos())
  // 7) Pergunta NOVA na de 12h às 16:00 (ciclo 2 foi às 12:00, 3º seria às 14:00 → já ciclo 3; o 4º seria às 16:00):
  //    reinicia: 30 min depois dela, não antes.
  await perguntar(c12h, U(2), 0)
  const antes12h = await ciclo(c12h)
  await tique(389); ok(await ciclo(c12h) === antes12h, '16:29: pergunta nova há 29 min → ainda não', [antes12h, await ciclo(c12h)])
  await tique(390); ok(await ciclo(c12h) === antes12h + 1, '16:30: pergunta nova há 30 min → reinicia', [antes12h, await ciclo(c12h)])
  const pNova = pushesDe('dono').filter(p => p.data.reparo_id === D(3)).pop()
  ok(pNova.title === '❓ 2 perguntas aguardam sua resposta', 'texto do reinício agrupa as 2 pendentes', pNova.title)
  // 8) 10 dias: 12h cai às 22:00 = silêncio → fica para 07:00
  await tique(719); ok(await ciclo(c10d) === 1, '21:59: 10d ainda no 1º ciclo')
  await tique(720); ok(await ciclo(c10d) === 1, '22:00: 10d devido mas em silêncio → não dispara')
  await tique(720 + 8 * 60 + 59); ok(await ciclo(c10d) === 1, '06:59: ainda em silêncio')
  await tique(720 + 9 * 60); ok(await ciclo(c10d) === 2, '07:00 do dia seguinte: 10d → 2º ciclo')
  ok((await emailsDono(c10d)).length === 2, 'dia novo → novo e-mail ao dono', await emailsDono(c10d))
  // 9) Recálculo pelo restante: 2d teve o 3º ciclo às 07:00 (restam 27h → 6h → 13:00), mas às 10:00
  //    restam 24h (faixa 6–24h → 2h): 07:00 + 2h = 09:00 já passou → dispara antes das 13:00.
  ok(await ciclo(c2d) === 3, '07:00: 2d → 3º ciclo (devido às 22:00, adiado)', await ciclo(c2d))
  await tique(1440 - 30); ok(await ciclo(c2d) === 3, '09:30: 2d restam 24h30 (faixa 6h) → ainda não', await ciclo(c2d))
  await tique(1440); ok(await ciclo(c2d) === 4, '10:00: 2d restam 24h (faixa 2h) → 4º ciclo: intervalo recalculado', await ciclo(c2d))
  // 10) Para: todas respondidas na de 10 dias (3º ciclo seria às 19:00)
  await db.query(`UPDATE perguntas_demanda SET respondido_em = now(), resposta = 'Sim' WHERE demanda_id = $1`, [D(c10d.n)])
  await tique(1440 + 9 * 60 + 30); ok(await ciclo(c10d) === 2, '19:30: 10d todas respondidas → parou', await ciclo(c10d))
  // 11) Para: match na de 2 dias; cancelada na de 12h
  const antes2d = await ciclo(c2d)
  await db.query(`UPDATE obras SET match_usuario_id = $2 WHERE id = $1`, [D(c2d.n), U(1)])
  await db.query(`UPDATE reparos SET status = 'cancelada' WHERE id = $1`, [D(c12h.n)])
  const antes12hB = await ciclo(c12h)
  await tique(1440 + 11 * 60); ok(await ciclo(c2d) === antes2d && await ciclo(c12h) === antes12hB, '21:00: 2d casada e 12h cancelada → pararam', [antes2d, await ciclo(c2d), antes12hB, await ciclo(c12h)])
  // 12) Pergunta nova na de 10 dias (todas respondidas até então) → reinicia 30 min depois
  await perguntar(c10d, U(4), 30)
  await tique(1440 + 11 * 60 + 1); ok(await ciclo(c10d) === 3, '21:01: 10d pergunta nova há 30 min → lembra de novo', await ciclo(c10d))
  ok(pushesDe('dono').filter(p => p.data.reparo_id === D(1)).pop().title === '❓ 1 pergunta aguarda sua resposta', 'reinício: só a nova pendente', pushesDe('dono').filter(p => p.data.reparo_id === D(1)).pop().title)

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
