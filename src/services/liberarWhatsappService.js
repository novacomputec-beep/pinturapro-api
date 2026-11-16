// "LIBERAR WHATSAPP" (arte "Ela chegou? v2", 16/11/2026 — reparos e obras).
// O DONO libera o próprio WhatsApp ao profissional escolhido sem esperar o "Estou a caminho":
//   POST /:tabela/:id/liberar-whatsapp   (só o dono — qualquer conta da pessoa)
// Vale só COM profissional escolhido e ANTES da conclusão (status 'aberta' + match). Grava
// whatsapp_liberado_em e whatsapp_liberado_para (= o profissional do match NAQUELE momento): a
// liberação é DESTE match — some sozinha se o profissional mudar (whatsappLiberado compara os
// dois e exige liberado_em >= match_feito_em), sem depender de cada caminho que desfaz match.
// Enquanto vale, GET /:id entrega dono_telefone ao profissional do match exatamente como depois
// do "Estou a caminho" (a_caminho_em).
// Pedido de acordo de cancelamento PENDENTE feito pelo PROFISSIONAL: é RETIRADO aqui (colunas
// cancelamento_pedido_* limpas), SEM falta para ninguém — ele pediu para sair porque não
// conseguia combinar; com o WhatsApp liberado o motivo acabou. Fica registrado em
// eventos_demanda (campo 'pedido_cancelamento_retirado' + o rastro automático das colunas).
// Pedido feito pelo DONO não é tocado.
// Aviso ao profissional: só push — "📱 <primeiro nome> liberou o WhatsApp para vocês combinarem."
const { pool } = require('../utils/supabase')
const { ehMesmaPessoa } = require('../utils/tipoConta')

const LADOS = {
  reparos: { tabela: 'reparos', chave: 'reparo_id', naoEncontrada: 'Serviço não encontrado' },
  obras: { tabela: 'obras', chave: 'obra_id', naoEncontrada: 'Obra não encontrada' },
}
const TITULO_PUSH = '📱 WhatsApp liberado'
const primeiroNomeDono = (nome) => String(nome || '').trim().split(/\s+/)[0] || 'O cliente'
const corpoPush = (nomeDono) => `${primeiroNomeDono(nomeDono)} liberou o WhatsApp para vocês combinarem.`

// A liberação vale para o match ATUAL? (linha de reparos/obras)
const whatsappLiberado = (d) => {
  if (!d || !d.whatsapp_liberado_em || !d.match_usuario_id) return false
  if (d.whatsapp_liberado_para !== d.match_usuario_id) return false
  if (!d.match_feito_em) return true
  return new Date(d.whatsapp_liberado_em).getTime() >= new Date(d.match_feito_em).getTime()
}

// Migração de boot (idempotente).
const migrarWhatsappLiberado = async (client) => {
  for (const tabela of ['reparos', 'obras']) {
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS whatsapp_liberado_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS whatsapp_liberado_para UUID`)
  }
}

const registrarEvento = async (tabela, id, campo, antes, depois, usuarioId) => {
  try {
    await pool.query(
      `INSERT INTO eventos_demanda (tabela, demanda_id, campo, valor_antes, valor_depois, origem, usuario_id, rota)
       VALUES ($1, $2, $3, $4, $5, 'rota', $6, $7)`,
      [tabela, id, campo, antes, depois, usuarioId, `POST /api/${tabela}/:id/liberar-whatsapp`])
  } catch (err) {
    console.error(`[LiberarWhatsapp] evento ${campo} ${tabela} ${id}:`, err.message)
  }
}

const handler = (tabela) => {
  const lado = LADOS[tabela]
  if (!lado) throw new Error(`liberarWhatsappService: lado desconhecido "${tabela}"`)
  return async (req, res) => {
    try {
      const alvo = await pool.query(
        `SELECT id, titulo, criado_por, status, match_usuario_id, match_feito_em, whatsapp_liberado_em, whatsapp_liberado_para
           FROM ${lado.tabela} WHERE id = $1`, [req.params.id])
      const d = alvo.rows[0]
      if (!d) return res.status(404).json({ erro: lado.naoEncontrada })
      if (!(await ehMesmaPessoa(d.criado_por, req.usuario.id))) {
        return res.status(403).json({ erro: 'Apenas o cliente pode liberar o WhatsApp' })
      }
      if (d.status !== 'aberta') return res.status(409).json({ erro: 'Este pedido já foi concluído ou cancelado', codigo: 'DEMANDA_FECHADA' })
      if (!d.match_usuario_id) return res.status(409).json({ erro: 'Escolha um profissional antes de liberar o WhatsApp', codigo: 'SEM_MATCH' })
      if (whatsappLiberado(d)) {
        return res.json({ mensagem: 'WhatsApp já liberado.', whatsapp_liberado_em: d.whatsapp_liberado_em, ja_liberado: true, pedido_cancelamento_retirado: false })
      }

      // Uma instrução só: lê o pedido pendente do PROFISSIONAL (antes) e grava a liberação —
      // limpando o pedido quando ele existe e ainda vale. O WHERE repete o estado lido (linha
      // viva + mesmo profissional): corrida com un-match/encerramento vira 0 linhas → 409.
      const upd = await pool.query(
        `WITH antes AS (
           SELECT id, cancelamento_pedido_por AS por, cancelamento_pedido_motivo AS motivo, cancelamento_pedido_detalhe AS detalhe,
                  cancelamento_pedido_em AS em,
                  (cancelamento_pedido_em IS NOT NULL AND cancelamento_pedido_expira_em > NOW()
                   AND cancelamento_pedido_por = match_usuario_id) AS retirar
             FROM ${lado.tabela} WHERE id = $1 AND status = 'aberta' AND match_usuario_id = $2 FOR UPDATE
         )
         UPDATE ${lado.tabela} d
            SET whatsapp_liberado_em = NOW(), whatsapp_liberado_para = d.match_usuario_id,
                cancelamento_pedido_por = CASE WHEN a.retirar THEN NULL ELSE d.cancelamento_pedido_por END,
                cancelamento_pedido_motivo = CASE WHEN a.retirar THEN NULL ELSE d.cancelamento_pedido_motivo END,
                cancelamento_pedido_detalhe = CASE WHEN a.retirar THEN NULL ELSE d.cancelamento_pedido_detalhe END,
                cancelamento_pedido_em = CASE WHEN a.retirar THEN NULL ELSE d.cancelamento_pedido_em END,
                cancelamento_pedido_expira_em = CASE WHEN a.retirar THEN NULL ELSE d.cancelamento_pedido_expira_em END
           FROM antes a
          WHERE d.id = a.id
          RETURNING d.whatsapp_liberado_em, a.retirar, a.por, a.motivo, a.detalhe, a.em`,
        [req.params.id, d.match_usuario_id])
      const r = upd.rows[0]
      if (!r) return res.status(409).json({ erro: 'O atendimento mudou. Atualize a tela.', codigo: 'ESTADO_MUDOU' })
      const retirado = r.retirar === true

      res.json({
        mensagem: 'WhatsApp liberado para o profissional.',
        whatsapp_liberado_em: r.whatsapp_liberado_em, ja_liberado: false, pedido_cancelamento_retirado: retirado,
      })

      // Depois da resposta: rastro e aviso (nunca derrubam a ação).
      await registrarEvento(lado.tabela, d.id, 'whatsapp_liberado_em', null, new Date(r.whatsapp_liberado_em).toISOString(), req.usuario.id)
      if (retirado) {
        await registrarEvento(lado.tabela, d.id, 'pedido_cancelamento_retirado',
          JSON.stringify({ por: r.por, motivo: r.motivo, detalhe: r.detalhe, pedido_em: r.em }), 'whatsapp_liberado (sem falta)', req.usuario.id)
      }
      try {
        // require tardio: alertaService carrega muita coisa e já depende de vários serviços.
        const { contatoDaPessoa, enviarPushNotificacao } = require('./alertaService')
        const [prof, dono] = await Promise.all([
          contatoDaPessoa(d.match_usuario_id),
          pool.query(`SELECT nome FROM usuarios WHERE id = $1`, [d.criado_por]),
        ])
        if (prof?.push_token) {
          await enviarPushNotificacao(prof.push_token, TITULO_PUSH, corpoPush(dono.rows[0]?.nome),
            { tipo: 'whatsapp_liberado', [lado.chave]: d.id }, d.match_usuario_id)
        }
      } catch (err) {
        console.error(`[LiberarWhatsapp] aviso ${lado.tabela} ${d.id}:`, err.message)
      }
    } catch (err) {
      console.error(`[LiberarWhatsapp] ${tabela} ${req.params.id}:`, err.message)
      if (!res.headersSent) res.status(500).json({ erro: 'Erro ao liberar o WhatsApp' })
    }
  }
}

module.exports = { handler, whatsappLiberado, migrarWhatsappLiberado, TITULO_PUSH, corpoPush }
