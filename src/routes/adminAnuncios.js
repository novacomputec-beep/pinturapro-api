// Pedido que parece anúncio (utils/suspeitaAnuncio) — ação do painel, só super-admin.
const express = require('express')
const router = express.Router()
const { autenticar, exigirSuperAdmin } = require('../middlewares/auth')
const A = require('../utils/suspeitaAnuncio')

// POST /admin/demandas/:tipo/:id/marcar-anuncio (tipo = reparo | obra) — tira o pedido do ar
// (status 'cancelada', cancelada_por 'admin', anuncio_em), põe na fila do robô de WhatsApp o aviso
// ao dono do pedido e conta uma ocorrência; a 3ª da pessoa em 90 dias bloqueia a publicação por 7
// dias (utils/penalidadesAuto). Pedido com profissional escolhido → 409 MATCH_ATIVO; já marcado →
// 409 JA_MARCADO. Devolve { whatsapp: 'fila' | motivo de não ter entrado, ocorrencias, penalidade }.
router.post('/admin/demandas/:tipo/:id/marcar-anuncio', autenticar, exigirSuperAdmin, async (req, res) => {
  try {
    const r = await A.marcarComoAnuncio({ tipo: req.params.tipo, id: req.params.id, adminId: req.usuario?.id })
    if (!r.ok) return res.status(r.status).json({ erro: r.erro, ...(r.codigo ? { codigo: r.codigo } : {}) })
    const { ok, ...corpo } = r
    res.json({ ...corpo, mensagem: r.penalidade === 'suspenso' ? 'Pedido tirado do ar. Foi a 3ª ocorrência: publicação bloqueada por 7 dias.' : 'Pedido tirado do ar.' })
  } catch (err) {
    console.error('[admin/marcar-anuncio]', err.message)
    res.status(500).json({ erro: 'Erro ao marcar o pedido como anúncio' })
  }
})

module.exports = router
