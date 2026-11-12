#!/usr/bin/env node
// PEDIDO CANCELADO PELO DONO (dono, 12/11/2026): DELETE /reparos/dono/:id e /obras/dono/:id de uma demanda
// ABERTA sem match → push (sem e-mail) "🔕 Pedido cancelado" / "\"<título>\" foi cancelado pelo cliente.",
// data { tipo: 'pedido_cancelado', reparo_id | obra_id }, a cada PESSOA com interesse ainda ativo (fora:
// recusado, cancelado/desistiu, expirado; NULL = pendente), menos suspensos. Já cancelada, expirada, com match real (409) ou de outro dono (404): nada.
// SQL REAL em PGlite; rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-pedido-cancelado-dono.js
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

  const PS = U(7), PN = U(8)
  const igualData = (a, b) => JSON.stringify(Object.keys(a).sort().map(k => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map(k => [k, b[k]]))
  await usr(PA2, 'Ana (2ª conta)', 'prestador', { tipo_prestador: 'reparador', cpf: '333', esp: ['eletrica'] })
  await usr(PS, 'Sérgio', 'prestador', { tipo_prestador: 'reparador', cpf: '777', esp: ['eletrica'] })
  await usr(PN, 'Nina', 'prestador', { tipo_prestador: 'reparador', cpf: '888', esp: ['eletrica'], semToken: true })
  await db.query(`UPDATE usuarios SET suspenso_em = now() WHERE id = $1`, [PS])
  // Interesses inativos: X1 cancelado (desistiu pelo profissional), X2 'desistiu', X3 expirado.
  // X4 com status NULL conta como pendente (ativo).
  const X1 = U(11), X2 = U(12), X3 = U(13), X4 = U(14)
  await usr(X1, 'Xico', 'prestador', { tipo_prestador: 'reparador', cpf: '1111', esp: ['eletrica'] })
  await usr(X2, 'Xena', 'prestador', { tipo_prestador: 'reparador', cpf: '1112', esp: ['eletrica'] })
  await usr(X3, 'Xavier', 'prestador', { tipo_prestador: 'reparador', cpf: '1113', esp: ['eletrica'] })
  await usr(X4, 'Xuxa', 'prestador', { tipo_prestador: 'reparador', cpf: '1114', esp: ['eletrica'] })

  const TIT = '🔕 Pedido cancelado'
  let n = 100
  // Demanda ABERTA; match opcional. Interessados: A pendente, A2 (mesma pessoa de A) pendente,
  // B contraproposta_dono, C recusado, S suspenso pendente, N sem token pendente.
  const nova = async (tabela, { status = 'aberta', match = null, aceito = false } = {}) => {
    const id = D(n++)
    titulos[id] = `${tabela === 'reparos' ? 'Serviço' : 'Obra'} ${n}`
    await db.query(`INSERT INTO ${tabela} (id, titulo, categoria, criado_por, valor, valor_estimado, cidade, uf, status, match_usuario_id, match_feito_em, expira_em, publicado_em)
                    VALUES ($1, $2, 'eletrica', $3, 100, 100, 'Uberlândia', 'MG', $4, $5::uuid, CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END, now() + INTERVAL '2 days', now() - INTERVAL '1 day')`,
      [id, titulos[id], DONO, status, match])
    const l = LADO[tabela]
    await db.query(`INSERT INTO ${l.proposta} (${l.coluna}, usuario_id, status) VALUES
      ($1, $2, 'pendente'), ($1, $3, 'pendente'), ($1, $4, 'contraproposta_dono'), ($1, $5, 'recusado'), ($1, $6, 'pendente'), ($1, $7, 'pendente'),
      ($1, $8, 'cancelado'), ($1, $9, 'desistiu'), ($1, $10, 'expirado'), ($1, $11, NULL)`, [id, PA, PA2, PB, PC, PS, PN, X1, X2, X3, X4])
    if (aceito) await db.query(`INSERT INTO ${l.proposta} (${l.coluna}, usuario_id, status) VALUES ($1, $2, 'aceito')`, [id, match])
    return id
  }
  const cancelados = (p0) => pushes.slice(p0).filter(p => p.title === TIT)

  for (const tabela of ['reparos', 'obras']) {
    const chave = LADO[tabela].chave
    const rotaDel = `/${tabela}/dono/:id`

    // Aberta sem match: A (uma vez pela pessoa A/A2) e B recebem; C, S, N, dono não.
    let id = await nova(tabela)
    let p0 = pushes.length, e0 = emails.length
    let r = await quieto(() => chamar('delete', rotaDel, DONO, id))
    const ps = cancelados(p0)
    ok(r.status === 200, `${tabela}: DELETE responde 200 (resposta inalterada)`, r)
    ok(ps.length === 3 && ps.filter(p => [tok(PA), tok(PA2)].includes(p.to)).length === 1 && ps.some(p => p.to === tok(PB)) && ps.some(p => p.to === tok(X4)),
       `${tabela}: push a A (uma vez por pessoa, A/A2), B e ao interesse com status NULL`, ps.map(p => p.to))
    ok(![X1, X2, X3].some(u => ps.some(p => p.to === tok(u))), `${tabela}: cancelado, desistiu e expirado não recebem`)
    ok(ps.every(p => p.body === `"${titulos[id]}" foi cancelado pelo cliente.` && igualData(p.data, { tipo: 'pedido_cancelado', [chave]: id })),
       `${tabela}: texto e data exatos`, ps[0] && [ps[0].body, ps[0].data])
    ok(![PC, PS, DONO].some(u => cancelados(p0).some(p => p.to === tok(u))), `${tabela}: recusado, suspenso e dono não recebem`)
    ok(emails.length === e0, `${tabela}: nenhum e-mail`)
    const st = (await db.query(`SELECT status, status_aprovacao FROM ${tabela} WHERE id = $1`, [id])).rows[0]
    ok(st.status === 'cancelada' && st.status_aprovacao === 'cancelada', `${tabela}: cancelamento segue igual`, st)

    // Já cancelada: DELETE de novo não avisa ninguém.
    p0 = pushes.length
    r = await quieto(() => chamar('delete', rotaDel, DONO, id))
    ok(r.status === 200 && cancelados(p0).length === 0, `${tabela}: já cancelada → nenhum push`, r.status)

    // Com match real → 409, nenhum push.
    id = await nova(tabela, { match: PRO, aceito: true })
    p0 = pushes.length
    r = await quieto(() => chamar('delete', rotaDel, DONO, id))
    ok(r.status === 409 && cancelados(p0).length === 0, `${tabela}: match real → 409, nenhum push`, r.status)

    // Expirada (status != aberta) → cancela sem aviso.
    id = await nova(tabela, { status: 'expirada' })
    p0 = pushes.length
    r = await quieto(() => chamar('delete', rotaDel, DONO, id))
    ok(r.status === 200 && cancelados(p0).length === 0, `${tabela}: expirada → nenhum push`, r.status)

    // Não é o dono → 404, nenhum push.
    id = await nova(tabela)
    p0 = pushes.length
    r = await quieto(() => chamar('delete', rotaDel, PB, id))
    ok(r.status === 404 && cancelados(p0).length === 0, `${tabela}: outro usuário → 404, nenhum push`, r.status)
  }

  const errosReais = erros.filter(e => !/sem banco/.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
