#!/usr/bin/env node
// CONTAS ISENTAS DA PENALIDADE POR CONTATO (utils/tentativasContato — dono, 28/11/2026). A conta
// oficial e as contas de teste do dono continuam com o contato detectado, mascarado e no log do
// admin, mas sem strike, aviso nem suspensão. Conta comum: a régua de sempre (aviso 1, aviso 2,
// suspensão). Lista: IDS_ISENTOS_PENALIDADE_CONTATO + env CONTATO_ISENTOS_IDS.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; push/e-mail falsos.
//   NODE_PATH=<pglite>/node_modules node scripts/testar-isentos-contato.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

let db = null
const q = async (sql, params) => {
  if (!db) throw new Error('sem banco (boot)')
  const r = await db.query(sql, params)
  if (r && r.rowCount === undefined) r.rowCount = r.rows.length || r.affectedRows || 0
  return r
}
const shim = { query: q, connect: async () => ({ query: q, release() {} }), on() {} }
const entregas = []
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/services[\\/]alertaService$/.test(request)) return {
    entregarPushOuEmail: async (a) => { entregas.push({ canal: 'push_ou_email', ...a }) },
    entregarPushEEmail: async (a) => { entregas.push({ canal: 'push_e_email', ...a }) },
  }
  return origLoad.apply(this, arguments)
}
const logOrig = console.log
const erros = []
console.log = () => {}; console.warn = () => {}
console.error = (...a) => { erros.push(a.map(x => x?.message || String(x)).join(' ')) }
const T = require(path.join(REPO, 'src/utils/tentativasContato'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const OFICIAL = '88e50935-5564-4d85-937d-96b797496357'
const TESTE_PRO = '0cd37980-bcc2-4621-be49-be5b067cd045'
const COMUM = 'aaaaaaaa-0000-4000-8000-000000000001'
const DA_ENV = 'aaaaaaaa-0000-4000-8000-000000000002'
const TEXTO_SUJO = 'Me chama no 34 99123-4567 que eu passo o orçamento'

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  for (const [id, n] of [[OFICIAL, 1], [TESTE_PRO, 2], [COMUM, 3], [DA_ENV, 4]]) {
    await q(`INSERT INTO usuarios (id, nome, email, role, cpf_cnpj, ativo, push_token) VALUES ($1::uuid, $2, $3, 'prestador', $4, true, $5)`,
      [id, `Usuario ${n}`, `u${n}@x.invalid`, String(n).padStart(11, '0'), `ExponentPushToken[u${n}]`])
  }
  const usuario = async (id) => (await q(`SELECT suspenso_em, suspenso_motivo FROM usuarios WHERE id = $1::uuid`, [id])).rows[0]
  const linhas = async (id) => (await q(`SELECT conta FROM tentativas_contato WHERE usuario_id = $1::uuid ORDER BY id`, [id])).rows.map(r => r.conta)
  const enviar = async (id) => {
    const { valores, registrar } = T.limparCamposEscrita({ mensagem: TEXTO_SUJO }, { usuario_id: id, tipo: 'candidatura', demanda_id: null })
    const r = await registrar()
    return { mensagem: valores.mensagem, r }
  }

  ok(T.IDS_ISENTOS_PENALIDADE_CONTATO.length === 5 && T.IDS_ISENTOS_PENALIDADE_CONTATO.includes(OFICIAL) && T.IDS_ISENTOS_PENALIDADE_CONTATO.includes(TESTE_PRO)
     && Object.isFrozen(T.IDS_ISENTOS_PENALIDADE_CONTATO), 'lista: conta oficial + as 4 contas de teste, congelada', T.IDS_ISENTOS_PENALIDADE_CONTATO.length)
  ok(T.isentoPenalidadeContato(OFICIAL) && T.isentoPenalidadeContato(TESTE_PRO.toUpperCase()) && !T.isentoPenalidadeContato(COMUM) && !T.isentoPenalidadeContato(null),
     'isentoPenalidadeContato: ids da lista (sem diferença de caixa); comum e nulo não')

  // Conta comum: a régua de sempre.
  const comum = []
  for (let i = 0; i < 3; i++) comum.push(await enviar(COMUM))
  const uc = await usuario(COMUM)
  ok(comum.every(x => x.mensagem.includes('[contato removido]') && !x.mensagem.includes('99123')) && comum.map(x => x.r).join() === 'aviso_1,aviso_2,suspenso'
     && !!uc.suspenso_em && uc.suspenso_motivo === T.MOTIVO_SUSPENSAO_CONTATO && (await linhas(COMUM)).join() === 'true,true,true',
     'conta comum: mascarado; aviso 1, aviso 2 e suspensão na 3ª', comum.map(x => x.r))

  // Contas isentas: mascarado e no log, sem strike, aviso nem suspensão.
  for (const id of [OFICIAL, TESTE_PRO]) {
    entregas.length = 0
    const rs = []
    for (let i = 0; i < 4; i++) rs.push(await enviar(id))
    const u = await usuario(id)
    ok(rs.every(x => x.mensagem.includes('[contato removido]') && !x.mensagem.includes('99123')), `isenta ${id.slice(0, 8)}: contato continua mascarado`, rs[0].mensagem)
    ok(rs.every(x => x.r === 'isento') && (await linhas(id)).join() === 'false,false,false,false', `isenta ${id.slice(0, 8)}: 4 envios no log do admin, todos com conta = false`, await linhas(id))
    ok(u.suspenso_em === null && u.suspenso_motivo === null && entregas.length === 0, `isenta ${id.slice(0, 8)}: sem aviso e sem suspensão`, { s: u.suspenso_em, e: entregas.length })
  }
  // Strikes antigos (conta = true) não suspendem uma conta isenta.
  for (let i = 0; i < 3; i++) await q(`INSERT INTO tentativas_contato (usuario_id, tipo, campo, conta) VALUES ($1::uuid, 'candidatura', 'mensagem', true)`, [TESTE_PRO])
  const rAntigos = await T.aplicarPenalidadeContato(TESTE_PRO, shim)
  ok(rAntigos === 'isento' && (await usuario(TESTE_PRO)).suspenso_em === null && entregas.length === 0, 'isenta com strikes antigos: aplicarPenalidadeContato não suspende', rAntigos)
  // Envio que não conta (falso positivo): igual para todos.
  ok((await T.registrarTentativaContato({ usuario_id: OFICIAL, tipo: 'pergunta_obra', campo: 'pergunta', conta: false }, shim)) === 'sem_penalidade', 'isenta, envio com conta = false: sem_penalidade')

  // Env CONTATO_ISENTOS_IDS: mais ids sem mexer no código.
  ok(!T.isentoPenalidadeContato(DA_ENV), 'id fora da lista e sem env: não isento')
  process.env.CONTATO_ISENTOS_IDS = ` outro-id , ${DA_ENV.toUpperCase()} `
  const re = []
  for (let i = 0; i < 3; i++) re.push((await enviar(DA_ENV)).r)
  ok(T.isentoPenalidadeContato(DA_ENV) && re.join() === 'isento,isento,isento' && (await usuario(DA_ENV)).suspenso_em === null, 'env CONTATO_ISENTOS_IDS (vírgulas, espaços, caixa): isento, sem suspensão', re)
  delete process.env.CONTATO_ISENTOS_IDS
  ok(!T.isentoPenalidadeContato(DA_ENV) && T.isentoPenalidadeContato(OFICIAL), 'sem a env: só a lista do código')

  const inesperados = erros.filter(x => !/sem banco/.test(x))
  ok(inesperados.length === 0, 'nenhum erro inesperado no log', inesperados.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { logOrig('ERRO', e); process.exit(1) })
