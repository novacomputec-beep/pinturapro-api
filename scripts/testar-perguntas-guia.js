#!/usr/bin/env node
// PERGUNTAS-GUIA (src/data/perguntasGuia.js, GET /perguntas-guia). Sem banco: confere o dado
// (chaves reais, 2–3 perguntas, até 45 caracteres, sem palavras de contato) e a rota real
// (pública, Cache-Control de 1h, o formato { grupos, especialidades }).
//   node scripts/testar-perguntas-guia.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')

const semBanco = async () => { throw new Error('sem banco (teste)') }
const shim = { query: semBanco, connect: semBanco, on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', () => {})
const logOrig = console.log
console.log = () => {}; console.warn = () => {}; console.error = () => {}
const router = require(path.join(REPO, 'src/routes/index.js'))
const { PERGUNTAS_GUIA, MAX_CARACTERES } = require(path.join(REPO, 'src/data/perguntasGuia'))
const { CHAVE_DO_GRUPO } = require(path.join(REPO, 'src/utils/gruposCategorias'))
const { CATEGORIAS_SERVICO, CATEGORIAS_CONSTRUCAO } = require(path.join(REPO, 'src/utils/categoriasApp'))
const { GRUPO_OBRAS_REPARADOR } = require(path.join(REPO, 'src/utils/especialidades'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const main = async () => {
  const { grupos, especialidades } = PERGUNTAS_GUIA
  const chavesGrupo = [...new Set([...Object.values(CHAVE_DO_GRUPO), GRUPO_OBRAS_REPARADOR.chave])]
  ok(Object.keys(PERGUNTAS_GUIA).join() === 'grupos,especialidades', 'formato: { grupos, especialidades }', Object.keys(PERGUNTAS_GUIA))
  const faltando = chavesGrupo.filter(k => !grupos[k])
  const sobrando = Object.keys(grupos).filter(k => !chavesGrupo.includes(k))
  ok(faltando.length === 0 && sobrando.length === 0, `todo grupo das categorias tem perguntas (${chavesGrupo.length}) e nenhuma chave inventada`, { faltando, sobrando })
  const slugs = new Set([...CATEGORIAS_SERVICO, ...CATEGORIAS_CONSTRUCAO].map(c => c.slug))
  const esp = Object.keys(especialidades)
  ok(esp.length >= 15 && esp.every(s => slugs.has(s)), `especialidades: ${esp.length}, todas com slug real`, esp.filter(s => !slugs.has(s)))
  ok(especialidades.pintor?.join('|') === 'Quantos cômodos ou metros quadrados?|Parede interna, externa ou as duas?|Precisa raspar, massa corrida ou só pintar?', 'pintor: as 3 perguntas do exemplo', especialidades.pintor)

  const todas = [...Object.entries(grupos), ...Object.entries(especialidades)]
  const qtd = todas.filter(([, l]) => !Array.isArray(l) || l.length < 2 || l.length > 3)
  ok(qtd.length === 0, '2 ou 3 perguntas por chave', qtd.map(([k]) => k))
  const perguntas = todas.flatMap(([k, l]) => l.map(p => [k, p]))
  const longas = perguntas.filter(([, p]) => typeof p !== 'string' || !p.trim() || p.length > MAX_CARACTERES || !p.endsWith('?'))
  ok(longas.length === 0, `toda pergunta: texto, até ${MAX_CARACTERES} caracteres, termina em "?"`, longas)
  const CONTATO = /telefone|celular|whats|zap|e-?mail|contato|ligar|liga[çc][ãa]o|endere[çc]o|\bcep\b|instagram|n[úu]mero/i
  const comContato = perguntas.filter(([, p]) => CONTATO.test(p))
  ok(comContato.length === 0, 'nenhuma pergunta fala de contato', comContato)
  const repetidas = todas.filter(([, l]) => new Set(l).size !== l.length)
  ok(repetidas.length === 0, 'sem pergunta repetida na mesma chave', repetidas.map(([k]) => k))
  ok(Object.isFrozen(grupos) && Object.isFrozen(grupos.reparos_casa) && Object.isFrozen(especialidades.pintor), 'dado congelado (a rota não pode ser alterada em memória)')

  const rotas = (r) => r.stack.flatMap(l => (l.route ? [l.route] : l.handle?.stack ? rotas(l.handle) : []))
  const rota = rotas(router).find(x => x.path === '/perguntas-guia' && x.methods.get)
  ok(!!rota && rota.stack.length === 1, 'GET /perguntas-guia: pública (sem autenticar), um handler só', rota && rota.stack.map(l => l.handle.name || l.name))
  let corpo = null, status = 200
  const headers = {}
  const res = { set(k, v) { headers[k] = v; return this }, status(c) { status = c; return this }, json(b) { corpo = b; return this } }
  await rota.stack[0].handle({ method: 'GET', headers: {}, query: {}, params: {} }, res)
  ok(status === 200 && headers['Cache-Control'] === 'public, max-age=3600', 'resposta 200 com Cache-Control public, max-age=3600', headers)
  ok(JSON.stringify(corpo) === JSON.stringify(PERGUNTAS_GUIA), 'corpo = o dado estático', corpo && Object.keys(corpo))

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { logOrig('ERRO', e); process.exit(1) })
