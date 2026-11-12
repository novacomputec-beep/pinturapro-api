// Obras × especialidades inferidas (utils/especialidadesInferidas) — o que precisa de alertaService:
//   reanunciarObraParaInferidos(obraId) — "Nova obra disponível!" (push + e-mail, registrado em
//       push_entregas/email_alertas tipo 'obra') SÓ a quem casa pelas especialidades inferidas e
//       NÃO é do público genérico de obras (inferidas.somente) e ainda não foi avisado desta obra
//       (excluirJaAvisados / claim de e-mail). Mesmo alcance, teto diário e filtros do aviso normal.
//   rodarBackfillEReanuncioUnico() — no boot (server.js): preenche especialidades_inferidas das
//       obras abertas ainda sem lista e, UMA vez (claim em configuracoes), reanuncia as obras de
//       CODIGOS_REANUNCIO aos recém-casados; grava o resultado em configuracoes para leitura.
const { pool } = require('../utils/supabase')
const { backfillEspecialidadesInferidas, gravarEspecialidadesInferidas } = require('../utils/especialidadesInferidas')
const { normalizar } = require('../utils/localidade')
const alerta = () => require('./alertaService')

const CODIGOS_REANUNCIO = ['YS5XR', 'BR5V3']
const CHAVE_CLAIM = 'reanuncio_inferidas_v1'
const CHAVE_RESULTADO = 'reanuncio_inferidas_v1_resultado'

// somente (default true): só quem casa pelas inferidas e NÃO é do público genérico. false = o público
// NORMAL de obra nova inteiro com as regras de hoje (genérico + inferidas), sempre menos quem já foi
// avisado desta obra — é o reanúncio único por obra (REANUNCIOS_UNICOS_OBRA).
const reanunciarObraParaInferidos = async (obraId, { somente = true } = {}) => {
  const { broadcastPaginado, enviarEmailsNovaDemanda, mensagemNovaObra, ponto } = alerta()
  const r = await pool.query(
    // categoria: mensagemNovaObra usa o emoji e o rótulo dela — sem a coluna o push saía "🎨 … publicada!"
    // sem "Categoria: …", diferente do aviso normal de obra nova.
    `SELECT id, codigo_publico, titulo, descricao, categoria, cidade, uf, latitude, longitude, especialidades_inferidas, status, status_aprovacao, expira_em > NOW() AS vigente, match_usuario_id
       FROM obras WHERE id = $1`, [obraId])
  const obra = r.rows[0]
  if (!obra) return { erro: 'obra não encontrada' }
  let slugs = obra.especialidades_inferidas
  if (!Array.isArray(slugs)) slugs = await gravarEspecialidadesInferidas(pool, obra.id, obra)
  const base = { codigo: obra.codigo_publico, slugs: slugs || [] }
  if (!slugs || slugs.length === 0) return { ...base, pulado: 'sem especialidade inferida' }
  if (obra.status !== 'aberta' || obra.status_aprovacao !== 'aprovada' || !obra.vigente || obra.match_usuario_id) return { ...base, pulado: 'obra não está aberta no feed' }
  const cidade = normalizar(obra.cidade), uf = String(obra.uf || '').trim().toUpperCase()
  if (!cidade || !uf) return { ...base, pulado: 'obra sem cidade/uf' }
  const total = await broadcastPaginado({
    publico: 'obras', cidade, uf,
    ...mensagemNovaObra(obra, obra.id),
    rotulo: `reanúncio inferidas obra ${obra.id}`,
    entrega: { tipo: 'obra', demandaId: obra.id },
    demanda: { tabela: 'obras', id: obra.id },
    porDistancia: ponto(obra),
    tetoDiario: { tabela: 'obras', demandaId: obra.id, ...ponto(obra), lote: [] },
    inferidas: { slugs, somente },
    excluirJaAvisados: { tipo: 'obra', demandaId: obra.id },
  })
  // E-mail aos mesmos (o claim de email_alertas tipo 'obra' já exclui quem recebeu o e-mail original).
  const emailsAntes = await pool.query(`SELECT count(*)::int AS n FROM email_alertas WHERE tipo = 'obra' AND demanda_id = $1`, [obra.id])
  await enviarEmailsNovaDemanda('obras', obra.id, { inferidasSomente: somente })
  const emails = await pool.query(`SELECT count(*)::int AS n FROM email_alertas WHERE tipo = 'obra' AND demanda_id = $1`, [obra.id])
  return { ...base, push_enviados: total?.enviados ?? 0, push_elegiveis: total?.elegiveis ?? 0, acima_do_teto: total?.acimaDoTeto ?? 0,
           emails_enviados: emails.rows[0].n - emailsAntes.rows[0].n, emails_total_obra: emails.rows[0].n }
}

// REANÚNCIO ÚNICO POR OBRA (dono, 12/11/2026): obra publicada ANTES de uma regra de público (ex.: a de
// água/esgoto das especialidades inferidas, 10/11 10:53) recebe UMA vez o aviso normal de obra nova com
// as regras de hoje, só para quem ainda não foi avisado dela. Claim em configuracoes (chave por obra);
// só entre 08h e 20h de São Paulo — fora disso não reivindica e o tique seguinte tenta de novo.
// Obra que não está mais aberta/sem match: claim gravado, nada enviado, sem log de envio.
const REANUNCIOS_UNICOS_OBRA = [
  { chave: 'reanuncio_obra_3eab5c42', obraId: '3eab5c42-d85b-4105-a8bb-5017eb2ef29f' },
]
const SQL_JANELA_DIA_SP = `EXTRACT(HOUR FROM NOW() AT TIME ZONE 'America/Sao_Paulo') >= 8 AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'America/Sao_Paulo') < 20`
let reanunciosUnicosEmExecucao = false
const rodarReanunciosUnicosPorObra = async (lista = REANUNCIOS_UNICOS_OBRA) => {
  if (reanunciosUnicosEmExecucao) return []
  reanunciosUnicosEmExecucao = true
  const feitos = []
  try {
    for (const { chave, obraId } of lista) {
      try {
        const claim = await pool.query(
          `INSERT INTO configuracoes (chave, valor) SELECT $1, NOW()::text WHERE ${SQL_JANELA_DIA_SP}
           ON CONFLICT (chave) DO NOTHING RETURNING chave`, [chave])
        if (claim.rows.length === 0) continue
        const r = await reanunciarObraParaInferidos(obraId, { somente: false })
        await pool.query(`UPDATE configuracoes SET valor = $2, atualizado_em = NOW() WHERE chave = $1`, [chave, JSON.stringify({ em: new Date().toISOString(), ...r })])
        if (r.pulado || r.erro) { feitos.push({ chave, ...r }); continue }
        console.log(`[reanuncio] obra ${obraId.slice(0, 8)}: ${r.push_enviados} push, ${r.emails_enviados} e-mail`)
        feitos.push({ chave, ...r })
      } catch (err) {
        // Erro antes de terminar: solta o claim para o próximo tique tentar de novo (quem já recebeu
        // fica de fora pelo push_entregas / email_alertas, então não há envio em dobro).
        console.error(`[reanuncio] obra ${obraId.slice(0, 8)}:`, err.message)
        await pool.query(`DELETE FROM configuracoes WHERE chave = $1`, [chave]).catch(() => {})
      }
    }
  } finally {
    reanunciosUnicosEmExecucao = false
  }
  return feitos
}

const rodarBackfillEReanuncioUnico = async () => {
  try {
    const n = await backfillEspecialidadesInferidas(pool)
    if (n > 0) console.log(`[Inferidas] backfill: ${n} obra(s) aberta(s) ganharam especialidades_inferidas`)
    const claim = await pool.query(
      `INSERT INTO configuracoes (chave, valor) VALUES ($1, NOW()::text) ON CONFLICT (chave) DO NOTHING RETURNING chave`, [CHAVE_CLAIM])
    if (claim.rows.length === 0) return null
    const resultado = []
    for (const codigo of CODIGOS_REANUNCIO) {
      const o = await pool.query(`SELECT id FROM obras WHERE codigo_publico = $1`, [codigo])
      if (!o.rows[0]) { resultado.push({ codigo, pulado: 'código não encontrado' }); continue }
      try {
        resultado.push(await reanunciarObraParaInferidos(o.rows[0].id))
      } catch (err) {
        resultado.push({ codigo, erro: err.message })
      }
    }
    await pool.query(
      `INSERT INTO configuracoes (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`,
      [CHAVE_RESULTADO, JSON.stringify({ em: new Date().toISOString(), resultado })])
    console.log('[Inferidas] reanúncio único:', JSON.stringify(resultado))
    return resultado
  } catch (err) {
    console.error('[Inferidas] backfill/reanúncio:', err.message)
    return null
  }
}

module.exports = { reanunciarObraParaInferidos, rodarBackfillEReanuncioUnico, rodarReanunciosUnicosPorObra, REANUNCIOS_UNICOS_OBRA, CODIGOS_REANUNCIO, CHAVE_CLAIM, CHAVE_RESULTADO }
