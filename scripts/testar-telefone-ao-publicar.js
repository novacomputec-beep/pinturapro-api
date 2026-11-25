#!/usr/bin/env node
// TELEFONE DO DONO AO PUBLICAR (utils/telefoneAoPublicar) — dono, 25/11/2026.
//  1) POST /reparos/dono e POST /obras/dono aceitam `telefone` (opcional): conta SEM telefone →
//     valida como celular brasileiro (11 dígitos com DDD) e grava na conta;
//  2) conta que JÁ tem telefone: nunca sobrescreve (nem valida o que veio);
//  3) inválido → 400 TELEFONE_INVALIDO, nada gravado (nem o pedido, nem o telefone);
//  4) login (montarSessao) e GET /auth/perfil trazem tem_telefone.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-telefone-ao-publicar.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { return chunk.map((_, i) => ({ status: 'ok', id: `t${i}` })) }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
const q = async (sql, params) => {
  if (!db) throw new Error('sem banco (boot)')
  const r = await db.query(sql, params)
  if (r && r.rowCount === undefined) r.rowCount = r.rows.length || r.affectedRows || 0
  return r
}
const shim = { query: q, connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: q, release() {} } }, on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async () => {}, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async () => {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const erros = []
const silenciar = (v) => {
  console.log = v ? () => {} : logOrig
  console.warn = v ? () => {} : warnOrig
  console.error = v ? (...a) => { erros.push(a.map(x => x?.message || String(x)).join(' ')) } : errOrig
}
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const authCtrl = require(path.join(REPO, 'src/controllers/authController'))
const T = require(path.join(REPO, 'src/utils/telefoneAoPublicar'))
const { normalizarTelefone } = require(path.join(REPO, 'src/whatsapp/config'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 200))
const rotasDe = (r) => r.stack.flatMap(l => (l.route ? [l.route] : l.handle?.stack ? rotasDe(l.handle) : []))
const ROTAS = rotasDe(router)
const rota = (metodo, caminho) => { const r = ROTAS.find(x => x.path === caminho && x.methods[metodo]); if (!r) throw new Error(`rota ${metodo} ${caminho} não encontrada`); return r }
const responder = async (handler, req) => {
  silenciar(true)
  try {
    let resp = null
    const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resp = resp || { status: this.statusCode, body: b }; return this } }
    await handler({ params: {}, query: {}, body: {}, get: () => '', headers: {}, ip: '127.0.0.1', ...req }, res)
    await assentar()
    return resp
  } finally { silenciar(false) }
}
const publicar = (caminho, usuario, body) => { const pilha = rota('post', caminho).stack; return responder(pilha[pilha.length - 1].handle, { method: 'POST', path: caminho, usuario, body }) }

const main = async () => {
  // ═══ 0. Funções puras ══════════════════════════════════════════════════════════════════════
  const c = T.celularValido
  ok(c('34999887766') === '34999887766' && c('(34) 99988-7766') === '34999887766' && c('+55 34 99988-7766') === '34999887766' && c('034999887766') === '34999887766' && c(34999887766) === '34999887766',
     'celularValido: 11 dígitos com DDD — com máscara, +55, 0 de tronco ou número → os 11 dígitos')
  ok([c('3499988776'), c('999887766'), c('34899887766'), c('00999887766'), c('3432221100'), c('349998877665'), c('abc'), c(''), c(null), c({}), c(['34999887766'])].every(v => v === null),
     'celularValido recusa: 10 dígitos, sem DDD, sem o 9, DDD inexistente, fixo, longo demais, texto, vazio, objeto')
  ok(T.temTelefone('34999887766') && T.temTelefone('(34) 9') && !T.temTelefone('') && !T.temTelefone(null) && !T.temTelefone('  ') && !T.temTelefone('-'),
     'temTelefone: ao menos um dígito gravado')
  ok(normalizarTelefone(c('(34) 99988-7766')) === '+5534999887766', 'o que é gravado é lido pelo robô de WhatsApp (+55…)')

  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`
    CREATE UNIQUE INDEX t_configuracoes_uq ON configuracoes (chave);
    CREATE UNIQUE INDEX t_push_entregas_uq ON push_entregas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_reparos_crid_uq ON reparos (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE UNIQUE INDEX t_obras_crid_uq ON obras (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
  `)
  const usr = async (n, nome, telefone) => {
    const u = { id: U(n), nome, email: `u${n}@x.invalid`, role: 'dono_obra', tipo_dono: 'reparo', cpf_cnpj: String(n).padStart(11, '0'), ativo: true, cidade: 'Patos de Minas', uf: 'MG', telefone }
    const ks = Object.keys(u)
    await q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => u[k]))
    return { id: u.id, role: u.role, nome, email: u.email }
  }
  const semTel = await usr(1, 'Íris Sem Telefone', null)
  const vazio = await usr(2, 'Vera Telefone Vazio', '  ')
  const comTel = await usr(3, 'Caio Com Telefone', '(34) 98888-0000')
  const obraSem = await usr(4, 'Olga Obra Sem Telefone', '')
  const outro = await usr(5, 'Nina Não Manda', null)
  const tel = async (u) => (await q(`SELECT telefone FROM usuarios WHERE id = $1`, [u.id])).rows[0].telefone
  const contar = async (tabela, u) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE criado_por = $1`, [u.id])).rows[0].n
  const corpoReparo = (extra = {}) => ({ titulo: 'Aula particular de matemática', categoria: 'eletrica', cidade: 'Patos de Minas', uf: 'MG', valor_estimado: 120, tera_midias: true, ...extra })
  const corpoObra = (extra = {}) => ({ titulo: 'Reforma do banheiro', descricao: 'Trocar piso e louças', categoria: 'residencial', cidade: 'Patos de Minas', uf: 'MG', valor: 5000, tera_midias: true, ...extra })

  // ═══ 1. Reparo ═════════════════════════════════════════════════════════════════════════════
  let r = await publicar('/reparos/dono', semTel, corpoReparo({ telefone: '3499988-776' }))
  ok(r.status === 400 && r.body.codigo === 'TELEFONE_INVALIDO' && /celular com DDD/.test(r.body.erro) && await tel(semTel) === null && await contar('reparos', semTel) === 0,
     'reparo, conta sem telefone, telefone INVÁLIDO: 400 TELEFONE_INVALIDO com mensagem clara; nem o pedido nem o telefone gravados', r)
  r = await publicar('/reparos/dono', semTel, corpoReparo({ telefone: '(34) 3222-1100' }))
  ok(r.status === 400 && r.body.codigo === 'TELEFONE_INVALIDO' && await contar('reparos', semTel) === 0, 'fixo não é celular: 400, nada gravado', r.status)
  r = await publicar('/reparos/dono', semTel, corpoReparo({ telefone: { numero: '34999887766' } }))
  ok(r.status === 400 && r.body.codigo === 'TELEFONE_INVALIDO', 'telefone que não é texto/número: 400', r.status)
  r = await publicar('/reparos/dono', semTel, corpoReparo({ telefone: '(34) 99988-7766' }))
  ok(r.status === 201 && await tel(semTel) === '34999887766' && await contar('reparos', semTel) === 1, 'reparo, conta sem telefone, celular válido: 201 e o telefone fica gravado na conta (só dígitos)', { status: r.status, telefone: await tel(semTel) })
  r = await publicar('/reparos/dono', semTel, corpoReparo({ titulo: 'Outro pedido', telefone: '(11) 97777-6666' }))
  ok(r.status === 201 && await tel(semTel) === '34999887766', 'pedido seguinte com OUTRO número: publica e NÃO sobrescreve o telefone gravado', await tel(semTel))
  r = await publicar('/reparos/dono', vazio, corpoReparo({ telefone: '+55 34 99911-2233' }))
  ok(r.status === 201 && await tel(vazio) === '34999112233', 'telefone só com espaços conta como vazio: grava', await tel(vazio))
  r = await publicar('/reparos/dono', comTel, corpoReparo({ telefone: '34999887766' }))
  ok(r.status === 201 && await tel(comTel) === '(34) 98888-0000', 'conta que JÁ tem telefone: publica e mantém o telefone exatamente como estava', await tel(comTel))
  r = await publicar('/reparos/dono', comTel, corpoReparo({ titulo: 'Mais um', telefone: 'qualquer coisa' }))
  ok(r.status === 201 && await tel(comTel) === '(34) 98888-0000', 'conta que já tem telefone: o campo é ignorado (nem validado)', r.status)
  r = await publicar('/reparos/dono', outro, corpoReparo())
  const r2 = await publicar('/reparos/dono', outro, corpoReparo({ titulo: 'Sem telefone 2', telefone: '' }))
  const r3 = await publicar('/reparos/dono', outro, corpoReparo({ titulo: 'Sem telefone 3', telefone: null }))
  ok(r.status === 201 && r2.status === 201 && r3.status === 201 && await tel(outro) === null, 'campo ausente, vazio ou null: publica como sempre, conta segue sem telefone', [r.status, r2.status, r3.status])
  r = await publicar('/reparos/dono', outro, corpoReparo({ titulo: '   ', telefone: '34999887766' }))
  ok(r.status === 400 && await tel(outro) === null, 'pedido recusado por outra validação (título): o telefone válido NÃO é gravado', r)

  // ═══ 2. Obra ═══════════════════════════════════════════════════════════════════════════════
  r = await publicar('/obras/dono', obraSem, corpoObra({ telefone: '99988-7766' }))
  ok(r.status === 400 && r.body.codigo === 'TELEFONE_INVALIDO' && await tel(obraSem) === '' && await contar('obras', obraSem) === 0, 'obra, telefone inválido (sem DDD): 400, nada gravado', r)
  r = await publicar('/obras/dono', obraSem, corpoObra({ valor: 0, telefone: '34999887766' }))
  ok(r.status === 400 && await tel(obraSem) === '' && await contar('obras', obraSem) === 0, 'obra recusada por outra validação (valor): o telefone válido NÃO é gravado', r.status)
  r = await publicar('/obras/dono', obraSem, corpoObra({ telefone: '34 9 9123 4567' }))
  ok(r.status < 300 && await tel(obraSem) === '34991234567' && await contar('obras', obraSem) === 1, 'obra, conta sem telefone, celular válido: publica e grava o telefone', { status: r.status, telefone: await tel(obraSem) })
  r = await publicar('/obras/dono', comTel, corpoObra({ telefone: '34999887766' }))
  ok(r.status < 300 && await tel(comTel) === '(34) 98888-0000', 'obra de conta que já tem telefone: não sobrescreve', await tel(comTel))

  // ═══ 3. Payload do usuário logado ══════════════════════════════════════════════════════════
  const linha = async (u) => (await q(`SELECT * FROM usuarios WHERE id = $1`, [u.id])).rows[0]
  silenciar(true)
  const sSem = (await authCtrl.montarSessao(await linha(outro), { headers: {}, get: () => '' })).usuario
  const sCom = (await authCtrl.montarSessao(await linha(semTel), { headers: {}, get: () => '' })).usuario
  silenciar(false)
  ok(sSem.tem_telefone === false && sSem.telefone === null && sCom.tem_telefone === true && sCom.telefone === '34999887766', 'login (montarSessao): tem_telefone false sem telefone; true (e o número) depois de gravado ao publicar', { sem: sSem.tem_telefone, com: sCom.tem_telefone })
  r = await responder(authCtrl.perfil, { usuario: outro })
  const rCom = await responder(authCtrl.perfil, { usuario: obraSem })
  ok(r.status === 200 && r.body.usuario.tem_telefone === false && rCom.body.usuario.tem_telefone === true && rCom.body.usuario.telefone === '34991234567', 'GET /auth/perfil: usuario.tem_telefone', { sem: r.body?.usuario?.tem_telefone, com: rCom.body?.usuario?.tem_telefone })

  const inesperados = erros.filter(e => !/sem banco/.test(e))
  ok(inesperados.length === 0, 'nenhum erro inesperado no log', inesperados.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
