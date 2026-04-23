const supabase = require('../utils/supabase')

// Gera o HTML do contrato e salva como PDF no Supabase Storage
// Para produção, instale: npm install puppeteer
// Para MVP, gera HTML e salva como arquivo

const gerarContratoPDF = async (candidatura) => {
  const { obras: obra, usuarios: pintor } = candidatura
  const dataHoje = new Date().toLocaleDateString('pt-BR')
  const dataFim = new Date(Date.now() + obra.prazo_execucao_dias * 86400000).toLocaleDateString('pt-BR')

  const htmlContrato = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; font-size: 13px; color: #222; margin: 60px; line-height: 1.7; }
    h1 { font-size: 18px; text-align: center; margin-bottom: 4px; }
    h2 { font-size: 14px; margin-top: 28px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
    .header { text-align: center; margin-bottom: 32px; }
    .header p { color: #888; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    td { padding: 6px 8px; border: 1px solid #ddd; }
    td:first-child { font-weight: bold; width: 40%; background: #f9f9f9; }
    .clausula { margin-top: 16px; }
    .clausula p { margin: 6px 0; }
    .assinaturas { margin-top: 60px; display: flex; justify-content: space-between; }
    .ass-box { text-align: center; width: 45%; }
    .ass-line { border-top: 1px solid #333; padding-top: 8px; margin-top: 48px; font-size: 12px; }
    .rodape { margin-top: 40px; font-size: 11px; color: #aaa; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <h1>CONTRATO DE PRESTAÇÃO DE SERVIÇOS DE PINTURA</h1>
    <p>Gerado em ${dataHoje} · PinturaPro</p>
  </div>

  <h2>1. Das Partes</h2>
  <table>
    <tr><td>Contratante</td><td>Rafael Silva — Equipe PinturaPro</td></tr>
    <tr><td>Contratado</td><td>${pintor.nome}</td></tr>
    <tr><td>CPF/CNPJ do Contratado</td><td>${pintor.cpf_cnpj || 'A confirmar'}</td></tr>
    <tr><td>Telefone</td><td>${pintor.telefone || 'A confirmar'}</td></tr>
  </table>

  <h2>2. Do Objeto</h2>
  <table>
    <tr><td>Descrição da obra</td><td>${obra.titulo}</td></tr>
    <tr><td>Localização</td><td>${obra.cidade}</td></tr>
    <tr><td>Valor total</td><td>R$ ${Number(obra.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td></tr>
    <tr><td>Prazo de execução</td><td>${obra.prazo_execucao_dias} dias corridos</td></tr>
    <tr><td>Data de início</td><td>${dataHoje}</td></tr>
    <tr><td>Data prevista de conclusão</td><td>${dataFim}</td></tr>
  </table>

  <h2>3. Das Obrigações do Contratado</h2>
  <div class="clausula">
    <p>3.1 Executar os serviços descritos com qualidade, dentro do prazo acordado.</p>
    <p>3.2 Fornecer mão de obra, equipamentos e materiais de consumo necessários à execução.</p>
    <p>3.3 Manter a limpeza e organização do local de trabalho durante toda a execução.</p>
    <p>3.4 Não subcontratar os serviços sem prévia autorização por escrito do Contratante.</p>
    <p>3.5 Responsabilizar-se por danos causados ao imóvel durante a execução dos serviços.</p>
  </div>

  <h2>4. Das Obrigações do Contratante</h2>
  <div class="clausula">
    <p>4.1 Efetuar o pagamento conforme acordado, mediante aprovação da entrega.</p>
    <p>4.2 Garantir acesso ao local de trabalho nos horários combinados.</p>
    <p>4.3 Fornecer as especificações técnicas necessárias antes do início dos serviços.</p>
  </div>

  <h2>5. Do Pagamento</h2>
  <div class="clausula">
    <p>5.1 O valor total de <strong>R$ ${Number(obra.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong> será pago conforme cronograma a ser definido entre as partes.</p>
    <p>5.2 O pagamento final será liberado após vistoria e aprovação do serviço pelo Contratante.</p>
  </div>

  <h2>6. Das Disposições Gerais</h2>
  <div class="clausula">
    <p>6.1 Este contrato é regido pelas leis brasileiras.</p>
    <p>6.2 Fica eleito o foro da cidade de ${obra.cidade} para dirimir quaisquer controvérsias.</p>
    <p>6.3 Qualquer alteração neste contrato deverá ser feita por escrito e assinada pelas partes.</p>
  </div>

  <div class="assinaturas">
    <div class="ass-box">
      <div class="ass-line">
        <strong>Contratante</strong><br>
        Rafael Silva — PinturaPro
      </div>
    </div>
    <div class="ass-box">
      <div class="ass-line">
        <strong>Contratado</strong><br>
        ${pintor.nome}
      </div>
    </div>
  </div>

  <div class="rodape">
    Documento gerado pela plataforma PinturaPro · ${dataHoje}
  </div>
</body>
</html>
  `

  // Salva o HTML no Supabase Storage como arquivo
  // Em produção: converter para PDF com puppeteer antes de salvar
  const nomeArquivo = `contratos/contrato_${candidatura.id}_${Date.now()}.html`
  const buffer = Buffer.from(htmlContrato, 'utf8')

  const { error } = await supabase.storage
    .from('contratos')
    .upload(nomeArquivo, buffer, { contentType: 'text/html', upsert: true })

  if (error) {
    console.error('Erro ao salvar contrato:', error)
    throw error
  }

  return nomeArquivo
}

module.exports = { gerarContratoPDF }
