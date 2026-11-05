// "Desfazer escolha" (obras e reparos): o DONO desfaz o match com o profissional escolhido
// enquanto nada aconteceu — nenhum horário proposto nem combinado (chegada_pendente_em e
// chegada_prevista_em nulos), sem "Estou a caminho" nem chegada (a_caminho_em,
// chegada_declarada_em, chegada_confirmada_em nulos), demanda 'aberta' — e só depois de uma
// ESPERA contada do match: 10% do que faltava do match até o prazo (a MESMA referência de
// repetirLembreteAgendar: COALESCE(chegada_prevista_em, expira_em)), no mínimo 1h e no máximo
// 48h. Antes disso a rota responde 409 AGUARDE com liberado_em; o mesmo instante sai em GET
// /:tabela/:id como desfazer_liberado_em (só para o dono; null quando não se aplica).
//
// Efeito (transação): match, agendamento e chegada zerados (SQL_LIMPAR_MATCH, a mesma lista do
// cancelamento), demanda de volta ao feed com o prazo que restava (piso de 1h), a proposta
// vencedora vira 'cancelado' com cancelado_motivo 'escolha_desfeita' (não conta como
// cancelamento frequente — cancelamentoMatchService exclui esse motivo), sem falta e sem
// prestadores_bloqueados. Depois: push + e-mail ao profissional e reanúncio aos profissionais
// que ainda não se manifestaram (alertaService.reanunciarDemanda). Os concorrentes recusados
// no match ('recusado') NÃO voltam a 'pendente': o dono escolhe entre quem se manifestar
// de novo, como no cancelamento.
const { pool } = require('../utils/supabase')
const { formatarDataHoraSP } = require('../utils/agendamento')
const { SQL_LIMPAR_MATCH } = require('./cancelamentoMatchService')
const { entregarPushEEmail, reanunciarDemanda } = require('./alertaService')

const ESPERA_FRACAO = 0.10
const ESPERA_MIN = '1 hour'
const ESPERA_MAX = '48 hours'
const PISO_PRAZO_RESTANTE = '1 hour'
const MOTIVO_ESCOLHA_DESFEITA = 'escolha_desfeita'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const LADOS = {
  obras:   { tabela: 'obras',   tipo: 'obra',   chave: 'obra_id',   proposta: { tabela: 'candidaturas',      coluna: 'obra_id' },   nome: 'a obra',    artigo: 'A obra',    naoEncontrada: 'Obra não encontrada',    tipoPush: 'candidatura_recusada' },
  reparos: { tabela: 'reparos', tipo: 'reparo', chave: 'reparo_id', proposta: { tabela: 'interesse_reparos', coluna: 'reparo_id' }, nome: 'o serviço', artigo: 'O serviço', naoEncontrada: 'Serviço não encontrado', tipoPush: 'interesse_recusado' },
}

// p = prefixo da tabela ('' ou 'o.'). Espera = 10% de (prazo − match), entre 1h e 48h.
const sqlEspera = (p = '') =>
  `LEAST(INTERVAL '${ESPERA_MAX}', GREATEST(INTERVAL '${ESPERA_MIN}', (COALESCE(${p}chegada_prevista_em, ${p}expira_em) - ${p}match_feito_em) * ${ESPERA_FRACAO}))`
// Condições em que desfazer se aplica (fora a espera): sem isso, NULL.
const sqlPodeDesfazer = (p = '') =>
  `(${p}status = 'aberta' AND ${p}match_usuario_id IS NOT NULL AND ${p}match_feito_em IS NOT NULL
    AND ${p}chegada_pendente_em IS NULL AND ${p}chegada_prevista_em IS NULL
    AND ${p}a_caminho_em IS NULL AND ${p}chegada_declarada_em IS NULL AND ${p}chegada_confirmada_em IS NULL)`
// desfazer_liberado_em de GET /:tabela/:id (e da rota): match_feito_em + espera, ou NULL.
const sqlDesfazerLiberadoEm = (p = '') =>
  `(CASE WHEN ${sqlPodeDesfazer(p)} THEN ${p}match_feito_em + ${sqlEspera(p)} ELSE NULL END)`

const contato = async (usuarioId) => {
  const r = await pool.query(`SELECT id AS usuario_id, push_token, email, nome FROM usuarios WHERE id = $1`, [usuarioId])
  return r.rows[0] || null
}

// POST /:tabela/dono/:id/desfazer-match — só o dono.
const handler = (tabela) => {
  const lado = LADOS[tabela]
  if (!lado) throw new Error(`desfazerEscolhaService: lado desconhecido "${tabela}"`)
  return async (req, res) => {
    try {
      const id = String(req.params.id)
      if (!UUID_RE.test(id)) return res.status(404).json({ erro: lado.naoEncontrada })
      const r = await pool.query(
        `SELECT id, titulo, criado_por, match_usuario_id, match_feito_em, status, a_caminho_em,
                chegada_pendente_em, chegada_prevista_em, chegada_declarada_em, chegada_confirmada_em,
                ${sqlDesfazerLiberadoEm()} AS liberado_em, NOW() AS agora
           FROM ${lado.tabela} WHERE id = $1`,
        [id]
      )
      const d = r.rows[0]
      if (!d) return res.status(404).json({ erro: lado.naoEncontrada })
      if (d.criado_por !== req.usuario.id) return res.status(403).json({ erro: 'Só o cliente pode desfazer a escolha' })
      if (d.status !== 'aberta') return res.status(409).json({ erro: `${lado.artigo} não está mais em andamento`, codigo: 'DEMANDA_FECHADA' })
      if (!d.match_usuario_id || !d.match_feito_em) return res.status(409).json({ erro: 'Não há profissional escolhido para desfazer', codigo: 'SEM_MATCH' })
      if (d.a_caminho_em || d.chegada_declarada_em || d.chegada_confirmada_em) {
        return res.status(409).json({ erro: 'O profissional já está a caminho ou chegou: não dá mais para desfazer a escolha.', codigo: 'A_CAMINHO' })
      }
      if (d.chegada_pendente_em || d.chegada_prevista_em) {
        return res.status(409).json({ erro: 'Já há horário proposto ou combinado. Para sair do atendimento, use o cancelamento.', codigo: 'HORARIO_EM_NEGOCIACAO' })
      }
      if (!d.liberado_em) return res.status(409).json({ erro: 'Não é possível desfazer a escolha agora', codigo: 'ESTADO_MUDOU' })
      if (new Date(d.agora) < new Date(d.liberado_em)) {
        return res.status(409).json({
          erro: `Dê um tempo ao profissional: você pode desfazer a escolha a partir de ${formatarDataHoraSP(d.liberado_em)}.`,
          codigo: 'AGUARDE', liberado_em: d.liberado_em,
        })
      }

      const profissionalId = d.match_usuario_id
      const client = await pool.connect()
      let desfeito = false
      try {
        await client.query('BEGIN')
        // As condições são reavaliadas na linha VIVA, inclusive a espera pelo relógio do banco.
        const upd = await client.query(
          `UPDATE ${lado.tabela} SET ${SQL_LIMPAR_MATCH},
                  expira_em = GREATEST(expira_em, NOW() + INTERVAL '${PISO_PRAZO_RESTANTE}')
            WHERE id = $1 AND match_usuario_id = $2 AND ${sqlPodeDesfazer()}
              AND NOW() >= match_feito_em + ${sqlEspera()}
            RETURNING id`,
          [d.id, profissionalId]
        )
        if (upd.rows.length === 0) { await client.query('ROLLBACK'); return res.status(409).json({ erro: 'O atendimento mudou. Atualize a tela.', codigo: 'ESTADO_MUDOU' }) }
        await client.query(
          `UPDATE ${lado.proposta.tabela}
              SET status = 'cancelado', cancelado_por = $3, cancelado_motivo = $4, cancelado_detalhe = NULL,
                  cancelado_em = NOW(), cancelado_acordo = false
            WHERE ${lado.proposta.coluna} = $1 AND usuario_id = $2 AND status = 'aceito'`,
          [d.id, profissionalId, req.usuario.id, MOTIVO_ESCOLHA_DESFEITA]
        )
        await client.query('COMMIT')
        desfeito = true
      } catch (err) {
        try { await client.query('ROLLBACK') } catch {}
        throw err
      } finally {
        client.release()
      }
      if (!desfeito) return
      console.log(`[DesfazerEscolha] ${lado.tipo} ${d.id}: dono ${req.usuario.id} desfez a escolha de ${profissionalId}`)

      // Fora da transação, sem travar a resposta: aviso crítico ao profissional (push + e-mail,
      // dedupe em email_alertas) e reanúncio a quem ainda não se manifestou. Nunca lançam.
      contato(profissionalId).then(u => u && entregarPushEEmail({
        ...u, ator_id: req.usuario.id,
        titulo: '↩️ O cliente desfez a escolha',
        corpo: `O cliente desfez a sua escolha em "${d.titulo}" antes de combinar o horário. ${lado.artigo} voltou ao feed e não há penalidade para você.`,
        data: { tipo: lado.tipoPush, [lado.chave]: d.id, motivo: MOTIVO_ESCOLHA_DESFEITA },
        rotulo: `escolha desfeita ${lado.tipo} ${d.id}`,
      })).catch(err => console.error(`[DesfazerEscolha] aviso ${lado.tipo} ${d.id}:`, err.message))
      reanunciarDemanda(lado.tabela, d.id).catch(() => {})

      res.json({ mensagem: `Escolha desfeita. ${lado.artigo} voltou ao feed para outros profissionais.`, profissional_id: profissionalId })
    } catch (err) {
      console.error(`[DesfazerEscolha] ${tabela} ${req.params.id}:`, err.message)
      res.status(500).json({ erro: 'Erro ao desfazer a escolha' })
    }
  }
}

module.exports = { ESPERA_FRACAO, ESPERA_MIN, ESPERA_MAX, MOTIVO_ESCOLHA_DESFEITA, sqlEspera, sqlDesfazerLiberadoEm, handler }
