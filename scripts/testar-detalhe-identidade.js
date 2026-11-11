#!/usr/bin/env node
// GET /obras/:id e GET /reparos/:id — identidade de quem lê o detalhe, por PESSOA (campos extras):
//   conta_id      = a conta da pessoa com proposta/match NESTA demanda (ou a logada, sem vínculo);
//   sou_escolhido = o match é de QUALQUER conta profissional da pessoa (mesmo CPF — Fase 2b);
//   sou_dono      = criado_por é QUALQUER conta contratante da pessoa (mesmo CPF — Fase 1).
// Semente: DA + DB = a mesma pessoa CONTRATANTE (dono_obra + dono_reparo); DX = dono estranho com
// o MESMO e-mail e outro CPF; PP + PR = a mesma pessoa PROFISSIONAL (pintor + reparador);
// EP = pintor estranho com o MESMO e-mail de PP e outro CPF; ADM = admin.
// Cadeia REAL das rotas (autenticar com JWT → conta vinculada) e SQL real num Postgres em memória.
//   npm i -D @electric-sql/pglite && node scripts/testar-detalhe-identidade.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const jwt = require(path.join(REPO, 'node_modules/jsonwebtoken'))
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { return chunk.map((_, i) => ({ status: 'ok', id: `t${i}` })) }
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
  if (/brevoService$/.test(request)) return { enviarEmail: async () => {}, enviarEmailComAnexo: async () => {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error
const erros = []
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.error = v ? (...a) => { erros.push(a.map(x => x?.message || String(x)).join(' ')) } : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const camadas = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack.map(l => l.handle)
}
// Cadeia inteira: autenticar (JWT, cache, conta vinculada) + handler.
const ver = (caminho, id, demandaId) => new Promise(resolve => {
  const hs = camadas('get', caminho)
  const req = { headers: { authorization: `Bearer ${jwt.sign({ id, tv: 1 }, process.env.JWT_SECRET)}` }, params: { id: demandaId }, body: {}, query: {}, get: () => '', ip: '127.0.0.1', route: { path: caminho } }
  const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  let i = 0
  const next = (err) => {
    if (err) return resolve({ erro: String(err.message || err) })
    if (i >= hs.length) return resolve({ passou: true })
    Promise.resolve(hs[i++](req, res, next)).catch(e => resolve({ erro: String(e.message || e) }))
  }
  next()
})
const ident = (r) => (r.status === 200 ? { conta_id: r.body.conta_id, sou_escolhido: r.body.sou_escolhido, sou_dono: r.body.sou_dono } : { status: r.status, corpo: r.body, erro: r.erro })
const eh = (r, conta, escolhido, dono) => r.status === 200 && r.body.conta_id === conta && r.body.sou_escolhido === escolhido && r.body.sou_dono === dono

const DA  = { id: U(1), nome: 'Dona (conta obra)' }
const DB  = { id: U(2), nome: 'Dona (conta serviço)' }
const DX  = { id: U(3), nome: 'Dono estranho' }
const PP  = { id: U(4), nome: 'Pessoa (pintor)' }
const PR  = { id: U(5), nome: 'Pessoa (reparador)' }
const EP  = { id: U(6), nome: 'Pintor estranho' }
const ADM = { id: U(7), nome: 'Admin' }
const NOME = Object.fromEntries([['DA', DA], ['DB', DB], ['DX', DX], ['PP', PP], ['PR', PR], ['EP', EP], ['ADM', ADM]].map(([k, v]) => [v.id, k]))

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

  // O que o detalhe lê além do esquema acima.
  // obras.especialidades_inferidas (GET /obras/:id devolve a lista, 11/11/2026) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/especialidadesInferidas')).migrarEspecialidadesInferidas(db)
  await db.exec(`
    CREATE TABLE assinaturas (usuario_id uuid, plano text, valor_mensal numeric, status text, tipo text, proximo_vencimento timestamptz, criado_em timestamptz DEFAULT now());
    ALTER TABLE usuarios ADD COLUMN anos_experiencia int, ADD COLUMN tamanho_equipe int, ADD COLUMN embaixador boolean DEFAULT false;
    CREATE TABLE push_entregas (tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, ultima_tentativa_em timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
  `)
  // Responsabilidade pós-match (eventos_responsabilidade, dias_credito_*, aviso_resposta_final_em) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/responsabilidade')).migrarResponsabilidade(db)
  // Retrato da desistência por exclusão de conta (utils/desistencias) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/desistencias')).migrarDesistencias(db)
  await db.query(`INSERT INTO usuarios (id, nome, email, role, tipo_dono, tipo_prestador, cpf_cnpj, especialidades, verificacao_status) VALUES
    ($1, 'Dona (conta obra)',    'dona@x.invalid',   'dono_obra', 'pintura', NULL, '111.111.111-11', NULL, 'aprovado'),
    ($2, 'Dona (conta serviço)', 'dona@x.invalid',   'dono_obra', 'reparo',  NULL, '11111111111',    NULL, 'aprovado'),
    ($3, 'Dono estranho',        'dona@x.invalid',   'dono_obra', 'pintura', NULL, '222.222.222-22', NULL, 'aprovado'),
    ($4, 'Pessoa (pintor)',      'pessoa@x.invalid', 'prestador', NULL, 'pintor',    '333.333.333-33', '{pintor}',   'aprovado'),
    ($5, 'Pessoa (reparador)',   'pessoa@x.invalid', 'prestador', NULL, 'reparador', '33333333333',    '{eletrica}', 'aprovado'),
    ($6, 'Pintor estranho',      'pessoa@x.invalid', 'prestador', NULL, 'pintor',    '444.444.444-44', '{pintor,eletrica}', 'aprovado'),
    ($7, 'Admin',                'adm@x.invalid',    'admin',     NULL, NULL, NULL, NULL, 'aprovado')`,
    [DA.id, DB.id, DX.id, PP.id, PR.id, EP.id, ADM.id])
  for (const c of [PP, PR, EP]) await db.query(`INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo) VALUES ($1, 'mensal', 49.90, 'ativa', 'gratuito')`, [c.id])
  const obra = (id, titulo, dono) => db.query(
    `INSERT INTO obras (id, titulo, categoria, cidade, uf, bairro, criado_por, valor, horas_para_expirar, expira_em, publicado_em, endereco_obra)
     VALUES ($1, $2, 'residencial', 'Uberlândia', 'MG', 'Centro', $3, 8000, 720, now() + INTERVAL '20 days', now(), 'Rua A, 10')`, [id, titulo, dono])
  const reparo = (id, titulo, dono) => db.query(
    `INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, expira_em, endereco_reparo)
     VALUES ($1, $2, 'eletrica', '{eletrica}', 'Uberlândia', 'MG', 'Centro', $3, 150, 48, now() + INTERVAL '2 days', 'Rua B, 20')`, [id, titulo, dono])
  const O1 = D(1), O2 = D(2), R1 = D(3), R2 = D(4)
  await obra(O1, 'Reforma', DA.id)
  await obra(O2, 'Muro', DA.id)
  await reparo(R1, 'Tomada', DB.id)
  await reparo(R2, 'Chuveiro', DX.id)
  const getObra = (c, id) => ver('/obras/:id', c.id, id)
  const getReparo = (c, id) => ver('/reparos/:id', c.id, id)
  silenciar(true)

  // ═══ OBRA sem vínculo de ninguém ═══════════════════════════════════════════════════════════
  let r = await getObra(DA, O1)
  ok(eh(r, DA.id, false, true), 'obra — quem criou: sou_dono true, conta_id = a própria conta', ident(r))
  const chavesAntes = ['obra', 'midias', 'minha_candidatura', 'candidatos', 'perguntas', 'sugestoes_restantes']
  ok(r.status === 200 && chavesAntes.every(k => k in r.body) && r.body.obra.id === O1 && Array.isArray(r.body.candidatos),
     'obra — tudo o que já saía continua na resposta (obra, midias, minha_candidatura, candidatos, perguntas…)', r.status === 200 ? Object.keys(r.body).length : r)
  r = await getObra(DB, O1)
  ok(eh(r, DB.id, false, true), 'obra — a OUTRA conta contratante da pessoa (dono_reparo): sou_dono true, conta_id = a logada', ident(r))
  r = await getObra(DX, O1)
  ok(r.status === 403, 'obra — dono ESTRANHO (mesmo e-mail, outro CPF): 403 como sempre', r.status)
  r = await getObra(PR, O1)
  ok(eh(r, PR.id, false, false) && r.body.minha_candidatura === null, 'obra — profissional sem vínculo: conta_id = a conta logada, nada mais', ident(r))
  r = await getObra(ADM, O1)
  ok(eh(r, ADM.id, false, false), 'obra — admin: conta_id = a própria, sou_escolhido e sou_dono false', ident(r))

  // ═══ OBRA com PROPOSTA da conta pintor ═════════════════════════════════════════════════════
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status, valor_proposto) VALUES ($1, $2, 'pendente', 7000)`, [O1, PP.id])
  r = await getObra(PP, O1)
  ok(eh(r, PP.id, false, false) && r.body.minha_candidatura?.status === 'pendente', 'obra — a conta que fez a proposta: conta_id = ela; ainda não escolhida', ident(r))
  r = await getObra(PR, O1)
  ok(eh(r, PP.id, false, false) && r.body.minha_candidatura?.status === 'pendente',
     'obra — logado como REPARADOR, proposta da conta PINTOR: conta_id = a conta pintor e minha_candidatura é a dela', ident(r))
  r = await getObra(EP, O1)
  ok(eh(r, EP.id, false, false) && r.body.minha_candidatura === null, 'obra — pintor ESTRANHO (mesmo e-mail): conta_id = ele mesmo, sem proposta', ident(r))
  r = await getObra(PR, O2)
  ok(eh(r, PR.id, false, false), 'outra obra, sem vínculo: conta_id volta a ser a conta logada', ident(r))

  // ═══ OBRA com MATCH da conta pintor ════════════════════════════════════════════════════════
  await db.query(`UPDATE candidaturas SET status = 'aceito' WHERE obra_id = $1 AND usuario_id = $2`, [O1, PP.id])
  await db.query(`UPDATE obras SET match_usuario_id = $2, match_feito_em = now() WHERE id = $1`, [O1, PP.id])
  r = await getObra(PP, O1)
  ok(eh(r, PP.id, true, false), 'obra — a conta casada: sou_escolhido true', ident(r))
  r = await getObra(PR, O1)
  // Endereço ao escolhido só com horário combinado (privacidadeDemanda, 11/11/2026): sem
  // chegada_prevista_em sai null + endereco_liberado false; com ele, o endereço.
  ok(eh(r, PP.id, true, false) && r.body.obra.endereco_obra === null && r.body.obra.endereco_liberado === false,
     'obra — logado como REPARADOR, match da conta PINTOR: sou_escolhido true, conta_id = a conta pintor (endereço ainda oculto: sem horário)', ident(r))
  await db.query(`UPDATE obras SET chegada_prevista_em = now() + INTERVAL '1 day' WHERE id = $1`, [O1])
  r = await getObra(PR, O1)
  ok(eh(r, PP.id, true, false) && r.body.obra.endereco_obra === 'Rua A, 10' && r.body.obra.endereco_liberado === true,
     'obra — com horário combinado, a pessoa do match vê o endereço (pela conta irmã também)', ident(r))
  r = await getObra(EP, O1)
  ok(eh(r, EP.id, false, false) && r.body.obra.endereco_obra === null && r.body.obra.endereco_liberado === false, 'obra — pintor estranho: sou_escolhido false (e sem endereço)', ident(r))
  r = await getObra(DA, O1)
  ok(eh(r, DA.id, false, true), 'obra — dono com profissional escolhido: sou_dono true, sou_escolhido false', ident(r))
  r = await getObra(DB, O1)
  ok(eh(r, DB.id, false, true), 'obra — a outra conta contratante: idem', ident(r))

  // ═══ REPARO ═══════════════════════════════════════════════════════════════════════════════
  r = await getReparo(DB, R1)
  ok(eh(r, DB.id, false, true), 'serviço — quem criou: sou_dono true', ident(r))
  ok(r.status === 200 && ['reparo', 'midias', 'meu_interesse', 'interessados', 'perguntas', 'sugestoes_restantes'].every(k => k in r.body) && r.body.reparo.id === R1,
     'serviço — tudo o que já saía continua na resposta', r.status === 200 ? Object.keys(r.body).length : r)
  r = await getReparo(DA, R1)
  ok(eh(r, DA.id, false, true), 'serviço — a OUTRA conta contratante (dono_obra): sou_dono true', ident(r))
  r = await getReparo(DA, R2)
  ok(r.status === 403, 'serviço de dono estranho — a pessoa contratante não é dona: 403 como sempre', r.status)
  r = await getReparo(PP, R1)
  ok(eh(r, PP.id, false, false) && r.body.meu_interesse === null, 'serviço — profissional sem vínculo: conta_id = a logada', ident(r))
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status, valor_proposto) VALUES ($1, $2, 'pendente', 140)`, [R1, PR.id])
  r = await getReparo(PP, R1)
  ok(eh(r, PR.id, false, false) && r.body.meu_interesse?.status === 'pendente',
     'serviço — logado como PINTOR, interesse da conta REPARADOR: conta_id = a conta reparador e meu_interesse é o dela', ident(r))
  await db.query(`UPDATE interesse_reparos SET status = 'aceito' WHERE reparo_id = $1 AND usuario_id = $2`, [R1, PR.id])
  await db.query(`UPDATE reparos SET match_usuario_id = $2, match_feito_em = now() WHERE id = $1`, [R1, PR.id])
  r = await getReparo(PP, R1)
  ok(eh(r, PR.id, true, false) && r.body.reparo.endereco_reparo === null && r.body.reparo.endereco_liberado === false, 'serviço — logado como PINTOR, match da conta REPARADOR: sou_escolhido true, conta_id = a conta reparador (endereço só com horário)', ident(r))
  await db.query(`UPDATE reparos SET chegada_prevista_em = now() + INTERVAL '1 day' WHERE id = $1`, [R1])
  r = await getReparo(PP, R1)
  ok(eh(r, PR.id, true, false) && r.body.reparo.endereco_reparo === 'Rua B, 20' && r.body.reparo.endereco_liberado === true, 'serviço — com horário combinado: endereço liberado à pessoa do match', ident(r))
  r = await getReparo(PR, R1)
  ok(eh(r, PR.id, true, false), 'serviço — a conta casada: sou_escolhido true', ident(r))
  r = await getReparo(EP, R1)
  ok(eh(r, EP.id, false, false), 'serviço — estranho: sou_escolhido false', ident(r))
  r = await getReparo(DB, R1)
  ok(eh(r, DB.id, false, true), 'serviço — dono com profissional escolhido: sou_dono true, sou_escolhido false', ident(r))

  // nunca os dois: os conjuntos contratante e profissional são disjuntos
  const todas = []
  for (const c of [DA, DB, PP, PR, EP, ADM]) for (const [g, id] of [[getObra, O1], [getObra, O2], [getReparo, R1]]) { const x = await g(c, id); if (x.status === 200) todas.push(x.body) }
  ok(todas.length >= 12 && todas.every(b => !(b.sou_dono && b.sou_escolhido)) && todas.every(b => typeof b.sou_dono === 'boolean' && typeof b.sou_escolhido === 'boolean' && typeof b.conta_id === 'string'),
     'em toda resposta: os três campos presentes e tipados; sou_dono e sou_escolhido nunca os dois true', todas.length)
  silenciar(false)
  const inesperados = erros.filter(e => !/sem banco|PAGBANK|migration/i.test(e))
  ok(inesperados.length === 0, 'nenhum erro logado nas leituras', inesperados.slice(0, 3))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error = errOrig; console.error('ERRO', e); process.exit(1) })
