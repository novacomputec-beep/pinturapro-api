#!/usr/bin/env node
// Testa a falta "não marcou horário" nos cronômetros de expiração (alertaService
// verificarCronometroReparos / verificarCronometroObras) com o SQL REAL num Postgres em memória
// (PGlite), Expo/Brevo falsos que só coletam, faltas e suspensão de verdade.
// Regra: match que expira sem o profissional ter proposto horário NENHUMA vez → 1 falta única por
// demanda com motivo "não marcou horário" + push/e-mail "Você recebeu 1 falta" (o "Prazo expirado"
// vai só ao dono). Proposta dele sem resposta do dono → isento. Demanda cancelada → fora do cron.
// Horário valendo e não chegou → falta de não comparecimento (como sempre).
//   npm i -D @electric-sql/pglite && node scripts/testar-falta-sem-horario.js
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
const T0 = Date.parse('2026-11-05T13:00:00Z')
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
      notif_5min_enviada boolean DEFAULT false, marco_1_em timestamptz, marco_2_em timestamptz, marco_3_em timestamptz,
      escolha_aviso_24h_em timestamptz, escolha_aviso_2h_em timestamptz, escolha_expirou_em timestamptz,
      prazo_modo text, prazo_timezone text, prazo_atendimento_horas numeric, horas_para_expirar numeric,
      chegada_prevista_em timestamptz, chegada_pendente_em timestamptz, chegada_pendente_janela text, chegada_janela text,
      chegada_declarada_por uuid, chegada_declarada_em timestamptz, chegada_recusada_em timestamptz, chegada_confirmada_em timestamptz,
      a_caminho_em timestamptz, pedido_tempo_status text, pedido_tempo_motivo text, pedido_tempo_minutos int,
      aviso_match_enviado_em timestamptz, lembrete_chegada_enviado_em timestamptz, aviso_atraso_enviado_em timestamptz,
      chegada_proposta_por uuid, chegada_pendente_rodada int DEFAULT 0, lembrete_agenda_vespera_em timestamptz, lembrete_agenda_2h_em timestamptz,
      lembrete_agenda_hora_em timestamptz, lembrete_agenda_dono_vespera_em timestamptz, lembrete_agenda_dono_2h_em timestamptz,
      vigia_comparecimento_em timestamptz, comparecimento_resposta text, comparecimento_respondido_em timestamptz,
      lembrete_agendar_offsets int[] DEFAULT '{}', lembrete_agendar_ultimo_em timestamptz, lembrete_agendar_dono_em timestamptz,
      lembrete_agendar_enviados int DEFAULT 0, lembrete_agendar_sem_proposta int NOT NULL DEFAULT 0, horario_vencido_em timestamptz, horarios_vencidos int NOT NULL DEFAULT 0, desfazer_aviso_em timestamptz,
      chegada_proposta_em timestamptz, lembrete_resposta_1h_em timestamptz, lembrete_resposta_antes_em timestamptz, lembrete_resposta_ultimo_em timestamptz, aviso_resposta_final_em timestamptz,
      sugestoes_horario_dono int DEFAULT 0, sugestoes_horario_profissional int DEFAULT 0, prazo_chegada_extra_em timestamptz,
      pedido_atraso_minutos int, pedido_atraso_motivo text, pedido_atraso_em timestamptz, pedido_atraso_status text, pedido_atraso_respondido_em timestamptz,
      pedidos_atraso_usados int DEFAULT 0, prestadores_bloqueados uuid[]`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text, suspenso_em timestamptz, suspenso_motivo text, desinstalado_em timestamptz, role text, cpf_cnpj text);
    CREATE TABLE reparos (${colsDemanda});
    CREATE TABLE obras (${colsDemanda});
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, status text);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, status text);
    CREATE TABLE faltas_profissional (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, tabela text, demanda_id uuid, motivo text, criado_em timestamptz DEFAULT now(), perdoada_em timestamptz, perdoada_por uuid);
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    SET search_path = public, pg_catalog;
  `)
  await db.exec(`CREATE TABLE IF NOT EXISTS assinaturas (usuario_id uuid, status text, tipo text, plano text, proximo_vencimento timestamptz, atualizado_em timestamptz)`)
  // Responsabilidade pós-match (eventos_responsabilidade, dias_credito_*, aviso_resposta_final_em) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/responsabilidade')).migrarResponsabilidade(db)
  // Reabertura pelo cronômetro (aviso_reabertura_em, status_antes_match) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/reaberturaMatch')).migrarReaberturaMatch(db)
  await db.query(`INSERT INTO usuarios (id, nome, email, push_token) VALUES
    ($1, 'Dono', 'dono@x.invalid', 'ExponentPushToken[dono]'), ($2, 'Prof', 'prof@x.invalid', 'ExponentPushToken[prof]'), ($3, 'Outro Prof', 'outro@x.invalid', 'ExponentPushToken[outro]'),
    ($4, 'Concorrente', 'conc@x.invalid', 'ExponentPushToken[conc]'), ($5, 'Recusado', 'rec@x.invalid', 'ExponentPushToken[rec]')`,
    [U(99), U(1), U(2), U(3), U(4)])
  await fixarAgora(0)
  // Todas casadas há 10h e com prazo vencido há 20 min (tolerância de 15 min já passou).
  const inserir = (tabela, n, titulo, extra = '') => db.query(
    `INSERT INTO ${tabela} (id, titulo, criado_por, match_usuario_id, match_feito_em, expira_em, ${tabela === 'reparos' ? 'prazo_atendimento_horas' : 'horas_para_expirar'})
     VALUES ($1, $2, $3, $4, now() - INTERVAL '10 hours', now() - INTERVAL '20 minutes', 24)${extra ? '; ' + extra : ''}`.split(';')[0],
    [D(n), titulo, U(99), U(1)])
  const proposta = (tabela, n, usuario, status = 'aceito') =>
    db.query(`INSERT INTO ${tabela === 'reparos' ? 'interesse_reparos' : 'candidaturas'} (${tabela === 'reparos' ? 'reparo_id' : 'obra_id'}, usuario_id, status) VALUES ($1, $2, $3)`, [D(n), usuario, status])
  // R1 reparo: nunca propôs. O1 obra: propôs, dono calado. R2 reparo: DONO propôs, prof calado.
  // R3 reparo cancelado. O2 obra: horário valendo, não chegou. O3 obra: nunca propôs (3ª falta).
  await inserir('reparos', 1, 'R1 sem proposta');            await proposta('reparos', 1, U(1))
  await inserir('obras',   2, 'O1 prof propôs');             await proposta('obras', 2, U(1))
  await db.query(`UPDATE obras SET chegada_pendente_em = now() + INTERVAL '1 day', chegada_proposta_por = $2, chegada_proposta_em = now() - INTERVAL '2 hours' WHERE id = $1`, [D(2), U(1)])
  await inserir('reparos', 3, 'R2 dono propôs');             await proposta('reparos', 3, U(1))
  await db.query(`UPDATE reparos SET chegada_pendente_em = now() + INTERVAL '1 day', chegada_proposta_por = $2, chegada_proposta_em = now() - INTERVAL '2 hours' WHERE id = $1`, [D(3), U(99)])
  await inserir('reparos', 4, 'R3 cancelado');               await proposta('reparos', 4, U(1))
  await db.query(`UPDATE reparos SET status = 'cancelada' WHERE id = $1`, [D(4)])
  await inserir('obras',   5, 'O2 horário valendo');         await proposta('obras', 5, U(2))
  await db.query(`UPDATE obras SET match_usuario_id = $2, chegada_prevista_em = now() - INTERVAL '20 minutes', chegada_janela = 'manha' WHERE id = $1`, [D(5), U(2)])
  await inserir('obras',   6, 'O3 sem proposta');            await proposta('obras', 6, U(1))
  // Concorrentes: rebaixados PELO MATCH (status_antes_match preenchido, como rejeitarConcorrentes grava)
  // em R1, O3 e O2 (todos voltam a valer quando a demanda retorna ao feed — regra única de 11/11/2026);
  // 'Recusado' foi recusado explicitamente pelo dono em R1 (sem marcador → fica recusado).
  const rebaixado = (tabela, n, usuario, antes) =>
    db.query(`INSERT INTO ${tabela === 'reparos' ? 'interesse_reparos' : 'candidaturas'} (${tabela === 'reparos' ? 'reparo_id' : 'obra_id'}, usuario_id, status, status_antes_match) VALUES ($1, $2, 'recusado', $3)`, [D(n), usuario, antes])
  await rebaixado('reparos', 1, U(3), 'pendente')
  await rebaixado('reparos', 1, U(4), null)
  await rebaixado('obras', 6, U(3), 'contraproposta_dono')
  await rebaixado('obras', 5, U(3), 'pendente')

  const A = require(path.join(REPO, 'src/services/alertaService'))
  const eventos = async (u) => (await db.query(`SELECT tabela, demanda_id, motivo, outro_usuario_id FROM eventos_responsabilidade WHERE usuario_id = $1 AND tipo_evento = 'compromisso_nao_cumprido' ORDER BY tabela, demanda_id`, [u])).rows
  const statusProposta = async (tabela, n, u) => (await db.query(`SELECT status, status_antes_match FROM ${tabela === 'reparos' ? 'interesse_reparos' : 'candidaturas'} WHERE ${tabela === 'reparos' ? 'reparo_id' : 'obra_id'} = $1 AND usuario_id = $2`, [D(n), u])).rows[0]
  const faltas = async (u) => (await db.query(`SELECT tabela, demanda_id, motivo FROM faltas_profissional WHERE usuario_id = $1 ORDER BY criado_em, tabela, demanda_id`, [u])).rows
  const linha = async (t, n) => (await db.query(`SELECT * FROM ${t} WHERE id = $1`, [D(n)])).rows[0]
  const pushesDe = (token) => pushes.filter(p => p.to === `ExponentPushToken[${token}]`)
  const limpar = () => { pushes.length = 0; emails.length = 0 }

  // ---- regra pura
  ok(A.nuncaPropos({ match_usuario_id: U(1) }) === true, 'nuncaPropos: nada → true')
  ok(A.nuncaPropos({ match_usuario_id: U(1), chegada_pendente_em: 'x', chegada_proposta_por: U(1) }) === false, 'nuncaPropos: pendência dele → false')
  ok(A.nuncaPropos({ match_usuario_id: U(1), chegada_pendente_em: 'x', chegada_proposta_por: null }) === false, 'nuncaPropos: pendência legada (sem proposta_por = dele) → false')
  ok(A.nuncaPropos({ match_usuario_id: U(1), chegada_pendente_em: 'x', chegada_proposta_por: U(99) }) === true, 'nuncaPropos: pendência do DONO → true')
  ok(A.nuncaPropos({ match_usuario_id: U(1), chegada_recusada_em: 'x' }) === false && A.nuncaPropos({ match_usuario_id: U(1), chegada_prevista_em: 'x' }) === false && A.nuncaPropos({ match_usuario_id: U(1), a_caminho_em: 'x' }) === false,
     'nuncaPropos: janela recusada / horário valendo / a caminho → false')

  // ---- 1) cron de reparos
  await A.verificarCronometroReparos()
  let f = await faltas(U(1))
  ok(f.length === 2 && f.every(x => x.motivo === 'não marcou horário') && f.map(x => x.demanda_id).sort().join() === [D(1), D(3)].sort().join(),
     'R1 (nunca propôs) e R2 (dono propôs, prof calado): 1 falta cada, motivo "não marcou horário"', f)
  ok((await faltas(U(1))).every(x => x.demanda_id !== D(4)) && (await linha('reparos', 4)).match_usuario_id === U(1), 'R3 cancelado: cron não toca, sem falta', (await linha('reparos', 4)).status)
  let d = await linha('reparos', 1)
  ok(d.match_usuario_id === null && d.status === 'aberta' && new RealDate(d.expira_em) > new RealDate(relogio) && d.prestadores_bloqueados?.[0] === U(1), 'R1: match desfeito, de volta ao feed, profissional bloqueado nesta demanda', { expira: d.expira_em })
  ok((await statusProposta('reparos', 1, U(1))).status === 'expirado', "R1: interesse do profissional 'expirado'")
  const pProf = pushesDe('prof')
  const faltaR1 = pProf.find(p => p.data.reparo_id === D(1))
  ok(faltaR1 && faltaR1.title === 'Você recebeu 1 falta' && faltaR1.body === 'O prazo de "R1 sem proposta" venceu sem você marcar dia e horário. Com 3 faltas em 90 dias, a conta é suspensa.' && faltaR1.data.tipo === 'match_expirado',
     'R1: push "Você recebeu 1 falta" ao profissional (texto aprovado)', faltaR1 && { title: faltaR1.title, body: faltaR1.body })
  ok(!pProf.some(p => p.data.reparo_id === D(1) && p.title === '⏰ Prazo expirado!'), 'R1: profissional NÃO recebe o "Prazo expirado" genérico (um push por fato)')
  const donoR1 = pushesDe('dono').find(p => p.data.reparo_id === D(1))
  ok(donoR1 && donoR1.title === '⏰ O profissional não marcou horário' && donoR1.body === 'Escolha outro interessado ou defina uma nova data para "R1 sem proposta".' && donoR1.data.tipo === 'match_expirado',
     'R1: dono recebe "O profissional não marcou horário" (texto aprovado, tipo match_expirado)', donoR1 && { title: donoR1.title, body: donoR1.body })
  ok(!pushesDe('dono').some(p => p.data.reparo_id === D(1) && p.title === '⏰ Prazo expirado!'), 'R1: dono NÃO recebe mais o "Prazo expirado" genérico')
  ok(emails.some(e => e.para === 'dono@x.invalid' && e.assunto === '⏰ O profissional não marcou horário'), 'R1: e-mail ao dono com o mesmo título')
  // Evento compromisso_nao_cumprido (igual ao "escolher outro"): R1 e R2, motivo prazo_vencido_sem_horario, outro = dono.
  let ev = await eventos(U(1))
  ok(ev.length === 2 && ev.every(x => x.motivo === 'prazo_vencido_sem_horario' && x.outro_usuario_id === U(99) && x.tabela === 'reparos') && ev.map(x => x.demanda_id).sort().join() === [D(1), D(3)].sort().join(),
     'R1 e R2: evento compromisso_nao_cumprido gravado (motivo prazo_vencido_sem_horario, outro_usuario_id = dono)', ev)
  // Concorrentes de R1: rebaixado pelo match volta a 'pendente'; recusado explicitamente fica recusado.
  ok((await statusProposta('reparos', 1, U(3))).status === 'pendente' && (await statusProposta('reparos', 1, U(3))).status_antes_match === null, "R1: concorrente rebaixado PELO MATCH volta a 'pendente' (status_antes_match limpo)")
  ok((await statusProposta('reparos', 1, U(4))).status === 'recusado', 'R1: recusado explicitamente pelo dono continua recusado')
  const pConc = pushesDe('conc').find(p => p.data.reparo_id === D(1))
  ok(pConc && pConc.title === '🔄 Pedido disponível de novo' && pConc.body === 'A demanda "R1 sem proposta" voltou a ficar disponível — o cliente pode escolher você.' && pConc.data.tipo === 'novo_reparo' && pConc.data.reaberta === true,
     'R1: concorrente recebe push "disponível de novo" (texto aprovado, toque novo_reparo + reaberta)', pConc && { title: pConc.title, body: pConc.body, tipo: pConc.data.tipo })
  ok(emails.some(e => e.para === 'conc@x.invalid' && e.assunto === '🔄 Pedido disponível de novo'), 'R1: e-mail ao concorrente')
  ok(!pushesDe('rec').length, 'R1: quem o dono recusou explicitamente NÃO é avisado')
  ok((await linha('reparos', 1)).aviso_reabertura_em === null, 'R1: claim aviso_reabertura_em limpo após o aviso')
  const chavesConc = (await db.query(`SELECT tipo FROM email_alertas WHERE demanda_id = $1 AND usuario_id = $2`, [D(1), U(3)])).rows.map(x => x.tipo)
  ok(chavesConc.length === 1 && chavesConc[0].startsWith('aviso:novo_reparo#'), "R1: e-mail do concorrente na reserva crítica ('aviso:'), um por reabertura", chavesConc)
  ok(emails.some(e => e.para === 'prof@x.invalid' && e.assunto === 'Você recebeu 1 falta'), 'R1: e-mail "Você recebeu 1 falta" ao profissional', emails.map(e => [e.para, e.assunto]))
  const chaves = (await db.query(`SELECT tipo FROM email_alertas WHERE demanda_id = $1 AND usuario_id = $2`, [D(1), U(1)])).rows.map(x => x.tipo)
  ok(chaves.length === 1 && chaves[0].startsWith('aviso:match_expirado#'), "R1: e-mail na cota crítica ('aviso:')", chaves)
  ok(pProf.filter(p => p.title === 'Você recebeu 1 falta').length === 2, 'R2 também gera o aviso de falta', pProf.map(p => p.title))

  // idempotência: o mesmo profissional casado de novo na MESMA demanda e expirando de novo → sem 2ª falta nem 2º aviso
  limpar()
  await db.query(`UPDATE reparos SET match_usuario_id = $2, match_feito_em = now() - INTERVAL '5 hours', expira_em = now() - INTERVAL '20 minutes', prestadores_bloqueados = NULL WHERE id = $1`, [D(1), U(1)])
  await db.query(`UPDATE interesse_reparos SET status = 'aceito' WHERE reparo_id = $1`, [D(1)])
  await A.verificarCronometroReparos()
  ok((await faltas(U(1))).filter(x => x.demanda_id === D(1)).length === 1, 'idempotente: 2ª expiração da mesma demanda NÃO soma falta')
  ok((await eventos(U(1))).filter(x => x.demanda_id === D(1)).length === 1, 'idempotente: 2ª expiração NÃO soma evento compromisso_nao_cumprido')
  ok(!pushesDe('prof').some(p => p.title === 'Você recebeu 1 falta') && (await linha('reparos', 1)).match_usuario_id === null, 'idempotente: sem 2º aviso de falta; match desfeito mesmo assim')
  await A.verificarCronometroReparos()
  ok((await faltas(U(1))).length === 2, 'rodar o cron de novo sem candidatos: nada muda')

  // ---- 2) cron de obras — às 23:30 de São Paulo (silêncio noturno): o aviso de reabertura fica devido.
  limpar()
  await fixarAgora(13.5 * 60)
  await A.verificarCronometroObras()
  f = await faltas(U(1))
  ok(f.filter(x => x.demanda_id === D(2)).length === 0, 'O1 (prof propôs, dono calado): ISENTO, sem falta')
  ok((await eventos(U(1))).every(x => x.demanda_id !== D(2)), 'O1: isento também do evento compromisso_nao_cumprido')
  d = await linha('obras', 2)
  ok(d.match_usuario_id === null && (d.prestadores_bloqueados === null || d.prestadores_bloqueados.length === 0), 'O1: match desfeito sem bloqueio', d.prestadores_bloqueados)
  ok(pushesDe('prof').some(p => p.data.obra_id === D(2) && p.title === '⏰ Prazo expirado!') && !pushesDe('prof').some(p => p.data.obra_id === D(2) && p.title === 'Você recebeu 1 falta'), 'O1: profissional recebe só o "Prazo expirado" genérico')
  ok(pushesDe('dono').some(p => p.data.obra_id === D(2) && p.title === '⏰ Prazo expirado!'), 'O1: dono segue com "Prazo expirado" (o profissional tinha proposto horário)')
  ok(f.filter(x => x.demanda_id === D(6) && x.motivo === 'não marcou horário').length === 1, 'O3 (nunca propôs): falta "não marcou horário"')
  ok((await eventos(U(1))).some(x => x.demanda_id === D(6) && x.tabela === 'obras' && x.motivo === 'prazo_vencido_sem_horario'), 'O3: evento compromisso_nao_cumprido (obras)')
  ok(pushesDe('prof').some(p => p.data.obra_id === D(6) && p.title === 'Você recebeu 1 falta'), 'O3: aviso de falta')
  ok(pushesDe('dono').some(p => p.data.obra_id === D(6) && p.title === '⏰ O profissional não marcou horário'), 'O3: dono recebe "não marcou horário" (sem silêncio: é evento crítico)')
  ok((await statusProposta('obras', 6, U(3))).status === 'contraproposta_dono', "O3: concorrente volta a 'contraproposta_dono' (status que tinha antes do match)")
  ok(!pushesDe('conc').some(p => p.data.obra_id === D(6)) && (await linha('obras', 6)).aviso_reabertura_em !== null, 'O3 às 23:30 SP: aviso de reabertura ADIADO (claim devido, nenhum push ao concorrente)')
  // 11/11/2026 (B55RT): TODO un-match que devolve a demanda ao feed restaura os concorrentes rebaixados pelo match
  // (utils/reaberturaMatch) — inclusive com horário valendo. O aviso de reabertura segue só no 'sem horário'.
  ok((await statusProposta('obras', 5, U(3))).status === 'pendente' && (await linha('obras', 5)).aviso_reabertura_em === null, 'O2 (horário valendo, não chegou): concorrente É restaurado (regra única); sem o aviso de reabertura do "sem horário"')
  // 07:30 SP do dia seguinte: o tique do cron entrega o aviso adiado.
  await fixarAgora(21.5 * 60)
  await A.avisarReabertura('obras')
  const pConcO3 = pushesDe('conc').find(p => p.data.obra_id === D(6))
  ok(pConcO3 && pConcO3.title === '🔄 Pedido disponível de novo' && pConcO3.body === 'A demanda "O3 sem proposta" voltou a ficar disponível — o cliente pode escolher você.' && pConcO3.data.tipo === 'nova_obra',
     'O3 às 07:30 SP: concorrente avisado (toque nova_obra)', pConcO3 && { title: pConcO3.title, tipo: pConcO3.data.tipo })
  ok((await linha('obras', 6)).aviso_reabertura_em === null && emails.some(e => e.para === 'conc@x.invalid' && e.assunto === '🔄 Pedido disponível de novo'), 'O3: claim limpo + e-mail ao concorrente')
  await A.avisarReabertura('obras')
  ok(pushesDe('conc').filter(p => p.data.obra_id === D(6)).length === 1, 'O3: rodar de novo não repete o aviso')
  const f2 = await faltas(U(2))
  ok(f2.length === 1 && f2[0].demanda_id === D(5) && f2[0].motivo === null, 'O2 (horário valendo, não chegou): falta de não comparecimento (sem motivo), como sempre', f2)
  ok(pushesDe('outro').some(p => p.data.obra_id === D(5) && p.title === '⏰ Prazo expirado!') && !pushesDe('outro').some(p => p.title === 'Você recebeu 1 falta'), 'O2: aviso genérico, sem o de "não marcou horário"')
  // suspensão: Prof acumulou R1 + R2 + O3 = 3 faltas
  const u1 = (await db.query(`SELECT suspenso_em, suspenso_motivo FROM usuarios WHERE id = $1`, [U(1)])).rows[0]
  ok((await faltas(U(1))).length === 3 && u1.suspenso_em !== null, '3 faltas em 90 dias → suspenso (avaliarSuspensaoPorFaltas)', u1)
  ok(pushesDe('prof').some(p => p.data.tipo === 'conta_suspensa'), 'push "Conta suspensa"')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
