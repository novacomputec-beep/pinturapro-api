#!/usr/bin/env node
// ROBÔ DE WHATSAPP — post automático no CANAL (23/11/2026). Adaptador FALSO (nada sai de verdade)
// e ESQUEMA DE PRODUÇÃO (PGlite). Cobre:
//   texto: cabeçalho, uma linha por pedido ("{emoji} {título} — {R$ valor | Aceita propostas} →
//   protudo.app.br/p/{codigo}"), mais recentes primeiro, no máximo 15, rodapé com o link; sem nome
//   nem telefone (nem o que o dono digitou no título);
//   API: chave canal_auto_ativo nasce desligada; 18:00 de São Paulo; só abertos, aprovados, sem
//   profissional escolhido, da cidade do canal; dia sem pedidos é pulado; um automático por dia;
//   worker: resolve o canal pelo convite, grava se o robô é admin, publica, registra hora/texto/
//   resultado; não admin, pausa, desconectado, sem trava, erro ao publicar (sem repetir), vencidos,
//   interrompidos; rotas do super-admin (preview, postar-agora, auto).
//   npm i -D @electric-sql/pglite && node scripts/testar-whatsapp-canal.js
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
const C = require(path.join(REPO, 'src/whatsapp/config'))
const { migrarWhatsapp } = require(path.join(REPO, 'src/whatsapp/migracao'))
const { criarCanal, recuperarPostsInterrompidos } = require(path.join(REPO, 'src/whatsapp/canal'))
const { canalDoMetadata } = require(path.join(REPO, 'src/whatsapp/adaptadorBaileys'))
const { montarPostCanal } = require(path.join(REPO, 'src/utils/canalResumo'))
const S = require(path.join(REPO, 'src/services/whatsappCanalService'))
const rotas = require(path.join(REPO, 'src/routes/adminWhatsapp'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const rota = (metodo, caminho) => rotas.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo]).route
const chamar = (metodo, caminho, { body = {}, query = {} } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  const pilha = rota(metodo, caminho).stack
  Promise.resolve(pilha[pilha.length - 1].handle({ body, query, params: {}, usuario: { id: U(99), role: 'admin' } }, res)).catch(e => resolve({ status: 599, body: { erro: e.message } }))
})

const CONVITE = '0029Vb9BoWT17En0RAOw8r1I', JID = '120363400000000001@newsletter'
const criarFalso = ({ papel = 'ADMIN' } = {}) => {
  const f = {
    papel, conexao: 'conectado', posts: [], resolucoes: [], falharPost: null, falharResolver: null, n: 0,
    conectar: async () => {}, desconectar: async () => {},
    estado: () => ({ conexao: f.conexao, qr: null, numero: '+5534900000000' }),
    existeNoWhatsapp: async () => ({ existe: false, jid: null }),
    enviarTexto: async () => { throw new Error('o canal não manda mensagem direta') },
    resolverCanal: async (c) => {
      f.resolucoes.push(c)
      if (f.falharResolver) throw new Error(f.falharResolver)
      return canalDoMetadata({ id: JID, thread_metadata: { name: { text: 'ProTudo Patos de Minas' }, subscribers_count: '321' }, viewer_metadata: { role: f.papel } })
    },
    postarNoCanal: async (jid, texto) => { if (f.falharPost) throw new Error(f.falharPost); const id = `NL${++f.n}`; f.posts.push({ jid, texto, id }); return { id } },
    aoReceber() {}, aoAtualizarStatus() {}, aoMudarEstado() {},
  }
  return f
}
const mudo = { log() {}, error() {} }
const ENV = { WHATSAPP_SOMENTE_PARA: '+5534998891747', WHATSAPP_CANAL_CONVITE: CONVITE }
// Hora de São Paulo (UTC−3) de um dia fixo.
const sp = (dia, hora, min = 0) => new Date(`${dia}T${String(hora).padStart(2, '0')}:${String(min).padStart(2, '0')}:00-03:00`)
const DIA1 = '2026-11-23', DIA2 = '2026-11-24', DIA3 = '2026-11-25', DIA4 = '2026-11-26'

const main = async () => {
  // ═══════════ TEXTO (puro) ═══════════
  const itens = [
    { tipo: 'reparo', titulo: 'trocar torneira da cozinha', categoria: 'encanador', valor: '150.00', criado_em: '2026-11-23T10:00:00Z', codigo_publico: 'AAAA2' },
    { tipo: 'obra', titulo: 'Pintar a sala', categoria: 'pintura', valor: null, criado_em: '2026-11-23T12:00:00Z', codigo_publico: 'BBBB3' },
    { tipo: 'reparo', titulo: 'Ligar para *João* (34) 99889-1747 ou 34998891747', categoria: 'x', valor: 0, criado_em: '2026-11-22T12:00:00Z', codigo_publico: 'CCCC4' },
  ]
  const t = montarPostCanal({ cidade: 'Patos de Minas', itens })
  const ls = t.texto.split('\n')
  ok(ls[0] === '📋 Pedidos abertos hoje em Patos de Minas' && ls[1] === '', 'cabeçalho "📋 Pedidos abertos hoje em Patos de Minas"', ls[0])
  ok(/^\S+ Pintar a sala — Aceita propostas → protudo\.app\.br\/p\/BBBB3$/.test(ls[2]), 'mais recente primeiro; sem valor → "Aceita propostas"', ls[2])
  ok(/^\S+ Trocar torneira da cozinha — R\$ 150 → protudo\.app\.br\/p\/AAAA2$/.test(ls[3]), 'linha "{emoji} {título} — R$ valor → protudo.app.br/p/{codigo}"', ls[3])
  ok(!/\d{4}/.test(ls[4].split(' → ')[0]) && ls[4].includes('Aceita propostas') && !t.texto.includes('*'), 'telefone digitado no título é retirado; valor 0 → "Aceita propostas"', ls[4])
  ok(ls[ls.length - 3] === '' && ls[ls.length - 2] === 'Baixe o ProTudo gratuito e mande sua proposta! 👇' && ls[ls.length - 1] === 'https://protudo.app.br/baixar', 'rodapé + link para baixar', ls.slice(-2))
  const muitos = Array.from({ length: 20 }, (_, i) => ({ tipo: 'reparo', titulo: `Pedido ${i}`, valor: 10 + i, criado_em: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(), codigo_publico: 'AAAA2' }))
  const tm = montarPostCanal({ cidade: 'Patos de Minas', itens: muitos })
  const lm = tm.texto.split('\n').filter(l => l.includes(' — '))
  ok(lm.length === 15 && tm.total === 20 && tm.exibidos === 15 && lm[0].includes('Pedido 19') && lm[14].includes('Pedido 5'), 'no máximo 15 linhas, as mais recentes', [lm.length, tm.total])
  ok(montarPostCanal({ cidade: 'Patos de Minas', itens: [] }).texto === null, 'sem pedidos → sem texto')
  ok(C.lerConviteCanal({ WHATSAPP_CANAL_CONVITE: CONVITE })?.chave === CONVITE && C.lerConviteCanal({ WHATSAPP_CANAL_CONVITE: `https://whatsapp.com/channel/${CONVITE}` })?.chave === CONVITE &&
     C.lerConviteCanal({ WHATSAPP_CANAL_CONVITE: JID })?.tipo === 'jid' && C.lerConviteCanal({}) === null && C.lerConviteCanal({ WHATSAPP_CANAL_CONVITE: 'a b' }) === null,
     'WHATSAPP_CANAL_CONVITE: código, link inteiro ou JID; ausente/inválida → null')
  const m1 = canalDoMetadata({ id: JID, thread_metadata: { name: { text: 'X' } }, viewer_metadata: { role: 'OWNER' } }), m2 = canalDoMetadata({ id: JID, viewer_metadata: { role: 'SUBSCRIBER' } }), m3 = canalDoMetadata({ id: JID, name: 'Y' })
  ok(m1.admin === true && m1.nome === 'X' && m2.admin === false && m3.admin === null && m3.nome === 'Y', 'papel OWNER/ADMIN = admin; SUBSCRIBER = não; sem papel = desconhecido', [m1, m2, m3])

  // ═══════════ BANCO ═══════════
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await q('BEGIN'); await migrarWhatsapp(shim); await migrarWhatsapp(shim); await q('COMMIT')
  ok((await q(`SELECT valor FROM configuracoes WHERE chave = 'canal_auto_ativo'`)).rows[0]?.valor === 'false', 'canal_auto_ativo nasce desligada (migração idempotente)')
  const config = (chave, valor) => q(`UPDATE configuracoes SET valor = $2 WHERE chave = $1`, [chave, valor])
  const posts = async (where = 'true') => (await q(`SELECT *, to_char(dia, 'YYYY-MM-DD') AS dia_txt FROM whatsapp_canal_posts WHERE ${where} ORDER BY id`)).rows
  const estado = async () => (await q(`SELECT * FROM whatsapp_estado WHERE id = 1`)).rows[0]
  await q(`UPDATE whatsapp_estado SET conexao = 'conectado', heartbeat_em = NOW() WHERE id = 1`)
  const cols = { id: U(1), nome: 'Luiz Dono Secreto', email: 'dono@x.invalid', role: 'dono_obra', telefone: '(34) 99889-1747', cpf_cnpj: '00000000001', ativo: true }
  await q(`INSERT INTO usuarios (${Object.keys(cols).join(', ')}) VALUES (${Object.keys(cols).map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(cols))
  const pedido = (tabela, n, titulo, codigo, extra = {}) => {
    const c = { id: D(n), titulo, criado_por: U(1), status: 'aberta', status_aprovacao: 'aprovada', codigo_publico: codigo, cidade: 'Patos de Minas', uf: 'MG',
      [tabela === 'reparos' ? 'valor_estimado' : 'valor']: 100 + n, criado_em: new Date(Date.UTC(2026, 10, 20, n)).toISOString(), ...extra }
    const ks = Object.keys(c)
    return q(`INSERT INTO ${tabela} (${ks.join(', ')}, expira_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, now() + INTERVAL '30 days')`, ks.map(k => c[k]))
  }

  // ═══════════ API: agendamento das 18:00 ═══════════
  const a0 = await S.agendarPostAutomatico({ agora: sp(DIA1, 18, 5) })
  ok(a0.motivo === 'desligado' && (await posts()).length === 0, 'chave desligada: às 18:05 nada é criado', a0)
  await config('canal_auto_ativo', 'true')
  const a1 = await S.agendarPostAutomatico({ agora: sp(DIA1, 17, 59) }), a2 = await S.agendarPostAutomatico({ agora: sp(DIA1, 21, 0) })
  ok(a1.motivo === 'fora_do_horario' && a2.motivo === 'fora_do_horario' && (await posts()).length === 0, 'chave ligada: 17:59 e 21:00 ficam fora (18:00 até o fim da janela)', [a1, a2])
  const a3 = await S.agendarPostAutomatico({ agora: sp(DIA1, 18, 0) })
  const [p1] = await posts()
  ok(a3.motivo === 'pulado' && p1.status === 'pulado' && p1.origem === 'auto' && p1.dia_txt === DIA1 && p1.texto === null && p1.total === 0, 'dia SEM pedidos: registrado como pulado, sem texto', [a3, p1.status, p1.dia_txt])
  await pedido('reparos', 1, 'Trocar torneira', 'AAAA2')
  const a4 = await S.agendarPostAutomatico({ agora: sp(DIA1, 18, 30) })
  ok(a4.motivo === 'ja_feito' && (await posts()).length === 1, 'pedido que chega depois não gera segundo automático no mesmo dia', a4)

  await pedido('obras', 2, 'Pintar a sala', 'BBBB3', { valor: null, valor_a_combinar: true })
  await pedido('reparos', 3, 'Com profissional escolhido', 'CCCC4', { match_usuario_id: U(1) })
  await pedido('reparos', 4, 'Ainda em aprovação', 'DDDD5', { status_aprovacao: 'pendente' })
  await pedido('reparos', 5, 'Cancelado', 'EEEE6', { status: 'cancelada' })
  await pedido('reparos', 6, 'De Uberlândia', 'FFFF7', { cidade: 'Uberlândia' })
  await pedido('obras', 7, 'Obra em outra cidade', 'GGGG8', { cidade: 'Uberaba' })
  const [a5, a6] = await Promise.all([S.agendarPostAutomatico({ agora: sp(DIA2, 18, 0) }), S.agendarPostAutomatico({ agora: sp(DIA2, 18, 0) })])
  const dia2 = await posts(`dia = '${DIA2}'`)
  ok(dia2.length === 1 && [a5.motivo, a6.motivo].sort().join() === 'agendado,ja_feito' && dia2[0].status === 'pendente' && dia2[0].total === 2, 'dois tiques ao mesmo tempo (réplicas): UMA linha no dia', [a5.motivo, a6.motivo])
  const txt = dia2[0].texto
  ok(txt.includes('Pintar a sala — Aceita propostas → protudo.app.br/p/BBBB3') && txt.includes('Trocar torneira — R$ 101 → protudo.app.br/p/AAAA2') && txt.indexOf('Pintar a sala') < txt.indexOf('Trocar torneira'),
     'texto: obra a combinar e reparo com valor, mais recente primeiro', txt)
  ok(!/escolhido|aprovação|Cancelado|Uberl|outra cidade/.test(txt), 'fora: com profissional escolhido, não aprovado, cancelado e de outra cidade')
  ok(!/Luiz|Secreto|99889|1747|x\.invalid/.test(txt), 'nenhum nome, telefone ou e-mail no texto')

  // ═══════════ WORKER ═══════════
  const f = criarFalso()
  const canal = criarCanal({ db: shim, adaptador: f, env: ENV, log: mudo })
  await config('whatsapp_pausado', 'true')
  const w0 = await canal.passo({ agora: sp(DIA2, 18, 1) })
  const e0 = await estado()
  ok(f.resolucoes.length === 1 && f.resolucoes[0].tipo === 'invite' && f.resolucoes[0].chave === CONVITE && e0.canal_jid === JID && e0.canal_nome === 'ProTudo Patos de Minas' && e0.canal_papel === 'ADMIN' && e0.canal_admin === true && e0.canal_erro === null && e0.canal_convite === CONVITE,
     'canal resolvido pelo convite; estado guarda JID, nome e que o robô é admin', [e0.canal_jid, e0.canal_papel, e0.canal_admin])
  ok(w0.motivo === 'pausado' && f.posts.length === 0 && (await posts(`dia = '${DIA2}'`))[0].status === 'pendente', 'pausa global: nada é publicado, a linha espera', w0)
  await config('whatsapp_pausado', 'false')
  f.conexao = 'conectando'
  const w1 = await canal.passo({ agora: sp(DIA2, 18, 2) })
  ok(w1.motivo === 'desconectado' && f.posts.length === 0, 'desconectado: nada é publicado', w1)
  f.conexao = 'conectado'
  const w2 = await canal.passo({ agora: sp(DIA2, 18, 3) })
  const [pp] = await posts(`dia = '${DIA2}'`)
  ok(w2.postou && f.posts.length === 1 && f.posts[0].jid === JID && f.posts[0].texto === txt, 'publica no JID do canal o texto exato da linha', w2)
  ok(pp.status === 'postado' && pp.wa_message_id === 'NL1' && pp.canal_jid === JID && pp.erro === null && new Date(pp.postado_em).getTime() === sp(DIA2, 18, 3).getTime() && pp.enviando_em === null,
     'registro: hora, texto e resultado (postado, id da mensagem)', [pp.status, pp.wa_message_id, pp.postado_em])
  ok(f.resolucoes.length === 2, 'depois de reconectar o canal é conferido de novo', f.resolucoes.length)
  const w3 = await canal.passo({ agora: sp(DIA2, 18, 4) })
  ok(w3.motivo === 'nada' && f.posts.length === 1 && f.resolucoes.length === 2, 'passo seguinte: nada a publicar, sem nova consulta ao WhatsApp', w3)
  const a7 = await S.agendarPostAutomatico({ agora: sp(DIA2, 19, 0) })
  ok(a7.motivo === 'ja_feito' && (await posts(`dia = '${DIA2}'`)).length === 1, 'no máximo um automático por dia', a7)

  // Robô NÃO admin.
  const fs2 = criarFalso({ papel: 'SUBSCRIBER' })
  const canal2 = criarCanal({ db: shim, adaptador: fs2, env: ENV, log: mudo })
  await S.agendarPostAutomatico({ agora: sp(DIA3, 18, 0) })
  const w4 = await canal2.passo({ agora: sp(DIA3, 18, 1) })
  const [p3] = await posts(`dia = '${DIA3}'`)
  const e3 = await estado()
  ok(w4.motivo === 'nao_admin' && fs2.posts.length === 0 && p3.status === 'falha' && /não é admin/.test(p3.erro) && e3.canal_admin === false && e3.canal_papel === 'SUBSCRIBER', 'robô não é admin do canal: nada é publicado, falha registrada, estado diz admin = false', [p3.erro, e3.canal_admin])
  const w5 = await canal.passo({ agora: sp(DIA3, 18, 2) }), a8 = await S.agendarPostAutomatico({ agora: sp(DIA3, 18, 3) })
  ok(w5.motivo === 'nada' && a8.motivo === 'ja_feito' && f.posts.length === 1, 'a falha do dia não é tentada de novo (no máximo um por dia)', [w5.motivo, a8.motivo])

  // Erro ao publicar, sem trava, sem convite, canal que não resolve.
  const manual = (agora) => q(`INSERT INTO whatsapp_canal_posts (origem, dia, cidade, texto, total, criado_em) VALUES ('manual', ($1::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date, 'Patos de Minas', 'texto manual', 1, $1::timestamptz) RETURNING id`, [agora.toISOString()]).then(r => r.rows[0].id)
  const um = async (id) => (await posts(`id = ${id}`))[0]
  f.falharPost = 'rate-overlimit'
  const idE = await manual(sp(DIA3, 22, 0))
  const w6 = await canal.passo({ agora: sp(DIA3, 22, 1) })
  f.falharPost = null
  const w7 = await canal.passo({ agora: sp(DIA3, 22, 2) })
  ok(w6.motivo === 'erro_ao_postar' && (await um(idE)).status === 'falha' && /rate-overlimit/.test((await um(idE)).erro) && w7.motivo === 'nada' && f.posts.length === 1, 'erro ao publicar: falha registrada e NÃO repetida', (await um(idE)).erro)
  const idT = await manual(sp(DIA3, 22, 3))
  const w8 = await criarCanal({ db: shim, adaptador: criarFalso(), env: { WHATSAPP_CANAL_CONVITE: CONVITE }, log: mudo }).passo({ agora: sp(DIA3, 22, 4) })
  ok(w8.motivo === 'sem_trava' && (await um(idT)).status === 'falha', 'worker sem WHATSAPP_SOMENTE_PARA não publica', (await um(idT)).erro)
  const idC = await manual(sp(DIA3, 22, 5))
  const fSem = criarFalso()
  const w9 = await criarCanal({ db: shim, adaptador: fSem, env: { WHATSAPP_SOMENTE_PARA: 'TODOS' }, log: mudo }).passo({ agora: sp(DIA3, 22, 6) })
  ok(w9.motivo === 'sem_canal' && fSem.resolucoes.length === 0 && /WHATSAPP_CANAL_CONVITE ausente/.test((await um(idC)).erro) && /ausente/.test((await estado()).canal_erro), 'sem WHATSAPP_CANAL_CONVITE: falha clara no registro e no estado', (await um(idC)).erro)
  const idR = await manual(sp(DIA3, 22, 7))
  const fRuim = criarFalso(); fRuim.falharResolver = 'not-found'
  const cRuim = criarCanal({ db: shim, adaptador: fRuim, env: ENV, log: mudo })
  const w10 = await cRuim.passo({ agora: sp(DIA3, 22, 8) })
  ok(w10.motivo === 'sem_canal' && fRuim.posts.length === 0 && /not-found/.test((await um(idR)).erro) && (await estado()).canal_jid === null, 'convite que não resolve: nada publicado, erro no registro e no estado', (await um(idR)).erro)
  fRuim.falharResolver = null
  await cRuim.passo({ agora: sp(DIA3, 22, 9) })
  const nAntes = fRuim.resolucoes.length
  await cRuim.passo({ agora: sp(DIA3, 22, 14) })
  ok(nAntes === 1 && fRuim.resolucoes.length === 2 && (await estado()).canal_admin === true, 'nova tentativa de resolver o canal só depois de 5 min', [nAntes, fRuim.resolucoes.length])

  // Manual fora da janela sai; automático fora da janela espera e vence no dia seguinte.
  const idM = await manual(sp(DIA3, 22, 20))
  const w11 = await canal.passo({ agora: sp(DIA3, 22, 21) })
  ok(w11.postou && (await um(idM)).status === 'postado' && f.posts[1].texto === 'texto manual', '"postar agora" sai mesmo fora da janela 08–21h', w11.motivo)
  await S.agendarPostAutomatico({ agora: sp(DIA4, 20, 59) })
  const w12 = await canal.passo({ agora: sp(DIA4, 21, 0) })
  const w13 = await canal.passo({ agora: sp(DIA4, 23, 59) }), antes = (await posts(`dia = '${DIA4}'`))[0].status
  const w14 = await canal.passo({ agora: sp('2026-11-27', 8, 0) })
  const p4 = (await posts(`dia = '${DIA4}'`))[0]
  ok(w12.motivo === 'nada' && w13.motivo === 'nada' && antes === 'pendente' && w14.motivo === 'nada' && p4.status === 'falha' && /a tempo/.test(p4.erro) && f.posts.length === 2, 'automático que não saiu até as 21h espera e, virado o dia, vence sem publicar', [antes, p4.status])
  const idV = await manual(sp('2026-11-27', 9, 0))
  const w15 = await canal.passo({ agora: sp('2026-11-27', 9, 16) })
  ok(w15.motivo === 'nada' && (await um(idV)).status === 'falha' && f.posts.length === 2, '"postar agora" que ninguém pegou em 15 min vence', (await um(idV)).erro)
  const idI = await manual(sp('2026-11-27', 10, 0))
  await q(`UPDATE whatsapp_canal_posts SET enviando_em = NOW() WHERE id = $1`, [idI])
  const rec = await recuperarPostsInterrompidos(shim)
  const w16 = await canal.passo({ agora: sp('2026-11-27', 10, 1) })
  ok(rec === 1 && (await um(idI)).status === 'falha' && /interrompido/.test((await um(idI)).erro) && w16.motivo === 'nada' && f.posts.length === 2, 'worker que caiu no meio da postagem: vira falha, nunca publica em dobro')
  const semMetodos = criarFalso(); delete semMetodos.resolverCanal; delete semMetodos.postarNoCanal
  const w17 = await criarCanal({ db: shim, adaptador: semMetodos, env: ENV, log: mudo }).passo({ agora: sp('2026-11-27', 10, 2) })
  ok(w17.motivo === 'nada', 'adaptador sem os métodos de canal não quebra o laço', w17)
  await canal.verificar(new Date())   // deixa o estado como o robô admin o gravaria

  // ═══════════ ROTAS ═══════════
  for (const [m, c] of [['get', '/admin/whatsapp/canal/preview'], ['post', '/admin/whatsapp/canal/postar-agora'], ['put', '/admin/whatsapp/canal/auto']]) {
    const pilha = rota(m, c).stack.map(l => l.name)
    ok(pilha.includes('autenticar') && pilha.includes('exigirSuperAdmin'), `${m.toUpperCase()} ${c}: autenticar + exigirSuperAdmin`)
  }
  const pv = await chamar('get', '/admin/whatsapp/canal/preview')
  ok(pv.status === 200 && pv.body.texto === txt && pv.body.total === 2 && pv.body.cidade === 'Patos de Minas' && pv.body.canal_auto_ativo === true && pv.body.hora_do_post === '18:00', 'preview: o texto que sairia agora + chave + hora', [pv.body.total, pv.body.canal_auto_ativo])
  ok(pv.body.canal.jid === JID && pv.body.canal.robo_admin === true && pv.body.canal.papel === 'ADMIN' && pv.body.canal.conectado === true, 'preview informa o canal e se o robô é admin', pv.body.canal)
  ok(pv.body.ultimos.length === 10 && pv.body.ultimos[0].id > pv.body.ultimos[1].id && pv.body.ultimos.every(u => 'status' in u && 'texto' in u && 'criado_em' in u && 'erro' in u), 'preview traz os últimos registros (hora, texto, resultado)')
  const d1 = await chamar('put', '/admin/whatsapp/canal/auto', { body: { ativo: 'sim' } }), d2 = await chamar('put', '/admin/whatsapp/canal/auto', { body: { ativo: false } })
  ok(d1.status === 400 && d2.status === 200 && d2.body.canal_auto_ativo === false && (await S.canalAutoAtivo()) === false && (await chamar('get', '/admin/whatsapp/canal/preview')).body.canal_auto_ativo === false, 'PUT auto { ativo }: valida e grava canal_auto_ativo', [d1.status, d2.body])
  const nPosts = (await posts()).length
  const pa = await chamar('post', '/admin/whatsapp/canal/postar-agora')
  const novo = (await posts()).pop()
  ok(pa.status === 200 && pa.body.status === 'pendente' && pa.body.texto === txt && novo.origem === 'manual' && novo.status === 'pendente' && novo.texto === txt && novo.criado_por === U(99) && (await posts()).length === nPosts + 1, 'postar-agora: linha manual pendente com o texto de agora (mesmo com a chave desligada)', pa.body.id)
  const pa2 = await chamar('post', '/admin/whatsapp/canal/postar-agora')
  ok(pa2.status === 409 && (await posts()).length === nPosts + 1, 'postar-agora com um post ainda esperando → 409', pa2.body)
  const w18 = await canal.passo({ agora: new Date() })
  ok(w18.postou && f.posts[2].texto === txt && (await um(novo.id)).status === 'postado', 'o worker publica o post manual', w18.motivo)
  await q(`UPDATE whatsapp_estado SET canal_admin = false, canal_papel = 'SUBSCRIBER' WHERE id = 1`)
  const pa3 = await chamar('post', '/admin/whatsapp/canal/postar-agora')
  await q(`UPDATE whatsapp_estado SET canal_admin = true, canal_papel = 'ADMIN', heartbeat_em = NOW() - INTERVAL '10 minutes' WHERE id = 1`)
  const pa4 = await chamar('post', '/admin/whatsapp/canal/postar-agora')
  await q(`UPDATE whatsapp_estado SET heartbeat_em = NOW() WHERE id = 1`)
  await q(`UPDATE reparos SET status = 'cancelada'`); await q(`UPDATE obras SET status = 'cancelada'`)
  const pa5 = await chamar('post', '/admin/whatsapp/canal/postar-agora'), pv2 = await chamar('get', '/admin/whatsapp/canal/preview')
  ok(pa3.status === 409 && /admin/.test(pa3.body.erro) && pa4.status === 409 && /conectado/.test(pa4.body.erro) && pa5.status === 409 && /Nenhum pedido/.test(pa5.body.erro) && pv2.body.texto === null && pv2.body.total === 0 && (await posts()).length === nPosts + 1,
     'postar-agora → 409: robô não admin, worker parado, nenhum pedido aberto (preview: texto null)', [pa3.body.erro, pa4.body.erro, pa5.body.erro])

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
