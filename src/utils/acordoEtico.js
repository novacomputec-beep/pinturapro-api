// ACORDO ÉTICO do contratante (dono, 23/11/2026) e MOTIVO do cancelamento pelo dono.
//
// usuarios.acordo_etico_aceito_em: quando a conta aceitou o acordo (POST /auth/acordo-etico, ou
// `acordo_etico: true` no corpo de POST /obras/dono e /reparos/dono — gravado no MESMO statement
// do INSERT). `precisa_acordo_etico` (payload de sessão e de perfil do contratante) é true quando:
//   - a PESSOA nunca aceitou; ou
//   - desde o ÚLTIMO aceite ela tem 2+ demandas (obras + reparos) canceladas ou vencidas SEM
//     profissional escolhido.
// Por PESSOA (mesmo CPF, contas contratantes — utils/tipoConta.sqlContasDaPessoa), como a posse das
// demandas: quem aceitou no perfil de pintura não é perguntado de novo no de serviços, e os pedidos
// das duas contas contam juntos. O aceite vale o mais recente entre as contas.
//
// O que conta (cada demanda uma vez):
//   - cancelada (status 'cancelada') que não foi cancelada pelo ADMIN (cancelada_por 'cliente' ou
//     NULL — histórico sem a coluna), no instante em que saiu do ar: o menor entre encerrado_em e
//     expira_em (venceu antes do aceite e só depois foi cancelada = não conta de novo);
//   - vencida: segue 'aberta', expira_em no passado (estender o prazo tira da conta).
// "Sem profissional escolhido" = utils/profissionalEscolhido (nem match nem proposta 'aceito') E
// sem proposta cancelada por 'cancelado_pelo_cliente' — o cancelamento com o atendimento EM
// ANDAMENTO (cancelamentoMatchService.cancelarEmAndamento) zera o match, mas ali havia escolhido.
// Nada aqui BLOQUEIA: o app antigo, que não manda o campo, cria e cancela como sempre.
const { pool } = require('./supabase')
const { sqlContasDaPessoa } = require('./tipoConta')
const { sqlSemProfissionalEscolhido } = require('./profissionalEscolhido')

const LIMITE_SEM_ESCOLHIDO = 2
// = cancelamentoMatchService.MOTIVO_CANCELADO_PELO_CLIENTE (literal aqui para o authController não
// carregar o serviço inteiro; scripts/testar-acordo-etico.js confere que os dois são iguais).
const MOTIVO_PROPOSTA_CANCELADA_PELO_CLIENTE = 'cancelado_pelo_cliente'
const PROPOSTAS = {
  obras:   { tabela: 'candidaturas',      fk: 'obra_id' },
  reparos: { tabela: 'interesse_reparos', fk: 'reparo_id' },
}

const sqlContaParaAcordo = (tabela, a, aceite) => {
  const p = PROPOSTAS[tabela]
  return `${sqlSemProfissionalEscolhido(tabela, a)}
      AND NOT EXISTS (SELECT 1 FROM ${p.tabela} pc WHERE pc.${p.fk} = ${a}.id AND pc.status = 'cancelado'
                         AND pc.cancelado_motivo = '${MOTIVO_PROPOSTA_CANCELADA_PELO_CLIENTE}')
      AND ((${a}.status = 'cancelada' AND ${a}.cancelada_por IS DISTINCT FROM 'admin'
            AND LEAST(${a}.encerrado_em, ${a}.expira_em) > ${aceite})
        OR (${a}.status = 'aberta' AND ${a}.expira_em <= NOW() AND ${a}.expira_em > ${aceite}))`
}

// { aceito_em, sem_escolhido, precisa } da pessoa da conta `usuarioId`.
const situacaoAcordoEtico = async (usuarioId, db = pool) => {
  const aceite = '(SELECT em FROM aceite)'
  const r = await db.query(
    `WITH pessoa AS (${sqlContasDaPessoa('$1')}),
          aceite AS (SELECT MAX(u.acordo_etico_aceito_em) AS em FROM usuarios u WHERE u.id IN (SELECT id FROM pessoa))
     SELECT ${aceite} AS aceito_em,
            ((SELECT COUNT(*) FROM obras o WHERE o.criado_por IN (SELECT id FROM pessoa) AND ${sqlContaParaAcordo('obras', 'o', aceite)})
           + (SELECT COUNT(*) FROM reparos r WHERE r.criado_por IN (SELECT id FROM pessoa) AND ${sqlContaParaAcordo('reparos', 'r', aceite)}))::int AS sem_escolhido`,
    [usuarioId]
  )
  const { aceito_em = null, sem_escolhido = 0 } = r.rows[0] || {}
  return { aceito_em, sem_escolhido, precisa: !aceito_em || sem_escolhido >= LIMITE_SEM_ESCOLHIDO }
}

// Campo do payload de sessão/perfil: só a conta CONTRATANTE recebe ({} nas demais — profissional
// e admin seguem com a resposta de antes). Falha na consulta NUNCA derruba login/perfil: false.
const camposAcordoEtico = async (usuario) => {
  if (!usuario || usuario.role !== 'dono_obra') return {}
  try {
    return { precisa_acordo_etico: (await situacaoAcordoEtico(usuario.id)).precisa }
  } catch (err) {
    console.error('[acordo-etico] falha ao calcular precisa_acordo_etico:', err.message)
    return { precisa_acordo_etico: false }
  }
}

// Aceite avulso (POST /auth/acordo-etico). Devolve o instante gravado.
const registrarAceiteAcordoEtico = async (usuarioId, db = pool) => {
  const r = await db.query('UPDATE usuarios SET acordo_etico_aceito_em = NOW() WHERE id = $1 RETURNING acordo_etico_aceito_em', [usuarioId])
  return r.rows[0]?.acordo_etico_aceito_em || null
}

// `acordo_etico: true` no corpo do create. App antigo não manda → false → nada é gravado.
const aceitouAcordoNoCorpo = (body) => body?.acordo_etico === true || body?.acordo_etico === 'true'
// Prefixo do INSERT da demanda: grava o aceite no MESMO statement (atômico com a criação).
// `pUsuario` e `pAceitou` são os placeholders do id da conta e do booleano.
const sqlCteAceiteAcordo = (pUsuario, pAceitou) =>
  `WITH aceite_acordo AS (UPDATE usuarios SET acordo_etico_aceito_em = NOW() WHERE id = ${pUsuario} AND ${pAceitou}::boolean RETURNING id)`

// ─── Motivo do cancelamento pelo dono (DELETE /obras/dono/:id e /reparos/dono/:id) ───
// Coluna motivo_cancelamento (obras e reparos). Opcional: app antigo não manda → NULL. Aceito no
// corpo ou na query string (há cliente/proxy que descarta corpo de DELETE). Valor fora da lista → 400.
const MOTIVOS_CANCELAMENTO_DONO = ['ja_resolvi', 'ninguem_respondeu', 'cadastrei_errado', 'desisti']
const lerMotivoCancelamentoDono = (req) => {
  const bruto = req.body?.motivo_cancelamento ?? req.query?.motivo_cancelamento
  if (bruto === undefined || bruto === null || bruto === '') return { valor: null }
  if (!MOTIVOS_CANCELAMENTO_DONO.includes(bruto)) return { erro: 'Motivo de cancelamento inválido', codigo: 'MOTIVO_CANCELAMENTO_INVALIDO' }
  return { valor: bruto }
}

module.exports = {
  LIMITE_SEM_ESCOLHIDO, MOTIVO_PROPOSTA_CANCELADA_PELO_CLIENTE, situacaoAcordoEtico, camposAcordoEtico,
  registrarAceiteAcordoEtico, aceitouAcordoNoCorpo, sqlCteAceiteAcordo, MOTIVOS_CANCELAMENTO_DONO, lerMotivoCancelamentoDono,
}
