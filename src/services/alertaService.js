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

const enviarBoasVindas = async (usuarioId) => {
  try {
    const result = await pool.query(
      `SELECT push_token, nome, role FROM usuarios WHERE id = $1`,
      [usuarioId]
    )
    if (!result.rows[0]?.push_token) return

    const { push_token, nome, role } = result.rows[0]
    const primeiroNome = nome?.split(' ')[0] || 'bem-vindo'

    let mensagem = ''
    if (role === 'assinante') {
      mensagem = 'Explore obras de pintura disponíveis na sua região agora mesmo!'
    } else if (role === 'prestador') {
      mensagem = 'Explore reparos e serviços disponíveis na sua região agora mesmo!'
    } else if (role === 'dono_obra') {
      mensagem = 'Cadastre sua primeira obra ou reparo e encontre profissionais qualificados!'
    }

    await enviarPushNotificacao(
      push_token,
      `🎉 Bem-vindo ao PinturaPro, ${primeiroNome}!`,
      mensagem,
      { tipo: 'boas_vindas' }
    )
  } catch (err) {
    console.error('Erro ao enviar boas vindas:', err)
  }
}

const notificarPintoresSobreNovaObra = async (obraId) => {
  try {
    const obraResult = await pool.query(
      `SELECT titulo, cidade, latitude, longitude FROM obras WHERE id = $1`,
      [obraId]
    )
    if (obraResult.rows.length === 0) return
    const obra = obraResult.rows[0]

    // Busca pintores ativos com assinatura ativa
    const pintores = await pool.query(
      `SELECT u.push_token, u.nome, u.cidade
       FROM usuarios u
       JOIN assinaturas a ON a.usuario_id = u.id
       WHERE u.role = 'assinante'
         AND a.status = 'ativa'
         AND u.push_token IS NOT NULL
       LIMIT 100`
    )

    for (const pintor of pintores.rows) {
      await enviarPushNotificacao(
        pintor.push_token,
        '🖌️ Nova obra disponível!',
        `"${obra.titulo}" em ${obra.cidade} acabou de ser publicada!`,
        { tipo: 'nova_obra', obra_id: obraId }
      )
    }
    console.log(`Notificados ${pintores.rows.length} pintores sobre nova obra`)
  } catch (err) {
    console.error('Erro ao notificar pintores:', err)
  }
}

const notificarPrestadoresSobreNovoReparo = async (reparoId) => {
  try {
    const reparoResult = await pool.query(
      `SELECT titulo, cidade, categoria FROM reparos WHERE id = $1`,
      [reparoId]
    )
    if (reparoResult.rows.length === 0) return
    const reparo = reparoResult.rows[0]

    // Busca prestadores ativos com assinatura ativa
    const prestadores = await pool.query(
      `SELECT u.push_token, u.nome
       FROM usuarios u
       JOIN assinaturas a ON a.usuario_id = u.id
       WHERE u.role = 'prestador'
         AND a.status = 'ativa'
         AND u.push_token IS NOT NULL
       LIMIT 100`
    )

    for (const prestador of prestadores.rows) {
      await enviarPushNotificacao(
        prestador.push_token,
        '🔧 Novo reparo disponível!',
        `"${reparo.titulo}" em ${reparo.cidade} — categoria: ${reparo.categoria}`,
        { tipo: 'novo_reparo', reparo_id: reparoId }
      )
    }
    console.log(`Notificados ${prestadores.rows.length} prestadores sobre novo reparo`)
  } catch (err) {
    console.error('Erro ao notificar prestadores:', err)
  }
}

const verificarObrasExpirando = async () => {
  try {
    // Obras que expiram em 24 horas e ainda não foram notificadas
    const obras = await pool.query(`
      SELECT o.id, o.titulo, u.push_token, u.nome
      FROM obras o
      JOIN usuarios u ON o.criado_por = u.id
      WHERE o.status = 'aberta'
        AND o.expira_em BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
        AND o.alerta_enviado_em IS NULL
        AND u.push_token IS NOT NULL
    `)

    for (const obra of obras.rows) {
      await enviarPushNotificacao(
        obra.push_token,
        '⏰ Sua obra expira em 24 horas!',
        `"${obra.titulo}" será encerrada em breve. Renove para continuar recebendo candidatos.`,
        { tipo: 'obra_expirando', obra_id: obra.id }
      )
      await pool.query(
        `UPDATE obras SET alerta_enviado_em = NOW() WHERE id = $1`,
        [obra.id]
      )
    }

    // Reparos que expiram em 24 horas
    const reparos = await pool.query(`
      SELECT r.id, r.titulo, u.push_token
      FROM reparos r
      JOIN usuarios u ON r.criado_por = u.id
      WHERE r.status = 'aberta'
        AND r.expira_em BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
        AND r.alerta_enviado_em IS NULL
        AND u.push_token IS NOT NULL
    `)

    for (const reparo of reparos.rows) {
      await enviarPushNotificacao(
        reparo.push_token,
        '⏰ Seu reparo expira em 24 horas!',
        `"${reparo.titulo}" será encerrado em breve.`,
        { tipo: 'reparo_expirando', reparo_id: reparo.id }
      )
      await pool.query(
        `UPDATE reparos SET alerta_enviado_em = NOW() WHERE id = $1`,
        [reparo.id]
      )
    }

    console.log(`Verificação de expiração: ${obras.rows.length} obras e ${reparos.rows.length} reparos notificados`)
  } catch (err) {
    console.error('Erro ao verificar obras expirando:', err)
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
      }
    }

  } catch (err) {
    console.error('Erro ao verificar engajamento:', err)
  }
}

module.exports = {
  enviarPushNotificacao,
  enviarBoasVindas,
  notificarPintoresSobreNovaObra,
  notificarPrestadoresSobreNovoReparo,
  verificarObrasExpirando,
  verificarObrasComBaixoEngajamento
}