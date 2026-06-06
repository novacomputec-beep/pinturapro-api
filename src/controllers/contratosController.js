const { pool } = require('../utils/supabase')
const { gerarContratoPDF } = require('../services/contratoService')
const { enviarEmailComAnexo } = require('../services/brevoService')

const formatarData = (data) =>
  new Date(data).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })

const formatarValor = (v) =>
  `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`

const formatarCpf = (cpf) => {
  if (!cpf) return '___________________'
  const limpo = cpf.replace(/\D/g, '')
  if (limpo.length === 11) return limpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
  return cpf
}

// ============================================================
// CONTRATO DE REPARO (baseado no modelo "Marido de Aluguel")
// ============================================================
const gerarContratoReparo = ({ dono, prestador, reparo }) => {
  const prazoHoras = reparo.prazo_atendimento_horas
    ? Math.ceil(reparo.prazo_atendimento_horas * 1.2)
    : null
  const valor = reparo.valor_estimado

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; font-size: 13px; color: #222; max-width: 700px; margin: 0 auto; padding: 40px 30px; line-height: 1.7; }
    h1 { text-align: center; font-size: 17px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    h2 { font-size: 13px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 22px; margin-bottom: 6px; }
    .subtitulo { text-align: center; font-size: 12px; color: #555; margin-bottom: 28px; }
    .parte-bloco { margin-bottom: 10px; }
    p { margin: 5px 0; }
    ul { margin: 6px 0 6px 20px; padding: 0; }
    li { margin-bottom: 3px; }
    .assinatura { margin-top: 60px; display: flex; justify-content: space-around; gap: 40px; }
    .assinatura-bloco { flex: 1; text-align: center; }
    .linha-assinatura { border-top: 1px solid #222; margin-bottom: 8px; }
    .assinatura-nome { font-size: 12px; font-weight: bold; }
    .assinatura-cpf { font-size: 11px; color: #555; }
    .rodape { margin-top: 36px; text-align: center; font-size: 10px; color: #888; border-top: 1px solid #eee; padding-top: 12px; }
    hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
  </style>
</head>
<body>

  <h1>Contrato Simples de Prestação de Serviços</h1>
  <p class="subtitulo">Gerado automaticamente pelo aplicativo PinturaPro em ${formatarData(new Date())}</p>

  <p>Pelo presente instrumento particular, de um lado:</p>

  <div class="parte-bloco">
    <p><strong>Contratante:</strong> ${dono.nome}</p>
    <p><strong>CPF:</strong> ${formatarCpf(dono.cpf_cnpj)}</p>
    <p><strong>Endereço da obra:</strong> ${reparo.endereco_obra || `${reparo.cidade}${reparo.bairro ? ', ' + reparo.bairro : ''}`}</p>
    ${dono.telefone ? `<p><strong>Telefone:</strong> ${dono.telefone}</p>` : ''}
  </div>

  <p>E de outro lado:</p>

  <div class="parte-bloco">
    <p><strong>Contratado:</strong> ${prestador.nome}</p>
    <p><strong>CPF:</strong> ${formatarCpf(prestador.cpf_cnpj)}</p>
    ${prestador.telefone ? `<p><strong>Telefone:</strong> ${prestador.telefone}</p>` : ''}
  </div>

  <p>Têm entre si justo e contratado o seguinte:</p>

  <hr>

  <h2>Cláusula 1 — Do Objeto</h2>
  <p>O presente contrato tem como objeto a prestação do seguinte serviço: <strong>${reparo.titulo}</strong>${reparo.descricao ? ` — ${reparo.descricao}` : ''}.</p>
  <p>Categoria: <strong>${reparo.categoria || 'Reparo geral'}</strong>.</p>

  <h2>Cláusula 2 — Da Execução dos Serviços</h2>
  <p>Os serviços serão executados no endereço indicado pela Contratante, conforme agendamento realizado através do aplicativo PinturaPro.</p>
  <p>O Contratado compromete-se a realizar os serviços com zelo, responsabilidade e dentro das condições técnicas adequadas.</p>

  <h2>Cláusula 3 — Dos Materiais</h2>
  <p>Os materiais necessários para execução dos serviços poderão:</p>
  <p>I – Ser fornecidos pela Contratante; ou</p>
  <p>II – Ser adquiridos pelo Contratado, mediante autorização prévia da Contratante, sendo os valores reembolsados posteriormente.</p>

  <h2>Cláusula 4 — Do Pagamento</h2>
  <p>Pelos serviços prestados, a Contratante pagará ao Contratado o valor de <strong>${valor ? formatarValor(valor) : '_______________'}</strong>.</p>
  <p>Forma de pagamento: ( ) PIX &nbsp;&nbsp; ( ) Dinheiro &nbsp;&nbsp; ( ) Transferência &nbsp;&nbsp; ( ) Cartão</p>
  <p>O pagamento deverá ocorrer após a conclusão dos serviços, salvo acordo diferente entre as partes.</p>

  <h2>Cláusula 5 — Da Garantia</h2>
  <p>O Contratado oferece garantia de <strong>${prazoHoras ? prazoHoras + ' hora(s)' : '_____ dias'}</strong> sobre a mão de obra executada, não abrangendo defeitos decorrentes de mau uso, desgaste natural, problemas preexistentes não identificados ou defeitos em peças e equipamentos já danificados.</p>

  <h2>Cláusula 6 — Das Responsabilidades</h2>
  <p>O Contratado não se responsabiliza por danos ocultos, problemas estruturais ou defeitos anteriores existentes no imóvel, equipamentos ou instalações.</p>
  <p>A Contratante compromete-se a fornecer acesso adequado ao local para realização dos serviços.</p>

  <h2>Cláusula 7 — Do Cancelamento</h2>
  <p>Caso haja cancelamento do serviço após o deslocamento do Contratado até o local, poderá ser cobrada taxa de visita a ser acordada entre as partes.</p>

  <h2>Cláusula 8 — Do Foro</h2>
  <p>Fica eleito o foro da comarca de <strong>${reparo.cidade || 'Patos de Minas'}</strong> para dirimir quaisquer dúvidas oriundas deste contrato.</p>

  <p style="margin-top: 16px;">E por estarem de pleno acordo, assinam o presente instrumento em duas vias de igual teor.</p>

  <div class="assinatura">
    <div class="assinatura-bloco">
      <div class="linha-assinatura"></div>
      <p class="assinatura-nome">${dono.nome}</p>
      <p class="assinatura-cpf">CPF: ${formatarCpf(dono.cpf_cnpj)}</p>
      <p class="assinatura-cpf">Contratante</p>
    </div>
    <div class="assinatura-bloco">
      <div class="linha-assinatura"></div>
      <p class="assinatura-nome">${prestador.nome}</p>
      <p class="assinatura-cpf">CPF: ${formatarCpf(prestador.cpf_cnpj)}</p>
      <p class="assinatura-cpf">Contratado</p>
    </div>
  </div>

  <div class="rodape">
    Documento gerado pelo aplicativo PinturaPro — Pode ser assinado manualmente ou por qualquer plataforma de assinatura digital.
  </div>

</body>
</html>
  `
}

// ============================================================
// CONTRATO DE OBRA DE PINTURA (mais completo)
// ============================================================
const gerarContratoObra = ({ dono, prestador, obra, candidatura }) => {
  const prazoContrato = Math.ceil((obra.prazo_execucao_dias || 7) * 1.2)
  const valor = candidatura.valor_oferta || obra.valor

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; font-size: 13px; color: #222; max-width: 700px; margin: 0 auto; padding: 40px 30px; line-height: 1.7; }
    h1 { text-align: center; font-size: 17px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    h2 { font-size: 13px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 22px; margin-bottom: 6px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    .subtitulo { text-align: center; font-size: 12px; color: #555; margin-bottom: 28px; }
    .parte-bloco { margin-bottom: 10px; }
    p { margin: 5px 0; }
    .assinatura { margin-top: 60px; display: flex; justify-content: space-around; gap: 40px; }
    .assinatura-bloco { flex: 1; text-align: center; }
    .linha-assinatura { border-top: 1px solid #222; margin-bottom: 8px; }
    .assinatura-nome { font-size: 12px; font-weight: bold; }
    .assinatura-cpf { font-size: 11px; color: #555; }
    .rodape { margin-top: 36px; text-align: center; font-size: 10px; color: #888; border-top: 1px solid #eee; padding-top: 12px; }
  </style>
</head>
<body>

  <h1>Contrato de Prestação de Serviços</h1>
  <p class="subtitulo">Serviço de Pintura / Reforma Residencial<br>Gerado automaticamente pelo aplicativo PinturaPro em ${formatarData(new Date())}</p>

  <h2>Cláusula 1 — Das Partes</h2>
  <div class="parte-bloco">
    <p><strong>Contratante:</strong> ${dono.nome}, CPF: ${formatarCpf(dono.cpf_cnpj)}, e-mail: ${dono.email}${dono.telefone ? `, telefone: ${dono.telefone}` : ''}.</p>
    <p><strong>Contratado:</strong> ${prestador.nome}, CPF: ${formatarCpf(prestador.cpf_cnpj)}, e-mail: ${prestador.email}${prestador.telefone ? `, telefone: ${prestador.telefone}` : ''}.</p>
  </div>

  <h2>Cláusula 2 — Do Objeto</h2>
  <p>Prestação de serviços de <strong>${obra.categoria || 'pintura e reforma'}</strong> referente à obra <strong>"${obra.titulo}"</strong>, localizada em ${obra.endereco_obra || `${obra.cidade}${obra.bairro ? ', ' + obra.bairro : ''}`}.${obra.descricao ? ` Descrição: ${obra.descricao}` : ''}</p>

  <h2>Cláusula 3 — Do Valor e Pagamento</h2>
  <p>Valor total acordado: <strong>${formatarValor(valor)}</strong>, conforme proposta aceita por ambas as partes através do aplicativo PinturaPro. Condições de pagamento a serem definidas diretamente entre as partes.</p>

  <h2>Cláusula 4 — Do Prazo</h2>
  <p>Prazo estimado para conclusão: <strong>${prazoContrato} dias corridos</strong> a partir do início efetivo dos trabalhos, podendo ser prorrogado mediante acordo.</p>

  <h2>Cláusula 5 — Das Obrigações do Contratado</h2>
  <p>a) Executar os serviços com qualidade e dentro do prazo; b) Utilizar materiais e ferramentas adequados; c) Manter o local limpo ao final de cada jornada; d) Comunicar imediatamente qualquer imprevisto que possa alterar prazo ou valor.</p>

  <h2>Cláusula 6 — Das Obrigações do Contratante</h2>
  <p>a) Providenciar acesso ao local nos horários combinados; b) Efetuar o pagamento nas condições acordadas; c) Informar previamente sobre condições especiais do imóvel.</p>

  <h2>Cláusula 7 — Da Rescisão</h2>
  <p>Rescisão mediante comunicação prévia de 48 horas. A parte que der causa à rescisão responde pelos custos já incorridos pela outra parte.</p>

  <h2>Cláusula 8 — Do Foro</h2>
  <p>Fica eleito o foro da comarca de <strong>${obra.cidade || 'Patos de Minas'}</strong> para dirimir quaisquer dúvidas. As partes declaram que leram e concordam com os termos acima.</p>
  <p>Local e data: ${obra.cidade || '_______________'}, ${formatarData(new Date())}.</p>

  <div class="assinatura">
    <div class="assinatura-bloco">
      <div class="linha-assinatura"></div>
      <p class="assinatura-nome">${dono.nome}</p>
      <p class="assinatura-cpf">CPF: ${formatarCpf(dono.cpf_cnpj)}</p>
      <p class="assinatura-cpf">Contratante</p>
    </div>
    <div class="assinatura-bloco">
      <div class="linha-assinatura"></div>
      <p class="assinatura-nome">${prestador.nome}</p>
      <p class="assinatura-cpf">CPF: ${formatarCpf(prestador.cpf_cnpj)}</p>
      <p class="assinatura-cpf">Contratado</p>
    </div>
  </div>

  <div class="rodape">
    Documento gerado pelo aplicativo PinturaPro — Pode ser assinado manualmente ou por qualquer plataforma de assinatura digital.
  </div>

</body>
</html>
  `
}

// ============================================================
// ENVIO POR E-MAIL
// ============================================================
const enviarContratoReparo = async (reparoId) => {
  try {
    const result = await pool.query(
      `SELECT r.*,
              u_dono.nome as dono_nome, u_dono.email as dono_email,
              u_dono.telefone as dono_telefone, u_dono.cpf_cnpj as dono_cpf,
              u_prest.nome as prest_nome, u_prest.email as prest_email,
              u_prest.telefone as prest_telefone, u_prest.cpf_cnpj as prest_cpf
       FROM reparos r
       JOIN usuarios u_dono  ON r.criado_por       = u_dono.id
       JOIN usuarios u_prest ON r.match_usuario_id = u_prest.id
       WHERE r.id = $1`,
      [reparoId]
    )
    if (result.rows.length === 0) return

    const r = result.rows[0]
    const dono      = { nome: r.dono_nome,  email: r.dono_email,  telefone: r.dono_telefone,  cpf_cnpj: r.dono_cpf  }
    const prestador = { nome: r.prest_nome, email: r.prest_email, telefone: r.prest_telefone, cpf_cnpj: r.prest_cpf }

    const html = gerarContratoReparo({ dono, prestador, reparo: r })

    const dadosPDF = {
      contratante: { ...dono, cidade: r.cidade },
      contratado:  { ...prestador, cidade: r.cidade },
      servico: {
        tipo:       r.categoria || 'reparo',
        descricao:  r.titulo + (r.descricao ? ` — ${r.descricao}` : ''),
        endereco:   r.endereco_obra || `${r.cidade}${r.bairro ? ', ' + r.bairro : ''}`,
        valor:      r.valor_estimado,
        prazo_dias: r.prazo_atendimento_horas ? Math.max(1, Math.ceil(r.prazo_atendimento_horas / 24)) : 1,
        metragem:   null
      },
      cidade: r.cidade || 'Patos de Minas',
      data:   new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
    }

    const pdfBuffer    = await gerarContratoPDF(dadosPDF)
    const assunto      = `📋 Contrato de Serviço — ${r.titulo}`
    const nomeArquivo  = `contrato_reparo_${String(reparoId).substring(0, 8)}.pdf`

    await enviarEmailComAnexo({ para: dono.email,      assunto, html, pdfBuffer, nomeArquivo })
    await enviarEmailComAnexo({ para: prestador.email, assunto, html, pdfBuffer, nomeArquivo })
    console.log(`[Contrato] Reparo ${reparoId} — enviado para ${dono.email} e ${prestador.email}`)
  } catch (err) {
    console.error('[Contrato] Erro ao enviar contrato de reparo:', err.message)
  }
}

const enviarContratoObra = async (candidaturaId) => {
  try {
    const result = await pool.query(
      `SELECT c.valor_oferta, c.mensagem_oferta, o.*,
              u_dono.nome  as dono_nome,  u_dono.email  as dono_email,
              u_dono.telefone  as dono_telefone,  u_dono.cpf_cnpj  as dono_cpf,
              u_prest.nome as prest_nome, u_prest.email as prest_email,
              u_prest.telefone as prest_telefone, u_prest.cpf_cnpj as prest_cpf
       FROM candidaturas c
       JOIN obras o          ON c.obra_id    = o.id
       JOIN usuarios u_dono  ON o.criado_por = u_dono.id
       JOIN usuarios u_prest ON c.usuario_id = u_prest.id
       WHERE c.id = $1`,
      [candidaturaId]
    )
    if (result.rows.length === 0) return

    const r = result.rows[0]
    const dono      = { nome: r.dono_nome,  email: r.dono_email,  telefone: r.dono_telefone,  cpf_cnpj: r.dono_cpf  }
    const prestador = { nome: r.prest_nome, email: r.prest_email, telefone: r.prest_telefone, cpf_cnpj: r.prest_cpf }
    const candidatura = { valor_oferta: r.valor_oferta }

    const html = gerarContratoObra({ dono, prestador, obra: r, candidatura })

    const dadosPDF = {
      contratante: { ...dono, cidade: r.cidade },
      contratado:  { ...prestador, cidade: r.cidade },
      servico: {
        tipo:       r.categoria || 'pintura',
        descricao:  r.titulo,
        endereco:   r.endereco_obra || `${r.cidade}${r.bairro ? ', ' + r.bairro : ''}`,
        valor:      r.valor_oferta || r.valor,
        prazo_dias: r.prazo_execucao_dias || 7,
        metragem:   r.metragem
      },
      cidade: r.cidade || 'Patos de Minas',
      data:   new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
    }

    const pdfBuffer   = await gerarContratoPDF(dadosPDF)
    const assunto     = `📋 Contrato de Prestação de Serviços — ${r.titulo}`
    const nomeArquivo = `contrato_obra_${String(r.id).substring(0, 8)}.pdf`

    await enviarEmailComAnexo({ para: dono.email,      assunto, html, pdfBuffer, nomeArquivo })
    await enviarEmailComAnexo({ para: prestador.email, assunto, html, pdfBuffer, nomeArquivo })
    console.log(`[Contrato] Obra ${r.id} — enviado para ${dono.email} e ${prestador.email}`)

    await pool.query(
      `INSERT INTO contratos (candidatura_id, status) VALUES ($1, 'enviado')
       ON CONFLICT (candidatura_id) DO UPDATE SET status = 'enviado', atualizado_em = NOW()`,
      [candidaturaId]
    )
  } catch (err) {
    console.error('[Contrato] Erro ao enviar contrato de obra:', err.message)
  }
}

module.exports = { enviarContratoReparo, enviarContratoObra }