#!/usr/bin/env node
// Exclusão de conta do profissional ESCOLHIDO (dono, 11/11/2026) — DELETE /conta/excluir (pessoa) e
// DELETE /usuarios/:id (admin): antes da cascata, cada obra/reparo ABERTO em que a conta é o match é
// desfeito como desistência (cancelamentoMatchService.desfazerMatchesPorExclusao): demanda segue
// 'aberta' sem match (agenda/chegada zeradas, prazo com piso de 1h), propostas rebaixadas PELO MATCH
// voltam ao status de antes (status_antes_match), SEM falta/evento/bloqueio; depois do COMMIT o dono
// recebe push + e-mail "O profissional escolhido saiu do ProTudo — escolha outro interessado para
// "<título>".", os interessados que voltaram a valer recebem o aviso NEUTRO "🔔 Pedido disponível de
// novo" (pelo cron de reabertura — aviso_reabertura_em marcado no un-match) e os demais o reanúncio.
// Toda exclusão grava uma linha em contas_excluidas (id, nome, cpf_hash, role, excluido_em, por).
// SQL REAL num Postgres em memória (PGlite); rotas reais (cadeia inteira, JWT); Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-exclusao-conta-match.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const jwt = require(path.join(REPO, 'node_modules/jsonwebtoken'))
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
const q = async (sql, params) => { if (!db) throw new Error('sem banco (boot)'); const r = await db.query(sql, params); r.rowCount = r.affectedRows ?? r.rows.length; return r }
const shim = { query: q, connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: q, release() {} } }, on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) }, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) } }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { errOrig('unhandled', e && (e.stack || e)); process.exit(1) } })
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? (process.env.DEBUG_ERROS ? (...a) => errOrig('   [erro]', ...a.map(x => x?.message || String(x).slice(0, 300))) : () => {}) : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const CM = require(path.join(REPO, 'src/services/cancelamentoMatchService'))
const CE = require(path.join(REPO, 'src/utils/contasExcluidas'))
const A = require(path.join(REPO, 'src/services/alertaService'))
silenciar(false)
// O aviso de reabertura só sai fora do silêncio 22–07 SP; o teste roda no relógio real, então o cron é
// chamado com NOW() fixado no último 12:00 SP (≤ agora, logo antes do expira_em das demandas).
const avisarReaberturaDeDia = async (tabela) => {
  const agora = Date.now()
  let base = new Date(agora); base.setUTCHours(15, 0, 0, 0)
  if (base.getTime() > agora) base = new Date(base.getTime() - 86400000)
  await db.exec(`SET search_path = public, pg_catalog; CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${base.toISOString()}'::timestamptz $$`)
  try { await quieto(() => A.avisarReabertura(tabela)) } finally { await db.exec(`DROP FUNCTION public.now()`) }
}

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = (ms = 400) => new Promise(r => setTimeout(r, ms))
const tok = (id) => `ExponentPushToken[${id.slice(-3)}]`
const camadas = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack.map(l => l.handle)
}
const rodar = (metodo, caminho, id, { body = {}, params = {} } = {}) => new Promise(resolve => {
  const hs = camadas(metodo, caminho)
  const req = { headers: { authorization: `Bearer ${jwt.sign({ id, tv: 1 }, process.env.JWT_SECRET)}` }, params, body, query: {}, get: () => '', ip: '127.0.0.1', route: { path: caminho } }
  const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  let i = 0
  const next = (err) => {
    if (err) return resolve({ erro: String(err.message || err) })
    if (i >= hs.length) return resolve({ passou: true })
    Promise.resolve(hs[i++](req, res, next)).catch(e => resolve({ erro: String(e.message || e) }))
  }
  next()
})
const quieto = async (fn) => { silenciar(true); try { return await fn() } finally { await assentar(); silenciar(false) } }
const linha = async (t, id) => (await db.query(`SELECT * FROM ${t} WHERE id = $1`, [id])).rows[0]
const propostas = async (t, col, id) => (await db.query(`SELECT usuario_id, status, status_antes_match, cancelado_motivo FROM ${t} WHERE ${col} = $1 ORDER BY usuario_id`, [id])).rows
const pushesPara = (id) => pushes.filter(p => p.to === tok(id))
const emailsPara = (email) => emails.filter(e => e.para === email)

const DONO = U(1), PRO = U(2), PRO_IRMA = U(3), I1 = U(4), I2 = U(5), I3 = U(6), LIVRE = U(7), ADM = U(8), PRO2 = U(9)

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
      prazo_atendimento_horas numeric, prazo_modo text, horas_para_expirar numeric, publicado_em timestamptz, valor_aumentado_em timestamptz, valor_aumentos int DEFAULT 0, alerta_enviado_em timestamptz, alerta_prazo_enviado_em timestamptz`
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
  await CE.migrarContasExcluidas(cliente)
  await CE.migrarContasExcluidas(cliente)
  await require(path.join(REPO, 'src/utils/desistencias')).migrarDesistencias(cliente)
  await require(path.join(REPO, 'src/utils/reaberturaMatch')).migrarReaberturaMatch(cliente)
  ok(true, 'migração contas_excluidas idempotente (2x)')
  const usr = (id, nome, role, extra = {}) => db.query(
    `INSERT INTO usuarios (id, nome, email, role, tipo_dono, tipo_prestador, cpf_cnpj, push_token, cidade, uf, especialidades, senha_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Uberlândia', 'MG', $9, 'x')`,
    [id, nome, `${nome.toLowerCase().replace(/[^a-z]/g, '')}@x.invalid`, role, extra.tipo_dono || null, extra.tipo_prestador || null, extra.cpf ?? null, tok(id), extra.esp || null])
  await usr(DONO, 'Maria', 'dono_obra', { tipo_dono: 'reparo', cpf: '11111111111' })
  await usr(PRO, 'Alex Reparador', 'prestador', { tipo_prestador: 'reparador', cpf: '222.222.222-22', esp: ['eletrica'] })
  await usr(PRO_IRMA, 'Alex Pintor', 'prestador', { tipo_prestador: 'pintor', cpf: '22222222222', esp: ['pintor'] })
  await usr(I1, 'Interessado Um', 'prestador', { tipo_prestador: 'reparador', cpf: '333', esp: ['eletrica'] })
  await usr(I2, 'Interessado Dois', 'prestador', { tipo_prestador: 'reparador', cpf: '444', esp: ['eletrica'] })
  await usr(I3, 'Recusado Antes', 'prestador', { tipo_prestador: 'reparador', cpf: '555', esp: ['eletrica'] })
  await usr(LIVRE, 'Livre Nunca Viu', 'prestador', { tipo_prestador: 'reparador', cpf: '666', esp: ['eletrica'] })
  await usr(ADM, 'Admin', 'admin', { cpf: '777' })
  await usr(PRO2, 'Beto', 'prestador', { tipo_prestador: 'pintor', cpf: '888', esp: ['pintor'] })
  for (const u of [PRO, PRO_IRMA, I1, I2, I3, LIVRE, PRO2]) await db.query(`INSERT INTO assinaturas (usuario_id, status, tipo, plano, valor_mensal) VALUES ($1, 'ativa', 'gratuito', 'mensal', 49.90)`, [u])

  // R1: reparo da Maria, match = Alex (reparador) com horário marcado; I1/I2 rebaixados PELO match
  // (status_antes_match = pendente / contraproposta_dono); I3 recusado ANTES do match (sem status_antes_match).
  const R1 = D(1), O1 = D(2), R3 = D(3)
  await db.query(`INSERT INTO reparos (id, titulo, categoria, categorias, criado_por, valor_estimado, prazo_atendimento_horas, expira_em, cidade, uf, bairro, match_usuario_id, match_feito_em, chegada_prevista_em, chegada_janela, publicado_em, push_novo_enviado_em)
    VALUES ($1, 'Trocar chuveiro', 'eletrica', '{eletrica}', $2, 150, 72, now() + INTERVAL '20 minutes', 'Uberlândia', 'MG', 'Centro', $3, now() - INTERVAL '1 day', now() + INTERVAL '1 day', 'agendado', now() - INTERVAL '1 day', now() - INTERVAL '1 day')`, [R1, DONO, PRO])
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status, status_antes_match, valor_proposto) VALUES
    ($1, $2, 'aceito', NULL, 140), ($1, $3, 'recusado', 'pendente', 130), ($1, $4, 'recusado', 'contraproposta_dono', 120), ($1, $5, 'recusado', NULL, 100)`, [R1, PRO, I1, I2, I3])
  // O1: obra da Maria, match = conta IRMÃ (pintor), sem horário; PRO2 rebaixado pelo match.
  await db.query(`INSERT INTO obras (id, titulo, categoria, criado_por, valor, horas_para_expirar, expira_em, cidade, uf, bairro, match_usuario_id, match_feito_em, publicado_em, push_novo_enviado_em)
    VALUES ($1, 'Pintura da sala', 'residencial', $2, 3000, 480, now() + INTERVAL '10 days', 'Uberlândia', 'MG', 'Centro', $3, now() - INTERVAL '2 hours', now() - INTERVAL '1 day', now() - INTERVAL '1 day')`, [O1, DONO, PRO_IRMA])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status, status_antes_match) VALUES ($1, $2, 'aceito', NULL), ($1, $3, 'recusado', 'pendente')`, [O1, PRO_IRMA, PRO2])
  // R3: reparo ENCERRADO com Alex — não é tocado.
  await db.query(`INSERT INTO reparos (id, titulo, categoria, criado_por, status, match_usuario_id, match_feito_em, encerrado_em, expira_em, cidade, uf)
    VALUES ($1, 'Antigo', 'eletrica', $2, 'encerrada', $3, now() - INTERVAL '10 days', now() - INTERVAL '9 days', now(), 'Uberlândia', 'MG')`, [R3, DONO, PRO])

  // ═══ 1. Alex (pessoa: reparador + pintor) exclui a própria conta ═══════════════════════════
  pushes.length = 0; emails.length = 0
  let r = await quieto(() => rodar('delete', '/conta/excluir', PRO, { body: { confirmacao: 'EXCLUIR' } }))
  await assentar(600)
  ok(r.status === 200 && r.body.contas_excluidas === 2, 'DELETE /conta/excluir: 200, 2 contas da pessoa', r.body)
  const r1 = await linha('reparos', R1)
  ok(r1.status === 'aberta' && r1.status_aprovacao === 'aprovada' && r1.match_usuario_id === null && r1.match_feito_em === null && r1.chegada_prevista_em === null && r1.chegada_janela === null,
     'R1: segue ABERTA/aprovada, sem match, agenda e chegada zeradas', { status: r1.status, match: r1.match_usuario_id, chegada: r1.chegada_prevista_em })
  ok(new Date(r1.expira_em) - Date.now() > 50 * 60 * 1000, 'R1: prazo que restava (20 min) sobe ao piso de 1h', r1.expira_em)
  let ps = await propostas('interesse_reparos', 'reparo_id', R1)
  const porU = Object.fromEntries(ps.map(p => [p.usuario_id, p]))
  ok(!porU[PRO] && porU[I1]?.status === 'pendente' && porU[I2]?.status === 'contraproposta_dono' && porU[I3]?.status === 'recusado' && ps.every(p => p.status_antes_match === null),
     'R1 propostas: a de Alex sumiu com a conta; I1 → pendente e I2 → contraproposta_dono (status_antes_match restaurado); I3, recusado ANTES do match, continua recusado',
     ps.map(p => `${p.usuario_id.slice(-1)}:${p.status}`))
  const o1 = await linha('obras', O1)
  ok(o1.status === 'aberta' && o1.match_usuario_id === null, 'O1 (match da conta IRMÃ, pintor): aberta, sem match', { status: o1.status, match: o1.match_usuario_id })
  ps = await propostas('candidaturas', 'obra_id', O1)
  ok(ps.length === 1 && ps[0].usuario_id === PRO2 && ps[0].status === 'pendente', 'O1: candidatura de Beto volta a pendente; a da conta irmã sumiu', ps)
  const r3 = await linha('reparos', R3)
  ok(r3.status === 'encerrada' && r3.match_usuario_id === null, 'R3 (encerrado): não é reaberto — só o match_usuario_id vira NULL pela cascata de sempre', { status: r3.status })
  ok((await db.query(`SELECT count(*)::int AS n FROM faltas_profissional`)).rows[0].n === 0 && (await db.query(`SELECT count(*)::int AS n FROM eventos_responsabilidade`)).rows[0].n === 0,
     'nenhuma falta nem evento de responsabilidade para a conta excluída')
  ok(!r1.prestadores_bloqueados && !o1.prestadores_bloqueados, 'ninguém entra em prestadores_bloqueados')
  // Avisos
  const pd = pushesPara(DONO)
  ok(pd.filter(p => /saiu do ProTudo/.test(p.title) && p.data?.tipo === 'match_cancelado' && p.data?.motivo === 'conta_excluida').length === 2,
     'dono: 2 pushes "O profissional escolhido saiu do ProTudo" (um por demanda), tipo match_cancelado / motivo conta_excluida', pd.map(p => p.title))
  ok(pd.some(p => p.body === 'O profissional escolhido saiu do ProTudo — escolha outro interessado para "Trocar chuveiro".'), 'texto exato ao dono', pd.map(p => p.body))
  const ed = emailsPara('maria@x.invalid')
  ok(ed.length === 2 && ed.every(e => /saiu do ProTudo/.test(e.html || '') || /saiu do ProTudo/.test(e.assunto || '')), 'dono: 2 e-mails (push E e-mail)', ed.map(e => e.assunto))
  const TITULO_NEUTRO = '🔔 Pedido disponível de novo'
  ok(![I1, I2, PRO2].some(u => pushesPara(u).some(p => p.title === TITULO_NEUTRO || /reabriu|saiu do/.test(p.title + p.body))),
     'interessados que voltaram a valer: nada direto da exclusão (o aviso é do cron de reabertura)', { i1: pushesPara(I1).map(p => p.title) })
  ok(r1.aviso_reabertura_em !== null && o1.aviso_reabertura_em !== null, 'R1 e O1: aviso de reabertura marcado no un-match')
  await avisarReaberturaDeDia('reparos')
  await avisarReaberturaDeDia('obras')
  const neutro = (p, titulo, data) => p.title === TITULO_NEUTRO && p.body === `"${titulo}" está aberto e sua proposta continua valendo — o cliente pode escolher você.` && JSON.stringify(p.data) === JSON.stringify(data)
  ok(pushesPara(I1).filter(p => p.title === TITULO_NEUTRO).length === 1 && pushesPara(I1).some(p => neutro(p, 'Trocar chuveiro', { tipo: 'novo_reparo', reaberta: true, reparo_id: R1 }))
     && pushesPara(I2).some(p => neutro(p, 'Trocar chuveiro', { tipo: 'novo_reparo', reaberta: true, reparo_id: R1 })),
     'cron de reabertura: I1 e I2 recebem o aviso NEUTRO do reparo (sem "saiu do ProTudo")', { i1: pushesPara(I1).map(p => [p.title, p.body]) })
  const pBeto = pushesPara(PRO2).filter(p => p.title === TITULO_NEUTRO)
  ok(pBeto.length === 1 && pBeto[0].data?.tipo === 'nova_obra' && pBeto[0].data?.obra_id === O1 && pBeto[0].data?.reaberta === true && Object.keys(pBeto[0].data).length === 3,
     'cron de reabertura: Beto recebe o aviso NEUTRO da obra (data { tipo nova_obra, reaberta, obra_id })', pBeto.map(p => p.data))
  ok(!pushesPara(I3).some(p => p.title === TITULO_NEUTRO), 'I3 (recusado antes do match) NÃO recebe o aviso de reabertura', pushesPara(I3).map(p => p.title))
  ok(pushesPara(LIVRE).length >= 1, 'quem nunca se manifestou recebe o reanúncio (reanunciarDemanda)', pushesPara(LIVRE).map(p => p.title))
  ok(pushesPara(PRO).length === 0 && pushesPara(PRO_IRMA).length === 0, 'a conta excluída não recebe nada')
  let ce = (await db.query(`SELECT id, nome, role, por, cpf_hash FROM contas_excluidas ORDER BY id`)).rows
  ok(ce.length === 2 && ce.every(c => c.por === 'usuario') && ce[0].cpf_hash === ce[1].cpf_hash && ce[0].cpf_hash === CE.hashCpf('222.222.222-22') && ce.map(c => c.role).join() === 'prestador,prestador',
     'contas_excluidas: as 2 contas, por = usuario, mesmo cpf_hash (sha256 dos dígitos), nunca o CPF', ce.map(c => ({ nome: c.nome, por: c.por })))
  ok((await db.query(`SELECT count(*)::int AS n FROM usuarios WHERE id = ANY($1::uuid[])`, [[PRO, PRO_IRMA]])).rows[0].n === 0, 'as contas de fato sumiram')
  // Retrato da desistência (sobrevive à cascata) → folha do dono no detalhe e desistencia_recente em /minhas.
  const snaps = (await db.query(`SELECT tabela, demanda_id, usuario_id, nome_curto, foto_url, genero, motivo FROM desistencias ORDER BY tabela`)).rows
  ok(snaps.length === 2 && snaps.find(s => s.tabela === 'reparos')?.nome_curto === 'Alex R.' && snaps.find(s => s.tabela === 'reparos')?.usuario_id === PRO
     && snaps.find(s => s.tabela === 'obras')?.nome_curto === 'Alex P.' && snaps.find(s => s.tabela === 'obras')?.usuario_id === PRO_IRMA && snaps.every(s => s.motivo === 'conta_excluida' && s.genero === null),
     'desistencias: um retrato por demanda desfeita (reparo: "Alex R.", obra: "Alex P."), motivo conta_excluida, usuario_id guardado como id simples', snaps.map(s => `${s.tabela}:${s.nome_curto}`))
  let det = await quieto(() => rodar('get', '/reparos/:id', DONO, { params: { id: R1 } }))
  ok(det.status === 200 && Array.isArray(det.body.desistencias) && det.body.desistencias.length === 1 && det.body.desistencias[0].nome === 'Alex' && det.body.desistencias[0].motivo === 'conta_excluida'
     && det.body.desistencias[0].motivo_texto === 'O profissional excluiu a conta e não vai mais fazer o serviço.' && det.body.desistencias[0].usuario_id === PRO,
     'GET /reparos/:id (dono): desistencias traz o retrato com o rótulo de conta excluída', det.body.desistencias)
  ok(det.body.interessados_ativos === 2, 'GET /reparos/:id: interessados_ativos = I1 + I2 restaurados', det.body.interessados_ativos)
  const minhas = await quieto(() => rodar('get', '/reparos/minhas', DONO))
  const m1 = (minhas.body.reparos || []).find(x => x.id === R1)
  ok(minhas.status === 200 && m1?.desistencia_recente?.nome === 'Alex' && m1.desistencia_recente.motivo_texto === 'O profissional excluiu a conta e não vai mais fazer o serviço.',
     'GET /reparos/minhas: desistencia_recente do reparo sem match vem do retrato', m1?.desistencia_recente)
  det = await quieto(() => rodar('get', '/obras/:id', DONO, { params: { id: O1 } }))
  ok(det.status === 200 && det.body.desistencias?.length === 1 && det.body.desistencias[0].nome === 'Alex' && det.body.desistencias[0].motivo === 'conta_excluida', 'GET /obras/:id (dono): idem na obra', det.body.desistencias)

  // ═══ 2. Admin exclui Beto, agora escolhido na obra ═════════════════════════════════════════
  await db.query(`UPDATE candidaturas SET status = 'aceito' WHERE obra_id = $1 AND usuario_id = $2`, [O1, PRO2])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status, status_antes_match) VALUES ($1, $2, 'recusado', 'pendente')`, [O1, I1])
  await db.query(`UPDATE obras SET match_usuario_id = $2, match_feito_em = now() WHERE id = $1`, [O1, PRO2])
  pushes.length = 0; emails.length = 0
  r = await quieto(() => rodar('delete', '/usuarios/:id', ADM, { params: { id: PRO2 } }))
  await assentar(600)
  ok(r.status === 200, 'DELETE /usuarios/:id (admin): 200', r.body || r.erro)
  const o1b = await linha('obras', O1)
  ps = await propostas('candidaturas', 'obra_id', O1)
  ok(o1b.status === 'aberta' && o1b.match_usuario_id === null && ps.length === 1 && ps[0].usuario_id === I1 && ps[0].status === 'pendente',
     'admin: obra aberta sem match; candidatura de I1 restaurada a pendente; a de Beto apagada', ps)
  ok(pushesPara(DONO).some(p => p.body === 'O profissional escolhido saiu do ProTudo — escolha outro interessado para "Pintura da sala".'), 'admin: dono avisado com o mesmo texto', pushesPara(DONO).map(p => p.body))
  ce = (await db.query(`SELECT id, por FROM contas_excluidas WHERE id = $1`, [PRO2])).rows
  ok(ce.length === 1 && ce[0].por === ADM, 'contas_excluidas: linha de Beto com por = id do admin', ce)
  ok((await db.query(`SELECT count(*)::int AS n FROM contas_excluidas`)).rows[0].n === 3, '3 linhas no total')

  // ═══ 3. Exclusão sem match aberto: só o registro ═══════════════════════════════════════════
  pushes.length = 0
  r = await quieto(() => rodar('delete', '/conta/excluir', LIVRE, { body: { confirmacao: 'EXCLUIR' } }))
  ok(r.status === 200 && pushesPara(DONO).length === 0 && (await db.query(`SELECT count(*)::int AS n FROM contas_excluidas`)).rows[0].n === 4, 'conta sem match aberto: nada a desfazer, só a linha em contas_excluidas', r.body)

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
