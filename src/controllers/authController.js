const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { pool } = require('../utils/supabase')
const { invalidarCacheAssinatura } = require('../middlewares/auth')
const { registrarTentativa, limparTentativas } = require('../utils/tentativasAuth')
const { MARCA } = require('../utils/marca')
const { validarEspecialidades } = require('../utils/especialidades')
const { MAX_CONTAS_POR_EMAIL, sqlTipoConta, tipoDaLinha, tipoDeTipoConta, multiplasContasAtivo } = require('../utils/tipoConta')
const nodemailer = require('nodemailer')
const crypto = require('crypto')

// Hash de comparação para e-mail SEM conta no login — nivela o tempo de resposta dos dois
// caminhos (ver o uso em `login`). Gerado uma única vez a partir de 32 bytes aleatórios, com
// custo 10 (o mesmo de bcrypt.hash(senha, 10) do cadastro). Não é segredo: é um hash de valor
// descartado, nenhuma senha real se compara a ele e nada além do TEMPO depende dele.
const HASH_FICTICIO = '$2b$10$TurXFLIbHVFyg7b3h/.ame16E9jSv4PmsB5G47xyqYPM1rXeqDSda'

const gerarToken = (usuario) => jwt.sign(
  { id: usuario.id, role: usuario.role, tv: usuario.token_version ?? 1 },
  process.env.JWT_SECRET,
  { expiresIn: usuario.role === 'admin' ? '30d' : (process.env.JWT_EXPIRES_IN || '7d') }
)

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
})

const cadastrar = async (req, res) => {
  const ts = new Date().toISOString()
  let client
  try {
    const { nome, email, telefone, senha, cidade, uf,
            especialidades, anos_experiencia, tamanho_equipe,
            cpf_cnpj, tipo_conta, plano, pix_reembolso, referencias,
            verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url,
            rg, rg_orgao, rg_estado, cep, latitude, longitude,
            logradouro, numero, complemento, bairro } = req.body

    // PRESENÇA, nunca o valor: email e cpf_cnpj saíam em claro para o stdout e ficavam
    // retidos no log da Railway. Mesmo estilo booleano já usado no log de campos obrigatórios
    // logo abaixo — o diagnóstico ("veio email?", "veio documento?") é preservado.
    console.log(`[CADASTRO][${ts}] ▶ inicio | tipo_conta=${tipo_conta} tem_email=${!!email} tem_cpf_cnpj=${!!cpf_cnpj} plano=${plano} tem_doc_frente=${!!verificacao_doc_frente_url} tem_doc_verso=${!!verificacao_doc_verso_url} tem_selfie=${!!verificacao_selfie_url}`)

    if (!nome || !email || !senha) {
      console.log(`[CADASTRO][${ts}] ✗ 400 campos obrigatorios ausentes | nome=${!!nome} email=${!!email} senha=${!!senha}`)
      return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' })
    }
    if (senha.length < 8) {
      console.log(`[CADASTRO][${ts}] ✗ 400 senha curta | len=${senha.length}`)
      return res.status(400).json({ erro: 'A senha deve ter pelo menos 8 caracteres' })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      console.log(`[CADASTRO][${ts}] ✗ 400 email invalido | tem_email=${!!email}`)
      return res.status(400).json({ erro: 'E-mail inválido' })
    }

    const emailNormalizado = email.toLowerCase().trim()

    // Hash FORA da transação: o bcrypt nativo roda na threadpool do libuv (não
    // bloqueia o event loop), então não seguramos uma conexão/lock do Postgres
    // durante o custo de CPU do hash — a transação abaixo fica curta.
    console.log(`[CADASTRO][${ts}] ▶ gerando hash de senha`)
    // `let`: com múltiplas contas, o novo tipo de um e-mail existente REUSA o hash da conta
    // que já existe (uma senha por e-mail) — a troca acontece dentro da transação, abaixo.
    let senha_hash = await bcrypt.hash(senha, 10)
    console.log(`[CADASTRO][${ts}] ✓ senha hash gerada`)

    let role = 'assinante'
    if (tipo_conta === 'dono_obra') role = 'dono_obra'
    else if (tipo_conta === 'prestador' || tipo_conta === 'pintor' || tipo_conta === 'construtor') role = 'prestador'

    // Define tipo_dono para distinguir donos de pintura vs reparo
    let tipo_dono = null
    if (tipo_conta === 'dono_obra') tipo_dono = 'pintura'
    else if (tipo_conta === 'dono_reparo') { role = 'dono_obra'; tipo_dono = 'reparo' }

    // Define tipo_prestador para distinguir pintores/construtores de reparadores.
    // Derivado ANTES da validação de especialidades porque é ele que escolhe a lista
    // (obra × reparador). tipo_conta ausente segue como sempre: role 'assinante',
    // tipo_prestador null — nenhum default inventado aqui.
    let tipo_prestador = null
    if (tipo_conta === 'pintor' || tipo_conta === 'construtor') tipo_prestador = 'pintor'
    else if (tipo_conta === 'prestador') tipo_prestador = 'reparador'

    // Validação do vocabulário FECHADO de especialidades (utils/especialidades). Roda aqui,
    // depois de role E tipo_prestador estarem resolvidos: o mínimo de 1 só vale para
    // profissional — dono não presta serviço e entra com lista vazia, que segue válida — e
    // o lado (tipo_prestador) escolhe a lista contra a qual os slugs são conferidos.
    // Campo ausente vira [] (mesmo default de antes), então dono que não manda nada continua
    // passando; profissional que não manda nada agora recebe 400, que é o ponto do fechamento.
    const espCadastro = validarEspecialidades(especialidades || [], role === 'prestador', tipo_prestador)
    if (espCadastro.erro) {
      console.log(`[CADASTRO][${ts}] ✗ 400 especialidades | motivo=${espCadastro.erro}`)
      return res.status(400).json({ erro: espCadastro.erro })
    }

    const verificacaoStatus = role === 'prestador' ? 'pendente' : 'nao_solicitada'
    const planoEscolhido = plano || 'mensal'

    // Janela de lançamento: prestador entra SEM pagar mas AINDA aguarda aprovação
    // do admin (idoneidade nunca é pulada). A janela só remove o paywall — a fila de
    // aprovação continua. "gratuito não expira" é gravado no tipo da linha, não na
    // janela, então continua correto mesmo depois que a janela for desligada.
    // Config em banco (chave='lancamento_data_fim'): admin liga/desliga/estende pelo
    // painel, sem mexer no Railway. Lido no MESMO client da transação abaixo.

    // Transação única: o INSERT em usuarios e o INSERT em assinaturas commitam
    // JUNTOS ou nada. Antes, cada pool.query fazia autocommit isolado — se a
    // resposta se perdesse (timeout/rede) após o INSERT em usuarios já commitado,
    // o usuário ficava meio-criado e todo retry virava um 409 legítimo ("CPF só
    // no fim"). Agora, qualquer falha antes do COMMIT desfaz tudo → o retry é limpo.
    client = await pool.connect()
    await client.query('BEGIN')

    // Lê a janela de lançamento no MESMO client (snapshot consistente da transação).
    // gratuito só vale se há data_fim futura; NULL/vazio ou passado = janela desligada.
    const cfgLancamento = await client.query(`SELECT valor FROM configuracoes WHERE chave = 'lancamento_data_fim'`)
    const dataFimLancamento = cfgLancamento.rows[0]?.valor || null
    const lancamentoGratis = !!dataFimLancamento && new Date(dataFimLancamento) > new Date()

    // Serializa cadastros do MESMO e-mail e do MESMO CPF/CNPJ (advisory lock de transação,
    // solto no COMMIT/ROLLBACK). Os índices únicos agora são por (email, tipo) e (cpf, tipo),
    // então sozinhos NÃO barram mais o mesmo e-mail/CPF em outro tipo: com a chave
    // multiplas_contas desligada, é este lock + as pré-checagens abaixo que mantêm a regra
    // "um e-mail, um CPF, uma conta" sem corrida; ligada, é ele que mantém corretos o teto de
    // contas e a checagem de "mesma pessoa". Ordem fixa (e-mail, depois CPF) — sem ciclo, sem
    // deadlock. Classe 1 = e-mail (a MESMA chave do trigger usuarios_email_admin_exclusivo),
    // classe 2 = CPF normalizado.
    const cpfLimpo = cpf_cnpj ? cpf_cnpj.replace(/\D/g, '') : null
    await client.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [emailNormalizado])
    if (cpf_cnpj) await client.query('SELECT pg_advisory_xact_lock(2, hashtext($1))', [cpfLimpo])

    const multiplasContas = await multiplasContasAtivo(client)

    // Pré-checagens amigáveis DENTRO da transação (mensagem limpa). Em corrida
    // real, o índice único (email + cpf_cnpj normalizado, por tipo) é a garantia final e
    // cai no handler de 23505 abaixo.
    console.log(`[CADASTRO][${ts}] ▶ verificando email no banco | email=${emailNormalizado}`)
    const existente = await client.query(
      `SELECT id, senha_hash, role, ativo, ${sqlTipoConta()} AS tipo,
              regexp_replace(COALESCE(cpf_cnpj, ''), '[^0-9]', '', 'g') AS cpf_norm
         FROM usuarios WHERE email = $1 ORDER BY criado_em ASC, id ASC`,
      [emailNormalizado]
    )
    // cpfLimpo NÃO entra no log: é CPF/CNPJ em claro. O marcador de etapa basta.
    if (cpf_cnpj) console.log(`[CADASTRO][${ts}] ▶ verificando cpf_cnpj no banco`)
    const cpfExistente = cpf_cnpj
      ? await client.query(
          `SELECT id, email FROM usuarios WHERE regexp_replace(cpf_cnpj, '[^0-9]', '', 'g') = $1`,
          [cpfLimpo]
        )
      : { rows: [] }

    const recusarEmail = async () => {
      await client.query('ROLLBACK')
      console.log(`[CADASTRO][${ts}] ✗ 409 email duplicado | email=${emailNormalizado}`)
      return res.status(409).json({ erro: 'Este e-mail já está cadastrado.', codigo: 'email_duplicado' })
    }
    const recusarCpf = async () => {
      await client.query('ROLLBACK')
      console.log(`[CADASTRO][${ts}] ✗ 409 cpf_cnpj duplicado`)
      return res.status(409).json({ erro: 'Este CPF/CNPJ já está cadastrado.', codigo: 'cpf_duplicado' })
    }

    if (!multiplasContas) {
      // Chave DESLIGADA: e-mail ou CPF existente em QUALQUER tipo recusa, como sempre foi.
      if (existente.rows.length > 0) return recusarEmail()
      console.log(`[CADASTRO][${ts}] ✓ email disponivel`)
      if (cpfExistente.rows.length > 0) return recusarCpf()
      if (cpf_cnpj) console.log(`[CADASTRO][${ts}] ✓ cpf_cnpj disponivel`)
    } else if (existente.rows.length > 0 || cpfExistente.rows.length > 0) {
      // Chave LIGADA e já existe conta com este e-mail e/ou este CPF: só entra como NOVO TIPO
      // da MESMA pessoa — e-mail E CPF têm que casar, os dois, com as contas que já existem.
      // Mesmo e-mail com outro CPF (ou sem CPF de um dos lados) e mesmo CPF com outro e-mail
      // seguem recusados com os 409 de sempre.
      const tipoNovo = tipoDeTipoConta(tipo_conta)
      if (existente.rows.length > 0) {
        const mesmaPessoa = !!cpfLimpo && existente.rows.every(u => u.cpf_norm === cpfLimpo)
        // Conta admin nunca divide e-mail (o trigger também barra); conta desativada não
        // ganha conta nova por outro tipo; cadastro sem tipo_conta ('assinante') não é um dos
        // 4 tipos. Todos: o mesmo 409 de e-mail duplicado de antes.
        const bloqueada = existente.rows.some(u => u.role === 'admin' || !u.ativo)
        if (!mesmaPessoa || bloqueada || !tipoNovo) return recusarEmail()
      }
      if (cpfExistente.rows.some(u => u.email !== emailNormalizado)) return recusarCpf()
      if (existente.rows.length === 0) return recusarCpf() // CPF existe, e-mail não: outra pessoa

      if (existente.rows.some(u => u.tipo === tipoNovo)) {
        await client.query('ROLLBACK')
        console.log(`[CADASTRO][${ts}] ✗ 409 tipo duplicado | tipo=${tipoNovo}`)
        return res.status(409).json({ erro: 'Você já tem uma conta deste tipo com este e-mail.', codigo: 'tipo_duplicado' })
      }
      if (existente.rows.length >= MAX_CONTAS_POR_EMAIL) {
        await client.query('ROLLBACK')
        console.log(`[CADASTRO][${ts}] ✗ 409 limite de contas | contas=${existente.rows.length}`)
        return res.status(409).json({ erro: 'Este e-mail já atingiu o limite de contas.', codigo: 'limite_contas' })
      }

      // UMA senha por e-mail: a senha enviada tem que ser a da conta que já existe, e a conta
      // nova REUSA aquele hash (o hash gerado acima é descartado). Isto é uma conferência de
      // senha exposta num endpoint público, então conta no MESMO contador por identidade do
      // login — sem isso o cadastro viraria um login sem teto de tentativas.
      const tentativa = await registrarTentativa('login', emailNormalizado)
      if (tentativa.excedeu) {
        await client.query('ROLLBACK')
        return res.status(429).json({
          erro: `Muitas tentativas. Tente novamente em ${Math.ceil(tentativa.segundosRestantes / 60)} minuto(s), ou redefina sua senha.`,
          codigo: 'MUITAS_TENTATIVAS',
          retry_apos_segundos: tentativa.segundosRestantes,
        })
      }
      const senhaConfere = await bcrypt.compare(senha, existente.rows[0].senha_hash)
      if (!senhaConfere) {
        await client.query('ROLLBACK')
        console.log(`[CADASTRO][${ts}] ✗ 401 senha nao confere com a conta existente`)
        return res.status(401).json({
          erro: 'Este e-mail já tem uma conta. Informe a mesma senha dela para criar este novo perfil.',
          codigo: 'senha_conta_existente',
        })
      }
      await limparTentativas('login', emailNormalizado)
      senha_hash = existente.rows[0].senha_hash
      console.log(`[CADASTRO][${ts}] ✓ novo tipo para pessoa existente | tipo=${tipoNovo} contas_existentes=${existente.rows.length}`)
    }

    console.log(`[CADASTRO][${ts}] ▶ INSERT usuarios | role=${role} tipo_dono=${tipo_dono} tipo_prestador=${tipo_prestador} verificacao_status=${verificacaoStatus}`)
    const result = await client.query(
      `INSERT INTO usuarios (nome, email, telefone, senha_hash, cidade, uf,
        especialidades, anos_experiencia, tamanho_equipe, cpf_cnpj, role, ativo,
        tipo_dono, pix_reembolso, referencias,
        verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url,
        verificacao_status, rg, rg_orgao, rg_estado, tipo_prestador, cep, latitude, longitude,
        logradouro, numero, complemento, bairro)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
       RETURNING id, nome, email, telefone, cidade, role, tipo_dono, tipo_prestador, foto_url`,
      [nome.trim(), emailNormalizado, telefone, senha_hash, cidade, uf || null,
       espCadastro.valor, anos_experiencia || 0,
       tamanho_equipe || 1, cpf_cnpj, role,
       tipo_dono,
       pix_reembolso || null,
       JSON.stringify(referencias || []),
       verificacao_doc_frente_url || null,
       verificacao_doc_verso_url || null,
       verificacao_selfie_url || null,
       verificacaoStatus,
       rg || null, rg_orgao || null, rg_estado || null,
       tipo_prestador,
       cep || null, latitude ?? null, longitude ?? null,
       logradouro || null, numero || null, complemento || null, bairro || null]
    )

    const usuario = result.rows[0]
    console.log(`[CADASTRO][${ts}] ✓ usuario criado | id=${usuario.id} role=${usuario.role} tipo_prestador=${usuario.tipo_prestador}`)

    if (role === 'dono_obra') {
      console.log(`[CADASTRO][${ts}] ▶ INSERT assinatura gratuita | usuario_id=${usuario.id}`)
      await client.query(
        `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo)
         VALUES ($1, 'mensal', 0, 'ativa', 'gratuito')`,
        [usuario.id]
      )
      console.log(`[CADASTRO][${ts}] ✓ assinatura gratuita criada`)
    } else if (role === 'prestador') {
      const valorMensal = tipo_prestador === 'pintor'
        ? (planoEscolhido === 'anual' ? 999.00 : 99.90)
        : (planoEscolhido === 'anual' ? 499.00 : 49.90)
      if (lancamentoGratis) {
        // Janela de lançamento: sem paywall, MAS ainda aguarda aprovação do admin.
        // status='pendente_verificacao' → app mostra tela de verificação (não libera).
        // tipo='gratuito' → a aprovação deixa proximo_vencimento NULL (nunca expira).
        // valor_mensal REAL (49.90/99.90) é preservado para uma conversão paga futura.
        // proximo_vencimento OMITIDO → NULL. verificacao_status continua 'pendente'.
        console.log(`[CADASTRO][${ts}] ▶ INSERT assinatura prestador GRATIS (lançamento) | usuario_id=${usuario.id} plano=${planoEscolhido} valor=${valorMensal}`)
        await client.query(
          `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo)
           VALUES ($1, $2, $3, 'pendente_verificacao', 'gratuito')`,
          [usuario.id, planoEscolhido, valorMensal]
        )
        console.log(`[CADASTRO][${ts}] ✓ assinatura pendente_verificacao gratuita criada | valor=${valorMensal}`)
      } else {
        console.log(`[CADASTRO][${ts}] ▶ INSERT assinatura prestador | usuario_id=${usuario.id} plano=${planoEscolhido} valor=${valorMensal}`)
        await client.query(
          `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status)
           VALUES ($1, $2, $3, 'pendente')`,
          [usuario.id, planoEscolhido, valorMensal]
        )
        console.log(`[CADASTRO][${ts}] ✓ assinatura pendente criada | valor=${valorMensal}`)
      }
    } else {
      const valorMensal = planoEscolhido === 'anual' ? 999.00 : 99.90
      console.log(`[CADASTRO][${ts}] ▶ INSERT assinatura assinante | usuario_id=${usuario.id} plano=${planoEscolhido} valor=${valorMensal}`)
      await client.query(
        `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status)
         VALUES ($1, $2, $3, 'pendente')`,
        [usuario.id, planoEscolhido, valorMensal]
      )
      console.log(`[CADASTRO][${ts}] ✓ assinatura pendente criada | valor=${valorMensal}`)
    }

    const assinaturaResult = await client.query(
      `SELECT status, tipo, plano, proximo_vencimento, valor_mensal FROM assinaturas WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [usuario.id]
    )
    const assinatura = assinaturaResult.rows[0] || null

    await client.query('COMMIT')

    const token = gerarToken(usuario)
    console.log(`[CADASTRO][${ts}] ✓ commit ok — token gerado | usuario_id=${usuario.id} — respondendo 201`)
    res.status(201).json({ usuario, token, assinatura })

    // E-mails especiais de teste — aprovação automática imediata (configurar via EMAILS_ESPECIAIS no Railway)
    const emailsEspeciais = (process.env.EMAILS_ESPECIAIS || '')
      .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    if (emailsEspeciais.length > 0 && emailsEspeciais.includes(emailNormalizado)) {
      setImmediate(async () => {
        try {
          await pool.query(`UPDATE usuarios SET verificacao_status = 'aprovado', aprovado_automaticamente = true WHERE id = $1`, [usuario.id])
          await pool.query(`UPDATE assinaturas SET status = 'ativa', tipo = 'gratuito', atualizado_em = NOW() WHERE usuario_id = $1`, [usuario.id])
          console.log(`[Acesso especial] ${emailNormalizado} aprovado automaticamente`)
        } catch (err) {
          console.error('Erro ao aprovar e-mail especial:', err)
        }
      })
    }

    setImmediate(async () => {
      try {
        const { enviarBoasVindas } = require('../services/alertaService')
        await enviarBoasVindas(usuario.id)
      } catch (err) {
        console.error('Erro ao enviar boas-vindas:', err)
      }
    })

  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    const ts2 = new Date().toISOString()
    // 23505 = unique_violation. Agora COBRE de fato o CPF: o índice único no
    // cpf_cnpj normalizado existe (migração em routes/index.js) e seu nome contém
    // "cpf", então a corrida real cai aqui e vira um 409 limpo em vez de 500.
    if (err.code === '23505') {
      console.error(`[CADASTRO][${ts2}] ✗ 409 unicidade BD | constraint=${err.constraint} | msg=${err.message}`)
      // `codigo` é a chave ESTÁVEL que o app usa p/ classificar sem depender do texto
      // em português. `erro` continua sendo a mensagem humana (retrocompatível).
      if (err.constraint?.includes('cpf')) return res.status(409).json({ erro: 'Este CPF/CNPJ já está cadastrado.', codigo: 'cpf_duplicado' })
      if (err.constraint?.includes('email')) return res.status(409).json({ erro: 'Este e-mail já está cadastrado.', codigo: 'email_duplicado' })
      return res.status(409).json({ erro: 'Dados já cadastrados. Verifique seu e-mail e CPF/CNPJ.', codigo: 'dados_duplicados' })
    }
    console.error(`[CADASTRO][${ts2}] ✗ ERRO INTERNO | msg="${err.message}" | code=${err.code}\n${err.stack}`)
    res.status(500).json({ erro: err.message || 'Erro ao criar conta' })
  } finally {
    if (client) client.release()
  }
}

const login = async (req, res) => {
  try {
    // `tipo` é opcional e só importa quando o e-mail tem 2+ contas ativas (múltiplas contas):
    // aceita o tipo canônico devolvido em `contas[].tipo` ou o tipo_conta do cadastro.
    const { email, senha, tipo } = req.body

    if (!email || !senha) {
      return res.status(400).json({ erro: 'E-mail e senha são obrigatórios' })
    }

    const emailNormalizado = email.toLowerCase().trim()

    // Contador por identidade ANTES de qualquer consulta e ANTES do bcrypt: identidade
    // trancada nem chega a queimar ~100ms de hash. Vale para e-mail inexistente também —
    // é isso que faz o 429 explícito não denunciar quais contas existem.
    const tentativa = await registrarTentativa('login', emailNormalizado)
    if (tentativa.excedeu) {
      return res.status(429).json({
        erro: `Muitas tentativas de login. Tente novamente em ${Math.ceil(tentativa.segundosRestantes / 60)} minuto(s), ou redefina sua senha.`,
        codigo: 'MUITAS_TENTATIVAS',
        retry_apos_segundos: tentativa.segundosRestantes,
      })
    }

    const result = await pool.query(
      // Mais ANTIGA primeiro: com 2+ contas e nenhum `tipo` no corpo (app antigo), é ela que entra.
      'SELECT id, nome, email, telefone, cidade, role, senha_hash, ativo, foto_url, tipo_dono, tipo_prestador, boas_vindas_exibida, token_version FROM usuarios WHERE email = $1 ORDER BY criado_em ASC, id ASC',
      [emailNormalizado]
    )

    if (result.rows.length === 0) {
      // E-mail sem conta: compara contra um hash FICTÍCIO em vez de sair na hora. O retorno
      // antecipado fazia o caminho "não existe" responder em ~1ms e o "existe" em ~65ms (custo
      // do bcrypt), e essa diferença sozinha já dizia quais e-mails estão cadastrados.
      // Agora os dois pagam o mesmo trabalho. O resultado é descartado de propósito — sempre
      // false, porque o hash vem de 32 bytes aleatórios que nenhuma senha submetida reproduz.
      // Custo 10, o mesmo de bcrypt.hash(senha, 10) usado no cadastro: com custo menor a
      // diferença de tempo voltaria.
      await bcrypt.compare(senha, HASH_FICTICIO)
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' })
    }

    // Só conta ATIVA conta. Nenhuma ativa = o 403 de sempre (com uma linha só, é exatamente o
    // `!usuario.ativo` de antes). Com 1 ativa nada muda. Com 2+ (múltiplas contas): entra a do
    // `tipo` pedido, ou a mais antiga quando o corpo não traz tipo.
    const ativas = result.rows.filter(u => u.ativo)
    if (ativas.length === 0) {
      return res.status(403).json({ erro: 'Conta desativada' })
    }
    const tipoPedido = ativas.length > 1 ? tipoDeTipoConta(tipo) : null
    const escolhida = tipoPedido ? ativas.find(u => tipoDaLinha(u) === tipoPedido) : ativas[0]

    // A senha é UMA por e-mail, então o hash é o mesmo em todas as linhas; compara contra o da
    // conta escolhida (ou o da mais antiga, quando o tipo pedido não existe — a recusa por
    // tipo só sai DEPOIS de a senha conferir, para não descrever as contas a quem não a tem).
    const senhaValida = await bcrypt.compare(senha, (escolhida || ativas[0]).senha_hash)
    if (!senhaValida) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' })
    }

    const contas = ativas.map(u => ({ id: u.id, tipo: tipoDaLinha(u), nome: u.nome }))
    if (!escolhida) {
      return res.status(404).json({ erro: 'Não há conta deste tipo para este e-mail.', codigo: 'conta_tipo_inexistente', contas })
    }
    const usuario = escolhida

    // Senha conferiu: apaga a linha (some, não zera — mantém a tabela pequena). Limpa ANTES
    // do 2FA de propósito: este contador defende a SENHA, e ela acabou de ser provada. Um
    // eventual contador de 2FA seria um controle à parte.
    await limparTentativas('login', emailNormalizado)

    if (usuario.role === 'admin') {
      const tfaResult = await pool.query(
        `SELECT dois_fa_ativo, dois_fa_secret FROM usuarios WHERE id = $1`,
        [usuario.id]
      )
      const tfa = tfaResult.rows[0]
      if (tfa?.dois_fa_ativo && tfa?.dois_fa_secret) {
        const tempToken = jwt.sign(
          { id: usuario.id, role: usuario.role, tipo: '2fa_pendente' },
          process.env.JWT_SECRET,
          { expiresIn: '5m' }
        )
        return res.status(200).json({ requer_2fa: true, temp_token: tempToken })
      }
    }

    const assinaturaResult = await pool.query(
      `SELECT status, tipo, plano, proximo_vencimento, valor_mensal FROM assinaturas
       WHERE usuario_id = $1
       ORDER BY CASE status WHEN 'ativa' THEN 1 WHEN 'pendente' THEN 2 ELSE 3 END, criado_em DESC
       LIMIT 1`,
      [usuario.id]
    )

    const token = gerarToken(usuario)

    res.json({
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        telefone: usuario.telefone || null,
        cidade: usuario.cidade || null,
        role: usuario.role,
        foto_url: usuario.foto_url || null,
        tipo_dono: usuario.tipo_dono || null,
        tipo_prestador: usuario.tipo_prestador || null,
        boas_vindas_exibida: usuario.boas_vindas_exibida ?? false
      },
      assinatura: assinaturaResult.rows[0] || null,
      token,
      // Campo EXTRA, só quando o e-mail tem 2+ contas ativas — com uma conta a resposta é
      // byte a byte a de antes. O app novo usa para oferecer a troca (novo login com `tipo`).
      ...(contas.length > 1 ? { contas } : {})
    })

  } catch (err) {
    console.error('Erro no login:', err)
    res.status(500).json({ erro: 'Erro ao fazer login' })
  }
}

const perfil = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nome, email, telefone, cidade, especialidades, anos_experiencia, tamanho_equipe, role, foto_url, tipo_dono, tipo_prestador, boas_vindas_exibida FROM usuarios WHERE id = $1',
      [req.usuario.id]
    )
    const assinaturaResult = await pool.query(
      `SELECT plano, status, tipo, proximo_vencimento, valor_mensal FROM assinaturas
       WHERE usuario_id = $1
       ORDER BY CASE status WHEN 'ativa' THEN 1 WHEN 'pendente' THEN 2 ELSE 3 END, criado_em DESC LIMIT 1`,
      [req.usuario.id]
    )
    res.json({ usuario: result.rows[0], assinatura: assinaturaResult.rows[0] || null })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar perfil' })
  }
}

const atualizarPerfil = async (req, res) => {
  try {
    const { nome, telefone, cidade, uf } = req.body

    // Rota de atualização PARCIAL: cada campo só é validado/gravado quando a chave
    // veio no body. Nome ausente ≠ nome inválido — a tela de especialidades manda
    // só { especialidades } de propósito, e exigir nome aqui quebrava esse save.
    const mexeNome = Object.prototype.hasOwnProperty.call(req.body, 'nome')
    if (mexeNome && (typeof nome !== 'string' || !nome.trim())) {
      return res.status(400).json({ erro: 'Nome é obrigatório' })
    }
    const mexeTelefone = Object.prototype.hasOwnProperty.call(req.body, 'telefone')

    // PRESENÇA da chave, não valor "truthy": [] e null são valores que o cliente pode ter
    // mandado de propósito, e `especialidades !== undefined` trataria { especialidades: null }
    // como ausência. Chave ausente = não mexe na coluna, exatamente como nome/telefone/
    // cidade/uf se comportam — e é o que preserva o texto livre legado de quem salva o
    // perfil sem tocar no campo. Nada aqui lê o valor já gravado: não há retro-validação.
    const mexeEspecialidades = Object.prototype.hasOwnProperty.call(req.body, 'especialidades')
    let especialidadesValidadas = null
    if (mexeEspecialidades) {
      // Lado = tipo_prestador da linha carregada por `autenticar` (não vem do corpo). NULL
      // (prestador legado sem tipo) cai na lista de reparador — o mesmo vocabulário que
      // valia para todo mundo antes do split; nada inventado.
      const r = validarEspecialidades(req.body.especialidades, req.usuario.role === 'prestador', req.usuario.tipo_prestador)
      if (r.erro) return res.status(400).json({ erro: r.erro })
      especialidadesValidadas = r.valor
    }

    // cidade/uf são não-destrutivos: só sobrescrevem quando vem valor não-vazio.
    // Antes o UPDATE gravava cidade incondicionalmente, então salvar o perfil com o
    // campo em branco (a tela valida só o nome) APAGAVA a cidade do usuário — e cidade
    // vazia degrada o feed inteiro (o filtro geográfico não resolve e a busca perde o
    // recorte). NULLIF(btrim($n), '') transforma ausente/em branco em NULL e o COALESCE
    // mantém o valor já gravado.
    // Body sem nenhum campo atualizável: 400 explícito em vez de um UPDATE que não
    // muda nada e devolve 200 como se tivesse salvo.
    const mexeCidade = Object.prototype.hasOwnProperty.call(req.body, 'cidade')
    const mexeUf = Object.prototype.hasOwnProperty.call(req.body, 'uf')
    if (!mexeNome && !mexeTelefone && !mexeCidade && !mexeUf && !mexeEspecialidades) {
      return res.status(400).json({ erro: 'Nenhum campo para atualizar' })
    }

    // Os flags booleanos governam se a coluna é tocada: com a chave ausente o CASE
    // devolve o próprio valor gravado. Isso vale também para telefone — antes ele era
    // gravado incondicionalmente, então um body sem a chave (undefined → NULL no pg)
    // apagava o telefone do usuário.
    const result = await pool.query(
      `UPDATE usuarios SET
              nome     = CASE WHEN $1::boolean THEN $2::text ELSE nome END,
              telefone = CASE WHEN $3::boolean THEN $4::text ELSE telefone END,
              cidade   = COALESCE(NULLIF(btrim($5), ''), cidade),
              uf       = COALESCE(NULLIF(btrim($6), ''), uf),
              especialidades = CASE WHEN $8::boolean THEN $9::text[] ELSE especialidades END
        WHERE id = $7
        RETURNING id, nome, email, telefone, cidade, uf, foto_url, especialidades`,
      [mexeNome, mexeNome ? nome.trim() : null,
       mexeTelefone, mexeTelefone ? telefone : null,
       cidade || '', uf || '', req.usuario.id,
       mexeEspecialidades, especialidadesValidadas]
    )
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar perfil' })
  }
}

const alterarSenha = async (req, res) => {
  try {
    const { senha_atual, nova_senha } = req.body
    if (!senha_atual || !nova_senha) {
      return res.status(400).json({ erro: 'Informe a senha atual e a nova senha' })
    }
    if (nova_senha.length < 8) {
      return res.status(400).json({ erro: 'A nova senha deve ter pelo menos 8 caracteres' })
    }
    if (senha_atual === nova_senha) {
      return res.status(400).json({ erro: 'A nova senha deve ser diferente da senha atual' })
    }
    const result = await pool.query('SELECT senha_hash FROM usuarios WHERE id = $1', [req.usuario.id])
    const senhaValida = await bcrypt.compare(senha_atual, result.rows[0].senha_hash)
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha atual incorreta' })
    }
    const nova_hash = await bcrypt.hash(nova_senha, 10)
    // Incrementa token_version: revoga TODAS as sessões (D51) — inclusive a que trocou a senha.
    // Múltiplas contas: a senha é UMA por e-mail, então vale para TODAS as linhas do e-mail
    // desta conta (e revoga as sessões de todas). Com uma conta só, é o UPDATE por id de antes.
    const alteradas = await pool.query(
      `UPDATE usuarios SET senha_hash = $1, token_version = token_version + 1
        WHERE email = (SELECT email FROM usuarios WHERE id = $2) RETURNING id`,
      [nova_hash, req.usuario.id]
    )
    // revogação imediata nesta réplica; até 30s nas demais
    alteradas.rows.forEach(u => invalidarCacheAssinatura(u.id))
    res.json({ mensagem: 'Senha alterada com sucesso' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao alterar senha' })
  }
}

const esqueciSenha = async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ erro: 'Informe o e-mail' })

    const emailNormalizado = email.toLowerCase().trim()

    res.json({ mensagem: 'Se este e-mail estiver cadastrado, você receberá as instruções em breve.' })

    // NUNCA 429 aqui — a resposta genérica acima já saiu e é sempre a mesma. O contrato deste
    // endpoint é não revelar se o endereço está cadastrado, e um status diferente no caminho
    // estourado seria exatamente esse oráculo. Estourou o teto: só não manda o e-mail.
    // Abuso de VOLUME continua sendo trabalho do limiter por IP (20/h em server.js).
    const tentativa = await registrarTentativa('reset', emailNormalizado)
    if (tentativa.excedeu) {
      console.warn(`[EsqueciSenha] teto por identidade atingido — e-mail não enviado (${tentativa.tentativas} pedidos na janela)`)
      return
    }

    // Múltiplas contas: UM código por e-mail, gravado em TODAS as linhas dele. A saudação usa
    // o nome da conta mais antiga (ORDER BY) — com uma conta só, é a linha de sempre.
    const result = await pool.query('SELECT id, nome, email FROM usuarios WHERE email = $1 ORDER BY criado_em ASC, id ASC', [emailNormalizado])
    if (result.rows.length === 0) return

    const usuario = result.rows[0]
    // Código de 6 caracteres hex maiúsculos (0-9 A-F, 3 bytes → 16^6 ≈ 16,8M) — É o que vai no
    // e-mail. Antes gravava o token de 64 chars mas mandava só os 6 primeiros em MAIÚSCULO,
    // então código digitado nunca casava. Agora guarda o HASH bcrypt do próprio código enviado
    // (não texto puro): um vazamento do banco não expõe o código, e a verificação é a mesma
    // bcrypt.compare das senhas.
    const codigo = crypto.randomBytes(3).toString('hex').toUpperCase()
    const codigoHash = await bcrypt.hash(codigo, 10)
    const expira = new Date(Date.now() + 3600000)

    await pool.query(
      `UPDATE usuarios SET reset_token = $1, reset_token_expira = $2 WHERE email = $3`,
      [codigoHash, expira, emailNormalizado]
    )

    await transporter.sendMail({
      from: `${MARCA} <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
      to: emailNormalizado,
      subject: `${MARCA} — Redefinição de senha`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #0a0a0a; margin: 0;">${MARCA}</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2>Olá, ${usuario.nome}!</h2>
            <p>Seu código de redefinição é:</p>
            <div style="background: #0a0a0a; color: #E8833A; font-size: 32px; font-weight: bold; text-align: center; padding: 20px; border-radius: 8px; letter-spacing: 8px; margin: 20px 0;">
              ${codigo}
            </div>
            <p style="color: #666; font-size: 13px;">Este código expira em 1 hora.</p>
            <p><strong>Equipe ${MARCA}</strong></p>
          </div>
        </div>
      `
    })
  } catch (err) {
    console.error('Erro ao processar esqueci senha:', err)
  }
}

// Consome o código enviado por esqueciSenha e redefine a senha. Público (o usuário está
// deslogado). Anti-enumeração: código errado, expirado, sem token e e-mail inexistente
// devolvem a MESMA resposta genérica, e a comparação bcrypt roda SEMPRE (contra HASH_FICTICIO
// quando não há alvo) para não vazar existência pelo tempo — mesma filosofia de login/esqueci.
const redefinirSenha = async (req, res) => {
  const GENERICO = { erro: 'Código inválido ou expirado. Solicite um novo.' }
  try {
    const { email, codigo, nova_senha } = req.body
    if (!email || !codigo || !nova_senha) {
      return res.status(400).json({ erro: 'Informe e-mail, código e a nova senha' })
    }
    // MESMA regra do cadastro (authController cadastrar: senha.length < 8).
    if (nova_senha.length < 8) {
      return res.status(400).json({ erro: 'A senha deve ter pelo menos 8 caracteres' })
    }
    const emailNorm = email.toLowerCase().trim()
    const codigoNorm = String(codigo).toUpperCase().trim()

    // Brute force: conta ANTES de checar o código e conta até para e-mail SEM conta (chave por
    // e-mail submetido, sem FK), então o 429 não vira oráculo de existência. 5/15min: dentro da
    // 1h de validade do código dá ~20 tentativas contra ~16,8M combinações — inviável — sem
    // trancar quem erra a digitação algumas vezes.
    const tentativa = await registrarTentativa('reset_confirmar', emailNorm)
    if (tentativa.excedeu) {
      return res.status(429).json({ erro: `Muitas tentativas. Tente novamente em ${Math.ceil(tentativa.segundosRestantes / 60)} minuto(s).` })
    }

    const result = await pool.query(
      'SELECT id, reset_token, reset_token_expira FROM usuarios WHERE email = $1 ORDER BY criado_em ASC, id ASC', [emailNorm]
    )
    // Múltiplas contas: o código é o mesmo em todas as linhas do e-mail (esqueciSenha grava
    // em todas). Uma conta criada DEPOIS do pedido nasce sem token, por isso a primeira linha
    // COM token — com uma conta só, é a rows[0] de antes.
    const usuario = result.rows.find(u => u.reset_token) || result.rows[0]
    const naoExpirou = usuario?.reset_token_expira && new Date(usuario.reset_token_expira) > new Date()
    const hashAlvo = (usuario?.reset_token && naoExpirou) ? usuario.reset_token : HASH_FICTICIO
    const ok = await bcrypt.compare(codigoNorm, hashAlvo)
    if (!ok) return res.status(400).json(GENERICO)

    const novaHash = await bcrypt.hash(nova_senha, 10)
    // Limpa o token (uso único), incrementa token_version (revoga sessões antigas — D51).
    // Em TODAS as linhas do e-mail: uma senha por e-mail (múltiplas contas).
    const redefinidas = await pool.query(
      `UPDATE usuarios SET senha_hash = $1, reset_token = NULL, reset_token_expira = NULL,
              token_version = token_version + 1 WHERE email = $2 RETURNING id`,
      [novaHash, emailNorm]
    )
    redefinidas.rows.forEach(u => invalidarCacheAssinatura(u.id))
    await limparTentativas('reset_confirmar', emailNorm)
    res.json({ mensagem: 'Senha redefinida com sucesso. Faça login com a nova senha.' })
  } catch (err) {
    console.error('Erro ao redefinir senha:', err.message)
    res.status(500).json({ erro: 'Erro ao redefinir senha' })
  }
}

// Admin (superadmin) redefine a senha de um usuário. GERA uma senha temporária e a devolve UMA
// vez na resposta, em vez de o admin digitar uma: senha alta-entropia, sem reuso e sem o admin
// precisar inventar/ver a antiga — ele repassa ao usuário, que troca depois. NUNCA age sobre
// outro admin. Incrementa token_version (revoga sessões do alvo).
const resetarSenhaUsuario = async (req, res) => {
  try {
    const { id } = req.params
    const alvo = await pool.query('SELECT id, role, nome FROM usuarios WHERE id = $1', [id])
    if (alvo.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })
    if (alvo.rows[0].role === 'admin') {
      return res.status(403).json({ erro: 'Não é possível redefinir a senha de um administrador por aqui.' })
    }
    // Alfabeto sem caracteres ambíguos (0/O, 1/l/I) — o admin lê/repassa a senha.
    const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz'
    const novaSenha = Array.from(crypto.randomBytes(12)).map(b => ALFABETO[b % ALFABETO.length]).join('')
    const hash = await bcrypt.hash(novaSenha, 10)
    // Em TODAS as linhas do e-mail do alvo: uma senha por e-mail (múltiplas contas). Nunca
    // alcança um admin — conta admin não divide e-mail (trigger usuarios_email_admin_exclusivo)
    // e o alvo admin já foi recusado acima.
    const redefinidas = await pool.query(
      `UPDATE usuarios SET senha_hash = $1, reset_token = NULL, reset_token_expira = NULL,
              token_version = token_version + 1
        WHERE email = (SELECT email FROM usuarios WHERE id = $2) RETURNING id`,
      [hash, id]
    )
    redefinidas.rows.forEach(u => invalidarCacheAssinatura(u.id))
    res.json({
      mensagem: 'Senha redefinida. Entregue esta senha ao usuário — ela aparece só uma vez.',
      usuario: alvo.rows[0].nome,
      senha_temporaria: novaSenha,
    })
  } catch (err) {
    console.error('Erro ao resetar senha do usuário:', err.message)
    res.status(500).json({ erro: 'Erro ao resetar senha' })
  }
}

// transporter exportado para o link de assinatura pela web usar o MESMO caminho de e-mail do reset.
module.exports = { cadastrar, login, perfil, atualizarPerfil, alterarSenha, esqueciSenha, redefinirSenha, resetarSenhaUsuario, transporter }