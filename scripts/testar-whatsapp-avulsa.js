#!/usr/bin/env node
// ROBÔ DE WHATSAPP — tipo 'avulsa' (19/11/2026): POST /admin/whatsapp/avulsa { codigo, texto }.
// Adaptador FALSO (nada sai de verdade) e ESQUEMA DE PRODUÇÃO (PGlite). Cobre:
//   rota: validação, pedido pelo código curto (reparo ou obra, sem diferenciar caixa), dono sem
//   telefone, dono que pediu SAIR, trava de teste, texto exato, telefone mascarado, dedupe de 24 h
//   (mesmo texto, mesma pessoa; a que falhou não conta);
//   fila: sempre ligada (fora do liga/desliga por tipo), atrás da pausa e da janela 08–21h, uma
//   mensagem por linha (nunca agrupada), sem o limite de 3 h, para o JID do onWhatsApp;
//   volta: a resposta fica na linha (painel), sem resposta automática, e não vira resposta de
//   pergunta antiga; citar a pergunta continua respondendo a pergunta;
//   painel: fora de /tipos, na lista de /mensagens com resumo e resposta.
//   npm i -D @electric-sql/pglite && node scripts/testar-whatsapp-avulsa.js
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
const F = require(path.join(REPO, 'src/whatsapp/fila'))
const { migrarWhatsapp } = require(path.join(REPO, 'src/whatsapp/migracao'))
const { registrarRecebida } = require(path.join(REPO, 'src/whatsapp/entrada'))
const SP = require(path.join(REPO, 'src/services/whatsappPerguntasService'))
const rotas = require(path.join(REPO, 'src/routes/adminWhatsapp'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const P = (n) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`
const rota = (metodo, caminho) => rotas.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo]).route
const chamar = (metodo, caminho, { body = {}, query = {} } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  const pilha = rota(metodo, caminho).stack
  Promise.resolve(pilha[pilha.length - 1].handle({ body, query, params: {}, usuario: { id: U(99), role: 'admin' } }, res)).catch(e => resolve({ status: 599, body: { erro: e.message } }))
})
const avulsa = (codigo, texto) => chamar('post', '/admin/whatsapp/avulsa', { body: { codigo, texto } })

const criarFalso = () => {
  const f = {
    enviados: [], consultas: [], n: 0,
    conectar: async () => {}, desconectar: async () => {},
    estado: () => ({ conexao: 'conectado', qr: null, numero: '+5534900000000' }),
    existeNoWhatsapp: async (tel) => { f.consultas.push(tel); const d = tel.slice(1); return { existe: true, jid: `${d.length === 13 ? d.slice(0, 4) + d.slice(5) : d}@s.whatsapp.net` } },
    enviarTexto: async (jid, texto) => { const id = `WA${++f.n}`; f.enviados.push({ jid, texto, id }); return { id } },
    aoReceber() {}, aoAtualizarStatus() {}, aoMudarEstado() {},
  }
  return f
}

const TEL = '+5534998891747', JID = '553498891747@s.whatsapp.net', TEL_WA = '+553498891747'
const TEL_MARIA = '+5511987654321'
const TRAVA = [TEL, TEL_MARIA].join(',')
const ENV = { WHATSAPP_SOMENTE_PARA: TRAVA }
// 08:30 de hoje em São Paulo.
const BASE = new Date(); BASE.setUTCHours(11, 30, 0, 0)
const em = (min) => new Date(BASE.getTime() + min * 60000)
const DONO = U(1), MARIA = U(2), SEM_TEL = U(3), FORA = U(4), PROF = U(5)
const R1 = D(1), R_MARIA = D(2), R_SEM_TEL = D(3), R_FORA = D(4), O1 = D(11)

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT')
  const usr = (id, nome, role, telefone, extra = {}) => {
    const cols = { id, nome, email: `${id.slice(-4)}@x.invalid`, role, telefone, cpf_cnpj: id.slice(-11), ativo: true, ...extra }
    const ks = Object.keys(cols)
    return q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => cols[k]))
  }
  await usr(DONO, 'Luiz Melo', 'dono_obra', '(34) 99889-1747')
  await usr(MARIA, 'Maria Souza', 'dono_obra', '11987654321', { whatsapp_avisos: false })
  await usr(SEM_TEL, 'Sem Telefone', 'dono_obra', null)
  await usr(FORA, 'Fora da Trava', 'dono_obra', '21987651234')
  await usr(PROF, 'Carlos', 'prestador', null)
  const pedido = (t, id, titulo, dono, codigo) => q(
    `INSERT INTO ${t} (id, titulo, criado_por, status, status_aprovacao, codigo_publico, expira_em) VALUES ($1, $2, $3, 'aberta', 'aprovada', $4, now() + INTERVAL '30 days')`, [id, titulo, dono, codigo])
  await pedido('reparos', R1, 'Entregar panfletos', DONO, 'AAAA1')
  await pedido('reparos', R_MARIA, 'Pedido da Maria', MARIA, 'DDDD4')
  await pedido('reparos', R_SEM_TEL, 'Pedido sem telefone', SEM_TEL, 'GGGG7')
  await pedido('reparos', R_FORA, 'Pedido fora da trava', FORA, 'HHHH8')
  await pedido('obras', O1, 'Pintar a sala', DONO, 'FFFF6')
  const config = (chave, valor) => q(`WITH u AS (UPDATE configuracoes SET valor = $2 WHERE chave = $1 RETURNING 1) INSERT INTO configuracoes (chave, valor) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM u)`, [chave, valor])
  const trava = async (valor) => {
    const u = await q(`UPDATE whatsapp_estado SET trava = $1 WHERE id = 1 RETURNING id`, [valor])
    if (!u.rows.length) await q(`INSERT INTO whatsapp_estado (id, trava) VALUES (1, $1)`, [valor])
  }
  const linhas = async (where = 'true') => (await q(`SELECT * FROM whatsapp_mensagens WHERE ${where} ORDER BY id`)).rows
  const f = criarFalso()
  const passo = (agora, env = ENV) => F.processarProxima({ db: shim, adaptador: f, agora, env })

  // ═══════════ ROTA ═══════════
  const pilha = rota('post', '/admin/whatsapp/avulsa').stack.map(l => l.name)
  ok(pilha.includes('autenticar') && pilha.includes('exigirSuperAdmin'), 'rota protegida: autenticar + exigirSuperAdmin', pilha)

  await trava(null)
  const semTrava = await avulsa('AAAA1', 'oi')
  ok(semTrava.status === 409 && (await linhas()).length === 0, 'robô sem trava (não iniciou): 409, nada entra na fila', semTrava.body)
  await trava(TRAVA)

  const v1 = await avulsa('', 'oi'), v2 = await avulsa('AAAA1', '   '), v3 = await avulsa('AAAA1', 'x'.repeat(1001)), v4 = await avulsa('ZZZZ9', 'oi')
  ok(v1.status === 400 && v2.status === 400 && v3.status === 400 && v4.status === 404, 'sem código / sem texto / 1001 caracteres → 400; código que não existe → 404', [v1.status, v2.status, v3.status, v4.status])
  const semTel = await avulsa('GGGG7', 'oi'), saiu = await avulsa('DDDD4', 'oi'), fora = await avulsa('HHHH8', 'oi')
  ok(semTel.status === 422 && saiu.status === 409 && saiu.body.status === 'saiu' && fora.status === 409 && (await linhas()).length === 0,
     'dono sem telefone → 422; dono que pediu SAIR → 409; número fora da trava de teste → 409; nada entra na fila', [semTel.status, saiu.body, fora.body])

  const TEXTO = 'Olá, Luiz! 👋\n\nAqui é o suporte do ProTudo.\nPode confirmar o endereço do seu pedido?'
  const a1 = await avulsa('AAAA1', TEXTO)
  const [l1] = await linhas()
  ok(a1.status === 200 && a1.body.para === 'Luiz Melo' && a1.body.telefone === '+55 34 *****-1747' && a1.body.status === 'fila' && !JSON.stringify(a1.body).includes('99889'),
     'resposta { para, telefone mascarado, status: fila } — o número inteiro não sai', a1.body)
  ok(l1 && l1.tipo === 'avulsa' && l1.status === 'fila' && l1.texto === TEXTO && l1.usuario_id === DONO && l1.telefone === TEL && l1.ref_tabela === 'reparos' && l1.ref_id === R1 && l1.sandbox === false,
     'UMA linha na fila: tipo avulsa, texto exatamente como veio, para o dono do pedido', l1 && [l1.tipo, l1.telefone, l1.ref_tabela])

  const rep = await avulsa('aaaa1', `  ${TEXTO}  `), repObra = await avulsa('ffff6', TEXTO)
  ok(rep.status === 409 && rep.body.status === 'duplicada' && repObra.status === 409 && (await linhas()).length === 1,
     'mesmo texto para a mesma pessoa em 24 h (mesmo por outro pedido dela) → 409 duplicada, nada novo na fila', [rep.body.status, repObra.body.status])
  const outra = await avulsa('#ffff6', 'Outro assunto: sua obra.')
  const l2 = (await linhas())[1]
  ok(outra.status === 200 && l2 && l2.ref_tabela === 'obras' && l2.ref_id === O1 && l2.texto === 'Outro assunto: sua obra.', 'texto diferente entra; obra pelo código em minúsculas (e com #)', outra.body)
  const mm = (await chamar('get', '/admin/whatsapp/mensagens', { query: { status: 'fila' } })).body
  ok(mm.total === 2 && mm.mensagens.every(x => x.itens_count === 1) && (await chamar('get', '/admin/whatsapp/status')).body.na_fila === 2,
     'painel: duas avulsas na fila para a mesma pessoa são DUAS mensagens', [mm.total])

  // ═══════════ FILA ═══════════
  for (const t of ['teste', 'pergunta_sem_resposta', 'novo_interessado', 'avulsa']) await config(`whatsapp_tipo_${t}`, 'false')
  await config('whatsapp_pausado', 'true')
  const pausado = await passo(em(0))
  await config('whatsapp_pausado', 'false')
  const noite = await passo(em(13 * 60))   // 21:30 em São Paulo
  ok(pausado.motivo === 'pausado' && noite.motivo === 'fora_do_horario' && f.enviados.length === 0, 'pausa global e fora da janela 08–21h: nada sai', [pausado.motivo, noite.motivo])
  const s1 = await passo(em(1))
  ok(s1.enviou && f.enviados.length === 1 && f.enviados[0].texto === TEXTO && f.enviados[0].jid === JID && f.consultas[0] === TEL,
     'todos os tipos desligados (até a chave whatsapp_tipo_avulsa): a avulsa sai assim mesmo, texto exato, para o JID do onWhatsApp', [s1.motivo, f.enviados[0] && f.enviados[0].jid])
  const s2 = await passo(em(2))
  const env2 = await linhas(`status = 'enviada'`)
  ok(s2.enviou && f.enviados.length === 2 && f.enviados[1].texto === 'Outro assunto: sua obra.' && env2.length === 2 && env2.every(x => x.agrupada_em === null && x.wa_message_id),
     'a segunda avulsa sai sozinha (não agrupa) e sem esperar as 3 h por pessoa', [s2.motivo, f.enviados.length])
  const s3 = await passo(em(3))
  ok(s3.motivo === 'tipos_desligados' && !s3.enviou, 'fila vazia com os tipos desligados: motivo continua "tipos_desligados"', s3.motivo)

  const tipos = (await chamar('get', '/admin/whatsapp/tipos')).body.tipos
  const put = await chamar('put', '/admin/whatsapp/tipos', { body: { tipo: 'avulsa', ligado: false } })
  ok(tipos.map(x => x.tipo).join() === 'pergunta_sem_resposta,novo_interessado,prazo_acabando,escolhido,horario_aguardando,teste' && put.status === 400,
     'painel /tipos: avulsa não aparece no liga/desliga e não aceita PUT', [tipos.length, put.status])

  // dedupe: depois de enviada continua valendo; 25 h depois, ou se falhou, entra de novo.
  const rep2 = await avulsa('AAAA1', TEXTO)
  await q(`UPDATE whatsapp_mensagens SET criado_em = NOW() - INTERVAL '25 hours' WHERE id = $1`, [l1.id])
  const depois = await avulsa('AAAA1', TEXTO)
  await q(`UPDATE whatsapp_mensagens SET status = 'falha' WHERE id = $1`, [depois.body.id])
  const aposFalha = await avulsa('AAAA1', TEXTO)
  ok(rep2.status === 409 && depois.status === 200 && aposFalha.status === 200, 'dedupe: já enviada há menos de 24 h → 409; depois de 24 h entra; a que falhou não conta', [rep2.status, depois.status, aposFalha.status])
  await q(`DELETE FROM whatsapp_mensagens WHERE status IN ('fila', 'falha')`)
  await q(`UPDATE whatsapp_mensagens SET criado_em = NOW() WHERE id = $1`, [l1.id])

  // ═══════════ VOLTA ═══════════
  // Uma pergunta de profissional enviada ANTES das avulsas e ainda sem resposta.
  await q(`INSERT INTO perguntas_demanda (id, tipo, demanda_id, autor_id, pergunta) VALUES ($1, 'reparo', $2, $3, 'Tem tinta aí?')`, [P(1), R1, PROF])
  await q(`INSERT INTO whatsapp_mensagens (tipo, usuario_id, telefone, texto, ref_tabela, ref_id, status, wa_jid, wa_message_id, enviada_em)
           VALUES ('pergunta_sem_resposta', $1, $2, 'pergunta', 'perguntas_demanda', $3, 'enviada', $4, 'WAQ', $5::timestamptz)`, [DONO, TEL, P(1), JID, em(-60).toISOString()])
  const respondidas = []
  const responder = async (a) => { respondidas.push(a); return { status: 200, body: { resposta: a.resposta } } }
  let nIn = 0
  const recebe = async (extra) => {
    const id = `IN${++nIn}`
    await registrarRecebida(shim, { id, jid: JID, telefone: TEL_WA, texto: '', quando: new Date(), ...extra })
    await SP.processarRecebidas({ responder }, shim)
    return (await q(`SELECT * FROM whatsapp_recebidas WHERE wa_message_id = $1`, [id])).rows[0]
  }
  const linha = async (id) => (await q(`SELECT * FROM whatsapp_mensagens WHERE id = $1`, [id])).rows[0]

  const r1 = await recebe({ texto: 'Rua das Flores, 120' })
  const dep1 = await linha(l2.id)
  ok(r1.resultado === 'avulsa (guardada)' && String(r1.mensagem_ref) === String(l2.id) && dep1.status === 'respondida' && dep1.resposta === 'Rua das Flores, 120' && dep1.respondida_em
     && respondidas.length === 0 && (await linhas(`tipo = 'resposta'`)).length === 0,
     'resposta sem citar: fica na ÚLTIMA avulsa (painel), não vira resposta da pergunta antiga e o robô não responde nada', [r1.resultado, dep1.status, respondidas.length])
  await recebe({ texto: 'Bairro Centro' })
  await recebe({ texto: '', midia: 'audio' })
  ok((await linha(l2.id)).resposta === 'Rua das Flores, 120\nBairro Centro\n(audio)', 'mensagens seguintes somam na mesma linha (áudio vira "(audio)")', (await linha(l2.id)).resposta)
  const r2 = await recebe({ texto: 'sobre a primeira: pode sim', citada: f.enviados[0].id })
  const dep2 = await linha(l1.id)
  ok(r2.resultado === 'avulsa (guardada)' && dep2.status === 'respondida' && dep2.resposta === 'sobre a primeira: pode sim', 'resposta CITANDO uma avulsa vai para a avulsa citada', [r2.resultado, dep2.resposta])
  const r3 = await recebe({ texto: 'tenho tinta sim', citada: 'WAQ' })
  ok(r3.resultado === 'entregue' && respondidas.length === 1 && respondidas[0].perguntaId === P(1) && respondidas[0].resposta === 'tenho tinta sim',
     'citar a PERGUNTA continua respondendo a pergunta no app', [r3.resultado, respondidas.length])

  const lista = (await chamar('get', '/admin/whatsapp/mensagens', { query: { tipo: 'avulsa' } })).body
  const m1 = lista.mensagens.find(x => String(x.id) === String(l1.id)), m2 = lista.mensagens.find(x => String(x.id) === String(l2.id))
  ok(lista.total === 2 && m1.resumo === 'Mensagem avulsa (painel) · AAAA1 “Entregar panfletos”' && m1.status === 'respondida' && m1.resposta === 'sobre a primeira: pode sim'
     && m1.texto === TEXTO && m1.usuario_nome === 'Luiz Melo' && m1.papel === 'dono' && m2.codigo === 'FFFF6' && m2.resposta.startsWith('Rua das Flores'),
     'painel /mensagens: a avulsa aparece com resumo do pedido, texto, status e a resposta da pessoa', m1 && [m1.resumo, m1.status])
  const ct = (await chamar('get', '/admin/whatsapp/contadores')).body
  ok(ct.por_tipo.avulsa && ct.por_tipo.avulsa.sete_dias.respondida === 2, '/contadores: avulsa conta como os demais tipos', ct.por_tipo.avulsa && ct.por_tipo.avulsa.sete_dias)

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
