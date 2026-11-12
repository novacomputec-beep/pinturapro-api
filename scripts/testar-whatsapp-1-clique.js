#!/usr/bin/env node
// Testa "WhatsApp em 1 clique": normalizador de telefone (utils/telefoneWhatsapp) e as rotas
// GET /admin/whatsapp-lista e POST /admin/whatsapp-envios (routes/index.js) com o SQL REAL em
// PGlite. Nada é enviado pelo servidor; o POST só registra.
//   npm i -D @electric-sql/pglite && node scripts/testar-whatsapp-1-clique.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

let db = null
const shim = {
  query: (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return db.query(sql, params) },
  connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: (sql, params) => db.query(sql, params), release() {} } },
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

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

// ── Normalizador ──
const { normalizarTelefoneWhatsapp: N, primeiroNome } = require(path.join(REPO, 'src/utils/telefoneWhatsapp.js'))
const casos = [
  // [entrada, telefone_wa, status, rótulo]
  ['(34) 3821-4567',     '553438214567',  'fixo',       'fixo 34 38xx'],
  ['34 3814-0000',       '553438140000',  'fixo',       'fixo 34 38xx sem máscara completa'],
  ['(34) 9988-7766',     '5534999887766', 'corrigido',  'celular de 8 dígitos: ganha o 9'],
  ['3488776655',         '5534988776655', 'corrigido',  'celular de 8 dígitos começando em 8'],
  ['(34) 99988-7766',    '5534999887766', 'ok',         'celular de 11 dígitos'],
  ['+55 34 99988-7766',  '5534999887766', 'ok',         'já com +55'],
  ['5534999887766',      '5534999887766', 'ok',         'já com 55 (13 dígitos)'],
  ['553499887766',       '5534999887766', 'corrigido',  'já com 55 mas celular de 8 dígitos'],
  ['553438214567',       '553438214567',  'fixo',       'já com 55, fixo'],
  ['55999887766',        '5555999887766', 'ok',         '11 dígitos começando em 55 = DDD 55 (RS), não país'],
  ['034 99988-7766',     '5534999887766', 'ok',         '0 de tronco'],
  ['99988-7766',         null,            'incompleto', 'curto demais: sem DDD'],
  ['9988-7766',          null,            'incompleto', 'curto demais: 8 dígitos'],
  ['123',                null,            'incompleto', 'curto demais: 3 dígitos'],
  ['',                   null,            'incompleto', 'vazio'],
  [null,                 null,            'incompleto', 'null'],
  ['(20) 99988-7766',    null,            'incompleto', 'DDD inexistente'],
  ['(34) 89988-7766',    null,            'incompleto', '11 dígitos sem o 9 na frente'],
  ['(34) 1988-7766',     null,            'incompleto', '8 dígitos começando em 1'],
  ['553499988776655',    null,            'incompleto', 'longo demais'],
]
for (const [e, wa, st, rot] of casos) {
  const r = N(e)
  ok(r.telefone_wa === wa && r.status_numero === st, `normalizador: ${rot}`, { entrada: e, ...r })
}
ok(primeiroNome('  JOÃO pedro silva ') === 'João' && primeiroNome('') === '' && primeiroNome(null) === '', 'primeiro_nome capitalizado')

// ── Rotas ──
const silencio = () => {}
const logOrig = console.log, errOrig = console.error
console.log = silencio; console.error = silencio
const router = require(path.join(REPO, 'src/routes/index.js'))
console.log = logOrig; console.error = errOrig

const rota = (metodo, caminho) => router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo]).route.stack
const chamar = (pilha, { query = {}, body = {}, usuario } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  const req = { params: {}, query, body, usuario, ip: '127.0.0.1', get() { return '' } }
  // pula autenticar (índice 0); roda o gate de admin e o handler
  const gate = pilha[1].handle, handler = pilha[pilha.length - 1].handle
  gate(req, res, () => handler(req, res))
})
const GET = rota('get', '/admin/whatsapp-lista')
const POST = rota('post', '/admin/whatsapp-envios')

const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const ADMIN = { id: U(99), role: 'admin' }

const main = async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, role text, telefone text, cidade text, uf text,
      especialidades text[], ativo boolean DEFAULT true);
    CREATE TABLE versoes_app_vistas (usuario_id uuid, plataforma text, versao text, primeiro_em timestamptz DEFAULT now(), ultimo_em timestamptz DEFAULT now());
    CREATE TABLE whatsapp_envios (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campanha text NOT NULL,
      usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, admin_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
      enviado_em timestamptz NOT NULL DEFAULT now());`)
  const ins = (n, nome, role, tel, cidade, uf, esp, ativo = true) => db.query(
    `INSERT INTO usuarios (id, nome, role, telefone, cidade, uf, especialidades, ativo) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::text[],$8::boolean)`,
    [U(n), nome, role, tel, cidade, uf, esp, ativo])
  await ins(1, 'ana PINTORA', 'prestador', '(34) 9988-7766', 'Patos de Minas', 'MG', ['pintura'])
  await ins(2, 'Bruno', 'pintor', '34999887755', 'patos  de minas', 'mg', ['pintura', 'eletrica'])
  await ins(3, 'Carla', 'prestador', '(34) 3821-4567', 'Uberlândia', 'MG', ['eletrica'], false)
  await ins(4, 'Davi dono', 'dono_obra', '123', 'Patos de Minas', 'MG', null)
  await ins(99, 'Admin', 'admin', '34999990000', 'Patos de Minas', 'MG', null)
  await db.query(`INSERT INTO versoes_app_vistas (usuario_id, plataforma, versao, ultimo_em) VALUES
    ($1::uuid,'android','1.0','2026-11-01'), ($1::uuid,'android','1.1','2026-11-10')`, [U(1)])

  let r = await chamar(GET, { usuario: ADMIN })
  ok(r.status === 200 && r.body.total === 4 && r.body.itens.every(i => i.id !== U(99)), 'sem filtros: 4 contas, admin fora', r.body.itens?.map(i => i.nome))
  const ana = r.body.itens.find(i => i.id === U(1))
  ok(ana && Object.keys(ana).join(',') === 'id,nome,primeiro_nome,role,telefone_original,telefone_wa,status_numero,ultimo_uso_app,enviado_em', 'campos exatos do item', Object.keys(ana || {}))
  ok(ana.primeiro_nome === 'Ana' && ana.telefone_original === '(34) 9988-7766' && ana.telefone_wa === '5534999887766' && ana.status_numero === 'corrigido', 'item normalizado', ana)
  ok(new Date(ana.ultimo_uso_app).toISOString().startsWith('2026-11-10') && ana.enviado_em === null, 'ultimo_uso_app = último ultimo_em; enviado_em null sem campanha', ana)
  ok(r.body.itens.find(i => i.id === U(4)).telefone_wa === null && r.body.itens.find(i => i.id === U(4)).status_numero === 'incompleto', 'telefone curto: telefone_wa null, incompleto')

  r = await chamar(GET, { usuario: ADMIN, query: { role: 'prestador' } })
  ok(r.body.total === 3 && r.body.itens.some(i => i.role === 'pintor'), 'role=prestador inclui o papel legado pintor', r.body.itens.map(i => i.role))
  r = await chamar(GET, { usuario: ADMIN, query: { role: 'dono_obra' } })
  ok(r.body.total === 1 && r.body.itens[0].id === U(4), 'role=dono_obra')
  r = await chamar(GET, { usuario: ADMIN, query: { role: 'admin' } })
  ok(r.status === 400, 'role inválido: 400', r.body)
  r = await chamar(GET, { usuario: ADMIN, query: { especialidade: 'eletrica' } })
  ok(r.body.total === 2, 'especialidade=eletrica', r.body.itens.map(i => i.nome))
  r = await chamar(GET, { usuario: ADMIN, query: { cidade: 'PATOS DE MINAS', role: 'prestador' } })
  ok(r.body.total === 2, 'cidade dobrada (caixa/espaços)', r.body.itens.map(i => i.nome))
  r = await chamar(GET, { usuario: ADMIN, query: { cidade: 'uberlandia' } })
  ok(r.body.total === 1 && r.body.itens[0].id === U(3), 'cidade sem acento casa com Uberlândia')
  r = await chamar(GET, { usuario: ADMIN, query: { uf: 'mg', apenas_ativos: 'true' } })
  ok(r.body.total === 3 && !r.body.itens.some(i => i.id === U(3)), 'uf minúscula + apenas_ativos=true tira a inativa', r.body.itens.map(i => i.nome))

  // POST
  r = await chamar(POST, { usuario: ADMIN, body: { campanha: ' novembro ', usuario_id: U(1) } })
  ok(r.status === 201 && r.body.campanha === 'novembro' && r.body.usuario_id === U(1) && r.body.admin_id === U(99) && r.body.enviado_em && r.body.id, 'POST: 201 com a linha gravada', r.body)
  ok(Object.keys(r.body).join(',') === 'id,campanha,usuario_id,admin_id,enviado_em', 'POST: campos exatos', Object.keys(r.body))
  r = await chamar(POST, { usuario: ADMIN, body: { campanha: 'novembro', usuario_id: U(77) } })
  ok(r.status === 404, 'POST: usuário inexistente 404', r.body)
  r = await chamar(POST, { usuario: ADMIN, body: { campanha: '', usuario_id: U(1) } })
  ok(r.status === 400, 'POST: campanha vazia 400', r.body)
  r = await chamar(POST, { usuario: ADMIN, body: { campanha: 'novembro', usuario_id: 'x' } })
  ok(r.status === 400, 'POST: usuario_id inválido 400', r.body)

  r = await chamar(GET, { usuario: ADMIN, query: { campanha: 'novembro' } })
  ok(r.body.itens.find(i => i.id === U(1)).enviado_em !== null && r.body.itens.find(i => i.id === U(2)).enviado_em === null, 'enviado_em aparece só para quem foi marcado na campanha')
  r = await chamar(GET, { usuario: ADMIN, query: { campanha: 'dezembro' } })
  ok(r.body.itens.every(i => i.enviado_em === null), 'outra campanha: enviado_em null')

  r = await chamar(GET, { usuario: { id: U(1), role: 'aprovador' } })
  ok(r.status === 403, 'aprovador: 403 (só admin)', r.body)
  r = await chamar(POST, { usuario: { id: U(1), role: 'prestador' }, body: { campanha: 'x', usuario_id: U(2) } })
  ok(r.status === 403, 'POST por não-admin: 403')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
