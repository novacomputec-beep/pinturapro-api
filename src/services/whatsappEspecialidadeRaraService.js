// ROBÔ DE WHATSAPP — tipo 'especialidade_rara' (dono, 23/11/2026). Roda na API (job de server.js, a
// cada 15 min); o worker (src/whatsapp) continua só enviando.
//
// PEDIDO que entra (serviço e obra): aberto, aprovado, sem profissional escolhido, com ZERO
//   interessados vivos (fila.sqlInteresseVivo), no ÚLTIMO QUARTO do prazo — o que resta até
//   expira_em é no máximo 1/4 da janela inteira (publicação → expira_em; obra: publicado_em, senão
//   criado_em) — e com pelo menos 1 h pela frente.
// ESPECIALIDADE RARA: a especialidade EXATA do pedido (serviço: reparos.categorias/categoria; obra:
//   obras.especialidades_inferidas — obras.categoria é o tipo do imóvel, não um ofício; 'outros'
//   nunca conta) que tem de 1 a 15 profissionais ATIVOS no alcance do pedido. Ativo e alcance são os
//   do aviso de pedido novo (alertaService.broadcastPaginado): conta 'prestador' ativa, assinatura
//   ativa, pessoa não suspensa, mesma cidade + UF ou até min(raio escolhido, 50 km); uma linha por
//   PESSOA (mesmo CPF). Pedido com várias categorias: vale cada categoria rara dele.
// QUEM RECEBE: até 5 por pedido, os MAIS PRÓXIMOS primeiro (sem coordenadas → por último), entre os
//   da especialidade rara que: não viram o pedido no feed (feed_visualizacoes), nunca manifestaram
//   interesse nele, não estão bloqueados nele, atendem o local do serviço, têm telefone, não
//   responderam SAIR (usuarios.whatsapp_avisos) e não têm aviso deste tipo na fila nem enviado nas
//   últimas 24 h (por pessoa e por número). A mesma pessoa nunca é avisada duas vezes do MESMO
//   pedido (chave de dedupe 'rara:<tabela>:<pedido>:<conta>' + conferência por pessoa).
// Só enfileira com o tipo LIGADO no painel (padrão: desligado), com o worker dizendo que pode
// enviar (trava de teste) e dentro da janela 08–21h — fora dela a fila encheria de avisos que, de
// manhã, já teriam perdido o prazo. O worker redige o texto na hora do envio ("Termina em…") e tira
// da fila o aviso do pedido que ganhou interessado, fechou ou venceu (fila.sqlRaraVale).
const { pool } = require('../utils/supabase')
const { enfileirar } = require('./whatsappFilaService')
const { lerConfig, sqlPedidoAbertoSemEscolhido, sqlInteresseVivo } = require('../whatsapp/fila')
const { TIPO_RARA, RARA_INTERVALO_JOB_MIN, RARA_MAX_PROFISSIONAIS, RARA_MAX_AVISOS_POR_PEDIDO, RARA_MIN_RESTANTE_MIN, RARA_INTERVALO_PESSOA_HORAS,
        normalizarTelefone, variantesTelefone, lerTrava, travaPermite, dentroDaJanela } = require('../whatsapp/config')
const T = require('../whatsapp/textos')
const { normalizar, sqlNormalizarCidade } = require('../utils/localidade')
const { sqlAlcance, sqlKm } = require('../utils/avisosPorDistancia')
const { sqlProfissionalDaPessoa, sqlPessoaNaoSuspensa } = require('../utils/tipoConta')
const { sqlCpfNormalizado, sqlNaoMesmoCpfDoCriador } = require('../utils/demandaPropria')
const { sqlAtendeLocalDaDemanda } = require('../utils/localAtendimento')
const { sqlSemBloqueioNaDemanda } = require('../utils/avisosForaDaArea')
const { apresentacaoReparo, apresentacaoConstrucao, categoriasDoReparo } = require('../utils/categoriasApp')

const INTERVALO_MS = RARA_INTERVALO_JOB_MIN * 60 * 1000
const LADOS = {
  reparos: { item: 'reparo', interesse: 'interesse_reparos', fk: 'reparo_id', inicio: 'd.criado_em' },
  obras:   { item: 'obra',   interesse: 'candidaturas',      fk: 'obra_id',   inicio: 'COALESCE(d.publicado_em, d.criado_em)' },
}
// Status de linha que NÃO chegou à pessoa: não conta para o limite de 24 h nem para os 5 do pedido.
const SQL_NAO_SAIU = `('falha', 'sem_whatsapp', 'saiu')`

const chaveDoAviso = (tabela, demandaId, usuarioId) => `rara:${tabela}:${demandaId}:${usuarioId}`
// Rótulo da especialidade: serviço, depois construção; slug desconhecido sai legível.
const rotuloDaEspecialidade = (slug) => {
  for (const apresentar of [apresentacaoReparo, apresentacaoConstrucao]) {
    const { rotulo } = apresentar(slug)
    if (rotulo && rotulo !== slug) return rotulo
  }
  return String(slug).replace(/_/g, ' ')
}
// Especialidades EXATAS do pedido (sem 'outros', que é "qualquer um", não um ofício).
const especialidadesDoPedido = (tabela, d) =>
  [...new Set((tabela === 'reparos' ? categoriasDoReparo(d) : (d.especialidades_inferidas || [])).filter(s => s && s !== 'outros'))]

const sqlPedidos = (tabela) => {
  const l = LADOS[tabela]
  return `SELECT '${tabela}'::text AS tabela, d.id, d.titulo, d.codigo_publico, d.cidade, d.uf, d.latitude, d.longitude, d.expira_em,
              ${tabela === 'reparos' ? 'd.categoria, d.categorias, NULL::text[] AS especialidades_inferidas' : 'NULL::text AS categoria, NULL::text[] AS categorias, d.especialidades_inferidas'}
         FROM ${tabela} d
        WHERE ${sqlPedidoAbertoSemEscolhido('d', 'NOW()')}
          AND d.expira_em >= NOW() + INTERVAL '${RARA_MIN_RESTANTE_MIN} minutes'
          AND (d.expira_em - NOW()) <= (d.expira_em - ${l.inicio}) / 4
          AND NULLIF(btrim(d.codigo_publico), '') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${l.interesse} i WHERE i.${l.fk} = d.id AND ${sqlInteresseVivo('i')})`
}

// Profissionais ATIVOS no alcance do pedido com alguma das especialidades ($6), um por pessoa, com
// o que decide se cada um pode receber. $1 pedido, $2 cidade normalizada, $3 UF, $4/$5 lat/lng.
const sqlPublico = (tabela) => {
  const l = LADOS[tabela]
  const mesmaCidade = `(NULLIF(btrim(u.cidade), '') IS NOT NULL AND NULLIF(btrim(u.uf), '') IS NOT NULL
              AND ${sqlNormalizarCidade('u.cidade')} = $2 AND upper(btrim(u.uf)) = $3)`
  const temCoordenadas = `($4::float8 IS NOT NULL AND $5::float8 IS NOT NULL AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL)`
  return `SELECT DISTINCT ON (COALESCE(${sqlCpfNormalizado('u.cpf_cnpj')}, u.id::text))
              u.id, u.nome, u.telefone, u.especialidades,
              CASE WHEN ${temCoordenadas} THEN ${sqlKm('u.latitude', 'u.longitude', '$4', '$5')} END AS km,
              COALESCE(u.whatsapp_avisos, true) AS quer_avisos,
              EXISTS (SELECT 1 FROM feed_visualizacoes fv WHERE fv.item_tipo = '${l.item}' AND fv.item_id = $1::uuid
                         AND ${sqlProfissionalDaPessoa('fv.usuario_id', 'u.id')}) AS viu,
              EXISTS (SELECT 1 FROM ${l.interesse} i WHERE i.${l.fk} = $1::uuid AND ${sqlProfissionalDaPessoa('i.usuario_id', 'u.id')}) AS manifestou,
              (${sqlSemBloqueioNaDemanda(tabela, '$1', 'u.id')}) AS sem_bloqueio,
              (${sqlAtendeLocalDaDemanda(tabela, '$1')}) AS atende_local,
              EXISTS (SELECT 1 FROM whatsapp_mensagens x WHERE x.tipo = '${TIPO_RARA}' AND x.ref_id = $1::uuid
                         AND ${sqlProfissionalDaPessoa('x.usuario_id', 'u.id')}) AS ja_deste_pedido,
              EXISTS (SELECT 1 FROM whatsapp_mensagens x WHERE x.tipo = '${TIPO_RARA}' AND x.status NOT IN ${SQL_NAO_SAIU}
                         AND (x.status = 'fila' OR x.enviada_em > NOW() - INTERVAL '${RARA_INTERVALO_PESSOA_HORAS} hours')
                         AND ${sqlProfissionalDaPessoa('x.usuario_id', 'u.id')}) AS recebeu_recente
         FROM usuarios u
         JOIN assinaturas a ON a.usuario_id = u.id
        WHERE u.role = 'prestador' AND COALESCE(u.ativo, true)
          AND a.status = 'ativa' AND (a.proximo_vencimento IS NULL OR a.proximo_vencimento > NOW())
          AND ${sqlPessoaNaoSuspensa('u.id')}
          AND COALESCE(u.especialidades && $6::text[], false)
          AND ${sqlAlcance({ pLat: '$4', pLng: '$5', sqlMesmaCidade: mesmaCidade })}
          AND ${sqlNaoMesmoCpfDoCriador(tabela, '$1')}
        ORDER BY COALESCE(${sqlCpfNormalizado('u.cpf_cnpj')}, u.id::text), (NULLIF(btrim(u.telefone), '') IS NOT NULL) DESC, u.id`
}

const enfileirarEspecialidadeRara = async (db = pool, { agora = new Date() } = {}) => {
  const config = await lerConfig(db)
  if (!config.tipos[TIPO_RARA]) return { enfileiradas: 0, motivo: 'tipo_desligado' }
  if (config.pausado) return { enfileiradas: 0, motivo: 'pausado' }
  if (!dentroDaJanela(agora)) return { enfileiradas: 0, motivo: 'fora_do_horario' }
  const e = await db.query(`SELECT trava FROM whatsapp_estado WHERE id = 1`)
  const trava = lerTrava({ WHATSAPP_SOMENTE_PARA: e.rows[0]?.trava || '' })
  if (trava.modo === 'ausente') return { enfileiradas: 0, motivo: 'sem_trava' }

  const pedidos = await db.query(`${sqlPedidos('reparos')} UNION ALL ${sqlPedidos('obras')} ORDER BY expira_em, id LIMIT 200`)
  let enfileiradas = 0
  for (const d of pedidos.rows) {
    const slugs = especialidadesDoPedido(d.tabela, d)
    const cidade = normalizar(d.cidade)
    const uf = String(d.uf || '').trim().toUpperCase()
    if (slugs.length === 0 || !cidade || !uf) continue
    // Os 5 do pedido contam o que já está na fila ou saiu (número sem WhatsApp cede a vez ao próximo).
    const ja = await db.query(
      `SELECT COUNT(*)::int AS n FROM whatsapp_mensagens WHERE tipo = $1 AND ref_tabela = $2 AND ref_id = $3::uuid AND status NOT IN ${SQL_NAO_SAIU}`,
      [TIPO_RARA, d.tabela, d.id])
    let vagas = RARA_MAX_AVISOS_POR_PEDIDO - ja.rows[0].n
    if (vagas <= 0) continue
    const lat = Number.isFinite(Number(d.latitude)) && d.latitude !== null ? Number(d.latitude) : null
    const lng = Number.isFinite(Number(d.longitude)) && d.longitude !== null ? Number(d.longitude) : null
    const publico = (await db.query(sqlPublico(d.tabela), [d.id, cidade, uf, lat, lng, slugs])).rows
    const raras = slugs.filter(s => {
      const n = publico.filter(u => (u.especialidades || []).includes(s)).length
      return n >= 1 && n <= RARA_MAX_PROFISSIONAIS
    })
    if (raras.length === 0) continue
    const candidatos = publico
      .filter(u => (u.especialidades || []).some(s => raras.includes(s)))
      .filter(u => u.quer_avisos && !u.viu && !u.manifestou && u.sem_bloqueio && u.atende_local && !u.ja_deste_pedido && !u.recebeu_recente)
      .sort((a, b) => (a.km === null) - (b.km === null) || Number(a.km) - Number(b.km) || String(a.id).localeCompare(String(b.id)))
    for (const u of candidatos) {
      if (vagas <= 0) break
      const telefone = normalizarTelefone(u.telefone)
      // Número fora da trava de teste: nem entra (o worker barraria).
      if (!telefone || !travaPermite(trava, telefone)) continue
      // O limite de 24 h vale também para o NÚMERO (a mesma pessoa pode ter duas contas com ele).
      const recente = await db.query(
        `SELECT 1 FROM whatsapp_mensagens x
          WHERE x.tipo = $1 AND x.telefone = ANY($2::text[]) AND x.status NOT IN ${SQL_NAO_SAIU}
            AND (x.status = 'fila' OR x.enviada_em > NOW() - INTERVAL '${RARA_INTERVALO_PESSOA_HORAS} hours') LIMIT 1`,
        [TIPO_RARA, variantesTelefone(telefone)])
      if (recente.rows.length > 0) continue
      const slug = raras.find(s => (u.especialidades || []).includes(s))
      const dados = {
        primeiro_nome: T.primeiroNome(u.nome), rotulo: rotuloDaEspecialidade(slug), especialidade: slug, titulo: d.titulo,
        demanda_id: d.id, tabela: d.tabela, codigo: d.codigo_publico, expira_em: new Date(d.expira_em).toISOString(),
        km: u.km === null ? null : Math.round(Number(u.km) * 10) / 10,
      }
      const en = await enfileirar({
        tipo: TIPO_RARA, usuarioId: u.id, telefone,
        // O worker redige de novo na hora do envio (tempo restante e rodapé do SAIR).
        texto: T.textoEspecialidadeRara(dados, { agora }),
        refTabela: d.tabela, refId: d.id, chaveDedupe: chaveDoAviso(d.tabela, d.id, u.id), dados,
      }, db)
      if (en.ok) { enfileiradas++; vagas-- }
    }
  }
  return { enfileiradas }
}

module.exports = { enfileirarEspecialidadeRara, chaveDoAviso, rotuloDaEspecialidade, especialidadesDoPedido, INTERVALO_MS }
