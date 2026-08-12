require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const rotasApp = require('./src/routes')
const { pool } = require('./src/utils/supabase')
const { verificarObrasComBaixoEngajamento, verificarObrasExpirando, enviarPushNotificacao, verificarMarcosExpiracao, verificarCronometroReparos, verificarCronometroObras, autoEncerrarPendentes } = require('./src/services/alertaService')
const { invalidarCachesUsuario } = require('./src/routes')
const { deletarDoCloudinary } = require('./src/services/uploadService')
const { flushVisitas, iniciarFlushVisitas, INTERVALO_FLUSH_MS } = require('./src/utils/visitas')

const app = express()
const PORT = process.env.PORT || 3000

app.set('trust proxy', 1)
app.use(helmet())

app.use(cors({
  origin: [
    'https://pinturapro-painel-production.up.railway.app',
    'http://localhost:3000',
    'http://localhost:8081',
    'exp://',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}))

// ============================================================
// SHEDDING DE CARGA — rejeita NA PORTA quando o pool satura
// ============================================================
// Antes: com as 20 conexões ocupadas, a requisição entrava na FILA do pool, esperava o
// connectionTimeoutMillis e virava um 500 genérico — que o comRetry do app tentava de novo,
// somando carga justamente durante a saturação. Agora a fila tem teto e o excesso leva 503
// na hora, em microssegundos, sem consumir slot.
//
// Sinal: pool.waitingCount = requisições JÁ enfileiradas esperando conexão. É a medida direta
// da fila; idleCount === 0 apenas diz que o pool está momentaneamente ocupado, o que é normal.
// Teto 10 = metade de max(20): waitingCount > 0 acontece em rajada e drena em milissegundos;
// chegar a 10 e ficar significa que a chegada supera o atendimento.
const POOL_FILA_MAX = 10
// Isenções — as duas precisam passar mesmo saturado:
//   '/' e '/api/health' → se o health check da plataforma levar 503, o container é reiniciado
//     no pico e derruba tudo que estava em voo, piorando o incidente.
//   webhook do PagBank → o handler sempre responde 200, então o PagBank NUNCA reenvia:
//     recusar uma entrega perde o evento de pagamento em definitivo.
const ROTAS_SEM_SHEDDING = new Set(['/', '/api/health', '/api/pagamentos/webhook-pagbank'])

// Posição no pipeline é deliberada: DEPOIS de helmet/cors (sem os headers de CORS o app não
// consegue ler o corpo nem o status do 503 — vira "erro de rede" e é retentado às cegas) e
// ANTES dos rate limiters e dos parsers de corpo (não faz sentido parsear até 100MB de body
// de uma requisição que já vai ser recusada).
app.use((req, res, next) => {
  if (ROTAS_SEM_SHEDDING.has(req.path)) return next()
  if (pool.waitingCount < POOL_FILA_MAX) return next()
  // Log com a fila e o total: é o que separa "pool pequeno demais" de "um endpoint ficou
  // lento" na hora do incidente.
  console.warn(`[Shedding] 503 | ${req.method} ${req.originalUrl} | waitingCount=${pool.waitingCount} totalCount=${pool.totalCount} idleCount=${pool.idleCount}`)
  res.set('Retry-After', '1')
  return res.status(503).json({
    erro: 'Servidor ocupado. Tente novamente em instantes.',
    codigo: 'SOBRECARGA',
  })
})

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
}))

app.use('/api/auth/login',    rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
}))
// 20/h (era 5/h): usuários de celular saem por CGNAT do carrier — muitos aparelhos
// reais compartilham o mesmo IP público, então 5/h bloqueava gente legítima. O limite
// também era consumido pelos próprios retries que os timeouts de cadastro provocavam.
app.use('/api/auth/cadastro', rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
}))

// Rotas sensíveis que até aqui só tinham o balde global de 300/15min — teto alto demais
// para o que cada uma faz. Mesmo formato dos dois limiters acima (montados ANTES de
// app.use('/api', rotasApp), senão não interceptam nada) e mesmo corpo de erro do global.
// Sem limiter no webhook do PagBank de propósito: as retentativas do gateway não podem
// ser estranguladas — um 429 lá vira pagamento não confirmado.
// 20/h (era 5/h) — não autenticada e dispara e-mail de saída a cada chamada.
// 20 e não 5 pelo mesmo CGNAT do cadastro acima: 5/h barrava aparelhos legítimos no mesmo IP.
app.use('/api/auth/esqueci-senha', rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
}))
// 20/h — não autenticada e aceita upload de arquivo (documentos de verificação).
app.use('/api/auth/upload-verificacao', rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
}))
// 60/h — não autenticada e emite assinatura de upload do Cloudinary.
app.use('/api/upload/assinatura-publica', rateLimit({
  windowMs: 60 * 60 * 1000, max: 60,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
}))
// 20/h — autenticada, mas abre cobrança no gateway a cada chamada.
app.use('/api/pagamentos/criar-assinatura', rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
}))

// Webhook PagBank precisa do corpo cru (bytes exatos) p/ validar a assinatura
// SHA-256. Escopado só a esta rota — não retém buffers crus no resto da API.
app.use('/api/pagamentos/webhook-pagbank', express.raw({ type: '*/*', limit: '1mb' }))
app.use(express.json({ limit: '100mb' }))
app.use(express.urlencoded({ extended: true, limit: '100mb' }))
app.use('/api', rotasApp)

// Health check
app.get('/', async (req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({
      api: 'PinturaPro API',
      versao: '1.0.0',
      status: 'online',
      banco: 'conectado',
      uptime: Math.floor(process.uptime()) + 's'
    })
  } catch (err) {
    res.status(503).json({
      api: 'PinturaPro API',
      status: 'degradado',
      banco: 'erro',
      detalhe: err.message
    })
  }
})

app.use((req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada' })
})

app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err.message)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ erro: 'Arquivo muito grande. Máximo permitido: 50MB.' })
  }
  res.status(500).json({ erro: 'Erro interno do servidor. Tente novamente.' })
})

const RAIO_KM              = 5
const RAIO_GRAUS           = RAIO_KM / 111

// Corpo do push de proximidade. Quando a coordenada da demanda veio do CENTRO DO MUNICÍPIO
// (coordenadas_origem = 'centro_cidade'), a distância calculada é precisão de CIDADE fingindo
// ser precisão de RUA: dizer "a apenas 800m de você" seria uma invenção confiante. Nesses
// casos citamos a cidade e omitimos a distância. O raio de 5km continua valendo — o que muda
// é só o texto. Origem 'cliente' ou NULL (linha legada) mantém a frase de hoje, byte a byte.
const textoProximidade = (rotulo, titulo, cidade, origem, distanciaKm) => {
  if (origem === 'centro_cidade') {
    return cidade
      ? `Há ${rotulo} "${titulo}" em ${cidade}!`
      : `Há ${rotulo} "${titulo}" perto de você!`
  }
  const dist = distanciaKm < 1
    ? `${Math.round(distanciaKm * 1000)}m`
    : `${distanciaKm.toFixed(1)}km`
  return `Há ${rotulo} "${titulo}" a apenas ${dist} de você!`
}

const verificarPrestadoresProximos = async () => {
  try {
    // Redesenho: dispara sobre reparos ARMADOS (aberturas_detalhe.notificado=false — o reparador
    // abriu o detalhe estando a >5km do cadastro) quando a posição AO VIVO chega a <5km.
    // Reparadores + reparos APENAS (obras/pintores removidos). O dedup agora é
    // aberturas_detalhe.notificado (claim atômico), NÃO mais proximidade_notificacoes (vestigial).
    //
    // Uma linha = um par (reparador armado, reparo) elegível: reparo válido (aberta/aprovada/não
    // expirado/sem match/com coords — mesma validade do endpoint app-open), reparador com
    // localização fresca (<30min), assinatura ativa, tier ESTRITO reparador (= exigirReparador:
    // role='prestador' AND tipo_prestador='reparador'), push_token, e sem engajamento prévio.
    const armados = await pool.query(`
      SELECT ad.reparador_id, ad.reparo_id,
             r.titulo, r.cidade, r.coordenadas_origem,
             r.latitude  AS r_lat, r.longitude AS r_lng,
             lp.latitude AS p_lat, lp.longitude AS p_lng,
             u.push_token
      FROM aberturas_detalhe ad
      JOIN reparos r                 ON r.id = ad.reparo_id
      JOIN localizacoes_prestadores lp ON lp.usuario_id = ad.reparador_id
      JOIN usuarios u                ON u.id = ad.reparador_id
      JOIN assinaturas a             ON a.usuario_id = u.id AND a.status = 'ativa'
      WHERE ad.notificado = false
        AND r.status = 'aberta' AND r.status_aprovacao = 'aprovada'
        AND r.expira_em > NOW() AND r.match_usuario_id IS NULL
        AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL
        AND lp.atualizado_em > NOW() - INTERVAL '30 minutes'
        AND u.push_token IS NOT NULL
        AND u.role = 'prestador' AND u.tipo_prestador = 'reparador'
        -- Suspenso por faltas não recebe isca de trabalho novo. Aqui é filtro de QUERY (não
        -- middleware): quem dispara o cron é o servidor, não o prestador.
        AND u.suspenso_em IS NULL
        AND NOT (ad.reparador_id = ANY(COALESCE(r.prestadores_bloqueados, '{}')))
        AND NOT EXISTS (
          SELECT 1 FROM interesse_reparos ir
          WHERE ir.reparo_id = r.id AND ir.usuario_id = ad.reparador_id
        )
    `)

    let notifReparos = 0
    for (const par of armados.rows) {
      const distLat = Math.abs(par.p_lat - par.r_lat)
      const distLon = Math.abs(par.p_lng - par.r_lng)
      if (distLat > RAIO_GRAUS || distLon > RAIO_GRAUS) continue
      const dLat = distLat * 111
      const dLon = distLon * 111 * Math.cos(par.p_lat * Math.PI / 180)
      const distanciaKm = Math.sqrt(dLat * dLat + dLon * dLon)
      if (distanciaKm > RAIO_KM) continue
      // CLAIM ATÔMICO (replica-safe): só envia se a linha ainda está notificado=false. Réplicas
      // do cron e o endpoint /feed/checar-proximidade competem pela mesma linha — só uma vence
      // (RETURNING). Sem linha retornada → já notificado → pula o push. One-time por reparo.
      const claim = await pool.query(
        `UPDATE aberturas_detalhe SET notificado = true
         WHERE reparador_id = $1 AND reparo_id = $2 AND notificado = false
         RETURNING reparo_id`,
        [par.reparador_id, par.reparo_id]
      )
      if (claim.rowCount === 0) continue
      await enviarPushNotificacao(
        par.push_token,
        '📍 Serviço próximo a você!',
        textoProximidade('um serviço', par.titulo, par.cidade, par.coordenadas_origem, distanciaKm),
        { tipo: 'reparo_proximo', reparo_id: par.reparo_id }
      ).catch(err => console.error('Erro push proximidade reparo:', err))
      notifReparos++
    }

    console.log(`[Proximidade] pares armados elegíveis: ${armados.rows.length} | notif enviadas: ${notifReparos}`)
  } catch (err) {
    console.error('[Proximidade] Erro na verificação:', err.message)
  }
}

const deletarMidiasAntigas = async () => {
  try {
    // Reparos encerrados há mais de 7 dias com mídias ainda não removidas
    const reparosAntigos = await pool.query(`
      SELECT r.id, mr.id as midia_id, mr.url, mr.tipo
      FROM reparos r
      JOIN midias_reparos mr ON mr.reparo_id = r.id
      WHERE r.status = 'encerrada'
        AND r.encerrado_em IS NOT NULL
        AND r.encerrado_em < NOW() - INTERVAL '7 days'
    `)
    for (const m of reparosAntigos.rows) {
      const sucesso = await deletarDoCloudinary(m.url, m.tipo)
      if (sucesso) {
        await pool.query(`DELETE FROM midias_reparos WHERE id = $1`, [m.midia_id])
      }
    }
    if (reparosAntigos.rows.length > 0) {
      console.log(`[MidiasAntigas] ${reparosAntigos.rows.length} mídias de reparos processadas`)
    }

    // Obras encerradas há mais de 7 dias com mídias ainda não removidas
    const obrasAntigas = await pool.query(`
      SELECT o.id, m.id as midia_id, m.url, m.tipo
      FROM obras o
      JOIN midias m ON m.obra_id = o.id
      WHERE o.status = 'encerrada'
        AND o.encerrado_em IS NOT NULL
        AND o.encerrado_em < NOW() - INTERVAL '7 days'
    `)
    for (const m of obrasAntigas.rows) {
      const sucesso = await deletarDoCloudinary(m.url, m.tipo)
      if (sucesso) {
        await pool.query(`DELETE FROM midias WHERE id = $1`, [m.midia_id])
      }
    }
    if (obrasAntigas.rows.length > 0) {
      console.log(`[MidiasAntigas] ${obrasAntigas.rows.length} mídias de obras processadas`)
    }
  } catch (err) {
    console.error('[MidiasAntigas] Erro:', err.message)
  }
}

const expirarAssinaturasVencidas = async () => {
  try {
    const vencidas = await pool.query(`
      SELECT a.id AS assinatura_id, a.usuario_id, u.push_token, u.nome
      FROM assinaturas a
      JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.status = 'ativa' AND a.proximo_vencimento < NOW()
    `)
    if (vencidas.rows.length === 0) return

    for (const sub of vencidas.rows) {
      // Chaveado no id da LINHA, não no usuario_id: o SELECT acima já escolheu exatamente
      // as assinaturas vencidas, e um usuário com mais de uma linha tinha todas marcadas
      // 'expirada' junto — inclusive as que ainda não venceram.
      await pool.query(
        `UPDATE assinaturas SET status = 'expirada', atualizado_em = NOW() WHERE id = $1`,
        [sub.assinatura_id]
      )
      // Os dois caches (middlewares/auth + cachePrestadores em routes) — só o primeiro
      // era limpo, então /reparos seguia servindo 'ativa' até o TTL de 5 min vencer.
      invalidarCachesUsuario(sub.usuario_id)
      if (sub.push_token) {
        enviarPushNotificacao(
          sub.push_token,
          '⚠️ Seu acesso expirou',
          'Sua assinatura venceu. Renove agora para continuar acessando os serviços.',
          { tipo: 'assinatura_expirada' }
        ).catch(() => {})
      }
    }
    console.log(`[ExpirarAssinaturas] ${vencidas.rows.length} assinatura(s) expirada(s)`)
  } catch (err) {
    console.error('[ExpirarAssinaturas] Erro:', err.message)
  }
}

// Três avisos de vencimento (24h / 12h / 6h), espelhando verificarMarcosExpiracao das
// demandas: bandas DISJUNTAS (no máximo um aviso por run e por assinatura) e claim-then-send.
// Compara TIMESTAMP, não DATE: o DATE() antigo tratava 00:30 e 23:50 do mesmo dia como iguais,
// então a antecedência real variava de minutos a quase 48h.
// tipo do payload segue 'assinatura_vence_amanha' nos TRÊS — o roteamento do app não muda;
// só título e corpo dizem quanto falta.
const MARCOS_VENCIMENTO = [
  { n: 1, col: 'marco_1_em', horas: 24, titulo: '⏰ Sua assinatura vence amanhã',
    corpo: 'Renove sua assinatura para não perder o acesso aos serviços disponíveis.' },
  { n: 2, col: 'marco_2_em', horas: 12, titulo: '⏰ Sua assinatura vence em 12 horas',
    corpo: 'Faltam menos de 12 horas. Renove para não perder o acesso aos serviços.' },
  { n: 3, col: 'marco_3_em', horas: 6,  titulo: '⚠️ Sua assinatura vence em 6 horas',
    corpo: 'Última chance: menos de 6 horas para renovar antes de perder o acesso.' },
]

const notificarAssinaturasProximasVencimento = async () => {
  try {
    // Candidatas: ativas, com vencimento AINDA no futuro dentro da maior banda (24h) e com
    // pelo menos um marco pendente. push_token vazio/nulo já sai daqui — não há o que enviar.
    const candidatos = await pool.query(`
      SELECT a.id, a.proximo_vencimento, a.marco_1_em, a.marco_2_em, a.marco_3_em, u.push_token
      FROM assinaturas a
      JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.status = 'ativa'
        AND a.proximo_vencimento IS NOT NULL
        AND a.proximo_vencimento > NOW()
        AND a.proximo_vencimento <= NOW() + INTERVAL '24 hours'
        AND (a.marco_1_em IS NULL OR a.marco_2_em IS NULL OR a.marco_3_em IS NULL)
        AND u.push_token IS NOT NULL AND u.push_token <> ''
    `)
    if (candidatos.rows.length === 0) return

    let totalEnviados = 0
    for (const sub of candidatos.rows) {
      const restanteHoras = (new Date(sub.proximo_vencimento).getTime() - Date.now()) / 3600000

      // Banda disjunta — no máximo um marco por run (mesma lógica de verificarMarcosExpiracao).
      const alvo = MARCOS_VENCIMENTO.find((m, i) => {
        const piso = MARCOS_VENCIMENTO[i + 1]?.horas ?? 0
        return sub[m.col] === null && restanteHoras <= m.horas && restanteHoras > piso
      })
      if (!alvo) continue

      // Claim-then-send: reivindica a coluna no MESMO UPDATE. Linha já reivindicada por outra
      // réplica (ou por um run anterior) não volta no RETURNING e não gera segundo envio.
      const claim = await pool.query(
        `UPDATE assinaturas SET ${alvo.col} = NOW() WHERE id = $1 AND ${alvo.col} IS NULL RETURNING id`,
        [sub.id]
      )
      if (claim.rows.length === 0) continue

      enviarPushNotificacao(sub.push_token, alvo.titulo, alvo.corpo, { tipo: 'assinatura_vence_amanha' })
        .catch(() => {})
      totalEnviados++
    }
    console.log(`[NotificarVencimento] ${totalEnviados} aviso(s) de vencimento enviado(s)`)
  } catch (err) {
    console.error('[NotificarVencimento] Erro:', err.message)
  }
}

const iniciarAgendador = () => {
  const INTERVALO_ENGAJAMENTO  = 8 * 60 * 60 * 1000
  const INTERVALO_EXPIRACAO    = 60 * 60 * 1000
  const INTERVALO_PROXIMIDADE  = 10 * 60 * 1000
  const INTERVALO_CRONOMETRO   = 60 * 1000
  const INTERVALO_AUTO_ENCERRAR = 5 * 60 * 1000

  setTimeout(() => {
    verificarObrasComBaixoEngajamento()
    // APOSENTADO: verificarObrasExpirando() enviava o texto fixo "expira em 24 horas!" para qualquer
    // demanda a <24h de expira_em, independente do tempo real restante. Substituído por
    // verificarMarcosExpiracao (marcos proporcionais à faixa de prazo). Função mantida em
    // alertaService.js, apenas não é mais agendada nem disparada no boot.
    // verificarObrasExpirando()
    verificarPrestadoresProximos()
    verificarMarcosExpiracao()
    verificarCronometroReparos()
    verificarCronometroObras()
  }, 60 * 1000)

  setInterval(() => { verificarObrasComBaixoEngajamento() }, INTERVALO_ENGAJAMENTO)
  // APOSENTADO (ver comentário acima): expiração agora é notificada SÓ por verificarMarcosExpiracao.
  // setInterval(() => { verificarObrasExpirando() }, INTERVALO_EXPIRACAO)
  setInterval(() => { verificarPrestadoresProximos() }, INTERVALO_PROXIMIDADE)
  setInterval(() => { verificarMarcosExpiracao() }, INTERVALO_CRONOMETRO)
  setInterval(() => { verificarCronometroReparos() }, INTERVALO_CRONOMETRO)
  setInterval(() => { verificarCronometroObras() }, INTERVALO_CRONOMETRO)
  setInterval(() => { deletarMidiasAntigas() }, 24 * 60 * 60 * 1000)
  setInterval(() => { expirarAssinaturasVencidas() }, 60 * 60 * 1000)
  // De 5 em 5 minutos. Era de hora em hora, justificado pelo prazo de 2 dias do encerramento
  // em duas mãos — mas a MESMA função também auto-confirma chegada, e esse prazo passou a ser
  // de 30 min nos reparos. Uma varredura horária é mais grossa que a própria janela: o reparo
  // ficava elegível aos 30 min e só era pego no tique seguinte (30–90 min reais, ~60 em média),
  // então o valor configurado virava um piso, não o comportamento. A 5 min a folga cai para
  // 30–35 min. O encerramento de 2 dias não se importa com a cadência mais fina; o custo é
  // apenas o SELECT/UPDATE dos dois lados, indexado e quase sempre vazio.
  setInterval(() => { autoEncerrarPendentes() }, INTERVALO_AUTO_ENCERRAR)
  // De hora em hora como o job de expiração: as bandas de 12h e 6h não existem numa cadência
  // diária — um tick por dia pularia as duas mais urgentes.
  setInterval(() => { notificarAssinaturasProximasVencimento() }, 60 * 60 * 1000)
  // Descarga do buffer de visitas (src/utils/visitas.js): agrupa as visitas da janela num
  // UPDATE por tabela, em vez de um UPDATE por visualização no caminho de leitura.
  iniciarFlushVisitas()

  setInterval(async () => {
    try {
      // Toggle "Modo Auto": OFF ('false' ou ausente) → admin presente, exige revisão manual.
      // Nenhuma aprovação automática acontece enquanto estiver OFF.
      const cfg = await pool.query(`SELECT valor FROM configuracoes WHERE chave = 'aprovacao_automatica'`)
      if (cfg.rows[0]?.valor !== 'true') return

      const pendentes = await pool.query(`
        SELECT u.id, u.nome, u.email, u.push_token
        FROM usuarios u
        JOIN assinaturas a ON a.usuario_id = u.id
        WHERE u.verificacao_status = 'pendente'
          AND a.status = 'pendente_verificacao'
          AND a.atualizado_em < NOW() - INTERVAL '1 hour'
      `)
      if (pendentes.rows.length === 0) return
      for (const p of pendentes.rows) {
        // aprovado_automaticamente = true → idoneidade ainda não revisada (auditável no painel)
        await pool.query(`UPDATE usuarios SET verificacao_status = 'aprovado', aprovado_automaticamente = true WHERE id = $1`, [p.id])
        await pool.query(`UPDATE assinaturas SET status = 'ativa', atualizado_em = NOW(),
          proximo_vencimento = CASE
            WHEN tipo = 'gratuito' THEN NULL
            WHEN plano = 'anual'   THEN GREATEST(proximo_vencimento, NOW() + INTERVAL '365 days')
            ELSE                        GREATEST(proximo_vencimento, NOW() + INTERVAL '30 days') END,
          marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL
         WHERE usuario_id = $1`, [p.id])
        // Assinatura recém-ativada: limpa os DOIS caches p/ o app não cair na tela de
        // pagamento (B72-07). Só o de middlewares/auth era limpo, então /reparos seguia
        // barrando o prestador recém-aprovado até o TTL de 5 min de cachePrestadores vencer.
        invalidarCachesUsuario(p.id)
        if (p.push_token) {
          await enviarPushNotificacao(p.push_token, '✅ Cadastro aprovado!', 'Bem-vindo ao PinturaPro! Seu acesso está liberado.', { tipo: 'verificacao_aprovada' }).catch(() => {})
        }
      }
      console.log(`[Timeout] ${pendentes.rows.length} prestadores auto-aprovados por timeout de 1h (Modo Auto ON)`)
    } catch (err) {
      console.error('[Timeout verificação] Erro:', err.message)
    }
  }, 10 * 60 * 1000)

  console.log(`Agendador iniciado — engajamento: 8h | expiração: 1h | proximidade: 10min | verificação timeout: 10min | marcos expiração (6h/60/30/15min, reparos+obras): 1min | cronômetro reparos: 1min | cronômetro obras: 1min | mídias antigas: 24h | expiração assinaturas: 1h | aviso vencimento: 1h | flush de visitas: ${INTERVALO_FLUSH_MS / 1000}s`)
}

rotasApp.migracaoPronta
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`
╔══════════════════════════════════════╗
║   PinturaPro API — v1.0.0            ║
║   Rodando em http://localhost:${PORT}   ║
╚══════════════════════════════════════╝
  `)
      console.log('[PagBank] token:', process.env.PAGBANK_TOKEN ? 'configurado' : 'AUSENTE', '| env:', process.env.PAGBANK_ENV || 'production')
      iniciarAgendador()
    })

    // Keep-alive: o default do Node é 5s, curto demais para um proxy à frente (o edge da
    // Railway mantém a conexão upstream por bem mais que isso). Com 5s, o proxy pode
    // escrever numa conexão que o Node acabou de fechar e a requisição morre como 502 —
    // sem nunca virar log de aplicação.
    //
    // A ORDEM DOS DOIS VALORES É OBRIGATÓRIA: headersTimeout > keepAliveTimeout. O default
    // de headersTimeout no Node 18 é 60000, MENOR que os 65000 abaixo — deixá-lo como está
    // faria o Node abortar conexões no meio da requisição. Se um dia mexer em um, mexa nos
    // dois. NÃO mexer em requestTimeout: os 300s do default são o que permite os uploads
    // grandes (express.json/urlencoded aceitam 100mb).
    server.keepAliveTimeout = 65000
    server.headersTimeout   = 70000

    // Desligamento gracioso — existe por UM motivo: descarregar o buffer de visitas antes
    // de sair, para um redeploy normal não perder a janela de até 30s acumulada em memória.
    //
    // ATENÇÃO: registrar handler de SIGTERM SUBSTITUI o default do Node (que encerra o
    // processo na hora). Se este caminho não terminar em process.exit, o redeploy fica
    // pendurado até a plataforma mandar SIGKILL — por isso o exit vai no `finally`, que roda
    // mesmo se o flush falhar. `once`: um segundo sinal não reentra no handler.
    const encerrarGraciosamente = (sinal) => {
      console.log(`[Shutdown] ${sinal} recebido — descarregando visitas pendentes`)
      flushVisitas()
        .catch(err => console.error('[Shutdown] flush de visitas falhou:', err.message))
        .finally(() => process.exit(0))
    }
    process.once('SIGTERM', () => encerrarGraciosamente('SIGTERM'))
    process.once('SIGINT',  () => encerrarGraciosamente('SIGINT'))
  })
  .catch((err) => {
    console.error('Falha na migração de boot — servidor não iniciado:', err)
    process.exit(1)
  })