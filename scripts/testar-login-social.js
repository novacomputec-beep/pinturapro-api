#!/usr/bin/env node
// Testa POST /auth/social (Google e Apple) e POST /auth/cadastro com `ticket`, com o SQL REAL num
// Postgres em memória (PGlite). Google: `google-auth-library` trocado por um OAuth2Client falso
// que devolve o payload programado. Apple: a verificação RS256 é a REAL — um par de chaves RSA
// gerado aqui, publicado por um `fetch` falso no formato JWKS da Apple, e os identity tokens são
// assinados com a privada (iss/aud/exp/kid conferidos de verdade pelo serviço).
//   npm i -D @electric-sql/pglite && node scripts/testar-login-social.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const crypto = require('crypto')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const bcrypt = require(path.join(REPO, 'node_modules/bcrypt'))
const jwt = require(path.join(REPO, 'node_modules/jsonwebtoken'))
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

let db = null
const client = () => ({ query: (sql, params) => db.query(sql, params), release() {} })
const shim = {
  query: (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return db.query(sql, params) },
  connect: async () => { if (!db) throw new Error('sem banco (boot)'); return client() },
  on() {},
}
// Google falso: cada verifyIdToken devolve o que o teste programou em `googlePayload` (ou lança).
let googlePayload = null
let googleAudienceVista = null
class OAuth2ClientFalso {
  constructor(id) { this.clientId = id }
  async verifyIdToken({ idToken, audience }) {
    googleAudienceVista = audience
    if (idToken !== 'google-ok') throw new Error('Invalid token signature')
    return { getPayload: () => googlePayload }
  }
}
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (request === 'google-auth-library') return { OAuth2Client: OAuth2ClientFalso }
  if (/utils[\\/]plataforma$/.test(request)) return { ...origLoad.apply(this, arguments), registrarPlataforma() {}, detectarPlataforma() { return false } }
  if (/utils[\\/]desinstalacoes$/.test(request)) return { ...origLoad.apply(this, arguments), registrarReinstalacao() {} }
  if (/services[\\/]alertaService$/.test(request)) return { enviarBoasVindas: async () => {} }
  if (/services[\\/]conviteCanalService$/.test(request)) return { enviarConviteCanal: async () => 'pulado' }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })

// Chaves da Apple: par RSA gerado aqui; o fetch falso publica a pública como JWKS.
const { publicKey: applePub, privateKey: applePriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const { publicKey: outraPub, privateKey: outraPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = 'kid-teste-1'
let fetchChamadas = 0
global.fetch = async (url) => {
  fetchChamadas++
  if (!/appleid\.apple\.com\/auth\/keys$/.test(url)) throw new Error('fetch inesperado ' + url)
  const jwk = applePub.export({ format: 'jwk' })
  return { ok: true, json: async () => ({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] }) }
}

const silencio = () => {}
const logOrig = console.log, errOrig = console.error
console.log = silencio; console.error = silencio
const router = require(path.join(REPO, 'src/routes/index.js'))
const authCtrl = require(path.join(REPO, 'src/controllers/authController'))
const cfg = require(path.join(REPO, 'src/config/loginSocial'))
const { sqlTipoConta } = require(path.join(REPO, 'src/utils/tipoConta'))
console.log = logOrig; console.error = errOrig

const handlerDe = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const chamar = (handler, { params = {}, body = {}, usuario } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, body, usuario, ip: '127.0.0.1', get() { return '' } }, res)
})
const hSocial = handlerDe('post', '/auth/social')
const hLogin = handlerDe('post', '/auth/login')
const social = (body) => chamar(hSocial, { body })
const login = (body) => chamar(hLogin, { body })
const cadastrar = (body) => chamar(authCtrl.cadastrar, { body })
const google = (payload, extra = {}) => { googlePayload = payload; return social({ provedor: 'google', id_token: 'google-ok', ...extra }) }
const tokenApple = (claims, { chave = applePriv, kid = KID, alg = 'RS256', ...opts } = {}) =>
  jwt.sign({ iss: cfg.APPLE_ISS, aud: cfg.APPLE_AUD, email_verified: 'true', ...claims }, chave, { algorithm: alg, keyid: kid, expiresIn: '10m', ...opts })
const apple = (claims, tokOpts, extra = {}) => social({ provedor: 'apple', id_token: tokenApple(claims, tokOpts), ...extra })

const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const SENHA = 'Senha12345'

const main = async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text, email text, telefone text, senha_hash text NOT NULL, cidade text, uf text,
      especialidades text[], anos_experiencia int, tamanho_equipe int, cpf_cnpj text, role text, ativo boolean DEFAULT true,
      tipo_dono text, pix_reembolso text, referencias jsonb, verificacao_doc_frente_url text, verificacao_doc_verso_url text,
      verificacao_selfie_url text, verificacao_status text DEFAULT 'nao_solicitada', rg text, rg_orgao text, rg_estado text,
      tipo_prestador text, cep text, latitude numeric, longitude numeric, logradouro text, numero text, complemento text, bairro text,
      foto_url text, codigo_indicacao text, indicado_por uuid, token_version int NOT NULL DEFAULT 1, boas_vindas_exibida boolean DEFAULT false,
      aceita_promocoes boolean, aprovado_automaticamente boolean, dois_fa_ativo boolean DEFAULT false, dois_fa_secret text,
      google_sub text, apple_sub text, criado_em timestamptz DEFAULT now());
    CREATE UNIQUE INDEX usuarios_cpf_cnpj_tipo_unico_idx ON usuarios ((regexp_replace(cpf_cnpj, '[^0-9]', '', 'g')), ${sqlTipoConta()}) WHERE cpf_cnpj IS NOT NULL AND cpf_cnpj <> '';
    CREATE UNIQUE INDEX usuarios_email_tipo_unico_idx ON usuarios (email, ${sqlTipoConta()});
    CREATE INDEX usuarios_google_sub_idx ON usuarios (google_sub) WHERE google_sub IS NOT NULL;
    CREATE INDEX usuarios_apple_sub_idx ON usuarios (apple_sub) WHERE apple_sub IS NOT NULL;
    ALTER TABLE usuarios ADD COLUMN avisos_todas_areas boolean NOT NULL DEFAULT true; -- preferência do aviso "fora da sua área" (migração de boot)
    CREATE TABLE assinaturas (usuario_id uuid, plano text, valor_mensal numeric, status text, tipo text, proximo_vencimento timestamptz, criado_em timestamptz DEFAULT now());
    CREATE TABLE configuracoes (chave text, valor text);
    CREATE TABLE candidaturas (obra_id uuid, usuario_id uuid); CREATE TABLE interesse_reparos (reparo_id uuid, usuario_id uuid); -- montarSessao lê tem_candidaturas / tem_interesses (Fases 2a e 2b)
    CREATE TABLE tentativas_auth (acao text, identificador text, tentativas int DEFAULT 0, janela_em timestamptz DEFAULT now(), PRIMARY KEY (acao, identificador));
    INSERT INTO configuracoes VALUES ('multiplas_contas', 'true');
    CREATE FUNCTION gerar_codigo_indicacao() RETURNS text LANGUAGE sql AS $$ SELECT 'COD' || floor(random()*100000)::text $$;
  `)
  await db.exec(`CREATE TABLE IF NOT EXISTS obras (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, status_aprovacao text, expira_em timestamptz, match_usuario_id uuid)`)
  // obras.especialidades_inferidas (capacidadesDaPessoa / feed / aviso de obra nova leem a coluna) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/especialidadesInferidas')).migrarEspecialidadesInferidas(db)
  const hash = bcrypt.hashSync(SENHA, 4)
  // Ana: dona de pintura por senha. Lu: reparador + dona de pintura (múltiplas contas) por senha.
  // Dida: conta desativada. Adm: admin com 2FA ligado.
  await db.query(`INSERT INTO usuarios (id, nome, email, senha_hash, cpf_cnpj, role, tipo_dono, criado_em) VALUES ($1, 'Ana Dona', 'ana@x.invalid', $2, '111.111.111-11', 'dono_obra', 'pintura', '2026-01-01')`, [U(1), hash])
  await db.query(`INSERT INTO assinaturas VALUES ($1, 'mensal', 0, 'ativa', 'gratuito', NULL)`, [U(1)])
  await db.query(`INSERT INTO usuarios (id, nome, email, senha_hash, cpf_cnpj, role, tipo_prestador, especialidades, criado_em) VALUES ($1, 'Lu Borges', 'lu@x.invalid', $2, '222.222.222-22', 'prestador', 'reparador', '{eletrica}', '2026-02-01')`, [U(2), hash])
  await db.query(`INSERT INTO usuarios (id, nome, email, senha_hash, cpf_cnpj, role, tipo_dono, criado_em) VALUES ($1, 'Lu Borges', 'lu@x.invalid', $2, '222.222.222-22', 'dono_obra', 'pintura', '2026-02-02')`, [U(3), hash])
  await db.query(`INSERT INTO usuarios (id, nome, email, senha_hash, role, tipo_dono, ativo) VALUES ($1, 'Dida', 'dida@x.invalid', $2, 'dono_obra', 'reparo', false)`, [U(4), hash])
  await db.query(`INSERT INTO usuarios (id, nome, email, senha_hash, role, dois_fa_ativo, dois_fa_secret) VALUES ($1, 'Adm', 'adm@x.invalid', $2, 'admin', true, 'JBSWY3DPEHPK3PXP')`, [U(5), hash])

  // ---- validação do corpo
  let r = await social({ provedor: 'facebook', id_token: 'x' })
  ok(r.status === 400 && r.body.codigo === 'provedor_invalido', 'provedor desconhecido → 400', r.body)
  r = await social({ provedor: 'google' })
  ok(r.status === 400 && r.body.codigo === 'id_token_obrigatorio', 'sem id_token → 400', r.body)

  // ---- Google
  googlePayload = null
  r = await social({ provedor: 'google', id_token: 'google-ruim' })
  ok(r.status === 401 && r.body.codigo === 'token_social_invalido', 'Google: token inválido → 401', r.body)
  ok(googleAudienceVista === cfg.GOOGLE_WEB_CLIENT_ID && /^592909036534-.*\.apps\.googleusercontent\.com$/.test(cfg.GOOGLE_WEB_CLIENT_ID), 'Google: audience = GOOGLE_WEB_CLIENT_ID da config', googleAudienceVista)
  r = await google({ sub: 'g-ana', email: 'ana@x.invalid', email_verified: false, name: 'Ana' })
  ok(r.status === 401 && r.body.codigo === 'email_nao_verificado', 'Google: email_verified=false → 401 (e-mail não vincula)', r.body)
  ok((await db.query(`SELECT google_sub FROM usuarios WHERE id = $1`, [U(1)])).rows[0].google_sub === null, 'Google: nada gravado na conta da Ana')

  // conta existente por e-mail (senha) → payload do login + sub gravado
  const porSenha = await login({ email: 'ana@x.invalid', senha: SENHA })
  r = await google({ sub: 'g-ana', email: 'Ana@X.invalid', email_verified: true, name: 'Ana G' })
  ok(r.status === 200 && r.body.usuario?.id === U(1) && r.body.token && r.body.assinatura?.status === 'ativa' && !('contas' in r.body) && !('novo' in r.body),
     'Google: e-mail verificado com conta → sessão da Ana (e-mail normalizado)', { id: r.body.usuario?.id })
  ok(JSON.stringify(Object.keys(r.body)) === JSON.stringify(Object.keys(porSenha.body)) && JSON.stringify(Object.keys(r.body.usuario)) === JSON.stringify(Object.keys(porSenha.body.usuario))
     && JSON.stringify({ ...r.body, token: 0 }) === JSON.stringify({ ...porSenha.body, token: 0 }),
     'Google: payload idêntico ao do login por senha (menos o token)', Object.keys(r.body))
  let dec = jwt.verify(r.body.token, process.env.JWT_SECRET)
  ok(dec.id === U(1) && dec.role === 'dono_obra' && dec.tv === 1, 'Google: token de sessão da Ana', dec)
  ok((await db.query(`SELECT google_sub FROM usuarios WHERE id = $1`, [U(1)])).rows[0].google_sub === 'g-ana', 'Google: google_sub gravado na conta')

  // segundo login: acha por sub mesmo com e-mail trocado no token/na conta
  await db.query(`UPDATE usuarios SET email = 'ana-nova@x.invalid' WHERE id = $1`, [U(1)])
  r = await google({ sub: 'g-ana', email: 'ana@x.invalid', email_verified: true })
  ok(r.status === 200 && r.body.usuario?.id === U(1) && r.body.usuario.email === 'ana-nova@x.invalid', 'Google: 2º login acha por sub, não por e-mail (e-mail da conta mudou)', r.body.usuario?.email)
  await db.query(`UPDATE usuarios SET email = 'ana@x.invalid' WHERE id = $1`, [U(1)])

  // múltiplas contas: contas[] + tipo + 404 em tipo inexistente; sub nas DUAS linhas
  r = await google({ sub: 'g-lu', email: 'lu@x.invalid', email_verified: true })
  ok(r.status === 200 && r.body.usuario?.id === U(2) && r.body.contas?.length === 2, 'Google: Lu (2 contas) sem tipo → a mais antiga + contas[2]', r.body.contas?.map(c => c.tipo))
  r = await google({ sub: 'g-lu', email: 'lu@x.invalid', email_verified: true }, { tipo: 'dono_obra' })
  ok(r.status === 200 && r.body.usuario?.id === U(3) && r.body.contas?.length === 2, "Google: Lu com tipo 'dono_obra' → entra na dona", r.body.usuario?.id)
  r = await google({ sub: 'g-lu', email: 'lu@x.invalid', email_verified: true }, { tipo: 'pintor' })
  ok(r.status === 404 && r.body.codigo === 'conta_tipo_inexistente' && r.body.contas?.length === 2, 'Google: tipo sem conta → 404 com contas[]', r.body.codigo)
  ok((await db.query(`SELECT count(*)::int n FROM usuarios WHERE email = 'lu@x.invalid' AND google_sub = 'g-lu'`)).rows[0].n === 2, 'Google: google_sub nas 2 contas do e-mail')

  // conta desativada; admin com 2FA
  r = await google({ sub: 'g-dida', email: 'dida@x.invalid', email_verified: true })
  ok(r.status === 403 && /desativada/.test(r.body.erro), 'Google: conta desativada → 403', r.body)
  r = await google({ sub: 'g-adm', email: 'adm@x.invalid', email_verified: true })
  const temp = r.body.temp_token && jwt.verify(r.body.temp_token, process.env.JWT_SECRET)
  ok(r.status === 200 && r.body.requer_2fa === true && temp?.tipo === '2fa_pendente' && temp.id === U(5) && !r.body.token, 'Google: admin com 2FA → requer_2fa + temp_token (sem sessão)', { requer_2fa: r.body.requer_2fa })

  // sem conta → novo + ticket; cadastro com ticket
  r = await google({ sub: 'g-novo', email: 'novo@x.invalid', email_verified: true, name: 'Novo Google' })
  ok(r.status === 200 && r.body.novo === true && r.body.nome === 'Novo Google' && r.body.email === 'novo@x.invalid' && typeof r.body.ticket === 'string', 'Google: sem conta → { novo, nome, email, ticket }', { ...r.body, ticket: '…' })
  const tk = jwt.verify(r.body.ticket, process.env.JWT_SECRET)
  ok(tk.tipo === cfg.TICKET_TIPO && tk.provedor === 'google' && tk.sub === 'g-novo' && tk.email === 'novo@x.invalid' && tk.exp - tk.iat === 15 * 60, 'ticket: JWT 15 min com provedor/sub/e-mail', { exp: tk.exp - tk.iat })
  ok((await db.query(`SELECT count(*)::int n FROM usuarios WHERE email = 'novo@x.invalid'`)).rows[0].n === 0, 'ticket não cria conta')
  r = await google({ sub: 'g-novo', email: 'novo@x.invalid', email_verified: true }, { nome: 'eu@x.invalid' })
  ok(r.body.novo === true && r.body.nome === null, 'nome do corpo que parece e-mail é ignorado (null)', r.body.nome)
  const ticket = tk && (await google({ sub: 'g-novo', email: 'novo@x.invalid', email_verified: true }, { nome: 'Novo Corpo' })).body.ticket
  ok(jwt.decode(ticket).nome === 'Novo Corpo', 'nome do corpo manda sobre o do provedor')

  r = await cadastrar({ ticket, nome: 'Novo Corpo', email: 'outro@x.invalid', tipo_conta: 'dono_obra', tipo_dono: 'reparo', cidade: 'Uberlândia', uf: 'MG', telefone: '34999990000', cpf_cnpj: '333.333.333-33' })
  ok(r.status === 201 && r.body.usuario?.email === 'novo@x.invalid' && r.body.token && r.body.assinatura?.status === 'ativa', 'cadastro com ticket (sem senha): 201, e-mail TRAVADO no do ticket (corpo ignorado)', { email: r.body.usuario?.email, status: r.status, erro: r.body.erro })
  const novo = (await db.query(`SELECT * FROM usuarios WHERE email = 'novo@x.invalid'`)).rows[0]
  ok(novo && novo.google_sub === 'g-novo' && novo.apple_sub === null && novo.role === 'dono_obra' && novo.tipo_dono === 'reparo', 'conta nova com google_sub gravado (dono_reparo)', { google_sub: novo?.google_sub, tipo_dono: novo?.tipo_dono })
  ok(/^\$2[ab]\$10\$/.test(novo.senha_hash) && !(await bcrypt.compare('', novo.senha_hash)) && !(await bcrypt.compare('undefined', novo.senha_hash)), 'senha_hash aleatório (bcrypt custo 10; vazio/undefined não conferem)')
  r = await login({ email: 'novo@x.invalid', senha: SENHA })
  ok(r.status === 401, 'conta social não entra por senha chutada → 401')
  r = await google({ sub: 'g-novo', email: 'novo@x.invalid', email_verified: true })
  ok(r.status === 200 && r.body.usuario?.id === novo.id && !r.body.novo, 'login social seguinte entra na conta nova (por sub)')
  r = await cadastrar({ ticket, nome: 'Novo Corpo', tipo_conta: 'dono_obra', tipo_dono: 'reparo' })
  ok(r.status === 409 && r.body.codigo === 'email_duplicado', 'mesmo ticket de novo SEM CPF → 409 email_duplicado (regra de múltiplas contas: CPF tem que casar)', r.body)
  r = await cadastrar({ ticket, nome: 'Novo Corpo', tipo_conta: 'dono_obra', tipo_dono: 'reparo', cpf_cnpj: '333.333.333-33' })
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'mesmo ticket de novo, mesmo tipo e CPF → 409 tipo_duplicado', r.body)
  r = await cadastrar({ ticket, nome: 'Novo Corpo', tipo_conta: 'pintor', especialidades: ['pintor'], cpf_cnpj: '333.333.333-33' })
  ok(r.status === 201 && r.body.usuario?.role === 'prestador', 'ticket + e-mail existente em OUTRO tipo: novo perfil sem pedir senha (identidade provada pelo provedor)', { status: r.status, erro: r.body.erro })
  ok((await db.query(`SELECT senha_hash FROM usuarios WHERE email = 'novo@x.invalid'`)).rows.every(u => u.senha_hash === novo.senha_hash), 'novo perfil reusa o hash da conta existente (uma senha por e-mail)')

  // ticket inválido / expirado / de sessão
  r = await cadastrar({ ticket: ticket + 'x', nome: 'X', tipo_conta: 'dono_obra' })
  ok(r.status === 401 && r.body.codigo === 'ticket_invalido', 'ticket adulterado → 401 ticket_invalido', r.body)
  const expirado = jwt.sign({ tipo: cfg.TICKET_TIPO, provedor: 'google', sub: 'g-x', email: 'x@x.invalid' }, process.env.JWT_SECRET, { expiresIn: -1 })
  r = await cadastrar({ ticket: expirado, nome: 'X', tipo_conta: 'dono_obra' })
  ok(r.status === 401 && r.body.codigo === 'ticket_invalido', 'ticket expirado → 401', r.body)
  const sessao = jwt.sign({ id: U(1), role: 'dono_obra', tv: 1 }, process.env.JWT_SECRET)
  r = await cadastrar({ ticket: sessao, nome: 'X', tipo_conta: 'dono_obra' })
  ok(r.status === 401 && r.body.codigo === 'ticket_invalido', 'token de sessão no lugar do ticket → 401', r.body)
  r = await cadastrar({ nome: 'Sem Nada', email: 'semnada@x.invalid', tipo_conta: 'dono_obra' })
  ok(r.status === 400 && /obrigat/.test(r.body.erro), 'sem senha e sem ticket → 400 como antes', r.body)
  r = await cadastrar({ nome: 'Com Senha', email: 'comsenha@x.invalid', senha: SENHA, tipo_conta: 'dono_obra', tipo_dono: 'pintura' })
  ok(r.status === 201 && (await db.query(`SELECT google_sub, apple_sub FROM usuarios WHERE email = 'comsenha@x.invalid'`)).rows[0].google_sub === null, 'cadastro por senha intacto (sem sub)', { status: r.status })
  r = await login({ email: 'comsenha@x.invalid', senha: SENHA })
  ok(r.status === 200 && r.body.token, 'login por senha intacto')

  // ---- Apple (RS256 real contra o JWKS falso)
  r = await apple({ sub: 'a-ana', email: 'ana@x.invalid' })
  ok(r.status === 200 && r.body.usuario?.id === U(1) && fetchChamadas === 1, 'Apple: token válido, e-mail real com conta → sessão da Ana (JWKS lido 1x)', { id: r.body.usuario?.id, fetch: fetchChamadas })
  ok((await db.query(`SELECT apple_sub, google_sub FROM usuarios WHERE id = $1`, [U(1)])).rows[0].apple_sub === 'a-ana', 'Apple: apple_sub gravado (google_sub preservado)')
  r = await apple({ sub: 'a-ana' })
  ok(r.status === 200 && r.body.usuario?.id === U(1) && fetchChamadas === 1, 'Apple: token SEM e-mail acha por sub (chaves do cache)', fetchChamadas)
  r = await apple({ sub: 'a-ana', email: 'ana@x.invalid' }, { expiresIn: -5 })
  ok(r.status === 401 && r.body.codigo === 'token_social_invalido', 'Apple: expirado → 401', r.body)
  r = await apple({ sub: 'a-ana', email: 'ana@x.invalid', aud: 'com.outro.app' })
  ok(r.status === 401, 'Apple: aud errado → 401', r.body.codigo)
  r = await apple({ sub: 'a-ana', email: 'ana@x.invalid', iss: 'https://accounts.google.com' })
  ok(r.status === 401, 'Apple: iss errado → 401')
  r = await apple({ sub: 'a-ana', email: 'ana@x.invalid' }, { chave: outraPriv })
  ok(r.status === 401, 'Apple: assinado por outra chave (mesmo kid) → 401')
  const antes = fetchChamadas
  r = await apple({ sub: 'a-ana', email: 'ana@x.invalid' }, { kid: 'kid-desconhecido' })
  ok(r.status === 401 && fetchChamadas === antes + 1, 'Apple: kid desconhecido → relê o JWKS e recusa', fetchChamadas - antes)
  r = await social({ provedor: 'apple', id_token: jwt.sign({ iss: cfg.APPLE_ISS, aud: cfg.APPLE_AUD, sub: 'a-ana' }, 'segredo-de-teste', { algorithm: 'HS256', keyid: KID }) })
  ok(r.status === 401, 'Apple: HS256 (alg confusion) → 401')
  r = await social({ provedor: 'apple', id_token: 'nao-e-jwt' })
  ok(r.status === 401, 'Apple: lixo → 401')
  // relay privado: NUNCA vincula por e-mail, mesmo havendo conta com esse e-mail exato
  await db.query(`INSERT INTO usuarios (nome, email, senha_hash, role, tipo_dono) VALUES ('Relay Antigo', 'abc123@privaterelay.appleid.com', $1, 'dono_obra', 'pintura')`, [hash])
  r = await apple({ sub: 'a-relay', email: 'abc123@privaterelay.appleid.com' })
  ok(r.status === 200 && r.body.novo === true && r.body.email === 'abc123@privaterelay.appleid.com' && r.body.ticket, 'Apple: e-mail de relay com conta existente → NÃO vincula: novo + ticket', { novo: r.body.novo })
  r = await apple({ sub: 'a-sememail' })
  ok(r.status === 400 && r.body.codigo === 'email_ausente', 'Apple: sem e-mail e sem conta por sub → 400 email_ausente', r.body)
  // cadastro por ticket da Apple com nome vindo do corpo (a Apple só manda nome no app)
  const tkApple = (await apple({ sub: 'a-novo', email: 'applenovo@x.invalid' }, {}, { nome: 'Nova Apple' })).body.ticket
  r = await cadastrar({ ticket: tkApple, nome: 'Nova Apple', tipo_conta: 'dono_obra', tipo_dono: 'pintura' })
  const novaApple = (await db.query(`SELECT apple_sub, google_sub FROM usuarios WHERE email = 'applenovo@x.invalid'`)).rows[0]
  ok(r.status === 201 && novaApple?.apple_sub === 'a-novo' && novaApple.google_sub === null, 'cadastro com ticket da Apple grava apple_sub', novaApple)
  r = await apple({ sub: 'a-novo' })
  ok(r.status === 200 && r.body.usuario?.email === 'applenovo@x.invalid', 'Apple: login seguinte (sem e-mail no token) entra por apple_sub')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
