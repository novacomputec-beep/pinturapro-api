const { pool } = require('./supabase')
const { ESPECIALIDADES_OBRA, ESPECIALIDADES_REPARADOR } = require('./especialidades')
const { sqlProfissionalDaPessoa } = require('./tipoConta')

// CAPACIDADES do profissional — "pode trabalhar em OBRAS" e "pode trabalhar em SERVIÇOS".
// Deixaram de ser sinônimo de tipo_prestador (decisão do dono, 09/11/2026). tipo_prestador NÃO
// muda (nenhuma migração, nenhuma fusão de contas): a capacidade é DERIVADA da linha.
//
// Fase 2a — OBRAS: a conta REPARADOR que marcou ao menos uma das 4 especialidades de obra
// (ESPECIALIDADES_OBRA — grupo "Obras de Construção Civil" do seletor) vê o feed de obras, recebe
// o push/e-mail de obra e se candidata como um pintor.
// Fase 2b — SERVIÇOS (simétrico): a conta PINTOR que marcou ao menos uma especialidade de serviço
// (ESPECIALIDADES_REPARADOR) vê o feed de serviços, recebe o push/e-mail de serviço POR
// ESPECIALIDADE (categoria × especialidades, como todo reparador) e demonstra interesse.
//
//   pode_obras    = role 'prestador' E ( tipo 'pintor'    OU ( tipo 'reparador' E especialidades ∩ obra    ≠ ∅ ) )
//   pode_servicos = role 'prestador' E ( tipo 'reparador' OU ( tipo 'pintor'    E especialidades ∩ serviço ≠ ∅ ) )
//
// Falha FECHADO: tipo_prestador NULL (legado) nunca pode — mesmo que o texto livre antigo em
// especialidades coincida com um slug — e dono/assinante também não. admin/aprovador não passam
// por aqui: quem decide o bypass de moderação é o gate (exigirPodeObras / exigirPodeServicos).
//
// Cada regra vive em duas formas que precisam concordar (como sqlTipoConta/tipoDaLinha em
// utils/tipoConta): JS sobre uma linha já lida (o gate lê req.usuario) e SQL (público do push/
// e-mail em alertaService e os campos das respostas). scripts/testar-reparador-obras.js e
// scripts/testar-profissional-mesma-pessoa.js comparam as duas linha a linha.
const SET_OBRA = new Set(ESPECIALIDADES_OBRA)
const SET_SERVICO = new Set(ESPECIALIDADES_REPARADOR)

// Os slugs entram como LITERAIS no SQL (os predicados são usados em consultas com numeração de
// parâmetros própria). São vocabulários fechados do código, nunca dado de usuário — e a checagem
// abaixo derruba o boot se alguém puser ali um slug fora de [a-z_].
const sqlListaSlugs = (lista, nome) => {
  for (const slug of lista) {
    if (!/^[a-z_]+$/.test(slug)) throw new Error(`capacidadeObras: slug de ${nome} inválido "${slug}"`)
  }
  return `ARRAY[${lista.map(s => `'${s}'`).join(', ')}]::text[]`
}
const SQL_SLUGS_OBRA = sqlListaSlugs(ESPECIALIDADES_OBRA, 'obra')
const SQL_SLUGS_SERVICO = sqlListaSlugs(ESPECIALIDADES_REPARADOR, 'serviço')

const temSlug = (u, conjunto) => Array.isArray(u.especialidades) && u.especialidades.some(e => conjunto.has(e))
const podeObras = (u) => !!u && u.role === 'prestador' && (
  u.tipo_prestador === 'pintor' || (u.tipo_prestador === 'reparador' && temSlug(u, SET_OBRA))
)
const podeServicos = (u) => !!u && u.role === 'prestador' && (
  u.tipo_prestador === 'reparador' || (u.tipo_prestador === 'pintor' && temSlug(u, SET_SERVICO))
)

// alias = prefixo da tabela usuarios ('u' por padrão; '' para colunas sem prefixo).
// COALESCE externo: com tipo_prestador NULL a expressão daria NULL (num WHERE já é "não", mas num
// SELECT sairia null) — aqui é sempre true/false, igual ao JS.
const sqlPode = (tipoNativo, tipoOutro, sqlSlugs) => (alias = 'u') => {
  const p = alias ? `${alias}.` : ''
  return `COALESCE(${p}role = 'prestador' AND (${p}tipo_prestador = '${tipoNativo}'
            OR (${p}tipo_prestador = '${tipoOutro}' AND COALESCE(${p}especialidades && ${sqlSlugs}, false))), false)`
}
const sqlPodeObras = sqlPode('pintor', 'reparador', SQL_SLUGS_OBRA)
const sqlPodeServicos = sqlPode('reparador', 'pintor', SQL_SLUGS_SERVICO)

// Capacidade por PESSOA (Fase 2b): a pessoa com conta de pintor E de reparador (mesmo CPF —
// utils/tipoConta.sqlContasProfissionaisDaPessoa) vê UM feed unificado: a conta logada pode o que
// QUALQUER conta profissional ATIVA dela pode. A conta de `param` conta sempre (quem a avalia já
// passou por autenticar); a irmã desativada não empresta capacidade.
const sqlPessoaPode = (sqlPodeConta) => (param = '$1') => `EXISTS (
        SELECT 1 FROM usuarios cap
         WHERE ${sqlProfissionalDaPessoa('cap.id', param)}
           AND (cap.id = ${param}::uuid OR cap.ativo IS TRUE)
           AND ${sqlPodeConta('cap')})`
const sqlPessoaPodeObras = sqlPessoaPode(sqlPodeObras)
const sqlPessoaPodeServicos = sqlPessoaPode(sqlPodeServicos)

// O que o app precisa saber da PESSOA por trás da conta logada (login, perfil, /auth/contas e o
// lado negativo dos gates), lido do banco numa consulta:
//   pode_obras / pode_servicos — capacidades acima, por pessoa; o app novo mostra as abas Obras e
//                                Serviços por elas, não por tipo_prestador;
//   tem_candidaturas / tem_interesses — alguma conta profissional da pessoa já se candidatou a uma
//                                obra / demonstrou interesse num serviço (qualquer status). Quem
//                                tirou a especialidade com proposta ou match em andamento continua
//                                precisando das telas "Minhas candidaturas" / "Meus interesses".
// Conta inexistente → tudo false.
const NADA = Object.freeze({ pode_obras: false, pode_servicos: false, tem_candidaturas: false, tem_interesses: false })
const capacidadesDaPessoa = async (usuarioId, db = pool) => {
  if (!usuarioId) return { ...NADA }
  const r = await db.query(
    `SELECT ${sqlPessoaPodeObras('$1')} AS pode_obras,
            ${sqlPessoaPodeServicos('$1')} AS pode_servicos,
            EXISTS (SELECT 1 FROM candidaturas c WHERE ${sqlProfissionalDaPessoa('c.usuario_id', '$1')}) AS tem_candidaturas,
            EXISTS (SELECT 1 FROM interesse_reparos i WHERE ${sqlProfissionalDaPessoa('i.usuario_id', '$1')}) AS tem_interesses`,
    [usuarioId]
  )
  const l = r.rows[0] || {}
  return {
    pode_obras: l.pode_obras === true, pode_servicos: l.pode_servicos === true,
    tem_candidaturas: l.tem_candidaturas === true, tem_interesses: l.tem_interesses === true,
  }
}

module.exports = {
  podeObras, podeServicos, sqlPodeObras, sqlPodeServicos, sqlPessoaPodeObras, sqlPessoaPodeServicos,
  capacidadesDaPessoa, capacidadeObras: capacidadesDaPessoa, // nome da Fase 2a, mantido
  SQL_SLUGS_OBRA, SQL_SLUGS_SERVICO,
}
