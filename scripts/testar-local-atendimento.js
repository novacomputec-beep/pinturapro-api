#!/usr/bin/env node
// ONDE O SERVIÇO ACONTECE (dono, 12/11/2026 — utils/localAtendimento): reparos.local_atendimento
// ('casa_cliente' | 'local_profissional' | 'tanto_faz' | NULL), aceito só nas categorias de
// CATEGORIAS_LOCAL_ATENDIMENTO, e usuarios.atende_casa_cliente / atende_local_proprio (DEFAULT true,
// os dois false → 400). Filtro: casa_cliente tira quem não atende na casa do cliente;
// local_profissional tira quem não atende no próprio local; tanto_faz/NULL não filtra. Conferido no
// create/edit, no perfil, no feed e no detalhe e em todo alcance por reparo: push e e-mail de demanda
// nova, e-mail do lembrete "ainda aberto", reanúncio e aviso de reabertura.
// SQL REAL em PGlite; rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-local-atendimento.js
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
const erros = []
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? (...a) => erros.push(a.map(x => x?.message || String(x)).join(' ').slice(0, 300)) : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const A = require(path.join(REPO, 'src/services/alertaService'))
const CM = require(path.join(REPO, 'src/services/cancelamentoMatchService'))
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
const DONO = U(1), PRO = U(2), PA = U(3), PB = U(4), PC = U(5), ADMIN = U(9), PA2 = U(6)
const ROLE = { [DONO]: 'dono_obra', [ADMIN]: 'admin' }
const rota = (metodo, caminho) => router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo]).route
const handlerDe = (metodo, caminho) => rota(metodo, caminho).stack[rota(metodo, caminho).stack.length - 1].handle
const chamar = (metodo, caminho, usuarioId, id, body = {}, query = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handlerDe(metodo, caminho)({ params: { id }, body, query, usuario: { id: usuarioId, role: ROLE[usuarioId] || 'prestador', tipo_prestador: ROLE[usuarioId] ? null : 'reparador' }, get() { return '' } }, res)
})
const quieto = async (fn) => { silenciar(true); try { return await fn() } finally { await assentar(); silenciar(false) } }

const LADO = {
  reparos: { proposta: 'interesse_reparos', coluna: 'reparo_id', chave: 'reparo_id', tipo: 'novo_reparo' },
  obras:   { proposta: 'candidaturas',      coluna: 'obra_id',   chave: 'obra_id',   tipo: 'nova_obra' },
}
let seq = 10
const titulos = {}
// Demanda ABERTA com match = PRO e três concorrentes: A rebaixado de 'pendente', B rebaixado de
// 'contraproposta_dono', C recusado explicitamente pelo dono (sem marcador).
const cenario = async (tabela, extra = {}) => {
  const id = D(seq++)
  titulos[id] = tabela === 'reparos' ? `Serviço ${seq}` : `Obra ${seq}`
  const cols = Object.keys(extra)
  const base = tabela === 'reparos'
    ? `titulo, categoria, categorias, criado_por, valor_estimado, prazo_atendimento_horas, cidade, uf, bairro, publicado_em, push_novo_enviado_em, match_usuario_id, match_feito_em, expira_em`
    : `titulo, categoria, criado_por, valor, horas_para_expirar, cidade, uf, bairro, publicado_em, push_novo_enviado_em, match_usuario_id, match_feito_em, expira_em`
  const vals = tabela === 'reparos'
    ? `$6, 'eletrica', '{eletrica}', $2, 150, 72, 'Uberlândia', 'MG', 'Centro', now() - INTERVAL '1 day', now() - INTERVAL '1 day', $3, COALESCE($4::timestamptz, now() - INTERVAL '2 hours'), COALESCE($5::timestamptz, now() + INTERVAL '2 days')`
    : `$6, 'residencial', $2, 3000, 480, 'Uberlândia', 'MG', 'Centro', now() - INTERVAL '1 day', now() - INTERVAL '1 day', $3, COALESCE($4::timestamptz, now() - INTERVAL '2 hours'), COALESCE($5::timestamptz, now() + INTERVAL '2 days')`
  const params = [id, DONO, PRO, extra.match_feito_em || null, extra.expira_em || null, titulos[id]]
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
const marcado = async (tabela, id) => (await db.query(`SELECT aviso_reabertura_em FROM ${tabela} WHERE id = $1`, [id])).rows[0].aviso_reabertura_em !== null
const TITULO = '🔔 Pedido disponível de novo'
const corpo = (id) => `"${titulos[id]}" está aberto e sua proposta continua valendo — o cliente pode escolher você.`
const REVELA = /reabriu|escolhido|desist|cancel|desinstal|saiu|não marcou|falta|vez(es)?\b/i
const pushesDe = (u, desde) => pushes.slice(desde).filter(p => p.to === tok(u))
const emailsDe = (u, desde) => emails.slice(desde).filter(e => e.para === `${u.slice(-3)}@x.invalid`)
const igualData = (a, b) => JSON.stringify(Object.keys(a).sort().map(k => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map(k => [k, b[k]]))

// Roda o caminho, confere que NADA foi aos interessados na hora (só a marca), roda o cron e confere o aviso neutro.
// O teto diário (15 pushes de demanda por pessoa) é testado à parte: cada cenário começa com ele zerado.
const zerarTeto = () => db.query(`DELETE FROM lembretes_push_enviados`)
const conferir = async (tabela, id, rotulo, acao, { cronJaAvisa = false } = {}) => {
  await zerarTeto()
  const p0 = pushes.length, e0 = emails.length
  const r = await quieto(acao)
  if (r && r.status !== undefined && r.status !== 200) { ok(false, `${rotulo}: caminho respondeu 200`, { status: r.status, corpo: r.body }); return }
  // O profissional que perdeu o match recebe o aviso DELE (fora do escopo daqui); os interessados, nada.
  const interessados = [PA, PB, PC]
  if (!cronJaAvisa) {
    ok(await marcado(tabela, id), `${rotulo}: aviso_reabertura_em marcado no un-match`)
    const naHora = interessados.flatMap(u => pushesDe(u, p0).map(p => p.title))
    ok(!naHora.some(t => t === TITULO || REVELA.test(t)) && ![PA, PB, PC].some(u => pushesDe(u, p0).length > 0),
       `${rotulo}: nada aos interessados direto do caminho`, naHora)
    await quieto(() => A.avisarReabertura(tabela))
  }
  const esperado = { tipo: LADO[tabela].tipo, reaberta: true, [LADO[tabela].chave]: id }
  for (const u of [PA, PB]) {
    const ps = pushesDe(u, p0).filter(p => p.title === TITULO)
    const es = emailsDe(u, e0).filter(e => e.assunto === TITULO)
    ok(ps.length === 1 && ps[0].body === corpo(id) && igualData(ps[0].data, esperado) && es.length === 1 && String(es[0].texto).includes(corpo(id)),
       `${rotulo}: ${u === PA ? 'A' : 'B'} recebe o aviso neutro (push exato + e-mail)`, { push: ps.map(p => [p.body, p.data]), emails: es.length })
  }
  const textos = [PA, PB].flatMap(u => [...pushesDe(u, p0).map(p => `${p.title} ${p.body}`), ...emailsDe(u, e0).map(e => `${e.assunto} ${e.texto}`)])
  ok(!textos.some(t => REVELA.test(t.replace(/Olá,[^\n]*\n/, ''))), `${rotulo}: nenhum texto aos interessados diz quem/por quê/quantas vezes`, textos.filter(t => REVELA.test(t)).slice(0, 2))
  ok(!pushesDe(PC, p0).some(p => p.title === TITULO) && !emailsDe(PC, e0).some(e => e.assunto === TITULO), `${rotulo}: C (recusa explícita do dono) não recebe`)
  ok(!pushesDe(PRO, p0).some(p => p.title === TITULO) && !emailsDe(PRO, e0).some(e => e.assunto === TITULO), `${rotulo}: o profissional que perdeu o match não recebe`)
  ok(!(await marcado(tabela, id)), `${rotulo}: claim limpo depois do aviso`)
}

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
      lembrete_agendar_enviados int NOT NULL DEFAULT 0, desfazer_aviso_em timestamptz, aviso_desinstalou_em timestamptz,
      lembrete_agendar_sem_proposta int NOT NULL DEFAULT 0, horario_vencido_em timestamptz, horarios_vencidos int NOT NULL DEFAULT 0,
      chegada_proposta_em timestamptz, lembrete_resposta_1h_em timestamptz, lembrete_resposta_antes_em timestamptz, lembrete_resposta_ultimo_em timestamptz, lembrete_resposta_ciclo int DEFAULT 0,
      sugestoes_horario_dono int DEFAULT 0, sugestoes_horario_profissional int DEFAULT 0, prazo_chegada_extra_em timestamptz, aviso_atraso_enviado_em timestamptz,
      pedido_atraso_minutos int, pedido_atraso_motivo text, pedido_atraso_em timestamptz, pedido_atraso_status text, pedido_atraso_respondido_em timestamptz,
      pedidos_atraso_usados int DEFAULT 0, cancelamento_pedido_por uuid, cancelamento_pedido_motivo text, cancelamento_pedido_detalhe text,
      cancelamento_pedido_em timestamptz, cancelamento_pedido_expira_em timestamptz, prestadores_bloqueados uuid[],
      prazo_atendimento_horas numeric, prazo_modo text, horas_para_expirar numeric, publicado_em timestamptz, valor_aumentado_em timestamptz, valor_aumentos int DEFAULT 0, alerta_enviado_em timestamptz, alerta_prazo_enviado_em timestamptz,
      marco_1_em timestamptz, marco_2_em timestamptz, marco_3_em timestamptz, alerta_sem_interessados_em timestamptz, notif_5min_enviada boolean DEFAULT false, escolha_aviso_24h_em timestamptz, escolha_aviso_2h_em timestamptz, escolha_expirou_em timestamptz`
  const colsProposta = (fk) => `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${fk} uuid, usuario_id uuid, status text DEFAULT 'pendente', status_antes_match text, cancelado_por uuid, cancelado_motivo text,
      cancelado_detalhe text, cancelado_em timestamptz, cancelado_acordo boolean DEFAULT false, referencias text, valor_oferta numeric, mensagem_oferta text, valor_proposto numeric, mensagem text, valor_contraproposta numeric, rodada int DEFAULT 0, criado_em timestamptz DEFAULT now()`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text, suspenso_em timestamptz, suspenso_motivo text, desinstalado_em timestamptz, role text, tipo_dono text, tipo_prestador text, cpf_cnpj text,
      cidade text, uf text, anos_experiencia int, tamanho_equipe int, especialidades text[], embaixador boolean DEFAULT false, foto_url text, logradouro text, numero text, telefone text,
      ativo boolean DEFAULT true, bairro text, verificacao_status text DEFAULT 'aprovado', avisos_todas_areas boolean NOT NULL DEFAULT true, latitude numeric, longitude numeric, raio_km_escolhido numeric,
      senha_hash text, google_sub text, token_version int NOT NULL DEFAULT 1, referencias jsonb, verificacao_doc_frente_url text, verificacao_doc_verso_url text, verificacao_selfie_url text, criado_em timestamptz DEFAULT now());
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
    `INSERT INTO usuarios (id, nome, email, role, tipo_dono, tipo_prestador, cpf_cnpj, push_token, cidade, uf, especialidades, senha_hash, avisos_todas_areas, atende_casa_cliente, atende_local_proprio)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Uberlândia', 'MG', $9, 'x', false, $10, $11)`,
    [id, nome, `${id.slice(-3)}@x.invalid`, role, extra.tipo_dono || null, extra.tipo_prestador || null, extra.cpf, tok(id), extra.esp || null,
     extra.casa !== false, extra.proprio !== false])
  // Três manicures: AMBOS (default), SO_CASA (atende_local_proprio = false), SO_LOCAL (atende_casa_cliente = false).
  const AMBOS = U(21), SO_CASA = U(22), SO_LOCAL = U(23), ELETRICISTA = U(24)
  await usr(DONO, 'Maria', 'dono_obra', { tipo_dono: 'reparo', cpf: '111' })
  await usr(PRO, 'Giovanna', 'prestador', { tipo_prestador: 'reparador', cpf: '222', esp: ['manicure'] })
  await usr(AMBOS, 'Ana Ambos', 'prestador', { tipo_prestador: 'reparador', cpf: '321', esp: ['manicure', 'eletrica'] })
  await usr(SO_CASA, 'Bia Casa', 'prestador', { tipo_prestador: 'reparador', cpf: '322', esp: ['manicure', 'eletrica'], proprio: false })
  await usr(SO_LOCAL, 'Cris Local', 'prestador', { tipo_prestador: 'reparador', cpf: '323', esp: ['manicure', 'eletrica'], casa: false })
  await usr(ELETRICISTA, 'Edu', 'prestador', { tipo_prestador: 'reparador', cpf: '324', esp: ['eletrica'] })
  for (const u of [PRO, AMBOS, SO_CASA, SO_LOCAL, ELETRICISTA]) await db.query(`INSERT INTO assinaturas (usuario_id, status, tipo, plano, valor_mensal) VALUES ($1, 'ativa', 'gratuito', 'mensal', 49.90)`, [u])
  // Índice parcial do retry idempotente do POST /reparos/dono (o ON CONFLICT da rota o exige) e id com default.
  await db.exec(`CREATE UNIQUE INDEX reparos_criado_por_client_request_idx ON reparos (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
                 ALTER TABLE reparos ALTER COLUMN id SET DEFAULT gen_random_uuid();
                 ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS boas_vindas_exibida boolean DEFAULT false;
                 ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS aceita_promocoes boolean NOT NULL DEFAULT true;`)
  // Erro de SQL que um catch da rota engole (500 genérico) fica registrado para o "nenhum erro logado".
  const consultar = db.query.bind(db)
  db.query = async (s, p) => { try { return await consultar(s, p) } catch (e) { erros.push(`SQL: ${e.message}`); throw e } }
  const LA = require(path.join(REPO, 'src/utils/localAtendimento'))
  const authCtrl = require(path.join(REPO, 'src/controllers/authController'))
  const chamarCtrl = (fn, usuarioId, body = {}) => new Promise(resolve => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
    Promise.resolve(fn({ body, params: {}, query: {}, headers: {}, usuario: { id: usuarioId, role: 'prestador', tipo_prestador: 'reparador' }, get() { return '' } }, res)).catch(e => resolve({ status: 599, body: { erro: e.message } }))
  })
  const TRES = [AMBOS, SO_CASA, SO_LOCAL]
  const nome = { [AMBOS]: 'AMBOS', [SO_CASA]: 'SO_CASA', [SO_LOCAL]: 'SO_LOCAL', [ELETRICISTA]: 'ELETRICISTA' }
  const quem = (lista) => lista.map(u => nome[u]).sort().join(',')
  const alcancados = (p0, e0, demandaId, chave = 'reparo_id') => ({
    push: quem(TRES.filter(u => pushes.slice(p0).some(p => p.to === tok(u) && p.data?.[chave] === demandaId))),
    email: quem(TRES.filter(u => emails.slice(e0).some(e => e.para === `${u.slice(-3)}@x.invalid`))),
  })
  const ESPERADO = { casa_cliente: 'AMBOS,SO_CASA', local_profissional: 'AMBOS,SO_LOCAL', tanto_faz: 'AMBOS,SO_CASA,SO_LOCAL', null: 'AMBOS,SO_CASA,SO_LOCAL' }
  let n = 100
  const reparoManicure = async (local, extra = {}) => {
    const id = D(n++)
    await db.query(`INSERT INTO reparos (id, titulo, categoria, categorias, criado_por, valor_estimado, prazo_atendimento_horas, cidade, uf, bairro, publicado_em, push_novo_enviado_em, expira_em, local_atendimento, codigo_publico)
      VALUES ($1, $2, 'manicure', '{manicure}', $3, 80, 72, 'Uberlândia', 'MG', 'Centro', now(), now(), now() + INTERVAL '2 days', $4, NULL)`, [id, `Unhas ${n}`, DONO, local])
    return id
  }

  // ═══ 1. Constante e normalização ═══════════════════════════════════════════════════════════
  const slugsServico = new Set(require(path.join(REPO, 'src/utils/categoriasApp')).CATEGORIAS_SERVICO.map(c => c.slug))
  ok(LA.CATEGORIAS_LOCAL_ATENDIMENTO.length === 10 && LA.CATEGORIAS_LOCAL_ATENDIMENTO.every(s => slugsServico.has(s)),
     'CATEGORIAS_LOCAL_ATENDIMENTO: 10 slugs, todos existentes em CATEGORIAS_SERVICO', LA.CATEGORIAS_LOCAL_ATENDIMENTO)
  ok(LA.normalizarLocalAtendimento('casa_cliente', ['manicure']).valor === 'casa_cliente', 'manicure + casa_cliente → aceito')
  ok(LA.normalizarLocalAtendimento('casa_cliente', ['eletrica', 'pet']).valor === 'casa_cliente', 'qualquer categoria da lista basta (eletrica + pet)')
  ok(LA.normalizarLocalAtendimento('casa_cliente', ['eletrica']).valor === null, 'eletrica + casa_cliente → ignorado (NULL)')
  ok(LA.normalizarLocalAtendimento('xyz', ['eletrica']).valor === null && !LA.normalizarLocalAtendimento('xyz', ['eletrica']).erro, 'categoria fora da lista: valor inválido é só ignorado')
  ok(!!LA.normalizarLocalAtendimento('xyz', ['cabelo']).erro, 'categoria da lista + valor inválido → erro')
  ok(LA.normalizarLocalAtendimento(undefined, ['cabelo']).valor === null, 'ausente (app antigo) → NULL')

  // ═══ 2. Create e edit ═════════════════════════════════════════════════════════════════════
  const criar = (body) => quieto(() => chamar('post', '/reparos/dono', DONO, undefined, { titulo: 'Fazer as unhas', descricao: 'pé e mão', valor_estimado: 80, cidade: 'Uberlândia', uf: 'MG', tera_midias: true, ...body }))
  let r = await criar({ categorias: ['manicure'], local_atendimento: 'casa_cliente' })
  ok(r.status === 201 && r.body.local_atendimento === 'casa_cliente', 'POST /reparos/dono manicure + casa_cliente → gravado', { status: r.status, local: r.body?.local_atendimento, erro: r.body?.erro })
  const criado = r.body?.id
  r = await criar({ categorias: ['eletrica'], local_atendimento: 'casa_cliente' })
  ok(r.status === 201 && r.body.local_atendimento === null, 'POST eletrica + casa_cliente → ignorado (NULL)', { status: r.status, local: r.body?.local_atendimento })
  r = await criar({ categorias: ['cabelo'], local_atendimento: 'na_lua' })
  ok(r.status === 400 && /local_atendimento/.test(r.body.erro), 'POST cabelo + valor inválido → 400', r.body)
  r = await criar({ categorias: ['cabelo'] })
  ok(r.status === 201 && r.body.local_atendimento === null, 'POST sem o campo (app antigo) → NULL', { local: r.body?.local_atendimento })
  if (criado) {
    r = await quieto(() => chamar('patch', '/reparos/dono/:id/categorias', DONO, criado, { categorias: ['manicure', 'pet'] }))
    ok(r.status === 200 && r.body.local_atendimento === 'casa_cliente', 'PATCH categorias sem a chave: mantém o local gravado', r.body)
    r = await quieto(() => chamar('patch', '/reparos/dono/:id/categorias', DONO, criado, { categorias: ['manicure'], local_atendimento: 'local_profissional' }))
    ok(r.status === 200 && r.body.local_atendimento === 'local_profissional', 'PATCH com local_profissional → trocado', r.body)
    r = await quieto(() => chamar('patch', '/reparos/dono/:id/categorias', DONO, criado, { categorias: ['manicure'], local_atendimento: 'x' }))
    ok(r.status === 400, 'PATCH com valor inválido → 400', r.body)
    r = await quieto(() => chamar('patch', '/reparos/dono/:id/categorias', DONO, criado, { categorias: ['eletrica'] }))
    ok(r.status === 200 && r.body.local_atendimento === null, 'PATCH para categoria fora da lista → zera (NULL)', r.body)
  }

  // ═══ 3. Perfil ════════════════════════════════════════════════════════════════════════════
  silenciar(true); r = await chamarCtrl(authCtrl.perfil, AMBOS); silenciar(false)
  ok(r.status === 200 && r.body.usuario?.atende_casa_cliente === true && r.body.usuario?.atende_local_proprio === true, 'GET /auth/perfil: os dois booleanos (default true)', { status: r.status, erro: r.body?.erro, casa: r.body?.usuario?.atende_casa_cliente, ultimoErro: erros.slice(-2) })
  r = await chamarCtrl(authCtrl.atualizarPerfil, ELETRICISTA, { atende_casa_cliente: false })
  ok(r.status === 200 && r.body.atende_casa_cliente === false && r.body.atende_local_proprio === true, 'PUT /auth/perfil atende_casa_cliente=false → salvo e devolvido', r.body)
  r = await chamarCtrl(authCtrl.atualizarPerfil, ELETRICISTA, { atende_local_proprio: false })
  ok(r.status === 400 && r.body.codigo === 'LOCAL_ATENDIMENTO_OBRIGATORIO', 'PUT só atende_local_proprio=false com o outro já false → 400', r.body)
  r = await chamarCtrl(authCtrl.atualizarPerfil, ELETRICISTA, { atende_casa_cliente: false, atende_local_proprio: false })
  ok(r.status === 400, 'PUT os dois false → 400', r.body)
  r = await chamarCtrl(authCtrl.atualizarPerfil, ELETRICISTA, { atende_casa_cliente: 'nao' })
  ok(r.status === 400, 'PUT valor não booleano → 400', r.body)
  r = await chamarCtrl(authCtrl.atualizarPerfil, ELETRICISTA, { atende_casa_cliente: true, atende_local_proprio: false })
  ok(r.status === 200 && r.body.atende_casa_cliente === true && r.body.atende_local_proprio === false, 'PUT troca os dois juntos (um true) → ok', r.body)
  await db.query(`UPDATE usuarios SET atende_casa_cliente = true, atende_local_proprio = true WHERE id = $1`, [ELETRICISTA])

  // ═══ 4. Feed ══════════════════════════════════════════════════════════════════════════════
  const ids = {}
  for (const local of ['casa_cliente', 'local_profissional', 'tanto_faz', null]) ids[local] = await reparoManicure(local)
  for (const u of TRES) {
    const f = await quieto(() => chamar('get', '/reparos', u, undefined, {}, {}))
    const vistos = Object.entries(ids).filter(([, id]) => (f.body?.reparos || []).some(x => x.id === id)).map(([l]) => l).sort().join(',')
    const esperado = Object.keys(ids).filter(l => ESPERADO[l].split(',').includes(nome[u])).sort().join(',')
    ok(f.status === 200 && vistos === esperado, `feed de ${nome[u]}: vê ${esperado}`, { vistos, status: f.status, erro: f.body?.erro })
  }
  const f0 = await quieto(() => chamar('get', '/reparos', AMBOS, undefined, {}, {}))
  ok((f0.body?.reparos || []).find(x => x.id === ids.casa_cliente)?.local_atendimento === 'casa_cliente', 'feed devolve local_atendimento')
  const det = await quieto(() => chamar('get', '/reparos/:id', AMBOS, ids.local_profissional))
  ok(det.status === 200 && det.body.reparo?.local_atendimento === 'local_profissional', 'detalhe (GET /reparos/:id → reparo) devolve local_atendimento', { status: det.status, local: det.body?.reparo?.local_atendimento })

  // ═══ 5. Push e e-mail de demanda nova, lembrete, reanúncio e reabertura ═══════════════════
  for (const local of ['casa_cliente', 'local_profissional', 'tanto_faz', null]) {
    const rotulo = local ?? 'NULL'
    let id = await reparoManicure(local)
    let p0 = pushes.length, e0 = emails.length
    await quieto(() => A.notificarPrestadoresSobreNovoReparo(id))
    let a = alcancados(p0, e0, id)
    ok(a.push === ESPERADO[local], `${rotulo}: push de demanda nova → ${ESPERADO[local]}`, a)
    await quieto(() => A.enviarEmailsNovaDemanda('reparos', id))
    a = alcancados(p0, e0, id)
    ok(a.email === ESPERADO[local], `${rotulo}: e-mail de demanda nova → ${ESPERADO[local]}`, a)
    // Lembrete "ainda aberto" (mesmo e-mail, override do lembrete) — e-mail só a quem não tem token: tira os tokens.
    const ladoLembrete = A.LADOS_LEMBRETE.find(l => l.tabela === 'reparos')
    await db.query(`UPDATE usuarios SET push_token = NULL WHERE id = ANY($1::uuid[])`, [TRES])
    e0 = emails.length
    await quieto(() => A.enviarEmailsNovaDemanda('reparos', id, { tipo: `${ladoLembrete.tipoEmail}#1`, mensagem: ladoLembrete.mensagem, interesse: ladoLembrete.interesse, somenteSemToken: true }))
    a = alcancados(pushes.length, e0, id)
    ok(a.email === ESPERADO[local], `${rotulo}: e-mail do lembrete "ainda aberto" → ${ESPERADO[local]}`, a)
    for (const u of TRES) await db.query(`UPDATE usuarios SET push_token = $2 WHERE id = $1`, [u, tok(u)])
    // Reanúncio (match desfeito): push + e-mail a quem não se manifestou.
    await db.query(`DELETE FROM lembretes_push_enviados`)
    p0 = pushes.length; e0 = emails.length
    await quieto(() => A.reanunciarDemanda('reparos', id))
    a = alcancados(p0, e0, id)
    ok(a.push === ESPERADO[local] && a.email === ESPERADO[local], `${rotulo}: reanúncio (push + e-mail) → ${ESPERADO[local]}`, a)
    // Reabertura: os três com proposta valendo; aviso só a quem atende no local pedido.
    id = await reparoManicure(local)
    for (const u of TRES) await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status) VALUES ($1, $2, 'pendente')`, [id, u])
    await db.query(`UPDATE reparos SET aviso_reabertura_em = now() WHERE id = $1`, [id])
    await db.query(`DELETE FROM lembretes_push_enviados`)
    p0 = pushes.length; e0 = emails.length
    await quieto(() => A.avisarReabertura('reparos'))
    a = alcancados(p0, e0, id)
    ok(a.push === ESPERADO[local] && a.email === ESPERADO[local], `${rotulo}: aviso de reabertura → ${ESPERADO[local]}`, a)
  }
  // Obras nunca filtram (a coluna é só de reparos).
  ok(LA.sqlAtendeLocalDaDemanda('obras', '$1') === 'true', 'obras: predicado sempre verdadeiro')

  const errosReais = erros.filter(e => !/sem banco/.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
