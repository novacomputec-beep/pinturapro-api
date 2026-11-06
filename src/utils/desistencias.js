// Desistências de uma demanda, para o DONO (GET /reparos/:id e GET /obras/:id): os interesses /
// candidaturas que o PRÓPRIO profissional cancelou depois de casado — status 'cancelado' com
// cancelado_por = o profissional (cancelamentoMatchService, cancelamento livre, tardio ou por
// acordo que ELE pediu). Ficam de fora: "desfazer escolha" do dono (cancelado_por = dono,
// motivo escolha_desfeita), cancelamento pelo dono e pelo admin, e os 'recusado'/'expirado' dos
// crons. Cada item: id, primeiro nome, avatar otimizado, quando, motivo em português (3ª pessoa:
// "Não consegue no horário", "Não precisa mais") e se foi por acordo. Mais recente primeiro.
// interessados_ativos: quem ainda está na disputa ('pendente' ou 'contraproposta_dono').
const { pool } = require('./supabase')
const { fotoOtimizada } = require('./donoResumo')

const LADOS = {
  reparos: { proposta: 'interesse_reparos', coluna: 'reparo_id' },
  obras:   { proposta: 'candidaturas',      coluna: 'obra_id' },
}
const ROTULO_DESISTENCIA = {
  imprevisto: 'Imprevisto', nao_consigo_horario: 'Não consegue no horário',
  nao_preciso: 'Não precisa mais', outro: 'Outro motivo',
}
const STATUS_ATIVOS = ['pendente', 'contraproposta_dono']

const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0] || null
const rotuloMotivo = (motivo) => ROTULO_DESISTENCIA[motivo] || (motivo ? String(motivo) : 'Outro motivo')

const listarDesistencias = async (tabela, demandaId, db = pool) => {
  const lado = LADOS[tabela]
  if (!lado) throw new Error(`listarDesistencias: tabela inválida ${tabela}`)
  const r = await db.query(
    `SELECT x.id, x.usuario_id, u.nome, u.foto_url, x.cancelado_em, x.cancelado_motivo, x.cancelado_detalhe, x.cancelado_acordo
       FROM ${lado.proposta} x JOIN usuarios u ON u.id = x.usuario_id
      WHERE x.${lado.coluna} = $1 AND x.status = 'cancelado' AND x.cancelado_por = x.usuario_id
      ORDER BY x.cancelado_em DESC NULLS LAST, x.id`,
    [demandaId]
  )
  return r.rows.map(x => ({
    id: x.id,
    usuario_id: x.usuario_id,
    nome: primeiroNome(x.nome),
    foto_url: fotoOtimizada(x.foto_url),
    cancelado_em: x.cancelado_em,
    motivo: x.cancelado_motivo || null,
    motivo_texto: rotuloMotivo(x.cancelado_motivo),
    detalhe: x.cancelado_detalhe || null,
    acordo: !!x.cancelado_acordo,
  }))
}

const contarInteressadosAtivos = async (tabela, demandaId, db = pool) => {
  const lado = LADOS[tabela]
  if (!lado) throw new Error(`contarInteressadosAtivos: tabela inválida ${tabela}`)
  const r = await db.query(
    `SELECT count(*)::int AS n FROM ${lado.proposta} WHERE ${lado.coluna} = $1 AND status = ANY($2::text[])`,
    [demandaId, STATUS_ATIVOS]
  )
  return r.rows[0].n
}

module.exports = { listarDesistencias, contarInteressadosAtivos, ROTULO_DESISTENCIA, STATUS_ATIVOS }
