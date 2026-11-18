#!/usr/bin/env node
// PUT /auth/perfil (authCtrl.atualizarPerfil) — anos_experiencia (inteiro 0–60) e tamanho_equipe
// (inteiro 1–50), só em conta de profissional. Body só com esses campos atualiza; tipo/faixa
// inválidos → 400; em conta de dono as chaves são ignoradas; os demais campos seguem como eram.
// SQL REAL em PGlite (colunas de usuarios conferidas em scripts/fixtures/esquema-producao.sql).
//   node scripts/testar-perfil-experiencia-equipe.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

let db = null
const q = async (sql, params) => { const r = await db.query(sql, params); r.rowCount = r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0); return r }
const shim = { query: q, connect: async () => ({ query: q, release() {} }), on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  return origLoad.apply(this, arguments)
}
const authCtrl = require(path.join(REPO, 'src/controllers/authController'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const PRO = 'aaaaaaaa-0000-4000-8000-000000000001'
const DONO = 'aaaaaaaa-0000-4000-8000-000000000002'
const chamar = (usuarioId, role, body) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  authCtrl.atualizarPerfil({ body, usuario: { id: usuarioId, role, tipo_prestador: role === 'prestador' ? 'reparador' : null }, get() { return '' } }, res)
})
const linha = async (id) => (await db.query('SELECT nome, telefone, cidade, anos_experiencia, tamanho_equipe FROM usuarios WHERE id = $1', [id])).rows[0]

const main = async () => {
  db = new PGlite()
  await db.exec(`CREATE TABLE usuarios (
    id uuid PRIMARY KEY, nome text, email text, telefone text, cidade text, uf text, foto_url text,
    especialidades text[], role text, tipo_prestador text, avisos_todas_areas boolean DEFAULT true,
    atende_casa_cliente boolean DEFAULT true, atende_local_proprio boolean DEFAULT true,
    anos_experiencia integer DEFAULT 0, tamanho_equipe integer DEFAULT 1)`)
  await db.query(`INSERT INTO usuarios (id, nome, email, telefone, cidade, uf, role, tipo_prestador) VALUES
    ($1, 'Pro Teste', 'pro@x.invalid', '34999990000', 'Uberlândia', 'MG', 'prestador', 'reparador'),
    ($2, 'Dono Teste', 'dono@x.invalid', '34988880000', 'Uberlândia', 'MG', 'dono_obra', NULL)`, [PRO, DONO])

  let r = await chamar(PRO, 'prestador', { anos_experiencia: 12, tamanho_equipe: 4 })
  ok(r.status === 200 && r.body.anos_experiencia === 12 && r.body.tamanho_equipe === 4, 'só os dois campos → 200 e resposta traz os valores', r)
  let l = await linha(PRO)
  ok(l.anos_experiencia === 12 && l.tamanho_equipe === 4 && l.nome === 'Pro Teste' && l.telefone === '34999990000' && l.cidade === 'Uberlândia', 'gravou os dois e não tocou em nome/telefone/cidade', l)

  r = await chamar(PRO, 'prestador', { anos_experiencia: 0 })
  l = await linha(PRO)
  ok(r.status === 200 && l.anos_experiencia === 0 && l.tamanho_equipe === 4, 'só anos_experiencia = 0 (limite) → grava e mantém a equipe', l)
  r = await chamar(PRO, 'prestador', { anos_experiencia: 60, tamanho_equipe: 50 })
  ok(r.status === 200 && r.body.anos_experiencia === 60 && r.body.tamanho_equipe === 50, 'limites superiores 60 / 50 → 200')
  r = await chamar(PRO, 'prestador', { tamanho_equipe: 1 })
  ok(r.status === 200 && r.body.tamanho_equipe === 1 && r.body.anos_experiencia === 60, 'só tamanho_equipe = 1 (limite) → grava e mantém os anos')

  for (const v of [-1, 61, 2.5, '5', null, true, NaN]) {
    r = await chamar(PRO, 'prestador', { anos_experiencia: v })
    ok(r.status === 400 && /Anos de experiência/.test(r.body.erro), `anos_experiencia ${JSON.stringify(v)} (${typeof v}) → 400`, r.body)
  }
  for (const v of [0, 51, 1.5, '3', null, false]) {
    r = await chamar(PRO, 'prestador', { tamanho_equipe: v })
    ok(r.status === 400 && /Tamanho da equipe/.test(r.body.erro), `tamanho_equipe ${JSON.stringify(v)} (${typeof v}) → 400`, r.body)
  }
  r = await chamar(PRO, 'prestador', { nome: 'Outro Nome', tamanho_equipe: 99 })
  l = await linha(PRO)
  ok(r.status === 400 && l.nome === 'Pro Teste' && l.tamanho_equipe === 1, 'campo inválido junto de um válido → 400 e nada gravado', l)

  r = await chamar(PRO, 'prestador', { nome: 'Pro Novo' })
  l = await linha(PRO)
  ok(r.status === 200 && l.nome === 'Pro Novo' && l.anos_experiencia === 60 && l.tamanho_equipe === 1, 'body sem as chaves → não mexe nos dois', l)
  r = await chamar(PRO, 'prestador', {})
  ok(r.status === 400 && r.body.erro === 'Nenhum campo para atualizar', 'body vazio segue 400 "Nenhum campo para atualizar"', r.body)

  r = await chamar(DONO, 'dono_obra', { anos_experiencia: 10, tamanho_equipe: 5 })
  ok(r.status === 400 && r.body.erro === 'Nenhum campo para atualizar', 'dono só com os dois campos → ignorados, 400 de sempre', r.body)
  r = await chamar(DONO, 'dono_obra', { nome: 'Dono Novo', anos_experiencia: 999, tamanho_equipe: 'x' })
  l = await linha(DONO)
  ok(r.status === 200 && l.nome === 'Dono Novo' && l.anos_experiencia === 0 && l.tamanho_equipe === 1, 'dono com nome + os dois (até inválidos) → salva o nome, ignora os dois', l)

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK')
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e.stack || e); process.exit(1) })
