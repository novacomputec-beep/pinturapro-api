#!/usr/bin/env node
// Lado contratante unificado, Fase 1 (decisão do dono, 07/11/2026): posse de demanda por PESSOA.
// Uma pessoa com conta dono_obra (A) e dono_reparo (B), mesmo CPF, gerencia as obras E os
// serviços de qualquer uma das duas sem trocar de conta (utils/tipoConta.sqlContasDaPessoa /
// ehMesmaPessoa, só CPF normalizado — NUNCA e-mail). Cobre: listas /minhas, candidaturas
// aprovar/recusar, encerrar, avaliar, cancelamento, desfazer escolha, perguntas, GET /auth/contas
// (tem_obras) e a entrega "uma vez por pessoa" (alertaService.contatoDaPessoa). Contra-casos:
// ESTRANHO com o MESMO e-mail e outro CPF (S) e conta SEM CPF (N) — só a própria conta.
// SQL REAL num Postgres em memória (PGlite); Expo/Brevo falsos que só coletam.
//   npm i -D @electric-sql/pglite && node scripts/testar-dono-mesma-pessoa.js
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
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error
console.log = () => {}; console.error = () => {}
const router = require(path.join(REPO, 'src/routes/index.js'))
console.log = logOrig; console.error = errOrig
const candCtrl = require(path.join(REPO, 'src/controllers/candidaturasController'))
const authCtrl = require(path.join(REPO, 'src/controllers/authController'))
const { avisarUsuario, contatoDaPessoa } = require(path.join(REPO, 'src/services/alertaService'))
const { contasDaPessoa, ehMesmaPessoa } = require(path.join(REPO, 'src/utils/tipoConta'))

const rota = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const chamar = (handler, { usuario, params = {}, query = {}, body = {} }) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, query, body, usuario, get: () => '', headers: {}, ip: '127.0.0.1' }, res)
})
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const C = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`
// A: dono_obra | B: dono_reparo (mesma pessoa, CPF 111) | S: estranho, MESMO e-mail, CPF 222 |
// N: dono sem CPF | P: pintor (match) | Q: outro pintor (candidato) | X: reparador da própria pessoa (CPF 111)
const A = { id: U(1), role: 'dono_obra', email: 'pessoa@x.invalid' }
const B = { id: U(2), role: 'dono_obra', email: 'pessoa@x.invalid' }
const S = { id: U(3), role: 'dono_obra', email: 'pessoa@x.invalid' }
const N = { id: U(4), role: 'dono_obra', email: 'semcpf@x.invalid' }
const P = { id: U(5), role: 'prestador', tipo_prestador: 'pintor' }
const Q = { id: U(6), role: 'prestador', tipo_prestador: 'pintor' }
const X = { id: U(7), role: 'prestador', tipo_prestador: 'reparador', email: 'pessoa@x.invalid' }
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const assentar = () => new Promise(r => setTimeout(r, 120))
const texto = (r) => JSON.stringify(r.body)

const main = async () => {
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, descricao text, categoria text, cidade text, uf text, bairro text, criado_por uuid, status text DEFAULT 'aberta',
      status_aprovacao text DEFAULT 'aprovada', encerrado_em timestamptz, encerramento_solicitado_por uuid, encerramento_solicitado_em timestamptz,
      match_usuario_id uuid, match_feito_em timestamptz, expira_em timestamptz, criado_em timestamptz DEFAULT now(), publicado_em timestamptz,
      chegada_prevista_em timestamptz, chegada_pendente_em timestamptz, chegada_pendente_janela text, chegada_janela text,
      chegada_declarada_por uuid, chegada_declarada_em timestamptz, chegada_recusada_em timestamptz, chegada_confirmada_em timestamptz,
      a_caminho_em timestamptz, pedido_tempo_status text, pedido_tempo_motivo text, pedido_tempo_minutos int,
      aviso_match_enviado_em timestamptz, lembrete_chegada_enviado_em timestamptz, chegada_proposta_por uuid, chegada_pendente_rodada int DEFAULT 0,
      lembrete_agenda_vespera_em timestamptz, lembrete_agenda_2h_em timestamptz, lembrete_agenda_hora_em timestamptz, lembrete_agenda_dono_vespera_em timestamptz,
      lembrete_agenda_dono_2h_em timestamptz, vigia_comparecimento_em timestamptz, comparecimento_resposta text, comparecimento_respondido_em timestamptz,
      lembrete_agendar_offsets int[] NOT NULL DEFAULT '{}', lembrete_agendar_ultimo_em timestamptz, lembrete_agendar_dono_em timestamptz, lembrete_agendar_ciclo int DEFAULT 0,
      lembrete_agendar_enviados int NOT NULL DEFAULT 0, lembrete_agendar_sem_proposta int NOT NULL DEFAULT 0, horario_vencido_em timestamptz, horarios_vencidos int NOT NULL DEFAULT 0, desfazer_aviso_em timestamptz, chegada_proposta_em timestamptz, lembrete_resposta_1h_em timestamptz,
      lembrete_resposta_antes_em timestamptz, lembrete_resposta_ultimo_em timestamptz, aviso_resposta_final_em timestamptz, sugestoes_horario_dono int DEFAULT 0, sugestoes_horario_profissional int DEFAULT 0,
      prazo_chegada_extra_em timestamptz, aviso_atraso_enviado_em timestamptz, pedido_atraso_minutos int, pedido_atraso_motivo text, pedido_atraso_em timestamptz,
      pedido_atraso_status text, pedido_atraso_respondido_em timestamptz, pedidos_atraso_usados int DEFAULT 0, cancelamento_pedido_por uuid, cancelamento_pedido_motivo text,
      cancelamento_pedido_detalhe text, cancelamento_pedido_em timestamptz, cancelamento_pedido_expira_em timestamptz, prestadores_bloqueados uuid[],
      prazo_modo text, prazo_timezone text, latitude numeric, longitude numeric, tags text[], valor_aumentado_em timestamptz, ultima_extensao_em timestamptz,
      ultima_extensao_horas numeric, aval_dispensada_em timestamptz, push_novo_enviado_em timestamptz, client_request_id text, codigo_publico text,
      marco_1_em timestamptz, marco_2_em timestamptz, marco_3_em timestamptz, escolha_aviso_24h_em timestamptz, escolha_aviso_2h_em timestamptz, escolha_expirou_em timestamptz,
      alerta_enviado_em timestamptz, alerta_sem_interessados_em timestamptz, endereco_obra text, endereco_reparo text, ponto_referencia text, coordenadas_origem text, enviada_por_dono boolean`
  const colsProposta = (fk) => `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${fk} uuid, usuario_id uuid, status text DEFAULT 'pendente', status_antes_match text,
      valor_proposto numeric, valor_contraproposta numeric, valor_oferta numeric, mensagem text, mensagem_oferta text, referencias text, aprovado_por uuid, rodada int DEFAULT 1,
      criado_em timestamptz DEFAULT now(), cancelado_por uuid, cancelado_motivo text, cancelado_detalhe text, cancelado_em timestamptz, cancelado_acordo boolean DEFAULT false`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, telefone text, cidade text, role text, tipo_dono text, tipo_prestador text, cpf_cnpj text,
      ativo boolean DEFAULT true, push_token text, criado_em timestamptz DEFAULT now(), suspenso_em timestamptz, suspenso_motivo text, desinstalado_em timestamptz,
      foto_url text, logradouro text, numero text, bairro text, senha_hash text, boas_vindas_exibida boolean, token_version int DEFAULT 1, verificacao_status text, referencias text,
      especialidades text[], uf text);
    ALTER TABLE usuarios ADD COLUMN avisos_todas_areas boolean NOT NULL DEFAULT true; -- preferência do aviso "fora da sua área" (migração de boot)
    CREATE TABLE reparos (${colsDemanda}, categorias text[], valor_estimado numeric, prazo_atendimento_horas numeric);
    CREATE TABLE obras (${colsDemanda}, valor numeric, horas_para_expirar numeric, metragem numeric, prazo_execucao_dias int);
    CREATE TABLE candidaturas (${colsProposta('obra_id')});
    CREATE TABLE interesse_reparos (${colsProposta('reparo_id')});
    CREATE UNIQUE INDEX candidaturas_aceito_unica_idx ON candidaturas (obra_id) WHERE status = 'aceito';
    CREATE TABLE midias (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, url text, ordem int);
    CREATE TABLE midias_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, url text, ordem int);
    CREATE TABLE avaliacoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contrato_tipo text, contrato_id uuid, avaliador_id uuid, avaliado_id uuid, estrelas int, etiquetas text[],
      criado_em timestamptz DEFAULT now(), UNIQUE (contrato_tipo, contrato_id, avaliador_id));
    CREATE TABLE faltas_profissional (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, tabela text, demanda_id uuid, motivo text, criado_em timestamptz DEFAULT now(), perdoada_em timestamptz);
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz DEFAULT now());
    CREATE TABLE perguntas_demanda (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tipo text, demanda_id uuid, autor_id uuid, pergunta text, resposta text, criado_em timestamptz DEFAULT now(), respondido_em timestamptz, respondida_por uuid, lembrete_enviado_em timestamptz);
    CREATE TABLE contratos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tipo text, demanda_id uuid, interesse_id uuid, valor_acordado numeric, criado_em timestamptz DEFAULT now());
    CREATE TABLE tentativas_contato (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, criado_em timestamptz DEFAULT now());
    SET search_path = public, pg_catalog;
  `)
  await db.exec(`CREATE TABLE IF NOT EXISTS assinaturas (usuario_id uuid, status text, tipo text, plano text, proximo_vencimento timestamptz, atualizado_em timestamptz)`)
  // Responsabilidade pós-match (eventos_responsabilidade, dias_credito_*, aviso_resposta_final_em) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/responsabilidade')).migrarResponsabilidade(db)
  // obras.especialidades_inferidas (capacidadesDaPessoa / feed / aviso de obra nova leem a coluna) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/especialidadesInferidas')).migrarEspecialidadesInferidas(db)
  await db.query(`INSERT INTO usuarios (id, nome, email, role, tipo_dono, tipo_prestador, cpf_cnpj, push_token) VALUES
    ($1, 'Pessoa (obra)',   'pessoa@x.invalid', 'dono_obra', 'pintura', NULL, '111.111.111-11', NULL),
    ($2, 'Pessoa (reparo)', 'pessoa@x.invalid', 'dono_obra', 'reparo',  NULL, '11111111111',    'ExponentPushToken[B]'),
    ($3, 'Estranho',        'pessoa@x.invalid', 'dono_obra', 'reparo',  NULL, '222.222.222-22', 'ExponentPushToken[S]'),
    ($4, 'Sem CPF',         'semcpf@x.invalid', 'dono_obra', 'pintura', NULL, NULL,             'ExponentPushToken[N]'),
    ($5, 'Pintor Match',    'p@x.invalid',      'prestador', NULL, 'pintor',    '333.333.333-33', 'ExponentPushToken[P]'),
    ($6, 'Pintor Q',        'q@x.invalid',      'prestador', NULL, 'pintor',    '444.444.444-44', 'ExponentPushToken[Q]'),
    ($7, 'Pessoa (reparador)', 'pessoa@x.invalid', 'prestador', NULL, 'reparador', '11111111111', 'ExponentPushToken[X]')`,
    [A.id, B.id, S.id, N.id, P.id, Q.id, X.id])
  // Obras de A: O1 aberta com candidaturas pendentes (P, Q); O2 casada com P (chegada confirmada → pode encerrar);
  // O3 encerrada com P (avaliar); O4 casada com P sem chegada (cancelamento / desfazer). Obra de N: O5. Reparo de A: R1.
  const obra = (id, titulo, dono) => db.query(
    `INSERT INTO obras (id, titulo, categoria, cidade, uf, bairro, criado_por, valor, horas_para_expirar, expira_em)
     VALUES ($1, $2, 'residencial', 'Patos de Minas', 'MG', 'Centro', $3, 1000, 720, now() + INTERVAL '20 days')`, [id, titulo, dono])
  await obra(D(1), 'O1 aberta', A.id)
  await obra(D(2), 'O2 casada chegou', A.id)
  await obra(D(3), 'O3 encerrada', A.id)
  await obra(D(4), 'O4 casada', A.id)
  await obra(D(5), 'O5 de N', N.id)
  await db.query(`UPDATE obras SET match_usuario_id = $2, match_feito_em = now() - INTERVAL '1 day', chegada_declarada_em = now(), chegada_declarada_por = $2, chegada_confirmada_em = now() WHERE id = $1`, [D(2), P.id])
  await db.query(`UPDATE obras SET match_usuario_id = $2, match_feito_em = now() - INTERVAL '2 days', status = 'encerrada', status_aprovacao = 'encerrada', encerrado_em = now() WHERE id = $1`, [D(3), P.id])
  await db.query(`UPDATE obras SET match_usuario_id = $2, match_feito_em = now() - INTERVAL '1 hour' WHERE id = $1`, [D(4), P.id])
  await db.query(`INSERT INTO candidaturas (id, obra_id, usuario_id, status, valor_proposto) VALUES ($1, $2, $3, 'pendente', 900), ($4, $2, $5, 'pendente', 950)`, [C(1), D(1), P.id, C(2), Q.id])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status) VALUES ($1, $2, 'aceito'), ($3, $2, 'aceito'), ($4, $2, 'aceito')`, [D(2), P.id, D(3), D(4)])
  await db.query(`INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, expira_em) VALUES
    ($1, 'R1 de A', 'eletrica', '{eletrica}', 'Patos de Minas', 'MG', 'Lagoa', $2, 100, 24, now() + INTERVAL '20 hours')`, [D(11), A.id])

  // ─── helpers de posse ─────────────────────────────────────────────────────
  let r
  const contasA = (await contasDaPessoa(A.id)).sort()
  ok(contasA.join() === [A.id, B.id].sort().join(), 'contasDaPessoa(A) = A + B (contas CONTRATANTES do mesmo CPF, com e sem máscara); reparador X da pessoa e estranho de mesmo e-mail FORA', contasA)
  ok((await contasDaPessoa(X.id)).join() === X.id && !(await ehMesmaPessoa(A.id, X.id)), 'perfil profissional da própria pessoa (X): só ele mesmo, não é dono das obras de A')
  r = await chamar(rota('post', '/obras/:id/encerrar'), { usuario: X, params: { id: D(2) }, body: {} })
  ok(r.status === 403, 'encerrar obra de A pelo reparador X (mesmo CPF, lado profissional) → 403', r.body)
  ok((await contasDaPessoa(N.id)).join() === N.id, 'conta sem CPF casa só consigo mesma')
  ok((await contasDaPessoa(S.id)).join() === S.id, 'estranho com o MESMO e-mail e outro CPF: só ele')
  ok(await ehMesmaPessoa(A.id, B.id) && await ehMesmaPessoa(B.id, A.id) && !(await ehMesmaPessoa(A.id, S.id)) && !(await ehMesmaPessoa(A.id, N.id)), 'ehMesmaPessoa: A↔B sim; A↔S e A↔N não')

  // ─── listas ───────────────────────────────────────────────────────────────
  r = await chamar(rota('get', '/obras/minhas'), { usuario: B })
  ok(r.status === 200 && texto(r).includes('O1 aberta') && texto(r).includes('O3 encerrada') && !texto(r).includes('O5 de N'),
     'GET /obras/minhas como B (dono_reparo) lista as obras criadas por A, não a de N', r.body?.erro || Object.keys(r.body))
  r = await chamar(rota('get', '/obras/minhas'), { usuario: S })
  ok(r.status === 200 && !texto(r).includes('O1 aberta'), 'GET /obras/minhas como estranho (mesmo e-mail): nada de A')
  r = await chamar(rota('get', '/reparos/minhas'), { usuario: B })
  ok(r.status === 200 && texto(r).includes('R1 de A'), 'GET /reparos/minhas como B lista o serviço criado por A', r.body?.erro)
  r = await chamar(rota('get', '/obras/meus-contratos-dono'), { usuario: B })
  ok(r.status === 200 && texto(r).includes('O3 encerrada'), 'GET /obras/meus-contratos-dono como B vê a obra encerrada de A', r.body?.erro)

  // ─── candidaturas: recusar e aprovar pela conta irmã ──────────────────────
  r = await chamar(candCtrl.recusar, { usuario: S, params: { id: C(2) } })
  ok(r.status === 403, 'recusar candidatura: estranho (mesmo e-mail) → 403', r.body)
  r = await chamar(candCtrl.recusar, { usuario: B, params: { id: C(2) } })
  ok(r.status === 200, 'recusar candidatura de Q pela conta irmã B → 200', r.body?.erro)
  r = await chamar(candCtrl.aprovar, { usuario: N, params: { id: C(1) } })
  ok(r.status === 403, 'aprovar candidatura: conta sem CPF (não é da pessoa) → 403', r.body)
  r = await chamar(candCtrl.aprovar, { usuario: B, params: { id: C(1) } })
  const o1 = (await db.query(`SELECT match_usuario_id FROM obras WHERE id = $1`, [D(1)])).rows[0]
  ok(r.status === 200 && o1.match_usuario_id === P.id, 'aprovar candidatura de P pela conta irmã B → 200 e match gravado', r.body?.erro)
  await assentar()

  // ─── cancelamento / desfazer / encerrar / avaliar / perguntas ─────────────
  r = await chamar(rota('post', '/obras/:id/cancelar-match'), { usuario: S, params: { id: D(4) }, query: { simular: '1' }, body: { motivo: 'nao_preciso' } })
  ok(r.status === 403, 'cancelar-match (simular): estranho → 403', r.body)
  r = await chamar(rota('post', '/obras/:id/cancelar-match'), { usuario: B, params: { id: D(4) }, query: { simular: '1' }, body: { motivo: 'nao_preciso' } })
  ok(r.status === 200 && r.body.papel === 'dono', 'cancelar-match (simular) pela conta irmã B: papel = dono', r.body)
  r = await chamar(rota('post', '/obras/dono/:id/desfazer-match'), { usuario: S, params: { id: D(4) } })
  ok(r.status === 403, 'desfazer-match: estranho → 403', r.body)
  r = await chamar(rota('post', '/obras/dono/:id/desfazer-match'), { usuario: B, params: { id: D(4) } })
  ok(r.status === 409 && r.body.codigo === 'AGUARDE', 'desfazer-match pela conta irmã B passa na posse (409 AGUARDE: ainda cedo), não 403', r.body)
  r = await chamar(rota('post', '/obras/:id/encerrar'), { usuario: S, params: { id: D(2) }, body: {} })
  ok(r.status === 403, 'encerrar: estranho → 403', r.body)
  r = await chamar(rota('post', '/obras/:id/encerrar'), { usuario: B, params: { id: D(2) }, body: {} })
  const o2 = (await db.query(`SELECT status, encerramento_solicitado_por FROM obras WHERE id = $1`, [D(2)])).rows[0]
  ok(r.status === 200 && (o2.status === 'encerrada' || o2.encerramento_solicitado_por === B.id), 'encerrar pela conta irmã B → 200 (encerrada ou pedido registrado)', { r: r.body, o2 })
  r = await chamar(rota('post', '/avaliacoes'), { usuario: S, body: { contrato_tipo: 'obra', contrato_id: D(3), nota: 5, etiquetas: [] } })
  ok(r.status === 403, 'avaliar: estranho → 403', r.body)
  r = await chamar(rota('post', '/avaliacoes'), { usuario: B, body: { contrato_tipo: 'obra', contrato_id: D(3), nota: 5, etiquetas: [] } })
  const aval = (await db.query(`SELECT avaliador_id, avaliado_id FROM avaliacoes WHERE contrato_id = $1`, [D(3)])).rows[0]
  ok((r.status === 200 || r.status === 201) && aval && aval.avaliador_id === B.id && aval.avaliado_id === P.id, 'avaliar pela conta irmã B: dono avalia o pintor (avaliador = B)', r.body?.erro || aval)
  // Resposta a pergunta (lado dono): só a pessoa dona responde; o estranho leva 403.
  await db.query(`INSERT INTO perguntas_demanda (id, tipo, demanda_id, autor_id, pergunta) VALUES ($1, 'obra', $2, $3, 'Tem andaime?')`, [C(9), D(1), Q.id])
  r = await chamar(rota('post', '/obras/:id/perguntas/:pid/resposta'), { usuario: S, params: { id: D(1), pid: C(9) }, body: { resposta: 'Sim' } })
  ok(r.status === 403, 'responder pergunta: estranho → 403', r.body)
  r = await chamar(rota('post', '/obras/:id/perguntas/:pid/resposta'), { usuario: B, params: { id: D(1), pid: C(9) }, body: { resposta: 'Sim, tem andaime.' } })
  const perg = (await db.query(`SELECT resposta FROM perguntas_demanda WHERE id = $1`, [C(9)])).rows[0]
  ok(r.status < 300 && perg.resposta === 'Sim, tem andaime.', 'responder pergunta pela conta irmã B → gravada', r.body?.erro || perg)

  // ─── GET /auth/contas ─────────────────────────────────────────────────────
  r = await chamar(authCtrl.listarContas, { usuario: B })
  ok(r.status === 200 && r.body.tem_obras === true && Array.isArray(r.body.contas), 'GET /auth/contas como B: tem_obras = true (obras de A são da pessoa)', r.body)
  r = await chamar(authCtrl.listarContas, { usuario: S })
  ok(r.status === 200 && r.body.tem_obras === false, 'GET /auth/contas como estranho: tem_obras = false', r.body)
  r = await chamar(authCtrl.listarContas, { usuario: N })
  ok(r.status === 200 && r.body.tem_obras === true, 'GET /auth/contas como N (sem CPF): tem_obras = true pela própria obra')

  // ─── entrega UMA vez por pessoa ───────────────────────────────────────────
  const cA = await contatoDaPessoa(A.id)
  ok(cA.usuario_id === A.id && cA.push_token === 'ExponentPushToken[B]' && cA.email === 'pessoa@x.invalid', 'contatoDaPessoa(A sem token): token da conta irmã B, e-mail próprio', cA)
  const cS = await contatoDaPessoa(S.id)
  ok(cS.push_token === 'ExponentPushToken[S]', 'contatoDaPessoa(estranho): só o próprio token')
  const cP = await contatoDaPessoa(P.id)
  ok(cP.push_token === 'ExponentPushToken[P]' && cP.email === 'p@x.invalid', 'contatoDaPessoa(profissional): linha própria (lado profissional inalterado)')
  pushes.length = 0; emails.length = 0
  const via = await avisarUsuario(A.id, { titulo: 'T', corpo: 'C', data: { tipo: 'teste' }, rotulo: 'teste', chave: 'teste1', demandaId: D(1) })
  ok(pushes.length === 1 && pushes[0].to === 'ExponentPushToken[B]' && emails.length === 1, 'avisarUsuario(A): 1 push (token de B) + 1 e-mail — uma vez por pessoa', { via, pushes: pushes.map(p => p.to), emails: emails.length })
  await db.query(`UPDATE usuarios SET push_token = 'ExponentPushToken[A]' WHERE id = $1`, [A.id])
  pushes.length = 0; emails.length = 0
  await avisarUsuario(A.id, { titulo: 'T', corpo: 'C', data: { tipo: 'teste' }, rotulo: 'teste', chave: 'teste2', demandaId: D(1) })
  ok(pushes.length === 1 && pushes[0].to === 'ExponentPushToken[A]', 'avisarUsuario(A com token): 1 push ao próprio token, nunca um por conta', pushes.map(p => p.to))

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
