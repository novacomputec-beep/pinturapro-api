#!/usr/bin/env node
// Testa utils/desistencias (desistencias + interessados_ativos de GET /reparos/:id e /obras/:id ao
// dono) com o SQL REAL num Postgres em memória (PGlite): só o cancelamento feito pelo PRÓPRIO
// profissional conta; desfazer do dono, cancelamento do dono/admin, recusado e expirado ficam fora.
//   npm i -D @electric-sql/pglite && node scripts/testar-desistencias.js
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
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const DONO = U(99), ADMIN = U(98)
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const main = async () => {
  db = new PGlite()
  const cols = (fk) => `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${fk} uuid, usuario_id uuid, status text, cancelado_por uuid, cancelado_motivo text,
      cancelado_detalhe text, cancelado_em timestamptz, cancelado_acordo boolean DEFAULT false`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, foto_url text);
    CREATE TABLE interesse_reparos (${cols('reparo_id')});
    CREATE TABLE candidaturas (${cols('obra_id')});
  `)
  await db.query(`INSERT INTO usuarios (id, nome, foto_url) VALUES
    ($1, 'Hudson Vinícius Silva', 'https://res.cloudinary.com/demo/image/upload/v1/fotos/hudson.jpg'),
    ($2, 'Ana', NULL), ($3, 'Beto Souza', 'https://outro.invalid/b.png'), ($4, 'Caio', NULL), ($5, 'Dono', NULL), ($6, 'Admin', NULL)`,
    [U(1), U(2), U(3), U(4), DONO, ADMIN])
  // Reparo 1: Hudson cancelou (imprevisto, 11:56) e de novo após nova escolha (acordo, 12:40); Ana desfeita pelo dono;
  // Beto cancelado pelo dono; Caio recusado; dois pendentes e uma contraproposta_dono; um cancelado pelo admin.
  const ins = (fk, tabela, rows) => Promise.all(rows.map(r => db.query(
    `INSERT INTO ${tabela} (${fk}, usuario_id, status, cancelado_por, cancelado_motivo, cancelado_detalhe, cancelado_em, cancelado_acordo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, r)))
  await ins('reparo_id', 'interesse_reparos', [
    [D(1), U(1), 'cancelado', U(1), 'imprevisto', 'Carro quebrou', '2026-11-06T14:56:00Z', false],
    [D(1), U(2), 'cancelado', DONO, 'escolha_desfeita', null, '2026-11-06T13:00:00Z', false],
    [D(1), U(3), 'cancelado', DONO, 'nao_preciso', null, '2026-11-06T15:00:00Z', false],
    [D(1), U(4), 'recusado', null, null, null, null, false],
    [D(1), U(5), 'pendente', null, null, null, null, false],
    [D(1), U(6), 'contraproposta_dono', null, null, null, null, false],
    [D(2), U(1), 'cancelado', U(1), 'nao_consigo_horario', null, '2026-11-06T15:40:00Z', true],
    [D(2), U(3), 'cancelado', U(3), 'xyz_motivo_novo', null, '2026-11-06T15:30:00Z', false],
    [D(2), U(2), 'cancelado', ADMIN, 'outro', 'admin', '2026-11-06T15:50:00Z', false],
  ])
  await ins('obra_id', 'candidaturas', [
    [D(3), U(3), 'cancelado', U(3), 'nao_preciso', null, '2026-11-06T10:00:00Z', false],
    [D(3), U(1), 'cancelado', U(1), 'outro', 'Peguei outro serviço', '2026-11-06T11:00:00Z', false],
    [D(3), U(2), 'pendente', null, null, null, null, false],
    [D(3), U(4), 'expirado', null, null, null, null, false],
  ])
  const { listarDesistencias, contarInteressadosAtivos, ROTULO_DESISTENCIA } = require(path.join(REPO, 'src/utils/desistencias'))

  let l = await listarDesistencias('reparos', D(1))
  ok(l.length === 1 && l[0].usuario_id === U(1), 'reparo 1: só o cancelamento feito pelo próprio profissional (desfazer do dono, cancelamento do dono e recusado ficam fora)', l.map(x => x.nome))
  ok(l[0].nome === 'Hudson' && l[0].motivo === 'imprevisto' && l[0].motivo_texto === 'Imprevisto' && l[0].detalhe === 'Carro quebrou' && l[0].acordo === false && new Date(l[0].cancelado_em).toISOString() === '2026-11-06T14:56:00.000Z',
     'item: primeiro nome, motivo em português, detalhe, acordo=false, cancelado_em', l[0])
  ok(l[0].foto_url === 'https://res.cloudinary.com/demo/image/upload/w_200,h_200,c_fill,g_face,q_auto,f_auto/v1/fotos/hudson.jpg', 'avatar otimizado (Cloudinary)', l[0].foto_url)
  ok(typeof l[0].id === 'string' && !('cancelado_por' in l[0]), 'tem id; sem colunas cruas')
  ok(await contarInteressadosAtivos('reparos', D(1)) === 2, 'interessados_ativos = pendente + contraproposta_dono (recusado/cancelado fora)')

  l = await listarDesistencias('reparos', D(2))
  ok(l.length === 2 && l[0].usuario_id === U(1) && l[1].usuario_id === U(3), 'reparo 2: duas desistências, mais recente primeiro; admin fora', l.map(x => [x.nome, x.cancelado_em]))
  ok(l[0].motivo_texto === 'Não consegue no horário' && l[0].acordo === true && l[1].motivo_texto === 'xyz_motivo_novo' && l[1].foto_url === 'https://outro.invalid/b.png',
     'rótulos: nao_consigo_horario → "Não consegue no horário", acordo=true; motivo desconhecido sai cru; foto fora do Cloudinary sai como está', l.map(x => x.motivo_texto))
  ok(await contarInteressadosAtivos('reparos', D(2)) === 0, 'reparo 2: nenhum ativo')

  l = await listarDesistencias('obras', D(3))
  ok(l.length === 2 && l[0].nome === 'Hudson' && l[0].motivo_texto === 'Outro motivo' && l[0].detalhe === 'Peguei outro serviço' && l[1].motivo_texto === 'Não precisa mais',
     'obra: candidaturas canceladas pelo pintor, mais recente primeiro, "Não precisa mais" / "Outro motivo"', l.map(x => [x.nome, x.motivo_texto]))
  ok(await contarInteressadosAtivos('obras', D(3)) === 1, 'obra: 1 ativo (expirado fora)')
  ok(Object.keys(ROTULO_DESISTENCIA).sort().join() === 'imprevisto,nao_consigo_horario,nao_preciso,outro', 'cobre os 4 motivos de cancelamentoMatchService')
  let erro = null
  try { await listarDesistencias('usuarios', D(1)) } catch (e) { erro = e.message }
  ok(/tabela inválida/.test(erro || ''), 'tabela inválida lança')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
