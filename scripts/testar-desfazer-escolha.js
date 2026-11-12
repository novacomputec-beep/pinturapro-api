#!/usr/bin/env node
// Testa "desfazer escolha" (services/desfazerEscolhaService): POST /:tabela/dono/:id/desfazer-match,
// a expressão desfazer_liberado_em de GET /:id, o aviso ao dono quando libera (avisarDesfazerLiberado)
// e os campos lembretes_agendar_enviados / proximo_lembrete_agendar_em (alertaService), com o SQL
// REAL num Postgres em memória (PGlite) e o alertaService REAL (Expo/Brevo falsos que só coletam;
// faltas e suspensão de verdade). NOW() sombreado por public.now() para andar o relógio.
// Regra (06/11/2026): libera quando resta ≤ 25% de (expira_em − match) = match + 75% do intervalo.
//   npm i -D @electric-sql/pglite && node scripts/testar-desfazer-escolha.js
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
// Gancho de corrida: roda ANTES de um statement que case com `antesDe` (uma vez), na mesma conexão.
let corrida = null
const query = async (sql, params) => {
  if (corrida && corrida.antesDe.test(sql)) { const c = corrida; corrida = null; await db.query(c.sql, c.params) }
  return db.query(sql, params)
}
const shim = {
  query,
  connect: async () => ({ query, release() {} }),
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
const T0 = Date.parse('2026-11-05T13:00:00Z') // match de todas as demandas (10:00 SP)
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
const chamar = (handler, usuario, params) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, body: {}, usuario }, res)
})
const assentar = () => new Promise(resolve => setTimeout(resolve, 150))
const iso = (v) => (v ? new RealDate(v).toISOString() : v)

const main = async () => {
  db = new PGlite()
  // Colunas de SQL_LIMPAR_MATCH + SQL_ZERAR_AGENDA + as lidas pelo serviço e pelos lembretes "Agende".
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, criado_por uuid, status text DEFAULT 'aberta', status_aprovacao text, encerrado_em timestamptz,
      match_usuario_id uuid, match_feito_em timestamptz, expira_em timestamptz, criado_em timestamptz DEFAULT now(),
      chegada_prevista_em timestamptz, chegada_pendente_em timestamptz, chegada_pendente_janela text, chegada_janela text,
      chegada_declarada_por uuid, chegada_declarada_em timestamptz, chegada_recusada_em timestamptz, chegada_confirmada_em timestamptz,
      a_caminho_em timestamptz, pedido_tempo_status text, pedido_tempo_motivo text, pedido_tempo_minutos int,
      aviso_match_enviado_em timestamptz, lembrete_chegada_enviado_em timestamptz,
      chegada_proposta_por uuid, chegada_pendente_rodada int DEFAULT 0, lembrete_agenda_vespera_em timestamptz, lembrete_agenda_2h_em timestamptz,
      lembrete_agenda_hora_em timestamptz, lembrete_agenda_dono_vespera_em timestamptz, lembrete_agenda_dono_2h_em timestamptz,
      vigia_comparecimento_em timestamptz, comparecimento_resposta text, comparecimento_respondido_em timestamptz,
      lembrete_agendar_offsets int[] NOT NULL DEFAULT '{}', lembrete_agendar_ultimo_em timestamptz, lembrete_agendar_dono_em timestamptz, lembrete_agendar_ciclo int DEFAULT 0,
      lembrete_agendar_enviados int NOT NULL DEFAULT 0, lembrete_agendar_sem_proposta int NOT NULL DEFAULT 0, horario_vencido_em timestamptz, horarios_vencidos int NOT NULL DEFAULT 0, desfazer_aviso_em timestamptz, aviso_desinstalou_em timestamptz,
      chegada_proposta_em timestamptz, lembrete_resposta_1h_em timestamptz, lembrete_resposta_antes_em timestamptz, lembrete_resposta_ultimo_em timestamptz, aviso_resposta_final_em timestamptz,
      sugestoes_horario_dono int DEFAULT 0, sugestoes_horario_profissional int DEFAULT 0, prazo_chegada_extra_em timestamptz, aviso_atraso_enviado_em timestamptz,
      pedido_atraso_minutos int, pedido_atraso_motivo text, pedido_atraso_em timestamptz, pedido_atraso_status text, pedido_atraso_respondido_em timestamptz,
      pedidos_atraso_usados int DEFAULT 0, cancelamento_pedido_por uuid, cancelamento_pedido_motivo text, cancelamento_pedido_detalhe text,
      cancelamento_pedido_em timestamptz, cancelamento_pedido_expira_em timestamptz, prestadores_bloqueados uuid[],
      prazo_atendimento_horas numeric, prazo_modo text, horas_para_expirar numeric, publicado_em timestamptz`
  const colsProposta = (fk) => `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${fk} uuid, usuario_id uuid, status text, status_antes_match text, cancelado_por uuid, cancelado_motivo text,
      cancelado_detalhe text, cancelado_em timestamptz, cancelado_acordo boolean DEFAULT false`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text, suspenso_em timestamptz, suspenso_motivo text, desinstalado_em timestamptz, role text, cpf_cnpj text);
    CREATE TABLE reparos (${colsDemanda});
    CREATE TABLE obras (${colsDemanda});
    CREATE TABLE interesse_reparos (${colsProposta('reparo_id')});
    CREATE TABLE candidaturas (${colsProposta('obra_id')});
    CREATE TABLE faltas_profissional (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, tabela text, demanda_id uuid, motivo text, criado_em timestamptz DEFAULT now(), perdoada_em timestamptz, perdoada_por uuid);
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    SET search_path = public, pg_catalog;
  `)
  await db.exec(`CREATE TABLE IF NOT EXISTS assinaturas (usuario_id uuid, status text, tipo text, plano text, proximo_vencimento timestamptz, atualizado_em timestamptz)`)
  // Responsabilidade pós-match (eventos_responsabilidade, dias_credito_*, aviso_resposta_final_em) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/responsabilidade')).migrarResponsabilidade(db)

  // reparos.local_atendimento + usuarios.atende_* (utils/localAtendimento) — a mesma migração de boot.

  await require(path.join(REPO, 'src/utils/localAtendimento')).migrarLocalAtendimento({ query: (s, p) => db.query(s, p) })
  // Aviso de reabertura (alertaService.avisarReabertura): aviso_reabertura_em, teto diário e bloqueios — as mesmas migrações de boot.
  await require(path.join(REPO, 'src/utils/reaberturaMatch')).migrarReaberturaMatch(db)
  await require(path.join(REPO, 'src/utils/avisosPorDistancia')).migrarAvisosPorDistancia(db)
  await db.exec(`CREATE TABLE IF NOT EXISTS avisos_fora_area (tabela text, demanda_id uuid, usuario_id uuid, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS push_entregas (primeira_tentativa_em timestamptz NOT NULL DEFAULT now(), tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, ultima_tentativa_em timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE IF NOT EXISTS prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid);`)
  // Dono com push; Prof (escolhido) com push; interessados: A com push, B só e-mail; C recusado pelo dono antes do match.
  await db.query(`INSERT INTO usuarios (id, nome, email, push_token) VALUES
    ($1, 'Dono', 'dono@x.invalid', 'ExponentPushToken[dono]'), ($2, 'Prof Silva', 'prof@x.invalid', 'ExponentPushToken[prof]'),
    ($3, 'Ana', 'ana@x.invalid', 'ExponentPushToken[ana]'), ($4, 'Beto', 'beto@x.invalid', NULL), ($5, 'Caio', 'caio@x.invalid', 'ExponentPushToken[caio]')`,
    [U(99), U(1), U(2), U(3), U(4)])
  await fixarAgora(0)
  // Demandas casadas em T0 com prazo contado de T0; libera em 75% do prazo: 10 dias → 7,5 d; 2h → 90 min;
  // 30 dias → 22,5 d; 40h → 30h.
  const cenarios = [
    { n: 1, tabela: 'reparos', proposta: 'interesse_reparos', fk: 'reparo_id', chave: 'reparo_id', rotulo: '10 dias', prazoMin: 10 * 1440, liberaMin: 7.5 * 1440 },
    { n: 2, tabela: 'obras',   proposta: 'candidaturas',      fk: 'obra_id',   chave: 'obra_id',   rotulo: '2 horas', prazoMin: 120,       liberaMin: 90 },
    { n: 3, tabela: 'obras',   proposta: 'candidaturas',      fk: 'obra_id',   chave: 'obra_id',   rotulo: '30 dias', prazoMin: 30 * 1440, liberaMin: 22.5 * 1440 },
    { n: 4, tabela: 'reparos', proposta: 'interesse_reparos', fk: 'reparo_id', chave: 'reparo_id', rotulo: '40 horas', prazoMin: 40 * 60,  liberaMin: 30 * 60 },
  ]
  for (const c of cenarios) {
    await db.query(`INSERT INTO ${c.tabela} (id, titulo, criado_por, match_usuario_id, match_feito_em, expira_em) VALUES ($1, $2, $3, $4, now(), now() + ($5 * INTERVAL '1 minute'))`,
      [D(c.n), `Demanda ${c.rotulo}`, U(99), U(1), c.prazoMin])
    // Prof aceito; Ana e Beto rebaixados pelo match (status_antes_match); Caio recusado pelo dono antes (sem marcador).
    await db.query(`INSERT INTO ${c.proposta} (${c.fk}, usuario_id, status, status_antes_match) VALUES
      ($1, $2, 'aceito', NULL), ($1, $3, 'recusado', 'pendente'), ($1, $4, 'recusado', 'contraproposta_dono'), ($1, $5, 'recusado', NULL)`,
      [D(c.n), U(1), U(2), U(3), U(4)])
  }
  const S = require(path.join(REPO, 'src/services/desfazerEscolhaService'))
  const A = require(path.join(REPO, 'src/services/alertaService'))
  const h = { reparos: S.handler('reparos'), obras: S.handler('obras') }
  const desfazer = (c, usuario = { id: U(99) }) => chamar(h[c.tabela], usuario, { id: D(c.n) })
  const liberadoEm = async (c) => (await db.query(`SELECT ${S.sqlDesfazerLiberadoEm()} AS l FROM ${c.tabela} WHERE id = $1`, [D(c.n)])).rows[0].l
  const prefixo = { reparos: 'reparos.', obras: 'o.' }
  const agendar = async (c) => (await db.query(
    `SELECT lembrete_agendar_enviados AS enviados, ${A.sqlProximoLembreteAgendar(c.tabela, prefixo[c.tabela])} AS proximo FROM ${c.tabela} ${c.tabela === 'obras' ? 'o' : ''} WHERE ${prefixo[c.tabela]}id = $1`, [D(c.n)])).rows[0]
  const linha = async (c) => (await db.query(`SELECT * FROM ${c.tabela} WHERE id = $1`, [D(c.n)])).rows[0]
  const propostas = async (c) => Object.fromEntries((await db.query(`SELECT usuario_id, status, status_antes_match, cancelado_motivo, cancelado_por FROM ${c.proposta} WHERE ${c.fk} = $1`, [D(c.n)])).rows.map(p => [p.usuario_id, p]))
  const pushesDe = (token) => pushes.filter(p => p.to === `ExponentPushToken[${token}]`)
  const faltas = async (u) => (await db.query(`SELECT tabela, demanda_id, motivo FROM faltas_profissional WHERE usuario_id = $1 ORDER BY criado_em`, [u])).rows
  const limparAvisos = async () => { pushes.length = 0; emails.length = 0; await db.query(`DELETE FROM email_alertas`) }
  const [c10d, c2h, c30d, c40h] = cenarios

  // 1) desfazer_liberado_em = match + 75% de (prazo − match)
  for (const c of cenarios) {
    const l = await liberadoEm(c)
    ok(l && iso(l) === emMin(c.liberaMin), `desfazer_liberado_em ${c.rotulo}: match + ${c.liberaMin / 60}h (75% do prazo)`, l)
  }
  // Prazo já vencido no match: libera na hora (espera ≤ 0).
  await db.query(`UPDATE obras SET expira_em = now() - INTERVAL '1 hour' WHERE id = $1`, [D(c30d.n)])
  ok(iso(await liberadoEm(c30d)) <= emMin(0), 'prazo vencido no match: desfazer_liberado_em ≤ match (libera na hora)')
  await db.query(`UPDATE obras SET expira_em = now() + ($2 * INTERVAL '1 minute') WHERE id = $1`, [D(c30d.n), c30d.prazoMin])

  // 2) guardas
  let r = await desfazer(c10d, { id: U(1) })
  ok(r.status === 403, 'profissional não pode desfazer: 403', r.body)
  r = await desfazer(c10d, { id: U(2) })
  ok(r.status === 403, 'terceiro não pode desfazer: 403', r.body)
  r = await chamar(h.reparos, { id: U(99) }, { id: 'nao-e-uuid' })
  ok(r.status === 404, 'id inválido: 404', r.body)
  r = await desfazer(c10d)
  ok(r.status === 409 && r.body.codigo === 'AGUARDE' && iso(r.body.liberado_em) === emMin(c10d.liberaMin) && /a partir de/.test(r.body.erro), 'cedo demais (T0): 409 AGUARDE com liberado_em', r.body)

  // 3) lembretes "Agende seu atendimento" deste match: contagem e próximo (campos de GET /:id)
  let ag = await agendar(c10d)
  ok(ag.enviados === 0 && iso(ag.proximo) === emMin(60), 'T0: 0 enviados; próximo = match + 1h (1º ciclo repetido)', ag)
  await fixarAgora(60)
  await A.repetirLembreteAgendar()
  ag = await agendar(c10d)
  // 10 dias: próximo ciclo = último + 12h = 23:00 SP (silêncio) → adiado às 07:00 do dia seguinte; fixo 'semana' (prazo − 1 dia) é depois.
  ok(ag.enviados === 1 && iso(ag.proximo) === emMin(1260), '10 dias às 1h: 1 enviado; próximo adiado do silêncio às 07:00 SP', { enviados: ag.enviados, proximo: iso(ag.proximo) })
  ag = await agendar(c2h)
  ok(ag.enviados === 1 && iso(ag.proximo) === emMin(90), '2 horas às 1h: 1 enviado; próximo = +30 min (restam < 6h)', { enviados: ag.enviados, proximo: iso(ag.proximo) })
  ok(pushesDe('prof').length === 4, '4 lembretes "Agende" ao profissional (1 por demanda)', pushesDe('prof').map(p => p.title))
  await limparAvisos()

  // 4) aviso ao dono quando libera (avisarDesfazerLiberado): 1x por match, só com prazo à frente
  await fixarAgora(89)
  r = await desfazer(c2h)
  ok(r.status === 409 && r.body.codigo === 'AGUARDE', '2 horas a 89 min: AGUARDE', r.body.codigo)
  await S.avisarDesfazerLiberado()
  ok(pushes.length === 0 && emails.length === 0, '89 min: nenhum aviso de liberação ainda')
  await fixarAgora(90)
  await S.avisarDesfazerLiberado()
  let pDono = pushesDe('dono')
  ok(pDono.length === 1 && pDono[0].title === S.TITULO_LIBERADO && pDono[0].body === 'Falta pouco e Prof ainda não marcou o horário de "Demanda 2 horas". Você já pode escolher outro profissional.'
     && pDono[0].data.tipo === 'chegada_prevista' && pDono[0].data.obra_id === D(c2h.n),
     '90 min: push ao dono (texto aprovado, primeiro nome, data.obra_id)', pDono[0] && { title: pDono[0].title, body: pDono[0].body, data: pDono[0].data })
  ok(emails.length === 1 && emails[0].para === 'dono@x.invalid' && emails[0].assunto === S.TITULO_LIBERADO && /Falta pouco e Prof/.test(emails[0].texto), 'e-mail ao dono (evento crítico: push + e-mail)', emails[0] && [emails[0].para, emails[0].assunto])
  ok((await linha(c2h)).desfazer_aviso_em !== null, 'claim desfazer_aviso_em gravado')
  await S.avisarDesfazerLiberado()
  ok(pushesDe('dono').length === 1, 'tique seguinte: não repete')
  r = await desfazer(c2h, { id: U(1) })
  ok(r.status === 403, '(o aviso não muda as guardas)')
  await limparAvisos()

  // 40 horas: fixo 'dia' (prazo − 2h) em T0+38h soma a contagem; próximo = fixo de 1h (antes do repetido adiado às 07:00)
  await fixarAgora(2280)
  await A.lembrarAgendarAtendimento()
  ag = await agendar(c40h)
  ok(ag.enviados === 2 && iso(ag.proximo) === emMin(2340), '40 horas às 38h: 2 enviados (repetido + fixo 2h); próximo = fixo 1h antes do prazo', { enviados: ag.enviados, proximo: iso(ag.proximo), offsets: (await linha(c40h)).lembrete_agendar_offsets })
  await S.avisarDesfazerLiberado()
  pDono = pushesDe('dono')
  ok(pDono.length === 1 && pDono[0].data.reparo_id === D(c40h.n) && /Demanda 40 horas/.test(pDono[0].body), '40 horas liberou às 30h: aviso ao dono (reparo_id); 10 dias ainda não', pDono.map(p => p.data))
  await limparAvisos()

  await fixarAgora(c10d.liberaMin - 1)
  r = await desfazer(c10d)
  ok(r.status === 409 && r.body.codigo === 'AGUARDE', '10 dias a 1 min de liberar: ainda AGUARDE', r.body.codigo)
  await fixarAgora(c10d.liberaMin)
  await S.avisarDesfazerLiberado()
  pDono = pushesDe('dono')
  ok(pDono.length === 1 && pDono[0].data.reparo_id === D(c10d.n), '7,5 dias: aviso só da demanda de 10 dias (2h e 40h já avisadas/vencidas; 30 dias ainda não)', pDono.map(p => p.data))
  await limparAvisos()

  // horário proposto / combinado / a caminho / sem match / fechada
  await db.query(`UPDATE reparos SET chegada_pendente_em = now() + INTERVAL '1 day' WHERE id = $1`, [D(c40h.n)])
  r = await desfazer(c40h)
  ok(r.status === 409 && r.body.codigo === 'HORARIO_EM_NEGOCIACAO' && await liberadoEm(c40h) === null && (await agendar(c40h)).proximo === null, 'horário proposto: 409 HORARIO_EM_NEGOCIACAO; desfazer_liberado_em e próximo lembrete null', r.body.codigo)
  await db.query(`UPDATE reparos SET chegada_pendente_em = NULL, chegada_prevista_em = now() + INTERVAL '1 day' WHERE id = $1`, [D(c40h.n)])
  r = await desfazer(c40h)
  ok(r.status === 409 && r.body.codigo === 'HORARIO_EM_NEGOCIACAO' && await liberadoEm(c40h) === null, 'horário combinado: 409 e null', r.body.codigo)
  await db.query(`UPDATE reparos SET chegada_prevista_em = NULL, a_caminho_em = now() WHERE id = $1`, [D(c40h.n)])
  r = await desfazer(c40h)
  ok(r.status === 409 && r.body.codigo === 'A_CAMINHO' && await liberadoEm(c40h) === null, 'a caminho: 409 A_CAMINHO e null', r.body.codigo)
  await db.query(`UPDATE reparos SET a_caminho_em = NULL, status = 'encerrada' WHERE id = $1`, [D(c40h.n)])
  r = await desfazer(c40h)
  ok(r.status === 409 && r.body.codigo === 'DEMANDA_FECHADA', 'encerrada: 409 DEMANDA_FECHADA', r.body.codigo)
  await db.query(`UPDATE reparos SET status = 'aberta', match_usuario_id = NULL WHERE id = $1`, [D(c40h.n)])
  r = await desfazer(c40h)
  ok(r.status === 409 && r.body.codigo === 'SEM_MATCH' && await liberadoEm(c40h) === null, 'sem match: 409 SEM_MATCH e null', r.body.codigo)
  ok((await faltas(U(1))).length === 0 && pushes.length === 0 && emails.length === 0, 'nenhuma guarda gerou falta, push ou e-mail')

  // 5) CORRIDA: o profissional propõe horário entre o SELECT FOR UPDATE e o UPDATE → aborta, nada muda
  corrida = { antesDe: /^\s*UPDATE reparos SET/, sql: `UPDATE reparos SET chegada_pendente_em = now() + INTERVAL '1 day', chegada_proposta_em = now() WHERE id = $1`, params: [D(c10d.n)] }
  r = await desfazer(c10d)
  let d = await linha(c10d)
  ok(r.status === 409 && r.body.codigo === 'ESTADO_MUDOU' && corrida === null, 'corrida (proposta no meio): 409 ESTADO_MUDOU', r.body)
  // (na PGlite a proposta injetada corre na MESMA conexão e cai junto no ROLLBACK; em produção
  // ela está commitada por outra conexão e a linha travada já a mostra ao SELECT FOR UPDATE.)
  ok(d.match_usuario_id === U(1) && (await propostas(c10d))[U(1)].status === 'aceito' && (await faltas(U(1))).length === 0 && pushes.length === 0,
     'corrida: match, proposta e faltas intactos, nenhum aviso (transação abortada)', { match: d.match_usuario_id })
  await db.query(`UPDATE reparos SET chegada_pendente_em = NULL, chegada_proposta_em = NULL WHERE id = $1`, [D(c10d.n)])

  // 6) desfaz de fato — reparo de 10 dias aos 7,5 dias
  r = await desfazer(c10d); await assentar()
  ok(r.status === 200 && r.body.profissional_id === U(1) && r.body.interessados_avisados === 2, '10 dias aos 7,5 d: 200, 2 interessados avisados', r.body)
  d = await linha(c10d)
  ok(d.match_usuario_id === null && d.match_feito_em === null && d.status === 'aberta' && d.a_caminho_em === null && d.lembrete_agendar_ultimo_em === null && d.lembrete_agendar_dono_em === null
     && d.lembrete_agendar_enviados === 0 && d.desfazer_aviso_em === null,
     'match/agenda zerados (lembretes "Agende" calados, contagem e claim do aviso zerados), demanda aberta no feed', { match: d.match_usuario_id, status: d.status, enviados: d.lembrete_agendar_enviados })
  ok(iso(d.expira_em) === emMin(10 * 1440), 'expira_em preservado (prazo que restava)', d.expira_em)
  ok(Array.isArray(d.prestadores_bloqueados) && d.prestadores_bloqueados.length === 1 && d.prestadores_bloqueados[0] === U(1), 'profissional em prestadores_bloqueados (some do feed desta demanda)', d.prestadores_bloqueados)
  let p = await propostas(c10d)
  ok(p[U(1)].status === 'cancelado' && p[U(1)].cancelado_motivo === 'escolha_desfeita' && p[U(1)].cancelado_por === U(99) && p[U(1)].status_antes_match === null,
     "proposta do profissional: 'cancelado' escolha_desfeita (linha fica → POST interesse responde 409; dono não aceita 'cancelado')", p[U(1)])
  ok(p[U(2)].status === 'pendente' && p[U(2)].status_antes_match === null && p[U(3)].status === 'contraproposta_dono' && p[U(3)].status_antes_match === null,
     'Ana e Beto voltam ao status de antes do match (pendente / contraproposta_dono)', { ana: p[U(2)].status, beto: p[U(3)].status })
  ok(p[U(4)].status === 'recusado', 'Caio (recusado pelo dono antes do match) continua recusado')
  ok(await liberadoEm(c10d) === null && (await agendar(c10d)).proximo === null, 'depois: desfazer_liberado_em e próximo lembrete null')
  // falta
  let f = await faltas(U(1))
  ok(f.length === 1 && f[0].tabela === 'reparos' && f[0].demanda_id === D(c10d.n) && f[0].motivo === 'não marcou horário', 'falta registrada com motivo "não marcou horário"', f)
  let u1 = (await db.query(`SELECT suspenso_em FROM usuarios WHERE id = $1`, [U(1)])).rows[0]
  ok(u1.suspenso_em === null, '1 falta: ainda não suspende')
  // avisos
  const pProf = pushesDe('prof')
  ok(pProf.length === 1 && pProf[0].title === 'Você saiu do serviço "Demanda 10 dias"' && /contou como 1 falta/.test(pProf[0].body) && pProf[0].data.tipo === 'interesse_recusado' && pProf[0].data.reparo_id === D(c10d.n),
     'push ao profissional (texto aprovado, tipo interesse_recusado)', pProf[0] && { title: pProf[0].title, body: pProf[0].body })
  ok(pushesDe('ana').length === 0 && !emails.some(e => e.para === 'ana@x.invalid' || e.para === 'beto@x.invalid'), 'interessados: nada direto do desfazer (o aviso é do cron de reabertura)')
  ok(d.aviso_reabertura_em !== null, 'aviso de reabertura marcado no un-match (aviso_reabertura_em)')
  ok(pushesDe('caio').length === 0, 'Caio (recusado) não é avisado')
  pDono = pushesDe('dono')
  ok(pDono.length === 1 && pDono[0].title === 'Pedido reaberto' && pDono[0].body === 'Avisamos os 2 interessados. Escolha o novo profissional quando quiser.' && pDono[0].data.reparo_id === D(c10d.n),
     'push ao dono (autor) com N = 2', pDono[0] && { title: pDono[0].title, body: pDono[0].body })
  // 7,5 dias depois de T0 (10:00 SP) = 22:00 SP: silêncio noturno → o aviso fica adiado, não descartado.
  await A.avisarReabertura('reparos')
  ok(pushesDe('ana').length === 0 && (await linha(c10d)).aviso_reabertura_em !== null, '22:00 SP (silêncio): aviso de reabertura adiado, marca mantida')
  await fixarAgora(c10d.liberaMin + 9 * 60) // 07:00 SP
  await A.avisarReabertura('reparos')
  const pAna = pushesDe('ana')
  ok(pAna.length === 1 && pAna[0].title === '🔔 Pedido disponível de novo'
     && pAna[0].body === '"Demanda 10 dias" está aberto e sua proposta continua valendo — o cliente pode escolher você.'
     && JSON.stringify(pAna[0].data) === JSON.stringify({ tipo: 'novo_reparo', reaberta: true, reparo_id: D(c10d.n) }),
     '07:00 SP: push NEUTRO à interessada Ana (texto aprovado, data { tipo, reaberta, reparo_id })', pAna[0] && { title: pAna[0].title, body: pAna[0].body, data: pAna[0].data })
  ok(pushesDe('prof').length === 1 && pushesDe('caio').length === 0 && !emails.some(e => e.para === 'caio@x.invalid'), 'profissional que perdeu o match e Caio (recusado) não recebem o aviso de reabertura')
  ok((await linha(c10d)).aviso_reabertura_em === null, 'claim do aviso de reabertura limpo')
  await fixarAgora(c10d.liberaMin)
  const paraDe = (e) => e.para
  ok(emails.filter(e => paraDe(e) === 'prof@x.invalid').length === 1 && emails.filter(e => paraDe(e) === 'ana@x.invalid').length === 1 && emails.filter(e => paraDe(e) === 'beto@x.invalid').length === 1 && emails.filter(e => paraDe(e) === 'dono@x.invalid').length === 1,
     'e-mail ao profissional, a Ana, a Beto (sem token) e ao dono', emails.map(e => [e.para, e.assunto]))
  const chaves = (await db.query(`SELECT tipo FROM email_alertas WHERE demanda_id = $1`, [D(c10d.n)])).rows.map(x => x.tipo)
  ok(chaves.length === 4 && chaves.every(k => k.startsWith('aviso:')), "e-mails na cota crítica ('aviso:')", chaves)
  r = await desfazer(c10d)
  ok(r.status === 409 && r.body.codigo === 'SEM_MATCH', 'repetir: 409 SEM_MATCH', r.body.codigo)

  // 7) obra de 2h aos 7,5 dias: prazo vencido → expira_em sobe ao piso NOW()+1h; 2ª falta
  pushes.length = 0; emails.length = 0
  r = await desfazer(c2h); await assentar()
  ok(r.status === 200, 'obra 2h (prazo vencido): 200', r.body)
  d = await linha(c2h)
  ok(iso(d.expira_em) === emMin(c10d.liberaMin + 60), 'prazo vencido → expira_em = agora + 1h (piso)', d.expira_em)
  p = await propostas(c2h)
  ok(p[U(1)].status === 'cancelado' && p[U(2)].status === 'pendente', "candidatura 'cancelado'; concorrente de volta a 'pendente'")
  ok(pushesDe('prof')[0]?.data.tipo === 'candidatura_recusada' && pushesDe('ana').length === 0 && pushesDe('dono')[0]?.data.obra_id === D(c2h.n) && d.aviso_reabertura_em !== null,
     'tipos de push do lado obra; interessada sem aviso direto (reabertura marcada para o cron)', pushes.map(x => x.data.tipo))
  ok((await faltas(U(1))).length === 2, '2ª falta registrada')

  // 8) 30 dias aos 22,5 dias: 3ª falta → suspensão (3 em 90 dias) + push "Conta suspensa"
  await fixarAgora(c30d.liberaMin - 1)
  r = await desfazer(c30d)
  ok(r.status === 409 && r.body.codigo === 'AGUARDE', '30 dias a 1 min de liberar: AGUARDE', r.body.codigo)
  await fixarAgora(c30d.liberaMin)
  pushes.length = 0
  r = await desfazer(c30d); await assentar()
  ok(r.status === 200, '30 dias aos 22,5 d → 200', r.body)
  ok((await faltas(U(1))).length === 3, '3ª falta')
  u1 = (await db.query(`SELECT suspenso_em, suspenso_motivo FROM usuarios WHERE id = $1`, [U(1)])).rows[0]
  ok(u1.suspenso_em !== null && /3 faltas/.test(u1.suspenso_motivo), '3 faltas em 90 dias → conta suspensa (mecanismo existente)', u1)
  ok(pushesDe('prof').some(x => x.data.tipo === 'conta_suspensa') && pushesDe('prof').some(x => /Você saiu/.test(x.title)), 'push "Conta suspensa" e "Você saiu" ao profissional', pushesDe('prof').map(x => x.title))

  // 9) cancelamentos frequentes: escolha_desfeita não conta (mesma consulta do serviço)
  const n = (await db.query(
    `SELECT (SELECT COUNT(*) FROM candidaturas WHERE cancelado_por = $1 AND cancelado_em > NOW() - ($2::int * INTERVAL '1 day') AND cancelado_motivo IS DISTINCT FROM 'escolha_desfeita')
          + (SELECT COUNT(*) FROM interesse_reparos WHERE cancelado_por = $1 AND cancelado_em > NOW() - ($2::int * INTERVAL '1 day') AND cancelado_motivo IS DISTINCT FROM 'escolha_desfeita') AS n`,
    [U(99), 90])).rows[0].n
  ok(Number(n) === 0, 'escolha_desfeita fora da contagem de cancelamentos frequentes do dono', n)

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
