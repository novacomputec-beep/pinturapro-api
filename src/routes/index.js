const express = require('express')
const router = express.Router()

const { autenticar, exigirAssinaturaAtiva, exigirAdmin } = require('../middlewares/auth')

const authCtrl         = require('../controllers/authController')
const obrasCtrl        = require('../controllers/obrasController')
const candidaturasCtrl = require('../controllers/candidaturasController')
const mensagensCtrl    = require('../controllers/mensagensController')

// ============================================================
// AUTH
// ============================================================
router.post('/auth/cadastro',       authCtrl.cadastrar)
router.post('/auth/login',          authCtrl.login)
router.get('/auth/perfil',          autenticar, authCtrl.perfil)
router.put('/auth/perfil',          autenticar, authCtrl.atualizarPerfil)

// ============================================================
// OBRAS — leitura exige assinatura ativa; escrita exige admin
// ============================================================
router.get('/obras',                autenticar, exigirAssinaturaAtiva, obrasCtrl.listar)
router.get('/obras/:id',            autenticar, exigirAssinaturaAtiva, obrasCtrl.detalhe)
router.post('/obras',               autenticar, exigirAdmin,           obrasCtrl.criar)
router.put('/obras/:id',            autenticar, exigirAdmin,           obrasCtrl.editar)
router.delete('/obras/:id',         autenticar, exigirAdmin,           obrasCtrl.encerrar)

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
// MENSAGENS / DÚVIDAS
// ============================================================
router.post('/mensagens',                       autenticar, exigirAssinaturaAtiva, mensagensCtrl.enviar)
router.get('/mensagens/obra/:obra_id',          autenticar, mensagensCtrl.porObra)
router.get('/mensagens/pendentes',              autenticar, exigirAdmin, mensagensCtrl.pendentes)
router.post('/mensagens/:id/responder',         autenticar, exigirAdmin, mensagensCtrl.responder)

// ============================================================
// DASHBOARD — métricas para o painel admin
// ============================================================
router.get('/dashboard', autenticar, exigirAdmin, async (req, res) => {
  const supabase = require('../utils/supabase')
  try {
    const [
      { count: obrasAbertas },
      { count: assinantesAtivos },
      { count: candidaturasPendentes },
      { count: contratosMes }
    ] = await Promise.all([
      supabase.from('obras').select('*', { count: 'exact', head: true }).eq('status', 'aberta'),
      supabase.from('assinaturas').select('*', { count: 'exact', head: true }).eq('status', 'ativa'),
      supabase.from('candidaturas').select('*', { count: 'exact', head: true }).eq('status', 'pendente'),
      supabase.from('contratos').select('*', { count: 'exact', head: true })
        .gte('gerado_em', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString())
    ])

    res.json({
      obras_abertas: obrasAbertas,
      assinantes_ativos: assinantesAtivos,
      receita_mensal: (assinantesAtivos || 0) * 99.90,
      candidaturas_pendentes: candidaturasPendentes,
      contratos_mes: contratosMes
    })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar métricas' })
  }
})

// Health check
router.get('/health', (req, res) => res.json({ status: 'ok', versao: '1.0.0' }))

module.exports = router
