#!/usr/bin/env node
// Testa o resumo do dia ao admin (services/resumoDiaAdminService): às 18:00 (America/Sao_Paulo),
// 1x/dia (claim em configuracoes), push a cada conta do ADMIN_EMAIL com token + 1 e-mail com o
// link do painel (#canal), N = pedidos abertos da cidade do canal (utils/itensCanal, a mesma
// consulta de GET /admin/canal/resumo). SQL REAL num Postgres em memória (PGlite); Expo e Brevo
// trocados por fakes que só coletam; NOW() sombreado por public.now() para andar o relógio.
//   npm i -D @electric-sql/pglite && node scripts/testar-resumo-dia-admin.js
process.env.ADMIN_EMAIL = ' Admin@Teste.invalid '
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
const RealDate = Date
let relogio = Date.parse('2026-11-06T20:59:00Z') // 17:59 SP
global.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [relogio])) }
  static now() { return relogio }
}
const fixarAgora = (isoUtc) => {
  relogio = RealDate.parse(isoUtc)
  return db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${isoUtc}'::timestamptz $$`)
}
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const main = async () => {
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), titulo text, categoria text, bairro text, cidade text, uf text, status text DEFAULT 'aberta',
      status_aprovacao text DEFAULT 'aprovada', expira_em timestamptz, criado_em timestamptz DEFAULT now(), codigo_publico text, match_usuario_id uuid`
  await db.exec(`
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz DEFAULT now());
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text, role text);
    CREATE TABLE reparos (${colsDemanda}, categorias text[], valor_estimado numeric);
    CREATE TABLE obras (${colsDemanda}, valor numeric);
    SET search_path = public, pg_catalog;
  `)
  await fixarAgora('2026-11-06T20:59:00Z')
  // Admin: 2 contas no e-mail (uma sem token), outro usuário com token.
  await db.query(`INSERT INTO usuarios (id, nome, email, push_token, role) VALUES
    ($1, 'Admin', 'admin@teste.invalid', 'ExponentPushToken[admin1]', 'admin'),
    ($2, 'Admin app', 'ADMIN@teste.invalid', NULL, 'dono_obra'),
    ($3, 'Outro', 'outro@x.invalid', 'ExponentPushToken[outro]', 'prestador')`, [U(1), U(2), U(3)])
  // Patos de Minas: 2 serviços + 1 obra abertos SEM profissional; fora: 1 serviço vencido, 1 obra em outra
  // cidade, 1 serviço pendente de aprovação, 1 serviço e 1 obra com profissional escolhido, 1 cancelado.
  await db.query(`INSERT INTO reparos (titulo, categoria, categorias, bairro, cidade, uf, valor_estimado, expira_em, status_aprovacao, codigo_publico, match_usuario_id, status) VALUES
    ('Torneira', 'hidraulica', '{hidraulica}', 'Centro', 'Patos de Minas', 'MG', 100, now() + INTERVAL '2 days', 'aprovada', 'r1', NULL, 'aberta'),
    ('Tomada', 'eletrica', '{eletrica}', 'Lagoa', 'PATOS DE MINAS ', 'mg', 80, now() + INTERVAL '1 day', 'aprovada', 'r2', NULL, 'aberta'),
    ('Vencido', 'eletrica', '{eletrica}', 'Lagoa', 'Patos de Minas', 'MG', 80, now() - INTERVAL '1 hour', 'aprovada', 'r3', NULL, 'aberta'),
    ('Pendente', 'eletrica', '{eletrica}', 'Lagoa', 'Patos de Minas', 'MG', 80, now() + INTERVAL '1 day', 'pendente', 'r4', NULL, 'aberta'),
    ('Com match', 'eletrica', '{eletrica}', 'Lagoa', 'Patos de Minas', 'MG', 80, now() + INTERVAL '1 day', 'aprovada', 'r5', $1, 'aberta'),
    ('Cancelado', 'eletrica', '{eletrica}', 'Lagoa', 'Patos de Minas', 'MG', 80, now() + INTERVAL '1 day', 'aprovada', 'r6', NULL, 'cancelada')`, [U(3)])
  await db.query(`INSERT INTO obras (titulo, categoria, bairro, cidade, uf, valor, expira_em, codigo_publico, match_usuario_id) VALUES
    ('Casa', 'residencial', 'Centro', 'Patos de Minas', 'MG', 5000, now() + INTERVAL '10 days', 'o1', NULL),
    ('Galpão BH', 'galpao', 'Centro', 'Belo Horizonte', 'MG', 9000, now() + INTERVAL '10 days', 'o2', NULL),
    ('Casa com pintor', 'residencial', 'Centro', 'Patos de Minas', 'MG', 7000, now() + INTERVAL '10 days', 'o3', $1)`, [U(3)])

  const S = require(path.join(REPO, 'src/services/resumoDiaAdminService'))
  const { ADMIN_EMAIL, PAINEL_URL } = require(path.join(REPO, 'src/config/admin'))
  const { listarItensCanal } = require(path.join(REPO, 'src/utils/itensCanal'))
  const claim = async () => (await db.query(`SELECT valor FROM configuracoes WHERE chave = $1`, [S.CHAVE_RESUMO])).rows[0]?.valor || null

  ok(ADMIN_EMAIL === 'admin@teste.invalid' && S.LINK_CANAL === `${PAINEL_URL}/#canal`, 'ADMIN_EMAIL dobrado (lower/trim) e link = painel/#canal', { ADMIN_EMAIL, link: S.LINK_CANAL })
  const itens = await listarItensCanal({ cidade: 'patos de minas', uf: 'MG' })
  ok(itens.length === 3 && itens.map(i => i.codigo_publico).sort().join() === 'o1,r1,r2', 'itens do canal: 2 serviços + 1 obra abertos SEM profissional (vencido, pendente, cancelado, com match e outra cidade fora)', itens.map(i => i.codigo_publico))

  // 17:59 SP: nada
  let r = await S.enviarResumoDiaAdmin()
  ok(r === null && pushes.length === 0 && emails.length === 0 && await claim() === null, '17:59 SP: nada enviado, sem claim')

  // 18:00 SP: envia (1 push: só a conta do e-mail com token; 1 e-mail)
  await fixarAgora('2026-11-06T21:00:00Z')
  r = await S.enviarResumoDiaAdmin()
  ok(r && r.dia === '2026-11-06' && r.n === 3 && r.pushes === 1 && r.email === 'enviado', '18:00 SP: enviado com N = 3', r)
  ok(pushes.length === 1 && pushes[0].to === 'ExponentPushToken[admin1]' && pushes[0].title === 'Resumo do dia pronto (3 pedidos)' && pushes[0].data.tipo === 'resumo_dia_admin' && pushes[0].data.url === S.LINK_CANAL,
     'push à conta do admin com token (título e url do painel)', pushes[0] && { to: pushes[0].to, title: pushes[0].title, body: pushes[0].body, data: pushes[0].data })
  ok(emails.length === 1 && emails[0].para === 'admin@teste.invalid' && emails[0].assunto === '📋 Resumo do dia pronto (3 pedidos)' && emails[0].html.includes(`href="${S.LINK_CANAL}"`) && /3 pedidos abertos em Patos de Minas/.test(emails[0].texto),
     'e-mail ao ADMIN_EMAIL com o link da aba Canal do WhatsApp', emails[0] && { para: emails[0].para, assunto: emails[0].assunto })
  ok(await claim() === '2026-11-06', 'claim do dia gravado em configuracoes')

  // 18:05 e 23:30 do mesmo dia: não repete
  await fixarAgora('2026-11-06T21:05:00Z')
  r = await S.enviarResumoDiaAdmin()
  await fixarAgora('2026-11-07T02:30:00Z')
  const r2 = await S.enviarResumoDiaAdmin()
  ok(r === null && r2 === null && pushes.length === 1 && emails.length === 1, 'mesmo dia (18:05, 23:30 SP): não repete')

  // Dia seguinte antes das 18: nada; às 18:30 (deploy tardio): envia, com N atualizado e singular
  await fixarAgora('2026-11-07T19:00:00Z') // 16:00 SP
  r = await S.enviarResumoDiaAdmin()
  ok(r === null && pushes.length === 1, 'dia seguinte às 16:00 SP: nada')
  await db.query(`UPDATE reparos SET expira_em = now() - INTERVAL '1 minute' WHERE codigo_publico IN ('r1', 'r2')`)
  await fixarAgora('2026-11-07T21:30:00Z') // 18:30 SP
  r = await S.enviarResumoDiaAdmin()
  ok(r && r.dia === '2026-11-07' && r.n === 1 && pushes.length === 2 && pushes[1].title === 'Resumo do dia pronto (1 pedido)' && emails.length === 2 && /1 pedido aberto/.test(emails[1].texto),
     'dia seguinte às 18:30 SP (primeiro tique depois das 18): envia de novo, N = 1 no singular', r)
  ok(await claim() === '2026-11-07', 'claim avança para o novo dia')

  // Corrida entre réplicas: duas chamadas no mesmo instante do dia seguinte → só uma envia
  await fixarAgora('2026-11-08T21:00:00Z')
  const [a, b] = await Promise.all([S.reivindicarEnvioDoDia(), S.reivindicarEnvioDoDia()])
  ok([a, b].filter(Boolean).length === 1, 'claim atômico: de 2 réplicas no mesmo tique só 1 ganha o envio', [a, b])

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
