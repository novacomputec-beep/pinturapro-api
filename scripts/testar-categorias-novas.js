#!/usr/bin/env node
// Testa as categorias de serviço informatica / gesseiro / placas_fachadas em todos os pontos que
// leem a lista: vocabulário de especialidades (validarEspecialidades, lado reparador × obra),
// apresentação (emoji/rótulo de push e contrato), grupos relacionados dos avisos (expandirCategoria
// e publicoDemanda com a chave ligada/desligada, num PGlite) e as chaves de grupo.
//   npm i -D @electric-sql/pglite && node scripts/testar-categorias-novas.js
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

let db
const shim = { query: (sql, params) => db.query(sql, params), connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }), on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  return origLoad.apply(this, arguments)
}
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const NOVAS = {
  informatica:     { rotulo: 'Informática',       emoji: '🖥️', grupo: 'Elétrica e tecnologia', chave: 'eletrica_tec', irmao: 'eletrica' },
  gesseiro:        { rotulo: 'Gesseiro',          emoji: '🪜', grupo: 'Reparos da casa',       chave: 'reparos_casa', irmao: 'alvenaria' },
  placas_fachadas: { rotulo: 'Placas e fachadas', emoji: '🪧', grupo: 'Arte e criação',       chave: 'arte',         irmao: 'artesanato' },
}

const main = async () => {
  db = new PGlite()
  await db.exec(`CREATE TABLE configuracoes (chave text, valor text); INSERT INTO configuracoes VALUES ('grupos_relacionados_ativo', 'true');`)
  const E = require(path.join(REPO, 'src/utils/especialidades'))
  const C = require(path.join(REPO, 'src/utils/categoriasApp'))
  const G = require(path.join(REPO, 'src/utils/gruposCategorias')) // validarGrupos() roda na carga: slug errado derrubaria aqui

  // ---- listas
  const slugsApp = C.CATEGORIAS_SERVICO.map(c => c.slug)
  ok(E.ESPECIALIDADES_REPARADOR.length === 57 && slugsApp.length === 57 && JSON.stringify(E.ESPECIALIDADES_REPARADOR) === JSON.stringify(slugsApp),
     'ESPECIALIDADES_REPARADOR e CATEGORIAS_SERVICO: 57 slugs, mesma ordem', { n: E.ESPECIALIDADES_REPARADOR.length })
  ok(E.ESPECIALIDADES_REPARADOR.slice(-4).join() === 'informatica,gesseiro,placas_fachadas,outros', "as 3 novas entram antes de 'outros'", E.ESPECIALIDADES_REPARADOR.slice(-4))
  ok(!E.ESPECIALIDADES_OBRA.some(s => NOVAS[s]), 'lado obra intacto (4 papéis)', E.ESPECIALIDADES_OBRA)

  for (const [slug, n] of Object.entries(NOVAS)) {
    // ---- apresentação (push "novo serviço", contrato)
    const a = C.apresentacaoReparo(slug, '🛠️')
    ok(a.emoji === n.emoji && a.rotulo === n.rotulo, `${slug}: apresentacaoReparo → ${n.emoji} ${n.rotulo}`, a)
    ok(E.rotuloCategoria(slug, 'Serviço') === n.rotulo, `${slug}: rotuloCategoria (contrato)`)
    const lista = C.apresentacaoReparoLista({ categorias: [slug, 'faxina'] }, '🛠️')
    ok(lista.rotulo === `${n.rotulo} +1` && lista.emoji === n.emoji, `${slug}: apresentacaoReparoLista com +1`, lista)

    // ---- validação de especialidades (cadastro/perfil do reparador) e do lado obra
    const v = E.validarEspecialidades([slug, slug, 'faxina'], true, 'reparador')
    ok(!v.erro && JSON.stringify(v.valor) === JSON.stringify([slug, 'faxina']), `${slug}: válida para reparador (duplicata colapsada)`, v)
    // Fase 2b: a conta pintor também pode declarar serviços (capacidade simétrica); tipo NULL não muda.
    const vo = E.validarEspecialidades([slug, 'pintor'], true, 'pintor')
    ok(!vo.erro && vo.valor.length === 2, `${slug}: válida também para a conta pintor (Fase 2b)`, vo)

    // ---- grupos dos avisos
    ok(G.GRUPOS_RELACIONADOS[n.grupo].includes(slug) && G.CHAVE_DO_SLUG[slug] === n.chave, `${slug}: no grupo "${n.grupo}" (chave ${n.chave})`)
    ok(Object.values(G.GRUPOS_RELACIONADOS).filter(l => l.includes(slug)).length === 1, `${slug}: em exatamente 1 grupo`)
    const exp = await G.expandirCategoria(slug)
    ok(exp.includes(slug) && exp.includes(n.irmao) && exp.length === G.GRUPOS_RELACIONADOS[n.grupo].length,
       `${slug}: expandirCategoria (chave ligada) = o grupo inteiro`, exp)
    const inv = await G.expandirCategoria(n.irmao)
    ok(inv.includes(slug), `${n.irmao} (já existente) agora alcança ${slug}`)
    const pub = await G.publicoDemanda([slug, 'outros'])
    ok(pub.push === null && pub.email.includes(n.irmao) && !pub.email.includes('outros'), `${slug} + outros: push a todos, e-mail ao grupo`, pub)
  }
  // Chave desligada: só o próprio slug
  await db.query(`UPDATE configuracoes SET valor = 'false'`)
  ok(JSON.stringify(await G.expandirCategoria('gesseiro')) === '["gesseiro"]', 'chave desligada: expandirCategoria = só o slug')
  // POST /reparos: a validação de categorias usa ESPECIALIDADES_REPARADOR.includes — coberto pela lista
  ok(['informatica', 'gesseiro', 'placas_fachadas'].every(s => E.ESPECIALIDADES_REPARADOR.includes(s)), 'categorias de reparo (POST/PUT /reparos) aceitam as 3')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
