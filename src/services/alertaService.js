const { pool } = require('../utils/supabase')
const { Expo } = require('expo-server-sdk')
const { getFaixa, PRAZO_MODO_HOJE, sqlFimDoDia, SQL_FIM_DO_DIA_SP, sqlZonaSegura } = require('../utils/faixasPrazo')
// Ver src/routes/index.js: a obra guarda a zona do dono em prazo_timezone, validada contra
// pg_timezone_names NA HORA DO USO — zona NULL ou que deixou de existir recua para o padrão em
// vez de derrubar o UPDATE do lote inteiro. Só o lado OBRA tem zona — reparo não tem "Hoje".
const SQL_ZONA_DA_OBRA = sqlZonaSegura('obras.prazo_timezone')
const { MARCA } = require('../utils/marca')
const { normalizar, sqlNormalizarCidade } = require('../utils/localidade')
// Cidade dobrada dos DOIS lados com a MESMA regra (ver utils/localidade): a do profissional
// aqui, a da demanda em JS com normalizar(). uf compara em caixa alta, que e como e gravado.
const SQL_CIDADE_PRESTADOR = sqlNormalizarCidade('u.cidade')
// Sem ciclo: middlewares/auth só importa jsonwebtoken e utils/supabase, nunca este serviço.
const { invalidarCacheAssinatura } = require('../middlewares/auth')

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
      mensagem = 'Explore serviços disponíveis na sua região agora mesmo!'
    } else if (role === 'dono_obra') {
      mensagem = 'Cadastre sua primeira obra ou serviço e encontre profissionais qualificados!'
    }

    await enviarPushNotificacao(
      push_token,
      `🎉 Bem-vindo ao ${MARCA}, ${primeiroNome}!`,
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
      `SELECT titulo, cidade, uf FROM obras WHERE id = $1`,
      [obraId]
    )
    if (obraResult.rows.length === 0) return
    const obra = obraResult.rows[0]

    // Sem cidade OU sem uf na demanda nao ha alvo possivel: antes disto a consulta nao
    // filtrava lugar nenhum e o aviso ia para o pais inteiro. Silencio e o comportamento
    // correto aqui — melhor ninguem do que todos.
    const cidadeObra = normalizar(obra.cidade)
    const ufObra = String(obra.uf || '').trim().toUpperCase()
    if (!cidadeObra || !ufObra) {
      console.log('[Push] Obra sem cidade/uf — nenhum pintor notificado |', obraId)
      return
    }

    // cidade E uf, nunca cidade sozinha: ha municipios homonimos em estados diferentes.
    // Prestador sem cidade ou sem uf fica de FORA (NULLIF ... IS NOT NULL) — sem lugar
    // declarado nao da para afirmar que ele atende ali.
    // LIMIT 500 mantido como rede de seguranca.
    const pintores = await pool.query(
      `SELECT u.push_token
       FROM usuarios u
       JOIN assinaturas a ON a.usuario_id = u.id
       WHERE u.role = 'prestador' AND u.tipo_prestador = 'pintor'
         AND a.status = 'ativa'
         AND u.push_token IS NOT NULL
         AND NULLIF(btrim(u.cidade), '') IS NOT NULL
         AND NULLIF(btrim(u.uf), '')     IS NOT NULL
         AND ${SQL_CIDADE_PRESTADOR} = $1
         AND upper(btrim(u.uf)) = $2
       LIMIT 500`,
      [cidadeObra, ufObra]
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
      `SELECT titulo, cidade, uf, categoria FROM reparos WHERE id = $1`,
      [reparoId]
    )
    if (reparoResult.rows.length === 0) return
    const reparo = reparoResult.rows[0]

    const cidadeReparo = normalizar(reparo.cidade)
    const ufReparo = String(reparo.uf || '').trim().toUpperCase()
    if (!cidadeReparo || !ufReparo) {
      console.log('[Push] Reparo sem cidade/uf — nenhum prestador notificado |', reparoId)
      return
    }

    // Mesma dobra de cidade+uf da obra. Alem disso ganha o JOIN em assinaturas com
    // status='ativa', que faltava SO aqui: o aviso de trabalho novo ia para quem esta com a
    // assinatura vencida e nem consegue demonstrar interesse depois de abrir o app.
    const prestadores = await pool.query(
      `SELECT u.push_token
       FROM usuarios u
       JOIN assinaturas a ON a.usuario_id = u.id
       WHERE u.role = 'prestador' AND u.tipo_prestador IS DISTINCT FROM 'pintor'
         AND a.status = 'ativa'
         AND u.push_token IS NOT NULL
         AND NULLIF(btrim(u.cidade), '') IS NOT NULL
         AND NULLIF(btrim(u.uf), '')     IS NOT NULL
         AND ${SQL_CIDADE_PRESTADOR} = $1
         AND upper(btrim(u.uf)) = $2
       LIMIT 500`,
      [cidadeReparo, ufReparo]
    )

    const total = await enviarPushEmLote(
      prestadores.rows,
      '🔧 Novo serviço disponível!',
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
        '⏰ Seu serviço expira em 24 horas!',
        'Seu serviço será encerrado em breve.',
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
        AND o.match_usuario_id IS NULL
        AND o.total_visitas >= 10
        AND o.criado_em < NOW() - INTERVAL '1 day'
        AND o.expira_em > NOW()
        AND (o.alerta_enviado_em IS NULL OR o.alerta_enviado_em < NOW() - INTERVAL '24 hours')
        AND NOT EXISTS (
          SELECT 1 FROM candidaturas c
          WHERE c.obra_id = o.id AND c.status IS DISTINCT FROM 'recusado'
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
        AND r.match_usuario_id IS NULL
        AND r.total_visitas >= 10
        AND r.criado_em < NOW() - INTERVAL '1 day'
        AND r.expira_em > NOW()
        AND (r.alerta_enviado_em IS NULL OR r.alerta_enviado_em < NOW() - INTERVAL '8 hours')
        AND NOT EXISTS (
          SELECT 1 FROM interesse_reparos ir
          WHERE ir.reparo_id = r.id AND ir.status IS DISTINCT FROM 'recusado'
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
          `Seu serviço "${reparo.titulo}" teve ${reparo.total_visitas} visitas e nenhum interessado ainda.`,
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
    { tabela: 'reparos', idKey: 'reparo_id', janelaCol: 'prazo_atendimento_horas', substantivo: 'Seu serviço', verbo: 'Aumente o prazo',
      tipoPrefixo: 'reparo_expirando', statusAprovacao: '',                          interesse: `SELECT 1 FROM interesse_reparos ir WHERE ir.reparo_id = d.id AND ir.status IS DISTINCT FROM 'recusado'` },
  ]

  let totalEnviados = 0
  try {
    for (const lado of lados) {
      // Candidatos elegíveis com algum marco pendente e expira_em dentro do MAIOR offset possível
      // (1440min = 24h, faixa 168) — demandas mais distantes que isso não entram em banda nenhuma.
      // COALESCE(janela, 720): linhas ANTIGAS gravadas com prazo NULL viravam Number(null)=0 no
      // getFaixa, caíam no `faixa desconhecida` e nunca recebiam marco. 720 é o mesmo default que
      // o create usa para o expira_em dessas linhas (e o que os dois crons já usam nas obras).
      const candidatos = await pool.query(`
        SELECT d.id, d.titulo, COALESCE(d.${lado.janelaCol}, 720) AS janela, d.expira_em,
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

// Avisa OS DOIS LADOS de um match desfeito pelo cronômetro — antes o ramo (b) dos dois crons
// devolvia a demanda ao feed em silêncio, e o profissional descobria abrindo o app. Mesmos
// título/tipo dos handlers POST /:id/expirar-match, para o app tratar tudo por 'match_expirado'.
// `tabela` sai de literal no chamador, nunca do request.
const ROTULOS_MATCH_DESFEITO = {
  obras:   { chave: 'obra_id',   profissional: 'pintor',    artigo: 'A obra',   volta: 'A obra voltou' },
  reparos: { chave: 'reparo_id', profissional: 'prestador', artigo: 'O serviço', volta: 'O serviço voltou' },
}

const notificarMatchDesfeito = async (tabela, demanda) => {
  const { chave, profissional, artigo, volta } = ROTULOS_MATCH_DESFEITO[tabela]
  const alvos = [demanda.criado_por, demanda.match_usuario_id].filter(Boolean)
  if (alvos.length === 0) return
  const tokens = await pool.query(
    `SELECT id, push_token FROM usuarios WHERE id = ANY($1::uuid[]) AND push_token IS NOT NULL`,
    [alvos]
  )
  for (const u of tokens.rows) {
    const paraDono = u.id === demanda.criado_por
    enviarPushNotificacao(u.push_token, '⏰ Prazo expirado!',
      paraDono
        ? `O ${profissional} não chegou a tempo para "${demanda.titulo}". ${artigo} está disponível novamente.`
        : `O prazo para chegar em "${demanda.titulo}" acabou. ${volta} para o feed.`,
      { tipo: 'match_expirado', [chave]: demanda.id }).catch(() => {})
  }
}

// Faltas: só o CRONÔMETRO registra. Os handlers POST /:id/expirar-match e as recusas de tempo
// extra também desfazem match, mas ali há um humano decidindo (dono ou admin, e o próprio
// profissional pode chamar expirar-match) — contar aquilo como falta deixaria a suspensão ao
// alcance de quem clica. O cron é a única evidência automática de "prazo venceu, ninguém chegou".
const FALTAS_PARA_SUSPENDER = 3
const JANELA_FALTAS = '90 days'
const MOTIVO_SUSPENSAO = `${FALTAS_PARA_SUSPENDER} faltas (não comparecimento) em ${JANELA_FALTAS.replace('days', 'dias')}`

// Isenção: o profissional ofereceu uma janela e ela NUNCA virou compromisso — porque o dono
// recusou (chegada_recusada_em) ou porque simplesmente não respondeu e a proposta morreu
// pendente (chegada_pendente_em). Nos dois casos chegada_prevista_em segue NULL: não houve
// horário acordado para ele furar. Cobrar falta aí puniria quem se ofereceu e ficou esperando —
// e, no caso do silêncio, puniria o profissional por inação do DONO.
// Se alguma janela chegou a VALER (chegada_prevista_em preenchida), a isenção cai: havia
// compromisso firmado, e não comparecer é falta.
// Espelhada no CASE de prestadores_bloqueados dos dois crons e dos dois expirar-match — as
// duas punições (falta e bloqueio) andam sempre juntas.
const isentoPorRecusa = (demanda) =>
  !demanda.chegada_prevista_em &&
  (!!demanda.chegada_recusada_em || !!demanda.chegada_pendente_em)

// Registra a falta e, ao cruzar o limite na janela móvel, suspende. `tabela` sai de literal no
// chamador, nunca do request. Erros são engolidos: uma falha aqui não pode derrubar o cron nem
// impedir que a demanda volte ao feed — o un-match já foi commitado quando isto roda.
const registrarFalta = async (tabela, demanda) => {
  if (!demanda.match_usuario_id) return
  try {
    await pool.query(
      `INSERT INTO faltas_profissional (usuario_id, tabela, demanda_id) VALUES ($1, $2, $3)`,
      [demanda.match_usuario_id, tabela, demanda.id]
    )
    // perdoada_em IS NULL: falta perdoada por um admin continua no histórico mas não conta.
    const c = await pool.query(
      `SELECT COUNT(*)::int AS n FROM faltas_profissional
        WHERE usuario_id = $1
          AND perdoada_em IS NULL
          AND criado_em > NOW() - INTERVAL '${JANELA_FALTAS}'`,
      [demanda.match_usuario_id]
    )
    if (c.rows[0].n < FALTAS_PARA_SUSPENDER) return

    // suspenso_em IS NULL no WHERE: suspende UMA vez. Sem isso, a 4ª, 5ª... falta reescreveria
    // o timestamp (empurrando o início da suspensão para frente) e reenviaria o push a cada
    // falta. rowCount = 0 significa "já estava suspenso" — nada a notificar.
    const upd = await pool.query(
      `UPDATE usuarios SET suspenso_em = NOW(), suspenso_motivo = $2
        WHERE id = $1 AND suspenso_em IS NULL
        RETURNING push_token`,
      [demanda.match_usuario_id, MOTIVO_SUSPENSAO]
    )
    if (upd.rowCount === 0) return
    // Derruba o usuário do cache de 30s de autenticar. Sem isto, quem estivesse com sessão
    // quente continuaria passando por exigirNaoSuspenso (que lê req.usuario) por até 30
    // segundos depois de suspenso — janela para pegar mais um trabalho. Os aceites já
    // consultam o banco direto, mas os feeds e a criação de proposta dependem do cache.
    invalidarCacheAssinatura(demanda.match_usuario_id)
    console.log(`[Faltas] usuario ${demanda.match_usuario_id} suspenso — ${c.rows[0].n} faltas em ${JANELA_FALTAS}`)
    if (upd.rows[0]?.push_token) {
      enviarPushNotificacao(upd.rows[0].push_token, '🚫 Conta suspensa',
        `Sua conta foi suspensa por ${MOTIVO_SUSPENSAO}. Fale com o suporte para regularizar.`,
        { tipo: 'conta_suspensa' }).catch(() => {})
    }
  } catch (err) {
    console.error(`[Faltas] Erro ao registrar falta em ${tabela}:`, err.message)
  }
}

// Cronômetro de matches de reparos.
// O prazo do cronômetro inicia em match_feito_em e vai até COALESCE(chegada_prevista_em,
// expira_em): quando o prestador promete uma janela de chegada, é ELA que passa a valer como
// prazo — inclusive quando cai depois do expira_em original (o dono aceitou esperar até lá ao
// ver a previsão). Sem previsão, nada muda: continua o expira_em.
// (a) A 5 minutos do fim: avisa o dono uma única vez por match.
// (b) Quando o cronômetro zera: devolve o reparo ao feed e limpa o match.
// Os dois ramos param assim que a chegada é DECLARADA (por qualquer lado) ou CONFIRMADA: a
// partir daí o prestador está no local, e nem faz sentido cobrar "ainda não chegou?" nem
// devolver ao feed um reparo em atendimento.
const verificarCronometroReparos = async () => {
  try {
    // (a) 5 minutos restantes → notifica o dono (uma vez por match)
    const cincoMin = await pool.query(`
      SELECT r.id, r.titulo, u.push_token
      FROM reparos r
      JOIN usuarios u ON r.criado_por = u.id
      WHERE r.match_usuario_id IS NOT NULL
        AND r.notif_5min_enviada = false
        AND u.push_token IS NOT NULL
        AND r.chegada_declarada_em IS NULL
        AND r.chegada_confirmada_em IS NULL
        AND COALESCE(r.chegada_prevista_em, r.expira_em) BETWEEN NOW() AND NOW() + INTERVAL '5 minutes'
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
    // SELECT antes do UPDATE porque RETURNING devolve a linha NOVA, em que match_usuario_id já
    // é NULL — e é justamente ele que precisamos para bloquear e notificar o prestador. O mesmo
    // predicado vai nos dois: o UPDATE continua sendo quem decide (linha que deixar de casar
    // entre as duas queries simplesmente não é atualizada e não gera push).
    // prazo_atendimento_horas NULL NÃO exclui mais a linha (D73 — paridade com o cron de obras):
    // o prazo pós-match é COALESCE(chegada_prevista_em, expira_em), que independe da coluna;
    // o filtro só servia para proteger o rebuild abaixo de "NULL * interval", e isso agora é
    // COALESCE. Com o filtro, um reparo casado com prazo NULL ficava com match eterno: sem
    // aviso de 5 min, sem voltar ao feed e sem falta.
    const PRED_EXPIRADOS_REPAROS = `
      status = 'aberta'
        AND match_usuario_id IS NOT NULL
        AND chegada_declarada_em IS NULL
        AND chegada_confirmada_em IS NULL
        AND COALESCE(chegada_prevista_em, expira_em) <= NOW()`

    // chegada_recusada_em/chegada_prevista_em entram no SELECT para a ISENÇÃO: match que morre
    // depois de o dono recusar a janela, e sem nenhuma outra valendo, não gera falta nem bloqueio.
    const candidatos = await pool.query(`
      SELECT id, titulo, criado_por, match_usuario_id,
             chegada_recusada_em, chegada_pendente_em, chegada_prevista_em
        FROM reparos WHERE ${PRED_EXPIRADOS_REPAROS}
    `)

    let expiradosCount = 0
    if (candidatos.rows.length > 0) {
      const expirados = await pool.query(`
        WITH desfeitos AS (
          UPDATE reparos SET
            status = 'aberta',
            match_feito_em = NULL,
            match_usuario_id = NULL,
            notif_5min_enviada = false,
            -- Mesmo re-armamento do lado obra (ver o comentário lá): sem isto o reparo volta
            -- ao feed com prazo novo e marcos velhos, e não recebe aviso de expiração nenhum.
            marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL,
            pedido_tempo_status = NULL,
            pedido_tempo_motivo = NULL,
            pedido_tempo_minutos = NULL,
            chegada_janela = NULL,
            chegada_prevista_em = NULL,
            chegada_declarada_por = NULL,
            chegada_declarada_em = NULL,
            chegada_pendente_janela = NULL,
            chegada_pendente_em = NULL,
            chegada_recusada_em = NULL,
            prestadores_bloqueados = CASE
              -- Isenção: janela oferecida que nunca virou compromisso — recusada pelo dono OU
              -- morta pendente sem resposta — e nenhuma outra valendo. Não bloqueia.
              WHEN chegada_prevista_em IS NULL
                   AND (chegada_recusada_em IS NOT NULL OR chegada_pendente_em IS NOT NULL)
              THEN prestadores_bloqueados
              WHEN match_usuario_id = ANY(COALESCE(prestadores_bloqueados, '{}'))
              THEN prestadores_bloqueados
              ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), match_usuario_id) END,
            -- Faixa "Hoje": devolver ao feed NÃO pode dar 24h novas a quem escolheu "hoje" —
            -- o prazo volta a ser o fim do dia CORRENTE (o dia em que o match morreu).
            -- Sem este CASE, o cron reconstruiria a partir de prazo_atendimento_horas.
            -- COALESCE(prazo_atendimento_horas, 720): mesma rede do cron de obras. 720h é o
            -- default do PRÓPRIO create de reparo quando o cliente não manda prazo
            -- (index.js: horasExpiracao = prazo || 720) e o que verificarMarcosExpiracao já
            -- assume para reparo com prazo NULL — a segunda vida da linha ganha a mesma janela
            -- da primeira, e os dois crons leem o mesmo número para a mesma linha.
            expira_em = CASE WHEN prazo_modo = '${PRAZO_MODO_HOJE}' THEN ${SQL_FIM_DO_DIA_SP}
                             ELSE NOW() + (COALESCE(prazo_atendimento_horas, 720) * INTERVAL '1 hour') END
          WHERE id = ANY($1::uuid[]) AND ${PRED_EXPIRADOS_REPAROS}
          RETURNING id
        ), propostas AS (
          -- A proposta vencedora expira JUNTO com o match, no mesmo statement: enquanto ela
          -- ficava 'aceito' o serviço voltava ao feed mas nenhum aceite novo passava
          -- (interesse_reparos_aceito_unico_idx ocupado + guard jaAceito → 409).
          -- O par (reparo, prestador) vem dos dois arrays paralelos porque o RETURNING acima já
          -- traz match_usuario_id NULL; o IN no CTE desfeitos limita aos reparos que o UPDATE
          -- realmente pegou, então quem escapou do predicado na corrida não é tocado.
          UPDATE interesse_reparos ir SET status = 'expirado'
            FROM unnest($1::uuid[], $2::uuid[]) AS alvo(reparo_id, usuario_id)
           WHERE ir.reparo_id = alvo.reparo_id AND ir.usuario_id = alvo.usuario_id
             AND ir.status = 'aceito'
             AND alvo.reparo_id IN (SELECT id FROM desfeitos)
          RETURNING ir.id
        )
        SELECT id FROM desfeitos
      `, [candidatos.rows.map(c => c.id), candidatos.rows.map(c => c.match_usuario_id)])
      expiradosCount = expirados.rows.length

      // Só notifica e contabiliza falta para quem o UPDATE realmente pegou. Os dois lados
      // continuam sendo avisados do fim do match mesmo na isenção — o que muda é só a punição.
      // try/catch POR LINHA: notificarMatchDesfeito faz query de token e pode estourar. Sem o
      // guard, uma linha ruim jogava para o catch da função e as SEGUINTES ficavam sem aviso e
      // sem falta, com o un-match já commitado para todas. registrarFalta já se protege sozinha.
      const atualizados = new Set(expirados.rows.map(r => r.id))
      for (const c of candidatos.rows) {
        if (!atualizados.has(c.id)) continue
        try {
          await notificarMatchDesfeito('reparos', c)
        } catch (err) {
          console.error(`[CronômetroReparos] falha ao notificar match desfeito ${c.id}:`, err.message)
        }
        if (!isentoPorRecusa(c)) await registrarFalta('reparos', c)
      }
    }

    console.log(`[CronômetroReparos] 5min notificados: ${cincoMin.rows.length} | matches expirados (devolvidos ao feed): ${expiradosCount}`)
  } catch (err) {
    console.error('Erro ao verificar cronômetro de reparos:', err.message)
  }
}

// Cronômetro de matches de obras — espelha verificarCronometroReparos com as colunas reais de obra.
// Prazo pós-match: COALESCE(chegada_prevista_em, expira_em) — a janela prometida pelo pintor
// manda quando existe; sem ela, segue o expira_em ORIGINAL (o match não reseta expira_em).
// (a) A 5 minutos do fim: avisa o dono uma única vez por match (notif_5min_enviada).
// (b) Quando o prazo zera: devolve a obra ao feed e limpa o match, reiniciando a janela
//     PRÉ-match (horas_para_expirar) para a próxima rodada de candidatos.
// Chegada declarada ou confirmada congela os dois ramos (mesma regra do cron de reparos).
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
        AND o.chegada_declarada_em IS NULL
        AND o.chegada_confirmada_em IS NULL
        AND COALESCE(o.chegada_prevista_em, o.expira_em) BETWEEN NOW() AND NOW() + INTERVAL '5 minutes'
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
    // SELECT antes do UPDATE pelo mesmo motivo do cron de reparos: RETURNING traz a linha nova,
    // com match_usuario_id já NULL, e é ele que precisamos para bloquear e notificar o pintor.
    const PRED_EXPIRADOS_OBRAS = `
      status = 'aberta'
        AND match_usuario_id IS NOT NULL
        AND chegada_declarada_em IS NULL
        AND chegada_confirmada_em IS NULL
        AND COALESCE(chegada_prevista_em, expira_em) <= NOW()`

    // Mesma isenção do cron de reparos (ver isentoPorRecusa).
    const candidatos = await pool.query(`
      SELECT id, titulo, criado_por, match_usuario_id,
             chegada_recusada_em, chegada_pendente_em, chegada_prevista_em
        FROM obras WHERE ${PRED_EXPIRADOS_OBRAS}
    `)

    let expiradosCount = 0
    if (candidatos.rows.length > 0) {
      const expirados = await pool.query(`
        WITH desfeitos AS (
          UPDATE obras SET
            status = 'aberta',
            match_feito_em = NULL,
            match_usuario_id = NULL,
            notif_5min_enviada = false,
            -- Marcos re-armados junto com o expira_em novo, exatamente como POST
            -- /obras/:id/estender já faz: a obra volta ao feed com prazo novo, então os 3
            -- avisos de expiração precisam valer de novo. Sem isto ela carregava os marcos
            -- já gastos da PRIMEIRA vida e não recebia aviso nenhum na segunda — o candidato
            -- da query de marcos exige ao menos um marco NULL, então ela nem era varrida.
            marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL,
            -- pedido_tempo_* zerados como o cron de reparos já fazia (D76): sem isto a obra
            -- voltava ao feed carregando o pedido de tempo do pintor que furou, e o próximo
            -- match nascia "aguardando aprovação" de alguém que já saiu.
            pedido_tempo_status = NULL,
            pedido_tempo_motivo = NULL,
            pedido_tempo_minutos = NULL,
            chegada_janela = NULL,
            chegada_prevista_em = NULL,
            chegada_declarada_por = NULL,
            chegada_declarada_em = NULL,
            chegada_pendente_janela = NULL,
            chegada_pendente_em = NULL,
            chegada_recusada_em = NULL,
            prestadores_bloqueados = CASE
              -- Isenção: janela oferecida que nunca virou compromisso — recusada pelo dono OU
              -- morta pendente sem resposta — e nenhuma outra valendo. Não bloqueia.
              WHEN chegada_prevista_em IS NULL
                   AND (chegada_recusada_em IS NOT NULL OR chegada_pendente_em IS NOT NULL)
              THEN prestadores_bloqueados
              WHEN match_usuario_id = ANY(COALESCE(prestadores_bloqueados, '{}'))
              THEN prestadores_bloqueados
              ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), match_usuario_id) END,
            -- Faixa "Hoje" — mesma regra do cron de reparos: volta ao fim do dia corrente,
            -- nunca a horas_para_expirar novas. O dia é o do DONO (prazo_timezone), não o de
            -- São Paulo: para um dono em Rio Branco o cron resolveria o dia errado.
            expira_em = CASE WHEN prazo_modo = '${PRAZO_MODO_HOJE}' THEN ${sqlFimDoDia(SQL_ZONA_DA_OBRA)}
                             ELSE NOW() + (COALESCE(horas_para_expirar, 720) * INTERVAL '1 hour') END
          WHERE id = ANY($1::uuid[]) AND ${PRED_EXPIRADOS_OBRAS}
          RETURNING id
        ), propostas AS (
          -- Candidatura vencedora expira junto com o match (ver o cron de reparos para o
          -- porquê dos dois arrays paralelos e do IN no CTE desfeitos).
          UPDATE candidaturas c SET status = 'expirado'
            FROM unnest($1::uuid[], $2::uuid[]) AS alvo(obra_id, usuario_id)
           WHERE c.obra_id = alvo.obra_id AND c.usuario_id = alvo.usuario_id
             AND c.status = 'aceito'
             AND alvo.obra_id IN (SELECT id FROM desfeitos)
          RETURNING c.id
        )
        SELECT id FROM desfeitos
      `, [candidatos.rows.map(c => c.id), candidatos.rows.map(c => c.match_usuario_id)])
      expiradosCount = expirados.rows.length

      // try/catch por linha pelo mesmo motivo do cron de reparos.
      const atualizados = new Set(expirados.rows.map(o => o.id))
      for (const c of candidatos.rows) {
        if (!atualizados.has(c.id)) continue
        try {
          await notificarMatchDesfeito('obras', c)
        } catch (err) {
          console.error(`[CronômetroObras] falha ao notificar match desfeito ${c.id}:`, err.message)
        }
        if (!isentoPorRecusa(c)) await registrarFalta('obras', c)
      }
    }

    console.log(`[CronômetroObras] 5min notificados: ${cincoMin.rows.length} | matches expirados (devolvidos ao feed): ${expiradosCount}`)
  } catch (err) {
    console.error('Erro ao verificar cronômetro de obras:', err.message)
  }
}

// Encerramento assimétrico: fecha sozinho a solicitação do profissional que o dono não
// confirmou no prazo. Sem isto um dono silencioso deixaria a demanda pendente para sempre.
// status = 'aberta' no WHERE (mesma lição do cron de reparos): a demanda só é candidata
// enquanto NÃO está encerrada. Notifica quem NÃO pediu — quem pediu já sabe.
//
// O prazo é POR TABELA, como já era o da chegada: um serviço é trabalho curto, começa e
// termina no mesmo dia, e 3h de espera pela confirmação do dono cabem dentro dele; uma obra
// corre noutra cadência, e fechar a solicitação do profissional em 3h ali seria errado — por
// isso a obra mantém os 2 dias originais. O sufixo de cada constante é o nome da tabela a
// que ela se aplica (lado.tabela), então casar constante e lado não exige tradução nenhuma.
const AUTO_ENCERRAR_APOS_OBRAS   = '2 days'
const AUTO_ENCERRAR_APOS_REPAROS = '3 hours'

// Rótulo pt-BR DERIVADO do próprio INTERVAL aplicado, em vez de escrito à mão ao lado dele:
// o push anuncia exatamente o prazo que o WHERE cobra, e não há um segundo valor para
// esquecer de mudar. Cobre as unidades usadas aqui; qualquer outra cai no fallback e o push
// sai com o intervalo cru, o que é feio mas não quebra o encerramento (já commitado).
const UNIDADES_PRAZO = { day: ['dia', 'dias'], hour: ['hora', 'horas'], minute: ['minuto', 'minutos'] }
const rotuloPrazo = (intervalo) => {
  const [qtd, unidade = ''] = intervalo.split(' ')
  const par = UNIDADES_PRAZO[unidade.replace(/s$/, '')]
  return par ? `${qtd} ${Number(qtd) === 1 ? par[0] : par[1]}` : intervalo
}

// Auto-confirmação da chegada: o profissional declarou, o dono nunca respondeu. Vencido o
// prazo a declaração vale por si — sem isto a demanda fica travada em "declarada mas não
// confirmada" para sempre (e, como chegada_declarada_em congela os dois crons, também nunca
// volta ao feed). O prazo é POR TABELA (chegadaApos): um reparo é uma visita curta, e 6h de
// limbo cobriam o serviço inteiro; uma obra se mede em horas e mantém as 6h de antes.
// chegadaRotulo anda junto do intervalo porque o mesmo prazo aparece no texto do push — se
// só um dos dois mudasse, o profissional seria avisado de um prazo que não é o aplicado.

const autoEncerrarPendentes = async () => {
  // tabela, coluna de id e prazos saem desta lista literal, nunca do request — interpolação segura.
  const lados = [
    { tabela: 'obras',   chave: 'obra_id',   tipoPush: 'obra_encerrada',    rotulo: 'a obra',
      encerrarApos: AUTO_ENCERRAR_APOS_OBRAS,
      chegadaApos: '6 hours',   chegadaRotulo: '6 horas' },
    { tabela: 'reparos', chave: 'reparo_id', tipoPush: 'reparo_encerrado',  rotulo: 'o serviço',
      encerrarApos: AUTO_ENCERRAR_APOS_REPAROS,
      chegadaApos: '30 minutes', chegadaRotulo: '30 minutos' }
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
          AND encerramento_solicitado_em <= NOW() - INTERVAL '${lado.encerrarApos}'
        RETURNING id, titulo, criado_por, match_usuario_id, encerramento_solicitado_por
      `)
      for (const d of fechados.rows) {
        // Quem NÃO solicitou é quem precisa ser avisado do fechamento automático.
        const avisarId = d.encerramento_solicitado_por === d.criado_por ? d.match_usuario_id : d.criado_por
        if (!avisarId) continue
        const alvo = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [avisarId])
        if (alvo.rows[0]?.push_token) {
          enviarPushNotificacao(alvo.rows[0].push_token, '✅ Encerrado automaticamente',
            `Sem confirmação em ${rotuloPrazo(lado.encerrarApos)}, ${lado.rotulo} "${d.titulo}" foi encerrad${lado.tabela === 'obras' ? 'a' : 'o'} automaticamente.`,
            { tipo: lado.tipoPush, [lado.chave]: d.id }).catch(() => {})
        }
      }
      if (fechados.rows.length > 0) {
        console.log(`[AutoEncerrar] ${lado.tabela}: ${fechados.rows.length} encerrad(a)s por falta de confirmação`)
      }

      // Chegada declarada há mais do que o prazo da tabela e nunca confirmada pelo dono →
      // confirma sozinho. Query separada (não um SET a mais no UPDATE acima): são regras
      // independentes — encerramento em duas mãos vs. chegada em duas mãos — com prazos e
      // predicados próprios, e a maioria das linhas candidatas a uma não é candidata à outra.
      const chegadas = await pool.query(`
        UPDATE ${lado.tabela} SET chegada_confirmada_em = NOW()
        WHERE chegada_declarada_em IS NOT NULL
          AND chegada_confirmada_em IS NULL
          AND chegada_declarada_em <= NOW() - INTERVAL '${lado.chegadaApos}'
        RETURNING id, titulo, match_usuario_id
      `)
      for (const c of chegadas.rows) {
        // Avisa o profissional, fechando a lacuna: era o ÚNICO caminho de confirmação que
        // não notificava ninguém. tipo 'chegada_confirmada' é o mesmo do POST /:id/chegada
        // (o app trata os dois igual); só o texto muda, porque aqui o dono NÃO confirmou —
        // venceu o prazo. Mesma construção do aviso de encerramento automático acima.
        if (!c.match_usuario_id) continue
        const prof = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [c.match_usuario_id])
        if (prof.rows[0]?.push_token) {
          enviarPushNotificacao(prof.rows[0].push_token, '✅ Chegada confirmada!',
            `Sem confirmação do solicitante em ${lado.chegadaRotulo}, sua chegada em "${c.titulo}" foi confirmada automaticamente.`,
            { tipo: 'chegada_confirmada', [lado.chave]: c.id }).catch(() => {})
        }
      }
      if (chegadas.rows.length > 0) {
        console.log(`[AutoConfirmarChegada] ${lado.tabela}: ${chegadas.rows.length} chegada(s) confirmada(s) por decurso de prazo`)
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
  autoEncerrarPendentes,
  // Exportadas para o painel admin (GET /admin/suspensos e o liberar) usarem EXATAMENTE a mesma
  // janela e o mesmo limite que o cron aplica — antes a rota tinha uma cópia '90 days' própria,
  // que passaria a mentir na primeira vez que este valor mudasse.
  JANELA_FALTAS,
  FALTAS_PARA_SUSPENDER
}