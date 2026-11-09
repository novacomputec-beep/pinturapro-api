// Mensagens prontas entre o dono e o profissional escolhido (obras e reparos) — catálogo, fases
// e limites em utils/mensagensProntas. Aqui: as duas rotas e o push ao outro lado.
//
//   GET  /:tabela/:id/mensagens-prontas             → { fase, papel, limite, restantes, frases, historico }
//   POST /:tabela/:id/mensagens-prontas {frase_id}  → 201 { mensagem, fase, restantes }
//
// QUEM: só o dono (qualquer conta contratante da mesma pessoa — utils/tipoConta.ehMesmaPessoa) e o
// profissional escolhido (qualquer conta profissional da pessoa do match — ehMesmoProfissional;
// nas rotas com a demanda na URL `autenticar` já age como a conta que tem o match). Os demais: 403.
// Só `autenticar` nas rotas: é conversa de um atendimento já combinado — conta suspensa ou sem
// assinatura continua podendo avisar que vai atrasar.
//
// ENVIO: só por frase_id; o texto gravado e enviado é o do catálogo (qualquer outro campo do
// corpo é ignorado). 400 FRASE_INVALIDA para id desconhecido ou do outro papel; 409 com `codigo`:
//   FASE_INCORRETA   — não há fase agora (sem profissional escolhido, demanda fechada, chegada já
//                      confirmada) ou a frase é de outra fase; `fase` traz a fase atual (ou null);
//   FRASE_REPETIDA   — esta frase já foi enviada por este lado nesta fase;
//   LIMITE_ATINGIDO  — este lado já enviou LIMITE_POR_FASE mensagens nesta fase.
// O limite e a repetição valem por PAPEL no atendimento (demanda + profissional escolhido): o
// dono é uma pessoa só, o profissional também, quaisquer que sejam as contas usadas.
//
// PUSH: imediato ao outro lado (só push — sem e-mail: são até 15 por lado por atendimento e o
// teto diário de e-mails é das coisas que só o e-mail resolve), título com quem fala + a demanda,
// corpo = a frase. data.tipo 'chegada_prevista' + obra_id/reparo_id: o roteador de toques do app
// já abre o DETALHE da demanda com ele, nos dois lados e nos dois tipos, desde 08/2026 — sem
// versão nova do app. `mensagem_pronta: true` só distingue nos registros.
const { pool } = require('../utils/supabase')
const { ehMesmaPessoa, ehMesmoProfissional } = require('../utils/tipoConta')
const { contatoDaPessoa, enviarPushNotificacao } = require('./alertaService')
const { LIMITE_POR_FASE, COLUNAS_FASE, fraseDoCatalogo, frasesDe, faseDaDemanda } = require('../utils/mensagensProntas')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LADOS = {
  obras:   { tabela: 'obras',   tipo: 'obra',   chave: 'obra_id',   naoEncontrada: 'Obra não encontrada' },
  reparos: { tabela: 'reparos', tipo: 'reparo', chave: 'reparo_id', naoEncontrada: 'Serviço não encontrado' },
}
const ERRO_SEM_FASE = 'As mensagens prontas valem entre a escolha do profissional e a chegada dele.'

const carregar = async (lado, id) => {
  if (!UUID_RE.test(String(id))) return null
  const r = await pool.query(`SELECT id, titulo, criado_por, ${COLUNAS_FASE} FROM ${lado.tabela} WHERE id = $1`, [id])
  return r.rows[0] || null
}
// 'dono' | 'profissional' | null (não participa). Os dois conjuntos de contas são disjuntos.
const papelDe = async (d, usuarioId) => {
  if (await ehMesmaPessoa(d.criado_por, usuarioId)) return 'dono'
  if (d.match_usuario_id && await ehMesmoProfissional(d.match_usuario_id, usuarioId)) return 'profissional'
  return null
}
// Demanda + papel de quem chama, ou { status, corpo } para responder.
const guardar = async (lado, req) => {
  const d = await carregar(lado, req.params.id)
  if (!d) return { status: 404, corpo: { erro: lado.naoEncontrada } }
  const papel = await papelDe(d, req.usuario.id)
  if (!papel) return { status: 403, corpo: { erro: 'Só o cliente e o profissional escolhido podem trocar mensagens neste pedido' } }
  return { d, papel }
}
// A conversa do ATENDIMENTO atual (demanda + profissional escolhido); sem escolhido, vazia.
const historicoDe = async (lado, d) => {
  if (!d.match_usuario_id) return []
  const r = await pool.query(
    `SELECT id, papel, fase, frase_id, texto, enviado_em
       FROM mensagens_prontas_enviadas
      WHERE tipo = $1 AND demanda_id = $2 AND profissional_id = $3
      ORDER BY enviado_em, id`,
    [lado.tipo, d.id, d.match_usuario_id])
  return r.rows
}
const montar = (d, papel, linhas) => {
  const fase = faseDaDemanda(d)
  const minhasNaFase = fase ? linhas.filter(l => l.papel === papel && l.fase === fase) : []
  const enviadas = new Set(minhasNaFase.map(l => l.frase_id))
  const restantes = fase ? Math.max(0, LIMITE_POR_FASE - minhasNaFase.length) : 0
  return {
    fase, papel, limite: LIMITE_POR_FASE, restantes,
    frases: fase ? frasesDe(fase, papel).map(f => ({ ...f, enviada: enviadas.has(f.id) })) : [],
    historico: linhas.map(l => ({ ...l, minha: l.papel === papel })),
  }
}

const tituloPush = (papel, d) => `💬 ${papel === 'dono' ? 'Cliente' : 'Profissional'} · ${String(d.titulo || '').slice(0, 60)}`
// Fire-and-forget; nunca lança.
const avisarOutroLado = async (lado, d, papel, frase) => {
  const destinoId = papel === 'dono' ? d.match_usuario_id : d.criado_por
  try {
    const contato = await contatoDaPessoa(destinoId)
    if (!contato?.push_token) return 'sem token'
    return await enviarPushNotificacao(contato.push_token, tituloPush(papel, d), frase.texto,
      { tipo: 'chegada_prevista', [lado.chave]: d.id, mensagem_pronta: true, frase_id: frase.id }, destinoId)
  } catch (err) {
    console.error(`[MensagensProntas] push ${lado.tabela} ${d.id}:`, err.message)
    return 'falha'
  }
}

const handlers = (tabela) => {
  const lado = LADOS[tabela]
  if (!lado) throw new Error(`mensagensProntasService: lado desconhecido "${tabela}"`)

  const listar = async (req, res) => {
    try {
      const g = await guardar(lado, req)
      if (g.status) return res.status(g.status).json(g.corpo)
      res.json(montar(g.d, g.papel, await historicoDe(lado, g.d)))
    } catch (err) {
      console.error(`[MensagensProntas] GET ${tabela} ${req.params.id}:`, err.message)
      res.status(500).json({ erro: 'Erro ao carregar as mensagens' })
    }
  }

  const enviar = async (req, res) => {
    try {
      const g = await guardar(lado, req)
      if (g.status) return res.status(g.status).json(g.corpo)
      const { d, papel } = g
      const frase = fraseDoCatalogo(req.body?.frase_id)
      if (!frase || frase.papel !== papel) return res.status(400).json({ erro: 'Mensagem inválida', codigo: 'FRASE_INVALIDA' })
      const fase = faseDaDemanda(d)
      if (!fase) return res.status(409).json({ erro: ERRO_SEM_FASE, codigo: 'FASE_INCORRETA', fase: null })
      if (frase.fase !== fase) return res.status(409).json({ erro: 'Esta mensagem não vale para o momento atual do atendimento.', codigo: 'FASE_INCORRETA', fase })

      // Limite e unicidade no MESMO statement: o SELECT só produz a linha abaixo do limite, e o
      // índice único (ON CONFLICT) barra a frase repetida — dois toques simultâneos gravam uma vez.
      const ins = await pool.query(
        `INSERT INTO mensagens_prontas_enviadas (tipo, demanda_id, remetente_id, papel, profissional_id, fase, frase_id, texto)
         SELECT $1::text, $2::uuid, $3::uuid, $4::text, $5::uuid, $6::text, $7::text, $8::text
          WHERE (SELECT count(*) FROM mensagens_prontas_enviadas m
                  WHERE m.tipo = $1::text AND m.demanda_id = $2::uuid AND m.profissional_id = $5::uuid
                    AND m.papel = $4::text AND m.fase = $6::text) < $9::int
         ON CONFLICT (tipo, demanda_id, profissional_id, papel, fase, frase_id) DO NOTHING
         RETURNING id, papel, fase, frase_id, texto, enviado_em`,
        [lado.tipo, d.id, req.usuario.id, papel, d.match_usuario_id, fase, frase.id, frase.texto, LIMITE_POR_FASE])
      if (ins.rows.length === 0) {
        const repetida = await pool.query(
          `SELECT 1 FROM mensagens_prontas_enviadas
            WHERE tipo = $1 AND demanda_id = $2 AND profissional_id = $3 AND papel = $4 AND fase = $5 AND frase_id = $6`,
          [lado.tipo, d.id, d.match_usuario_id, papel, fase, frase.id])
        if (repetida.rows.length > 0) return res.status(409).json({ erro: 'Você já enviou esta mensagem.', codigo: 'FRASE_REPETIDA', fase })
        return res.status(409).json({ erro: `Você já enviou ${LIMITE_POR_FASE} mensagens nesta etapa.`, codigo: 'LIMITE_ATINGIDO', fase, limite: LIMITE_POR_FASE })
      }
      const estado = montar(d, papel, await historicoDe(lado, d))
      res.status(201).json({ mensagem: { ...ins.rows[0], minha: true }, fase, limite: LIMITE_POR_FASE, restantes: estado.restantes, frases: estado.frases })
      avisarOutroLado(lado, d, papel, frase)
    } catch (err) {
      console.error(`[MensagensProntas] POST ${tabela} ${req.params.id}:`, err.message)
      res.status(500).json({ erro: 'Erro ao enviar a mensagem' })
    }
  }

  return { listar, enviar }
}

module.exports = { handlers, tituloPush }
