require('dotenv').config()
const express = require('express')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const routes = require('./src/routes')

const app = express()
const PORT = process.env.PORT || 3000

// Trust proxy
app.set('trust proxy', 1)

// CORS — libera o painel admin e o app
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

// Rate limit global
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
}))

// Rate limit mais restrito para login/cadastro
app.use('/api/auth/login',    rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }))
app.use('/api/auth/cadastro', rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }))

// Parsing
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Rotas
app.use('/api', routes)

// Rota raiz
app.get('/', (req, res) => {
  res.json({
    api: 'PinturaPro API',
    versao: '1.0.0',
    status: 'online',
    docs: '/api/health'
  })
})

// Erro 404
app.use((req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada' })
})

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   PinturaPro API — v1.0.0            ║
║   Rodando em http://localhost:${PORT}   ║
╚══════════════════════════════════════╝
  `)
})