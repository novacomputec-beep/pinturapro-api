#!/usr/bin/env node
// Lado profissional unificado, Fase 2b (decisão do dono, 09/11/2026):
//   (1) capacidade SIMÉTRICA — a conta PINTOR que marca especialidade de serviço passa nas rotas de
//       serviço, vê o feed e recebe push/e-mail de serviço POR ESPECIALIDADE (pode_servicos);
//   (2) PROFISSIONAL = PESSOA — contas 'prestador' do mesmo CPF normalizado (NUNCA e-mail) são um
//       profissional só: feed e gates pela capacidade da pessoa, listas "minhas" das duas contas,
//       ações do profissional escolhido por qualquer uma (autenticar assume a conta vinculada),
//       UMA proposta por pessoa por demanda, UM aviso por pessoa, faltas / suspensão / lista negra /
//       bloqueio do dono por pessoa — sem tocar no conjunto CONTRATANTE (Fase 1), que é disjunto.
// Semente: PP + PR = a mesma pessoa (pintor + reparador, CPF 111 com e sem máscara);
//          EST = ESTRANHO com o MESMO e-mail e outro CPF; SP + SR = sem CPF (mesmo e-mail);
//          DP = conta de DONO da própria pessoa (CPF 111); DUO = pessoa com as duas contas elegíveis
//          nos dois lados; IP + IR = pessoa com a conta de reparador DESATIVADA.
// SQL REAL num Postgres em memória (PGlite); Expo/Brevo falsos que só coletam.
//   npm i -D @electric-sql/pglite && node scripts/testar-profissional-mesma-pessoa.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const jwt = require(path.join(REPO, 'node_modules/jsonwebtoken'))
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
  if (/utils[\\/]plataforma$/.test(request)) return { ...origLoad.apply(this, arguments), registrarPlataforma() {}, detectarPlataforma() { return false } }
  if (/utils[\\/]desinstalacoes$/.test(request)) return { ...origLoad.apply(this, arguments), registrarReinstalacao() {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error
console.log = () => {}; console.error = () => {}
const router = require(path.join(REPO, 'src/routes/index.js'))
const authCtrl = require(path.join(REPO, 'src/controllers/authController'))
const candCtrl = require(path.join(REPO, 'src/controllers/candidaturasController'))
const alerta = require(path.join(REPO, 'src/services/alertaService'))
const auth = require(path.join(REPO, 'src/middlewares/auth'))
const esp = require(path.join(REPO, 'src/utils/especialidades'))
const tc = require(path.join(REPO, 'src/utils/tipoConta'))
const cap = require(path.join(REPO, 'src/utils/capacidadeObras'))
const { ehDemandaPropria } = require(path.join(REPO, 'src/utils/demandaPropria'))
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.error = v ? () => {} : errOrig }
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 150))
const tok = (id) => `ExponentPushToken[${id.slice(-3)}]`
const ordenado = (l) => [...l].sort()
const igual = (a, b) => JSON.stringify(ordenado(a)) === JSON.stringify(ordenado(b))
const limparCache = () => Object.values(C).forEach(c => auth.invalidarCacheAssinatura(c.id))

// ─── cadeia REAL da rota (autenticar com JWT incluso). soGates: tudo MENOS o handler final ───
const camadas = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack.map(l => l.handle)
}
const rodar = (metodo, caminho, { id, params = {}, body = {}, query = {}, soGates = false }) => new Promise(resolve => {
  const hs = soGates ? camadas(metodo, caminho).slice(0, -1) : camadas(metodo, caminho)
  const req = { headers: { authorization: `Bearer ${jwt.sign({ id, tv: 1 }, process.env.JWT_SECRET)}` }, params, body, query, get: () => '', ip: '127.0.0.1', route: { path: caminho } }
  const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b, req }) } }
  let i = 0
  const next = (err) => {
    if (err) return resolve({ erro: String(err.message || err), req })
    if (i >= hs.length) return resolve({ passou: true, req })
    Promise.resolve(hs[i++](req, res, next)).catch(e => resolve({ erro: String(e.message || e), req }))
  }
  next()
})
const chamar = (handler, { usuario, params = {}, query = {}, body = {} }) => new Promise(resolve => {
  const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, query, body, usuario, get: () => '', headers: {}, ip: '127.0.0.1' }, res)
})

const OBRA = D(1), REPARO = D(2)
const ROTAS_SERVICO = [
  { m: 'get',  c: '/reparos' },
  { m: 'post', c: '/reparos/:id/perguntas', params: { id: REPARO } },
  { m: 'post', c: '/reparos/:id/interesse', params: { id: REPARO } },
  { m: 'post', c: '/reparos/:id/abertura', params: { id: REPARO } },
  { m: 'post', c: '/feed/checar-proximidade' },
  { m: 'post', c: '/reparos/:id/match', params: { id: REPARO } },
  { m: 'post', c: '/reparos/:id/interesse/:interesse_id/prestador-responder', params: { id: REPARO, interesse_id: D(99) } },
]
const ROTAS_OBRA = [
  { m: 'get',  c: '/obras' },
  { m: 'post', c: '/obras/:id/perguntas', params: { id: OBRA } },
  { m: 'post', c: '/obras/:id/candidatura', params: { id: OBRA } },
  { m: 'post', c: '/candidaturas' },
  { m: 'post', c: '/obras/:id/candidatura/:candidaturaId/pintor-responder', params: { id: OBRA, candidaturaId: D(99) } },
  { m: 'post', c: '/obras/:id/match', params: { id: OBRA } },
]
const gates = async (rotas, id) => {
  const saida = []
  for (const r of rotas) saida.push({ ...r, r: await rodar(r.m, r.c, { id, params: r.params, soGates: true }) })
  return saida
}
const todasPassam = (rs) => rs.every(x => x.r.passou === true)
const todasTier = (rs) => rs.every(x => x.r.status === 403 && x.r.body?.codigo === 'TIER_INCORRETO')
const resumo = (rs) => rs.map(x => `${x.c.replace(/^\/(reparos|obras)\/:id/, '…')}=${x.r.passou ? 'ok' : (x.r.status || x.r.erro)}${x.r.body?.codigo ? ':' + x.r.body.codigo : ''}`)

// Todas em Uberlândia/MG, assinatura ativa, token e verificadas, salvo a observação.
const C = {
  DONO: { n: 1,  role: 'dono_obra', tipo_dono: 'pintura', cpf: '100.100.100-10', email: 'dono@x.invalid' },
  PP:   { n: 2,  tipo: 'pintor',    esp: ['pintor'],   cpf: '111.111.111-11', email: 'pessoa@x.invalid' },   // a PESSOA, conta pintor
  PR:   { n: 3,  tipo: 'reparador', esp: ['eletrica'], cpf: '11111111111',    email: 'pessoa@x.invalid' },   // a PESSOA, conta reparador
  EST:  { n: 4,  tipo: 'reparador', esp: ['eletrica'], cpf: '222.222.222-22', email: 'pessoa@x.invalid' },   // ESTRANHO: mesmo e-mail, outro CPF
  SP:   { n: 5,  tipo: 'pintor',    esp: ['pintor'],   cpf: null,             email: 'semcpf@x.invalid' },   // sem CPF
  SR:   { n: 6,  tipo: 'reparador', esp: ['eletrica'], cpf: null,             email: 'semcpf@x.invalid' },   // sem CPF, mesmo e-mail
  PS:   { n: 7,  tipo: 'pintor',    esp: ['pintor', 'eletrica'], cpf: '333.333.333-33', email: 'ps@x.invalid' }, // pintor COM serviço
  PN:   { n: 8,  tipo: 'pintor',    esp: ['pintor'],   cpf: '444.444.444-44', email: 'pn@x.invalid' },       // pintor SEM serviço
  NL:   { n: 9,  tipo: null,        esp: ['eletrica'], cpf: '555.555.555-55', email: 'nl@x.invalid' },       // legado: tipo NULL
  DP:   { n: 10, role: 'dono_obra', tipo_dono: 'reparo', cpf: '111.111.111-11', email: 'pessoa@x.invalid' }, // conta de DONO da PESSOA
  DUP:  { n: 11, tipo: 'pintor',    esp: ['pintor', 'mecanica'],    cpf: '777.777.777-77', email: 'duo.p@x.invalid' }, // DUO: elegível nos dois lados
  DUR:  { n: 12, tipo: 'reparador', esp: ['mecanica', 'construtor'], cpf: '77777777777',   email: 'duo.r@x.invalid' }, // DUO: idem
  IP:   { n: 13, tipo: 'pintor',    esp: ['pintor'],   cpf: '666.666.666-66', email: 'inat@x.invalid' },
  IR:   { n: 14, tipo: 'reparador', esp: ['eletrica'], cpf: '666.666.666-66', email: 'inat@x.invalid', inativa: true }, // irmã DESATIVADA
  ADM:  { n: 15, role: 'admin', cpf: null, email: 'adm@x.invalid' },
}
Object.values(C).forEach(c => { c.id = U(c.n) })

const main = async () => {
  // ═══ 1. Vocabulário e capacidade (sem banco) ══════════════════════════════════════════════
  const OBRA4 = ['engenheiro', 'construtor', 'pedreiro_servente', 'pintor']
  let v = esp.validarEspecialidades(['pintor', 'eletrica', 'faxina'], true, 'pintor')
  ok(!v.erro && v.valor.length === 3, 'pintor: obra + SERVIÇO aceitos (simétrico ao reparador)', v)
  v = esp.validarEspecialidades(['eletrica'], true, 'pintor')
  ok(!v.erro, 'pintor: só serviço (sem especialidade de obra) é válido', v)
  v = esp.validarEspecialidades(['eletrica', 'faxina', ...OBRA4], true, 'pintor')
  ok(/no máximo 5/.test(v.erro || ''), 'pintor: teto de 5 NO TOTAL (2 serviços + 4 obra)', v)
  v = esp.validarEspecialidades(['residencial'], true, 'pintor')
  ok(/inválida/.test(v.erro || ''), 'pintor: slug fora das duas listas continua recusado', v)
  v = esp.validarEspecialidades(['pintor'], true, null)
  ok(/inválida/.test(v.erro || ''), 'tipo NULL: lista de sempre (slug de obra recusado)', v)
  ok(esp.ESPECIALIDADES_REPARADOR.length === 62 && esp.ESPECIALIDADES_OBRA.length === 4, 'listas de base intactas (62 serviços, 4 de obra)')
  const P = (tipo, e, role = 'prestador') => ({ role, tipo_prestador: tipo, especialidades: e })
  ok(cap.podeServicos(P('reparador', ['eletrica'])) && cap.podeServicos(P('reparador', ['pintor'])) && cap.podeServicos(P('reparador', null)),
     'podeServicos: reparador sempre (mesmo só com especialidade de obra ou sem lista)')
  ok(cap.podeServicos(P('pintor', ['pintor', 'eletrica'])) && !cap.podeServicos(P('pintor', ['pintor'])) && !cap.podeServicos(P('pintor', null)),
     'podeServicos: pintor SÓ com especialidade de serviço')
  ok(!cap.podeServicos(P(null, ['eletrica'])) && !cap.podeServicos(P('reparador', ['eletrica'], 'dono_obra')) && !cap.podeServicos(null),
     'podeServicos falha fechado: tipo NULL, role errado, linha nula')
  ok(cap.podeObras(P('pintor', ['eletrica'])) && cap.podeObras(P('reparador', ['pintor'])) && !cap.podeObras(P('reparador', ['eletrica'])),
     'podeObras (Fase 2a) inalterado')

  // ═══ banco ════════════════════════════════════════════════════════════════════════════════
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, descricao text, categoria text, cidade text, uf text, estado text, bairro text, criado_por uuid, status text DEFAULT 'aberta',
      status_aprovacao text DEFAULT 'aprovada', encerrado_em timestamptz, match_usuario_id uuid, match_feito_em timestamptz, expira_em timestamptz,
      criado_em timestamptz DEFAULT now(), publicado_em timestamptz, a_caminho_em timestamptz, prestadores_bloqueados uuid[], codigo_publico text,
      push_novo_enviado_em timestamptz, email_novo_pendente_em timestamptz, valor_aumentado_em timestamptz, latitude numeric, longitude numeric, coordenadas_origem text, tags text[],
      prazo_modo text, ultima_extensao_horas numeric, encerramento_solicitado_por uuid, encerramento_solicitado_em timestamptz,
      chegada_janela text, chegada_prevista_em timestamptz, chegada_declarada_por uuid, chegada_declarada_em timestamptz, chegada_confirmada_em timestamptz,
      chegada_pendente_janela text, chegada_pendente_em timestamptz, chegada_recusada_em timestamptz, chegada_proposta_por uuid, chegada_pendente_rodada int DEFAULT 0`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, latitude numeric, longitude numeric, raio_km_escolhido numeric, nome text, email text, telefone text, cidade text, uf text, role text, tipo_dono text, tipo_prestador text, cpf_cnpj text,
      ativo boolean DEFAULT true, push_token text, criado_em timestamptz DEFAULT now(), suspenso_em timestamptz, suspenso_motivo text, desinstalado_em timestamptz,
      foto_url text, senha_hash text, boas_vindas_exibida boolean DEFAULT false, token_version int NOT NULL DEFAULT 1, verificacao_status text DEFAULT 'aprovado',
      referencias jsonb, especialidades text[], anos_experiencia int, tamanho_equipe int, aceita_promocoes boolean, indicacao_pedida_em timestamptz);
    ALTER TABLE usuarios ADD COLUMN avisos_todas_areas boolean NOT NULL DEFAULT true; -- preferência do aviso "fora da sua área" (migração de boot)
    CREATE TABLE assinaturas (usuario_id uuid, plano text, valor_mensal numeric, status text, tipo text, proximo_vencimento timestamptz, criado_em timestamptz DEFAULT now());
    CREATE TABLE obras (${colsDemanda}, valor numeric, horas_para_expirar numeric, metragem numeric, prazo_execucao_dias int);
    CREATE TABLE reparos (${colsDemanda}, categorias text[], valor_estimado numeric, prazo_atendimento_horas numeric);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, status text DEFAULT 'pendente', valor_proposto numeric,
      valor_contraproposta numeric, mensagem text, referencias text, rodada int DEFAULT 1, criado_em timestamptz DEFAULT now());
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, status text DEFAULT 'pendente', valor_proposto numeric,
      valor_contraproposta numeric, mensagem text, rodada int DEFAULT 1, criado_em timestamptz DEFAULT now());
    CREATE TABLE midias (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, url text, ordem int);
    CREATE TABLE midias_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, url text, ordem int);
    CREATE TABLE avaliacoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contrato_tipo text, contrato_id uuid, avaliador_id uuid, avaliado_id uuid, estrelas int, etiquetas text[], criado_em timestamptz DEFAULT now());
    CREATE TABLE prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid, UNIQUE (dono_id, prestador_id));
    CREATE TABLE faltas_profissional (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, tabela text, demanda_id uuid, motivo text, criado_em timestamptz DEFAULT now(), perdoada_em timestamptz);
    CREATE TABLE avisos_fora_area (tabela text, demanda_id uuid, usuario_id uuid, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE lembretes_push_enviados (tabela text, demanda_id uuid, usuario_id uuid, motivo text, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE avisos_acima_do_teto (tabela text, demanda_id uuid, usuario_id uuid, criado_em timestamptz NOT NULL DEFAULT now(), resumo_em timestamptz, PRIMARY KEY (tabela, demanda_id, usuario_id));
    CREATE TABLE push_entregas (primeira_tentativa_em timestamptz NOT NULL DEFAULT now(), tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, ultima_tentativa_em timestamptz DEFAULT now(),
      criado_em timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz DEFAULT now());
    CREATE TABLE tentativas_contato (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, tipo text, demanda_id uuid, campo text, criado_em timestamptz DEFAULT now());
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true'), ('multiplas_contas', 'true');
    SET search_path = public, pg_catalog;
  `)
  // Responsabilidade pós-match (eventos_responsabilidade, dias_credito_*, aviso_resposta_final_em) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/responsabilidade')).migrarResponsabilidade(db)

  // reparos.local_atendimento + usuarios.atende_* (utils/localAtendimento) — a mesma migração de boot.

  await require(path.join(REPO, 'src/utils/localAtendimento')).migrarLocalAtendimento({ query: (s, p) => db.query(s, p) })
  // obras.especialidades_inferidas (capacidadesDaPessoa / feed / aviso de obra nova leem a coluna) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/especialidadesInferidas')).migrarEspecialidadesInferidas(db)
  for (const [nome, c] of Object.entries(C)) {
    const role = c.role || 'prestador'
    await db.query(
      `INSERT INTO usuarios (id, nome, email, telefone, cidade, uf, role, tipo_dono, tipo_prestador, cpf_cnpj, push_token, ativo, especialidades, referencias)
       VALUES ($1::uuid, $2, $3, '34999990000', 'Uberlândia', 'MG', $4, $5, $6, $7, $8, $9, $10::text[], '[]'::jsonb)`,
      [c.id, `${nome} Teste`, c.email, role, c.tipo_dono || null, c.tipo ?? null, c.cpf, tok(c.id), !c.inativa, c.esp ?? null])
    if (role === 'prestador') await db.query(`INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo) VALUES ($1::uuid, 'mensal', 49.90, 'ativa', 'gratuito')`, [c.id])
  }
  const { DONO, PP, PR, EST, SP, SR, PS, PN, NL, DP, DUP, DUR, IP, IR, ADM } = C
  const obra = (id, titulo, dono = DONO.id) => db.query(
    `INSERT INTO obras (id, titulo, categoria, cidade, uf, bairro, criado_por, valor, horas_para_expirar, expira_em)
     VALUES ($1::uuid, $2, 'residencial', 'Uberlândia', 'MG', 'Centro', $3::uuid, 8000, 720, now() + INTERVAL '20 days')`, [id, titulo, dono])
  const reparo = (id, titulo, categoria, dono = DONO.id) => db.query(
    `INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, expira_em)
     VALUES ($1::uuid, $2, $3, ARRAY[$3], 'Uberlândia', 'MG', 'Centro', $4::uuid, 150, 48, now() + INTERVAL '2 days')`, [id, titulo, categoria, dono])
  await obra(OBRA, 'Reforma da casa')
  await reparo(REPARO, 'Trocar tomada', 'eletrica')

  // ═══ 2. Conjunto profissional da pessoa: só CPF, só 'prestador', disjunto do contratante ══
  ok(igual(await tc.contasProfissionaisDaPessoa(PP.id), [PP.id, PR.id]) && igual(await tc.contasProfissionaisDaPessoa(PR.id), [PP.id, PR.id]),
     'contas profissionais da PESSOA = pintor + reparador (CPF com e sem máscara), nos dois sentidos')
  ok(igual(await tc.contasProfissionaisDaPessoa(EST.id), [EST.id]), 'ESTRANHO com o MESMO e-mail e outro CPF: só a própria conta')
  ok(igual(await tc.contasProfissionaisDaPessoa(SP.id), [SP.id]) && igual(await tc.contasProfissionaisDaPessoa(SR.id), [SR.id]), 'contas SEM CPF (mesmo e-mail): cada uma só consigo')
  ok(igual(await tc.contasProfissionaisDaPessoa(DP.id), [DP.id]) && !(await tc.contasProfissionaisDaPessoa(PP.id)).includes(DP.id),
     'conta de DONO da mesma pessoa: fora do conjunto profissional, nos dois sentidos')
  ok(igual(await tc.contasDaPessoa(DP.id), [DP.id]) && igual(await tc.contasDaPessoa(PP.id), [PP.id]),
     'conjunto CONTRATANTE (Fase 1) continua sem contas profissionais — os dois conjuntos são disjuntos')
  ok(await tc.ehMesmoProfissional(PP.id, PR.id) && !(await tc.ehMesmoProfissional(EST.id, PR.id)) && !(await tc.ehMesmoProfissional(DP.id, PP.id)) && await tc.ehMesmoProfissional(EST.id, EST.id),
     'ehMesmoProfissional: irmã sim; estranho e conta de dono não; a própria sim')
  ok(await ehDemandaPropria('obras', OBRA, PP.id) === false, 'demanda de outro dono não é "própria"')
  await obra(D(20), 'Obra da própria pessoa (conta de dono)', DP.id)
  ok(await ehDemandaPropria('obras', D(20), PR.id) === true, 'demanda criada pela conta de DONO da pessoa continua "própria" para as contas profissionais dela')

  const linhas = (await db.query(`SELECT u.id, u.nome, u.role, u.tipo_prestador, u.especialidades, ${cap.sqlPodeServicos('u')} AS sql_s, ${cap.sqlPodeObras('u')} AS sql_o FROM usuarios u`)).rows
  ok(linhas.every(l => cap.podeServicos(l) === l.sql_s && cap.podeObras(l) === l.sql_o), 'podeServicos/podeObras (JS) ≡ SQL em todas as contas',
     linhas.filter(l => cap.podeServicos(l) !== l.sql_s || cap.podeObras(l) !== l.sql_o).map(l => l.nome))

  // ═══ 3. Gates de SERVIÇO (capacidade simétrica) e por PESSOA ═══════════════════════════════
  let g = await gates(ROTAS_SERVICO, PS.id)
  ok(todasPassam(g), 'PINTOR com especialidade de serviço passa nas 7 rotas de serviço', resumo(g))
  g = await gates(ROTAS_SERVICO, PN.id)
  ok(todasTier(g), 'pintor SEM especialidade de serviço → 403 TIER_INCORRETO nas 7 (regressão)', resumo(g))
  g = await gates(ROTAS_SERVICO, EST.id)
  ok(todasPassam(g), 'reparador passa nas 7 (regressão)', resumo(g))
  g = await gates(ROTAS_SERVICO, NL.id)
  ok(todasTier(g), 'prestador tipo NULL com "eletrica" → 403 nas 7 (falha fechado)', resumo(g))
  g = await gates(ROTAS_SERVICO, DONO.id)
  ok(g.every(x => x.r.status === 403), 'dono → 403 nas 7', resumo(g))
  g = await gates(ROTAS_SERVICO, ADM.id)
  ok(g.filter(x => !['/reparos', '/reparos/:id/perguntas', '/reparos/:id/interesse', '/reparos/:id/abertura', '/feed/checar-proximidade'].includes(x.c)).every(x => x.r.passou), 'admin passa nos gates de capacidade', resumo(g))

  g = await gates(ROTAS_SERVICO, PP.id)
  ok(todasPassam(g), 'PESSOA: a conta PINTOR (sem serviço) passa nas rotas de SERVIÇO pela conta irmã reparador', resumo(g))
  g = await gates(ROTAS_OBRA, PR.id)
  ok(todasPassam(g), 'PESSOA: a conta REPARADOR (sem obra) passa nas rotas de OBRA pela conta irmã pintor', resumo(g))
  g = await gates(ROTAS_OBRA, EST.id)
  ok(todasTier(g), 'ESTRANHO (mesmo e-mail, outro CPF) NÃO herda nada: 403 nas rotas de obra', resumo(g))
  g = await gates(ROTAS_OBRA, SR.id)
  ok(todasTier(g), 'reparador SEM CPF não herda do pintor sem CPF de mesmo e-mail: 403 nas rotas de obra', resumo(g))
  g = await gates(ROTAS_SERVICO, SP.id)
  ok(todasTier(g), 'pintor SEM CPF não herda do reparador sem CPF: 403 nas rotas de serviço', resumo(g))
  g = await gates(ROTAS_SERVICO, IP.id)
  ok(todasTier(g), 'conta irmã DESATIVADA não empresta capacidade: 403 nas rotas de serviço', resumo(g))

  // ═══ 4. Capacidades nas respostas (por pessoa) ════════════════════════════════════════════
  const linha = async (id) => (await db.query(`SELECT * FROM usuarios WHERE id = $1`, [id])).rows[0]
  const sessao = async (c) => (await authCtrl.montarSessao(await linha(c.id), { headers: {}, get: () => '' })).usuario
  const caps = (s) => ({ o: s.pode_obras, s: s.pode_servicos, c: s.tem_candidaturas, i: s.tem_interesses })
  let s = await sessao(PS)
  ok(s.pode_obras && s.pode_servicos && s.tipo_prestador === 'pintor', 'login PINTOR com serviço: pode_obras e pode_servicos true (tipo segue "pintor")', caps(s))
  s = await sessao(PN)
  ok(s.pode_obras && !s.pode_servicos, 'login pintor sem serviço: pode_servicos false', caps(s))
  s = await sessao(EST)
  ok(!s.pode_obras && s.pode_servicos, 'login ESTRANHO reparador: só pode_servicos', caps(s))
  s = await sessao(PP)
  ok(s.pode_obras && s.pode_servicos && !s.tem_candidaturas && !s.tem_interesses, 'login PESSOA (conta pintor): pode os DOIS lados; ainda sem propostas', caps(s))
  s = await sessao(PR)
  ok(s.pode_obras && s.pode_servicos, 'login PESSOA (conta reparador): pode os DOIS lados', caps(s))
  s = await sessao(IP)
  ok(s.pode_obras && !s.pode_servicos, 'login com irmã desativada: pode_servicos false', caps(s))
  s = await sessao(DP)
  ok(!s.pode_obras && !s.pode_servicos, 'login conta de DONO da pessoa: nenhuma capacidade profissional', caps(s))
  let r = await chamar(authCtrl.listarContas, { usuario: await linha(PP.id) })
  ok(r.status === 200 && r.body.pode_obras && r.body.pode_servicos && r.body.tem_interesses === false && Array.isArray(r.body.contas), 'GET /auth/contas: pode_servicos e tem_interesses ao lado dos demais', { ...r.body, contas: r.body.contas?.length })
  r = await chamar(authCtrl.perfil, { usuario: await linha(PS.id) })
  ok(r.status === 200 && r.body.usuario.pode_servicos === true && r.body.usuario.tem_interesses === false, 'GET /auth/perfil: usuario.pode_servicos / tem_interesses', r.status)
  r = await chamar(authCtrl.atualizarPerfil, { usuario: { ...(await linha(PN.id)) }, body: { especialidades: ['pintor', 'faxina'] } })
  ok(r.status === 200 && r.body.pode_servicos === true && r.body.pode_obras === true, 'PUT /auth/perfil: pintor marca serviço → pode_servicos true na resposta', r.body)
  g = await gates(ROTAS_SERVICO, PN.id)
  ok(todasPassam(g), 'depois do save o pintor passa nas rotas de serviço', resumo(g))
  r = await chamar(authCtrl.atualizarPerfil, { usuario: { ...(await linha(PN.id)) }, body: { especialidades: ['pintor'] } })
  ok(r.status === 200 && r.body.pode_servicos === false, 'PUT /auth/perfil: tirou o serviço → pode_servicos false', r.body)

  // ═══ 5. Público do push / e-mail: capacidade + UM aviso por pessoa ═════════════════════════
  const para = () => ordenado(pushes.map(p => p.to))
  silenciar(true)
  pushes.length = 0
  await alerta.notificarPrestadoresSobreNovoReparo(REPARO)   // 'eletrica'
  silenciar(false)
  // IR (reparador DESATIVADO) entra: o público do broadcast nunca filtrou u.ativo — comportamento
  // anterior, fora do escopo; o que a Fase 2b muda aqui é o pintor PS entrar.
  ok(igual(para(), [PR, EST, SR, PS, IR].map(c => tok(c.id))),
     'push NOVO SERVIÇO (elétrica): reparadores que casam + PINTOR com "eletrica" (PS); pintor sem serviço e tipo NULL NÃO', para())
  await reparo(D(3), 'Vazamento', 'mecanica')
  await obra(D(4), 'Pintura do muro')
  silenciar(true)
  pushes.length = 0
  await alerta.notificarPrestadoresSobreNovoReparo(D(3))     // 'mecanica': DUP (pintor) e DUR (reparador) casam
  const pushHidraulica = para()
  emails.length = 0
  await alerta.enviarEmailsNovaDemanda('reparos', D(3))
  await assentar()
  pushes.length = 0
  await alerta.notificarPintoresSobreNovaObra(D(4))          // obra: DUP (pintor) e DUR (construtor) podem
  const pushObra = para()
  silenciar(false)
  ok(igual(pushHidraulica, [tok(DUR.id)]), 'DUO elegível nas DUAS contas no serviço: UM push, na conta do tipo nativo (reparador)', pushHidraulica)
  const emHid = (await db.query(`SELECT usuario_id FROM email_alertas WHERE tipo = 'reparo' AND demanda_id = $1`, [D(3)])).rows.map(x => x.usuario_id)
  ok(igual(emHid, [DUR.id]) && emails.length === 1, 'DUO: UM e-mail do serviço (conta reparador)', { contas: emHid.length, enviados: emails.length })
  ok(pushObra.filter(t => [tok(DUP.id), tok(DUR.id)].includes(t)).join() === tok(DUP.id), 'DUO elegível nas DUAS contas na obra: UM push, na conta do tipo nativo (pintor)', pushObra)
  ok(pushObra.includes(tok(PP.id)) && !pushObra.includes(tok(PR.id)) && !pushObra.includes(tok(EST.id)), 'obra: PESSOA recebe UMA vez (pela conta pintor); estranho reparador não recebe', pushObra)
  // Só uma das contas com token: a pessoa recebe por ela.
  await db.query(`UPDATE usuarios SET push_token = NULL WHERE id = $1`, [DUP.id])
  await obra(D(5), 'Telhado')
  silenciar(true)
  pushes.length = 0
  await alerta.notificarPintoresSobreNovaObra(D(5))
  silenciar(false)
  ok(para().filter(t => [tok(DUP.id), tok(DUR.id)].includes(t)).join() === tok(DUR.id), 'DUO com token só na conta reparador: o push da obra vai por ela (uma vez)', para())
  // Aviso 1:1 à conta SEM token: vai ao token da conta irmã profissional; dono sem token não ganha token de ninguém.
  silenciar(true)
  pushes.length = 0; emails.length = 0
  await alerta.avisarUsuario(DUP.id, { titulo: 'Aviso 1:1', corpo: 'teste', data: { tipo: 'teste_um_a_um', obra_id: D(5) }, rotulo: 'teste' })
  const umAum = para()
  await db.query(`UPDATE usuarios SET push_token = NULL WHERE id = $1`, [DP.id])
  pushes.length = 0
  await alerta.avisarUsuario(DP.id, { titulo: 'Aviso dono', corpo: 'teste', data: { tipo: 'teste_dono', obra_id: D(20) }, rotulo: 'teste dono' })
  const donoSemToken = para()
  silenciar(false)
  ok(igual(umAum, [tok(DUR.id)]), 'aviso 1:1 a conta profissional SEM token → token da conta irmã (uma vez)', umAum)
  ok(donoSemToken.length === 0, 'conta de DONO sem token NÃO recebe pelo token do perfil profissional da mesma pessoa (conjuntos disjuntos)', donoSemToken)
  await db.query(`UPDATE usuarios SET push_token = $2 WHERE id = $1`, [DUP.id, tok(DUP.id)])

  // ═══ 6. UMA proposta por pessoa por demanda ═══════════════════════════════════════════════
  silenciar(true)
  r = await rodar('post', '/obras/:id/candidatura', { id: PP.id, params: { id: OBRA }, body: { mensagem: 'Pinto a casa', valor_proposto: 7000 } })
  silenciar(false)
  ok(r.status === 201 && r.body.usuario_id === PP.id, 'conta PINTOR da pessoa se candidata à obra → 201', r.status === 201 ? r.body.status : r.body)
  r = await rodar('post', '/obras/:id/candidatura', { id: PR.id, params: { id: OBRA }, body: { mensagem: 'De novo' } })
  ok(r.status === 409 && r.body.codigo === 'PROPOSTA_OUTRO_PERFIL' && /outro perfil profissional/.test(r.body.erro), '2ª conta (reparador) da MESMA pessoa na mesma obra → 409 PROPOSTA_OUTRO_PERFIL, mensagem clara', r.body)
  r = await rodar('post', '/candidaturas', { id: PR.id, body: { obra_id: OBRA } })
  ok(r.status === 409 && r.body.codigo === 'PROPOSTA_OUTRO_PERFIL', 'rota antiga POST /candidaturas (obra no corpo): mesma trava por pessoa', r.body)
  r = await rodar('post', '/obras/:id/candidatura', { id: PP.id, params: { id: OBRA }, body: {} })
  ok(r.status === 409 && !r.body.codigo, 'a MESMA conta de novo → 409 de sempre (sem o código novo)', r.body)
  ok((await db.query(`SELECT count(*)::int AS n FROM candidaturas WHERE obra_id = $1`, [OBRA])).rows[0].n === 1, 'uma candidatura só na obra')
  silenciar(true)
  r = await rodar('post', '/reparos/:id/interesse', { id: PR.id, params: { id: REPARO }, body: { mensagem: 'Faço hoje', valor_proposto: 140 } })
  const intPR = r
  r = await rodar('post', '/reparos/:id/interesse', { id: PP.id, params: { id: REPARO }, body: {} })
  const intPP = r
  r = await rodar('post', '/reparos/:id/interesse', { id: EST.id, params: { id: REPARO }, body: {} })
  const intEST = r
  silenciar(false)
  ok(intPR.status === 201 && intPR.body.usuario_id === PR.id, 'conta REPARADOR da pessoa demonstra interesse no serviço → 201', intPR.status)
  ok(intPP.status === 409 && intPP.body.codigo === 'PROPOSTA_OUTRO_PERFIL', '2ª conta (pintor) da mesma pessoa no mesmo serviço → 409 PROPOSTA_OUTRO_PERFIL', intPP.body)
  ok(intEST.status === 201 && intEST.body.usuario_id === EST.id, 'ESTRANHO (mesmo e-mail) demonstra interesse normalmente → 201', intEST.status)
  // Já se manifestou por uma conta: a pessoa sai dos reanúncios/lembretes nas DUAS contas.
  silenciar(true)
  pushes.length = 0
  await alerta.reanunciarDemanda('obras', OBRA)
  await assentar()
  silenciar(false)
  ok(!para().includes(tok(PP.id)) && !para().includes(tok(PR.id)) && para().includes(tok(DUP.id)), 'reanúncio da obra: a PESSOA que já se candidatou não é avisada por nenhuma conta', para())

  // ═══ 7. Listas "minhas" pelas contas da pessoa ════════════════════════════════════════════
  r = await chamar(candCtrl.minhas, { usuario: await linha(PR.id) })
  ok(r.status === 200 && r.body.candidaturas.length === 1 && r.body.candidaturas[0].conta_id === PP.id && r.body.candidaturas[0].obra_id === OBRA,
     'GET /candidaturas/minhas logado como REPARADOR: traz a candidatura feita pela conta pintor (conta_id)', r.body.candidaturas?.map(c => c.conta_id))
  r = await rodar('get', '/reparos/meus-interesses', { id: PP.id })
  const meus = r.body?.interesses || r.body?.ativos || Object.values(r.body || {}).find(Array.isArray) || []
  const todosInt = Object.values(r.body || {}).filter(Array.isArray).flat()
  ok(r.status === 200 && todosInt.length === 1 && todosInt[0].conta_id === PR.id && todosInt[0].reparo_id === REPARO,
     'GET /reparos/meus-interesses logado como PINTOR: traz o interesse feito pela conta reparador (conta_id)', todosInt.map(i => i.conta_id))
  r = await chamar(candCtrl.minhas, { usuario: await linha(EST.id) })
  ok(r.status === 200 && r.body.candidaturas.length === 0, 'ESTRANHO não vê candidatura de ninguém', r.body.candidaturas?.length)
  s = await sessao(PR)
  ok(s.tem_candidaturas === true && s.tem_interesses === true, 'login: tem_candidaturas / tem_interesses por PESSOA (cada conta fez uma proposta)', caps(s))

  // ═══ 8. Conta vinculada: qualquer conta da pessoa age como o profissional escolhido ═══════
  const cand = (await db.query(`SELECT id FROM candidaturas WHERE obra_id = $1`, [OBRA])).rows[0].id
  // dono fez contraproposta → a conta REPARADOR responde pela proposta que é da conta PINTOR
  await db.query(`UPDATE candidaturas SET status = 'contraproposta_dono', valor_contraproposta = 6500 WHERE id = $1`, [cand])
  silenciar(true)
  r = await rodar('post', '/obras/:id/candidatura/:candidaturaId/pintor-responder', { id: PR.id, params: { id: OBRA, candidaturaId: cand }, body: { action: 'contraproposta', valor: 6800 } })
  silenciar(false)
  const depois = (await db.query(`SELECT status, usuario_id FROM candidaturas WHERE id = $1`, [cand])).rows[0]
  ok(r.status === 200 && depois.usuario_id === PP.id && depois.status !== 'contraproposta_dono' && r.req.usuario.id === PP.id && r.req.contaLogada?.id === PR.id,
     'conta REPARADOR responde à contraproposta da candidatura da conta PINTOR (age como a conta vinculada)', { status: r.status, cand: depois.status, corpo: r.body })
  r = await rodar('post', '/obras/:id/candidatura/:candidaturaId/pintor-responder', { id: EST.id, params: { id: OBRA, candidaturaId: cand }, body: { action: 'recusar' } })
  ok(r.status === 403 || r.status === 404, 'ESTRANHO não responde pela candidatura alheia', r.status)
  // match com a conta PINTOR → a conta REPARADOR confirma "a caminho"
  await db.query(`UPDATE candidaturas SET status = 'aceito' WHERE id = $1`, [cand])
  await db.query(`UPDATE obras SET match_usuario_id = $2, match_feito_em = now() WHERE id = $1`, [OBRA, PP.id])
  r = await rodar('post', '/obras/:id/match', { id: EST.id, params: { id: OBRA } })
  ok(r.status === 403 || r.status === 409, 'ESTRANHO não confirma o match alheio', { status: r.status, corpo: r.body })
  silenciar(true)
  pushes.length = 0
  r = await rodar('post', '/obras/:id/match', { id: PR.id, params: { id: OBRA } })
  await assentar()
  silenciar(false)
  const o1 = (await db.query(`SELECT match_usuario_id, a_caminho_em FROM obras WHERE id = $1`, [OBRA])).rows[0]
  ok(r.status === 200 && o1.a_caminho_em && o1.match_usuario_id === PP.id, 'conta REPARADOR confirma "a caminho" do match da conta PINTOR; o match continua da conta que casou', { status: r.status, corpo: r.body })
  ok(pushes.some(p => p.to === tok(DONO.id) && p.data?.tipo === 'a_caminho'), 'dono avisado do "a caminho"', pushes.map(p => p.data?.tipo))
  // unidade: ordem de decisão de assumirContaVinculada
  const assumir = async (logada, caminho, params) => {
    auth.invalidarCacheAssinatura(logada)
    const req = { usuario: await auth.carregarUsuario(logada), route: { path: caminho }, params }
    await auth.assumirContaVinculada(req)
    return { age: req.usuario.id, logada: req.contaLogada?.id || null }
  }
  let a = await assumir(PR.id, '/obras/:id', { id: OBRA })
  ok(a.age === PP.id && a.logada === PR.id, 'assumirContaVinculada: match da conta irmã → age como ela', a)
  a = await assumir(PP.id, '/obras/:id', { id: OBRA })
  ok(a.age === PP.id && a.logada === null, 'a própria conta do match não troca nada', a)
  a = await assumir(PP.id, '/reparos/:id/interesse', { id: REPARO })
  ok(a.age === PR.id && a.logada === PP.id, 'sem match: a irmã que tem a PROPOSTA é quem age', a)
  a = await assumir(PP.id, '/reparos/:id', { id: D(3) })
  ok(a.age === PP.id && a.logada === null, 'demanda sem vínculo de ninguém: segue a conta logada (é ela que cria a proposta)', a)
  a = await assumir(EST.id, '/obras/:id/match', { id: OBRA })
  ok(a.age === EST.id && a.logada === null, 'estranho nunca assume conta alheia', a)
  a = await assumir(PR.id, '/obras/dono/:id', { id: OBRA })
  ok(a.age === PR.id && a.logada === null, 'rota fora de /obras/:id… e /reparos/:id… não troca', a)
  a = await assumir(DP.id, '/obras/:id', { id: OBRA })
  ok(a.age === DP.id && a.logada === null, 'conta de DONO da pessoa nunca assume o perfil profissional', a)
  // Os gates de CONTA julgam a conta do TOKEN: reparador da pessoa não verificado é barrado
  // mesmo agindo pela conta pintor (verificada).
  await db.query(`UPDATE usuarios SET verificacao_status = 'nao_solicitada' WHERE id = $1`, [PR.id])
  r = await rodar('post', '/obras/:id/perguntas', { id: PR.id, params: { id: OBRA }, body: { pergunta: 'Tem andaime?' }, soGates: true })
  ok(r.status === 403 && r.body.codigo === 'VERIFICACAO_NECESSARIA', 'verificação de identidade continua sendo da conta LOGADA (não da conta assumida)', r.body)
  await db.query(`UPDATE usuarios SET verificacao_status = 'aprovado' WHERE id = $1`, [PR.id])

  // contratos finalizados: obra encerrada com match da conta PINTOR aparece para a conta REPARADOR
  await db.query(`UPDATE obras SET status = 'encerrada', encerrado_em = now() WHERE id = $1`, [OBRA])
  silenciar(true)
  r = await rodar('get', '/obras/meus-contratos', { id: PR.id })
  const contratosEst = await rodar('get', '/obras/meus-contratos', { id: EST.id })
  silenciar(false)
  ok(r.status === 200 && r.body.contratos?.length === 1 && r.body.contratos[0].id === OBRA && r.body.contratos[0].conta_id === PP.id,
     'GET /obras/meus-contratos logado como REPARADOR: contrato da conta pintor (conta_id)', r.status === 200 ? r.body.total : r.body)
  ok(contratosEst.status === 200 && contratosEst.body.contratos.length === 0, 'ESTRANHO: nenhum contrato', contratosEst.body?.total)

  // ═══ 9. Lista negra, bloqueio do dono, faltas e suspensão por PESSOA ══════════════════════
  // SQL dos feeds (mesmos fragmentos que GET /obras e GET /reparos usam)
  const fonteObras = fs.readFileSync(path.join(REPO, 'src/controllers/obrasController.js'), 'utf8')
  const fonteRotas = fs.readFileSync(path.join(REPO, 'src/routes/index.js'), 'utf8')
  ok(!/\$1::uuid = ANY\(COALESCE\(o\.prestadores_bloqueados/.test(fonteObras) && !/pb\.prestador_id = \$1/.test(fonteObras) && !/c\.usuario_id = \$1 AND c\.status = 'recusado'/.test(fonteObras),
     'feed de obras: lista negra, bloqueio do dono e recusa não comparam mais com UMA conta')
  ok(!/\$1::uuid = ANY\(COALESCE\(r\.prestadores_bloqueados/.test(fonteRotas) && !/pb\.prestador_id = \$1/.test(fonteRotas) && !/ir\.usuario_id = \$1 AND ir\.status = 'recusado'/.test(fonteRotas),
     'feed de serviços e checar-proximidade: idem')
  await obra(D(6), 'Obra com lista negra')
  await db.query(`UPDATE obras SET prestadores_bloqueados = ARRAY[$2::uuid] WHERE id = $1`, [D(6), PP.id])
  await reparo(D(7), 'Reparo do dono que bloqueou', 'eletrica')
  silenciar(true)
  const feedObras = async (c) => { const x = await rodar('get', '/obras', { id: c.id, query: {} }); return { status: x.status, ids: (Object.values(x.body || {}).find(Array.isArray) || []).map(o => o.id), corpo: x.status === 200 ? undefined : x.body } }
  const feedReparos = async (c) => { const x = await rodar('get', '/reparos', { id: c.id, query: {} }); return { status: x.status, ids: (Object.values(x.body || {}).find(Array.isArray) || []).map(o => o.id), corpo: x.status === 200 ? undefined : x.body } }
  const fo = { PR: await feedObras(PR), PN: await feedObras(PN) }
  // o dono bloqueia a conta PINTOR da pessoa — vale para as duas contas, nos dois feeds
  await db.query(`INSERT INTO prestadores_bloqueados_dono (dono_id, prestador_id) VALUES ($1, $2)`, [DONO.id, PP.id])
  const fr = { PR: await feedReparos(PR), PP: await feedReparos(PP), EST: await feedReparos(EST) }
  const foBloq = await feedObras(PR)
  silenciar(false)
  ok(foBloq.status === 200 && !foBloq.ids.includes(D(4)), 'bloqueio do dono à conta PINTOR também tira as obras dele do feed de obras da conta REPARADOR', foBloq.ids.length)
  ok(fo.PN.status === 200 && fo.PN.ids.includes(D(6)), 'feed de obras: outro pintor VÊ a obra com lista negra', fo.PN)
  ok(fo.PR.status === 200 && !fo.PR.ids.includes(D(6)) && fo.PR.ids.includes(D(4)), 'feed de obras da conta REPARADOR: NÃO vê a obra em que a conta PINTOR está na lista negra (vê as demais)', fo.PR)
  ok(fr.EST.status === 200 && fr.EST.ids.includes(D(7)), 'feed de serviços: o estranho VÊ o serviço do dono que bloqueou a pessoa', fr.EST)
  ok(fr.PR.status === 200 && !fr.PR.ids.includes(D(7)) && !fr.PP.ids.includes(D(7)), 'bloqueio do dono à conta PINTOR vale para a conta REPARADOR (e para o feed unificado da conta pintor)', { PR: fr.PR.ids.length, PP: fr.PP.ids.length })
  await db.query(`DELETE FROM prestadores_bloqueados_dono`)

  // faltas: 2 na conta pintor + 1 na conta reparador = 3 da PESSOA → suspensa; estranho com 2 não
  await db.query(`INSERT INTO faltas_profissional (usuario_id, tabela, demanda_id) VALUES ($1, 'obras', $2), ($1, 'obras', $3), ($4, 'reparos', $5), ($4, 'reparos', $6)`,
    [PP.id, D(4), D(5), EST.id, D(3), D(7)])
  silenciar(true)
  await alerta.avaliarSuspensaoPorFaltas(EST.id)
  const estSuspenso = (await linha(EST.id)).suspenso_em
  pushes.length = 0
  await alerta.registrarFaltaUsuario('reparos', D(3), PR.id)
  await assentar()
  silenciar(false)
  ok(!estSuspenso, 'ESTRANHO com 2 faltas não é suspenso pelas faltas da pessoa de mesmo e-mail', estSuspenso)
  const lp = { PP: await linha(PP.id), PR: await linha(PR.id) }
  ok(!!lp.PR.suspenso_em && !lp.PP.suspenso_em, '3ª falta da PESSOA (2 no pintor + 1 no reparador) suspende — gravada na conta que levou a última falta', { PP: !!lp.PP.suspenso_em, PR: !!lp.PR.suspenso_em })
  r = await rodar('get', '/obras', { id: PP.id, soGates: true })
  ok(r.status === 403 && r.body.codigo === 'CONTA_SUSPENSA', 'a OUTRA conta (pintor) da pessoa suspensa → 403 CONTA_SUSPENSA no feed (sem esperar o cache)', r.body?.codigo || r)
  r = await rodar('get', '/reparos', { id: EST.id, soGates: true })
  ok(r.passou === true, 'estranho segue livre', r.body)
  const u = await auth.carregarUsuario(PP.id)
  ok(!!u.suspenso_em && /faltas/.test(u.suspenso_motivo || '') && igual(u.contas_irmas, [PR.id]), 'linha de sessão da conta pintor: suspensão e motivo da conta irmã; contas_irmas = [reparador]', { motivo: u.suspenso_motivo, irmas: u.contas_irmas.length })
  await obra(D(8), 'Obra nova depois da suspensão')
  silenciar(true)
  pushes.length = 0
  await alerta.notificarPintoresSobreNovaObra(D(8))
  silenciar(false)
  ok(!para().includes(tok(PP.id)) && !para().includes(tok(PR.id)) && para().includes(tok(PN.id)), 'pessoa suspensa não recebe push de obra por NENHUMA conta', para())
  const naoSusp = (await db.query(`SELECT u.id FROM usuarios u WHERE NOT (${tc.sqlPessoaNaoSuspensa('u.id')})`)).rows.map(x => x.id)
  ok(igual(naoSusp, [PP.id, PR.id]), 'sqlPessoaNaoSuspensa: só as duas contas da pessoa contam como suspensas', naoSusp.length)
  // aceite do dono: candidato cuja conta IRMÃ está suspensa é recusado
  await obra(D(9), 'Obra para aceite')
  const c9 = (await db.query(`INSERT INTO candidaturas (obra_id, usuario_id) VALUES ($1, $2) RETURNING id`, [D(9), PP.id])).rows[0].id
  silenciar(true)
  r = await chamar(candCtrl.aprovar, { usuario: await linha(DONO.id), params: { id: c9 } })
  silenciar(false)
  ok(r.status === 409 && r.body.codigo === 'PROFISSIONAL_SUSPENSO', 'dono não consegue aceitar a conta pintor de uma pessoa suspensa pela conta reparador', r.body)
  // levantar a suspensão na conta que a recebeu libera a pessoa
  await db.query(`UPDATE usuarios SET suspenso_em = NULL, suspenso_motivo = NULL WHERE id = $1`, [PR.id])
  limparCache()
  r = await rodar('get', '/obras', { id: PP.id, soGates: true })
  ok(r.passou === true, 'suspensão levantada na conta que a recebeu → a outra conta volta a passar', r.body)

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error = errOrig; console.error('ERRO', e); process.exit(1) })
