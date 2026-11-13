#!/usr/bin/env node
// CAIXA-PRETA DOS PEDIDOS (dono, 13/11/2026 — utils/auditoriaDemanda): trigger AFTER UPDATE em reparos/obras
// (status, status_aprovacao, match_usuario_id, match_feito_em, expira_em, cancelamento_pedido_*) e nos interesses
// (status) grava eventos_demanda com origem/rota/usuário lidos de set_config local à transação. Rota (com e sem
// transação do código), job (agendador e semSobreposicao) e SQL solto deixam linha ('desconhecida' sem origem);
// falha do evento não derruba o UPDATE; GET /admin/demandas/:codigo/linha-do-tempo. SQL REAL em PGlite.
//   npm i -D @electric-sql/pglite && node scripts/testar-caixa-preta.js
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
    `INSERT INTO usuarios (id, nome, email, role, tipo_dono, tipo_prestador, cpf_cnpj, push_token, cidade, uf, especialidades, senha_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Uberlândia', 'MG', $9, 'x')`,
    [id, nome, `${id.slice(-3)}@x.invalid`, role, extra.tipo_dono || null, extra.tipo_prestador || null, extra.cpf, extra.semToken ? null : tok(id), extra.esp || null])
  await usr(DONO, 'Maria', 'dono_obra', { tipo_dono: 'reparo', cpf: '111' })
  await usr(PRO, 'Giovanna Lima', 'prestador', { tipo_prestador: 'reparador', cpf: '222', esp: ['eletrica', 'pintor'] })
  await usr(PA, 'Ana', 'prestador', { tipo_prestador: 'reparador', cpf: '333', esp: ['eletrica', 'pintor'] })
  await usr(PB, 'Beto', 'prestador', { tipo_prestador: 'reparador', cpf: '444', esp: ['eletrica', 'pintor'] })
  await usr(PC, 'Caio', 'prestador', { tipo_prestador: 'reparador', cpf: '555', esp: ['eletrica', 'pintor'] })
  await usr(ADMIN, 'Admin', 'admin', { cpf: '999' })
  for (const u of [PRO, PA, PB, PC]) await db.query(`INSERT INTO assinaturas (usuario_id, status, tipo, plano, valor_mensal) VALUES ($1, 'ativa', 'gratuito', 'mensal', 49.90)`, [u])

  const AUD = require(path.join(REPO, 'src/utils/auditoriaDemanda'))
  await AUD.migrarEventosDemanda(cliente)
  await AUD.migrarEventosDemanda(cliente) // boot repetido: idempotente (sem trigger em dobro)
  // O pool do app é instrumentado em utils/supabase; aqui o shim faz o papel dele.
  AUD.instrumentarPool(shim)
  // Rota como o Express a vê: middleware da caixa-preta → handler, com req.route/baseUrl/method.
  const viaRota = (metodo, caminho, usuarioId, id, body = {}, query = {}) => new Promise(resolve => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
    const req = { method: metodo.toUpperCase(), baseUrl: '/api', route: { path: caminho }, originalUrl: `/api${caminho}`, params: { id, codigo: id }, body, query,
      usuario: { id: usuarioId, role: ROLE[usuarioId] || 'prestador', tipo_prestador: ROLE[usuarioId] ? null : 'reparador' }, get() { return '' } }
    AUD.middlewareAuditoria(req, res, () => handlerDe(metodo, caminho)(req, res))
  })
  const eventos = async (id) => (await db.query(`SELECT campo, valor_antes, valor_depois, origem, rota, usuario_id FROM eventos_demanda WHERE demanda_id = $1 ORDER BY id`, [id])).rows
  const ev = (lista, campo) => lista.filter(e => e.campo === campo)

  // 1) Rota sem transação própria (pool.query): DELETE /reparos/dono/:id de um reparo aberto sem match.
  const R1 = D(201)
  await db.query(`INSERT INTO reparos (id, codigo_publico, titulo, categoria, criado_por, valor_estimado, cidade, uf, status, expira_em) VALUES ($1, 'CXP01', 'Pintar muro', 'eletrica', $2, 100, 'Uberlândia', 'MG', 'aberta', now() + INTERVAL '2 days')`, [R1, DONO])
  let r = await quieto(() => viaRota('delete', '/reparos/dono/:id', DONO, R1))
  let e1 = await eventos(R1)
  ok(r.status === 200 && ev(e1, 'status').length === 1 && ev(e1, 'status')[0].valor_antes === 'aberta' && ev(e1, 'status')[0].valor_depois === 'cancelada',
     'rota (pool.query): status aberta → cancelada registrado', e1)
  ok(e1.every(e => e.origem === 'rota' && e.rota === 'DELETE /api/reparos/dono/:id' && e.usuario_id === DONO), 'rota: origem "rota", método + caminho, usuário do token', e1.map(e => [e.campo, e.origem, e.rota, e.usuario_id]))
  ok(ev(e1, 'status_aprovacao').length === 1 && ev(e1, 'encerrado_em').length === 0, 'só os campos auditados (status_aprovacao sim; encerrado_em não)', e1.map(e => e.campo))

  // 2) Rota COM transação do código (client BEGIN … COMMIT): dono encerra pelo cancelar-match.
  const R2 = D(202)
  await db.query(`INSERT INTO reparos (id, codigo_publico, titulo, categoria, criado_por, valor_estimado, cidade, uf, status, match_usuario_id, match_feito_em, expira_em) VALUES ($1, 'CXP02', 'Trocar tomada', 'eletrica', $2, 100, 'Uberlândia', 'MG', 'aberta', $3, now() - INTERVAL '1 hour', now() + INTERVAL '2 days')`, [R2, DONO, PRO])
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status) VALUES ($1, $2, 'aceito'), ($1, $3, 'recusado')`, [R2, PRO, PA])
  r = await quieto(() => viaRota('post', '/reparos/:id/cancelar-match', DONO, R2, { motivo: 'nao_preciso' }))
  const e2 = await eventos(R2)
  const campos2 = e2.map(e => e.campo)
  ok(r.status === 200 && ['status', 'status_aprovacao', 'match_usuario_id', 'match_feito_em'].every(c => campos2.includes(c)) && campos2.includes(`interesse:${PRO}:status`) && !campos2.includes('expira_em'),
     'rota (transação): status, aprovação, match, match_feito_em e o interesse do escolhido (expira_em não mudou: sem linha)', campos2)
  const ei = ev(e2, `interesse:${PRO}:status`)[0]
  ok(ei && ei.valor_antes === 'aceito' && ei.valor_depois === 'cancelado', 'interesse: aceito → cancelado', ei)
  ok(e2.every(e => e.origem === 'rota' && e.rota === 'POST /api/reparos/:id/cancelar-match' && e.usuario_id === DONO), 'transação: todos com a rota e o usuário', e2.map(e => [e.campo, e.origem, e.usuario_id]))
  ok(ev(e2, 'match_usuario_id')[0]?.valor_antes === PRO && ev(e2, 'match_usuario_id')[0]?.valor_depois === null, 'match_usuario_id: antes = escolhida, depois = NULL')

  // 3) Job: expirarPedidosCancelamento (via job() do agendador) limpa o pedido de acordo vencido.
  const R3 = D(203)
  await db.query(`INSERT INTO reparos (id, codigo_publico, titulo, categoria, criado_por, valor_estimado, cidade, uf, status, match_usuario_id, match_feito_em, expira_em,
                    cancelamento_pedido_por, cancelamento_pedido_motivo, cancelamento_pedido_em, cancelamento_pedido_expira_em)
                  VALUES ($1, 'CXP03', 'Ligar chuveiro', 'eletrica', $2, 100, 'Uberlândia', 'MG', 'aberta', $3, now() - INTERVAL '5 hours', now() + INTERVAL '2 days',
                    $3, 'imprevisto', now() - INTERVAL '3 hours', now() - INTERVAL '1 hour')`, [R3, DONO, PRO])
  await quieto(() => AUD.job('expirarPedidosCancelamento', CM.expirarPedidosCancelamento)())
  const e3 = await eventos(R3)
  ok(['cancelamento_pedido_por', 'cancelamento_pedido_motivo', 'cancelamento_pedido_em', 'cancelamento_pedido_expira_em'].every(c => ev(e3, c).length === 1) && ev(e3, 'cancelamento_pedido_motivo')[0].valor_antes === 'imprevisto',
     'job: os 4 campos cancelamento_pedido_* registrados', e3.map(e => e.campo))
  ok(e3.every(e => e.origem === 'job' && e.rota === 'expirarPedidosCancelamento' && e.usuario_id === null), 'job: origem "job", nome do job, sem usuário', e3.map(e => [e.origem, e.rota]))
  // job via semSobreposicao (nome próprio)
  await A.semSobreposicao('jobDeTeste', () => shim.query(`UPDATE reparos SET expira_em = expira_em + INTERVAL '1 day' WHERE id = $1`, [R3]))()
  const e3b = (await eventos(R3)).filter(e => e.campo === 'expira_em')
  ok(e3b.length === 1 && e3b[0].origem === 'job' && e3b[0].rota === 'jobDeTeste', 'job via semSobreposicao: origem "job" com o nome dele', e3b)

  // 4) SQL solto (fora do app: sem origem) → 'desconhecida'.
  await db.query(`UPDATE reparos SET status = 'aberta', status_aprovacao = 'aprovada' WHERE id = $1`, [R1])
  await db.query(`UPDATE interesse_reparos SET status = 'pendente' WHERE reparo_id = $1 AND usuario_id = $2`, [R2, PA])
  const e4 = (await eventos(R1)).slice(-2)
  const e4i = ev(await eventos(R2), `interesse:${PA}:status`)
  ok(e4.length === 2 && e4.every(e => e.origem === 'desconhecida' && e.usuario_id === null && e.rota === null), 'SQL solto em reparos: origem "desconhecida"', e4)
  ok(e4i.length === 1 && e4i[0].origem === 'desconhecida' && e4i[0].valor_antes === 'recusado', 'SQL solto no interesse: origem "desconhecida"', e4i)
  // pool do app fora de rota/job (sem contexto) → também 'desconhecida', e o UPDATE roda normal
  const rs = await shim.query(`UPDATE reparos SET status = 'expirada' WHERE id = $1 RETURNING id`, [R1])
  ok(rs.rows.length === 1 && (await eventos(R1)).slice(-1)[0].origem === 'desconhecida', 'pool sem contexto: UPDATE normal, origem "desconhecida"')

  // 5) UPDATE que não mexe em campo auditado → nenhuma linha; o contexto não vaza entre transações.
  let antes = (await eventos(R1)).length
  await db.query(`UPDATE reparos SET titulo = 'Pintar muro (novo)' WHERE id = $1`, [R1])
  ok((await eventos(R1)).length === antes, 'campo não auditado (titulo): nenhuma linha')
  await db.query(`UPDATE reparos SET status = 'aberta' WHERE id = $1`, [R1])
  ok((await eventos(R1)).slice(-1)[0].origem === 'desconhecida', 'set_config é local à transação: depois de rota/job, SQL solto segue "desconhecida"')

  // 6) "Falha ao gravar o evento não derruba o UPDATE" (BEGIN … EXCEPTION … RAISE WARNING nos triggers)
  //    NÃO é exercitável aqui: o PGlite desta versão não suporta capturar erro em bloco EXCEPTION de
  //    PL/pgSQL ("cannot resolve symbol setTempRet0"); no Postgres é o comportamento padrão. Confere-se
  //    só que as duas funções têm o bloco de proteção.
  const fns = (await db.query(`SELECT proname, prosrc FROM pg_proc WHERE proname IN ('auditar_demanda', 'auditar_interesse')`)).rows
  ok(fns.length === 2 && fns.every(f => /EXCEPTION WHEN others THEN\s+RAISE WARNING/.test(f.prosrc)), 'as duas funções de trigger protegem o UPDATE (EXCEPTION → WARNING)', fns.map(f => f.proname))

  // 7) Obra (candidaturas → tabela 'obras').
  const O1 = D(204)
  await db.query(`INSERT INTO obras (id, codigo_publico, titulo, categoria, criado_por, valor, cidade, uf, status, expira_em) VALUES ($1, 'CXP04', 'Reforma', 'residencial', $2, 3000, 'Uberlândia', 'MG', 'aberta', now() + INTERVAL '5 days')`, [O1, DONO])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status) VALUES ($1, $2, 'pendente')`, [O1, PB])
  await db.query(`UPDATE candidaturas SET status = 'recusado' WHERE obra_id = $1`, [O1])
  const eo = await eventos(O1)
  ok(eo.length === 1 && eo[0].campo === `interesse:${PB}:status` && (await db.query(`SELECT tabela FROM eventos_demanda WHERE demanda_id = $1`, [O1])).rows[0].tabela === 'obras', 'candidatura: evento na tabela "obras"', eo)

  // 8) GET /admin/demandas/:codigo/linha-do-tempo
  r = await quieto(() => viaRota('get', '/admin/demandas/:codigo/linha-do-tempo', ADMIN, 'cxp02'))
  const linha = r.body.eventos || []
  ok(r.status === 200 && r.body.demanda?.id === R2 && r.body.demanda?.tabela === 'reparos' && linha.length === e2.length + 1, 'linha do tempo por código (caixa ignorada): o pedido e todos os eventos', { status: r.status, n: linha.length })
  ok(linha.every((x, i) => i === 0 || new Date(x.criado_em) >= new Date(linha[i - 1].criado_em)) && linha.filter(x => x.usuario_id === DONO).every(x => x.usuario_nome === 'Maria'),
     'em ordem, com o nome de quem fez', linha.map(x => [x.campo, x.usuario_nome]))
  const lpro = linha.find(x => x.campo === `interesse:${PRO}:status`)
  ok(lpro && lpro.profissional_id === PRO && lpro.profissional_nome === 'Giovanna Lima', 'evento de interesse traz o profissional', lpro)
  r = await quieto(() => viaRota('get', '/admin/demandas/:codigo/linha-do-tempo', ADMIN, R3))
  ok(r.status === 200 && r.body.demanda?.codigo === 'CXP03', 'linha do tempo também pelo id', r.body.demanda)
  r = await quieto(() => viaRota('get', '/admin/demandas/:codigo/linha-do-tempo', ADMIN, 'NAOEXISTE'))
  ok(r.status === 404, 'código inexistente: 404', r.status)
  const { exigirSuperAdmin } = require(path.join(REPO, 'src/middlewares/auth'))
  let negado = null
  exigirSuperAdmin({ usuario: { id: DONO, role: 'dono_obra' } }, { status(c) { negado = c; return { json() {} } } }, () => { negado = 'passou' })
  ok(negado === 403, 'só o admin principal (exigirSuperAdmin: 403 para os demais)', negado)

  const errosReais = erros.filter(e => !/sem banco/.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
