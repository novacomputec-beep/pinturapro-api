#!/usr/bin/env node
// Testa a página pública GET /p/:codigo (routes/paginaPublica) nos três estados — ABERTA (detalhes),
// COM PROFISSIONAL ("Este pedido já tem um profissional escolhido.", sem detalhes; por match OU por
// proposta 'aceito' sem match — utils/profissionalEscolhido) e ENCERRADA —
// com o SQL REAL num Postgres em memória (PGlite), chamando o handler da rota.
//   npm i -D @electric-sql/pglite && node scripts/testar-pagina-publica.js
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
const router = require(path.join(REPO, 'src/routes/paginaPublica'))
const { TEXTO_COM_PROFISSIONAL } = router._interno

const handler = router.stack.find(l => l.route && l.route.path === '/:codigo').route.stack[0].handle
const abrir = (codigo) => new Promise(resolve => {
  const res = {
    statusCode: 200, cabecalhos: {},
    status(c) { this.statusCode = c; return this }, set(k, v) { this.cabecalhos[k] = v; return this }, type() { return this },
    send(html) { resolve({ status: this.statusCode, html: String(html) }) },
  }
  handler({ params: { codigo }, protocol: 'https', get: (h) => (h === 'host' ? 'protudo.app.br' : 'Mozilla/5.0 (Linux; Android 14)') }, res)
})
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const main = async () => {
  db = new PGlite()
  const cols = `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), titulo text, categoria text, cidade text, uf text, bairro text, prazo_modo text,
      expira_em timestamptz, status text DEFAULT 'aberta', status_aprovacao text DEFAULT 'aprovada', match_usuario_id uuid, codigo_publico text`
  await db.exec(`
    CREATE TABLE reparos (${cols}, categorias text[], valor_estimado numeric, prazo_atendimento_horas numeric);
    CREATE TABLE obras (${cols}, valor numeric, horas_para_expirar numeric);
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, status text DEFAULT 'pendente');
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, status text DEFAULT 'pendente');
  `)
  await db.query(`INSERT INTO reparos (titulo, categoria, categorias, cidade, uf, bairro, valor_estimado, prazo_atendimento_horas, expira_em, codigo_publico, match_usuario_id, status) VALUES
    ('Trocar torneira <b>', 'hidraulica', '{hidraulica}', 'Patos de Minas', 'MG', 'Centro', 150, 24, now() + INTERVAL '20 hours', 'ABERT', NULL, 'aberta'),
    ('Tomada queimada', 'eletrica', '{eletrica}', 'Patos de Minas', 'MG', 'Lagoa', 90, 24, now() + INTERVAL '20 hours', 'MATCH', $1, 'aberta'),
    ('Pintar muro', 'alvenaria', '{alvenaria}', 'Patos de Minas', 'MG', 'Lagoa', 300, 24, now() - INTERVAL '2 hours', 'VENCD', NULL, 'aberta'),
    ('Cancelado', 'eletrica', '{eletrica}', 'Patos de Minas', 'MG', 'Lagoa', 90, 24, now() + INTERVAL '20 hours', 'CANCD', $1, 'cancelada')`, [U(1)])
  await db.query(`INSERT INTO obras (titulo, categoria, cidade, uf, bairro, valor, horas_para_expirar, expira_em, codigo_publico, match_usuario_id) VALUES
    ('Casa nova', 'residencial', 'Patos de Minas', 'MG', 'Centro', 8000, 720, now() + INTERVAL '10 days', 'XBRAM', $1),
    ('Pintura', 'residencial', 'Patos de Minas', 'MG', 'Copacabana', 3000, 720, now() + INTERVAL '10 days', 'ACEPT', NULL)`, [U(1)])
  // ACEPT: candidatura 'aceito' com match_usuario_id NULL (caso real) — tem profissional, não é aberta.
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status) SELECT id, $1::uuid, 'aceito' FROM obras WHERE codigo_publico = 'ACEPT'`, [U(1)])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status) SELECT id, $1::uuid, 'recusado' FROM obras WHERE codigo_publico = 'XBRAM'`, [U(1)])

  // ABERTA: detalhes
  let r = await abrir('ABERT')
  ok(r.status === 200 && /Tem cliente esperando/.test(r.html) && /Trocar torneira &lt;b&gt;/.test(r.html) && /R\$ 150/.test(r.html) && /Prazo:/.test(r.html) && /Ninguém respondeu ainda/.test(r.html),
     'aberta: card completo (título escapado, valor, prazo, faixa "ninguém respondeu")')
  ok(!r.html.includes(TEXTO_COM_PROFISSIONAL), 'aberta: sem o texto de profissional escolhido')

  // COM PROFISSIONAL: texto pedido, sem detalhes
  r = await abrir('MATCH')
  ok(r.status === 200 && r.html.includes(TEXTO_COM_PROFISSIONAL) && /Pedido em andamento · Patos de Minas/.test(r.html), 'com profissional: "Este pedido já tem um profissional escolhido."')
  ok(/Tomada queimada/.test(r.html) && /📍 Patos de Minas/.test(r.html) && /card off/.test(r.html), 'com profissional: card apagado só com chip, título e cidade')
  ok(!/R\$ 90/.test(r.html) && !/Prazo:/.test(r.html) && !/Ninguém respondeu/.test(r.html) && !/Lagoa/.test(r.html) && !/Tem cliente esperando/.test(r.html), 'com profissional: sem valor, prazo, bairro, faixa nem chamada de pedido aberto')
  ok(/og:title" content="Pedido com profissional escolhido"/.test(r.html) && /veja os pedidos abertos/.test(r.html), 'com profissional: OG e botão "veja os pedidos abertos"')
  r = await abrir('XBRAM')
  ok(r.status === 200 && r.html.includes(TEXTO_COM_PROFISSIONAL) && /Casa nova/.test(r.html) && !/R\$ 8/.test(r.html), 'obra com pintor escolhido: mesmo estado, sem valor')
  r = await abrir('ACEPT')
  ok(r.status === 200 && r.html.includes(TEXTO_COM_PROFISSIONAL) && /Pintura/.test(r.html) && !/R\$ 3/.test(r.html) && !/Tem cliente esperando/.test(r.html), 'obra com candidatura aceita e match_usuario_id NULL: "já tem um profissional escolhido"')

  // ENCERRADA / VENCIDA / CANCELADA / DESCONHECIDO
  r = await abrir('VENCD')
  ok(r.status === 200 && /já foi atendido ou expirou/.test(r.html) && !r.html.includes(TEXTO_COM_PROFISSIONAL), 'vencida sem match: encerrada')
  r = await abrir('CANCD')
  ok(r.status === 200 && /já foi atendido ou expirou/.test(r.html) && !r.html.includes(TEXTO_COM_PROFISSIONAL), 'cancelada (mesmo com match_usuario_id órfão): encerrada, não "profissional escolhido"')
  r = await abrir('ZZZZZ')
  ok(r.status === 404 && /já foi atendido ou expirou/.test(r.html), 'código desconhecido: 404 com a página encerrada')
  r = await abrir('abc')
  ok(r.status === 404, 'código malformado: 404')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
