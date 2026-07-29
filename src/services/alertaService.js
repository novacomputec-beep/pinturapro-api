const { pool } = require('../utils/supabase')
const { Expo } = require('expo-server-sdk')
const { getFaixa } = require('../utils/faixasPrazo')

const expo = new Expo()

// Consulta os recibos de entrega (depois de um intervalo, pois o Expo processa a
// entrega de forma assíncrona) e remove tokens reportados como DeviceNotRegistered.
// Recebe pares { ticket, pushToken } de tickets já confirmados como 'ok'.
// É chamada em fire-and-forget — qualquer erro é apenas logado, nunca propagado.
const processarRecibos = async (ticketsComToken, delayMs = 15000) => {
  const receiptIdToToken = {}
  for (const { ticket, pushToken } of ticketsComToken) {
    if (ticket && ticket.status === 'ok' && ticket.id) {
      receiptIdToToken[ticket.id] = pushToken
    }
  }
  const receiptIds = Object.keys(receiptIdToToken)
  if (receiptIds.length === 0) return

  // Aguarda o Expo concluir a entrega antes de consultar os recibos
  await new Promise(resolve => setTimeout(resolve, delayMs))

  const tokensInvalidos = new Set()
  const idChunks = expo.chunkPushNotificationReceiptIds(receiptIds)
  for (const chunk of idChunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk)
      for (const [receiptId, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'error') {
          const erro = receipt.details?.error
          console.error('[Push] Recibo com erro | erro:', erro || 'n/a', '| msg:', receipt.message)
          if (erro === 'DeviceNotRegistered') {
            tokensInvalidos.add(receiptIdToToken[receiptId])
          }
        }
      }
    } catch (err) {
      console.error('[Push] Erro ao consultar recibos:', err.message)
    }
  }

  if (tokensInvalidos.size > 0) {
    try {
      await pool.query(
        `UPDATE usuarios SET push_token = NULL WHERE push_token = ANY($1)`,
        [[...tokensInvalidos]]
      )
      console.log(`[Push] ${tokensInvalidos.size} token(s) inválido(s) removido(s) (DeviceNotRegistered)`)
    } catch (err) {
      console.error('[Push] Erro ao remover tokens inválidos:', err.message)
    }
  }
}

const enviarPushNotificacao = async (pushToken, titulo, corpo, data = {}) => {
  if (!Expo.isExpoPushToken(pushToken)) {
    console.warn('[Push] Token inválido ou ausente:', pushToken ? pushToken.substring(0, 30) : 'null')
    return
  }
  try {
    const tickets = await expo.sendPushNotificationsAsync([{
      to: pushToken,
      sound: 'default',
      channelId: 'default_v2',
      title: titulo,
      body: corpo,
      data,
    }])
    const ticket = tickets[0]
    if (ticket && ticket.status === 'error') {
      console.error(
        '[Push] Falha no envio:', titulo,
        '| erro:', ticket.message,
        '| detalhe:', ticket.details?.error || 'n/a',
        '→', pushToken.substring(0, 30)
      )
    } else {
      console.log('[Push] Enviado:', titulo, '→', pushToken.substring(0, 30))
      processarRecibos([{ ticket, pushToken }]).catch(err =>
        console.error('[Push] Erro no processamento de recibos:', err.message))
    }
  } catch (err) {
    console.error('[Push] Erro ao enviar:', err.message)
  }
}

// Envia notificações em lote para múltiplos tokens de uma vez
// Muito mais eficiente que um loop sequencial com await
const enviarPushEmLote = async (destinatarios, titulo, corpo, data = {}) => {
  const mensagens = destinatarios
    .filter(d => Expo.isExpoPushToken(d.push_token))
    .map(d => ({
      to: d.push_token,
      sound: 'default',
      channelId: 'default_v2',
      title: titulo,
      body: corpo,
      data,
    }))

  if (mensagens.length === 0) return 0

  // Expo recomenda chunks de até 100 mensagens por chamada
  const chunks = expo.chunkPushNotifications(mensagens)
  const ticketsComToken = []
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk)
      tickets.forEach((ticket, i) => {
        const pushToken = chunk[i].to
        if (ticket && ticket.status === 'error') {
          console.error(
            '[Push] Falha no envio (lote):', titulo,
            '| erro:', ticket.message,
            '| detalhe:', ticket.details?.error || 'n/a',
            '→', pushToken.substring(0, 30)
          )
        } else {
          ticketsComToken.push({ ticket, pushToken })
        }
      })
    } catch (err) {
      console.error('Erro ao enviar chunk de notificações:', err)
    }
  }

  if (ticketsComToken.length > 0) {
    processarRecibos(ticketsComToken).catch(err =>
      console.error('[Push] Erro no processamento de recibos:', err.message))
  }

  return mensagens.length
}

const enviarBoasVindas = async (usuarioId) => {
  try {
    const result = await pool.query(
      `SELECT push_token, nome, role FROM usuarios WHERE id = $1`,
      [usuarioId]
    )
    if (!result.rows[0]?.push_token) return

    const { push_token, nome, role } = result.rows[0]
    const primeiroNome = nome?.split(' ')[0] || 'bem-vindo'

    let mensagem = ''
    if (role === 'assinante') {
      mensagem = 'Explore obras de pintura disponíveis na sua região agora mesmo!'
    } else if (role === 'prestador') {
      mensagem = 'Explore reparos e serviços disponíveis na sua região agora mesmo!'
    } else if (role === 'dono_obra') {
      mensagem = 'Cadastre sua primeira obra ou reparo e encontre profissionais qualificados!'
    }

    await enviarPushNotificacao(
      push_token,
      `🎉 Bem-vindo ao ArrumaPro, ${primeiroNome}!`,
      mensagem,
      { tipo: 'boas_vindas' }
    )
  } catch (err) {
    console.error('Erro ao enviar boas vindas:', err)
  }
}

const notificarPintoresSobreNovaObra = async (obraId) => {
  try {
    const obraResult = await pool.query(
      `SELECT titulo, cidade FROM obras WHERE id = $1`,
      [obraId]
    )
    if (obraResult.rows.length === 0) return
    const obra = obraResult.rows[0]

    const pintores = await pool.query(
      `SELECT u.push_token
       FROM usuarios u
       JOIN assinaturas a ON a.usuario_id = u.id
       WHERE u.role = 'prestador' AND u.tipo_prestador = 'pintor'
         AND a.status = 'ativa'
         AND u.push_token IS NOT NULL
       LIMIT 500`
    )

    const total = await enviarPushEmLote(
      pintores.rows,
      '🎨 Nova obra disponível!',
      `"${obra.titulo}" em ${obra.cidade} acabou de ser publicada!`,
      { tipo: 'nova_obra', obra_id: obraId }
    )
    console.log(`Notificados ${total} pintores sobre nova obra`)
  } catch (err) {
    console.error('Erro ao notificar pintores:', err)
  }
}

const notificarPrestadoresSobreNovoReparo = async (reparoId) => {
  try {
    const reparoResult = await pool.query(
      `SELECT titulo, cidade, categoria FROM reparos WHERE id = $1`,
      [reparoId]
    )
    if (reparoResult.rows.length === 0) return
    const reparo = reparoResult.rows[0]

    const prestadores = await pool.query(
      `SELECT u.push_token
       FROM usuarios u
       WHERE u.role = 'prestador' AND u.tipo_prestador IS DISTINCT FROM 'pintor'
         AND u.push_token IS NOT NULL
       LIMIT 500`
    )

    const total = await enviarPushEmLote(
      prestadores.rows,
      '🔧 Novo reparo disponível!',
      `"${reparo.titulo}" em ${reparo.cidade} — categoria: ${reparo.categoria}`,
      { tipo: 'novo_reparo', reparo_id: reparoId }
    )
    console.log(`Notificados ${total} prestadores sobre novo reparo`)
  } catch (err) {
    console.error('Erro ao notificar prestadores:', err)
  }
}

const verificarObrasExpirando = async () => {
  try {
    const obras = await pool.query(`
      SELECT o.id, o.titulo, u.push_token
      FROM obras o
      JOIN usuarios u ON o.criado_por = u.id
      WHERE o.status = 'aberta'
        AND o.expira_em BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
        AND o.alerta_enviado_em IS NULL
        AND u.push_token IS NOT NULL
    `)

    // Atualiza alerta_enviado_em em lote antes de notificar
    if (obras.rows.length > 0) {
      const ids = obras.rows.map(o => o.id)
      await pool.query(
        `UPDATE obras SET alerta_enviado_em = NOW() WHERE id = ANY($1)`,
        [ids]
      )
      await enviarPushEmLote(
        obras.rows,
        '⏰ Sua obra expira em 24 horas!',
        'Sua obra será encerrada em breve. Renove para continuar recebendo candidatos.',
        { tipo: 'obra_expirando' }
      )
    }

    const reparos = await pool.query(`
      SELECT r.id, r.titulo, u.push_token
      FROM reparos r
      JOIN usuarios u ON r.criado_por = u.id
      WHERE r.status = 'aberta'
        AND r.expira_em BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
        AND r.alerta_enviado_em IS NULL
        AND u.push_token IS NOT NULL
    `)

    if (reparos.rows.length > 0) {
      const ids = reparos.rows.map(r => r.id)
      await pool.query(
        `UPDATE reparos SET alerta_enviado_em = NOW() WHERE id = ANY($1)`,
        [ids]
      )
      await enviarPushEmLote(
        reparos.rows,
        '⏰ Seu reparo expira em 24 horas!',
        'Seu reparo será encerrado em breve.',
        { tipo: 'reparo_expirando' }
      )
    }

    console.log(`Expiração: ${obras.rows.length} obras e ${reparos.rows.length} reparos notificados`)
  } catch (err) {
    console.error('Erro ao verificar obras expirando:', err)
  }
}

const verificarObrasComBaixoEngajamento = async () => {
  try {
    console.log('Verificando obras com baixo engajamento...')

    const obras = await pool.query(`
      SELECT o.id, o.titulo, o.total_visitas, u.push_token
      FROM obras o
      JOIN usuarios u ON o.criado_por = u.id
      WHERE o.status = 'aberta'
        AND o.status_aprovacao = 'aprovada'
        AND o.total_visitas >= 10
        AND o.criado_em < NOW() - INTERVAL '1 day'
        AND (o.alerta_enviado_em IS NULL OR o.alerta_enviado_em < NOW() - INTERVAL '24 hours')
        AND NOT EXISTS (
          SELECT 1 FROM candidaturas c
          WHERE c.obra_id = o.id AND c.status = 'pendente'
        )
        AND u.push_token IS NOT NULL
    `)

    if (obras.rows.length > 0) {
      const ids = obras.rows.map(o => o.id)
      await pool.query(`UPDATE obras SET alerta_enviado_em = NOW() WHERE id = ANY($1)`, [ids])

      // Envio individual aqui pois a mensagem inclui total_visitas específico de cada obra
      for (const obra of obras.rows) {
        await enviarPushNotificacao(
          obra.push_token,
          '💡 Considere aumentar sua oferta',
          `Sua obra "${obra.titulo}" teve ${obra.total_visitas} visitas e nenhum interessado ainda.`,
          { tipo: 'baixo_engajamento', obra_id: obra.id }
        )
      }
    }

    const reparos = await pool.query(`
      SELECT r.id, r.titulo, r.total_visitas, u.push_token
      FROM reparos r
      JOIN usuarios u ON r.criado_por = u.id
      WHERE r.status = 'aberta'
        AND r.status_aprovacao = 'aprovada'
        AND r.total_visitas >= 10
        AND r.criado_em < NOW() - INTERVAL '1 day'
        AND (r.alerta_enviado_em IS NULL OR r.alerta_enviado_em < NOW() - INTERVAL '8 hours')
        AND NOT EXISTS (
          SELECT 1 FROM interesse_reparos ir
          WHERE ir.reparo_id = r.id AND ir.status = 'pendente'
        )
        AND u.push_token IS NOT NULL
    `)

    if (reparos.rows.length > 0) {
      const ids = reparos.rows.map(r => r.id)
      await pool.query(`UPDATE reparos SET alerta_enviado_em = NOW() WHERE id = ANY($1)`, [ids])

      for (const reparo of reparos.rows) {
        await enviarPushNotificacao(
          reparo.push_token,
          '💡 Considere aumentar sua oferta',
          `Seu reparo "${reparo.titulo}" teve ${reparo.total_visitas} visitas e nenhum interessado ainda.`,
          { tipo: 'baixo_engajamento_reparo', reparo_id: reparo.id }
        )
      }
    }

    console.log(`Engajamento: ${obras.rows.length} obras e ${reparos.rows.length} reparos notificados`)
  } catch (err) {
    console.error('Erro ao verificar engajamento:', err)
  }
}

// Marcos de expiração PROPORCIONAIS à faixa de prazo da demanda (ver src/utils/faixasPrazo.js).
// Alerta o dono de uma demanda SEM match e SEM interessados em 3 marcos cujos offsets VARIAM por
// faixa: ex. faixa 1h → [15,10,5] min antes de expira_em; faixa 168h → [1 dia, 8h, 4h]. Cada push
// tem deep-link para a tela de detalhe (onde fica o botão de estender).
//
// Bandas contíguas e DISJUNTAS a partir dos 3 offsets [m1>m2>m3]:
//   marco_1: (m2, m1]   marco_2: (m3, m2]   marco_3: (0, m3]
// Como não se sobrepõem, a demanda cai em no máximo uma banda por run → no máximo um push por marco
// (reforçado pelo claim marco_N_em IS NULL). Demanda que só aparece já dentro da banda menor recebe
// só aquele alerta (cobertura, não sequência). SEM backfill anti-rajada: as bandas disjuntas já
// garantem no máximo um disparo por run, então o 1º run pós-deploy não gera rajada de alertas.
//
// Elegibilidade: status='aberta', match_usuario_id IS NULL, sem interesse (obras: NOT EXISTS
// candidaturas; reparos: NOT EXISTS interesse_reparos), dono com push_token entregável. Obras
// exigem status_aprovacao='aprovada' (reparos não, por decisão).
//
// Claim-then-send replica-safe: o SELECT reúne candidatos; o UPDATE ... WHERE marco_N_em IS NULL
// RETURNING reivindica a coluna atomicamente — a 2ª réplica vê a coluna já preenchida e retorna 0
// linhas, então só uma envia o push. Faixa desconhecida (getFaixa null) → pula com log, sem crash.

// Formata minutos em rótulo PT-BR curto: 5→"5 minutos", 60→"1 hora", 90→"1h30", 1440→"1 dia".
const formatarTempoRestante = (min) => {
  if (min >= 1440) { const d = Math.round(min / 1440); return d === 1 ? '1 dia' : `${d} dias` }
  if (min >= 60) {
    const h = Math.floor(min / 60), m = min % 60
    if (m === 0) return h === 1 ? '1 hora' : `${h} horas`
    return `${h}h${String(m).padStart(2, '0')}`
  }
  return `${min} minutos`
}

// `interesse`: subconsulta do NOT EXISTS que suprime o alerta quando a demanda JÁ tem
// interessado. Testava só a EXISTÊNCIA da linha, então uma candidatura/interesse já
// RECUSADO calava o alerta para sempre — justamente quando o dono mais precisa dele
// (demanda expirando e sem ninguém vivo na fila). Agora só linhas vivas suprimem.
// IS DISTINCT FROM (e não <>) por ser NULL-safe: status NULL continua suprimindo, como hoje.
const verificarMarcosExpiracao = async () => {
  const lados = [
    { tabela: 'obras',   idKey: 'obra_id',   janelaCol: 'horas_para_expirar',      substantivo: 'Sua obra',   verbo: 'Estenda o prazo',
      tipoPrefixo: 'obra_expirando',   statusAprovacao: `AND d.status_aprovacao = 'aprovada'`, interesse: `SELECT 1 FROM candidaturas c WHERE c.obra_id = d.id AND c.status IS DISTINCT FROM 'recusado'` },
    { tabela: 'reparos', idKey: 'reparo_id', janelaCol: 'prazo_atendimento_horas', substantivo: 'Seu reparo', verbo: 'Aumente o prazo',
      tipoPrefixo: 'reparo_expirando', statusAprovacao: '',                          interesse: `SELECT 1 FROM interesse_reparos ir WHERE ir.reparo_id = d.id AND ir.status IS DISTINCT FROM 'recusado'` },
  ]

  let totalEnviados = 0
  try {
    for (const lado of lados) {
      // Candidatos elegíveis com algum marco pendente e expira_em dentro do MAIOR offset possível
      // (1440min = 24h, faixa 168) — demandas mais distantes que isso não entram em banda nenhuma.
      const candidatos = await pool.query(`
        SELECT d.id, d.titulo, d.${lado.janelaCol} AS janela, d.expira_em,
               d.marco_1_em, d.marco_2_em, d.marco_3_em, u.push_token
        FROM ${lado.tabela} d
        JOIN usuarios u ON d.criado_por = u.id
        WHERE d.status = 'aberta'
          ${lado.statusAprovacao}
          AND d.match_usuario_id IS NULL
          AND u.push_token IS NOT NULL AND u.push_token <> ''
          AND NOT EXISTS (${lado.interesse})
          AND (d.marco_1_em IS NULL OR d.marco_2_em IS NULL OR d.marco_3_em IS NULL)
          AND d.expira_em > NOW()
          AND d.expira_em <= NOW() + INTERVAL '1440 minutes'
      `)

      for (const d of candidatos.rows) {
        const faixa = getFaixa(Math.round(Number(d.janela)))
        if (!faixa) {
          console.warn(`[MarcosExpiracao] faixa desconhecida (janela=${d.janela}) — ${lado.tabela} ${d.id} ignorado`)
          continue
        }
        const [m1, m2, m3] = faixa.milestones
        const restante = (new Date(d.expira_em).getTime() - Date.now()) / 60000

        // Banda disjunta — no máximo um marco por run.
        let alvo = null
        if      (d.marco_1_em === null && restante <= m1 && restante > m2) alvo = { n: 1, col: 'marco_1_em', offset: m1 }
        else if (d.marco_2_em === null && restante <= m2 && restante > m3) alvo = { n: 2, col: 'marco_2_em', offset: m2 }
        else if (d.marco_3_em === null && restante <= m3 && restante > 0)  alvo = { n: 3, col: 'marco_3_em', offset: m3 }
        if (!alvo) continue

        // Claim-then-send: reivindica a coluna no mesmo UPDATE (replica-safe).
        const claim = await pool.query(
          `UPDATE ${lado.tabela} SET ${alvo.col} = NOW() WHERE id = $1 AND ${alvo.col} IS NULL RETURNING id`,
          [d.id]
        )
        if (claim.rows.length === 0) continue

        const label = formatarTempoRestante(alvo.offset)
        const titulo = `⏰ ${lado.substantivo} está expirando`
        const corpo = alvo.n === 3
          ? `Última chance: ${lado.substantivo.toLowerCase()} '${d.titulo}' expira em menos de ${label} e ainda não tem interessados. ${lado.verbo} agora.`
          : `${lado.substantivo} '${d.titulo}' expira em menos de ${label} e ainda não tem interessados. ${lado.verbo}.`
        await enviarPushEmLote(
          [{ push_token: d.push_token }],
          titulo,
          corpo,
          { tipo: `${lado.tipoPrefixo}_${alvo.n}`, [lado.idKey]: d.id }
        )
        totalEnviados++
      }
    }
    console.log(`[MarcosExpiracao] ${totalEnviados} alerta(s) de expiração enviado(s)`)
  } catch (err) {
    console.error('Erro ao verificar marcos de expiração:', err.message)
  }
}

// Cronômetro de matches de reparos.
// O prazo do cronômetro inicia em match_feito_em e dura prazo_atendimento_horas.
// (a) A 5 minutos do fim: avisa o dono uma única vez por match.
// (b) Quando o cronômetro zera: devolve o reparo ao feed e limpa o match.
const verificarCronometroReparos = async () => {
  try {
    // (a) 5 minutos restantes → notifica o dono (uma vez por match)
    const cincoMin = await pool.query(`
      SELECT r.id, r.titulo, u.push_token
      FROM reparos r
      JOIN usuarios u ON r.criado_por = u.id
      WHERE r.match_usuario_id IS NOT NULL
        AND r.prazo_atendimento_horas IS NOT NULL
        AND r.notif_5min_enviada = false
        AND u.push_token IS NOT NULL
        AND r.expira_em BETWEEN NOW() AND NOW() + INTERVAL '5 minutes'
    `)

    if (cincoMin.rows.length > 0) {
      const ids = cincoMin.rows.map(r => r.id)
      await pool.query(`UPDATE reparos SET notif_5min_enviada = true WHERE id = ANY($1)`, [ids])

      for (const reparo of cincoMin.rows) {
        await enviarPushNotificacao(
          reparo.push_token,
          '⏰ O prestador ainda não chegou?',
          'Faltam 5 minutos. Se ele ainda não chegou, você pode aumentar o prazo ou aguardar o cronômetro zerar.',
          { tipo: 'reparo_5min_restantes', reparo_id: reparo.id }
        )
      }
    }

    // (b) Cronômetro zerou → devolve o reparo ao feed e limpa o match,
    // reiniciando a contagem com o prazo original configurado na criação.
    // status = 'aberta' no WHERE (espelha o cron de obras): sem ele, um reparo já
    // ENCERRADO com expira_em vencido seria ressuscitado para o feed e perderia o
    // match. Reparo casado permanece 'aberta' (/reparos/:id/match não mexe no status),
    // então o filtro não exclui nenhuma linha legítima do cronômetro.
    const expirados = await pool.query(`
      UPDATE reparos SET
        status = 'aberta',
        match_feito_em = NULL,
        match_usuario_id = NULL,
        notif_5min_enviada = false,
        pedido_tempo_status = NULL,
        pedido_tempo_motivo = NULL,
        pedido_tempo_minutos = NULL,
        expira_em = NOW() + (prazo_atendimento_horas * INTERVAL '1 hour')
      WHERE status = 'aberta'
        AND match_usuario_id IS NOT NULL
        AND prazo_atendimento_horas IS NOT NULL
        AND expira_em <= NOW()
      RETURNING id
    `)

    console.log(`[CronômetroReparos] 5min notificados: ${cincoMin.rows.length} | matches expirados (devolvidos ao feed): ${expirados.rows.length}`)
  } catch (err) {
    console.error('Erro ao verificar cronômetro de reparos:', err.message)
  }
}

// Cronômetro de matches de obras — espelha verificarCronometroReparos com as colunas reais de obra.
// Prazo único: a contagem pós-match vai até o expira_em ORIGINAL (o match não reseta expira_em).
// (a) A 5 minutos do fim: avisa o dono uma única vez por match (notif_5min_enviada).
// (b) Quando expira_em zera: devolve a obra ao feed e limpa o match, reiniciando a janela
//     PRÉ-match (horas_para_expirar) para a próxima rodada de candidatos.
const verificarCronometroObras = async () => {
  try {
    // (a) 5 minutos restantes → notifica o dono (uma vez por match)
    const cincoMin = await pool.query(`
      SELECT o.id, o.titulo, u.push_token
      FROM obras o
      JOIN usuarios u ON o.criado_por = u.id
      WHERE o.status = 'aberta'
        AND o.match_usuario_id IS NOT NULL
        AND o.notif_5min_enviada = false
        AND u.push_token IS NOT NULL
        AND o.expira_em BETWEEN NOW() AND NOW() + INTERVAL '5 minutes'
    `)

    if (cincoMin.rows.length > 0) {
      const ids = cincoMin.rows.map(o => o.id)
      await pool.query(`UPDATE obras SET notif_5min_enviada = true WHERE id = ANY($1)`, [ids])

      for (const obra of cincoMin.rows) {
        await enviarPushNotificacao(
          obra.push_token,
          '⏰ O pintor ainda não chegou?',
          'Faltam 5 minutos. Se ele ainda não chegou, você pode aumentar o prazo ou aguardar o cronômetro zerar.',
          { tipo: 'obra_5min_restantes', obra_id: obra.id }
        )
      }
    }

    // (b) Cronômetro zerou → devolve a obra ao feed e limpa o match, reiniciando a contagem
    // com a janela original. COALESCE(horas_para_expirar, 720): horas_para_expirar pode ser NULL
    // em obras legadas; sem o COALESCE, NOW() + NULL = NULL e a obra sumiria do feed para sempre
    // (expira_em > NOW() nunca casa NULL). 720h = default de criação (mesma base de index.js:960).
    const expirados = await pool.query(`
      UPDATE obras SET
        status = 'aberta',
        match_feito_em = NULL,
        match_usuario_id = NULL,
        notif_5min_enviada = false,
        expira_em = NOW() + (COALESCE(horas_para_expirar, 720) * INTERVAL '1 hour')
      WHERE status = 'aberta'
        AND match_usuario_id IS NOT NULL
        AND expira_em <= NOW()
      RETURNING id
    `)

    console.log(`[CronômetroObras] 5min notificados: ${cincoMin.rows.length} | matches expirados (devolvidos ao feed): ${expirados.rows.length}`)
  } catch (err) {
    console.error('Erro ao verificar cronômetro de obras:', err.message)
  }
}

// Encerramento em duas mãos: fecha sozinho a solicitação que a outra parte não confirmou
// em 2 dias. Sem isto uma parte silenciosa deixaria a demanda pendente para sempre.
// status = 'aberta' no WHERE (mesma lição do cron de reparos): a demanda só é candidata
// enquanto NÃO está encerrada. Notifica quem NÃO pediu — quem pediu já sabe.
const AUTO_ENCERRAR_APOS = '2 days'

const autoEncerrarPendentes = async () => {
  // tabela e coluna de id saem desta lista literal, nunca do request — interpolação segura.
  const lados = [
    { tabela: 'obras',   chave: 'obra_id',   tipoPush: 'obra_encerrada',    rotulo: 'a obra' },
    { tabela: 'reparos', chave: 'reparo_id', tipoPush: 'reparo_encerrado',  rotulo: 'o reparo' }
  ]
  for (const lado of lados) {
    try {
      const fechados = await pool.query(`
        UPDATE ${lado.tabela} SET
          status = 'encerrada',
          status_aprovacao = 'encerrada',
          encerrado_em = NOW(),
          encerramento_solicitado_por = NULL,
          encerramento_solicitado_em = NULL
        WHERE status = 'aberta'
          AND encerramento_solicitado_por IS NOT NULL
          AND encerramento_solicitado_em <= NOW() - INTERVAL '${AUTO_ENCERRAR_APOS}'
        RETURNING id, titulo, criado_por, match_usuario_id, encerramento_solicitado_por
      `)
      for (const d of fechados.rows) {
        // Quem NÃO solicitou é quem precisa ser avisado do fechamento automático.
        const avisarId = d.encerramento_solicitado_por === d.criado_por ? d.match_usuario_id : d.criado_por
        if (!avisarId) continue
        const alvo = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [avisarId])
        if (alvo.rows[0]?.push_token) {
          enviarPushNotificacao(alvo.rows[0].push_token, '✅ Encerrado automaticamente',
            `Sem confirmação em 2 dias, ${lado.rotulo} "${d.titulo}" foi encerrad${lado.tabela === 'obras' ? 'a' : 'o'} automaticamente.`,
            { tipo: lado.tipoPush, [lado.chave]: d.id }).catch(() => {})
        }
      }
      if (fechados.rows.length > 0) {
        console.log(`[AutoEncerrar] ${lado.tabela}: ${fechados.rows.length} encerrad(a)s por falta de confirmação`)
      }
    } catch (err) {
      console.error(`[AutoEncerrar] Erro em ${lado.tabela}:`, err.message)
    }
  }
}

module.exports = {
  enviarPushNotificacao,
  enviarBoasVindas,
  notificarPintoresSobreNovaObra,
  notificarPrestadoresSobreNovoReparo,
  verificarObrasExpirando,
  verificarObrasComBaixoEngajamento,
  verificarMarcosExpiracao,
  verificarCronometroReparos,
  verificarCronometroObras,
  autoEncerrarPendentes
}