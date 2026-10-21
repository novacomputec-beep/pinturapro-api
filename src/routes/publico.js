// Rotas públicas (sem JWT) sob /api/publico — só leitura, só o mínimo.
//
// GET /api/publico/demanda/:codigo → { tipo: 'reparo' | 'obra', id } para um codigo_publico que
// existe (reparos ou obras, aberta ou não); 404 { erro } para código malformado ou inexistente.
// Nenhum outro campo sai daqui: quem quiser detalhes passa pela página pública (/p/<codigo>, que
// também só mostra o que é público) ou pelo app autenticado. Mesma validação RE_CODIGO da página
// (5 caracteres do alfabeto sem ambiguidade, case-insensitive) e o mesmo limite de requisições:
// o limiter global de server.js (por IP), que cobre /api e /p igualmente — sem balde extra.
const express = require('express')
const { pool } = require('../utils/supabase')
const { RE_CODIGO } = require('./paginaPublica')
const { lerVideoComoFunciona } = require('../utils/videoComoFunciona')

const router = express.Router()

// GET /api/publico/video-como-funciona → { video_id, capitulos: [{ seg, titulo }] }. Sem JWT:
// é a tela "Como funciona" antes do login. video_id '' = sem vídeo publicado. Quem grava é o
// admin (PUT /api/admin/video-como-funciona). Cache curto: muda raramente, mas o admin quer
// ver a troca sem esperar.
router.get('/video-como-funciona', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60')
  try {
    return res.json(await lerVideoComoFunciona(pool))
  } catch (err) {
    console.error('[Publico] erro em /video-como-funciona:', err.message)
    return res.status(500).json({ erro: 'Erro ao carregar o vídeo' })
  }
})

// Código único entre as duas tabelas por construção (gerar_codigo_publico), então a primeira
// que responder é a resposta. Só o id — nada de título, cidade ou status.
const LADOS = [
  { tabela: 'reparos', tipo: 'reparo' },
  { tabela: 'obras',   tipo: 'obra' },
]
const localizarDemanda = async (codigo) => {
  for (const lado of LADOS) {
    const r = await pool.query(`SELECT id FROM ${lado.tabela} WHERE codigo_publico = $1`, [codigo])
    if (r.rows.length > 0) return { tipo: lado.tipo, id: r.rows[0].id }
  }
  return null
}

router.get('/demanda/:codigo', async (req, res) => {
  const codigo = String(req.params.codigo || '').trim().toUpperCase()
  res.set('Cache-Control', 'no-cache')
  if (!RE_CODIGO.test(codigo)) return res.status(404).json({ erro: 'Código não encontrado' })
  try {
    const achado = await localizarDemanda(codigo)
    if (!achado) return res.status(404).json({ erro: 'Código não encontrado' })
    return res.json(achado)
  } catch (err) {
    console.error(`[Publico] erro em /demanda/${codigo}:`, err.message)
    return res.status(500).json({ erro: 'Erro ao localizar o pedido' })
  }
})

module.exports = router
