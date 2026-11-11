// GET /prestador/oportunidades-resumo (dono, 11/11/2026) — quantas demandas ABERTAS existem ao
// alcance do profissional logado, e quantas delas casam com o que ele faz:
//   abertos_perto    — obras + reparos abertos, aprovados, sem profissional escolhido e no prazo,
//                      ao ALCANCE da pessoa: MESMA cidade+UF (sempre) OU, com coordenadas dos dois
//                      lados, a até min(raio escolhido, 50 km) — a MESMA regra do aviso de demanda
//                      nova e do lembrete (utils/avisosPorDistancia.sqlAlcance). Demanda da própria
//                      pessoa (mesmo CPF) não conta.
//   na_especialidade — dessas, as que a PESSOA pode atender: obra → pode trabalhar em obras
//                      (capacidadeObras.sqlPessoaPodeObras) OU a lista inferida da obra casa com as
//                      especialidades dela (a regra do feed GET /obras); reparo → pode trabalhar em
//                      serviços E a categoria do reparo (categorias, ou categoria) está nas
//                      especialidades da pessoa.
// Só leitura; uma consulta. `param` = placeholder do usuario_id.
const { sqlAlcance } = require('./avisosPorDistancia')
const { sqlPessoaPodeObras, sqlPessoaPodeServicos } = require('./capacidadeObras')
const { sqlEspecialidadesDaPessoa } = require('./especialidadesInferidas')
const { sqlNormalizarCidade } = require('./localidade')
const { sqlNaoDemandaPropria } = require('./demandaPropria')

const SQL_ABERTA = (a) => `${a}.status = 'aberta' AND ${a}.status_aprovacao = 'aprovada' AND ${a}.match_usuario_id IS NULL AND ${a}.expira_em > NOW()`

const sqlOportunidadesResumo = (param = '$1') => {
  const mesmaCidade = `(NULLIF(btrim(u.cidade), '') IS NOT NULL AND NULLIF(btrim(u.uf), '') IS NOT NULL
             AND ${sqlNormalizarCidade('u.cidade')} = ${sqlNormalizarCidade('d.cidade')} AND upper(btrim(u.uf)) = upper(btrim(d.uf)))`
  return `
    WITH esp AS (SELECT ${sqlEspecialidadesDaPessoa(param)} AS lista),
    d AS (
      SELECT o.cidade, o.uf, o.latitude, o.longitude,
             (${sqlPessoaPodeObras(param)} OR COALESCE(o.especialidades_inferidas && (SELECT lista FROM esp), false)) AS casa
        FROM obras o WHERE ${SQL_ABERTA('o')} AND ${sqlNaoDemandaPropria('o', param)}
      UNION ALL
      SELECT r.cidade, r.uf, r.latitude, r.longitude,
             (${sqlPessoaPodeServicos(param)}
              AND COALESCE(COALESCE(r.categorias, ARRAY[r.categoria]) && (SELECT lista FROM esp), false)) AS casa
        FROM reparos r WHERE ${SQL_ABERTA('r')} AND ${sqlNaoDemandaPropria('r', param)})
    SELECT COUNT(*)::int AS abertos_perto, (COUNT(*) FILTER (WHERE d.casa))::int AS na_especialidade
      FROM usuarios u JOIN d ON ${sqlAlcance({ pLat: 'd.latitude', pLng: 'd.longitude', sqlMesmaCidade: mesmaCidade })}
     WHERE u.id = ${param}::uuid`
}

const oportunidadesResumo = async (db, usuarioId) => {
  const r = await db.query(sqlOportunidadesResumo('$1'), [usuarioId])
  return { abertos_perto: r.rows[0]?.abertos_perto ?? 0, na_especialidade: r.rows[0]?.na_especialidade ?? 0 }
}

module.exports = { sqlOportunidadesResumo, oportunidadesResumo }
