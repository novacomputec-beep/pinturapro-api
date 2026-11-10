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
      foto_url text, codigo_indicacao text, indicado_por uuid, token_version int NOT NULL DEFAULT 1, boas_vindas_exibida boolean DEFAULT false,
      aceita_promocoes boolean, aprovado_automaticamente boolean, criado_em timestamptz DEFAULT now());
    ALTER TABLE usuarios ADD COLUMN avisos_todas_areas boolean NOT NULL DEFAULT true; -- preferência do aviso "fora da sua área" (migração de boot)
    CREATE TABLE assinaturas (usuario_id uuid, plano text, valor_mensal numeric, status text, tipo text, proximo_vencimento timestamptz, criado_em timestamptz DEFAULT now());
    CREATE TABLE avaliacoes (avaliado_id uuid, estrelas int);
    CREATE TABLE configuracoes (chave text, valor text);
    CREATE TABLE candidaturas (obra_id uuid, usuario_id uuid); CREATE TABLE interesse_reparos (reparo_id uuid, usuario_id uuid); -- montarSessao lê tem_candidaturas / tem_interesses (Fases 2a e 2b)
    INSERT INTO configuracoes VALUES ('multiplas_contas', 'true');
    CREATE FUNCTION gerar_codigo_indicacao() RETURNS text LANGUAGE sql AS $$ SELECT 'COD' || floor(random()*100000)::text $$;
  `)
  await db.exec(`CREATE TABLE IF NOT EXISTS obras (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, status_aprovacao text, expira_em timestamptz, match_usuario_id uuid)`)
  // obras.especialidades_inferidas (capacidadesDaPessoa / feed / aviso de obra nova leem a coluna) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/especialidadesInferidas')).migrarEspecialidadesInferidas(db)
  // Ana: dona de reparo SEM documentos. Beto: pintor com docs PENDENTES e assinatura ativa anual.
  // Dalva: pintora APROVADA com docs e assinatura ativa mensal vencendo em 2026-12-01.
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_dono, bairro, cep, criado_em)
                  VALUES ($1, 'Ana Dona', 'ana@x.invalid', '34999990000', '$2b$10$hashdaana', 'Uberlândia', 'MG', '111.111.111-11', 'dono_obra', 'reparo', 'Centro', '38400000', '2026-01-01')`, [U(1)])
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_prestador, especialidades,
                  verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url, verificacao_status, rg, anos_experiencia, tamanho_equipe, codigo_indicacao)
                  VALUES ($1, 'Beto Pintor', 'beto@x.invalid', '34988880000', '$2b$10$hashdobeto', 'Araguari', 'MG', '22222222222', 'prestador', 'pintor', '{pintor}',
                  'https://f', 'https://v', 'https://s', 'pendente', 'MG123', 7, 3, 'BET777')`, [U(2)])
  await db.query(`INSERT INTO assinaturas VALUES ($1, 'anual', 999, 'ativa', NULL, '2027-06-30T00:00:00Z')`, [U(2)])
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_prestador, especialidades,
                  verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url, verificacao_status, codigo_indicacao)
                  VALUES ($1, 'Dalva Pintora', 'dalva@x.invalid', '34977770000', '$2b$10$hashdadalva', 'Uberaba', 'MG', '33333333333', 'prestador', 'pintor', '{pintor}',
                  'https://f', 'https://v', 'https://s', 'aprovado', 'DAV777')`, [U(3)])
  await db.query(`INSERT INTO assinaturas VALUES ($1, 'mensal', 99.90, 'ativa', NULL, '2026-12-01T00:00:00Z')`, [U(3)])
  // Edu: dono de reparo com endereço parcial (cep/bairro) — o app manda os campos do cadastro profissional.
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, senha_hash, cidade, uf, cpf_cnpj, role, tipo_dono, bairro, cep)
                  VALUES ($1, 'Edu Dono', 'edu@x.invalid', '34966660000', '$2b$10$hashdoedu', 'Uberlândia', 'MG', '44444444444', 'dono_obra', 'reparo', 'Centro', '38400000')`, [U(4)])

  // ---- POST /auth/contas/:tipo
  let r = await criar(U(1), 'gerente')
  ok(r.status === 400 && r.body.codigo === 'tipo_invalido', 'tipo desconhecido → 400 tipo_invalido', r.body)
  r = await criar(U(1), 'dono_reparo')
  ok(r.status === 409 && r.body.codigo === 'tipo_duplicado', 'dono_reparo → dono_reparo: 409 tipo_duplicado', r.body)
  r = await criar(U(1), 'reparador', {})
  ok(r.status === 400 && /especialidade/i.test(r.body.erro), 'dono → reparador sem especialidades: 400', r.body)
  // Fase 2a: slug de ESPECIALIDADE de obra (pintor, pedreiro_servente…) passou a valer para o reparador;
  // o que segue inválido é o que não é especialidade nenhuma — ex.: categoria de obra.
  r = await criar(U(1), 'reparador', { especialidades: ['residencial'] })
  ok(r.status === 400 && /inválida/.test(r.body.erro), 'reparador com slug que não é especialidade (categoria de obra): 400', r.body)

  r = await criar(U(1), 'reparador', { especialidades: ['eletrica', 'pedreiro_servente'] })
  ok(r.status === 201 && r.body.usuario.pode_obras === true && r.body.usuario.tem_candidaturas === false && r.body.usuario.tipo_prestador === 'reparador',
     'reparador vinculado COM especialidade de obra: sessão traz pode_obras true (tipo_prestador segue reparador)', r.body.usuario && { pode_obras: r.body.usuario.pode_obras })
  ok(r.status === 201 && r.body.conta.tipo === 'reparador' && r.body.aprovada === false && r.body.assinatura_herdada === false, 'dono_reparo → reparador: 201, sem docs, 1º perfil profissional (nada a herdar)', { conta: r.body.conta, herdada: r.body.assinatura_herdada })
  const repAna = (await db.query(`SELECT * FROM usuarios WHERE id = $1`, [r.body.conta.id])).rows[0]
  ok(repAna.nome === 'Ana Dona' && repAna.email === 'ana@x.invalid' && repAna.telefone === '34999990000' && repAna.cpf_cnpj === '111.111.111-11'
     && repAna.senha_hash === '$2b$10$hashdaana' && repAna.cidade === 'Uberlândia' && repAna.uf === 'MG' && repAna.bairro === 'Centro' && repAna.cep === '38400000',
     'copiou nome, e-mail, telefone, CPF, senha_hash, cidade/UF e endereço')
  ok(repAna.role === 'prestador' && repAna.tipo_prestador === 'reparador' && repAna.tipo_dono === null && JSON.stringify(repAna.especialidades) === '["eletrica","pedreiro_servente"]'
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
  // Corpo com campos do cadastro: tamanho_equipe enviado vence a cópia; rg '' e anos_experiencia
  // ausente caem na origem; o PRÓPRIO código de indicação é ignorado (indicado_por NULL).
  r = await criar(U(2), 'prestador', { especialidades: ['hidraulica'], tamanho_equipe: 5, rg: '', codigo_indicacao: 'bet777' })
  ok(r.status === 201 && r.body.conta.tipo === 'reparador' && r.body.aprovada === false && r.body.assinatura_herdada === true, "pintor pendente → 'prestador': 201, não aprovada, assinatura herdada", { conta: r.body.conta.tipo })
  const repBeto = (await db.query(`SELECT verificacao_status, verificacao_doc_frente_url, rg, anos_experiencia, tamanho_equipe, indicado_por FROM usuarios WHERE id = $1`, [r.body.conta.id])).rows[0]
  ok(repBeto.verificacao_status === 'pendente' && repBeto.verificacao_doc_frente_url === 'https://f' && repBeto.rg === 'MG123' && repBeto.anos_experiencia === 7, 'docs, RG (corpo \'\' → cópia), experiência (ausente → cópia) copiados; status pendente', repBeto)
  ok(repBeto.tamanho_equipe === 5 && repBeto.indicado_por === null, 'tamanho_equipe do corpo vence a cópia (3 → 5); código de indicação PRÓPRIO ignorado', { equipe: repBeto.tamanho_equipe, indicado_por: repBeto.indicado_por })
  ass = (await db.query(`SELECT * FROM assinaturas WHERE usuario_id = $1`, [r.body.conta.id])).rows[0]
  ok(ass.status === 'ativa' && ass.plano === 'anual' && Number(ass.valor_mensal) === 999 && new Date(ass.proximo_vencimento).toISOString() === '2027-06-30T00:00:00.000Z', 'herdou ativa/anual/999 com o MESMO vencimento', { status: ass.status, venc: ass.proximo_vencimento })
  ok(r.body.assinatura?.status === 'ativa', 'payload.assinatura já reflete a herdada (app não cai no paywall)', r.body.assinatura)

  // Dalva (pintora APROVADA) → reparador: aprovada na hora SEM aprovarPrestador (vencimento herdado intocado)
  r = await criar(U(3), 'reparador', { especialidades: ['faxina'], codigo_indicacao: 'nope' })
  ok(r.status === 201 && r.body.aprovada === true && r.body.assinatura_herdada === true && r.body.usuario.verificacao_status === 'aprovado', 'pintora aprovada → reparador: aprovada, herdada', { aprovada: r.body.aprovada, vs: r.body.usuario.verificacao_status })
  const repDalva = (await db.query(`SELECT u.verificacao_status, u.indicado_por, a.status, a.proximo_vencimento FROM usuarios u JOIN assinaturas a ON a.usuario_id = u.id WHERE u.id = $1`, [r.body.conta.id])).rows[0]
  ok(repDalva.verificacao_status === 'aprovado' && repDalva.status === 'ativa' && new Date(repDalva.proximo_vencimento).toISOString() === '2026-12-01T00:00:00.000Z', 'verificação aprovada no banco; vencimento 2026-12-01 NÃO estendido (aprovarPrestador não rodou)', repDalva)
  ok(repDalva.indicado_por === null, "código de indicação malformado ('nope') ignorado em silêncio: 201 e indicado_por NULL")

  // Edu (dono, endereço parcial) → reparador com TODOS os campos do cadastro profissional no corpo:
  // gravados como o cadastro grava, com precedência sobre a cópia (cep/bairro da origem substituídos);
  // código da Dalva (outra pessoa) → indicado_por = Dalva.
  r = await criar(U(4), 'reparador', { especialidades: ['eletrica'], anos_experiencia: 12, tamanho_equipe: 4, cep: '38401-000', latitude: -18.91, longitude: -48.27,
                                       logradouro: 'Rua das Acácias', numero: '10', complemento: 'casa 2', bairro: 'Santa Mônica', rg: 'MG999', rg_orgao: 'SSP', rg_estado: 'MG', codigo_indicacao: ' dav777 ' })
  ok(r.status === 201 && r.body.conta.tipo === 'reparador', 'dono → reparador com campos do cadastro profissional: 201', r.body.conta || r.body)
  const repEdu = (await db.query(`SELECT anos_experiencia, tamanho_equipe, cep, latitude, longitude, logradouro, numero, complemento, bairro, rg, rg_orgao, rg_estado, indicado_por, codigo_indicacao, nome, cidade, telefone FROM usuarios WHERE id = $1`, [r.body.conta.id])).rows[0]
  ok(repEdu.anos_experiencia === 12 && repEdu.tamanho_equipe === 4 && repEdu.cep === '38401-000' && Number(repEdu.latitude) === -18.91 && Number(repEdu.longitude) === -48.27
     && repEdu.logradouro === 'Rua das Acácias' && repEdu.numero === '10' && repEdu.complemento === 'casa 2' && repEdu.bairro === 'Santa Mônica',
     'experiência, equipe, cep, coordenadas e endereço do corpo gravados (cep/bairro do corpo VENCEM a cópia 38400000/Centro)', repEdu)
  ok(repEdu.rg === 'MG999' && repEdu.rg_orgao === 'SSP' && repEdu.rg_estado === 'MG', 'RG/órgão/UF do corpo gravados (origem não tinha RG)', { rg: repEdu.rg, orgao: repEdu.rg_orgao, uf: repEdu.rg_estado })
  ok(repEdu.indicado_por === U(3) && !!repEdu.codigo_indicacao && repEdu.codigo_indicacao !== 'DAV777', "' dav777 ' normalizado → indicado_por = Dalva; conta nova ganha código PRÓPRIO", { indicado_por: repEdu.indicado_por, codigo: repEdu.codigo_indicacao })
  ok(repEdu.nome === 'Edu Dono' && repEdu.cidade === 'Uberlândia' && repEdu.telefone === '34966660000', 'nome/cidade/telefone continuam copiados da origem')
  // Dono novo: campos de perfil aceitos igual, mas código de indicação só vale para profissional.
  r = await criar(U(4), 'dono_obra', { codigo_indicacao: 'DAV777', anos_experiencia: 3 })
  const donoEdu = r.status === 201 ? (await db.query(`SELECT indicado_por, anos_experiencia, cep FROM usuarios WHERE id = $1`, [r.body.conta.id])).rows[0] : null
  ok(r.status === 201 && donoEdu.indicado_por === null && donoEdu.anos_experiencia === 3 && donoEdu.cep === '38400000', 'dono_obra vinculado: código de indicação ignorado (não é profissional); experiência do corpo gravada; cep copiado', donoEdu || r.body)

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
