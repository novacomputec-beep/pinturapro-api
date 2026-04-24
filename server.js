require('dotenv').config()

const express    = require('express')
const cors       = require('cors')
const helmet     = require('helmet')
const rateLimit  = require('express-rate-limit')
const routes     = require('./src/routes')

const app = express()

// ============================================================
// SEGURANÇA
// ============================================================

app.use(helmet())

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:8081',
    process.env.ADMIN_URL    || 'http://localhost:3001'
  ],
  credentials: true
}))

// Rate limit global: 100 requisições por IP a cada 15 minutos
app.set('trust proxy', 1)app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
}))

// Rate limit mais restrito para login/cadastro
app.use('/api/auth/login',    rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }))
app.use('/api/auth/cadastro', rateLimit({ windowMs: 60 * 60 * 1000, max: 5  }))

// ============================================================
// PARSING
// ============================================================

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// ============================================================
// ROTAS
// ============================================================

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

// ============================================================
// ERRO 404
// ============================================================

app.use((req, res) => {
  res.status(404).json({ erro: `Rota não encontrada: ${req.method} ${req.path}` })
})

// ============================================================
// TRATAMENTO GLOBAL DE ERROS
// ============================================================

app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err)
  res.status(500).json({ erro: 'Erro interno do servidor' })
})

// ============================================================
// START
// ============================================================

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   PinturaPro API — v1.0.0            ║
  ║   Rodando em http://localhost:${PORT}   ║
  ╚══════════════════════════════════════╝
  `)
})

module.exports = app
