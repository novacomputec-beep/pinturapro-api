// Pedidos ABERTOS de uma cidade para o Canal do WhatsApp — a ÚNICA consulta, lida por dois
// consumidores: GET /admin/canal/resumo (prévia/texto do painel) e o resumo das 18:00 ao admin
// (services/resumoDiaAdminService, "Resumo do dia pronto (N pedidos)"), para N ser exatamente o
// que a prévia mostra. Mora em utils/ (e não no serviço) porque routes/index.js a importa e o
// serviço depende do alertaService — que alguns testes de rota substituem por um dublê parcial.
//
// Critério: status 'aberta', aprovados, não vencidos; cidade dobrada (utils/localidade, mesma
// regra do broadcast), uf opcional em caixa alta; cada lado pode ser desligado. Só o que o canal
// mostra sai daqui (título, categoria, bairro, valor, data, código público): nome do dono,
// telefone, endereço, referência e descrição nunca.
const { pool } = require('./supabase')
const { normalizar, sqlNormalizarCidade } = require('./localidade')

const listarItensCanal = async ({ cidade, uf = null, comServicos = true, comObras = true, db = pool }) => {
  const cidadeNorm = normalizar(cidade)
  const ufNorm = uf ? String(uf).trim().toUpperCase() : null
  const itens = []
  if (comServicos) {
    const r = await db.query(
      `SELECT 'reparo' AS tipo, r.titulo, r.categoria, r.categorias, r.bairro, r.valor_estimado AS valor, r.criado_em, r.codigo_publico
         FROM reparos r
        WHERE r.status = 'aberta' AND r.status_aprovacao = 'aprovada' AND r.expira_em > NOW()
          AND ${sqlNormalizarCidade('r.cidade')} = $1
          AND ($2::text IS NULL OR upper(btrim(r.uf)) = $2)
        ORDER BY r.criado_em DESC
        LIMIT 200`,
      [cidadeNorm, ufNorm]
    )
    itens.push(...r.rows)
  }
  if (comObras) {
    const o = await db.query(
      `SELECT 'obra' AS tipo, o.titulo, o.categoria, o.bairro, o.valor, o.criado_em, o.codigo_publico
         FROM obras o
        WHERE o.status = 'aberta' AND o.status_aprovacao = 'aprovada' AND o.expira_em > NOW()
          AND ${sqlNormalizarCidade('o.cidade')} = $1
          AND ($2::text IS NULL OR upper(btrim(o.uf)) = $2)
        ORDER BY o.criado_em DESC
        LIMIT 200`,
      [cidadeNorm, ufNorm]
    )
    itens.push(...o.rows)
  }
  return itens
}

module.exports = { listarItensCanal }
