#!/usr/bin/env node
// Testa GET /dicas e o CRUD /admin/dicas com o DDL/seed REAIS (utils/dicas) em Postgres em
// memória (PGlite). Handlers chamados direto, sem HTTP.
//   npm i -D @electric-sql/pglite && node scripts/testar-dicas.js
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

let db = null
const shim = {
  query: (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return db.query(sql, params) },
  connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: (s, p) => db.query(s, p), release() {} } },
  on() {},
}
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error
console.log = () => {}; console.error = () => {}
const router = require(path.join(REPO, 'src/routes/index.js'))
console.log = logOrig; console.error = errOrig
const { SQL_CRIAR_TABELA_DICAS, SEED_DICAS, seedDicas } = require(path.join(REPO, 'src/utils/dicas'))

const rota = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const chamar = (handler, { usuario, params = {}, query = {}, body = {} }) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, query, body, usuario }, res)
})
const DONO = { id: 'aaaaaaaa-0000-4000-8000-000000000001', role: 'dono_obra' }
const PROF = { id: 'aaaaaaaa-0000-4000-8000-000000000002', role: 'prestador', tipo_prestador: 'pintor' }
const ADMIN = { id: 'aaaaaaaa-0000-4000-8000-000000000003', role: 'admin' }
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const totalSeed = SEED_DICAS.reduce((n, t) => n + t.dicas.length, 0)
const seedPorLado = (lado) => SEED_DICAS.filter(t => t.lado === lado)

const main = async () => {
  db = new PGlite()
  await db.exec(SQL_CRIAR_TABELA_DICAS)
  const n1 = await seedDicas(db)
  const n2 = await seedDicas(db)
  const cont = await db.query(`SELECT COUNT(*)::int AS n FROM dicas`)
  ok(n1 === totalSeed && n2 === totalSeed && cont.rows[0].n === totalSeed, `seed idempotente: ${totalSeed} dicas, re-run não duplica`, cont.rows[0])

  const getDicas = rota('get', '/dicas')
  const c = await chamar(getDicas, { usuario: DONO })
  const temasC = seedPorLado('cliente')
  ok(c.status === 200 && c.body.lado === 'cliente', 'GET /dicas dono → lado cliente')
  ok(c.body.temas.map(t => t.tema).join('|') === temasC.map(t => t.tema).join('|'), 'temas do cliente na ordem', c.body.temas.map(t => `${t.icone} ${t.tema}`))
  ok(c.body.total === temasC.reduce((n, t) => n + t.dicas.length, 0), `total cliente = ${c.body.total}`)
  const dicaNova = c.body.temas[0].dicas.find(d => d.ordem === 2)
  ok(dicaNova.nova === true && dicaNova.novo_ate === '2026-12-04' && dicaNova.acao === 'meus_pedidos', 'dica com novo_ate futuro vem nova=true e acao', dicaNova)
  ok(c.body.temas[0].dicas[0].nova === false && c.body.temas[0].dicas[0].acao === null && /\*\*Marcar "Outros"\*\*/.test(c.body.temas[0].dicas[0].texto), 'dica sem novo_ate/acao: nova=false, acao null, **negrito** preservado')

  const p = await chamar(getDicas, { usuario: PROF })
  const temasP = seedPorLado('profissional')
  ok(p.status === 200 && p.body.lado === 'profissional' && p.body.temas.map(t => t.tema).join('|') === temasP.map(t => t.tema).join('|'), 'GET /dicas pintor → lado profissional, temas na ordem', p.body.temas.map(t => `${t.icone} ${t.tema} (${t.dicas.length})`))
  ok(p.body.temas[0].dicas.map(d => d.acao).join(',') === 'editar_perfil,especialidades,,,ativar_avisos', 'ações do tema Receber pedidos')
  const r = await chamar(getDicas, { usuario: { ...PROF, tipo_prestador: 'reparador' } })
  ok(r.body.lado === 'profissional' && r.body.total === p.body.total, 'reparador vê o mesmo lado profissional')
  const a1 = await chamar(getDicas, { usuario: ADMIN, query: { lado: 'profissional' } })
  const a2 = await chamar(getDicas, { usuario: ADMIN, query: { lado: 'xyz' } })
  ok(a1.body.lado === 'profissional' && a2.body.lado === 'cliente', 'admin escolhe ?lado=; inválido cai em cliente')

  // CRUD admin
  const listar = rota('get', '/admin/dicas'), criar = rota('post', '/admin/dicas'), alterar = rota('put', '/admin/dicas/:id'), apagar = rota('delete', '/admin/dicas/:id')
  const l = await chamar(listar, { usuario: ADMIN, query: {} })
  ok(l.status === 200 && l.body.total === totalSeed && l.body.dicas[0].lado === 'cliente', 'GET /admin/dicas lista tudo')
  const lp = await chamar(listar, { usuario: ADMIN, query: { lado: 'profissional' } })
  ok(lp.body.total === temasP.reduce((n, t) => n + t.dicas.length, 0) && lp.body.dicas.every(d => d.lado === 'profissional'), 'GET /admin/dicas?lado=profissional filtra')

  const ruins = [
    [{ tema: 'X', texto: 'y' }, /lado/],
    [{ lado: 'cliente', texto: 'y' }, /tema/],
    [{ lado: 'cliente', tema: 'X' }, /texto/],
    [{ lado: 'cliente', tema: 'X', texto: 'y', acao: 'abrir_chat' }, /acao/],
    [{ lado: 'cliente', tema: 'X', texto: 'y', novo_ate: '04/12/2026' }, /novo_ate/],
    [{ lado: 'cliente', tema: 'X', texto: 'y', ordem: 1.5 }, /ordem/],
    [{ lado: 'cliente', tema: 'X', texto: 'y', ativo: 'sim' }, /ativo/],
  ]
  for (const [body, re] of ruins) {
    const x = await chamar(criar, { usuario: ADMIN, body })
    ok(x.status === 400 && re.test(x.body.erro), `POST inválido 400: ${x.body.erro}`)
  }
  const dup = await chamar(criar, { usuario: ADMIN, body: { lado: 'cliente', tema: 'Cuidados', ordem: 1, texto: 'repetida' } })
  ok(dup.status === 409 && dup.body.codigo === 'dica_duplicada', 'POST duplicada (lado+tema+ordem) → 409')
  const nova = await chamar(criar, { usuario: ADMIN, body: { lado: 'cliente', tema: 'Cuidados', tema_icone: '🛡️', tema_ordem: 5, ordem: 2, texto: '**Nova** dica do admin', acao: 'meus_perfis', novo_ate: '2099-01-01' } })
  ok(nova.status === 201 && nova.body.id && nova.body.nova === true && nova.body.acao === 'meus_perfis' && nova.body.ativo === true, 'POST válido 201', { id: nova.body.id, nova: nova.body.nova })
  const c2 = await chamar(getDicas, { usuario: DONO })
  const cuidados = c2.body.temas.find(t => t.tema === 'Cuidados')
  ok(cuidados.dicas.length === 2 && cuidados.dicas[1].texto === '**Nova** dica do admin', 'dica criada aparece no GET /dicas do cliente')

  const vazio = await chamar(alterar, { usuario: ADMIN, params: { id: nova.body.id }, body: {} })
  ok(vazio.status === 400, 'PUT sem campos → 400')
  const inval = await chamar(alterar, { usuario: ADMIN, params: { id: nova.body.id }, body: { lado: 'ambos' } })
  ok(inval.status === 400, 'PUT lado inválido → 400')
  const alt = await chamar(alterar, { usuario: ADMIN, params: { id: nova.body.id }, body: { texto: 'Texto editado', acao: null, novo_ate: null } })
  ok(alt.status === 200 && alt.body.texto === 'Texto editado' && alt.body.acao === null && alt.body.novo_ate === null && alt.body.nova === false, 'PUT parcial: texto, acao null, novo_ate null', alt.body)
  const mov = await chamar(alterar, { usuario: ADMIN, params: { id: nova.body.id }, body: { ordem: 1 } })
  ok(mov.status === 409, 'PUT para ordem já ocupada → 409')
  const semId = await chamar(alterar, { usuario: ADMIN, params: { id: 'nao-uuid' }, body: { texto: 'x' } })
  const naoExiste = await chamar(alterar, { usuario: ADMIN, params: { id: '00000000-0000-4000-8000-000000000000' }, body: { texto: 'x' } })
  ok(semId.status === 404 && naoExiste.status === 404, 'PUT id inválido/inexistente → 404')

  // Desativar dica do seed: sai do GET /dicas, segue no admin, e o re-seed preserva ativo=false
  const seedCuid = cuidados.dicas[0]
  const des = await chamar(alterar, { usuario: ADMIN, params: { id: seedCuid.id }, body: { ativo: false } })
  ok(des.status === 200 && des.body.ativo === false, 'PUT ativo=false em dica do seed')
  await seedDicas(db)
  const c3 = await chamar(getDicas, { usuario: DONO })
  const cuid3 = c3.body.temas.find(t => t.tema === 'Cuidados')
  const adm3 = await chamar(listar, { usuario: ADMIN, query: { lado: 'cliente' } })
  ok(cuid3.dicas.length === 1 && cuid3.dicas[0].id === nova.body.id, 'inativa some do GET /dicas (tema continua pela outra dica)')
  ok(adm3.body.dicas.find(d => d.id === seedCuid.id)?.ativo === false, 're-seed preservou ativo=false da dica do seed')
  const reat = await chamar(alterar, { usuario: ADMIN, params: { id: seedCuid.id }, body: { ativo: true } })
  ok(reat.body.ativo === true, 'PUT ativo=true reativa')

  // Tema inteiro inativo desaparece
  await db.query(`UPDATE dicas SET ativo = false WHERE lado = 'profissional' AND tema = 'Reputação'`)
  const p2 = await chamar(getDicas, { usuario: PROF })
  ok(!p2.body.temas.some(t => t.tema === 'Reputação') && p2.body.temas.length === temasP.length - 1, 'tema com todas as dicas inativas não aparece')

  const del = await chamar(apagar, { usuario: ADMIN, params: { id: nova.body.id } })
  const del2 = await chamar(apagar, { usuario: ADMIN, params: { id: nova.body.id } })
  ok(del.status === 200 && del2.status === 404, 'DELETE ok, segundo → 404')
  const c4 = await chamar(getDicas, { usuario: DONO })
  ok(c4.body.total === temasC.reduce((n, t) => n + t.dicas.length, 0), 'após DELETE o cliente volta ao total do seed')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
