// ROBÔ DE WHATSAPP — tipo 'novo_interessado' (dono, 19/11/2026). Roda na API (job de server.js);
// o worker (src/whatsapp) continua só enviando.
//
// QUANDO: um profissional demonstra interesse (serviço — interesse_reparos) ou se candidata (obra —
//   candidaturas) e o DONO do pedido está SEM push: nenhuma conta contratante da mesma pessoa tem
//   usuarios.push_token (a regra com que o envio de push decide pular — fila.sqlDonoSemPush). Quem
//   tem push já foi avisado na hora pelo app; este aviso cobre só quem não seria avisado.
// ESPERA: 15 min depois do PRIMEIRO interesse ainda não avisado da pessoa, entram na fila TODOS os
//   interesses pendentes dela (uma linha por interesse — chave de dedupe 'interessado:<tabela>:<id>':
//   o mesmo interesse nunca é avisado duas vezes). O worker junta as linhas da pessoa em UMA
//   mensagem (src/whatsapp/fila.js + textos.textoInteressados), respeita 08–21h e 1 mensagem por
//   pessoa a cada 3 h, e tira da fila o que deixou de valer antes do envio (dono escolheu um
//   profissional, pedido fechou/venceu, interesse cancelado/recusado, dono passou a ter push).
// Só enfileira com o tipo LIGADO no painel (padrão: desligado) e com o worker dizendo que pode
// enviar (trava de teste em whatsapp_estado.trava) — sem isso a fila encheria de avisos velhos.
const { pool } = require('../utils/supabase')
const { enfileirar } = require('./whatsappFilaService')
const { lerConfig, TIPO_INTERESSADO, sqlPedidoAbertoSemEscolhido, sqlInteresseVivo, sqlDonoSemPush } = require('../whatsapp/fila')
const { ESPERA_INTERESSADO_MIN, IDADE_MAXIMA_INTERESSADO_HORAS, normalizarTelefone, lerTrava, travaPermite } = require('../whatsapp/config')
const T = require('../whatsapp/textos')

const chaveDoInteresse = (tabela, interesseId) => `interessado:${tabela}:${interesseId}`

const enfileirarNovosInteressados = async (db = pool) => {
  const config = await lerConfig(db)
  if (!config.tipos[TIPO_INTERESSADO]) return { enfileiradas: 0, motivo: 'tipo_desligado' }
  const e = await db.query(`SELECT trava FROM whatsapp_estado WHERE id = 1`)
  const trava = lerTrava({ WHATSAPP_SOMENTE_PARA: e.rows[0]?.trava || '' })
  if (trava.modo === 'ausente') return { enfileiradas: 0, motivo: 'sem_trava' }
  // pendentes = interesses que ainda valem e nunca entraram na fila; `primeiro` = o mais antigo
  // deles por dono — a espera de 15 min conta a partir dele, e aí vão todos juntos.
  const r = await db.query(
    `WITH ev AS (
       SELECT 'reparos'::text AS tabela, i.id AS interesse_id, i.criado_em, d.id AS demanda_id, d.titulo, d.codigo_publico, d.criado_por, i.usuario_id AS prof_id
         FROM interesse_reparos i JOIN reparos d ON d.id = i.reparo_id
        WHERE ${sqlInteresseVivo('i')} AND ${sqlPedidoAbertoSemEscolhido('d', 'NOW()')}
          AND i.criado_em > NOW() - INTERVAL '${IDADE_MAXIMA_INTERESSADO_HORAS} hours'
       UNION ALL
       SELECT 'obras'::text, i.id, i.criado_em, d.id, d.titulo, d.codigo_publico, d.criado_por, i.usuario_id
         FROM candidaturas i JOIN obras d ON d.id = i.obra_id
        WHERE ${sqlInteresseVivo('i')} AND ${sqlPedidoAbertoSemEscolhido('d', 'NOW()')}
          AND i.criado_em > NOW() - INTERVAL '${IDADE_MAXIMA_INTERESSADO_HORAS} hours'
     ), pendentes AS (
       SELECT ev.*, dono.nome AS dono_nome, dono.telefone AS dono_telefone, prof.nome AS prof_nome,
              MIN(ev.criado_em) OVER (PARTITION BY ev.criado_por) AS primeiro
         FROM ev
         JOIN usuarios dono ON dono.id = ev.criado_por
         JOIN usuarios prof ON prof.id = ev.prof_id
        WHERE COALESCE(dono.ativo, true) AND COALESCE(dono.whatsapp_avisos, true)
          AND ${sqlDonoSemPush('ev.criado_por')}
          AND NOT EXISTS (SELECT 1 FROM whatsapp_mensagens m WHERE m.chave_dedupe = 'interessado:' || ev.tabela || ':' || ev.interesse_id::text)
     )
     SELECT * FROM pendentes
      WHERE primeiro <= NOW() - INTERVAL '${ESPERA_INTERESSADO_MIN} minutes'
      ORDER BY criado_por, criado_em, interesse_id
      LIMIT 500`)
  let enfileiradas = 0
  for (const p of r.rows) {
    const telefone = normalizarTelefone(p.dono_telefone)
    // Número fora da trava de teste: nem entra (o worker barraria; e o interesse ainda pode ser
    // avisado quando a trava abrir, se continuar valendo). Sem código público não há link.
    if (!telefone || !travaPermite(trava, telefone) || !p.codigo_publico) continue
    const dados = {
      primeiro_nome: T.primeiroNome(p.dono_nome), nome_prof: T.primeiroNome(p.prof_nome), titulo: p.titulo,
      demanda_id: p.demanda_id, tabela: p.tabela, interesse_id: p.interesse_id, codigo: p.codigo_publico, link: T.linkAbrir(p.codigo_publico),
    }
    const en = await enfileirar({
      tipo: TIPO_INTERESSADO, usuarioId: p.criado_por, telefone,
      // Texto de UM interesse; o worker redige de novo na hora do envio (agrupamento e rodapé).
      texto: T.textoInteressados([dados]),
      refTabela: p.tabela, refId: p.demanda_id, chaveDedupe: chaveDoInteresse(p.tabela, p.interesse_id), dados,
    }, db)
    if (en.ok) enfileiradas++
  }
  return { enfileiradas }
}

module.exports = { enfileirarNovosInteressados, chaveDoInteresse }
