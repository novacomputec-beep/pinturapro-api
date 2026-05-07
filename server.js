require('dotenv').config()
const express = require('express')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const routes = require('./src/routes')
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

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
}))

app.use('/api/auth/login',    rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }))
app.use('/api/auth/cadastro', rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }))

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

app.use('/api', routes)

app.get('/', (req, res) => {
  res.json({ api: 'PinturaPro API', versao: '1.0.0', status: 'online', docs: '/api/health' })
})

app.use((req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada' })
})

const iniciarAgendador = () => {
  const INTERVALO_ENGAJAMENTO = 8 * 60 * 60 * 1000  // 8 horas
  const INTERVALO_EXPIRACAO = 60 * 60 * 1000         // 1 hora

  // Roda após 1 minuto da inicialização
  setTimeout(() => {
    verificarObrasComBaixoEngajamento()
    verificarObrasExpirando()
  }, 60 * 1000)

  // Engajamento a cada 8 horas
  setInterval(() => {
    verificarObrasComBaixoEngajamento()
  }, INTERVALO_ENGAJAMENTO)

  // Expiração a cada 1 hora
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