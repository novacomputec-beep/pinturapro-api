#!/usr/bin/env node
// Testa POST /auth/contas/:tipo com o SQL REAL num Postgres em memória (PGlite). O handler é
// chamado direto (req.usuario já posto, como autenticar faria); pool do repo trocado por shim.
//   npm i -D @electric-sql/pglite && node scripts/testar-contas-tipo.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const jwt = require(path.join(REPO, 'node_modules/jsonwebtoken'))
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
  return origLoad.apply(this, arguments)
}
// A migração de boot (IIFE async em routes/index.js) rejeita sem banco; aqui isso é esperado.
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const silencio = () => {}
const logOrig = console.log, errOrig = console.error
console.log = silencio; console.error = silencio
const router = require(path.join(REPO, 'src/routes/index.js'))
console.log = logOrig; console.error = errOrig

const layer = router.stack.find(l => l.route && l.route.path === '/auth/contas/:tipo')
const handler = layer.route.stack[layer.route.stack.length - 1].handle
const chamar = (usuarioId, tipo, body = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params: { tipo }, body, usuario: { id: usuarioId, role: 'x' } }, res)
})

const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const main = async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text, email text, telefone text, senha_hash text, cidade text, uf text,
      especialidades text[], anos_experiencia int, tamanho_equipe int, cpf_cnpj text, role text, ativo boolean DEFAULT true,
      tipo_dono text, pix_reembolso text, referencias jsonb, verificacao_doc_frente_url text, verificacao_doc_verso_url text,
      verificacao_selfie_url text, verificacao_status text DEFAULT 'nao_solicitada', rg text, rg_orgao text, rg_estado text,
      tipo_prestador text, cep text, latitude numeric, longitude numeric, logradouro text, numero text, complemento text, bairro text,
      foto_url text, codigo_indicacao text, token_version int NOT NULL DEFAULT 1, boas_vindas_exibida boolean DEFAULT false, criado_em timestamptz DEFAULT now());
    CREATE TABLE assinaturas (usuario_id uuid, plano text, valor_mensal numeric, status text, tipo text, criado_em timestamptz DEFAULT now());
    CREATE TABLE configuracoes (chave text, valor text);
    INSERT INTO configuracoes VALUES ('multiplas_contas', 'true');
    CREATE FUNCTION gerar_codigo_indicacao() RETURNS text LANGUAGE sql AS $$ SELECT 'COD' || floor(random()*100000)::text $$;
  `)
  // Dono de reparo SEM documentos (origem 1) e pintor COM documentos pendentes (origem 2, outro e-mail/CPF)
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_dono, bairro, cep)
                  VALUES ($1, 'Ana Dona', 'ana@x.invalid', '34999990000', '$2b$10$hashdaana', 'Uberlândia', 'MG', '111.111.111-11', 'dono_obra', 'reparo', 'Centro', '38400000')`, [U(1)])
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_prestador, especialidades,
                  verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url, verificacao_status, rg, anos_experiencia, tamanho_equipe)
                  VALUES ($1, 'Beto Pintor', 'beto@x.invalid', '34988880000', '$2b$10$hashdobeto', 'Araguari', 'MG', '22222222222', 'prestador', 'pintor', '{pintor}',
                  'https://f', 'https://v', 'https://s', 'pendente', 'MG123', 7, 3)`, [U(2)])

  // 1) tipo inválido
  let r = await chamar(U(1), 'gerente')
  ok(r.status === 400 && r.body.codigo === 'tipo_invalido', 'tipo desconhecido → 400 tipo_invalido', r.body)
  // 2) mesmo tipo da origem
  r = await chamar(U(1), 'dono_reparo')
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'dono_reparo → dono_reparo: 409 tipo_duplicado', r.body)
  // 3) dono → reparador sem especialidades
  r = await chamar(U(1), 'reparador', {})
  ok(r.status === 400 && /especialidade/i.test(r.body.erro), 'dono → reparador sem especialidades: 400', r.body)
  // 4) dono → reparador com especialidade de pintor (lista errada)
  r = await chamar(U(1), 'reparador', { especialidades: ['pintor'] })
  ok(r.status === 400 && /inválida/.test(r.body.erro), 'reparador com slug de obra: 400', r.body)
  // 5) dono → reparador OK
  r = await chamar(U(1), 'reparador', { especialidades: ['eletrica', 'vidraceiro'] })
  ok(r.status === 201 && r.body.conta.tipo === 'reparador' && r.body.aprovada === false, 'dono_reparo → reparador: 201, não aprovada (sem docs)', r.body.conta)
  const novo = (await db.query(`SELECT * FROM usuarios WHERE id = $1`, [r.body.conta.id])).rows[0]
  ok(novo.nome === 'Ana Dona' && novo.email === 'ana@x.invalid' && novo.telefone === '34999990000' && novo.cpf_cnpj === '111.111.111-11'
     && novo.senha_hash === '$2b$10$hashdaana' && novo.cidade === 'Uberlândia' && novo.uf === 'MG' && novo.bairro === 'Centro' && novo.cep === '38400000',
     'copiou nome, e-mail, telefone, CPF, senha_hash, cidade/UF e endereço', { nome: novo.nome, cpf: novo.cpf_cnpj, bairro: novo.bairro })
  ok(novo.role === 'prestador' && novo.tipo_prestador === 'reparador' && novo.tipo_dono === null && JSON.stringify(novo.especialidades) === '["eletrica","vidraceiro"]'
     && novo.verificacao_status === 'nao_solicitada' && !!novo.codigo_indicacao, 'role/tipo_prestador/especialidades/verificação/código de indicação', { role: novo.role, tp: novo.tipo_prestador, vs: novo.verificacao_status })
  const ass = (await db.query(`SELECT * FROM assinaturas WHERE usuario_id = $1`, [novo.id])).rows[0]
  ok(ass && ass.status === 'pendente' && Number(ass.valor_mensal) === 49.9 && ass.plano === 'mensal', 'assinatura do reparador: pendente, 49,90 mensal (sem janela de lançamento)', ass)
  const dec = jwt.verify(r.body.token, process.env.JWT_SECRET)
  ok(dec.id === novo.id && dec.role === 'prestador' && dec.tv === 1, 'token é da conta NOVA (id, role, tv)', dec)
  ok(r.body.usuario.id === novo.id && r.body.usuario.role === 'prestador' && r.body.usuario.tipo_prestador === 'reparador' && r.body.usuario.email === 'ana@x.invalid', 'usuario no formato do login', r.body.usuario)
  // 6) repetir → tipo duplicado (via contas do e-mail)
  r = await chamar(U(1), 'reparador', { especialidades: ['eletrica'] })
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'segundo reparador para o mesmo e-mail: 409', r.body)
  // 7) dono → dono_obra: nada no corpo, assinatura gratuita ativa
  r = await chamar(U(1), 'dono_obra')
  ok(r.status === 201 && r.body.conta.tipo === 'dono_obra', 'dono_reparo → dono_obra: 201 sem corpo', r.body.conta)
  const assDono = (await db.query(`SELECT * FROM assinaturas WHERE usuario_id = $1`, [r.body.conta.id])).rows[0]
  const dono = (await db.query(`SELECT role, tipo_dono, tipo_prestador, especialidades, verificacao_status FROM usuarios WHERE id = $1`, [r.body.conta.id])).rows[0]
  ok(assDono.status === 'ativa' && assDono.tipo === 'gratuito' && Number(assDono.valor_mensal) === 0, 'dono novo: assinatura gratuita ativa', assDono)
  ok(dono.role === 'dono_obra' && dono.tipo_dono === 'pintura' && dono.tipo_prestador === null && dono.verificacao_status === 'nao_solicitada', 'dono_obra: role/tipo_dono', dono)
  // 8) a partir da conta NOVA (reparador), criar pintor com plano anual → 4ª conta
  r = await chamar(novo.id, 'pintor', { especialidades: ['pintor', 'construtor'], plano: 'anual' })
  ok(r.status === 201 && r.body.conta.tipo === 'pintor', 'reparador → pintor (4ª conta): 201', r.body.conta)
  const assPintor = (await db.query(`SELECT * FROM assinaturas WHERE usuario_id = $1`, [r.body.conta.id])).rows[0]
  ok(assPintor.plano === 'anual' && Number(assPintor.valor_mensal) === 999, 'pintor anual: 999', assPintor)
  // 9) 5º tipo não existe; mas teto: todas as 4 ocupadas → próximo pedido cai em tipo_duplicado antes do limite
  r = await chamar(novo.id, 'dono_reparo')
  ok(r.status === 409, 'todos os 4 tipos ocupados: 409', r.body.codigo)
  const total = (await db.query(`SELECT count(*)::int n FROM usuarios WHERE email = 'ana@x.invalid'`)).rows[0].n
  ok(total === 4, 'e-mail da Ana com exatamente 4 contas', total)
  // 10) pintor COM documentos pendentes → reparador nasce 'pendente' com os docs copiados, não aprovado
  r = await chamar(U(2), 'prestador', { especialidades: ['hidraulica'] }) // nome do cadastro ('prestador' = reparador)
  ok(r.status === 201 && r.body.conta.tipo === 'reparador' && r.body.aprovada === false, "pintor pendente → 'prestador' (alias de reparador): 201, não aprovada", r.body.conta)
  const rep2 = (await db.query(`SELECT verificacao_status, verificacao_doc_frente_url, rg, anos_experiencia, tamanho_equipe, cidade FROM usuarios WHERE id = $1`, [r.body.conta.id])).rows[0]
  ok(rep2.verificacao_status === 'pendente' && rep2.verificacao_doc_frente_url === 'https://f' && rep2.rg === 'MG123' && rep2.anos_experiencia === 7 && rep2.tamanho_equipe === 3, 'docs, RG, experiência e equipe copiados; status pendente', rep2)
  // 11) CPF do Beto em OUTRO e-mail já existente → cpf_duplicado
  await db.query(`INSERT INTO usuarios (nome, email, senha_hash, cpf_cnpj, role, tipo_dono) VALUES ('Clone', 'clone@x.invalid', 'h', '22222222222', 'dono_obra', 'reparo')`)
  r = await chamar(U(2), 'dono_obra')
  ok(r.status === 409 && r.body.codigo === 'cpf_duplicado', 'CPF em outro e-mail: 409 cpf_duplicado', r.body)
  // 12) chave desligada
  await db.query(`UPDATE configuracoes SET valor = 'false' WHERE chave = 'multiplas_contas'`)
  r = await chamar(U(1), 'pintor', { especialidades: ['pintor'] })
  ok(r.status === 403 && r.body.codigo === 'multiplas_contas_desligada', 'chave desligada: 403', r.body)

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
