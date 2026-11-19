// ROBÔ DE WHATSAPP — ETAPA 2: tipo 'pergunta_sem_resposta' (dono, 17/11/2026). Roda na API (jobs
// de server.js); o worker (src/whatsapp) continua só enviando e recebendo.
//
// IDA — enfileirarPerguntasSemResposta(): pergunta de um interessado num pedido ABERTO, sem
//   resposta do dono 30 min depois de feita → uma linha na fila para o dono (chave de dedupe
//   'pergunta:<id>': a mesma pergunta nunca é avisada duas vezes). O worker junta as perguntas do
//   mesmo dono numa mensagem só (até 5, numeradas), respeita 1 mensagem por pessoa a cada 3 h e
//   tira da fila a pergunta que o dono respondeu no app antes do envio (src/whatsapp/fila.js).
//   Só enfileira com o tipo LIGADO no painel e com o worker dizendo que pode enviar (trava de
//   teste em whatsapp_estado.trava): sem isso a fila encheria de avisos velhos.
//
// VOLTA — processarRecebidas({ responder }): cada mensagem recebida (whatsapp_recebidas com
//   processada_em NULL) é casada com a pergunta: (1) pela mensagem CITADA; (2) se a pessoa só tem
//   uma pergunta pendente, é ela; (3) pelo número no começo ("2 sim…"); senão o robô pede o
//   número. Áudio/mídia → pede texto. A resposta entra pelo MESMO caminho do app
//   (`responder` = routes/index.responderPergunta: mesmas regras, sanitizador e aviso ao
//   profissional), com a origem 'whatsapp' na caixa-preta (auditoriaDemanda.comOrigem → o
//   set_config('app.origem', …, true) de toda escrita em pedidos feita ali dentro).
//
// SIMULAÇÃO — simularPergunta() (POST /admin/whatsapp/simular-pergunta, dono, 18/11/2026): UMA
//   pergunta de mentira (whatsapp_mensagens.sandbox = true, sem pergunta nem pedido de verdade)
//   para o número da trava de teste. A volta casa do mesmo jeito (citada / única / número), mas
//   NADA vai para o app: a resposta fica só na linha (`resposta`, para o painel) e a pessoa
//   recebe o "✅ Pronto!…" de sempre.
const { pool } = require('../utils/supabase')
const { comOrigem } = require('../utils/auditoriaDemanda')
const { enfileirar } = require('./whatsappFilaService')
const { lerConfig, sqlPerguntaPendente, TIPO_PERGUNTA } = require('../whatsapp/fila')
const { TIPO_RESPOSTA, ESPERA_PERGUNTA_MIN, IDADE_MAXIMA_PERGUNTA_HORAS, normalizarTelefone, variantesTelefone, lerTrava, travaPermite, dentroDaJanela } = require('../whatsapp/config')
const T = require('../whatsapp/textos')

const MIDIAS_COM_RESPOSTA = ['audio', 'imagem', 'video', 'documento', 'figurinha']
// Resposta a uma mensagem nossa vale por até 7 dias depois do envio.
const VALIDADE_RESPOSTA_DIAS = 7

// O que o worker gravou sobre a própria trava (WHATSAPP_SOMENTE_PARA): null = não pode enviar.
const travaDoWorker = async (db) => {
  const r = await db.query(`SELECT trava FROM whatsapp_estado WHERE id = 1`)
  return lerTrava({ WHATSAPP_SOMENTE_PARA: r.rows[0]?.trava || '' })
}

const enfileirarPerguntasSemResposta = async (db = pool) => {
  const config = await lerConfig(db)
  if (!config.tipos[TIPO_PERGUNTA]) return { enfileiradas: 0, motivo: 'tipo_desligado' }
  const trava = await travaDoWorker(db)
  if (trava.modo === 'ausente') return { enfileiradas: 0, motivo: 'sem_trava' }
  const r = await db.query(
    `SELECT pq.id, pq.tipo, pq.demanda_id, pq.pergunta, d.titulo, d.criado_por,
            dono.nome AS dono_nome, dono.telefone AS dono_telefone, autor.nome AS autor_nome
       FROM perguntas_demanda pq
       JOIN LATERAL (
              SELECT titulo, criado_por FROM reparos WHERE pq.tipo = 'reparo' AND id = pq.demanda_id
              UNION ALL
              SELECT titulo, criado_por FROM obras WHERE pq.tipo = 'obra' AND id = pq.demanda_id
            ) d ON true
       JOIN usuarios dono ON dono.id = d.criado_por
       JOIN usuarios autor ON autor.id = pq.autor_id
      WHERE ${sqlPerguntaPendente('pq', 'NOW()')}
        AND pq.criado_em <= NOW() - INTERVAL '${ESPERA_PERGUNTA_MIN} minutes'
        AND pq.criado_em > NOW() - INTERVAL '${IDADE_MAXIMA_PERGUNTA_HORAS} hours'
        AND COALESCE(dono.ativo, true) AND COALESCE(dono.whatsapp_avisos, true)
        AND NOT EXISTS (SELECT 1 FROM whatsapp_mensagens m WHERE m.chave_dedupe = 'pergunta:' || pq.id::text)
      ORDER BY pq.criado_em, pq.id
      LIMIT 200`)
  let enfileiradas = 0
  for (const p of r.rows) {
    const telefone = normalizarTelefone(p.dono_telefone)
    // Número fora da trava de teste: nem entra (o worker barraria; assim não suja a lista do
    // painel e a pergunta ainda pode ser avisada quando a trava abrir, se continuar valendo).
    if (!telefone || !travaPermite(trava, telefone)) continue
    const dados = {
      primeiro_nome: T.primeiroNome(p.dono_nome), titulo: p.titulo, nome_prof: T.primeiroNome(p.autor_nome),
      pergunta: p.pergunta, demanda_id: p.demanda_id, tabela: p.tipo === 'obra' ? 'obras' : 'reparos', pergunta_id: p.id,
    }
    const e = await enfileirar({
      tipo: TIPO_PERGUNTA, usuarioId: p.criado_por, telefone,
      // Texto de UMA pergunta; o worker redige de novo na hora do envio (agrupamento e rodapé).
      texto: T.textoPerguntas([dados]),
      refTabela: 'perguntas_demanda', refId: p.id, chaveDedupe: `pergunta:${p.id}`, dados,
    }, db)
    if (e.ok) enfileiradas++
  }
  return { enfileiradas }
}

// Dados de mentira da simulação (dono, 18/11/2026). Sem ids: não existe pedido nem pergunta.
const SIMULACAO = { primeiro_nome: 'Luiz', nome_prof: 'Carlos', titulo: 'Teste do robô', pergunta: 'Tem tinta aí ou eu levo?' }
const MAX_RESPOSTA_SIMULACAO = 1000

// Põe UMA pergunta simulada na fila, para o número da trava de teste (o primeiro, se forem
// vários). Devolve { ok, id, telefone, ja_na_fila, janela_aberta, pausado } ou { ok: false, status, erro }.
const simularPergunta = async (db = pool, agora = new Date()) => {
  const trava = await travaDoWorker(db)
  if (trava.modo === 'ausente') return { ok: false, status: 409, erro: 'O robô está sem a trava WHATSAPP_SOMENTE_PARA (ou ainda não iniciou): nada pode ser enviado.' }
  if (trava.modo !== 'lista') return { ok: false, status: 409, erro: 'A simulação só sai para o número da trava de teste, e a trava está em TODOS.' }
  const config = await lerConfig(db)
  if (!config.tipos[TIPO_PERGUNTA]) return { ok: false, status: 409, erro: 'O tipo "Pergunta sem resposta" está desligado no painel: ligue-o para a simulação sair.' }
  const telefone = trava.numeros[0]
  const extra = { janela_aberta: dentroDaJanela(agora), pausado: config.pausado }
  // Uma simulação por vez na fila: clicar de novo não empilha mensagens.
  const naFila = await db.query(`SELECT id FROM whatsapp_mensagens WHERE sandbox AND tipo = $1 AND status = 'fila' ORDER BY id LIMIT 1`, [TIPO_PERGUNTA])
  if (naFila.rows.length) return { ok: true, id: naFila.rows[0].id, telefone, ja_na_fila: true, ...extra }
  const dados = { ...SIMULACAO, sandbox: true }
  const e = await enfileirar({ tipo: TIPO_PERGUNTA, telefone, texto: T.textoPerguntas([dados]), dados, sandbox: true }, db)
  if (!e.ok) return { ok: false, status: 400, erro: `Não entrou na fila: ${e.motivo}` }
  return { ok: true, id: e.id, telefone: e.telefone, ja_na_fila: false, ...extra }
}

// Resposta automática a quem escreveu (uma por mensagem recebida).
const responderAutomatico = (db, rec, usuarioId, texto) => enfileirar({
  tipo: TIPO_RESPOSTA, usuarioId, telefone: rec.telefone, waJid: rec.wa_jid, texto, chaveDedupe: `resposta:${rec.id}`,
}, db)

const concluir = (db, rec, resultado, mensagemRef = null) => db.query(
  `UPDATE whatsapp_recebidas SET resultado = $2, mensagem_ref = $3::bigint, processada_em = NOW() WHERE id = $1::bigint`,
  [rec.id, String(resultado).slice(0, 200), mensagemRef])

// Qual pergunta a pessoa está respondendo. Devolve { alvo, texto } ou { duvida: texto do robô }.
const escolherPergunta = (rec, pendentes) => {
  const texto = String(rec.texto || '').trim()
  const lido = T.lerNumeroInicial(texto)
  // 1) Respondeu citando uma mensagem nossa.
  const citadas = rec.citada_wa_message_id ? pendentes.filter(p => p.wa_message_id === rec.citada_wa_message_id) : []
  const campo = citadas.length ? citadas : pendentes
  // 1/2) Só uma pergunta possível (a citada tinha uma só, ou a pessoa só tem uma pendente).
  if (campo.length === 1) {
    const alvo = campo[0]
    // Mensagem numerada e a pessoa começou pelo número dela: o número não faz parte da resposta.
    const semNumero = lido && alvo.item_numero != null && lido.numero === Number(alvo.item_numero) && lido.resto ? lido.resto : texto
    return { alvo, texto: semNumero }
  }
  // 3) Número no começo: o item com esse número (a mensagem mais recente primeiro).
  if (lido && lido.resto) {
    const alvo = campo.find(p => p.item_numero != null && Number(p.item_numero) === lido.numero)
    if (alvo) return { alvo, texto: lido.resto }
  }
  const numeros = [...new Set(campo.filter(p => p.item_numero != null).map(p => Number(p.item_numero)))]
  return { duvida: numeros.length ? T.textoNaoEntendi(numeros) : T.TEXTO_NAO_ENTENDI_SEM_NUMERO }
}

const processarUma = async (db, rec, responder) => {
  const formas = variantesTelefone(rec.telefone)
  // Perguntas que mandamos para este destino, ainda sem resposta (a mais recente primeiro).
  const pend = await db.query(
    `SELECT m.id, m.usuario_id, m.wa_message_id, m.item_numero, m.dados, m.sandbox, pq.id AS pergunta_id, pq.tipo AS pergunta_tipo, pq.demanda_id
       FROM whatsapp_mensagens m LEFT JOIN perguntas_demanda pq ON pq.id = m.ref_id
      WHERE m.tipo = $1 AND m.status IN ('enviada', 'entregue', 'lida') AND m.wa_message_id IS NOT NULL
        AND (m.wa_jid = $2 OR m.telefone = ANY($3::text[]))
        -- Simulação (sandbox) não tem pergunta no app: fica pendente até ser respondida aqui.
        AND (m.sandbox OR (pq.id IS NOT NULL AND pq.respondido_em IS NULL))
        AND m.enviada_em > NOW() - INTERVAL '${VALIDADE_RESPOSTA_DIAS} days'
      ORDER BY m.enviada_em DESC, m.item_numero NULLS FIRST, m.id`,
    [TIPO_PERGUNTA, rec.wa_jid, formas])
  const pendentes = pend.rows
  // Sem pergunta nossa esperando resposta: a mensagem fica guardada e o robô não puxa conversa.
  if (pendentes.length === 0) return concluir(db, rec, 'sem_pergunta_pendente')
  const dono = pendentes[0].usuario_id

  if (rec.midia) {
    if (!MIDIAS_COM_RESPOSTA.includes(rec.midia)) return concluir(db, rec, `ignorada (${rec.midia})`)
    await responderAutomatico(db, rec, dono, T.TEXTO_SO_ESCRITA)
    return concluir(db, rec, `midia (${rec.midia})`)
  }
  if (!String(rec.texto || '').trim()) return concluir(db, rec, 'ignorada (vazia)')

  const escolha = escolherPergunta(rec, pendentes)
  if (escolha.duvida) {
    await responderAutomatico(db, rec, dono, escolha.duvida)
    return concluir(db, rec, 'nao_entendida')
  }
  const { alvo, texto } = escolha
  // SIMULAÇÃO: nada vai para o app (não existe pergunta nem pedido) — a resposta fica só na linha,
  // para o painel, e a pessoa recebe o "✅ Pronto!…" de sempre.
  if (alvo.sandbox) {
    await db.query(
      `UPDATE whatsapp_mensagens SET status = 'respondida', respondida_em = NOW(), resposta = $2, atualizado_em = NOW() WHERE id = $1::bigint`,
      [alvo.id, texto.slice(0, MAX_RESPOSTA_SIMULACAO)])
    await responderAutomatico(db, rec, dono, T.textoEntregue(alvo.dados?.nome_prof || 'o profissional'))
    return concluir(db, rec, 'entregue (simulação)', alvo.id)
  }
  // A MESMA função da rota do app; origem 'whatsapp' na caixa-preta para o que ela escrever em pedidos.
  const r = await comOrigem({ origem: 'whatsapp', rota: 'whatsapp:resposta-pergunta', usuarioId: alvo.usuario_id }, () => responder({
    tabela: alvo.pergunta_tipo === 'obra' ? 'obras' : 'reparos', demandaId: alvo.demanda_id, perguntaId: alvo.pergunta_id,
    usuarioId: alvo.usuario_id, resposta: texto,
  }))
  if (r.status !== 200) {
    await responderAutomatico(db, rec, dono, T.textoNaoEntregue(r.body?.erro))
    return concluir(db, rec, `recusada (${r.status}): ${r.body?.erro || ''}`, alvo.id)
  }
  // Painel: a linha da pergunta vira 'respondida' com o texto que foi gravado (já sanitizado).
  await db.query(
    `UPDATE whatsapp_mensagens SET status = 'respondida', respondida_em = NOW(), resposta = $2, atualizado_em = NOW() WHERE id = $1::bigint`,
    [alvo.id, r.body.resposta])
  await responderAutomatico(db, rec, dono, T.textoEntregue(alvo.dados?.nome_prof || 'o profissional'))
  return concluir(db, rec, 'entregue', alvo.id)
}

// Uma passada: até 20 mensagens recebidas, na ordem de chegada. `responder` = a função interna
// que o app usa para responder pergunta (injetada por server.js; evita import circular).
const processarRecebidas = async ({ responder }, db = pool) => {
  const r = await db.query(
    `SELECT id, wa_message_id, wa_jid, telefone, texto, citada_wa_message_id, midia
       FROM whatsapp_recebidas WHERE processada_em IS NULL ORDER BY id LIMIT 20`)
  let processadas = 0
  for (const rec of r.rows) {
    try {
      await processarUma(db, rec, responder)
    } catch (err) {
      console.error(`[whatsapp/recebidas] ${rec.id}:`, err.message)
      await concluir(db, rec, `erro: ${err.message}`).catch(() => {})
    }
    processadas++
  }
  return { processadas }
}

// Jobs de server.js: nunca dois ao mesmo tempo, erro vira log.
const semSobrepor = (nome, fn) => {
  let rodando = false
  return async () => {
    if (rodando) return
    rodando = true
    try { await fn() } catch (err) { console.error(`[whatsapp/${nome}]`, err.message) } finally { rodando = false }
  }
}

module.exports = { enfileirarPerguntasSemResposta, processarRecebidas, escolherPergunta, semSobrepor, simularPergunta, SIMULACAO }
