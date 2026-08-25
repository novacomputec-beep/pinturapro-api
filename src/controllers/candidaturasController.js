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
              -- Encerramento assimétrico: só o PINTOR cria solicitação pendente. O dono não
              -- solicita — ele encerra na hora, e é ele quem confirma a solicitação do pintor.
              -- Para o lado do pintor: _por = próprio usuário → ele pediu e aguarda o dono
              -- fechar; NULL = nenhuma solicitação em aberto. _por nunca é o dono daqui em
              -- diante (linhas antigas do desenho simétrico podem ter, e fecham na 1ª chamada).
              o.encerramento_solicitado_por, o.encerramento_solicitado_em,
              -- Chegada: o pintor precisa ver a janela que ele mesmo prometeu e se o dono já
              -- confirmou a chegada (declarada por ele + confirmada = atendimento em curso).
              o.chegada_janela, o.chegada_prevista_em, o.chegada_declarada_por,
              o.chegada_declarada_em, o.chegada_confirmada_em,
              -- Janela que estourou o prazo e aguarda o dono, e a marca de recusa. Sem estas o
              -- pintor via a lista sem janela nenhuma (na pendência, chegada_janela/_prevista_em
              -- seguem NULL) e ainda era barrado de propor outra pelo write-once — sem nada na
              -- tela explicando por quê.
              o.chegada_pendente_janela, o.chegada_pendente_em, o.chegada_recusada_em,
              -- "Expirada" não é status no banco: é uma obra NÃO encerrada cujo expira_em já
              -- passou. Mesma expressão de GET /obras/minhas e GET /obras/:id, calculada no SQL
              -- (relógio do servidor) para o app não comparar expira_em com o relógio do aparelho.
              (o.status <> 'encerrada' AND o.expira_em <= NOW()) AS obra_expirada
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
      // telefone e email são sempre NULL aqui de propósito: o contato do pintor só é
      // revelado ao dono APÓS o match, nunca no aceite (regra de negócio — ver GET /obras/:id).
      // Não ligar estas colunas a c.status: reintroduziria o vazamento corrigido em 4fbdab1.
      // email seguia saindo em claro para TODOS os candidatos enquanto o telefone ao lado já
      // era mascarado — mesmo dado de contato, mesma regra, agora com o mesmo tratamento.
      `SELECT c.id, c.status, c.referencias, c.valor_oferta, c.mensagem_oferta, c.criado_em,
              u.id as usuario_id, u.nome,
              NULL as email,
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

    // usuario_id entra no SELECT porque a checagem de suspensão precisa dele ANTES do UPDATE
    // (o RETURNING * lá embaixo só chega depois de o aceite já ter sido gravado).
    const existe = await pool.query(`SELECT id, status, obra_id, usuario_id FROM candidaturas WHERE id = $1`, [id])
    if (existe.rows.length === 0) {
      return res.status(404).json({ erro: 'Candidatura não encontrada' })
    }

    // titulo entra aqui para compor o push "Deu match!" no fim da função, sem query extra.
    const obraCheck = await pool.query(
      `SELECT criado_por, titulo, status, match_usuario_id FROM obras WHERE id = $1`,
      [existe.rows[0].obra_id]
    )
    if (
      obraCheck.rows.length === 0 ||
      (obraCheck.rows[0].criado_por !== req.usuario.id && req.usuario.role !== 'admin')
    ) {
      return res.status(403).json({ erro: 'Sem permissão para esta ação' })
    }

    // Guarda de estado da DEMANDA (D82 — mesma de POST /obras/:id/candidatura/:cid/responder e
    // do lado reparo): aceitar só numa obra viva e ainda não casada. Sem isto, este caminho
    // (usado pelo painel) casava uma obra 'encerrada'/'cancelada' — o UPDATE em obras só
    // exigia match_usuario_id IS NULL.
    const obraAbertaParaNegociar = obraCheck.rows[0].status === 'aberta' && !obraCheck.rows[0].match_usuario_id
    if (!obraAbertaParaNegociar) {
      return res.status(409).json({ erro: 'Esta obra não está mais aberta para negociação.' })
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

    // Suspensão do CANDIDATO (quem chama aqui é o dono ou um admin). Terceiro caminho de
    // aceite, junto de POST /obras/:id/candidatura/:candidaturaId/responder e o equivalente
    // de reparo — todos casam o profissional, então todos precisam da mesma trava.
    const suspenso = await pool.query(
      `SELECT suspenso_em FROM usuarios WHERE id = $1`,
      [existe.rows[0].usuario_id]
    )
    if (suspenso.rows[0]?.suspenso_em) {
      return res.status(409).json({
        erro: 'Este profissional está com a conta suspensa e não pode assumir novos trabalhos. Escolha outro candidato.',
        codigo: 'PROFISSIONAL_SUSPENSO',
      })
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

    const existe = await pool.query(`SELECT id, status, obra_id, usuario_id FROM candidaturas WHERE id = $1`, [id])
    if (existe.rows.length === 0) {
      return res.status(404).json({ erro: 'Candidatura não encontrada' })
    }

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

    const result = await pool.query(
      `UPDATE candidaturas SET status = 'recusado', aprovado_por = $1
       WHERE id = $2 RETURNING *`,
      [req.usuario.id, id]
    )

    res.json(result.rows[0])

    // Aviso ao pintor recusado (D82): mesmo push de POST /obras/:id/candidatura/:cid/responder
    // e do lado reparo — este caminho (painel) era o único que recusava em silêncio.
    const pintor = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [existe.rows[0].usuario_id])
    if (pintor.rows[0]?.push_token) {
      enviarPushNotificacao(pintor.rows[0].push_token, '❌ Candidatura não aceita',
        `Sua candidatura para "${obraCheck.rows[0].titulo}" não foi selecionada desta vez.`,
        { tipo: 'candidatura_recusada', obra_id: existe.rows[0].obra_id }).catch(() => {})
    }

  } catch (err) {
    console.error('Erro ao recusar candidatura:', err)
    res.status(500).json({ erro: 'Erro ao recusar candidatura' })
  }
}

module.exports = { minhas, porObra, pendentes, aprovar, recusar }