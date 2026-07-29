const { pool } = require('./supabase')
const { enviarPushNotificacao } = require('../services/alertaService')

// Recusa as demais candidaturas/interesses da demanda e notifica os perdedores.
//
// Extraído dos dois handlers de /match, onde era código duplicado e onde CONTINUA rodando
// (linhas legadas: demandas casadas antes do aceite passar a criar o match). Como hoje o
// aceite já define match_usuario_id, /match sai no early-return idempotente e não varreria
// mais nada — por isso os cinco caminhos de aceite também chamam esta função.
//
// Idempotente por construção: o filtro status NOT IN ('recusado','expirado') faz a segunda
// execução não retornar linha nenhuma, então ninguém recebe push repetido.
const CONFIG = {
  obra: {
    tabela:       'candidaturas',
    coluna:       'obra_id',
    mensagem:     'O solicitante escolheu outro profissional para esta obra.',
    tipo:         'candidatura_recusada',
    chavePayload: 'obra_id'
  },
  reparo: {
    tabela:       'interesse_reparos',
    coluna:       'reparo_id',
    mensagem:     'O solicitante escolheu outro prestador para este reparo.',
    tipo:         'interesse_recusado',
    chavePayload: 'reparo_id'
  }
}

// Retorna quantos foram recusados. Nunca lança para o chamador em fluxo normal — os
// chamadores usam .catch() e o efeito é secundário à resposta já enviada ao cliente.
const rejeitarConcorrentes = async (tipoDemanda, demandaId, vencedorUsuarioId) => {
  const cfg = CONFIG[tipoDemanda]
  if (!cfg) throw new Error(`rejeitarConcorrentes: tipoDemanda inválido "${tipoDemanda}"`)

  // tabela/coluna saem do CONFIG acima (whitelist fechada), nunca do request —
  // a interpolação no SQL é segura pelo mesmo motivo do POST /avaliacoes.
  const rejeitados = await pool.query(
    `UPDATE ${cfg.tabela} SET status = 'recusado'
     WHERE ${cfg.coluna} = $1 AND usuario_id != $2 AND status NOT IN ('recusado', 'expirado')
     RETURNING usuario_id`,
    [demandaId, vencedorUsuarioId]
  )
  const ids = rejeitados.rows.map(r => r.usuario_id)
  if (ids.length === 0) return 0

  const tokens = await pool.query(
    `SELECT push_token FROM usuarios WHERE id = ANY($1) AND push_token IS NOT NULL`,
    [ids]
  )
  tokens.rows.forEach(r => {
    enviarPushNotificacao(
      r.push_token,
      '❌ Outro profissional foi selecionado',
      cfg.mensagem,
      { tipo: cfg.tipo, [cfg.chavePayload]: demandaId }
    ).catch(() => {})
  })
  return ids.length
}

module.exports = { rejeitarConcorrentes }
