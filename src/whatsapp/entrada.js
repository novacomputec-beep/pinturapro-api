// MENSAGENS RECEBIDAS. O worker só GUARDA em whatsapp_recebidas e trata o pedido de saída
// ("SAIR"). Casar a resposta com a pergunta e entregá-la no app é trabalho da API (Etapa 2 —
// services/whatsappPerguntasService), que lê as linhas com processada_em NULL.
const { normalizarTelefone, variantesTelefone, ehPedidoDeSaida } = require('./config')

// msg = { id, jid, telefone, texto, quando, citada, midia } (contrato do adaptador). Devolve
// { nova, saiu, usuarios } — nova = false quando o id já tinha sido gravado (reentrega).
const registrarRecebida = async (db, msg) => {
  const telefone = normalizarTelefone(msg.telefone)
  // O WhatsApp costuma informar o número SEM o nono dígito: compara com as duas formas.
  const formas = variantesTelefone(telefone)
  // Quem é: a conta da última mensagem que mandamos para este destino (o JID é o que o WhatsApp
  // devolveu no envio); sem isso, fica só o telefone.
  const dono = await db.query(
    `SELECT usuario_id FROM whatsapp_mensagens
      WHERE usuario_id IS NOT NULL AND (wa_jid = $1 OR telefone = ANY($2::text[]))
      ORDER BY id DESC LIMIT 1`,
    [msg.jid || null, formas])
  const usuarioId = dono.rows[0]?.usuario_id || null

  // citada = id da mensagem que a pessoa citou ao responder; midia = 'audio' | 'imagem' | … (texto = NULL).
  // O "SAIR" é resolvido aqui mesmo (processada_em já preenchido); o resto fica com processada_em
  // NULL para a API casar com a pergunta (services/whatsappPerguntasService).
  const saida = !msg.midia && ehPedidoDeSaida(msg.texto)
  const ins = await db.query(
    `INSERT INTO whatsapp_recebidas (wa_message_id, wa_jid, telefone, usuario_id, texto, recebida_em, citada_wa_message_id, midia, processada_em, resultado)
     VALUES ($1, $2, $3, $4::uuid, $5, COALESCE($6::timestamptz, NOW()), $7, $8, CASE WHEN $9::boolean THEN NOW() ELSE NULL END, CASE WHEN $9::boolean THEN 'saiu' ELSE NULL END)
     ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`,
    [String(msg.id), msg.jid || null, telefone, usuarioId, String(msg.texto ?? ''), msg.quando ? new Date(msg.quando).toISOString() : null,
     msg.citada || null, msg.midia || null, saida])
  if (ins.rows.length === 0) return { nova: false, saiu: false, usuarios: [] }
  if (!saida) return { nova: true, saiu: false, usuarios: [] }

  // SAIR vale para o NÚMERO: todas as contas com este telefone (a mesma pessoa tem conta de
  // contratante e de profissional) e a conta para quem escrevemos neste destino. O cadastro
  // guarda o telefone com ou sem o 55 → compara só os dígitos, nas duas grafias.
  const digitos = formas.flatMap(f => [f.slice(1), f.slice(3)])
  const upd = await db.query(
    `UPDATE usuarios SET whatsapp_avisos = false
      WHERE whatsapp_avisos IS DISTINCT FROM false
        AND (id = $1::uuid OR regexp_replace(COALESCE(telefone, ''), '\\D', '', 'g') = ANY($2::text[]))
  RETURNING id`,
    [usuarioId, digitos])
  const usuarios = upd.rows.map(l => l.id)
  if (usuarioId && !usuarios.includes(usuarioId)) usuarios.push(usuarioId)
  // O que ainda estava na fila para essa pessoa/destino não sai mais.
  await db.query(
    `UPDATE whatsapp_mensagens SET status = 'saiu', enviando_em = NULL, atualizado_em = NOW()
      WHERE status = 'fila' AND (usuario_id = ANY($1::uuid[]) OR wa_jid = $2 OR telefone = ANY($3::text[]))`,
    [usuarios, msg.jid || null, formas])
  return { nova: true, saiu: true, usuarios }
}

module.exports = { registrarRecebida }
