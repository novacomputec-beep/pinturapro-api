const supabase = require('../utils/supabase')

// GET /obras — lista obras com filtro de raio e categoria
const listar = async (req, res) => {
  try {
    const {
      latitude,
      longitude,
      raio_km = 50,       // padrão 50km
      categoria,
      page = 1,
      limit = 20
    } = req.query

    const raio_metros = parseFloat(raio_km) * 1000
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let obras = []

    // Se passou coordenadas, usa a função PostGIS de raio
    if (latitude && longitude) {
      const { data, error } = await supabase.rpc('obras_por_raio', {
        lat: parseFloat(latitude),
        lng: parseFloat(longitude),
        raio_metros
      })

      if (error) throw error

      obras = data

      // Filtra por categoria se informada
      if (categoria && categoria !== 'todas') {
        obras = obras.filter(o => o.categoria === categoria)
      }

    } else {
      // Sem coordenadas: retorna todas as obras abertas
      let query = supabase
        .from('obras')
        .select('id, titulo, categoria, valor, cidade, bairro, metragem, prazo_execucao_dias, expira_em, tags, status')
        .eq('status', 'aberta')
        .gt('expira_em', new Date().toISOString())
        .order('criado_em', { ascending: false })

      if (categoria && categoria !== 'todas') {
        query = query.eq('categoria', categoria)
      }

      const { data, error } = await query.range(offset, offset + parseInt(limit) - 1)
      if (error) throw error
      obras = data
    }

    // Adiciona contagem de mídias e candidaturas para cada obra
    const obrasEnriquecidas = await Promise.all(
      obras.slice(offset, offset + parseInt(limit)).map(async (obra) => {
        const [{ count: totalMidias }, { count: totalCandidaturas }] = await Promise.all([
          supabase.from('midias').select('*', { count: 'exact', head: true }).eq('obra_id', obra.id),
          supabase.from('candidaturas').select('*', { count: 'exact', head: true }).eq('obra_id', obra.id)
        ])
        return { ...obra, total_midias: totalMidias, total_candidaturas: totalCandidaturas }
      })
    )

    res.json({
      obras: obrasEnriquecidas,
      pagina: parseInt(page),
      total: obras.length
    })

  } catch (err) {
    console.error('Erro ao listar obras:', err)
    res.status(500).json({ erro: 'Erro ao buscar obras' })
  }
}

// GET /obras/:id — detalhe completo da obra
const detalhe = async (req, res) => {
  try {
    const { id } = req.params

    const { data: obra, error } = await supabase
      .from('obras')
      .select('*')
      .eq('id', id)
      .eq('status', 'aberta')
      .single()

    if (error || !obra) {
      return res.status(404).json({ erro: 'Obra não encontrada' })
    }

    // Gera URLs assinadas para as mídias (expiram em 1 hora — proteção contra compartilhamento)
    const { data: midias } = await supabase
      .from('midias')
      .select('id, tipo, url, url_thumbnail, ordem')
      .eq('obra_id', id)
      .order('ordem')

    const midiasComUrl = await Promise.all(
      (midias || []).map(async (midia) => {
        const { data: urlAssinada } = await supabase.storage
          .from('obras-midias')
          .createSignedUrl(midia.url, 3600) // expira em 1h

        return {
          ...midia,
          url_assinada: urlAssinada?.signedUrl || null
        }
      })
    )

    // Verifica se o usuário já se candidatou
    const { data: candidatura } = await supabase
      .from('candidaturas')
      .select('id, status')
      .eq('obra_id', id)
      .eq('usuario_id', req.usuario.id)
      .single()

    res.json({
      obra,
      midias: midiasComUrl,
      minha_candidatura: candidatura || null
    })

  } catch (err) {
    console.error('Erro ao buscar obra:', err)
    res.status(500).json({ erro: 'Erro ao buscar obra' })
  }
}

// POST /obras — cadastrar nova obra (admin)
const criar = async (req, res) => {
  try {
    const {
      titulo, categoria, valor, cidade, bairro,
      latitude, longitude, metragem,
      prazo_execucao_dias, horas_para_expirar,
      descricao, tags
    } = req.body

    const expira_em = new Date(Date.now() + (horas_para_expirar || 48) * 3600 * 1000)

    const { data: obra, error } = await supabase
      .from('obras')
      .insert({
        criado_por: req.usuario.id,
        titulo, categoria, valor, cidade, bairro,
        latitude, longitude, metragem,
        prazo_execucao_dias,
        expira_em: expira_em.toISOString(),
        descricao,
        tags: tags || [],
        status: 'aberta'
      })
      .select()
      .single()

    if (error) throw error

    res.status(201).json(obra)

  } catch (err) {
    console.error('Erro ao criar obra:', err)
    res.status(500).json({ erro: 'Erro ao criar obra' })
  }
}

// PUT /obras/:id — editar obra (admin)
const editar = async (req, res) => {
  try {
    const campos = ['titulo', 'categoria', 'valor', 'cidade', 'bairro',
                    'metragem', 'prazo_execucao_dias', 'descricao', 'tags', 'status']
    const atualizacao = {}
    campos.forEach(c => { if (req.body[c] !== undefined) atualizacao[c] = req.body[c] })

    const { data, error } = await supabase
      .from('obras')
      .update(atualizacao)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao editar obra' })
  }
}

// DELETE /obras/:id — encerrar/cancelar obra (admin)
const encerrar = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('obras')
      .update({ status: 'encerrada' })
      .eq('id', req.params.id)
      .select('id, titulo, status')
      .single()

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao encerrar obra' })
  }
}

module.exports = { listar, detalhe, criar, editar, encerrar }
