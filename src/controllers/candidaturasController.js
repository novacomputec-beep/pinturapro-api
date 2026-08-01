const { pool } = require('../utils/supabase')
const { enviarContratoObra } = require('./contratosController')
const { rejeitarConcorrentes } = require('../utils/rejeitarConcorrentes')
const { enviarPushNotificacao } = require('../services/alertaService')

const minhas = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1
    const limit  = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

    const result = await pool.query(
      `SELECT c.id, c.status, c.criado_em, c.valor_contraproposta, c.valor_proposto,
              o.id as obra_id, o.titulo, o.categoria, o.valor, o.cidade, o.status as obra_status,
              o.match_usuario_id, o.match_feito_em,
              -- Encerramento em duas mãos: o lado do pintor precisa saber se há solicitação
              -- pendente e quem pediu (_por = próprio usuário → aguardando o dono; _por = dono
              -- → cabe ao pintor confirmar). NULL = nenhuma solicitação em aberto.
              o.encerramento_solicitado_por, o.encerramento_solicitado_em,
              -- Chegada: o pintor precisa ver a janela que ele mesmo prometeu e se o dono já
              -- confirmou a chegada (declarada por ele + confirmada = atendimento em curso).
              o.chegada_janela, o.chegada_prevista_em, o.chegada_declarada_por,
              o.chegada_declarada_em, o.chegada_confirmada_em
       FROM candidaturas c
       JOIN obras o ON c.obra_id = o.id
       WHERE c.usuario_id = $1
       ORDER BY c.criado_em DESC
       LIMIT $2 OFFSET $3`,
      [req.usuario.id, limit, offset]
    )
    res.json({ candidaturas: result.rows, page, limit })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar candidaturas' })
  }
}

const porObra = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1
    const limit  = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

    const obraExiste = await pool.query(`SELECT id, criado_por FROM obras WHERE id = $1`, [req.params.obra_id])
    if (obraExiste.rows.length === 0) {
      return res.status(404).json({ erro: 'Obra não encontrada' })
    }
    if (obraExiste.rows[0].criado_por !== req.usuario.id && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Sem permissão para esta ação' })
    }

    const result = await pool.query(
      // telefone é sempre NULL aqui de propósito: o contato do pintor só é revelado
      // ao dono APÓS o match, nunca no aceite (regra de negócio — ver GET /obras/:id).
      // Não ligar esta coluna a c.status: reintroduziria o vazamento corrigido em 4fbdab1.
      `SELECT c.id, c.status, c.referencias, c.valor_oferta, c.mensagem_oferta, c.criado_em,
              u.id as usuario_id, u.nome, u.email,
              NULL as telefone,
              u.cidade, u.anos_experiencia, u.tamanho_equipe, u.especialidades,
              (SELECT COUNT(*)::int FROM avaliacoes a WHERE a.avaliado_id = u.id) AS avaliacoes_total,
              (SELECT COALESCE(ROUND(AVG(a.estrelas)::numeric, 1), 0) FROM avaliacoes a WHERE a.avaliado_id = u.id) AS avaliacoes_media
       FROM candidaturas c
       JOIN usuarios u ON c.usuario_id = u.id
       WHERE c.obra_id = $1
       ORDER BY c.criado_em ASC
       LIMIT $2 OFFSET $3`,
      [req.params.obra_id, limit, offset]
    )
    res.json({ candidaturas: result.rows, page, limit })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar candidaturas' })
  }
}

const pendentes = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1
    const limit  = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

    const result = await pool.query(
      `SELECT c.id, c.status, c.referencias, c.criado_em,
              o.id as obra_id, o.titulo, o.categoria, o.valor, o.cidade,
              u.id as pintor_id, u.nome as pintor_nome, u.email as pintor_email,
              u.telefone, u.cidade as pintor_cidade, u.anos_experiencia, u.tamanho_equipe
       FROM candidaturas c
       JOIN obras o ON c.obra_id = o.id
       JOIN usuarios u ON c.usuario_id = u.id
       WHERE c.status = 'pendente'
       ORDER BY c.criado_em ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    res.json({ candidaturas: result.rows, page, limit })
  } catch (err) {
    console.error('Erro ao buscar candidaturas pendentes:', err)
    res.status(500).json({ erro: 'Erro ao buscar candidaturas pendentes' })
  }
}

const aprovar = async (req, res) => {
  try {
    const { id } = req.params

    const existe = await pool.query(`SELECT id, status, obra_id FROM candidaturas WHERE id = $1`, [id])
    if (existe.rows.length === 0) {
      return res.status(404).json({ erro: 'Candidatura não encontrada' })
    }

    // titulo entra aqui para compor o push "Deu match!" no fim da função, sem query extra.
    const obraCheck = await pool.query(
      `SELECT criado_por, titulo FROM obras WHERE id = $1`,
      [existe.rows[0].obra_id]
    )
    if (
      obraCheck.rows.length === 0 ||
      (obraCheck.rows[0].criado_por !== req.usuario.id && req.usuario.role !== 'admin')
    ) {
      return res.status(403).json({ erro: 'Sem permissão para esta ação' })
    }

    if (existe.rows[0].status !== 'pendente') {
      return res.status(400).json({ erro: 'Candidatura já foi processada' })
    }

    const jaAceito = await pool.query(
      `SELECT id FROM candidaturas WHERE obra_id = $1 AND status = 'aceito' AND id != $2`,
      [existe.rows[0].obra_id, id]
    )
    if (jaAceito.rows.length > 0) {
      return res.status(409).json({ erro: 'Já existe um candidato aceito para esta obra' })
    }

    const result = await pool.query(
      `UPDATE candidaturas SET status = 'aceito', aprovado_por = $1
       WHERE id = $2 RETURNING *`,
      [req.usuario.id, id]
    )

    // O aceite já casa o profissional com a obra. usuario_id/obra_id saem do RETURNING *
    // acima, então não é preciso alargar o SELECT de `existe`. Guard match_usuario_id IS
    // NULL: idempotente em retry e impede que um segundo aceite roube um match existente.
    await pool.query(
      `UPDATE obras SET match_usuario_id = $1, match_feito_em = NOW()
       WHERE id = $2 AND match_usuario_id IS NULL`,
      [result.rows[0].usuario_id, result.rows[0].obra_id]
    )

    // Token do aprovado, buscado antes da resposta para o push logo abaixo não precisar de
    // await depois do res.json (throw pós-resposta cairia no catch e tentaria responder 2x).
    const vencedor = await pool.query(
      `SELECT push_token FROM usuarios WHERE id = $1`,
      [result.rows[0].usuario_id]
    )

    res.json(result.rows[0])

    // Push "Deu match!" para o profissional aprovado — paridade com os outros quatro
    // caminhos de aceite, que sempre notificam a contraparte. Este endpoint não notificava
    // ninguém. Mesmo título, texto e payload usados em .../responder.
    if (vencedor.rows[0]?.push_token) {
      enviarPushNotificacao(vencedor.rows[0].push_token, '🎉 Deu match!',
        `Parabéns! Você fechou negócio em "${obraCheck.rows[0].titulo}"! Toque para ver os detalhes.`,
        { tipo: 'candidatura_aceita', obra_id: result.rows[0].obra_id }).catch(() => {})
    }

    // Envia contrato por e-mail de forma assíncrona sem bloquear a resposta
    enviarContratoObra(id).catch(err =>
      console.error('Erro ao enviar contrato de obra:', err)
    )

    // Recusa os demais candidatos e os notifica (antes só o /match fazia isso, e hoje ele
    // sai no early-return idempotente). Este endpoint nunca enviou push nenhum; agora ao
    // menos os perdedores são avisados. Assíncrono, como o contrato acima.
    rejeitarConcorrentes('obra', result.rows[0].obra_id, result.rows[0].usuario_id).catch(err =>
      console.error('[candidaturas/aprovar] rejeitarConcorrentes:', err.message)
    )

  } catch (err) {
    // 23505 = unique_violation. O único write daqui é o UPDATE acima, e o único
    // índice único que ele pode violar é candidaturas_aceito_unica_idx (UNIQUE em
    // obra_id WHERE status='aceito') — ou seja: outro aceite para a mesma obra
    // entrou entre o SELECT do jaAceito e o UPDATE. O guard acima resolve o caso
    // comum; este catch fecha a corrida. Mesma resposta nos dois caminhos.
    if (err.code === '23505') {
      return res.status(409).json({ erro: 'Já existe um candidato aceito para esta obra' })
    }
    console.error('Erro ao aprovar candidatura:', err)
    res.status(500).json({ erro: 'Erro ao aprovar candidatura' })
  }
}

const recusar = async (req, res) => {
  try {
    const { id } = req.params

    const existe = await pool.query(`SELECT id, status, obra_id FROM candidaturas WHERE id = $1`, [id])
    if (existe.rows.length === 0) {
      return res.status(404).json({ erro: 'Candidatura não encontrada' })
    }

    const obraCheck = await pool.query(
      `SELECT criado_por FROM obras WHERE id = $1`,
      [existe.rows[0].obra_id]
    )
    if (
      obraCheck.rows.length === 0 ||
      (obraCheck.rows[0].criado_por !== req.usuario.id && req.usuario.role !== 'admin')
    ) {
      return res.status(403).json({ erro: 'Sem permissão para esta ação' })
    }

    if (existe.rows[0].status !== 'pendente') {
      return res.status(400).json({ erro: 'Candidatura já foi processada' })
    }

    const result = await pool.query(
      `UPDATE candidaturas SET status = 'recusado', aprovado_por = $1
       WHERE id = $2 RETURNING *`,
      [req.usuario.id, id]
    )

    res.json(result.rows[0])

  } catch (err) {
    console.error('Erro ao recusar candidatura:', err)
    res.status(500).json({ erro: 'Erro ao recusar candidatura' })
  }
}

module.exports = { minhas, porObra, pendentes, aprovar, recusar }