const { pool } = require('../utils/supabase')
const { notificarNovaObra } = require('../services/notificacaoService')
const { ufDeCidade } = require('../utils/localidade')

const listar = async (req, res) => {
  try {
    const { categoria, raio_km, lat, lng, page = 1, limit = 20 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let query = `
      SELECT o.id, o.titulo, o.categoria, o.valor, o.cidade, o.estado, o.bairro, o.uf,
             o.latitude, o.longitude,
             o.metragem, o.prazo_execucao_dias, o.expira_em, o.tags, o.status,
             0 as distancia_metros,
             (SELECT COUNT(*) FROM midias WHERE obra_id = o.id) as total_midias,
             (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_candidaturas,
             (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) as foto_capa
      FROM obras o
      WHERE o.status = 'aberta'
      AND o.status_aprovacao = 'aprovada'
      AND o.expira_em > NOW()
      AND o.match_usuario_id IS NULL
    `
    const params = []

    if (categoria && categoria !== 'todas') {
      params.push(categoria)
      query += ` AND o.categoria = $${params.length}`
    }

    if (raio_km === 'cidade' && req.usuario?.id) {
      let cidade = (req.query.cidade_busca || '').trim()
      if (!cidade) {
        const cidadeResult = await pool.query(`SELECT cidade FROM usuarios WHERE id = $1`, [req.usuario.id])
        cidade = cidadeResult.rows[0]?.cidade
      }
      if (cidade) {
        params.push(cidade)
        query += ` AND o.cidade = $${params.length}`
      }
    } else if (raio_km === 'estado' && req.usuario?.id) {
      let uf = (req.query.uf_busca || '').trim()
      if (!uf) {
        const ufResult = await pool.query(`SELECT uf FROM usuarios WHERE id = $1`, [req.usuario.id])
        uf = ufResult.rows[0]?.uf
      }
      if (uf) {
        params.push(uf)
        query += ` AND o.uf = $${params.length}`
      }
    } else if (raio_km && raio_km !== 'pais' && lat && lng) {
      const raio = parseFloat(raio_km)
      const latNum = parseFloat(lat)
      const lngNum = parseFloat(lng)
      if (!isNaN(raio) && !isNaN(latNum) && !isNaN(lngNum)) {
        // Raio cumulativo: inclui obras dentro de X km (com coordenadas) OU da cidade do
        // usuário (mesmo sem coordenadas geocodificadas — "sem lat/lng" não pode significar "invisível")
        const cidadeResult = req.usuario?.id
          ? await pool.query(`SELECT cidade FROM usuarios WHERE id = $1`, [req.usuario.id])
          : { rows: [] }
        const cidade = cidadeResult.rows[0]?.cidade
        // Pré-filtro por bounding box (sargável → usa o índice btree (latitude, longitude))
        // antes do haversine exato por linha. A caixa é um superconjunto do círculo de raio
        // R (usa cos na latitude da borda mais próxima do polo), então não há falsos negativos:
        // o haversine continua sendo o filtro exato.
        const KM_POR_GRAU = 111.045
        const latDelta = raio / KM_POR_GRAU
        const cosBorda = Math.cos(Math.min(89.9, Math.abs(latNum) + latDelta) * Math.PI / 180)
        const lngDelta = cosBorda > 0.0001 ? raio / (KM_POR_GRAU * cosBorda) : 180
        const latMin = latNum - latDelta
        const latMax = latNum + latDelta
        const lngMin = Math.max(-180, lngNum - lngDelta)
        const lngMax = Math.min(180, lngNum + lngDelta)
        const latIdx = params.length + 1
        const lngIdx = params.length + 2
        const raioIdx = params.length + 3
        const latMinIdx = params.length + 4
        const latMaxIdx = params.length + 5
        const lngMinIdx = params.length + 6
        const lngMaxIdx = params.length + 7
        params.push(latNum, lngNum, raio, latMin, latMax, lngMin, lngMax)
        let condicao = `(o.latitude IS NOT NULL AND o.longitude IS NOT NULL
          AND o.latitude BETWEEN $${latMinIdx} AND $${latMaxIdx}
          AND o.longitude BETWEEN $${lngMinIdx} AND $${lngMaxIdx}
          AND (6371 * acos(LEAST(1.0, cos(radians($${latIdx})) * cos(radians(o.latitude::float)) * cos(radians(o.longitude::float) - radians($${lngIdx})) + sin(radians($${latIdx})) * sin(radians(o.latitude::float))))) <= $${raioIdx})`
        if (cidade) {
          params.push(cidade)
          condicao = `(${condicao} OR o.cidade = $${params.length})`
        }
        query += ` AND ${condicao}`
      }
    }

    query += ` ORDER BY o.expira_em ASC, o.valor DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(parseInt(limit), offset)

    const result = await pool.query(query, params)

    res.json({
      obras: result.rows,
      pagina: parseInt(page),
      total: result.rows.length
    })

  } catch (err) {
    console.error('Erro ao listar obras:', err)
    res.status(500).json({ erro: 'Erro ao buscar obras' })
  }
}

const detalhe = async (req, res) => {
  try {
    const { id } = req.params

    const result = await pool.query(
      `SELECT * FROM obras WHERE id = $1 AND status = 'aberta'`,
      [id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Obra não encontrada' })
    }

    const obra = result.rows[0]

    const midiasResult = await pool.query(
      `SELECT id, tipo, url, url_thumbnail, ordem FROM midias WHERE obra_id = $1 ORDER BY ordem`,
      [id]
    )

    const candidaturaResult = await pool.query(
      `SELECT id, status FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2`,
      [id, req.usuario.id]
    )

    res.json({
      obra,
      midias: midiasResult.rows.map(m => ({ ...m, url_assinada: m.url })),
      minha_candidatura: candidaturaResult.rows[0] || null
    })

  } catch (err) {
    console.error('Erro ao buscar obra:', err)
    res.status(500).json({ erro: 'Erro ao buscar obra' })
  }
}

const criar = async (req, res) => {
  try {
    const {
      titulo, categoria, valor, cidade, bairro, uf,
      latitude, longitude, metragem,
      prazo_execucao_dias, horas_para_expirar,
      descricao, tags
    } = req.body

    // Validações básicas
    if (!titulo || !categoria || !valor || !cidade) {
      return res.status(400).json({ erro: 'Título, categoria, valor e cidade são obrigatórios' })
    }
    if (isNaN(parseFloat(valor)) || parseFloat(valor) <= 0) {
      return res.status(400).json({ erro: 'Valor inválido' })
    }

    // Rede de segurança: deriva o uf da cidade quando o cliente não envia
    const ufFinal = uf || await ufDeCidade(cidade)
    const expira_em = new Date(Date.now() + (horas_para_expirar || 48) * 3600 * 1000)

    const result = await pool.query(
      `INSERT INTO obras (criado_por, titulo, categoria, valor, cidade, bairro, uf,
        latitude, longitude, metragem, prazo_execucao_dias, expira_em, descricao, tags, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'aberta')
       RETURNING *`,
      [req.usuario.id, titulo, categoria, valor, cidade, bairro, ufFinal,
       latitude || null, longitude || null, metragem, prazo_execucao_dias,
       expira_em.toISOString(), descricao, tags || []]
    )

    const obra = result.rows[0]

    // Notifica todos os pintores sobre a nova obra de forma assíncrona
    notificarNovaObra(pool, obra).catch(err =>
      console.error('Erro ao enviar notificações:', err)
    )

    res.status(201).json(obra)

  } catch (err) {
    console.error('Erro ao criar obra:', err)
    res.status(500).json({ erro: 'Erro ao criar obra' })
  }
}

const editar = async (req, res) => {
  try {
    const { titulo, categoria, valor, cidade, bairro, uf, metragem, prazo_execucao_dias, descricao, tags, status } = req.body

    // Verifica se a obra existe antes de editar
    const existe = await pool.query(`SELECT id FROM obras WHERE id = $1`, [req.params.id])
    if (existe.rows.length === 0) {
      return res.status(404).json({ erro: 'Obra não encontrada' })
    }

    // Impede status inválidos
    const statusPermitidos = ['aberta', 'encerrada', 'cancelada', 'rascunho']
    if (status && !statusPermitidos.includes(status)) {
      return res.status(400).json({ erro: 'Status inválido' })
    }

    // Rede de segurança: deriva o uf da cidade quando o cliente não envia
    const ufFinal = uf || await ufDeCidade(cidade)
    const result = await pool.query(
      `UPDATE obras SET titulo=$1, categoria=$2, valor=$3, cidade=$4, bairro=$5, uf=$6,
       metragem=$7, prazo_execucao_dias=$8, descricao=$9, tags=$10, status=$11
       WHERE id=$12 RETURNING *`,
      [titulo, categoria, valor, cidade, bairro, ufFinal, metragem, prazo_execucao_dias, descricao, tags, status, req.params.id]
    )

    res.json(result.rows[0])
  } catch (err) {
    console.error('Erro ao editar obra:', err)
    res.status(500).json({ erro: 'Erro ao editar obra' })
  }
}

const encerrar = async (req, res) => {
  try {
    // Verifica se a obra existe antes de encerrar
    const existe = await pool.query(`SELECT id FROM obras WHERE id = $1`, [req.params.id])
    if (existe.rows.length === 0) {
      return res.status(404).json({ erro: 'Obra não encontrada' })
    }

    const result = await pool.query(
      `UPDATE obras SET status='encerrada' WHERE id=$1 RETURNING id, titulo, status`,
      [req.params.id]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('Erro ao encerrar obra:', err)
    res.status(500).json({ erro: 'Erro ao encerrar obra' })
  }
}

module.exports = { listar, detalhe, criar, editar, encerrar }