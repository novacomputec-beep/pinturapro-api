require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const routes = require('./src/routes')
const { pool } = require('./src/utils/supabase')
const { verificarObrasComBaixoEngajamento, verificarObrasExpirando, enviarPushNotificacao } = require('./src/services/alertaService')

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

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))
app.use('/api', routes)

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
  res.status(500).json({ erro: 'Erro interno do servidor. Tente novamente.' })
})

// ============================================================
// JOB: NOTIFICAR PRESTADORES PRÓXIMOS DE REPAROS DISPONÍVEIS
// Roda a cada 15 minutos
// Raio: 5km (~0.045 graus de latitude/longitude)
// ============================================================
const RAIO_KM = 5
const RAIO_GRAUS = RAIO_KM / 111 // 1 grau ≈ 111km

const verificarPrestadoresProximos = async () => {
  try {
    // Busca reparos disponíveis com localização cadastrada
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

    if (reparos.rows.length === 0) return

    // Busca prestadores com localização atualizada nos últimos 30 minutos
    const prestadores = await pool.query(`
      SELECT lp.usuario_id, lp.latitude, lp.longitude, u.push_token, u.nome
      FROM localizacoes_prestadores lp
      JOIN usuarios u ON lp.usuario_id = u.id
      JOIN assinaturas a ON a.usuario_id = u.id AND a.status = 'ativa'
      WHERE lp.atualizado_em > NOW() - INTERVAL '30 minutes'
        AND u.push_token IS NOT NULL
    `)

    if (prestadores.rows.length === 0) return

    // Para cada reparo, verifica quais prestadores estão no raio
    for (const reparo of reparos.rows) {
      const bloqueados = reparo.prestadores_bloqueados || []

      for (const prestador of prestadores.rows) {
        // Pula prestadores bloqueados neste reparo
        if (bloqueados.includes(prestador.usuario_id)) continue

        const distLat = Math.abs(prestador.latitude - reparo.latitude)
        const distLon = Math.abs(prestador.longitude - reparo.longitude)

        // Verifica se está dentro do raio (aproximação por graus)
        if (distLat <= RAIO_GRAUS && distLon <= RAIO_GRAUS) {
          // Calcula distância em km (fórmula de Haversine simplificada)
          const dLat = distLat * 111
          const dLon = distLon * 111 * Math.cos(prestador.latitude * Math.PI / 180)
          const distanciaKm = Math.sqrt(dLat * dLat + dLon * dLon)

          if (distanciaKm <= RAIO_KM) {
            const distFormatada = distanciaKm < 1
              ? `${Math.round(distanciaKm * 1000)}m`
              : `${distanciaKm.toFixed(1)}km`

            await enviarPushNotificacao(
              prestador.push_token,
              '📍 Serviço próximo a você!',
              `Há um reparo "${reparo.titulo}" a apenas ${distFormatada} de você!`,
              { tipo: 'reparo_proximo', reparo_id: reparo.id }
            ).catch(err => console.error('Erro push proximidade:', err))
          }
        }
      }
    }

    console.log(`[Proximidade] Verificação concluída — ${reparos.rows.length} reparos, ${prestadores.rows.length} prestadores ativos`)
  } catch (err) {
    console.error('[Proximidade] Erro na verificação:', err.message)
  }
}

const iniciarAgendador = () => {
  const INTERVALO_ENGAJAMENTO  = 8 * 60 * 60 * 1000  // 8 horas
  const INTERVALO_EXPIRACAO    = 60 * 60 * 1000       // 1 hora
  const INTERVALO_PROXIMIDADE  = 15 * 60 * 1000       // 15 minutos

  // Aguarda 1 minuto antes de iniciar os jobs (servidor precisa estar pronto)
  setTimeout(() => {
    verificarObrasComBaixoEngajamento()
    verificarObrasExpirando()
    verificarPrestadoresProximos()
  }, 60 * 1000)

  setInterval(() => {
    verificarObrasComBaixoEngajamento()
  }, INTERVALO_ENGAJAMENTO)

  setInterval(() => {
    verificarObrasExpirando()
  }, INTERVALO_EXPIRACAO)

  setInterval(() => {
    verificarPrestadoresProximos()
  }, INTERVALO_PROXIMIDADE)

  console.log('Agendador iniciado — engajamento: 8h | expiração: 1h | proximidade: 15min')
}

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   PinturaPro API — v1.0.0            ║
║   Rodando em http://localhost:${PORT}   ║
╚══════════════════════════════════════╝
  `)
  iniciarAgendador()
})