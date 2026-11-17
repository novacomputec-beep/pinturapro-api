// Porta de entrada da API para o robô de WhatsApp: a API SÓ INSERE na fila (whatsapp_mensagens);
// quem envia é o worker (src/whatsapp/worker.js, serviço separado). Chamadores: o teste do painel
// (POST /admin/whatsapp/teste) e, desde a Etapa 2, services/whatsappPerguntasService.
//
// enfileirar NUNCA lança: devolve { ok, id } ou { ok: false, motivo }. Um aviso por WhatsApp que
// não entra na fila não pode derrubar quem o pediu.
//   tipo        — chave de config.TIPOS (liga/desliga por tipo no painel) ou o tipo interno
//                 'resposta' (resposta automática a quem escreveu);
//   usuarioId   — conta de destino (opcional no teste); sem `telefone`, usa usuarios.telefone;
//   chaveDedupe — identidade do item pendente (ex.: 'pergunta:<id>'): a MESMA chave nunca entra
//                 duas vezes (índice único) → { ok: false, motivo: 'duplicada' };
//   dados       — o que o worker precisa para redigir a mensagem na hora do envio (JSON);
//   waJid       — destino já conhecido no WhatsApp (resposta a quem escreveu).
const { pool } = require('../utils/supabase')
const { TIPOS, TIPO_RESPOSTA, normalizarTelefone } = require('../whatsapp/config')

const enfileirar = async ({ tipo, usuarioId = null, telefone = null, texto, refTabela = null, refId = null, chaveDedupe = null, dados = null, waJid = null } = {}, db = pool) => {
  try {
    if (tipo !== TIPO_RESPOSTA) {
      if (!Object.prototype.hasOwnProperty.call(TIPOS, tipo)) return { ok: false, motivo: 'tipo_desconhecido' }
      // Tipo que o painel já lista mas ainda não tem gatilho: nada entra na fila.
      if (!TIPOS[tipo].implementado) return { ok: false, motivo: 'tipo_nao_implementado' }
    }
    const corpo = String(texto ?? '').trim()
    if (!corpo) return { ok: false, motivo: 'texto_vazio' }
    let destino = normalizarTelefone(telefone)
    if (!destino && usuarioId) {
      const u = await db.query(`SELECT telefone FROM usuarios WHERE id = $1::uuid`, [usuarioId])
      destino = normalizarTelefone(u.rows[0]?.telefone)
    }
    if (!destino) return { ok: false, motivo: 'telefone_invalido' }
    const r = await db.query(
      `INSERT INTO whatsapp_mensagens (tipo, usuario_id, telefone, texto, ref_tabela, ref_id, chave_dedupe, dados, wa_jid)
       VALUES ($1, $2::uuid, $3, $4, $5, $6::uuid, $7, $8::jsonb, $9)
       ON CONFLICT (chave_dedupe) WHERE chave_dedupe IS NOT NULL DO NOTHING
       RETURNING id`,
      [tipo, usuarioId, destino, corpo, refTabela, refId, chaveDedupe ? String(chaveDedupe).slice(0, 200) : null,
       dados ? JSON.stringify(dados) : null, waJid])
    if (r.rows.length === 0) return { ok: false, motivo: 'duplicada' }
    return { ok: true, id: r.rows[0].id, telefone: destino }
  } catch (err) {
    console.error('[whatsapp/enfileirar]', err.message)
    return { ok: false, motivo: 'erro', erro: err.message }
  }
}

module.exports = { enfileirar }
