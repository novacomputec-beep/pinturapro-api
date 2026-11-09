const { pool } = require('./supabase')
const { sqlProfissionalDaPessoa, sqlArrayProfissionaisDaPessoa } = require('./tipoConta')

// AVISO "FORA DA SUA ÁREA" (decisão do dono, 09/11/2026) — as peças de dados; o envio em si
// (claim por demanda, público e texto) mora em alertaService.avisarForaDaArea.
//
// Quando um serviço ou uma obra é publicado, além do público normal (quem pode trabalhar naquele
// lado E casa com a categoria), os demais profissionais da MESMA CIDADE com
// usuarios.avisos_todas_areas = true recebem UM push — só push, nunca e-mail, então não entra no
// teto do Brevo — convidando a ver o pedido ou indicar quem faz.
//
//   usuarios.avisos_todas_areas  BOOLEAN NOT NULL DEFAULT TRUE — a preferência, por conta. Nasce
//       ligada para todo mundo (existentes e novos); o profissional desliga em PUT /auth/perfil.
//   obras/reparos.aviso_fora_area_em  — claim por demanda (NULL = ainda não avisado). O aviso só
//       sai entre 08h e 20h de São Paulo (a janela dos lembretes): demanda publicada fora dela
//       fica com NULL e o cron a pega quando a janela abre.
//   avisos_fora_area  — uma linha por push ENVIADO (demanda × conta). É o que o teto diário conta;
//       tabela própria porque push_entregas é a entrega do aviso de demanda nova (CHECK de tipo,
//       repescagem, "profissionais avisados" do dono) e este aviso não é nada disso.
//   configuracoes.limite_avisos_fora_area_dia  — teto por PESSOA por dia de São Paulo; '0' (o
//       padrão) = sem limite. O painel ajusta em POST /config/limite-avisos-fora-area.
const CHAVE_LIMITE_FORA_AREA = 'limite_avisos_fora_area_dia'
const LIMITE_FORA_AREA_PADRAO = 0
const CHAVE_BACKFILL_FORA_AREA = 'backfill_aviso_fora_area_em'
// O log só serve ao teto do DIA; guardar uma semana dá folga para conferir e mantém a tabela pequena.
const RETENCAO_LOG_DIAS = 7

// Migração de boot (chamada dentro da transação de routes/index.js, DEPOIS de configuracoes e de
// push_novo_enviado_em existirem). Idempotente. Exportada para o teste rodar os MESMOS statements.
// Backfill ÚNICO (marcador em configuracoes, como o de push_novo_enviado_em): toda demanda que JÁ
// tinha sido anunciada quando a coluna nasceu é marcada como avisada — sem isso o primeiro tique
// do cron depois do deploy dispararia o aviso para todas as demandas abertas de uma vez. Demanda
// ainda não anunciada (aguardando aprovação/mídias) fica NULL e recebe o aviso quando for publicada.
const migrarAvisosForaDaArea = async (client) => {
  await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS avisos_todas_areas BOOLEAN NOT NULL DEFAULT TRUE`)
  await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS aviso_fora_area_em TIMESTAMPTZ`)
  await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS aviso_fora_area_em TIMESTAMPTZ`)
  await client.query(`
    CREATE TABLE IF NOT EXISTS avisos_fora_area (
      tabela     TEXT NOT NULL CHECK (tabela IN ('obras', 'reparos')),
      demanda_id UUID NOT NULL,
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      enviado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tabela, demanda_id, usuario_id)
    )`)
  await client.query(`CREATE INDEX IF NOT EXISTS avisos_fora_area_usuario_dia_idx ON avisos_fora_area (usuario_id, enviado_em)`)
  await client.query(`CREATE INDEX IF NOT EXISTS avisos_fora_area_enviado_em_idx ON avisos_fora_area (enviado_em)`)
  await client.query(
    `INSERT INTO configuracoes (chave, valor) SELECT $1, $2
      WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = $1)`,
    [CHAVE_LIMITE_FORA_AREA, String(LIMITE_FORA_AREA_PADRAO)])
  const marcador = await client.query(
    `INSERT INTO configuracoes (chave, valor) SELECT $1, NOW()::text
      WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = $1)
      RETURNING chave`,
    [CHAVE_BACKFILL_FORA_AREA])
  if (marcador.rows.length === 1) {
    for (const tabela of ['obras', 'reparos']) {
      await client.query(
        `UPDATE ${tabela} SET aviso_fora_area_em = NOW()
          WHERE aviso_fora_area_em IS NULL AND push_novo_enviado_em IS NOT NULL`)
    }
    console.log('[migration] backfill aviso_fora_area_em: demandas já anunciadas marcadas como avisadas')
  }
}

// Teto EFETIVO (inteiro ≥ 0; 0 = sem limite). Lido a cada uso, sem cache, como as demais chaves.
// Valor ausente, vazio, negativo ou não numérico cai no padrão — nunca num teto inventado.
const lerLimiteAvisosForaDaArea = async (db = pool) => {
  const r = await db.query(`SELECT valor FROM configuracoes WHERE chave = $1`, [CHAVE_LIMITE_FORA_AREA])
  const n = Number(String(r.rows[0]?.valor ?? '').trim() || NaN)
  return Number.isInteger(n) && n >= 0 ? n : LIMITE_FORA_AREA_PADRAO
}
const gravarLimiteAvisosForaDaArea = async (limite, db = pool) => {
  await db.query(
    `INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`,
    [CHAVE_LIMITE_FORA_AREA, String(limite)])
}

// Predicado do teto, por PESSOA (contas profissionais do mesmo CPF — utils/tipoConta): verdadeiro
// quando a pessoa de `exprUsuarioId` ainda está ABAIXO do limite de hoje (dia de São Paulo).
// `paramLimite` ≤ 0 = sem limite: o OR curto-circuita e a contagem nem roda.
const SQL_INICIO_DO_DIA_SP = `(date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`
const sqlAbaixoDoLimiteForaDaArea = (paramLimite, exprUsuarioId = 'u.id') => `(${paramLimite}::int <= 0 OR (
          SELECT count(*) FROM avisos_fora_area af
           WHERE ${sqlProfissionalDaPessoa('af.usuario_id', exprUsuarioId)}
             AND af.enviado_em >= ${SQL_INICIO_DO_DIA_SP}) < ${paramLimite}::int)`

// BLOQUEIOS, por PESSOA: verdadeiro quando NENHUMA conta profissional da pessoa de `exprUsuarioId`
// está na lista negra da demanda (prestadores_bloqueados) nem foi bloqueada pelo dono dela
// (prestadores_bloqueados_dono) — as mesmas duas travas dos feeds. `tabela` vem de literal do
// chamador ('obras' | 'reparos'), nunca do request; `paramDemanda` é o placeholder do id.
const sqlSemBloqueioNaDemanda = (tabela, paramDemanda, exprUsuarioId = 'u.id') => {
  if (tabela !== 'obras' && tabela !== 'reparos') throw new Error(`sqlSemBloqueioNaDemanda: tabela inválida ${tabela}`)
  return `NOT EXISTS (
          SELECT 1 FROM ${tabela} bd
           WHERE bd.id = ${paramDemanda}::uuid
             AND (COALESCE(bd.prestadores_bloqueados, '{}') && ${sqlArrayProfissionaisDaPessoa(exprUsuarioId)}
                  OR EXISTS (SELECT 1 FROM prestadores_bloqueados_dono pb
                              WHERE pb.dono_id = bd.criado_por
                                AND ${sqlProfissionalDaPessoa('pb.prestador_id', exprUsuarioId)})))`
}

// Registra os pushes ENVIADOS de uma página do broadcast (resultados de enviarPushEmLoteDetalhado:
// [{ id, resultado }]). Falha e token inválido não contam no teto.
const registrarAvisosForaDaArea = async (tabela, demandaId, resultados, db = pool) => {
  const ids = (resultados || []).filter(r => r.resultado === 'enviado').map(r => r.id)
  if (ids.length === 0) return 0
  await db.query(
    `INSERT INTO avisos_fora_area (tabela, demanda_id, usuario_id)
     SELECT $1, $2::uuid, x FROM unnest($3::uuid[]) AS x
     ON CONFLICT (tabela, demanda_id, usuario_id) DO NOTHING`,
    [tabela, demandaId, ids])
  return ids.length
}
const limparAvisosForaDaAreaAntigos = (db = pool) =>
  db.query(`DELETE FROM avisos_fora_area WHERE enviado_em < NOW() - (${RETENCAO_LOG_DIAS} * INTERVAL '1 day')`)

module.exports = {
  CHAVE_LIMITE_FORA_AREA, LIMITE_FORA_AREA_PADRAO, CHAVE_BACKFILL_FORA_AREA,
  migrarAvisosForaDaArea, lerLimiteAvisosForaDaArea, gravarLimiteAvisosForaDaArea,
  sqlAbaixoDoLimiteForaDaArea, sqlSemBloqueioNaDemanda, registrarAvisosForaDaArea, limparAvisosForaDaAreaAntigos,
}
