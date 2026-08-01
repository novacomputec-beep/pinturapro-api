const { pool } = require('../utils/supabase')
const { notificarNovaObra } = require('../services/notificacaoService')
const { ufDeCidade } = require('../utils/localidade')
const { resolverBusca, montarFiltroGeo } = require('../utils/geoBusca')

const listar = async (req, res) => {
  try {
    const { categoria, raio_km, lat, lng, page = 1, limit = 20 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let query = `
      SELECT o.id, o.titulo, o.categoria, o.valor, o.cidade, o.estado, o.bairro, o.uf,
             o.latitude, o.longitude, o.coordenadas_origem,
             o.metragem, o.prazo_execucao_dias, o.expira_em, o.tags, o.status,
             0 as distancia_metros,
             (SELECT COUNT(*) FROM midias WHERE obra_id = o.id) as total_midias,
             (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_candidaturas,
             (SELECT url FROM midias WHERE obra_id = o.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) as foto_capa
      FROM obras o
      WHERE o.status = 'aberta'
      AND o.status_aprovacao = 'aprovada'
      AND o.expira_em > NOW()
      AND o.match_usuario_id IS NULL
      -- Lista negra desta obra: pintor que já teve um match desfeito aqui não vê o card de
      -- novo. Mesma expressão do feed de reparos (index.js, GET /reparos). Fica na BASE do
      -- WHERE, antes de qualquer filtro dinâmico, para valer em todos os modos de busca.
      AND NOT ($1::uuid = ANY(COALESCE(o.prestadores_bloqueados, '{}')))
      AND NOT EXISTS (
        SELECT 1 FROM prestadores_bloqueados_dono pb
        WHERE pb.dono_id = o.criado_por AND pb.prestador_id = $1
      )
      -- Obra que este pintor já recusou não volta ao feed: o card ficava visível mas
      -- POST /obras/:id/candidatura rejeita com 409 (guarda de duplicidade), então era
      -- um card em que ele não podia mais agir. Fica na BASE do WHERE, antes de qualquer
      -- filtro dinâmico, para valer em todos os modos (cidade, raio, estado e sem
      -- recorte). Só 'recusado' — pendente/contraproposta_dono/aceito seguem iguais.
      AND NOT EXISTS (
        SELECT 1 FROM candidaturas c
        WHERE c.obra_id = o.id AND c.usuario_id = $1 AND c.status = 'recusado'
      )
    `
    // $1 reservado para o usuario_id (filtro de bloqueio global por dono)
    const params = [req.usuario.id]

    if (categoria && categoria !== 'todas') {
      params.push(categoria)
      query += ` AND o.categoria = $${params.length}`
    }

    // Mesmo resolvedor compartilhado de /reparos (geoBusca): âncora e escopo separados,
    // e nenhum caminho degrada para "país inteiro". 'estado' e 'pais' seguem inalterados.
    // Sem raio_km a busca não tem recorte (comportamento de hoje, preservado): o metadado
    // reporta 'pais' porque é o que de fato acontece — o app sempre envia raio_km.
    let filtroMeta = { modo: raio_km || null, aplicado: (!raio_km || raio_km === 'pais') ? 'pais' : raio_km, degradado: false, motivo: null }
    let escopo = null
    let ancora = null

    const modoGeo = (raio_km === 'cidade' && req.usuario?.id) ? 'cidade'
      : (raio_km && raio_km !== 'pais' && raio_km !== 'estado' && !isNaN(parseFloat(raio_km))) ? 'raio'
      : null

    if (modoGeo) {
      const busca = await resolverBusca({
        cidade_busca: req.query.cidade_busca,
        uf_busca: req.query.uf_busca,
        lat, lng,
        usuarioId: req.usuario?.id
      })
      escopo = busca.escopo
      ancora = busca.ancora
      const filtro = montarFiltroGeo({
        alias: 'o', modo: modoGeo, raio: parseFloat(raio_km), escopo, ancora, params
      })
      filtroMeta = filtro.meta
      if (filtro.sql === null) {
        return res.json({ obras: [], pagina: parseInt(page), total: 0, filtro: filtroMeta, escopo, ancora })
      }
      query += filtro.sql
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
    }

    query += ` ORDER BY o.expira_em ASC, o.valor DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(parseInt(limit), offset)

    const result = await pool.query(query, params)

    res.json({
      obras: result.rows,
      pagina: parseInt(page),
      total: result.rows.length,
      filtro: filtroMeta,
      escopo,
      ancora
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
    // Janela original resolvida UMA vez (default 48 aqui, não 720). Esta rota insere já como
    // 'aberta' — publica na hora —, então grava horas_para_expirar E publicado_em = NOW().
    const horasExpiracao = horas_para_expirar || 48
    const expira_em = new Date(Date.now() + horasExpiracao * 3600 * 1000)

    const result = await pool.query(
      `INSERT INTO obras (criado_por, titulo, categoria, valor, cidade, bairro, uf,
        latitude, longitude, metragem, prazo_execucao_dias, expira_em, descricao, tags, status, horas_para_expirar, publicado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'aberta',$15,NOW())
       RETURNING *`,
      [req.usuario.id, titulo, categoria, valor, cidade, bairro, ufFinal,
       latitude || null, longitude || null, metragem, prazo_execucao_dias,
       expira_em.toISOString(), descricao, tags || [], horasExpiracao]
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