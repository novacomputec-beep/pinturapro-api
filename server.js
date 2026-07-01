require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const rotasApp = require('./src/routes')
const { pool } = require('./src/utils/supabase')
const { verificarObrasComBaixoEngajamento, verificarObrasExpirando, enviarPushNotificacao, verificarReparosExpirandoSemInteressados, verificarObrasExpirandoSemInteressados, verificarCronometroReparos } = require('./src/services/alertaService')
const { invalidarCacheAssinatura } = require('./src/middlewares/auth')
const { deletarDoCloudinary } = require('./src/services/uploadService')

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

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
}))

app.use('/api/auth/login',    rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }))
app.use('/api/auth/cadastro', rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }))

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
const COOLDOWN_PROXIMIDADE = 4 * 60 * 60 * 1000   // 4 hours per prestador+job pair
const notificacoesEnviadas = new Map()

const verificarPrestadoresProximos = async () => {
  const agora = Date.now()
  try {
    // ── REPAROS → prestadores ───────────────────────────────────────────────
    const reparos = await pool.query(`
      SELECT id, titulo, latitude, longitude, prestadores_bloqueados
      FROM reparos
      WHERE status = 'aberta'
        AND status_aprovacao = 'aprovada'
        AND expira_em > NOW()
        AND match_usuario_id IS NULL
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
    `)

    const prestadores = reparos.rows.length > 0
      ? await pool.query(`
          SELECT lp.usuario_id, lp.latitude, lp.longitude, u.push_token, u.nome
          FROM localizacoes_prestadores lp
          JOIN usuarios u ON lp.usuario_id = u.id
          JOIN assinaturas a ON a.usuario_id = u.id AND a.status = 'ativa'
          WHERE lp.atualizado_em > NOW() - INTERVAL '30 minutes'
            AND u.push_token IS NOT NULL
            AND u.role = 'prestador' AND u.tipo_prestador IS DISTINCT FROM 'pintor'
        `)
      : { rows: [] }

    let notifReparos = 0
    for (const reparo of reparos.rows) {
      const bloqueados = reparo.prestadores_bloqueados || []
      for (const prestador of prestadores.rows) {
        if (bloqueados.includes(prestador.usuario_id)) continue
        const distLat = Math.abs(prestador.latitude - reparo.latitude)
        const distLon = Math.abs(prestador.longitude - reparo.longitude)
        if (distLat > RAIO_GRAUS || distLon > RAIO_GRAUS) continue
        const dLat = distLat * 111
        const dLon = distLon * 111 * Math.cos(prestador.latitude * Math.PI / 180)
        const distanciaKm = Math.sqrt(dLat * dLat + dLon * dLon)
        if (distanciaKm > RAIO_KM) continue
        const chave = `${prestador.usuario_id}_reparo_${reparo.id}`
        const ultimaEnviada = notificacoesEnviadas.get(chave)
        if (ultimaEnviada && agora - ultimaEnviada < COOLDOWN_PROXIMIDADE) continue
        notificacoesEnviadas.set(chave, agora)
        const dist = distanciaKm < 1
          ? `${Math.round(distanciaKm * 1000)}m`
          : `${distanciaKm.toFixed(1)}km`
        await enviarPushNotificacao(
          prestador.push_token,
          '📍 Serviço próximo a você!',
          `Há um reparo "${reparo.titulo}" a apenas ${dist} de você!`,
          { tipo: 'reparo_proximo', reparo_id: reparo.id }
        ).catch(err => console.error('Erro push proximidade reparo:', err))
        notifReparos++
      }
    }

    // ── OBRAS → assinantes (pintores) ───────────────────────────────────────
    const obras = await pool.query(`
      SELECT id, titulo, latitude, longitude
      FROM obras
      WHERE status = 'aberta'
        AND status_aprovacao = 'aprovada'
        AND expira_em > NOW()
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
    `)

    const pintores = obras.rows.length > 0
      ? await pool.query(`
          SELECT lp.usuario_id, lp.latitude, lp.longitude, u.push_token, u.nome
          FROM localizacoes_prestadores lp
          JOIN usuarios u ON lp.usuario_id = u.id
          JOIN assinaturas a ON a.usuario_id = u.id AND a.status = 'ativa'
          WHERE lp.atualizado_em > NOW() - INTERVAL '30 minutes'
            AND u.push_token IS NOT NULL
            AND u.role = 'prestador' AND u.tipo_prestador = 'pintor'
        `)
      : { rows: [] }

    let notifObras = 0
    for (const obra of obras.rows) {
      for (const pintor of pintores.rows) {
        const distLat = Math.abs(pintor.latitude - obra.latitude)
        const distLon = Math.abs(pintor.longitude - obra.longitude)
        if (distLat > RAIO_GRAUS || distLon > RAIO_GRAUS) continue
        const dLat = distLat * 111
        const dLon = distLon * 111 * Math.cos(pintor.latitude * Math.PI / 180)
        const distanciaKm = Math.sqrt(dLat * dLat + dLon * dLon)
        if (distanciaKm > RAIO_KM) continue
        const chave = `${pintor.usuario_id}_obra_${obra.id}`
        const ultimaEnviada = notificacoesEnviadas.get(chave)
        if (ultimaEnviada && agora - ultimaEnviada < COOLDOWN_PROXIMIDADE) continue
        notificacoesEnviadas.set(chave, agora)
        const dist = distanciaKm < 1
          ? `${Math.round(distanciaKm * 1000)}m`
          : `${distanciaKm.toFixed(1)}km`
        await enviarPushNotificacao(
          pintor.push_token,
          '🎨 Obra próxima a você!',
          `Há uma obra "${obra.titulo}" a apenas ${dist} de você!`,
          { tipo: 'obra_proxima', obra_id: obra.id }
        ).catch(err => console.error('Erro push proximidade obra:', err))
        notifObras++
      }
    }

    console.log(`[Proximidade] reparos: ${reparos.rows.length} | prestadores ativos: ${prestadores.rows.length} | notif enviadas: ${notifReparos} | obras: ${obras.rows.length} | pintores ativos: ${pintores.rows.length} | notif enviadas: ${notifObras}`)
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
      SELECT a.usuario_id, u.push_token, u.nome
      FROM assinaturas a
      JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.status = 'ativa' AND a.proximo_vencimento < NOW()
    `)
    if (vencidas.rows.length === 0) return

    for (const sub of vencidas.rows) {
      await pool.query(
        `UPDATE assinaturas SET status = 'expirada', atualizado_em = NOW() WHERE usuario_id = $1`,
        [sub.usuario_id]
      )
      invalidarCacheAssinatura(sub.usuario_id)
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

const iniciarAgendador = () => {
  const INTERVALO_ENGAJAMENTO  = 8 * 60 * 60 * 1000
  const INTERVALO_EXPIRACAO    = 60 * 60 * 1000
  const INTERVALO_PROXIMIDADE  = 15 * 60 * 1000
  const INTERVALO_CRONOMETRO   = 60 * 1000

  setTimeout(() => {
    verificarObrasComBaixoEngajamento()
    verificarObrasExpirando()
    verificarPrestadoresProximos()
    verificarReparosExpirandoSemInteressados()
    verificarObrasExpirandoSemInteressados()
    verificarCronometroReparos()
  }, 60 * 1000)

  setInterval(() => { verificarObrasComBaixoEngajamento() }, INTERVALO_ENGAJAMENTO)
  setInterval(() => { verificarObrasExpirando() }, INTERVALO_EXPIRACAO)
  setInterval(() => { verificarPrestadoresProximos() }, INTERVALO_PROXIMIDADE)
  setInterval(() => { verificarReparosExpirandoSemInteressados() }, INTERVALO_EXPIRACAO)
  setInterval(() => { verificarObrasExpirandoSemInteressados() }, INTERVALO_EXPIRACAO)
  setInterval(() => { verificarCronometroReparos() }, INTERVALO_CRONOMETRO)
  setInterval(() => { deletarMidiasAntigas() }, 24 * 60 * 60 * 1000)
  setInterval(() => { expirarAssinaturasVencidas() }, 60 * 60 * 1000)

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
          proximo_vencimento = CASE WHEN plano = 'anual' THEN NOW() + INTERVAL '365 days' ELSE NOW() + INTERVAL '30 days' END
         WHERE usuario_id = $1`, [p.id])
        // Assinatura recém-ativada: limpa o cache p/ o app não cair na tela de pagamento (B72-07)
        invalidarCacheAssinatura(p.id)
        if (p.push_token) {
          await enviarPushNotificacao(p.push_token, '✅ Cadastro aprovado!', 'Bem-vindo ao PinturaPro! Seu acesso está liberado.', { tipo: 'verificacao_aprovada' }).catch(() => {})
        }
      }
      console.log(`[Timeout] ${pendentes.rows.length} prestadores auto-aprovados por timeout de 1h (Modo Auto ON)`)
    } catch (err) {
      console.error('[Timeout verificação] Erro:', err.message)
    }
  }, 10 * 60 * 1000)

  console.log('Agendador iniciado — engajamento: 8h | expiração: 1h | proximidade: 15min | verificação timeout: 10min | expirando sem interessados (reparos+obras): 1h | cronômetro reparos: 1min | mídias antigas: 24h | expiração assinaturas: 1h')
}

rotasApp.migracaoPronta
  .then(() => {
    app.listen(PORT, () => {
      console.log(`
╔══════════════════════════════════════╗
║   PinturaPro API — v1.0.0            ║
║   Rodando em http://localhost:${PORT}   ║
╚══════════════════════════════════════╝
  `)
      console.log('[PagBank] token:', process.env.PAGBANK_TOKEN ? 'configurado' : 'AUSENTE', '| env:', process.env.PAGBANK_ENV || 'production')
      iniciarAgendador()
    })
  })
  .catch((err) => {
    console.error('Falha na migração de boot — servidor não iniciado:', err)
    process.exit(1)
  })