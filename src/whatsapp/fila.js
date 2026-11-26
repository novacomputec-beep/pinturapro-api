// FILA DE ENVIO do robô de WhatsApp. Uma chamada de processarProxima() envia NO MÁXIMO uma
// mensagem (o worker espera 20–40 s entre chamadas que falaram com o WhatsApp). Ordem das travas:
//   1) trava de teste WHATSAPP_SOMENTE_PARA ausente → nada sai;
//   2) pausa global (configuracoes.whatsapp_pausado);
//   3) janela 08–21h de São Paulo (fora dela só sai a resposta automática a quem escreveu);
//   4) adaptador conectado;
//   5) por linha: tipo ligado, número liberado pela trava, pessoa não saiu (usuarios.whatsapp_avisos),
//      no máximo uma mensagem por pessoa a cada 3 h (tipos com limitePorPessoa), número existe no
//      WhatsApp (onWhatsApp) — e o envio vai para o JID que o WhatsApp devolveu.
// Vários itens pendentes do mesmo tipo para a mesma pessoa/telefone saem numa mensagem só.
// ETAPA 2 — 'pergunta_sem_resposta': o texto é redigido AQUI, na hora do envio (textos.js), com
// as perguntas que ainda estão sem resposta; a que o dono já respondeu no app (ou cujo pedido
// fechou) sai da fila sem enviar.
// 'novo_interessado' (19/11/2026): também redigido AQUI, com TODOS os interesses pendentes da
// pessoa numa mensagem só; sai da fila sem enviar o interesse cancelado/recusado, o de pedido que
// já tem escolhido, fechou ou venceu, e o de dono que passou a ter notificação (push) no celular.
// SIMULAÇÃO (whatsapp_mensagens.sandbox — POST /admin/whatsapp/simular-pergunta): pergunta de
// mentira, sem pergunta/pedido de verdade. Passa pelas MESMAS travas (trava de teste, pausa, janela
// 08–21h, tipo ligado), menos o limite de 3 h por pessoa: não é barrada por ele nem conta para ele.
// Sai sempre sozinha (nunca agrupada) e não "caduca" (não há pergunta no app para ser respondida).
// 'avulsa' (19/11/2026 — POST /admin/whatsapp/avulsa): escrita à mão no painel; sempre ligada (fora
// do liga/desliga por tipo), sai sozinha com o texto exato e passa pelas demais travas.
// 'especialidade_rara' (23/11/2026 — services/whatsappEspecialidadeRaraService): para o
// profissional; uma mensagem por linha, redigida AQUI (o "Termina em…" é o da hora do envio). Sai da
// fila sem enviar se o pedido ganhou interessado/escolhido, fechou ou venceu.
// 'contato_no_texto' (26/11/2026 — services/whatsappContatoNoTextoService): para o dono do pedido;
// sai sozinha, com o texto exato da fila. Sai da fila sem enviar se o pedido fechou, ganhou
// escolhido, venceu ou deixou de estar marcado.
// `db` = pool (ou client); `agora` e `env` injetáveis para o teste.
const { TIPOS, CHAVE_PAUSADO, chaveTipo, MAX_TENTATIVAS, ESPERA_ENTRE_TENTATIVAS_MIN, MAX_ITENS_POR_MENSAGEM,
        TIPO_RESPOSTA, RESPOSTA_VALIDADE_MIN, INTERVALO_PESSOA_HORAS, MAX_PERGUNTAS_POR_MENSAGEM, MAX_INTERESSADOS_POR_MENSAGEM,
        TIPO_RARA, TIPO_CONTATO, lerTrava, travaPermite, dentroDaJanela, variantesTelefone } = require('./config')
const { textoPerguntas, textoInteressados, textoEspecialidadeRara } = require('./textos')

const TIPO_PERGUNTA = 'pergunta_sem_resposta'
const TIPO_INTERESSADO = 'novo_interessado'
const TIPOS_LIMITADOS = Object.keys(TIPOS).filter(t => TIPOS[t].limitePorPessoa)

// { pausado, tiposLigados } — chave ausente vale o padrão do tipo (config.TIPOS).
const lerConfig = async (db) => {
  const chaves = [CHAVE_PAUSADO, ...Object.keys(TIPOS).map(chaveTipo)]
  const r = await db.query(`SELECT chave, valor FROM configuracoes WHERE chave = ANY($1::text[])`, [chaves])
  const mapa = Object.fromEntries(r.rows.map(l => [l.chave, l.valor]))
  const tipos = Object.fromEntries(Object.entries(TIPOS).map(([t, def]) => {
    const v = mapa[chaveTipo(t)]
    // sempreLigado (avulsa): a chave por tipo não vale para ele.
    return [t, def.sempreLigado ? true : v === undefined || v === null ? !!def.padrao : v === 'true']
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

// "Pedido aberto" = a mesma expressão que aceita a pergunta (routes/index: aberta, aprovada,
// dentro do prazo, sem escolhido). $n = instante de referência.
const sqlPerguntaPendente = (pq, n) => `(${pq}.id IS NOT NULL AND ${pq}.respondido_em IS NULL AND (
    EXISTS (SELECT 1 FROM reparos d WHERE ${pq}.tipo = 'reparo' AND d.id = ${pq}.demanda_id AND d.status = 'aberta'
               AND d.status_aprovacao = 'aprovada' AND d.expira_em > ${n}::timestamptz AND d.match_usuario_id IS NULL)
 OR EXISTS (SELECT 1 FROM obras d WHERE ${pq}.tipo = 'obra' AND d.id = ${pq}.demanda_id AND d.status = 'aberta'
               AND d.status_aprovacao = 'aprovada' AND d.expira_em > ${n}::timestamptz AND d.match_usuario_id IS NULL)))`

// Pedido aberto para escolha: a mesma expressão acima, sobre a linha do pedido (alias d).
const sqlPedidoAbertoSemEscolhido = (d, n) => `(${d}.status = 'aberta' AND ${d}.status_aprovacao = 'aprovada' AND ${d}.expira_em > ${n}::timestamptz AND ${d}.match_usuario_id IS NULL)`
// Interesse/candidatura (alias i) que ainda vale: não cancelado nem recusado pelo dono.
const sqlInteresseVivo = (i) => `(${i}.cancelado_em IS NULL AND COALESCE(${i}.status, 'pendente') <> 'recusado')`
// Dono SEM push: nenhuma conta CONTRATANTE da mesma pessoa (mesmo CPF/CNPJ só em dígitos — a
// regra de utils/tipoConta.sqlContasDaPessoa, que é a que o envio de push usa) tem push_token.
// Repetida aqui porque o worker não importa os utils da API (config.WATCH_PATHS).
const sqlCpf = (c) => `NULLIF(regexp_replace(COALESCE(${c}, ''), '[^0-9]', '', 'g'), '')`
const sqlDonoSemPush = (uid) => `NOT EXISTS (
    SELECT 1 FROM usuarios tk
     WHERE COALESCE(tk.push_token, '') <> ''
       AND (tk.id = ${uid} OR (tk.role = 'dono_obra' AND EXISTS (
             SELECT 1 FROM usuarios eu WHERE eu.id = ${uid} AND eu.role = 'dono_obra' AND ${sqlCpf('eu.cpf_cnpj')} = ${sqlCpf('tk.cpf_cnpj')}))))`
// Linha da fila (alias m) de 'novo_interessado' que ainda deve sair. ref_tabela/ref_id = o pedido;
// dados.interesse_id = a linha de interesse_reparos/candidaturas.
const sqlInteressadoVale = (m, n) => `(${sqlDonoSemPush(`${m}.usuario_id`)} AND (
    EXISTS (SELECT 1 FROM reparos d JOIN interesse_reparos i ON i.reparo_id = d.id
             WHERE ${m}.ref_tabela = 'reparos' AND d.id = ${m}.ref_id AND i.id::text = ${m}.dados->>'interesse_id'
               AND ${sqlInteresseVivo('i')} AND ${sqlPedidoAbertoSemEscolhido('d', n)})
 OR EXISTS (SELECT 1 FROM obras d JOIN candidaturas i ON i.obra_id = d.id
             WHERE ${m}.ref_tabela = 'obras' AND d.id = ${m}.ref_id AND i.id::text = ${m}.dados->>'interesse_id'
               AND ${sqlInteresseVivo('i')} AND ${sqlPedidoAbertoSemEscolhido('d', n)})))`

// Linha da fila (alias m) de 'especialidade_rara' que ainda deve sair: o pedido (ref_tabela/ref_id)
// segue aberto, sem escolhido, dentro do prazo e SEM nenhum interessado vivo.
const sqlRaraVale = (m, n) => `(
    EXISTS (SELECT 1 FROM reparos d WHERE ${m}.ref_tabela = 'reparos' AND d.id = ${m}.ref_id AND ${sqlPedidoAbertoSemEscolhido('d', n)}
               AND NOT EXISTS (SELECT 1 FROM interesse_reparos i WHERE i.reparo_id = d.id AND ${sqlInteresseVivo('i')}))
 OR EXISTS (SELECT 1 FROM obras d WHERE ${m}.ref_tabela = 'obras' AND d.id = ${m}.ref_id AND ${sqlPedidoAbertoSemEscolhido('d', n)}
               AND NOT EXISTS (SELECT 1 FROM candidaturas i WHERE i.obra_id = d.id AND ${sqlInteresseVivo('i')})))`
// Linha da fila (alias m) de 'contato_no_texto' que ainda deve sair: o pedido segue aberto, sem
// escolhido, dentro do prazo e ainda MARCADO com contato no texto.
const sqlContatoVale = (m, n) => `(
    EXISTS (SELECT 1 FROM reparos d WHERE ${m}.ref_tabela = 'reparos' AND d.id = ${m}.ref_id AND d.contato_no_texto AND ${sqlPedidoAbertoSemEscolhido('d', n)})
 OR EXISTS (SELECT 1 FROM obras d WHERE ${m}.ref_tabela = 'obras' AND d.id = ${m}.ref_id AND d.contato_no_texto AND ${sqlPedidoAbertoSemEscolhido('d', n)}))`
// Prazo ATUAL do pedido da linha (o dono pode ter estendido depois de a linha entrar na fila).
const sqlExpiraDoPedido = (m) => `(CASE ${m}.ref_tabela WHEN 'reparos' THEN (SELECT d.expira_em FROM reparos d WHERE d.id = ${m}.ref_id)
                                      WHEN 'obras' THEN (SELECT d.expira_em FROM obras d WHERE d.id = ${m}.ref_id) END)`

// Devolve { enviou, motivo, falouComWhatsapp }. falouComWhatsapp = true → o worker espera o
// intervalo de 20–40 s antes da próxima (vale também para a consulta onWhatsApp sem envio).
const processarProxima = async ({ db, adaptador, agora = new Date(), env = process.env } = {}) => {
  const trava = lerTrava(env)
  if (trava.modo === 'ausente') return { enviou: false, motivo: 'sem_trava', falouComWhatsapp: false }
  const config = await lerConfig(db)
  if (config.pausado) return { enviou: false, motivo: 'pausado', falouComWhatsapp: false }
  const agoraIso = agora.toISOString()
  // Resposta automática velha não sai mais (antes de qualquer outra coisa, mesmo desconectado).
  await db.query(
    `UPDATE whatsapp_mensagens SET status = 'falha', erro = 'resposta automática expirada (não enviada a tempo)', enviando_em = NULL, atualizado_em = NOW()
      WHERE status = 'fila' AND tipo = $1 AND criado_em < $2::timestamptz - INTERVAL '${RESPOSTA_VALIDADE_MIN} minutes'`,
    [TIPO_RESPOSTA, agoraIso])
  const naJanela = dentroDaJanela(agora)
  const tipos = naJanela ? [...config.tiposLigados, TIPO_RESPOSTA] : [TIPO_RESPOSTA]
  if (adaptador.estado().conexao !== 'conectado') return { enviou: false, motivo: 'desconectado', falouComWhatsapp: false }

  // Linhas resolvidas sem falar com o WhatsApp (trava, saída, pergunta já respondida) não seguram
  // a fila: segue para a próxima.
  for (let volta = 0; volta < 50; volta++) {
    const prox = await db.query(
      `SELECT m.id, m.tipo, m.usuario_id, m.telefone, m.wa_jid, m.tentativas, m.sandbox, u.whatsapp_avisos
         FROM whatsapp_mensagens m LEFT JOIN usuarios u ON u.id = m.usuario_id
        WHERE m.status = 'fila' AND m.enviando_em IS NULL AND m.tipo = ANY($1::text[])
          AND (m.proxima_tentativa_em IS NULL OR m.proxima_tentativa_em <= $2::timestamptz)
          -- No máximo uma mensagem por pessoa (telefone) a cada ${INTERVALO_PESSOA_HORAS} h, nos tipos limitados.
          -- Simulação (sandbox) fica fora do limite: não é barrada e não conta.
          AND (m.sandbox OR m.tipo <> ALL($3::text[]) OR NOT EXISTS (
                SELECT 1 FROM whatsapp_mensagens x
                 WHERE x.telefone = m.telefone AND x.tipo = ANY($3::text[]) AND NOT x.sandbox
                   AND x.enviada_em > $2::timestamptz - INTERVAL '${INTERVALO_PESSOA_HORAS} hours'))
        ORDER BY (m.tipo = $4) DESC, m.criado_em, m.id LIMIT 1`,
      [tipos, agoraIso, TIPOS_LIMITADOS, TIPO_RESPOSTA])
    const p = prox.rows[0]
    if (!p) {
      if (!naJanela) return { enviou: false, motivo: 'fora_do_horario', falouComWhatsapp: false }
      return { enviou: false, motivo: config.tiposLigados.every(t => TIPOS[t].sempreLigado) ? 'tipos_desligados' : 'fila_vazia', falouComWhatsapp: false }
    }
    const ehResposta = p.tipo === TIPO_RESPOSTA

    if (!travaPermite(trava, p.telefone)) {
      await encerrar(db, [p.id], 'falha', 'bloqueada pela trava de teste (WHATSAPP_SOMENTE_PARA)')
      continue
    }
    // Quem saiu não recebe aviso. (A resposta automática vai para quem ACABOU de escrever.)
    if (!ehResposta && p.usuario_id && p.whatsapp_avisos === false) {
      await db.query(
        `UPDATE whatsapp_mensagens SET status = 'saiu', enviando_em = NULL, atualizado_em = NOW()
          WHERE status = 'fila' AND usuario_id = $1::uuid AND tipo <> $2`,
        [p.usuario_id, TIPO_RESPOSTA])
      continue
    }

    // Agrupa: os itens pendentes do MESMO tipo, da mesma pessoa, para o mesmo telefone.
    const grupo = await db.query(
      `SELECT m.id, m.texto, m.dados, ${p.tipo === TIPO_PERGUNTA ? `(m.sandbox OR ${sqlPerguntaPendente('pq', '$4')})` : p.tipo === TIPO_INTERESSADO ? sqlInteressadoVale('m', '$4') : p.tipo === TIPO_RARA ? sqlRaraVale('m', '$4') : p.tipo === TIPO_CONTATO ? sqlContatoVale('m', '$4') : 'true'} AS vale,
              ${p.tipo === TIPO_RARA ? sqlExpiraDoPedido('m') : 'NULL::timestamptz'} AS expira_em
         FROM whatsapp_mensagens m
         ${p.tipo === TIPO_PERGUNTA ? `LEFT JOIN perguntas_demanda pq ON pq.id = m.ref_id` : ''}
        WHERE m.status = 'fila' AND m.enviando_em IS NULL AND m.telefone = $1 AND m.tipo = $2
          AND m.usuario_id IS NOT DISTINCT FROM $3::uuid
          AND (m.proxima_tentativa_em IS NULL OR m.proxima_tentativa_em <= $4::timestamptz)
          -- Simulação sai sozinha; as de verdade nunca levam uma simulação junto.
          AND m.sandbox = $5::boolean AND ($5::boolean IS NOT TRUE OR m.id = $6::bigint)
          -- Tipo "sozinho" (avulsa): cada linha é uma mensagem, com o texto como foi escrito.
          AND ($7::boolean IS NOT TRUE OR m.id = $6::bigint)
        ORDER BY m.criado_em, m.id LIMIT ${MAX_INTERESSADOS_POR_MENSAGEM}`,
      [p.telefone, p.tipo, p.usuario_id, agoraIso, p.sandbox === true, p.id, !!TIPOS[p.tipo]?.sozinho])
    // Pergunta que o dono já respondeu no app (ou de pedido que fechou) e interesse que não vale
    // mais (pedido com escolhido/fechado/vencido, interesse cancelado, dono já com push): sai da
    // fila sem enviar.
    const caducas = grupo.rows.filter(l => !l.vale).map(l => l.id)
    if (caducas.length) await db.query(`DELETE FROM whatsapp_mensagens WHERE id = ANY($1::bigint[]) AND status = 'fila'`, [caducas])
    const maximo = ehResposta ? 1 : p.tipo === TIPO_PERGUNTA ? MAX_PERGUNTAS_POR_MENSAGEM
      : p.tipo === TIPO_INTERESSADO ? MAX_INTERESSADOS_POR_MENSAGEM : MAX_ITENS_POR_MENSAGEM
    const itens = grupo.rows.filter(l => l.vale).slice(0, maximo)
    if (itens.length === 0) continue
    const ids = itens.map(l => l.id)

    let texto = montarTexto(itens)
    if (p.tipo === TIPO_PERGUNTA || p.tipo === TIPO_INTERESSADO || p.tipo === TIPO_RARA) {
      // Primeira mensagem que este número recebe do robô (qualquer tipo)? Só ela leva o "responda SAIR".
      const antes = await db.query(
        `SELECT 1 FROM whatsapp_mensagens WHERE enviada_em IS NOT NULL AND telefone = ANY($1::text[]) LIMIT 1`,
        [variantesTelefone(p.telefone)])
      const primeira = antes.rows.length === 0
      if (p.tipo === TIPO_RARA) {
        texto = textoEspecialidadeRara({ ...(itens[0].dados || {}), expira_em: itens[0].expira_em || itens[0].dados?.expira_em }, { primeira, agora })
      } else {
        const redigir = p.tipo === TIPO_INTERESSADO ? textoInteressados : textoPerguntas
        texto = redigir(itens.map(l => l.dados || {}), { primeira })
      }
    }
    await db.query(`UPDATE whatsapp_mensagens SET enviando_em = $2::timestamptz WHERE id = ANY($1::bigint[])`, [ids, agoraIso])

    try {
      // Resposta automática: o destino é o JID de quem escreveu (já é do WhatsApp) — sem consulta.
      const destino = ehResposta && p.wa_jid ? { existe: true, jid: p.wa_jid } : await adaptador.existeNoWhatsapp(p.telefone)
      if (!destino?.existe || !destino.jid) {
        await encerrar(db, ids, 'sem_whatsapp')
        return { enviou: false, motivo: 'sem_whatsapp', falouComWhatsapp: true, ids }
      }
      const envio = await adaptador.enviarTexto(destino.jid, texto)
      if (!envio?.id) throw new Error('o WhatsApp não devolveu o id da mensagem')
      // A primeira linha é a "dona" da mensagem (guarda o texto que saiu); as demais apontam para
      // ela (agrupada_em). item_numero = posição na mensagem numerada (só quando há mais de uma).
      await db.query(
        `UPDATE whatsapp_mensagens m
            SET status = 'enviada', wa_jid = $2, wa_message_id = $3, enviada_em = $4::timestamptz, erro = NULL,
                tentativas = tentativas + 1, enviando_em = NULL, proxima_tentativa_em = NULL,
                agrupada_em = CASE WHEN m.id = $5::bigint THEN NULL ELSE $5::bigint END,
                texto = CASE WHEN m.id = $5::bigint THEN $6 ELSE m.texto END,
                item_numero = CASE WHEN $7::boolean THEN array_position($1::bigint[], m.id) ELSE NULL END,
                atualizado_em = NOW()
          WHERE m.id = ANY($1::bigint[])`,
        [ids, destino.jid, envio.id, agoraIso, ids[0], texto, p.tipo === TIPO_PERGUNTA && ids.length > 1])
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

module.exports = { lerConfig, recuperarInterrompidas, processarProxima, aplicarStatus, montarTexto, sqlPerguntaPendente, TIPO_PERGUNTA,
  TIPO_INTERESSADO, sqlPedidoAbertoSemEscolhido, sqlInteresseVivo, sqlDonoSemPush, sqlInteressadoVale, sqlRaraVale, sqlContatoVale }
