#!/usr/bin/env node
// Escolhido DESINSTALOU o app (dono, 11/11/2026). Quando usuarios.desinstalado_em é marcado (recibo
// DeviceNotRegistered → utils/desinstalacoes.marcarDesinstalados) e a conta é o match de obra/reparo
// ABERTO sem horário combinado:
//   - dono recebe push + e-mail UMA vez por match: "<Nome> desinstalou o app e pode não ver os avisos" /
//     "Você pode escolher outro profissional para \"<título>\" sem penalidade, ou esperar." (claim
//     aviso_desinstalou_em; disparo imediato em alertaService e no cron de 1 min);
//   - pode_escolher_outro vira true na hora, com motivo_escolher_outro = 'desinstalou' ('avisos_ignorados'
//     segue para a regra dos 2 lembretes; com os dois, vale 'desinstalou');
//   - POST /dono/:id/escolher-outro com motivo desinstalou: restaura os outros (regra única) SEM falta nem
//     compromisso_nao_cumprido; aviso ao profissional sem "contou como 1 falta";
//   - reinstalou (desinstalado_em NULL): pode_escolher_outro volta à regra normal.
// SQL REAL num Postgres em memória (PGlite); rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-desinstalou-escolher-outro.js
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
const q = async (sql, params) => { if (!db) throw new Error('sem banco (boot)'); const r = await db.query(sql, params); r.rowCount = r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0); return r }
const shim = { query: q, connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: q, release() {} } }, on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) }, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async () => {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { errOrig('unhandled', e && (e.stack || e)); process.exit(1) } })
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? (process.env.DEBUG_ERROS ? (...a) => errOrig('   [erro]', ...a.map(x => x?.message || String(x).slice(0, 300))) : () => {}) : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const A = require(path.join(REPO, 'src/services/alertaService'))
const CM = require(path.join(REPO, 'src/services/cancelamentoMatchService'))
const DE = require(path.join(REPO, 'src/services/desfazerEscolhaService'))
const { marcarDesinstalados, registrarReinstalacao } = require(path.join(REPO, 'src/utils/desinstalacoes'))
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
const tok = (id) => `ExponentPushToken[${id.slice(-3)}]`
const DONO = U(1), PRO = U(2), PA = U(3), PB = U(4), PC = U(5), ADMIN = U(9)
const ROLE = { [DONO]: 'dono_obra', [ADMIN]: 'admin' }
const rota = (metodo, caminho) => router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo]).route
const handlerDe = (metodo, caminho) => rota(metodo, caminho).stack[rota(metodo, caminho).stack.length - 1].handle
const chamar = (metodo, caminho, usuarioId, id, body = {}, query = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handlerDe(metodo, caminho)({ params: { id }, body, query, usuario: { id: usuarioId, role: ROLE[usuarioId] || 'prestador', tipo_prestador: ROLE[usuarioId] ? null : 'reparador' }, get() { return '' } }, res)
})
const quieto = async (fn) => { silenciar(true); try { return await fn() } finally { await assentar(); silenciar(false) } }

const LADO = {
  reparos: { proposta: 'interesse_reparos', coluna: 'reparo_id', chave: 'reparo_id' },
  obras:   { proposta: 'candidaturas',      coluna: 'obra_id',   chave: 'obra_id' },
}
let seq = 10
// Demanda ABERTA com match = PRO e três concorrentes: A rebaixado de 'pendente', B rebaixado de
// 'contraproposta_dono', C recusado explicitamente pelo dono (sem marcador). `extra` = colunas a mais.
const cenario = async (tabela, extra = {}) => {
  const id = D(seq++)
  const cols = Object.keys(extra)
  const base = tabela === 'reparos'
    ? `titulo, categoria, categorias, criado_por, valor_estimado, prazo_atendimento_horas, cidade, uf, bairro, publicado_em, push_novo_enviado_em, match_usuario_id, match_feito_em, expira_em`
    : `titulo, categoria, criado_por, valor, horas_para_expirar, cidade, uf, bairro, publicado_em, push_novo_enviado_em, match_usuario_id, match_feito_em, expira_em`
  const vals = tabela === 'reparos'
    ? `'Serviço ${seq}', 'eletrica', '{eletrica}', $2, 150, 72, 'Uberlândia', 'MG', 'Centro', now() - INTERVAL '1 day', now() - INTERVAL '1 day', $3, COALESCE($4::timestamptz, now() - INTERVAL '2 hours'), COALESCE($5::timestamptz, now() + INTERVAL '2 days')`
    : `'Obra ${seq}', 'residencial', $2, 3000, 480, 'Uberlândia', 'MG', 'Centro', now() - INTERVAL '1 day', now() - INTERVAL '1 day', $3, COALESCE($4::timestamptz, now() - INTERVAL '2 hours'), COALESCE($5::timestamptz, now() + INTERVAL '2 days')`
  const params = [id, DONO, PRO, extra.match_feito_em || null, extra.expira_em || null]
  const outras = cols.filter(c => !['match_feito_em', 'expira_em'].includes(c))
  const colsSql = outras.length ? ', ' + outras.join(', ') : ''
  const valsSql = outras.map((c, i) => `$${params.length + 1 + i}`).join(', ')
  for (const c of outras) params.push(extra[c])
  await db.query(`INSERT INTO ${tabela} (id, ${base}${colsSql}) VALUES ($1, ${vals}${valsSql ? ', ' + valsSql : ''})`, params)
  const l = LADO[tabela]
  await db.query(`INSERT INTO ${l.proposta} (${l.coluna}, usuario_id, status, status_antes_match, valor_proposto) VALUES
    ($1, $2, 'aceito', NULL, 140), ($1, $3, 'recusado', 'pendente', 130), ($1, $4, 'recusado', 'contraproposta_dono', 120), ($1, $5, 'recusado', NULL, 100)`, [id, PRO, PA, PB, PC])
  return id
}
const estado = async (tabela, id) => {
  const l = LADO[tabela]
  const d = (await db.query(`SELECT status, match_usuario_id FROM ${tabela} WHERE id = $1`, [id])).rows[0]
  const ps = (await db.query(`SELECT usuario_id, status, status_antes_match FROM ${l.proposta} WHERE ${l.coluna} = $1 ORDER BY usuario_id`, [id])).rows
  const por = Object.fromEntries(ps.map(p => [p.usuario_id, p]))
  return { status: d.status, match: d.match_usuario_id, pro: por[PRO]?.status ?? '(sumiu)', A: por[PA]?.status, B: por[PB]?.status, C: por[PC]?.status, marcadores: ps.filter(p => p.status_antes_match !== null).length }
}
const restaurou = (e) => e.status === 'aberta' && e.match === null && e.A === 'pendente' && e.B === 'contraproposta_dono' && e.C === 'recusado' && e.marcadores === 0

const main = async () => {
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, descricao text, categoria text, categorias text[], valor numeric, valor_estimado numeric, cidade text, bairro text, uf text, estado text, tags text[],
      latitude numeric, longitude numeric, coordenadas_origem text, metragem numeric, prazo_execucao_dias int, ultima_extensao_horas numeric, endereco_obra text, endereco_reparo text, ponto_referencia text,
      criado_por uuid, status text DEFAULT 'aberta', status_aprovacao text DEFAULT 'aprovada', encerrado_em timestamptz, client_request_id text, enviada_por_dono boolean, prazo_timezone text,
      match_usuario_id uuid, match_feito_em timestamptz, expira_em timestamptz, criado_em timestamptz DEFAULT now(), contrato_enviado boolean DEFAULT false, codigo_publico text,
      encerramento_solicitado_por uuid, encerramento_solicitado_em timestamptz, push_novo_enviado_em timestamptz, email_novo_pendente_em timestamptz, aviso_reabertura_em timestamptz,
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
      prazo_atendimento_horas numeric, prazo_modo text, horas_para_expirar numeric, publicado_em timestamptz, valor_aumentado_em timestamptz, valor_aumentos int DEFAULT 0, alerta_enviado_em timestamptz, alerta_prazo_enviado_em timestamptz,
      marco_1_em timestamptz, marco_2_em timestamptz, marco_3_em timestamptz, alerta_sem_interessados_em timestamptz, notif_5min_enviada boolean DEFAULT false, aviso_desinstalou_em timestamptz, escolha_aviso_24h_em timestamptz, escolha_aviso_2h_em timestamptz, escolha_expirou_em timestamptz`
  const colsProposta = (fk) => `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${fk} uuid, usuario_id uuid, status text DEFAULT 'pendente', status_antes_match text, cancelado_por uuid, cancelado_motivo text,
      cancelado_detalhe text, cancelado_em timestamptz, cancelado_acordo boolean DEFAULT false, referencias text, valor_oferta numeric, mensagem_oferta text, valor_proposto numeric, mensagem text, valor_contraproposta numeric, rodada int DEFAULT 0, criado_em timestamptz DEFAULT now()`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text, suspenso_em timestamptz, suspenso_motivo text, desinstalado_em timestamptz, role text, tipo_dono text, tipo_prestador text, cpf_cnpj text,
      cidade text, uf text, anos_experiencia int, tamanho_equipe int, especialidades text[], embaixador boolean DEFAULT false, foto_url text, logradouro text, numero text, telefone text,
      ativo boolean DEFAULT true, bairro text, verificacao_status text DEFAULT 'aprovado', avisos_todas_areas boolean NOT NULL DEFAULT true, latitude numeric, longitude numeric, raio_km_escolhido numeric,
      senha_hash text, google_sub text, plataforma text, push_plataforma text, token_version int NOT NULL DEFAULT 1, referencias jsonb, verificacao_doc_frente_url text, verificacao_doc_verso_url text, verificacao_selfie_url text, criado_em timestamptz DEFAULT now());
    CREATE TABLE assinaturas (usuario_id uuid, status text, tipo text, plano text, valor_mensal numeric, proximo_vencimento timestamptz, atualizado_em timestamptz, criado_em timestamptz DEFAULT now());
    CREATE TABLE midias (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, url text, tipo text, ordem int);
    CREATE TABLE midias_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, url text, tipo text, ordem int);
    CREATE TABLE midias_orfas (url text PRIMARY KEY, tipo text, criado_em timestamptz DEFAULT now());
    CREATE TABLE mensagens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, autor_id uuid, conteudo text);
    CREATE TABLE localizacoes_prestadores (usuario_id uuid, latitude numeric, longitude numeric);
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz DEFAULT now());
    CREATE TABLE contratos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), candidatura_id uuid, interesse_id uuid, status text, valor_acordado numeric, criado_em timestamptz DEFAULT now());
    CREATE TABLE tentativas_contato (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, criado_em timestamptz DEFAULT now());
    CREATE TABLE tentativas_auth (acao text NOT NULL, identificador text NOT NULL, tentativas int NOT NULL DEFAULT 0, janela_em timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (acao, identificador));
    CREATE TABLE push_entregas (tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, ultima_tentativa_em timestamptz DEFAULT now(), primeira_tentativa_em timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE lembretes_push_enviados (tabela text, demanda_id uuid, usuario_id uuid, motivo text, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE avisos_fora_area (tabela text, demanda_id uuid, usuario_id uuid, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE avisos_acima_do_teto (tabela text, demanda_id uuid, usuario_id uuid, criado_em timestamptz NOT NULL DEFAULT now(), resumo_em timestamptz, lembrete boolean NOT NULL DEFAULT false, PRIMARY KEY (tabela, demanda_id, usuario_id));
    CREATE TABLE prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid);
    CREATE TABLE desinstalacoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, detectado_em timestamptz NOT NULL DEFAULT now(), plataforma text, token_prefix text, reinstalado_em timestamptz);
    CREATE TABLE reparos (${colsDemanda});
    CREATE TABLE obras (${colsDemanda});
    CREATE TABLE interesse_reparos (${colsProposta('reparo_id')});
    CREATE TABLE candidaturas (${colsProposta('obra_id')});
    CREATE TABLE perguntas_demanda (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tipo text, demanda_id uuid, autor_id uuid, pergunta text, resposta text, criado_em timestamptz DEFAULT now(), respondido_em timestamptz);
    CREATE TABLE faltas_profissional (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, tabela text, demanda_id uuid, motivo text, criado_em timestamptz DEFAULT now(), perdoada_em timestamptz, perdoada_por uuid);
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE avaliacoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), avaliador_id uuid, avaliado_id uuid, estrelas int);
    SET search_path = public, pg_catalog;
  `)
  const cliente = { query: (s, p) => db.query(s, p) }
  await require(path.join(REPO, 'src/utils/responsabilidade')).migrarResponsabilidade(cliente)

  // reparos.local_atendimento + usuarios.atende_* (utils/localAtendimento) — a mesma migração de boot.

  await require(path.join(REPO, 'src/utils/localAtendimento')).migrarLocalAtendimento({ query: (s, p) => db.query(s, p) })
  await require(path.join(REPO, 'src/utils/especialidadesInferidas')).migrarEspecialidadesInferidas(cliente)
  await require(path.join(REPO, 'src/utils/contasExcluidas')).migrarContasExcluidas(cliente)
  await require(path.join(REPO, 'src/utils/desistencias')).migrarDesistencias(cliente)
  await fixarAgora(0)
  const usr = (id, nome, role, extra = {}) => db.query(
    `INSERT INTO usuarios (id, nome, email, role, tipo_dono, tipo_prestador, cpf_cnpj, push_token, cidade, uf, especialidades, senha_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Uberlândia', 'MG', $9, 'x')`,
    [id, nome, `${id.slice(-3)}@x.invalid`, role, extra.tipo_dono || null, extra.tipo_prestador || null, extra.cpf, tok(id), extra.esp || null])
  await usr(DONO, 'Maria', 'dono_obra', { tipo_dono: 'reparo', cpf: '111' })
  await usr(PRO, 'Giovanna Lima', 'prestador', { tipo_prestador: 'reparador', cpf: '222', esp: ['eletrica', 'pintor'] })
  await usr(PA, 'A', 'prestador', { tipo_prestador: 'reparador', cpf: '333', esp: ['eletrica', 'pintor'] })
  await usr(PB, 'B', 'prestador', { tipo_prestador: 'reparador', cpf: '444', esp: ['eletrica', 'pintor'] })
  await usr(PC, 'C', 'prestador', { tipo_prestador: 'reparador', cpf: '555', esp: ['eletrica', 'pintor'] })
  await usr(ADMIN, 'Admin', 'admin', { cpf: '999' })
  for (const u of [PRO, PA, PB, PC]) await db.query(`INSERT INTO assinaturas (usuario_id, status, tipo, plano, valor_mensal) VALUES ($1, 'ativa', 'gratuito', 'mensal', 49.90)`, [u])

  const det = (tabela, id, quem = DONO) => quieto(() => chamar('get', `/${tabela}/:id`, quem, id))
  const pushesPara = (id) => pushes.filter(p => p.to === tok(id))
  const faltas = async () => (await db.query(`SELECT count(*)::int AS n FROM faltas_profissional WHERE usuario_id = $1`, [PRO])).rows[0].n
  const eventosN = async () => (await db.query(`SELECT count(*)::int AS n FROM eventos_responsabilidade WHERE usuario_id = $1`, [PRO])).rows[0].n
  const TOKEN_PRO = tok(PRO)

  // ═══ 1. Estado inicial: match sem horário, ninguém desinstalou ═════════════════════════════
  const R1 = await cenario('reparos')
  const O1 = await cenario('obras')
  let d = await det('reparos', R1)
  ok(d.status === 200 && d.body.pode_escolher_outro === false && d.body.motivo_escolher_outro === null, 'GET /reparos/:id (dono): pode_escolher_outro false, motivo null — os campos SAEM no payload', { pode: d.body.pode_escolher_outro, motivo: d.body.motivo_escolher_outro })
  d = await det('reparos', R1, PA)
  ok(d.status === 200 && d.body.pode_escolher_outro === null && d.body.motivo_escolher_outro === null, 'profissional lendo o detalhe: null nos dois (só dono)', { pode: d.body.pode_escolher_outro })

  // ═══ 2. Recibo DeviceNotRegistered → desinstalado_em → aviso ao dono + pode_escolher_outro ══
  pushes.length = 0; emails.length = 0
  const m = await marcarDesinstalados([TOKEN_PRO])
  ok(m.removidos === 1 && m.novos === 1, 'marcarDesinstalados: token nulado, desinstalação nova', m)
  // (em produção alertaService chama o aviso logo após marcar; aqui chamamos o mesmo sweep)
  let n = await quieto(() => DE.avisarDonosProfissionalDesinstalou())
  ok(n === 2, 'sweep: 2 avisos (reparo e obra em aberto sem horário)', n)
  const pd = pushesPara(DONO)
  ok(pd.length === 2 && pd.every(p => p.title === 'Giovanna desinstalou o app e pode não ver os avisos') && pd.some(p => p.body === 'Você pode escolher outro profissional para "Serviço 11" sem penalidade, ou esperar.'),
     'dono: push com título "<Nome> desinstalou o app e pode não ver os avisos" e corpo exato', pd.map(p => [p.title, p.body]))
  ok(pd.every(p => p.data?.motivo_escolher_outro === 'desinstalou' && p.data?.escolher_outro === true), 'push data: motivo_escolher_outro desinstalou', pd.map(p => p.data))
  ok(emails.filter(e => e.para === '001@x.invalid').length === 2, 'dono: e-mail junto do push (um por demanda)', emails.map(e => e.para))
  n = await quieto(() => DE.avisarDonosProfissionalDesinstalou())
  ok(n === 0 && pushesPara(DONO).length === 2, 'segundo sweep: nada (uma vez por match — claim aviso_desinstalou_em)', n)
  d = await det('reparos', R1)
  ok(d.body.pode_escolher_outro === true && d.body.motivo_escolher_outro === 'desinstalou', 'GET /reparos/:id: pode_escolher_outro TRUE na hora, motivo desinstalou', { pode: d.body.pode_escolher_outro, motivo: d.body.motivo_escolher_outro })
  d = await det('obras', O1)
  ok(d.body.pode_escolher_outro === true && d.body.motivo_escolher_outro === 'desinstalou', 'GET /obras/:id: idem', { pode: d.body.pode_escolher_outro, motivo: d.body.motivo_escolher_outro })

  // ═══ 3. Horário combinado: sem aviso (fora do escopo) ═══════════════════════════════════════
  const R2 = await cenario('reparos', { chegada_prevista_em: emMin(600), chegada_janela: 'agendado' })
  pushes.length = 0
  n = await quieto(() => DE.avisarDonosProfissionalDesinstalou())
  d = await det('reparos', R2)
  ok(n === 0 && d.body.pode_escolher_outro === false && d.body.motivo_escolher_outro === null, 'com horário combinado: nenhum aviso e pode_escolher_outro false', { n, pode: d.body.pode_escolher_outro })

  // ═══ 4. Reinstalou → volta à regra normal ══════════════════════════════════════════════════
  await registrarReinstalacao(PRO)
  d = await det('reparos', R1)
  ok(d.body.pode_escolher_outro === false && d.body.motivo_escolher_outro === null, 'reinstalou (desinstalado_em NULL): pode_escolher_outro volta a false', { pode: d.body.pode_escolher_outro })
  await db.query(`UPDATE reparos SET lembrete_agendar_sem_proposta = 2 WHERE id = $1`, [R1])
  d = await det('reparos', R1)
  ok(d.body.pode_escolher_outro === true && d.body.motivo_escolher_outro === 'avisos_ignorados', 'regra dos 2 lembretes: motivo avisos_ignorados', { motivo: d.body.motivo_escolher_outro })
  await db.query(`UPDATE usuarios SET desinstalado_em = now() WHERE id = $1`, [PRO])
  d = await det('reparos', R1)
  ok(d.body.motivo_escolher_outro === 'desinstalou', 'lembretes ignorados E desinstalou: vale desinstalou (sem penalidade)', { motivo: d.body.motivo_escolher_outro })
  await db.query(`UPDATE reparos SET lembrete_agendar_sem_proposta = 0 WHERE id = $1`, [R1])

  // ═══ 5. Escolher outro com motivo desinstalou: restaura, SEM falta/evento ══════════════════
  pushes.length = 0; emails.length = 0
  const f0 = await faltas(), e0 = await eventosN()
  let r = await quieto(() => chamar('post', '/reparos/dono/:id/escolher-outro', DONO, R1))
  let e = await estado('reparos', R1)
  ok(r.status === 200 && r.body.motivo_escolher_outro === 'desinstalou' && restaurou(e) && e.pro === 'cancelado', 'POST escolher-outro (desinstalou): 200, A/B restaurados, proposta do escolhido cancelada', { status: r.status, corpo: r.body, ...e })
  ok(await faltas() === f0 && await eventosN() === e0, 'SEM falta e SEM compromisso_nao_cumprido para o profissional', { faltas: await faltas(), eventos: await eventosN() })
  const prop = (await db.query(`SELECT cancelado_motivo, cancelado_detalhe FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2`, [R1, PRO])).rows[0]
  ok(prop.cancelado_motivo === 'escolheu_outro' && prop.cancelado_detalhe === 'desinstalou', 'proposta: cancelado_motivo escolheu_outro, cancelado_detalhe desinstalou', prop)
  ok(pushesPara(PRO).length === 0, 'profissional sem token (desinstalou): nenhum push a ele')
  // Trocar de profissional (13/11/2026): sem penalidade o aviso ao profissional é UM push neutro, sem e-mail.
  const ePro = emails.filter(x => x.para === '002@x.invalid')
  ok(ePro.length === 0, 'profissional sem penalidade: só o push neutro (sem token aqui), nenhum e-mail', ePro.map(x => x.assunto))
  ok(pushesPara(PA).length === 0 && pushesPara(PB).length === 0, 'interessados: nada direto do escolher-outro (o aviso é do cron de reabertura)')
  await quieto(() => A.avisarReabertura('reparos'))
  const neutro = (p) => p.title === '🔔 Pedido disponível de novo' && p.body === '"Serviço 11" está aberto e sua proposta continua valendo — o cliente pode escolher você.'
    && JSON.stringify(p.data) === JSON.stringify({ tipo: 'novo_reparo', reaberta: true, reparo_id: R1 })
  ok(pushesPara(PA).length === 1 && neutro(pushesPara(PA)[0]) && pushesPara(PB).length === 1 && neutro(pushesPara(PB)[0]),
     'cron de reabertura: A e B recebem o aviso NEUTRO (sem "desinstalou", sem quem/por quê)', [...pushesPara(PA), ...pushesPara(PB)].map(p => [p.title, p.body]))
  ok(!emails.some(x => x.para === '002@x.invalid' && /Pedido disponível de novo/.test(x.assunto || '')), 'o profissional que perdeu o match não recebe o aviso de reabertura')
  ok(pushesPara(DONO).some(p => p.title === 'Pedido reaberto'), 'dono: "Pedido reaberto"')

  // ═══ 6. Escolher outro pela regra dos lembretes continua COM falta/evento ═══════════════════
  await db.query(`UPDATE usuarios SET desinstalado_em = NULL WHERE id = $1`, [PRO])
  const R3 = await cenario('reparos', { lembrete_agendar_sem_proposta: 2 })
  r = await quieto(() => chamar('post', '/reparos/dono/:id/escolher-outro', DONO, R3))
  e = await estado('reparos', R3)
  ok(r.status === 200 && r.body.motivo_escolher_outro === 'avisos_ignorados' && restaurou(e) && await faltas() === f0 + 1 && await eventosN() === e0 + 1,
     'escolher-outro por avisos_ignorados: restaura E registra falta + compromisso_nao_cumprido (regra antiga intacta)', { status: r.status, motivo: r.body.motivo_escolher_outro, faltas: await faltas(), eventos: await eventosN() })

  // ═══ 7. Match novo zera o claim do aviso ════════════════════════════════════════════════════
  const { SQL_ZERAR_AGENDA } = require(path.join(REPO, 'src/utils/agendamento'))
  ok(/aviso_desinstalou_em = NULL/.test(SQL_ZERAR_AGENDA), 'SQL_ZERAR_AGENDA zera aviso_desinstalou_em (match novo → aviso de novo se o novo escolhido também desinstalar)')

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
