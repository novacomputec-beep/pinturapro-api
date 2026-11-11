#!/usr/bin/env node
// REGRA ÚNICA (dono, 11/11/2026 — B55RT): em TODO caminho em que o match acaba e a demanda SEGUE
// ABERTA, as propostas rebaixadas PELO MATCH ('recusado' com status_antes_match) voltam ao status que
// tinham, na MESMA transação/statement (utils/reaberturaMatch.sqlRestaurarPropostas /
// restaurarPropostasRebaixadas). Um cenário por caminho, obras e reparos:
//   1. desistência do profissional (POST /:id/cancelar-match), os 4 motivos;
//   2. cancelamento do dono mantendo aberta (manter_aberta) — e, no contraste, 'nao_preciso' fecha e
//      NÃO restaura;
//   3. escolher outro (POST /dono/:id/escolher-outro);
//   4. desfazer escolha (POST /dono/:id/desfazer-match);
//   5. expirar-match (admin e dono com prazo vencido);
//   6. recusa de mais tempo pelo dono (POST /:id/pedir-atraso/responder {aceitar:false});
//   7. cronômetro: horário combinado vencido sem chegada (antes só o "sem horário" restaurava) e
//      sem horário marcado;
//   8. exclusão da conta do escolhido (desfazerMatchesPorExclusao).
// Em cada um: A ('recusado' ← 'pendente') volta a pendente, B ('recusado' ← 'contraproposta_dono')
// volta a contraproposta_dono, C (recusa explícita do dono, sem marcador) continua recusado.
// SQL REAL num Postgres em memória (PGlite); rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-restaurar-propostas-unmatch.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

const pushes = []
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
  if (/brevoService$/.test(request)) return { enviarEmail: async () => {}, enviarEmailComAnexo: async () => {} }
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
const RM = require(path.join(REPO, 'src/utils/reaberturaMatch'))
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

  // ═══ 0. Helper puro ═════════════════════════════════════════════════════════════════════════
  let id = await cenario('reparos')
  let n = await RM.restaurarPropostasRebaixadas(cliente, 'reparos', id)
  let e = await estado('reparos', id)
  ok(n.length === 2 && n.includes(PA) && n.includes(PB) && e.A === 'pendente' && e.B === 'contraproposta_dono' && e.C === 'recusado' && e.pro === 'aceito' && e.marcadores === 0,
     'restaurarPropostasRebaixadas: A e B voltam (devolve os 2 ids), C fica recusado, o aceito do match não é tocado, marcadores limpos', e)
  let erro = null; try { RM.sqlRestaurarPropostas('usuarios', { igual: '$1' }) } catch (x) { erro = x.message }
  ok(/tabela inválida/.test(erro || ''), 'sqlRestaurarPropostas: tabela inválida lança')

  // ═══ 1. Desistência do profissional — 4 motivos, reparos e obras ═════════════════════════════
  for (const tabela of ['reparos', 'obras']) {
    for (const motivo of CM.MOTIVOS) {
      id = await cenario(tabela)
      const r = await quieto(() => chamar('post', `/${tabela}/:id/cancelar-match`, PRO, id, { motivo, detalhe: 'x' }))
      e = await estado(tabela, id)
      ok(r.status === 200 && restaurou(e) && e.pro === 'cancelado', `${tabela}: profissional cancela (${motivo}) → A pendente, B contraproposta_dono, C recusado, demanda aberta`, { status: r.status, ...e })
    }
  }

  // ═══ 2. Cancelamento do dono: mantendo aberta restaura; 'nao_preciso' fecha e não restaura ═══
  for (const tabela of ['reparos', 'obras']) {
    id = await cenario(tabela)
    let r = await quieto(() => chamar('post', `/${tabela}/:id/cancelar-match`, DONO, id, { motivo: 'imprevisto' }))
    e = await estado(tabela, id)
    ok(r.status === 200 && restaurou(e), `${tabela}: dono cancela mantendo aberta → restaura`, { status: r.status, ...e })
    id = await cenario(tabela)
    r = await quieto(() => chamar('post', `/${tabela}/:id/cancelar-match`, DONO, id, { motivo: 'nao_preciso' }))
    e = await estado(tabela, id)
    ok(r.status === 200 && e.status === 'cancelada' && e.A === 'recusado' && e.B === 'recusado' && e.marcadores === 2, `${tabela}: dono 'nao_preciso' ENCERRA → nada restaurado (demanda fechada)`, { status: r.status, ...e })
  }

  // ═══ 3. Escolher outro (2 lembretes "Agende" sem proposta) ══════════════════════════════════
  for (const tabela of ['reparos', 'obras']) {
    id = await cenario(tabela, { lembrete_agendar_sem_proposta: 2 })
    const r = await quieto(() => chamar('post', `/${tabela}/dono/:id/escolher-outro`, DONO, id))
    e = await estado(tabela, id)
    ok(r.status === 200 && restaurou(e), `${tabela}: escolher outro → restaura`, { status: r.status, corpo: r.body?.erro, ...e })
  }

  // ═══ 4. Desfazer escolha (resta ≤ 25% do intervalo match→prazo) ═════════════════════════════
  for (const tabela of ['reparos', 'obras']) {
    id = await cenario(tabela, { match_feito_em: emMin(-600), expira_em: emMin(60) })
    const r = await quieto(() => chamar('post', `/${tabela}/dono/:id/desfazer-match`, DONO, id))
    e = await estado(tabela, id)
    ok(r.status === 200 && restaurou(e), `${tabela}: desfazer escolha → restaura`, { status: r.status, corpo: r.body?.erro, ...e })
  }

  // ═══ 5. Expirar-match: admin, e dono com prazo vencido ══════════════════════════════════════
  for (const tabela of ['reparos', 'obras']) {
    id = await cenario(tabela)
    let r = await quieto(() => chamar('post', `/${tabela}/:id/expirar-match`, ADMIN, id))
    e = await estado(tabela, id)
    ok(r.status === 200 && restaurou(e) && e.pro === 'expirado', `${tabela}: expirar-match pelo admin → restaura (aceito vira expirado)`, { status: r.status, corpo: r.body?.erro, ...e })
    id = await cenario(tabela, { expira_em: emMin(-30) })
    r = await quieto(() => chamar('post', `/${tabela}/:id/expirar-match`, DONO, id))
    e = await estado(tabela, id)
    ok(r.status === 200 && restaurou(e), `${tabela}: expirar-match pelo dono com prazo vencido → restaura`, { status: r.status, corpo: r.body?.erro, ...e })
  }

  // ═══ 6. Recusa de mais tempo pelo dono ══════════════════════════════════════════════════════
  for (const tabela of ['reparos', 'obras']) {
    id = await cenario(tabela, { a_caminho_em: emMin(-20), chegada_prevista_em: emMin(10), pedido_atraso_status: 'pendente', pedido_atraso_minutos: 30, pedido_atraso_em: emMin(-2) })
    const r = await quieto(() => chamar('post', `/${tabela}/:id/pedir-atraso/responder`, DONO, id, { aceitar: false }))
    e = await estado(tabela, id)
    ok(r.status === 200 && restaurou(e) && e.pro === 'expirado', `${tabela}: dono recusa mais tempo → un-match restaura`, { status: r.status, corpo: r.body?.erro, ...e })
  }

  // ═══ 7. Cronômetro: horário combinado vencido (ANTES não restaurava) e sem horário ══════════
  for (const [tabela, cron] of [['reparos', A.verificarCronometroReparos], ['obras', A.verificarCronometroObras]]) {
    // horário agendado vencido + dono respondeu 'não veio' à vigia (senão o cron espera 24h pela resposta)
    const comHorario = await cenario(tabela, { chegada_prevista_em: emMin(-120), chegada_janela: 'agendado', expira_em: emMin(600), comparecimento_resposta: 'nao' })
    const semHorario = await cenario(tabela, { expira_em: emMin(-30) })
    await fixarAgora(0)
    await quieto(() => cron())
    const e1 = await estado(tabela, comHorario), e2 = await estado(tabela, semHorario)
    ok(restaurou(e1) && e1.pro === 'expirado', `${tabela}: cronômetro com HORÁRIO vencido sem chegada → restaura (buraco antigo)`, e1)
    ok(restaurou(e2) && e2.pro === 'expirado', `${tabela}: cronômetro sem horário marcado → restaura (como já fazia)`, e2)
  }

  // ═══ 8. Exclusão da conta do escolhido ══════════════════════════════════════════════════════
  for (const tabela of ['reparos', 'obras']) {
    id = await cenario(tabela)
    await db.query('BEGIN'); await CM.desfazerMatchesPorExclusao(cliente, PRO); await db.query('COMMIT')
    e = await estado(tabela, id)
    ok(restaurou(e) && e.pro === 'cancelado', `${tabela}: exclusão da conta do escolhido → restaura`, e)
  }

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
