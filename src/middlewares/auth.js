const jwt = require('jsonwebtoken')
const { pool } = require('../utils/supabase')
// Só importa utils/supabase — sem ciclo com este middleware.
const { registrarVersaoVista } = require('../utils/versaoApp')
// utils/demandaPropria só importa utils/supabase — sem ciclo. sqlCpfNormalizado: a MESMA
// normalização do índice único de cadastro (identidade da pessoa = CPF, nunca e-mail).
const { sqlCpfNormalizado } = require('../utils/demandaPropria')

// Cache simples em memória
const cacheUsuarios = new Map()
const cacheAssinaturas = new Map()
// 30s (era 5 min): o cache é POR PROCESSO, então invalidarCacheAssinatura só limpa a réplica
// que atendeu a requisição — com mais de uma, um prestador recém-aprovado seguiria barrado
// nas outras até o TTL vencer. 30s limita essa janela sem largar o cache. As duas consultas
// por trás dele são de uma linha por índice (usuarios_pkey e assinaturas_usuario_id_unico_idx),
// então o custo dos misses extras é baixo.
const CACHE_TTL = 30 * 1000

const getCacheUsuario = (id) => {
  const entry = cacheUsuarios.get(id)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cacheUsuarios.delete(id)
    return null
  }
  return entry.data
}

const setCacheUsuario = (id, data) => {
  cacheUsuarios.set(id, { data, timestamp: Date.now() })
}

const getCacheAssinatura = (id) => {
  const entry = cacheAssinaturas.get(id)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cacheAssinaturas.delete(id)
    return null
  }
  return entry.data
}

const setCacheAssinatura = (id, data) => {
  cacheAssinaturas.set(id, { data, timestamp: Date.now() })
}

// Invalida os caches em memória de um usuário. Chamado quando a assinatura muda
// de estado (ex.: aprovação manual / auto-aprovação ativa a assinatura) para que
// a próxima chamada a rota protegida releia o status real do banco em vez de
// devolver um `false` cacheado por até 5 min — o que mandava o prestador recém-
// aprovado para a tela de pagamento mesmo já tendo pago/sido aprovado (B72-07).
const invalidarCacheAssinatura = (id) => {
  cacheUsuarios.delete(id)
  cacheAssinaturas.delete(id)
}

// Fonte ÚNICA da resposta "este usuário tem assinatura ativa?", com o cache por trás.
// Existia uma segunda cópia em routes/index.js (cachePrestadores) com a MESMA consulta e o
// MESMO predicado: dois mapas guardando a mesma resposta, e por isso a invalidação precisava
// lembrar de limpar os dois — que foi exatamente o esquecimento do B72-07. Agora exigirPrestador
// (routes) e exigirAssinaturaAtiva (aqui) passam os dois por esta função.
const assinaturaAtivaCacheada = async (usuarioId) => {
  // getCacheAssinatura devolve null quando não há entrada ou ela expirou; `false` cacheado é
  // resposta legítima e NÃO pode ir ao banco de novo.
  let ativa = getCacheAssinatura(usuarioId)
  if (ativa === null || ativa === undefined) {
    const result = await pool.query(
      `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' AND (proximo_vencimento IS NULL OR proximo_vencimento > NOW()) LIMIT 1`,
      [usuarioId]
    )
    ativa = result.rows.length > 0
    setCacheAssinatura(usuarioId, ativa)
  }
  return ativa
}

// Linha de sessão de UM usuário, pelo cache de 30s. Além das colunas da própria linha:
//   especialidades — os gates de capacidade (exigirPodeObras / exigirPodeServicos, routes/index.js)
//     decidem por tipo OU especialidade (utils/capacidadeObras);
//   contas_irmas   — ids das OUTRAS contas PROFISSIONAIS da mesma pessoa (role 'prestador' nos dois
//     lados, mesmo CPF normalizado, nunca e-mail — a regra de utils/tipoConta
//     .sqlContasProfissionaisDaPessoa). '{}' para dono/admin e para quem tem uma conta só, que é
//     quase todo mundo: nenhum caminho abaixo consulta nada a mais nesse caso;
//   suspenso_em / suspenso_motivo — por PESSOA (Fase 2b): os da própria conta ou, sem eles, os de
//     uma conta irmã suspensa. A suspensão segue gravada na conta que a mereceu; aqui a outra conta
//     profissional da mesma pessoa deixa de ser porta dos fundos (exigirNaoSuspenso lê isto).
const sqlMesmoProfissional = (outro) => `${outro}.id <> u.id AND u.role = 'prestador' AND ${outro}.role = 'prestador'
             AND ${sqlCpfNormalizado(`${outro}.cpf_cnpj`)} = ${sqlCpfNormalizado('u.cpf_cnpj')}`
const SQL_USUARIO_SESSAO = `
  SELECT u.id, u.nome, u.email, u.role, u.ativo, u.tipo_prestador, u.especialidades, u.token_version,
         COALESCE(u.suspenso_em, sp.suspenso_em) AS suspenso_em,
         CASE WHEN u.suspenso_em IS NOT NULL THEN u.suspenso_motivo ELSE sp.suspenso_motivo END AS suspenso_motivo,
         ARRAY(SELECT irma.id FROM usuarios irma WHERE ${sqlMesmoProfissional('irma')} ORDER BY irma.id) AS contas_irmas
    FROM usuarios u
    LEFT JOIN LATERAL (
      SELECT s.suspenso_em, s.suspenso_motivo FROM usuarios s
       WHERE ${sqlMesmoProfissional('s')} AND s.suspenso_em IS NOT NULL
       ORDER BY s.suspenso_em LIMIT 1) sp ON true
   WHERE u.id = $1`
const carregarUsuario = async (id) => {
  let usuario = getCacheUsuario(id)
  if (!usuario) {
    const result = await pool.query(SQL_USUARIO_SESSAO, [id])
    if (result.rows.length === 0) return null
    usuario = result.rows[0]
    setCacheUsuario(id, usuario)
  }
  return usuario
}

// ─── Conta VINCULADA à demanda (lado profissional unificado, Fase 2b — 09/11/2026) ──────────────
// A pessoa com conta de pintor E de reparador (mesmo CPF) é UM profissional: numa demanda ela age
// por UMA conta só — a primeira que se envolveu (proposta ou match). Se a conta LOGADA não tem
// vínculo com a demanda da rota e a conta IRMÃ tem, o handler roda COMO a irmã: req.usuario passa
// a ser a linha dela e req.contaLogada guarda a conta do token.
//
// Por que trocar a identidade aqui, num lugar só, em vez de afrouxar cada checagem de posse: todo
// o código de obra/reparo compara match_usuario_id e usuario_id com req.usuario.id e GRAVA esse id
// (chegada_declarada_por, encerramento_solicitado_por, faltas, lista negra). Aceitar "qualquer
// conta da pessoa" em cada comparação deixaria linhas em que quem declarou a chegada não é o
// profissional do match — e os crons e o app leem essas colunas por igualdade. Trocando a conta,
// todas as invariantes continuam valendo e as checagens de "profissional escolhido" aceitam
// qualquer conta profissional da pessoa sem mudar uma linha.
//
// Quem decide (nesta ordem): (1) a proposta NOMEADA na rota (:candidaturaId / :interesse_id) —
// age a conta dona dela; (2) o match — age a conta casada; (3) a conta logada, se tem proposta;
// (4) a irmã que tem proposta. Sem vínculo de ninguém, segue a conta logada (é ela que cria a
// proposta nova). Consequência: a 2ª conta que tenta se candidatar cai no "já se candidatou" da
// irmã — uma proposta por PESSOA por demanda (a rota troca a mensagem; ver req.contaLogada lá).
//
// Só rotas de UMA demanda (/obras/:id… e /reparos/:id…), só role 'prestador' com conta irmã.
// Os gates de CONTA (assinatura, verificação de identidade) continuam julgando a conta LOGADA
// (contaDoToken); capacidade e suspensão são por pessoa. Exportada para as rotas que recebem a
// demanda no CORPO (avaliações) chamarem com (req, tabela, demandaId).
const LADOS_VINCULO = [
  { prefixo: '/obras/:id',   tabela: 'obras',   proposta: 'candidaturas',      fk: 'obra_id',   paramProposta: 'candidaturaId' },
  { prefixo: '/reparos/:id', tabela: 'reparos', proposta: 'interesse_reparos', fk: 'reparo_id', paramProposta: 'interesse_id' },
]
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ladoDaRota = (req) => {
  const caminho = req.route?.path
  if (typeof caminho !== 'string') return null
  return LADOS_VINCULO.find(l => caminho === l.prefixo || caminho.startsWith(`${l.prefixo}/`)) || null
}
const contaVinculada = async (usuario, lado, demandaId, propostaId) => {
  const contas = [usuario.id, ...(usuario.contas_irmas || [])]
  if (propostaId && RE_UUID.test(String(propostaId))) {
    const p = await pool.query(
      `SELECT usuario_id FROM ${lado.proposta} WHERE id = $1 AND ${lado.fk} = $2 AND usuario_id = ANY($3::uuid[])`,
      [propostaId, demandaId, contas]
    )
    if (p.rows[0]) return p.rows[0].usuario_id
  }
  const r = await pool.query(
    `SELECT d.match_usuario_id,
            ARRAY(SELECT p.usuario_id FROM ${lado.proposta} p
                   WHERE p.${lado.fk} = d.id AND p.usuario_id = ANY($2::uuid[])
                   ORDER BY p.criado_em, p.usuario_id) AS com_proposta
       FROM ${lado.tabela} d WHERE d.id = $1`,
    [demandaId, contas]
  )
  const d = r.rows[0]
  if (!d) return usuario.id
  if (d.match_usuario_id && contas.includes(d.match_usuario_id)) return d.match_usuario_id
  if (d.com_proposta.includes(usuario.id)) return usuario.id
  return d.com_proposta[0] || usuario.id
}
const assumirContaVinculada = async (req, tabela = null, demandaId = null) => {
  const usuario = req.usuario
  if (!usuario || usuario.role !== 'prestador' || !(usuario.contas_irmas?.length > 0)) return
  const lado = tabela ? LADOS_VINCULO.find(l => l.tabela === tabela) : ladoDaRota(req)
  const id = tabela ? demandaId : req.params?.id
  if (!lado || !RE_UUID.test(String(id || ''))) return
  const alvoId = await contaVinculada(usuario, lado, id, tabela ? null : req.params?.[lado.paramProposta])
  if (!alvoId || alvoId === usuario.id) return
  const alvo = await carregarUsuario(alvoId)
  if (!alvo) return
  req.contaLogada = usuario
  req.usuario = alvo
}
// A conta do TOKEN — a que os gates de conta (assinatura, verificação) julgam, mesmo quando o
// handler vai agir como a conta irmã vinculada à demanda.
const contaDoToken = (req) => req.contaLogada || req.usuario

const autenticar = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ erro: 'Token não fornecido' })
    }
    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.tipo === '2fa_pendente') {
      return res.status(401).json({ erro: 'Autenticação incompleta — código 2FA necessário' })
    }

    // Tenta cache primeiro (carregarUsuario)
    const usuario = await carregarUsuario(decoded.id)
    if (!usuario) {
      return res.status(401).json({ erro: 'Usuário não encontrado' })
    }

    if (!usuario.ativo) {
      return res.status(403).json({ erro: 'Conta desativada' })
    }

    // Revogação por troca de senha (D51): o JWT carrega a versão vigente na emissão (tv);
    // trocar a senha incrementa token_version e o token antigo deixa de casar. Token legado
    // sem 'tv' conta como 1, que casa com o default 1 das linhas — ninguém é deslogado no
    // deploy. Lê token_version do MESMO `usuario` (cache de 30s): a revogação é imediata na
    // réplica que processou a troca (ela invalida o cache local) e vale em até 30s nas demais.
    if ((decoded.tv ?? 1) !== usuario.token_version) {
      return res.status(401).json({ erro: 'Sua senha foi alterada. Faça login novamente.', codigo: 'TOKEN_REVOGADO' })
    }

    req.usuario = usuario
    // Mesma pessoa, outra conta profissional com proposta/match NESTA demanda: age como ela.
    await assumirContaVinculada(req)
    // Versão/plataforma do app que fez a chamada (headers X-App-Version / X-App-Platform):
    // registro fire-and-forget com dedupe em memória (utils/versaoApp) — síncrono, sem await,
    // nunca falha a requisição. Sem os headers (painel web, cliente antigo) é no-op.
    registrarVersaoVista(req)
    next()
  } catch (err) {
    console.error('Erro auth:', err.message)
    return res.status(401).json({ erro: 'Token inválido ou expirado' })
  }
}

const exigirAssinaturaAtiva = async (req, res, next) => {
  if (req.usuario.role === 'admin' || req.usuario.role === 'aprovador' || req.usuario.role === 'dono_obra') {
    return next()
  }
  try {
    // Conta do TOKEN (contaDoToken): a assinatura é da conta que está logada.
    const assinaturaAtiva = await assinaturaAtivaCacheada(contaDoToken(req).id)

    if (!assinaturaAtiva) {
      return res.status(403).json({
        erro: 'Assinatura inativa. Renove seu plano para acessar as obras.',
        codigo: 'ASSINATURA_INATIVA'
      })
    }
    next()
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao verificar assinatura' })
  }
}

// Suspensão por faltas (ver registrarFalta em alertaService). Fecha só a porta de ENTRADA em
// trabalho novo: feeds, proximidade e criação/aceite de proposta. Tudo que já está em
// andamento — match, chegada, encerramento, avaliação, denúncia, perfil, login — segue aberto,
// porque suspender alguém no meio de um serviço puniria o dono junto.
// admin/aprovador nunca são barrados (moderação não pode se autotrancar).
// suspenso_em vem de req.usuario, populado por autenticar — atenção ao cache de 30s de lá.
// É por PESSOA (Fase 2b): carregarUsuario já devolve a suspensão da conta OU da conta irmã
// profissional (mesmo CPF), então a outra conta da mesma pessoa também fica barrada aqui.
// Corpo do 403 de conta suspensa, exportado para os pontos que checam a suspensão FORA do
// middleware (aceites, onde a decisão depende da action) não reescreverem o texto por conta
// própria e acabarem divergindo dele.
const corpoContaSuspensa = ({ suspenso_em, suspenso_motivo }) => ({
  erro: suspenso_motivo
    ? `Conta suspensa por ${suspenso_motivo}. Você não pode pegar novos trabalhos. Fale com o suporte para regularizar.`
    : 'Conta suspensa. Você não pode pegar novos trabalhos. Fale com o suporte para regularizar.',
  codigo: 'CONTA_SUSPENSA',
  suspenso_em,
})

const exigirNaoSuspenso = (req, res, next) => {
  if (req.usuario.role === 'admin' || req.usuario.role === 'aprovador') return next()
  if (req.usuario.suspenso_em) {
    return res.status(403).json(corpoContaSuspensa(req.usuario))
  }
  next()
}

// Verificação de identidade ADIADA: o profissional pode se cadastrar sem foto do documento e
// selfie e navegar o feed, mas só envia proposta/interesse com verificacao_status = 'aprovado'.
// Lê direto do banco (uma linha pela PK), sem o cache de autenticar: a aprovação tem que valer
// na hora em qualquer réplica, e estas rotas são de escrita, de baixo volume.
// admin/aprovador nunca são barrados. verificacao_status vai no corpo para o app distinguir
// "envie os documentos" (nao_solicitada/reprovado) de "em análise" (pendente).
const exigirVerificado = async (req, res, next) => {
  if (req.usuario.role === 'admin' || req.usuario.role === 'aprovador') return next()
  try {
    // Conta do TOKEN (contaDoToken): a verificação de identidade é da conta que está logada.
    const r = await pool.query(`SELECT verificacao_status FROM usuarios WHERE id = $1`, [contaDoToken(req).id])
    const status = r.rows[0]?.verificacao_status || 'nao_solicitada'
    if (status === 'aprovado') return next()
    return res.status(403).json({
      erro: status === 'pendente'
        ? 'Seus documentos estão em análise. Você poderá enviar propostas assim que forem aprovados.'
        : 'Envie a foto do seu documento e uma selfie para poder enviar propostas.',
      codigo: 'VERIFICACAO_NECESSARIA',
      verificacao_status: status,
    })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao verificar cadastro' })
  }
}

const exigirAdmin = (req, res, next) => {
  if (!['admin', 'aprovador'].includes(req.usuario.role)) {
    return res.status(403).json({ erro: 'Acesso negado' })
  }
  next()
}

const exigirSuperAdmin = (req, res, next) => {
  if (req.usuario.role !== 'admin') {
    return res.status(403).json({ erro: 'Acesso restrito ao administrador' })
  }
  next()
}

module.exports = { autenticar, exigirAssinaturaAtiva, exigirNaoSuspenso, corpoContaSuspensa, exigirVerificado, exigirAdmin, exigirSuperAdmin, invalidarCacheAssinatura, assinaturaAtivaCacheada,
  assumirContaVinculada, contaDoToken, carregarUsuario }