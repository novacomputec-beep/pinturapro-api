const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { pool } = require('../utils/supabase')
const { invalidarCacheAssinatura } = require('../middlewares/auth')
const { registrarTentativa, limparTentativas } = require('../utils/tentativasAuth')
const { MARCA } = require('../utils/marca')
const { validarEspecialidades } = require('../utils/especialidades')
// pode_obras / pode_servicos / tem_candidaturas / tem_interesses das respostas de sessão e perfil
// (Fases 2a e 2b — utils/capacidadeObras), por PESSOA: contas profissionais do mesmo CPF.
const { podeObras, podeServicos, capacidadesDaPessoa } = require('../utils/capacidadeObras')
const { MAX_CONTAS_POR_EMAIL, sqlTipoConta, tipoDaLinha, tipoDeTipoConta, tipoDoCadastro, colunasDoTipo, multiplasContasAtivo, sqlDonoDaPessoa } = require('../utils/tipoConta')
const { registrarPlataforma, detectarPlataforma } = require('../utils/plataforma')
const { registrarReinstalacao } = require('../utils/desinstalacoes')
const { municipioExiste } = require('../utils/geoBusca')
const { normalizarCodigo, recalcularIndicador } = require('../utils/indicacoes')
const { temReferenciaPropria, ERRO_REFERENCIA_PROPRIA, erroTelefoneReferencias, camposReferencias } = require('../utils/referencias')
// Resumo de avaliações + selo "bem avaliado" no perfil do profissional (utils/etiquetasAvaliacao).
const { sqlSeloBemAvaliado } = require('../utils/etiquetasAvaliacao')
// Login social (Google/Apple): verificação dos tokens e ticket de cadastro (services/loginSocialService).
const social = require('../services/loginSocialService')
const cfgSocial = require('../config/loginSocial')
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

// Nome com '@' é e-mail digitado no campo errado (o padrão de e-mail já contém '@', então
// um teste só cobre os dois casos). Vale nos DOIS caminhos de escrita de usuarios.nome:
// cadastro e PUT /auth/perfil.
const ERRO_NOME_PARECE_EMAIL = 'Digite seu nome, não o e-mail.'
const nomePareceEmail = (nome) => typeof nome === 'string' && nome.includes('@')

const cadastrar = async (req, res) => {
  const ts = new Date().toISOString()
  let client
  try {
    const { nome, telefone, senha, cidade, uf,
            especialidades, anos_experiencia, tamanho_equipe,
            cpf_cnpj, tipo_conta, plano, pix_reembolso, referencias,
            verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url,
            rg, rg_orgao, rg_estado, cep, latitude, longitude,
            logradouro, numero, complemento, bairro, codigo_indicacao, ticket } = req.body
    let { email } = req.body

    // Cadastro via login social: `ticket` (JWT de 15 min devolvido por POST /auth/social quando o
    // e-mail não tinha conta) entra NO LUGAR da senha. O e-mail é o do ticket — o do corpo é
    // ignorado — e a linha nasce com google_sub/apple_sub preenchido. A senha gravada é um
    // hash de um segredo aleatório (ninguém entra por senha até "esqueci minha senha").
    let identidadeSocial = null
    if (ticket) {
      try {
        identidadeSocial = social.lerTicket(ticket)
      } catch (err) {
        console.log(`[CADASTRO][${ts}] ✗ 401 ticket social | ${err.message}`)
        return res.status(401).json({ erro: err.message, codigo: err.codigo || 'ticket_invalido' })
      }
      email = identidadeSocial.email
    }

    // TIPO da conta resolvido do corpo INTEIRO (utils/tipoConta.tipoDoCadastro): tipo_conta e
    // também tipo_dono / tipo_prestador / role que o app manda junto — dono de serviço enviado
    // como tipo_conta 'dono_obra' + tipo_dono 'reparo' é dono_reparo. Sem tipo reconhecido,
    // segue o legado: role 'assinante', sem tipo_dono/tipo_prestador.
    const tipoResolvido = tipoDoCadastro({ tipo_conta, tipo_dono: req.body.tipo_dono, tipo_prestador: req.body.tipo_prestador, role: req.body.role })
    // PRESENÇA, nunca o valor: email e cpf_cnpj saíam em claro para o stdout e ficavam
    // retidos no log da Railway. Mesmo estilo booleano já usado no log de campos obrigatórios
    // logo abaixo — o diagnóstico ("veio email?", "veio documento?") é preservado.
    console.log(`[CADASTRO][${ts}] ▶ inicio | tipo_conta=${tipo_conta} tipo_dono=${req.body.tipo_dono} tipo_prestador=${req.body.tipo_prestador} role=${req.body.role} tipo=${tipoResolvido} tem_email=${!!email} tem_cpf_cnpj=${!!cpf_cnpj} social=${identidadeSocial ? identidadeSocial.provedor : 'nao'} plano=${plano} tem_doc_frente=${!!verificacao_doc_frente_url} tem_doc_verso=${!!verificacao_doc_verso_url} tem_selfie=${!!verificacao_selfie_url}`)

    if (!nome || !email || (!senha && !identidadeSocial)) {
      console.log(`[CADASTRO][${ts}] ✗ 400 campos obrigatorios ausentes | nome=${!!nome} email=${!!email} senha=${!!senha}`)
      return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' })
    }
    if (nomePareceEmail(nome)) {
      console.log(`[CADASTRO][${ts}] ✗ 400 nome parece e-mail`)
      return res.status(400).json({ erro: ERRO_NOME_PARECE_EMAIL })
    }
    if (!identidadeSocial && senha.length < 8) {
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
    // Via ticket social não há senha: o hash é de 32 bytes aleatórios descartados (a coluna é
    // preenchida, o login por senha continua funcionando para as outras contas e esta só
    // ganha senha por "esqueci minha senha").
    let senha_hash = await bcrypt.hash(identidadeSocial ? crypto.randomBytes(32).toString('hex') : senha, 10)
    console.log(`[CADASTRO][${ts}] ✓ senha hash gerada`)

    // role / tipo_dono / tipo_prestador são o inverso do tipo resolvido (colunasDoTipo):
    // dono_obra → role dono_obra + tipo_dono 'pintura'; dono_reparo → dono_obra + 'reparo';
    // pintor/construtor → prestador + 'pintor'; prestador/reparador → prestador + 'reparador'.
    // Derivados ANTES da validação de especialidades porque tipo_prestador escolhe a lista
    // (obra × reparador). Tipo não reconhecido segue como sempre: role 'assinante',
    // tipo_dono/tipo_prestador null — nenhum default inventado aqui.
    const { role, tipo_dono, tipo_prestador } = colunasDoTipo(tipoResolvido) || { role: 'assinante', tipo_dono: null, tipo_prestador: null }

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

    // Verificação ADIADA: profissional que se cadastra SEM nenhuma das três fotos nasce
    // 'nao_solicitada' — entra, vê o feed e só precisa enviar documento + selfie
    // (POST /auth/verificacao) antes da primeira proposta/interesse (exigirVerificado).
    // Com qualquer foto no corpo (apps antigos), o fluxo de sempre: 'pendente' + fila.
    const semDocs = role === 'prestador'
      && !verificacao_doc_frente_url && !verificacao_doc_verso_url && !verificacao_selfie_url
    const verificacaoStatus = role === 'prestador' && !semDocs ? 'pendente' : 'nao_solicitada'
    const planoEscolhido = plano || 'mensal'

    // Referência própria (telefone igual ao do cadastro, ou nome igual/contido no nome
    // completo) é recusada antes de abrir a transação — regra única em utils/referencias.
    // Telefone repetido entre as referências ou igual ao do cadastro: mensagem própria.
    const erroTel = erroTelefoneReferencias(referencias, { telefone })
    if (erroTel) {
      console.log(`[CADASTRO][${ts}] ✗ 400 telefone de referencia repetido/proprio`)
      return res.status(400).json(erroTel)
    }
    if (temReferenciaPropria(referencias, { nome, telefone })) {
      console.log(`[CADASTRO][${ts}] ✗ 400 referencia propria`)
      return res.status(400).json(ERRO_REFERENCIA_PROPRIA)
    }

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
      const tipoNovo = tipoResolvido
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
      // Com ticket social a posse do e-mail já foi provada pelo provedor: não há senha a conferir.
      if (!identidadeSocial) {
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
      }
      senha_hash = existente.rows[0].senha_hash
      console.log(`[CADASTRO][${ts}] ✓ novo tipo para pessoa existente | tipo=${tipoNovo} contas_existentes=${existente.rows.length}`)
    }

    // Indicação (utils/indicacoes): só profissional nasce indicado, e só por um código que
    // existe e não é da própria pessoa (mesmo e-mail ou mesmo CPF normalizado — a outra conta
    // dela). Código ausente, malformado, inexistente ou próprio é IGNORADO em silêncio: nunca
    // barra o cadastro. O próprio código do novo profissional sai de gerar_codigo_indicacao().
    let indicadoPor = null
    const codigoIndicacao = role === 'prestador' ? normalizarCodigo(codigo_indicacao) : null
    if (codigoIndicacao) {
      const indicador = await client.query(
        `SELECT id FROM usuarios
          WHERE codigo_indicacao = $1
            AND LOWER(email) <> $2
            AND (NULLIF(regexp_replace(COALESCE(cpf_cnpj, ''), '[^0-9]', '', 'g'), '') IS DISTINCT FROM $3::text OR $3::text IS NULL)`,
        [codigoIndicacao, emailNormalizado, cpfLimpo || null]
      )
      indicadoPor = indicador.rows[0]?.id || null
      console.log(`[CADASTRO][${ts}] ${indicadoPor ? '✓ código de indicação aceito' : '· código de indicação ignorado'}`)
    }

    console.log(`[CADASTRO][${ts}] ▶ INSERT usuarios | role=${role} tipo_dono=${tipo_dono} tipo_prestador=${tipo_prestador} verificacao_status=${verificacaoStatus}`)
    const result = await client.query(
      `INSERT INTO usuarios (nome, email, telefone, senha_hash, cidade, uf,
        especialidades, anos_experiencia, tamanho_equipe, cpf_cnpj, role, ativo,
        tipo_dono, pix_reembolso, referencias,
        verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url,
        verificacao_status, rg, rg_orgao, rg_estado, tipo_prestador, cep, latitude, longitude,
        logradouro, numero, complemento, bairro, indicado_por, codigo_indicacao, google_sub, apple_sub)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
               $30, CASE WHEN $31::boolean THEN gerar_codigo_indicacao() ELSE NULL END, $32, $33)
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
       logradouro || null, numero || null, complemento || null, bairro || null,
       indicadoPor, role === 'prestador',
       identidadeSocial?.provedor === 'google' ? identidadeSocial.sub : null,
       identidadeSocial?.provedor === 'apple' ? identidadeSocial.sub : null]
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
      if (lancamentoGratis && semDocs) {
        // Janela de lançamento + verificação adiada: não há o que aguardar, a assinatura já
        // nasce 'ativa' (feed liberado). A idoneidade é cobrada na proposta, não aqui.
        // tipo='gratuito' e valor_mensal REAL como no ramo abaixo, para o backfill do
        // desligamento da janela (SQL_BACKFILL_LANCAMENTO) pegar esta linha igual às outras.
        console.log(`[CADASTRO][${ts}] ▶ INSERT assinatura prestador GRATIS sem docs (lançamento) | usuario_id=${usuario.id} plano=${planoEscolhido} valor=${valorMensal}`)
        await client.query(
          `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo)
           VALUES ($1, $2, $3, 'ativa', 'gratuito')`,
          [usuario.id, planoEscolhido, valorMensal]
        )
        console.log(`[CADASTRO][${ts}] ✓ assinatura ativa gratuita criada (verificação adiada) | valor=${valorMensal}`)
      } else if (lancamentoGratis) {
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
    // O app entra com este usuario (loginComToken) até reler o perfil: mesmos campos de
    // referências do GET /auth/perfil, calculados do que acabou de ser gravado.
    Object.assign(usuario, camposReferencias(referencias || [], usuario))
    // Mesmos campos do login (montarSessao), por PESSOA: a conta nova pode ser a 2ª conta
    // profissional de um CPF (múltiplas contas) e herdar capacidade/propostas da irmã. Já houve
    // COMMIT: se a leitura falhar, cai no cálculo local do que acabou de ser gravado em vez de
    // responder 500 a um cadastro feito.
    const linhaNova = { role, tipo_prestador, especialidades: espCadastro.valor }
    Object.assign(usuario,
      { pode_obras: podeObras(linhaNova), pode_servicos: podeServicos(linhaNova), tem_candidaturas: false, tem_interesses: false },
      await capacidadesDaPessoa(usuario.id).catch(() => ({})))
    console.log(`[CADASTRO][${ts}] ✓ commit ok — token gerado | usuario_id=${usuario.id} — respondendo 201`)
    res.status(201).json({ usuario, token, assinatura })
    registrarPlataforma(usuario.id, req)

    // E-mails especiais de teste — aprovação automática imediata (configurar via EMAILS_ESPECIAIS no Railway)
    const emailsEspeciais = (process.env.EMAILS_ESPECIAIS || '')
      .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    if (emailsEspeciais.length > 0 && emailsEspeciais.includes(emailNormalizado)) {
      setImmediate(async () => {
        try {
          await pool.query(`UPDATE usuarios SET verificacao_status = 'aprovado', aprovado_automaticamente = true WHERE id = $1`, [usuario.id])
          await pool.query(`UPDATE assinaturas SET status = 'ativa', tipo = 'gratuito', atualizado_em = NOW() WHERE usuario_id = $1`, [usuario.id])
          recalcularIndicador(usuario.id)
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

    // Convite para o canal do WhatsApp — só profissional (reparador ou pintor/construtor)
    // da cidade do canal (o serviço compara cidade/UF e pula quem está fora, sem gravar),
    // DEPOIS do COMMIT e da resposta 201, fire-and-forget: o serviço nunca lança (grava
    // convites_canal antes de enviar; e-mail já convidado não recebe de novo), e qualquer
    // erro fica só no log — o cadastro já está feito e respondido.
    // uf vem do body (o RETURNING do INSERT não o devolve); é o mesmo valor gravado acima.
    if (usuario.role === 'prestador' || usuario.role === 'pintor') {
      setImmediate(async () => {
        try {
          const { enviarConviteCanal } = require('../services/conviteCanalService')
          const resultado = await enviarConviteCanal(usuario.email, usuario.nome, usuario.cidade, uf)
          console.log(`[ConviteCanal] cadastro ${usuario.id}: ${resultado}`)
        } catch (err) {
          console.error('[ConviteCanal] erro no convite pós-cadastro:', err.message)
        }
      })
    }

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
      'SELECT id, nome, email, telefone, cidade, role, senha_hash, ativo, foto_url, tipo_dono, tipo_prestador, boas_vindas_exibida, token_version, verificacao_status, referencias FROM usuarios WHERE email = $1 ORDER BY criado_em ASC, id ASC',
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

    await responderSessao(usuario, req, res, contas)

  } catch (err) {
    console.error('Erro no login:', err)
    res.status(500).json({ erro: 'Erro ao fazer login' })
  }
}

// Último passo do login (senha ou social), depois de a identidade estar provada: admin com 2FA
// ligado recebe { requer_2fa, temp_token } (POST /admin/2fa/login-verificar fecha a sessão);
// todo o resto recebe o payload de sessão de montarSessao. Os dois logins passam por aqui para
// a resposta ser byte a byte a mesma.
const responderSessao = async (usuario, req, res, contas) => {
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
  res.json(await montarSessao(usuario, req, contas))
}

// POST /auth/social { provedor: 'google'|'apple', id_token, nome?, tipo? }
// 1. Verifica o token no provedor (services/loginSocialService): Google exige email_verified;
//    Apple é o identity token RS256 contra as chaves públicas da Apple (iss/aud/exp).
// 2. Procura contas PRIMEIRO pelo sub do provedor (google_sub/apple_sub); só depois pelo
//    e-mail verificado — e um e-mail de relay privado da Apple nunca vincula por e-mail.
// 3. Com contas: grava o sub nelas e responde EXATAMENTE como o login por senha (mesma escolha
//    por `tipo` com múltiplas contas, mesma lista `contas`, mesma regra de 2FA do admin).
// 4. Sem contas: { novo: true, nome, email, ticket } — o ticket (15 min) entra no lugar da
//    senha em POST /auth/cadastro, que grava o sub na conta nova.
// Sem contador de tentativas: não há senha a adivinhar; o teto por IP está em server.js.
const loginSocial = async (req, res) => {
  const ts = new Date().toISOString()
  try {
    const { provedor, id_token, nome, tipo } = req.body || {}
    if (!cfgSocial.PROVEDORES.includes(provedor)) {
      return res.status(400).json({ erro: "provedor deve ser 'google' ou 'apple'", codigo: 'provedor_invalido' })
    }
    if (!id_token || typeof id_token !== 'string') {
      return res.status(400).json({ erro: 'id_token é obrigatório', codigo: 'id_token_obrigatorio' })
    }

    let identidade
    try {
      identidade = await social.verificar(provedor, id_token)
    } catch (err) {
      if (err instanceof social.ErroLoginSocial) {
        console.log(`[LOGIN SOCIAL][${ts}] ✗ 401 ${provedor} | ${err.codigo}: ${err.message}`)
        return res.status(401).json({ erro: 'Não foi possível validar o login com ' + (provedor === 'google' ? 'Google' : 'Apple') + '.', codigo: err.codigo })
      }
      throw err
    }

    const coluna = social.colunaSub(provedor)
    const relay = social.ehEmailRelayApple(identidade.email)
    // E-mail "âncora" das contas: o das linhas já vinculadas ao sub (prioridade — o e-mail da
    // conta pode ter mudado no app) ou, sem vínculo, o e-mail verificado pelo provedor.
    const porSub = await pool.query(
      `SELECT email FROM usuarios WHERE ${coluna} = $1 ORDER BY criado_em ASC, id ASC LIMIT 1`,
      [identidade.sub]
    )
    const emailConta = porSub.rows[0]?.email
      || (identidade.email && identidade.email_verificado && !relay ? identidade.email : null)
    console.log(`[LOGIN SOCIAL][${ts}] ▶ ${provedor} | por_sub=${porSub.rows.length > 0} tem_email=${!!identidade.email} relay=${relay}`)

    const linhas = emailConta
      ? (await pool.query(
          `SELECT ${COLUNAS_SESSAO} FROM usuarios WHERE email = $1 ORDER BY criado_em ASC, id ASC`,
          [emailConta]
        )).rows
      : []

    if (linhas.length === 0) {
      if (!identidade.email) {
        console.log(`[LOGIN SOCIAL][${ts}] ✗ 400 ${provedor} sem e-mail e sem conta vinculada`)
        return res.status(400).json({ erro: 'O provedor não informou um e-mail. Cadastre-se com e-mail e senha.', codigo: 'email_ausente' })
      }
      const nomeNovo = (typeof nome === 'string' && nome.trim() && !nomePareceEmail(nome)) ? nome.trim() : (identidade.nome || null)
      console.log(`[LOGIN SOCIAL][${ts}] · ${provedor} sem conta → ticket de cadastro`)
      return res.json({
        novo: true,
        nome: nomeNovo,
        email: identidade.email,
        ticket: social.gerarTicket({ provedor, sub: identidade.sub, email: identidade.email, nome: nomeNovo }),
      })
    }

    // Vincula o sub a TODAS as contas do e-mail (a identidade é da pessoa, não de um perfil) —
    // só grava onde ainda não está, então um login repetido não escreve nada.
    await pool.query(
      `UPDATE usuarios SET ${coluna} = $1 WHERE email = $2 AND ${coluna} IS DISTINCT FROM $1`,
      [identidade.sub, emailConta]
    )

    // Daqui em diante, a MESMA regra do login por senha (sem o bcrypt): só conta ativa; com 2+
    // ativas entra a do `tipo` pedido ou a mais antiga; tipo sem conta → 404 com `contas`.
    const ativas = linhas.filter(u => u.ativo)
    if (ativas.length === 0) {
      return res.status(403).json({ erro: 'Conta desativada' })
    }
    const tipoPedido = ativas.length > 1 ? tipoDeTipoConta(tipo) : null
    const escolhida = tipoPedido ? ativas.find(u => tipoDaLinha(u) === tipoPedido) : ativas[0]
    const contas = ativas.map(u => ({ id: u.id, tipo: tipoDaLinha(u), nome: u.nome }))
    if (!escolhida) {
      return res.status(404).json({ erro: 'Não há conta deste tipo para este e-mail.', codigo: 'conta_tipo_inexistente', contas })
    }
    console.log(`[LOGIN SOCIAL][${ts}] ✓ ${provedor} | usuario_id=${escolhida.id} contas=${contas.length}`)
    await responderSessao(escolhida, req, res, contas)
  } catch (err) {
    console.error(`[LOGIN SOCIAL][${ts}] erro:`, err)
    res.status(500).json({ erro: 'Erro ao fazer login' })
  }
}

// Colunas que o payload de sessão precisa (login, trocar-conta e a conta vinculada de
// POST /auth/contas/:tipo leem a MESMA lista, para o `usuario` sair igual nos três).
const COLUNAS_SESSAO = 'id, nome, email, telefone, cidade, role, senha_hash, ativo, foto_url, tipo_dono, tipo_prestador, boas_vindas_exibida, token_version, verificacao_status, referencias, criado_em'

// Payload de sessão de UMA conta — exatamente o que o login sempre devolveu: usuario,
// assinatura (a melhor linha), token (gerarToken) e, só com 2+ contas ativas no e-mail, a
// lista `contas`. Efeitos colaterais do login (plataforma, reinstalação) vêm junto, porque a
// troca de conta é um login sem senha: a conta alvo passa a ser a sessão do aparelho.
// `contas` = [{ id, tipo, nome }] das contas ATIVAS do e-mail (quem chama já as leu).
const montarSessao = async (usuario, req, contas = []) => {
  const assinaturaResult = await pool.query(
    `SELECT status, tipo, plano, proximo_vencimento, valor_mensal FROM assinaturas
     WHERE usuario_id = $1
     ORDER BY CASE status WHEN 'ativa' THEN 1 WHEN 'pendente' THEN 2 ELSE 3 END, criado_em DESC
     LIMIT 1`,
    [usuario.id]
  )

  // pode_obras / pode_servicos / tem_candidaturas / tem_interesses: lidos do BANCO (não da linha
  // recebida — nem todo chamador traz especialidades, ex.: o RETURNING da conta vinculada), com as
  // MESMAS expressões do público do push, e por PESSOA (contas profissionais do mesmo CPF —
  // Fase 2b). Campos EXTRAS em `usuario`: app antigo ignora e segue decidindo as abas por
  // tipo_prestador; o app novo mostra Obras por pode_obras e Serviços por pode_servicos.
  const capacidade = await capacidadesDaPessoa(usuario.id)

  const token = gerarToken(usuario)
  registrarPlataforma(usuario.id, req)
  // Login vindo do APP (não do painel/site no navegador) fecha a desinstalação provável.
  if (detectarPlataforma(req)) registrarReinstalacao(usuario.id)

  return {
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
      boas_vindas_exibida: usuario.boas_vindas_exibida ?? false,
      verificacao_status: usuario.verificacao_status || 'nao_solicitada',
      ...capacidade,
      // O app usa ESTE usuario até a próxima releitura do perfil (boot/revalidarSessao): sem
      // os campos aqui, "Minhas referências" ficava escondido logo depois do login.
      ...camposReferencias(usuario.referencias, usuario),
    },
    assinatura: assinaturaResult.rows[0] || null,
    token,
    // Campo EXTRA, só quando o e-mail tem 2+ contas ativas — com uma conta a resposta é
    // byte a byte a de antes. O app novo usa para oferecer a troca (POST /auth/trocar-conta).
    ...(contas.length > 1 ? { contas } : {})
  }
}

// Contas ATIVAS do e-mail (uma por tipo), mais antiga primeiro — a mesma ordem do login.
// Linhas completas (COLUNAS_SESSAO) para trocarConta montar a sessão da escolhida sem reler.
const contasDoEmail = async (email) => {
  const r = await pool.query(
    `SELECT ${COLUNAS_SESSAO} FROM usuarios WHERE email = $1 AND ativo = true ORDER BY criado_em ASC, id ASC`,
    [email]
  )
  return r.rows
}
const resumoContas = (linhas) => linhas.map(u => ({ id: u.id, tipo: tipoDaLinha(u), nome: u.nome }))

// POST /auth/trocar-conta (autenticado, body { tipo }): sessão da conta ATIVA do MESMO e-mail
// com aquele tipo, com o payload do login. Não pede senha: ela é UMA por e-mail e já foi provada
// pela sessão atual; trocar de perfil é só escolher outra linha da mesma pessoa. Admin nunca
// divide e-mail (trigger), então fica fora dos dois lados. Tipo sem conta → 404 com a lista
// `contas`, como o login com `tipo` errado. Trocar para o próprio tipo só renova o token.
const trocarConta = async (req, res) => {
  try {
    const tipoPedido = tipoDeTipoConta(req.body?.tipo)
    if (!tipoPedido) {
      return res.status(400).json({ erro: 'Tipo de conta inválido', codigo: 'tipo_invalido' })
    }
    if (req.usuario.role === 'admin') {
      return res.status(403).json({ erro: 'Sem permissão para esta ação' })
    }
    const linhas = (await contasDoEmail(req.usuario.email.toLowerCase().trim())).filter(u => u.role !== 'admin')
    const alvo = linhas.find(u => tipoDaLinha(u) === tipoPedido)
    const contas = resumoContas(linhas)
    if (!alvo) {
      return res.status(404).json({ erro: 'Não há conta deste tipo para este e-mail.', codigo: 'conta_tipo_inexistente', contas })
    }
    res.json(await montarSessao(alvo, req, contas))
  } catch (err) {
    console.error('Erro ao trocar conta:', err)
    res.status(500).json({ erro: 'Erro ao trocar de conta' })
  }
}

// pode_obras / pode_servicos / tem_candidaturas / tem_interesses (Fases 2a e 2b): as capacidades
// e o histórico de propostas da PESSOA no lado profissional (contas 'prestador' do mesmo CPF —
// utils/capacidadeObras.capacidadesDaPessoa). Mesmos valores de `usuario` no login e no perfil.
// GET /auth/contas (autenticado): { contas: [{ id, tipo, nome }], tem_obras }. `contas` é a MESMA
// lista do login/trocar-conta (contas ativas do e-mail, sem admin). `tem_obras` é por PESSOA
// (mesmo CPF, qualquer conta — utils/tipoConta.sqlDonoDaPessoa): com o lado contratante unificado
// um dono_reparo vê e gerencia as obras da sua conta de pintura, então o app só esconde a aba
// Mensagens (chat de obra) de quem nunca abriu obra em conta nenhuma. Conta qualquer status de
// obra: uma cancelada ainda pode ter conversa.
const listarContas = async (req, res) => {
  try {
    const linhas = req.usuario.role === 'admin'
      ? []
      : (await contasDoEmail(String(req.usuario.email || '').toLowerCase().trim())).filter(u => u.role !== 'admin')
    const obras = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM obras WHERE ${sqlDonoDaPessoa('criado_por', '$1')}) AS tem`,
      [req.usuario.id]
    )
    const capacidade = await capacidadesDaPessoa(req.usuario.id)
    res.json({ contas: resumoContas(linhas), tem_obras: obras.rows[0]?.tem === true, ...capacidade })
  } catch (err) {
    console.error('Erro ao listar contas:', err)
    res.status(500).json({ erro: 'Erro ao listar contas' })
  }
}

const perfil = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nome, email, telefone, cidade, especialidades, anos_experiencia, tamanho_equipe, role, foto_url, tipo_dono, tipo_prestador, boas_vindas_exibida, aceita_promocoes, verificacao_status, referencias FROM usuarios WHERE id = $1',
      [req.usuario.id]
    )
    const assinaturaResult = await pool.query(
      `SELECT plano, status, tipo, proximo_vencimento, valor_mensal FROM assinaturas
       WHERE usuario_id = $1
       ORDER BY CASE status WHEN 'ativa' THEN 1 WHEN 'pendente' THEN 2 ELSE 3 END, criado_em DESC LIMIT 1`,
      [req.usuario.id]
    )
    registrarPlataforma(req.usuario.id, req)
    const usuario = result.rows[0]
    // tem_referencias / referencias_problema (null | 'propria' | 'repetido'): o app decide se
    // mostra "trocar referências" (PUT /auth/referencias) e se avisa de uma gravada antes da
    // regra atual. A lista em si não sai aqui — GET /auth/referencias.
    if (usuario) {
      Object.assign(usuario, camposReferencias(usuario.referencias, usuario))
      delete usuario.referencias
      // Mesmos campos do login (montarSessao): abas Obras/Serviços por capacidade, "Minhas
      // candidaturas"/"Meus interesses" por histórico — por PESSOA, lidos do banco.
      Object.assign(usuario, await capacidadesDaPessoa(usuario.id))
    }
    // Profissional: resumo das avaliações recebidas + selo "bem avaliado" (3× 5★) no payload
    // do perfil, para o app mostrar sem segunda chamada. Dono/admin não recebem o bloco.
    if (usuario && usuario.role === 'prestador') {
      const av = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COALESCE(ROUND(AVG(estrelas)::numeric, 1), 0) AS media,
                COUNT(*) FILTER (WHERE estrelas = 5)::int AS cinco_estrelas,
                ${sqlSeloBemAvaliado('$1::uuid')} AS selo_bem_avaliado
           FROM avaliacoes WHERE avaliado_id = $1`,
        [req.usuario.id]
      )
      const a = av.rows[0]
      usuario.avaliacoes = { total: a.total, media: parseFloat(a.media), cinco_estrelas: a.cinco_estrelas }
      usuario.selo_bem_avaliado = a.selo_bem_avaliado
    }
    // Múltiplas contas: TODAS as contas ativas do e-mail ({ id, tipo, nome }), a atual incluída,
    // para o Perfil oferecer "trocar perfil" (POST /auth/trocar-conta) e "adicionar perfil"
    // (POST /auth/contas/:tipo) nos tipos que faltam. Sempre presente (1+ itens).
    const contas = usuario ? resumoContas(await contasDoEmail(usuario.email)) : []
    res.json({ usuario, assinatura: assinaturaResult.rows[0] || null, contas })
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
    if (mexeNome && nomePareceEmail(nome)) {
      return res.status(400).json({ erro: ERRO_NOME_PARECE_EMAIL })
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

    // cidade precisa ser um município brasileiro de verdade (dataset IBGE em memória,
    // src/data/municipios-br.json — a mesma lista do SeletorLocalidade do app). Antes
    // qualquer texto não-vazio era gravado, e cidade inexistente tira o usuário do feed e
    // dos alertas por cidade. Só valida quando vem valor: chave ausente, null ou em branco
    // continuam significando "não mexe". Com uf no body o par cidade+uf tem de existir;
    // sem uf basta o nome existir em algum estado.
    if (mexeCidade && cidade != null && (typeof cidade !== 'string' || cidade.trim())) {
      const ufInformada = typeof uf === 'string' ? uf.trim() : ''
      if (typeof cidade !== 'string' || !municipioExiste(cidade, ufInformada)) {
        return res.status(400).json({
          erro: ufInformada
            ? 'Cidade inválida: selecione um município existente no estado informado'
            : 'Cidade inválida: selecione um município brasileiro existente',
          codigo: 'cidade_invalida'
        })
      }
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
    const salvo = result.rows[0]
    // Especialidades mudam as CAPACIDADES (reparador que marca/tira especialidade de obra, pintor
    // que marca/tira especialidade de serviço): o cache de `autenticar` guarda a lista antiga por
    // até 30s, e os gates exigirPodeObras / exigirPodeServicos a leriam. Limpa nesta réplica; nas
    // outras, o gate reconfere a negativa no banco antes do 403.
    if (mexeEspecialidades) invalidarCacheAssinatura(req.usuario.id)
    // pode_obras / pode_servicos já na resposta do save (campos extras): o app liga/desliga as abas
    // sem reler o perfil. Por PESSOA, como no login; se a leitura falhar, vale o cálculo da conta.
    if (salvo) {
      const linhaSalva = { role: req.usuario.role, tipo_prestador: req.usuario.tipo_prestador, especialidades: salvo.especialidades }
      const cap = await capacidadesDaPessoa(req.usuario.id).catch(() => null)
      salvo.pode_obras = cap ? cap.pode_obras : podeObras(linhaSalva)
      salvo.pode_servicos = cap ? cap.pode_servicos : podeServicos(linhaSalva)
    }
    res.json(salvo)
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
// gerarToken / montarSessao / contasDoEmail / resumoContas: exportados para POST /auth/contas/:tipo
// (routes/index.js) devolver a sessão da conta vinculada recém-criada com o MESMO payload do login.
module.exports = { cadastrar, login, loginSocial, trocarConta, listarContas, perfil, atualizarPerfil, alterarSenha, esqueciSenha, redefinirSenha, resetarSenhaUsuario, transporter, gerarToken, montarSessao, contasDoEmail, resumoContas }