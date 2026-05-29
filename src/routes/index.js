require('dotenv').config()
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
const { uploadArquivo } = require('../services/uploadService')
const { enviarPushNotificacao, notificarPintoresSobreNovaObra, notificarPrestadoresSobreNovoReparo } = require('../services/alertaService')
const { enviarContratoReparo, enviarContratoObra } = require('../controllers/contratosController')

// Cache de assinatura para prestadores
const cachePrestadores = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutos

const exigirPrestador = async (req, res, next) => {
  try {
    if (req.usuario.role !== 'prestador' && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Acesso restrito a prestadores de serviços' })
    }
    if (req.usuario.role === 'admin') return next()

    const cached = cachePrestadores.get(req.usuario.id)
    if (cached !== null && cached !== undefined && Date.now() - cached.timestamp < CACHE_TTL) {
      if (!cached.ativa) return res.status(403).json({ erro: 'Assinatura inativa. Renove seu plano para acessar os reparos.' })
      return next()
    }

    const assinatura = await pool.query(
      `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' LIMIT 1`,
      [req.usuario.id]
    )
    const ativa = assinatura.rows.length > 0
    cachePrestadores.set(req.usuario.id, { ativa, timestamp: Date.now() })

    if (!ativa) return res.status(403).json({ erro: 'Assinatura inativa. Renove seu plano para acessar os reparos.' })
    next()
  } catch (err) {
    res.status(500).json({ erro: 'Erro de autenticação' })
  }
}

// ============================================================
// AUTH
// ============================================================
router.post('/auth/cadastro',        authCtrl.cadastrar)
router.post('/auth/login',           authCtrl.login)
router.get('/auth/perfil',           autenticar, authCtrl.perfil)
router.put('/auth/perfil',           autenticar, authCtrl.atualizarPerfil)
router.post('/auth/alterar-senha',   autenticar, authCtrl.alterarSenha)
router.post('/auth/esqueci-senha',   authCtrl.esqueciSenha)

router.post('/auth/foto-perfil', autenticar, upload.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' })
    const resultado = await uploadArquivo(req.file)
    await pool.query('UPDATE usuarios SET foto_url = $1 WHERE id = $2', [resultado.secure_url, req.usuario.id])
    res.json({ foto_url: resultado.secure_url })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao enviar foto' })
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
// USUARIOS
// ============================================================
router.delete('/usuarios/:id', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    const { id } = req.params
    if (id === req.usuario.id) return res.status(400).json({ erro: 'Não é possível excluir sua própria conta' })

    const usuario = await client.query('SELECT id, role FROM usuarios WHERE id = $1', [id])
    if (usuario.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })
    if (usuario.rows[0].role === 'admin') return res.status(400).json({ erro: 'Não é possível excluir um administrador' })

    await client.query('BEGIN')
    await client.query('DELETE FROM assinaturas WHERE usuario_id = $1', [id])
    await client.query('DELETE FROM candidaturas WHERE usuario_id = $1', [id])
    await client.query('DELETE FROM mensagens WHERE autor_id = $1', [id])
    await client.query('DELETE FROM interesse_reparos WHERE usuario_id = $1', [id])
    await client.query('DELETE FROM negociacoes WHERE autor_id = $1', [id])
    await client.query('DELETE FROM usuarios WHERE id = $1', [id])
    await client.query('COMMIT')

    res.json({ mensagem: 'Usuário excluído com sucesso' })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Erro ao excluir usuário:', err)
    res.status(500).json({ erro: 'Erro ao excluir usuário' })
  } finally {
    client.release()
  }
})

// ============================================================
// OBRAS
// ============================================================
router.get('/obras/minhas', autenticar, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

    const result = await pool.query(
      `SELECT o.*,
        (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_interessados,
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) as foto_capa
       FROM obras o WHERE o.criado_por = $1 ORDER BY o.criado_em DESC
       LIMIT $2 OFFSET $3`,
      [req.usuario.id, limit, offset]
    )
    res.json({ obras: result.rows, page, limit })
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
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

    const result = await pool.query(
      `SELECT o.*, u.nome as dono_nome, u.email as dono_email, u.telefone as dono_telefone,
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) as foto_capa
       FROM obras o JOIN usuarios u ON o.criado_por = u.id
       WHERE o.enviada_por_dono = true AND o.status_aprovacao = 'pendente'
       ORDER BY o.criado_em DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    res.json({ obras: result.rows, page, limit })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar obras para aprovação' })
  }
})

router.post('/obras-aprovacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE obras SET status_aprovacao = 'aprovada', status = 'aberta' WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Obra aprovada e publicada!' })
    notificarPintoresSobreNovaObra(req.params.id).catch(err => console.error('Erro notificar pintores:', err))
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

router.get('/obras', autenticar, exigirAssinaturaAtiva, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit
    req.query.page  = page
    req.query.limit = limit
    req.query.offset = offset
    return obrasCtrl.listar(req, res)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar obras' })
  }
})

router.post('/obras',       autenticar, exigirAdmin, obrasCtrl.criar)
router.put('/obras/:id',    autenticar, exigirAdmin, obrasCtrl.editar)
router.delete('/obras/:id', autenticar, exigirAdmin, obrasCtrl.encerrar)

router.get('/obras/:id', autenticar, exigirAssinaturaAtiva, async (req, res) => {
  try {
    await pool.query(`UPDATE obras SET total_visitas = COALESCE(total_visitas, 0) + 1 WHERE id = $1`, [req.params.id])
    const result = await pool.query(
      `SELECT o.*,
        (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_candidaturas,
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) as foto_capa
       FROM obras o WHERE o.id = $1 AND o.status = 'aberta'`,
      [req.params.id]
    )
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    const midias = await pool.query(`SELECT * FROM midias WHERE obra_id = $1 ORDER BY ordem`, [req.params.id])
    const minhaCandidatura = await pool.query(
      `SELECT id, status, valor_oferta, mensagem_oferta FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2`,
      [req.params.id, req.usuario.id]
    )
    res.json({ obra: result.rows[0], midias: midias.rows, minha_candidatura: minhaCandidatura.rows[0] || null })
  } catch (err) {
    console.error('Erro ao buscar obra:', err)
    res.status(500).json({ erro: 'Erro ao buscar obra' })
  }
})

// ============================================================
// REPAROS
// ============================================================
router.get('/reparos/minhas', autenticar, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

    const result = await pool.query(
      `SELECT r.*,
        (SELECT COUNT(*) FROM interesse_reparos WHERE reparo_id = r.id) as total_interessados,
        (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY ordem LIMIT 1) as foto_capa
       FROM reparos r WHERE r.criado_por = $1 ORDER BY r.criado_em DESC
       LIMIT $2 OFFSET $3`,
      [req.usuario.id, limit, offset]
    )
    res.json({ reparos: result.rows, page, limit })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar reparos' })
  }
})

router.post('/reparos/dono', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'dono_obra' && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Apenas donos podem cadastrar reparos' })
    }
    const { titulo, categoria, descricao, valor_estimado, cidade, bairro, tags, prazo_atendimento_horas } = req.body
    const expira_em = new Date(Date.now() + 720 * 3600 * 1000)
    const result = await pool.query(
      `INSERT INTO reparos (criado_por, titulo, categoria, descricao, valor_estimado, cidade, bairro, tags, status, status_aprovacao, expira_em, prazo_atendimento_horas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'aberta','aprovada',$9,$10) RETURNING *`,
      [req.usuario.id, titulo, categoria, descricao, valor_estimado, cidade, bairro, tags || [], expira_em.toISOString(), prazo_atendimento_horas || null]
    )
    res.status(201).json(result.rows[0])
    notificarPrestadoresSobreNovoReparo(result.rows[0].id).catch(err => console.error('Erro notificar prestadores:', err))
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao cadastrar reparo' })
  }
})

router.get('/reparos/aprovacao', autenticar, exigirAdmin, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

    const result = await pool.query(
      `SELECT r.*, u.nome as dono_nome, u.email as dono_email, u.telefone as dono_telefone
       FROM reparos r JOIN usuarios u ON r.criado_por = u.id
       WHERE r.status_aprovacao = 'pendente' ORDER BY r.criado_em DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    res.json({ reparos: result.rows, page, limit })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar reparos' })
  }
})

router.post('/reparos/aprovacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE reparos SET status_aprovacao = 'aprovada', status = 'aberta' WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Reparo aprovado e publicado!' })
    notificarPrestadoresSobreNovoReparo(req.params.id).catch(err => console.error('Erro notificar prestadores:', err))
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

router.get('/reparos', autenticar, exigirPrestador, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit
    const { categoria } = req.query

    // $1 reservado para o usuario_id (filtro de bloqueados)
    const params = [req.usuario.id]

    let query = `
      SELECT r.*,
        (SELECT COUNT(*) FROM interesse_reparos WHERE reparo_id = r.id) as total_interessados,
        (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY ordem LIMIT 1) as foto_capa
      FROM reparos r
      WHERE r.status = 'aberta' AND r.status_aprovacao = 'aprovada' AND r.expira_em > NOW()
        AND NOT ($1::uuid = ANY(COALESCE(r.prestadores_bloqueados, '{}')))`

    if (categoria && categoria !== 'todas') {
      params.push(categoria)
      query += ` AND r.categoria = $${params.length}`
    }

    params.push(limit)
    query += ` ORDER BY r.criado_em DESC LIMIT $${params.length}`
    params.push(offset)
    query += ` OFFSET $${params.length}`

    const result = await pool.query(query, params)
    res.json({ reparos: result.rows, page, limit })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar reparos' })
  }
})

router.post('/reparos/:id/interesse', autenticar, exigirPrestador, async (req, res) => {
  try {
    const { mensagem } = req.body
    const existente = await pool.query(`SELECT id FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id])
    if (existente.rows.length > 0) return res.status(409).json({ erro: 'Você já demonstrou interesse neste reparo' })
    const result = await pool.query(
      `INSERT INTO interesse_reparos (reparo_id, usuario_id, mensagem) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, req.usuario.id, mensagem]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar interesse' })
  }
})

router.post('/reparos/:id/match', autenticar, exigirPrestador, async (req, res) => {
  try {
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1 AND status = 'aberta'`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    if (reparo.rows[0].match_usuario_id) return res.status(409).json({ erro: 'Este reparo já tem um prestador a caminho' })
    await pool.query(
      `UPDATE reparos SET match_feito_em = NOW(), match_usuario_id = $1 WHERE id = $2`,
      [req.usuario.id, req.params.id]
    )
    const dono = await pool.query(
      `SELECT u.push_token FROM reparos r JOIN usuarios u ON r.criado_por = u.id WHERE r.id = $1`,
      [req.params.id]
    )
    if (dono.rows[0]?.push_token) {
      await enviarPushNotificacao(
        dono.rows[0].push_token,
        '🚀 Profissional a caminho!',
        `Um prestador confirmou que está indo até você para "${reparo.rows[0].titulo}"`,
        { tipo: 'match_reparo', reparo_id: req.params.id }
      )
    }
    res.json({ mensagem: 'Match confirmado! Contagem regressiva iniciada.', match_feito_em: new Date() })
    // Envia contrato por e-mail para dono e prestador
    enviarContratoReparo(req.params.id).catch(err => console.error('Erro ao enviar contrato reparo:', err))
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao confirmar match' })
  }
})

router.post('/reparos/:id/encerrar', autenticar, async (req, res) => {
  try {
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    const r = reparo.rows[0]
    const ehDono      = r.criado_por === req.usuario.id
    const ehPrestador = r.match_usuario_id === req.usuario.id
    const ehAdmin     = req.usuario.role === 'admin'
    if (!ehDono && !ehPrestador && !ehAdmin) return res.status(403).json({ erro: 'Sem permissão para encerrar este reparo' })
    await pool.query(`UPDATE reparos SET status = 'encerrada', status_aprovacao = 'encerrada' WHERE id = $1`, [req.params.id])
    if (ehDono && r.match_usuario_id) {
      const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
      if (prestador.rows[0]?.push_token) {
        await enviarPushNotificacao(prestador.rows[0].push_token, '✅ Reparo encerrado!',
          `O solicitante encerrou o reparo "${r.titulo}".`, { tipo: 'reparo_encerrado', reparo_id: req.params.id })
      }
    } else if (ehPrestador) {
      const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.criado_por])
      if (dono.rows[0]?.push_token) {
        await enviarPushNotificacao(dono.rows[0].push_token, '✅ Serviço concluído!',
          `O prestador concluiu o reparo "${r.titulo}".`, { tipo: 'reparo_encerrado', reparo_id: req.params.id })
      }
    }
    res.json({ mensagem: 'Reparo encerrado com sucesso!' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao encerrar reparo' })
  }
})

router.post('/reparos/:id/expirar-match', autenticar, async (req, res) => {
  try {
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    const r = reparo.rows[0]
    const ehDono      = r.criado_por === req.usuario.id
    const ehPrestador = r.match_usuario_id === req.usuario.id
    const ehAdmin     = req.usuario.role === 'admin'
    if (!ehDono && !ehPrestador && !ehAdmin) {
      return res.status(403).json({ erro: 'Sem permissão para expirar este match' })
    }
    // Grava o prestador na lista negra antes de limpar o match
    await pool.query(
      `UPDATE reparos SET
        match_feito_em = NULL,
        match_usuario_id = NULL,
        prestadores_bloqueados = array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid)
       WHERE id = $1`,
      [req.params.id, r.match_usuario_id]
    )
    res.json({ mensagem: 'Match expirado, reparo disponível novamente' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao expirar match' })
  }
})

// Prestador solicita mais tempo — envia motivo e notifica dono
router.post('/reparos/:id/pedir-tempo', autenticar, async (req, res) => {
  try {
    const { motivo } = req.body
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    const r = reparo.rows[0]

    if (r.match_usuario_id !== req.usuario.id) {
      return res.status(403).json({ erro: 'Apenas o prestador do match pode solicitar mais tempo' })
    }

    await pool.query(
      `UPDATE reparos SET pedido_tempo_status = 'aguardando_tempo', pedido_tempo_motivo = $1, pedido_tempo_minutos = NULL WHERE id = $2`,
      [motivo, req.params.id]
    )

    // Notifica o dono
    const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.criado_por])
    if (dono.rows[0]?.push_token) {
      await enviarPushNotificacao(
        dono.rows[0].push_token,
        '⚠️ Prestador precisa de mais tempo!',
        `Motivo: ${motivo}. Abra o app para responder.`,
        { tipo: 'pedido_tempo', reparo_id: req.params.id }
      )
    }

    res.json({ mensagem: 'Solicitação enviada ao dono.' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao solicitar mais tempo' })
  }
})

// Dono pergunta quanto tempo o prestador precisa — notifica prestador
router.post('/reparos/:id/perguntar-tempo', autenticar, async (req, res) => {
  try {
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    const r = reparo.rows[0]

    if (r.criado_por !== req.usuario.id) {
      return res.status(403).json({ erro: 'Apenas o dono pode responder o pedido' })
    }

    await pool.query(
      `UPDATE reparos SET pedido_tempo_status = 'aguardando_minutos' WHERE id = $1`,
      [req.params.id]
    )

    // Notifica o prestador
    const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
    if (prestador.rows[0]?.push_token) {
      await enviarPushNotificacao(
        prestador.rows[0].push_token,
        '⏱ Quanto tempo você precisa?',
        'O solicitante quer saber quantos minutos a mais você precisa para chegar.',
        { tipo: 'perguntar_tempo', reparo_id: req.params.id }
      )
    }

    res.json({ mensagem: 'Prestador notificado para informar o tempo.' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao perguntar tempo' })
  }
})

// Prestador informa quantos minutos precisa — notifica dono para aceitar/recusar
router.post('/reparos/:id/informar-tempo', autenticar, async (req, res) => {
  try {
    const { minutos } = req.body
    if (!minutos || minutos <= 0) return res.status(400).json({ erro: 'Informe um tempo válido em minutos' })

    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    const r = reparo.rows[0]

    if (r.match_usuario_id !== req.usuario.id) {
      return res.status(403).json({ erro: 'Apenas o prestador do match pode informar o tempo' })
    }

    await pool.query(
      `UPDATE reparos SET pedido_tempo_status = 'aguardando_aprovacao', pedido_tempo_minutos = $1 WHERE id = $2`,
      [minutos, req.params.id]
    )

    // Notifica o dono
    const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.criado_por])
    if (dono.rows[0]?.push_token) {
      await enviarPushNotificacao(
        dono.rows[0].push_token,
        '⏳ Prestador precisa de mais tempo',
        `Ele precisa de ${minutos} minuto(s) a mais. Aceitar ou recusar?`,
        { tipo: 'aprovar_tempo', reparo_id: req.params.id }
      )
    }

    res.json({ mensagem: 'Dono notificado para aprovar o tempo.' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao informar tempo' })
  }
})

// Dono aceita ou recusa o tempo extra
router.post('/reparos/:id/responder-tempo', autenticar, async (req, res) => {
  try {
    const { aceito } = req.body
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    const r = reparo.rows[0]

    if (r.criado_por !== req.usuario.id) {
      return res.status(403).json({ erro: 'Apenas o dono pode responder' })
    }

    if (aceito) {
      // Estende o cronômetro somando os minutos ao match_feito_em
      const novoMatchFeitoEm = new Date(new Date(r.match_feito_em).getTime() + r.pedido_tempo_minutos * 60 * 1000)
      await pool.query(
        `UPDATE reparos SET match_feito_em = $1, pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL WHERE id = $2`,
        [novoMatchFeitoEm.toISOString(), req.params.id]
      )

      // Notifica prestador
      const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
      if (prestador.rows[0]?.push_token) {
        await enviarPushNotificacao(
          prestador.rows[0].push_token,
          '✅ Tempo extra aceito!',
          `O solicitante aceitou. Você tem mais ${r.pedido_tempo_minutos} minuto(s). Corra!`,
          { tipo: 'tempo_aceito', reparo_id: req.params.id }
        )
      }

      res.json({ mensagem: 'Tempo extra concedido!', novo_match_feito_em: novoMatchFeitoEm })
    } else {
      // Recusou — bloqueia prestador e volta reparo para disponível
      await pool.query(
        `UPDATE reparos SET
          match_feito_em = NULL,
          match_usuario_id = NULL,
          pedido_tempo_status = NULL,
          pedido_tempo_motivo = NULL,
          pedido_tempo_minutos = NULL,
          prestadores_bloqueados = array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid)
         WHERE id = $1`,
        [req.params.id, r.match_usuario_id]
      )

      // Notifica prestador
      const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
      if (prestador.rows[0]?.push_token) {
        await enviarPushNotificacao(
          prestador.rows[0].push_token,
          '❌ Tempo extra recusado',
          'O solicitante não aceitou. O reparo voltou para disponível.',
          { tipo: 'tempo_recusado', reparo_id: req.params.id }
        )
      }

      res.json({ mensagem: 'Tempo recusado. Reparo disponível novamente.' })
    }
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao responder pedido de tempo' })
  }
})

// CORRIGIDO: aceita dono do reparo E prestador (não só prestador)
router.get('/reparos/:id', autenticar, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })

    const reparo = result.rows[0]
    const ehDono           = reparo.criado_por === req.usuario.id
    const ehPrestadorDoMatch = reparo.match_usuario_id === req.usuario.id

    // Dono sempre pode ver seu próprio reparo
    // Prestador do match sempre pode ver
    // Admin sempre pode ver
    // Prestador comum precisa de assinatura ativa
    if (!ehDono && !ehPrestadorDoMatch && req.usuario.role !== 'admin') {
      if (req.usuario.role !== 'prestador') {
        return res.status(403).json({ erro: 'Sem permissão para ver este reparo' })
      }
      const assinatura = await pool.query(
        `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' LIMIT 1`,
        [req.usuario.id]
      )
      if (assinatura.rows.length === 0) {
        return res.status(403).json({ erro: 'Assinatura inativa. Renove seu plano para acessar os reparos.' })
      }
    }

    // Só conta visita se for prestador (não dono consultando o próprio reparo)
    if (!ehDono) {
      await pool.query(`UPDATE reparos SET total_visitas = COALESCE(total_visitas, 0) + 1 WHERE id = $1`, [req.params.id])
    }

    const midias    = await pool.query(`SELECT * FROM midias_reparos WHERE reparo_id = $1 ORDER BY ordem`, [req.params.id])
    const interesse = await pool.query(
      `SELECT id, status FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2`,
      [req.params.id, req.usuario.id]
    )

    // Se for dono ou admin, busca lista de interessados
    let interessados = []
    if (ehDono || req.usuario.role === 'admin') {
      const result2 = await pool.query(
        `SELECT ir.id, ir.status, ir.mensagem, ir.criado_em,
                u.nome, u.telefone, u.cidade
         FROM interesse_reparos ir
         JOIN usuarios u ON ir.usuario_id = u.id
         WHERE ir.reparo_id = $1
         ORDER BY ir.criado_em ASC`,
        [req.params.id]
      )
      interessados = result2.rows
    }

    res.json({
      reparo: result.rows[0],
      midias: midias.rows,
      meu_interesse: interesse.rows[0] || null,
      interessados,
    })
  } catch (err) {
    console.error('Erro ao buscar reparo:', err)
    res.status(500).json({ erro: 'Erro ao buscar reparo' })
  }
})

router.post('/upload/reparo', autenticar, upload.single('arquivo'), async (req, res) => {
  try {
    const { reparo_id, ordem } = req.body
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' })
    const resultado = await uploadArquivo(req.file)
    const tipo = req.file.mimetype.startsWith('video/') ? 'video' : 'foto'
    const result = await pool.query(
      `INSERT INTO midias_reparos (reparo_id, tipo, url, ordem) VALUES ($1, $2, $3, $4) RETURNING *`,
      [reparo_id, tipo, resultado.secure_url, ordem || 1]
    )
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao fazer upload' })
  }
})

// Limpar dados de teste (admin) — apaga tudo exceto admins
router.post('/admin/limpar-testes', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM interesse_reparos`)
    await client.query(`DELETE FROM midias_reparos`)
    await client.query(`DELETE FROM reparos`)
    await client.query(`DELETE FROM negociacoes`)
    await client.query(`DELETE FROM candidaturas`)
    await client.query(`DELETE FROM midias`)
    await client.query(`DELETE FROM obras`)
    await client.query(`DELETE FROM mensagens`)
    await client.query(`DELETE FROM assinaturas WHERE usuario_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    await client.query(`DELETE FROM localizacoes_prestadores WHERE usuario_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    await client.query(`DELETE FROM usuarios WHERE role != 'admin'`)
    await client.query('COMMIT')
    res.json({ mensagem: 'Dados de teste removidos com sucesso!' })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Erro ao limpar testes:', err)
    res.status(500).json({ erro: 'Erro ao limpar dados de teste' })
  } finally {
    client.release()
  }
})

// ============================================================
// VERIFICAÇÃO DE PRESTADORES
// ============================================================

// Upload de documentos de verificação
router.post('/auth/upload-verificacao', autenticar, upload.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' })
    const { tipo } = req.body
    const resultado = await uploadArquivo(req.file)

    // Salva URL no campo correto
    const campo = tipo === 'doc_frente' ? 'verificacao_doc_frente_url'
      : tipo === 'doc_verso' ? 'verificacao_doc_verso_url'
      : 'verificacao_selfie_url'

    await pool.query(`UPDATE usuarios SET ${campo} = $1 WHERE id = $2`, [resultado.secure_url, req.usuario.id])
    res.json({ url: resultado.secure_url })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao enviar documento' })
  }
})

// Lista prestadores pendentes de verificação (admin)
router.get('/verificacao/pendentes', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.nome, u.email, u.telefone, u.cidade, u.cpf_cnpj,
             u.verificacao_status, u.verificacao_doc_frente_url,
             u.verificacao_doc_verso_url, u.verificacao_selfie_url,
             u.referencias, u.pix_reembolso, u.criado_em,
             a.plano, a.status as assinatura_status
      FROM usuarios u
      LEFT JOIN assinaturas a ON a.usuario_id = u.id
      WHERE u.verificacao_status = 'pendente'
        AND u.role IN ('prestador', 'pintor', 'assinante')
      ORDER BY u.criado_em ASC
    `)
    res.json({ prestadores: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar pendentes' })
  }
})

// Aprovar prestador
router.post('/verificacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { id } = req.params

    const usuario = await pool.query(
      `SELECT nome, email FROM usuarios WHERE id = $1`, [id]
    )
    if (usuario.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })

    // Aprova verificação e ativa assinatura
    await pool.query(
      `UPDATE usuarios SET verificacao_status = 'aprovado' WHERE id = $1`, [id]
    )
    await pool.query(
      `UPDATE assinaturas SET status = 'ativa', atualizado_em = NOW() WHERE usuario_id = $1`, [id]
    )

    // Notifica prestador por e-mail
    const { nome, email } = usuario.rows[0]
    const nodemailer = require('nodemailer')
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: 587, secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
    transporter.sendMail({
      from: `PinturaPro <${process.env.SMTP_USER}>`,
      to: email,
      subject: '✅ PinturaPro — Cadastro aprovado! Bem-vindo!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #4caf50; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #fff; margin: 0;">✅ Cadastro Aprovado!</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2>Parabéns, ${nome}!</h2>
            <p>Sua identidade foi verificada e seu acesso ao PinturaPro está liberado.</p>
            <p>Abra o aplicativo e comece a encontrar serviços na sua região agora mesmo!</p>
            <p><strong>Equipe PinturaPro</strong></p>
          </div>
        </div>
      `
    }).catch(err => console.error('Erro e-mail aprovação:', err))

    // Notificação push
    const pushToken = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [id])
    if (pushToken.rows[0]?.push_token) {
      await enviarPushNotificacao(
        pushToken.rows[0].push_token,
        '✅ Cadastro aprovado!',
        'Sua identidade foi verificada. Bem-vindo ao PinturaPro!',
        { tipo: 'verificacao_aprovada' }
      )
    }

    res.json({ mensagem: 'Prestador aprovado com sucesso' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar prestador' })
  }
})

// Reprovar prestador e fazer reembolso via PIX
router.post('/verificacao/:id/reprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { motivo } = req.body

    const usuario = await pool.query(
      `SELECT nome, email, pix_reembolso FROM usuarios WHERE id = $1`, [id]
    )
    if (usuario.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })

    const { nome, email, pix_reembolso } = usuario.rows[0]

    // Reprova e cancela assinatura
    await pool.query(
      `UPDATE usuarios SET verificacao_status = 'reprovado' WHERE id = $1`, [id]
    )
    await pool.query(
      `UPDATE assinaturas SET status = 'cancelada', atualizado_em = NOW() WHERE usuario_id = $1`, [id]
    )

    // Notifica prestador por e-mail com instrução de reembolso
    const nodemailer = require('nodemailer')
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: 587, secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
    transporter.sendMail({
      from: `PinturaPro <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'PinturaPro — Informação sobre seu cadastro',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #0a0a0a; margin: 0;">PinturaPro</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2>Olá, ${nome}</h2>
            <p>Após análise, não foi possível aprovar seu cadastro no momento.</p>
            ${motivo ? `<p><strong>Motivo:</strong> ${motivo}</p>` : ''}
            <p style="background: #fff3cd; padding: 16px; border-radius: 8px; border-left: 4px solid #E8833A;">
              <strong>Reembolso:</strong> O valor pago será devolvido para sua chave PIX 
              <strong>${pix_reembolso || 'informada no cadastro'}</strong> em até 5 dias úteis.
            </p>
            <p>Se tiver dúvidas, entre em contato conosco respondendo este e-mail.</p>
            <p><strong>Equipe PinturaPro</strong></p>
          </div>
        </div>
      `
    }).catch(err => console.error('Erro e-mail reprovação:', err))

    // Notificação push
    const pushToken = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [id])
    if (pushToken.rows[0]?.push_token) {
      await enviarPushNotificacao(
        pushToken.rows[0].push_token,
        '📋 Informação sobre seu cadastro',
        'Acesse seu e-mail para mais detalhes sobre seu cadastro.',
        { tipo: 'verificacao_reprovada' }
      )
    }

    res.json({
      mensagem: 'Prestador reprovado',
      pix_reembolso,
      aviso: `Efetue o reembolso manualmente via PIX para a chave: ${pix_reembolso}`
    })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao reprovar prestador' })
  }
})

// Modo automático — liga/desliga aprovação automática
router.get('/verificacao/modo-automatico', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT valor FROM configuracoes WHERE chave = 'aprovacao_automatica'`
    )
    res.json({ ativo: result.rows[0]?.valor === 'true' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar configuração' })
  }
})

router.post('/verificacao/modo-automatico', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { ativo } = req.body
    await pool.query(
      `UPDATE configuracoes SET valor = $1, atualizado_em = NOW() WHERE chave = 'aprovacao_automatica'`,
      [ativo ? 'true' : 'false']
    )

    // Se ligar modo automático, aprova todos os pendentes agora
    if (ativo) {
      const pendentes = await pool.query(
        `SELECT u.id FROM usuarios u
         JOIN assinaturas a ON a.usuario_id = u.id
         WHERE u.verificacao_status = 'pendente'
           AND a.status = 'pendente_verificacao'`
      )
      for (const p of pendentes.rows) {
        await pool.query(`UPDATE usuarios SET verificacao_status = 'aprovado' WHERE id = $1`, [p.id])
        await pool.query(`UPDATE assinaturas SET status = 'ativa', atualizado_em = NOW() WHERE usuario_id = $1`, [p.id])
      }
      console.log(`[Modo automático] ${pendentes.rows.length} prestadores aprovados automaticamente`)
    }

    res.json({ mensagem: ativo ? 'Modo automático ativado' : 'Modo automático desativado', ativo })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar configuração' })
  }
})

// ============================================================
// LOCALIZAÇÃO DE PRESTADORES
// ============================================================

// Prestador envia sua localização atual
router.post('/prestadores/localizacao', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'prestador') {
      return res.status(403).json({ erro: 'Apenas prestadores enviam localização' })
    }
    const { latitude, longitude } = req.body
    if (!latitude || !longitude) return res.status(400).json({ erro: 'Latitude e longitude são obrigatórios' })

    await pool.query(
      `INSERT INTO localizacoes_prestadores (usuario_id, latitude, longitude, atualizado_em)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (usuario_id) DO UPDATE SET latitude = $2, longitude = $3, atualizado_em = NOW()`,
      [req.usuario.id, latitude, longitude]
    )
    res.json({ mensagem: 'Localização atualizada' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar localização' })
  }
})

// ============================================================
// UPLOAD
// ============================================================
router.post('/upload',      autenticar, exigirAdmin, upload.single('arquivo'), uploadMidia)
router.post('/upload/dono', autenticar,              upload.single('arquivo'), uploadMidia)

// ============================================================
// CANDIDATURAS
// ============================================================
router.post('/candidaturas', autenticar, exigirAssinaturaAtiva, async (req, res) => {
  try {
    const { obra_id, referencias, valor_oferta, mensagem_oferta } = req.body
    const obraResult = await pool.query(`SELECT id, titulo, status FROM obras WHERE id = $1 AND status = 'aberta'`, [obra_id])
    if (obraResult.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada ou não está disponível' })
    const existente = await pool.query(`SELECT id FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2`, [obra_id, req.usuario.id])
    if (existente.rows.length > 0) return res.status(409).json({ erro: 'Você já demonstrou interesse nesta obra' })
    const result = await pool.query(
      `INSERT INTO candidaturas (obra_id, usuario_id, referencias, valor_oferta, mensagem_oferta, status)
       VALUES ($1, $2, $3, $4, $5, 'pendente') RETURNING *`,
      [obra_id, req.usuario.id, referencias, valor_oferta || null, mensagem_oferta || null]
    )
    const dono = await pool.query(
      `SELECT u.push_token, o.titulo FROM obras o JOIN usuarios u ON o.criado_por = u.id WHERE o.id = $1`,
      [obra_id]
    )
    if (dono.rows[0]?.push_token) {
      const temOferta = valor_oferta && valor_oferta > 0
      await enviarPushNotificacao(
        dono.rows[0].push_token,
        temOferta ? '🎨 Nova contra-oferta recebida!' : '👀 Novo interesse na sua obra!',
        temOferta
          ? `Um pintor fez uma oferta de R$ ${Number(valor_oferta).toLocaleString('pt-BR')} para "${dono.rows[0].titulo}"`
          : `Um pintor demonstrou interesse em "${dono.rows[0].titulo}"`,
        { tipo: 'nova_candidatura', obra_id }
      )
    }
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('Erro ao candidatar:', err)
    res.status(500).json({ erro: 'Erro ao registrar candidatura' })
  }
})

router.get('/candidaturas/minhas',        autenticar, candidaturasCtrl.minhas)
router.get('/candidaturas/pendentes',     autenticar, exigirAdmin, candidaturasCtrl.pendentes)
router.get('/candidaturas/obra/:obra_id', autenticar, candidaturasCtrl.porObra)
router.post('/candidaturas/:id/aprovar',  autenticar, candidaturasCtrl.aprovar)
router.post('/candidaturas/:id/recusar',  autenticar, candidaturasCtrl.recusar)

router.post('/candidaturas/:id/negociar', autenticar, async (req, res) => {
  try {
    const { valor, mensagem } = req.body
    const { id } = req.params
    const candidatura = await pool.query(
      `SELECT c.*, o.criado_por as dono_id, o.titulo, u.push_token
       FROM candidaturas c JOIN obras o ON c.obra_id = o.id JOIN usuarios u ON c.usuario_id = u.id
       WHERE c.id = $1`, [id]
    )
    if (candidatura.rows.length === 0) return res.status(404).json({ erro: 'Candidatura não encontrada' })
    const cand = candidatura.rows[0]
    if (req.usuario.id !== cand.dono_id && req.usuario.id !== cand.usuario_id) return res.status(403).json({ erro: 'Sem permissão' })
    const negociacao = await pool.query(
      `INSERT INTO negociacoes (candidatura_id, autor_id, tipo, valor, mensagem) VALUES ($1, $2, 'contra_oferta', $3, $4) RETURNING *`,
      [id, req.usuario.id, valor, mensagem]
    )
    const ehDono = req.usuario.id === cand.dono_id
    if (!ehDono) {
      const donoResult = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [cand.dono_id])
      if (donoResult.rows[0]?.push_token) {
        await enviarPushNotificacao(donoResult.rows[0].push_token, '🎨 Nova contra-oferta!',
          `Um pintor propôs R$ ${Number(valor).toLocaleString('pt-BR')} para "${cand.titulo}"`,
          { tipo: 'contra_oferta', candidatura_id: id })
      }
    } else if (cand.push_token) {
      await enviarPushNotificacao(cand.push_token, '🎨 O dono fez uma contra-oferta!',
        `Nova proposta de R$ ${Number(valor).toLocaleString('pt-BR')} para "${cand.titulo}"`,
        { tipo: 'contra_oferta', candidatura_id: id })
    }
    res.status(201).json(negociacao.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar negociação' })
  }
})

router.get('/candidaturas/:id/negociacoes', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT n.*, u.nome as autor_nome, u.role as autor_role FROM negociacoes n
       JOIN usuarios u ON n.autor_id = u.id WHERE n.candidatura_id = $1 ORDER BY n.criado_em ASC`,
      [req.params.id]
    )
    res.json({ negociacoes: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar negociações' })
  }
})

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
router.post('/pagamentos/criar-assinatura',   autenticar, pagamentoCtrl.criarAssinatura)
router.post('/pagamentos/webhook',            pagamentoCtrl.webhook)
router.post('/pagamentos/webhook-pagbank',    pagamentoCtrl.webhookPagbank)
router.get('/pagamentos/sucesso',             pagamentoCtrl.sucesso)
router.get('/pagamentos/falha',               (req, res) => res.redirect('https://pinturapro-painel-production.up.railway.app'))
router.get('/pagamentos/pendente',            (req, res) => res.redirect('https://pinturapro-painel-production.up.railway.app'))
router.post('/pagamentos/acesso-gratuito',    autenticar, exigirAdmin, pagamentoCtrl.darAcessoGratuito)
router.get('/pagamentos/assinantes',          autenticar, exigirAdmin, pagamentoCtrl.listarAssinantes)

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

// Health check
router.get('/health', (req, res) => res.json({ status: 'ok', versao: '1.0.0' }))

module.exports = router