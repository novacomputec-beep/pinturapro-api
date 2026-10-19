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

// Predicado p/ o WHERE dos feeds: verdadeiro quando o criador da demanda (`${alias}.criado_por`)
// NÃO tem o mesmo CPF do usuário em `param`. Encaixa na BASE do WHERE, antes dos filtros
// dinâmicos, como os demais filtros por usuário (bloqueados, recusados).
const sqlNaoDemandaPropria = (alias, param = '$1') => `NOT EXISTS (
        SELECT 1 FROM usuarios dono_cpf
        JOIN usuarios eu_cpf ON eu_cpf.id = ${param}::uuid
        WHERE dono_cpf.id = ${alias}.criado_por
          AND ${sqlCpfNormalizado('dono_cpf.cpf_cnpj')} = ${sqlCpfNormalizado('eu_cpf.cpf_cnpj')}
      )`

// Corpo único do 400 — os três endpoints de criação devolvem exatamente isto.
const ERRO_DEMANDA_PROPRIA = Object.freeze({ erro: 'Este pedido foi criado por você em outra conta.', codigo: 'demanda_propria' })

const TABELAS = new Set(['obras', 'reparos'])

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

module.exports = { sqlCpfNormalizado, sqlNaoDemandaPropria, ERRO_DEMANDA_PROPRIA, ehDemandaPropria }
