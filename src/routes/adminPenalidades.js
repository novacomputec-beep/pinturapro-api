// Penalidades automáticas (utils/penalidadesAuto) — só super-admin.
const express = require('express')
const router = express.Router()
const { autenticar, exigirSuperAdmin } = require('../middlewares/auth')
const P = require('../utils/penalidadesAuto')

// GET /admin/penalidades — penalidades EM VIGOR: { pessoa (nome, e-mail), lado: profissional |
// cliente, status: em_observacao | suspenso, desde, ate, motivo (as 3 avaliações ou as 3 denúncias) }.
router.get('/admin/penalidades', autenticar, exigirSuperAdmin, async (req, res) => {
  try {
    const penalidades = await P.listarPenalidades()
    res.json({
      regra: { notas_na_media: P.NOTAS_NA_MEDIA, media_maxima: P.MEDIA_MAXIMA, denuncias: P.DENUNCIAS_PARA_SUSPENDER, janela_denuncias_dias: P.JANELA_DENUNCIAS_DIAS, dias_suspensao: P.DIAS_SUSPENSAO },
      total: penalidades.length,
      penalidades,
    })
  } catch (err) {
    console.error('[admin/penalidades]', err.message)
    res.status(500).json({ erro: 'Erro ao listar penalidades' })
  }
})

// POST /admin/penalidades/:id/tirar-observacao e …/desfazer-suspensao — encerra a penalidade
// (id da lista acima). Nenhuma mensagem vai ao usuário; a contagem dele recomeça daqui.
const encerrar = (tipo, rotulo) => async (req, res) => {
  try {
    const r = await P.encerrarPeloAdmin(req.params.id, tipo, req.usuario?.id)
    if (!r.ok) return res.status(r.status).json({ erro: r.erro })
    res.json({ id: r.id, usuario_id: r.usuario_id, lado: r.lado, mensagem: tipo === 'observacao' ? 'Observação tirada.' : 'Suspensão desfeita.' })
  } catch (err) {
    console.error(`[admin/penalidades/${rotulo}]`, err.message)
    res.status(500).json({ erro: 'Erro ao encerrar a penalidade' })
  }
}
router.post('/admin/penalidades/:id/tirar-observacao', autenticar, exigirSuperAdmin, encerrar('observacao', 'tirar-observacao'))
router.post('/admin/penalidades/:id/desfazer-suspensao', autenticar, exigirSuperAdmin, encerrar('suspensao', 'desfazer-suspensao'))

module.exports = router
