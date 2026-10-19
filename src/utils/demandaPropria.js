const { pool } = require('./supabase')

// "Demanda própria em outra conta": com múltiplas contas (utils/tipoConta) a MESMA pessoa tem
// uma conta de dono e outra de profissional, com ids diferentes e o MESMO cpf_cnpj. O
// profissional não pode se candidatar / demonstrar interesse no pedido que ele mesmo criou
// como dono — e o feed não deve nem mostrar esse card.
//
// A identidade é o CPF/CNPJ NORMALIZADO (só dígitos), a MESMA expressão do índice único de
// cadastro (usuarios_cpf_cnpj_tipo_unico_idx). Conta sem cpf_cnpj (NULL ou vazio) normaliza
// para NULL e a igualdade dá NULL → nunca casa: faltando o CPF de qualquer um dos lados, a
// checagem é pulada (não bloqueia, não esconde).
const sqlCpfNormalizado = (coluna) => `NULLIF(regexp_replace(COALESCE(${coluna}, ''), '[^0-9]', '', 'g'), '')`

const TABELAS = new Set(['obras', 'reparos'])

// Predicado genérico: verdadeiro quando o usuário `exprUsuarioId` NÃO tem o mesmo CPF do usuário
// `exprCriadorId` (ids como expressões SQL: coluna, placeholder tipado ou subselect). É a peça
// única por trás do feed, dos três POSTs de criação e de TODO público de notificação de demanda
// (broadcast de demanda nova e repescagem, e-mail de reserva, lembretes, proximidade).
const sqlNaoMesmoCpf = (exprCriadorId, exprUsuarioId) => `NOT EXISTS (
        SELECT 1 FROM usuarios dono_cpf
        JOIN usuarios eu_cpf ON eu_cpf.id = ${exprUsuarioId}
        WHERE dono_cpf.id = ${exprCriadorId}
          AND ${sqlCpfNormalizado('dono_cpf.cpf_cnpj')} = ${sqlCpfNormalizado('eu_cpf.cpf_cnpj')}
      )`

// Predicado p/ o WHERE dos feeds: verdadeiro quando o criador da demanda (`${alias}.criado_por`)
// NÃO tem o mesmo CPF do usuário em `param`. Encaixa na BASE do WHERE, antes dos filtros
// dinâmicos, como os demais filtros por usuário (bloqueados, recusados).
const sqlNaoDemandaPropria = (alias, param = '$1') => sqlNaoMesmoCpf(`${alias}.criado_por`, `${param}::uuid`)

// Mesma coisa quando a demanda NÃO está na consulta (públicos de notificação, que selecionam só
// usuarios): o criador vem por subselect em `tabela` pelo id em `param`; `aliasUsuario` é o alias
// do profissional na consulta de público ('u' em todas).
const sqlNaoMesmoCpfDoCriador = (tabela, param, aliasUsuario = 'u') => {
  if (!TABELAS.has(tabela)) throw new Error(`sqlNaoMesmoCpfDoCriador: tabela inválida ${tabela}`)
  return sqlNaoMesmoCpf(`(SELECT criado_por FROM ${tabela} WHERE id = ${param}::uuid)`, `${aliasUsuario}.id`)
}

// Corpo único do 400 — os três endpoints de criação devolvem exatamente isto.
const ERRO_DEMANDA_PROPRIA = Object.freeze({ erro: 'Este pedido foi criado por você em outra conta.', codigo: 'demanda_propria' })

// true quando a demanda `demandaId` (em `tabela`) foi criada por uma conta com o mesmo CPF
// normalizado de `usuarioId`. Demanda inexistente ou CPF ausente em qualquer lado → false.
const ehDemandaPropria = async (tabela, demandaId, usuarioId, db = pool) => {
  if (!TABELAS.has(tabela)) throw new Error(`ehDemandaPropria: tabela inválida ${tabela}`)
  const r = await db.query(
    `SELECT 1 FROM ${tabela} d
     JOIN usuarios dono ON dono.id = d.criado_por
     JOIN usuarios eu ON eu.id = $2
     WHERE d.id = $1
       AND ${sqlCpfNormalizado('dono.cpf_cnpj')} = ${sqlCpfNormalizado('eu.cpf_cnpj')}
     LIMIT 1`,
    [demandaId, usuarioId]
  )
  return r.rows.length > 0
}

module.exports = { sqlCpfNormalizado, sqlNaoMesmoCpf, sqlNaoDemandaPropria, sqlNaoMesmoCpfDoCriador, ERRO_DEMANDA_PROPRIA, ehDemandaPropria }
