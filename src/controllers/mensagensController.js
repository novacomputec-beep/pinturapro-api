const { pool } = require('../utils/supabase')
const { enviarEmail } = require('../services/emailService')

// POST /mensagens — pintor envia dúvida sobre uma obra
const enviar = async (req, res) => {
  try {
    const { obra_id, conteudo } = req.body

    if (!obra_id || !conteudo || !conteudo.trim()) {
      return res.status(400).json({ erro: 'obra_id e conteudo são obrigatórios' })
    }

    const obraResult = await pool.query(
      `SELECT id, titulo, criado_por FROM obras WHERE id = $1`,
      [obra_id]
    )
    if (obraResult.rows.length === 0) {
      return res.status(404).json({ erro: 'Obra não encontrada' })
    }
    const obra = obraResult.rows[0]

    // Só quem tem relação com a obra escreve no thread: o DONO, ou o profissional que já se
    // candidatou nela. Antes bastava a obra existir — qualquer assinante podia inserir
    // mensagem em qualquer obra_id. Vale QUALQUER status de candidatura (inclusive recusada):
    // quem participou da disputa continua podendo perguntar sobre o desfecho.
    if (obra.criado_por !== req.usuario.id) {
      const candidatura = await pool.query(
        `SELECT 1 FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2 LIMIT 1`,
        [obra_id, req.usuario.id]
      )
      if (candidatura.rowCount === 0) {
        return res.status(403).json({ erro: 'Sem permissão para enviar mensagem nesta obra' })
      }
    }

    const result = await pool.query(
      `INSERT INTO mensagens (obra_id, autor_id, conteudo) VALUES ($1, $2, $3) RETURNING *`,
      [obra_id, req.usuario.id, conteudo.trim()]
    )
    const mensagem = result.rows[0]

    res.status(201).json(mensagem)

    // Notifica a equipe de forma assíncrona
    enviarEmail({
      para: process.env.EMAIL_EQUIPE || process.env.SMTP_USER,
      assunto: `Nova dúvida sobre — ${obra.titulo}`,
      html: `
        <p><strong>Pintor:</strong> ${req.usuario.nome}</p>
        <p><strong>Obra:</strong> ${obra.titulo}</p>
        <p><strong>Dúvida:</strong> ${conteudo}</p>
        <p>Acesse o painel para responder.</p>
      `
    }).catch(err => console.error('Erro ao notificar equipe:', err))

  } catch (err) {
    console.error('Erro ao enviar mensagem:', err)
    res.status(500).json({ erro: 'Erro ao enviar mensagem' })
  }
}

// GET /mensagens/obra/:obra_id — dúvidas de uma obra (admin vê tudo, pintor vê só as suas)
const porObra = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1
    const limit  = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

    // Verifica se a obra existe
    const obraExiste = await pool.query(`SELECT id FROM obras WHERE id = $1`, [req.params.obra_id])
    if (obraExiste.rows.length === 0) {
      return res.status(404).json({ erro: 'Obra não encontrada' })
    }

    let query
    let params

    // Admin vê o thread inteiro da obra; qualquer outro usuário vê SOMENTE as mensagens que
    // ele mesmo escreveu (autor_id = req.usuario.id).
    // O recorte antes dependia de role === 'assinante' — valor que nenhum usuário real tem
    // (o cadastro grava 'dono_obra', 'prestador' ou 'admin'; 'assinante' é só o inicializador
    // sobrescrito em authController). Com isso TODO usuário autenticado caía no ramo aberto e
    // lia o thread alheio de qualquer obra_id. Agora o ramo restrito é o default e só admin
    // escapa dele.
    if (req.usuario.role === 'admin') {
      query = `
        SELECT m.id, m.conteudo, m.resposta, m.respondido, m.criado_em, m.respondido_em,
               u.id as usuario_id, u.nome as usuario_nome
        FROM mensagens m
        JOIN usuarios u ON m.autor_id = u.id
        WHERE m.obra_id = $1
        ORDER BY m.criado_em ASC
        LIMIT $2 OFFSET $3`
      params = [req.params.obra_id, limit, offset]
    } else {
      query = `
        SELECT m.id, m.conteudo, m.resposta, m.respondido, m.criado_em, m.respondido_em,
               u.id as usuario_id, u.nome as usuario_nome
        FROM mensagens m
        JOIN usuarios u ON m.autor_id = u.id
        WHERE m.obra_id = $1 AND m.autor_id = $2
        ORDER BY m.criado_em ASC
        LIMIT $3 OFFSET $4`
      params = [req.params.obra_id, req.usuario.id, limit, offset]
    }

    const result = await pool.query(query, params)
    res.json({ mensagens: result.rows, page, limit })

  } catch (err) {
    console.error('Erro ao buscar mensagens:', err)
    res.status(500).json({ erro: 'Erro ao buscar mensagens' })
  }
}

// GET /mensagens/pendentes — sem resposta (admin)
const pendentes = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1
    const limit  = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

    const result = await pool.query(
      `SELECT m.id, m.conteudo, m.criado_em,
              o.id as obra_id, o.titulo as obra_titulo,
              u.id as usuario_id, u.nome as usuario_nome, u.email as usuario_email
       FROM mensagens m
       JOIN obras o ON m.obra_id = o.id
       JOIN usuarios u ON m.autor_id = u.id
       WHERE m.respondido = false
       ORDER BY m.criado_em ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    res.json({ mensagens: result.rows, page, limit })

  } catch (err) {
    console.error('Erro ao buscar mensagens pendentes:', err)
    res.status(500).json({ erro: 'Erro ao buscar mensagens pendentes' })
  }
}

// POST /mensagens/:id/responder — equipe responde (admin)
const responder = async (req, res) => {
  try {
    const { resposta } = req.body
    const { id } = req.params

    if (!resposta || !resposta.trim()) {
      return res.status(400).json({ erro: 'Resposta é obrigatória' })
    }

    // Verifica se a mensagem existe e não foi respondida ainda
    const existe = await pool.query(`SELECT id, respondido FROM mensagens WHERE id = $1`, [id])
    if (existe.rows.length === 0) {
      return res.status(404).json({ erro: 'Mensagem não encontrada' })
    }
    if (existe.rows[0].respondido) {
      return res.status(400).json({ erro: 'Mensagem já foi respondida' })
    }

    const result = await pool.query(
      `UPDATE mensagens
       SET resposta = $1, respondido = true, respondido_por = $2, respondido_em = NOW()
       WHERE id = $3
       RETURNING id, conteudo, resposta, respondido_em`,
      [resposta.trim(), req.usuario.id, id]
    )
    const mensagem = result.rows[0]

    // Busca dados do autor e obra para o e-mail
    const dadosResult = await pool.query(
      `SELECT u.nome, u.email, o.titulo
       FROM mensagens m
       JOIN usuarios u ON m.autor_id = u.id
       JOIN obras o ON m.obra_id = o.id
       WHERE m.id = $1`,
      [id]
    )
    const dados = dadosResult.rows[0]

    res.json(mensagem)

    // Notifica o pintor de forma assíncrona
    if (dados?.email) {
      enviarEmail({
        para: dados.email,
        assunto: `Sua dúvida sobre "${dados.titulo}" foi respondida`,
        html: `
          <p>Olá, <strong>${dados.nome}</strong>!</p>
          <p><strong>Sua dúvida:</strong> ${mensagem.conteudo}</p>
          <p><strong>Resposta da equipe:</strong> ${resposta}</p>
        `
      }).catch(err => console.error('Erro ao notificar pintor:', err))
    }

  } catch (err) {
    console.error('Erro ao responder mensagem:', err)
    res.status(500).json({ erro: 'Erro ao responder mensagem' })
  }
}

module.exports = { enviar, porObra, pendentes, responder }