// MÍDIA ADICIONADA DEPOIS DA PUBLICAÇÃO (dono, 20/11/2026).
//   1) Upload de mídia (POST /upload/reparo, /upload/reparo-url, /upload/obra-url) em pedido
//      finalizado, encerrado ou cancelado → 409 { erro: 'Pedido finalizado' } (demandaFinalizada).
//      Aberto e aguardando aprovação seguem aceitando, inclusive os uploads da criação.
//   2) Depois de a mídia entrar num pedido que JÁ TEM perguntas de profissionais, cada profissional
//      que perguntou recebe UM push (sem push / push falho → e-mail: entregarPushOuEmail) que abre o
//      detalhe do pedido. No máximo um aviso por profissional por pedido a cada 10 minutos — vários
//      arquivos em sequência viram um aviso só. Sem pergunta, ninguém é avisado.
// O claim é atômico em avisos_midia_adicionada (PK tabela + demanda + usuário): o INSERT pega quem
// nunca foi avisado e o DO UPDATE ... WHERE só reabre quem foi avisado há mais de 10 minutos; duas
// chamadas simultâneas (dois arquivos subindo juntos) não avisam em dobro.
const { pool } = require('../utils/supabase')
const { contatoDaPessoa, entregarPushOuEmail } = require('./alertaService')

const LADOS = Object.freeze({
  obras:   { tipo: 'obra',   chave: 'obra_id' },
  reparos: { tipo: 'reparo', chave: 'reparo_id' },
})
const JANELA_MINUTOS = 10
const TITULO_MIDIA_ADICIONADA = '📸 O cliente adicionou fotos ou vídeos ao pedido'
const corpoMidiaAdicionada = (titulo) => `"${titulo}" · toque para ver`
const ERRO_PEDIDO_FINALIZADO = Object.freeze({ erro: 'Pedido finalizado' })

// Pedido que não aceita mais mídia: finalizado/encerrado ('encerrada') ou cancelado/expirado
// ('cancelada'), no status ou no status_aprovacao. 'aberta' (com ou sem match) e aprovação
// 'pendente' continuam aceitando.
const demandaFinalizada = (d) =>
  ['encerrada', 'cancelada'].includes(d?.status) || ['encerrada', 'cancelada'].includes(d?.status_aprovacao)

// Migração de boot (idempotente); exportada para os testes rodarem o MESMO statement.
const migrarAvisoMidia = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS avisos_midia_adicionada (
      tabela     TEXT NOT NULL,
      demanda_id UUID NOT NULL,
      usuario_id UUID NOT NULL,
      enviado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tabela, demanda_id, usuario_id)
    )`)
}

// Avisa quem perguntou. Devolve quantos foram reivindicados (0 = sem perguntas ou todos dentro da
// janela). Nunca lança: a rota de upload já respondeu e o aviso não pode derrubá-la.
const avisarMidiaAdicionada = async (tabela, demandaId, atorId = null) => {
  const lado = LADOS[tabela]
  if (!lado || !demandaId) return 0
  try {
    const claim = await pool.query(
      `INSERT INTO avisos_midia_adicionada (tabela, demanda_id, usuario_id)
       SELECT $1, p.demanda_id, p.autor_id FROM perguntas_demanda p
        WHERE p.tipo = $2 AND p.demanda_id = $3::uuid
       ON CONFLICT (tabela, demanda_id, usuario_id) DO UPDATE SET enviado_em = NOW()
        WHERE avisos_midia_adicionada.enviado_em <= NOW() - INTERVAL '${JANELA_MINUTOS} minutes'
       RETURNING usuario_id`,
      [tabela, lado.tipo, demandaId]
    )
    if (claim.rows.length === 0) return 0
    const d = await pool.query(`SELECT titulo FROM ${tabela} WHERE id = $1::uuid`, [demandaId])
    const titulo = d.rows[0]?.titulo || 'Pedido'
    await Promise.all(claim.rows.map(async ({ usuario_id }) => {
      const contato = await contatoDaPessoa(usuario_id)
      if (!contato) return
      await entregarPushOuEmail({
        ...contato,
        ator_id: atorId,
        titulo: TITULO_MIDIA_ADICIONADA,
        corpo: corpoMidiaAdicionada(titulo),
        data: { tipo: 'midia_adicionada', [lado.chave]: demandaId },
        rotulo: `mídia adicionada ${tabela} ${demandaId}`,
      })
    }))
    // Faxina: a linha só serve dentro da janela.
    pool.query(`DELETE FROM avisos_midia_adicionada WHERE enviado_em < NOW() - INTERVAL '1 day'`).catch(() => {})
    return claim.rows.length
  } catch (err) {
    console.error(`[MidiaAdicionada] ${tabela} ${demandaId}:`, err.message)
    return 0
  }
}

module.exports = {
  JANELA_MINUTOS, TITULO_MIDIA_ADICIONADA, corpoMidiaAdicionada, ERRO_PEDIDO_FINALIZADO,
  demandaFinalizada, migrarAvisoMidia, avisarMidiaAdicionada,
}
