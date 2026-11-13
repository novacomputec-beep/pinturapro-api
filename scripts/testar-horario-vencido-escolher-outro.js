#!/usr/bin/env node
// Duas regras pós-match (dono, 10/11/2026), obras e reparos:
//   (1) PROPOSTA DE HORÁRIO VENCIDA — o horário proposto pelo profissional passa sem resposta do
//       dono: o job expirarPropostasDeHorario limpa a proposta (volta a "aguardando horário"),
//       avisa o profissional por push + e-mail e os lembretes "Agende" recomeçam — o mesmo para a
//       contraproposta do dono que o profissional deixou vencer;
//   (2) ESCOLHER OUTRO — pode_escolher_outro (detalhe do dono) fica true com 2 lembretes "Agende"
//       seguidos sem proposta; POST /:tabela/dono/:id/escolher-outro desfaz o match (com falta desde 10/11),
//       reabre com candidaturas/interesses/perguntas intactos, bloqueia o profissional nesta
//       demanda e avisa "O cliente escolheu outro profissional"; 409 quando não pode.
// SQL REAL num Postgres em memória (PGlite); rotas reais de proposta de horário; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-horario-vencido-escolher-outro.js
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
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) } }
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
const { autenticar } = require(path.join(REPO, 'src/middlewares/auth'))
const A = require(path.join(REPO, 'src/services/alertaService'))
const S = require(path.join(REPO, 'src/services/desfazerEscolhaService'))
const { SQL_ZERAR_AGENDA } = require(path.join(REPO, 'src/utils/agendamento'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const T0 = Date.parse('2026-11-10T13:00:00Z') // 10:00 em São Paulo
const RealDate = Date
const emMin = (min) => new RealDate(T0 + min * 60000).toISOString()
let relogio = T0
global.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [relogio])) }
  static now() { return relogio }
}
const fixarAgora = (min) => { relogio = T0 + min * 60000; return db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${emMin(min)}'::timestamptz $$`) }
const assentar = () => new Promise(r => setTimeout(r, 150))
const iso = (v) => (v ? new RealDate(v).toISOString() : v)
const tok = (n) => `ExponentPushToken[${n}]`
const DONO = U(1), PROF = U(2), ANA = U(3), BETO = U(4), CAIO = U(5), OUTRO = U(6)
const rota = (metodo, caminho) => router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo]).route
const handlerDe = (metodo, caminho) => rota(metodo, caminho).stack[rota(metodo, caminho).stack.length - 1].handle
const chamar = (handler, usuarioId, id, body = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params: { id }, body, usuario: { id: usuarioId, role: usuarioId === DONO ? 'dono_obra' : 'prestador' } }, res)
})
const propor = async (tabela, id, dataHora, quem = PROF) => { silenciar(true); const r = await chamar(handlerDe('post', `/${tabela}/:id/chegada-prevista`), quem, id, { data_hora: dataHora }); await assentar(); silenciar(false); return r }
const escolherOutro = async (tabela, id, quem = DONO) => { pushes.length = 0; emails.length = 0; silenciar(true); const r = await chamar(S.handler(tabela, 'escolher_outro'), quem, id); await assentar(); silenciar(false); return r }
const job = async (fn) => { pushes.length = 0; emails.length = 0; silenciar(true); await fn(); await assentar(); silenciar(false) }
const linha = async (tabela, id) => (await db.query(`SELECT *, ${S.sqlPodeEscolherOutro()} AS pode FROM ${tabela} WHERE id = $1`, [id])).rows[0]
const pushesDe = (n) => pushes.filter(p => p.to === tok(n))

const main = async () => {
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, criado_por uuid, status text DEFAULT 'aberta', status_aprovacao text DEFAULT 'aprovada', encerrado_em timestamptz,
      match_usuario_id uuid, match_feito_em timestamptz, expira_em timestamptz, criado_em timestamptz DEFAULT now(),
      chegada_prevista_em timestamptz, chegada_pendente_em timestamptz, chegada_pendente_janela text, chegada_janela text,
      chegada_declarada_por uuid, chegada_declarada_em timestamptz, chegada_recusada_em timestamptz, chegada_confirmada_em timestamptz,
      a_caminho_em timestamptz, pedido_tempo_status text, pedido_tempo_motivo text, pedido_tempo_minutos int,
      aviso_match_enviado_em timestamptz, lembrete_chegada_enviado_em timestamptz,
      chegada_proposta_por uuid, chegada_pendente_rodada int DEFAULT 0, lembrete_agenda_vespera_em timestamptz, lembrete_agenda_2h_em timestamptz,
      lembrete_agenda_hora_em timestamptz, lembrete_agenda_dono_vespera_em timestamptz, lembrete_agenda_dono_2h_em timestamptz,
      vigia_comparecimento_em timestamptz, comparecimento_resposta text, comparecimento_respondido_em timestamptz,
      lembrete_agendar_offsets int[] NOT NULL DEFAULT '{}', lembrete_agendar_ultimo_em timestamptz, lembrete_agendar_dono_em timestamptz, lembrete_agendar_ciclo int DEFAULT 0,
      lembrete_agendar_enviados int NOT NULL DEFAULT 0, desfazer_aviso_em timestamptz, aviso_desinstalou_em timestamptz,
      lembrete_agendar_sem_proposta int NOT NULL DEFAULT 0, horario_vencido_em timestamptz, horarios_vencidos int NOT NULL DEFAULT 0,
      chegada_proposta_em timestamptz, lembrete_resposta_1h_em timestamptz, lembrete_resposta_antes_em timestamptz, lembrete_resposta_ultimo_em timestamptz, aviso_resposta_final_em timestamptz,
      sugestoes_horario_dono int DEFAULT 0, sugestoes_horario_profissional int DEFAULT 0, prazo_chegada_extra_em timestamptz, aviso_atraso_enviado_em timestamptz,
      pedido_atraso_minutos int, pedido_atraso_motivo text, pedido_atraso_em timestamptz, pedido_atraso_status text, pedido_atraso_respondido_em timestamptz,
      pedidos_atraso_usados int DEFAULT 0, cancelamento_pedido_por uuid, cancelamento_pedido_motivo text, cancelamento_pedido_detalhe text,
      cancelamento_pedido_em timestamptz, cancelamento_pedido_expira_em timestamptz, prestadores_bloqueados uuid[],
      prazo_atendimento_horas numeric, prazo_modo text, horas_para_expirar numeric, publicado_em timestamptz`
  const colsProposta = (fk) => `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${fk} uuid, usuario_id uuid, status text, status_antes_match text, cancelado_por uuid, cancelado_motivo text,
      cancelado_detalhe text, cancelado_em timestamptz, cancelado_acordo boolean DEFAULT false, criado_em timestamptz DEFAULT now()`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text, suspenso_em timestamptz, suspenso_motivo text, desinstalado_em timestamptz, role text, tipo_dono text, tipo_prestador text, cpf_cnpj text);
    CREATE TABLE reparos (${colsDemanda});
    CREATE TABLE obras (${colsDemanda});
    CREATE TABLE interesse_reparos (${colsProposta('reparo_id')});
    CREATE TABLE candidaturas (${colsProposta('obra_id')});
    CREATE TABLE perguntas_demanda (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tipo text, demanda_id uuid, autor_id uuid, pergunta text, resposta text, criado_em timestamptz DEFAULT now(), respondido_em timestamptz);
    CREATE TABLE faltas_profissional (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, tabela text, demanda_id uuid, motivo text, criado_em timestamptz DEFAULT now(), perdoada_em timestamptz, perdoada_por uuid);
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    SET search_path = public, pg_catalog;
  `)
  await db.exec(`CREATE TABLE IF NOT EXISTS assinaturas (usuario_id uuid, status text, tipo text, plano text, proximo_vencimento timestamptz, atualizado_em timestamptz)`)
  // Responsabilidade pós-match (eventos_responsabilidade, dias_credito_*, aviso_resposta_final_em) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/responsabilidade')).migrarResponsabilidade(db)

  // reparos.local_atendimento + usuarios.atende_* (utils/localAtendimento) — a mesma migração de boot.

  await db.exec('ALTER TABLE reparos ADD COLUMN IF NOT EXISTS categoria text; ALTER TABLE reparos ADD COLUMN IF NOT EXISTS categorias text[];') // colunas reais (reparos multi-categoria)
  await require(path.join(REPO, 'src/utils/localAtendimento')).migrarLocalAtendimento({ query: (s, p) => db.query(s, p) })
  // Aviso de reabertura (alertaService.avisarReabertura): aviso_reabertura_em, teto diário de push e bloqueios.
  await require(path.join(REPO, 'src/utils/reaberturaMatch')).migrarReaberturaMatch(db)
  await require(path.join(REPO, 'src/utils/avisosPorDistancia')).migrarAvisosPorDistancia(db)
  await db.exec(`CREATE TABLE IF NOT EXISTS avisos_fora_area (tabela text, demanda_id uuid, usuario_id uuid, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS push_entregas (primeira_tentativa_em timestamptz NOT NULL DEFAULT now(), tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, ultima_tentativa_em timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE IF NOT EXISTS prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid);`)
  await db.query(`INSERT INTO usuarios (id, nome, email, push_token, role, tipo_dono, tipo_prestador, cpf_cnpj) VALUES
    ($1, 'Maria', 'maria@x.invalid', $7, 'dono_obra', 'reparo', NULL, '111'), ($2, 'Alex Silva', 'alex@x.invalid', $8, 'prestador', NULL, 'reparador', '222'),
    ($3, 'Ana', 'ana@x.invalid', $9, 'prestador', NULL, 'reparador', '333'), ($4, 'Beto', 'beto@x.invalid', NULL, 'prestador', NULL, 'reparador', '444'),
    ($5, 'Caio', 'caio@x.invalid', $10, 'prestador', NULL, 'reparador', '555'), ($6, 'Outro', 'outro@x.invalid', $11, 'prestador', NULL, 'reparador', '666')`,
    [DONO, PROF, ANA, BETO, CAIO, OUTRO, tok('maria'), tok('alex'), tok('ana'), tok('caio'), tok('outro')])
  await fixarAgora(0)
  // Reparo com 5h de prazo (lembretes repetidos a cada 30 min quando restam < 6h); obra com 10 dias.
  const seed = async (tabela, n, titulo, prazoMin) => {
    const prop = tabela === 'obras' ? { t: 'candidaturas', fk: 'obra_id' } : { t: 'interesse_reparos', fk: 'reparo_id' }
    await db.query(`INSERT INTO ${tabela} (id, titulo, criado_por, match_usuario_id, match_feito_em, expira_em, prazo_atendimento_horas, horas_para_expirar) VALUES ($1, $2, $3, $4, now(), now() + ($5 * INTERVAL '1 minute'), $6, $6)`,
      [D(n), titulo, DONO, PROF, prazoMin, prazoMin / 60])
    await db.query(`INSERT INTO ${prop.t} (${prop.fk}, usuario_id, status, status_antes_match) VALUES
      ($1, $2, 'aceito', NULL), ($1, $3, 'recusado', 'pendente'), ($1, $4, 'recusado', 'contraproposta_dono'), ($1, $5, 'recusado', NULL)`, [D(n), PROF, ANA, BETO, CAIO])
    await db.query(`INSERT INTO perguntas_demanda (tipo, demanda_id, autor_id, pergunta, resposta, respondido_em) VALUES ($1, $2, $3, 'Tem material?', 'Tenho', now()), ($1, $2, $4, 'Qual o tamanho?', NULL, NULL)`,
      [tabela === 'obras' ? 'obra' : 'reparo', D(n), ANA, CAIO])
  }
  await seed('reparos', 1, 'Trocar chuveiro', 300)
  await seed('obras', 2, 'Pintura da sala', 10 * 1440)
  await seed('reparos', 3, 'Contraproposta do dono', 300)

  // ═══ 0. Rotas e expressão ══════════════════════════════════════════════════════════════════
  for (const tabela of ['obras', 'reparos']) {
    const r = rota('post', `/${tabela}/dono/:id/escolher-outro`)
    ok(r && r.stack.length === 2 && r.stack[0].handle === autenticar, `POST /${tabela}/dono/:id/escolher-outro registrada, só com autenticar`)
  }
  ok(S.LEMBRETES_PARA_ESCOLHER_OUTRO === 2 && S.MOTIVO_ESCOLHEU_OUTRO === 'escolheu_outro', 'constantes: 2 lembretes; motivo escolheu_outro')
  ok(/lembrete_agendar_sem_proposta = 0/.test(SQL_ZERAR_AGENDA) && /horarios_vencidos = 0/.test(SQL_ZERAR_AGENDA), 'SQL_ZERAR_AGENDA zera o contador e o registro de horários vencidos (match novo / un-match)')
  let l = await linha('reparos', D(1))
  ok(l.pode === false && l.lembrete_agendar_sem_proposta === 0, 'T0: pode_escolher_outro false (0 lembretes)')

  // ═══ 1. Dois lembretes "Agende" seguidos sem proposta → pode_escolher_outro ════════════════
  await fixarAgora(60); await job(A.repetirLembreteAgendar)
  l = await linha('reparos', D(1))
  ok(l.lembrete_agendar_sem_proposta === 1 && l.lembrete_agendar_enviados === 1 && l.pode === false && pushesDe('alex').filter(p => p.data?.reparo_id === D(1)).length === 1, '1h: 1º lembrete "Agende" → contador 1, ainda não pode', { sem_proposta: l.lembrete_agendar_sem_proposta })
  let r = await escolherOutro('reparos', D(1))
  ok(r.status === 409 && r.body.codigo === 'ESCOLHER_OUTRO_INDISPONIVEL' && r.body.lembretes_sem_proposta === 1 && r.body.necessarios === 2, 'escolher-outro com 1 lembrete: 409 ESCOLHER_OUTRO_INDISPONIVEL', r.body)
  await fixarAgora(90); await job(A.repetirLembreteAgendar)
  l = await linha('reparos', D(1))
  ok(l.lembrete_agendar_sem_proposta === 2 && l.pode === true, '1h30: 2º lembrete seguido → pode_escolher_outro TRUE', { sem_proposta: l.lembrete_agendar_sem_proposta, pode: l.pode })
  const lo = await linha('obras', D(2))
  ok(lo.lembrete_agendar_sem_proposta === 1 && lo.pode === false, 'obra de 10 dias: só 1 lembrete até aqui (cadência de 12h) → ainda não pode')

  // ═══ 2. Proposta do profissional zera o contador; vence sem resposta → volta a aguardar ════
  r = await propor('reparos', D(1), emMin(150)) // propõe 12:30 SP
  l = await linha('reparos', D(1))
  ok(r.status === 200 && iso(l.chegada_pendente_em) === emMin(150) && l.chegada_proposta_por === PROF && l.lembrete_agendar_sem_proposta === 0 && l.pode === false,
     'proposta de horário (rota real): pendente gravada, contador ZERADO, pode_escolher_outro false', { status: r.status, sem_proposta: l.lembrete_agendar_sem_proposta })
  r = await escolherOutro('reparos', D(1))
  ok(r.status === 409 && r.body.codigo === 'HORARIO_EM_NEGOCIACAO', 'com proposta pendente: 409 HORARIO_EM_NEGOCIACAO', r.body.codigo)
  await fixarAgora(149); await job(A.expirarPropostasDeHorario)
  l = await linha('reparos', D(1))
  ok(iso(l.chegada_pendente_em) === emMin(150) && pushes.length === 0, '12:29: proposta ainda não venceu — nada muda')
  // contraproposta do DONO pendente (outra demanda), já vencida: some do mesmo jeito
  await db.query(`UPDATE reparos SET chegada_pendente_em = $2, chegada_pendente_janela = 'agendado', chegada_proposta_por = $3, chegada_proposta_em = now() WHERE id = $1`, [D(3), emMin(100), DONO])
  await fixarAgora(151); await job(A.expirarPropostasDeHorario)
  l = await linha('reparos', D(1))
  ok(l.chegada_pendente_em === null && l.chegada_pendente_janela === null && l.chegada_proposta_por === null && l.chegada_proposta_em === null,
     '12:31: proposta VENCEU sem resposta → pendente limpa (volta a "aguardando horário")', { pendente: l.chegada_pendente_em })
  ok(iso(l.horario_vencido_em) === emMin(151) && l.horarios_vencidos === 1 && l.lembrete_resposta_1h_em === null && l.lembrete_resposta_ultimo_em === null,
     'registro do vencimento (horario_vencido_em, horarios_vencidos = 1); lembretes de resposta do dono zerados')
  ok(iso(l.lembrete_agendar_ultimo_em) === emMin(151) && igualArr(l.lembrete_agendar_offsets, []) && l.lembrete_agendar_sem_proposta === 0 && l.sugestoes_horario_profissional === 1,
     'lembretes "Agende" recomeçam (último = agora, fixos zerados); contador segue 0; a sugestão vencida continua contando no teto', { ultimo: iso(l.lembrete_agendar_ultimo_em), sugestoes: l.sugestoes_horario_profissional })
  const pa = pushesDe('alex').filter(p => p.data?.reparo_id === D(1) && !p.data?.compensacao) // o push de compensação (responsabilidade) sai à parte
  ok(pa.length === 1 && pa[0].title === A.TITULO_HORARIO_VENCIDO && pa[0].body === 'Proponha um novo horário para "Trocar chuveiro".' && pa[0].data.tipo === 'chegada_prevista_recusada' && pa[0].data.reparo_id === D(1) && pa[0].data.horario_vencido === true,
     'push ao profissional: "O horário que você propôs venceu sem resposta" + proponha um novo horário; toque abre o detalhe', pa[0] && { title: pa[0].title, body: pa[0].body, data: pa[0].data })
  ok(emails.some(e => e.para === 'alex@x.invalid' && e.assunto === A.TITULO_HORARIO_VENCIDO), 'e-mail ao profissional (push + e-mail)', emails.map(e => [e.para, e.assunto]))
  ok(pushesDe('maria').length === 0, 'o dono não é avisado do vencimento')
  const l3 = await linha('reparos', D(3))
  const pc = pushesDe('alex').filter(p => p.data?.reparo_id === D(3))
  ok(l3.chegada_pendente_em === null && l3.chegada_proposta_por === null && l3.horarios_vencidos === 1 && iso(l3.lembrete_agendar_ultimo_em) === emMin(151),
     'contraproposta do DONO vencida: limpa do mesmo jeito (aguardando horário, lembretes recomeçam)', { pendente: l3.chegada_pendente_em, vencidos: l3.horarios_vencidos })
  ok(pc.length === 1 && pc[0].title === A.TITULO_CONTRAPROPOSTA_VENCIDA && pc[0].body === 'Proponha um novo horário para "Contraproposta do dono".' && pc[0].data.contraproposta === true
     && emails.some(e => e.para === 'alex@x.invalid' && e.assunto === A.TITULO_CONTRAPROPOSTA_VENCIDA),
     'profissional avisado (push + e-mail) para propor um novo horário, com título próprio', pc[0] && { title: pc[0].title, body: pc[0].body })
  ok(pa[0].data.contraproposta === false, 'proposta do próprio profissional vencida: contraproposta = false no payload')
  await job(A.expirarPropostasDeHorario)
  l = await linha('reparos', D(1))
  ok(l.horarios_vencidos === 1 && pushes.length === 0, 'tique seguinte: nada a vencer (claim)')
  // os lembretes recomeçam de fato: +30 min → 1º da nova rodada; +60 → 2º → pode_escolher_outro de novo
  await fixarAgora(181); await job(A.repetirLembreteAgendar)
  l = await linha('reparos', D(1))
  ok(l.lembrete_agendar_sem_proposta === 1 && pushesDe('alex').filter(p => p.data?.reparo_id === D(1)).length === 1 && l.pode === false, '13:01: lembrete "Agende" volta a sair (1 sem proposta)', { sem_proposta: l.lembrete_agendar_sem_proposta })
  await fixarAgora(211); await job(A.repetirLembreteAgendar)
  l = await linha('reparos', D(1))
  ok(l.lembrete_agendar_sem_proposta === 2 && l.pode === true, '13:31: 2º lembrete seguido → pode_escolher_outro TRUE de novo')

  // ═══ 3. Escolher outro: sem falta, tudo intacto, profissional bloqueado e avisado ══════════
  ok((await escolherOutro('reparos', D(1), PROF)).status === 403 && (await escolherOutro('reparos', D(1), ANA)).status === 403, 'profissional ou terceiro: 403')
  ok((await chamar(S.handler('reparos', 'escolher_outro'), DONO, 'nao-e-uuid')).status === 404, 'id inválido: 404')
  r = await escolherOutro('reparos', D(1))
  l = await linha('reparos', D(1))
  ok(r.status === 200 && r.body.modo === 'escolher_outro' && r.body.profissional_id === PROF && r.body.interessados_avisados === 2, 'escolher-outro: 200 (2 interessados seguem valendo)', r.body)
  ok(l.match_usuario_id === null && l.status === 'aberta' && l.chegada_pendente_em === null && l.lembrete_agendar_sem_proposta === 0 && l.horarios_vencidos === 0 && l.lembrete_agendar_enviados === 0,
     'match desfeito, demanda aberta de novo, agenda e contadores zerados', { match: l.match_usuario_id, status: l.status })
  ok(Array.isArray(l.prestadores_bloqueados) && l.prestadores_bloqueados.includes(PROF), 'profissional bloqueado nesta demanda (prestadores_bloqueados)', l.prestadores_bloqueados)
  const props = Object.fromEntries((await db.query(`SELECT usuario_id, status, status_antes_match, cancelado_motivo, cancelado_por FROM interesse_reparos WHERE reparo_id = $1`, [D(1)])).rows.map(p => [p.usuario_id, p]))
  ok(props[PROF].status === 'cancelado' && props[PROF].cancelado_motivo === 'escolheu_outro' && props[PROF].cancelado_por === DONO, 'proposta do profissional: cancelado, motivo escolheu_outro (não se recandidata)', props[PROF])
  ok(props[ANA].status === 'pendente' && props[BETO].status === 'contraproposta_dono' && props[CAIO].status === 'recusado' && props[ANA].status_antes_match === null,
     'demais interesses INTACTOS: rebaixados pelo match voltam ao status que tinham; recusa explícita do dono fica', { ana: props[ANA].status, beto: props[BETO].status, caio: props[CAIO].status })
  const perguntas = (await db.query(`SELECT pergunta, resposta FROM perguntas_demanda WHERE demanda_id = $1 ORDER BY pergunta`, [D(1)])).rows
  ok(perguntas.length === 2 && perguntas.find(p => p.pergunta === 'Tem material?').resposta === 'Tenho', 'perguntas e respostas intactas', perguntas)
  ok((await db.query(`SELECT count(*)::int AS n FROM faltas_profissional WHERE usuario_id = $1 AND demanda_id = $2`, [PROF, D(1)])).rows[0].n === 1, '1 falta registrada (responsabilidade, 10/11/2026: escolher outro conta falta)')
  ok(pushesDe('alex').length === 1 && pushesDe('alex')[0].title === 'O cliente escolheu outro profissional' && pushesDe('alex')[0].data.reparo_id === D(1) && pushesDe('alex')[0].data.motivo === 'escolheu_outro',
     'push ao profissional: "O cliente escolheu outro profissional"', pushesDe('alex')[0] && { title: pushesDe('alex')[0].title, body: pushesDe('alex')[0].body })
  ok(pushesDe('ana').length === 0 && !emails.some(e => e.para === 'beto@x.invalid') && pushesDe('maria').length === 1 && /reaberto/i.test(pushesDe('maria')[0].title) && l.aviso_reabertura_em !== null,
     'dono avisado da reabertura; interessados nada direto (aviso de reabertura marcado para o cron)', { ana: pushesDe('ana').length, maria: pushesDe('maria').map(p => p.title) })
  await job(() => A.avisarReabertura('reparos'))
  const tituloR1 = (await db.query(`SELECT titulo FROM reparos WHERE id = $1`, [D(1)])).rows[0].titulo
  const pAnaR = pushesDe('ana')
  ok(pAnaR.length === 1 && pAnaR[0].title === '🔔 Pedido disponível de novo' && pAnaR[0].body === `"${tituloR1}" está aberto e sua proposta continua valendo — o cliente pode escolher você.`
     && JSON.stringify(pAnaR[0].data) === JSON.stringify({ tipo: 'novo_reparo', reaberta: true, reparo_id: D(1) })
     && emails.some(e => e.para === 'beto@x.invalid' && e.assunto === '🔔 Pedido disponível de novo') && !emails.some(e => e.para === 'caio@x.invalid' && e.assunto === '🔔 Pedido disponível de novo'),
     'cron de reabertura: Ana (push) e Beto (e-mail) recebem o aviso NEUTRO; Caio (recusado) não', pAnaR.map(p => [p.title, p.body]))
  ok(pushesDe('alex').length === 0 && !emails.some(e => e.para === 'alex@x.invalid' && e.assunto === '🔔 Pedido disponível de novo'), 'o profissional que perdeu o match não recebe o aviso de reabertura')
  ok((await escolherOutro('reparos', D(1))).body.codigo === 'SEM_MATCH', 'de novo sem match: 409 SEM_MATCH')
  // Novo escolhido: a demanda recomeça limpa para ele
  await db.query(`UPDATE reparos SET match_usuario_id = $2, match_feito_em = now(), ${SQL_ZERAR_AGENDA} WHERE id = $1`, [D(1), OUTRO])
  l = await linha('reparos', D(1))
  ok(l.pode === false && l.lembrete_agendar_sem_proposta === 0, 'novo profissional escolhido: contador zerado, pode_escolher_outro false')

  // ═══ 4. Obra: mesmo caminho; "desfazer" clássico continua com falta ════════════════════════
  await db.query(`UPDATE obras SET lembrete_agendar_sem_proposta = 2 WHERE id = $1`, [D(2)])
  r = await escolherOutro('obras', D(2))
  const lo2 = await linha('obras', D(2))
  const cand = Object.fromEntries((await db.query(`SELECT usuario_id, status, cancelado_motivo FROM candidaturas WHERE obra_id = $1`, [D(2)])).rows.map(p => [p.usuario_id, p]))
  ok(r.status === 200 && lo2.match_usuario_id === null && lo2.prestadores_bloqueados.includes(PROF) && cand[PROF].cancelado_motivo === 'escolheu_outro' && cand[ANA].status === 'pendente'
     && pushesDe('alex')[0]?.data.obra_id === D(2) && (await db.query(`SELECT count(*)::int AS n FROM faltas_profissional WHERE usuario_id = $1`, [PROF])).rows[0].n === 2,
     'obra: escolher-outro desfaz (com falta), bloqueia, restaura candidaturas, push com obra_id', { status: r.status })
  // o desfazer clássico (75% do prazo) segue registrando falta — não foi alterado
  await db.query(`UPDATE obras SET match_usuario_id = $2, match_feito_em = now() - INTERVAL '9 days', expira_em = now() + INTERVAL '1 day', prestadores_bloqueados = NULL, ${SQL_ZERAR_AGENDA} WHERE id = $1`, [D(2), OUTRO])
  await db.query(`UPDATE candidaturas SET status = 'aceito', cancelado_motivo = NULL, cancelado_por = NULL, cancelado_em = NULL WHERE obra_id = $1 AND usuario_id = $2`, [D(2), PROF])
  await db.query(`UPDATE candidaturas SET usuario_id = $3 WHERE obra_id = $1 AND usuario_id = $2`, [D(2), PROF, OUTRO])
  silenciar(true); r = await chamar(S.handler('obras'), DONO, D(2)); await assentar(); silenciar(false)
  // Trocar de profissional (13/11/2026): sem os 2 avisos ignorados (pode_escolher_outro false) não há falta.
  ok(r.status === 200 && r.body.modo === 'desfazer' && (await db.query(`SELECT count(*)::int AS n FROM faltas_profissional WHERE usuario_id = $1`, [OUTRO])).rows[0].n === 0, 'desfazer sem avisos ignorados: troca feita, SEM falta', { status: r.status, body: r.body })

  const inesperados = erros.filter(e => !/sem banco|PAGBANK|migration/i.test(e))
  ok(inesperados.length === 0, 'nenhum erro logado', inesperados.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
const igualArr = (a, b) => JSON.stringify(a || []) === JSON.stringify(b)
main().catch(e => { console.error = errOrig; console.error('ERRO', e); process.exit(1) })
