#!/usr/bin/env node
// Testa repetirLembreteAgendar (alertaService) com o SQL REAL num Postgres em memória (PGlite):
// pool trocado por um shim, Expo e Brevo trocados por fakes que só coletam as mensagens,
// NOW() sombreado por public.now() para andar o relógio (hora de São Paulo).
// Cadência esperada: 1º ciclo 1h após o match; depois pelo tempo RESTANTE até o prazo,
// reavaliado a cada tique: > 3 d → 12h · 1–3 d → 6h · 6–24h → 2h · < 6h → 30 min.
//   npm i -D @electric-sql/pglite && node scripts/testar-agendar-repetido.js
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
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, criado_por uuid, status text, match_usuario_id uuid, match_feito_em timestamptz,
      expira_em timestamptz, criado_em timestamptz, chegada_prevista_em timestamptz, chegada_pendente_em timestamptz,
      chegada_declarada_em timestamptz, chegada_confirmada_em timestamptz, a_caminho_em timestamptz,
      lembrete_agendar_ultimo_em timestamptz, lembrete_agendar_ciclo int NOT NULL DEFAULT 0, lembrete_agendar_dono_em timestamptz,
      lembrete_agendar_enviados int NOT NULL DEFAULT 0`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text);
    CREATE TABLE reparos (${colsDemanda}, prazo_atendimento_horas numeric, prazo_modo text);
    CREATE TABLE obras (${colsDemanda}, horas_para_expirar numeric, publicado_em timestamptz);
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    SET search_path = public, pg_catalog;
  `)
  await db.query(`INSERT INTO usuarios VALUES ($1, 'Dono', 'dono@x.invalid', 'ExponentPushToken[dono]')`, [U(99)])
  await db.query(`INSERT INTO usuarios VALUES ($1, 'Prof', 'prof@x.invalid', 'ExponentPushToken[prof]')`, [U(1)])
  await fixarAgora(0)
  // Quatro demandas casadas às 09:00 SP (T0 − 1h), prazo = tempo restante contado de T0.
  const cenarios = [
    { n: 1, tabela: 'reparos', rotulo: '10 dias', restanteMin: 10 * 1440 },
    { n: 2, tabela: 'obras',   rotulo: '2 dias',  restanteMin: 2 * 1440 },
    { n: 3, tabela: 'reparos', rotulo: '12 horas', restanteMin: 12 * 60 },
    { n: 4, tabela: 'reparos', rotulo: '3 horas',  restanteMin: 3 * 60 },
  ]
  // A de 3h leva um título comprido: o push ao dono deve encurtá-lo, o e-mail leva inteiro.
  const TITULO_LONGO = 'Pintura completa do apartamento com três quartos, sala, cozinha, dois banheiros e área de serviço, incluindo massa corrida, lixamento, selador, duas demãos de tinta acrílica fosca e retoques nos rodapés e batentes das portas'
  for (const c of cenarios) {
    const extra = c.tabela === 'reparos' ? `, $5, NULL` : `, $5, now() - INTERVAL '2 hours'`
    await db.query(
      `INSERT INTO ${c.tabela} (id, titulo, criado_por, status, match_usuario_id, match_feito_em, expira_em, criado_em, ${c.tabela === 'reparos' ? 'prazo_atendimento_horas, prazo_modo' : 'horas_para_expirar, publicado_em'})
       VALUES ($1, $2, $3, 'aberta', $4, now() - INTERVAL '1 hour', now() + ($5 * INTERVAL '1 minute'), now() - INTERVAL '2 hours'${extra})`,
      [D(c.n), c.n === 4 ? TITULO_LONGO : `Demanda ${c.rotulo}`, U(99), U(1), c.restanteMin])
  }
  const A = require(path.join(REPO, 'src/services/alertaService'))
  const ciclo = async (c) => (await db.query(`SELECT lembrete_agendar_ciclo AS n FROM ${c.tabela} WHERE id = $1`, [D(c.n)])).rows[0].n
  const ciclos = async () => { const r = {}; for (const c of cenarios) r[c.rotulo] = await ciclo(c); return r }
  const tique = async (min) => { await fixarAgora(min); await A.repetirLembreteAgendar() }
  const [c10d, c2d, c12h, c3h] = cenarios
  const pushesDe = (token) => pushes.filter(p => p.to === `ExponentPushToken[${token}]`)
  const corpoLinha = (t) => `O profissional ainda não propôs dia e horário para "${t}". Já enviamos um lembrete a ele. Assim que ele propuser, você recebe um aviso para confirmar.`
  const emailsProf = async (c) => (await db.query(`SELECT tipo FROM email_alertas WHERE demanda_id = $1 AND usuario_id = $2 ORDER BY tipo`, [D(c.n), U(1)])).rows.map(r => r.tipo)

  // 1) 59 min após o match: nada
  await tique(-1)
  ok(Object.values(await ciclos()).every(n => n === 0) && pushes.length === 0, '09:59 (match + 59 min): nenhum ciclo', await ciclos())
  // 2) 1h após o match: 1º ciclo nas quatro, push + e-mail ao profissional, nada ao dono
  await tique(0)
  ok(Object.values(await ciclos()).every(n => n === 1), '10:00 (match + 1h): 1º ciclo nas 4 demandas', await ciclos())
  ok(pushesDe('prof').length === 4 && pushesDe('dono').length === 0, '1º ciclo: 4 pushes ao profissional, 0 ao dono', [pushesDe('prof').length, pushesDe('dono').length])
  ok(emails.length === 4 && emails.every(e => e.para === 'prof@x.invalid'), '1º ciclo: 1 e-mail por demanda ao profissional', emails.length)
  ok(pushesDe('prof')[0].title === '📅 Agende seu atendimento', 'título do push', pushesDe('prof')[0].title)
  // 3) 29 min depois: nada; 30 min: só a de 3h (< 6h → 30 min); dono avisado do 2º ciclo; e-mail do dia já enviado
  await tique(29)
  ok(JSON.stringify(await ciclos()) === JSON.stringify({ '10 dias': 1, '2 dias': 1, '12 horas': 1, '3 horas': 1 }), '10:29: nenhum ciclo novo', await ciclos())
  await tique(30)
  ok(await ciclo(c3h) === 2 && await ciclo(c12h) === 1, '10:30: 3h → 2º ciclo (30 min); 12h ainda no 1º', await ciclos())
  ok(pushesDe('dono').length === 1 && pushesDe('dono')[0].title === '⏳ Aguardando o horário do profissional', '2º ciclo: dono avisado', pushesDe('dono')[0]?.title)
  ok((await emailsProf(c3h)).length === 1 && emails.length === 5, 'profissional: 1 e-mail/dia por demanda (2º ciclo só push); dono recebeu o dele', [await emailsProf(c3h), emails.length])
  const pushDono = pushesDe('dono')[0]
  const emailDono = emails.find(e => e.para === 'dono@x.invalid')
  const CORPO_RE = /^O profissional ainda não propôs dia e horário para "(.+)"\. Já enviamos um lembrete a ele\. Assim que ele propuser, você recebe um aviso para confirmar\.$/
  ok(CORPO_RE.test(pushDono.body) && pushDono.body.length <= 240 && CORPO_RE.exec(pushDono.body)[1].endsWith('…') && TITULO_LONGO.startsWith(CORPO_RE.exec(pushDono.body)[1].slice(0, -1)),
    'push ao dono: texto novo, ≤ 240 caracteres, título encurtado com reticências', [pushDono.body.length, pushDono.body])
  ok(!/sugerir|sugira|propor|proponha/.test(pushDono.body), 'push ao dono não pede para ele sugerir horário')
  ok(emailDono && emailDono.assunto === '⏳ Aguardando o horário do profissional' && emailDono.texto.includes(corpoLinha(TITULO_LONGO)),
    'e-mail ao dono: assunto novo e título da demanda INTEIRO', emailDono?.texto)
  // 4) 12h: 2h de intervalo (6–24h restantes)
  await tique(119); ok(await ciclo(c12h) === 1, '11:59: 12h ainda no 1º ciclo')
  await tique(120); ok(await ciclo(c12h) === 2, '12:00: 12h → 2º ciclo (2h)')
  // 5) 2 dias: 6h (1–3 dias restantes)
  await tique(359); ok(await ciclo(c2d) === 1 && await ciclo(c10d) === 1, '15:59: 2d e 10d ainda no 1º ciclo', await ciclos())
  await tique(360); ok(await ciclo(c2d) === 2 && await ciclo(c10d) === 1, '16:00: 2d → 2º ciclo (6h); 10d não (12h)', await ciclos())
  // 6) 10 dias: 12h cai às 22:00 = silêncio → fica para 07:00
  await tique(719); ok(await ciclo(c10d) === 1, '21:59: 10d ainda no 1º ciclo')
  await tique(720); ok(await ciclo(c10d) === 1, '22:00: 10d devido mas em silêncio → não dispara')
  await tique(720 + 8 * 60 + 59); ok(await ciclo(c10d) === 1, '06:59: ainda em silêncio')
  await tique(720 + 9 * 60); ok(await ciclo(c10d) === 2, '07:00 do dia seguinte: 10d → 2º ciclo')
  ok((await emailsProf(c10d)).length === 2, 'dia novo → novo e-mail ao profissional', await emailsProf(c10d))
  // 7) Recálculo pelo restante: 2d teve o 3º ciclo às 07:00 (restam 27h → 6h → 13:00), mas às 10:00
  //    restam 24h (faixa 6–24h → 2h): 07:00 + 2h = 09:00 já passou → dispara antes das 13:00.
  ok(await ciclo(c2d) === 3, '07:00: 2d → 3º ciclo (devido às 22:00, adiado)', await ciclo(c2d))
  await tique(1440 - 30); ok(await ciclo(c2d) === 3, '09:30: 2d restam 24h30 (faixa 6h) → ainda não', await ciclo(c2d))
  await tique(1440); ok(await ciclo(c2d) === 4, '10:00: 2d restam 24h (faixa 2h) → 4º ciclo: intervalo recalculado', await ciclo(c2d))
  // 8) Para: horário proposto (chegada_pendente_em) na de 10 dias (3º ciclo seria às 19:00)
  await db.query(`UPDATE reparos SET chegada_pendente_em = now() + INTERVAL '1 day' WHERE id = $1`, [D(c10d.n)])
  await tique(1440 + 9 * 60 + 30); ok(await ciclo(c10d) === 2, '19:30: 10d com horário proposto → parou', await ciclo(c10d))

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
