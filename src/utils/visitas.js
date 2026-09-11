const { pool } = require('./supabase')

// Buffer em memória do contador de visitas dos detalhes (GET /obras/:id e GET /reparos/:id).
//
// Antes cada visita era um UPDATE próprio: uma ESCRITA no caminho de leitura mais quente da
// API, tomando lock da linha (visitantes simultâneos da MESMA demanda serializavam entre si)
// e gerando uma tupla morta por visualização. Agora a visita só incrementa um contador em
// memória e um flush periódico grava tudo de uma vez — O(demandas distintas por janela) em
// vez de O(visitas).
//
// Precisão: o que estiver no buffer se perde se o processo morrer de forma abrupta (crash,
// SIGKILL). O limite é UMA janela de flush. Redeploy normal não perde nada — os handlers de
// SIGTERM/SIGINT em server.js descarregam antes de sair. O único consumidor é o cron de baixo
// engajamento (8h, limiar >= 10), então essa perda não muda decisão nenhuma.
//
// Múltiplas réplicas: cada processo tem o seu buffer e o UPDATE é ADITIVO (soma o delta em
// vez de setar valor), então os flushes de réplicas diferentes se somam corretamente — ao
// contrário dos caches deste projeto, aqui o estado por processo não é problema.
const INTERVALO_FLUSH_MS = 30 * 1000

// Teto de CHAVES por tabela: a demanda é que os mapas nunca cresçam sem limite. Em operação
// normal o flush de 30s esvazia bem antes disso (são demandas DISTINTAS vistas na janela);
// o teto existe para o caso patológico — varredura de ids, pico anormal. No teto, chave NOVA
// é descartada (a visita não é contada) e as já presentes seguem incrementando.
const MAX_CHAVES = 5000

// Chaves fixas: são também os NOMES DE TABELA interpolados no SQL abaixo. Nada vem do
// request — registrarVisita só aceita estas duas chaves, e id desconhecido sai fora.
const buffers = { obras: new Map(), reparos: new Map() }

// Dedupe por (tabela, demanda, usuário): o MESMO usuário reabrindo a MESMA demanda dentro
// da janela conta UMA visita, não uma por leitura. Mapa INDEPENDENTE do buffer acima: o
// buffer esvazia a cada flush de 30s e por isso não lembra quem já viu; este guarda o
// último instante visto por chave e sobrevive aos flushes. É por processo, como os demais
// caches do projeto: uma releitura que cai em OUTRA réplica ainda conta mais uma vez.
const JANELA_DEDUPE_MS = 24 * 60 * 60 * 1000

// Teto de chaves do mapa de dedupe. Em operação normal a poda por idade (a cada tique do
// flush) segura o tamanho; o teto é a garantia de que não cresce sem limite. No teto, chave
// NOVA não entra e a visita é DESCARTADA (mesmo racional de MAX_CHAVES: sem lugar para
// lembrar, não conta) — as já presentes seguem sendo consultadas normalmente.
const MAX_CHAVES_DEDUPE = 50000

const vistos = new Map()

let flushEmAndamento = false
let descartadosPorLimite = 0
let descartadosPorLimiteDedupe = 0

const chaveDedupe = (tabela, id, usuarioId) => tabela + ':' + id + ':' + usuarioId

// Chamado no caminho quente: precisa ser síncrono e barato. Sem I/O, sem promise.
// usuarioId é quem está lendo; sem ele (chamada legada) não há dedupe e a visita conta.
const registrarVisita = (tabela, id, usuarioId) => {
  const buffer = buffers[tabela]
  if (!buffer || !id) return

  if (usuarioId) {
    const chave = chaveDedupe(tabela, id, usuarioId)
    const agora = Date.now()
    const ultimo = vistos.get(chave)
    if (ultimo !== undefined && agora - ultimo < JANELA_DEDUPE_MS) return
    if (ultimo === undefined && vistos.size >= MAX_CHAVES_DEDUPE) {
      descartadosPorLimiteDedupe++
      return
    }
    vistos.set(chave, agora)
  }

  const atual = buffer.get(id)
  if (atual === undefined && buffer.size >= MAX_CHAVES) {
    descartadosPorLimite++
    return
  }
  buffer.set(id, (atual || 0) + 1)
}

// Poda do mapa de dedupe: remove o que já saiu da janela. Roda a cada tique do flush (30s);
// varrer até 50k chaves nesse intervalo é barato. Devolve quantas saíram, só para o log.
const podarVistos = () => {
  const limite = Date.now() - JANELA_DEDUPE_MS
  let removidos = 0
  for (const [chave, visto] of vistos) {
    if (visto < limite) {
      vistos.delete(chave)
      removidos++
    }
  }
  return removidos
}

// Grava o buffer de UMA tabela num único statement e desconta o que foi gravado.
// `tabela` vem das chaves de `buffers` (whitelist fechada), nunca do request — a
// interpolação no SQL não é superfície de injeção, mesmo racional de rejeitarConcorrentes.
const flushTabela = async (tabela) => {
  const buffer = buffers[tabela]
  if (buffer.size === 0) return 0

  // Snapshot ANTES do await: o que chegar durante o UPDATE não entra neste lote.
  const ids = [...buffer.keys()]
  const deltas = ids.map(id => buffer.get(id))

  await pool.query(
    `UPDATE ${tabela} d
        SET total_visitas = COALESCE(d.total_visitas, 0) + v.delta
       FROM unnest($1::uuid[], $2::int[]) AS v(id, delta)
      WHERE d.id = v.id`,
    [ids, deltas]
  )

  // Desconta SÓ o snapshot, em vez de limpar o mapa: incremento que chegou durante o UPDATE
  // sobrevive para a próxima rodada. Se o UPDATE tivesse falhado, nada seria descontado e o
  // lote inteiro seria retentado — por isso este trecho fica DEPOIS do await.
  ids.forEach((id, i) => {
    const restante = (buffer.get(id) || 0) - deltas[i]
    if (restante > 0) buffer.set(id, restante)
    else buffer.delete(id)
  })
  return ids.length
}

// Idempotente sob concorrência: se o flush anterior ainda está rodando (banco lento), este
// tique sai sem fazer nada. Sem essa trava dois flushes leriam o mesmo snapshot e somariam
// o mesmo delta duas vezes.
const flushVisitas = async () => {
  if (flushEmAndamento) {
    console.warn('[Visitas] flush anterior ainda em andamento — tique ignorado')
    return
  }
  flushEmAndamento = true
  try {
    let totalObras = 0
    let totalReparos = 0
    // Cada tabela com o seu try: falha numa não impede a outra de gravar.
    try { totalObras = await flushTabela('obras') }
    catch (err) { console.error('[Visitas] flush obras falhou (contadores mantidos):', err.message) }
    try { totalReparos = await flushTabela('reparos') }
    catch (err) { console.error('[Visitas] flush reparos falhou (contadores mantidos):', err.message) }

    if (totalObras > 0 || totalReparos > 0) {
      console.log(`[Visitas] flush | obras=${totalObras} reparos=${totalReparos}`)
    }
    if (descartadosPorLimite > 0) {
      console.warn(`[Visitas] ${descartadosPorLimite} visita(s) descartada(s) por teto de ${MAX_CHAVES} chaves`)
      descartadosPorLimite = 0
    }
    if (descartadosPorLimiteDedupe > 0) {
      console.warn('[Visitas] ' + descartadosPorLimiteDedupe + ' visita(s) descartada(s) por teto de ' + MAX_CHAVES_DEDUPE + ' chaves do dedupe')
      descartadosPorLimiteDedupe = 0
    }
    // Poda do dedupe fica no tique do flush para não precisar de um segundo timer.
    const podados = podarVistos()
    if (podados > 0) {
      console.log('[Visitas] dedupe | podados=' + podados + ' restantes=' + vistos.size)
    }
  } finally {
    flushEmAndamento = false
  }
}

const iniciarFlushVisitas = () => setInterval(() => { flushVisitas() }, INTERVALO_FLUSH_MS)

module.exports = { registrarVisita, flushVisitas, iniciarFlushVisitas, INTERVALO_FLUSH_MS, JANELA_DEDUPE_MS }
