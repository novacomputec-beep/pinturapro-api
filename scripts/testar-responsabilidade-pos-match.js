#!/usr/bin/env node
// Responsabilidade pós-match (dono, 10/11/2026), obras e reparos, por PESSOA (CPF), janela de 90 dias:
//   (A) PROFISSIONAL — "escolher outro" e "desfazer escolha" gravam compromisso_nao_cumprido + falta;
//       o 1º lembrete "Agende" de uma sequência sem proposta avisa ("…sem penalidade. Se ignorar, conta
//       como falta."); a desistência voluntária antes do horário continua 'livre'; candidaturas e
//       interesses ao dono trazem compromissos_nao_cumpridos_90d e cumpriu_todos.
//   (B) DONO — aviso final 1h antes da proposta do profissional vencer; a proposta vencida grava
//       cliente_nao_respondeu (1º só marca; 2º em 90 dias bloqueia pedidos novos por 7 dias → 409
//       PEDIDOS_BLOQUEADOS em POST /obras/dono e /reparos/dono, demandas abertas intactas);
//       cliente_nao_respondeu_90d em feed e detalhe.
//   (C) COMPENSAÇÃO — cada cliente_nao_respondeu dá 7 dias ao profissional: vencimento +7 na assinatura
//       paga e ativa (sem cobrança, sem mexer em plano/valor/status), guardado nas demais e aplicado
//       pela varredura quando a assinatura vira paga; push ao profissional; lista do painel.
// SQL REAL num Postgres em memória (PGlite); rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-responsabilidade-pos-match.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

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
const { autenticar, exigirAdmin } = require(path.join(REPO, 'src/middlewares/auth'))
const A = require(path.join(REPO, 'src/services/alertaService'))
const S = require(path.join(REPO, 'src/services/desfazerEscolhaService'))
const R = require(path.join(REPO, 'src/services/responsabilidadeService'))
const C = require(path.join(REPO, 'src/services/cancelamentoMatchService'))
const U_ = require(path.join(REPO, 'src/utils/responsabilidade'))
const { SQL_ZERAR_AGENDA } = require(path.join(REPO, 'src/utils/agendamento'))
const candidaturasCtrl = require(path.join(REPO, 'src/controllers/candidaturasController'))
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
const DONO = U(1), PROF = U(2), ANA = U(3), BETO = U(4), CAIO = U(5), OUTRO = U(6), DONO2 = U(7), PROF2 = U(8), ADMIN = U(9)
const ROLE = { [DONO]: 'dono_obra', [DONO2]: 'dono_obra', [ADMIN]: 'admin' }
const rota = (metodo, caminho) => router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo]).route
const handlerDe = (metodo, caminho) => rota(metodo, caminho).stack[rota(metodo, caminho).stack.length - 1].handle
const chamar = (handler, usuarioId, id, body = {}, query = {}, params = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params: { id, ...params }, body, query, usuario: { id: usuarioId, role: ROLE[usuarioId] || 'prestador' } }, res)
})
const quieto = async (fn) => { silenciar(true); const n0 = erros.length; try { return await fn() } finally { await assentar(); silenciar(false); if (process.env.DEBUG_ERROS && erros.length > n0) logOrig('   [erros]', erros.slice(n0).join(' || ').slice(0, 600)) } }
const propor = (tabela, id, dataHora, quem = PROF) => quieto(() => chamar(handlerDe('post', `/${tabela}/:id/chegada-prevista`), quem, id, { data_hora: dataHora }))
const job = async (fn) => { pushes.length = 0; emails.length = 0; await quieto(fn) }
const linha = async (tabela, id) => (await db.query(`SELECT * FROM ${tabela} WHERE id = $1`, [id])).rows[0]
const pushesDe = (n) => pushes.filter(p => p.to === tok(n))
const eventos = async (tipo, usuario) => (await db.query(`SELECT * FROM eventos_responsabilidade WHERE tipo_evento = $1 AND usuario_id = $2 ORDER BY criado_em`, [tipo, usuario])).rows
const assinatura = async (u) => (await db.query(`SELECT status, tipo, plano, valor_mensal, proximo_vencimento, dias_credito_aplicados FROM assinaturas WHERE usuario_id = $1`, [u])).rows[0]
const creditoTotal = async (u) => (await db.query(`SELECT dias_credito_compensacao AS n FROM usuarios WHERE id = $1`, [u])).rows[0].n
const dias = (a, b) => Math.round((new RealDate(a) - new RealDate(b)) / 86400000)
const contadoresProf = async (u) => (await db.query(`SELECT ${U_.sqlCompromissosNaoCumpridos90d('$1::uuid')} AS n, ${U_.sqlCumpriuTodos('$1::uuid')} AS cumpriu`, [u])).rows[0]

const main = async () => {
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, descricao text, categoria text, categorias text[], valor numeric, valor_estimado numeric, cidade text, bairro text, uf text, estado text, tags text[],
      latitude double precision, longitude double precision, coordenadas_origem text, metragem numeric, prazo_execucao_dias int, ultima_extensao_horas numeric, endereco_obra text, endereco_reparo text, ponto_referencia text,
      criado_por uuid, status text DEFAULT 'aberta', status_aprovacao text DEFAULT 'aprovada', encerrado_em timestamptz, client_request_id text, enviada_por_dono boolean, prazo_timezone text,
      match_usuario_id uuid, match_feito_em timestamptz, expira_em timestamptz, criado_em timestamptz DEFAULT now(),
      chegada_prevista_em timestamptz, chegada_pendente_em timestamptz, chegada_pendente_janela text, chegada_janela text,
      chegada_declarada_por uuid, chegada_declarada_em timestamptz, chegada_recusada_em timestamptz, chegada_confirmada_em timestamptz,
      a_caminho_em timestamptz, pedido_tempo_status text, pedido_tempo_motivo text, pedido_tempo_minutos int,
      aviso_match_enviado_em timestamptz, lembrete_chegada_enviado_em timestamptz,
      chegada_proposta_por uuid, chegada_pendente_rodada int DEFAULT 0, lembrete_agenda_vespera_em timestamptz, lembrete_agenda_2h_em timestamptz,
      lembrete_agenda_hora_em timestamptz, lembrete_agenda_dono_vespera_em timestamptz, lembrete_agenda_dono_2h_em timestamptz,
      vigia_comparecimento_em timestamptz, comparecimento_resposta text, comparecimento_respondido_em timestamptz,
      lembrete_agendar_offsets int[] NOT NULL DEFAULT '{}', lembrete_agendar_ultimo_em timestamptz, lembrete_agendar_dono_em timestamptz, lembrete_agendar_ciclo int DEFAULT 0,
      lembrete_agendar_enviados int NOT NULL DEFAULT 0, desfazer_aviso_em timestamptz,
      lembrete_agendar_sem_proposta int NOT NULL DEFAULT 0, horario_vencido_em timestamptz, horarios_vencidos int NOT NULL DEFAULT 0,
      chegada_proposta_em timestamptz, lembrete_resposta_1h_em timestamptz, lembrete_resposta_antes_em timestamptz, lembrete_resposta_ultimo_em timestamptz, lembrete_resposta_ciclo int DEFAULT 0,
      sugestoes_horario_dono int DEFAULT 0, sugestoes_horario_profissional int DEFAULT 0, prazo_chegada_extra_em timestamptz, aviso_atraso_enviado_em timestamptz,
      pedido_atraso_minutos int, pedido_atraso_motivo text, pedido_atraso_em timestamptz, pedido_atraso_status text, pedido_atraso_respondido_em timestamptz,
      pedidos_atraso_usados int DEFAULT 0, cancelamento_pedido_por uuid, cancelamento_pedido_motivo text, cancelamento_pedido_detalhe text,
      cancelamento_pedido_em timestamptz, cancelamento_pedido_expira_em timestamptz, prestadores_bloqueados uuid[],
      prazo_atendimento_horas numeric, prazo_modo text, horas_para_expirar numeric, publicado_em timestamptz, valor_aumentado_em timestamptz, valor_aumentos int DEFAULT 0, alerta_enviado_em timestamptz, alerta_prazo_enviado_em timestamptz`
  const colsProposta = (fk) => `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${fk} uuid, usuario_id uuid, status text, status_antes_match text, cancelado_por uuid, cancelado_motivo text,
      cancelado_detalhe text, cancelado_em timestamptz, cancelado_acordo boolean DEFAULT false, referencias text, valor_oferta numeric, mensagem_oferta text, valor_proposto numeric, mensagem text, valor_contraproposta numeric, rodada int DEFAULT 0, criado_em timestamptz DEFAULT now()`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text, suspenso_em timestamptz, suspenso_motivo text, desinstalado_em timestamptz, role text, tipo_dono text, tipo_prestador text, cpf_cnpj text,
      cidade text, anos_experiencia int, tamanho_equipe int, especialidades text[], embaixador boolean DEFAULT false, foto_url text, logradouro text, numero text, telefone text, uf text,
      ativo boolean DEFAULT true, bairro text, verificacao_status text, avisos_todas_areas boolean NOT NULL DEFAULT true, latitude double precision, longitude double precision, raio_km_escolhido int);
    CREATE TABLE assinaturas (usuario_id uuid PRIMARY KEY, status text, tipo text, plano text, valor_mensal numeric, proximo_vencimento timestamptz, atualizado_em timestamptz, criado_em timestamptz DEFAULT now());
    CREATE TABLE midias (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, url text, ordem int);
    CREATE TABLE midias_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, url text, ordem int);
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz DEFAULT now());
    CREATE TABLE contratos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tipo text, demanda_id uuid, interesse_id uuid, valor_acordado numeric, criado_em timestamptz DEFAULT now());
    CREATE TABLE tentativas_contato (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, criado_em timestamptz DEFAULT now());
    CREATE TABLE push_entregas (tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, ultima_tentativa_em timestamptz DEFAULT now(), primeira_tentativa_em timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid);
    CREATE TABLE reparos (${colsDemanda});
    CREATE TABLE obras (${colsDemanda});
    CREATE TABLE interesse_reparos (${colsProposta('reparo_id')});
    CREATE TABLE candidaturas (${colsProposta('obra_id')});
    CREATE TABLE perguntas_demanda (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tipo text, demanda_id uuid, autor_id uuid, pergunta text, resposta text, criado_em timestamptz DEFAULT now(), respondido_em timestamptz);
    CREATE TABLE faltas_profissional (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, tabela text, demanda_id uuid, motivo text, criado_em timestamptz DEFAULT now(), perdoada_em timestamptz, perdoada_por uuid);
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE avaliacoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), avaliado_id uuid, estrelas int);
    SET search_path = public, pg_catalog;
  `)
  await U_.migrarResponsabilidade(db)
  // obras.especialidades_inferidas (capacidadesDaPessoa / feed / aviso de obra nova leem a coluna) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/especialidadesInferidas')).migrarEspecialidadesInferidas(db)
  await db.query(`INSERT INTO usuarios (id, nome, email, push_token, role, tipo_dono, tipo_prestador, cpf_cnpj) VALUES
    ($1, 'Maria', 'maria@x.invalid', $10, 'dono_obra', 'reparo', NULL, '111.111.111-11'), ($2, 'Alex Silva', 'alex@x.invalid', $11, 'prestador', NULL, 'reparador', '222'),
    ($3, 'Ana', 'ana@x.invalid', $12, 'prestador', NULL, 'reparador', '333'), ($4, 'Beto', 'beto@x.invalid', NULL, 'prestador', NULL, 'reparador', '444'),
    ($5, 'Caio', 'caio@x.invalid', $13, 'prestador', NULL, 'reparador', '555'), ($6, 'Outro', 'outro@x.invalid', $14, 'prestador', NULL, 'reparador', '666'),
    ($7, 'Maria (obras)', 'maria2@x.invalid', NULL, 'dono_obra', 'obra', NULL, '11111111111'), ($8, 'Alex (pintor)', 'alex2@x.invalid', NULL, 'prestador', NULL, 'pintor', '222'),
    ($9, 'Admin', 'admin@x.invalid', NULL, 'admin', NULL, NULL, '999')`,
    [DONO, PROF, ANA, BETO, CAIO, OUTRO, DONO2, PROF2, ADMIN, tok('maria'), tok('alex'), tok('ana'), tok('caio'), tok('outro')])
  // Alex: assinatura PAGA e ativa (vence em 20 dias). Ana: gratuita de lançamento (sem vencimento). Beto: pendente (nunca pagou).
  await db.query(`INSERT INTO assinaturas (usuario_id, status, tipo, plano, valor_mensal, proximo_vencimento) VALUES
    ($1, 'ativa', NULL, 'mensal', 49.90, now() + INTERVAL '20 days'), ($2, 'ativa', 'gratuito', 'mensal', 49.90, NULL), ($3, 'pendente', NULL, 'mensal', 49.90, NULL), ($4, 'ativa', 'gratuito', 'mensal', 49.90, NULL)`, [PROF, ANA, BETO, CAIO])
  await fixarAgora(0)
  const seed = async (tabela, n, titulo, prazoMin, prof = PROF) => {
    const prop = tabela === 'obras' ? { t: 'candidaturas', fk: 'obra_id' } : { t: 'interesse_reparos', fk: 'reparo_id' }
    await db.query(`INSERT INTO ${tabela} (id, titulo, criado_por, match_usuario_id, match_feito_em, expira_em, prazo_atendimento_horas, horas_para_expirar, cidade, uf) VALUES ($1, $2, $3, $4, now(), now() + ($5 * INTERVAL '1 minute'), $6, $6, 'Niterói', 'RJ')`,
      [D(n), titulo, DONO, prof, prazoMin, prazoMin / 60])
    await db.query(`INSERT INTO ${prop.t} (${prop.fk}, usuario_id, status, status_antes_match) VALUES
      ($1, $2, 'aceito', NULL), ($1, $3, 'recusado', 'pendente'), ($1, $4, 'recusado', 'contraproposta_dono'), ($1, $5, 'recusado', NULL)`, [D(n), prof, ANA, BETO, CAIO])
  }
  await seed('reparos', 1, 'Trocar chuveiro', 300)
  await seed('obras', 2, 'Pintura da sala', 10 * 1440)
  await seed('reparos', 3, 'Segunda proposta', 300)
  await seed('reparos', 4, 'Contraproposta do dono', 300)
  // Serviço já encerrado com Alex (para cumpriu_todos).
  await db.query(`INSERT INTO reparos (id, titulo, criado_por, match_usuario_id, status, encerrado_em, expira_em) VALUES ($1, 'Antigo', $2, $3, 'encerrada', now() - INTERVAL '30 days', now())`, [D(9), DONO, PROF])

  // ═══ 0. Rotas, constantes, migração ═══════════════════════════════════════════════════════
  const adm = rota('get', '/admin/eventos-responsabilidade')
  ok(adm && adm.stack[0].handle === autenticar && adm.stack[1].handle === exigirAdmin && adm.stack.length === 3, 'GET /admin/eventos-responsabilidade registrada com autenticar + exigirAdmin')
  ok(U_.JANELA_DIAS === 90 && U_.EVENTOS_PARA_BLOQUEIO === 2 && U_.BLOQUEIO_PEDIDOS_DIAS === 7 && U_.CREDITO_DIAS_COMPENSACAO === 7, 'constantes: 90 dias, 2º evento bloqueia 7 dias, crédito 7 dias')
  ok(/aviso_resposta_final_em = NULL/.test(SQL_ZERAR_AGENDA), 'SQL_ZERAR_AGENDA zera o claim do aviso final (match novo / un-match)')
  const cols = (await db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE (table_name IN ('obras','reparos') AND column_name = 'aviso_resposta_final_em') OR (table_name = 'usuarios' AND column_name = 'dias_credito_compensacao') OR (table_name = 'assinaturas' AND column_name = 'dias_credito_aplicados')`)).rows
  ok(cols.length === 4, 'migração: aviso_resposta_final_em (obras, reparos), dias_credito_compensacao, dias_credito_aplicados', cols.map(c => `${c.table_name}.${c.column_name}`))
  await U_.migrarResponsabilidade(db)
  ok(true, 'migração idempotente (rodou 2x sem erro)')
  ok(A.CORPO_AGENDAR_PRIMEIRO === "Marque o horário ou toque em 'Não vou conseguir' — sem penalidade. Se ignorar, conta como falta.", 'texto do 1º lembrete "Agende"')
  let c0 = await contadoresProf(PROF)
  ok(c0.n === 0 && c0.cumpriu === true, 'Alex antes de tudo: 0 compromissos não cumpridos, cumpriu_todos TRUE (tem serviço encerrado)', c0)
  ok((await contadoresProf(ANA)).cumpriu === false, 'Ana sem serviço encerrado: cumpriu_todos FALSE (não NULL)')

  // ═══ A. 1º lembrete "Agende" avisa; desistência livre; escolher outro → evento + falta ═════
  await fixarAgora(60); await job(A.repetirLembreteAgendar)
  let pa = pushesDe('alex').filter(p => p.data?.reparo_id === D(1))
  ok(pa.length === 1 && pa[0].title === '📅 Agende seu atendimento' && pa[0].body === A.CORPO_AGENDAR_PRIMEIRO, '1h: 1º lembrete "Agende" com o aviso de falta (push)', pa[0] && pa[0].body)
  ok(emails.some(e => e.para === 'alex@x.invalid' && e.assunto === '📅 Agende seu atendimento' && String(e.texto || e.html || '').includes('sem penalidade')), 'e-mail do 1º lembrete com o mesmo texto', emails.filter(e => e.para === 'alex@x.invalid').map(e => e.assunto))
  await fixarAgora(90); await job(A.repetirLembreteAgendar)
  pa = pushesDe('alex').filter(p => p.data?.reparo_id === D(1))
  ok(pa.length === 1 && pa[0].body !== A.CORPO_AGENDAR_PRIMEIRO && /ainda não agendou/.test(pa[0].body), '1h30: 2º lembrete volta ao texto de sempre', pa[0] && pa[0].body)
  // Desistência voluntária ANTES de horário combinado: 'livre', sem falta nem evento (reparo 3).
  const sim = await quieto(() => chamar(C.handlers ? C.handlers('reparos').cancelar : handlerDe('post', '/reparos/:id/cancelar-match'), PROF, D(3), {}, { simular: '1' }))
  ok(sim.status === 200 && sim.body.tipo === 'livre' && sim.body.falta === false, '"Não vou conseguir" antes do horário: simulação diz livre, sem falta', sim.body && { tipo: sim.body.tipo, falta: sim.body.falta })
  // Escolher outro (2 lembretes seguidos) → falta + compromisso_nao_cumprido
  let r = await quieto(() => chamar(S.handler('reparos', 'escolher_outro'), DONO, D(1)))
  let ev = await eventos('compromisso_nao_cumprido', PROF)
  const faltas = (await db.query(`SELECT motivo FROM faltas_profissional WHERE usuario_id = $1 AND demanda_id = $2`, [PROF, D(1)])).rows
  ok(r.status === 200 && r.body.modo === 'escolher_outro' && ev.length === 1 && ev[0].tabela === 'reparos' && ev[0].demanda_id === D(1) && ev[0].motivo === 'escolheu_outro' && ev[0].outro_usuario_id === DONO,
     'escolher-outro: 200 + evento compromisso_nao_cumprido (motivo escolheu_outro, dono como outra parte)', { status: r.status, eventos: ev.length })
  ok(faltas.length === 1 && faltas[0].motivo === 'não marcou horário', 'escolher-outro agora registra 1 falta ("não marcou horário")', faltas)
  const pe = pushesDe('alex').find(p => p.title === 'O cliente escolheu outro profissional')
  ok(pe && /Isso contou como 1 falta/.test(pe.body), 'push ao profissional avisa que contou como falta', pe && pe.body)
  c0 = await contadoresProf(PROF)
  ok(c0.n === 1 && c0.cumpriu === false, 'Alex: compromissos_nao_cumpridos_90d = 1, cumpriu_todos FALSE', c0)
  ok((await contadoresProf(PROF2)).n === 1, 'conta irmã profissional (mesmo CPF, pintor) vê o MESMO contador (por pessoa)')
  // Desfazer clássico: também grava (obra 2, Outro como escolhido há 9 dias)
  await db.query(`UPDATE obras SET match_usuario_id = $2, match_feito_em = now() - INTERVAL '9 days', expira_em = now() + INTERVAL '1 day', ${SQL_ZERAR_AGENDA} WHERE id = $1`, [D(2), OUTRO])
  await db.query(`UPDATE candidaturas SET usuario_id = $3 WHERE obra_id = $1 AND usuario_id = $2`, [D(2), PROF, OUTRO])
  r = await quieto(() => chamar(S.handler('obras'), DONO, D(2)))
  ev = await eventos('compromisso_nao_cumprido', OUTRO)
  ok(r.status === 200 && r.body.modo === 'desfazer' && ev.length === 1 && ev[0].motivo === 'escolha_desfeita' && (await db.query(`SELECT count(*)::int AS n FROM faltas_profissional WHERE usuario_id = $1`, [OUTRO])).rows[0].n === 1,
     'desfazer clássico: evento (motivo escolha_desfeita) + falta', { status: r.status, eventos: ev.length })
  ok((await R.registrarCompromissoNaoCumprido(db, { tabela: 'obras', demandaId: D(2), profissionalId: OUTRO, donoId: DONO, motivo: 'x' })) === false && (await eventos('compromisso_nao_cumprido', OUTRO)).length === 1, 'evento idempotente por (profissional, demanda)')
  // Janela de 90 dias
  await db.query(`UPDATE eventos_responsabilidade SET criado_em = now() - INTERVAL '91 days' WHERE usuario_id = $1`, [OUTRO])
  ok((await contadoresProf(OUTRO)).n === 0, 'evento com 91 dias sai da contagem')
  // Candidaturas/interesses ao dono trazem os contadores
  await db.query(`INSERT INTO obras (id, titulo, criado_por, expira_em) VALUES ($1, 'Obra nova', $2, now() + INTERVAL '5 days')`, [D(5), DONO])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status) VALUES ($1, $2, 'pendente'), ($1, $3, 'pendente')`, [D(5), PROF, ANA])
  await db.query(`INSERT INTO reparos (id, titulo, criado_por, expira_em) VALUES ($1, 'Reparo novo', $2, now() + INTERVAL '5 days')`, [D(6), DONO])
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status) VALUES ($1, $2, 'pendente'), ($1, $3, 'pendente')`, [D(6), PROF, ANA])
  const det = await quieto(() => chamar(handlerDe('get', '/obras/:id'), DONO, D(5)))
  const cands = Object.fromEntries((det.body.candidatos || []).map(c => [c.usuario_id, c]))
  ok(det.status === 200 && cands[PROF]?.compromissos_nao_cumpridos_90d === 1 && cands[PROF]?.cumpriu_todos === false && cands[ANA]?.compromissos_nao_cumpridos_90d === 0 && cands[ANA]?.cumpriu_todos === false,
     'GET /obras/:id (dono): cada candidato traz compromissos_nao_cumpridos_90d e cumpriu_todos', { status: det.status, alex: cands[PROF] && [cands[PROF].compromissos_nao_cumpridos_90d, cands[PROF].cumpriu_todos] })
  const detR = await quieto(() => chamar(handlerDe('get', '/reparos/:id'), DONO, D(6)))
  const ints = Object.fromEntries((detR.body.interessados || []).map(c => [c.usuario_id, c]))
  ok(detR.status === 200 && ints[PROF]?.compromissos_nao_cumpridos_90d === 1 && ints[ANA]?.compromissos_nao_cumpridos_90d === 0, 'GET /reparos/:id (dono): interessados idem', { status: detR.status })
  const lc = await quieto(() => chamar(candidaturasCtrl.porObra, DONO, undefined, {}, {}, { obra_id: D(5) }))
  ok(lc.status === 200 && lc.body.candidaturas.find(c => c.usuario_id === PROF)?.compromissos_nao_cumpridos_90d === 1 && 'cumpriu_todos' in lc.body.candidaturas[0], 'GET /obras/:obra_id/candidaturas: idem', { status: lc.status })

  // ═══ B. Dono: aviso final 1h antes; proposta vencida → cliente_nao_respondeu ══════════════
  await db.query(`UPDATE reparos SET match_usuario_id = $2, match_feito_em = now(), prestadores_bloqueados = NULL, ${SQL_ZERAR_AGENDA} WHERE id = $1`, [D(1), PROF])
  pushes.length = 0; emails.length = 0
  r = await propor('reparos', D(1), emMin(240)) // 14:00 SP
  ok(r.status === 200 && (await linha('reparos', D(1))).aviso_resposta_final_em === null, 'proposta do profissional às 11:30 para 14:00: claim do aviso final zerado')
  await fixarAgora(170); await job(R.avisarRespostaFinalDono)
  ok(pushesDe('maria').length === 0, '12:50 (70 min antes): aviso final ainda não')
  await fixarAgora(181); await job(R.avisarRespostaFinalDono)
  let pm = pushesDe('maria')
  ok(pm.length === 1 && pm[0].title === R.TITULO_AVISO_FINAL && pm[0].body === 'Alex reservou a agenda para você. Responda ou cancele o pedido — se ignorar, sua conta fica marcada.' && pm[0].data.tipo === 'chegada_prevista_pendente' && pm[0].data.reparo_id === D(1),
     '13:01 (59 min antes): aviso final ao dono por push ("<nome> reservou a agenda…"), toque abre o detalhe', pm[0] && { title: pm[0].title, body: pm[0].body })
  ok(emails.some(e => e.para === 'maria@x.invalid' && e.assunto === R.TITULO_AVISO_FINAL), 'e-mail do aviso final ao dono', emails.map(e => [e.para, e.assunto]))
  await fixarAgora(190); await job(R.avisarRespostaFinalDono)
  ok(pushesDe('maria').length === 0 && iso((await linha('reparos', D(1))).aviso_resposta_final_em) === emMin(181), 'aviso final sai UMA vez por proposta (claim)')
  // Contraproposta do dono vencida (reparo 4): sem aviso final, sem evento
  await db.query(`UPDATE reparos SET chegada_pendente_em = $2, chegada_pendente_janela = 'agendado', chegada_proposta_por = $3, chegada_proposta_em = now() WHERE id = $1`, [D(4), emMin(200), DONO])
  await fixarAgora(195); await job(R.avisarRespostaFinalDono)
  ok(pushesDe('maria').length === 0 && pushesDe('alex').length === 0, 'contraproposta do DONO pendente: nenhum aviso final (só proposta do profissional)')
  // Vencimento (14:01): evento do dono; o profissional recebe o aviso de sempre + crédito
  const vencAntes = (await assinatura(PROF)).proximo_vencimento
  await fixarAgora(241); await job(A.expirarPropostasDeHorario)
  let evd = await eventos('cliente_nao_respondeu', DONO)
  ok(evd.length === 1 && evd[0].tabela === 'reparos' && evd[0].demanda_id === D(1) && evd[0].outro_usuario_id === PROF && evd[0].motivo === 'proposta_vencida' && evd[0].bloqueio_ate === null && evd[0].credito_dias === 7,
     '14:01 proposta venceu: evento cliente_nao_respondeu do dono (1º: SEM bloqueio), crédito 7 ao profissional', evd[0] && { bloqueio: evd[0].bloqueio_ate, credito: evd[0].credito_dias })
  ok((await eventos('cliente_nao_respondeu', DONO)).length === 1 && (await db.query(`SELECT count(*)::int AS n FROM eventos_responsabilidade WHERE demanda_id = $1`, [D(4)])).rows[0].n === 0, 'contraproposta do dono vencida (reparo 4) NÃO gera evento')
  ok((await R.bloqueioDePedidos(DONO)) === null, '1º evento: só marca — bloqueioDePedidos null')
  let sq = await db.query(`SELECT ${U_.sqlClienteNaoRespondeu90d('$1::uuid')} AS n`, [DONO2])
  ok(sq.rows[0].n === 1, 'conta irmã contratante (mesmo CPF) vê cliente_nao_respondeu_90d = 1 (por pessoa)')
  // (C) compensação: assinatura PAGA e ativa → +7 dias, nada mais muda, sem cobrança
  let as = await assinatura(PROF)
  ok(dias(as.proximo_vencimento, vencAntes) === 7 && as.status === 'ativa' && as.tipo === null && as.plano === 'mensal' && Number(as.valor_mensal) === 49.9 && as.dias_credito_aplicados === 7 && (await creditoTotal(PROF)) === 7,
     '(C) Alex (paga, ativa): vencimento +7 dias; status/tipo/plano/valor intactos; creditado 7 = aplicado 7', { antes: iso(vencAntes), depois: iso(as.proximo_vencimento), aplicados: as.dias_credito_aplicados })
  ok((await db.query(`SELECT count(*)::int AS n FROM assinaturas`)).rows[0].n === 4 && (await db.query(`SELECT to_regclass('pagamentos') IS NULL AS sem`)).rows[0].sem === true, 'guarda de cobrança: nenhuma linha nova de assinatura/cobrança criada (só o vencimento andou)')
  evd = await eventos('cliente_nao_respondeu', DONO)
  ok(iso(evd[0].credito_aplicado_em) === emMin(241), 'evento marca credito_aplicado_em')
  const pc = pushesDe('alex').find(p => p.title === R.TITULO_CREDITO)
  ok(pc && /ganhou 7 dias, sem cobrança/.test(pc.body) && pc.data.compensacao === true && pc.data.aplicado === true && pc.data.reparo_id === D(1), 'push ao profissional: "Você recebeu 7 dias grátis pelo cliente que não respondeu" (aplicado)', pc && pc.body)
  ok(pushesDe('alex').some(p => p.title === A.TITULO_HORARIO_VENCIDO), 'o aviso "horário venceu" de sempre continua saindo')
  // Dono ainda cria pedidos (1º evento)
  const bodyObra = { titulo: 'Pintar quarto', descricao: 'x', valor: 500, cidade: 'Niterói', uf: 'RJ' }
  const bodyReparo = { titulo: 'Trocar tomada', descricao: 'x', valor_estimado: 100, cidade: 'Niterói', uf: 'RJ', categoria: 'eletrica' }
  r = await quieto(() => chamar(handlerDe('post', '/obras/dono'), DONO, undefined, bodyObra))
  ok(r.status !== 409 || r.body.codigo !== 'PEDIDOS_BLOQUEADOS', 'POST /obras/dono com 1 evento: não é PEDIDOS_BLOQUEADOS', r.status)

  // 2º evento em 90 dias (reparo 3, proposta de Alex vencida) → bloqueio de 7 dias; crédito guardado p/ Ana
  await db.query(`UPDATE reparos SET match_usuario_id = $2, prestadores_bloqueados = NULL, ${SQL_ZERAR_AGENDA} WHERE id = $1`, [D(3), ANA])
  await db.query(`UPDATE reparos SET chegada_pendente_em = $2, chegada_pendente_janela = 'agendado', chegada_proposta_por = $3, chegada_proposta_em = now() WHERE id = $1`, [D(3), emMin(250), ANA])
  await fixarAgora(251); await job(A.expirarPropostasDeHorario)
  evd = await eventos('cliente_nao_respondeu', DONO)
  ok(evd.length === 2 && iso(evd[1].bloqueio_ate) === emMin(251 + 7 * 1440) && evd[1].outro_usuario_id === ANA, '2º evento em 90 dias: bloqueio_ate = agora + 7 dias', evd[1] && { bloqueio: iso(evd[1].bloqueio_ate) })
  let bl = await R.bloqueioDePedidos(DONO)
  ok(bl && iso(bl.liberado_em) === emMin(251 + 7 * 1440) && iso((await R.bloqueioDePedidos(DONO2))?.liberado_em) === emMin(251 + 7 * 1440), 'bloqueioDePedidos: liberado_em em 7 dias, para as DUAS contas contratantes da pessoa')
  r = await quieto(() => chamar(handlerDe('post', '/obras/dono'), DONO, undefined, bodyObra))
  ok(r.status === 409 && r.body.codigo === 'PEDIDOS_BLOQUEADOS' && iso(r.body.liberado_em) === emMin(251 + 7 * 1440) && /7 dias/.test(r.body.erro), 'POST /obras/dono: 409 PEDIDOS_BLOQUEADOS com liberado_em', r.body && { status: r.status, codigo: r.body.codigo })
  r = await quieto(() => chamar(handlerDe('post', '/reparos/dono'), DONO2, undefined, bodyReparo))
  ok(r.status === 409 && r.body.codigo === 'PEDIDOS_BLOQUEADOS' && iso(r.body.liberado_em) === emMin(251 + 7 * 1440), 'POST /reparos/dono pela conta irmã: 409 PEDIDOS_BLOQUEADOS', r.body && { status: r.status, codigo: r.body.codigo })
  const abertas = (await db.query(`SELECT count(*)::int AS n FROM reparos WHERE criado_por = $1 AND status = 'aberta'`, [DONO])).rows[0].n
  ok(abertas >= 4, 'demandas abertas do dono seguem intactas', abertas)
  // Feed e detalhe aos profissionais: cliente_nao_respondeu_90d = 2
  const feedR = await quieto(() => chamar(handlerDe('get', '/reparos'), CAIO, undefined, {}, { raio_km: 'estado', uf: 'RJ' }))
  const cardR = (feedR.body.reparos || []).find(x => x.id === D(6))
  ok(feedR.status === 200 && cardR && cardR.cliente_nao_respondeu_90d === 2, 'feed de reparos (profissional): card traz cliente_nao_respondeu_90d = 2', { status: feedR.status, card: cardR && cardR.cliente_nao_respondeu_90d, n: (feedR.body.reparos || []).length })
  const detP = await quieto(() => chamar(handlerDe('get', '/reparos/:id'), CAIO, D(6)))
  ok(detP.status === 200 && detP.body.reparo?.cliente_nao_respondeu_90d === 2, 'GET /reparos/:id (profissional): cliente_nao_respondeu_90d = 2', { status: detP.status, v: detP.body.reparo?.cliente_nao_respondeu_90d })
  const detO = await quieto(() => chamar(handlerDe('get', '/obras/:id'), CAIO, D(5)))
  ok(detO.status === 200 && detO.body.obra?.cliente_nao_respondeu_90d === 2, 'GET /obras/:id (profissional): cliente_nao_respondeu_90d = 2', { status: detO.status, v: detO.body.obra?.cliente_nao_respondeu_90d })
  // 11/11/2026: especialidades_inferidas sai no detalhe, sempre array (coluna NULL → []).
  ok(Array.isArray(detO.body.obra?.especialidades_inferidas), 'GET /obras/:id (profissional): especialidades_inferidas é array (NULL → [])', detO.body.obra?.especialidades_inferidas)
  // Feed de obras: só o público de obras (ou quem casa por especialidade inferida) vê cards — Caio vira pintor.
  await db.query(`UPDATE usuarios SET tipo_prestador = 'pintor' WHERE id = $1`, [CAIO])
  const feedO = await quieto(() => chamar(handlerDe('get', '/obras'), CAIO, undefined, {}, { raio_km: 'estado', uf: 'RJ', page: '1', limit: '20' }))
  const cardO = (feedO.body.obras || []).find(x => x.id === D(5))
  ok(feedO.status === 200 && cardO && cardO.cliente_nao_respondeu_90d === 2, 'feed de obras (profissional): card traz cliente_nao_respondeu_90d = 2', { status: feedO.status, n: (feedO.body.obras || []).length })
  // (C) Ana (gratuita): crédito guardado; vira vencimento quando a assinatura passa a paga (varredura)
  as = await assinatura(ANA)
  ok((await creditoTotal(ANA)) === 7 && as.dias_credito_aplicados === 0 && as.proximo_vencimento === null && as.tipo === 'gratuito', '(C) Ana (gratuita): 7 dias GUARDADOS, assinatura intocada', { total: await creditoTotal(ANA), aplicados: as.dias_credito_aplicados })
  const pcA = pushesDe('ana').find(p => p.title === R.TITULO_CREDITO)
  ok(pcA && /ficam guardados/.test(pcA.body) && pcA.data.aplicado === false, 'push à Ana: dias guardados para quando a cobrança começar', pcA && pcA.body)
  ok((await eventos('cliente_nao_respondeu', DONO))[1].credito_aplicado_em === null, 'evento da Ana sem credito_aplicado_em')
  ok((await R.aplicarCreditosPendentes()) === 0, 'varredura sem assinatura paga nova: nada aplicado')
  await db.query(`UPDATE assinaturas SET tipo = NULL, proximo_vencimento = now() + INTERVAL '30 days' WHERE usuario_id = $1`, [ANA]) // fim da janela de lançamento / pagamento
  ok((await R.aplicarCreditosPendentes()) === 1, 'varredura: 1 assinatura recebe o crédito guardado')
  as = await assinatura(ANA)
  ok(dias(as.proximo_vencimento, emMin(251)) === 37 && as.dias_credito_aplicados === 7 && (await eventos('cliente_nao_respondeu', DONO))[1].credito_aplicado_em !== null, 'Ana: 30 + 7 dias; aplicados = 7; evento marcado', { vence: iso(as.proximo_vencimento) })
  ok((await R.aplicarCreditosPendentes()) === 0 && dias((await assinatura(ANA)).proximo_vencimento, emMin(251)) === 37, 'varredura de novo: idempotente (não soma duas vezes)')
  // Beto (pendente, nunca pagou): crédito guardado; expirada não recebe
  await db.query(`UPDATE usuarios SET dias_credito_compensacao = 7 WHERE id = $1`, [BETO])
  ok((await R.aplicarCreditoCompensacao(BETO)) === null && (await assinatura(BETO)).proximo_vencimento === null, 'Beto (pendente): crédito guardado, nada aplicado')
  await db.query(`UPDATE assinaturas SET status = 'ativa', proximo_vencimento = now() - INTERVAL '1 day' WHERE usuario_id = $1`, [BETO])
  ok((await R.aplicarCreditoCompensacao(BETO)) === null, 'assinatura ativa mas VENCIDA: não aplica (só paga e ativa)')
  // Bloqueio vence
  await fixarAgora(251 + 7 * 1440 + 1)
  ok((await R.bloqueioDePedidos(DONO)) === null, '7 dias depois: bloqueio liberado')
  r = await quieto(() => chamar(handlerDe('post', '/obras/dono'), DONO, undefined, bodyObra))
  ok(!(r.status === 409 && r.body.codigo === 'PEDIDOS_BLOQUEADOS'), 'POST /obras/dono volta a passar do bloqueio', r.status)

  // ═══ Painel ═══════════════════════════════════════════════════════════════════════════════
  let pl = await quieto(() => chamar(R.listarEventosAdmin, ADMIN, undefined, {}, {}))
  ok(pl.status === 200 && pl.body.total === 4 && pl.body.eventos.length === 4 && pl.body.eventos[0].usuario_nome === 'Maria' && pl.body.eventos[0].outro_nome === 'Ana' && pl.body.eventos[0].demanda_titulo === 'Segunda proposta' && pl.body.eventos[0].bloqueio_ate && pl.body.eventos[0].credito_dias === 7,
     'GET /admin/eventos-responsabilidade: 4 eventos com nomes, título da demanda, bloqueio e crédito', pl.body && { total: pl.body.total, primeiro: pl.body.eventos[0] && [pl.body.eventos[0].tipo_evento, pl.body.eventos[0].usuario_nome, pl.body.eventos[0].outro_nome] })
  pl = await quieto(() => chamar(R.listarEventosAdmin, ADMIN, undefined, {}, { tipo: 'compromisso_nao_cumprido' }))
  ok(pl.status === 200 && pl.body.total === 2 && pl.body.eventos.every(e => e.tipo_evento === 'compromisso_nao_cumprido'), 'filtro ?tipo=compromisso_nao_cumprido: 2')
  pl = await quieto(() => chamar(R.listarEventosAdmin, ADMIN, undefined, {}, { usuario_id: ANA }))
  ok(pl.status === 200 && pl.body.total === 1 && pl.body.eventos[0].outro_usuario_id === ANA, 'filtro ?usuario_id= (qualquer das duas partes): 1')

  const inesperados = erros.filter(e => !/sem banco|PAGBANK|migration|geocod|ufDeCidade|fetch|Moderacao|moderador|ON CONFLICT|valor_aumentado_em/i.test(e))
  ok(inesperados.length === 0, 'nenhum erro inesperado logado', inesperados.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error = errOrig; console.error('ERRO', e); process.exit(1) })
