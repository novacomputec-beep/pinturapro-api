const supabase = require('../utils/supabase')
const { gerarContratoPDF } = require('../services/contratoService')
const { enviarEmail } = require('../services/emailService')

// POST /candidaturas — pintor demonstra interesse em uma obra
const candidatar = async (req, res) => {
  try {
    const { obra_id, referencias } = req.body

    // Verifica se a obra existe e está aberta
    const { data: obra, error: erroObra } = await supabase
      .from('obras')
      .select('id, titulo, status, expira_em')
      .eq('id', obra_id)
      .eq('status', 'aberta')
      .single()

    if (erroObra || !obra) {
      return res.status(404).json({ erro: 'Obra não encontrada ou não está disponível' })
    }

    if (new Date(obra.expira_em) < new Date()) {
      return res.status(400).json({ erro: 'O prazo para aceite desta obra expirou' })
    }

    // Verifica se já se candidatou
    const { data: existente } = await supabase
      .from('candidaturas')
      .select('id, status')
      .eq('obra_id', obra_id)
      .eq('usuario_id', req.usuario.id)
      .single()

    if (existente) {
      return res.status(409).json({
        erro: 'Você já demonstrou interesse nesta obra',
        candidatura: existente
      })
    }

    const { data: candidatura, error } = await supabase
      .from('candidaturas')
      .insert({
        obra_id,
        usuario_id: req.usuario.id,
        referencias,
        status: 'pendente'
      })
      .select()
      .single()

    if (error) throw error

    // Atualiza status da obra para "em análise"
    await supabase.from('obras').update({ status: 'em_analise' }).eq('id', obra_id)

    // Notifica equipe por e-mail
    await enviarEmail({
      para: process.env.EMAIL_EQUIPE || process.env.SMTP_USER,
      assunto: `Nova candidatura — ${obra.titulo}`,
      html: `
        <h2>Nova candidatura recebida</h2>
        <p><strong>Pintor:</strong> ${req.usuario.nome}</p>
        <p><strong>Obra:</strong> ${obra.titulo}</p>
        <p><strong>Referências:</strong> ${referencias || 'Não informadas'}</p>
        <p>Acesse o painel para aprovar ou recusar.</p>
      `
    })

    res.status(201).json(candidatura)

  } catch (err) {
    console.error('Erro ao candidatar:', err)
    res.status(500).json({ erro: 'Erro ao registrar candidatura' })
  }
}

// GET /candidaturas/minhas — candidaturas do pintor logado
const minhas = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('candidaturas')
      .select(`
        id, status, criado_em,
        obras (id, titulo, categoria, valor, cidade, status)
      `)
      .eq('usuario_id', req.usuario.id)
      .order('criado_em', { ascending: false })

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar candidaturas' })
  }
}

// GET /candidaturas/obra/:obra_id — todas candidaturas de uma obra (admin)
const porObra = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('candidaturas')
      .select(`
        id, status, referencias, criado_em,
        usuarios (id, nome, email, telefone, cidade, anos_experiencia, tamanho_equipe, especialidades)
      `)
      .eq('obra_id', req.params.obra_id)
      .order('criado_em', { ascending: true })

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar candidaturas' })
  }
}

// GET /candidaturas/pendentes — todas pendentes (admin)
const pendentes = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('candidaturas')
      .select(`
        id, status, referencias, criado_em,
        obras (id, titulo, categoria, valor, cidade),
        usuarios (id, nome, email, telefone, cidade, anos_experiencia, tamanho_equipe)
      `)
      .eq('status', 'pendente')
      .order('criado_em', { ascending: true })

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar candidaturas pendentes' })
  }
}

// POST /candidaturas/:id/aprovar — aprovar candidatura e gerar contrato
const aprovar = async (req, res) => {
  try {
    const { id } = req.params
    const { observacoes } = req.body

    const { data: candidatura, error } = await supabase
      .from('candidaturas')
      .update({
        status: 'aprovada',
        aprovado_por: req.usuario.id,
        observacoes_admin: observacoes
      })
      .eq('id', id)
      .select(`
        id,
        obras (id, titulo, valor, cidade, prazo_execucao_dias),
        usuarios (id, nome, email, telefone, cpf_cnpj)
      `)
      .single()

    if (error) throw error

    // Encerra a obra — não aceita mais candidatos
    await supabase.from('obras').update({ status: 'encerrada' }).eq('id', candidatura.obras.id)

    // Gera o contrato PDF
    const pdfUrl = await gerarContratoPDF(candidatura)

    // Salva o contrato no banco
    const { data: contrato } = await supabase
      .from('contratos')
      .insert({
        candidatura_id: id,
        pdf_url: pdfUrl,
        status_assinatura: 'gerado'
      })
      .select()
      .single()

    // Notifica o pintor por e-mail
    await enviarEmail({
      para: candidatura.usuarios.email,
      assunto: `Parabéns! Sua candidatura foi aprovada — ${candidatura.obras.titulo}`,
      html: `
        <h2>Candidatura aprovada!</h2>
        <p>Olá, <strong>${candidatura.usuarios.nome}</strong>!</p>
        <p>Sua candidatura para a obra <strong>${candidatura.obras.titulo}</strong> foi aprovada.</p>
        <p>O contrato foi gerado e está disponível no app para assinatura.</p>
        <p><strong>Valor:</strong> R$ ${candidatura.obras.valor}</p>
        <p><strong>Cidade:</strong> ${candidatura.obras.cidade}</p>
        <p><strong>Prazo:</strong> ${candidatura.obras.prazo_execucao_dias} dias</p>
        <p>Acesse o app PinturaPro para visualizar e assinar o contrato.</p>
      `
    })

    res.json({ candidatura, contrato })

  } catch (err) {
    console.error('Erro ao aprovar candidatura:', err)
    res.status(500).json({ erro: 'Erro ao aprovar candidatura' })
  }
}

// POST /candidaturas/:id/recusar
const recusar = async (req, res) => {
  try {
    const { id } = req.params
    const { observacoes } = req.body

    const { data: candidatura, error } = await supabase
      .from('candidaturas')
      .update({
        status: 'recusada',
        aprovado_por: req.usuario.id,
        observacoes_admin: observacoes
      })
      .eq('id', id)
      .select(`
        id,
        obras (titulo),
        usuarios (nome, email)
      `)
      .single()

    if (error) throw error

    // Notifica o pintor
    await enviarEmail({
      para: candidatura.usuarios.email,
      assunto: `Atualização sobre sua candidatura — ${candidatura.obras.titulo}`,
      html: `
        <p>Olá, <strong>${candidatura.usuarios.nome}</strong>.</p>
        <p>Infelizmente sua candidatura para a obra <strong>${candidatura.obras.titulo}</strong> não foi selecionada desta vez.</p>
        <p>Continue acompanhando novas obras disponíveis no app!</p>
      `
    })

    res.json(candidatura)

  } catch (err) {
    res.status(500).json({ erro: 'Erro ao recusar candidatura' })
  }
}

module.exports = { candidatar, minhas, porObra, pendentes, aprovar, recusar }
