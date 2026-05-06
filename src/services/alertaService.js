const { pool } = require('../utils/supabase')
const { Expo } = require('expo-server-sdk')

const expo = new Expo()

const enviarPushNotificacao = async (pushToken, titulo, corpo, data = {}) => {
  if (!Expo.isExpoPushToken(pushToken)) return
  try {
    await expo.sendPushNotificationsAsync([{
      to: pushToken,
      sound: 'default',
      title: titulo,
      body: corpo,
      data,
    }])
  } catch (err) {
    console.error('Erro ao enviar push:', err)
  }
}

const verificarObrasComBaixoEngajamento = async () => {
  try {
    console.log('Verificando obras com baixo engajamento...')

    // Obras de pintura — alerta 1x por dia
    const obras = await pool.query(`
      SELECT o.id, o.titulo, o.total_visitas, o.alerta_enviado_em,
             u.push_token, u.nome as dono_nome
      FROM obras o
      JOIN usuarios u ON o.criado_por = u.id
      WHERE o.status = 'aberta'
        AND o.status_aprovacao = 'aprovada'
        AND o.total_visitas >= 10
        AND o.criado_em < NOW() - INTERVAL '1 day'
        AND (
          o.alerta_enviado_em IS NULL
          OR o.alerta_enviado_em < NOW() - INTERVAL '24 hours'
        )
        AND NOT EXISTS (
          SELECT 1 FROM candidaturas c
          WHERE c.obra_id = o.id AND c.status = 'pendente'
        )
    `)

    for (const obra of obras.rows) {
      if (obra.push_token) {
        await enviarPushNotificacao(
          obra.push_token,
          '💡 Considere aumentar sua oferta',
          `Sua obra "${obra.titulo}" teve ${obra.total_visitas} visitas e nenhum interessado ainda.`,
          { tipo: 'baixo_engajamento', obra_id: obra.id }
        )
        await pool.query(
          `UPDATE obras SET alerta_enviado_em = NOW() WHERE id = $1`,
          [obra.id]
        )
        console.log(`Alerta enviado para obra ${obra.id}`)
      }
    }

    // Reparos — alerta 3x por dia
    const reparos = await pool.query(`
      SELECT r.id, r.titulo, r.total_visitas, r.alerta_enviado_em,
             u.push_token, u.nome as dono_nome
      FROM reparos r
      JOIN usuarios u ON r.criado_por = u.id
      WHERE r.status = 'aberta'
        AND r.status_aprovacao = 'aprovada'
        AND r.total_visitas >= 10
        AND r.criado_em < NOW() - INTERVAL '1 day'
        AND (
          r.alerta_enviado_em IS NULL
          OR r.alerta_enviado_em < NOW() - INTERVAL '8 hours'
        )
        AND NOT EXISTS (
          SELECT 1 FROM interesse_reparos ir
          WHERE ir.reparo_id = r.id AND ir.status = 'pendente'
        )
    `)

    for (const reparo of reparos.rows) {
      if (reparo.push_token) {
        await enviarPushNotificacao(
          reparo.push_token,
          '💡 Considere aumentar sua oferta',
          `Seu reparo "${reparo.titulo}" teve ${reparo.total_visitas} visitas e nenhum interessado ainda.`,
          { tipo: 'baixo_engajamento_reparo', reparo_id: reparo.id }
        )
        await pool.query(
          `UPDATE reparos SET alerta_enviado_em = NOW() WHERE id = $1`,
          [reparo.id]
        )
        console.log(`Alerta enviado para reparo ${reparo.id}`)
      }
    }

  } catch (err) {
    console.error('Erro ao verificar engajamento:', err)
  }
}

module.exports = { verificarObrasComBaixoEngajamento, enviarPushNotificacao }