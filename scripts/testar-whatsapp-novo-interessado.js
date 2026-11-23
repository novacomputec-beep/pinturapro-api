#!/usr/bin/env node
// ROBÔ DE WHATSAPP — tipo 'novo_interessado' (19/11/2026). Adaptador FALSO (nada sai de verdade) e
// ESQUEMA DE PRODUÇÃO (PGlite). Cobre:
//   gatilho (tipo ligado, trava do worker, dono SEM push — nem na conta irmã —, 15 min de espera
//   que junta tudo da pessoa, pedido aberto sem escolhido, interesse vivo, até 24 h, dedupe);
//   texto de UM interesse, de VÁRIOS no mesmo pedido e de pedidos DIFERENTES (um link por pedido);
//   rodapé do SAIR só na primeira mensagem; no máximo uma mensagem por pessoa a cada 3 h; 08–21h;
//   dono escolheu / ganhou push antes do envio → sai da fila sem enviar; o mesmo interesse nunca
//   duas vezes; resposta ao aviso → "Para escolher o profissional, toque no link acima 👆";
//   painel: /tipos com rótulo e dica, /mensagens com o resumo do pedido.
//   npm i -D @electric-sql/pglite && node scripts/testar-whatsapp-novo-interessado.js
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
const C = require(path.join(REPO, 'src/whatsapp/config'))
const T = require(path.join(REPO, 'src/whatsapp/textos'))
const F = require(path.join(REPO, 'src/whatsapp/fila'))
const { migrarWhatsapp } = require(path.join(REPO, 'src/whatsapp/migracao'))
const { registrarRecebida } = require(path.join(REPO, 'src/whatsapp/entrada'))
const SI = require(path.join(REPO, 'src/services/whatsappInteressadosService'))
const SP = require(path.join(REPO, 'src/services/whatsappPerguntasService'))
const rotasAdmin = require(path.join(REPO, 'src/routes/adminWhatsapp'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const I = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`

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

// Três números na trava: o dono sem push, a dona COM push e a dona cuja conta irmã tem push.
const TESTE = '+5534998891747', JID = '553498891747@s.whatsapp.net', TEL_WA = '+553498891747'
const TEL_MARIA = '+5511987654321', TEL_PAULA = '+5531987650000'
const TRAVA = [TESTE, TEL_MARIA, TEL_PAULA].join(',')
const ENV = { WHATSAPP_SOMENTE_PARA: TRAVA }
// 08:30 de hoje em São Paulo; cada "rodada" anda 3 h 01 min (o limite por pessoa é 3 h).
const BASE = new Date(); BASE.setUTCHours(11, 30, 0, 0)
const em = (min) => new Date(BASE.getTime() + min * 60000)
const RODADA = 181

const DONO = U(900), MARIA = U(901), PAULA = U(902), PAULA_IRMA = U(903), CARLOS = U(1), LARISSA = U(2), GETULIO = U(3), ANA = U(4), BETO = U(5)
const R1 = D(1), R2 = D(2), R_FECHADO = D(3), R_MARIA = D(4), R_PAULA = D(5), O1 = D(11)
const DICA = '💡 _Dica: ative as notificações do ProTudo no celular para saber na hora._'
const SAIR = '\n_Para não receber mais avisos, responda SAIR._'

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT')

  const usr = (id, nome, role, telefone, extra = {}) => {
    const cols = { id, nome, email: `${id.slice(-4)}@x.invalid`, role, telefone, cpf_cnpj: id.slice(-11), ativo: true, cidade: 'Patos de Minas', uf: 'MG', ...extra }
    const ks = Object.keys(cols)
    return q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => cols[k]))
  }
  await usr(DONO, 'Luiz Melo', 'dono_obra', '(34) 99889-1747')
  await usr(MARIA, 'Maria Souza', 'dono_obra', '11987654321', { push_token: 'ExponentPushToken[maria]' })
  // Paula: a conta que criou o pedido não tem token, mas a outra conta contratante dela (mesmo CPF) tem.
  await usr(PAULA, 'Paula Dias', 'dono_obra', '31987650000', { cpf_cnpj: '123.456.789-09', tipo_dono: 'dono_reparo' })
  await usr(PAULA_IRMA, 'Paula Dias', 'dono_obra', null, { cpf_cnpj: '12345678909', tipo_dono: 'dono_obra', push_token: 'ExponentPushToken[paula]' })
  for (const [id, nome] of [[CARLOS, 'Carlos Eduardo Macário'], [LARISSA, 'Larissa Andrade'], [GETULIO, 'Getúlio Freitas'], [ANA, 'Ana Lima'], [BETO, 'Beto Reis']]) {
    await usr(id, nome, 'prestador', null, { tipo_prestador: 'reparador', push_token: `ExponentPushToken[${id.slice(-3)}]` })
  }
  const pedido = (t, id, titulo, dono, codigo, extra = {}) => {
    const cols = { id, titulo, descricao: 'x', categoria: t === 'reparos' ? 'panfletagem' : 'residencial', cidade: 'Patos de Minas', uf: 'MG', criado_por: dono, status: 'aberta', status_aprovacao: 'aprovada', codigo_publico: codigo, ...extra }
    const ks = Object.keys(cols)
    return q(`INSERT INTO ${t} (${ks.join(', ')}, expira_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, now() + INTERVAL '30 days')`, ks.map(k => cols[k]))
  }
  await pedido('reparos', R1, 'Entregar panfletos', DONO, 'AAAA1')
  await pedido('reparos', R2, 'Pintar o portão', DONO, 'BBBB2')
  await pedido('reparos', R_FECHADO, 'Já tem escolhido', DONO, 'CCCC3', { match_usuario_id: CARLOS })
  await pedido('reparos', R_MARIA, 'Pedido da Maria', MARIA, 'DDDD4')
  await pedido('reparos', R_PAULA, 'Pedido da Paula', PAULA, 'EEEE5')
  await pedido('obras', O1, 'Pintar a sala', DONO, 'FFFF6')
  // min = há quantos minutos o profissional demonstrou interesse / se candidatou.
  const interesse = (n, reparo, prof, min, extra = {}) => {
    const cols = { id: I(n), reparo_id: reparo, usuario_id: prof, ...extra }
    const ks = Object.keys(cols)
    return q(`INSERT INTO interesse_reparos (${ks.join(', ')}, criado_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, now() - (${Number(min)} * INTERVAL '1 minute'))`, ks.map(k => cols[k]))
  }
  const candidatura = (n, obra, prof, min) => q(
    `INSERT INTO candidaturas (id, obra_id, usuario_id, status, criado_em) VALUES ($1, $2, $3, 'pendente', now() - (${Number(min)} * INTERVAL '1 minute'))`, [I(n), obra, prof])
  const fila = async (where = 'true') => (await q(`SELECT * FROM whatsapp_mensagens WHERE ${where} ORDER BY id`)).rows
  const config = (chave, valor) => q(`WITH u AS (UPDATE configuracoes SET valor = $2 WHERE chave = $1 RETURNING 1) INSERT INTO configuracoes (chave, valor) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM u)`, [chave, valor])
  const f = criarFalso()
  let relogio = em(0)
  const passo = (agora, env = ENV) => { relogio = agora; return F.processarProxima({ db: shim, adaptador: f, agora, env }) }
  let nIn = 0
  const recebe = async (extra) => {
    const id = `IN${++nIn}`
    await registrarRecebida(shim, { id, jid: JID, telefone: TEL_WA, texto: '', quando: new Date(), ...extra })
    await SP.processarRecebidas({ responder: async () => { throw new Error('não era para responder pergunta') } }, shim)
    await q(`UPDATE whatsapp_mensagens SET criado_em = $1::timestamptz WHERE tipo = 'resposta' AND status = 'fila'`, [relogio.toISOString()])
    return (await q(`SELECT * FROM whatsapp_recebidas WHERE wa_message_id = $1`, [id])).rows[0]
  }
  const ultimo = () => f.enviados[f.enviados.length - 1]

  // ═══════════ GATILHO ═══════════
  await interesse(1, R1, CARLOS, 16)
  await interesse(2, R_MARIA, LARISSA, 20)                              // dona COM push
  await interesse(3, R_PAULA, LARISSA, 20)                              // push na conta irmã (mesmo CPF)
  await interesse(4, R_FECHADO, GETULIO, 20)                            // pedido já tem escolhido
  await interesse(5, R2, ANA, 20, { cancelado_em: new Date().toISOString() }) // interesse cancelado
  await interesse(6, R2, BETO, 60 * 25)                                 // mais de 24 h
  await interesse(7, R2, GETULIO, 20, { status: 'recusado' })           // o dono já recusou
  let e = await SI.enfileirarNovosInteressados(shim)
  ok(e.enfileiradas === 0 && e.motivo === 'tipo_desligado' && (await fila()).length === 0, 'tipo desligado (padrão): o gatilho não põe nada na fila', e)
  ok(C.TIPOS.novo_interessado.padrao === false && C.TIPOS.novo_interessado.implementado === true && C.TIPOS.novo_interessado.limitePorPessoa === true, 'config: implementado, desligado por padrão, dentro do limite por pessoa')
  await config('whatsapp_tipo_novo_interessado', 'true')
  e = await SI.enfileirarNovosInteressados(shim)
  ok(e.enfileiradas === 0 && e.motivo === 'sem_trava', 'tipo ligado mas worker sem trava (WHATSAPP_SOMENTE_PARA): nada entra na fila', e)
  await q(`UPDATE whatsapp_estado SET trava = $1, conexao = 'conectado', heartbeat_em = NOW()`, [TRAVA])
  e = await SI.enfileirarNovosInteressados(shim)
  let l = await fila()
  ok(e.enfileiradas === 1 && l.length === 1 && l[0].tipo === 'novo_interessado' && l[0].usuario_id === DONO && l[0].telefone === TESTE && l[0].ref_tabela === 'reparos' && l[0].ref_id === R1
     && l[0].chave_dedupe === `interessado:reparos:${I(1)}` && l[0].dados.nome_prof === 'Carlos' && l[0].dados.primeiro_nome === 'Luiz' && l[0].dados.link === 'https://protudo.app.br/p/AAAA1',
     'só o interesse em pedido aberto de dono SEM push entra (não: dona com push, push na conta irmã, pedido com escolhido, cancelado, recusado, mais de 24 h)', l.map(x => x.chave_dedupe))
  e = await SI.enfileirarNovosInteressados(shim)
  ok(e.enfileiradas === 0 && (await fila()).length === 1, 'rodar de novo não duplica')

  // ═══════════ UM INTERESSE ═══════════
  let r = await passo(em(0))
  const UM = `Oi, Luiz! 👋 Aqui é o *ProTudo*.\n🙋 *Carlos* se interessou pelo seu pedido *Entregar panfletos*.\n👉 Veja e escolha aqui: https://protudo.app.br/p/AAAA1\n${DICA}`
  l = await fila()
  ok(r.enviou && f.enviados.length === 1 && f.enviados[0].jid === JID && f.enviados[0].texto === UM + SAIR, 'UM interesse: texto exato, com o rodapé do SAIR na primeira mensagem da pessoa', f.enviados[0]?.texto)
  ok(l[0].status === 'enviada' && l[0].texto === f.enviados[0].texto && l[0].wa_message_id === 'WA1' && l[0].item_numero === null, 'a linha guarda o texto que saiu')

  // ═══════════ VOLTA ═══════════
  let rec = await recebe({ texto: 'ok, vou ver' })
  l = await fila()
  ok(rec.resultado === 'interessado (link)' && String(rec.mensagem_ref) === String(l[0].id) && l[0].status === 'respondida' && l[0].resposta === 'ok, vou ver'
     && l[1]?.tipo === 'resposta' && l[1].status === 'fila' && l[1].texto === 'Para escolher o profissional, toque no link acima 👆' && l[1].wa_jid === JID,
     'resposta ao aviso: o robô responde "Para escolher o profissional, toque no link acima 👆" e a resposta fica na linha (painel)', [rec.resultado, l[1]?.texto])
  r = await passo(em(1))
  ok(r.enviou && ultimo().texto === 'Para escolher o profissional, toque no link acima 👆', 'a resposta automática sai na hora (fora do limite de 3 h)')
  rec = await recebe({ texto: 'obrigado' })
  ok(rec.resultado === 'sem_pergunta_pendente' && (await fila(`tipo = 'resposta'`)).length === 1, 'segunda mensagem da pessoa: o robô não puxa conversa (uma resposta por aviso)', rec.resultado)
  rec = await recebe({ texto: 'e esse aqui?', citada: 'WA1' })
  ok(rec.resultado === 'interessado (link)' && (await fila(`tipo = 'resposta'`)).length === 2, 'respondeu CITANDO o aviso: recebe o "toque no link acima" de novo', rec.resultado)
  await passo(em(2))
  e = await SI.enfileirarNovosInteressados(shim)
  ok(e.enfileiradas === 0, 'o mesmo interesse nunca é avisado duas vezes')

  // ═══════════ ESPERA DE 15 MIN + VÁRIOS NO MESMO PEDIDO + LIMITE DE 3 H ═══════════
  await interesse(10, R2, LARISSA, 5)
  e = await SI.enfileirarNovosInteressados(shim)
  ok(e.enfileiradas === 0, 'interesse de 5 min: ainda esperando os 15 min')
  await interesse(11, R2, GETULIO, 16)
  await interesse(12, R2, ANA, 1)
  e = await SI.enfileirarNovosInteressados(shim)
  ok(e.enfileiradas === 3, 'o mais antigo fez 15 min: entram TODOS os interesses pendentes da pessoa (também os de 5 e de 1 min)', e)
  r = await passo(em(10))
  ok(!r.enviou && f.enviados.length === 3, 'limite: menos de 3 h desde a última mensagem para a pessoa → espera na fila', r.motivo)
  r = await passo(em(RODADA))
  l = await fila(`tipo = 'novo_interessado' AND ref_id = '${R2}'`)
  ok(r.enviou && ultimo().texto === `Oi, Luiz! 👋 Aqui é o *ProTudo*.\n🙋 *3 profissionais* se interessaram pelo seu pedido *Pintar o portão*.\n👉 Veja e escolha aqui: https://protudo.app.br/p/BBBB2\n${DICA}`,
     'VÁRIOS no mesmo pedido: UMA mensagem com "3 profissionais", sem o rodapé do SAIR (não é mais a primeira)', ultimo().texto)
  ok(l.length === 3 && l.every(x => x.status === 'enviada' && x.wa_message_id === ultimo().id) && l.filter(x => x.agrupada_em === null).length === 1, 'as 3 linhas saem na mesma mensagem (uma é a dona, as outras apontam para ela)')

  // ═══════════ PEDIDOS DIFERENTES ═══════════
  await interesse(20, R1, LARISSA, 18)
  await interesse(21, R1, GETULIO, 17)
  await candidatura(22, O1, ANA, 16)
  e = await SI.enfileirarNovosInteressados(shim)
  l = await fila(`chave_dedupe = 'interessado:obras:${I(22)}'`)
  ok(e.enfileiradas === 3 && l.length === 1 && l[0].ref_tabela === 'obras' && l[0].ref_id === O1, 'candidatura em obra entra como o interesse em serviço', e)
  r = await passo(em(2 * RODADA))
  ok(r.enviou && ultimo().texto === `Oi, Luiz! 👋 Aqui é o *ProTudo*.\n🙋 Seus pedidos têm novos interessados:\n• *Entregar panfletos*: 2 interessados\n👉 https://protudo.app.br/p/AAAA1\n• *Pintar a sala*: 1 interessado\n👉 https://protudo.app.br/p/FFFF6\n${DICA}`,
     'PEDIDOS DIFERENTES: uma linha por pedido, com a contagem e um link por pedido', ultimo().texto)

  // ═══════════ DEIXOU DE VALER ANTES DO ENVIO ═══════════
  await interesse(30, R2, BETO, 16)
  await interesse(31, R1, BETO, 16)
  e = await SI.enfileirarNovosInteressados(shim)
  await q(`UPDATE reparos SET match_usuario_id = $2 WHERE id = $1`, [R2, CARLOS])
  await q(`UPDATE reparos SET status = 'encerrada' WHERE id = $1`, [R1])
  const antes = f.enviados.length
  r = await passo(em(3 * RODADA))
  ok(e.enfileiradas === 2 && !r.enviou && f.enviados.length === antes && (await fila(`tipo = 'novo_interessado' AND status = 'fila'`)).length === 0,
     'dono escolheu um profissional / pedido fechou antes do envio: sai da fila, nada é enviado', r.motivo)
  await q(`UPDATE reparos SET status = 'aberta' WHERE id = $1`, [R1])
  await q(`UPDATE reparos SET match_usuario_id = NULL WHERE id = $1`, [R2])
  await q(`UPDATE usuarios SET push_token = 'ExponentPushToken[luiz]' WHERE id = $1`, [DONO])
  e = await SI.enfileirarNovosInteressados(shim)
  ok(e.enfileiradas === 0, 'dono passou a ter push: o gatilho não avisa mais por WhatsApp', e)
  await q(`UPDATE usuarios SET push_token = NULL WHERE id = $1`, [DONO])
  e = await SI.enfileirarNovosInteressados(shim)
  await q(`UPDATE usuarios SET push_token = 'ExponentPushToken[luiz]' WHERE id = $1`, [DONO])
  r = await passo(em(3 * RODADA + 1))
  ok(e.enfileiradas === 2 && !r.enviou && f.enviados.length === antes && (await fila(`tipo = 'novo_interessado' AND status = 'fila'`)).length === 0,
     'dono ganhou push DEPOIS de entrar na fila: sai da fila sem enviar', r.motivo)

  // ═══════════ JANELA 08–21h ═══════════
  await q(`UPDATE usuarios SET push_token = NULL WHERE id = $1`, [DONO])
  await q(`DELETE FROM interesse_reparos WHERE id = $1`, [I(30)])
  e = await SI.enfileirarNovosInteressados(shim)
  const NOITE = em(13 * 60 + 30), MANHA = em(23 * 60 + 30) // 22:00 de hoje e 08:00 de amanhã (São Paulo)
  r = await passo(NOITE)
  ok(e.enfileiradas === 1 && !r.enviou && r.motivo === 'fora_do_horario' && f.enviados.length === antes, '22h: fora da janela, fica na fila', r.motivo)
  r = await passo(MANHA)
  ok(r.enviou && ultimo().texto === `Oi, Luiz! 👋 Aqui é o *ProTudo*.\n🙋 *Beto* se interessou pelo seu pedido *Entregar panfletos*.\n👉 Veja e escolha aqui: https://protudo.app.br/p/AAAA1\n${DICA}`,
     '08h do dia seguinte: sai', ultimo().texto)

  // ═══════════ TEXTOS (função pura) E PAINEL ═══════════
  ok(T.linkAbrir('X1Y2Z') === 'https://protudo.app.br/p/X1Y2Z' && T.TEXTO_RESPOSTA_INTERESSADO === 'Para escolher o profissional, toque no link acima 👆', 'link do pedido e resposta do robô')
  const pilha = (m, c) => rotasAdmin.stack.find(x => x.route && x.route.path === c && x.route.methods[m]).route.stack
  const chamar = (m, c, query = {}) => new Promise(resolve => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
    const p = pilha(m, c); p[p.length - 1].handle({ query, body: {}, params: {}, usuario: { id: U(99), role: 'admin' } }, res)
  })
  const tipos = (await chamar('get', '/admin/whatsapp/tipos')).body.tipos
  const ni = tipos.find(x => x.tipo === 'novo_interessado')
  ok(tipos.map(x => x.tipo).join() === 'pergunta_sem_resposta,novo_interessado,especialidade_rara,prazo_acabando,escolhido,horario_aguardando,teste'
     && ni.rotulo === '🙋 Novo interessado' && ni.dica === 'Só para quem está sem notificação' && ni.implementado === true && ni.ligado === true
     && tipos.find(x => x.tipo === 'teste').dica === null,
     'painel /tipos: "🙋 Novo interessado" com a dica "Só para quem está sem notificação", implementado', ni)
  const lista = (await chamar('get', '/admin/whatsapp/mensagens', { tipo: 'novo_interessado', limit: '100' })).body
  const m1 = lista.mensagens.find(x => x.status === 'respondida')
  ok(m1 && m1.resposta === 'ok, vou ver' && m1.papel === 'dono' && m1.codigo === 'AAAA1' && m1.resumo.startsWith('🙋 Novo interessado · AAAA1 '), 'painel /mensagens: resumo com o pedido e a resposta dada pelo WhatsApp', m1 && m1.resumo)

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
