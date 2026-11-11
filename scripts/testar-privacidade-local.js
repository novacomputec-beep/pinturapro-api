#!/usr/bin/env node
// Privacidade do LOCAL da demanda ao profissional (dono, 11/11/2026) — obras e reparos:
//   (1) latitude/longitude ARREDONDADAS a 3 casas no feed (GET /obras, GET /reparos), no detalhe e em
//       GET /reparos/meus-interesses para todo leitor que não seja o dono/admin — inclusive o
//       profissional do match ANTES do horário combinado; exatas para dono, admin e para o escolhido
//       com chegada_prevista_em. O alcance/raio do servidor segue nas colunas exatas.
//   (2) endereco_obra/endereco_reparo e ponto_referencia: null + endereco_liberado:false até o
//       horário ser combinado; depois, só ao escolhido (e dono/admin). bairro/cidade/uf sempre saem.
//   (3) contrato por e-mail às duas partes sai quando o horário é combinado (janela dentro do prazo
//       em POST /:tabela/:id/chegada-prevista, ou 'aceitar' em .../chegada-prevista/responder), UMA
//       vez por match; não sai mais no match.
// SQL REAL num Postgres em memória (PGlite); rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-privacidade-local.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const fs = require('fs')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

const pushes = []
const emails = []
const anexos = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { pushes.push(...chunk); return chunk.map((_, i) => ({ status: 'ok', id: `t${pushes.length}-${i}` })) }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
// PGlite devolve affectedRows; o pg devolve rowCount — as rotas de agendamento decidem por rowCount
// (write real × releitura), então o shim expõe os dois.
const q = async (sql, params) => { if (!db) throw new Error('sem banco (boot)'); const r = await db.query(sql, params); r.rowCount = r.affectedRows ?? r.rows.length; return r }
const shim = { query: q, connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: q, release() {} } }, on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) }, enviarEmailComAnexo: async (m) => { anexos.push(m) } }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) } }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { errOrig('unhandled', e && (e.stack || e)); process.exit(1) } })
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const erros = []
const silenciar = (v) => {
  console.log = v ? () => {} : logOrig
  console.warn = v ? () => {} : warnOrig
  console.error = v ? (...a) => { erros.push(a.map(x => x?.message || String(x)).join(' ')) } : errOrig
}
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const P = require(path.join(REPO, 'src/utils/privacidadeDemanda'))
const obrasCtrl = require(path.join(REPO, 'src/controllers/obrasController'))
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
const assentar = () => new Promise(r => setTimeout(r, 200))
// O contrato sai fire-and-forget depois do res.json (claim + PDF + 2 e-mails): espera até a condição
// valer ou 5 s — nunca falha por tempo, só a asserção seguinte decide.
const esperar = async (cond) => { for (let i = 0; i < 50 && !(await cond()); i++) await new Promise(r => setTimeout(r, 100)) }
const DONO = U(1), PROF = U(2), OUTRO = U(3), ADMIN = U(9)
const ROLE = { [DONO]: 'dono_obra', [ADMIN]: 'admin' }
const rota = (metodo, caminho) => router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo]).route
const handlerDe = (metodo, caminho) => rota(metodo, caminho).stack[rota(metodo, caminho).stack.length - 1].handle
const chamar = (handler, usuarioId, id, body = {}, query = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params: { id }, body, query, usuario: { id: usuarioId, role: ROLE[usuarioId] || 'prestador', tipo_prestador: ROLE[usuarioId] ? null : 'reparador' }, get() { return '' } }, res)
})
const quieto = async (fn) => { silenciar(true); const n0 = erros.length; try { return await fn() } finally { await assentar(); silenciar(false); if (process.env.DEBUG_ERROS && erros.length > n0) logOrig('   [erros]', erros.slice(n0).join(' || ').slice(0, 800)) } }
const detalhe = (tabela, id, quem) => quieto(() => chamar(handlerDe('get', `/${tabela}/:id`), quem, id))
const LAT = -18.578912, LNG = -46.518134, LAT3 = -18.579, LNG3 = -46.518
const local = (r, chave) => r.status !== 200 ? { status: r.status, erro: r.body } : (({ latitude, longitude, endereco_obra, endereco_reparo, ponto_referencia, endereco_liberado, bairro, cidade, uf }) =>
  ({ latitude, longitude, endereco: endereco_obra ?? endereco_reparo, ponto_referencia, endereco_liberado, bairro, cidade, uf }))(r.body[chave])
const exato = (l, endereco) => l.latitude === LAT && l.longitude === LNG && l.endereco === endereco && l.ponto_referencia === 'Portão azul' && l.endereco_liberado === true
const oculto = (l) => l.latitude === LAT3 && l.longitude === LNG3 && l.endereco === null && l.ponto_referencia === null && l.endereco_liberado === false && l.bairro === 'Centro' && l.cidade === 'Patos de Minas' && l.uf === 'MG'
const contratos = async () => (await db.query(`SELECT candidatura_id, interesse_id, status FROM contratos ORDER BY criado_em`)).rows

const main = async () => {
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, descricao text, categoria text, categorias text[], valor numeric, valor_estimado numeric, cidade text, bairro text, uf text, estado text, tags text[],
      latitude double precision, longitude double precision, coordenadas_origem text, metragem numeric, prazo_execucao_dias int, ultima_extensao_horas numeric, endereco_obra text, endereco_reparo text, ponto_referencia text,
      criado_por uuid, status text DEFAULT 'aberta', status_aprovacao text DEFAULT 'aprovada', encerrado_em timestamptz, client_request_id text, enviada_por_dono boolean, prazo_timezone text,
      match_usuario_id uuid, match_feito_em timestamptz, expira_em timestamptz, criado_em timestamptz DEFAULT now(), contrato_enviado boolean DEFAULT false,
      encerramento_solicitado_por uuid, encerramento_solicitado_em timestamptz,
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
    CREATE TABLE contratos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), candidatura_id uuid UNIQUE, interesse_id uuid, status text, valor_acordado numeric, criado_em timestamptz DEFAULT now());
    CREATE UNIQUE INDEX contratos_interesse_id_uniq ON contratos (interesse_id) WHERE interesse_id IS NOT NULL;
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
  await require(path.join(REPO, 'src/utils/responsabilidade')).migrarResponsabilidade(db)
  await require(path.join(REPO, 'src/utils/especialidadesInferidas')).migrarEspecialidadesInferidas(db)
  await db.query(`INSERT INTO usuarios (id, nome, email, push_token, role, tipo_dono, tipo_prestador, cpf_cnpj, telefone, cidade, uf, latitude, longitude, especialidades) VALUES
    ($1, 'Maria Souza', 'maria@x.invalid', 'ExponentPushToken[maria]', 'dono_obra', 'reparo', NULL, '11111111111', '34999990000', 'Patos de Minas', 'MG', $5, $6, NULL),
    ($2, 'Alex Silva', 'alex@x.invalid', 'ExponentPushToken[alex]', 'prestador', NULL, 'reparador', '22222222222', '34988880000', 'Patos de Minas', 'MG', $5, $6, '{eletrica,pintor}'),
    ($3, 'Outro Pro', 'outro@x.invalid', 'ExponentPushToken[outro]', 'prestador', NULL, 'reparador', '33333333333', NULL, 'Patos de Minas', 'MG', $5, $6, '{eletrica,pintor}'),
    ($4, 'Admin', 'admin@x.invalid', NULL, 'admin', NULL, NULL, '99999999999', NULL, NULL, NULL, NULL, NULL, NULL)`,
    [DONO, PROF, OUTRO, ADMIN, LAT + 0.01, LNG + 0.01])
  await db.query(`INSERT INTO assinaturas (usuario_id, status, tipo, plano, valor_mensal) VALUES ($1, 'ativa', 'gratuito', 'mensal', 49.90), ($2, 'ativa', 'gratuito', 'mensal', 49.90)`, [PROF, OUTRO])
  await fixarAgora(0)
  const O1 = D(1), R1 = D(2), R2 = D(3)
  await db.query(`INSERT INTO obras (id, titulo, descricao, categoria, criado_por, valor, horas_para_expirar, expira_em, publicado_em, cidade, bairro, uf, latitude, longitude, endereco_obra, ponto_referencia, prazo_execucao_dias)
    VALUES ($1, 'Pintura da sala', 'Duas demãos', 'residencial', $2, 3000, 480, now() + INTERVAL '20 days', now(), 'Patos de Minas', 'Centro', 'MG', $3, $4, 'Rua A, 10', 'Portão azul', 5)`, [O1, DONO, LAT, LNG])
  for (const [id, titulo] of [[R1, 'Trocar chuveiro'], [R2, 'Tomada']]) {
    await db.query(`INSERT INTO reparos (id, titulo, descricao, categoria, categorias, criado_por, valor_estimado, prazo_atendimento_horas, expira_em, publicado_em, cidade, bairro, uf, latitude, longitude, endereco_reparo, ponto_referencia)
      VALUES ($1, $2, 'Resistência queimada', 'eletrica', '{eletrica}', $3, 150, 72, now() + INTERVAL '72 hours', now(), 'Patos de Minas', 'Centro', 'MG', $4, $5, 'Rua B, 20', 'Portão azul')`, [id, titulo, DONO, LAT, LNG])
  }

  // ═══ 0. Helper e fiação estática ═══════════════════════════════════════════════════════════
  ok(P.CASAS_COORDENADA === 3 && P.arredondarCoordenada('-18.578912') === '-18.579' && P.arredondarCoordenada(-46.518134) === -46.518 && P.arredondarCoordenada(null) === null && P.arredondarCoordenada('abc') === 'abc',
     'arredondarCoordenada: 3 casas, preserva o tipo (string do NUMERIC / número), deixa null e lixo em paz')
  const fonteRotas = fs.readFileSync(path.join(REPO, 'src/routes/index.js'), 'utf8')
  const fonteCand = fs.readFileSync(path.join(REPO, 'src/controllers/candidaturasController.js'), 'utf8')
  ok(!/enviarContrato(Obra|Reparo)\(/.test(fonteRotas) && !/enviarContrato(Obra|Reparo)\(/.test(fonteCand), 'nenhuma rota de match chama mais enviarContratoObra/Reparo')
  ok((fonteRotas.match(/enviarContratoAoAgendar\(tabela, req\.params\.id\)/g) || []).length === 2, 'enviarContratoAoAgendar chamado nos 2 pontos que gravam chegada_prevista_em (janela no prazo + aceitar)')

  // ═══ 1. OBRA — detalhe por leitor ══════════════════════════════════════════════════════════
  let r = await detalhe('obras', O1, DONO)
  ok(r.status === 200 && exato(local(r, 'obra'), 'Rua A, 10'), 'obra/dono: coordenadas exatas, endereço, ponto de referência, endereco_liberado true', local(r, 'obra'))
  r = await detalhe('obras', O1, OUTRO)
  ok(r.status === 200 && oculto(local(r, 'obra')), 'obra/assinante sem vínculo: lat/lng a 3 casas, endereço e ponto null, endereco_liberado false; bairro/cidade/uf saem', local(r, 'obra'))
  r = await detalhe('obras', O1, ADMIN)
  ok(r.status === 200 && exato(local(r, 'obra'), 'Rua A, 10'), 'obra/admin: tudo exato', local(r, 'obra'))
  // candidatura ACEITA sem match (antes via o endereço; agora não)
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status, valor_proposto) VALUES ($1, $2, 'aceito', 2800)`, [O1, PROF])
  r = await detalhe('obras', O1, PROF)
  ok(r.status === 200 && oculto(local(r, 'obra')) && r.body.minha_candidatura?.status === 'aceito', 'obra/candidato com aceite mas sem match: ainda oculto', local(r, 'obra'))
  // match sem horário
  await db.query(`UPDATE obras SET match_usuario_id = $2, match_feito_em = now() WHERE id = $1`, [O1, PROF])
  r = await detalhe('obras', O1, PROF)
  ok(r.status === 200 && oculto(local(r, 'obra')) && r.body.sou_escolhido === true && r.body.dono_nome === 'Maria S.',
     'obra/escolhido SEM horário: oculto (coordenadas a 3 casas, endereço null, endereco_liberado false); dono_nome segue', { ...local(r, 'obra'), dono_nome: r.body.dono_nome })
  ok((await contratos()).length === 0 && anexos.length === 0, 'match feito: NENHUM contrato enviado ainda (nem linha em contratos, nem e-mail)', { contratos: (await contratos()).length, anexos: anexos.length })
  // horário combinado pela janela 'hoje' (cabe no prazo) → endereço liberado + contrato
  r = await quieto(() => chamar(handlerDe('post', '/obras/:id/chegada-prevista'), PROF, O1, { janela: 'hoje' }))
  ok(r.status === 200 && r.body.chegada_prevista_em && !r.body.chegada_pendente_em, 'POST /obras/:id/chegada-prevista {janela:hoje}: horário valendo', { status: r.status, prevista: !!r.body.chegada_prevista_em })
  await esperar(async () => anexos.length >= 2)
  if (process.env.DEBUG_ERROS && anexos.length < 2) logOrig('   [erros]', erros.slice(-5).join(' || ').slice(0, 800))
  let cs = await contratos()
  ok(cs.length === 1 && cs[0].candidatura_id && cs[0].status === 'enviado' && anexos.length === 2 && anexos.every(a => /Contrato/.test(a.assunto)) && new Set(anexos.map(a => a.para)).size === 2 && anexos.some(a => a.para === 'maria@x.invalid') && anexos.some(a => a.para === 'alex@x.invalid'),
     'horário combinado → contrato da obra: 1 linha em contratos (candidatura_id) + 2 e-mails com anexo (dono e profissional)', { contratos: cs.length, para: anexos.map(a => a.para) })
  ok(anexos[0] && /Rua A, 10/.test(anexos[0].html) && /Maria Souza/.test(anexos[0].html), 'e-mail do contrato traz endereço e nome do dono (como antes, só o momento mudou)')
  ok((await db.query(`SELECT contrato_enviado FROM obras WHERE id = $1`, [O1])).rows[0].contrato_enviado === true, 'obras.contrato_enviado marcado')
  r = await detalhe('obras', O1, PROF)
  ok(r.status === 200 && exato(local(r, 'obra'), 'Rua A, 10'), 'obra/escolhido COM horário: coordenadas exatas, endereço, ponto, endereco_liberado true', local(r, 'obra'))
  r = await detalhe('obras', O1, OUTRO)
  ok(r.status === 200 && oculto(local(r, 'obra')), 'obra/outro assinante depois do horário: segue oculto', local(r, 'obra'))
  // repetir a janela (rowCount 0, retry/reabertura) não manda 2º contrato
  r = await quieto(() => chamar(handlerDe('post', '/obras/:id/chegada-prevista'), PROF, O1, { janela: 'hoje' }))
  ok(r.status === 200 && (await contratos()).length === 1 && anexos.length === 2, 'repetir a janela: nenhum contrato novo (claim por candidatura)', { contratos: (await contratos()).length, anexos: anexos.length })

  // ═══ 2. REPARO — proposta PENDENTE não libera; 'aceitar' do dono libera e manda o contrato ═══
  anexos.length = 0
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status, valor_proposto) VALUES ($1, $2, 'aceito', 140)`, [R1, PROF])
  await db.query(`UPDATE reparos SET match_usuario_id = $2, match_feito_em = now() WHERE id = $1`, [R1, PROF])
  r = await detalhe('reparos', R1, PROF)
  ok(r.status === 200 && oculto(local(r, 'reparo')) && r.body.sou_escolhido === true, 'reparo/escolhido sem horário: oculto', local(r, 'reparo'))
  r = await detalhe('reparos', R1, DONO)
  ok(r.status === 200 && exato(local(r, 'reparo'), 'Rua B, 20'), 'reparo/dono: exato', local(r, 'reparo'))
  // proposta do profissional DEPOIS do prazo → pendente, aguardando o dono (prazo encurtado para
  // hoje 20h SP; a janela 'amanha_manha' estoura)
  await db.query(`UPDATE reparos SET expira_em = now() + INTERVAL '10 hours' WHERE id = $1`, [R1])
  r = await quieto(() => chamar(handlerDe('post', '/reparos/:id/chegada-prevista'), PROF, R1, { janela: 'amanha_manha' }))
  ok(r.status === 200 && r.body.chegada_pendente_em && !r.body.chegada_prevista_em, 'proposta além do prazo: fica PENDENTE', { status: r.status, pendente: !!r.body.chegada_pendente_em })
  ok((await contratos()).length === 1 && anexos.length === 0, 'proposta pendente NÃO manda contrato', { contratos: (await contratos()).length, anexos: anexos.length })
  r = await detalhe('reparos', R1, PROF)
  ok(r.status === 200 && oculto(local(r, 'reparo')), 'reparo/escolhido com proposta pendente: ainda oculto', local(r, 'reparo'))
  // dono aceita → horário combinado
  r = await quieto(() => chamar(handlerDe('post', '/reparos/:id/chegada-prevista/responder'), DONO, R1, { acao: 'aceitar' }))
  ok(r.status === 200 && r.body.chegada_prevista_em, 'POST .../chegada-prevista/responder {aceitar} pelo dono: horário valendo', { status: r.status, prevista: !!r.body.chegada_prevista_em })
  await esperar(async () => anexos.length >= 2)
  cs = await contratos()
  // Nota: o contrato de REPARO lê reparo.endereco_obra (contratosController :72/:313), coluna que não
  // existe em reparos (a coluna é endereco_reparo) — cai em "cidade, bairro". Comportamento ANTIGO,
  // fora deste ajuste; conferido aqui só para não passar despercebido se mudar.
  ok(cs.length === 2 && cs.some(c => c.interesse_id) && cs.some(c => c.candidatura_id) && anexos.length === 2 && anexos.some(a => a.para === 'maria@x.invalid') && anexos.some(a => a.para === 'alex@x.invalid') && anexos[0] && /Patos de Minas, Centro/.test(anexos[0].html),
     'aceite do horário → contrato do reparo: linha em contratos (interesse_id) + 2 e-mails (endereço do reparo = cidade, bairro — como antes)', { contratos: cs.length, para: anexos.map(a => a.para) })
  r = await detalhe('reparos', R1, PROF)
  ok(r.status === 200 && exato(local(r, 'reparo'), 'Rua B, 20'), 'reparo/escolhido COM horário: exato + endereço + endereco_liberado true', local(r, 'reparo'))
  // remarcar e aceitar de novo: mesmo match → sem 2º contrato
  await db.query(`UPDATE reparos SET chegada_prevista_em = NULL, chegada_janela = NULL, chegada_pendente_em = now() + INTERVAL '5 days', chegada_pendente_janela = 'agendado', chegada_proposta_por = $2, chegada_proposta_em = now() WHERE id = $1`, [R1, PROF])
  r = await quieto(() => chamar(handlerDe('post', '/reparos/:id/chegada-prevista/responder'), DONO, R1, { acao: 'aceitar' }))
  ok(r.status === 200 && (await contratos()).length === 2 && anexos.length === 2, 'remarcação aceita no MESMO match: nenhum contrato novo (uma vez por match)', { contratos: (await contratos()).length, anexos: anexos.length })

  // ═══ 3. FEEDS e meus-interesses ════════════════════════════════════════════════════════════
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status, valor_proposto) VALUES ($1, $2, 'pendente', 120)`, [R2, PROF])
  r = await quieto(() => chamar(handlerDe('get', '/reparos'), OUTRO, undefined, {}, { raio_km: 'cidade' }))
  const cardR2 = (r.body.reparos || []).find(x => x.id === R2)
  ok(r.status === 200 && cardR2 && cardR2.latitude === LAT3 && cardR2.longitude === LNG3 && cardR2.bairro === 'Centro' && !('endereco_reparo' in cardR2),
     'GET /reparos (feed): coordenadas a 3 casas, bairro sai, endereço não existe no card', cardR2 && { lat: cardR2.latitude, lng: cardR2.longitude })
  ok((r.body.reparos || []).some(x => x.id === R2), 'feed: filtro por raio/cidade continua achando o reparo (conta nas colunas exatas do banco)')
  await db.query(`UPDATE usuarios SET raio_km_escolhido = NULL WHERE id = $1`, [OUTRO])
  await db.query(`UPDATE obras SET match_usuario_id = NULL, match_feito_em = NULL, chegada_prevista_em = NULL, chegada_janela = NULL WHERE id = $1`, [O1])
  r = await quieto(() => chamar(obrasCtrl.listar, OUTRO, undefined, {}, { raio_km: 'cidade' }))
  const cardO1 = (r.body.obras || []).find(x => x.id === O1)
  ok(r.status === 200 && cardO1 && cardO1.latitude === LAT3 && cardO1.longitude === LNG3 && !('endereco_obra' in cardO1), 'GET /obras (feed): coordenadas a 3 casas', cardO1 ? { lat: cardO1.latitude, lng: cardO1.longitude } : r.body)
  r = await quieto(() => chamar(handlerDe('get', '/reparos/meus-interesses'), PROF))
  const porReparo = Object.fromEntries([...(r.body.ativos || []), ...(r.body.historico || [])].map(i => [i.reparo_id, i]))
  ok(r.status === 200 && porReparo[R1]?.latitude === LAT && porReparo[R1]?.longitude === LNG, 'meus-interesses: reparo em que sou o match COM horário → coordenadas exatas', porReparo[R1] && { lat: porReparo[R1].latitude })
  ok(porReparo[R2]?.latitude === LAT3 && porReparo[R2]?.longitude === LNG3, 'meus-interesses: interesse pendente → coordenadas a 3 casas', porReparo[R2] && { lat: porReparo[R2].latitude })

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig("MAIN FALHOU:", e && (e.stack || e)); process.exit(1) })
