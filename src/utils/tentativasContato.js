// Texto livre que UMA parte mostra à OUTRA (mensagem da candidatura/interesse, referências da
// candidatura antiga, pergunta e resposta, denúncia): contato removido na ESCRITA (o que vai
// ao banco já sai limpo) e na LEITURA (linha antiga, gravada antes do filtro, é mascarada ao
// sair em GET /obras/:id, GET /reparos/:id e nas listas de candidatos/interessados).
//
// O sanitizador é o MESMO das descrições (moderacaoDemanda.sanitizarTexto): telefone em
// qualquer formato, dígitos por extenso, e-mail, link, @handle e "whats/zap + número" viram
// "[contato removido]"; preço, medida, ano e CEP ficam. Cada ENVIO em que algo foi removido
// vira UMA linha em tentativas_contato (migração de boot em routes/index.js) — um envio com
// dois campos sujos conta uma vez (campo = 'referencias,mensagem') — lida por
// GET /admin/tentativas-contato. Fire-and-forget: falha aqui é log, nunca 500.
//
// PENALIDADE ESCALONADA (dono ou profissional, mesma régua), contando as linhas do usuário nos
// últimos JANELA_PENALIDADE_DIAS:
//   1ª  → push (reserva: e-mail) "⚠️ Contato não permitido" explicando a regra;
//   2ª  → mesmo título, "Último aviso";
//   (só linhas com conta = true — contato CLARO: telefone em algarismos, e-mail, link ou
//   "canal + número"; dígitos por extenso, @handle e "chame no whats" são mascarados mas não
//   contam, para um falso positivo não suspender ninguém)
//   3ª+ → suspensão por DIAS_SUSPENSAO_CONTATO dias pelo MESMO mecanismo das faltas
//         (usuarios.suspenso_em + suspenso_motivo; exigirNaoSuspenso barra proposta/interesse/
//         pergunta e a publicação de pedido; cache de autenticar invalidado), com push/e-mail
//         "Conta suspensa por 7 dias". Já suspenso: nada a fazer. O admin levanta com
//         POST /admin/suspensos/:id/liberar; liberarSuspensoesContato (cron horário em server.js)
//         levanta sozinho as que venceram — só as deste motivo, as de falta são do admin.
const { pool } = require('./supabase')
const { sanitizarTexto, temContatoClaro } = require('./moderacaoDemanda')
const { invalidarCacheAssinatura } = require('../middlewares/auth')
const { MARCA } = require('./marca')

const JANELA_PENALIDADE_DIAS = 90
const AVISOS_ANTES_DE_SUSPENDER = 2
const DIAS_SUSPENSAO_CONTATO = 7
const MOTIVO_SUSPENSAO_CONTATO = 'Tentativa de compartilhar contato'

const TITULO_AVISO = '⚠️ Contato não permitido'
const CORPO_AVISO_1 = `Não é permitido enviar telefone, e-mail ou link pelo ${MARCA}. O contato é liberado no 'Estou a caminho'. Na 3ª tentativa, sua conta será suspensa.`
const CORPO_AVISO_2 = `Último aviso: a próxima tentativa suspende sua conta por ${DIAS_SUSPENSAO_CONTATO} dias.`
const TITULO_SUSPENSAO = `Conta suspensa por ${DIAS_SUSPENSAO_CONTATO} dias`
const CORPO_SUSPENSAO = `Sua conta foi suspensa por ${DIAS_SUSPENSAO_CONTATO} dias: foi a 3ª tentativa de enviar telefone, e-mail ou link pelo ${MARCA}. Durante a suspensão você não pode enviar propostas, perguntas nem publicar pedidos. O contato é liberado no 'Estou a caminho'. Dúvidas, fale com o suporte.`

// alertaService carregado na hora do uso (ele puxa Expo, Brevo e meia API): este módulo é
// requerido por routes e controllers logo no boot, e o aviso só acontece em escrita suja.
const entregar = (args) => require('../services/alertaService').entregarPushOuEmail(args)

// Conta as tentativas do usuário na janela e aplica o degrau correspondente. Nunca lança.
const aplicarPenalidadeContato = async (usuarioId, db = pool) => {
  try {
    // conta = true: só contato CLARO (telefone em algarismos, e-mail, link) pesa na régua;
    // dígitos por extenso e afins ficam na lista do admin (conta = false) sem punir.
    const c = await db.query(
      `SELECT COUNT(*)::int AS n FROM tentativas_contato
        WHERE usuario_id = $1 AND conta AND criado_em > NOW() - ($2::int * INTERVAL '1 day')`,
      [usuarioId, JANELA_PENALIDADE_DIAS]
    )
    const n = c.rows[0]?.n || 0
    if (n === 0) return null
    const u = await db.query(`SELECT push_token, email, nome FROM usuarios WHERE id = $1`, [usuarioId])
    const usuario = u.rows[0]
    if (!usuario) return null

    if (n <= AVISOS_ANTES_DE_SUSPENDER) {
      await entregar({
        ...usuario, titulo: TITULO_AVISO, corpo: n === 1 ? CORPO_AVISO_1 : CORPO_AVISO_2,
        data: { tipo: 'contato_nao_permitido', tentativa: n }, rotulo: `aviso contato ${n} ${usuarioId}`,
      })
      console.log(`[TentativaContato] usuario ${usuarioId}: aviso ${n}/${AVISOS_ANTES_DE_SUSPENDER}`)
      return `aviso_${n}`
    }
    // suspenso_em IS NULL: suspende UMA vez (mesma guarda de registrarFalta); já suspenso, nada.
    const upd = await db.query(
      `UPDATE usuarios SET suspenso_em = NOW(), suspenso_motivo = $2
        WHERE id = $1 AND suspenso_em IS NULL RETURNING id`,
      [usuarioId, MOTIVO_SUSPENSAO_CONTATO]
    )
    if (upd.rowCount === 0) return 'ja_suspenso'
    invalidarCacheAssinatura(usuarioId)
    console.log(`[TentativaContato] usuario ${usuarioId} suspenso por ${DIAS_SUSPENSAO_CONTATO} dias — ${n} tentativas em ${JANELA_PENALIDADE_DIAS} dias`)
    await entregar({
      ...usuario, titulo: TITULO_SUSPENSAO, corpo: CORPO_SUSPENSAO,
      data: { tipo: 'conta_suspensa', motivo: 'contato', dias: DIAS_SUSPENSAO_CONTATO }, rotulo: `suspensao contato ${usuarioId}`,
    })
    return 'suspenso'
  } catch (err) {
    console.error(`[TentativaContato] penalidade de ${usuarioId}:`, err.message)
    return null
  }
}

// Uma linha por ENVIO sujo; em seguida o degrau da penalidade — só quando `conta` (contato
// claro: temContatoClaro). Chamar DEPOIS de o INSERT do envio ter entrado: um envio recusado
// (409 de duplicidade etc.) não é tentativa. Nunca rejeita.
const registrarTentativaContato = async ({ usuario_id, tipo, demanda_id, campo, conta = true }, db = pool) => {
  try {
    await db.query(
      `INSERT INTO tentativas_contato (usuario_id, tipo, demanda_id, campo, conta) VALUES ($1, $2, $3, $4, $5)`,
      [usuario_id, tipo, demanda_id || null, campo, !!conta]
    )
  } catch (err) {
    console.error(`[TentativaContato] ${tipo}/${campo} de ${usuario_id}:`, err.message)
    return null
  }
  if (!conta) return 'sem_penalidade'
  return aplicarPenalidadeContato(usuario_id, db)
}

// Cron horário: levanta as suspensões POR CONTATO que já cumpriram os dias. Só este motivo —
// a suspensão por faltas continua até o admin liberar. Devolve os ids liberados.
const liberarSuspensoesContato = async (db = pool) => {
  try {
    const r = await db.query(
      `UPDATE usuarios SET suspenso_em = NULL, suspenso_motivo = NULL
        WHERE suspenso_motivo = $1 AND suspenso_em <= NOW() - ($2::int * INTERVAL '1 day')
        RETURNING id`,
      [MOTIVO_SUSPENSAO_CONTATO, DIAS_SUSPENSAO_CONTATO]
    )
    for (const { id } of r.rows) invalidarCacheAssinatura(id)
    if (r.rowCount > 0) console.log(`[TentativaContato] ${r.rowCount} suspensão(ões) por contato vencida(s) liberada(s)`)
    return r.rows.map(x => x.id)
  } catch (err) {
    console.error('[TentativaContato] liberar suspensões:', err.message)
    return []
  }
}

// Sanitiza string, lista de strings e objeto com strings (referencias da candidatura antiga
// chega em qualquer um destes formatos); número, null e undefined voltam como vieram.
const limparProfundo = (v) => {
  if (typeof v === 'string') return sanitizarTexto(v)
  if (Array.isArray(v)) return v.map(limparProfundo)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limparProfundo(x)]))
  return v
}
const mudou = (antes, depois) => JSON.stringify(antes) !== JSON.stringify(depois)
// Algum valor (string, lista ou objeto) com contato CLARO.
const temClaroProfundo = (v) => {
  if (typeof v === 'string') return temContatoClaro(v)
  if (Array.isArray(v)) return v.some(temClaroProfundo)
  if (v && typeof v === 'object') return Object.values(v).some(temClaroProfundo)
  return false
}

// ESCRITA. campos = { nome: valor } como veio do body; contexto = { usuario_id, tipo, demanda_id }.
// Devolve { valores (limpos, mesmas chaves), removidos (nomes dos campos que mudaram), conta
// (algum campo tinha contato claro), registrar }. NÃO registra sozinha: o chamador invoca
// registrar() depois de o INSERT entrar (envio recusado não é tentativa) — uma tentativa por
// envio (campo = nomes alterados, separados por vírgula), penalidade só quando conta.
const limparCamposEscrita = (campos, contexto) => {
  const valores = {}
  const removidos = []
  let conta = false
  for (const [campo, valor] of Object.entries(campos)) {
    const limpo = limparProfundo(valor)
    valores[campo] = limpo
    if (mudou(valor, limpo)) {
      removidos.push(campo)
      if (temClaroProfundo(valor)) conta = true
    }
  }
  const registrar = () => (removidos.length > 0
    ? registrarTentativaContato({ ...contexto, campo: removidos.join(','), conta })
    : Promise.resolve(null))
  return { valores, removidos, conta, registrar }
}

// LEITURA. Mascara os campos listados numa linha (ou em cada linha de uma lista) — linha
// antiga com contato aparece como "[contato removido]", sem reescrever o banco. Devolve a
// mesma referência; null/undefined passam.
const mascararLinha = (linha, campos) => {
  if (!linha || typeof linha !== 'object') return linha
  for (const campo of campos) {
    if (linha[campo] != null) linha[campo] = limparProfundo(linha[campo])
  }
  return linha
}
const mascararLista = (linhas, campos) => (Array.isArray(linhas) ? linhas.map(l => mascararLinha(l, campos)) : linhas)

module.exports = {
  JANELA_PENALIDADE_DIAS, AVISOS_ANTES_DE_SUSPENDER, DIAS_SUSPENSAO_CONTATO, MOTIVO_SUSPENSAO_CONTATO,
  registrarTentativaContato, aplicarPenalidadeContato, liberarSuspensoesContato, temContatoClaro,
  limparProfundo, limparCamposEscrita, mascararLinha, mascararLista,
}
