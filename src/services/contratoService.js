const PDFDocument = require('pdfkit')
const { pool } = require('../utils/supabase')
const { enviarEmailComAnexo } = require('./brevoService')

const gerarContratoPDF = (dados) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' })
    const buffers = []

    doc.on('data', chunk => buffers.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const { contratante, contratado, servico, cidade, data } = dados

    // Cabeçalho
    doc.fontSize(16).font('Helvetica-Bold').text('CONTRATO DE PRESTAÇÃO DE SERVIÇOS', { align: 'center' })
    doc.moveDown(0.5)
    doc.fontSize(10).font('Helvetica').text(`Gerado pela plataforma ArrumaPro em ${data}`, { align: 'center' })
    doc.moveDown(1.5)

    // Linha separadora
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke()
    doc.moveDown(1)

    // Partes
    doc.fontSize(11).font('Helvetica-Bold').text('PARTES CONTRATANTES')
    doc.moveDown(0.5)

    doc.fontSize(10).font('Helvetica-Bold').text('CONTRATANTE:')
    doc.font('Helvetica').text(`Nome: ${contratante.nome}`)
    doc.text(`CPF/CNPJ: ${contratante.cpf_cnpj || 'Não informado'}`)
    doc.text(`Telefone: ${contratante.telefone || 'Não informado'}`)
    doc.text(`E-mail: ${contratante.email}`)
    doc.text(`Cidade: ${contratante.cidade || cidade}`)
    doc.moveDown(0.5)

    doc.font('Helvetica-Bold').text('CONTRATADO:')
    doc.font('Helvetica').text(`Nome: ${contratado.nome}`)
    doc.text(`CPF/CNPJ: ${contratado.cpf_cnpj || 'Não informado'}`)
    doc.text(`Telefone: ${contratado.telefone || 'Não informado'}`)
    doc.text(`E-mail: ${contratado.email}`)
    doc.text(`Cidade: ${contratado.cidade || cidade}`)
    doc.moveDown(0.5)

    doc.font('Helvetica-Bold').text('INTERMEDIADOR:')
    doc.font('Helvetica').text('ArrumaPro Serviços Digitais — plataforma digital de intermediação')
    doc.moveDown(1)

    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke()
    doc.moveDown(1)

    // Cláusulas
    const clausula = (num, titulo, texto) => {
      doc.fontSize(11).font('Helvetica-Bold').text(`CLÁUSULA ${num}ª — ${titulo}`)
      doc.moveDown(0.3)
      doc.fontSize(10).font('Helvetica').text(texto, { align: 'justify' })
      doc.moveDown(0.8)
    }

    clausula('1', 'DO OBJETO',
      `O presente contrato tem por objeto a prestação dos seguintes serviços:\n\n` +
      `Tipo de serviço: ${servico.tipo}\n` +
      `Descrição: ${servico.descricao}\n` +
      `Endereço: ${servico.endereco || cidade}\n` +
      (servico.metragem ? `Área estimada: ${servico.metragem} m²\n` : '')
    )

    clausula('2', 'DO VALOR E FORMA DE PAGAMENTO',
      `2.1 O valor total pelos serviços prestados é de R$ ${Number(servico.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} ` +
      `(${valorPorExtenso(servico.valor)}).\n\n` +
      `2.2 O pagamento será realizado conforme acordado entre as partes, preferencialmente via PIX ou transferência bancária, com comprovante enviado ao CONTRATADO.`
    )

    clausula('3', 'DO PRAZO',
      `3.1 Os serviços deverão ser concluídos em até ${servico.prazo_dias} dias corridos a partir do início da execução.\n\n` +
      `3.2 Para serviços de pequeno porte, o prazo poderá ser de horas ou dias conforme acordado entre as partes.\n\n` +
      `3.3 Atrasos causados por fatores externos ou alterações no escopo serão justificados e o prazo prorrogado mediante acordo.`
    )

    clausula('4', 'DAS OBRIGAÇÕES DO CONTRATADO',
      `4.1 Executar os serviços com qualidade, zelo e técnica adequada.\n` +
      `4.2 Utilizar materiais e ferramentas de boa qualidade.\n` +
      `4.3 Manter o local organizado e limpo ao final de cada jornada.\n` +
      `4.4 Responsabilizar-se por danos causados ao imóvel por negligência ou imperícia.\n` +
      `4.5 Cumprir as normas de segurança do trabalho.\n` +
      `4.6 Comunicar imediatamente ao CONTRATANTE qualquer imprevisto.`
    )

    clausula('5', 'DAS OBRIGAÇÕES DO CONTRATANTE',
      `5.1 Efetuar o pagamento nas condições e prazos estabelecidos.\n` +
      `5.2 Fornecer acesso ao local nos horários combinados.\n` +
      `5.3 Fornecer os materiais acordados, quando aplicável.\n` +
      `5.4 Comunicar alterações no escopo com antecedência mínima de 24 horas.`
    )

    const garantia = servico.tipo === 'pintura' ? '90 (noventa) dias' :
      servico.tipo === 'hidraulica' || servico.tipo === 'eletrica' ? '60 (sessenta) dias' : '30 (trinta) dias'

    clausula('6', 'DA GARANTIA',
      `6.1 O CONTRATADO garante os serviços executados pelo prazo de ${garantia} a contar da conclusão.\n\n` +
      `6.2 Durante a garantia, o CONTRATADO corrigirá gratuitamente defeitos decorrentes de falha na execução.\n\n` +
      `6.3 A garantia não cobre danos por uso inadequado ou reformas posteriores.`
    )

    clausula('7', 'DA RESCISÃO',
      `7.1 O contrato poderá ser rescindido por qualquer parte com comunicação prévia de 48 horas.\n\n` +
      `7.2 Rescisão pelo CONTRATANTE sem justo motivo: remuneração proporcional ao executado + multa de 10%.\n\n` +
      `7.3 Rescisão pelo CONTRATADO sem justo motivo: devolução proporcional dos valores + multa de 10%.`
    )

    clausula('8', 'DA RESPONSABILIDADE DA PLATAFORMA',
      `8.1 A ArrumaPro atua exclusivamente como intermediadora, não sendo responsável pela execução dos serviços ou inadimplência das partes.\n\n` +
      `8.2 A plataforma não gera vínculo trabalhista, previdenciário ou fiscal entre as partes.`
    )

    clausula('9', 'DO FORO',
      `As partes elegem o foro da Comarca de ${cidade}, Estado de Minas Gerais, para dirimir quaisquer litígios, renunciando a qualquer outro.`
    )

    clausula('10', 'DAS DISPOSIÇÕES GERAIS',
      `10.1 Este contrato é firmado em caráter autônomo, sem vínculo empregatício.\n` +
      `10.2 Alterações somente terão validade se feitas por escrito e assinadas por ambas as partes.\n` +
      `10.3 As partes declaram ter lido e concordado com todas as cláusulas.`
    )

    // Assinaturas
    doc.moveDown(1)
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke()
    doc.moveDown(1)

    doc.fontSize(11).font('Helvetica-Bold').text(`${cidade}, ${data}`)
    doc.moveDown(2)

    // Linha de assinatura contratante
    doc.moveTo(50, doc.y).lineTo(240, doc.y).stroke()
    doc.moveDown(0.3)
    doc.fontSize(10).font('Helvetica').text('CONTRATANTE', 50)
    doc.text(`${contratante.nome}`, 50)
    doc.text(`CPF/CNPJ: ${contratante.cpf_cnpj || 'Não informado'}`, 50)
    doc.moveDown(2)

    // Linha de assinatura contratado
    doc.moveTo(50, doc.y).lineTo(240, doc.y).stroke()
    doc.moveDown(0.3)
    doc.fontSize(10).font('Helvetica').text('CONTRATADO', 50)
    doc.text(`${contratado.nome}`, 50)
    doc.text(`CPF/CNPJ: ${contratado.cpf_cnpj || 'Não informado'}`, 50)
    doc.moveDown(2)

    // Testemunhas
    doc.fontSize(10).font('Helvetica-Bold').text('TESTEMUNHAS:')
    doc.moveDown(1)
    doc.moveTo(50, doc.y).lineTo(240, doc.y).stroke()
    doc.font('Helvetica').text('Testemunha 1 — Nome: _______________________  CPF: _______________')
    doc.moveDown(1.5)
    doc.moveTo(50, doc.y).lineTo(240, doc.y).stroke()
    doc.font('Helvetica').text('Testemunha 2 — Nome: _______________________  CPF: _______________')

    // Rodapé
    doc.moveDown(2)
    doc.fontSize(8).fillColor('#888888').text('Documento gerado automaticamente pela plataforma ArrumaPro | www.pinturapro.com.br', { align: 'center' })

    doc.end()
  })
}

const enviarContratoPorEmail = async (emailContratante, emailContratado, pdfBuffer, dados) => {
  const assunto = `ArrumaPro — Contrato de Serviço: ${dados.servico.descricao}`
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: #0a0a0a; margin: 0;">ArrumaPro</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
        <h2 style="color: #333;">Contrato de Prestação de Serviços</h2>
        <p>Olá! Segue em anexo o contrato referente ao serviço contratado pela plataforma ArrumaPro.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="background: #eee;">
            <td style="padding: 10px; font-weight: bold;">Serviço</td>
            <td style="padding: 10px;">${dados.servico.descricao}</td>
          </tr>
          <tr>
            <td style="padding: 10px; font-weight: bold;">Contratante</td>
            <td style="padding: 10px;">${dados.contratante.nome}</td>
          </tr>
          <tr style="background: #eee;">
            <td style="padding: 10px; font-weight: bold;">Contratado</td>
            <td style="padding: 10px;">${dados.contratado.nome}</td>
          </tr>
          <tr>
            <td style="padding: 10px; font-weight: bold;">Valor</td>
            <td style="padding: 10px; color: #4caf50; font-weight: bold;">R$ ${Number(dados.servico.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
          </tr>
          <tr style="background: #eee;">
            <td style="padding: 10px; font-weight: bold;">Prazo</td>
            <td style="padding: 10px;">${dados.servico.prazo_dias} dias</td>
          </tr>
        </table>
        <p style="color: #666; font-size: 13px;">O contrato está disponível em anexo neste e-mail. Recomendamos que ambas as partes o assinem e guardem uma cópia.</p>
        <p style="color: #666; font-size: 13px;">Em caso de dúvidas, entre em contato conosco.</p>
        <p style="margin-top: 30px; color: #333;"><strong>Equipe ArrumaPro</strong></p>
      </div>
    </div>
  `

  await enviarEmailComAnexo({ para: emailContratante, assunto, html, pdfBuffer, nomeArquivo: 'contrato_pinturapro.pdf' })
  await enviarEmailComAnexo({ para: emailContratado,  assunto, html, pdfBuffer, nomeArquivo: 'contrato_pinturapro.pdf' })
  console.log(`Contrato enviado para ${emailContratante} e ${emailContratado}`)
}

const gerarEEnviarContrato = async (candidaturaId) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id as candidatura_id,
        u_pintor.nome as pintor_nome, u_pintor.email as pintor_email,
        u_pintor.telefone as pintor_telefone, u_pintor.cpf_cnpj as pintor_cpf,
        u_pintor.cidade as pintor_cidade,
        u_dono.nome as dono_nome, u_dono.email as dono_email,
        u_dono.telefone as dono_telefone, u_dono.cpf_cnpj as dono_cpf,
        u_dono.cidade as dono_cidade,
        o.titulo as obra_titulo, o.descricao as obra_descricao,
        o.valor as obra_valor, o.cidade as obra_cidade,
        o.prazo_execucao_dias, o.categoria, o.metragem
      FROM candidaturas c
      JOIN usuarios u_pintor ON c.usuario_id = u_pintor.id
      JOIN obras o ON c.obra_id = o.id
      JOIN usuarios u_dono ON o.criado_por = u_dono.id
      WHERE c.id = $1
    `, [candidaturaId])

    if (result.rows.length === 0) throw new Error('Candidatura não encontrada')

    const row = result.rows[0]
    const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })

    const dados = {
      contratante: {
        nome: row.dono_nome,
        email: row.dono_email,
        telefone: row.dono_telefone,
        cpf_cnpj: row.dono_cpf,
        cidade: row.dono_cidade
      },
      contratado: {
        nome: row.pintor_nome,
        email: row.pintor_email,
        telefone: row.pintor_telefone,
        cpf_cnpj: row.pintor_cpf,
        cidade: row.pintor_cidade
      },
      servico: {
        tipo: row.categoria || 'pintura',
        descricao: row.obra_titulo,
        endereco: row.obra_cidade,
        valor: row.obra_valor,
        prazo_dias: row.prazo_execucao_dias,
        metragem: row.metragem
      },
      cidade: row.obra_cidade || 'Patos de Minas',
      data: hoje
    }

    const pdfBuffer = await gerarContratoPDF(dados)
    await enviarContratoPorEmail(row.dono_email, row.pintor_email, pdfBuffer, dados)

    // Salva registro do contrato no banco
    await pool.query(
      `INSERT INTO contratos (candidatura_id, status) VALUES ($1, 'enviado')
       ON CONFLICT (candidatura_id) DO UPDATE SET status = 'enviado', atualizado_em = NOW()`,
      [candidaturaId]
    )

    return true
  } catch (err) {
    console.error('Erro ao gerar/enviar contrato:', err)
    return false
  }
}

// Função auxiliar para valor por extenso (simplificada)
const valorPorExtenso = (valor) => {
  const num = parseFloat(valor)
  if (isNaN(num)) return 'valor não informado'
  const inteiro = Math.floor(num)
  const centavos = Math.round((num - inteiro) * 100)
  const reais = inteiro === 1 ? 'um real' : `${inteiro.toLocaleString('pt-BR')} reais`
  if (centavos === 0) return reais
  const cents = centavos === 1 ? 'um centavo' : `${centavos} centavos`
  return `${reais} e ${cents}`
}

module.exports = { gerarContratoPDF, enviarContratoPorEmail, gerarEEnviarContrato }