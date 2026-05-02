const express = require('express')
const router = express.Router()

const { autenticar, exigirAssinaturaAtiva, exigirAdmin } = require('../middlewares/auth')
const { pool } = require('../utils/supabase')

const authCtrl         = require('../controllers/authController')
const obrasCtrl        = require('../controllers/obrasController')
const candidaturasCtrl = require('../controllers/candidaturasController')
const mensagensCtrl    = require('../controllers/mensagensController')
const pagamentoCtrl    = require('../controllers/pagamentoController')
const { upload, uploadMidia } = require('../controllers/uploadController')

// ============================================================
// AUTH
// ============================================================
router.post('/auth/cadastro',       authCtrl.cadastrar)
router.post('/auth/login',          authCtrl.login)
router.get('/auth/perfil',          autenticar, authCtrl.perfil)
router.put('/auth/perfil',          autenticar, authCtrl.atualizarPerfil)

router.post('/auth/push-token', autenticar, async (req, res) => {
  try {
    const { token } = req.body
    await pool.query(
      'UPDATE usuarios SET push_token = $1 WHERE id = $2',
      [token, req.usuario.id]
    )
    res.json({ mensagem: 'Token registrado' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar token' })
  }
})

// ============================================================
// OBRAS — rotas específicas ANTES das rotas com parâmetro
// ============================================================

// Dono de obra — listar suas obras
router.get('/obras/minhas', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*,
        (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_interessados,
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) as foto_capa
       FROM obras o
       WHERE o.criado_por = $1
       ORDER BY o.criado_em DESC`,
      [req.usuario.id]
    )
    res.json({ obras: result.rows })
  } catch (err) {
    console.error('Erro ao buscar obras do dono:', err)
    res.status(500).json({ erro: 'Erro ao buscar obras' })
  }
})

// Dono de obra — cadastrar obra
router.post('/obras/dono', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'dono_obra' && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Apenas donos de obra podem cadastrar obras' })
    }

    const { titulo, categoria, valor, cidade, bairro, metragem,
            prazo_execucao_dias, horas_para_expirar, descricao, tags } = req.body

    const expira_em = new Date(Date.now() + (horas_para_expirar || 720) * 3600 * 1000)

    const result = await pool.query(
      `INSERT INTO obras (criado_por, titulo, categoria, valor, cidade, bairro,
        metragem, prazo_execucao_dias, expira_em, descricao, tags, status,
        enviada_por_dono, status_aprovacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'rascunho',true,'pendente')
       RETURNING *`,
      [req.usuario.id, titulo, categoria, valor, cidade, bairro,
       metragem, prazo_execucao_dias, expira_em.toISOString(), descricao, tags || []]
    )

    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('Erro ao criar obra do dono:', err)
    res.status(500).json({ erro: 'Erro ao cadastrar obra' })
  }
})

// Admin — aprovação de obras
router.get('/obras-aprovacao', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, u.nome as dono_nome, u.email as dono_email, u.telefone as dono_telefone,
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) as foto_capa
       FROM obras o
       JOIN usuarios u ON o.criado_por = u.id
       WHERE o.enviada_por_dono = true AND o.status_aprovacao = 'pendente'
       ORDER BY o.criado_em DESC`
    )
    res.json({ obras: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar obras para aprovação' })
  }
})

router.post('/obras-aprovacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(
      `UPDATE obras SET status_aprovacao = 'aprovada', status = 'aberta' WHERE id = $1`,
      [req.params.id]
    )
    res.json({ mensagem: 'Obra aprovada e publicada!' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar obra' })
  }
})

router.post('/obras-aprovacao/:id/recusar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(
      `UPDATE obras SET status_aprovacao = 'recusada', status = 'cancelada' WHERE id = $1`,
      [req.params.id]
    )
    res.json({ mensagem: 'Obra recusada' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao recusar obra' })
  }
})

// Rotas gerais de obras — com parâmetro :id DEPOIS das específicas
router.get('/obras',                autenticar, exigirAssinaturaAtiva, obrasCtrl.listar)
router.get('/obras/:id',            autenticar, exigirAssinaturaAtiva, obrasCtrl.detalhe)
router.post('/obras',               autenticar, exigirAdmin,           obrasCtrl.criar)
router.put('/obras/:id',            autenticar, exigirAdmin,           obrasCtrl.editar)
router.delete('/obras/:id',         autenticar, exigirAdmin,           obrasCtrl.encerrar)

// ============================================================
// UPLOAD DE MÍDIAS
// ============================================================
router.post('/upload',      autenticar, exigirAdmin, upload.single('arquivo'), uploadMidia)
router.post('/upload/dono', autenticar,              upload.single('arquivo'), uploadMidia)

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
// PAGAMENTOS
// ============================================================
router.post('/pagamentos/criar-assinatura',     autenticar, pagamentoCtrl.criarAssinatura)
router.post('/pagamentos/webhook',              pagamentoCtrl.webhook)
router.get('/pagamentos/sucesso',               pagamentoCtrl.sucesso)
router.get('/pagamentos/falha',                 (req, res) => res.redirect('https://pinturapro-painel-production.up.railway.app'))
router.get('/pagamentos/pendente',              (req, res) => res.redirect('https://pinturapro-painel-production.up.railway.app'))
router.post('/pagamentos/acesso-gratuito',      autenticar, exigirAdmin, pagamentoCtrl.darAcessoGratuito)
router.get('/pagamentos/assinantes',            autenticar, exigirAdmin, pagamentoCtrl.listarAssinantes)

// ============================================================
// DASHBOARD
// ============================================================
router.get('/dashboard', autenticar, exigirAdmin, async (req, res) => {
  try {
    const [obras, assinantes, candidaturas, obrasAprovacao] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM obras WHERE status = 'aberta'`),
      pool.query(`SELECT COUNT(*) FROM assinaturas WHERE status = 'ativa'`),
      pool.query(`SELECT COUNT(*) FROM candidaturas WHERE status = 'pendente'`),
      pool.query(`SELECT COUNT(*) FROM obras WHERE enviada_por_dono = true AND status_aprovacao = 'pendente'`)
    ])

    const totalAssinantes = parseInt(assinantes.rows[0].count)

    res.json({
      obras_abertas: parseInt(obras.rows[0].count),
      assinantes_ativos: totalAssinantes,
      receita_mensal: totalAssinantes * 99.90,
      candidaturas_pendentes: parseInt(candidaturas.rows[0].count),
      obras_para_aprovar: parseInt(obrasAprovacao.rows[0].count)
    })
  } catch (err) {
    console.error('Erro dashboard:', err)
    res.status(500).json({ erro: 'Erro ao buscar métricas' })
  }
})

// Health check
router.get('/health', (req, res) => res.json({ status: 'ok', versao: '1.0.0' }))

module.exports = router