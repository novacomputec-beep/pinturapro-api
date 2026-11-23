#!/usr/bin/env node
// ROBÔ DE WHATSAPP — tipo 'especialidade_rara' (23/11/2026). Adaptador FALSO (nada sai de verdade)
// e ESQUEMA DE PRODUÇÃO (PGlite). Cobre:
//   gatilho (tipo ligado, pausa, janela 08–21h, trava do worker); pedido aberto SEM interessado, no
//   último quarto do prazo e com 1 h ou mais; especialidade com 1 a 15 profissionais ativos no
//   alcance (16 → não é rara); até 5 por pedido, os mais próximos primeiro; fora quem viu o pedido,
//   respondeu SAIR, não tem telefone, é de longe, está sem assinatura; 1 aviso por profissional a
//   cada 24 h; nunca duas vezes o mesmo pedido; obra pelas especialidades inferidas;
//   texto aprovado ("Termina em…" da hora do envio, rodapé do SAIR só na primeira mensagem);
//   pedido que ganhou interessado antes do envio → sai da fila sem enviar; painel /tipos.
//   npm i -D @electric-sql/pglite && node scripts/testar-whatsapp-especialidade-rara.js
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
const logOrig = console.log, errOrig = console.error
console.log = () => {} // o boot do geoBusca fala
const C = require(path.join(REPO, 'src/whatsapp/config'))
const T = require(path.join(REPO, 'src/whatsapp/textos'))
const F = require(path.join(REPO, 'src/whatsapp/fila'))
const { migrarWhatsapp } = require(path.join(REPO, 'src/whatsapp/migracao'))
const { registrarRecebida } = require(path.join(REPO, 'src/whatsapp/entrada'))
const SR = require(path.join(REPO, 'src/services/whatsappEspecialidadeRaraService'))
const SP = require(path.join(REPO, 'src/services/whatsappPerguntasService'))
const rotasAdmin = require(path.join(REPO, 'src/routes/adminWhatsapp'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`

const criarFalso = () => {
  const f = {
    enviados: [], n: 0,
    conectar: async () => {}, desconectar: async () => {},
    estado: () => ({ conexao: 'conectado', qr: null, numero: '+5534900000000' }),
    existeNoWhatsapp: async (tel) => { const d = tel.slice(1); return { existe: true, jid: `${d.length === 13 ? d.slice(0, 4) + d.slice(5) : d}@s.whatsapp.net` } },
    enviarTexto: async (jid, texto) => { const id = `WA${++f.n}`; f.enviados.push({ jid, texto, id }); return { id } },
    aoReceber() {}, aoAtualizarStatus() {}, aoMudarEstado() {},
  }
  return f
}
const ENV = { WHATSAPP_SOMENTE_PARA: 'TODOS' }
// Relógio do robô: agora, se já é horário de envio em São Paulo; senão as próximas 08:30 (os
// pedidos do teste vencem daqui a 20 h, então continuam abertos nesse instante).
const REAL = new Date()
let AGORA = REAL
if (!C.dentroDaJanela(REAL)) { AGORA = new Date(REAL); AGORA.setUTCHours(11, 30, 0, 0); if (AGORA <= REAL) AGORA = new Date(AGORA.getTime() + 24 * 3600000) }
const NOITE = new Date(AGORA); NOITE.setUTCHours(2, 0, 0, 0) // 23:00 em São Paulo
const SAIR = '\n_Para não receber mais avisos, responda SAIR._'
// Patos de Minas; cada 0,009° de latitude ≈ 1 km.
const LAT = -18.5789, LNG = -46.5181
const tel = (n) => `349${String(90000000 + n)}`

const DONO = U(900)
const R1 = D(1), R_COMUM = D(2), R_COM_INTERESSE = D(3), R_CEDO = D(4), R_NO_FIM = D(5), R_OUTROS = D(6), R7 = D(7), R8 = D(8), O1 = D(11)

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT')

  const usr = async (id, nome, role, extra = {}) => {
    const cols = { id, nome, email: `${id.slice(-5)}@x.invalid`, role, cpf_cnpj: id.slice(-11), ativo: true, cidade: 'Patos de Minas', uf: 'MG', ...extra }
    const ks = Object.keys(cols)
    await q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => cols[k]))
  }
  // Profissional n: a `km` quilômetros do pedido, com assinatura ativa (a menos de semAssinatura).
  const prof = async (n, nome, especialidades, km, extra = {}, { semAssinatura = false } = {}) => {
    await usr(U(n), nome, 'prestador', { tipo_prestador: 'reparador', especialidades, telefone: tel(n), latitude: LAT + km * 0.009, longitude: LNG, ...extra })
    if (!semAssinatura) await q(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [U(n)])
  }
  await usr(DONO, 'Luiz Melo', 'dono_obra', { telefone: '34998891747' })
  await prof(1, 'Ana Lima', ['vidraceiro'], 1)
  await prof(2, 'Beto Reis', ['vidraceiro', 'eletrica'], 2)                    // já VIU o R1 no feed
  await prof(3, 'Caio Luz', ['vidraceiro'], 3, { whatsapp_avisos: false })     // respondeu SAIR
  await prof(4, 'Dora Sá', ['vidraceiro'], 4, { telefone: null })              // sem telefone
  await prof(5, 'Enzo Dias', ['vidraceiro'], 5)
  await prof(6, 'Fábio Maia', ['vidraceiro'], 6)
  await prof(7, 'Gil Costa', ['vidraceiro'], 7)
  await prof(8, 'Hugo Paz', ['vidraceiro'], 8)
  await prof(9, 'Íris Melo', ['vidraceiro'], 9)                                // o 6º mais perto: fica de fora do R1
  await prof(10, 'Jair Longe', ['vidraceiro'], 200, { cidade: 'Uberlândia' })  // fora do alcance
  await prof(11, 'Kátia Sem', ['vidraceiro'], 0.5, {}, { semAssinatura: true }) // sem assinatura ativa
  await prof(12, 'Leo Tudo', ['outros'], 0.2)                                  // faz-tudo: não é a especialidade exata
  for (let n = 20; n < 36; n++) await prof(n, `Eletricista ${n}`, ['eletrica'], 1 + n / 10) // 16 + Beto = 17 de elétrica
  await prof(40, 'Marta Gesso', ['gesseiro'], 3)
  await prof(41, 'Nilo Gesso', ['gesseiro'], 25, { cidade: 'Lagoa Formosa' })  // cidade vizinha, dentro de 50 km

  // criadoHa / expiraEm em horas. Padrão: aberto há 30 dias, vence em 20 h (último quarto, mais de 1 h).
  const pedido = (t, id, titulo, codigo, extra = {}, { criadoHa = 24 * 30, expiraEm = 20 } = {}) => {
    const cols = { id, titulo, descricao: 'x', cidade: 'Patos de Minas', uf: 'MG', latitude: LAT, longitude: LNG, criado_por: DONO, status: 'aberta', status_aprovacao: 'aprovada', codigo_publico: codigo,
      ...(t === 'reparos' ? { categoria: 'vidraceiro' } : { categoria: 'residencial' }), ...extra }
    const ks = Object.keys(cols)
    return q(`INSERT INTO ${t} (${ks.join(', ')}, criado_em, expira_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, now() - (${Number(criadoHa)} * INTERVAL '1 hour'), now() + (${Number(expiraEm)} * INTERVAL '1 hour'))`, ks.map(k => cols[k]))
  }
  const fila = async (where = 'true') => (await q(`SELECT * FROM whatsapp_mensagens WHERE ${where} ORDER BY id`)).rows
  const config = (chave, valor) => q(`WITH u AS (UPDATE configuracoes SET valor = $2 WHERE chave = $1 RETURNING 1) INSERT INTO configuracoes (chave, valor) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM u)`, [chave, valor])
  const f = criarFalso()
  const passo = (agora = AGORA) => F.processarProxima({ db: shim, adaptador: f, agora, env: ENV })
  const job = (agora = AGORA) => SR.enfileirarEspecialidadeRara(shim, { agora })
  const ultimo = () => f.enviados[f.enviados.length - 1]
  const nomes = (linhas) => linhas.map(l => l.dados.primeiro_nome).join()

  // ═══════════ TEXTO (função pura) E CONFIG ═══════════
  ok(['45 min', '1 h', '3 h 20 min', '1 dia', '2 dias e 5 h', '1 min'].join() ===
     [45, 60, 200, 24 * 60 + 30, 53 * 60 + 10, 0].map(m => T.tempoRestante(m * 60000)).join(), 'tempo restante: "45 min", "1 h", "3 h 20 min", "1 dia", "2 dias e 5 h"')
  const base = new Date('2026-11-23T15:00:00Z')
  const exemplo = { primeiro_nome: 'Ana', rotulo: 'Vidraceiro', titulo: 'Trocar o vidro da janela', codigo: 'AAAA1', expira_em: '2026-11-23T17:30:00Z' }
  const TEXTO = 'Oi, Ana! 👋 Aqui é o *ProTudo*.\nTem um pedido de *Vidraceiro* perto de você ainda sem ninguém: *"Trocar o vidro da janela"*.\n⏰ Termina em 2 h 30 min.\n👉 Veja e mande sua proposta: protudo.app.br/p/AAAA1'
  ok(T.textoEspecialidadeRara(exemplo, { agora: base }) === TEXTO && T.textoEspecialidadeRara(exemplo, { agora: base, primeira: true }) === TEXTO + SAIR, 'texto aprovado; rodapé do SAIR só na primeira mensagem', T.textoEspecialidadeRara(exemplo, { agora: base }))
  const def = C.TIPOS.especialidade_rara
  ok(def.padrao === false && def.implementado === true && !def.limitePorPessoa && C.RARA_MAX_PROFISSIONAIS === 15 && C.RARA_MAX_AVISOS_POR_PEDIDO === 5 && SR.INTERVALO_MS === 15 * 60000,
     'config: implementado, desligado por padrão, 15 profissionais, 5 por pedido, job de 15 min')
  ok(SR.rotuloDaEspecialidade('vidraceiro') === 'Vidraceiro' && SR.rotuloDaEspecialidade('pedreiro_servente') === 'Pedreiro/servente' && SR.rotuloDaEspecialidade('coisa_nova') === 'coisa nova', 'rótulo da especialidade (serviço, construção, desconhecida)')

  // ═══════════ GATILHO ═══════════
  await pedido('reparos', R1, 'Trocar o vidro da janela', 'AAAA1', {}, { expiraEm: 20 })
  await q(`INSERT INTO feed_visualizacoes (usuario_id, item_tipo, item_id) VALUES ($1, 'reparo', $2)`, [U(2), R1])
  await pedido('reparos', R_COMUM, 'Trocar tomada', 'BBBB2', { categoria: 'eletrica' })                       // 17 eletricistas: não é rara
  await pedido('reparos', R_COM_INTERESSE, 'Vidro do box', 'CCCC3')
  await q(`INSERT INTO interesse_reparos (reparo_id, usuario_id) VALUES ($1, $2)`, [R_COM_INTERESSE, U(12)])  // já tem interessado
  await pedido('reparos', R_CEDO, 'Vidro da porta', 'DDDD4', {}, { criadoHa: 10, expiraEm: 20 })              // fora do último quarto
  await pedido('reparos', R_NO_FIM, 'Vidro do carro', 'EEEE5', {}, { expiraEm: 0.9 })                         // menos de 1 h
  await pedido('reparos', R_OUTROS, 'Qualquer coisa', 'FFFF6', { categoria: 'outros' })                       // 'outros' não é ofício

  let e = await job()
  ok(e.enfileiradas === 0 && e.motivo === 'tipo_desligado' && (await fila()).length === 0, 'tipo desligado (padrão): nada entra na fila', e)
  await config(C.chaveTipo('especialidade_rara'), 'true')
  e = await job()
  ok(e.enfileiradas === 0 && e.motivo === 'sem_trava', 'sem a trava do worker: nada entra na fila', e)
  await q(`UPDATE whatsapp_estado SET trava = 'TODOS' WHERE id = 1`)
  e = await job(NOITE)
  ok(e.enfileiradas === 0 && e.motivo === 'fora_do_horario', 'fora da janela 08–21h: nada entra na fila', e)
  await config(C.CHAVE_PAUSADO, 'true')
  e = await job()
  ok(e.enfileiradas === 0 && e.motivo === 'pausado', 'robô pausado: nada entra na fila', e)
  await config(C.CHAVE_PAUSADO, 'false')

  e = await job()
  let linhas = await fila()
  ok(e.enfileiradas === 5 && nomes(linhas) === 'Ana,Enzo,Fábio,Gil,Hugo' && linhas.every(l => l.ref_id === R1 && l.ref_tabela === 'reparos' && l.tipo === 'especialidade_rara' && l.status === 'fila'),
     'R1: 5 avisos, os mais próximos primeiro — fora quem viu (Beto), saiu (Caio), não tem telefone (Dora), está longe, sem assinatura ou é faz-tudo; o 6º (Íris) não entra', nomes(linhas))
  ok(linhas[0].usuario_id === U(1) && linhas[0].telefone === `+55${tel(1)}` && linhas[0].chave_dedupe === SR.chaveDoAviso('reparos', R1, U(1)) && linhas[0].dados.rotulo === 'Vidraceiro'
     && linhas[0].dados.codigo === 'AAAA1' && linhas[0].dados.km === 1 && /Termina em 19 h 5\d min|Termina em \d+ h/.test(linhas[0].texto),
     'linha da fila: conta, telefone, chave de dedupe e dados para o worker redigir', linhas[0].dados)
  ok(!linhas.some(l => [R_COMUM, R_COM_INTERESSE, R_CEDO, R_NO_FIM, R_OUTROS].includes(l.ref_id)),
     'não entram: especialidade com 17 profissionais, pedido com interessado, fora do último quarto, com menos de 1 h, só "outros"')
  e = await job()
  ok(e.enfileiradas === 0 && (await fila()).length === 5, 'job de novo: o pedido já tem os seus 5 — nada novo', e)

  // Outro pedido de vidraceiro: quem já tem aviso na fila/24 h não recebe outro; Beto (não viu ESTE) e Íris recebem.
  await pedido('reparos', R7, 'Espelho do banheiro', 'GGGG7', {}, { expiraEm: 21 })
  e = await job()
  linhas = await fila(`ref_id = '${R7}'`)
  ok(e.enfileiradas === 2 && nomes(linhas) === 'Beto,Íris', 'R7: no máximo 1 aviso por profissional a cada 24 h — só Beto e Íris, que não tinham nenhum', nomes(linhas))

  // Obra: pelas especialidades inferidas; vizinho dentro do raio entra, mais perto primeiro.
  await pedido('obras', O1, 'Forro de gesso da sala', 'HHHH8', { especialidades_inferidas: ['gesseiro', 'outros'] })
  e = await job()
  linhas = await fila(`ref_id = '${O1}'`)
  ok(e.enfileiradas === 2 && nomes(linhas) === 'Marta,Nilo' && linhas[0].ref_tabela === 'obras' && linhas[0].dados.rotulo === 'Gesseiro' && linhas[1].dados.km > 20,
     'obra: especialidade inferida (gesseiro), cidade vizinha dentro do raio entra', linhas.map(l => [l.dados.primeiro_nome, l.dados.km]))

  // ═══════════ ENVIO (worker) ═══════════
  let r = await passo(NOITE)
  ok(!r.enviou && r.motivo === 'fora_do_horario' && f.enviados.length === 0, 'worker fora da janela 08–21h: nada sai', r.motivo)
  r = await passo()
  const expira = (await q(`SELECT expira_em FROM reparos WHERE id = $1`, [R1])).rows[0].expira_em
  const esperado = `Oi, Ana! 👋 Aqui é o *ProTudo*.\nTem um pedido de *Vidraceiro* perto de você ainda sem ninguém: *"Trocar o vidro da janela"*.\n⏰ Termina em ${T.tempoRestante(new Date(expira) - AGORA)}.\n👉 Veja e mande sua proposta: protudo.app.br/p/AAAA1${SAIR}`
  ok(r.enviou && f.enviados.length === 1 && ultimo().texto === esperado && ultimo().jid === `55${tel(1).slice(0, 2)}${tel(1).slice(3)}@s.whatsapp.net`,
     'sai UMA mensagem (Ana), com o texto aprovado, o tempo restante da hora do envio e o rodapé do SAIR (primeira mensagem do número)', ultimo() && ultimo().texto)
  const enviada = (await fila(`usuario_id = '${U(1)}'`))[0]
  ok(enviada.status === 'enviada' && enviada.texto === esperado && enviada.wa_message_id === 'WA1' && enviada.agrupada_em === null, 'registro como nos outros tipos: enviada, texto que saiu, id do WhatsApp')
  // Enzo já recebeu outra mensagem do robô antes: sem rodapé.
  await q(`INSERT INTO whatsapp_mensagens (tipo, telefone, texto, status, enviada_em) VALUES ('teste', $1, 'oi', 'enviada', now() - INTERVAL '3 days')`, [`+55${tel(5)}`])
  r = await passo()
  ok(r.enviou && f.enviados.length === 2 && ultimo().texto.startsWith('Oi, Enzo!') && !ultimo().texto.includes('SAIR'), 'cada linha é uma mensagem (nunca agrupada); quem já recebeu algo do robô não leva o rodapé', ultimo().texto)

  // O pedido ganhou um interessado antes do envio: o que resta dele sai da fila sem enviar.
  await q(`INSERT INTO interesse_reparos (id, reparo_id, usuario_id) VALUES ($1, $2, $3)`, [D(99), R1, U(12)])
  for (let i = 0; i < 6; i++) r = await passo()
  const depois = await fila()
  ok(f.enviados.length === 6 && !f.enviados.slice(2).some(m => /Fábio|Gil|Hugo/.test(m.texto)) && depois.filter(l => l.ref_id === R1).length === 2 && depois.every(l => l.status === 'enviada') && r.motivo === 'fila_vazia',
     'pedido ganhou interessado: Fábio, Gil e Hugo saem da fila sem envio; os de R7 e da obra saem normalmente', f.enviados.map(m => m.texto.slice(4, 9)))

  // Resposta do profissional ao aviso: fica guardada, o robô não puxa conversa.
  await registrarRecebida(shim, { id: 'IN1', jid: f.enviados[0].jid, telefone: `+${f.enviados[0].jid.split('@')[0]}`, texto: 'quanto paga?', quando: new Date() })
  await SP.processarRecebidas({ responder: async () => { throw new Error('não era para responder pergunta') } }, shim)
  const rec = (await q(`SELECT resultado FROM whatsapp_recebidas WHERE wa_message_id = 'IN1'`)).rows[0]
  ok(rec.resultado === 'sem_pergunta_pendente' && (await fila(`tipo = 'resposta'`)).length === 0, 'resposta ao aviso: guardada, sem resposta automática', rec)

  // ═══════════ 24 H E "UMA VEZ POR PEDIDO" ═══════════
  // O interessado desistiu: R1 volta a valer. Ana e Enzo JÁ receberam este pedido (nunca de novo);
  // Fábio, Gil e Hugo não chegaram a receber → entram. Beto e Íris receberam outro aviso há menos de 24 h.
  await q(`UPDATE interesse_reparos SET cancelado_em = now() WHERE id = $1`, [D(99)])
  e = await job()
  linhas = await fila(`status = 'fila'`)
  ok(e.enfileiradas === 3 && nomes(linhas) === 'Fábio,Gil,Hugo' && linhas.every(l => l.ref_id === R1), 'R1 sem interessado de novo: só quem ainda não tinha recebido (o pedido fica com os seus 5)', nomes(linhas))
  await q(`DELETE FROM whatsapp_mensagens WHERE status = 'fila'`)
  await q(`UPDATE reparos SET status = 'cancelada' WHERE id = ANY($1::uuid[])`, [[R1, R7]])
  await pedido('reparos', R8, 'Vidro da vitrine', 'JJJJ9', {}, { expiraEm: 22 })
  e = await job()
  linhas = await fila(`status = 'fila'`)
  ok(e.enfileiradas === 3 && nomes(linhas) === 'Fábio,Gil,Hugo', 'R8 no mesmo dia: Ana, Enzo, Beto e Íris já receberam um aviso nas últimas 24 h — ficam de fora', nomes(linhas))
  await q(`DELETE FROM whatsapp_mensagens WHERE status = 'fila'`)
  await q(`UPDATE whatsapp_mensagens SET enviada_em = now() - INTERVAL '25 hours' WHERE tipo = 'especialidade_rara'`)
  e = await job()
  linhas = await fila(`status = 'fila'`)
  ok(e.enfileiradas === 5 && nomes(linhas) === 'Ana,Beto,Enzo,Fábio,Gil', 'R8 passadas 24 h: os 5 mais próximos de novo (Ana, Beto, Enzo, Fábio, Gil)', nomes(linhas))

  // ═══════════ PAINEL ═══════════
  const pilha = (m, c) => rotasAdmin.stack.find(x => x.route && x.route.path === c && x.route.methods[m]).route.stack
  const chamar = (m, c, query = {}) => new Promise(resolve => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
    const p = pilha(m, c); p[p.length - 1].handle({ query, body: {}, params: {}, usuario: { id: U(99), role: 'admin' } }, res)
  })
  const tipos = (await chamar('get', '/admin/whatsapp/tipos')).body.tipos
  const er = tipos.find(x => x.tipo === 'especialidade_rara')
  ok(er && er.rotulo === '🔎 Especialidade rara' && er.implementado === true && er.ligado === true && typeof er.dica === 'string', 'painel /tipos: "🔎 Especialidade rara", implementado, com o liga/desliga dos outros tipos', er)
  const lista = (await chamar('get', '/admin/whatsapp/mensagens', { tipo: 'especialidade_rara', limit: '100' })).body
  const m1 = (lista.mensagens || []).find(x => x.codigo === 'AAAA1' && x.status === 'enviada')
  ok(m1 && m1.resumo.startsWith('🔎 Especialidade rara · AAAA1 '), 'painel /mensagens: o aviso aparece com o pedido, como os outros tipos', m1 && m1.resumo)

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
