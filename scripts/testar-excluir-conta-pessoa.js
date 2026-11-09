#!/usr/bin/env node
// DELETE /conta/excluir — exclusão da PESSOA (decisão do dono, 09/11/2026):
//   • confirmação por { confirmacao: "EXCLUIR" } sem senha; { senha } dos apps antigos continua valendo;
//   • apaga TODAS as contas da pessoa (mesmo CPF normalizado, qualquer papel), cada uma pela cascata
//     de sempre, numa única transação; sem CPF → só a própria conta; NUNCA por e-mail;
//   • contas admin/aprovador nunca entram como "irmãs", e o admin que se exclui apaga só a si.
// Semente: PESSOA com 4 contas (dono_obra, dono_reparo, pintor, reparador — CPF com e sem máscara),
// ESTRANHO com o mesmo e-mail e outro CPF, conta de LOGIN SOCIAL sem senha, duas contas SEM CPF de
// mesmo e-mail, pessoa de app ANTIGO (confirma por senha), admin com o CPF da pessoa, e um terceiro
// (dono e profissional) que se relaciona com todos.
// Cadeia REAL da rota (autenticar com JWT) e SQL real num Postgres em memória (PGlite).
//   npm i -D @electric-sql/pglite && node scripts/testar-excluir-conta-pessoa.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const jwt = require(path.join(REPO, 'node_modules/jsonwebtoken'))
const bcrypt = require(path.join(REPO, 'node_modules/bcrypt'))
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

const emails = []
let db = null
const shim = {
  query: (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return db.query(sql, params) },
  connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: (s, p) => db.query(s, p), release() {} } },
  on() {},
}
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) } }
  if (/brevoService$/.test(request)) return { enviarEmail: async () => {}, enviarEmailComAnexo: async () => {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.error = v ? () => {} : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 120))
const camadas = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack.map(l => l.handle)
}
// Cadeia inteira (autenticar com JWT + handler).
const rodar = (metodo, caminho, id, body) => new Promise(resolve => {
  const hs = camadas(metodo, caminho)
  const req = { headers: { authorization: `Bearer ${jwt.sign({ id, tv: 1 }, process.env.JWT_SECRET)}` }, params: {}, body, query: {}, get: () => '', ip: '127.0.0.1', route: { path: caminho } }
  const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  let i = 0
  const next = (err) => {
    if (err) return resolve({ erro: String(err.message || err) })
    if (i >= hs.length) return resolve({ passou: true })
    Promise.resolve(hs[i++](req, res, next)).catch(e => resolve({ erro: String(e.message || e) }))
  }
  next()
})
const excluir = async (id, body) => { silenciar(true); const r = await rodar('delete', '/conta/excluir', id, body); await assentar(); silenciar(false); return r }
const existem = async (...ids) => (await db.query(`SELECT id FROM usuarios WHERE id = ANY($1::uuid[])`, [ids])).rows.length
const conta = async (tabela, where = 'true', params = []) => (await db.query(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${where}`, params)).rows[0].n

// A PESSOA (4 contas) | estranho | social | sem CPF ×2 | app antigo ×2 | admin com CPF da pessoa |
// admin + dono de mesmo CPF | terceiros | pessoa do teste de transação ×2
const PA = U(1), PB = U(2), PC = U(3), PD = U(4)
const EST = U(5), SOC = U(6), N1 = U(7), N2 = U(8), V1 = U(9), V2 = U(10)
const ADM_P = U(11), ADM2 = U(12), DONO2 = U(13), XD = U(14), XP = U(15), T1 = U(16), T2 = U(17)
const L1 = U(18), L2 = U(19) // limite de tentativas: duas contas de pessoas diferentes

const main = async () => {
  db = new PGlite()
  const hashAntigo = await bcrypt.hash('segredo123', 4)
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, role text, tipo_dono text, tipo_prestador text, cpf_cnpj text, senha_hash text, ativo boolean DEFAULT true,
      push_token text, google_sub text, suspenso_em timestamptz, suspenso_motivo text, token_version int NOT NULL DEFAULT 1, especialidades text[],
      foto_url text, verificacao_doc_frente_url text, verificacao_doc_verso_url text, verificacao_selfie_url text);
    CREATE TABLE obras (id uuid PRIMARY KEY, titulo text, criado_por uuid REFERENCES usuarios(id), match_usuario_id uuid REFERENCES usuarios(id), match_feito_em timestamptz,
      encerramento_solicitado_por uuid REFERENCES usuarios(id), encerramento_solicitado_em timestamptz);
    CREATE TABLE reparos (id uuid PRIMARY KEY, titulo text, criado_por uuid REFERENCES usuarios(id), match_usuario_id uuid REFERENCES usuarios(id), match_feito_em timestamptz,
      encerramento_solicitado_por uuid REFERENCES usuarios(id), encerramento_solicitado_em timestamptz);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid REFERENCES obras(id), usuario_id uuid REFERENCES usuarios(id), status text DEFAULT 'pendente');
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid REFERENCES reparos(id), usuario_id uuid REFERENCES usuarios(id), status text DEFAULT 'pendente');
    CREATE TABLE contratos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), candidatura_id uuid REFERENCES candidaturas(id), interesse_id uuid REFERENCES interesse_reparos(id));
    CREATE TABLE mensagens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid REFERENCES obras(id), autor_id uuid REFERENCES usuarios(id), conteudo text);
    CREATE TABLE midias (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid REFERENCES obras(id), url text, tipo text, ordem int);
    CREATE TABLE midias_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid REFERENCES reparos(id), url text, tipo text, ordem int);
    CREATE TABLE midias_orfas (url text PRIMARY KEY, tipo text, criado_em timestamptz DEFAULT now());
    CREATE TABLE assinaturas (usuario_id uuid REFERENCES usuarios(id), status text, plano text);
    CREATE TABLE localizacoes_prestadores (usuario_id uuid REFERENCES usuarios(id), latitude numeric, longitude numeric);
    CREATE TABLE prestadores_bloqueados_dono (dono_id uuid REFERENCES usuarios(id), prestador_id uuid REFERENCES usuarios(id));
    CREATE TABLE faltas_profissional (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid REFERENCES usuarios(id), tabela text, demanda_id uuid);
    CREATE TABLE avaliacoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), avaliador_id uuid REFERENCES usuarios(id) ON DELETE CASCADE, avaliado_id uuid REFERENCES usuarios(id) ON DELETE CASCADE, estrelas int);
    CREATE TABLE trava_teste (usuario_id uuid REFERENCES usuarios(id));
    CREATE TABLE tentativas_auth (acao text NOT NULL, identificador text NOT NULL, tentativas int NOT NULL DEFAULT 0, janela_em timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (acao, identificador));
  `)
  const usr = (id, nome, email, role, extra = {}) => db.query(
    `INSERT INTO usuarios (id, nome, email, role, tipo_dono, tipo_prestador, cpf_cnpj, senha_hash, push_token, google_sub, foto_url, verificacao_doc_frente_url, verificacao_selfie_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, nome, email, role, extra.tipo_dono || null, extra.tipo_prestador || null, extra.cpf ?? null, extra.senha_hash ?? '$2b$04$naoconferecomnadanaoconferecomnadanaoconferecomnadanaoco', `tok-${id.slice(-2)}`, extra.google_sub || null,
     `https://cdn.invalid/foto-${id.slice(-2)}.jpg`, extra.docs ? `https://cdn.invalid/doc-${id.slice(-2)}.jpg` : null, extra.docs ? `https://cdn.invalid/selfie-${id.slice(-2)}.jpg` : null])
  await usr(PA, 'Pessoa (dono obra)',    'pessoa@x.invalid', 'dono_obra', { tipo_dono: 'pintura', cpf: '111.111.111-11' })
  await usr(PB, 'Pessoa (dono serviço)', 'pessoa@x.invalid', 'dono_obra', { tipo_dono: 'reparo', cpf: '11111111111' })
  await usr(PC, 'Pessoa (pintor)',       'pessoa@x.invalid', 'prestador', { tipo_prestador: 'pintor', cpf: '111.111.111-11', docs: true })
  await usr(PD, 'Pessoa (reparador)',    'pessoa@x.invalid', 'prestador', { tipo_prestador: 'reparador', cpf: '111 111 111 11', docs: true })
  await usr(EST, 'Estranho mesmo e-mail', 'pessoa@x.invalid', 'prestador', { tipo_prestador: 'reparador', cpf: '222.222.222-22' })
  await usr(SOC, 'Login Social', 'social@x.invalid', 'dono_obra', { tipo_dono: 'reparo', cpf: '333.333.333-33', senha_hash: null, google_sub: 'google-123' })
  await usr(N1, 'Sem CPF 1', 'semcpf@x.invalid', 'dono_obra', { tipo_dono: 'reparo' })
  await usr(N2, 'Sem CPF 2', 'semcpf@x.invalid', 'prestador', { tipo_prestador: 'reparador' })
  await usr(V1, 'App antigo (dono)',   'antigo@x.invalid', 'dono_obra', { tipo_dono: 'reparo', cpf: '444.444.444-44', senha_hash: hashAntigo })
  await usr(V2, 'App antigo (pintor)', 'antigo@x.invalid', 'prestador', { tipo_prestador: 'pintor', cpf: '44444444444', senha_hash: hashAntigo })
  await usr(ADM_P, 'Admin com o CPF da pessoa', 'adm@x.invalid', 'admin', { cpf: '111.111.111-11' })
  await usr(ADM2, 'Admin que se exclui', 'adm2@x.invalid', 'admin', { cpf: '555.555.555-55' })
  await usr(DONO2, 'Dono com o CPF do admin', 'dono2@x.invalid', 'dono_obra', { tipo_dono: 'reparo', cpf: '55555555555' })
  await usr(XD, 'Terceiro dono', 'xd@x.invalid', 'dono_obra', { tipo_dono: 'pintura', cpf: '900' })
  await usr(XP, 'Terceiro profissional', 'xp@x.invalid', 'prestador', { tipo_prestador: 'pintor', cpf: '901' })
  await usr(T1, 'Transação 1', 'tx@x.invalid', 'dono_obra', { tipo_dono: 'reparo', cpf: '777.777.777-77' })
  await usr(T2, 'Transação 2', 'tx@x.invalid', 'prestador', { tipo_prestador: 'reparador', cpf: '77777777777' })
  await usr(L1, 'Limite 1', 'limite1@x.invalid', 'dono_obra', { tipo_dono: 'reparo', cpf: '888.888.888-88', senha_hash: hashAntigo })
  await usr(L2, 'Limite 2', 'limite2@x.invalid', 'dono_obra', { tipo_dono: 'reparo', cpf: '999.999.999-99' })
  for (const id of [PC, PD, EST, N2, V2, XP, T2]) await db.query(`INSERT INTO assinaturas VALUES ($1, 'ativa', 'mensal')`, [id])

  // Demandas ABERTAS da pessoa (com proposta, mídia e conversa de terceiros)
  await db.query(`INSERT INTO obras (id, titulo, criado_por) VALUES ($1, 'Obra da pessoa', $2), ($3, 'Obra do terceiro', $4), ($5, 'Obra do terceiro 2', $4)`, [D(1), PA, D(9), XD, D(8)])
  await db.query(`INSERT INTO reparos (id, titulo, criado_por) VALUES ($1, 'Serviço da pessoa', $2), ($3, 'Serviço do terceiro', $4), ($5, 'Serviço sem CPF', $6), ($7, 'Serviço da transação', $8)`, [D(2), PB, D(7), XD, D(6), N1, D(5), T1])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id) VALUES ($1, $2)`, [D(1), XP])
  await db.query(`INSERT INTO midias (obra_id, url, tipo, ordem) VALUES ($1, 'https://cdn.invalid/obra1.jpg', 'foto', 1)`, [D(1)])
  await db.query(`INSERT INTO mensagens (obra_id, autor_id, conteudo) VALUES ($1, $2, 'Dúvida'), ($3, $4, 'Dúvida do pintor da pessoa')`, [D(1), XP, D(9), PC])
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id) VALUES ($1, $2)`, [D(2), EST])
  await db.query(`INSERT INTO midias_reparos (reparo_id, url, tipo, ordem) VALUES ($1, 'https://cdn.invalid/reparo2.mp4', 'video', 1)`, [D(2)])
  // A pessoa como PROFISSIONAL em demandas de terceiros: match + contrato (pintor), interesse (reparador)
  const candPC = (await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status) VALUES ($1, $2, 'aceito') RETURNING id`, [D(9), PC])).rows[0].id
  await db.query(`UPDATE obras SET match_usuario_id = $2, match_feito_em = now(), encerramento_solicitado_por = $2, encerramento_solicitado_em = now() WHERE id = $1`, [D(9), PC])
  await db.query(`INSERT INTO contratos (candidatura_id) VALUES ($1)`, [candPC])
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id) VALUES ($1, $2), ($1, $3)`, [D(7), PD, EST])
  await db.query(`INSERT INTO faltas_profissional (usuario_id, tabela, demanda_id) VALUES ($1, 'reparos', $2)`, [PD, D(7)])
  await db.query(`INSERT INTO localizacoes_prestadores VALUES ($1, -18.9, -48.2), ($2, -18.9, -48.2)`, [PD, EST])
  await db.query(`INSERT INTO prestadores_bloqueados_dono VALUES ($1, $2), ($3, $4)`, [PA, XP, XD, PD])
  await db.query(`INSERT INTO avaliacoes (avaliador_id, avaliado_id, estrelas) VALUES ($1, $2, 5), ($3, $4, 4)`, [XD, PC, PA, XP])

  // ═══ 1. Validação da confirmação — nada é apagado ═════════════════════════════════════════
  let r = await excluir(PA, {})
  ok(r.status === 400 && /Senha é obrigatória/.test(r.body.erro), 'corpo vazio → 400 (mensagem de sempre, apps antigos)', r.body)
  r = await excluir(PA, { confirmacao: 'sim' })
  ok(r.status === 400 && r.body.codigo === 'CONFIRMACAO_INVALIDA' && /Digite EXCLUIR/.test(r.body.erro), '{ confirmacao: "sim" } → 400 "Digite EXCLUIR…"', r.body)
  r = await excluir(PA, { confirmacao: 'EXCLUIR TUDO' })
  ok(r.status === 400 && r.body.codigo === 'CONFIRMACAO_INVALIDA', '{ confirmacao: "EXCLUIR TUDO" } → 400', r.body)
  r = await excluir(PA, { confirmacao: true })
  ok(r.status === 400, 'confirmacao que não é texto → 400', r.body)
  r = await excluir(PA, { senha: 'qualquer' })
  ok(r.status === 401 && r.body.erro === 'Senha incorreta', '{ senha } errada → 401 (caminho antigo intacto)', r.body)
  ok(await existem(PA, PB, PC, PD) === 4 && await conta('obras') === 3 && await conta('reparos') === 4, 'nenhuma dessas tentativas apagou nada')

  // ═══ 2. Transação única: falha numa conta desfaz TODAS ════════════════════════════════════
  await db.query(`INSERT INTO trava_teste VALUES ($1)`, [T2])   // FK sem cascata: a 2ª conta não pode ser apagada
  r = await excluir(T1, { confirmacao: 'EXCLUIR' })
  ok(r.status === 500, 'pessoa com 2 contas em que a 2ª não pode ser apagada → 500', r.body)
  ok(await existem(T1, T2) === 2 && await conta('reparos', 'id = $1', [D(5)]) === 1 && await conta('assinaturas', 'usuario_id = $1', [T2]) === 1,
     'ROLLBACK: a 1ª conta, o serviço dela e a assinatura da 2ª continuam lá (ou saem todas, ou nenhuma)')
  await db.query(`DELETE FROM trava_teste`)

  // ═══ 3. PESSOA com 4 contas: { confirmacao: "EXCLUIR" }, sem senha, logada como reparador ══
  emails.length = 0
  r = await excluir(PD, { confirmacao: 'EXCLUIR' })
  ok(r.status === 200 && r.body.contas_excluidas === 4 && r.body.mensagem === 'Conta excluída com sucesso.', '{ confirmacao: "EXCLUIR" } → 200, 4 contas da pessoa excluídas', r.body)
  ok(await existem(PA, PB, PC, PD) === 0, 'as 4 contas (dono_obra, dono_reparo, pintor, reparador — CPF com e sem máscara) sumiram')
  ok(await existem(EST) === 1, 'ESTRANHO com o MESMO e-mail e outro CPF continua existindo')
  ok(await existem(ADM_P) === 1, 'conta ADMIN com o CPF da pessoa NÃO é apagada como irmã')
  ok(await conta('obras', 'id = $1', [D(1)]) === 0 && await conta('reparos', 'id = $1', [D(2)]) === 0, 'demandas abertas da pessoa (obra e serviço) apagadas')
  ok(await conta('candidaturas', 'obra_id = $1', [D(1)]) === 0 && await conta('mensagens', 'obra_id = $1', [D(1)]) === 0 && await conta('midias') === 0 && await conta('midias_reparos') === 0,
     'propostas, conversas e mídias das demandas dela apagadas')
  ok(await conta('interesse_reparos', 'reparo_id = $1', [D(2)]) === 0, 'interesse do ESTRANHO no serviço dela saiu junto com o serviço (como sempre)')
  const o9 = (await db.query(`SELECT match_usuario_id, encerramento_solicitado_por FROM obras WHERE id = $1`, [D(9)])).rows[0]
  ok(o9 && o9.match_usuario_id === null && o9.encerramento_solicitado_por === null, 'obra do terceiro em que o pintor da pessoa estava casado: continua, sem match', o9)
  ok(await conta('contratos') === 0 && await conta('candidaturas', 'usuario_id = $1', [PC]) === 0 && await conta('mensagens', 'autor_id = $1', [PC]) === 0, 'contrato, candidatura e mensagens do pintor da pessoa apagados')
  ok(await conta('interesse_reparos', 'reparo_id = $1', [D(7)]) === 1 && await conta('interesse_reparos', 'usuario_id = $1', [EST]) === 1, 'no serviço do terceiro: sai o interesse da pessoa, FICA o do estranho')
  ok(await conta('assinaturas', 'usuario_id = ANY($1::uuid[])', [[PC, PD]]) === 0 && await conta('assinaturas', 'usuario_id = $1', [EST]) === 1, 'assinaturas da pessoa apagadas; a do estranho fica')
  ok(await conta('faltas_profissional') === 0 && await conta('localizacoes_prestadores') === 1 && await conta('prestadores_bloqueados_dono') === 0, 'faltas, localização e bloqueios da pessoa apagados (localização do estranho fica)')
  ok(await conta('avaliacoes') === 0, 'avaliações dadas/recebidas pela pessoa caem por CASCADE')
  const orfas = (await db.query(`SELECT url FROM midias_orfas ORDER BY url`)).rows.map(x => x.url)
  ok(orfas.length === 10 && orfas.includes('https://cdn.invalid/obra1.jpg') && orfas.includes('https://cdn.invalid/reparo2.mp4') && orfas.includes('https://cdn.invalid/selfie-04.jpg') && orfas.includes('https://cdn.invalid/foto-01.jpg'),
     'arquivos na fila de exclusão: mídias das demandas + foto das 4 contas + documento e selfie dos 2 perfis profissionais', orfas.length)
  ok(emails.length === 1 && emails[0].para === 'pessoa@x.invalid', 'UM e-mail de confirmação (as 4 contas dividem o endereço)', emails.map(e => e.para))
  silenciar(true)
  const depois = await rodar('get', '/auth/contas', PA, {})
  silenciar(false)
  ok(depois.status === 401, 'token de uma conta excluída deixa de valer (401)', depois.status)
  r = await excluir(PD, { confirmacao: 'EXCLUIR' })
  ok(r.status === 401, 'repetir a exclusão com o token antigo → 401', r.status)

  // ═══ 4. Login SOCIAL sem senha ════════════════════════════════════════════════════════════
  r = await excluir(SOC, { senha: 'nao-tenho-senha' })
  ok(r.status === 401 && await existem(SOC) === 1, 'conta de login social pelo caminho antigo ({ senha }) → 401, sem erro 500', r.body)
  emails.length = 0
  r = await excluir(SOC, { confirmacao: ' excluir ' })
  ok(r.status === 200 && r.body.contas_excluidas === 1 && await existem(SOC) === 0, 'conta de login social SEM senha exclui com a palavra (aceita minúsculas e espaços)', r.body)
  ok(emails.length === 1 && emails[0].para === 'social@x.invalid', 'e-mail de confirmação à conta social', emails.map(e => e.para))

  // ═══ 5. Sem CPF: só a própria conta ═══════════════════════════════════════════════════════
  r = await excluir(N1, { confirmacao: 'EXCLUIR' })
  ok(r.status === 200 && r.body.contas_excluidas === 1 && await existem(N1) === 0 && await existem(N2) === 1, 'conta SEM CPF: exclui só a própria — a outra conta sem CPF de mesmo e-mail fica', r.body)
  ok(await conta('reparos', 'id = $1', [D(6)]) === 0 && await conta('assinaturas', 'usuario_id = $1', [N2]) === 1, 'o serviço dela saiu; a assinatura da outra conta ficou')

  // ═══ 6. App antigo: { senha } correta também apaga a pessoa inteira ════════════════════════
  r = await excluir(V1, { senha: 'errada' })
  ok(r.status === 401 && await existem(V1, V2) === 2, 'app antigo, senha errada → 401, nada apagado', r.body)
  r = await excluir(V1, { senha: 'segredo123' })
  ok(r.status === 200 && r.body.contas_excluidas === 2 && await existem(V1, V2) === 0, 'app antigo, senha certa → 200 e as 2 contas da pessoa excluídas', r.body)

  // ═══ 7. Admin: nunca irmã, e ao se excluir apaga só a si ══════════════════════════════════
  r = await excluir(ADM2, { confirmacao: 'EXCLUIR' })
  ok(r.status === 200 && r.body.contas_excluidas === 1 && await existem(ADM2) === 0 && await existem(DONO2) === 1, 'admin que se exclui apaga SÓ a própria linha — a conta de dono com o mesmo CPF fica', r.body)
  r = await excluir(DONO2, { confirmacao: 'EXCLUIR' })
  ok(r.status === 200 && r.body.contas_excluidas === 1, 'depois, o dono exclui a sua normalmente', r.body)

  // ═══ 7b. Limite próprio: 5 tentativas por CONTA por hora ══════════════════════════════════
  const tentativasL1 = []
  for (let i = 1; i <= 5; i++) tentativasL1.push(await excluir(L1, { senha: `palpite-${i}` }))
  ok(tentativasL1.every(x => x.status === 401), 'as 5 primeiras tentativas (senha errada) respondem 401 como sempre', tentativasL1.map(x => x.status))
  r = await excluir(L1, { senha: 'segredo123' })
  ok(r.status === 429 && r.body.erro === 'Muitas tentativas. Tente novamente mais tarde.' && r.body.codigo === 'MUITAS_TENTATIVAS' && r.body.retry_apos_segundos > 0 && r.body.retry_apos_segundos <= 3600,
     '6ª tentativa na mesma hora → 429 "Muitas tentativas. Tente novamente mais tarde." — mesmo com a senha CERTA', r.body)
  r = await excluir(L1, { confirmacao: 'EXCLUIR' })
  ok(r.status === 429 && await existem(L1) === 1, '7ª, agora com a palavra de confirmação → 429 também; a conta continua lá', r.status)
  r = await excluir(L2, { confirmacao: 'EXCLUIR' })
  ok(r.status === 200 && await existem(L2) === 0, 'o limite é por CONTA: outra conta exclui normalmente enquanto a primeira está bloqueada', r.body)
  ok(await conta('tentativas_auth', `acao = 'excluir_conta' AND identificador = $1`, [L2]) === 0, 'conta excluída não deixa contador para trás')
  await db.query(`UPDATE tentativas_auth SET janela_em = now() - INTERVAL '61 minutes' WHERE acao = 'excluir_conta' AND identificador = $1`, [L1])
  r = await excluir(L1, { confirmacao: 'EXCLUIR' })
  ok(r.status === 200 && await existem(L1) === 0, 'passada 1 hora da primeira tentativa, a janela zera e a exclusão acontece', r.body)

  // ═══ 8. Ninguém de fora foi tocado ════════════════════════════════════════════════════════
  ok(await existem(EST, N2, ADM_P, XD, XP, T1, T2) === 7, 'estranho, 2ª conta sem CPF, admin, terceiros e a pessoa do teste de transação: todos intactos')
  ok(await conta('obras') === 2 && await conta('reparos') === 2, 'restam só as demandas dos terceiros e da pessoa do teste de transação', { obras: await conta('obras'), reparos: await conta('reparos') })

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error = errOrig; console.error('ERRO', e); process.exit(1) })
