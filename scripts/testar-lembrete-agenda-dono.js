#!/usr/bin/env node
// Testa os lembretes do horário AGENDADO ao DONO (alertaService.lembrarAgendamento,
// LEMBRETES_AGENDA_DONO: véspera 18:00 SP e 2h antes) com o SQL REAL num Postgres em memória
// (PGlite) e Expo/Brevo falsos que só coletam. Mesma regra do profissional: janela de 60 min
// (slot passado não sai), claim por slot (sem repetição), nada para horário cancelado/remarcado,
// push + e-mail com a dedupe de lembrete (1 e-mail/dia por demanda × dono), sem o "hora de sair".
//   npm i -D @electric-sql/pglite && node scripts/testar-lembrete-agenda-dono.js
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
// T0 = 05/11/2026 10:00 em São Paulo (13:00Z). Horário agendado H = 06/11 14:00 SP (17:00Z).
// Véspera 18:00 SP = 05/11 21:00Z = T0+480 min. 2h antes = 06/11 15:00Z = T0+1560. Hora = T0+1680.
const T0 = Date.parse('2026-11-05T13:00:00Z')
const H = '2026-11-06T17:00:00Z'
const RealDate = Date
const emMin = (min) => new RealDate(T0 + min * 60000).toISOString()
let relogio = T0
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
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, criado_por uuid, status text DEFAULT 'aberta', status_aprovacao text DEFAULT 'aprovada',
      match_usuario_id uuid, match_feito_em timestamptz, expira_em timestamptz, criado_em timestamptz DEFAULT now(), publicado_em timestamptz,
      prazo_modo text, prazo_timezone text, prazo_atendimento_horas numeric, horas_para_expirar numeric,
      chegada_prevista_em timestamptz, chegada_pendente_em timestamptz, chegada_pendente_janela text, chegada_janela text,
      chegada_declarada_por uuid, chegada_declarada_em timestamptz, chegada_recusada_em timestamptz, chegada_confirmada_em timestamptz,
      a_caminho_em timestamptz, pedido_tempo_status text,
      aviso_match_enviado_em timestamptz, lembrete_chegada_enviado_em timestamptz, aviso_atraso_enviado_em timestamptz,
      chegada_proposta_por uuid, chegada_pendente_rodada int DEFAULT 0, lembrete_agenda_vespera_em timestamptz, lembrete_agenda_2h_em timestamptz,
      lembrete_agenda_hora_em timestamptz, lembrete_agenda_dono_vespera_em timestamptz, lembrete_agenda_dono_2h_em timestamptz,
      vigia_comparecimento_em timestamptz, comparecimento_resposta text, comparecimento_respondido_em timestamptz,
      lembrete_agendar_offsets int[] DEFAULT '{}', lembrete_agendar_ultimo_em timestamptz, lembrete_agendar_dono_em timestamptz,
      lembrete_agendar_enviados int DEFAULT 0, desfazer_aviso_em timestamptz,
      chegada_proposta_em timestamptz, lembrete_resposta_1h_em timestamptz, lembrete_resposta_antes_em timestamptz, lembrete_resposta_ultimo_em timestamptz,
      sugestoes_horario_dono int DEFAULT 0, sugestoes_horario_profissional int DEFAULT 0, prazo_chegada_extra_em timestamptz,
      pedido_atraso_minutos int, pedido_atraso_motivo text, pedido_atraso_em timestamptz, pedido_atraso_status text, pedido_atraso_respondido_em timestamptz,
      pedidos_atraso_usados int DEFAULT 0`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text, desinstalado_em timestamptz);
    CREATE TABLE reparos (${colsDemanda});
    CREATE TABLE obras (${colsDemanda});
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    SET search_path = public, pg_catalog;
  `)
  await db.query(`INSERT INTO usuarios (id, nome, email, push_token) VALUES
    ($1, 'Dona Maria', 'dona@x.invalid', 'ExponentPushToken[dona]'), ($2, 'João Silva Pintor', 'prof@x.invalid', 'ExponentPushToken[prof]'),
    ($3, 'Dono Sem Push', 'semPush@x.invalid', NULL)`, [U(99), U(1), U(98)])
  await fixarAgora(0)
  const inserir = (tabela, n, titulo, dono = U(99), prevista = H) => db.query(
    `INSERT INTO ${tabela} (id, titulo, criado_por, match_usuario_id, match_feito_em, expira_em, chegada_prevista_em, chegada_janela)
     VALUES ($1, $2, $3, $4, now() - INTERVAL '1 hour', $5, $5, 'agendado')`, [D(n), titulo, dono, U(1), prevista])
  // R1 reparo normal. O1 obra normal. R2 cancelado. O2 chegada já declarada. R3 dono sem push.
  // O3 obra: horário aceito TARDE (véspera já passou há mais de 60 min quando o cron roda).
  await inserir('reparos', 1, 'Trocar chuveiro')
  await inserir('obras', 2, 'Pintar sala')
  await inserir('reparos', 3, 'Cancelado');  await db.query(`UPDATE reparos SET status = 'cancelada' WHERE id = $1`, [D(3)])
  await inserir('obras', 4, 'Já chegou');    await db.query(`UPDATE obras SET chegada_declarada_em = now() WHERE id = $1`, [D(4)])
  await inserir('reparos', 5, 'Sem push', U(98))

  const A = require(path.join(REPO, 'src/services/alertaService'))
  const { SQL_ZERAR_AGENDA } = require(path.join(REPO, 'src/utils/agendamento'))
  const linha = async (t, n) => (await db.query(`SELECT * FROM ${t} WHERE id = $1`, [D(n)])).rows[0]
  const pushesDe = (token) => pushes.filter(p => p.to === `ExponentPushToken[${token}]`)
  const emailsDe = (para) => emails.filter(e => e.para === para)
  const limpar = () => { pushes.length = 0; emails.length = 0 }

  ok(A.LEMBRETES_AGENDA_DONO.length === 2 && A.LEMBRETES_AGENDA_DONO.map(l => l.coluna).join() === 'lembrete_agenda_dono_vespera_em,lembrete_agenda_dono_2h_em', 'dono: só véspera e 2h (sem "hora de sair")')

  // ---- antes da véspera: nada
  await fixarAgora(10); await A.lembrarAgendamento()
  ok(pushes.length === 0 && emails.length === 0, 'T0+10 min: nenhum lembrete (antes da véspera)')

  // ---- véspera 18:00 SP (+1 min)
  await fixarAgora(481); limpar(); await A.lembrarAgendamento()
  let pd = pushesDe('dona')
  const vR1 = pd.find(p => p.data.reparo_id === D(1))
  ok(vR1 && vR1.body === 'Amanhã às 14:00: João vai aí para "Trocar chuveiro". Esteja no local.' && vR1.title === '📅 Amanhã às 14:00: João vai aí' && vR1.data.tipo === 'chegada_prevista',
     'véspera: push ao dono do reparo (texto exato, primeiro nome do profissional)', vR1 && { title: vR1.title, body: vR1.body })
  const vO1 = pd.find(p => p.data.obra_id === D(2))
  ok(vO1 && vO1.body === 'Amanhã às 14:00: João vai aí para "Pintar sala". Esteja no local.', 'véspera: push ao dono da obra', vO1?.body)
  ok(pd.length === 2, 'véspera: exatamente 2 pushes à dona (R1 e O1)', pd.map(p => p.body))
  ok(!pd.some(p => p.data.reparo_id === D(3)) && !pd.some(p => p.data.obra_id === D(4)), 'cancelado e chegada já declarada: nada ao dono')
  const pp = pushesDe('prof')
  ok(pp.length === 3 && pp.every(p => p.title.startsWith('📅 Amanhã')), 'profissional continua recebendo a véspera dele (R1, O1, R3-sem-push)', pp.map(p => p.title))
  let ed = emailsDe('dona@x.invalid')
  ok(ed.length === 2 && ed.every(e => e.assunto.startsWith('📅 Amanhã às 14:00') && e.texto.includes('Esteja no local.')), 'véspera: e-mail à dona em R1 e O1 (1º lembrete do dia)', ed.map(e => e.assunto))
  const esp = emailsDe('semPush@x.invalid')
  ok(esp.length === 1 && esp[0].texto.includes('João vai aí para "Sem push"'), 'dono SEM push: só o e-mail', esp.map(e => e.assunto))
  let r1 = await linha('reparos', 1)
  ok(!!r1.lembrete_agenda_dono_vespera_em && !r1.lembrete_agenda_dono_2h_em && !!r1.lembrete_agenda_vespera_em, 'claim do dono gravado (véspera), 2h ainda nulo')

  // mesmo tique de novo: sem repetição
  limpar(); await A.lembrarAgendamento()
  ok(pushes.length === 0 && emails.length === 0, 'tique repetido: nada sai de novo (claim)')

  // ---- O3: horário aceito depois da véspera já ter passado (> 60 min) → véspera NÃO sai
  await inserir('obras', 6, 'Aceite tardio')
  await fixarAgora(545); limpar(); await A.lembrarAgendamento()
  ok(pushesDe('dona').length === 0 && (await linha('obras', 6)).lembrete_agenda_dono_vespera_em === null, 'O3: véspera devida há 65 min → pulada (janela de 60 min), claim nulo')

  // ---- remarcar: zerar agenda (match novo / remarcar) limpa os claims do dono
  await db.query(`UPDATE reparos SET ${SQL_ZERAR_AGENDA} WHERE id = $1`, [D(1)])
  r1 = await linha('reparos', 1)
  ok(r1.lembrete_agenda_dono_vespera_em === null && r1.lembrete_agenda_dono_2h_em === null, 'SQL_ZERAR_AGENDA zera os claims do dono')
  // Horário remarcado para 07/11 14:00: a véspera (06/11 18:00) e o 2h (07/11 12:00) são do horário NOVO.
  await db.query(`UPDATE reparos SET chegada_prevista_em = '2026-11-07T17:00:00Z', expira_em = '2026-11-07T17:00:00Z' WHERE id = $1`, [D(1)])

  // ---- 2h antes (06/11 12:00 SP)
  await fixarAgora(1561); limpar(); await A.lembrarAgendamento()
  pd = pushesDe('dona')
  const h2O1 = pd.find(p => p.data.obra_id === D(2))
  ok(h2O1 && h2O1.body === 'Daqui a 2 horas, às 14:00, João chega para "Pintar sala". Esteja no local.' && h2O1.title === '⏰ Em 2h, às 14:00: João chega', '2h: push ao dono da obra (texto exato)', h2O1 && { title: h2O1.title, body: h2O1.body })
  ok(pd.some(p => p.data.obra_id === D(6)), '2h: O3 (aceite tardio) recebe o 2h normalmente')
  ok(!pd.some(p => p.data.reparo_id === D(1)), '2h: R1 remarcado para 07/11 NÃO recebe o 2h do horário antigo')
  ed = emailsDe('dona@x.invalid')
  ok(ed.some(e => e.assunto === '⏰ Em 2h, às 14:00: João chega') && ed.length === 2, '2h: e-mail à dona (dia novo em SP → 1º do dia em cada demanda)', ed.map(e => e.assunto))

  // ---- hora: só o profissional
  await fixarAgora(1681); limpar(); await A.lembrarAgendamento()
  ok(pushesDe('dona').length === 0 && pushesDe('prof').some(p => p.title.startsWith('🚗 Hora de sair')), 'na hora: nada ao dono, "Hora de sair" ao profissional')

  // ---- R1 remarcado: véspera do horário novo (06/11 18:00 SP = T0+1920) sai com a data nova
  await fixarAgora(1921); limpar(); await A.lembrarAgendamento()
  const vR1b = pushesDe('dona').find(p => p.data.reparo_id === D(1))
  ok(vR1b && vR1b.body === 'Amanhã às 14:00: João vai aí para "Trocar chuveiro". Esteja no local.', 'R1 remarcado: véspera do horário NOVO sai (claim zerado)', vR1b?.body)
  limpar(); await A.lembrarAgendamento()
  ok(pushes.length === 0, 'R1 remarcado: sem repetição')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
