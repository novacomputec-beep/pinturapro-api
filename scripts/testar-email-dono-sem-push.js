#!/usr/bin/env node
// Testa a regra de e-mail dos lembretes repetidos do DONO (alertaService.entregarLembrete com
// emailCadaCiclo): dono COM push ativo → 1 e-mail/dia por demanda; dono SEM push ativo (sem
// push_token ou com desinstalado_em) → e-mail a cada ciclo, até 6/dia por demanda × dono (SP),
// chaves 'aviso:lembrete#AAAAMMDD#k' (fora do teto dos e-mails de demanda nova). Depois roda os
// três crons de verdade (perguntas sem resposta, responda o horário, escolha pendente diário)
// com um dono sem token, num Postgres em memória (PGlite), com Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-email-dono-sem-push.js
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
const T0 = Date.parse('2026-11-05T13:00:00Z') // 10:00 São Paulo
const emMin = (min) => new RealDate(T0 + min * 60000).toISOString()
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
      match_feito_em timestamptz, expira_em timestamptz, criado_em timestamptz, publicado_em timestamptz,
      chegada_prevista_em timestamptz, chegada_pendente_em timestamptz, chegada_proposta_em timestamptz, chegada_proposta_por uuid,
      lembrete_resposta_ultimo_em timestamptz, lembrete_resposta_ciclo int NOT NULL DEFAULT 0,
      lembrete_perguntas_ultimo_em timestamptz, lembrete_perguntas_ciclo int NOT NULL DEFAULT 0,
      escolha_lembrete_em timestamptz, escolha_aviso_24h_em timestamptz, escolha_aviso_2h_em timestamptz, escolha_expirou_em timestamptz`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text, desinstalado_em timestamptz);
    CREATE TABLE reparos (${colsDemanda});
    CREATE TABLE obras (${colsDemanda});
    CREATE TABLE perguntas_demanda (id uuid PRIMARY KEY, tipo text, demanda_id uuid, autor_id uuid, pergunta text, resposta text,
      criado_em timestamptz DEFAULT now(), respondido_em timestamptz, UNIQUE (tipo, demanda_id, autor_id));
    CREATE TABLE interesse_reparos (reparo_id uuid, usuario_id uuid, status text, criado_em timestamptz);
    CREATE TABLE candidaturas (obra_id uuid, usuario_id uuid, status text, criado_em timestamptz);
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    SET search_path = public, pg_catalog;
  `)
  await fixarAgora(0)
  await db.query(`INSERT INTO usuarios VALUES ($1, 'Dono Com Push', 'com@x.invalid', 'ExponentPushToken[com]', NULL)`, [U(10)])
  await db.query(`INSERT INTO usuarios VALUES ($1, 'Dono Sem Token', 'sem@x.invalid', NULL, NULL)`, [U(11)])
  await db.query(`INSERT INTO usuarios VALUES ($1, 'Dono Desinstalado', 'des@x.invalid', 'ExponentPushToken[des]', now() - INTERVAL '1 day')`, [U(12)])
  await db.query(`INSERT INTO usuarios VALUES ($1, 'Prof', 'prof@x.invalid', 'ExponentPushToken[prof]', NULL)`, [U(1)])
  const A = require(path.join(REPO, 'src/services/alertaService'))
  const E = require(path.join(REPO, 'src/services/escolhaPendenteService'))
  const dono = async (n) => (await db.query(`SELECT id, push_token, desinstalado_em, email, nome FROM usuarios WHERE id = $1`, [U(n)])).rows[0]
  const chaves = async (dId, uId) => (await db.query(`SELECT tipo FROM email_alertas WHERE demanda_id = $1 AND usuario_id = $2 ORDER BY tipo`, [dId, uId])).rows.map(r => r.tipo)
  const lembrar = (u, dId, chave = 'reparo_id') => A.entregarLembrete({
    usuario_id: u.id, push_token: u.push_token, email: u.email, nome: u.nome, emailCadaCiclo: A.semPushAtivo(u),
    titulo: 'Lembrete', corpo: 'x', data: { tipo: 'nova_pergunta', [chave]: dId }, rotulo: 'teste',
  })
  const emailsPara = (e) => emails.filter(m => m.para === e).length

  ok(A.LEMBRETE_EMAIL_SEM_PUSH_TETO_DIA === 6, 'teto diário sem push = 6')
  ok(A.semPushAtivo(await dono(10)) === false && A.semPushAtivo(await dono(11)) === true && A.semPushAtivo(await dono(12)) === true, 'semPushAtivo: token ativo → false; sem token → true; desinstalado → true')

  // A) Dono COM push ativo: 3 ciclos no dia → 3 pushes, 1 e-mail
  const vias = []
  for (let i = 0; i < 3; i++) vias.push(await lembrar(await dono(10), D(1)))
  ok(pushes.filter(p => p.to === 'ExponentPushToken[com]').length === 3 && emailsPara('com@x.invalid') === 1, 'com push: 3 pushes, 1 e-mail no dia', [pushes.length, emailsPara('com@x.invalid')])
  ok(JSON.stringify(vias) === JSON.stringify(['push+e-mail', 'push+e-mail já enviado', 'push+e-mail já enviado']), 'vias com push', vias)
  ok(JSON.stringify(await chaves(D(1), U(10))) === JSON.stringify(['aviso:lembrete#20261105']), 'chave diária simples', await chaves(D(1), U(10)))

  // B) Dono SEM token: 8 ciclos no dia → 6 e-mails, 7º e 8º barrados pelo teto; nenhum push
  const viasSem = []
  for (let i = 0; i < 8; i++) viasSem.push(await lembrar(await dono(11), D(2)))
  ok(emailsPara('sem@x.invalid') === 6, 'sem token: 8 ciclos → 6 e-mails (teto)', emailsPara('sem@x.invalid'))
  ok(viasSem.slice(0, 6).every(v => v === 'e-mail') && viasSem[6] === 'e-mail teto do dia' && viasSem[7] === 'e-mail teto do dia', 'vias sem token', viasSem)
  ok(JSON.stringify(await chaves(D(2), U(11))) === JSON.stringify([1, 2, 3, 4, 5, 6].map(k => `aviso:lembrete#20261105#${k}`)), 'chaves numeradas 1..6', await chaves(D(2), U(11)))
  ok(pushes.filter(p => p.to !== 'ExponentPushToken[com]').length === 0, 'sem token: nenhum push')
  // Outra demanda do mesmo dono no mesmo dia: teto é por demanda
  ok(await lembrar(await dono(11), D(3)) === 'e-mail', 'teto por demanda: outra demanda sai')

  // C) Dono DESINSTALADO (token presente, desinstalado_em marcado): e-mail a cada ciclo
  const viasDes = []
  for (let i = 0; i < 3; i++) viasDes.push(await lembrar(await dono(12), D(4)))
  ok(emailsPara('des@x.invalid') === 3 && viasDes.every(v => v === 'push+e-mail'), 'desinstalado: e-mail em cada um dos 3 ciclos (push ainda tentado)', viasDes)

  // D) Dia começou com push (chave simples) e o token caiu: a simples conta no teto → só mais 5
  await db.query(`UPDATE usuarios SET push_token = NULL WHERE id = $1`, [U(10)])
  const viasD = []
  for (let i = 0; i < 6; i++) viasD.push(await lembrar(await dono(10), D(1)))
  ok(emailsPara('com@x.invalid') === 6 && viasD[4] === 'e-mail' && viasD[5] === 'e-mail teto do dia', 'token caiu: chave simples + 5 numeradas = 6', [emailsPara('com@x.invalid'), viasD])

  // E) Dia seguinte (SP): teto zera
  await fixarAgora(24 * 60)
  ok(await lembrar(await dono(11), D(2)) === 'e-mail' && (await chaves(D(2), U(11))).includes('aviso:lembrete#20261106#1'), 'dia novo: contagem recomeça (#1 do dia)', await chaves(D(2), U(11)))

  // F) Cota: tudo 'aviso:%' → fora do teto dos e-mails de demanda nova (reivindicarEmailsNovaDemanda conta NOT LIKE 'aviso:%')
  const fora = await db.query(`SELECT count(*)::int AS n FROM email_alertas WHERE tipo NOT LIKE 'aviso:%'`)
  const total = await db.query(`SELECT count(*)::int AS n FROM email_alertas`)
  ok(fora.rows[0].n === 0 && total.rows[0].n === emails.length, 'todas as chaves são aviso:% (reserva dos críticos), nenhuma no teto de demanda', [fora.rows[0].n, total.rows[0].n, emails.length])

  // G) Crons reais com dono SEM token (U11), de volta ao dia 1 às 10:00 SP
  await fixarAgora(0)
  await db.query(`DELETE FROM email_alertas`); emails.length = 0; pushes.length = 0
  // G1) perguntas sem resposta, reparo com 3h restantes (ciclo a cada 30 min): pergunta há 30 min
  await db.query(`INSERT INTO reparos (id, titulo, criado_por, status, status_aprovacao, expira_em, criado_em)
                  VALUES ($1, 'Pia', $2, 'aberta', 'aprovada', now() + INTERVAL '3 hours', now() - INTERVAL '2 hours')`, [D(20), U(11)])
  await db.query(`INSERT INTO perguntas_demanda (id, tipo, demanda_id, autor_id, pergunta, criado_em) VALUES ($1, 'reparo', $2, $3, 'Faz hoje?', now() - INTERVAL '30 minutes')`, [D(90), D(20), U(1)])
  for (let m = 0; m <= 150; m += 30) { await fixarAgora(m); await A.lembrarPerguntasSemResposta() }
  const cicloP = (await db.query(`SELECT lembrete_perguntas_ciclo AS n FROM reparos WHERE id = $1`, [D(20)])).rows[0].n
  ok(cicloP === 6 && emailsPara('sem@x.invalid') === 6, 'perguntas sem resposta: 6 ciclos (10:00–12:30) → 6 e-mails ao dono sem token', [cicloP, emailsPara('sem@x.invalid')])
  ok(emails.every(m => m.assunto === '❓ 1 pergunta aguarda sua resposta'), 'assunto do e-mail = título do push', emails[0]?.assunto)
  // G2) responda o horário (proposta do profissional há 30 min, horário em 12h) na mesma demanda: 7º e-mail do dia → teto
  await fixarAgora(180)
  await db.query(`UPDATE reparos SET match_usuario_id = $2, match_feito_em = now() - INTERVAL '1 hour', expira_em = now() + INTERVAL '2 days',
                    chegada_pendente_em = now() + INTERVAL '12 hours', chegada_proposta_em = now() - INTERVAL '30 minutes', chegada_proposta_por = $2 WHERE id = $1`, [D(20), U(1)])
  await A.repetirRespostaHorarioDono()
  const cicloR = (await db.query(`SELECT lembrete_resposta_ciclo AS n FROM reparos WHERE id = $1`, [D(20)])).rows[0].n
  ok(cicloR === 1 && emailsPara('sem@x.invalid') === 6, 'responda o horário: ciclo rodou, e-mail barrado pelo teto da demanda (6 já hoje)', [cicloR, emailsPara('sem@x.invalid')])
  // G3) escolha pendente diário, outra demanda do mesmo dono (2 interessados há 7h, prazo em 5 dias)
  await db.query(`INSERT INTO reparos (id, titulo, criado_por, status, status_aprovacao, expira_em, criado_em)
                  VALUES ($1, 'Muro', $2, 'aberta', 'aprovada', now() + INTERVAL '5 days', now() - INTERVAL '8 hours')`, [D(21), U(11)])
  await db.query(`INSERT INTO interesse_reparos VALUES ($1, $2, 'pendente', now() - INTERVAL '7 hours'), ($1, $3, 'pendente', now() - INTERVAL '6 hours')`, [D(21), U(1), U(10)])
  await E.verificarEscolhaPendente()
  const ch21 = await chaves(D(21), U(11))
  ok(emailsPara('sem@x.invalid') === 7 && JSON.stringify(ch21) === JSON.stringify(['aviso:lembrete#20261105#1']), 'escolha pendente diário: e-mail com chave numerada (#1 nesta demanda)', [emailsPara('sem@x.invalid'), ch21])
  ok(emails[emails.length - 1].assunto === '👥 2 profissionais aguardam sua escolha', 'assunto do diário', emails[emails.length - 1].assunto)
  await E.verificarEscolhaPendente()
  ok(emailsPara('sem@x.invalid') === 7, 'diário: segundo tique no mesmo dia não repete (claim diário da demanda)')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
