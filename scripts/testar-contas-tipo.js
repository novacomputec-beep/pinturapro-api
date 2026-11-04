#!/usr/bin/env node
// Testa POST /auth/contas/:tipo, POST /auth/trocar-conta e GET /auth/perfil (contas[]) com o SQL
// REAL num Postgres em memória (PGlite). Os handlers são chamados direto (req.usuario já posto,
// como autenticar faria); pool do repo trocado por shim; plataforma/desinstalações sem efeito.
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
  if (/utils[\\/]plataforma$/.test(request)) return { ...origLoad.apply(this, arguments), registrarPlataforma() {}, detectarPlataforma() { return false } }
  if (/utils[\\/]desinstalacoes$/.test(request)) return { ...origLoad.apply(this, arguments), registrarReinstalacao() {} }
  return origLoad.apply(this, arguments)
}
// A migração de boot (IIFE async em routes/index.js) rejeita sem banco; aqui isso é esperado.
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const silencio = () => {}
const logOrig = console.log, errOrig = console.error
console.log = silencio; console.error = silencio
const router = require(path.join(REPO, 'src/routes/index.js'))
console.log = logOrig; console.error = errOrig

const handlerDe = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const hContas = handlerDe('post', '/auth/contas/:tipo')
const hTrocar = handlerDe('post', '/auth/trocar-conta')
const hPerfil = handlerDe('get', '/auth/perfil')
const chamar = (handler, usuario, { params = {}, body = {} } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, body, usuario, get() { return '' } }, res)
})
const usuarioReq = async (id) => (await db.query(`SELECT id, nome, email, role, ativo, tipo_prestador FROM usuarios WHERE id = $1`, [id])).rows[0]
const criar = async (id, tipo, body) => chamar(hContas, await usuarioReq(id), { params: { tipo }, body })
const trocar = async (id, tipo) => chamar(hTrocar, await usuarioReq(id), { body: { tipo } })
const perfil = async (id) => chamar(hPerfil, await usuarioReq(id))

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
      foto_url text, codigo_indicacao text, token_version int NOT NULL DEFAULT 1, boas_vindas_exibida boolean DEFAULT false,
      aceita_promocoes boolean, aprovado_automaticamente boolean, criado_em timestamptz DEFAULT now());
    CREATE TABLE assinaturas (usuario_id uuid, plano text, valor_mensal numeric, status text, tipo text, proximo_vencimento timestamptz, criado_em timestamptz DEFAULT now());
    CREATE TABLE avaliacoes (avaliado_id uuid, estrelas int);
    CREATE TABLE configuracoes (chave text, valor text);
    INSERT INTO configuracoes VALUES ('multiplas_contas', 'true');
    CREATE FUNCTION gerar_codigo_indicacao() RETURNS text LANGUAGE sql AS $$ SELECT 'COD' || floor(random()*100000)::text $$;
  `)
  // Ana: dona de reparo SEM documentos. Beto: pintor com docs PENDENTES e assinatura ativa anual.
  // Dalva: pintora APROVADA com docs e assinatura ativa mensal vencendo em 2026-12-01.
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_dono, bairro, cep, criado_em)
                  VALUES ($1, 'Ana Dona', 'ana@x.invalid', '34999990000', '$2b$10$hashdaana', 'Uberlândia', 'MG', '111.111.111-11', 'dono_obra', 'reparo', 'Centro', '38400000', '2026-01-01')`, [U(1)])
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_prestador, especialidades,
                  verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url, verificacao_status, rg, anos_experiencia, tamanho_equipe)
                  VALUES ($1, 'Beto Pintor', 'beto@x.invalid', '34988880000', '$2b$10$hashdobeto', 'Araguari', 'MG', '22222222222', 'prestador', 'pintor', '{pintor}',
                  'https://f', 'https://v', 'https://s', 'pendente', 'MG123', 7, 3)`, [U(2)])
  await db.query(`INSERT INTO assinaturas VALUES ($1, 'anual', 999, 'ativa', NULL, '2027-06-30T00:00:00Z')`, [U(2)])
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_prestador, especialidades,
                  verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url, verificacao_status)
                  VALUES ($1, 'Dalva Pintora', 'dalva@x.invalid', '34977770000', '$2b$10$hashdadalva', 'Uberaba', 'MG', '33333333333', 'prestador', 'pintor', '{pintor}',
                  'https://f', 'https://v', 'https://s', 'aprovado')`, [U(3)])
  await db.query(`INSERT INTO assinaturas VALUES ($1, 'mensal', 99.90, 'ativa', NULL, '2026-12-01T00:00:00Z')`, [U(3)])

  // ---- POST /auth/contas/:tipo
  let r = await criar(U(1), 'gerente')
  ok(r.status === 400 && r.body.codigo === 'tipo_invalido', 'tipo desconhecido → 400 tipo_invalido', r.body)
  r = await criar(U(1), 'dono_reparo')
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'dono_reparo → dono_reparo: 409 tipo_duplicado', r.body)
  r = await criar(U(1), 'reparador', {})
  ok(r.status === 400 && /especialidade/i.test(r.body.erro), 'dono → reparador sem especialidades: 400', r.body)
  r = await criar(U(1), 'reparador', { especialidades: ['pintor'] })
  ok(r.status === 400 && /inválida/.test(r.body.erro), 'reparador com slug de obra: 400', r.body)

  r = await criar(U(1), 'reparador', { especialidades: ['eletrica', 'vidraceiro'] })
  ok(r.status === 201 && r.body.conta.tipo === 'reparador' && r.body.aprovada === false && r.body.assinatura_herdada === false, 'dono_reparo → reparador: 201, sem docs, 1º perfil profissional (nada a herdar)', { conta: r.body.conta, herdada: r.body.assinatura_herdada })
  const repAna = (await db.query(`SELECT * FROM usuarios WHERE id = $1`, [r.body.conta.id])).rows[0]
  ok(repAna.nome === 'Ana Dona' && repAna.email === 'ana@x.invalid' && repAna.telefone === '34999990000' && repAna.cpf_cnpj === '111.111.111-11'
     && repAna.senha_hash === '$2b$10$hashdaana' && repAna.cidade === 'Uberlândia' && repAna.uf === 'MG' && repAna.bairro === 'Centro' && repAna.cep === '38400000',
     'copiou nome, e-mail, telefone, CPF, senha_hash, cidade/UF e endereço')
  ok(repAna.role === 'prestador' && repAna.tipo_prestador === 'reparador' && repAna.tipo_dono === null && JSON.stringify(repAna.especialidades) === '["eletrica","vidraceiro"]'
     && repAna.verificacao_status === 'nao_solicitada' && !!repAna.codigo_indicacao, 'role/tipo_prestador/especialidades/verificação/código de indicação')
  let ass = (await db.query(`SELECT * FROM assinaturas WHERE usuario_id = $1`, [repAna.id])).rows[0]
  ok(ass && ass.status === 'pendente' && Number(ass.valor_mensal) === 49.9 && ass.plano === 'mensal', 'assinatura do 1º profissional: pendente 49,90 (como o cadastro)', { status: ass.status, valor: ass.valor_mensal })
  let dec = jwt.verify(r.body.token, process.env.JWT_SECRET)
  ok(dec.id === repAna.id && dec.role === 'prestador' && dec.tv === 1, 'token é da conta NOVA', dec)
  ok(r.body.usuario.id === repAna.id && r.body.usuario.tipo_prestador === 'reparador' && r.body.assinatura?.status === 'pendente'
     && Array.isArray(r.body.contas) && r.body.contas.length === 2 && 'tem_referencias' in r.body.usuario, 'payload = login (usuario com referências, assinatura, token, contas[2])', { contas: r.body.contas.map(c => c.tipo) })

  r = await criar(U(1), 'reparador', { especialidades: ['eletrica'] })
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'segundo reparador para o mesmo e-mail: 409', r.body)

  r = await criar(U(1), 'dono_obra')
  ok(r.status === 201 && r.body.conta.tipo === 'dono_obra' && r.body.assinatura_herdada === false, 'dono_reparo → dono_obra: 201 sem corpo', r.body.conta)
  const assDono = (await db.query(`SELECT * FROM assinaturas WHERE usuario_id = $1`, [r.body.conta.id])).rows[0]
  ok(assDono.status === 'ativa' && assDono.tipo === 'gratuito' && Number(assDono.valor_mensal) === 0, 'dono novo: assinatura gratuita ativa', { status: assDono.status, tipo: assDono.tipo })

  // Ana (via o reparador) → pintor: HERDA a assinatura do reparador (pendente 49,90), não cria 999 anual
  r = await criar(repAna.id, 'pintor', { especialidades: ['pintor', 'construtor'], plano: 'anual' })
  ok(r.status === 201 && r.body.conta.tipo === 'pintor' && r.body.assinatura_herdada === true, 'reparador → pintor (4ª conta): herda a assinatura do reparador', r.body.conta)
  ass = (await db.query(`SELECT * FROM assinaturas WHERE usuario_id = $1`, [r.body.conta.id])).rows
  ok(ass.length === 1 && ass[0].status === 'pendente' && ass[0].plano === 'mensal' && Number(ass[0].valor_mensal) === 49.9, 'pintor herdou pendente/mensal/49,90 — `plano: anual` do corpo ignorado, nenhuma cobrança nova', ass[0])
  r = await criar(repAna.id, 'dono_reparo')
  ok(r.status === 409, 'todos os 4 tipos ocupados: 409', r.body.codigo)
  ok((await db.query(`SELECT count(*)::int n FROM usuarios WHERE email = 'ana@x.invalid'`)).rows[0].n === 4, 'e-mail da Ana com exatamente 4 contas')

  // Beto (pintor pendente, assinatura ativa anual) → 'prestador' (alias): docs copiados, pendente, assinatura HERDADA ativa
  r = await criar(U(2), 'prestador', { especialidades: ['hidraulica'] })
  ok(r.status === 201 && r.body.conta.tipo === 'reparador' && r.body.aprovada === false && r.body.assinatura_herdada === true, "pintor pendente → 'prestador': 201, não aprovada, assinatura herdada", { conta: r.body.conta.tipo })
  const repBeto = (await db.query(`SELECT verificacao_status, verificacao_doc_frente_url, rg, anos_experiencia, tamanho_equipe FROM usuarios WHERE id = $1`, [r.body.conta.id])).rows[0]
  ok(repBeto.verificacao_status === 'pendente' && repBeto.verificacao_doc_frente_url === 'https://f' && repBeto.rg === 'MG123' && repBeto.anos_experiencia === 7, 'docs, RG, experiência copiados; status pendente')
  ass = (await db.query(`SELECT * FROM assinaturas WHERE usuario_id = $1`, [r.body.conta.id])).rows[0]
  ok(ass.status === 'ativa' && ass.plano === 'anual' && Number(ass.valor_mensal) === 999 && new Date(ass.proximo_vencimento).toISOString() === '2027-06-30T00:00:00.000Z', 'herdou ativa/anual/999 com o MESMO vencimento', { status: ass.status, venc: ass.proximo_vencimento })
  ok(r.body.assinatura?.status === 'ativa', 'payload.assinatura já reflete a herdada (app não cai no paywall)', r.body.assinatura)

  // Dalva (pintora APROVADA) → reparador: aprovada na hora SEM aprovarPrestador (vencimento herdado intocado)
  r = await criar(U(3), 'reparador', { especialidades: ['faxina'] })
  ok(r.status === 201 && r.body.aprovada === true && r.body.assinatura_herdada === true && r.body.usuario.verificacao_status === 'aprovado', 'pintora aprovada → reparador: aprovada, herdada', { aprovada: r.body.aprovada, vs: r.body.usuario.verificacao_status })
  const repDalva = (await db.query(`SELECT u.verificacao_status, a.status, a.proximo_vencimento FROM usuarios u JOIN assinaturas a ON a.usuario_id = u.id WHERE u.id = $1`, [r.body.conta.id])).rows[0]
  ok(repDalva.verificacao_status === 'aprovado' && repDalva.status === 'ativa' && new Date(repDalva.proximo_vencimento).toISOString() === '2026-12-01T00:00:00.000Z', 'verificação aprovada no banco; vencimento 2026-12-01 NÃO estendido (aprovarPrestador não rodou)', repDalva)

  // CPF em OUTRO e-mail → cpf_duplicado
  await db.query(`INSERT INTO usuarios (nome, email, senha_hash, cpf_cnpj, role, tipo_dono) VALUES ('Clone', 'clone@x.invalid', 'h', '22222222222', 'dono_obra', 'reparo')`)
  r = await criar(U(2), 'dono_obra')
  ok(r.status === 409 && r.body.codigo === 'cpf_duplicado', 'CPF em outro e-mail: 409 cpf_duplicado', r.body)

  // ---- POST /auth/trocar-conta
  r = await trocar(U(1), 'reparador')
  dec = jwt.verify(r.body.token, process.env.JWT_SECRET)
  ok(r.status === 200 && dec.id === repAna.id && r.body.usuario.id === repAna.id && r.body.usuario.role === 'prestador' && r.body.assinatura?.status === 'pendente' && r.body.contas.length === 4,
     'trocar-conta dono → reparador: token/usuario/assinatura da conta alvo + contas[4]', { id: r.body.usuario.id === repAna.id, contas: r.body.contas.map(c => c.tipo) })
  r = await trocar(U(1), 'construtor')
  ok(r.status === 200 && r.body.usuario.tipo_prestador === 'pintor', "trocar-conta aceita o nome do cadastro ('construtor' → pintor)", r.body.usuario.tipo_prestador)
  r = await trocar(U(1), 'dono_reparo')
  ok(r.status === 200 && r.body.usuario.id === U(1), 'trocar para o próprio tipo: renova a sessão atual', r.body.usuario.id)
  r = await trocar(U(1), 'gerente')
  ok(r.status === 400 && r.body.codigo === 'tipo_invalido', 'trocar-conta tipo inválido: 400', r.body)
  r = await trocar(U(3), 'dono_obra')
  ok(r.status === 404 && r.body.codigo === 'conta_tipo_inexistente' && r.body.contas.length === 2, 'Dalva → dono_obra (não existe): 404 com contas[2]', r.body.contas?.map(c => c.tipo))
  await db.query(`UPDATE usuarios SET ativo = false WHERE id = $1`, [repDalva && (await db.query(`SELECT id FROM usuarios WHERE email = 'dalva@x.invalid' AND tipo_prestador = 'reparador'`)).rows[0].id])
  r = await trocar(U(3), 'reparador')
  ok(r.status === 404, 'conta alvo DESATIVADA não entra: 404', r.body.codigo)
  r = await chamar(hTrocar, { id: U(9), email: 'adm@x.invalid', role: 'admin' }, { body: { tipo: 'pintor' } })
  ok(r.status === 403, 'admin: 403', r.body)

  // ---- GET /auth/perfil
  r = await perfil(U(1))
  ok(r.status === 200 && r.body.usuario.id === U(1) && r.body.contas.length === 4 && r.body.contas.every(c => c.id && c.tipo && c.nome)
     && JSON.stringify(r.body.contas.map(c => c.tipo)) === JSON.stringify(['dono_reparo', 'reparador', 'dono_obra', 'pintor']),
     'perfil da Ana: contas[] com os 4 tipos (id, tipo, nome), mais antiga primeiro', r.body.contas?.map(c => c.tipo))
  r = await perfil(repAna.id)
  ok(r.status === 200 && r.body.contas.length === 4 && r.body.usuario.avaliacoes && r.body.assinatura?.status === 'pendente', 'perfil do reparador (prestador): contas[4] + bloco de avaliações', { avaliacoes: r.body.usuario.avaliacoes })
  r = await perfil(U(3))
  ok(r.status === 200 && r.body.contas.length === 1 && r.body.contas[0].tipo === 'pintor', 'perfil da Dalva: só a conta ativa (reparador desativado fora)', r.body.contas)

  // chave desligada
  await db.query(`UPDATE configuracoes SET valor = 'false' WHERE chave = 'multiplas_contas'`)
  r = await criar(U(2), 'dono_reparo')
  ok(r.status === 403 && r.body.codigo === 'multiplas_contas_desligada', 'chave desligada: 403', r.body)

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
