#!/usr/bin/env node
// Correções aprovadas em 16/11/2026, com o SQL REAL num Postgres em memória (PGlite), Expo/Brevo
// falsos que só coletam e relógio congelado (05/11/2026 10:00 em São Paulo):
//   1) aceitar/escolher em pedido VENCIDO ('aberta' com expira_em no passado) → 409 PRAZO_VENCIDO
//      antes de qualquer escrita (dono em …/responder; profissional em …/prestador|pintor-responder);
//   2) cronômetro que tira o escolhido por ATRASO grava a saída em desistencias (motivo
//      'atraso_chegada', retrato nome/foto) e o dono recebe "<nome> não chegou no prazo combinado";
//   3) dono aumenta o prazo de pedido AINDA VIVO → 1 push neutro (sem e-mail) a cada interessado
//      ativo; o aviso pós-vencimento ("🔄 Prazo aumentado", push + e-mail) fica como está;
//   4) GET /reparos/admin e /obras/admin devolvem situacao_painel ('expirada' ou o status real).
//   npm i -D @electric-sql/pglite && node scripts/testar-prazo-vencido-atraso-prazo.js
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
let db
// PGlite não preenche rowCount (as rotas leem upd.rowCount): mesma conta do pg.
const q = async (sql, params) => { const r = await db.query(sql, params); if (r && r.rowCount === undefined) r.rowCount = r.rows.length || r.affectedRows || 0; return r }
const shim = { query: q, connect: async () => ({ query: q, release() {} }), on() {} }
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
      lembrete_agendar_enviados int DEFAULT 0, lembrete_agendar_sem_proposta int NOT NULL DEFAULT 0, horario_vencido_em timestamptz, horarios_vencidos int NOT NULL DEFAULT 0, desfazer_aviso_em timestamptz, aviso_desinstalou_em timestamptz,
      chegada_proposta_em timestamptz, lembrete_resposta_1h_em timestamptz, lembrete_resposta_antes_em timestamptz, lembrete_resposta_ultimo_em timestamptz, aviso_resposta_final_em timestamptz,
      sugestoes_horario_dono int DEFAULT 0, sugestoes_horario_profissional int DEFAULT 0, prazo_chegada_extra_em timestamptz,
      pedido_atraso_minutos int, pedido_atraso_motivo text, pedido_atraso_em timestamptz, pedido_atraso_status text, pedido_atraso_respondido_em timestamptz,
      pedidos_atraso_usados int DEFAULT 0, prestadores_bloqueados uuid[]`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text, suspenso_em timestamptz, suspenso_motivo text, desinstalado_em timestamptz, role text, cpf_cnpj text);
    CREATE TABLE reparos (valor_a_combinar boolean NOT NULL DEFAULT false, ${colsDemanda});
    CREATE TABLE obras (valor_a_combinar boolean NOT NULL DEFAULT false, ${colsDemanda});
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, status text);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, status text);
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
  // Reabertura pelo cronômetro (aviso_reabertura_em, status_antes_match) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/reaberturaMatch')).migrarReaberturaMatch(db)
  // Aviso de reabertura (alertaService.avisarReabertura): teto diário de push e bloqueios.
  await require(path.join(REPO, 'src/utils/avisosPorDistancia')).migrarAvisosPorDistancia(db)
  await db.exec(`CREATE TABLE IF NOT EXISTS avisos_fora_area (tabela text, demanda_id uuid, usuario_id uuid, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS push_entregas (primeira_tentativa_em timestamptz NOT NULL DEFAULT now(), tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, ultima_tentativa_em timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE IF NOT EXISTS prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid);`)
  // ---- colunas a mais deste teste (todas existem em produção: ALTERs de routes/index.js)
  for (const t of ['reparos', 'obras']) {
    await db.exec(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS encerrado_em timestamptz; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ultima_extensao_em timestamptz;
      ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ultima_extensao_horas numeric; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS cidade text; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS uf text;
      ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS bairro text; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS categoria text; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS tags text[];
      ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS valor numeric; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS valor_estimado numeric; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS metragem numeric;
      ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS prazo_execucao_dias int; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS lembrete_conclusao_em timestamptz;`)
  }
  for (const t of ['interesse_reparos', 'candidaturas']) {
    await db.exec(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS criado_em timestamptz DEFAULT now(); ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS valor_proposto numeric;
      ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS valor_contraproposta numeric; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS rodada int; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS cancelado_por uuid;
      ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS cancelado_motivo text; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS cancelado_detalhe text; ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS cancelado_em timestamptz;
      ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS cancelado_acordo boolean NOT NULL DEFAULT false;`)
  }
  await db.exec(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS foto_url text; ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone text;`)
  const Des = require(path.join(REPO, 'src/utils/desistencias'))
  await Des.migrarDesistencias(db)

  const DONO = U(99), CARMEN = U(1), OUTRO = U(2), CONC = U(3)
  await db.query(`INSERT INTO usuarios (id, nome, email, push_token, role, cpf_cnpj, foto_url) VALUES
    ($1, 'Dono', 'dono@x.invalid', 'ExponentPushToken[dono]', 'dono_obra', '11111111111', NULL),
    ($2, 'Carmen Alves de Jesus', 'carmen@x.invalid', 'ExponentPushToken[carmen]', 'prestador', '22222222222', 'https://x.invalid/carmen.jpg'),
    ($3, 'Outro Prof', 'outro@x.invalid', 'ExponentPushToken[outro]', 'prestador', '33333333333', NULL),
    ($4, 'Concorrente', 'conc@x.invalid', 'ExponentPushToken[conc]', 'prestador', '44444444444', NULL)`, [DONO, CARMEN, OUTRO, CONC])
  await fixarAgora(0) // 05/11/2026 10:00 em São Paulo

  const logOrig = console.log, errOrig = console.error
  const calar = () => { console.log = () => {}; console.error = process.env.DEBUG_TESTE ? errOrig : () => {} }
  const falar = () => { console.log = logOrig; console.error = errOrig }
  // O require das rotas dispara a migração de boot: ela roda SEM banco (como nos outros testes) e
  // a falha dela é ignorada; o banco do teste só volta depois.
  let boot = true
  process.on('unhandledRejection', (e) => { if (boot) return; errOrig('unhandled', e); process.exit(1) })
  const dbReal = db
  db = null
  calar()
  const router = require(path.join(REPO, 'src/routes/index.js'))
  const A = require(path.join(REPO, 'src/services/alertaService'))
  await new Promise(r => setTimeout(r, 300))
  falar()
  db = dbReal
  boot = false
  const rota = (metodo, caminho) => {
    const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
    return layer.route.stack[layer.route.stack.length - 1].handle
  }
  const chamar = async (handler, { usuario, params = {}, query = {}, body = {} }) => {
    calar()
    try {
      return await new Promise(resolve => {
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
        handler({ params, query, body, usuario, ip: '127.0.0.1', get() { return '' } }, res)
      })
    } finally { falar() }
  }
  // Os avisos pós-resposta são fire-and-forget: espera real (setTimeout não usa o Date falso).
  const assentar = () => new Promise(r => setTimeout(r, 400))
  const usuarioDono = { id: DONO, role: 'dono_obra' }
  const lado = (t) => (t === 'reparos' ? { prop: 'interesse_reparos', fk: 'reparo_id', horas: 'prazo_atendimento_horas' } : { prop: 'candidaturas', fk: 'obra_id', horas: 'horas_para_expirar' })
  const demanda = (t, n, titulo, expiraSql, extra = {}) => {
    const cols = { id: D(n), titulo, criado_por: DONO, [lado(t).horas]: 24, cidade: 'Patos de Minas', uf: 'MG', ...extra }
    const ks = Object.keys(cols)
    return db.query(`INSERT INTO ${t} (${ks.join(', ')}, expira_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, ${expiraSql})`, ks.map(k => cols[k]))
  }
  const proposta = async (t, n, usuario, status = 'pendente') =>
    (await db.query(`INSERT INTO ${lado(t).prop} (${lado(t).fk}, usuario_id, status, valor_proposto, valor_contraproposta) VALUES ($1, $2, $3, 100, 80) RETURNING id`, [D(n), usuario, status])).rows[0].id
  const linha = async (t, n) => (await db.query(`SELECT * FROM ${t} WHERE id = $1`, [D(n)])).rows[0]
  const statusProp = async (t, id) => (await db.query(`SELECT status FROM ${lado(t).prop} WHERE id = $1`, [id])).rows[0].status
  const pushesDe = (token) => pushes.filter(p => p.to === `ExponentPushToken[${token}]`)
  const limpar = () => { pushes.length = 0; emails.length = 0 }
  const MSG = 'O prazo deste pedido venceu. Aumente o prazo para escolher este profissional.'

  // ================= 1) ACEITAR EM PEDIDO VENCIDO → 409 PRAZO_VENCIDO, nada muda =================
  const H = {
    reparos: rota('post', '/reparos/:id/interesse/:interesse_id/responder'), obras: rota('post', '/obras/:id/candidatura/:candidaturaId/responder'),
    prestador: rota('post', '/reparos/:id/interesse/:interesse_id/prestador-responder'), pintor: rota('post', '/obras/:id/candidatura/:candidaturaId/pintor-responder'),
  }
  const pAceite = (t, n, id) => (t === 'reparos' ? { id: D(n), interesse_id: id } : { id: D(n), candidaturaId: id })
  for (const [t, n] of [['reparos', 10], ['obras', 11]]) {
    await demanda(t, n, `Vencido ${t}`, `now() - INTERVAL '76 minutes'`)
    const idP = await proposta(t, n, CARMEN)
    const idP2 = await proposta(t, n, OUTRO)
    limpar()
    const r = await chamar(H[t], { usuario: usuarioDono, params: pAceite(t, n, idP), body: { action: 'aceitar' } })
    await assentar()
    const d = await linha(t, n)
    ok(r.status === 409 && r.body.codigo === 'PRAZO_VENCIDO' && r.body.mensagem === MSG && r.body.erro === MSG, `${t}: dono aceita em pedido vencido → 409 PRAZO_VENCIDO com a mensagem aprovada`, r.body)
    ok(d.match_usuario_id === null && d.match_feito_em === null && d.status === 'aberta' && await statusProp(t, idP) === 'pendente' && await statusProp(t, idP2) === 'pendente',
       `${t}: nada mudou (sem match, as duas propostas seguem 'pendente')`)
    ok(pushes.length === 0 && emails.length === 0, `${t}: nenhum push/e-mail saiu`, pushes.map(p => p.title))
    // recusar continua como era (só o aceite é barrado)
    const rc = await chamar(H[t], { usuario: usuarioDono, params: pAceite(t, n, idP2), body: { action: 'recusar' } })
    await assentar()
    ok(rc.status === 200 && await statusProp(t, idP2) === 'recusado', `${t}: recusar em pedido vencido segue funcionando`, rc.body)
    // depois de AUMENTAR o prazo, o mesmo aceite passa
    await db.query(`UPDATE ${t} SET expira_em = now() + INTERVAL '5 hours' WHERE id = $1`, [D(n)])
    const r2 = await chamar(H[t], { usuario: usuarioDono, params: pAceite(t, n, idP), body: { action: 'aceitar' } })
    await assentar()
    ok(r2.status === 200 && (await linha(t, n)).match_usuario_id === CARMEN && await statusProp(t, idP) === 'aceito', `${t}: com o prazo aumentado o aceite passa e casa o profissional`, r2.body)
  }
  // profissional aceitando a contraproposta do dono num pedido vencido: mesma trava, texto dele
  for (const [t, n, h] of [['reparos', 12, 'prestador'], ['obras', 13, 'pintor']]) {
    await demanda(t, n, `Vencido contra ${t}`, `now() - INTERVAL '10 minutes'`)
    const idP = await proposta(t, n, CARMEN, 'contraproposta_dono')
    limpar()
    const r = await chamar(H[h], { usuario: { id: CARMEN, role: 'prestador' }, params: pAceite(t, n, idP), body: { action: 'aceitar' } })
    await assentar()
    ok(r.status === 409 && r.body.codigo === 'PRAZO_VENCIDO' && /cliente precisa aumentar o prazo/.test(r.body.mensagem) && (await linha(t, n)).match_usuario_id === null
       && await statusProp(t, idP) === 'contraproposta_dono' && pushes.length === 0, `${t}: profissional aceita contraproposta em pedido vencido → 409 PRAZO_VENCIDO, nada muda`, r.body)
  }

  // ================= 2) CRONÔMETRO: saída por ATRASO vira desistência + push próprio =================
  const casado = async (t, n, titulo, prof, comHorario) => {
    await demanda(t, n, titulo, `now() - INTERVAL '20 minutes'`, { match_usuario_id: prof })
    await db.query(`UPDATE ${t} SET match_feito_em = now() - INTERVAL '10 hours'${comHorario ? `, chegada_prevista_em = now() - INTERVAL '20 minutes', chegada_janela = 'manha'` : ''} WHERE id = $1`, [D(n)])
    return proposta(t, n, prof, 'aceito')
  }
  // Os pedidos casados na parte 1 saem do caminho do cron (prazo longe).
  await db.query(`UPDATE reparos SET expira_em = now() + INTERVAL '30 days' WHERE id = $1`, [D(10)])
  await db.query(`UPDATE obras SET expira_em = now() + INTERVAL '30 days' WHERE id = $1`, [D(11)])
  await casado('reparos', 20, 'Pia vazando', CARMEN, true)
  await casado('reparos', 21, 'Sem horario', OUTRO, false)
  await casado('obras', 22, 'Pintura sala', CARMEN, true)
  const faltasAntes = (await db.query(`SELECT count(*)::int AS n FROM faltas_profissional`)).rows[0].n
  limpar(); calar()
  await A.verificarCronometroReparos()
  await A.verificarCronometroObras()
  falar()
  for (const [t, n, titulo, chave] of [['reparos', 20, 'Pia vazando', 'reparo_id'], ['obras', 22, 'Pintura sala', 'obra_id']]) {
    const d = await linha(t, n)
    ok(d.match_usuario_id === null && d.status === 'aberta', `${t}: cron desfez o match por atraso (como sempre)`)
    const des = (await db.query(`SELECT * FROM desistencias WHERE tabela = $1 AND demanda_id = $2`, [t, D(n)])).rows
    ok(des.length === 1 && des[0].motivo === 'atraso_chegada' && des[0].usuario_id === CARMEN && des[0].nome_curto === 'Carmen J.' && des[0].foto_url === 'https://x.invalid/carmen.jpg',
       `${t}: 1 linha em desistencias (motivo atraso_chegada, retrato nome/foto)`, des.map(x => [x.motivo, x.nome_curto]))
    const folha = await Des.listarDesistencias(t, D(n))
    ok(folha.length === 1 && folha[0].nome === 'Carmen' && folha[0].motivo === 'atraso_chegada' && folha[0].motivo_texto === 'Não chegou no prazo combinado' && folha[0].usuario_id === CARMEN,
       `${t}: a folha do dono (listarDesistencias) mostra a saída por atraso`, folha)
    const pd = pushesDe('dono').filter(p => p.data[chave] === D(n))
    ok(pd.length === 1 && pd[0].title === '⏰ Carmen não chegou no prazo combinado' && pd[0].body === `Escolha outro profissional para "${titulo}".` && pd[0].data.tipo === 'match_expirado' && pd[0].data.motivo === 'atraso_chegada',
       `${t}: push do dono com o texto aprovado`, pd.map(p => [p.title, p.body]))
    const pp = pushesDe('carmen').filter(p => p.data[chave] === D(n) && p.title === '⏰ Prazo expirado!')
    ok(pp.length === 1 && pp[0].data.motivo === undefined, `${t}: aviso do profissional não mudou ("Prazo expirado!")`, pushesDe('carmen').map(p => p.title))
  }
  const recente = (await db.query(`SELECT id, match_usuario_id FROM reparos WHERE id = $1`, [D(20)])).rows
  await Des.anexarDesistenciaRecente('reparos', recente)
  ok(recente[0].desistencia_recente?.motivo === 'atraso_chegada' && recente[0].desistencia_recente.motivo_texto === 'Não chegou no prazo combinado',
     "reparos: desistencia_recente (/minhas) traz motivo 'atraso_chegada' + o texto", recente[0].desistencia_recente)
  const recenteObra = (await db.query(`SELECT id, match_usuario_id FROM obras WHERE id = $1`, [D(22)])).rows
  await Des.anexarDesistenciaRecente('obras', recenteObra)
  ok(recenteObra[0].desistencia_recente?.motivo === 'atraso_chegada', "obras: desistencia_recente (/minhas) traz motivo 'atraso_chegada'", recenteObra[0].desistencia_recente)
  const f = (await db.query(`SELECT usuario_id, tabela, motivo FROM faltas_profissional ORDER BY tabela`)).rows
  ok(f.length - faltasAntes === 3 && f.filter(x => x.usuario_id === CARMEN).length === 2 && f.filter(x => x.usuario_id === OUTRO && x.motivo === 'não marcou horário').length === 1,
     'faltas iguais às de antes: 1 por atraso em cada demanda da Carmen + "não marcou horário" do outro', f)
  ok((await db.query(`SELECT count(*)::int AS n FROM desistencias WHERE demanda_id = $1`, [D(21)])).rows[0].n === 0
     && pushesDe('dono').some(p => p.data.reparo_id === D(21) && p.title === '⏰ O profissional não marcou horário'),
     'sem horário marcado (não é atraso): sem desistência, dono recebe o texto de sempre')
  calar(); await A.verificarCronometroReparos(); await A.verificarCronometroObras(); falar()
  ok((await db.query(`SELECT count(*)::int AS n FROM desistencias`)).rows[0].n === 2, 'cron de novo: nenhuma desistência duplicada')
  ok(A.tituloDonoAtraso(null) === '⏰ O profissional não chegou no prazo combinado', 'sem nome (conta sumiu): "O profissional não chegou…"')

  // ================= 3) AUMENTAR PRAZO de pedido AINDA VIVO → 1 push neutro a cada ativo =================
  const E = { reparos: rota('post', '/reparos/:id/estender'), obras: rota('post', '/obras/:id/estender') }
  for (const [t, n, chave, tipo] of [['reparos', 30, 'reparo_id', 'novo_reparo'], ['obras', 31, 'obra_id', 'nova_obra']]) {
    await demanda(t, n, `Vivo ${t}`, `now() + INTERVAL '5 hours'`)
    await proposta(t, n, CARMEN, 'pendente'); await proposta(t, n, OUTRO, 'contraproposta_dono'); await proposta(t, n, CONC, 'recusado')
    limpar()
    const r = await chamar(E[t], { usuario: usuarioDono, params: { id: D(n) }, body: { horas: 24 } })
    await assentar()
    const esperado = `"Vivo ${t}" ficou aberto até 06/11. Sua proposta continua valendo.`
    const ps = pushes.filter(p => p.data[chave] === D(n))
    ok(r.status === 200 && ps.length === 2 && ps.every(p => p.title === '⏰ Prazo aumentado' && p.body === esperado && p.data.tipo === tipo && p.data.prazo_estendido === true)
       && ps.map(p => p.to).sort().join() === ['ExponentPushToken[carmen]', 'ExponentPushToken[outro]'].sort().join(),
       `${t}: pendente e contraproposta_dono recebem 1 push "⏰ Prazo aumentado … até 06/11"; recusado e dono não`, ps.map(p => [p.to, p.title, p.body]))
    ok(pushes.length === 2 && emails.length === 0, `${t}: nenhum outro push e nenhum e-mail`, emails.map(e => e.assunto))
    // retry do mesmo clique (dedupe do /estender): nenhum push novo
    limpar()
    const r2 = await chamar(E[t], { usuario: usuarioDono, params: { id: D(n) }, body: { horas: 24 } })
    await assentar()
    ok(r2.status === 200 && pushes.length === 0, `${t}: clique repetido (dedupe) não reenvia`, pushes.map(p => p.title))
  }
  // vencido COM o aviso de vencimento já enviado → só o aviso antigo (push + e-mail), não o novo
  await demanda('reparos', 32, 'Vencido avisado', `now() - INTERVAL '1 hour'`, { escolha_expirou_em: emMin(-30) })
  await proposta('reparos', 32, CARMEN, 'pendente')
  limpar()
  await chamar(E.reparos, { usuario: usuarioDono, params: { id: D(32) }, body: { horas: 24 } }); await assentar()
  ok(pushes.length === 1 && pushes[0].title === '🔄 Prazo aumentado' && /Seu interesse continua valendo/.test(pushes[0].body) && emails.length === 1,
     'vencido com aviso de vencimento: sai o aviso antigo (push + e-mail), intacto, e não o novo', pushes.map(p => p.title))
  // vencido SEM aviso de vencimento → nada (como antes)
  await demanda('reparos', 33, 'Vencido calado', `now() - INTERVAL '1 hour'`)
  await proposta('reparos', 33, CARMEN, 'pendente')
  limpar()
  const rv = await chamar(E.reparos, { usuario: usuarioDono, params: { id: D(33) }, body: { horas: 24 } }); await assentar()
  ok(pushes.length === 0 && emails.length === 0, 'vencido sem aviso de vencimento: nada sai', pushes.map(p => p.title))
  // O diálogo PRAZO_VENCIDO do app manda o dono para cá: pedido VENCIDO é aceito e ganha prazo a partir de AGORA.
  ok(rv.status === 200 && new RealDate(rv.body.expira_em).getTime() === T0 + 24 * 3600000 && new RealDate((await linha('reparos', 33)).expira_em).getTime() === T0 + 24 * 3600000,
     'reparos: /estender aceita pedido já vencido — novo prazo = agora + horas', rv.body)
  // caminho inteiro do diálogo, nos dois lados: 409 PRAZO_VENCIDO → /estender → o MESMO aceite passa
  for (const [t, n] of [['reparos', 35], ['obras', 36]]) {
    await demanda(t, n, `Dialogo ${t}`, `now() - INTERVAL '3 hours'`)
    const idP = await proposta(t, n, CARMEN)
    const a1 = await chamar(H[t], { usuario: usuarioDono, params: pAceite(t, n, idP), body: { action: 'aceitar' } })
    const ex = await chamar(E[t], { usuario: usuarioDono, params: { id: D(n) }, body: { horas: 24 } }); await assentar()
    const a2 = await chamar(H[t], { usuario: usuarioDono, params: pAceite(t, n, idP), body: { action: 'aceitar' } }); await assentar()
    ok(a1.status === 409 && a1.body.codigo === 'PRAZO_VENCIDO' && ex.status === 200 && new RealDate(ex.body.expira_em).getTime() >= T0 + 24 * 3600000
       && a2.status === 200 && (await linha(t, n)).match_usuario_id === CARMEN,
       `${t}: vencido há 3h → 409 PRAZO_VENCIDO → /estender 200 → aceite passa`, [a1.status, ex.status, ex.body.expira_em, a2.status])
  }
  // vivo sem interessado ativo → nada
  await demanda('reparos', 34, 'Vivo sozinho', `now() + INTERVAL '5 hours'`)
  await proposta('reparos', 34, CONC, 'recusado')
  limpar()
  await chamar(E.reparos, { usuario: usuarioDono, params: { id: D(34) }, body: { horas: 24 } }); await assentar()
  ok(pushes.length === 0, 'vivo sem interessado ativo: nada sai')

  // ================= 4) PAINEL: situacao_painel =================
  const ADMIN = { id: U(9), role: 'admin' }
  await demanda('reparos', 40, 'Cancelado depois de vencer', `now() - INTERVAL '3 hours'`, { status: 'cancelada', encerrado_em: emMin(-104) }) // como 4DXCJ: 1h16 depois do prazo
  await demanda('reparos', 41, 'Cancelado no prazo', `now() + INTERVAL '3 hours'`, { status: 'cancelada', encerrado_em: emMin(-10) })
  await demanda('reparos', 42, 'Aberto e vencido', `now() - INTERVAL '2 hours'`)
  await demanda('reparos', 43, 'Feito', `now() - INTERVAL '3 hours'`, { status: 'encerrada', encerrado_em: emMin(-10), match_usuario_id: CARMEN })
  await demanda('obras', 44, 'Obra cancelada depois de vencer', `now() - INTERVAL '3 hours'`, { status: 'cancelada', encerrado_em: emMin(-60) })
  const G = { reparos: rota('get', '/reparos/admin'), obras: rota('get', '/obras/admin') }
  const lista = async (t, filtro) => {
    const r = await chamar(G[t], { usuario: ADMIN, query: { filtro } })
    return Object.fromEntries((r.body[t] || []).map(x => [x.id, x]))
  }
  let l = await lista('reparos', 'canceladas')
  ok(l[D(40)]?.situacao_painel === 'expirada' && l[D(40)].status === 'cancelada', 'reparo cancelado DEPOIS do prazo: situacao_painel expirada, status real cancelada', l[D(40)] && [l[D(40)].status, l[D(40)].situacao_painel])
  ok(l[D(41)]?.situacao_painel === 'cancelada', 'reparo cancelado DENTRO do prazo: situacao_painel cancelada', l[D(41)] && l[D(41)].situacao_painel)
  ok(l[D(42)]?.situacao_painel === 'expirada' && l[D(42)].status === 'aberta' && l[D(42)].expirada === true, 'reparo aberto com prazo vencido: situacao_painel expirada, status real aberta', l[D(42)] && [l[D(42)].status, l[D(42)].situacao_painel])
  l = await lista('reparos', 'finalizadas')
  ok(l[D(43)]?.situacao_painel === 'encerrada', 'reparo concluído com profissional: situacao_painel encerrada (nunca expirada)', l[D(43)] && l[D(43)].situacao_painel)
  l = await lista('reparos', 'abertas')
  ok(l[D(34)]?.situacao_painel === 'aberta', 'reparo aberto no prazo: situacao_painel aberta', l[D(34)] && l[D(34)].situacao_painel)
  l = await lista('obras', 'canceladas')
  ok(l[D(44)]?.situacao_painel === 'expirada' && l[D(44)].status === 'cancelada', 'obra cancelada depois do prazo: situacao_painel expirada', l[D(44)] && [l[D(44)].status, l[D(44)].situacao_painel])

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
