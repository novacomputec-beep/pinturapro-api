// Aba "WhatsApp" do painel (robô — Etapa 1). Só super-admin. A API NÃO fala com o WhatsApp:
// lê o que o worker grava (whatsapp_estado, whatsapp_mensagens) e deixa pedidos para ele
// (configuracoes: pausa e tipos; whatsapp_estado.comando: desconectar; a fila: teste).
const express = require('express')
const router = express.Router()
const { autenticar, exigirSuperAdmin } = require('../middlewares/auth')
const { pool } = require('../utils/supabase')
const { TIPOS, STATUS, CHAVE_PAUSADO, chaveTipo, TZ, dentroDaJanela, normalizarTelefone, HORA_INICIO, HORA_FIM, TIPO_RESPOSTA, ROTULO_RESPOSTA } = require('../whatsapp/config')
const { lerConfig } = require('../whatsapp/fila')
const { enfileirar } = require('../services/whatsappFilaService')
const { simularPergunta } = require('../services/whatsappPerguntasService')

// Worker considerado vivo se bateu nos últimos 90 s (ele bate a cada 30 s).
const WORKER_VIVO_SEGUNDOS = 90

// configuracoes.chave é PRIMARY KEY em produção; UPDATE + INSERT condicional funciona também
// num esquema sem a constraint (fixtures de teste).
const gravarConfig = (chave, valor) => pool.query(
  `WITH upd AS (UPDATE configuracoes SET valor = $2, atualizado_em = NOW() WHERE chave = $1 RETURNING 1)
   INSERT INTO configuracoes (chave, valor) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM upd)`,
  [chave, valor])

// "Pergunta sem resposta · 3529D “Entregar panfletos 1000 unidades”" — sem pedido, só o rótulo do tipo.
const resumoDaMensagem = (tipo, codigo, titulo) => {
  const rotulo = TIPOS[tipo]?.rotulo || (tipo === TIPO_RESPOSTA ? ROTULO_RESPOSTA : tipo)
  const t = String(titulo || '').trim()
  const pedido = [codigo, t ? `“${t.length > 40 ? `${t.slice(0, 39)}…` : t}”` : ''].filter(Boolean).join(' ')
  return pedido ? `${rotulo} · ${pedido}` : rotulo
}

const responderErro = (res, rotulo, err) => {
  console.error(`[admin/whatsapp/${rotulo}]`, err.message)
  res.status(500).json({ erro: 'Erro no robô de WhatsApp' })
}

// GET /admin/whatsapp/status — conexão, QR (texto; o painel desenha), número, trava, pausa, fila.
router.get('/admin/whatsapp/status', autenticar, exigirSuperAdmin, async (req, res) => {
  try {
    const e = await pool.query(
      `SELECT conexao, qr, qr_em, numero, trava, heartbeat_em, ultimo_envio_em, ultimo_erro, comando, conectado_em,
              (heartbeat_em IS NOT NULL AND heartbeat_em > NOW() - INTERVAL '${WORKER_VIVO_SEGUNDOS} seconds') AS worker_vivo
         FROM whatsapp_estado WHERE id = 1`)
    const linha = e.rows[0] || {}
    const config = await lerConfig(pool)
    const fila = await pool.query(`SELECT COUNT(*)::int AS n FROM whatsapp_mensagens WHERE status = 'fila'`)
    const vivo = !!linha.worker_vivo
    res.json({
      worker_vivo: vivo,
      // Worker parado: o que está gravado é o último estado conhecido, não o atual.
      conexao: vivo ? linha.conexao : 'desligado',
      qr: vivo && linha.conexao === 'aguardando_qr' ? linha.qr : null,
      qr_em: linha.qr_em || null,
      // Desde quando a conexão atual está aberta; null se não está conectado agora.
      conectado_em: vivo && linha.conexao === 'conectado' ? (linha.conectado_em || null) : null,
      numero: linha.numero || null,
      trava: linha.trava || null,
      envio_liberado: !!linha.trava,
      pausado: config.pausado,
      janela: { inicio: HORA_INICIO, fim: HORA_FIM, fuso: TZ, aberta: dentroDaJanela(new Date()) },
      na_fila: fila.rows[0].n,
      heartbeat_em: linha.heartbeat_em || null,
      ultimo_envio_em: linha.ultimo_envio_em || null,
      ultimo_erro: linha.ultimo_erro || null,
      comando_pendente: linha.comando || null,
    })
  } catch (err) { responderErro(res, 'status', err) }
})

const definirPausa = (pausado) => async (req, res) => {
  try {
    await gravarConfig(CHAVE_PAUSADO, pausado ? 'true' : 'false')
    res.json({ pausado })
  } catch (err) { responderErro(res, pausado ? 'pausar' : 'retomar', err) }
}
router.post('/admin/whatsapp/pausar', autenticar, exigirSuperAdmin, definirPausa(true))
router.post('/admin/whatsapp/retomar', autenticar, exigirSuperAdmin, definirPausa(false))

// POST /admin/whatsapp/desconectar — o worker encerra a sessão e mostra um QR novo.
router.post('/admin/whatsapp/desconectar', autenticar, exigirSuperAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE whatsapp_estado SET comando = 'desconectar', atualizado_em = NOW() WHERE id = 1`)
    res.json({ mensagem: 'Pedido registrado. O robô desconecta em alguns segundos e gera um novo QR.' })
  } catch (err) { responderErro(res, 'desconectar', err) }
})

// GET /admin/whatsapp/contadores — por status e por tipo: hoje (dia de São Paulo) e últimos 7 dias.
router.get('/admin/whatsapp/contadores', autenticar, exigirSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT tipo, status,
              COUNT(*) FILTER (WHERE (criado_em AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date)::int AS hoje,
              COUNT(*)::int AS sete_dias
         FROM whatsapp_mensagens
        WHERE criado_em > NOW() - INTERVAL '7 days'
        GROUP BY tipo, status`)
    const zero = () => Object.fromEntries(STATUS.map(s => [s, 0]))
    const hoje = zero(), seteDias = zero(), porTipo = {}
    for (const l of r.rows) {
      hoje[l.status] = (hoje[l.status] || 0) + l.hoje
      seteDias[l.status] = (seteDias[l.status] || 0) + l.sete_dias
      porTipo[l.tipo] ??= { hoje: zero(), sete_dias: zero() }
      porTipo[l.tipo].hoje[l.status] = l.hoje
      porTipo[l.tipo].sete_dias[l.status] = l.sete_dias
    }
    const recebidas = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE (recebida_em AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date)::int AS hoje,
              COUNT(*)::int AS sete_dias
         FROM whatsapp_recebidas WHERE recebida_em > NOW() - INTERVAL '7 days'`)
    res.json({ hoje, sete_dias: seteDias, por_tipo: porTipo, recebidas: recebidas.rows[0] })
  } catch (err) { responderErro(res, 'contadores', err) }
})

// GET /admin/whatsapp/mensagens?status=&tipo=&telefone=&de=AAAA-MM-DD&ate=AAAA-MM-DD&page=&limit=
router.get('/admin/whatsapp/mensagens', autenticar, exigirSuperAdmin, async (req, res) => {
  try {
    const { status, tipo, telefone, de, ate } = req.query
    const RE_DIA = /^\d{4}-\d{2}-\d{2}$/
    if (status && !STATUS.includes(status)) return res.status(400).json({ erro: 'status inválido' })
    if ((de && !RE_DIA.test(de)) || (ate && !RE_DIA.test(ate))) return res.status(400).json({ erro: 'datas no formato AAAA-MM-DD' })
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50))
    const where = [], params = []
    const p = (v) => { params.push(v); return `$${params.length}` }
    if (status) where.push(`m.status = ${p(status)}`)
    if (tipo) where.push(`m.tipo = ${p(String(tipo))}`)
    const digitos = String(telefone || '').replace(/\D/g, '')
    if (digitos) where.push(`m.telefone LIKE ${p(`%${digitos}%`)}`)
    if (de) where.push(`(m.criado_em AT TIME ZONE '${TZ}')::date >= ${p(de)}::date`)
    if (ate) where.push(`(m.criado_em AT TIME ZONE '${TZ}')::date <= ${p(ate)}::date`)
    // Pedido da mensagem: ref_tabela 'reparos' | 'obras' aponta direto; 'perguntas_demanda' aponta
    // a pergunta, que leva ao pedido. codigo = código curto; papel = lado de quem RECEBE no pedido
    // ('dono' se a conta criou o pedido, senão 'profissional'); sem pedido, vale o tipo da conta.
    const r = await pool.query(
      `SELECT m.id, m.tipo, m.status, m.usuario_id, u.nome AS usuario_nome, m.telefone, m.texto, m.ref_tabela, m.ref_id,
              m.wa_jid, m.wa_message_id, m.agrupada_em, m.tentativas, m.erro, m.criado_em, m.proxima_tentativa_em,
              m.enviada_em, m.entregue_em, m.lida_em, m.respondida_em, m.item_numero, m.resposta, m.sandbox,
              COALESCE(rp.codigo_publico, ob.codigo_publico) AS codigo,
              -- Simulação não tem pedido: o título de mentira vem dos dados da própria linha.
              COALESCE(rp.titulo, ob.titulo, CASE WHEN m.sandbox THEN m.dados->>'titulo' END) AS _titulo,
              CASE WHEN COALESCE(rp.criado_por, ob.criado_por) = m.usuario_id THEN 'dono'
                   WHEN COALESCE(rp.id, ob.id) IS NOT NULL AND u.role = 'prestador' THEN 'profissional'
                   WHEN u.role = 'dono_obra' THEN 'dono'
                   WHEN u.role = 'prestador' THEN 'profissional'
                   ELSE NULL END AS papel,
              COUNT(*) OVER()::int AS _total
         FROM whatsapp_mensagens m
         LEFT JOIN usuarios u ON u.id = m.usuario_id
         LEFT JOIN perguntas_demanda pq ON m.ref_tabela = 'perguntas_demanda' AND pq.id = m.ref_id
         LEFT JOIN reparos rp ON rp.id = COALESCE(pq.demanda_id, m.ref_id)
         LEFT JOIN obras ob ON ob.id = COALESCE(pq.demanda_id, m.ref_id)
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY m.criado_em DESC, m.id DESC
        LIMIT ${p(limit)}::int OFFSET ${p((page - 1) * limit)}::int`,
      params)
    const total = r.rows[0]?._total || 0
    const mensagens = r.rows.map(({ _total, _titulo, ...l }) => ({
      ...l,
      // resumo: detalhe curto para a linha da lista — tipo + pedido (código e título), quando há.
      resumo: resumoDaMensagem(l.tipo, l.codigo, _titulo) + (l.sandbox ? ' (simulação)' : ''),
      // resposta: o que a pessoa respondeu a ESTA mensagem pelo WhatsApp (null se não respondeu).
      resposta: l.resposta ?? null,
    }))
    res.json({ mensagens, total, page, limit })
  } catch (err) { responderErro(res, 'mensagens', err) }
})

// GET /admin/whatsapp/tipos — liga/desliga por tipo.
router.get('/admin/whatsapp/tipos', autenticar, exigirSuperAdmin, async (req, res) => {
  try {
    const config = await lerConfig(pool)
    // Sempre os mesmos slugs, na ordem de config.TIPOS; implementado = já tem gatilho de envio;
    // dica = linha de ajuda embaixo do rótulo (null quando o tipo não tem).
    res.json({ tipos: Object.entries(TIPOS).map(([tipo, def]) => ({ tipo, rotulo: def.rotulo, dica: def.dica || null, ligado: config.tipos[tipo], implementado: !!def.implementado })) })
  } catch (err) { responderErro(res, 'tipos', err) }
})

// PUT /admin/whatsapp/tipos { tipo, ligado }
router.put('/admin/whatsapp/tipos', autenticar, exigirSuperAdmin, async (req, res) => {
  try {
    const { tipo, ligado } = req.body || {}
    if (typeof tipo !== 'string' || !Object.prototype.hasOwnProperty.call(TIPOS, tipo)) return res.status(400).json({ erro: 'tipo desconhecido' })
    if (typeof ligado !== 'boolean') return res.status(400).json({ erro: 'ligado deve ser true ou false' })
    await gravarConfig(chaveTipo(tipo), ligado ? 'true' : 'false')
    res.json({ tipo, ligado })
  } catch (err) { responderErro(res, 'tipos', err) }
})

// POST /admin/whatsapp/teste { texto?, telefone? } — põe UMA mensagem de teste na fila. Destino:
// o número da trava (o primeiro, se forem vários); com a trava em TODOS, `telefone` é obrigatório.
router.post('/admin/whatsapp/teste', autenticar, exigirSuperAdmin, async (req, res) => {
  try {
    const e = await pool.query(`SELECT trava FROM whatsapp_estado WHERE id = 1`)
    const trava = e.rows[0]?.trava || null
    if (!trava) return res.status(409).json({ erro: 'O robô está sem a trava WHATSAPP_SOMENTE_PARA (ou ainda não iniciou): nada pode ser enviado.' })
    const informado = normalizarTelefone(req.body?.telefone)
    const destino = trava === 'TODOS' ? informado : (informado && trava.split(',').includes(informado) ? informado : trava.split(',')[0])
    if (!destino) return res.status(400).json({ erro: 'Informe o telefone de destino (com DDD).' })
    const texto = typeof req.body?.texto === 'string' && req.body.texto.trim()
      ? req.body.texto.trim().slice(0, 1000)
      : 'Teste do robô ProTudo: se você recebeu esta mensagem, o envio automático está funcionando.'
    const r = await enfileirar({ tipo: 'teste', telefone: destino, texto })
    if (!r.ok) return res.status(400).json({ erro: `Não entrou na fila: ${r.motivo}` })
    res.json({ id: r.id, telefone: r.telefone, mensagem: 'Mensagem de teste na fila.' })
  } catch (err) { responderErro(res, 'teste', err) }
})

// POST /admin/whatsapp/simular-pergunta — põe UMA "pergunta sem resposta" SIMULADA na fila para o
// número da trava de teste (services/whatsappPerguntasService.simularPergunta): dados de mentira,
// sandbox = true, sem pedido nem pergunta de verdade. A resposta dada pelo WhatsApp NÃO vai para o
// app — aparece só aqui, na lista de mensagens. Respeita a janela 08–21h; fora do limite de 3 h.
router.post('/admin/whatsapp/simular-pergunta', autenticar, exigirSuperAdmin, async (req, res) => {
  try {
    const r = await simularPergunta(pool)
    if (!r.ok) return res.status(r.status).json({ erro: r.erro })
    const quando = r.pausado ? 'O robô está pausado: sai quando for retomado.'
      : r.janela_aberta ? 'Sai em instantes.' : `Fora do horário de envio: sai a partir das ${String(HORA_INICIO).padStart(2, '0')}h.`
    res.json({
      id: r.id, telefone: r.telefone, sandbox: true, ja_na_fila: r.ja_na_fila, janela_aberta: r.janela_aberta, pausado: r.pausado,
      mensagem: `${r.ja_na_fila ? 'Já havia uma pergunta simulada na fila.' : 'Pergunta simulada na fila.'} ${quando}`,
    })
  } catch (err) { responderErro(res, 'simular-pergunta', err) }
})

module.exports = router
