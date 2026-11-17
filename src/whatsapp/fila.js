// FILA DE ENVIO do robô de WhatsApp. Uma chamada de processarProxima() envia NO MÁXIMO uma
// mensagem (o worker espera 20–40 s entre chamadas que falaram com o WhatsApp). Ordem das travas:
//   1) trava de teste WHATSAPP_SOMENTE_PARA ausente → nada sai;
//   2) pausa global (configuracoes.whatsapp_pausado);
//   3) janela 08–21h de São Paulo;
//   4) adaptador conectado;
//   5) por linha: tipo ligado, número liberado pela trava, pessoa não saiu (usuarios.whatsapp_avisos),
//      número existe no WhatsApp (onWhatsApp) — e o envio vai para o JID que o WhatsApp devolveu.
// Vários itens pendentes da mesma pessoa/telefone saem numa mensagem só.
// `db` = pool (ou client); `agora` e `env` injetáveis para o teste.
const { TIPOS, CHAVE_PAUSADO, chaveTipo, MAX_TENTATIVAS, ESPERA_ENTRE_TENTATIVAS_MIN, MAX_ITENS_POR_MENSAGEM,
        lerTrava, travaPermite, dentroDaJanela } = require('./config')

// { pausado, tiposLigados } — chave ausente vale o padrão do tipo (config.TIPOS).
const lerConfig = async (db) => {
  const chaves = [CHAVE_PAUSADO, ...Object.keys(TIPOS).map(chaveTipo)]
  const r = await db.query(`SELECT chave, valor FROM configuracoes WHERE chave = ANY($1::text[])`, [chaves])
  const mapa = Object.fromEntries(r.rows.map(l => [l.chave, l.valor]))
  const tipos = Object.fromEntries(Object.entries(TIPOS).map(([t, def]) => {
    const v = mapa[chaveTipo(t)]
    return [t, v === undefined || v === null ? !!def.padrao : v === 'true']
  }))
  return { pausado: mapa[CHAVE_PAUSADO] === 'true', tipos, tiposLigados: Object.keys(tipos).filter(t => tipos[t]) }
}

// Worker que caiu ENTRE marcar enviando_em e gravar o resultado: não dá para saber se a mensagem
// saiu. Vira 'falha' (visível no painel) em vez de voltar à fila — nunca manda em dobro.
const recuperarInterrompidas = async (db) => {
  const r = await db.query(
    `UPDATE whatsapp_mensagens
        SET status = 'falha', erro = 'interrompida durante o envio (não reenviada)', enviando_em = NULL, atualizado_em = NOW()
      WHERE status = 'fila' AND enviando_em IS NOT NULL
  RETURNING id`)
  return r.rows.length
}

const encerrar = (db, ids, status, erro = null) => db.query(
  `UPDATE whatsapp_mensagens SET status = $2, erro = $3, enviando_em = NULL, atualizado_em = NOW() WHERE id = ANY($1::bigint[]) AND status = 'fila'`,
  [ids, status, erro])

const montarTexto = (linhas) => linhas.map(l => String(l.texto).trim()).join('\n\n')

// Devolve { enviou, motivo, falouComWhatsapp }. falouComWhatsapp = true → o worker espera o
// intervalo de 20–40 s antes da próxima (vale também para a consulta onWhatsApp sem envio).
const processarProxima = async ({ db, adaptador, agora = new Date(), env = process.env } = {}) => {
  const trava = lerTrava(env)
  if (trava.modo === 'ausente') return { enviou: false, motivo: 'sem_trava', falouComWhatsapp: false }
  const config = await lerConfig(db)
  if (config.pausado) return { enviou: false, motivo: 'pausado', falouComWhatsapp: false }
  if (!dentroDaJanela(agora)) return { enviou: false, motivo: 'fora_do_horario', falouComWhatsapp: false }
  if (adaptador.estado().conexao !== 'conectado') return { enviou: false, motivo: 'desconectado', falouComWhatsapp: false }
  if (config.tiposLigados.length === 0) return { enviou: false, motivo: 'tipos_desligados', falouComWhatsapp: false }
  const agoraIso = agora.toISOString()

  // Linhas resolvidas sem falar com o WhatsApp (trava, saída) não seguram a fila: segue para a próxima.
  for (let volta = 0; volta < 50; volta++) {
    const prox = await db.query(
      `SELECT m.id, m.usuario_id, m.telefone, m.tentativas, u.whatsapp_avisos
         FROM whatsapp_mensagens m LEFT JOIN usuarios u ON u.id = m.usuario_id
        WHERE m.status = 'fila' AND m.enviando_em IS NULL AND m.tipo = ANY($1::text[])
          AND (m.proxima_tentativa_em IS NULL OR m.proxima_tentativa_em <= $2::timestamptz)
        ORDER BY m.criado_em, m.id LIMIT 1`,
      [config.tiposLigados, agoraIso])
    const p = prox.rows[0]
    if (!p) return { enviou: false, motivo: 'fila_vazia', falouComWhatsapp: false }

    if (!travaPermite(trava, p.telefone)) {
      await encerrar(db, [p.id], 'falha', 'bloqueada pela trava de teste (WHATSAPP_SOMENTE_PARA)')
      continue
    }
    if (p.usuario_id && p.whatsapp_avisos === false) {
      await db.query(
        `UPDATE whatsapp_mensagens SET status = 'saiu', enviando_em = NULL, atualizado_em = NOW() WHERE status = 'fila' AND usuario_id = $1::uuid`,
        [p.usuario_id])
      continue
    }

    // Agrupa: todos os itens pendentes da mesma pessoa para o mesmo telefone, na ordem de chegada.
    const grupo = await db.query(
      `SELECT id, texto FROM whatsapp_mensagens
        WHERE status = 'fila' AND enviando_em IS NULL AND telefone = $1 AND tipo = ANY($2::text[])
          AND usuario_id IS NOT DISTINCT FROM $3::uuid
          AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em <= $4::timestamptz)
        ORDER BY criado_em, id LIMIT ${MAX_ITENS_POR_MENSAGEM}`,
      [p.telefone, config.tiposLigados, p.usuario_id, agoraIso])
    const ids = grupo.rows.map(l => l.id)
    await db.query(`UPDATE whatsapp_mensagens SET enviando_em = $2::timestamptz WHERE id = ANY($1::bigint[])`, [ids, agoraIso])

    try {
      const destino = await adaptador.existeNoWhatsapp(p.telefone)
      if (!destino?.existe || !destino.jid) {
        await encerrar(db, ids, 'sem_whatsapp')
        return { enviou: false, motivo: 'sem_whatsapp', falouComWhatsapp: true, ids }
      }
      const envio = await adaptador.enviarTexto(destino.jid, montarTexto(grupo.rows))
      if (!envio?.id) throw new Error('o WhatsApp não devolveu o id da mensagem')
      // A primeira linha é a "dona" da mensagem; as demais apontam para ela (agrupada_em).
      await db.query(
        `UPDATE whatsapp_mensagens
            SET status = 'enviada', wa_jid = $2, wa_message_id = $3, enviada_em = $4::timestamptz, erro = NULL,
                tentativas = tentativas + 1, enviando_em = NULL, proxima_tentativa_em = NULL,
                agrupada_em = CASE WHEN id = $5::bigint THEN NULL ELSE $5::bigint END, atualizado_em = NOW()
          WHERE id = ANY($1::bigint[])`,
        [ids, destino.jid, envio.id, agoraIso, ids[0]])
      return { enviou: true, motivo: 'enviada', falouComWhatsapp: true, ids, jid: destino.jid, waMessageId: envio.id }
    } catch (err) {
      const proxima = new Date(agora.getTime() + ESPERA_ENTRE_TENTATIVAS_MIN * 60000 * (Number(p.tentativas) + 1)).toISOString()
      await db.query(
        `UPDATE whatsapp_mensagens
            SET tentativas = tentativas + 1, erro = $2, enviando_em = NULL,
                status = CASE WHEN tentativas + 1 >= $3::int THEN 'falha' ELSE 'fila' END,
                proxima_tentativa_em = CASE WHEN tentativas + 1 >= $3::int THEN NULL ELSE $4::timestamptz END,
                atualizado_em = NOW()
          WHERE id = ANY($1::bigint[])`,
        [ids, String(err?.message || err).slice(0, 500), MAX_TENTATIVAS, proxima])
      return { enviou: false, motivo: 'erro_no_envio', falouComWhatsapp: true, ids, erro: String(err?.message || err) }
    }
  }
  return { enviou: false, motivo: 'fila_so_com_bloqueadas', falouComWhatsapp: false }
}

// Recibo do WhatsApp: enviada → entregue → lida. Nunca volta atrás e não mexe em linha que já
// saiu desse trilho (respondida, falha…). Vale para a mensagem e para as agrupadas nela.
const aplicarStatus = async (db, { id, status }) => {
  if (!id || !['entregue', 'lida'].includes(status)) return 0
  const r = await db.query(
    `UPDATE whatsapp_mensagens
        SET status = $2,
            entregue_em = COALESCE(entregue_em, NOW()),
            lida_em = CASE WHEN $2 = 'lida' THEN COALESCE(lida_em, NOW()) ELSE lida_em END,
            atualizado_em = NOW()
      WHERE wa_message_id = $1 AND (status = 'enviada' OR (status = 'entregue' AND $2 = 'lida'))
  RETURNING id`,
    [id, status])
  return r.rows.length
}

module.exports = { lerConfig, recuperarInterrompidas, processarProxima, aplicarStatus, montarTexto }
