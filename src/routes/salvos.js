// Pedidos salvos (utils/demandasSalvas) — do profissional.
const express = require('express')
const router = express.Router()
const { autenticar } = require('../middlewares/auth')
const S = require('../utils/demandasSalvas')

const soProfissional = (req, res, next) =>
  (req.usuario?.role === 'prestador' || req.usuario?.role === 'admin' ? next() : res.status(403).json({ erro: 'Apenas profissionais podem salvar pedidos' }))

// POST /salvos { tipo: 'reparo' | 'obra', demanda_id } — alterna: salva se não estava salvo, tira
// se estava. Devolve { tipo, demanda_id, salvo }.
router.post('/salvos', autenticar, soProfissional, async (req, res) => {
  try {
    const { tipo, demanda_id } = req.body || {}
    const r = await S.alternarSalvo(req.usuario.id, tipo, demanda_id)
    if (!r.ok) return res.status(r.status).json({ erro: r.erro })
    res.json({ tipo, demanda_id, salvo: r.salvo })
  } catch (err) {
    console.error('[salvos POST]', err.message)
    res.status(500).json({ erro: 'Erro ao salvar o pedido' })
  }
})

// GET /salvos?page=&limit= — os pedidos que a conta salvou, do mais recente para o mais antigo:
// { salvos: [{ tipo, id, codigo_publico, titulo, categoria, categorias, valor, valor_a_combinar,
//   cidade, bairro, uf, status, expira_em, aberta, foto_capa, salvo_em, salvo: true }], page, limit }.
router.get('/salvos', autenticar, soProfissional, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 100)
    const page = Math.max(parseInt(req.query?.page, 10) || 1, 1)
    res.json({ salvos: await S.listarSalvos(req.usuario.id, { limit, offset: (page - 1) * limit }), page, limit })
  } catch (err) {
    console.error('[salvos GET]', err.message)
    res.status(500).json({ erro: 'Erro ao buscar os pedidos salvos' })
  }
})

module.exports = router
