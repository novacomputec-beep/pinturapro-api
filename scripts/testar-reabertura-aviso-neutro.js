#!/usr/bin/env node
// AVISO NEUTRO DE REABERTURA (dono, 12/11/2026): em TODO caminho em que o match acaba, a demanda
// segue aberta e propostas voltam a valer, os profissionais restaurados recebem o MESMO aviso,
// push + e-mail, só por alertaService.avisarReabertura (o caminho só marca aviso_reabertura_em):
//   título "🔔 Pedido disponível de novo"
//   corpo  "\"<título>\" está aberto e sua proposta continua valendo — o cliente pode escolher você."
//   data   { tipo: novo_reparo | nova_obra, reaberta: true, reparo_id | obra_id }
// Nunca diz quem/por quê/quantas vezes; nada sai direto do caminho; o profissional que perdeu o match
// e a recusa explícita do dono ficam de fora. Caminhos (obras e reparos): desistência do profissional
// (4 motivos), dono cancela mantendo aberta, escolher outro, escolher outro porque desinstalou,
// desfazer escolha, expirar-match (admin e dono), recusa de mais tempo, cronômetro com e sem
// horário, exclusão da conta do escolhido. E as regras do envio: silêncio 22–07 (adiado, não
// descartado), teto de 15 pushes/dia (resumo; e-mail sai), bloqueios, suspensão, uma vez por pessoa,
// cada reabertura com o seu e-mail, novo match antes do tique → nada.
// SQL REAL em PGlite; rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-reabertura-aviso-neutro.js
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

  let id
  // ═══ Caminhos ═══════════════════════════════════════════════════════════════════════════════
  for (const tabela of ['reparos', 'obras']) {
    for (const motivo of CM.MOTIVOS) {
      id = await cenario(tabela)
      await conferir(tabela, id, `${tabela} desistência do profissional (${motivo})`, () => chamar('post', `/${tabela}/:id/cancelar-match`, PRO, id, { motivo, detalhe: 'x' }))
    }
    id = await cenario(tabela)
    await conferir(tabela, id, `${tabela} dono cancela mantendo aberta`, () => chamar('post', `/${tabela}/:id/cancelar-match`, DONO, id, { motivo: 'imprevisto' }))
    id = await cenario(tabela)
    const p0 = pushes.length
    await quieto(() => chamar('post', `/${tabela}/:id/cancelar-match`, DONO, id, { motivo: 'nao_preciso' }))
    await quieto(() => A.avisarReabertura(tabela))
    ok(!(await marcado(tabela, id)) && ![PA, PB].some(u => pushesDe(u, p0).some(p => p.title === TITULO)), `${tabela} dono 'nao_preciso' (encerra): nenhum aviso de reabertura`)

    id = await cenario(tabela, { lembrete_agendar_sem_proposta: 2 })
    await conferir(tabela, id, `${tabela} escolher outro`, () => chamar('post', `/${tabela}/dono/:id/escolher-outro`, DONO, id))
    id = await cenario(tabela)
    await db.query(`UPDATE usuarios SET desinstalado_em = now() WHERE id = $1`, [PRO])
    await conferir(tabela, id, `${tabela} escolher outro porque o escolhido desinstalou`, () => chamar('post', `/${tabela}/dono/:id/escolher-outro`, DONO, id))
    await db.query(`UPDATE usuarios SET desinstalado_em = NULL WHERE id = $1`, [PRO])
    id = await cenario(tabela, { match_feito_em: emMin(-600), expira_em: emMin(60) })
    await conferir(tabela, id, `${tabela} desfazer escolha`, () => chamar('post', `/${tabela}/dono/:id/desfazer-match`, DONO, id))
    id = await cenario(tabela)
    await conferir(tabela, id, `${tabela} expirar-match (admin)`, () => chamar('post', `/${tabela}/:id/expirar-match`, ADMIN, id))
    // expirar-match pelo dono com o prazo JÁ vencido: a demanda volta sem prazo (expira_em passado),
    // então não está aberta para ninguém — o aviso NÃO sai ("está aberto" seria falso) e a marca é limpa.
    id = await cenario(tabela, { expira_em: emMin(-30) })
    await zerarTeto()
    let p1 = pushes.length, e1 = emails.length
    const rv = await quieto(() => chamar('post', `/${tabela}/:id/expirar-match`, DONO, id))
    await quieto(() => A.avisarReabertura(tabela))
    ok(rv.status === 200 && !(await marcado(tabela, id)) && ![PA, PB].some(u => pushesDe(u, p1).some(p => p.title === TITULO) || emailsDe(u, e1).some(e => e.assunto === TITULO)),
       `${tabela} expirar-match (dono, prazo já vencido): demanda sem prazo → sem aviso, marca limpa`)
    // expirar-match pelo dono com prazo ainda valendo (chegada não confirmada pelo profissional): avisa.
    id = await cenario(tabela, { chegada_declarada_por: PRO, chegada_declarada_em: emMin(-10) })
    await conferir(tabela, id, `${tabela} expirar-match (dono contesta chegada)`, () => chamar('post', `/${tabela}/:id/expirar-match`, DONO, id))
    id = await cenario(tabela, { a_caminho_em: emMin(-20), chegada_prevista_em: emMin(10), pedido_atraso_status: 'pendente', pedido_atraso_minutos: 30, pedido_atraso_em: emMin(-2) })
    await conferir(tabela, id, `${tabela} recusa de mais tempo`, () => chamar('post', `/${tabela}/:id/pedir-atraso/responder`, DONO, id, { aceitar: false }))
    id = await cenario(tabela)
    await conferir(tabela, id, `${tabela} exclusão da conta do escolhido`, async () => { await db.query('BEGIN'); const ef = await CM.desfazerMatchesPorExclusao(cliente, PRO); await db.query('COMMIT'); await CM.avisarMatchesDesfeitosPorExclusao(ef) })
  }
  // Cronômetro (ele mesmo chama avisarReabertura no fim do tique): com horário vencido e sem horário.
  for (const [tabela, cron] of [['reparos', A.verificarCronometroReparos], ['obras', A.verificarCronometroObras]]) {
    const comHorario = await cenario(tabela, { chegada_prevista_em: emMin(-120), chegada_janela: 'agendado', expira_em: emMin(600), comparecimento_resposta: 'nao' })
    const semHorario = await cenario(tabela, { expira_em: emMin(-30) })
    await zerarTeto()
    const p0 = pushes.length, e0 = emails.length
    await quieto(() => cron())
    for (const [rot, did] of [['com horário vencido', comHorario], ['sem horário', semHorario]]) {
      const esperado = { tipo: LADO[tabela].tipo, reaberta: true, [LADO[tabela].chave]: did }
      for (const u of [PA, PB]) {
        const ps = pushesDe(u, p0).filter(p => p.title === TITULO && p.data[LADO[tabela].chave] === did)
        ok(ps.length === 1 && ps[0].body === corpo(did) && igualData(ps[0].data, esperado) && emailsDe(u, e0).some(e => e.assunto === TITULO && String(e.texto).includes(corpo(did))),
           `${tabela} cronômetro ${rot}: ${u === PA ? 'A' : 'B'} recebe o aviso neutro`, ps.map(p => p.data))
      }
      ok(!pushesDe(PC, p0).some(p => p.title === TITULO) && !pushesDe(PRO, p0).some(p => p.title === TITULO), `${tabela} cronômetro ${rot}: C e o profissional que perdeu não recebem`)
    }
    const titulosInteressados = [PA, PB].flatMap(u => pushesDe(u, p0).map(p => `${p.title} ${p.body}`))
    ok(!titulosInteressados.some(t => REVELA.test(t)), `${tabela} cronômetro: nenhum texto revelador aos interessados`, titulosInteressados.filter(t => REVELA.test(t)))
  }

  // ═══ Regras do envio ════════════════════════════════════════════════════════════════════════
  // Silêncio noturno: marca às 23:00 SP, nada sai; às 07:00 sai.
  await fixarAgora(13 * 60) // 23:00 SP
  id = await cenario('reparos')
  let p0 = pushes.length
  await quieto(() => chamar('post', '/reparos/:id/cancelar-match', PRO, id, { motivo: 'imprevisto', detalhe: 'x' }))
  await quieto(() => A.avisarReabertura('reparos'))
  ok(await marcado('reparos', id) && !pushesDe(PA, p0).some(p => p.title === TITULO), '23:00 SP: aviso ADIADO (marca segue, nada sai)')
  await fixarAgora(21 * 60) // 07:00 SP do dia seguinte
  await quieto(() => A.avisarReabertura('reparos'))
  ok(!(await marcado('reparos', id)) && pushesDe(PA, p0).filter(p => p.title === TITULO).length === 1 && pushesDe(PB, p0).filter(p => p.title === TITULO).length === 1, '07:00 SP: o aviso adiado sai (não foi descartado)')

  // Teto de 15 pushes/dia: A no teto → sem push, entra no resumo, e-mail sai; B (abaixo) recebe push.
  await db.query(`INSERT INTO lembretes_push_enviados (tabela, demanda_id, usuario_id, motivo) SELECT 'reparos', gen_random_uuid(), $1, 'lembrete' FROM generate_series(1, 15)`, [PA])
  id = await cenario('reparos')
  p0 = pushes.length; let e0 = emails.length
  await quieto(() => chamar('post', '/reparos/:id/cancelar-match', PRO, id, { motivo: 'imprevisto', detalhe: 'x' }))
  await quieto(() => A.avisarReabertura('reparos'))
  const resumo = (await db.query(`SELECT lembrete, resumo_em FROM avisos_acima_do_teto WHERE demanda_id = $1 AND usuario_id = $2`, [id, PA])).rows[0]
  ok(!pushesDe(PA, p0).some(p => p.title === TITULO) && resumo && resumo.lembrete === true && resumo.resumo_em === null && emailsDe(PA, e0).some(e => e.assunto === TITULO),
     'teto de 15/dia: A sem push, entra no push-resumo (avisos_acima_do_teto), e-mail sai', { resumo, emails: emailsDe(PA, e0).length })
  ok(pushesDe(PB, p0).filter(p => p.title === TITULO).length === 1, 'teto: B (abaixo do teto) recebe o push')
  const contou = (await db.query(`SELECT count(*)::int AS n FROM lembretes_push_enviados WHERE usuario_id = $1 AND demanda_id = $2 AND motivo = 'reanuncio'`, [PB, id])).rows[0].n
  ok(contou === 1, 'push enviado conta no teto diário (lembretes_push_enviados, reanuncio)', contou)
  await db.query(`DELETE FROM lembretes_push_enviados WHERE usuario_id = $1`, [PA])

  // Bloqueios e suspensão: B bloqueado pelo dono, A suspenso → nenhum recebe.
  await db.query(`INSERT INTO prestadores_bloqueados_dono (dono_id, prestador_id) VALUES ($1, $2)`, [DONO, PB])
  await db.query(`UPDATE usuarios SET suspenso_em = now() WHERE id = $1`, [PA])
  id = await cenario('reparos')
  p0 = pushes.length; e0 = emails.length
  await quieto(() => chamar('post', '/reparos/:id/cancelar-match', PRO, id, { motivo: 'imprevisto', detalhe: 'x' }))
  await quieto(() => A.avisarReabertura('reparos'))
  ok(![PA, PB].some(u => pushesDe(u, p0).some(p => p.title === TITULO) || emailsDe(u, e0).some(e => e.assunto === TITULO)), 'bloqueado pelo dono (B) e suspenso (A): nenhum aviso')
  await db.query(`DELETE FROM prestadores_bloqueados_dono`)
  await db.query(`UPDATE usuarios SET suspenso_em = NULL WHERE id = $1`, [PA])
  // Bloqueio na demanda (prestadores_bloqueados).
  id = await cenario('reparos', { prestadores_bloqueados: [PB] })
  p0 = pushes.length
  await quieto(() => chamar('post', '/reparos/:id/cancelar-match', PRO, id, { motivo: 'imprevisto', detalhe: 'x' }))
  await quieto(() => A.avisarReabertura('reparos'))
  ok(!pushesDe(PB, p0).some(p => p.title === TITULO) && pushesDe(PA, p0).some(p => p.title === TITULO), 'bloqueado na demanda (B): sem aviso; A recebe')

  // Uma vez por PESSOA: A tem uma 2ª conta profissional (mesmo CPF) com proposta valendo → um aviso.
  await usr(PA2, 'Ana Pintora', 'prestador', { tipo_prestador: 'pintor', cpf: '333', esp: ['pintor'], semToken: true })
  id = await cenario('reparos')
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status, status_antes_match) VALUES ($1, $2, 'recusado', 'pendente')`, [id, PA2])
  p0 = pushes.length; e0 = emails.length
  await quieto(() => chamar('post', '/reparos/:id/cancelar-match', PRO, id, { motivo: 'imprevisto', detalhe: 'x' }))
  await quieto(() => A.avisarReabertura('reparos'))
  const daAna = pushes.slice(p0).filter(p => p.title === TITULO && p.data.reparo_id === id && p.to === tok(PA)).length
  const emailsAna = [...emailsDe(PA, e0), ...emailsDe(PA2, e0)].filter(e => e.assunto === TITULO).length
  ok(daAna === 1 && emailsAna === 1, 'pessoa com 2 contas profissionais: UM push e UM e-mail', { daAna, emailsAna })

  // Segunda reabertura da MESMA demanda: novo push E novo e-mail (o instante discrimina a rodada).
  await db.query(`UPDATE interesse_reparos SET status = 'recusado', status_antes_match = 'pendente' WHERE reparo_id = $1 AND usuario_id IN ($2, $3)`, [id, PA, PB])
  await db.query(`UPDATE interesse_reparos SET status = 'aceito', status_antes_match = NULL WHERE reparo_id = $1 AND usuario_id = $2`, [id, PRO])
  await db.query(`UPDATE reparos SET match_usuario_id = $2, match_feito_em = now() WHERE id = $1`, [id, PRO])
  await fixarAgora(21 * 60 + 30)
  p0 = pushes.length; e0 = emails.length
  await quieto(() => chamar('post', '/reparos/:id/cancelar-match', PRO, id, { motivo: 'outro', detalhe: 'x' }))
  await quieto(() => A.avisarReabertura('reparos'))
  ok(pushesDe(PB, p0).filter(p => p.title === TITULO).length === 1 && emailsDe(PB, e0).filter(e => e.assunto === TITULO).length === 1, '2ª reabertura da mesma demanda: novo push e novo e-mail')
  await quieto(() => A.avisarReabertura('reparos'))
  ok(pushesDe(PB, p0).filter(p => p.title === TITULO).length === 1, 'tique seguinte: nada repetido')

  // Novo match antes do tique: claim limpo, ninguém avisado.
  id = await cenario('reparos')
  p0 = pushes.length
  await quieto(() => chamar('post', '/reparos/:id/cancelar-match', PRO, id, { motivo: 'imprevisto', detalhe: 'x' }))
  await db.query(`UPDATE reparos SET match_usuario_id = $2, match_feito_em = now() WHERE id = $1`, [id, PA])
  await quieto(() => A.avisarReabertura('reparos'))
  ok(!(await marcado('reparos', id)) && ![PA, PB].some(u => pushesDe(u, p0).some(p => p.title === TITULO)), 'novo match antes do tique: claim limpo, nenhum aviso')

  const errosReais = erros.filter(e => !/sem banco/.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
