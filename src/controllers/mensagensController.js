const supabase = require('../utils/supabase')
const { enviarEmail } = require('../services/emailService')

// POST /mensagens — pintor envia dúvida sobre uma obra
const enviar = async (req, res) => {
  try {
    const { obra_id, conteudo } = req.body

    const { data: obra } = await supabase
      .from('obras')
      .select('id, titulo')
      .eq('id', obra_id)
      .single()

    if (!obra) return res.status(404).json({ erro: 'Obra não encontrada' })

    const { data: mensagem, error } = await supabase
      .from('mensagens')
      .insert({ obra_id, autor_id: req.usuario.id, conteudo })
      .select()
      .single()

    if (error) throw error

    // Notifica a equipe
    await enviarEmail({
      para: process.env.EMAIL_EQUIPE || process.env.SMTP_USER,
      assunto: `Nova dúvida sobre — ${obra.titulo}`,
      html: `
        <p><strong>Pintor:</strong> ${req.usuario.nome}</p>
        <p><strong>Obra:</strong> ${obra.titulo}</p>
        <p><strong>Dúvida:</strong> ${conteudo}</p>
        <p>Acesse o painel para responder.</p>
      `
    })

    res.status(201).json(mensagem)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao enviar mensagem' })
  }
}

// GET /mensagens/obra/:obra_id — dúvidas de uma obra (admin vê tudo, pintor vê só as suas)
const porObra = async (req, res) => {
  try {
    let query = supabase
      .from('mensagens')
      .select(`id, conteudo, resposta, respondido, criado_em, respondido_em,
               usuarios (id, nome)`)
      .eq('obra_id', req.params.obra_id)
      .order('criado_em', { ascending: true })

    // Pintor só vê suas próprias mensagens
    if (req.usuario.role === 'assinante') {
      query = query.eq('autor_id', req.usuario.id)
    }

    const { data, error } = await query
    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar mensagens' })
  }
}

// GET /mensagens/pendentes — sem resposta (admin)
const pendentes = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('mensagens')
      .select(`id, conteudo, criado_em,
               obras (id, titulo),
               usuarios (id, nome, email)`)
      .eq('respondido', false)
      .order('criado_em', { ascending: true })

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar mensagens pendentes' })
  }
}

// POST /mensagens/:id/responder — equipe responde (admin)
const responder = async (req, res) => {
  try {
    const { resposta } = req.body

    const { data: mensagem, error } = await supabase
      .from('mensagens')
      .update({
        resposta,
        respondido: true,
        respondido_por: req.usuario.id,
        respondido_em: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select(`id, conteudo, resposta, usuarios (nome, email), obras (titulo)`)
      .single()

    if (error) throw error

    // Notifica o pintor que recebeu resposta
    await enviarEmail({
      para: mensagem.usuarios.email,
      assunto: `Sua dúvida sobre "${mensagem.obras.titulo}" foi respondida`,
      html: `
        <p>Olá, <strong>${mensagem.usuarios.nome}</strong>!</p>
        <p><strong>Sua dúvida:</strong> ${mensagem.conteudo}</p>
        <p><strong>Resposta da equipe:</strong> ${resposta}</p>
      `
    })

    res.json(mensagem)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao responder mensagem' })
  }
}

module.exports = { enviar, porObra, pendentes, responder }
