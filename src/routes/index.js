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
const { uploadParaCloudinary, gerarAssinaturaCloudinary } = require('../services/uploadService')

// Middleware para verificar se é prestador de serviços
const exigirPrestador = async (req, res, next) => {
  try {
    if (req.usuario.role !== 'prestador' && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Acesso restrito a prestadores de serviços' })
    }
    const assinatura = await pool.query(
      `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' LIMIT 1`,
      [req.usuario.id]
    )
    if (assinatura.rows.length === 0) {
      return res.status(403).json({ erro: 'Assinatura inativa. Renove seu plano para acessar os reparos.' })
    }
    next()
  } catch (err) {
    res.status(500).json({ erro: 'Erro de autenticação' })
  }
}

// ============================================================
// AUTH
// ============================================================
router.post('/auth/cadastro',       authCtrl.cadastrar)
router.post('/auth/login',          authCtrl.login)
router.get('/auth/perfil',          autenticar, authCtrl.perfil)
router.put('/auth/perfil',          autenticar, authCtrl.atualizarPerfil)

// Upload de documentos de verificação — público (usuário ainda não tem token)
router.post('/auth/upload-verificacao', upload.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' })
    const resultado = await uploadParaCloudinary(req.file.buffer, 'imagem', 'pinturapro/verificacao')
    res.json({ url: resultado.url })
  } catch (err) {
    console.error('Erro upload verificacao:', err)
    res.status(500).json({ erro: 'Erro ao enviar documento' })
  }
})

router.post('/auth/push-token', autenticar, async (req, res) => {
  try {
    const { token } = req.body
    await pool.query('UPDATE usuarios SET push_token = $1 WHERE id = $2', [token, req.usuario.id])
    res.json({ mensagem: 'Token registrado' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar token' })
  }
})

// ============================================================
// OBRAS — rotas específicas ANTES das rotas com parâmetro
// ============================================================
router.get('/obras/minhas', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*,
        (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_interessados,
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) as foto_capa
       FROM obras o WHERE o.criado_por = $1 ORDER BY o.criado_em DESC`,
      [req.usuario.id]
    )
    res.json({ obras: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar obras' })
  }
})

router.post('/obras/dono', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'dono_obra' && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Apenas donos de obra podem cadastrar obras' })
    }
    const { titulo, categoria, valor, cidade, bairro, metragem, prazo_execucao_dias, horas_para_expirar, descricao, tags } = req.body
    const expira_em = new Date(Date.now() + (horas_para_expirar || 720) * 3600 * 1000)
    const result = await pool.query(
      `INSERT INTO obras (criado_por, titulo, categoria, valor, cidade, bairro, metragem, prazo_execucao_dias, expira_em, descricao, tags, status, enviada_por_dono, status_aprovacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'rascunho',true,'pendente') RETURNING *`,
      [req.usuario.id, titulo, categoria, valor, cidade, bairro, metragem, prazo_execucao_dias, expira_em.toISOString(), descricao, tags || []]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao cadastrar obra' })
  }
})

router.get('/obras-aprovacao', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, u.nome as dono_nome, u.email as dono_email, u.telefone as dono_telefone,
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) as foto_capa
       FROM obras o JOIN usuarios u ON o.criado_por = u.id
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
    await pool.query(`UPDATE obras SET status_aprovacao = 'aprovada', status = 'aberta' WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Obra aprovada e publicada!' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar obra' })
  }
})

router.post('/obras-aprovacao/:id/recusar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE obras SET status_aprovacao = 'recusada', status = 'cancelada' WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Obra recusada' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao recusar obra' })
  }
})

router.get('/obras',      autenticar, exigirAssinaturaAtiva, obrasCtrl.listar)
router.get('/obras/:id',  autenticar, exigirAssinaturaAtiva, obrasCtrl.detalhe)
router.post('/obras',     autenticar, exigirAdmin,           obrasCtrl.criar)
router.put('/obras/:id',  autenticar, exigirAdmin,           obrasCtrl.editar)
router.delete('/obras/:id', autenticar, exigirAdmin,         obrasCtrl.encerrar)

// ============================================================
// REPAROS — rotas específicas ANTES das rotas com parâmetro
// ============================================================
router.get('/reparos/minhas', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*,
        (SELECT COUNT(*) FROM interesse_reparos WHERE reparo_id = r.id) as total_interessados,
        (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY ordem LIMIT 1) as foto_capa
       FROM reparos r WHERE r.criado_por = $1 ORDER BY r.criado_em DESC`,
      [req.usuario.id]
    )
    res.json({ reparos: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar reparos' })
  }
})

router.post('/reparos/dono', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'dono_obra' && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Apenas donos podem cadastrar reparos' })
    }
    const { titulo, categoria, descricao, valor_estimado, cidade, bairro, tags } = req.body
    const expira_em = new Date(Date.now() + 720 * 3600 * 1000)
    const result = await pool.query(
      `INSERT INTO reparos (criado_por, titulo, categoria, descricao, valor_estimado, cidade, bairro, tags, status, status_aprovacao, expira_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'rascunho','pendente',$9) RETURNING *`,
      [req.usuario.id, titulo, categoria, descricao, valor_estimado, cidade, bairro, tags || [], expira_em.toISOString()]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('Erro ao criar reparo:', err)
    res.status(500).json({ erro: 'Erro ao cadastrar reparo' })
  }
})

router.get('/reparos/aprovacao', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.nome as dono_nome, u.email as dono_email, u.telefone as dono_telefone,
        (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY ordem LIMIT 1) as foto_capa
       FROM reparos r JOIN usuarios u ON r.criado_por = u.id
       WHERE r.status_aprovacao = 'pendente' ORDER BY r.criado_em DESC`
    )
    res.json({ reparos: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar reparos' })
  }
})

// Alias para compatibilidade com o painel admin
router.get('/reparos-aprovacao', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.nome as dono_nome, u.email as dono_email, u.telefone as dono_telefone,
        (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY ordem LIMIT 1) as foto_capa
       FROM reparos r JOIN usuarios u ON r.criado_por = u.id
       WHERE r.status_aprovacao = 'pendente' ORDER BY r.criado_em DESC`
    )
    res.json({ reparos: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar reparos' })
  }
})

router.post('/reparos/aprovacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE reparos SET status_aprovacao = 'aprovada', status = 'aberta' WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Reparo aprovado e publicado!' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar reparo' })
  }
})

router.post('/reparos/aprovacao/:id/recusar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE reparos SET status_aprovacao = 'recusada', status = 'cancelada' WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Reparo recusado' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao recusar reparo' })
  }
})

router.post('/reparos-aprovacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE reparos SET status_aprovacao = 'aprovada', status = 'aberta' WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Reparo aprovado e publicado!' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar reparo' })
  }
})

router.post('/reparos-aprovacao/:id/recusar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE reparos SET status_aprovacao = 'recusada', status = 'cancelada' WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Reparo recusado' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao recusar reparo' })
  }
})

// ============================================================
// PRESTADORES — aprovação de cadastro
// ============================================================
router.get('/prestadores/aprovacao', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.nome, u.email, u.telefone, u.cidade, u.uf, u.role,
             u.verificacao_status, u.verificacao_doc_frente_url, u.verificacao_doc_verso_url,
             u.verificacao_selfie_url, u.pix_reembolso, u.referencias, u.criado_em,
             a.plano, a.valor_mensal, a.status as assinatura_status
      FROM usuarios u
      LEFT JOIN assinaturas a ON a.usuario_id = u.id
      WHERE u.role IN ('prestador', 'assinante') AND u.verificacao_status = 'pendente'
      ORDER BY u.criado_em DESC
    `)
    res.json({ prestadores: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar prestadores' })
  }
})

router.post('/prestadores/aprovacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(
      `UPDATE usuarios SET verificacao_status = 'aprovado' WHERE id = $1`,
      [req.params.id]
    )
    res.json({ mensagem: 'Prestador aprovado com sucesso!' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar prestador' })
  }
})

router.post('/prestadores/aprovacao/:id/recusar', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { motivo } = req.body
    await pool.query(
      `UPDATE usuarios SET verificacao_status = 'recusado', ativo = false WHERE id = $1`,
      [req.params.id]
    )
    res.json({ mensagem: 'Prestador recusado' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao recusar prestador' })
  }
})

// ============================================================
// VERIFICAÇÃO — aliases para o painel admin
// ============================================================
router.get('/verificacao/pendentes', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.nome, u.email, u.telefone, u.cidade, u.uf, u.role,
             u.verificacao_status, u.verificacao_doc_frente_url, u.verificacao_doc_verso_url,
             u.verificacao_selfie_url, u.pix_reembolso, u.referencias, u.criado_em,
             a.plano, a.valor_mensal, a.status as assinatura_status
      FROM usuarios u
      LEFT JOIN assinaturas a ON a.usuario_id = u.id
      WHERE u.role IN ('prestador', 'assinante') AND u.verificacao_status = 'pendente'
      ORDER BY u.criado_em DESC
    `)
    res.json({ prestadores: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar prestadores' })
  }
})

router.post('/verificacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE usuarios SET verificacao_status = 'aprovado' WHERE id = $1`, [req.params.id])
    await pool.query(`UPDATE assinaturas SET status = 'ativa' WHERE usuario_id = $1`, [req.params.id])
    res.json({ mensagem: 'Prestador aprovado com sucesso!' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar prestador' })
  }
})

router.post('/verificacao/:id/reprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { motivo } = req.body
    const usuario = await pool.query(`SELECT pix_reembolso FROM usuarios WHERE id = $1`, [req.params.id])
    await pool.query(`UPDATE usuarios SET verificacao_status = 'recusado', ativo = false WHERE id = $1`, [req.params.id])
    const pix = usuario.rows[0]?.pix_reembolso
    const aviso = pix ? '' : '⚠️ Nenhuma chave PIX informada. Realize o reembolso manualmente.'
    res.json({ mensagem: 'Prestador reprovado', aviso })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao reprovar prestador' })
  }
})

router.get('/verificacao/modo-automatico', autenticar, exigirAdmin, (req, res) => {
  res.json({ ativo: false })
})

router.post('/verificacao/modo-automatico', autenticar, exigirAdmin, async (req, res) => {
  const { ativo } = req.body
  if (ativo) {
    await pool.query(`UPDATE usuarios SET verificacao_status = 'aprovado' WHERE verificacao_status = 'pendente'`)
    await pool.query(`UPDATE assinaturas SET status = 'ativa' WHERE status = 'pendente'`)
    res.json({ ativo: true, mensagem: 'Modo automático ativado. Todos os prestadores pendentes foram aprovados.' })
  } else {
    res.json({ ativo: false, mensagem: 'Modo automático desativado.' })
  }
})

router.get('/reparos', autenticar, exigirPrestador, async (req, res) => {
  try {
    const { categoria } = req.query
    let query = `
      SELECT r.*,
        (SELECT COUNT(*) FROM interesse_reparos WHERE reparo_id = r.id) as total_interessados,
        (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY ordem LIMIT 1) as foto_capa
      FROM reparos r
      WHERE r.status = 'aberta' AND r.status_aprovacao = 'aprovada' AND r.expira_em > NOW()`
    const params = []
    if (categoria && categoria !== 'todas') {
      params.push(categoria)
      query += ` AND r.categoria = $${params.length}`
    }
    query += ` ORDER BY r.criado_em DESC`
    const result = await pool.query(query, params)
    res.json({ reparos: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar reparos' })
  }
})

router.get('/reparos/:id', autenticar, async (req, res) => {
  try {
    const { role, id: userId } = req.usuario
    const isDono = role === 'dono_obra'
    const isAdmin = role === 'admin'

    let result
    if (isDono) {
      result = await pool.query(`SELECT * FROM reparos WHERE id = $1 AND criado_por = $2`, [req.params.id, userId])
    } else if (isAdmin) {
      result = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    } else {
      const assinatura = await pool.query(`SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' LIMIT 1`, [userId])
      if (assinatura.rows.length === 0) return res.status(403).json({ erro: 'Assinatura inativa. Renove seu plano para acessar os reparos.' })
      result = await pool.query(`SELECT * FROM reparos WHERE id = $1 AND status = 'aberta'`, [req.params.id])
    }

    if (result.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    const midias = await pool.query(`SELECT * FROM midias_reparos WHERE reparo_id = $1 ORDER BY ordem`, [req.params.id])

    if (isDono || isAdmin) {
      const interessados = await pool.query(`
        SELECT ir.id, ir.usuario_id, ir.mensagem, ir.status, ir.criado_em,
               u.nome, u.telefone, u.cidade, u.anos_experiencia, u.especialidades
        FROM interesse_reparos ir
        JOIN usuarios u ON ir.usuario_id = u.id
        WHERE ir.reparo_id = $1
        ORDER BY ir.criado_em DESC
      `, [req.params.id])
      res.json({ reparo: result.rows[0], midias: midias.rows, interessados: interessados.rows })
    } else {
      const interesse = await pool.query(`SELECT id, status FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2`, [req.params.id, userId])
      res.json({ reparo: result.rows[0], midias: midias.rows, meu_interesse: interesse.rows[0] || null })
    }
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar reparo' })
  }
})

router.post('/reparos/:id/interesse', autenticar, exigirPrestador, async (req, res) => {
  try {
    const { mensagem } = req.body
    const existente = await pool.query(`SELECT id FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id])
    if (existente.rows.length > 0) return res.status(409).json({ erro: 'Voce ja demonstrou interesse neste reparo' })
    const result = await pool.query(
      `INSERT INTO interesse_reparos (reparo_id, usuario_id, mensagem) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, req.usuario.id, mensagem]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar interesse' })
  }
})

router.post('/upload/reparo', autenticar, upload.single('arquivo'), async (req, res) => {
  try {
    const { reparo_id, ordem } = req.body
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' })
    const isVideo = req.file.mimetype.startsWith('video/')
    const tipo = isVideo ? 'video' : 'imagem'
    const resultado = await uploadParaCloudinary(req.file.buffer, tipo, 'pinturapro/reparos')
    const result = await pool.query(
      `INSERT INTO midias_reparos (reparo_id, tipo, url, ordem) VALUES ($1, $2, $3, $4) RETURNING *`,
      [reparo_id, isVideo ? 'video' : 'foto', resultado.url, ordem || 1]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('Erro upload reparo:', err)
    res.status(500).json({ erro: 'Erro ao fazer upload' })
  }
})

// Assinatura para upload direto ao Cloudinary (para vídeos grandes)
router.get('/upload/assinatura-cloudinary', autenticar, (req, res) => {
  try {
    const params = gerarAssinaturaCloudinary('pinturapro/videos')
    res.json(params)
  } catch (err) {
    console.error('Erro ao gerar assinatura Cloudinary:', err)
    res.status(500).json({ erro: 'Erro ao gerar assinatura de upload' })
  }
})

// Salva URL de mídia após upload direto ao Cloudinary
router.post('/upload/reparo-url', autenticar, async (req, res) => {
  try {
    const { reparo_id, url, tipo = 'video', ordem = 1 } = req.body
    if (!reparo_id || !url) return res.status(400).json({ erro: 'reparo_id e url são obrigatórios' })
    const result = await pool.query(
      `INSERT INTO midias_reparos (reparo_id, tipo, url, ordem) VALUES ($1, $2, $3, $4) RETURNING *`,
      [reparo_id, tipo, url, ordem]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('Erro ao salvar URL reparo:', err)
    res.status(500).json({ erro: 'Erro ao salvar mídia' })
  }
})

// ============================================================
// UPLOAD DE MÍDIAS
// ============================================================
router.post('/upload',      autenticar, exigirAdmin, upload.single('arquivo'), uploadMidia)
router.post('/upload/dono', autenticar,              upload.single('arquivo'), uploadMidia)

// ============================================================
// CANDIDATURAS
// ============================================================
router.post('/candidaturas',              autenticar, exigirAssinaturaAtiva, candidaturasCtrl.candidatar)
router.get('/candidaturas/minhas',        autenticar, candidaturasCtrl.minhas)
router.get('/candidaturas/pendentes',     autenticar, exigirAdmin, candidaturasCtrl.pendentes)
router.get('/candidaturas/obra/:obra_id', autenticar, exigirAdmin, candidaturasCtrl.porObra)
router.post('/candidaturas/:id/aprovar',  autenticar, exigirAdmin, candidaturasCtrl.aprovar)
router.post('/candidaturas/:id/recusar',  autenticar, exigirAdmin, candidaturasCtrl.recusar)

// ============================================================
// MENSAGENS
// ============================================================
router.post('/mensagens',                 autenticar, exigirAssinaturaAtiva, mensagensCtrl.enviar)
router.get('/mensagens/obra/:obra_id',    autenticar, mensagensCtrl.porObra)
router.get('/mensagens/pendentes',        autenticar, exigirAdmin, mensagensCtrl.pendentes)
router.post('/mensagens/:id/responder',   autenticar, exigirAdmin, mensagensCtrl.responder)

// ============================================================
// PAGAMENTOS
// ============================================================
router.post('/pagamentos/criar-assinatura', autenticar, pagamentoCtrl.criarAssinatura)
router.post('/pagamentos/webhook',          pagamentoCtrl.webhook)
router.get('/pagamentos/sucesso',           pagamentoCtrl.sucesso)
router.get('/pagamentos/falha',             (req, res) => res.redirect('https://pinturapro-painel-production.up.railway.app'))
router.get('/pagamentos/pendente',          (req, res) => res.redirect('https://pinturapro-painel-production.up.railway.app'))
router.post('/pagamentos/acesso-gratuito',  autenticar, exigirAdmin, pagamentoCtrl.darAcessoGratuito)
router.get('/pagamentos/assinantes',        autenticar, exigirAdmin, pagamentoCtrl.listarAssinantes)

// ============================================================
// DASHBOARD
// ============================================================
router.get('/dashboard', autenticar, exigirAdmin, async (req, res) => {
  try {
    const [obras, assinantes, candidaturas, obrasAprovacao, reparosAprovacao] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM obras WHERE status = 'aberta'`),
      pool.query(`SELECT COUNT(*) FROM assinaturas WHERE status = 'ativa'`),
      pool.query(`SELECT COUNT(*) FROM candidaturas WHERE status = 'pendente'`),
      pool.query(`SELECT COUNT(*) FROM obras WHERE enviada_por_dono = true AND status_aprovacao = 'pendente'`),
      pool.query(`SELECT COUNT(*) FROM reparos WHERE status_aprovacao = 'pendente'`)
    ])
    const totalAssinantes = parseInt(assinantes.rows[0].count)
    res.json({
      obras_abertas: parseInt(obras.rows[0].count),
      assinantes_ativos: totalAssinantes,
      receita_mensal: totalAssinantes * 99.90,
      candidaturas_pendentes: parseInt(candidaturas.rows[0].count),
      obras_para_aprovar: parseInt(obrasAprovacao.rows[0].count),
      reparos_para_aprovar: parseInt(reparosAprovacao.rows[0].count)
    })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar métricas' })
  }
})

// ============================================================
// ADMINISTRAÇÃO
// ============================================================
router.delete('/usuarios/:id', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM usuarios WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Usuário excluído' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao excluir usuário' })
  }
})

// Health check
router.get('/health', (req, res) => res.json({ status: 'ok', versao: '1.0.0' }))

module.exports = router