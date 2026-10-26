// Indicações entre profissionais: cada prestador tem um codigo_indicacao (6 caracteres do
// mesmo alfabeto sem ambiguidade de gerar_codigo_publico, gerado por gerar_codigo_indicacao()
// na migração de boot). Quem se cadastra com um código válido nasce com indicado_por; a
// indicação só CONTA quando o indicado é aprovado (verificacao_status = 'aprovado').
//
// Por indicador ficam gravados em usuarios:
//   meses_bonus_indicacao = indicados aprovados, com teto TETO_MESES_BONUS — meses que o
//                           backfill do fim da janela de lançamento SOMA ao vencimento
//                           (SQL_BACKFILL_LANCAMENTO em routes); nada é cobrado nem mudado
//                           fora desse momento;
//   embaixador            = indicados aprovados >= MIN_INDICADOS_EMBAIXADOR (sai nos cards
//                           de candidato/interessado que o dono vê).
// Ambos são recalculados por recalcularIndicador DEPOIS de cada caminho que aprova um
// profissional (painel, modo automático, timeout, acesso gratuito, e-mail especial).
const { pool } = require('./supabase')

const TETO_MESES_BONUS = 12
const MIN_INDICADOS_EMBAIXADOR = 3
const RE_CODIGO_INDICACAO = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/
const LINK_INDICACAO = (codigo) => `https://protudo.app.br/baixar?c=${codigo}`

// Código como o app manda (qualquer caixa, espaços em volta) → maiúsculo válido ou null.
const normalizarCodigo = (v) => {
  const c = String(v ?? '').trim().toUpperCase()
  return RE_CODIGO_INDICACAO.test(c) ? c : null
}

// Recalcula meses_bonus_indicacao e embaixador do INDICADOR de `indicadoId` a partir dos
// indicados aprovados hoje. Quem não foi indicado (indicado_por NULL) não tem o que recalcular.
// Nunca lança: erro vira log — é chamada fire-and-forget depois da aprovação.
const recalcularIndicador = async (indicadoId, db = pool) => {
  try {
    await db.query(
      `UPDATE usuarios r
          SET meses_bonus_indicacao = LEAST($2::int, s.aprovados),
              embaixador = (s.aprovados >= $3::int)
         FROM (SELECT i.indicado_por,
                      COUNT(*) FILTER (WHERE i.verificacao_status = 'aprovado')::int AS aprovados
                 FROM usuarios i
                WHERE i.indicado_por = (SELECT indicado_por FROM usuarios WHERE id = $1)
                GROUP BY i.indicado_por) s
        WHERE r.id = s.indicado_por`,
      [indicadoId, TETO_MESES_BONUS, MIN_INDICADOS_EMBAIXADOR]
    )
  } catch (err) {
    console.error(`[Indicacoes] recálculo do indicador de ${indicadoId} falhou:`, err.message)
  }
}

module.exports = { TETO_MESES_BONUS, MIN_INDICADOS_EMBAIXADOR, RE_CODIGO_INDICACAO, LINK_INDICACAO, normalizarCodigo, recalcularIndicador }
