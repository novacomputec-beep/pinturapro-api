// Desistências de uma demanda, para o DONO (GET /reparos/:id e GET /obras/:id): os interesses /
// candidaturas que o PRÓPRIO profissional cancelou depois de casado — status 'cancelado' com
// cancelado_por = o profissional (cancelamentoMatchService, cancelamento livre, tardio ou por
// acordo que ELE pediu). Ficam de fora: "desfazer escolha" do dono (cancelado_por = dono,
// motivo escolha_desfeita), cancelamento pelo dono e pelo admin, e os 'recusado'/'expirado' dos
// crons. Cada item: id, primeiro nome, avatar otimizado, quando, motivo em português (3ª pessoa:
// "Não consegue no horário", "Não precisa mais") e se foi por acordo. Mais recente primeiro.
// interessados_ativos: quem ainda está na disputa ('pendente' ou 'contraproposta_dono').
// desistenciaRecentePorDemanda: a desistência MAIS RECENTE de cada demanda de uma lista (GET
// /reparos/minhas e /obras/minhas), numa consulta só (DISTINCT ON), no formato resumido
// { id, nome, foto_url, cancelado_em, motivo_texto, acordo }; o chamador só a expõe nas demandas
// SEM profissional escolhido.
//
// CONTA EXCLUÍDA (dono, 11/11/2026): quando a conta do profissional ESCOLHIDO é apagada, a cascata
// leva o interesse/candidatura dele e a linha de usuarios — a desistência sumiria junto. Por isso a
// exclusão (cancelamentoMatchService.desfazerMatchesPorExclusao) grava ANTES uma linha na tabela
// `desistencias` com um RETRATO do profissional (nome_curto "Elaine K.", foto_url, genero quando
// conhecido), usuario_id como id simples (sem FK), motivo 'conta_excluida'. As leituras daqui
// juntam as duas fontes; quando a linha de usuarios já não existe (LEFT JOIN), o nome/foto saem do
// retrato. O rótulo de 'conta_excluida' muda com o gênero guardado: "A profissional…" só quando
// genero = 'f'; desconhecido ou masculino → "O profissional…". (Hoje usuarios não guarda gênero,
// então o retrato nasce com genero NULL — a coluna já existe para quando houver.)
const { pool } = require('./supabase')
const { fotoOtimizada, nomeCurto } = require('./donoResumo')

const LADOS = {
  reparos: { proposta: 'interesse_reparos', coluna: 'reparo_id' },
  obras:   { proposta: 'candidaturas',      coluna: 'obra_id' },
}
const MOTIVO_CONTA_EXCLUIDA = 'conta_excluida'
const ROTULO_DESISTENCIA = {
  imprevisto: 'Imprevisto', nao_consigo_horario: 'Não consegue no horário',
  nao_preciso: 'Não precisa mais', outro: 'Outro motivo',
  conta_excluida: 'O profissional excluiu a conta e não vai mais fazer o serviço.',
}
const ROTULO_CONTA_EXCLUIDA_F = 'A profissional excluiu a conta e não vai mais fazer o serviço.'
const STATUS_ATIVOS = ['pendente', 'contraproposta_dono']

const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0] || null
const rotuloMotivo = (motivo, genero = null) => {
  if (motivo === MOTIVO_CONTA_EXCLUIDA) return String(genero || '').toLowerCase().startsWith('f') ? ROTULO_CONTA_EXCLUIDA_F : ROTULO_DESISTENCIA.conta_excluida
  return ROTULO_DESISTENCIA[motivo] || (motivo ? String(motivo) : 'Outro motivo')
}

// Tabela do retrato (migração de boot; idempotente). usuario_id SEM FK de propósito: a conta some.
const migrarDesistencias = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS desistencias (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tabela      TEXT NOT NULL,
      demanda_id  UUID NOT NULL,
      usuario_id  UUID,
      nome_curto  TEXT,
      foto_url    TEXT,
      genero      TEXT,
      motivo      TEXT NOT NULL,
      criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  await client.query(`CREATE INDEX IF NOT EXISTS desistencias_demanda_idx ON desistencias (tabela, demanda_id, criado_em DESC)`)
}
// Grava o retrato DENTRO da transação de quem chama (antes da cascata apagar o usuário).
// `usuario` = { id, nome, foto_url, genero? } como está em usuarios naquele momento.
const registrarDesistenciaSnapshot = async (client, { tabela, demandaId, usuario, motivo = MOTIVO_CONTA_EXCLUIDA }) => {
  if (!LADOS[tabela]) throw new Error(`registrarDesistenciaSnapshot: tabela inválida ${tabela}`)
  const r = await client.query(
    `INSERT INTO desistencias (tabela, demanda_id, usuario_id, nome_curto, foto_url, genero, motivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [tabela, demandaId, usuario?.id || null, nomeCurto(usuario?.nome), usuario?.foto_url || null, usuario?.genero || null, motivo]
  )
  return r.rows[0].id
}

// As duas fontes com as MESMAS colunas: propostas canceladas pelo próprio profissional (nome/foto da
// conta, ou do retrato se a conta já não existe) + retratos da exclusão de conta. `tabela` entra
// como literal (vem de LADOS, nunca do request).
const sqlFontes = (tabela, lado, pDemandas) => `
     SELECT x.id, x.usuario_id, x.${lado.coluna} AS demanda_id,
            COALESCE(u.nome, s.nome_curto) AS nome, COALESCE(u.foto_url, s.foto_url) AS foto_url, s.genero,
            x.cancelado_em, x.cancelado_motivo, x.cancelado_detalhe, x.cancelado_acordo
       FROM ${lado.proposta} x
       LEFT JOIN usuarios u ON u.id = x.usuario_id
       LEFT JOIN LATERAL (SELECT nome_curto, foto_url, genero FROM desistencias d
                           WHERE d.tabela = '${tabela}' AND d.demanda_id = x.${lado.coluna} AND d.usuario_id = x.usuario_id
                           ORDER BY d.criado_em DESC LIMIT 1) s ON true
      WHERE x.${lado.coluna} = ANY(${pDemandas}::uuid[]) AND x.status = 'cancelado' AND x.cancelado_por = x.usuario_id
     UNION ALL
     SELECT d.id, d.usuario_id, d.demanda_id, d.nome_curto, d.foto_url, d.genero,
            d.criado_em, d.motivo, NULL::text, false
       FROM desistencias d
      WHERE d.tabela = '${tabela}' AND d.demanda_id = ANY(${pDemandas}::uuid[])
        -- a proposta dele já foi apagada pela cascata; se por algum motivo ainda existir cancelada,
        -- a primeira fonte já a mostra e o retrato não duplica.
        AND NOT EXISTS (SELECT 1 FROM ${lado.proposta} p WHERE p.${lado.coluna} = d.demanda_id AND p.usuario_id = d.usuario_id AND p.status = 'cancelado')`

const listarDesistencias = async (tabela, demandaId, db = pool) => {
  const lado = LADOS[tabela]
  if (!lado) throw new Error(`listarDesistencias: tabela inválida ${tabela}`)
  const r = await db.query(
    `SELECT * FROM (${sqlFontes(tabela, lado, '$1')}) f ORDER BY f.cancelado_em DESC NULLS LAST, f.id`,
    [[demandaId]]
  )
  return r.rows.map(x => ({
    id: x.id,
    usuario_id: x.usuario_id,
    nome: primeiroNome(x.nome),
    foto_url: fotoOtimizada(x.foto_url),
    cancelado_em: x.cancelado_em,
    motivo: x.cancelado_motivo || null,
    motivo_texto: rotuloMotivo(x.cancelado_motivo, x.genero),
    detalhe: x.cancelado_detalhe || null,
    acordo: !!x.cancelado_acordo,
  }))
}

// Resumo de um item para a lista (sem usuario_id, motivo cru nem detalhe).
const resumo = (x) => ({
  id: x.id, nome: primeiroNome(x.nome), foto_url: fotoOtimizada(x.foto_url),
  cancelado_em: x.cancelado_em, motivo_texto: rotuloMotivo(x.cancelado_motivo, x.genero), acordo: !!x.cancelado_acordo,
})
// { [demandaId]: resumo } só para as demandas que têm desistência; `ids` vazio → {}.
const desistenciaRecentePorDemanda = async (tabela, ids, db = pool) => {
  const lado = LADOS[tabela]
  if (!lado) throw new Error(`desistenciaRecentePorDemanda: tabela inválida ${tabela}`)
  const lista = [...new Set((ids || []).filter(Boolean).map(String))]
  if (lista.length === 0) return {}
  const r = await db.query(
    `SELECT DISTINCT ON (f.demanda_id) f.* FROM (${sqlFontes(tabela, lado, '$1')}) f
      ORDER BY f.demanda_id, f.cancelado_em DESC NULLS LAST, f.id`,
    [lista]
  )
  const mapa = {}
  for (const x of r.rows) mapa[x.demanda_id] = resumo(x)
  return mapa
}
// Aplica desistencia_recente a cada linha de uma lista de demandas (as linhas já carregadas de
// /minhas): só quem está SEM match recebe o item; com match (ou sem desistência) fica null.
const anexarDesistenciaRecente = async (tabela, linhas, db = pool) => {
  const semMatch = linhas.filter(l => !l.match_usuario_id)
  const mapa = await desistenciaRecentePorDemanda(tabela, semMatch.map(l => l.id), db)
  for (const l of linhas) l.desistencia_recente = (!l.match_usuario_id && mapa[l.id]) || null
  return linhas
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

module.exports = {
  listarDesistencias, contarInteressadosAtivos, desistenciaRecentePorDemanda, anexarDesistenciaRecente,
  migrarDesistencias, registrarDesistenciaSnapshot, rotuloMotivo,
  ROTULO_DESISTENCIA, ROTULO_CONTA_EXCLUIDA_F, MOTIVO_CONTA_EXCLUIDA, STATUS_ATIVOS,
}
