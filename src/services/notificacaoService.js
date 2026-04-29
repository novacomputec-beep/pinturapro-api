const { Expo } = require('expo-server-sdk')

const expo = new Expo()

const enviarNotificacao = async (tokens, titulo, mensagem, dados = {}) => {
  const mensagens = []

  for (const token of tokens) {
    if (!Expo.isExpoPushToken(token)) {
      console.warn(`Token inválido: ${token}`)
      continue
    }
    mensagens.push({
      to: token,
      sound: 'default',
      title: titulo,
      body: mensagem,
      data: dados,
    })
  }

  if (mensagens.length === 0) return

  const chunks = expo.chunkPushNotifications(mensagens)
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk)
    } catch (err) {
      console.error('Erro ao enviar notificação:', err)
    }
  }
}

const notificarNovaObra = async (pool, obra) => {
  try {
    const result = await pool.query(
      `SELECT push_token FROM usuarios 
       WHERE push_token IS NOT NULL 
       AND ativo = true
       AND role = 'assinante'`
    )

    const tokens = result.rows.map(r => r.push_token).filter(Boolean)

    if (tokens.length === 0) return

    await enviarNotificacao(
      tokens,
      '🏠 Nova obra disponível!',
      `${obra.titulo} — R$ ${Number(obra.valor).toLocaleString('pt-BR')} em ${obra.cidade}`,
      { tipo: 'nova_obra', obra_id: obra.id }
    )

    console.log(`Notificação enviada para ${tokens.length} pintores`)
  } catch (err) {
    console.error('Erro ao notificar nova obra:', err)
  }
}

const notificarCandidaturaAprovada = async (pool, usuarioId, obraTitulo) => {
  try {
    const result = await pool.query(
      `SELECT push_token FROM usuarios WHERE id = $1 AND push_token IS NOT NULL`,
      [usuarioId]
    )

    if (result.rows.length === 0 || !result.rows[0].push_token) return

    await enviarNotificacao(
      [result.rows[0].push_token],
      '✅ Candidatura aprovada!',
      `Você foi aprovado para a obra: ${obraTitulo}`,
      { tipo: 'candidatura_aprovada' }
    )
  } catch (err) {
    console.error('Erro ao notificar candidatura:', err)
  }
}

module.exports = { enviarNotificacao, notificarNovaObra, notificarCandidaturaAprovada }