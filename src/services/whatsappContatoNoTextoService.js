// ROBÔ DE WHATSAPP — tipo 'contato_no_texto' (dono, 26/11/2026). Roda na API (job de server.js, a
// cada 1 min); o worker (src/whatsapp) continua só enviando.
//
// PEDIDO que entra (serviço e obra): MARCADO com contato no texto (utils/contatoNoTexto — varredura
//   única dos abertos, ou app antigo que publicou sem suporte à recusa), aberto, aprovado, dentro
//   do prazo e sem profissional escolhido.
// QUEM RECEBE: o dono do pedido, no telefone da CONTA; conta sem telefone → o número achado no
//   texto do pedido (contato_no_texto_telefone), quando tem DDD. Não recebe quem respondeu SAIR
//   (a conta, ou qualquer conta com aquele número).
// UMA VEZ POR PEDIDO (chave de dedupe 'contato:<tabela>:<pedido>') e no máximo uma mensagem deste
//   tipo por pessoa/número a cada 24 h. Só enfileira com o tipo LIGADO no painel (padrão:
//   desligado), com o worker dizendo que pode enviar (trava de teste) e dentro da janela 08–21h.
//   O texto é o aprovado pelo dono (whatsapp/textos.textoContatoNoTexto), sai sozinho e exatamente
//   como está; o worker tira da fila o aviso do pedido que fechou ou deixou de estar marcado
//   (fila.sqlContatoVale). Ritmo (20–40 s), pausa e SAIR são os do worker.
const { pool } = require('../utils/supabase')
const { enfileirar } = require('./whatsappFilaService')
const { lerConfig, sqlPedidoAbertoSemEscolhido } = require('../whatsapp/fila')
const { TIPO_CONTATO, CONTATO_INTERVALO_PESSOA_HORAS, normalizarTelefone, variantesTelefone, lerTrava, travaPermite, dentroDaJanela } = require('../whatsapp/config')
const T = require('../whatsapp/textos')

const SQL_NAO_SAIU = `('falha', 'sem_whatsapp', 'saiu')`
const chaveDoAviso = (tabela, demandaId) => `contato:${tabela}:${demandaId}`

const sqlPedidos = (tabela) => `
  SELECT '${tabela}'::text AS tabela, d.id, d.titulo, d.criado_por, d.criado_em, d.contato_no_texto_telefone,
         u.telefone AS dono_telefone
    FROM ${tabela} d JOIN usuarios u ON u.id = d.criado_por
   WHERE d.contato_no_texto AND ${sqlPedidoAbertoSemEscolhido('d', 'NOW()')}
     AND COALESCE(u.ativo, true) AND COALESCE(u.whatsapp_avisos, true)
     AND NOT EXISTS (SELECT 1 FROM whatsapp_mensagens m WHERE m.chave_dedupe = 'contato:${tabela}:' || d.id::text)`

const enfileirarContatoNoTexto = async (db = pool, { agora = new Date() } = {}) => {
  const config = await lerConfig(db)
  if (!config.tipos[TIPO_CONTATO]) return { enfileiradas: 0, motivo: 'tipo_desligado' }
  if (config.pausado) return { enfileiradas: 0, motivo: 'pausado' }
  if (!dentroDaJanela(agora)) return { enfileiradas: 0, motivo: 'fora_do_horario' }
  const e = await db.query(`SELECT trava FROM whatsapp_estado WHERE id = 1`)
  const trava = lerTrava({ WHATSAPP_SOMENTE_PARA: e.rows[0]?.trava || '' })
  if (trava.modo === 'ausente') return { enfileiradas: 0, motivo: 'sem_trava' }

  const pedidos = await db.query(`${sqlPedidos('reparos')} UNION ALL ${sqlPedidos('obras')} ORDER BY criado_em, id LIMIT 200`)
  let enfileiradas = 0
  for (const d of pedidos.rows) {
    const daConta = normalizarTelefone(d.dono_telefone)
    const telefone = daConta || normalizarTelefone(d.contato_no_texto_telefone)
    // Número fora da trava de teste: nem entra (o worker barraria).
    if (!telefone || !travaPermite(trava, telefone)) continue
    const formas = variantesTelefone(telefone)
    // Número tirado do texto: alguma conta com ele respondeu SAIR → não recebe.
    if (!daConta) {
      const saiu = await db.query(
        `SELECT 1 FROM usuarios WHERE whatsapp_avisos = false
            AND regexp_replace(COALESCE(telefone, ''), '\\D', '', 'g') = ANY($1::text[]) LIMIT 1`,
        [formas.flatMap(f => [f.slice(1), f.slice(3)])])
      if (saiu.rows.length > 0) continue
    }
    // No máximo uma mensagem deste tipo por pessoa/número a cada 24 h (o próximo pedido espera).
    const recente = await db.query(
      `SELECT 1 FROM whatsapp_mensagens x
        WHERE x.tipo = $1 AND (x.usuario_id = $2::uuid OR x.telefone = ANY($3::text[])) AND x.status NOT IN ${SQL_NAO_SAIU}
          AND (x.status = 'fila' OR x.enviada_em > NOW() - INTERVAL '${CONTATO_INTERVALO_PESSOA_HORAS} hours') LIMIT 1`,
      [TIPO_CONTATO, d.criado_por, formas])
    if (recente.rows.length > 0) continue
    const en = await enfileirar({
      tipo: TIPO_CONTATO, usuarioId: d.criado_por, telefone, texto: T.textoContatoNoTexto(d.titulo),
      refTabela: d.tabela, refId: d.id, chaveDedupe: chaveDoAviso(d.tabela, d.id),
      dados: { titulo: d.titulo, tabela: d.tabela, demanda_id: d.id, telefone_do_texto: !daConta },
    }, db)
    if (en.ok) enfileiradas++
  }
  return { enfileiradas }
}

module.exports = { enfileirarContatoNoTexto, chaveDoAviso }
