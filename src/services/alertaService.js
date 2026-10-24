const { pool } = require('../utils/supabase')
const { Expo } = require('expo-server-sdk')
const { getFaixa, MAX_OFFSET_MARCO_MINUTOS, PRAZO_MODO_HOJE, sqlFimDoDia, SQL_FIM_DO_DIA_SP, sqlZonaSegura } = require('../utils/faixasPrazo')
// Ver src/routes/index.js: a obra guarda a zona do dono em prazo_timezone, validada contra
// pg_timezone_names NA HORA DO USO — zona NULL ou que deixou de existir recua para o padrão em
// vez de derrubar o UPDATE do lote inteiro. Só o lado OBRA tem zona — reparo não tem "Hoje".
const SQL_ZONA_DA_OBRA = sqlZonaSegura('obras.prazo_timezone')
// D78: o reparo também guarda a zona do dono (reparos.prazo_timezone) para a faixa "Hoje".
const SQL_ZONA_DO_REPARO = sqlZonaSegura('reparos.prazo_timezone')
const { MARCA } = require('../utils/marca')
const { normalizar, sqlNormalizarCidade } = require('../utils/localidade')
// Emoji e rótulo por categoria (cópia verbatim das listas do app): o push "novo serviço" /
// "nova obra" mostra o mesmo emoji do chip que o prestador vê no feed, e o rótulo acentuado
// em vez do slug cru. Fallback = emoji fixo de antes + slug cru, para categoria fora da lista.
const { apresentacaoReparo, apresentacaoObra } = require('../utils/categoriasApp')
// Cidade dobrada dos DOIS lados com a MESMA regra (ver utils/localidade): a do profissional
// aqui, a da demanda em JS com normalizar(). uf compara em caixa alta, que e como e gravado.
const SQL_CIDADE_PRESTADOR = sqlNormalizarCidade('u.cidade')
// Sem ciclo: middlewares/auth só importa jsonwebtoken e utils/supabase, nunca este serviço.
const { invalidarCacheAssinatura } = require('../middlewares/auth')
// E-mail de reserva do aviso de demanda nova (enviarEmailsNovaDemanda). brevoService só
// importa o SDK e utils/marca — sem ciclo. Direto no Brevo (e não em emailService) para o
// erro de cada envio chegar aqui e ser logado por destinatário.
const { enviarEmail: enviarEmailBrevo } = require('./brevoService')
// A OUTRA conta da mesma pessoa (mesmo CPF normalizado do criador da demanda) fica fora de todo
// público de notificação de demanda: broadcast de demanda nova / oferta aumentada / lembrete
// (broadcastPaginado), repescagem por destinatário (reenviarEntregasFalhas) e e-mail de reserva
// (reivindicarEmailsNovaDemanda). Sem CPF de um dos lados o predicado não filtra. Só leitura:
// push_entregas nunca é reescrita por causa disto. utils/demandaPropria só importa utils/supabase.
const { sqlNaoMesmoCpf, sqlNaoMesmoCpfDoCriador } = require('../utils/demandaPropria')
// Agendamento livre de chegada (módulo inerte): zeragem das colunas no un-match, isenção de
// falta (JS + SQL), espera pela resposta à vigia e os lembretes/vigia abaixo de lembrarPrazoChegada.
const { TZ_AGENDA, JANELA_AGENDADO, VIGIA_ATRASO, LEMBRETE_AGENDA_JANELA, SQL_ZERAR_AGENDA, SQL_ISENCAO_FALTA, isentoDeFalta, SQL_ESPERA_COMPARECIMENTO, formatarDataHoraSP } = require('../utils/agendamento')

const expo = new Expo()

// Consulta os recibos de entrega (depois de um intervalo, pois o Expo processa a
// entrega de forma assíncrona) e remove tokens reportados como DeviceNotRegistered.
// Recebe pares { ticket, pushToken } de tickets já confirmados como 'ok'.
// É chamada em fire-and-forget — qualquer erro é apenas logado, nunca propagado.
const processarRecibos = async (ticketsComToken, delayMs = 15000) => {
  const receiptIdToToken = {}
  for (const { ticket, pushToken } of ticketsComToken) {
    if (ticket && ticket.status === 'ok' && ticket.id) {
      receiptIdToToken[ticket.id] = pushToken
    }
  }
  const receiptIds = Object.keys(receiptIdToToken)
  if (receiptIds.length === 0) return

  // Aguarda o Expo concluir a entrega antes de consultar os recibos
  await new Promise(resolve => setTimeout(resolve, delayMs))

  const tokensInvalidos = new Set()
  const idChunks = expo.chunkPushNotificationReceiptIds(receiptIds)
  for (const chunk of idChunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk)
      for (const [receiptId, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'error') {
          const erro = receipt.details?.error
          console.error('[Push] Recibo com erro | erro:', erro || 'n/a', '| msg:', receipt.message)
          if (erro === 'DeviceNotRegistered') {
            tokensInvalidos.add(receiptIdToToken[receiptId])
          }
        }
      }
    } catch (err) {
      console.error('[Push] Erro ao consultar recibos:', err.message)
    }
  }

  if (tokensInvalidos.size > 0) {
    try {
      await pool.query(
        `UPDATE usuarios SET push_token = NULL WHERE push_token = ANY($1)`,
        [[...tokensInvalidos]]
      )
      console.log(`[Push] ${tokensInvalidos.size} token(s) inválido(s) removido(s) (DeviceNotRegistered)`)
    } catch (err) {
      console.error('[Push] Erro ao remover tokens inválidos:', err.message)
    }
  }
}

// Nunca lança. Devolve 'enviado' (ticket ok), 'falha' (ticket 'error' ou exceção) ou
// 'invalido' (token ausente/não-Expo) — os chamadores antigos ignoram o retorno; a reserva de
// e-mail (entregarPushOuEmail) usa-o para decidir se ainda precisa mandar o e-mail.
const enviarPushNotificacao = async (pushToken, titulo, corpo, data = {}) => {
  if (!Expo.isExpoPushToken(pushToken)) {
    console.warn('[Push] Token inválido ou ausente:', pushToken ? pushToken.substring(0, 30) : 'null')
    return 'invalido'
  }
  try {
    const tickets = await expo.sendPushNotificationsAsync([{
      to: pushToken,
      sound: 'default',
      channelId: 'default_v3',
      title: titulo,
      body: corpo,
      data,
    }])
    const ticket = tickets[0]
    if (ticket && ticket.status === 'error') {
      console.error(
        '[Push] Falha no envio:', titulo,
        '| erro:', ticket.message,
        '| detalhe:', ticket.details?.error || 'n/a',
        '→', pushToken.substring(0, 30)
      )
      return 'falha'
    }
    console.log('[Push] Enviado:', titulo, '→', pushToken.substring(0, 30))
    processarRecibos([{ ticket, pushToken }]).catch(err =>
      console.error('[Push] Erro no processamento de recibos:', err.message))
    return 'enviado'
  } catch (err) {
    console.error('[Push] Erro ao enviar:', err.message)
    return 'falha'
  }
}

// Envia notificações em lote para múltiplos tokens de uma vez
// Muito mais eficiente que um loop sequencial com await
// Devolve UM resultado POR DESTINATÁRIO, na mesma ordem da entrada:
//   { id, push_token, resultado } com resultado em 'enviado' (ticket 'ok'), 'falha' (ticket
//   'error' OU chunk inteiro que estourou na chamada HTTP) ou 'invalido' (token que nem é
//   Expo, incluindo null). Os contadores agregados de antes saem de contarResultados(), para
//   o log; a lista por pessoa é o que broadcastPaginado grava em push_entregas — antes só
//   existiam os totais, e quem falhou dentro de uma página não era registrado em lugar nenhum.
// Os chunks de 100 seguem SEQUENCIAIS (um await por chamada HTTP).
const enviarPushEmLoteDetalhado = async (destinatarios, titulo, corpo, data = {}) => {
  const resultados = destinatarios.map(d => ({
    id: d.id,
    push_token: d.push_token,
    resultado: Expo.isExpoPushToken(d.push_token) ? null : 'invalido',
  }))
  // Índices (na lista de entrada) dos destinatários com token válido, na ordem em que as
  // mensagens são montadas: a resposta do Expo vem na ordem do chunk, então chunk[i] casa
  // com validos[offset + i].
  const validos = []
  const mensagens = []
  destinatarios.forEach((d, i) => {
    if (resultados[i].resultado !== null) return
    validos.push(i)
    mensagens.push({
      to: d.push_token,
      sound: 'default',
      channelId: 'default_v3',
      title: titulo,
      body: corpo,
      // data por destinatario (d.data) tem precedencia sobre o data compartilhado da chamada
      data: d.data || data,
    })
  })

  if (mensagens.length === 0) return resultados

  // Expo recomenda chunks de até 100 mensagens por chamada
  const chunks = expo.chunkPushNotifications(mensagens)
  const ticketsComToken = []
  let offset = 0
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk)
      tickets.forEach((ticket, i) => {
        const alvo = resultados[validos[offset + i]]
        const pushToken = chunk[i].to
        if (ticket && ticket.status === 'error') {
          alvo.resultado = 'falha'
          console.error(
            '[Push] Falha no envio (lote):', titulo,
            '| erro:', ticket.message,
            '| detalhe:', ticket.details?.error || 'n/a',
            '→', pushToken.substring(0, 30)
          )
        } else {
          alvo.resultado = 'enviado'
          ticketsComToken.push({ ticket, pushToken })
        }
      })
    } catch (err) {
      // Chunk inteiro sem resposta: todo mundo dele é 'falha' (e agora fica registrado).
      for (let i = 0; i < chunk.length; i++) resultados[validos[offset + i]].resultado = 'falha'
      console.error('Erro ao enviar chunk de notificações:', err)
    }
    offset += chunk.length
  }

  if (ticketsComToken.length > 0) {
    processarRecibos(ticketsComToken).catch(err =>
      console.error('[Push] Erro no processamento de recibos:', err.message))
  }

  return resultados
}

// Totais a partir da lista por destinatário — o formato que o log do broadcast sempre usou.
const contarResultados = (resultados) => {
  const c = { elegiveis: resultados.length, invalidos: 0, enviados: 0, falhos: 0 }
  for (const r of resultados) {
    if (r.resultado === 'enviado') c.enviados++
    else if (r.resultado === 'falha') c.falhos++
    else c.invalidos++
  }
  return c
}

// Compatibilidade: os chamadores antigos recebem o mesmo número de sempre (mensagens com
// token válido, enviadas ou não).
const enviarPushEmLote = async (destinatarios, titulo, corpo, data = {}) => {
  const s = contarResultados(await enviarPushEmLoteDetalhado(destinatarios, titulo, corpo, data))
  return s.enviados + s.falhos
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
      mensagem = 'Explore serviços disponíveis na sua região agora mesmo!'
    } else if (role === 'dono_obra') {
      mensagem = 'Cadastre sua primeira obra ou serviço e encontre profissionais qualificados!'
    }

    await enviarPushNotificacao(
      push_token,
      `🎉 Bem-vindo ao ${MARCA}, ${primeiroNome}!`,
      mensagem,
      { tipo: 'boas_vindas' }
    )
  } catch (err) {
    console.error('Erro ao enviar boas vindas:', err)
  }
}

// Predicado canônico de "assinatura ativa" — o MESMO de assinaturaAtivaCacheada
// (src/middlewares/auth.js), que é o gate que todo prestador atravessa, e dos detalhes
// GET /obras/:id e GET /reparos/:id: status 'ativa' E vencimento nulo ou futuro. Antes o
// broadcast olhava só o status e avisava quem já estava vencido (A5, item 3).
const SQL_ASSINATURA_ATIVA = `a.status = 'ativa' AND (a.proximo_vencimento IS NULL OR a.proximo_vencimento > NOW())`

// Tamanho de página do broadcast — o antigo LIMIT 500 vira o passo do cursor, não o teto.
const PAGINA_BROADCAST = 500

// Broadcast PAGINADO por chave estável (A5): u.id > cursor ORDER BY u.id LIMIT 500, até
// esgotar. Antes era LIMIT 500 sem ORDER BY nem continuação: numa cidade com 5.000
// assinantes, até 90% nunca recebiam a publicação — e, sem ordem, possivelmente sempre os
// mesmos. Cada página é enviada antes de buscar a próxima (a memória não cresce com a
// cidade). No fim, UMA linha de log com elegíveis / enviados / falhos / inválidos / páginas,
// para truncamento ou falha nunca mais ser silencioso. Declarada ANTES dos dois chamadores
// (const em TDZ derrubou o boot em 25/08).
//
// categoria (opcional, só o lado reparo passa): casa a categoria da demanda com
// usuarios.especialidades NO SQL —
//   - null (lado obra): sem filtro, comportamento de sempre;
//   - 'outros': todo reparador ativo da cidade que tenha AO MENOS UMA especialidade;
//   - qualquer outra: só quem tem exatamente esse slug no array.
// Array NULL ou vazio nunca recebe nada, nem 'outros' (cardinality(NULL) é NULL → falso).
// Registro por destinatário em push_entregas (routes/index.js, migração). Um statement por
// página. ON CONFLICT: a linha já existe quando é RE-tentativa (rede de segurança) ou quando o
// claim da demanda deu ROLLBACK e o broadcast inteiro rodou de novo — nos dois casos o
// resultado vira o da tentativa atual e tentativas soma 1. tipo/demandaId vêm do chamador
// (nunca do request); usuario_id/resultado vêm do próprio envio.
const registrarEntregas = async (tipo, demandaId, resultados) => {
  if (resultados.length === 0) return
  await pool.query(
    `INSERT INTO push_entregas (tipo, demanda_id, usuario_id, resultado)
     SELECT $1, $2, r.usuario_id, r.resultado
       FROM unnest($3::uuid[], $4::text[]) AS r(usuario_id, resultado)
     ON CONFLICT (tipo, demanda_id, usuario_id) DO UPDATE
        SET resultado = EXCLUDED.resultado,
            tentativas = push_entregas.tentativas + 1,
            ultima_tentativa_em = NOW()`,
    [tipo, demandaId, resultados.map(r => r.id), resultados.map(r => r.resultado)]
  )
}

// Quem JÁ se manifestou numa demanda (candidaturas / interesse_reparos, qualquer status — o app
// não deixa a mesma pessoa manifestar duas vezes) fica FORA dos lembretes dela, no push e no
// e-mail. `interesse` = { tabela, coluna } do lado (LADOS_LEMBRETE); `param` é o placeholder do
// id da demanda; `u` é o alias do prestador nas duas consultas de público. Sem `interesse`
// (demanda nova) devolve '' — ninguém pode ter se manifestado antes do primeiro aviso.
const sqlSemManifestacao = (interesse, param) => (interesse
  ? `AND NOT EXISTS (SELECT 1 FROM ${interesse.tabela} x WHERE x.${interesse.coluna} = ${param}::uuid AND x.usuario_id = u.id)`
  : '')

// entrega = { tipo: 'obra' | 'reparo', demandaId }: identifica a demanda em push_entregas.
// null: envia sem registrar (push "oferta aumentada", que não é a entrega da demanda nova).
// excluirManifestados (opcional, só o lembrete passa) = { interesse, demandaId }: tira do público
// quem já se candidatou / mostrou interesse NESTA demanda (sqlSemManifestacao).
// demanda = { tabela: 'obras' | 'reparos', id }: a demanda anunciada — tira do público a outra
// conta do seu criador (sqlNaoMesmoCpfDoCriador). Todos os chamadores passam; sem ela não filtra.
const broadcastPaginado = async ({ tipoPrestador, cidade, uf, titulo, corpo, data, rotulo, categoria = null, entrega, excluirManifestados = null, demanda = null }) => {
  const total = { elegiveis: 0, invalidos: 0, enviados: 0, falhos: 0, paginas: 0 }
  let cursor = null
  for (;;) {
    // Filtros opcionais entram no SQL E na lista de parâmetros JUNTOS: o pg recusa parâmetro
    // que a consulta não cita ("bind message supplies N parameters, but prepared statement
    // requires N-1"), e era isso que o $7 fixo fazia com o broadcast de demanda nova (sem
    // excluirManifestados o fragmento era '' e o 7º valor sobrava → o claim dava ROLLBACK).
    const params = [tipoPrestador, cidade, uf, cursor, PAGINA_BROADCAST, categoria]
    let filtrosOpcionais = ''
    if (excluirManifestados?.interesse) {
      params.push(excluirManifestados.demandaId)
      filtrosOpcionais += `\n         ${sqlSemManifestacao(excluirManifestados.interesse, `$${params.length}`)}`
    }
    if (demanda) {
      params.push(demanda.id)
      filtrosOpcionais += `\n         AND ${sqlNaoMesmoCpfDoCriador(demanda.tabela, `$${params.length}`)}`
    }
    const pagina = await pool.query(
      `SELECT u.id, u.push_token
       FROM usuarios u
       JOIN assinaturas a ON a.usuario_id = u.id
       WHERE u.role = 'prestador' AND u.tipo_prestador = $1
         AND ${SQL_ASSINATURA_ATIVA}
         AND u.push_token IS NOT NULL
         -- Suspenso por faltas não recebe isca de trabalho novo — mesmo predicado de QUERY do
         -- cron de proximidade (server.js, verificarPrestadoresProximos): quem dispara é o
         -- servidor, não o prestador, então o middleware exigirNaoSuspenso não passa por aqui.
         AND u.suspenso_em IS NULL
         AND NULLIF(btrim(u.cidade), '') IS NOT NULL
         AND NULLIF(btrim(u.uf), '')     IS NOT NULL
         AND ${SQL_CIDADE_PRESTADOR} = $2
         AND upper(btrim(u.uf)) = $3
         AND ($4::uuid IS NULL OR u.id > $4::uuid)
         AND ($6::text IS NULL OR (cardinality(u.especialidades) > 0 AND ($6::text = 'outros' OR $6::text = ANY(u.especialidades))))${filtrosOpcionais}
       ORDER BY u.id
       LIMIT $5`,
      params
    )
    if (pagina.rows.length === 0) break
    total.paginas++
    const resultados = await enviarPushEmLoteDetalhado(pagina.rows, titulo, corpo, data)
    // Grava ANTES de somar/seguir: se o registro falhar, o erro sobe e o claim da demanda
    // dá ROLLBACK — melhor reenviar tudo do que ter enviado sem saber para quem.
    if (entrega) await registrarEntregas(entrega.tipo, entrega.demandaId, resultados)
    const s = contarResultados(resultados)
    total.elegiveis += s.elegiveis; total.invalidos += s.invalidos; total.enviados += s.enviados; total.falhos += s.falhos
    cursor = pagina.rows[pagina.rows.length - 1].id
    if (pagina.rows.length < PAGINA_BROADCAST) break
  }
  console.log(`[Broadcast] ${rotulo} | elegíveis: ${total.elegiveis} | enviados: ${total.enviados} | falhos: ${total.falhos} | tokens inválidos: ${total.invalidos} | páginas: ${total.paginas}`)
  // Envio que não chegou a NINGUÉM apesar de haver alvo (Expo fora do ar, chunk inteiro
  // estourando) é falha, e precisa subir: o chamador (dispararPushNovoComClaim) só carimba
  // push_novo_enviado_em quando esta função volta sem erro — assim a rede de segurança
  // reenvia. Falha PARCIAL não sobe: reenviar duplicaria o aviso para quem já recebeu.
  if (total.elegiveis > 0 && total.enviados === 0 && total.falhos > 0) {
    throw new Error(`broadcast ${rotulo}: nenhum envio concluído (${total.falhos} falha(s) em ${total.elegiveis} elegíveis)`)
  }
  return total
}

// Texto do push "nova obra" / "novo serviço" num só lugar: o broadcast inicial e a
// repescagem por destinatário (reenviarEntregasFalhas) mandam a MESMA mensagem.
// Emoji do título = o da categoria (🎨 / 🔧 de antes só quando a categoria não está no
// mapa); rótulo acentuado no corpo (slug cru no mesmo fallback). obras.categoria pode ser
// NULL (o create não a exige): sem categoria o corpo da obra fica como sempre foi.
const mensagemNovaObra = (obra, obraId) => {
  const { emoji, rotulo } = apresentacaoObra(obra.categoria, '🎨')
  return {
    titulo: `${emoji} Nova obra disponível!`,
    corpo: `"${obra.titulo}" em ${obra.cidade} acabou de ser publicada!${rotulo ? ` Categoria: ${rotulo}.` : ''}`,
    data: { tipo: 'nova_obra', obra_id: obraId },
  }
}
const mensagemNovoReparo = (reparo, reparoId) => {
  const { emoji, rotulo } = apresentacaoReparo(reparo.categoria, '🔧')
  return {
    titulo: `${emoji} Novo serviço disponível!`,
    corpo: `"${reparo.titulo}" em ${reparo.cidade} — categoria: ${rotulo}`,
    data: { tipo: 'novo_reparo', reparo_id: reparoId },
  }
}

const notificarPintoresSobreNovaObra = async (obraId) => {
  try {
    const obraResult = await pool.query(
      `SELECT titulo, cidade, uf, categoria FROM obras WHERE id = $1`,
      [obraId]
    )
    if (obraResult.rows.length === 0) return
    const obra = obraResult.rows[0]

    // Sem cidade OU sem uf na demanda nao ha alvo possivel: antes disto a consulta nao
    // filtrava lugar nenhum e o aviso ia para o pais inteiro. Silencio e o comportamento
    // correto aqui — melhor ninguem do que todos.
    const cidadeObra = normalizar(obra.cidade)
    const ufObra = String(obra.uf || '').trim().toUpperCase()
    if (!cidadeObra || !ufObra) {
      console.log('[Push] Obra sem cidade/uf — nenhum pintor notificado |', obraId)
      return
    }

    // cidade E uf, nunca cidade sozinha: ha municipios homonimos em estados diferentes.
    // Prestador sem cidade ou sem uf fica de FORA (NULLIF ... IS NOT NULL) — sem lugar
    // declarado nao da para afirmar que ele atende ali. Paginado por u.id (A5): todos os
    // pintores assinantes da cidade recebem, em páginas de 500.
    await broadcastPaginado({
      tipoPrestador: 'pintor', cidade: cidadeObra, uf: ufObra,
      ...mensagemNovaObra(obra, obraId),
      rotulo: `nova obra ${obraId}`,
      entrega: { tipo: 'obra', demandaId: obraId },
      demanda: { tabela: 'obras', id: obraId },
    })
  } catch (err) {
    // Loga E propaga: o claim de push_novo_enviado_em (dispararPushNovoComClaim) só grava
    // depois desta função voltar sem erro — engolir aqui carimbaria um aviso que não saiu.
    console.error('Erro ao notificar pintores:', err)
    throw err
  }
}

const notificarPrestadoresSobreNovoReparo = async (reparoId) => {
  try {
    const reparoResult = await pool.query(
      `SELECT titulo, cidade, uf, categoria FROM reparos WHERE id = $1`,
      [reparoId]
    )
    if (reparoResult.rows.length === 0) return
    const reparo = reparoResult.rows[0]

    const cidadeReparo = normalizar(reparo.cidade)
    const ufReparo = String(reparo.uf || '').trim().toUpperCase()
    if (!cidadeReparo || !ufReparo) {
      console.log('[Push] Reparo sem cidade/uf — nenhum prestador notificado |', reparoId)
      return
    }

    // Mesma dobra de cidade+uf da obra. Alem disso ganha o JOIN em assinaturas com
    // status='ativa', que faltava SO aqui: o aviso de trabalho novo ia para quem esta com a
    // assinatura vencida e nem consegue demonstrar interesse depois de abrir o app.
    // tipo_prestador = 'reparador' ESTRITO (D87), o mesmo predicado de exigirReparador: o
    // "IS DISTINCT FROM 'pintor'" antigo incluía NULL/legado, que recebia o push e caía em
    // 403 TIER_INCORRETO ao tocar. Paridade com o broadcast de obra (= 'pintor').
    // Paginado por u.id (A5), mesmo helper do lado obra.
    // categoria: só quem declarou esse serviço em especialidades recebe; 'outros' vai a
    // todo reparador da cidade com ao menos uma especialidade (ver broadcastPaginado).
    // Os DOIS chamadores (POST /reparos/dono e a rota de aprovação) passam por aqui.
    await broadcastPaginado({
      tipoPrestador: 'reparador', cidade: cidadeReparo, uf: ufReparo, categoria: reparo.categoria,
      ...mensagemNovoReparo(reparo, reparoId),
      rotulo: `novo reparo ${reparoId}`,
      entrega: { tipo: 'reparo', demandaId: reparoId },
      demanda: { tabela: 'reparos', id: reparoId },
    })
  } catch (err) {
    // Loga E propaga — mesmo motivo do lado obra (ver notificarPintoresSobreNovaObra).
    console.error('Erro ao notificar prestadores:', err)
    throw err
  }
}

// Push "oferta aumentada" (POST /obras/:id/aumentar-valor e /reparos/:id/aumentar-valor em
// routes/index.js). MESMOS destinatários do push de demanda nova: o mesmo broadcastPaginado,
// com o mesmo tipoPrestador, a mesma dobra cidade+uf e, no lado reparo, o mesmo filtro de
// categoria × especialidades. Emoji e rótulo da categoria saem de apresentacaoObra/Reparo,
// como em mensagemNovaObra/NovoReparo. data.tipo repete o da demanda nova para o app abrir o
// mesmo detalhe; oferta_aumentada: true distingue a origem.
// entrega: null — este aviso NÃO passa por push_entregas: a PK (tipo, demanda_id, usuario_id)
// é a da entrega do push de demanda nova, e gravar por cima reescreveria aquele resultado e
// faria reenviarEntregasFalhas repescar a falha DESTE push com o texto de demanda nova.
const formatarReaisPush = (v) => `R$ ${Number(v).toLocaleString('pt-BR')}`
const mensagemOfertaAumentadaObra = (obra, obraId) => {
  const { emoji, rotulo } = apresentacaoObra(obra.categoria, '🎨')
  return {
    titulo: `${emoji} Oferta aumentada!`,
    corpo: `"${obra.titulo}" em ${obra.cidade} agora paga ${formatarReaisPush(obra.valor)}.${rotulo ? ` Categoria: ${rotulo}.` : ''}`,
    data: { tipo: 'nova_obra', obra_id: obraId, oferta_aumentada: true },
  }
}
const mensagemOfertaAumentadaReparo = (reparo, reparoId) => {
  const { emoji, rotulo } = apresentacaoReparo(reparo.categoria, '🔧')
  return {
    titulo: `${emoji} Oferta aumentada!`,
    corpo: `"${reparo.titulo}" em ${reparo.cidade} agora paga ${formatarReaisPush(reparo.valor_estimado)}.${rotulo ? ` Categoria: ${rotulo}.` : ''}`,
    data: { tipo: 'novo_reparo', reparo_id: reparoId, oferta_aumentada: true },
  }
}

// Devolvem o total do broadcast ({ elegiveis, enviados, falhos, invalidos, paginas }) ou null
// quando não há alvo possível (demanda sumiu, ou sem cidade/uf — mesmo silêncio dos
// notificadores de demanda nova). Erro do broadcast SOBE: o chamador decide o que responder —
// o valor já foi gravado antes do push, então a rota loga e responde 200 com push: { erro }.
const notificarOfertaAumentadaObra = async (obraId) => {
  const r = await pool.query(`SELECT titulo, cidade, uf, categoria, valor FROM obras WHERE id = $1`, [obraId])
  if (r.rows.length === 0) return null
  const obra = r.rows[0]
  const cidade = normalizar(obra.cidade)
  const uf = String(obra.uf || '').trim().toUpperCase()
  if (!cidade || !uf) {
    console.log('[Push] Obra sem cidade/uf — aviso de oferta aumentada não enviado |', obraId)
    return null
  }
  return broadcastPaginado({
    tipoPrestador: 'pintor', cidade, uf,
    ...mensagemOfertaAumentadaObra(obra, obraId),
    rotulo: `oferta aumentada obra ${obraId}`,
    entrega: null,
    demanda: { tabela: 'obras', id: obraId },
  })
}
const notificarOfertaAumentadaReparo = async (reparoId) => {
  const r = await pool.query(`SELECT titulo, cidade, uf, categoria, valor_estimado FROM reparos WHERE id = $1`, [reparoId])
  if (r.rows.length === 0) return null
  const reparo = r.rows[0]
  const cidade = normalizar(reparo.cidade)
  const uf = String(reparo.uf || '').trim().toUpperCase()
  if (!cidade || !uf) {
    console.log('[Push] Reparo sem cidade/uf — aviso de oferta aumentada não enviado |', reparoId)
    return null
  }
  return broadcastPaginado({
    tipoPrestador: 'reparador', cidade, uf, categoria: reparo.categoria,
    ...mensagemOfertaAumentadaReparo(reparo, reparoId),
    rotulo: `oferta aumentada reparo ${reparoId}`,
    entrega: null,
    demanda: { tabela: 'reparos', id: reparoId },
  })
}

// E-mail de RESERVA do aviso "nova obra / novo serviço": vai ao prestador ELEGÍVEL que não tem
// push_token — o mesmo público do broadcast, menos a exigência de token (e mais a de e-mail).
// Consulta SEPARADA da do push (broadcastPaginado continua intocado): os predicados abaixo
// ESPELHAM os de lá (role, tipo_prestador, assinatura ativa, não suspenso, cidade+uf dobrados,
// categoria × especialidades) e mudar um sem o outro deve saltar aos olhos.
//
// Quando roda: SÓ depois do COMMIT do claim (dispararPushNovoComClaim), fire-and-forget, fora de
// qualquer transação, nunca no caminho "oferta aumentada". Erro aqui é apenas logado — jamais
// sobe nem desfaz o carimbo do push.
// Idempotência: INSERT em email_alertas (UNIQUE tipo+demanda+usuário) ANTES do envio; só quem
// o RETURNING devolve recebe. Repetição do caminho (boot, réplica, claim que rodou de novo)
// encontra a linha e não reenvia.
// Teto diário (EMAIL_ALERTAS_TETO_DIA) contado por created_at no dia de São Paulo. A contagem e
// o INSERT são dois statements, então duas réplicas no mesmo instante podem estourar o teto por
// algumas unidades — é rede de segurança contra disparo em massa, não cota exata.
// Um e-mail POR destinatário (nunca vários `to` num envio: exporia os endereços entre si),
// sequencial, erro de um não derruba os demais.
const EMAIL_ALERTAS_TETO_DIA = 250
const EMAIL_ALERTAS_URL_BAIXAR = 'https://protudo.app.br/baixar'
// Página pública da demanda (routes/paginaPublica.js, via redirect do site): o botão principal
// do e-mail aponta para ela quando a linha tem codigo_publico; sem código (linha anterior à
// migração, ou vazio), o botão volta a ser o de sempre ("Ver no app", página /baixar).
const EMAIL_ALERTAS_URL_PAGINA_PUBLICA = 'https://protudo.app.br/p/'
const RE_CODIGO_PUBLICO = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/
const botaoEmailDemanda = (codigoPublico) => {
  const codigo = String(codigoPublico || '').trim().toUpperCase()
  if (RE_CODIGO_PUBLICO.test(codigo)) return { url: `${EMAIL_ALERTAS_URL_PAGINA_PUBLICA}${codigo}`, texto: 'Ver o pedido' }
  return { url: EMAIL_ALERTAS_URL_BAIXAR, texto: `Ver no app ${MARCA}` }
}
// colunaValor: lida como `valor` no SELECT da demanda — mensagemNovaObra/NovoReparo a ignoram;
// o lembrete "ainda aberto" (lembrarDemandasSemResposta) a mostra no corpo.
const LADOS_EMAIL = {
  obras:   { tipo: 'obra',   tipoPrestador: 'pintor',    comCategoria: false, mensagem: mensagemNovaObra,   aba: 'Obras',    colunaValor: 'valor' },
  reparos: { tipo: 'reparo', tipoPrestador: 'reparador', comCategoria: true,  mensagem: mensagemNovoReparo, aba: 'Serviços', colunaValor: 'valor_estimado' },
}
const escaparHtml = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
const htmlEmailNovaDemanda = ({ nome, titulo, corpo, aba, botao = botaoEmailDemanda(null) }) => `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: #0a0a0a; margin: 0;">${MARCA}</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
          <h2>Olá, ${escaparHtml(nome)}!</h2>
          <p><strong>${escaparHtml(titulo)}</strong></p>
          <p>${escaparHtml(corpo)}</p>
          <p style="text-align: center; margin: 30px 0;">
            <a href="${botao.url}" style="background: #E8833A; color: #000; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">${escaparHtml(botao.texto)}</a>
          </p>
          <p>O pedido está na aba ${aba}</p>
          <p style="color: #666; font-size: 13px;">Ative as notificações do app ProTudo para receber pedidos na hora</p>
        </div>
      </div>
    `

// Assunto + HTML de UM e-mail, exatamente como o envio de produção monta: assunto = título do
// push, corpo = texto do push, primeiro nome do destinatário. Exportada para o teste de
// renderização poder mandar a mesma coisa que a produção mandaria.
// lado (opcional): o lembrete "ainda aberto" passa o seu, com outro tipo e outra mensagem;
// sem ele, o lado de demanda nova de sempre.
const montarEmailNovaDemanda = (tabela, demanda, demandaId, nome, lado = LADOS_EMAIL[tabela]) => {
  const { titulo, corpo } = lado.mensagem(demanda, demandaId)
  return {
    assunto: titulo,
    html: htmlEmailNovaDemanda({ nome: nome?.split(' ')[0] || 'profissional', titulo, corpo, aba: lado.aba, botao: botaoEmailDemanda(demanda.codigo_publico) }),
  }
}

// Um envio ao Brevo não pode prender a fila: 10 s e o destinatário vira 'falha' (só log).
const EMAIL_ALERTAS_TIMEOUT_MS = 10000
const comTimeout = (promessa, ms, rotulo) => {
  let timer
  const estouro = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${rotulo}: timeout após ${ms} ms`)), ms) })
  return Promise.race([promessa, estouro]).finally(() => clearTimeout(timer))
}

// Fase 1 (banco): elegíveis + teto + claim, num client DEDICADO que é devolvido ao pool no
// finally — ANTES de qualquer chamada ao Brevo. Devolve o que a fase 2 precisa, ou null.
const reivindicarEmailsNovaDemanda = async (tabela, demandaId, lado) => {
  const client = await pool.connect()
  try {
    // `interessados` só no lembrete (lado.interesse): é o que escolhe o texto do corpo.
    const dem = await client.query(
      `SELECT d.titulo, d.cidade, d.uf, d.categoria, d.${lado.colunaValor} AS valor, d.codigo_publico
              ${lado.interesse ? `, (SELECT count(*)::int FROM ${lado.interesse.tabela} x WHERE x.${lado.interesse.coluna} = d.id) AS interessados` : ''}
         FROM ${tabela} d WHERE d.id = $1`, [demandaId])
    if (dem.rows.length === 0) return null
    const demanda = dem.rows[0]
    const cidade = normalizar(demanda.cidade)
    const uf = String(demanda.uf || '').trim().toUpperCase()
    if (!cidade || !uf) return null // mesmo silêncio do push: sem lugar não há alvo
    const categoria = lado.comCategoria ? demanda.categoria : null

    // Elegíveis SEM token (espelho de broadcastPaginado, trocando push_token IS NOT NULL por
    // IS NULL e exigindo e-mail). Ordem por u.id como lá, para o teto cortar de forma estável.
    const elegiveis = await client.query(
      `SELECT u.id, u.nome, u.email
       FROM usuarios u
       JOIN assinaturas a ON a.usuario_id = u.id
       WHERE u.role = 'prestador' AND u.tipo_prestador = $1
         AND ${SQL_ASSINATURA_ATIVA}
         AND u.push_token IS NULL
         AND NULLIF(btrim(u.email), '') IS NOT NULL
         AND u.suspenso_em IS NULL
         AND NULLIF(btrim(u.cidade), '') IS NOT NULL
         AND NULLIF(btrim(u.uf), '')     IS NOT NULL
         AND ${SQL_CIDADE_PRESTADOR} = $2
         AND upper(btrim(u.uf)) = $3
         AND ($4::text IS NULL OR (cardinality(u.especialidades) > 0 AND ($4::text = 'outros' OR $4::text = ANY(u.especialidades))))
         ${sqlSemManifestacao(lado.interesse, '$5')}
         AND ${sqlNaoMesmoCpfDoCriador(tabela, '$5')}
       ORDER BY u.id`,
      [lado.tipoPrestador, cidade, uf, categoria, demandaId]
    )
    if (elegiveis.rows.length === 0) return null

    const hoje = await client.query(
      `SELECT count(*)::int AS n FROM email_alertas
        WHERE created_at >= (date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`
    )
    const restante = EMAIL_ALERTAS_TETO_DIA - hoje.rows[0].n
    if (restante <= 0) {
      console.warn(`[EmailAlerta] ${lado.tipo} ${demandaId}: teto diário de ${EMAIL_ALERTAS_TETO_DIA} e-mails atingido — ${elegiveis.rows.length} elegível(is) sem aviso`)
      return null
    }
    const candidatos = elegiveis.rows.slice(0, restante)

    // Claim por destinatário ANTES de enviar: só quem entrou agora recebe.
    const claim = await client.query(
      `INSERT INTO email_alertas (tipo, demanda_id, usuario_id)
       SELECT $1, $2, x FROM unnest($3::uuid[]) AS x
       ON CONFLICT (tipo, demanda_id, usuario_id) DO NOTHING
       RETURNING usuario_id`,
      [lado.tipo, demandaId, candidatos.map(c => c.id)]
    )
    const reivindicados = new Set(claim.rows.map(r => r.usuario_id))
    const destinatarios = candidatos.filter(c => reivindicados.has(c.id))
    return { demanda, destinatarios, elegiveis: elegiveis.rows.length, cortados: elegiveis.rows.length - candidatos.length }
  } finally {
    client.release()
  }
}

// ladoOverride (opcional): o lembrete "ainda aberto" passa { tipo, mensagem, interesse } próprios
// por cima do lado da tabela — mesmo público (sem token) MENOS quem já se manifestou na demanda,
// mesmo claim em email_alertas (com o tipo dele), mesmo teto diário, mesmo HTML. Sem override:
// demanda nova, como sempre.
const enviarEmailsNovaDemanda = async (tabela, demandaId, ladoOverride = null) => {
  const lado = LADOS_EMAIL[tabela] ? { ...LADOS_EMAIL[tabela], ...(ladoOverride || {}) } : null
  if (!lado) return
  try {
    const fase1 = await reivindicarEmailsNovaDemanda(tabela, demandaId, lado)
    if (!fase1 || fase1.destinatarios.length === 0) return
    // Daqui em diante NENHUM client do pool está preso: só Brevo, um envio por vez.
    let enviados = 0, falhos = 0
    for (const d of fase1.destinatarios) {
      try {
        const { assunto, html } = montarEmailNovaDemanda(tabela, fase1.demanda, demandaId, d.nome, lado)
        await comTimeout(enviarEmailBrevo({ para: d.email, assunto, html }), EMAIL_ALERTAS_TIMEOUT_MS, 'Brevo')
        enviados++
      } catch (err) {
        falhos++
        console.error(`[EmailAlerta] falha ao enviar | ${lado.tipo} ${demandaId} | usuário ${d.id}:`, err.message)
      }
    }
    console.log(`[EmailAlerta] ${lado.tipo} ${demandaId} | elegíveis sem token: ${fase1.elegiveis} | enviados: ${enviados} | falhos: ${falhos} | cortados pelo teto: ${fase1.cortados}`)
  } catch (err) {
    console.error(`[EmailAlerta] erro em ${tabela} ${demandaId}:`, err.message)
  }
}

// Lembretes "ainda aberto" — demanda aberta, aprovada, SEM MATCH e não expirada recebe avisos
// repetidos até fechar com alguém (match_usuario_id) ou expirar — ter interesses/candidaturas
// NÃO a tira da cadência. Público = os MESMOS elegíveis do broadcast de demanda nova (mesmo
// broadcastPaginado: tipoPrestador, cidade+uf dobrados, categoria × especialidades no lado
// reparo) MENOS quem já se manifestou nesta demanda (sqlSemManifestacao: candidaturas /
// interesse_reparos, qualquer status — push e e-mail). Mesmo data.tipo/id para o toque abrir o
// mesmo detalhe (lembrete: true distingue a origem, como oferta_aumentada), e o mesmo e-mail de
// reserva a quem não tem token (enviarEmailsNovaDemanda com tipo próprio).
// Corpo pelo nº de manifestações (`interessados`, contado no claim e de novo no e-mail):
//   0  → "Ninguém respondeu ainda, chegue primeiro!"
//   1+ → "Ainda sem profissional definido — mande sua proposta!"
// A faixa da página pública (routes/paginaPublica.js) NÃO segue esta regra: continua só com zero.
//
// CADÊNCIA pela janela original W da demanda (horas_para_expirar / prazo_atendimento_horas;
// se NULL, expira_em − âncora), contada desde a MESMA âncora de publicação de sempre (obras
// COALESCE(publicado_em, criado_em), reparos criado_em — convenção de enviarPushNovoPendente):
//   W ≤ 24h          fase 'unica'   → UM lembrete em W/2 (1h→30min … 24h→12h), a qualquer hora.
//   24h < W ≤ 168h   fase 'diaria'  → um por dia: fatias de 24h desde a âncora (k = 1, 2, …).
//   W > 168h         fase 'semanal' → um por semana (fatias de 7 dias desde a âncora) enquanto
//                    faltam MAIS de 7 dias para expira_em; depois fase 'final' → um por dia nos
//                    últimos 7 dias (fatias de 24h contadas de trás, a partir de expira_em).
// Fases diárias/semanais só entre LEMBRETE_HORA_INICIO e LEMBRETE_HORA_FIM (São Paulo): fora
// da janela o claim não acontece e a fatia espera o próximo tique dentro dela (a fatia é
// "devida" enquanto durar, então ninguém perde a vez — só adia). Entre dois lembretes dessas
// fases vale ainda um intervalo mínimo (LEMBRETE_GAP_MIN_HORAS): cobre a virada semanal→final e
// a fatia adiada pela janela, sem permitir dois avisos no mesmo dia.
//
// CLAIM atômico por FATIA (mesmo desenho dos crons de 5 min): o UPDATE grava
// lembrete_enviado_em = NOW() e lembretes_enviados + 1 e devolve via RETURNING só as linhas que
// ELE reivindicou. "Fatia devida" = NOW() ≥ início da fatia atual E o último lembrete é anterior
// a esse início — duas réplicas/tiques não repetem a mesma fatia (o WHERE é reavaliado sobre a
// linha atual quando há concorrência). Claim ANTES do envio e nunca desfeito: falha de envio
// fica no log; a demanda espera a próxima fatia.
// push_novo_enviado_em IS NOT NULL: lembrar antes do aviso original (tera_midias pendente)
// seria anunciar duas vezes na ordem errada — a rede de segurança ainda vai mandar o primeiro.
// entrega: null — NUNCA passa por push_entregas (mesma razão do push "oferta aumentada": a
// PK é a da entrega do aviso de demanda nova e a repescagem reenviaria com o texto errado).
// E-mail: tipo em email_alertas leva o número do lembrete (lembrete_reparo#2) — o UNIQUE
// (tipo, demanda, usuário) é por fatia, então o 2º+ lembrete não fica bloqueado pelo 1º.
const LEMBRETE_HORA_INICIO = 8
const LEMBRETE_HORA_FIM = 20
const LEMBRETE_GAP_MIN_HORAS = 20
const LEMBRETE_UNICA_MAX_HORAS = 24
const LEMBRETE_DIARIA_MAX_HORAS = 168
const SQL_JANELA_LEMBRETE = `EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')) >= ${LEMBRETE_HORA_INICIO}
    AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')) < ${LEMBRETE_HORA_FIM}`
const valorLembrete = (v) => (Number(v) > 0 ? formatarReaisPush(v) : 'Valor a combinar')
// Fecho do corpo pelo nº de manifestações da demanda (ver cabeçalho). `interessados` ausente
// (NULL/undefined) conta como zero.
const CHAMADA_LEMBRETE_SEM_RESPOSTA = 'Ninguém respondeu ainda, chegue primeiro!'
const CHAMADA_LEMBRETE_COM_INTERESSE = 'Ainda sem profissional definido — mande sua proposta!'
const chamadaLembrete = (d) => (Number(d.interessados) > 0 ? CHAMADA_LEMBRETE_COM_INTERESSE : CHAMADA_LEMBRETE_SEM_RESPOSTA)
const mensagemLembreteObra = (obra, obraId) => {
  const { rotulo } = apresentacaoObra(obra.categoria, '🎨')
  return {
    titulo: `🔔 Ainda aberto: ${obra.titulo}`,
    corpo: `${rotulo || 'Obra'} · ${valorLembrete(obra.valor)} · ${chamadaLembrete(obra)}`,
    data: { tipo: 'nova_obra', obra_id: obraId, lembrete: true },
  }
}
const mensagemLembreteReparo = (reparo, reparoId) => {
  const { rotulo } = apresentacaoReparo(reparo.categoria, '🔧')
  return {
    titulo: `🔔 Ainda aberto: ${reparo.titulo}`,
    corpo: `${rotulo || 'Serviço'} · ${valorLembrete(reparo.valor)} · ${chamadaLembrete(reparo)}`,
    data: { tipo: 'novo_reparo', reparo_id: reparoId, lembrete: true },
  }
}
// interesse = { tabela, coluna }: onde o prestador se manifesta nesta demanda. Conta os
// `interessados` (texto do corpo) e exclui do público quem já está lá (sqlSemManifestacao).
const LADOS_LEMBRETE = [
  { tabela: 'obras',   tipoEmail: 'lembrete_obra',   tipoPrestador: 'pintor',    comCategoria: false, colunaValor: 'valor',
    ancora: 'COALESCE(d.publicado_em, d.criado_em)', janelaCol: 'horas_para_expirar',
    interesse: { tabela: 'candidaturas', coluna: 'obra_id' },
    mensagem: mensagemLembreteObra },
  { tabela: 'reparos', tipoEmail: 'lembrete_reparo', tipoPrestador: 'reparador', comCategoria: true,  colunaValor: 'valor_estimado',
    ancora: 'd.criado_em', janelaCol: 'prazo_atendimento_horas',
    interesse: { tabela: 'interesse_reparos', coluna: 'reparo_id' },
    mensagem: mensagemLembreteReparo },
]
const sqlInteressados = (lado) => `(SELECT count(*)::int FROM ${lado.interesse.tabela} x WHERE x.${lado.interesse.coluna} = d.id)`
// Predicado da demanda ELEGÍVEL (estado), sem a parte de tempo — compartilhado pelo claim
// (UPDATE) e pela prévia sem efeito (listarCandidatosLembrete). `d` é o alias da tabela.
// Interesses NÃO entram aqui: a cadência só para no match (match_usuario_id) ou na expiração.
const predicadoLembrete = (lado) => `
      d.status = 'aberta' AND d.status_aprovacao = 'aprovada'
      AND d.match_usuario_id IS NULL AND d.expira_em > NOW()
      AND d.push_novo_enviado_em IS NOT NULL`
// Janela W em horas (NUMERIC): a coluna da demanda ou, se NULL, expira_em − âncora.
const sqlJanelaHoras = (lado) => `COALESCE(d.${lado.janelaCol}, EXTRACT(EPOCH FROM (d.expira_em - ${lado.ancora})) / 3600.0)`
const sqlFaseLembrete = (lado) => `CASE
      WHEN ${sqlJanelaHoras(lado)} <= ${LEMBRETE_UNICA_MAX_HORAS}  THEN 'unica'
      WHEN ${sqlJanelaHoras(lado)} <= ${LEMBRETE_DIARIA_MAX_HORAS} THEN 'diaria'
      WHEN d.expira_em - NOW() > INTERVAL '7 days'                  THEN 'semanal'
      ELSE 'final' END`
// Início da FATIA ATUAL de cada fase (a fatia k=0 é a própria publicação e nunca é devida).
const sqlInicioFatia = (lado) => `CASE ${sqlFaseLembrete(lado)}
      WHEN 'unica'   THEN ${lado.ancora} + (${sqlJanelaHoras(lado)} / 2) * INTERVAL '1 hour'
      WHEN 'diaria'  THEN ${lado.ancora} + floor(EXTRACT(EPOCH FROM (NOW() - ${lado.ancora})) / 86400) * INTERVAL '1 day'
      WHEN 'semanal' THEN ${lado.ancora} + floor(EXTRACT(EPOCH FROM (NOW() - ${lado.ancora})) / 604800) * INTERVAL '7 days'
      ELSE d.expira_em - (floor(EXTRACT(EPOCH FROM (d.expira_em - NOW())) / 86400) + 1) * INTERVAL '1 day' END`
// Subconsulta `s`: elegíveis + fase + início da fatia, calculados UMA vez por linha. O UPDATE e a
// prévia leem daqui, então claim e dry-run nunca divergem.
const sqlCalculoLembrete = (lado) => `
      SELECT d.id, ${sqlFaseLembrete(lado)} AS fase, ${sqlInicioFatia(lado)} AS inicio_fatia,
             ${sqlJanelaHoras(lado)} AS janela_horas, ${lado.ancora} AS ancora
        FROM ${lado.tabela} d WHERE ${predicadoLembrete(lado)}`
// Fatia DEVIDA agora (d = linha atual da tabela, s = cálculo acima). O teste sobre
// d.lembrete_enviado_em é o que torna o claim idempotente entre réplicas/tiques.
const sqlFatiaDevida = (lado) => `
      NOW() >= s.inicio_fatia AND s.inicio_fatia > ${lado.ancora}
      AND (d.lembrete_enviado_em IS NULL OR d.lembrete_enviado_em < s.inicio_fatia)
      AND (s.fase <> 'unica' OR d.lembretes_enviados = 0)
      AND (s.fase = 'unica' OR (${SQL_JANELA_LEMBRETE}
           AND (d.lembrete_enviado_em IS NULL OR d.lembrete_enviado_em < NOW() - (${LEMBRETE_GAP_MIN_HORAS} * INTERVAL '1 hour'))))`
const COLUNAS_LEMBRETE = (lado) => `d.id, d.titulo, d.cidade, d.uf, d.categoria, d.${lado.colunaValor} AS valor, d.lembretes_enviados, ${sqlInteressados(lado)} AS interessados`
// O claim em si (UPDATE … RETURNING). Exportado só para o dry-run executar o MESMO statement
// dentro de um BEGIN…ROLLBACK; o cron (lembrarDemandasSemResposta) é o único chamador real.
const sqlClaimLembrete = (lado) => `
      UPDATE ${lado.tabela} d
         SET lembrete_enviado_em = NOW(), lembretes_enviados = d.lembretes_enviados + 1
        FROM (${sqlCalculoLembrete(lado)}) s
       WHERE d.id = s.id AND ${sqlFatiaDevida(lado)}
   RETURNING ${COLUNAS_LEMBRETE(lado)}, s.fase`

// Próximo lembrete previsto (só para prévia/admin; o claim não usa isto). Reproduz a regra em
// JS a partir do que a subconsulta devolveu: fatia devida → agora; senão início da próxima fatia
// (ou da fase 'final', se vier antes), adiada para a janela 08–20h SP e para o gap mínimo.
// SP não tem horário de verão desde 2019: deslocamento fixo de −3h.
const MS_H = 3600 * 1000, MS_D = 24 * MS_H, SP_OFFSET_MS = -3 * MS_H
const adiarParaJanela = (t) => {
  const sp = new Date(t.getTime() + SP_OFFSET_MS)
  const h = sp.getUTCHours()
  if (h >= LEMBRETE_HORA_INICIO && h < LEMBRETE_HORA_FIM) return t
  const dia = Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate()) + (h >= LEMBRETE_HORA_FIM ? MS_D : 0)
  return new Date(dia + LEMBRETE_HORA_INICIO * MS_H - SP_OFFSET_MS)
}
const proximoLembrete = ({ fase, inicio_fatia, ancora, expira_em, lembrete_enviado_em, lembretes_enviados, devida_agora, agora }) => {
  if (devida_agora) return agora
  const inicio = new Date(inicio_fatia), exp = new Date(expira_em), ult = lembrete_enviado_em ? new Date(lembrete_enviado_em) : null
  if (fase === 'unica') return (Number(lembretes_enviados) > 0 || ult) ? null : (inicio > agora ? inicio : null)
  const jaEnviadaNestaFatia = ult && ult >= inicio
  let prox
  if (!jaEnviadaNestaFatia && inicio > new Date(ancora)) prox = inicio < agora ? agora : inicio
  else if (fase === 'diaria' || fase === 'final') prox = new Date(inicio.getTime() + MS_D)
  else prox = new Date(Math.min(inicio.getTime() + 7 * MS_D, exp.getTime() - 7 * MS_D))
  if (fase === 'semanal' && prox > new Date(exp.getTime() - 7 * MS_D)) prox = new Date(exp.getTime() - 7 * MS_D)
  if (ult) prox = new Date(Math.max(prox.getTime(), ult.getTime() + LEMBRETE_GAP_MIN_HORAS * MS_H))
  prox = adiarParaJanela(prox)
  return prox < exp ? prox : null
}

// Prévia SEM efeito (dry-run / admin): toda demanda elegível por estado, com fase, janela W,
// se a fatia está devida AGORA e o próximo lembrete previsto. Devolve { tabela, demandas }
// por lado. db (opcional): client/transação do chamador — o dry-run roda num BEGIN…ROLLBACK.
const listarCandidatosLembrete = async (db = pool) => {
  const saida = []
  for (const lado of LADOS_LEMBRETE) {
    const r = await db.query(
      `SELECT ${COLUNAS_LEMBRETE(lado)}, d.lembrete_enviado_em, d.expira_em, s.fase, s.inicio_fatia, s.janela_horas, s.ancora,
              (${sqlFatiaDevida(lado)}) AS devida_agora, NOW() AS agora
         FROM ${lado.tabela} d JOIN (${sqlCalculoLembrete(lado)}) s ON s.id = d.id
        ORDER BY s.ancora`
    )
    saida.push({ tabela: lado.tabela, demandas: r.rows.map(d => ({ ...d, proximo: proximoLembrete(d) })) })
  }
  return saida
}

// O cron em si (lembrarDemandasSemResposta) fica mais abaixo, DEPOIS de semSobreposicao:
// const em TDZ derrubaria o boot (mesma lição do broadcastPaginado, 25/08).

// Push para o DONO com o desfecho da análise da obra (a obra é a única vertical que passa
// por aprovação; reparo publica direto). Segue o padrão já usado no aviso de novo candidato
// (SELECT juntando usuarios pelo criado_por — ver /candidaturas em routes/index.js).
// Sem push_token cadastrado simplesmente não há o que enviar — não é erro.
// Quem chama SEMPRE dispara fire-and-forget e só na TRANSIÇÃO de status: o painel do admin
// não pode esperar nem falhar por causa de uma notificação, e reprocessar não pode reavisar.
// Vive aqui (e não em routes/index.js) porque a aprovação AUTOMÁTICA adia este aviso: quem
// o dispara nesse caminho é o claim de push_aprovada_enviado_em em enviarPushNovoPendente.
const notificarDonoSobreAnaliseObra = async (obraId, aprovada) => {
  const info = await pool.query(
    `SELECT u.push_token, o.titulo FROM obras o JOIN usuarios u ON o.criado_por = u.id WHERE o.id = $1`,
    [obraId]
  )
  const { push_token, titulo } = info.rows[0] || {}
  if (!push_token) return
  await enviarPushNotificacao(
    push_token,
    aprovada ? '✅ Obra aprovada!' : '❌ Obra não aprovada',
    aprovada
      ? `"${titulo}" já está publicada e visível para os pintores.`
      : `"${titulo}" não foi publicada desta vez. Toque para rever os detalhes e cadastrar novamente.`,
    { tipo: aprovada ? 'obra_aprovada' : 'obra_recusada', obra_id: obraId }
  )
}

// Claim do push "nova obra / novo serviço disponível" — ÚNICO caminho que grava
// push_novo_enviado_em fora do backfill de migração. A ordem é send-then-stamp: a coluna só
// recebe NOW() DEPOIS de notificar() voltar sem erro. Antes o UPDATE vinha primeiro e uma
// falha no envio (Expo fora do ar, banco indisponível no meio) deixava a linha carimbada
// sem ninguém avisado — e a rede de segurança abaixo, que só olha NULL, nunca a repescava.
// Atomicidade: a transação prende a linha com FOR UPDATE SKIP LOCKED enquanto envia. A
// chamada concorrente (outra réplica, retry do app, midias-prontas × aprovação) não obtém a
// linha, devolve false e não envia; quem chega depois do COMMIT vê a coluna preenchida e
// também não envia. Falha em notificar() → ROLLBACK: a coluna segue NULL e
// enviarPushNovoPendente reenvia a partir de JANELA_PUSH_NOVO_MIN da publicação.
// criadoPor / exigirPublicada reproduzem os predicados extras que cada rota já punha no
// UPDATE antigo (midias-prontas: linha do próprio dono, e status aberta + aprovada); as
// rotas de aprovação e o create de reparo não os passam, como antes.
// Devolve true quando ESTA chamada enviou e carimbou; false quando não havia o que
// reivindicar. Erro de notificar() SOBE para o chamador — aqui nunca é engolido.
const dispararPushNovoComClaim = async (tabela, id, notificar, { criadoPor = null, exigirPublicada = false } = {}) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const lock = await client.query(
      `SELECT id FROM ${tabela}
        WHERE id = $1 AND push_novo_enviado_em IS NULL
          AND ($2::uuid IS NULL OR criado_por = $2::uuid)
          AND (NOT $3::boolean OR (status = 'aberta' AND status_aprovacao = 'aprovada'))
        FOR UPDATE SKIP LOCKED`,
      [id, criadoPor, exigirPublicada]
    )
    if (lock.rowCount === 0) {
      await client.query('ROLLBACK')
      return false
    }
    await notificar(id)
    await client.query(`UPDATE ${tabela} SET push_novo_enviado_em = NOW() WHERE id = $1`, [id])
    await client.query('COMMIT')
    // E-mail de reserva a quem não tem token: só DEPOIS do COMMIT, fire-and-forget, com o pool
    // (nunca este client). Falha ali é só log — o carimbo acima já está gravado e fica.
    enviarEmailsNovaDemanda(tabela, id).catch(err =>
      console.error(`[EmailAlerta] erro inesperado em ${tabela} ${id}:`, err.message))
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// Rede de segurança do push "nova obra / novo serviço disponível". O app avisa via
// POST /:id/midias-prontas quando o último upload termina; se ele nunca chamar (upload
// falhou, tela abandonada, app antigo que mandou tera_midias=true), a demanda ficaria
// publicada sem ninguém avisado. Roda dentro de verificarMarcosExpiracao (a cada
// INTERVALO_CRONOMETRO = 60 s, e no boot) — nenhum agendador novo.
// Mesmo claim das rotas (dispararPushNovoComClaim), uma linha por vez: o SELECT abaixo só
// lista candidatas; quem decide e carimba — depois do envio — é o helper, sob lock de linha.
// Também é ela que repesca o envio que falhou numa rota: a linha voltou a NULL no ROLLBACK.
// Só o limite inferior (10 min): sem teto, uma demanda que ficou sem aviso porque o servidor
// esteve fora por horas ainda é anunciada quando ele volta. As demandas anteriores à coluna
// não entram porque a migração as marcou de uma vez (backfill único em migracaoPronta).
// Âncora: obras têm publicado_em (a aprovação publica); reparos publicam na criação e não
// têm essa coluna — criado_em é a âncora deles (mesma convenção do estender).
const JANELA_PUSH_NOVO_MIN = 10
// Atraso do push "obra aprovada" ao dono na aprovação AUTOMÁTICA (segundo claim abaixo).
const ATRASO_PUSH_APROVADA_MIN = 5

// Repescagem POR DESTINATÁRIO (push_entregas): quem ficou 'falha' numa demanda já carimbada
// (push_novo_enviado_em NOT NULL — o claim por demanda segue como está) recebe nova tentativa,
// até MAX_TENTATIVAS_ENTREGA no total, com ao menos JANELA_PUSH_NOVO_MIN entre tentativas
// para uma queda do Expo não queimar as três em três tiques de 60 s. Demanda com push_novo_
// enviado_em NULL NÃO entra aqui: ela ainda vai pelo broadcast completo do bloco abaixo.
//
// Fim garantido: cada linha processada vira 'enviado', 'invalido' (token sumiu/não-Expo) ou
// 'falha' com tentativas + 1 — e o predicado EXISTS só olha 'falha' com tentativas < 3, então
// uma demanda cujas falhas restantes já esgotaram o teto sai do sweep por conta própria.
// Só token e id são relidos de usuarios: a elegibilidade (cidade, assinatura, especialidade)
// foi decidida no broadcast original, cuja consulta continua intocada. Exceção: a outra conta do
// criador (mesmo CPF) não é repescada — nas DUAS consultas, para uma linha 'falha' dela não manter
// a demanda no sweep a cada tique. A linha em push_entregas fica como está (histórico intocado).
const MAX_TENTATIVAS_ENTREGA = 3
const LADOS_ENTREGA = [
  { tipo: 'obra',   tabela: 'obras',   colunas: 'titulo, cidade, uf, categoria', mensagem: mensagemNovaObra },
  { tipo: 'reparo', tabela: 'reparos', colunas: 'titulo, cidade, uf, categoria', mensagem: mensagemNovoReparo },
]
const reenviarEntregasFalhas = async () => {
  for (const lado of LADOS_ENTREGA) {
    try {
      const candidatas = await pool.query(
        `SELECT d.id, ${lado.colunas} FROM ${lado.tabela} d
          WHERE d.push_novo_enviado_em IS NOT NULL
            AND d.status = 'aberta' AND d.status_aprovacao = 'aprovada' AND d.expira_em > NOW()
            AND EXISTS (
              SELECT 1 FROM push_entregas pe
               WHERE pe.tipo = $1 AND pe.demanda_id = d.id
                 AND pe.resultado = 'falha' AND pe.tentativas < $2
                 AND pe.ultima_tentativa_em <= NOW() - ($3::int * INTERVAL '1 minute')
                 AND ${sqlNaoMesmoCpf('d.criado_por', 'pe.usuario_id')}
            )
          ORDER BY d.criado_em
          LIMIT 50`,
        [lado.tipo, MAX_TENTATIVAS_ENTREGA, JANELA_PUSH_NOVO_MIN]
      )
      for (const d of candidatas.rows) {
        try {
          const alvos = await pool.query(
            `SELECT u.id, u.push_token
               FROM push_entregas pe
               JOIN usuarios u ON u.id = pe.usuario_id
              WHERE pe.tipo = $1 AND pe.demanda_id = $2
                AND pe.resultado = 'falha' AND pe.tentativas < $3
                AND pe.ultima_tentativa_em <= NOW() - ($4::int * INTERVAL '1 minute')
                AND ${sqlNaoMesmoCpfDoCriador(lado.tabela, '$2')}
              ORDER BY u.id`,
            [lado.tipo, d.id, MAX_TENTATIVAS_ENTREGA, JANELA_PUSH_NOVO_MIN]
          )
          if (alvos.rows.length === 0) continue
          const { titulo, corpo, data } = lado.mensagem(d, d.id)
          // Token null/não-Expo volta como 'invalido' do próprio lote — terminal, sai do sweep.
          const resultados = await enviarPushEmLoteDetalhado(alvos.rows, titulo, corpo, data)
          await registrarEntregas(lado.tipo, d.id, resultados)
          const s = contarResultados(resultados)
          console.log(`[PushEntregas] repescagem ${lado.tipo} ${d.id} | alvos: ${s.elegiveis} | enviados: ${s.enviados} | falhos: ${s.falhos} | inválidos: ${s.invalidos}`)
        } catch (err) {
          // Uma demanda não derruba as demais; a linha segue 'falha' e volta no próximo tique.
          console.error(`[PushEntregas] repescagem ${lado.tipo} ${d.id} falhou:`, err.message)
        }
      }
    } catch (err) {
      console.error(`[PushEntregas] erro em ${lado.tabela}:`, err.message)
    }
  }
}

const enviarPushNovoPendente = async () => {
  const lados = [
    { tabela: 'obras',   ancora: 'COALESCE(publicado_em, criado_em)', notificar: notificarPintoresSobreNovaObra },
    { tabela: 'reparos', ancora: 'criado_em',                         notificar: notificarPrestadoresSobreNovoReparo },
  ]
  for (const lado of lados) {
    try {
      const pendentes = await pool.query(
        `SELECT id FROM ${lado.tabela}
          WHERE push_novo_enviado_em IS NULL
            AND status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()
            AND ${lado.ancora} <= NOW() - ($1::int * INTERVAL '1 minute')
          ORDER BY ${lado.ancora}`,
        [JANELA_PUSH_NOVO_MIN]
      )
      if (pendentes.rowCount === 0) continue
      console.log(`[PushNovoPendente] ${lado.tabela}: ${pendentes.rowCount} demanda(s) publicada(s) há mais de ${JANELA_PUSH_NOVO_MIN} min sem aviso — disparando`)
      for (const r of pendentes.rows) {
        // Uma falha não derruba as demais candidatas do tique: loga e segue. A linha que
        // falhou continua NULL (ROLLBACK no helper) e volta a ser candidata no próximo tique.
        try {
          await dispararPushNovoComClaim(lado.tabela, r.id, lado.notificar, { exigirPublicada: true })
        } catch (err) {
          console.error(`[PushNovoPendente] ${lado.tabela} ${r.id}: envio falhou, segue sem carimbo para nova tentativa:`, err.message)
        }
      }
    } catch (err) {
      console.error(`[PushNovoPendente] erro em ${lado.tabela}:`, err.message)
    }
  }

  // Depois do broadcast completo das demandas sem carimbo: repescagem por destinatário das
  // já carimbadas (push_entregas). Próprio try/catch dentro; nunca derruba o bloco seguinte.
  await reenviarEntregasFalhas()

  // Push "obra aprovada" ao DONO, adiado 5 min na aprovação AUTOMÁTICA. aprovarEPublicarObra
  // (routes/index.js) deixa push_aprovada_enviado_em NULL nesse caminho; na aprovação manual
  // carimba NOW() no próprio UPDATE e avisa inline, então nunca cai aqui. Mesmo claim atômico
  // do bloco acima: só as linhas devolvidas no RETURNING recebem push, uma vez cada. Âncora
  // COALESCE(publicado_em, criado_em) — a aprovação é o que publica. Sem teto de tempo, pelo
  // mesmo motivo do claim acima; as obras anteriores à coluna foram marcadas pelo backfill.
  try {
    const claim = await pool.query(
      `UPDATE obras SET push_aprovada_enviado_em = NOW()
        WHERE push_aprovada_enviado_em IS NULL
          AND status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()
          AND COALESCE(publicado_em, criado_em) <= NOW() - ($1::int * INTERVAL '1 minute')
        RETURNING id`,
      [ATRASO_PUSH_APROVADA_MIN]
    )
    if (claim.rowCount > 0) {
      console.log(`[PushNovoPendente] obras: ${claim.rowCount} aprovada(s) automaticamente há mais de ${ATRASO_PUSH_APROVADA_MIN} min sem aviso ao dono — disparando`)
      for (const r of claim.rows) await notificarDonoSobreAnaliseObra(r.id, true)
    }
  } catch (err) {
    console.error('[PushNovoPendente] erro no push "obra aprovada" ao dono:', err.message)
  }
}

const verificarObrasExpirando = async () => {
  try {
    const obras = await pool.query(`
      SELECT o.id, o.titulo, u.push_token
      FROM obras o
      JOIN usuarios u ON o.criado_por = u.id
      WHERE o.status = 'aberta'
        AND o.expira_em BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
        AND o.alerta_enviado_em IS NULL
        AND u.push_token IS NOT NULL
    `)

    // Atualiza alerta_enviado_em em lote antes de notificar
    if (obras.rows.length > 0) {
      const ids = obras.rows.map(o => o.id)
      await pool.query(
        `UPDATE obras SET alerta_enviado_em = NOW() WHERE id = ANY($1)`,
        [ids]
      )
      await enviarPushEmLote(
        obras.rows.map(o => ({ push_token: o.push_token, data: { tipo: 'obra_expirando', obra_id: o.id } })),
        '⏰ Sua obra expira em 24 horas!',
        'Sua obra será encerrada em breve. Renove para continuar recebendo candidatos.'
      )
    }

    const reparos = await pool.query(`
      SELECT r.id, r.titulo, u.push_token
      FROM reparos r
      JOIN usuarios u ON r.criado_por = u.id
      WHERE r.status = 'aberta'
        AND r.expira_em BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
        AND r.alerta_enviado_em IS NULL
        AND u.push_token IS NOT NULL
    `)

    if (reparos.rows.length > 0) {
      const ids = reparos.rows.map(r => r.id)
      await pool.query(
        `UPDATE reparos SET alerta_enviado_em = NOW() WHERE id = ANY($1)`,
        [ids]
      )
      await enviarPushEmLote(
        reparos.rows.map(r => ({ push_token: r.push_token, data: { tipo: 'reparo_expirando', reparo_id: r.id } })),
        '⏰ Seu serviço expira em 24 horas!',
        'Seu serviço será encerrado em breve.'
      )
    }

    console.log(`Expiração: ${obras.rows.length} obras e ${reparos.rows.length} reparos notificados`)
  } catch (err) {
    console.error('Erro ao verificar obras expirando:', err)
  }
}

// Guarda de sobreposição LOCAL (A7 da auditoria externa): setInterval dispara sem esperar o
// tique anterior, então um tique lento do MESMO job no MESMO processo rodava por cima do
// outro. Um nome por job; tique que encontra o nome ocupado sai sem fazer nada (o próximo
// pega o que sobrou). Não substitui o claim atômico abaixo — este só cobre um processo;
// entre réplicas quem decide é o RETURNING.
// Declarada AQUI, acima do primeiro uso: é const, e usá-la antes da declaração derruba o
// módulo no require (TDZ) — foi a causa da queda de 25/08.
const jobsEmExecucao = new Set()
const semSobreposicao = (nome, fn) => async (...args) => {
  if (jobsEmExecucao.has(nome)) {
    console.warn(`[Cron] ${nome} ainda em execução — tique ignorado`)
    return
  }
  jobsEmExecucao.add(nome)
  try { return await fn(...args) } finally { jobsEmExecucao.delete(nome) }
}

// Lembretes "ainda aberto" — racional, cadência, mensagens e predicados em LADOS_LEMBRETE /
// sqlCalculoLembrete / sqlFatiaDevida (acima, junto do e-mail de reserva). Aqui só claim + envio.
const lembrarDemandasSemResposta = semSobreposicao('lembrarDemandasSemResposta', async () => {
  for (const lado of LADOS_LEMBRETE) {
    try {
      const claim = await pool.query(sqlClaimLembrete(lado))
      if (claim.rowCount === 0) continue
      console.log(`[Lembrete] ${lado.tabela}: ${claim.rowCount} demanda(s) sem match com fatia devida — lembrando (${claim.rows.map(d => `${d.id.slice(0, 8)} ${d.fase} #${d.lembretes_enviados} interessados=${d.interessados}`).join(', ')})`)
      for (const d of claim.rows) {
        const cidade = normalizar(d.cidade)
        const uf = String(d.uf || '').trim().toUpperCase()
        if (!cidade || !uf) {
          console.log(`[Lembrete] ${lado.tabela} ${d.id} sem cidade/uf — ninguém lembrado`)
          continue
        }
        // try/catch POR demanda: uma falha de broadcast não derruba as demais do tique. O claim
        // da fatia já está gravado — sem repescagem; a demanda espera a próxima fatia.
        try {
          await broadcastPaginado({
            tipoPrestador: lado.tipoPrestador, cidade, uf,
            categoria: lado.comCategoria ? d.categoria : null,
            ...lado.mensagem(d, d.id),
            rotulo: `lembrete ${lado.tabela} ${d.id}`,
            entrega: null,
            excluirManifestados: { interesse: lado.interesse, demandaId: d.id },
            demanda: { tabela: lado.tabela, id: d.id },
          })
        } catch (err) {
          console.error(`[Lembrete] push ${lado.tabela} ${d.id} falhou:`, err.message)
        }
        // E-mail de reserva a quem não tem token: mesma função do aviso de demanda nova, com o
        // tipo do lembrete + número da fatia no claim de email_alertas (ver cabeçalho: o UNIQUE
        // é por fatia) e o `interesse` do lado (exclui quem já se manifestou; conta os
        // interessados para o texto). Já engole os próprios erros (só log).
        await enviarEmailsNovaDemanda(lado.tabela, d.id, { tipo: `${lado.tipoEmail}#${d.lembretes_enviados}`, mensagem: lado.mensagem, interesse: lado.interesse })
      }
    } catch (err) {
      console.error(`[Lembrete] erro em ${lado.tabela}:`, err.message)
    }
  }
})

// Avisos ao PROFISSIONAL casado, sobre o prazo de chegada (o do cronômetro):
//   (1) avisarMatchFeito — logo após o match: "use Pedir mais tempo se combinar outra data".
//   (2) lembrarPrazoChegada — UM lembrete antes do prazo, em prazo − min(1h, metade do intervalo
//       match_feito_em → prazo). Cron de 1 min, como os cronômetros.
// PRAZO = a MESMA expressão dos crons verificarCronometro* (COALESCE(chegada_prevista_em,
// expira_em)); nada aqui altera o cronômetro — só lê o que ele lê.
// Pulado (2) enquanto: chegada já declarada/confirmada, match desfeito (match_usuario_id NULL),
// pedido de tempo em curso (pedido_tempo_status) ou janela de chegada proposta sem resposta do
// dono (chegada_pendente_em). O predicado é reavaliado a cada tique: pendência resolvida antes do
// prazo ainda recebe o lembrete, se couber.
// Idempotência: aviso_match_enviado_em / lembrete_chegada_enviado_em (claim atômico UPDATE ...
// WHERE IS NULL RETURNING), zeradas no UPDATE que cria o match (SQL_LIMPAR_CHEGADA em routes).
// data do push = o mesmo dos pushes de match ao profissional (candidatura_aceita / interesse_aceito
// + id), para o toque abrir o detalhe da demanda. E-mail SÓ a quem não tem push_token, com o mesmo
// HTML de reserva dos avisos de demanda (htmlEmailNovaDemanda, botão "Ver no app").
const LADOS_MATCH = {
  obras:   { tabela: 'obras',   chave: 'obra_id',   tipoPush: 'candidatura_aceita', aba: 'Obras' },
  reparos: { tabela: 'reparos', chave: 'reparo_id', tipoPush: 'interesse_aceito',   aba: 'Serviços' },
}
const SQL_PRAZO_CHEGADA = `COALESCE(d.chegada_prevista_em, d.expira_em)`
const TEXTO_MATCH_FEITO = {
  titulo: '🤝 Match feito!',
  corpo: 'Se combinar outra data com o cliente, use "Pedir mais tempo" no app. Senão o match é desfeito quando o prazo de chegada vencer.',
}
const CORPO_LEMBRETE_CHEGADA = 'Já chegou? Confirme no app. Combinou outra data? Toque em "Pedir mais tempo".'
// "1h" quando resta a hora inteira (antecedência de 1h disparada no tique certo, com até 1 min
// de cadência); senão os minutos reais que restam — inclusive quando o tique chegou atrasado.
const rotuloRestante = (restanteMin) =>
  (Number(restanteMin) >= 59 ? '1h' : `${Math.max(1, Math.round(Number(restanteMin)))} min`)
const tituloLembreteChegada = (d) => `⏰ Prazo de chegada vence em ${rotuloRestante(d.restante_min)}`

// Push ao profissional ou, sem token, e-mail (nunca os dois). Erro só no log.
const entregarAoProfissional = async ({ lado, demanda, titulo, corpo, rotulo }) => {
  const data = { tipo: lado.tipoPush, [lado.chave]: demanda.id }
  if (demanda.push_token) {
    await enviarPushNotificacao(demanda.push_token, titulo, corpo, data)
    return 'push'
  }
  if (!demanda.email) return 'sem contato'
  const html = htmlEmailNovaDemanda({ nome: demanda.nome?.split(' ')[0] || 'profissional', titulo, corpo, aba: lado.aba })
  await comTimeout(enviarEmailBrevo({ para: demanda.email, assunto: titulo, html }), EMAIL_ALERTAS_TIMEOUT_MS, `Brevo ${rotulo}`)
  return 'e-mail'
}

// Push com reserva de e-mail para avisos a QUALQUER lado (dono ou profissional) — negociação de
// horário em routes (proposta, contraproposta, aceite, recusa) e lembrarRespostaHorario. Push
// quando há token E o Expo aceitou o ticket; senão (sem token, token inválido, ticket 'error',
// exceção) e-mail em TEXTO PURO, sem link: assunto = título do push, corpo = texto do push.
// Nunca lança (erro de e-mail vira log). Devolve 'push' | 'e-mail' | 'sem contato' | 'falha'.
const entregarPushOuEmail = async ({ push_token, email, nome, titulo, corpo, data, rotulo }) => {
  try {
    if (push_token) {
      const r = await enviarPushNotificacao(push_token, titulo, corpo, data)
      if (r === 'enviado') return 'push'
    }
    const destino = String(email || '').trim()
    if (!destino) return 'sem contato'
    const primeiro = String(nome || '').trim().split(/\s+/)[0]
    const texto = `${primeiro ? `Olá, ${primeiro}!\n\n` : ''}${titulo}\n\n${corpo}\n\nAbra o app ${MARCA} para responder.`
    await comTimeout(enviarEmailBrevo({ para: destino, assunto: titulo, texto }), EMAIL_ALERTAS_TIMEOUT_MS, `Brevo ${rotulo}`)
    return 'e-mail'
  } catch (err) {
    console.error(`[Entrega] ${rotulo} falhou:`, err.message)
    return 'falha'
  }
}

// (1) Chamada fire-and-forget logo depois do UPDATE que cria o match (7 caminhos de aceite/match
// em routes/index.js e candidaturasController). O claim exige match_usuario_id = usuarioId: um
// match que já mudou de mãos ou foi desfeito não recebe nada.
const avisarMatchFeito = (tabela, demandaId, usuarioId) => {
  const lado = LADOS_MATCH[tabela]
  if (!lado || !demandaId || !usuarioId) return Promise.resolve()
  return (async () => {
    const claim = await pool.query(
      `UPDATE ${lado.tabela} d SET aviso_match_enviado_em = NOW()
         FROM usuarios u
        WHERE d.id = $1 AND d.match_usuario_id = $2 AND u.id = d.match_usuario_id
          AND d.aviso_match_enviado_em IS NULL
    RETURNING d.id, d.titulo, u.push_token, u.email, u.nome`,
      [demandaId, usuarioId]
    )
    if (claim.rowCount === 0) return
    const via = await entregarAoProfissional({ lado, demanda: claim.rows[0], ...TEXTO_MATCH_FEITO, rotulo: `match feito ${tabela} ${demandaId}` })
    console.log(`[MatchFeito] ${tabela} ${demandaId} → profissional ${usuarioId} via ${via}`)
  })().catch(err => console.error(`[MatchFeito] ${tabela} ${demandaId}:`, err.message))
}

// (2) Cálculo por linha: prazo, antecedência (min(1h, metade de match→prazo)) e instante do
// lembrete. Compartilhado pelo claim e pela prévia (dry-run), para nunca divergirem.
const sqlCalculoLembreteChegada = (lado) => `
      SELECT d.id, ${SQL_PRAZO_CHEGADA} AS prazo,
             LEAST(INTERVAL '1 hour', (${SQL_PRAZO_CHEGADA} - d.match_feito_em) / 2) AS antecedencia,
             ${SQL_PRAZO_CHEGADA} - LEAST(INTERVAL '1 hour', (${SQL_PRAZO_CHEGADA} - d.match_feito_em) / 2) AS dispara_em
        FROM ${lado.tabela} d
       WHERE d.status = 'aberta' AND d.match_usuario_id IS NOT NULL AND d.match_feito_em IS NOT NULL
         AND d.chegada_declarada_em IS NULL AND d.chegada_confirmada_em IS NULL
         AND ${SQL_PRAZO_CHEGADA} > NOW()`
// Devido agora: já passou o instante do lembrete, ainda não enviado, sem pendência em curso.
const sqlLembreteChegadaDevido = `
      NOW() >= s.dispara_em AND d.lembrete_chegada_enviado_em IS NULL
      AND d.pedido_tempo_status IS NULL AND d.chegada_pendente_em IS NULL`
const COLUNAS_LEMBRETE_CHEGADA = `d.id, d.titulo, d.match_usuario_id, s.prazo,
      EXTRACT(EPOCH FROM s.antecedencia) / 60 AS antecedencia_min,
      EXTRACT(EPOCH FROM (s.prazo - NOW())) / 60 AS restante_min`
const sqlClaimLembreteChegada = (lado) => `
      UPDATE ${lado.tabela} d SET lembrete_chegada_enviado_em = NOW()
        FROM (${sqlCalculoLembreteChegada(lado)}) s
       WHERE d.id = s.id AND ${sqlLembreteChegadaDevido}
   RETURNING ${COLUNAS_LEMBRETE_CHEGADA}`

// Prévia SEM efeito (dry-run): todo match vivo com prazo à frente, quando o lembrete dispara e
// por que (ainda) não dispara. db: client/transação do chamador.
const listarLembretesPrazoChegada = async (db = pool) => {
  const saida = []
  for (const lado of Object.values(LADOS_MATCH)) {
    const r = await db.query(
      `SELECT ${COLUNAS_LEMBRETE_CHEGADA}, s.dispara_em, d.match_feito_em, d.expira_em, d.chegada_prevista_em,
              d.pedido_tempo_status, d.chegada_pendente_em, d.lembrete_chegada_enviado_em, d.aviso_match_enviado_em,
              u.push_token IS NOT NULL AS tem_token, NULLIF(btrim(u.email), '') IS NOT NULL AS tem_email,
              (${sqlLembreteChegadaDevido}) AS devido_agora, NOW() AS agora
         FROM ${lado.tabela} d JOIN (${sqlCalculoLembreteChegada(lado)}) s ON s.id = d.id
         LEFT JOIN usuarios u ON u.id = d.match_usuario_id
        ORDER BY s.prazo`
    )
    saida.push({ tabela: lado.tabela, matches: r.rows })
  }
  return saida
}

const lembrarPrazoChegada = semSobreposicao('lembrarPrazoChegada', async () => {
  for (const lado of Object.values(LADOS_MATCH)) {
    try {
      const claim = await pool.query(sqlClaimLembreteChegada(lado))
      if (claim.rowCount === 0) continue
      for (const d of claim.rows) {
        try {
          const prof = await pool.query(`SELECT push_token, email, nome FROM usuarios WHERE id = $1`, [d.match_usuario_id])
          const via = await entregarAoProfissional({
            lado, demanda: { ...d, ...(prof.rows[0] || {}) },
            titulo: tituloLembreteChegada(d), corpo: CORPO_LEMBRETE_CHEGADA,
            rotulo: `lembrete chegada ${lado.tabela} ${d.id}`,
          })
          console.log(`[LembreteChegada] ${lado.tabela} ${d.id} → profissional ${d.match_usuario_id} via ${via} (${rotuloRestante(d.restante_min)} para o prazo)`)
        } catch (err) {
          // Claim já gravado: sem repescagem — é UM lembrete por match, e o prazo está perto.
          console.error(`[LembreteChegada] ${lado.tabela} ${d.id} falhou:`, err.message)
        }
      }
    } catch (err) {
      console.error(`[LembreteChegada] erro em ${lado.tabela}:`, err.message)
    }
  }
})

// Agendamento livre (chegada_janela = 'agendado', utils/agendamento) — dois crons de 1 min:
//   lembrarAgendamento   → ao PROFISSIONAL com horário aceito: véspera às 18:00 (SP), 2h antes e
//                          na hora ("Hora de sair"). Um claim por lembrete (lembrete_agenda_*_em,
//                          UPDATE ... WHERE IS NULL RETURNING), zerados por SQL_ZERAR_AGENDA no
//                          match/un-match e no aceite de um horário novo. Janela de disparo de
//                          60 min: horário aceito depois do instante do lembrete não recebe um
//                          lembrete atrasado. Push ou, sem token, e-mail (entregarAoProfissional).
//   vigiarComparecimento → ao DONO, 1h depois do horário sem chegada declarada/confirmada:
//                          "o profissional veio?" (claim vigia_comparecimento_em). A resposta
//                          entra por POST /:id/confirmar-comparecimento; o cron de cronômetro
//                          espera por ela até 24h (SQL_ESPERA_COMPARECIMENTO).
// Base comum: match vivo, horário agendado valendo, chegada ainda não declarada nem confirmada.
const SQL_BASE_AGENDA = `d.status = 'aberta' AND d.match_usuario_id IS NOT NULL
        AND d.chegada_janela = '${JANELA_AGENDADO}' AND d.chegada_prevista_em IS NOT NULL
        AND d.chegada_declarada_em IS NULL AND d.chegada_confirmada_em IS NULL`
const LEMBRETES_AGENDA = [
  { coluna: 'lembrete_agenda_vespera_em',
    dispara: `((((d.chegada_prevista_em AT TIME ZONE '${TZ_AGENDA}')::date - 1) + TIME '18:00') AT TIME ZONE '${TZ_AGENDA}')`,
    titulo: (d) => `📅 Amanhã: ${formatarDataHoraSP(d.chegada_prevista_em)}`,
    // Só a hora (o "às HH:MM" do formatador): o dia já está no título.
    corpo: (d) => `Amanhã às ${formatarDataHoraSP(d.chegada_prevista_em).split(' às ')[1]}: ${d.titulo}. Registre a chegada e a conclusão aqui no app.` },
  { coluna: 'lembrete_agenda_2h_em',
    dispara: `(d.chegada_prevista_em - INTERVAL '2 hours')`,
    titulo: (d) => `⏰ Em 2h: ${formatarDataHoraSP(d.chegada_prevista_em)}`,
    corpo: (d) => `Seu horário em "${d.titulo}" está chegando. Prepare-se para sair.` },
  { coluna: 'lembrete_agenda_hora_em',
    dispara: `d.chegada_prevista_em`,
    titulo: () => '🚗 Hora de sair: toque em Estou a caminho',
    corpo: (d) => `Horário combinado em "${d.titulo}": ${formatarDataHoraSP(d.chegada_prevista_em)}.` },
]
const lembrarAgendamento = semSobreposicao('lembrarAgendamento', async () => {
  for (const lado of Object.values(LADOS_MATCH)) {
    for (const l of LEMBRETES_AGENDA) {
      try {
        const claim = await pool.query(
          `UPDATE ${lado.tabela} d SET ${l.coluna} = NOW()
             FROM usuarios u
            WHERE u.id = d.match_usuario_id AND ${SQL_BASE_AGENDA}
              AND d.${l.coluna} IS NULL
              AND NOW() >= ${l.dispara}
              AND NOW() < ${l.dispara} + INTERVAL '${LEMBRETE_AGENDA_JANELA}'
        RETURNING d.id, d.titulo, d.match_usuario_id, d.chegada_prevista_em, u.push_token, u.email, u.nome`
        )
        for (const d of claim.rows) {
          try {
            const via = await entregarAoProfissional({
              lado, demanda: d, titulo: l.titulo(d), corpo: l.corpo(d),
              rotulo: `agenda ${l.coluna} ${lado.tabela} ${d.id}`,
            })
            console.log(`[Agenda] ${l.coluna} ${lado.tabela} ${d.id} → profissional ${d.match_usuario_id} via ${via}`)
          } catch (err) {
            // Claim já gravado: sem repescagem (um lembrete por slot).
            console.error(`[Agenda] ${l.coluna} ${lado.tabela} ${d.id} falhou:`, err.message)
          }
        }
      } catch (err) {
        console.error(`[Agenda] erro em ${lado.tabela} ${l.coluna}:`, err.message)
      }
    }
  }
})

// "Agende seu atendimento" — ao PROFISSIONAL casado enquanto NINGUÉM propôs dia/hora
// (chegada_pendente_em e chegada_prevista_em nulos). Cron de 1 min, como os demais do match.
// PRAZO = SQL_PRAZO_CHEGADA, o mesmo do "Prazo para chegar" dos cronômetros (com a prevista
// nula, é expira_em — que na obra é o prazo de INÍCIO). Antecedências, pela janela W da
// demanda (sqlJanelaHoras: prazo_atendimento_horas/horas_para_expirar ou expira_em − âncora):
//   reparo W < 4h (1h, 2h)              → 30 min, 15 min
//   reparo 4h ≤ W < 8h                  → 1h, 30 min
//   reparo 8h ≤ W < 168h e "Hoje"       → 2h, 1h          (8h, 12h, Hoje, Amanhã)
//   reparo 168h ≤ W < 720h              → 1 dia, 6h, 1h   (Esta semana)
//   reparo W ≥ 720h e TODA obra         → 1 semana, 3 dias, 1 dia, 2h  (Este mês, Mês que vem)
// Para (tudo no predicado, reavaliado a cada tique): proposta de horário em curso (de qualquer
// lado), horário aceito, chegada declarada/confirmada, "Estou a caminho", demanda fora de
// 'aberta' (encerrada/cancelada), match desfeito (match_usuario_id NULL).
// Antecedência cujo instante já tinha passado no momento do match NÃO dispara (match_feito_em
// tem de ser anterior a prazo − antecedência). Só a antecedência CORRENTE é devida: a janela
// de cada uma vai do seu instante até o da seguinte (a última, até o prazo) — depois de uma
// parada do processo sai UM aviso, não a fila atrasada.
// Idempotência entre réplicas e restarts: lembrete_agendar_offsets (INTEGER[] de minutos, nas
// duas tabelas). O claim é UPDATE ... array_append ... WHERE NOT (coluna @> ARRAY[off])
// RETURNING — a mesma antecedência nunca sai duas vezes; a coluna é zerada em SQL_ZERAR_AGENDA
// (match novo, un-match, remarcar), então o profissional seguinte recebe os seus.
// Entrega por entregarAoProfissional: push com data { tipo, reparo_id | obra_id } (o toque abre
// o detalhe, como os outros pushes do match); sem token, o e-mail de reserva.
const TITULO_AGENDAR = '📅 Agende seu atendimento'
const CORPO_AGENDAR = {
  reparoCurto: 'Você ainda não agendou o horário do serviço conquistado',
  reparo:      'Você ainda não agendou o dia e o horário do serviço conquistado',
  obra:        'Você ainda não agendou o dia e o horário de início da obra conquistada',
}
// Antecedências em MINUTOS, decrescentes (a ordem é a das janelas de disparo).
const OFFSETS_AGENDAR = {
  curtissimo: [30, 15],
  curto:      [60, 30],
  dia:        [120, 60],
  semana:     [1440, 360, 60],
  longo:      [10080, 4320, 1440, 120],
}
// Conjunto de antecedências da linha. Obra: sempre 'longo'. Reparo: "Hoje" cai com 8h/12h/Amanhã;
// o resto é pela janela W. `d` é o alias da tabela.
const sqlConjuntoAgendar = (lado) => {
  if (lado.tabela === 'obras') return `'longo'`
  const w = sqlJanelaHoras(LADOS_LEMBRETE.find(l => l.tabela === lado.tabela))
  return `CASE WHEN d.prazo_modo = '${PRAZO_MODO_HOJE}' THEN 'dia'
               WHEN ${w} < 4   THEN 'curtissimo'
               WHEN ${w} < 8   THEN 'curto'
               WHEN ${w} < 168 THEN 'dia'
               WHEN ${w} < 720 THEN 'semana'
               ELSE 'longo' END`
}
// Reparo com prazo abaixo de 24h (ou "Hoje"): só a HORA faz sentido no texto.
const sqlReparoCurto = (lado) => {
  if (lado.tabela === 'obras') return 'false'
  const w = sqlJanelaHoras(LADOS_LEMBRETE.find(l => l.tabela === lado.tabela))
  // COALESCE: prazo_modo NULL (o caso normal) daria NULL OR false = NULL, não false.
  return `(COALESCE(d.prazo_modo = '${PRAZO_MODO_HOJE}', false) OR ${w} < 24)`
}
// Antecedência devida AGORA dentro de um conjunto: a de maior janela cujo instante já passou e
// cuja seguinte ainda não chegou (a última vale até o prazo). NULL = nenhuma devida.
const sqlOffsetDevido = (offsets) => {
  const inst = (min) => `(${SQL_PRAZO_CHEGADA} - INTERVAL '${min} minutes')`
  const ramos = offsets.map((off, i) => {
    const proximo = offsets[i + 1]
    const ateProximo = proximo === undefined ? '' : ` AND NOW() < ${inst(proximo)}`
    return `WHEN NOW() >= ${inst(off)}${ateProximo} THEN ${off}`
  })
  return `CASE ${ramos.join(' ')} END`
}
const SQL_BASE_AGENDAR = `d.status = 'aberta' AND d.match_usuario_id IS NOT NULL AND d.match_feito_em IS NOT NULL
        AND d.chegada_prevista_em IS NULL AND d.chegada_pendente_em IS NULL
        AND d.chegada_declarada_em IS NULL AND d.chegada_confirmada_em IS NULL
        AND d.a_caminho_em IS NULL`
const sqlClaimAgendar = (lado, conjunto, offsets) => `
      UPDATE ${lado.tabela} d SET lembrete_agendar_offsets = array_append(d.lembrete_agendar_offsets, s.off)
        FROM (SELECT d.id, ${SQL_PRAZO_CHEGADA} AS prazo, ${sqlOffsetDevido(offsets)} AS off, ${sqlReparoCurto(lado)} AS curto
                FROM ${lado.tabela} d
               WHERE ${SQL_BASE_AGENDAR} AND ${SQL_PRAZO_CHEGADA} > NOW()
                 AND (${sqlConjuntoAgendar(lado)}) = '${conjunto}') s,
             usuarios u
       WHERE d.id = s.id AND u.id = d.match_usuario_id
         AND s.off IS NOT NULL
         AND d.match_feito_em <= s.prazo - s.off * INTERVAL '1 minute'
         AND NOT (d.lembrete_agendar_offsets @> ARRAY[s.off])
         AND ${SQL_BASE_AGENDAR}
   RETURNING d.id, d.titulo, d.match_usuario_id, s.off, s.curto, u.push_token, u.email, u.nome`
const corpoAgendar = (lado, d) =>
  lado.tabela === 'obras' ? CORPO_AGENDAR.obra : (d.curto ? CORPO_AGENDAR.reparoCurto : CORPO_AGENDAR.reparo)
const lembrarAgendarAtendimento = semSobreposicao('lembrarAgendarAtendimento', async () => {
  for (const lado of Object.values(LADOS_MATCH)) {
    for (const [conjunto, offsets] of Object.entries(OFFSETS_AGENDAR)) {
      if (lado.tabela === 'obras' && conjunto !== 'longo') continue
      try {
        const claim = await pool.query(sqlClaimAgendar(lado, conjunto, offsets))
        for (const d of claim.rows) {
          try {
            const via = await entregarAoProfissional({
              lado, demanda: d, titulo: TITULO_AGENDAR, corpo: corpoAgendar(lado, d),
              rotulo: `agendar ${lado.tabela} ${d.id} ${d.off}min`,
            })
            console.log(`[Agendar] ${lado.tabela} ${d.id} (${conjunto}, ${d.off} min antes) → profissional ${d.match_usuario_id} via ${via}`)
          } catch (err) {
            // Claim já gravado: sem repescagem (uma antecedência, um aviso).
            console.error(`[Agendar] ${lado.tabela} ${d.id} ${d.off}min falhou:`, err.message)
          }
        }
      } catch (err) {
        console.error(`[Agendar] erro em ${lado.tabela} ${conjunto}:`, err.message)
      }
    }
  }
})

// "Responda o horário proposto" — à parte que DEVE RESPONDER uma proposta/contraproposta de
// horário pendente (chegada_pendente_em): quem NÃO propôs — proposta do profissional
// (COALESCE(chegada_proposta_por, match_usuario_id) = match_usuario_id) → dono; do dono →
// profissional. Cron de 1 min. Dois avisos por proposta:
//   1h depois da proposta (chegada_proposta_em + 1h) e 1h antes do horário proposto
//   (chegada_pendente_em − 1h). Cada um só dentro de 60 min do seu instante
//   (LEMBRETE_AGENDA_JANELA): instante já passado (proposta a menos de 1h do horário, processo
//   parado) não dispara atrasado; nenhum dos dois depois do horário proposto. O "1h antes" tem
//   de cair ao menos 30 min depois do "1h depois" (proposta ≥ 2h30 antes do horário), senão os
//   dois sairiam no mesmo minuto.
// Para (tudo no predicado): resposta (aceite/recusa zeram chegada_pendente_em), proposta trocada
// (toda escrita de proposta renova chegada_proposta_em e zera as marcas), demanda fora de
// 'aberta', match desfeito (match_usuario_id NULL / SQL_ZERAR_AGENDA).
// Idempotência: lembrete_resposta_{1h,antes}_em — claim UPDATE ... WHERE IS NULL RETURNING.
// data do push = o tipo que cada lado já recebe nesta negociação (dono: chegada_prevista_pendente;
// profissional: chegada_contraproposta) + obra_id/reparo_id — o toque abre o detalhe.
// Entrega por entregarPushOuEmail (push; sem token ou push falho, e-mail em texto puro).
const TITULO_RESPOSTA_HORARIO = '⏳ Responda o horário proposto'
const SQL_QUEM_PROPOS = `COALESCE(d.chegada_proposta_por, d.match_usuario_id)`
const SQL_QUEM_RESPONDE = `CASE WHEN ${SQL_QUEM_PROPOS} = d.match_usuario_id THEN d.criado_por ELSE d.match_usuario_id END`
const LEMBRETES_RESPOSTA = [
  { coluna: 'lembrete_resposta_1h_em',
    dispara: `(d.chegada_proposta_em + INTERVAL '1 hour')`,
    extra: '' },
  { coluna: 'lembrete_resposta_antes_em',
    dispara: `(d.chegada_pendente_em - INTERVAL '1 hour')`,
    extra: `AND d.chegada_pendente_em - INTERVAL '1 hour' >= d.chegada_proposta_em + INTERVAL '90 minutes'` },
]
const sqlClaimRespostaHorario = (lado, l) => `
      UPDATE ${lado.tabela} d SET ${l.coluna} = NOW()
        FROM usuarios u, usuarios p
       WHERE d.status = 'aberta' AND d.match_usuario_id IS NOT NULL
         AND d.chegada_pendente_em IS NOT NULL AND d.chegada_proposta_em IS NOT NULL
         AND u.id = ${SQL_QUEM_RESPONDE} AND p.id = ${SQL_QUEM_PROPOS}
         AND d.${l.coluna} IS NULL
         AND NOW() >= ${l.dispara} AND NOW() < ${l.dispara} + INTERVAL '${LEMBRETE_AGENDA_JANELA}'
         AND NOW() < d.chegada_pendente_em
         ${l.extra}
   RETURNING d.id, d.titulo, d.chegada_pendente_em, (u.id = d.criado_por) AS para_dono,
             u.push_token, u.email, u.nome, p.nome AS nome_proponente`
const corpoRespostaHorario = (d) => {
  const quem = String(d.nome_proponente || '').trim().split(/\s+/)[0] || (d.para_dono ? 'O profissional' : 'O solicitante')
  return `${quem} propôs ${formatarDataHoraSP(d.chegada_pendente_em)} para "${d.titulo}". Confirme ou sugira outro.`
}
const lembrarRespostaHorario = semSobreposicao('lembrarRespostaHorario', async () => {
  for (const lado of Object.values(LADOS_MATCH)) {
    for (const l of LEMBRETES_RESPOSTA) {
      try {
        const claim = await pool.query(sqlClaimRespostaHorario(lado, l))
        for (const d of claim.rows) {
          const via = await entregarPushOuEmail({
            push_token: d.push_token, email: d.email, nome: d.nome,
            titulo: TITULO_RESPOSTA_HORARIO, corpo: corpoRespostaHorario(d),
            data: { tipo: d.para_dono ? 'chegada_prevista_pendente' : 'chegada_contraproposta', [lado.chave]: d.id },
            rotulo: `resposta horário ${l.coluna} ${lado.tabela} ${d.id}`,
          })
          console.log(`[RespostaHorario] ${l.coluna} ${lado.tabela} ${d.id} → ${d.para_dono ? 'dono' : 'profissional'} via ${via}`)
        }
      } catch (err) {
        console.error(`[RespostaHorario] erro em ${lado.tabela} ${l.coluna}:`, err.message)
      }
    }
  }
})

const vigiarComparecimento = semSobreposicao('vigiarComparecimento', async () => {
  for (const lado of Object.values(LADOS_MATCH)) {
    try {
      // Sem resposta prévia (comparecimento_resposta IS NULL): o dono responde uma vez por horário.
      const claim = await pool.query(
        `UPDATE ${lado.tabela} d SET vigia_comparecimento_em = NOW()
           FROM usuarios u
          WHERE u.id = d.criado_por AND ${SQL_BASE_AGENDA}
            AND d.vigia_comparecimento_em IS NULL AND d.comparecimento_resposta IS NULL
            AND NOW() >= d.chegada_prevista_em + INTERVAL '${VIGIA_ATRASO}'
      RETURNING d.id, d.titulo, d.chegada_prevista_em, u.push_token`
      )
      for (const d of claim.rows) {
        if (!d.push_token) {
          console.log(`[Vigia] ${lado.tabela} ${d.id}: dono sem push_token — sem aviso (o cron espera a resposta até 24h mesmo assim)`)
          continue
        }
        await enviarPushNotificacao(
          d.push_token,
          '🤔 O profissional veio?',
          `O horário combinado em "${d.titulo}" (${formatarDataHoraSP(d.chegada_prevista_em)}) passou há 1h sem chegada registrada. Responda no app.`,
          { tipo: 'confirmar_comparecimento', [lado.chave]: d.id }
        )
      }
      if (claim.rowCount > 0) console.log(`[Vigia] ${lado.tabela}: ${claim.rowCount} dono(s) perguntado(s)`)
    } catch (err) {
      console.error(`[Vigia] erro em ${lado.tabela}:`, err.message)
    }
  }
})

const verificarObrasComBaixoEngajamento = semSobreposicao('verificarObrasComBaixoEngajamento', async () => {
  try {
    console.log('Verificando obras com baixo engajamento...')

    // CLAIM atômico (A7, mesmo desenho do aviso de 5 min): o próprio UPDATE grava
    // alerta_enviado_em e devolve, via RETURNING, só as linhas que ELE reivindicou. O push sai
    // apenas para essas. Antes era SELECT → UPDATE WHERE id = ANY → push para a lista do
    // SELECT: duas réplicas (ou dois tiques sobrepostos) avisavam o mesmo dono duas vezes.
    // Cadência de 24h (D86) preservada no predicado.
    const obras = await pool.query(`
      UPDATE obras o SET alerta_enviado_em = NOW()
      FROM usuarios u
      WHERE u.id = o.criado_por
        AND o.status = 'aberta'
        AND o.status_aprovacao = 'aprovada'
        AND o.match_usuario_id IS NULL
        AND o.total_visitas >= 10
        AND o.criado_em < NOW() - INTERVAL '1 day'
        AND o.expira_em > NOW()
        AND (o.alerta_enviado_em IS NULL OR o.alerta_enviado_em < NOW() - INTERVAL '24 hours')
        AND NOT EXISTS (
          SELECT 1 FROM candidaturas c
          WHERE c.obra_id = o.id AND c.status IS DISTINCT FROM 'recusado'
        )
        AND u.push_token IS NOT NULL
      RETURNING o.id, o.titulo, o.total_visitas, u.push_token
    `)

    if (obras.rows.length > 0) {
      // Envio individual aqui pois a mensagem inclui total_visitas específico de cada obra
      for (const obra of obras.rows) {
        await enviarPushNotificacao(
          obra.push_token,
          '💡 Considere aumentar sua oferta',
          `Sua obra "${obra.titulo}" teve ${obra.total_visitas} visitas e nenhum profissional se interessou. Considere aumentar o prazo ou revisar o texto.`,
          { tipo: 'baixo_engajamento', obra_id: obra.id }
        )
      }
    }

    // Mesmo claim atômico do lado obra (ver acima).
    const reparos = await pool.query(`
      UPDATE reparos r SET alerta_enviado_em = NOW()
      FROM usuarios u
      WHERE u.id = r.criado_por
        AND r.status = 'aberta'
        AND r.status_aprovacao = 'aprovada'
        AND r.match_usuario_id IS NULL
        AND r.total_visitas >= 10
        AND r.criado_em < NOW() - INTERVAL '1 day'
        AND r.expira_em > NOW()
        -- 24h como na obra (D86): o job roda a cada 8h, e com '8 hours' o dono de reparo era
        -- cutucado até 3x por dia sobre a mesma demanda. O gate criado_em < NOW() - 1 day acima
        -- já garante que só reparos com vida de dias chegam aqui, então a cadência de obra
        -- (uma vez por dia) é a certa para os dois lados.
        AND (r.alerta_enviado_em IS NULL OR r.alerta_enviado_em < NOW() - INTERVAL '24 hours')
        AND NOT EXISTS (
          SELECT 1 FROM interesse_reparos ir
          WHERE ir.reparo_id = r.id AND ir.status IS DISTINCT FROM 'recusado'
        )
        AND u.push_token IS NOT NULL
      RETURNING r.id, r.titulo, r.total_visitas, u.push_token
    `)

    if (reparos.rows.length > 0) {
      for (const reparo of reparos.rows) {
        await enviarPushNotificacao(
          reparo.push_token,
          '💡 Considere aumentar sua oferta',
          `Seu serviço "${reparo.titulo}" teve ${reparo.total_visitas} visitas e nenhum profissional se interessou. Considere aumentar o prazo ou revisar o texto.`,
          { tipo: 'baixo_engajamento_reparo', reparo_id: reparo.id }
        )
      }
    }

    console.log(`Engajamento: ${obras.rows.length} obras e ${reparos.rows.length} reparos notificados`)
  } catch (err) {
    console.error('Erro ao verificar engajamento:', err)
  }
})

// Marcos de expiração PROPORCIONAIS à faixa de prazo da demanda (ver src/utils/faixasPrazo.js).
// Alerta o dono de uma demanda SEM match e SEM interessados em 3 marcos cujos offsets VARIAM por
// faixa: ex. faixa 1h → [15,10,5] min antes de expira_em; faixa 168h → [1 dia, 8h, 4h]. Cada push
// tem deep-link para a tela de detalhe (onde fica o botão de estender).
//
// Bandas contíguas e DISJUNTAS a partir dos 3 offsets [m1>m2>m3]:
//   marco_1: (m2, m1]   marco_2: (m3, m2]   marco_3: (0, m3]
// Como não se sobrepõem, a demanda cai em no máximo uma banda por run → no máximo um push por marco
// (reforçado pelo claim marco_N_em IS NULL). Demanda que só aparece já dentro da banda menor recebe
// só aquele alerta (cobertura, não sequência). SEM backfill anti-rajada: as bandas disjuntas já
// garantem no máximo um disparo por run, então o 1º run pós-deploy não gera rajada de alertas.
//
// Elegibilidade: status='aberta', match_usuario_id IS NULL, sem interesse (obras: NOT EXISTS
// candidaturas; reparos: NOT EXISTS interesse_reparos), dono com push_token entregável. Obras
// exigem status_aprovacao='aprovada' (reparos não, por decisão).
//
// Claim-then-send replica-safe: o SELECT reúne candidatos; o UPDATE ... WHERE marco_N_em IS NULL
// RETURNING reivindica a coluna atomicamente — a 2ª réplica vê a coluna já preenchida e retorna 0
// linhas, então só uma envia o push. Faixa desconhecida (getFaixa null) → pula com log, sem crash.

// Formata minutos em rótulo PT-BR curto: 5→"5 minutos", 60→"1 hora", 90→"1h30", 1440→"1 dia".
const formatarTempoRestante = (min) => {
  if (min >= 1440) { const d = Math.round(min / 1440); return d === 1 ? '1 dia' : `${d} dias` }
  if (min >= 60) {
    const h = Math.floor(min / 60), m = min % 60
    if (m === 0) return h === 1 ? '1 hora' : `${h} horas`
    return `${h}h${String(m).padStart(2, '0')}`
  }
  return `${min} minutos`
}

// `interesse`: subconsulta do NOT EXISTS que suprime o alerta quando a demanda JÁ tem
// interessado. Testava só a EXISTÊNCIA da linha, então uma candidatura/interesse já
// RECUSADO calava o alerta para sempre — justamente quando o dono mais precisa dele
// (demanda expirando e sem ninguém vivo na fila). Agora só linhas vivas suprimem.
// IS DISTINCT FROM (e não <>) por ser NULL-safe: status NULL continua suprimindo, como hoje.
const verificarMarcosExpiracao = async () => {
  const lados = [
    { tabela: 'obras',   idKey: 'obra_id',   janelaCol: 'horas_para_expirar',      substantivo: 'Sua obra',   verbo: 'Estenda o prazo',
      tipoPrefixo: 'obra_expirando',   statusAprovacao: `AND d.status_aprovacao = 'aprovada'`, interesse: `SELECT 1 FROM candidaturas c WHERE c.obra_id = d.id AND c.status IS DISTINCT FROM 'recusado'` },
    { tabela: 'reparos', idKey: 'reparo_id', janelaCol: 'prazo_atendimento_horas', substantivo: 'Seu serviço', verbo: 'Aumente o prazo',
      tipoPrefixo: 'reparo_expirando', statusAprovacao: '',                          interesse: `SELECT 1 FROM interesse_reparos ir WHERE ir.reparo_id = d.id AND ir.status IS DISTINCT FROM 'recusado'` },
  ]

  let totalEnviados = 0
  try {
    for (const lado of lados) {
      // Candidatos elegíveis com algum marco pendente e expira_em dentro do MAIOR offset possível
      // (MAX_OFFSET_MARCO_MINUTOS, derivado de FAIXAS: hoje 20160min = 14 dias, marco 1 da faixa
      // 1440) — demandas mais distantes que isso não entram em banda nenhuma. Literal numérico
      // vindo da tabela, nunca do request; o predicado segue um range em expira_em, então
      // obras_marcos_pendentes_idx / reparos_marcos_pendentes_idx continuam cobrindo a leitura.
      // COALESCE(janela, 720): linhas ANTIGAS gravadas com prazo NULL viravam Number(null)=0 no
      // getFaixa, caíam no `faixa desconhecida` e nunca recebiam marco. 720 é o mesmo default que
      // o create usa para o expira_em dessas linhas (e o que os dois crons já usam nas obras).
      const candidatos = await pool.query(`
        SELECT d.id, d.titulo, COALESCE(d.${lado.janelaCol}, 720) AS janela, d.expira_em,
               d.marco_1_em, d.marco_2_em, d.marco_3_em, u.push_token
        FROM ${lado.tabela} d
        JOIN usuarios u ON d.criado_por = u.id
        WHERE d.status = 'aberta'
          ${lado.statusAprovacao}
          AND d.match_usuario_id IS NULL
          AND u.push_token IS NOT NULL AND u.push_token <> ''
          AND NOT EXISTS (${lado.interesse})
          AND (d.marco_1_em IS NULL OR d.marco_2_em IS NULL OR d.marco_3_em IS NULL)
          AND d.expira_em > NOW()
          AND d.expira_em <= NOW() + INTERVAL '${MAX_OFFSET_MARCO_MINUTOS} minutes'
      `)

      for (const d of candidatos.rows) {
        const faixa = getFaixa(Math.round(Number(d.janela)))
        if (!faixa) {
          console.warn(`[MarcosExpiracao] faixa desconhecida (janela=${d.janela}) — ${lado.tabela} ${d.id} ignorado`)
          continue
        }
        const [m1, m2, m3] = faixa.milestones
        const restante = (new Date(d.expira_em).getTime() - Date.now()) / 60000

        // Banda disjunta — no máximo um marco por run.
        let alvo = null
        if      (d.marco_1_em === null && restante <= m1 && restante > m2) alvo = { n: 1, col: 'marco_1_em', offset: m1 }
        else if (d.marco_2_em === null && restante <= m2 && restante > m3) alvo = { n: 2, col: 'marco_2_em', offset: m2 }
        else if (d.marco_3_em === null && restante <= m3 && restante > 0)  alvo = { n: 3, col: 'marco_3_em', offset: m3 }
        if (!alvo) continue

        // Claim-then-send: reivindica a coluna no mesmo UPDATE (replica-safe).
        const claim = await pool.query(
          `UPDATE ${lado.tabela} SET ${alvo.col} = NOW() WHERE id = $1 AND ${alvo.col} IS NULL RETURNING id`,
          [d.id]
        )
        if (claim.rows.length === 0) continue

        const label = formatarTempoRestante(alvo.offset)
        const titulo = `⏰ ${lado.substantivo} está expirando`
        const corpo = alvo.n === 3
          ? `Última chance: ${lado.substantivo.toLowerCase()} '${d.titulo}' expira em menos de ${label} e ainda não tem interessados. ${lado.verbo} agora.`
          : `${lado.substantivo} '${d.titulo}' expira em menos de ${label} e ainda não tem interessados. ${lado.verbo}.`
        await enviarPushEmLote(
          [{ push_token: d.push_token }],
          titulo,
          corpo,
          { tipo: `${lado.tipoPrefixo}_${alvo.n}`, [lado.idKey]: d.id }
        )
        totalEnviados++
      }
    }
    console.log(`[MarcosExpiracao] ${totalEnviados} alerta(s) de expiração enviado(s)`)
  } catch (err) {
    console.error('Erro ao verificar marcos de expiração:', err.message)
  }
  // Rede de segurança do push de "novo disponível" — mesma cadência deste job, try/catch próprio.
  await enviarPushNovoPendente()
}

// Avisa OS DOIS LADOS de um match desfeito pelo cronômetro — antes o ramo (b) dos dois crons
// devolvia a demanda ao feed em silêncio, e o profissional descobria abrindo o app. Mesmos
// título/tipo dos handlers POST /:id/expirar-match, para o app tratar tudo por 'match_expirado'.
// `tabela` sai de literal no chamador, nunca do request.
const ROTULOS_MATCH_DESFEITO = {
  obras:   { chave: 'obra_id',   profissional: 'pintor',    artigo: 'A obra',   volta: 'A obra voltou' },
  reparos: { chave: 'reparo_id', profissional: 'prestador', artigo: 'O serviço', volta: 'O serviço voltou' },
}

const notificarMatchDesfeito = async (tabela, demanda) => {
  const { chave, profissional, artigo, volta } = ROTULOS_MATCH_DESFEITO[tabela]
  const alvos = [demanda.criado_por, demanda.match_usuario_id].filter(Boolean)
  if (alvos.length === 0) return
  const tokens = await pool.query(
    `SELECT id, push_token FROM usuarios WHERE id = ANY($1::uuid[]) AND push_token IS NOT NULL`,
    [alvos]
  )
  for (const u of tokens.rows) {
    const paraDono = u.id === demanda.criado_por
    enviarPushNotificacao(u.push_token, '⏰ Prazo expirado!',
      paraDono
        ? `O ${profissional} não chegou a tempo para "${demanda.titulo}". ${artigo} está disponível novamente.`
        : `O prazo para chegar em "${demanda.titulo}" acabou. ${volta} para o feed.`,
      { tipo: 'match_expirado', [chave]: demanda.id }).catch(() => {})
  }
}

// Faltas: só o CRONÔMETRO registra. Os handlers POST /:id/expirar-match e as recusas de tempo
// extra também desfazem match, mas ali há um humano decidindo (dono ou admin, e o próprio
// profissional pode chamar expirar-match) — contar aquilo como falta deixaria a suspensão ao
// alcance de quem clica. O cron é a única evidência automática de "prazo venceu, ninguém chegou".
const FALTAS_PARA_SUSPENDER = 3
const JANELA_FALTAS = '90 days'
const MOTIVO_SUSPENSAO = `${FALTAS_PARA_SUSPENDER} faltas (não comparecimento) em ${JANELA_FALTAS.replace('days', 'dias')}`

// Isenção: o profissional ofereceu uma janela e ela NUNCA virou compromisso — porque o dono
// recusou (chegada_recusada_em) ou porque simplesmente não respondeu e a proposta morreu
// pendente (chegada_pendente_em). Nos dois casos chegada_prevista_em segue NULL: não houve
// horário acordado para ele furar. Cobrar falta aí puniria quem se ofereceu e ficou esperando —
// e, no caso do silêncio, puniria o profissional por inação do DONO.
// Se alguma janela chegou a VALER (chegada_prevista_em preenchida), a isenção cai: havia
// compromisso firmado, e não comparecer é falta.
// Espelhada no CASE de prestadores_bloqueados dos dois crons e dos dois expirar-match — as
// duas punições (falta e bloqueio) andam sempre juntas.
// Agendamento: a pendência só isenta quando a proposta era DO PROFISSIONAL (aguardava o dono);
// proposta do dono sem resposta do profissional não isenta. Regra única em utils/agendamento
// (isentoDeFalta em JS, SQL_ISENCAO_FALTA nos CASE de prestadores_bloqueados).
const isentoPorRecusa = (demanda) => isentoDeFalta(demanda)

// Registra a falta e, ao cruzar o limite na janela móvel, suspende. `tabela` sai de literal no
// chamador, nunca do request. Erros são engolidos: uma falha aqui não pode derrubar o cron nem
// impedir que a demanda volte ao feed — o un-match já foi commitado quando isto roda.
const registrarFalta = async (tabela, demanda) => {
  if (!demanda.match_usuario_id) return
  try {
    await pool.query(
      `INSERT INTO faltas_profissional (usuario_id, tabela, demanda_id) VALUES ($1, $2, $3)`,
      [demanda.match_usuario_id, tabela, demanda.id]
    )
    // perdoada_em IS NULL: falta perdoada por um admin continua no histórico mas não conta.
    const c = await pool.query(
      `SELECT COUNT(*)::int AS n FROM faltas_profissional
        WHERE usuario_id = $1
          AND perdoada_em IS NULL
          AND criado_em > NOW() - INTERVAL '${JANELA_FALTAS}'`,
      [demanda.match_usuario_id]
    )
    if (c.rows[0].n < FALTAS_PARA_SUSPENDER) return

    // suspenso_em IS NULL no WHERE: suspende UMA vez. Sem isso, a 4ª, 5ª... falta reescreveria
    // o timestamp (empurrando o início da suspensão para frente) e reenviaria o push a cada
    // falta. rowCount = 0 significa "já estava suspenso" — nada a notificar.
    const upd = await pool.query(
      `UPDATE usuarios SET suspenso_em = NOW(), suspenso_motivo = $2
        WHERE id = $1 AND suspenso_em IS NULL
        RETURNING push_token`,
      [demanda.match_usuario_id, MOTIVO_SUSPENSAO]
    )
    if (upd.rowCount === 0) return
    // Derruba o usuário do cache de 30s de autenticar. Sem isto, quem estivesse com sessão
    // quente continuaria passando por exigirNaoSuspenso (que lê req.usuario) por até 30
    // segundos depois de suspenso — janela para pegar mais um trabalho. Os aceites já
    // consultam o banco direto, mas os feeds e a criação de proposta dependem do cache.
    invalidarCacheAssinatura(demanda.match_usuario_id)
    console.log(`[Faltas] usuario ${demanda.match_usuario_id} suspenso — ${c.rows[0].n} faltas em ${JANELA_FALTAS}`)
    if (upd.rows[0]?.push_token) {
      enviarPushNotificacao(upd.rows[0].push_token, '🚫 Conta suspensa',
        `Sua conta foi suspensa por ${MOTIVO_SUSPENSAO}. Fale com o suporte para regularizar.`,
        { tipo: 'conta_suspensa' }).catch(() => {})
    }
  } catch (err) {
    console.error(`[Faltas] Erro ao registrar falta em ${tabela}:`, err.message)
  }
}

// Cronômetro de matches de reparos.
// O prazo do cronômetro inicia em match_feito_em e vai até COALESCE(chegada_prevista_em,
// expira_em): quando o prestador promete uma janela de chegada, é ELA que passa a valer como
// prazo — inclusive quando cai depois do expira_em original (o dono aceitou esperar até lá ao
// ver a previsão). Sem previsão, nada muda: continua o expira_em.
// (a) A 5 minutos do fim: avisa o dono uma única vez por match.
// (b) Quando o cronômetro zera: devolve o reparo ao feed e limpa o match.
// Os dois ramos param assim que a chegada é DECLARADA (por qualquer lado) ou CONFIRMADA: a
// partir daí o prestador está no local, e nem faz sentido cobrar "ainda não chegou?" nem
// devolver ao feed um reparo em atendimento.
const verificarCronometroReparos = semSobreposicao('verificarCronometroReparos', async () => {
  try {
    // (a) 5 minutos restantes → notifica o dono (uma vez por match).
    // CLAIM atômico (A7): o próprio UPDATE decide quem avisa — notif_5min_enviada = false no
    // WHERE e RETURNING com o token. Duas réplicas (ou dois tiques) não avisam a mesma linha
    // duas vezes: a segunda não casa mais o predicado e recebe zero linhas. Antes era
    // SELECT → UPDATE WHERE id = ANY → push para a lista do SELECT, e as duas venciam.
    const cincoMin = await pool.query(`
      UPDATE reparos r SET notif_5min_enviada = true
      FROM usuarios u
      WHERE u.id = r.criado_por
        AND r.match_usuario_id IS NOT NULL
        AND r.notif_5min_enviada = false
        AND u.push_token IS NOT NULL
        AND r.chegada_declarada_em IS NULL
        AND r.chegada_confirmada_em IS NULL
        AND COALESCE(r.chegada_prevista_em, r.expira_em) BETWEEN NOW() AND NOW() + INTERVAL '5 minutes'
      RETURNING r.id, r.titulo, u.push_token
    `)

    if (cincoMin.rows.length > 0) {
      for (const reparo of cincoMin.rows) {
        await enviarPushNotificacao(
          reparo.push_token,
          '⏰ O prestador ainda não chegou?',
          'Faltam 5 minutos. Se ele ainda não chegou, você pode aumentar o prazo ou aguardar o cronômetro zerar.',
          { tipo: 'reparo_5min_restantes', reparo_id: reparo.id }
        )
      }
    }

    // (b) Cronômetro zerou → devolve o reparo ao feed e limpa o match,
    // reiniciando a contagem com o prazo original configurado na criação.
    // status = 'aberta' no WHERE (espelha o cron de obras): sem ele, um reparo já
    // ENCERRADO com expira_em vencido seria ressuscitado para o feed e perderia o
    // match. Reparo casado permanece 'aberta' (/reparos/:id/match não mexe no status),
    // então o filtro não exclui nenhuma linha legítima do cronômetro.
    // SELECT antes do UPDATE porque RETURNING devolve a linha NOVA, em que match_usuario_id já
    // é NULL — e é justamente ele que precisamos para bloquear e notificar o prestador. O mesmo
    // predicado vai nos dois: o UPDATE continua sendo quem decide (linha que deixar de casar
    // entre as duas queries simplesmente não é atualizada e não gera push).
    // prazo_atendimento_horas NULL NÃO exclui mais a linha (D73 — paridade com o cron de obras):
    // o prazo pós-match é COALESCE(chegada_prevista_em, expira_em), que independe da coluna;
    // o filtro só servia para proteger o rebuild abaixo de "NULL * interval", e isso agora é
    // COALESCE. Com o filtro, um reparo casado com prazo NULL ficava com match eterno: sem
    // aviso de 5 min, sem voltar ao feed e sem falta.
    // SQL_ESPERA_COMPARECIMENTO (utils/agendamento): horário AGENDADO vencido espera a resposta
    // do dono à vigia ('nao' libera na hora; sem resposta, 24h depois do horário). Janela de
    // rótulo antigo ou sem janela: sem espera, como sempre.
    const PRED_EXPIRADOS_REPAROS = `
      status = 'aberta'
        AND match_usuario_id IS NOT NULL
        AND chegada_declarada_em IS NULL
        AND chegada_confirmada_em IS NULL
        AND COALESCE(chegada_prevista_em, expira_em) <= NOW()
        AND ${SQL_ESPERA_COMPARECIMENTO}`

    // chegada_recusada_em/chegada_prevista_em entram no SELECT para a ISENÇÃO: match que morre
    // depois de o dono recusar a janela, e sem nenhuma outra valendo, não gera falta nem bloqueio.
    // chegada_proposta_por: de quem era a pendência (só a do profissional isenta).
    const candidatos = await pool.query(`
      SELECT id, titulo, criado_por, match_usuario_id,
             chegada_recusada_em, chegada_pendente_em, chegada_prevista_em, chegada_proposta_por
        FROM reparos WHERE ${PRED_EXPIRADOS_REPAROS}
    `)

    let expiradosCount = 0
    if (candidatos.rows.length > 0) {
      const expirados = await pool.query(`
        WITH desfeitos AS (
          UPDATE reparos SET
            status = 'aberta',
            match_feito_em = NULL,
            match_usuario_id = NULL,
            notif_5min_enviada = false,
            -- Mesmo re-armamento do lado obra (ver o comentário lá): sem isto o reparo volta
            -- ao feed com prazo novo e marcos velhos, e não recebe aviso de expiração nenhum.
            marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL,
            pedido_tempo_status = NULL,
            pedido_tempo_motivo = NULL,
            pedido_tempo_minutos = NULL,
            chegada_janela = NULL,
            chegada_prevista_em = NULL,
            chegada_declarada_por = NULL,
            chegada_declarada_em = NULL,
            chegada_pendente_janela = NULL,
            chegada_pendente_em = NULL,
            chegada_recusada_em = NULL,
            ${SQL_ZERAR_AGENDA},
            prestadores_bloqueados = CASE
              -- Isenção (SQL_ISENCAO_FALTA): janela que nunca virou compromisso — recusada pelo
              -- dono OU proposta DO PROFISSIONAL morta sem resposta — e nenhuma outra valendo.
              WHEN ${SQL_ISENCAO_FALTA}
              THEN prestadores_bloqueados
              WHEN match_usuario_id = ANY(COALESCE(prestadores_bloqueados, '{}'))
              THEN prestadores_bloqueados
              ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), match_usuario_id) END,
            -- Faixa "Hoje": devolver ao feed NÃO pode dar 24h novas a quem escolheu "hoje" —
            -- o prazo volta a ser o fim do dia CORRENTE (o dia em que o match morreu).
            -- Sem este CASE, o cron reconstruiria a partir de prazo_atendimento_horas.
            -- COALESCE(prazo_atendimento_horas, 720): mesma rede do cron de obras. 720h é o
            -- default do PRÓPRIO create de reparo quando o cliente não manda prazo
            -- (index.js: horasExpiracao = prazo || 720) e o que verificarMarcosExpiracao já
            -- assume para reparo com prazo NULL — a segunda vida da linha ganha a mesma janela
            -- da primeira, e os dois crons leem o mesmo número para a mesma linha.
            -- O dia é o do DONO (reparos.prazo_timezone, D78), como no cron de obras — não o de SP.
            expira_em = CASE WHEN prazo_modo = '${PRAZO_MODO_HOJE}' THEN ${sqlFimDoDia(SQL_ZONA_DO_REPARO)}
                             ELSE NOW() + (COALESCE(prazo_atendimento_horas, 720) * INTERVAL '1 hour') END
          WHERE id = ANY($1::uuid[]) AND ${PRED_EXPIRADOS_REPAROS}
          RETURNING id
        ), propostas AS (
          -- A proposta vencedora expira JUNTO com o match, no mesmo statement: enquanto ela
          -- ficava 'aceito' o serviço voltava ao feed mas nenhum aceite novo passava
          -- (interesse_reparos_aceito_unico_idx ocupado + guard jaAceito → 409).
          -- O par (reparo, prestador) vem dos dois arrays paralelos porque o RETURNING acima já
          -- traz match_usuario_id NULL; o IN no CTE desfeitos limita aos reparos que o UPDATE
          -- realmente pegou, então quem escapou do predicado na corrida não é tocado.
          UPDATE interesse_reparos ir SET status = 'expirado'
            FROM unnest($1::uuid[], $2::uuid[]) AS alvo(reparo_id, usuario_id)
           WHERE ir.reparo_id = alvo.reparo_id AND ir.usuario_id = alvo.usuario_id
             AND ir.status = 'aceito'
             AND alvo.reparo_id IN (SELECT id FROM desfeitos)
          RETURNING ir.id
        )
        SELECT id FROM desfeitos
      `, [candidatos.rows.map(c => c.id), candidatos.rows.map(c => c.match_usuario_id)])
      expiradosCount = expirados.rows.length

      // Só notifica e contabiliza falta para quem o UPDATE realmente pegou. Os dois lados
      // continuam sendo avisados do fim do match mesmo na isenção — o que muda é só a punição.
      // try/catch POR LINHA: notificarMatchDesfeito faz query de token e pode estourar. Sem o
      // guard, uma linha ruim jogava para o catch da função e as SEGUINTES ficavam sem aviso e
      // sem falta, com o un-match já commitado para todas. registrarFalta já se protege sozinha.
      const atualizados = new Set(expirados.rows.map(r => r.id))
      for (const c of candidatos.rows) {
        if (!atualizados.has(c.id)) continue
        try {
          await notificarMatchDesfeito('reparos', c)
        } catch (err) {
          console.error(`[CronômetroReparos] falha ao notificar match desfeito ${c.id}:`, err.message)
        }
        if (!isentoPorRecusa(c)) await registrarFalta('reparos', c)
      }
    }

    console.log(`[CronômetroReparos] 5min notificados: ${cincoMin.rows.length} | matches expirados (devolvidos ao feed): ${expiradosCount}`)
  } catch (err) {
    console.error('Erro ao verificar cronômetro de reparos:', err.message)
  }
})

// Cronômetro de matches de obras — espelha verificarCronometroReparos com as colunas reais de obra.
// Prazo pós-match: COALESCE(chegada_prevista_em, expira_em) — a janela prometida pelo pintor
// manda quando existe; sem ela, segue o expira_em ORIGINAL (o match não reseta expira_em).
// (a) A 5 minutos do fim: avisa o dono uma única vez por match (notif_5min_enviada).
// (b) Quando o prazo zera: devolve a obra ao feed e limpa o match, reiniciando a janela
//     PRÉ-match (horas_para_expirar) para a próxima rodada de candidatos.
// Chegada declarada ou confirmada congela os dois ramos (mesma regra do cron de reparos).
const verificarCronometroObras = semSobreposicao('verificarCronometroObras', async () => {
  try {
    // (a) 5 minutos restantes → notifica o dono (uma vez por match).
    // CLAIM atômico (A7) — ver o comentário no cron de reparos: o UPDATE decide, RETURNING avisa.
    const cincoMin = await pool.query(`
      UPDATE obras o SET notif_5min_enviada = true
      FROM usuarios u
      WHERE u.id = o.criado_por
        AND o.status = 'aberta'
        AND o.match_usuario_id IS NOT NULL
        AND o.notif_5min_enviada = false
        AND u.push_token IS NOT NULL
        AND o.chegada_declarada_em IS NULL
        AND o.chegada_confirmada_em IS NULL
        AND COALESCE(o.chegada_prevista_em, o.expira_em) BETWEEN NOW() AND NOW() + INTERVAL '5 minutes'
      RETURNING o.id, o.titulo, u.push_token
    `)

    if (cincoMin.rows.length > 0) {
      for (const obra of cincoMin.rows) {
        await enviarPushNotificacao(
          obra.push_token,
          '⏰ O pintor ainda não chegou?',
          'Faltam 5 minutos. Se ele ainda não chegou, você pode aumentar o prazo ou aguardar o cronômetro zerar.',
          { tipo: 'obra_5min_restantes', obra_id: obra.id }
        )
      }
    }

    // (b) Cronômetro zerou → devolve a obra ao feed e limpa o match, reiniciando a contagem
    // com a janela original. COALESCE(horas_para_expirar, 720): horas_para_expirar pode ser NULL
    // em obras legadas; sem o COALESCE, NOW() + NULL = NULL e a obra sumiria do feed para sempre
    // (expira_em > NOW() nunca casa NULL). 720h = default de criação (mesma base de index.js:960).
    // SELECT antes do UPDATE pelo mesmo motivo do cron de reparos: RETURNING traz a linha nova,
    // com match_usuario_id já NULL, e é ele que precisamos para bloquear e notificar o pintor.
    // SQL_ESPERA_COMPARECIMENTO: mesma espera pela resposta à vigia do cron de reparos.
    const PRED_EXPIRADOS_OBRAS = `
      status = 'aberta'
        AND match_usuario_id IS NOT NULL
        AND chegada_declarada_em IS NULL
        AND chegada_confirmada_em IS NULL
        AND COALESCE(chegada_prevista_em, expira_em) <= NOW()
        AND ${SQL_ESPERA_COMPARECIMENTO}`

    // Mesma isenção do cron de reparos (ver isentoPorRecusa).
    const candidatos = await pool.query(`
      SELECT id, titulo, criado_por, match_usuario_id,
             chegada_recusada_em, chegada_pendente_em, chegada_prevista_em, chegada_proposta_por
        FROM obras WHERE ${PRED_EXPIRADOS_OBRAS}
    `)

    let expiradosCount = 0
    if (candidatos.rows.length > 0) {
      const expirados = await pool.query(`
        WITH desfeitos AS (
          UPDATE obras SET
            status = 'aberta',
            match_feito_em = NULL,
            match_usuario_id = NULL,
            notif_5min_enviada = false,
            -- Marcos re-armados junto com o expira_em novo, exatamente como POST
            -- /obras/:id/estender já faz: a obra volta ao feed com prazo novo, então os 3
            -- avisos de expiração precisam valer de novo. Sem isto ela carregava os marcos
            -- já gastos da PRIMEIRA vida e não recebia aviso nenhum na segunda — o candidato
            -- da query de marcos exige ao menos um marco NULL, então ela nem era varrida.
            marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL,
            -- pedido_tempo_* zerados como o cron de reparos já fazia (D76): sem isto a obra
            -- voltava ao feed carregando o pedido de tempo do pintor que furou, e o próximo
            -- match nascia "aguardando aprovação" de alguém que já saiu.
            pedido_tempo_status = NULL,
            pedido_tempo_motivo = NULL,
            pedido_tempo_minutos = NULL,
            chegada_janela = NULL,
            chegada_prevista_em = NULL,
            chegada_declarada_por = NULL,
            chegada_declarada_em = NULL,
            chegada_pendente_janela = NULL,
            chegada_pendente_em = NULL,
            chegada_recusada_em = NULL,
            ${SQL_ZERAR_AGENDA},
            prestadores_bloqueados = CASE
              -- Isenção (SQL_ISENCAO_FALTA): janela que nunca virou compromisso — recusada pelo
              -- dono OU proposta DO PROFISSIONAL morta sem resposta — e nenhuma outra valendo.
              WHEN ${SQL_ISENCAO_FALTA}
              THEN prestadores_bloqueados
              WHEN match_usuario_id = ANY(COALESCE(prestadores_bloqueados, '{}'))
              THEN prestadores_bloqueados
              ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), match_usuario_id) END,
            -- Faixa "Hoje" — mesma regra do cron de reparos: volta ao fim do dia corrente,
            -- nunca a horas_para_expirar novas. O dia é o do DONO (prazo_timezone), não o de
            -- São Paulo: para um dono em Rio Branco o cron resolveria o dia errado.
            expira_em = CASE WHEN prazo_modo = '${PRAZO_MODO_HOJE}' THEN ${sqlFimDoDia(SQL_ZONA_DA_OBRA)}
                             ELSE NOW() + (COALESCE(horas_para_expirar, 720) * INTERVAL '1 hour') END
          WHERE id = ANY($1::uuid[]) AND ${PRED_EXPIRADOS_OBRAS}
          RETURNING id
        ), propostas AS (
          -- Candidatura vencedora expira junto com o match (ver o cron de reparos para o
          -- porquê dos dois arrays paralelos e do IN no CTE desfeitos).
          UPDATE candidaturas c SET status = 'expirado'
            FROM unnest($1::uuid[], $2::uuid[]) AS alvo(obra_id, usuario_id)
           WHERE c.obra_id = alvo.obra_id AND c.usuario_id = alvo.usuario_id
             AND c.status = 'aceito'
             AND alvo.obra_id IN (SELECT id FROM desfeitos)
          RETURNING c.id
        )
        SELECT id FROM desfeitos
      `, [candidatos.rows.map(c => c.id), candidatos.rows.map(c => c.match_usuario_id)])
      expiradosCount = expirados.rows.length

      // try/catch por linha pelo mesmo motivo do cron de reparos.
      const atualizados = new Set(expirados.rows.map(o => o.id))
      for (const c of candidatos.rows) {
        if (!atualizados.has(c.id)) continue
        try {
          await notificarMatchDesfeito('obras', c)
        } catch (err) {
          console.error(`[CronômetroObras] falha ao notificar match desfeito ${c.id}:`, err.message)
        }
        if (!isentoPorRecusa(c)) await registrarFalta('obras', c)
      }
    }

    console.log(`[CronômetroObras] 5min notificados: ${cincoMin.rows.length} | matches expirados (devolvidos ao feed): ${expiradosCount}`)
  } catch (err) {
    console.error('Erro ao verificar cronômetro de obras:', err.message)
  }
})

// Encerramento assimétrico: fecha sozinho a solicitação do profissional que o dono não
// confirmou no prazo. Sem isto um dono silencioso deixaria a demanda pendente para sempre.
// status = 'aberta' no WHERE (mesma lição do cron de reparos): a demanda só é candidata
// enquanto NÃO está encerrada. Notifica quem NÃO pediu — quem pediu já sabe.
//
// O prazo é POR TABELA, como já era o da chegada: um serviço é trabalho curto, começa e
// termina no mesmo dia, e 3h de espera pela confirmação do dono cabem dentro dele; uma obra
// corre noutra cadência, e fechar a solicitação do profissional em 3h ali seria errado — por
// isso a obra mantém os 2 dias originais. O sufixo de cada constante é o nome da tabela a
// que ela se aplica (lado.tabela), então casar constante e lado não exige tradução nenhuma.
const AUTO_ENCERRAR_APOS_OBRAS   = '2 days'
const AUTO_ENCERRAR_APOS_REPAROS = '3 hours'

// Rótulo pt-BR DERIVADO do próprio INTERVAL aplicado, em vez de escrito à mão ao lado dele:
// o push anuncia exatamente o prazo que o WHERE cobra, e não há um segundo valor para
// esquecer de mudar. Cobre as unidades usadas aqui; qualquer outra cai no fallback e o push
// sai com o intervalo cru, o que é feio mas não quebra o encerramento (já commitado).
const UNIDADES_PRAZO = { day: ['dia', 'dias'], hour: ['hora', 'horas'], minute: ['minuto', 'minutos'] }
const rotuloPrazo = (intervalo) => {
  const [qtd, unidade = ''] = intervalo.split(' ')
  const par = UNIDADES_PRAZO[unidade.replace(/s$/, '')]
  return par ? `${qtd} ${Number(qtd) === 1 ? par[0] : par[1]}` : intervalo
}

// Auto-confirmação da chegada: o profissional declarou, o dono nunca respondeu. Vencido o
// prazo a declaração vale por si — sem isto a demanda fica travada em "declarada mas não
// confirmada" para sempre (e, como chegada_declarada_em congela os dois crons, também nunca
// volta ao feed). O prazo é POR TABELA (chegadaApos): um reparo é uma visita curta, e 6h de
// limbo cobriam o serviço inteiro; uma obra se mede em horas e mantém as 6h de antes.
// chegadaRotulo anda junto do intervalo porque o mesmo prazo aparece no texto do push — se
// só um dos dois mudasse, o profissional seria avisado de um prazo que não é o aplicado.

const autoEncerrarPendentes = async () => {
  // tabela, coluna de id e prazos saem desta lista literal, nunca do request — interpolação segura.
  const lados = [
    { tabela: 'obras',   chave: 'obra_id',   tipoPush: 'obra_encerrada',    rotulo: 'a obra',
      encerrarApos: AUTO_ENCERRAR_APOS_OBRAS,
      chegadaApos: '6 hours',   chegadaRotulo: '6 horas' },
    { tabela: 'reparos', chave: 'reparo_id', tipoPush: 'reparo_encerrado',  rotulo: 'o serviço',
      encerrarApos: AUTO_ENCERRAR_APOS_REPAROS,
      chegadaApos: '30 minutes', chegadaRotulo: '30 minutos' }
  ]
  for (const lado of lados) {
    try {
      const fechados = await pool.query(`
        UPDATE ${lado.tabela} SET
          status = 'encerrada',
          status_aprovacao = 'encerrada',
          encerrado_em = NOW(),
          encerramento_solicitado_por = NULL,
          encerramento_solicitado_em = NULL
        WHERE status = 'aberta'
          AND encerramento_solicitado_por IS NOT NULL
          AND encerramento_solicitado_em <= NOW() - INTERVAL '${lado.encerrarApos}'
        RETURNING id, titulo, criado_por, match_usuario_id, encerramento_solicitado_por
      `)
      for (const d of fechados.rows) {
        // Quem NÃO solicitou é quem precisa ser avisado do fechamento automático.
        const avisarId = d.encerramento_solicitado_por === d.criado_por ? d.match_usuario_id : d.criado_por
        if (!avisarId) continue
        const alvo = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [avisarId])
        if (alvo.rows[0]?.push_token) {
          enviarPushNotificacao(alvo.rows[0].push_token, '✅ Encerrado automaticamente',
            `Sem confirmação em ${rotuloPrazo(lado.encerrarApos)}, ${lado.rotulo} "${d.titulo}" foi encerrad${lado.tabela === 'obras' ? 'a' : 'o'} automaticamente.`,
            { tipo: lado.tipoPush, [lado.chave]: d.id }).catch(() => {})
        }
      }
      if (fechados.rows.length > 0) {
        console.log(`[AutoEncerrar] ${lado.tabela}: ${fechados.rows.length} encerrad(a)s por falta de confirmação`)
      }

      // Chegada declarada há mais do que o prazo da tabela e nunca confirmada pelo dono →
      // confirma sozinho. Query separada (não um SET a mais no UPDATE acima): são regras
      // independentes — encerramento em duas mãos vs. chegada em duas mãos — com prazos e
      // predicados próprios, e a maioria das linhas candidatas a uma não é candidata à outra.
      // A3 (auditoria externa): só confirma chegada de demanda ABERTA, COM match, e declarada
      // por um dos dois participantes. Sem isto o job mutava demandas canceladas/encerradas
      // ou sem profissional (chegada órfã) — estado terminal não pode ganhar confirmação.
      const chegadas = await pool.query(`
        UPDATE ${lado.tabela} SET chegada_confirmada_em = NOW()
        WHERE status = 'aberta'
          AND match_usuario_id IS NOT NULL
          AND chegada_declarada_em IS NOT NULL
          AND chegada_confirmada_em IS NULL
          AND chegada_declarada_por IN (criado_por, match_usuario_id)
          AND chegada_declarada_em <= NOW() - INTERVAL '${lado.chegadaApos}'
        RETURNING id, titulo, match_usuario_id
      `)
      for (const c of chegadas.rows) {
        // Avisa o profissional, fechando a lacuna: era o ÚNICO caminho de confirmação que
        // não notificava ninguém. tipo 'chegada_confirmada' é o mesmo do POST /:id/chegada
        // (o app trata os dois igual); só o texto muda, porque aqui o dono NÃO confirmou —
        // venceu o prazo. Mesma construção do aviso de encerramento automático acima.
        if (!c.match_usuario_id) continue
        const prof = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [c.match_usuario_id])
        if (prof.rows[0]?.push_token) {
          enviarPushNotificacao(prof.rows[0].push_token, '✅ Chegada confirmada!',
            `Sem confirmação do solicitante em ${lado.chegadaRotulo}, sua chegada em "${c.titulo}" foi confirmada automaticamente.`,
            { tipo: 'chegada_confirmada', [lado.chave]: c.id }).catch(() => {})
        }
      }
      if (chegadas.rows.length > 0) {
        console.log(`[AutoConfirmarChegada] ${lado.tabela}: ${chegadas.rows.length} chegada(s) confirmada(s) por decurso de prazo`)
      }
    } catch (err) {
      console.error(`[AutoEncerrar] Erro em ${lado.tabela}:`, err.message)
    }
  }
}

module.exports = {
  semSobreposicao,
  enviarPushNotificacao,
  // Exportada para o painel admin (POST /admin/notificacoes/enviar): mesmo lote, recibos e
  // limpeza de token morto do broadcast de demanda nova.
  enviarPushEmLoteDetalhado,
  enviarBoasVindas,
  notificarPintoresSobreNovaObra,
  notificarPrestadoresSobreNovoReparo,
  notificarOfertaAumentadaObra,
  notificarOfertaAumentadaReparo,
  notificarDonoSobreAnaliseObra,
  dispararPushNovoComClaim,
  enviarEmailsNovaDemanda,
  montarEmailNovaDemanda,
  EMAIL_ALERTAS_TETO_DIA,
  enviarPushNovoPendente,
  lembrarDemandasSemResposta,
  listarCandidatosLembrete,
  sqlClaimLembrete,
  LADOS_LEMBRETE,
  avisarMatchFeito,
  lembrarPrazoChegada,
  lembrarAgendamento,
  lembrarAgendarAtendimento,
  sqlClaimAgendar,
  OFFSETS_AGENDAR,
  entregarPushOuEmail,
  lembrarRespostaHorario,
  sqlClaimRespostaHorario,
  LEMBRETES_RESPOSTA,
  vigiarComparecimento,
  listarLembretesPrazoChegada,
  sqlClaimLembreteChegada,
  tituloLembreteChegada,
  LADOS_MATCH,
  verificarObrasExpirando,
  verificarObrasComBaixoEngajamento,
  verificarMarcosExpiracao,
  verificarCronometroReparos,
  verificarCronometroObras,
  autoEncerrarPendentes,
  // Exportadas para o painel admin (GET /admin/suspensos e o liberar) usarem EXATAMENTE a mesma
  // janela e o mesmo limite que o cron aplica — antes a rota tinha uma cópia '90 days' própria,
  // que passaria a mentir na primeira vez que este valor mudasse.
  JANELA_FALTAS,
  FALTAS_PARA_SUSPENDER
}