#!/usr/bin/env node
// PAINEL DO ROBÔ DE WHATSAPP — mensagens AGRUPADAS (19/11/2026). whatsapp_mensagens tem uma linha
// por ITEM; o painel lista e conta MENSAGENS de verdade. ESQUEMA DE PRODUÇÃO (PGlite). Cobre:
//   /mensagens: uma linha por mensagem (mesmo wa_message_id; na fila, o lote que vai sair junto;
//   falhas encerradas juntas), itens_count, resumo "5 interessados" / "2 perguntas", status mais
//   adiantado, resposta, filtro por status e total da paginação;
//   /contadores e /status: enviadas, falhas, na fila e respondidas contam mensagens, não itens.
//   npm i -D @electric-sql/pglite && node scripts/testar-whatsapp-painel-agrupadas.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

let db = null
const q = async (sql, params) => {
  if (!db) throw new Error('sem banco (boot)')
  const r = await db.query(sql, params)
  if (r && r.rowCount === undefined) r.rowCount = r.rows.length || r.affectedRows || 0
  return r
}
const shim = { query: q, connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: q, release() {}, on() {} } }, on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const { migrarWhatsapp } = require(path.join(REPO, 'src/whatsapp/migracao'))
const rotas = require(path.join(REPO, 'src/routes/adminWhatsapp'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const P = (n) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`
const chamar = (metodo, caminho, query = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  const pilha = rotas.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo]).route.stack
  Promise.resolve(pilha[pilha.length - 1].handle({ body: {}, query, params: {}, usuario: { id: U(99), role: 'admin' } }, res)).catch(e => resolve({ status: 599, body: { erro: e.message } }))
})

const TEL = '+5534998891747', OUTRO = '+5511987654321'
const DONO = U(1), PROF = U(2), R1 = D(1), R2 = D(2)

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT')
  await q(`INSERT INTO usuarios (id, nome, email, role, telefone, cpf_cnpj, ativo) VALUES ($1, 'Luiz Melo', 'd@x.invalid', 'dono_obra', '34998891747', '00000000001', true), ($2, 'Carlos', 'p@x.invalid', 'prestador', '11987654321', '00000000002', true)`, [DONO, PROF])
  await q(`INSERT INTO reparos (id, titulo, criado_por, status, codigo_publico) VALUES ($1, 'Entregar panfletos', $3, 'aberta', 'AAAA1'), ($2, 'Pintar o portão', $3, 'aberta', 'BBBB2')`, [R1, R2, DONO])
  for (let n = 1; n <= 3; n++) await q(`INSERT INTO perguntas_demanda (id, tipo, demanda_id, autor_id, pergunta) VALUES ($1, 'reparo', $2, $3, 'Pergunta?')`, [P(n), R1, PROF])

  // Uma linha por ITEM. `extra` = colunas além das básicas; devolve o id.
  const item = async (tipo, tabela, ref, extra = {}) => {
    const cols = { tipo, usuario_id: DONO, telefone: TEL, texto: `item ${tipo}`, ref_tabela: tabela, ref_id: ref, ...extra }
    const ks = Object.keys(cols)
    return (await q(`INSERT INTO whatsapp_mensagens (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, ks.map(k => cols[k]))).rows[0].id
  }
  // Mensagem ENVIADA com vários itens: a primeira linha é a dona (guarda o texto que saiu).
  const enviada = async (wa, tipo, refs, status, porItem = () => ({})) => {
    let dona = null
    for (const [i, [tabela, ref]] of refs.entries()) {
      const id = await item(tipo, tabela, ref, { status, wa_message_id: wa, enviada_em: new Date().toISOString(), agrupada_em: dona, ...(i === 0 ? { texto: `texto que saiu ${wa}` } : {}), ...porItem(i) })
      dona ??= id
    }
    return dona
  }
  const NI = 'novo_interessado', PG = 'pergunta_sem_resposta'
  const respondeu = (resposta) => ({ status: 'respondida', resposta, respondida_em: new Date().toISOString() })

  // 5 interessados no MESMO pedido, numa mensagem só — lida.
  const donaA = await enviada('WA-A', NI, Array(5).fill(['reparos', R1]), 'lida')
  // 3 interessados em DOIS pedidos, numa mensagem — a pessoa respondeu (o serviço marca todas).
  await enviada('WA-B', NI, [['reparos', R1], ['reparos', R1], ['reparos', R2]], 'lida', () => respondeu('ok, vou ver'))
  // 2 perguntas numa mensagem: só a nº 1 foi respondida; a nº 2 segue lida.
  await enviada('WA-C', PG, [['perguntas_demanda', P(1)], ['perguntas_demanda', P(2)]], 'lida', (i) => ({ item_numero: i + 1, ...(i === 0 ? respondeu('sim, pode') : {}) }))
  // 1 pergunta sozinha — enviada.
  await enviada('WA-D', PG, [['perguntas_demanda', P(3)]], 'enviada')
  // NA FILA: 4 interessados da mesma pessoa (saem juntos) + 1 teste para outro número.
  for (let i = 0; i < 4; i++) await item(NI, 'reparos', i < 3 ? R1 : R2)
  await item('teste', null, null, { usuario_id: null, telefone: OUTRO })
  // Respostas automáticas na fila para o mesmo número: nunca se agrupam (2 mensagens).
  await item('resposta', null, null); await item('resposta', null, null)
  // FALHAS: 2 itens que falharam juntos (o mesmo UPDATE do worker) + 1 que falhou em outra hora.
  const f1 = await item(NI, 'reparos', R1), f2 = await item(NI, 'reparos', R1), f3 = await item(NI, 'reparos', R2)
  await q(`UPDATE whatsapp_mensagens SET status = 'falha', erro = 'falha simulada', atualizado_em = NOW() - INTERVAL '2 hours' WHERE id = ANY($1::bigint[])`, [[f1, f2]])
  await q(`UPDATE whatsapp_mensagens SET status = 'falha', erro = 'falha simulada', atualizado_em = NOW() - INTERVAL '1 hour' WHERE id = $1`, [f3])

  const itens = (await q(`SELECT COUNT(*)::int AS n FROM whatsapp_mensagens`)).rows[0].n
  const lista = (await chamar('get', '/admin/whatsapp/mensagens', { limit: '100' })).body
  const porWa = (wa) => lista.mensagens.find(x => x.wa_message_id === wa)
  const a = porWa('WA-A'), b = porWa('WA-B'), c = porWa('WA-C'), d = porWa('WA-D')
  ok(itens === 21 && lista.total === 10 && lista.mensagens.length === 10, '/mensagens: 21 linhas de item viram 10 mensagens de verdade', [itens, lista.total])
  ok(a && a.itens_count === 5 && a.status === 'lida' && String(a.id) === String(donaA) && a.texto === 'texto que saiu WA-A' && a.codigo === 'AAAA1' && a.papel === 'dono'
     && a.resumo === '🙋 Novo interessado · 5 interessados · AAAA1 “Entregar panfletos”',
     '5 interessados no mesmo pedido: uma linha (a dona, com o texto que saiu), itens_count 5 e resumo "5 interessados"', a && [a.itens_count, a.resumo])
  ok(b && b.itens_count === 3 && b.pedidos_count === 2 && b.status === 'respondida' && b.resposta === 'ok, vou ver' && b.respondida_em && b.codigo === null
     && b.resumo === '🙋 Novo interessado · 3 interessados em 2 pedidos',
     'interessados em 2 pedidos: uma linha respondida, sem código de UM pedido', b && [b.itens_count, b.status, b.resumo])
  ok(c && c.itens_count === 2 && c.status === 'respondida' && c.resposta === 'sim, pode' && c.resumo === 'Pergunta sem resposta · 2 perguntas · AAAA1 “Entregar panfletos”'
     && c.itens.length === 2 && c.itens[0].item_numero === 1 && c.itens[0].resposta === 'sim, pode' && c.itens[1].status === 'lida' && c.itens[1].resposta === null && d.itens.length === 1,
     '2 perguntas numa mensagem, uma respondida: uma linha, status mais adiantado (respondida), resumo "2 perguntas" e a resposta de cada item em itens[]', c && [c.status, c.resumo])
  ok(d && d.itens_count === 1 && d.status === 'enviada' && d.resumo === 'Pergunta sem resposta · AAAA1 “Entregar panfletos”' && d.resposta === null,
     'mensagem de um item só continua igual (resumo antigo, itens_count 1)', d && d.resumo)

  const naFila = (await chamar('get', '/admin/whatsapp/mensagens', { status: 'fila', limit: '100' })).body
  const loteNi = naFila.mensagens.find(x => x.tipo === NI)
  ok(naFila.total === 4 && loteNi.itens_count === 4 && loteNi.resumo === '🙋 Novo interessado · 4 interessados em 2 pedidos' && naFila.mensagens.filter(x => x.tipo === 'resposta').length === 2
     && naFila.mensagens.filter(x => x.tipo === 'resposta').every(x => x.itens_count === 1),
     'na fila: os 4 interessados da pessoa são UMA mensagem; teste e respostas automáticas, uma cada', [naFila.total, loteNi && loteNi.resumo])
  const falharam = (await chamar('get', '/admin/whatsapp/mensagens', { status: 'falha' })).body
  ok(falharam.total === 2 && falharam.mensagens.map(x => x.itens_count).sort().join() === '1,2' && falharam.mensagens.every(x => x.erro === 'falha simulada'),
     'falhas: os 2 itens que falharam juntos são uma mensagem; o que falhou em outra hora, outra', falharam.mensagens.map(x => x.itens_count))
  const lidas = (await chamar('get', '/admin/whatsapp/mensagens', { status: 'lida' })).body
  const respondidas = (await chamar('get', '/admin/whatsapp/mensagens', { status: 'respondida' })).body
  ok(lidas.total === 1 && lidas.mensagens[0].wa_message_id === 'WA-A' && respondidas.total === 2,
     'filtro por status usa o status da MENSAGEM (a de 2 perguntas com uma respondida não aparece em "lida")', [lidas.total, respondidas.total])
  const pag = (await chamar('get', '/admin/whatsapp/mensagens', { limit: '3', page: '2' })).body
  ok(pag.total === 10 && pag.mensagens.length === 3 && lista.mensagens.slice(3, 6).map(x => x.id).join() === pag.mensagens.map(x => x.id).join()
     && lista.mensagens.every(x => !('_grupo' in x) && !('_n' in x) && !('_status' in x)), 'paginação conta mensagens (total 10) e não vaza colunas internas')

  const ct = (await chamar('get', '/admin/whatsapp/contadores')).body
  const h = ct.hoje, ni = ct.por_tipo[NI].sete_dias, pg = ct.por_tipo[PG].hoje
  ok(h.enviada === 1 && h.lida === 1 && h.respondida === 2 && h.falha === 2 && h.fila === 4 && JSON.stringify(ct.sete_dias) === JSON.stringify(h),
     '/contadores: enviadas, falhas, na fila e respondidas contam mensagens distintas (não as 21 linhas)', h)
  ok(ni.fila === 1 && ni.lida === 1 && ni.respondida === 1 && ni.falha === 2 && ni.enviada === 0 && pg.respondida === 1 && pg.enviada === 1 && pg.lida === 0
     && ct.por_tipo.resposta.hoje.fila === 2 && ct.por_tipo.teste.hoje.fila === 1,
     '/contadores por tipo: novo_interessado 1 na fila, 1 lida, 1 respondida, 2 falhas; perguntas 1 respondida e 1 enviada', [ni, pg])
  const st = (await chamar('get', '/admin/whatsapp/status')).body
  ok(st.na_fila === 4, '/status: na_fila conta mensagens (4), não itens (7)', st.na_fila)

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
