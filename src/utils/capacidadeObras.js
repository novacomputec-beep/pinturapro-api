const { pool } = require('./supabase')
const { ESPECIALIDADES_OBRA } = require('./especialidades')

// CAPACIDADE "pode trabalhar em OBRAS" — Fase 2a do lado profissional (decisão do dono, 09/11/2026).
// Deixou de ser sinônimo de tipo_prestador = 'pintor': uma conta REPARADOR que marcou ao menos uma
// das 4 especialidades de obra (ESPECIALIDADES_OBRA — grupo "Obras de Construção Civil" do seletor)
// vê o feed de obras, recebe o push/e-mail de obra e se candidata como um pintor. tipo_prestador
// NÃO muda (nenhuma migração, nenhuma fusão de contas): a capacidade é DERIVADA da linha.
//
//   pode_obras = role 'prestador' E ( tipo_prestador = 'pintor'
//                                     OU ( tipo_prestador = 'reparador' E especialidades ∩ obra ≠ ∅ ) )
//
// Falha FECHADO: tipo_prestador NULL (legado) nunca pode — mesmo que o texto livre antigo em
// especialidades coincida com um slug de obra — e dono/assinante também não. admin/aprovador não
// passam por aqui: quem decide o bypass de moderação é o gate (exigirPodeObras, routes/index.js).
//
// A MESMA regra vive em duas formas que precisam concordar (como sqlTipoConta/tipoDaLinha em
// utils/tipoConta): podeObras (JS, sobre uma linha já lida — o gate lê req.usuario) e sqlPodeObras
// (SQL — público do push/e-mail de obra em alertaService e os campos pode_obras das respostas).
// scripts/testar-reparador-obras.js compara as duas linha a linha.
const SET_OBRA = new Set(ESPECIALIDADES_OBRA)

// Os slugs entram como LITERAIS no SQL (o predicado é usado em consultas com numeração de
// parâmetros própria). É um vocabulário fechado do código, nunca dado de usuário — e a checagem
// abaixo derruba o boot se alguém puser ali um slug fora de [a-z_].
for (const slug of ESPECIALIDADES_OBRA) {
  if (!/^[a-z_]+$/.test(slug)) throw new Error(`capacidadeObras: slug de obra inválido "${slug}"`)
}
const SQL_SLUGS_OBRA = `ARRAY[${ESPECIALIDADES_OBRA.map(s => `'${s}'`).join(', ')}]::text[]`

const podeObras = (u) => !!u && u.role === 'prestador' && (
  u.tipo_prestador === 'pintor'
  || (u.tipo_prestador === 'reparador'
      && Array.isArray(u.especialidades)
      && u.especialidades.some(e => SET_OBRA.has(e)))
)

// alias = prefixo da tabela usuarios ('u' por padrão; '' para colunas sem prefixo).
// COALESCE externo: com tipo_prestador NULL a expressão daria NULL (num WHERE já é "não", mas num
// SELECT sairia null) — aqui é sempre true/false, igual ao podeObras do JS.
const sqlPodeObras = (alias = 'u') => {
  const p = alias ? `${alias}.` : ''
  return `COALESCE(${p}role = 'prestador' AND (${p}tipo_prestador = 'pintor'
            OR (${p}tipo_prestador = 'reparador' AND COALESCE(${p}especialidades && ${SQL_SLUGS_OBRA}, false))), false)`
}

// { pode_obras, tem_candidaturas } de UMA conta, lidos do banco (login, perfil, /auth/contas):
//   pode_obras       — a capacidade acima; o app novo mostra a aba Obras por ela, não por tipo;
//   tem_candidaturas — a conta já se candidatou a alguma obra (qualquer status). Quem tirou a
//                      especialidade de obra com proposta/match em andamento continua precisando
//                      da tela "Minhas candidaturas" (GET /candidaturas/minhas não tem gate de tier).
// Conta inexistente → os dois false.
const capacidadeObras = async (usuarioId, db = pool) => {
  if (!usuarioId) return { pode_obras: false, tem_candidaturas: false }
  const r = await db.query(
    `SELECT ${sqlPodeObras('u')} AS pode_obras,
            EXISTS (SELECT 1 FROM candidaturas c WHERE c.usuario_id = u.id) AS tem_candidaturas
       FROM usuarios u WHERE u.id = $1`,
    [usuarioId]
  )
  return { pode_obras: r.rows[0]?.pode_obras === true, tem_candidaturas: r.rows[0]?.tem_candidaturas === true }
}

module.exports = { podeObras, sqlPodeObras, capacidadeObras, SQL_SLUGS_OBRA }
