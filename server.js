require('dotenv').config()
const express = require('express')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const routes = require('./src/routes')
const { pool } = require('./src/utils/supabase')
const { verificarObrasComBaixoEngajamento, verificarObrasExpirando } = require('./src/services/alertaService')

const app = express()
const PORT = process.env.PORT || 3000

app.set('trust proxy', 1)

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

// Rate limit global — aumentado para não bloquear uso legítimo do app
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
}))

// Rate limits específicos para rotas sensíveis
app.use('/api/auth/login',    rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }))
app.use('/api/auth/cadastro', rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }))

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

app.use('/api', routes)

// Health check real — verifica banco de dados
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

// Rota não encontrada
app.use((req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada' })
})

// Error handler global — captura erros não tratados nas rotas
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err.message)
  res.status(500).json({ erro: 'Erro interno do servidor. Tente novamente.' })
})

const iniciarAgendador = () => {
  const INTERVALO_ENGAJAMENTO = 8 * 60 * 60 * 1000
  const INTERVALO_EXPIRACAO   = 60 * 60 * 1000

  setTimeout(() => {
    verificarObrasComBaixoEngajamento()
    verificarObrasExpirando()
  }, 60 * 1000)

  setInterval(() => {
    verificarObrasComBaixoEngajamento()
  }, INTERVALO_ENGAJAMENTO)

  setInterval(() => {
    verificarObrasExpirando()
  }, INTERVALO_EXPIRACAO)

  console.log('Agendador iniciado — engajamento: 8h, expiração: 1h')
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