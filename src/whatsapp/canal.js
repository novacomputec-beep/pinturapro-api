// CANAL do WhatsApp (newsletter) — lado do WORKER (dono, 23/11/2026).
// A API monta o texto e insere a linha 'pendente' em whatsapp_canal_posts
// (services/whatsappCanalService: o post das 18:00 e o "postar agora" do painel). Aqui o worker:
//   1. resolve o canal pelo convite (env WHATSAPP_CANAL_CONVITE) e grava em whatsapp_estado o JID,
//      o nome e se o NÚMERO DO ROBÔ é admin (ao conectar, a cada 6 h e antes de postar sem canal);
//   2. posta UMA linha pendente por passo e grava o resultado na própria linha (o registro).
// Nunca posta em dobro: enviando_em é marcado ANTES de postar (quem cai no meio vira 'falha' ao
// voltar — recuperarPostsInterrompidos) e uma linha que falhou não é tentada de novo.
// Não posta: desconectado, com a pausa global ligada (a linha espera) ou sem a trava
// WHATSAPP_SOMENTE_PARA (worker que "não envia nada" → falha). A trava em lista NÃO segura o canal:
// ela escolhe quem recebe mensagem direta; o canal é ligado pela chave canal_auto_ativo / pelo
// super-admin. O automático só sai dentro da janela 08–21h e no próprio dia; depois disso expira.
const { TZ, CHAVE_PAUSADO, VALIDADE_POST_MANUAL_MIN, REVERIFICAR_CANAL_MS, NOVA_TENTATIVA_CANAL_MS,
        lerConviteCanal, lerTrava, dentroDaJanela } = require('./config')

const cortar = (s, n = 300) => String(s ?? '').slice(0, n)

const recuperarPostsInterrompidos = async (db) => {
  const r = await db.query(
    `UPDATE whatsapp_canal_posts
        SET status = 'falha', erro = 'interrompido durante a postagem (não repetido)', enviando_em = NULL
      WHERE status = 'pendente' AND enviando_em IS NOT NULL
  RETURNING id`)
  return r.rows.length
}

const criarCanal = ({ db, adaptador, env = process.env, log = console }) => {
  const convite = lerConviteCanal(env)
  const conviteBruto = String(env.WHATSAPP_CANAL_CONVITE ?? '').trim() || null
  const sabePostar = typeof adaptador.resolverCanal === 'function' && typeof adaptador.postarNoCanal === 'function'
  const erroFixo = !sabePostar ? 'este adaptador não publica em canal'
    : !convite ? (conviteBruto ? 'WHATSAPP_CANAL_CONVITE inválida' : 'WHATSAPP_CANAL_CONVITE ausente') : null
  let canal = null                 // { jid, nome, papel, admin, seguidores }
  let ultimoErro = erroFixo
  let verificadoEm = 0, tentarDe = 0, erroFixoGravado = false

  const gravar = (c, erro) => db.query(
    `UPDATE whatsapp_estado
        SET canal_convite = $1, canal_jid = $2, canal_nome = $3, canal_papel = $4, canal_admin = $5, canal_erro = $6, canal_verificado_em = NOW()
      WHERE id = 1`,
    [conviteBruto, c?.jid || null, c?.nome || null, c?.papel || null, c ? c.admin : null, erro ? cortar(erro) : null])

  // Pergunta ao WhatsApp qual é o canal e qual o papel do robô nele. Nunca lança.
  const verificar = async (agora = new Date()) => {
    try {
      canal = await adaptador.resolverCanal(convite)
      ultimoErro = null
      verificadoEm = agora.getTime()
      await gravar(canal, null)
      log.log(`[whatsapp/canal] ${canal.nome || 'canal'} (${canal.jid}) — papel do robô: ${canal.papel || 'não informado'}${canal.admin ? ' (admin: pode postar)' : canal.admin === false ? ' (NÃO é admin: não pode postar)' : ''}`)
    } catch (err) {
      canal = null
      ultimoErro = `não foi possível resolver o canal: ${err?.message || err}`
      verificadoEm = 0
      tentarDe = agora.getTime() + NOVA_TENTATIVA_CANAL_MS
      log.error('[whatsapp/canal]', ultimoErro)
      await gravar(null, ultimoErro).catch(() => {})
    }
    return canal
  }

  const encerrar = (id, status, { erro = null, waId = null, agoraIso }) => db.query(
    `UPDATE whatsapp_canal_posts
        SET status = $2, erro = $3, wa_message_id = $4, canal_jid = $5, enviando_em = NULL,
            postado_em = CASE WHEN $2 = 'postado' THEN $6::timestamptz ELSE NULL END
      WHERE id = $1`,
    [id, status, erro ? cortar(erro) : null, waId, canal?.jid || null, agoraIso])

  // Um passo do laço do worker. Devolve { postou, motivo, falouComWhatsapp, id? }.
  const passo = async ({ agora = new Date() } = {}) => {
    const agoraIso = agora.toISOString()
    let falou = false
    // Vencidos: o automático que não saiu no dia; o manual que ninguém pegou em 15 min.
    await db.query(
      `UPDATE whatsapp_canal_posts
          SET status = 'falha', erro = 'não postado a tempo (robô parado, pausado ou desconectado)'
        WHERE status = 'pendente' AND enviando_em IS NULL
          AND ((origem = 'auto' AND dia <> ($1::timestamptz AT TIME ZONE '${TZ}')::date)
            OR (origem = 'manual' AND criado_em < $1::timestamptz - INTERVAL '${VALIDADE_POST_MANUAL_MIN} minutes'))`,
      [agoraIso])
    if (erroFixo && !erroFixoGravado) { await gravar(null, erroFixo); erroFixoGravado = true }
    if (adaptador.estado().conexao !== 'conectado') {
      verificadoEm = 0                 // reconectou → confere o canal de novo
      return { postou: false, motivo: 'desconectado', falouComWhatsapp: false }
    }
    if (!erroFixo && agora.getTime() - verificadoEm > REVERIFICAR_CANAL_MS && agora.getTime() >= tentarDe) {
      await verificar(agora)
      falou = true
    }
    const pausa = await db.query(`SELECT valor FROM configuracoes WHERE chave = $1`, [CHAVE_PAUSADO])
    if (pausa.rows[0]?.valor === 'true') return { postou: false, motivo: 'pausado', falouComWhatsapp: falou }

    const prox = await db.query(
      `UPDATE whatsapp_canal_posts SET enviando_em = $1::timestamptz
        WHERE id = (SELECT id FROM whatsapp_canal_posts
                     WHERE status = 'pendente' AND enviando_em IS NULL AND (origem = 'manual' OR $2::boolean)
                     ORDER BY id LIMIT 1)
    RETURNING id, origem, texto`,
      [agoraIso, dentroDaJanela(agora)])
    const post = prox.rows[0]
    if (!post) return { postou: false, motivo: 'nada', falouComWhatsapp: falou }

    const falhar = async (erro, motivo) => {
      await encerrar(post.id, 'falha', { erro, agoraIso })
      log.error(`[whatsapp/canal] post ${post.id} (${post.origem}) NÃO publicado: ${erro}`)
      return { postou: false, motivo, falouComWhatsapp: falou, id: post.id, erro }
    }
    if (lerTrava(env).modo === 'ausente') return falhar('robô sem WHATSAPP_SOMENTE_PARA: nada é enviado', 'sem_trava')
    if (erroFixo) return falhar(erroFixo, 'sem_canal')
    if (!canal && !falou) { await verificar(agora); falou = true }
    if (!canal) return falhar(ultimoErro || 'canal não resolvido', 'sem_canal')
    if (canal.admin === false) return falhar(`o número do robô não é admin do canal (papel: ${canal.papel})`, 'nao_admin')
    if (!String(post.texto || '').trim()) return falhar('post sem texto', 'sem_texto')
    try {
      const r = await adaptador.postarNoCanal(canal.jid, post.texto)
      await encerrar(post.id, 'postado', { waId: r?.id || null, agoraIso })
      return { postou: true, motivo: 'postado', falouComWhatsapp: true, id: post.id, waMessageId: r?.id || null }
    } catch (err) {
      falou = true
      return falhar(`erro ao publicar: ${err?.message || err}`, 'erro_ao_postar')
    }
  }

  return { passo, verificar, canal: () => (canal ? { ...canal } : null), erro: () => ultimoErro }
}

module.exports = { criarCanal, recuperarPostsInterrompidos }
