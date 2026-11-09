#!/usr/bin/env node
// Testa o tipo de conta resolvido do corpo inteiro (utils/tipoConta.tipoDoCadastro) em
// POST /auth/verificar-disponibilidade, POST /auth/cadastro e POST /auth/contas/:tipo, com o SQL
// REAL num Postgres em memória (PGlite) e os MESMOS índices únicos de produção ((email, tipo) e
// (cpf, tipo)). Forma do caso real: a pessoa já tem prestador (reparador) e dono_obra (pintura)
// com o mesmo e-mail e CPF; o app de dono de SERVIÇO manda tipo_conta 'dono_obra' + tipo_dono
// 'reparo' — antes virava 'dono_obra' e caía em cpf_duplicado / tipo_duplicado.
//   npm i -D @electric-sql/pglite && node scripts/testar-cadastro-dono-servico.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const bcrypt = require(path.join(REPO, 'node_modules/bcrypt'))
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

let db = null
const client = () => ({ query: (sql, params) => db.query(sql, params), release() {} })
const shim = {
  query: (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return db.query(sql, params) },
  connect: async () => { if (!db) throw new Error('sem banco (boot)'); return client() },
  on() {},
}
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/utils[\\/]plataforma$/.test(request)) return { ...origLoad.apply(this, arguments), registrarPlataforma() {}, detectarPlataforma() { return false } }
  if (/utils[\\/]desinstalacoes$/.test(request)) return { ...origLoad.apply(this, arguments), registrarReinstalacao() {} }
  if (/services[\\/]alertaService$/.test(request)) return { enviarBoasVindas: async () => {} }
  if (/services[\\/]conviteCanalService$/.test(request)) return { enviarConviteCanal: async () => 'pulado' }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const silencio = () => {}
const logOrig = console.log, errOrig = console.error
console.log = silencio; console.error = silencio
const router = require(path.join(REPO, 'src/routes/index.js'))
const authCtrl = require(path.join(REPO, 'src/controllers/authController'))
const { sqlTipoConta, tipoDoCadastro } = require(path.join(REPO, 'src/utils/tipoConta'))
console.log = logOrig; console.error = errOrig

const handlerDe = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const hVerif = handlerDe('post', '/auth/verificar-disponibilidade')
const hContas = handlerDe('post', '/auth/contas/:tipo')
const chamar = (handler, { params = {}, body = {}, usuario } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, body, usuario, ip: '127.0.0.1', get() { return '' } }, res)
})
const verificar = (body) => chamar(hVerif, { body })
const cadastrar = (body) => chamar(authCtrl.cadastrar, { body })
const usuarioReq = async (id) => (await db.query(`SELECT id, nome, email, role, ativo, tipo_prestador FROM usuarios WHERE id = $1`, [id])).rows[0]
const vincular = async (id, tipo, body) => chamar(hContas, { params: { tipo }, body, usuario: await usuarioReq(id) })
const tipos = async (email) => (await db.query(`SELECT ${sqlTipoConta()} AS tipo FROM usuarios WHERE email = $1 ORDER BY criado_em, id`, [email])).rows.map(r => r.tipo)

const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const SENHA = 'Senha12345'
const EMAIL = 'lu@x.invalid'
const CPF = '123.456.789-09'

const main = async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text, email text, telefone text, senha_hash text, cidade text, uf text,
      especialidades text[], anos_experiencia int, tamanho_equipe int, cpf_cnpj text, role text, ativo boolean DEFAULT true,
      tipo_dono text, pix_reembolso text, referencias jsonb, verificacao_doc_frente_url text, verificacao_doc_verso_url text,
      verificacao_selfie_url text, verificacao_status text DEFAULT 'nao_solicitada', rg text, rg_orgao text, rg_estado text,
      tipo_prestador text, cep text, latitude numeric, longitude numeric, logradouro text, numero text, complemento text, bairro text,
      foto_url text, codigo_indicacao text, indicado_por uuid, token_version int NOT NULL DEFAULT 1, boas_vindas_exibida boolean DEFAULT false,
      aceita_promocoes boolean, aprovado_automaticamente boolean, google_sub text, apple_sub text, criado_em timestamptz DEFAULT now());
    CREATE UNIQUE INDEX usuarios_cpf_cnpj_tipo_unico_idx ON usuarios ((regexp_replace(cpf_cnpj, '[^0-9]', '', 'g')), ${sqlTipoConta()}) WHERE cpf_cnpj IS NOT NULL AND cpf_cnpj <> '';
    CREATE UNIQUE INDEX usuarios_email_tipo_unico_idx ON usuarios (email, ${sqlTipoConta()});
    CREATE TABLE assinaturas (usuario_id uuid, plano text, valor_mensal numeric, status text, tipo text, proximo_vencimento timestamptz, criado_em timestamptz DEFAULT now());
    CREATE TABLE configuracoes (chave text, valor text);
    CREATE TABLE candidaturas (obra_id uuid, usuario_id uuid); CREATE TABLE interesse_reparos (reparo_id uuid, usuario_id uuid); -- montarSessao lê tem_candidaturas / tem_interesses (Fases 2a e 2b)
    CREATE TABLE tentativas_auth (acao text, identificador text, tentativas int DEFAULT 0, janela_em timestamptz DEFAULT now(), PRIMARY KEY (acao, identificador));
    INSERT INTO configuracoes VALUES ('multiplas_contas', 'true');
    CREATE FUNCTION gerar_codigo_indicacao() RETURNS text LANGUAGE sql AS $$ SELECT 'COD' || floor(random()*100000)::text $$;
  `)
  const hash = bcrypt.hashSync(SENHA, 4)
  // Forma do caso real: reparador às 13:46 e dona de pintura às 16:52 (SP, no dia anterior ao
  // teste, para a conta nova ficar por último na ordem de criação), mesmo e-mail e CPF.
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_prestador, especialidades, criado_em)
                  VALUES ($1, 'Lu Borges', $2, '34999990000', $3, 'Uberlândia', 'MG', $4, 'prestador', 'reparador', '{eletrica}', '2026-11-04T16:46:00Z')`, [U(1), EMAIL, hash, CPF])
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_dono, criado_em)
                  VALUES ($1, 'Lu Borges', $2, '34999990000', $3, 'Uberlândia', 'MG', $4, 'dono_obra', 'pintura', '2026-11-04T19:52:00Z')`, [U(2), EMAIL, hash, CPF])
  // Outra pessoa com outro CPF, e uma terceira com e-mail diferente
  await db.query(`INSERT INTO usuarios (id, nome, email, senha_hash, cpf_cnpj, role, tipo_dono) VALUES ($1, 'Outra', 'outra@x.invalid', $2, '987.654.321-00', 'dono_obra', 'reparo')`, [U(3), hash])

  // ---- resolução do tipo
  ok(tipoDoCadastro({ tipo_conta: 'dono_obra', tipo_dono: 'reparo' }) === 'dono_reparo', "tipo_conta dono_obra + tipo_dono reparo → dono_reparo")
  ok(tipoDoCadastro({ tipo_conta: 'dono_obra', tipo_dono: 'servico' }) === 'dono_reparo', "tipo_dono 'servico' (carga do lado serviço) → dono_reparo")
  ok(tipoDoCadastro({ tipo_conta: 'dono_obra' }) === 'dono_obra' && tipoDoCadastro({ tipo_conta: 'dono_obra', tipo_dono: 'pintura' }) === 'dono_obra', 'dono_obra sem tipo_dono / com pintura → dono_obra')
  ok(tipoDoCadastro({ tipo_conta: 'dono_reparo' }) === 'dono_reparo' && tipoDoCadastro({ tipo_conta: 'dono_reparo', tipo_dono: 'pintura' }) === 'dono_obra', 'dono_reparo → dono_reparo; tipo_dono pintura manda → dono_obra')
  ok(tipoDoCadastro({ role: 'dono_obra', tipo_dono: 'reparo' }) === 'dono_reparo' && tipoDoCadastro({ role: 'prestador', tipo_prestador: 'reparador' }) === 'reparador', 'sem tipo_conta: role + tipo_dono/tipo_prestador')
  ok(tipoDoCadastro({ tipo_conta: 'pintor', tipo_prestador: 'reparador' }) === 'reparador' && tipoDoCadastro({ tipo_conta: 'prestador' }) === 'reparador' && tipoDoCadastro({ tipo_conta: 'construtor' }) === 'pintor', 'profissional: tipo_prestador manda; prestador=reparador; construtor=pintor')
  ok(tipoDoCadastro({}) === null && tipoDoCadastro({ tipo_conta: 'gerente', role: 'admin' }) === null, 'sem tipo reconhecido → null')

  // ---- POST /auth/verificar-disponibilidade (etapa só com CPF, como o formulário em etapas)
  let r = await verificar({ cpf_cnpj: CPF, tipo_conta: 'dono_obra', tipo_dono: 'reparo' })
  ok(r.status === 200 && r.body.disponivel === true && r.body.cpf_em_outro_tipo === true, 'CPF só: dono_obra + tipo_dono reparo → disponível (CPF em outros tipos)', r.body)
  r = await verificar({ cpf_cnpj: CPF, tipo_conta: 'dono_obra' })
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado' && /CPF/.test(r.body.erro), 'CPF só: dono_obra (pintura, já existe) → tipo_duplicado, NÃO cpf_duplicado', r.body)
  r = await verificar({ email: EMAIL, cpf_cnpj: CPF, tipo_conta: 'dono_obra', tipo_dono: 'reparo' })
  ok(r.status === 200 && r.body.disponivel === true && r.body.email_em_outro_tipo === true && r.body.cpf_em_outro_tipo === true, 'e-mail + CPF: dono de serviço → disponível', r.body)
  r = await verificar({ email: EMAIL, cpf_cnpj: CPF, tipo_conta: 'dono_obra', tipo_dono: 'pintura' })
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'e-mail + CPF: dono de pintura de novo → tipo_duplicado', r.body)
  r = await verificar({ email: 'nova@x.invalid', cpf_cnpj: CPF, tipo_conta: 'dono_obra', tipo_dono: 'reparo' })
  ok(r.status === 409 && r.body.codigo === 'cpf_duplicado', 'CPF da Lu com OUTRO e-mail → cpf_duplicado', r.body)
  r = await verificar({ email: EMAIL, cpf_cnpj: '987.654.321-00', tipo_conta: 'dono_obra', tipo_dono: 'reparo' })
  ok(r.status === 409 && r.body.codigo === 'email_duplicado', 'e-mail da Lu com CPF de outra pessoa → email_duplicado', r.body)
  r = await verificar({ cpf_cnpj: '987.654.321-00', tipo_conta: 'dono_obra', tipo_dono: 'reparo' })
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'CPF só, de outra pessoa no MESMO tipo (e-mail desconhecido) → tipo_duplicado; o cadastro dá a palavra final', r.body)
  r = await verificar({ cpf_cnpj: CPF, tipo_conta: 'pintor', tipo_prestador: 'reparador' })
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'CPF só: pintor + tipo_prestador reparador → reparador já existe → tipo_duplicado', r.body)
  r = await verificar({ cpf_cnpj: CPF, tipo_conta: 'pintor' })
  ok(r.status === 200 && r.body.disponivel === true, 'CPF só: pintor (não existe) → disponível', r.body)

  // ---- POST /auth/cadastro (o pedido das 16:57)
  const corpo = { nome: 'Lu Borges', email: EMAIL, telefone: '34999990000', senha: SENHA, cidade: 'Uberlândia', uf: 'MG', cpf_cnpj: CPF, tipo_conta: 'dono_obra', tipo_dono: 'reparo' }
  r = await cadastrar({ ...corpo, senha: 'errada12345' })
  ok(r.status === 401 && r.body.codigo === 'senha_conta_existente', 'senha diferente da conta existente → 401', r.body)
  r = await cadastrar(corpo)
  ok(r.status === 201 && r.body.usuario.role === 'dono_obra' && r.body.usuario.tipo_dono === 'reparo', 'cadastro dono de serviço (tipo_conta dono_obra + tipo_dono reparo) → 201 dono_reparo', { status: r.status, body: r.body.erro || { role: r.body.usuario?.role, tipo_dono: r.body.usuario?.tipo_dono } })
  ok(JSON.stringify(await tipos(EMAIL)) === JSON.stringify(['reparador', 'dono_obra', 'dono_reparo']), 'e-mail da Lu com 3 contas: reparador, dono_obra, dono_reparo', await tipos(EMAIL))
  const nova = (await db.query(`SELECT senha_hash, cpf_cnpj FROM usuarios WHERE email = $1 AND tipo_dono = 'reparo'`, [EMAIL])).rows[0]
  ok(nova.senha_hash === hash && nova.cpf_cnpj === CPF, 'conta nova reusa o hash da senha e grava o CPF')
  r = await cadastrar(corpo)
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'repetir o mesmo cadastro → tipo_duplicado', r.body)
  r = await cadastrar({ ...corpo, tipo_conta: 'dono_obra', tipo_dono: undefined })
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'dono de pintura de novo → tipo_duplicado', r.body)
  r = await cadastrar({ ...corpo, tipo_conta: 'pintor', tipo_dono: undefined, tipo_prestador: 'reparador', especialidades: ['eletrica'] })
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'pintor + tipo_prestador reparador → reparador já existe → tipo_duplicado', r.body)
  r = await cadastrar({ ...corpo, email: 'nova@x.invalid' })
  ok(r.status === 409 && r.body.codigo === 'cpf_duplicado', 'CPF da Lu com outro e-mail → cpf_duplicado', r.body)
  r = await cadastrar({ ...corpo, tipo_conta: undefined, tipo_dono: undefined, role: 'dono_obra' })
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'sem tipo_conta, role dono_obra → dono_obra já existe → tipo_duplicado', r.body)
  r = await cadastrar({ nome: 'Novo Dono', email: 'novo@x.invalid', telefone: '34911112222', senha: SENHA, cidade: 'Uberlândia', uf: 'MG', cpf_cnpj: '111.444.777-35', tipo_conta: 'dono_obra', tipo_dono: 'reparo' })
  ok(r.status === 201 && r.body.usuario.tipo_dono === 'reparo' && r.body.assinatura?.tipo === 'gratuito', 'pessoa nova, dono de serviço → 201 tipo_dono reparo, assinatura gratuita', { status: r.status, erro: r.body.erro })

  // ---- POST /auth/contas/:tipo (logado como reparador): /auth/contas/dono_obra + tipo_dono 'reparo'
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_prestador, especialidades)
                  VALUES ($1, 'Zé', 'ze@x.invalid', '34900000000', $2, 'Araguari', 'MG', '222.333.444-05', 'prestador', 'reparador', '{hidraulica}')`, [U(4), hash])
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_dono)
                  VALUES ($1, 'Zé', 'ze@x.invalid', '34900000000', $2, 'Araguari', 'MG', '222.333.444-05', 'dono_obra', 'pintura')`, [U(5), hash])
  r = await vincular(U(4), 'dono_obra', { tipo_dono: 'reparo' })
  ok(r.status === 201 && r.body.conta.tipo === 'dono_reparo', '/auth/contas/dono_obra + tipo_dono reparo → 201 dono_reparo', r.body.conta || r.body)
  ok(JSON.stringify(await tipos('ze@x.invalid')) === JSON.stringify(['reparador', 'dono_obra', 'dono_reparo']), 'Zé com 3 contas', await tipos('ze@x.invalid'))
  r = await vincular(U(4), 'dono_obra', { tipo_dono: 'reparo' })
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'de novo → tipo_duplicado', r.body)
  r = await vincular(U(4), 'dono_obra', {})
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', '/auth/contas/dono_obra sem tipo_dono → dono_obra já existe → tipo_duplicado', r.body)

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
