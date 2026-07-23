const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { pool } = require('../utils/supabase')
const nodemailer = require('nodemailer')
const crypto = require('crypto')

const gerarToken = (usuario) => jwt.sign(
  { id: usuario.id, role: usuario.role },
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

    console.log(`[CADASTRO][${ts}] ▶ inicio | tipo_conta=${tipo_conta} email=${email} cpf_cnpj=${cpf_cnpj} plano=${plano} tem_doc_frente=${!!verificacao_doc_frente_url} tem_doc_verso=${!!verificacao_doc_verso_url} tem_selfie=${!!verificacao_selfie_url}`)

    if (!nome || !email || !senha) {
      console.log(`[CADASTRO][${ts}] ✗ 400 campos obrigatorios ausentes | nome=${!!nome} email=${!!email} senha=${!!senha}`)
      return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' })
    }
    if (senha.length < 8) {
      console.log(`[CADASTRO][${ts}] ✗ 400 senha curta | len=${senha.length}`)
      return res.status(400).json({ erro: 'A senha deve ter pelo menos 8 caracteres' })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      console.log(`[CADASTRO][${ts}] ✗ 400 email invalido | email=${email}`)
      return res.status(400).json({ erro: 'E-mail inválido' })
    }

    const emailNormalizado = email.toLowerCase().trim()

    // Hash FORA da transação: o bcrypt nativo roda na threadpool do libuv (não
    // bloqueia o event loop), então não seguramos uma conexão/lock do Postgres
    // durante o custo de CPU do hash — a transação abaixo fica curta.
    console.log(`[CADASTRO][${ts}] ▶ gerando hash de senha`)
    const senha_hash = await bcrypt.hash(senha, 10)
    console.log(`[CADASTRO][${ts}] ✓ senha hash gerada`)

    let role = 'assinante'
    if (tipo_conta === 'dono_obra') role = 'dono_obra'
    else if (tipo_conta === 'prestador' || tipo_conta === 'pintor' || tipo_conta === 'construtor') role = 'prestador'

    // Define tipo_dono para distinguir donos de pintura vs reparo
    let tipo_dono = null
    if (tipo_conta === 'dono_obra') tipo_dono = 'pintura'
    else if (tipo_conta === 'dono_reparo') { role = 'dono_obra'; tipo_dono = 'reparo' }

    // Define tipo_prestador para distinguir pintores/construtores de reparadores
    let tipo_prestador = null
    if (tipo_conta === 'pintor' || tipo_conta === 'construtor') tipo_prestador = 'pintor'
    else if (tipo_conta === 'prestador') tipo_prestador = 'reparador'

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

    // Pré-checagens amigáveis DENTRO da transação (mensagem limpa). Em corrida
    // real, o índice único (email + cpf_cnpj normalizado) é a garantia final e
    // cai no handler de 23505 abaixo.
    console.log(`[CADASTRO][${ts}] ▶ verificando email no banco | email=${emailNormalizado}`)
    const existente = await client.query('SELECT id FROM usuarios WHERE email = $1', [emailNormalizado])
    if (existente.rows.length > 0) {
      await client.query('ROLLBACK')
      console.log(`[CADASTRO][${ts}] ✗ 409 email duplicado | email=${emailNormalizado}`)
      return res.status(409).json({ erro: 'Este e-mail já está cadastrado.', codigo: 'email_duplicado' })
    }
    console.log(`[CADASTRO][${ts}] ✓ email disponivel`)

    if (cpf_cnpj) {
      const cpfLimpo = cpf_cnpj.replace(/\D/g, '')
      console.log(`[CADASTRO][${ts}] ▶ verificando cpf_cnpj no banco | cpfLimpo=${cpfLimpo}`)
      const cpfExistente = await client.query(
        `SELECT id FROM usuarios WHERE regexp_replace(cpf_cnpj, '[^0-9]', '', 'g') = $1`,
        [cpfLimpo]
      )
      if (cpfExistente.rows.length > 0) {
        await client.query('ROLLBACK')
        console.log(`[CADASTRO][${ts}] ✗ 409 cpf_cnpj duplicado | cpfLimpo=${cpfLimpo}`)
        return res.status(409).json({ erro: 'Este CPF/CNPJ já está cadastrado.', codigo: 'cpf_duplicado' })
      }
      console.log(`[CADASTRO][${ts}] ✓ cpf_cnpj disponivel`)
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
       especialidades || [], anos_experiencia || 0,
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
      `SELECT status, plano, proximo_vencimento, valor_mensal FROM assinaturas WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
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
    const { email, senha } = req.body

    if (!email || !senha) {
      return res.status(400).json({ erro: 'E-mail e senha são obrigatórios' })
    }

    const emailNormalizado = email.toLowerCase().trim()

    const result = await pool.query(
      'SELECT id, nome, email, telefone, cidade, role, senha_hash, ativo, foto_url, tipo_dono, tipo_prestador, boas_vindas_exibida FROM usuarios WHERE email = $1',
      [emailNormalizado]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' })
    }

    const usuario = result.rows[0]

    if (!usuario.ativo) {
      return res.status(403).json({ erro: 'Conta desativada' })
    }

    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash)
    if (!senhaValida) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' })
    }

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
      `SELECT status, plano, proximo_vencimento, valor_mensal FROM assinaturas
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
      token
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
      `SELECT plano, status, proximo_vencimento, valor_mensal FROM assinaturas
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

    if (!nome || !nome.trim()) {
      return res.status(400).json({ erro: 'Nome é obrigatório' })
    }

    // cidade/uf são não-destrutivos: só sobrescrevem quando vem valor não-vazio.
    // Antes o UPDATE gravava cidade incondicionalmente, então salvar o perfil com o
    // campo em branco (a tela valida só o nome) APAGAVA a cidade do usuário — e cidade
    // vazia degrada o feed inteiro (o filtro geográfico não resolve e a busca perde o
    // recorte). NULLIF(btrim($n), '') transforma ausente/em branco em NULL e o COALESCE
    // mantém o valor já gravado.
    const result = await pool.query(
      `UPDATE usuarios SET nome = $1, telefone = $2,
              cidade = COALESCE(NULLIF(btrim($3), ''), cidade),
              uf     = COALESCE(NULLIF(btrim($4), ''), uf)
        WHERE id = $5
        RETURNING id, nome, email, telefone, cidade, uf, foto_url`,
      [nome.trim(), telefone, cidade || '', uf || '', req.usuario.id]
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
    await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [nova_hash, req.usuario.id])
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

    const result = await pool.query('SELECT id, nome, email FROM usuarios WHERE email = $1', [emailNormalizado])
    if (result.rows.length === 0) return

    const usuario = result.rows[0]
    const tokenCompleto = crypto.randomBytes(32).toString('hex')
    const codigoExibido = tokenCompleto.substring(0, 6).toUpperCase()
    const expira = new Date(Date.now() + 3600000)

    await pool.query(
      `UPDATE usuarios SET reset_token = $1, reset_token_expira = $2 WHERE id = $3`,
      [tokenCompleto, expira, usuario.id]
    )

    await transporter.sendMail({
      from: `ArrumaPro <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
      to: emailNormalizado,
      subject: 'ArrumaPro — Redefinição de senha',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #0a0a0a; margin: 0;">ArrumaPro</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2>Olá, ${usuario.nome}!</h2>
            <p>Seu código de redefinição é:</p>
            <div style="background: #0a0a0a; color: #E8833A; font-size: 32px; font-weight: bold; text-align: center; padding: 20px; border-radius: 8px; letter-spacing: 8px; margin: 20px 0;">
              ${codigoExibido}
            </div>
            <p style="color: #666; font-size: 13px;">Este código expira em 1 hora.</p>
            <p><strong>Equipe ArrumaPro</strong></p>
          </div>
        </div>
      `
    })
  } catch (err) {
    console.error('Erro ao processar esqueci senha:', err)
  }
}

module.exports = { cadastrar, login, perfil, atualizarPerfil, alterarSenha, esqueciSenha }