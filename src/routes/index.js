const express = require('express')
const router = express.Router()

const { autenticar, exigirAssinaturaAtiva, exigirAdmin } = require('../middlewares/auth')
const { pool } = require('../utils/supabase')

const authCtrl         = require('../controllers/authController')
const obrasCtrl        = require('../controllers/obrasController')
const candidaturasCtrl = require('../controllers/candidaturasController')
const mensagensCtrl    = require('../controllers/mensagensController')
const { upload, uploadMidia } = require('../controllers/uploadController')

// ============================================================
// AUTH
// ============================================================
router.post('/auth/cadastro',       authCtrl.cadastrar)
router.post('/auth/login',          authCtrl.login)
router.get('/auth/perfil',          autenticar, authCtrl.perfil)
router.put('/auth/perfil',          autenticar, authCtrl.atualizarPerfil)

// ============================================================
// OBRAS
// ============================================================
router.get('/obras',                autenticar, exigirAssinaturaAtiva, obrasCtrl.listar)
router.get('/obras/:id',            autenticar, exigirAssinaturaAtiva, obrasCtrl.detalhe)
router.post('/obras',               autenticar, exigirAdmin,           obrasCtrl.criar)
router.put('/obras/:id',            autenticar, exigirAdmin,           obrasCtrl.editar)
router.delete('/obras/:id',         autenticar, exigirAdmin,           obrasCtrl.encerrar)

// ============================================================
// UPLOAD DE MÍDIAS
// ============================================================
router.post('/upload', autenticar, exigirAdmin, upload.single('arquivo'), uploadMidia)

// ============================================================
// CANDIDATURAS
// ============================================================
router.post('/candidaturas',                    autenticar, exigirAssinaturaAtiva, candidaturasCtrl.candidatar)
router.get('/candidaturas/minhas',              autenticar, candidaturasCtrl.minhas)
router.get('/candidaturas/pendentes',           autenticar, exigirAdmin, candidaturasCtrl.pendentes)
router.get('/candidaturas/obra/:obra_id',       autenticar, exigirAdmin, candidaturasCtrl.porObra)
router.post('/candidaturas/:id/aprovar',        autenticar, exigirAdmin, candidaturasCtrl.aprovar)
router.post('/candidaturas/:id/recusar',        autenticar, exigirAdmin, candidaturasCtrl.recusar)

// ============================================================
// MENSAGENS
// ============================================================
router.post('/mensagens',                       autenticar, exigirAssinaturaAtiva, mensagensCtrl.enviar)
router.get('/mensagens/obra/:obra_id',          autenticar, mensagensCtrl.porObra)
router.get('/mensagens/pendentes',              autenticar, exigirAdmin, mensagensCtrl.pendentes)
router.post('/mensagens/:id/responder',         autenticar, exigirAdmin, mensagensCtrl.responder)

// ============================================================
// DASHBOARD
// ============================================================
router.get('/dashboard', autenticar, exigirAdmin, async (req, res) => {
  try {
    const [obras, assinantes, candidaturas] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM obras WHERE status = 'aberta'`),
      pool.query(`SELECT COUNT(*) FROM assinaturas WHERE status = 'ativa'`),
      pool.query(`SELECT COUNT(*) FROM candidaturas WHERE status = 'pendente'`)
    ])

    const totalAssinantes = parseInt(assinantes.rows[0].count)

    res.json({
      obras_abertas: parseInt(obras.rows[0].count),
      assinantes_ativos: totalAssinantes,
      receita_mensal: totalAssinantes * 99.90,
      candidaturas_pendentes: parseInt(candidaturas.rows[0].count)
    })
  } catch (err) {
    console.error('Erro dashboard:', err)
    res.status(500).json({ erro: 'Erro ao buscar métricas' })
  }
})

// Health check
router.get('/health', (req, res) => res.json({ status: 'ok', versao: '1.0.0' }))

module.exports = router