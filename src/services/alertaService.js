const { pool } = require('../utils/supabase')
const { Expo } = require('expo-server-sdk')

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

// Marcos fixos de expiração: alerta o dono de uma demanda SEM match e SEM interessados a 6h,
// 60min, 30min e 15min de expira_em, cada um com deep-link para a tela de detalhe (onde fica o
// botão de estender). Substitui os dois jobs single-shot "expirando sem interessados".
//
// Bandas ancoradas em expira_em (tempo restante), semi-abertas e DISJUNTAS — (inferior, superior]:
//   marco_15: (NOW,        NOW+15min]
//   marco_30: (NOW+15min,  NOW+30min]
//   marco_60: (NOW+30min,  NOW+60min]
//   marco_6h: (NOW+60min,  NOW+6h]   — só quando a janela ORIGINAL > 12h
// Como as bandas não se sobrepõem, a demanda cai em no máximo uma por run → no máximo um push por
// marco (reforçado pelo claim marco_X_em IS NULL). Uma demanda cuja vida inteira é < 15min só
// entra na banda de 15 → recebe apenas o alerta de 15min (cobertura, não sequência). Deploy-
// tolerante: bandas de 15..300min de largura absorvem minutos perdidos entre runs.
//
// Elegibilidade reaproveitada dos jobs aposentados: status='aberta', match_usuario_id IS NULL,
// e o MESMO teste de interesse (obras: NOT EXISTS candidaturas; reparos: NOT EXISTS
// interesse_reparos). Obras exigem status_aprovacao='aprovada' (reparos não, por decisão).
//
// Claim-then-send: o UPDATE ... FROM usuarios ... WHERE marco_X_em IS NULL ... RETURNING reivindica
// a linha no MESMO statement que a seleciona — replica-safe, sem duplo envio (a 2ª réplica vê
// marco_X_em já preenchido e retorna 0 linhas). Empurra só para as linhas retornadas.
const verificarMarcosExpiracao = async () => {
  const lados = [
    {
      tabela: 'obras',
      idKey: 'obra_id',
      janelaCol: 'horas_para_expirar',
      statusAprovacao: `AND d.status_aprovacao = 'aprovada'`,
      interesse: `SELECT 1 FROM candidaturas c WHERE c.obra_id = d.id`,
      marcos: [
        { col: 'marco_6h_em', sup: '6 hours',    inf: '60 minutes', mMin: 360, tipo: 'obra_expirando_6h', titulo: '⏰ Sua obra expira em 6 horas',    corpo: t => `Sua obra '${t}' expira em 6 horas e ainda não tem interessados. Estenda o prazo para continuar recebendo candidatos.` },
        { col: 'marco_60_em', sup: '60 minutes', inf: '30 minutes', mMin: 60,  tipo: 'obra_expirando_60', titulo: '⏰ Sua obra expira em 1 hora',     corpo: t => `Sua obra '${t}' expira em 1 hora e ainda não tem interessados. Estenda o prazo.` },
        { col: 'marco_30_em', sup: '30 minutes', inf: '15 minutes', mMin: 30,  tipo: 'obra_expirando_30', titulo: '⏰ Sua obra expira em 30 minutos', corpo: t => `Sua obra '${t}' expira em 30 minutos e ainda não tem interessados. Estenda o prazo.` },
        { col: 'marco_15_em', sup: '15 minutes', inf: '0 minutes',  mMin: 15,  tipo: 'obra_expirando_15', titulo: '⏰ Sua obra expira em 15 minutos', corpo: t => `Última chance: sua obra '${t}' expira em 15 minutos sem interessados. Estenda o prazo agora.` },
      ],
    },
    {
      tabela: 'reparos',
      idKey: 'reparo_id',
      janelaCol: 'prazo_atendimento_horas',
      statusAprovacao: '',
      interesse: `SELECT 1 FROM interesse_reparos ir WHERE ir.reparo_id = d.id`,
      marcos: [
        { col: 'marco_6h_em', sup: '6 hours',    inf: '60 minutes', mMin: 360, tipo: 'reparo_expirando_6h', titulo: '⏰ Seu reparo expira em 6 horas',    corpo: t => `Seu reparo '${t}' expira em 6 horas e ainda não tem interessados. Aumente o prazo para continuar recebendo profissionais.` },
        { col: 'marco_60_em', sup: '60 minutes', inf: '30 minutes', mMin: 60,  tipo: 'reparo_expirando_60', titulo: '⏰ Seu reparo expira em 1 hora',     corpo: t => `Seu reparo '${t}' expira em 1 hora e ainda não tem interessados. Aumente o prazo.` },
        { col: 'marco_30_em', sup: '30 minutes', inf: '15 minutes', mMin: 30,  tipo: 'reparo_expirando_30', titulo: '⏰ Seu reparo expira em 30 minutos', corpo: t => `Seu reparo '${t}' expira em 30 minutos e ainda não tem interessados. Aumente o prazo.` },
        { col: 'marco_15_em', sup: '15 minutes', inf: '0 minutes',  mMin: 15,  tipo: 'reparo_expirando_15', titulo: '⏰ Última chance para seu reparo',   corpo: t => `Seu reparo '${t}' expira em 15 minutos sem interessados. Aumente o prazo agora.` },
      ],
    },
  ]

  let totalEnviados = 0
  try {
    for (const lado of lados) {
      for (const marco of lado.marcos) {
        // Gate de janela ORIGINAL uniforme: o marco M só dispara se a janela original da demanda
        // (janelaCol em horas × 60) for MAIOR que M em minutos — um alerta "faltam 60min" nunca
        // chega a quem nunca teve 60min. Substitui o antigo gate especial de 6h (>12h), agora só
        // o caso M=360. Fronteira estrita (>): janela == M não dispara M (ex.: 1h não dispara o 60).
        const gate = `AND d.${lado.janelaCol} * 60 > ${marco.mMin}`
        const claim = await pool.query(`
          UPDATE ${lado.tabela} d
          SET ${marco.col} = NOW()
          FROM usuarios u
          WHERE d.criado_por = u.id
            AND d.status = 'aberta'
            ${lado.statusAprovacao}
            AND d.match_usuario_id IS NULL
            AND u.push_token IS NOT NULL AND u.push_token <> ''
            AND NOT EXISTS (${lado.interesse})
            AND d.${marco.col} IS NULL
            AND d.expira_em <= NOW() + INTERVAL '${marco.sup}'
            AND d.expira_em >  NOW() + INTERVAL '${marco.inf}'
            ${gate}
          RETURNING d.id, d.titulo, u.push_token
        `)

        for (const row of claim.rows) {
          await enviarPushEmLote(
            [{ push_token: row.push_token }],
            marco.titulo,
            marco.corpo(row.titulo),
            { tipo: marco.tipo, [lado.idKey]: row.id }
          )
          totalEnviados++
        }
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
        AND (r.match_feito_em + (r.prazo_atendimento_horas * INTERVAL '1 hour'))
              BETWEEN NOW() AND NOW() + INTERVAL '5 minutes'
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
    // reiniciando a contagem com o prazo original configurado na criação
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
      WHERE match_usuario_id IS NOT NULL
        AND prazo_atendimento_horas IS NOT NULL
        AND (match_feito_em + (prazo_atendimento_horas * INTERVAL '1 hour')) <= NOW()
      RETURNING id
    `)

    console.log(`[CronômetroReparos] 5min notificados: ${cincoMin.rows.length} | matches expirados (devolvidos ao feed): ${expirados.rows.length}`)
  } catch (err) {
    console.error('Erro ao verificar cronômetro de reparos:', err.message)
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
  verificarCronometroReparos
}