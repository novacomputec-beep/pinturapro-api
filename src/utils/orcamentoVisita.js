// PROPOSTA DE VISITA PARA ORÇAMENTO (dono, 26/11/2026 — arte aprovada "orcamento-previa"). Vale
// para os DOIS lados: candidaturas (obras) e interesse_reparos (reparos).
//
// 1) ENVIAR (POST /obras/:id/candidatura, POST /reparos/:id/interesse) — só com
//    suporta_orcamento: true no corpo (app antigo segue exatamente como era):
//      tipo_proposta 'valor' (padrão): os campos de sempre; valor_proposto, quando vem, tem de ser
//        >= R$ 20 → senão 400 VALOR_MINIMO;
//      tipo_proposta 'visita': visita_quando (data + hora, obrigatória, no futuro), visita_gratis
//        e visita_valor (obrigatório e > 0 quando não é grátis). Não leva valor_proposto.
// 2) DONO ACEITA A VISITA (…/responder, action 'aceitar_visita' — ou 'aceitar' numa visita ainda
//    sem orçamento, que é o que o app antigo manda): status 'visita_aceita'; o pedido CONTINUA
//    ABERTO para os demais; o endereço completo aparece só para esse profissional; ele recebe
//    "📋 Visita aceita: {título}". Recusar ('recusar') segue como sempre.
// 3) PROFISSIONAL MANDA O ORÇAMENTO (POST …/orcamento, só em 'visita_aceita'): valor (>= R$ 20),
//    prazo_dias, data_inicio, observacao → status 'orcamento_enviado', valor_proposto = valor; o
//    dono recebe "💰 Orçamento recebido: {título}". Aceitar ('aceitar') é o aceite de SEMPRE
//    (match, demais propostas recusadas, avaliações); recusar não mexe em mais nada.
// 4) LEMBRETE (job de server.js): no dia seguinte ao da visita, sem orçamento enviado → um push,
//    uma vez, fora do silêncio noturno (22h–7h): "Mande o orçamento do pedido {título}".
// 5) APP ANTIGO (não manda suporta_orcamento) vendo uma visita: a coluna `mensagem` guarda um texto
//    LEGÍVEL montado aqui ("📋 Visita para orçamento (grátis) · sáb., 28/11 às 14:00. …") e o que o
//    profissional escreveu fica em mensagem_original; valor_proposto sai como o valor da visita
//    (0 quando grátis) até existir orçamento — nunca nulo, que o app antigo leria como "aceitou o
//    valor do pedido". O app novo usa os campos estruturados e mensagem_profissional.
// 6) LEITURA: anexarCamposProposta põe em cada proposta tipo_proposta, visita_*, orcamento_* e
//    mensagem_profissional (nunca lança; esquema sem as colunas → tudo 'valor'/null).
// 7) PÓS-VISITA ('contratei', aviso na hora da visita, contratou_visitante, visitante_ativo): ver o
//    bloco "PÓS-VISITA" no fim do arquivo.
// 8) AJUSTES DA VISITA (27/11/2026): orçamento e 'contratei' só a partir de visita_quando (409
//    ORCAMENTO_ANTES_DA_VISITA / CONTRATEI_INDISPONIVEL; desde 28/11 o orçamento libera 1h antes, em
//    orcamento_libera_em), pode_enviar_orcamento, orcamento_libera_em e pode_contratei em
//    cada proposta, GET /me/pendencias (pendenciasDoUsuario) e endereço liberado ao profissional do
//    match que veio de uma visita (visitaLiberaEndereco).
const { pool } = require('./supabase')
const { GRUPOS_RELACIONADOS } = require('./gruposCategorias')
const { GRUPO_OBRAS_REPARADOR } = require('./especialidades')
const { categoriasDoReparo } = require('./categoriasApp')

const VALOR_MINIMO = 20
const TZ = 'America/Sao_Paulo'
const TIPO_VALOR = 'valor'
const TIPO_VISITA = 'visita'
const STATUS_VISITA_ACEITA = 'visita_aceita'
const STATUS_ORCAMENTO_ENVIADO = 'orcamento_enviado'
// Em negociação além de 'pendente'/'contraproposta_dono': contam como interessado ativo, recebem
// os avisos de prazo/reabertura e podem ser recusados pelo dono.
const STATUS_ORCAMENTO = [STATUS_VISITA_ACEITA, STATUS_ORCAMENTO_ENVIADO]
// Com estes status (numa proposta de visita) o profissional vê o endereço completo do pedido.
const STATUS_COM_ENDERECO = STATUS_ORCAMENTO
const MAX_OBSERVACAO = 500
const MAX_PRAZO_DIAS = 365

const LADOS = {
  obras:   { tabela: 'obras',   proposta: 'candidaturas',      fk: 'obra_id',   chave: 'obra_id',   idPush: 'candidatura_id', rotulo: 'obras' },
  reparos: { tabela: 'reparos', proposta: 'interesse_reparos', fk: 'reparo_id', chave: 'reparo_id', idPush: 'interesse_id',   rotulo: 'reparos' },
}

// QUAIS PEDIDOS ACEITAM VISITA (dono, 26/11/2026). Toda OBRA aceita. Um serviço (reparo) aceita
// quando ALGUMA das suas categorias está em: "Obras de Construção Civil" (as 6 especialidades do
// grupo e os 4 papéis de obra), "Consertos da casa", "Limpeza e jardim", ou é mudancas,
// placas_fachadas, decoracao_festas ou outros. As listas vêm das canônicas (gruposCategorias,
// especialidades): categoria nova num desses grupos passa a aceitar visita sozinha. Fora disso, a
// proposta de visita leva 400 VISITA_NAO_PERMITIDA; permite_visita sai no detalhe e no feed.
const GRUPOS_COM_VISITA = ['Obras de Construção Civil', 'Consertos da casa', 'Limpeza e jardim']
const AVULSAS_COM_VISITA = ['mudancas', 'placas_fachadas', 'decoracao_festas', 'outros']
const SLUGS_COM_VISITA = Object.freeze([...new Set([
  ...GRUPOS_COM_VISITA.flatMap(g => { if (!GRUPOS_RELACIONADOS[g]) throw new Error(`orcamentoVisita: grupo "${g}" não existe`); return GRUPOS_RELACIONADOS[g] }),
  ...GRUPO_OBRAS_REPARADOR.categorias, ...AVULSAS_COM_VISITA])])
const CONJUNTO_COM_VISITA = new Set(SLUGS_COM_VISITA)
const permiteVisita = (tabela, demanda) => tabela === 'obras' || categoriasDoReparo(demanda).some(s => CONJUNTO_COM_VISITA.has(s))
// permite_visita em cada linha (reparo: precisa de categoria/categorias na linha). Muta e devolve.
const anexarPermiteVisita = (tabela, linhas) => {
  for (const l of (Array.isArray(linhas) ? linhas : [linhas])) if (l) l.permite_visita = permiteVisita(tabela, l)
  return linhas
}
const ERRO_VISITA_NAO_PERMITIDA = Object.freeze({ erro: 'Este tipo de pedido aceita apenas valor fechado.', codigo: 'VISITA_NAO_PERMITIDA' })

const ERRO_VALOR_MINIMO = Object.freeze({
  erro: 'Valor abaixo de R$ 20. Se ainda não sabe o preço, envie uma visita para orçamento.', codigo: 'VALOR_MINIMO', valor_minimo: VALOR_MINIMO })
const ERRO_ORCAMENTO_MINIMO = Object.freeze({ erro: 'O orçamento precisa ser de pelo menos R$ 20.', codigo: 'VALOR_MINIMO', valor_minimo: VALOR_MINIMO })
const erro = (mensagem, codigo) => ({ erro: mensagem, codigo })

const suporta = (body) => body?.suporta_orcamento === true || body?.suporta_orcamento === 'true'
const vazio = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim())
const numero = (v) => {
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return NaN
  return Number(v.trim().replace(',', '.'))
}
// Data + hora: ISO com fuso ("2026-11-28T14:00:00-03:00", "…Z") ou sem fuso, lida como horário de
// Brasília ("2026-11-28T14:00", "2026-11-28 14:00"). Devolve Date ou null.
const lerDataHora = (v) => {
  if (typeof v !== 'string' || !v.trim()) return null
  let s = v.trim().replace(' ', 'T')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += '-03:00'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

const fmtDia = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' })
const fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const fmtDiaMes = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' })
// "sáb., 28/11 às 14:00"
const quandoLegivel = (quando) => { const d = new Date(quando); return `${fmtDia.format(d)} às ${fmtHora.format(d)}` }
const reais = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
// 'YYYY-MM-DD' (date) → "02/12", sem passar por fuso.
const diaMesDaData = (data) => { const [, m, d] = String(data).slice(0, 10).split('-'); return `${d}/${m}` }
const hojeEmSaoPaulo = (agora = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(agora)

// O texto que o app ANTIGO mostra no lugar da mensagem (o novo usa os campos estruturados).
const textoVisita = ({ visita_gratis, visita_valor, visita_quando }, mensagem) =>
  [`📋 Visita para orçamento (${visita_gratis ? 'grátis' : reais(visita_valor)}) · ${quandoLegivel(visita_quando)}. O valor do serviço vem depois da visita.`,
   vazio(mensagem) ? null : String(mensagem).trim()].filter(Boolean).join('\n')
// No app antigo o cartão de 'orcamento_enviado' não tem botão: o texto diz o que fazer.
const AVISO_APP_ANTIGO = '(Atualize o app ProTudo para aceitar ou recusar este orçamento.)'
const textoOrcamento = ({ valor, prazo_dias, data_inicio, observacao }) =>
  [`💰 Orçamento: ${reais(valor)} · prazo de ${prazo_dias} ${prazo_dias === 1 ? 'dia' : 'dias'} · início em ${diaMesDaData(data_inicio)}.`,
   vazio(observacao) ? null : String(observacao).trim(), AVISO_APP_ANTIGO].filter(Boolean).join('\n')

// Corpo de POST candidatura/interesse → { legado: true } (app antigo: nada muda), { erro } (400)
// ou { tipo, valor_proposto?, visita_gratis?, visita_valor?, visita_quando? }.
const lerProposta = (body, agora = new Date()) => {
  if (!suporta(body)) return { legado: true, tipo: TIPO_VALOR }
  const tipo = vazio(body.tipo_proposta) ? TIPO_VALOR : body.tipo_proposta
  if (tipo !== TIPO_VALOR && tipo !== TIPO_VISITA) return { erro: erro("tipo_proposta deve ser 'valor' ou 'visita'", 'TIPO_PROPOSTA_INVALIDO') }
  if (tipo === TIPO_VALOR) {
    if (vazio(body.valor_proposto)) return { tipo }
    const n = numero(body.valor_proposto)
    if (!Number.isFinite(n) || n < VALOR_MINIMO) return { erro: ERRO_VALOR_MINIMO }
    return { tipo, valor_proposto: n }
  }
  const quando = lerDataHora(body.visita_quando)
  if (!quando) return { erro: erro('Informe o dia e a hora da visita.', 'VISITA_QUANDO_OBRIGATORIA') }
  if (quando.getTime() <= agora.getTime()) return { erro: erro('A visita precisa ser em um dia e hora futuros.', 'VISITA_NO_PASSADO') }
  const valor = vazio(body.visita_valor) ? null : numero(body.visita_valor)
  const gratis = body.visita_gratis === undefined || body.visita_gratis === null
    ? !(valor > 0) : (body.visita_gratis === true || body.visita_gratis === 'true')
  if (!gratis && !(Number.isFinite(valor) && valor > 0)) return { erro: erro('Informe o valor da visita, ou marque a visita como grátis.', 'VISITA_VALOR_OBRIGATORIO') }
  return { tipo, visita_gratis: gratis, visita_valor: gratis ? null : valor, visita_quando: quando.toISOString() }
}

// Corpo de POST …/orcamento → { erro } (400) ou { valor, prazo_dias, data_inicio, observacao }.
const lerOrcamento = (body, agora = new Date()) => {
  const valor = numero(body?.valor)
  if (!Number.isFinite(valor) || valor < VALOR_MINIMO) return { erro: ERRO_ORCAMENTO_MINIMO }
  const prazo = numero(typeof body?.prazo_dias === 'number' ? body.prazo_dias : String(body?.prazo_dias ?? ''))
  if (!Number.isInteger(prazo) || prazo < 1 || prazo > MAX_PRAZO_DIAS) return { erro: erro(`Informe o prazo em dias (de 1 a ${MAX_PRAZO_DIAS}).`, 'PRAZO_INVALIDO') }
  const data = typeof body?.data_inicio === 'string' ? body.data_inicio.trim().slice(0, 10) : ''
  const valida = /^\d{4}-\d{2}-\d{2}$/.test(data) && !Number.isNaN(new Date(`${data}T12:00:00Z`).getTime())
    && new Date(`${data}T12:00:00Z`).toISOString().slice(0, 10) === data
  if (!valida) return { erro: erro('Informe a data de início (AAAA-MM-DD).', 'DATA_INICIO_INVALIDA') }
  if (data < hojeEmSaoPaulo(agora)) return { erro: erro('A data de início não pode estar no passado.', 'DATA_INICIO_NO_PASSADO') }
  const obs = vazio(body?.observacao) ? null : String(body.observacao).trim()
  if (obs && obs.length > MAX_OBSERVACAO) return { erro: erro(`A observação deve ter no máximo ${MAX_OBSERVACAO} caracteres.`, 'OBSERVACAO_LONGA') }
  return { valor, prazo_dias: prazo, data_inicio: data, observacao: obs }
}

const ehVisita = (proposta) => proposta?.tipo_proposta === TIPO_VISITA
// Visita que ainda não virou orçamento: o 'aceitar' do dono aqui aceita a VISITA, não fecha negócio.
const visitaSemOrcamento = (proposta) => ehVisita(proposta) && ['pendente', STATUS_VISITA_ACEITA].includes(proposta.status)
// O profissional desta proposta vê o endereço completo? Visita aceita/orçamento enviado — e, AJUSTES
// DA VISITA (dono, 27/11/2026), o profissional do match que veio de uma visita (orçamento aceito ou
// 'contratei': proposta 'aceito'), já na hora, sem esperar o horário combinado. ehDoMatch é
// obrigatório para o 'aceito': match desfeito não deixa o endereço aberto.
const visitaLiberaEndereco = (proposta, ehDoMatch = false) =>
  ehVisita(proposta) && (STATUS_COM_ENDERECO.includes(proposta.status) || (ehDoMatch && proposta.status === 'aceito'))

// AJUSTES DA VISITA (dono, 27/11/2026 — arte aprovada "visita-ajustes-previa"): o orçamento e o
// 'contratei' só liberam a partir do horário da visita (visita_quando). Comparação de instantes; o
// texto do horário sai em America/Sao_Paulo.
const visitaJaChegou = (proposta, agora = new Date()) =>
  !!proposta?.visita_quando && new Date(proposta.visita_quando).getTime() <= agora.getTime()
// Visita aceita que já chegou ao horário: o dono pode 'contratei'.
const visitaNoHorario = (proposta, agora = new Date()) => ehVisita(proposta) && proposta.status === STATUS_VISITA_ACEITA && visitaJaChegou(proposta, agora)
// ORÇAMENTO 1h ANTES (dono, 28/11/2026): o profissional pode mandar o orçamento a partir de
// visita_quando − ANTECEDENCIA_ORCAMENTO_MS (orcamento_libera_em, calculado aqui e devolvido pela API
// — o app nunca calcula). O 'contratei' e o push "📋 Você está na visita?" seguem em visita_quando.
const ANTECEDENCIA_ORCAMENTO_MS = 60 * 60 * 1000
const orcamentoLiberaEm = (proposta) => {
  if (!proposta?.visita_quando) return null
  const t = new Date(proposta.visita_quando).getTime()
  return Number.isNaN(t) ? null : new Date(t - ANTECEDENCIA_ORCAMENTO_MS).toISOString()
}
const orcamentoLiberado = (proposta, agora = new Date()) => {
  const libera = orcamentoLiberaEm(proposta)
  return !!libera && new Date(libera).getTime() <= agora.getTime()
}
const podeEnviarOrcamento = (proposta, agora = new Date()) => ehVisita(proposta) && proposta.status === STATUS_VISITA_ACEITA && orcamentoLiberado(proposta, agora)
// "28/11 às 14h" (ou "28/11 às 14h30").
const quandoCurto = (quando) => {
  const d = new Date(quando)
  const [h, m] = fmtHora.format(d).split(':')
  return `${fmtDiaMes.format(d)} às ${h}h${m === '00' ? '' : m}`
}
const erroOrcamentoAntesDaVisita = (quando) => {
  const libera = orcamentoLiberaEm({ visita_quando: quando })
  return {
    erro: `O orçamento libera em ${quandoCurto(libera)}, 1 hora antes da visita.`, codigo: 'ORCAMENTO_ANTES_DA_VISITA',
    visita_quando: new Date(quando).toISOString(), orcamento_libera_em: libera }
}

const MSG_VISITA_ACEITA = 'Visita aceita! O profissional foi avisado e já vê o endereço. O pedido continua aberto para outras propostas.'
// Dono aceita a visita. `demanda` = { criado_por, titulo, status, match_usuario_id }; `proposta` = a
// linha inteira. dep = { estaSuspenso, prazoVencido, avisarUsuario, ERRO_ACEITE_SUSPENSO,
// ERRO_PRAZO_VENCIDO }. Devolve { status, body }.
const aceitarVisita = async ({ tabela, demandaId, demanda, proposta, donoId }, dep, db = pool) => {
  const lado = LADOS[tabela]
  if (!ehVisita(proposta)) return { status: 409, body: erro('Esta proposta não é uma visita para orçamento.', 'NAO_E_VISITA') }
  // Idempotência de retry (e o 'aceitar' repetido do app antigo): já aceita → sucesso, sem novo aviso.
  if (proposta.status === STATUS_VISITA_ACEITA) return { status: 200, body: { mensagem: 'Visita já aceita. Aguardando o orçamento do profissional.', status: STATUS_VISITA_ACEITA } }
  if (demanda.status !== 'aberta' || demanda.match_usuario_id) return { status: 409, body: erro('Este pedido não está mais aberto para negociação.', 'PEDIDO_FECHADO') }
  if (proposta.status !== 'pendente') return { status: 409, body: erro('Esta visita não está mais disponível para aceite.', 'VISITA_INDISPONIVEL') }
  if (await dep.prazoVencido(db, tabela, demandaId)) return { status: 409, body: dep.ERRO_PRAZO_VENCIDO }
  if (await dep.estaSuspenso(proposta.usuario_id)) return { status: 409, body: dep.ERRO_ACEITE_SUSPENSO }
  const upd = await db.query(
    `UPDATE ${lado.proposta} SET status = '${STATUS_VISITA_ACEITA}', visita_aceita_em = NOW() WHERE id = $1 AND status = 'pendente' RETURNING id`, [proposta.id])
  if (upd.rows.length === 0) return { status: 409, body: erro('Esta visita não está mais disponível para aceite.', 'VISITA_INDISPONIVEL') }
  dep.avisarUsuario(proposta.usuario_id, {
    ator_id: donoId,
    titulo: `📋 Visita aceita: ${demanda.titulo}`,
    corpo: `${quandoLegivel(proposta.visita_quando)}. O endereço completo já aparece no pedido.`,
    data: { tipo: 'visita_aceita', [lado.chave]: demandaId, [lado.idPush]: proposta.id, visita_quando: new Date(proposta.visita_quando).toISOString() },
    rotulo: `visita aceita ${lado.rotulo} ${demandaId}`,
  })
  return { status: 200, body: { mensagem: MSG_VISITA_ACEITA, status: STATUS_VISITA_ACEITA } }
}

// Profissional manda o orçamento, DENTRO da transação que travou o pedido (`client`). `orc` vem de
// lerOrcamento (observação já sanitizada por quem chama). Devolve { status, body, avisar? } —
// avisar() é chamado por quem chama DEPOIS do COMMIT.
const gravarOrcamento = async ({ tabela, demandaId, demanda, propostaId, usuarioId, orc, agora = new Date() }, dep, client) => {
  const lado = LADOS[tabela]
  const r = await client.query(`SELECT * FROM ${lado.proposta} WHERE id = $1 AND ${lado.fk} = $2 AND usuario_id = $3 FOR UPDATE`, [propostaId, demandaId, usuarioId])
  const p = r.rows[0]
  if (!p) return { status: 404, body: { erro: 'Proposta não encontrada' } }
  if (!ehVisita(p)) return { status: 409, body: erro('Esta proposta não é uma visita para orçamento.', 'NAO_E_VISITA') }
  if (p.status === STATUS_ORCAMENTO_ENVIADO) return { status: 409, body: erro('Você já enviou o orçamento deste pedido.', 'ORCAMENTO_JA_ENVIADO') }
  if (p.status !== STATUS_VISITA_ACEITA) return { status: 409, body: erro('O orçamento só pode ser enviado depois que o cliente aceita a visita.', 'VISITA_NAO_ACEITA') }
  if (!orcamentoLiberado(p, agora)) return { status: 409, body: erroOrcamentoAntesDaVisita(p.visita_quando) }
  const upd = await client.query(
    `UPDATE ${lado.proposta}
        SET status = '${STATUS_ORCAMENTO_ENVIADO}', valor_proposto = $2, orcamento_prazo_dias = $3, orcamento_data_inicio = $4::date,
            orcamento_observacao = $5, orcamento_enviado_em = NOW(), mensagem = $6
      WHERE id = $1 RETURNING *`,
    [p.id, orc.valor, orc.prazo_dias, orc.data_inicio, orc.observacao, textoOrcamento(orc)])
  const linha = apresentar(upd.rows[0])
  return {
    status: 200, body: linha,
    avisar: () => dep.avisarUsuario(demanda.criado_por, {
      ator_id: usuarioId,
      titulo: `💰 Orçamento recebido: ${demanda.titulo}`,
      corpo: `${reais(orc.valor)} · prazo de ${orc.prazo_dias} ${orc.prazo_dias === 1 ? 'dia' : 'dias'} · início em ${diaMesDaData(orc.data_inicio)}. Toque para ver e responder.`,
      data: { tipo: 'orcamento_recebido', [lado.chave]: demandaId, [lado.idPush]: p.id },
      rotulo: `orçamento recebido ${lado.rotulo} ${demandaId}`,
    }),
  }
}

const CAMPOS_NULOS = Object.freeze({
  tipo_proposta: TIPO_VALOR, visita_gratis: null, visita_valor: null, visita_quando: null, visita_aceita_em: null,
  orcamento_valor: null, orcamento_prazo_dias: null, orcamento_data_inicio: null, orcamento_observacao: null, orcamento_enviado_em: null,
  pode_enviar_orcamento: false, orcamento_libera_em: null, pode_contratei: false,
})
// Os campos do payload a partir da linha do banco (muta e devolve). Serve ao RETURNING * e à leitura.
const apresentar = (linha, fonte = linha) => {
  if (!linha) return linha
  const visita = fonte.tipo_proposta === TIPO_VISITA
  const data = fonte.orcamento_data_inicio
  Object.assign(linha, {
    tipo_proposta: visita ? TIPO_VISITA : TIPO_VALOR,
    visita_gratis: visita ? fonte.visita_gratis === true : null,
    visita_valor: visita && fonte.visita_valor != null ? Number(fonte.visita_valor) : null,
    visita_quando: visita ? fonte.visita_quando ?? null : null,
    visita_aceita_em: visita ? fonte.visita_aceita_em ?? null : null,
    orcamento_valor: fonte.orcamento_enviado_em && fonte.valor_proposto != null ? Number(fonte.valor_proposto) : null,
    orcamento_prazo_dias: fonte.orcamento_prazo_dias ?? null,
    orcamento_data_inicio: data == null ? null : (data instanceof Date ? data.toISOString().slice(0, 10) : String(data).slice(0, 10)),
    orcamento_observacao: fonte.orcamento_observacao ?? null,
    orcamento_enviado_em: fonte.orcamento_enviado_em ?? null,
  })
  // Ajustes da visita: os mesmos testes de POST …/orcamento (1h antes) e do 'contratei' (no horário).
  const p = { tipo_proposta: fonte.tipo_proposta, status: fonte.status ?? linha.status, visita_quando: fonte.visita_quando }
  linha.pode_enviar_orcamento = podeEnviarOrcamento(p)
  linha.orcamento_libera_em = visita ? orcamentoLiberaEm(p) : null
  linha.pode_contratei = visitaNoHorario(p)
  // O que o profissional escreveu (na visita, `mensagem` é o texto montado para o app antigo).
  if ('mensagem' in fonte || visita) linha.mensagem_profissional = visita ? fonte.mensagem_original ?? null : fonte.mensagem ?? null
  // Visita ainda sem orçamento: valor_proposto nunca sai nulo (ver o item 5 do cabeçalho).
  if (visita && fonte.valor_proposto == null && 'valor_proposto' in linha) linha.valor_proposto = Number(fonte.visita_valor || 0)
  return linha
}

// Em cada proposta da lista (que tem `id`): tipo_proposta, visita_*, orcamento_*,
// mensagem_profissional. Nunca lança: banco sem as colunas (esquema de teste) → tudo 'valor'/null.
const anexarCamposProposta = async (tabela, linhas, db = pool) => {
  const lista = (Array.isArray(linhas) ? linhas : [linhas]).filter(l => l && l.id)
  for (const l of lista) Object.assign(l, CAMPOS_NULOS)
  const lado = LADOS[tabela]
  if (lista.length === 0 || !lado) return linhas
  try {
    const r = await db.query(
      `SELECT id, status, tipo_proposta, visita_gratis, visita_valor, visita_quando, visita_aceita_em, valor_proposto, mensagem, mensagem_original,
              orcamento_prazo_dias, orcamento_data_inicio::text AS orcamento_data_inicio, orcamento_observacao, orcamento_enviado_em
         FROM ${lado.proposta} WHERE id = ANY($1::uuid[])`, [lista.map(l => l.id)])
    const porId = new Map(r.rows.map(x => [x.id, x]))
    for (const l of lista) { const x = porId.get(l.id); if (x) apresentar(l, x) }
  } catch (err) {
    if (err.code !== '42703' && !/does not exist/.test(String(err.message))) console.error(`[orçamento] campos da proposta (${tabela}):`, err.message)
  }
  return linhas
}

const migrarOrcamentoVisita = async (client) => {
  for (const { proposta } of Object.values(LADOS)) {
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS tipo_proposta TEXT NOT NULL DEFAULT 'valor'`)
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS visita_gratis BOOLEAN`)
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS visita_valor NUMERIC(12,2)`)
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS visita_quando TIMESTAMPTZ`)
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS visita_aceita_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS mensagem_original TEXT`)
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS orcamento_prazo_dias INTEGER`)
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS orcamento_data_inicio DATE`)
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS orcamento_observacao TEXT`)
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS orcamento_enviado_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS orcamento_lembrete_em TIMESTAMPTZ`)
    // Visita aceita que o dono recusou depois: quando, e quando o profissional foi avisado.
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS visita_cancelada_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS visita_cancelada_aviso_em TIMESTAMPTZ`)
    // Pós-visita (arte pos-visita-previa): claim do "📋 Você está na visita?" e o valor que o dono
    // registrou no 'contratei' (também copiado para valor_proposto — é o que valorAcordado lê).
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS visita_hora_aviso_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE ${proposta} ADD COLUMN IF NOT EXISTS valor_combinado NUMERIC(12,2)`)
  }
  for (const { tabela } of Object.values(LADOS)) {
    // origem_match: 'contratado_apos_visita' quando o match veio do 'contratei'; NULL no aceite comum.
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS origem_match TEXT`)
    // Métrica: no cancelamento pelo dono de pedido com visitante ativo, ele contratou o visitante por fora?
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS contratou_visitante BOOLEAN`)
  }
}

// VISITA CANCELADA (dono, 26/11/2026): o dono recusa ('recusar') uma proposta em 'visita_aceita' →
// 'recusado' + visita_cancelada_em, e o profissional recebe "📋 Visita cancelada: {título}" (push +
// e-mail, o caminho de sempre) no lugar do aviso genérico de proposta não aceita. Fora do silêncio
// noturno (22h–7h de São Paulo) sai na hora; dentro dele fica devido e o job de server.js o envia a
// partir das 7h. visita_cancelada_aviso_em é o claim: um aviso por visita. O lembrete do orçamento
// morre junto (ele só olha 'visita_aceita'). Orçamento já enviado recusado segue com o aviso genérico.
const TITULO_VISITA_CANCELADA = (titulo) => `📋 Visita cancelada: ${titulo}`
const CORPO_VISITA_CANCELADA = 'O cliente desistiu da visita. Obrigado pela disponibilidade!'
const visitaAceitaAtiva = (proposta) => ehVisita(proposta) && proposta.status === STATUS_VISITA_ACEITA
const avisarVisitasCanceladas = async ({ avisarUsuario }, db = pool, agora = new Date()) => {
  let enviados = 0
  const iso = agora.toISOString()
  for (const [tabela, lado] of Object.entries(LADOS)) {
    const r = await db.query(
      `UPDATE ${lado.proposta} p SET visita_cancelada_aviso_em = $1::timestamptz
         FROM ${lado.tabela} d
        WHERE d.id = p.${lado.fk} AND p.visita_cancelada_em IS NOT NULL AND p.visita_cancelada_aviso_em IS NULL
          AND EXTRACT(HOUR FROM $1::timestamptz AT TIME ZONE '${TZ}') >= 7 AND EXTRACT(HOUR FROM $1::timestamptz AT TIME ZONE '${TZ}') < 22
      RETURNING p.id, p.usuario_id, d.id AS demanda_id, d.titulo, d.criado_por`, [iso])
    for (const l of r.rows) {
      avisarUsuario(l.usuario_id, {
        ator_id: l.criado_por,
        titulo: TITULO_VISITA_CANCELADA(l.titulo), corpo: CORPO_VISITA_CANCELADA,
        data: { tipo: 'visita_cancelada', [lado.chave]: l.demanda_id, [lado.idPush]: l.id },
        rotulo: `visita cancelada ${tabela} ${l.demanda_id}`,
      })
      enviados++
    }
  }
  return enviados
}
// Dono recusa a visita aceita. Devolve true se era uma visita aceita e foi cancelada aqui (quem
// chama então NÃO manda o aviso genérico de recusa).
const cancelarVisitaAceita = async ({ tabela, proposta }, dep, db = pool) => {
  if (!visitaAceitaAtiva(proposta)) return false
  const r = await db.query(
    `UPDATE ${LADOS[tabela].proposta} SET status = 'recusado', visita_cancelada_em = NOW() WHERE id = $1 AND status = '${STATUS_VISITA_ACEITA}' RETURNING id`, [proposta.id])
  if (r.rows.length === 0) return false
  // Na hora, se não for silêncio; nunca derruba a resposta ao dono.
  avisarVisitasCanceladas(dep, db).catch(err => console.error('[orçamento] aviso de visita cancelada:', err.message))
  return true
}

// LEMBRETE do orçamento: visita aceita cujo DIA (em São Paulo) já passou, sem orçamento, pedido
// ainda aberto e sem escolhido — um aviso, uma vez (orcamento_lembrete_em é o claim), só fora do
// silêncio noturno (22h–7h de São Paulo; o que cair nele sai às 7h). Devolve quantos saíram.
const TITULO_LEMBRETE = '💰 Falta o seu orçamento'
const corpoLembrete = (titulo) => `Mande o orçamento do pedido ${titulo}`
const INTERVALO_LEMBRETE_MS = 10 * 60 * 1000
const lembrarOrcamentos = async ({ avisarUsuario }, db = pool, agora = new Date()) => {
  let enviados = 0
  const iso = agora.toISOString()
  for (const [tabela, lado] of Object.entries(LADOS)) {
    const r = await db.query(
      `UPDATE ${lado.proposta} p SET orcamento_lembrete_em = $1::timestamptz
         FROM ${lado.tabela} d
        WHERE d.id = p.${lado.fk} AND p.tipo_proposta = '${TIPO_VISITA}' AND p.status = '${STATUS_VISITA_ACEITA}' AND p.orcamento_lembrete_em IS NULL
          AND (p.visita_quando AT TIME ZONE '${TZ}')::date < ($1::timestamptz AT TIME ZONE '${TZ}')::date
          AND d.status = 'aberta' AND d.match_usuario_id IS NULL
          AND EXTRACT(HOUR FROM $1::timestamptz AT TIME ZONE '${TZ}') >= 7 AND EXTRACT(HOUR FROM $1::timestamptz AT TIME ZONE '${TZ}') < 22
      RETURNING p.id, p.usuario_id, d.id AS demanda_id, d.titulo`, [iso])
    for (const l of r.rows) {
      avisarUsuario(l.usuario_id, {
        titulo: TITULO_LEMBRETE, corpo: corpoLembrete(l.titulo),
        data: { tipo: 'lembrete_orcamento', [lado.chave]: l.demanda_id, [lado.idPush]: l.id },
        rotulo: `lembrete orçamento ${tabela} ${l.demanda_id}`,
      })
      enviados++
    }
  }
  return enviados
}

// ── PÓS-VISITA (dono, 27/11/2026 — arte aprovada "pos-visita-previa") ──────────────────────────
// 1) 'CONTRATEI' (POST …/responder, action 'contratei', valor_combinado opcional >= R$ 20): o dono
//    registra que contratou o profissional da visita (proposta em 'visita_aceita' e já no horário
//    da visita — ajustes de 27/11; com orçamento enviado é o 'aceitar' de sempre). É o aceite de SEMPRE (match, demais propostas recusadas, regras de
//    contato, avaliações); muda só: o valor acordado (valor_combinado, ou o orçamento já enviado)
//    vai para valor_proposto + valor_combinado, o pedido ganha origem_match 'contratado_apos_visita'
//    e o push ao profissional é "✅ {primeiro nome} registrou que contratou você para "{título}"".
const ORIGEM_CONTRATADO_APOS_VISITA = 'contratado_apos_visita'
const ACTION_CONTRATEI = 'contratei'
const tituloContratado = (primeiroNome, titulo) => `✅ ${primeiroNome} registrou que contratou você para "${titulo}"`
const CORPO_CONTRATADO = 'Toque para ver os detalhes do serviço.'
// proposta = linha inteira; body = corpo do responder. → { erro: { status, body } } ou { valor } (valor acordado
// ou null = sem valor: valorAcordado cai no valor do pedido, como no aceite comum sem proposta de valor).
// Ajustes da visita (27/11/2026): só 'visita_aceita' E a partir de visita_quando; com orçamento
// enviado o dono usa o 'aceitar' de sempre.
const lerContratei = (proposta, body, agora = new Date()) => {
  if (!visitaNoHorario(proposta, agora)) {
    return { erro: { status: 409, body: erro('Só dá para registrar a contratação a partir do horário de uma visita aceita.', 'CONTRATEI_INDISPONIVEL') } }
  }
  const bruto = body?.valor_combinado
  if (!vazio(bruto)) {
    const n = numero(bruto)
    if (!Number.isFinite(n) || n < VALOR_MINIMO) return { erro: { status: 400, body: { erro: 'O valor combinado precisa ser de pelo menos R$ 20.', codigo: 'VALOR_MINIMO', valor_minimo: VALOR_MINIMO } } }
    return { valor: n }
  }
  return { valor: null }
}

// 2) NA HORA DA VISITA: "📋 Você está na visita?" — uma vez por proposta (visita_hora_aviso_em é o
//    claim), a partir de visita_quando e por até JANELA_AVISO_VISITA_H horas (visita antiga não
//    dispara em deploy), fora do silêncio noturno (22h–7h de São Paulo). Só proposta ainda em
//    'visita_aceita' (orçamento enviado, visita cancelada ou contratado = outro status → não sai)
//    num pedido aberto e sem escolhido.
const TITULO_HORA_VISITA = '📋 Você está na visita?'
const corpoHoraVisita = (titulo) => `Envie o orçamento de "${titulo}" agora, pelo app.`
const JANELA_AVISO_VISITA_H = 6
const avisarHoraDaVisita = async ({ avisarUsuario }, db = pool, agora = new Date()) => {
  let enviados = 0
  const iso = agora.toISOString()
  for (const [tabela, lado] of Object.entries(LADOS)) {
    const r = await db.query(
      `UPDATE ${lado.proposta} p SET visita_hora_aviso_em = $1::timestamptz
         FROM ${lado.tabela} d
        WHERE d.id = p.${lado.fk} AND p.tipo_proposta = '${TIPO_VISITA}' AND p.status = '${STATUS_VISITA_ACEITA}'
          AND p.visita_hora_aviso_em IS NULL AND p.visita_cancelada_em IS NULL AND p.orcamento_enviado_em IS NULL
          AND p.visita_quando <= $1::timestamptz AND p.visita_quando > $1::timestamptz - INTERVAL '${JANELA_AVISO_VISITA_H} hours'
          AND d.status = 'aberta' AND d.match_usuario_id IS NULL
          AND EXTRACT(HOUR FROM $1::timestamptz AT TIME ZONE '${TZ}') >= 7 AND EXTRACT(HOUR FROM $1::timestamptz AT TIME ZONE '${TZ}') < 22
      RETURNING p.id, p.usuario_id, d.id AS demanda_id, d.titulo`, [iso])
    for (const l of r.rows) {
      avisarUsuario(l.usuario_id, {
        titulo: TITULO_HORA_VISITA, corpo: corpoHoraVisita(l.titulo),
        data: { tipo: 'hora_da_visita', [lado.chave]: l.demanda_id, [lado.idPush]: l.id },
        rotulo: `hora da visita ${tabela} ${l.demanda_id}`,
      })
      enviados++
    }
  }
  return enviados
}

// 3) VISITANTE ATIVO (payload do dono): a proposta de visita em 'visita_aceita'/'orcamento_enviado'
//    mais recente do pedido → { proposta_id, nome (primeiro nome) } ou null.
const SQL_TEM_VISITANTE = (lado, demandaExpr) =>
  `EXISTS (SELECT 1 FROM ${lado.proposta} v WHERE v.${lado.fk} = ${demandaExpr} AND v.tipo_proposta = '${TIPO_VISITA}' AND v.status = ANY('{${STATUS_ORCAMENTO.join(',')}}'::text[]))`
const visitanteAtivo = async (tabela, demandaId, db = pool) => {
  const lado = LADOS[tabela]
  try {
    const r = await db.query(
      `SELECT p.id, u.nome FROM ${lado.proposta} p JOIN usuarios u ON u.id = p.usuario_id
        WHERE p.${lado.fk} = $1 AND p.tipo_proposta = '${TIPO_VISITA}' AND p.status = ANY($2::text[])
        ORDER BY p.visita_aceita_em DESC NULLS LAST LIMIT 1`, [demandaId, STATUS_ORCAMENTO])
    if (r.rows.length === 0) return null
    return { proposta_id: r.rows[0].id, nome: String(r.rows[0].nome || '').trim().split(/\s+/)[0] || null }
  } catch (err) {
    // Esquema sem as colunas de visita (teste): null em silêncio, como anexarCamposProposta.
    if (err.code !== '42703' && !/does not exist/.test(String(err.message))) console.error(`[orçamento] visitante ativo (${tabela} ${demandaId}):`, err.message)
    return null
  }
}

// 4) CANCELAMENTO PELO DONO com contratou_visitante: true|false (corpo ou query, como
//    motivo_cancelamento). Só é gravado quando o pedido tem visitante ativo; outro valor = ignorado.
const lerContratouVisitante = (req) => {
  const v = req.body?.contratou_visitante ?? req.query?.contratou_visitante
  if (v === true || v === 'true') return true
  if (v === false || v === 'false') return false
  return null
}
const registrarContratouVisitante = async (tabela, demandaId, valor, db = pool) => {
  if (valor === null) return false
  const lado = LADOS[tabela]
  const r = await db.query(
    `UPDATE ${lado.tabela} d SET contratou_visitante = $2 WHERE d.id = $1 AND ${SQL_TEM_VISITANTE(lado, 'd.id')} RETURNING d.id`, [demandaId, valor])
  return r.rows.length > 0
}

// ── PENDÊNCIAS (GET /me/pendencias — ajustes da visita, 27/11/2026) ─────────────────────────────
// Banners do topo do app. Profissional (as propostas DESTA conta): { tipo: 'visita_aceita',
// obra_id|reparo_id, proposta_id, titulo, visita_quando } — visita aceita, sem orçamento, de hoje
// em diante (dia em São Paulo), pedido aberto e sem escolhido. Dono (pedidos de qualquer conta da
// pessoa): { tipo: 'orcamento_recebido', obra_id|reparo_id, proposta_id, titulo, valor } — orçamento
// ainda sem resposta, pedido aberto e sem escolhido. Mais recentes primeiro (visita_aceita_em /
// orcamento_enviado_em), no máximo MAX_PENDENCIAS. Nunca lança: esquema sem as colunas → [].
const MAX_PENDENCIAS = 3
const pendenciasDoUsuario = async (usuarioId, db = pool, agora = new Date()) => {
  const { sqlDonoDaPessoa } = require('./tipoConta')
  const itens = []
  try {
    for (const lado of Object.values(LADOS)) {
      const vis = await db.query(
        `SELECT p.id, d.id AS demanda_id, d.titulo, p.visita_quando, p.visita_aceita_em AS evento_em
           FROM ${lado.proposta} p JOIN ${lado.tabela} d ON d.id = p.${lado.fk}
          WHERE p.usuario_id = $1 AND p.tipo_proposta = '${TIPO_VISITA}' AND p.status = '${STATUS_VISITA_ACEITA}'
            AND p.orcamento_enviado_em IS NULL AND p.visita_cancelada_em IS NULL
            AND (p.visita_quando AT TIME ZONE '${TZ}')::date >= ($2::timestamptz AT TIME ZONE '${TZ}')::date
            AND d.status = 'aberta' AND d.match_usuario_id IS NULL
          ORDER BY p.visita_aceita_em DESC NULLS LAST LIMIT ${MAX_PENDENCIAS}`, [usuarioId, agora.toISOString()])
      for (const l of vis.rows) itens.push({ evento_em: l.evento_em, item: {
        tipo: 'visita_aceita', [lado.chave]: l.demanda_id, proposta_id: l.id, titulo: l.titulo, visita_quando: new Date(l.visita_quando).toISOString() } })
      const orc = await db.query(
        `SELECT p.id, d.id AS demanda_id, d.titulo, p.valor_proposto, p.orcamento_enviado_em AS evento_em
           FROM ${lado.proposta} p JOIN ${lado.tabela} d ON d.id = p.${lado.fk}
          WHERE ${sqlDonoDaPessoa('d.criado_por', '$1')} AND p.tipo_proposta = '${TIPO_VISITA}' AND p.status = '${STATUS_ORCAMENTO_ENVIADO}'
            AND d.status = 'aberta' AND d.match_usuario_id IS NULL
          ORDER BY p.orcamento_enviado_em DESC NULLS LAST LIMIT ${MAX_PENDENCIAS}`, [usuarioId])
      for (const l of orc.rows) itens.push({ evento_em: l.evento_em, item: {
        tipo: 'orcamento_recebido', [lado.chave]: l.demanda_id, proposta_id: l.id, titulo: l.titulo, valor: l.valor_proposto == null ? null : Number(l.valor_proposto) } })
    }
  } catch (err) {
    if (err.code !== '42703' && !/does not exist/.test(String(err.message))) console.error(`[orçamento] pendências (${usuarioId}):`, err.message)
    return []
  }
  const t = (x) => (x.evento_em ? new Date(x.evento_em).getTime() : 0)
  return itens.sort((a, b) => t(b) - t(a)).slice(0, MAX_PENDENCIAS).map(x => x.item)
}

module.exports = {
  visitaJaChegou, visitaNoHorario, ANTECEDENCIA_ORCAMENTO_MS, orcamentoLiberaEm, orcamentoLiberado, podeEnviarOrcamento, quandoCurto, erroOrcamentoAntesDaVisita, MAX_PENDENCIAS, pendenciasDoUsuario,
  ORIGEM_CONTRATADO_APOS_VISITA, ACTION_CONTRATEI, tituloContratado, CORPO_CONTRATADO, lerContratei,
  TITULO_HORA_VISITA, corpoHoraVisita, JANELA_AVISO_VISITA_H, avisarHoraDaVisita,
  visitanteAtivo, lerContratouVisitante, registrarContratouVisitante,
  VALOR_MINIMO, TIPO_VALOR, TIPO_VISITA, STATUS_VISITA_ACEITA, STATUS_ORCAMENTO_ENVIADO, STATUS_ORCAMENTO, LADOS,
  ERRO_VALOR_MINIMO, ERRO_ORCAMENTO_MINIMO, MSG_VISITA_ACEITA, TITULO_LEMBRETE, corpoLembrete, INTERVALO_LEMBRETE_MS,
  suporta, lerDataHora, quandoLegivel, textoVisita, textoOrcamento, lerProposta, lerOrcamento,
  ehVisita, visitaSemOrcamento, visitaLiberaEndereco, aceitarVisita, gravarOrcamento, apresentar, anexarCamposProposta,
  migrarOrcamentoVisita, lembrarOrcamentos,
  GRUPOS_COM_VISITA, SLUGS_COM_VISITA, permiteVisita, anexarPermiteVisita, ERRO_VISITA_NAO_PERMITIDA,
  TITULO_VISITA_CANCELADA, CORPO_VISITA_CANCELADA, visitaAceitaAtiva, avisarVisitasCanceladas, cancelarVisitaAceita,
}
