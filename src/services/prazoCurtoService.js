// PRAZO ACABANDO COM INTERESSADOS (dono, 26/11/2026 — arte "prazo-curto-previa-v2"). Vale para os
// DOIS lados (reparos e obras), sempre em pedido ABERTO, aprovado, SEM profissional escolhido e com
// pelo menos 1 proposta na disputa (desistencias.STATUS_ATIVOS: pendente, contraproposta_dono,
// visita_aceita, orcamento_enviado).
//
// A) TIPO 'prazo_acabando' DO ROBÔ (avisarPrazoAcabando — job de 1 min em server.js): faltando 30
//    minutos ou menos para expira_em, o dono recebe UM push e UM WhatsApp. Uma vez por pedido
//    (prazo_acabando_em é o claim; chave de dedupe 'prazo:<tabela>:<pedido>'). Tudo atrás do
//    liga/desliga do tipo no painel (padrão: DESLIGADO) — com ele desligado nem o push sai. Push:
//    fora do silêncio noturno (22h–7h de São Paulo). WhatsApp: janela 08–21h, pausa, trava de
//    teste, SAIR, ritmo do worker; o worker descarta o aviso do pedido que fechou, ganhou
//    escolhido ou venceu antes do envio (fila.sqlPrazoVale).
// B) EXTENSÃO AUTOMÁTICA (estenderAutomaticamente — passo de escolhaPendenteService, ANTES do aviso
//    "Seu pedido expirou"): o pedido chega a expira_em nessa situação → ganha 24 horas UMA vez
//    (auto_extensao_em), pelo MESMO algoritmo de POST /…/estender: GREATEST(expira_em, NOW()) + 24h
//    — na faixa "Hoje", o fim do dia seguinte na zona do pedido —, marcos e avisos de escolha
//    zerados, ultima_extensao_em/_horas gravados. Só para quem venceu há menos de 1 hora e ainda não
//    recebeu o aviso de vencimento (pedido vencido antigo não ressuscita no deploy). O 2º
//    vencimento segue as regras de sempre.
//    Avisos (avisarExtensoesAutomaticas, claim auto_extensao_aviso_em, fora do silêncio noturno —
//    extensão de madrugada avisa às 7h): dono (push + e-mail) e cada interessado ativo (push).
// Colunas ausentes (esquema sem a migração) → os passos não fazem nada, em silêncio.
const { pool } = require('../utils/supabase')
const { enviarPushNotificacao, avisarUsuario } = require('./alertaService')
const { enfileirar } = require('./whatsappFilaService')
const { lerConfig } = require('../whatsapp/fila')
const { TIPO_PRAZO, PRAZO_ACABANDO_MIN, normalizarTelefone, lerTrava, travaPermite, dentroDaJanela } = require('../whatsapp/config')
const T = require('../whatsapp/textos')
const { STATUS_ATIVOS } = require('../utils/desistencias')
const { PRAZO_MODO_HOJE, sqlZonaSegura } = require('../utils/faixasPrazo')

const TZ = 'America/Sao_Paulo'
const HORAS_EXTENSAO = 24
const JANELA_EXTENSAO = '1 hour'
const LADOS = [
  { tabela: 'reparos', chave: 'reparo_id', proposta: 'interesse_reparos', fk: 'reparo_id', prefixoDono: 'reparo_expirando', tipoPro: 'novo_reparo' },
  { tabela: 'obras',   chave: 'obra_id',   proposta: 'candidaturas',      fk: 'obra_id',   prefixoDono: 'obra_expirando',   tipoPro: 'nova_obra' },
]
const SQL_ATIVOS_LISTA = STATUS_ATIVOS.map(s => `'${s}'`).join(', ')
const sqlAtivos = (lado) => `(SELECT count(*)::int FROM ${lado.proposta} x WHERE x.${lado.fk} = d.id AND x.status IN (${SQL_ATIVOS_LISTA}))`
const SQL_BASE = `d.status = 'aberta' AND d.status_aprovacao = 'aprovada' AND d.match_usuario_id IS NULL`
const sqlForaSilencio = (p) => `EXTRACT(HOUR FROM ${p}::timestamptz AT TIME ZONE '${TZ}') >= 7 AND EXTRACT(HOUR FROM ${p}::timestamptz AT TIME ZONE '${TZ}') < 22`
const foraDoSilencio = (agora) => {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(agora))
  return h >= 7 && h < 22
}
const semColuna = (err) => err?.code === '42703' || /column .* does not exist/i.test(String(err?.message))
const interessados = (n) => (Number(n) === 1 ? '1 interessado' : `${Number(n)} interessados`)

const migrarPrazoCurto = async (client) => {
  for (const { tabela } of LADOS) {
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS prazo_acabando_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS auto_extensao_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS auto_extensao_aviso_em TIMESTAMPTZ`)
  }
}

// ── A) 'prazo_acabando' ───────────────────────────────────────────────────────────────────────
const TITULO_PUSH_ACABANDO = '⏰ Seu pedido termina em 30 minutos'
const corpoPushAcabando = (titulo, n) => `"${titulo}" tem ${interessados(n)}. Escolha um profissional agora ou estenda o prazo.`
const chaveDoAviso = (tabela, demandaId) => `prazo:${tabela}:${demandaId}`

const avisarPrazoAcabando = async (db = pool, { agora = new Date() } = {}) => {
  const config = await lerConfig(db)
  if (!config.tipos[TIPO_PRAZO]) return { pedidos: 0, pushes: 0, whatsapp: 0, motivo: 'tipo_desligado' }
  const iso = agora.toISOString()
  const e = await db.query(`SELECT trava FROM whatsapp_estado WHERE id = 1`)
  const trava = lerTrava({ WHATSAPP_SOMENTE_PARA: e.rows[0]?.trava || '' })
  const podeWhatsapp = !config.pausado && dentroDaJanela(agora) && trava.modo !== 'ausente'
  const saida = { pedidos: 0, pushes: 0, whatsapp: 0 }
  for (const lado of LADOS) {
    let claim
    try {
      claim = await db.query(
        `UPDATE ${lado.tabela} d SET prazo_acabando_em = $1::timestamptz
           FROM usuarios u
          WHERE u.id = d.criado_por AND ${SQL_BASE} AND d.prazo_acabando_em IS NULL
            AND d.expira_em > $1::timestamptz AND d.expira_em <= $1::timestamptz + INTERVAL '${PRAZO_ACABANDO_MIN} minutes'
            AND ${sqlAtivos(lado)} > 0
        RETURNING d.id, d.titulo, d.codigo_publico, d.criado_por, d.expira_em, ${sqlAtivos(lado)} AS ativos,
                  u.push_token, u.telefone, COALESCE(u.whatsapp_avisos, true) AS quer_whatsapp, COALESCE(u.ativo, true) AS conta_ativa`, [iso])
    } catch (err) {
      if (semColuna(err)) continue
      throw err
    }
    for (const d of claim.rows) {
      saida.pedidos++
      if (!d.conta_ativa) continue
      if (foraDoSilencio(agora) && d.push_token) {
        const r = await enviarPushNotificacao(d.push_token, TITULO_PUSH_ACABANDO, corpoPushAcabando(d.titulo, d.ativos),
          { tipo: `${lado.prefixoDono}_prazo_acabando`, [lado.chave]: d.id, expira_em: new Date(d.expira_em).toISOString() }, d.criado_por)
        if (r !== 'invalido' && r !== 'erro') saida.pushes++
      }
      const telefone = normalizarTelefone(d.telefone)
      const codigo = String(d.codigo_publico || '').trim()
      if (podeWhatsapp && d.quer_whatsapp && telefone && codigo && travaPermite(trava, telefone)) {
        const dados = { titulo: d.titulo, interessados: d.ativos, codigo, tabela: lado.tabela, demanda_id: d.id }
        const en = await enfileirar({
          tipo: TIPO_PRAZO, usuarioId: d.criado_por, telefone, texto: T.textoPrazoAcabando(dados),
          refTabela: lado.tabela, refId: d.id, chaveDedupe: chaveDoAviso(lado.tabela, d.id), dados }, db)
        if (en.ok) saida.whatsapp++
      }
    }
  }
  return saida
}

// ── B) extensão automática ────────────────────────────────────────────────────────────────────
const TITULO_DONO_ESTENDIDO = '⏳ Mais 24 horas para escolher'
const corpoDonoEstendido = (titulo, n) => `Demos mais 24 horas ao seu pedido "${titulo}" porque ele tem ${interessados(n)}. Escolha um profissional!`
const TITULO_PRO_ESTENDIDO = '⏳ Mais 24 horas'
const corpoProEstendido = (titulo) => `O pedido "${titulo}" ganhou mais 24 horas.`

// Um lado por chamada (é um passo de escolhaPendenteService.verificarEscolhaPendente). Devolve
// quantos pedidos ganharam as 24 horas.
const estenderAutomaticamente = async (lado, db = pool) => {
  try {
    const r = await db.query(
      `UPDATE ${lado.tabela} d
          SET expira_em = CASE WHEN d.prazo_modo = '${PRAZO_MODO_HOJE}' THEN (
                  date_trunc('day', GREATEST(d.expira_em AT TIME ZONE ${sqlZonaSegura('d.prazo_timezone')}, NOW() AT TIME ZONE ${sqlZonaSegura('d.prazo_timezone')}))
                  + (2 * INTERVAL '1 day') - INTERVAL '1 microsecond'
                ) AT TIME ZONE ${sqlZonaSegura('d.prazo_timezone')}
                ELSE GREATEST(d.expira_em, NOW()) + INTERVAL '${HORAS_EXTENSAO} hours' END,
              marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL,
              escolha_aviso_24h_em = NULL, escolha_aviso_2h_em = NULL, escolha_expirou_em = NULL,
              ultima_extensao_em = NOW(), ultima_extensao_horas = ${HORAS_EXTENSAO},
              auto_extensao_em = NOW(), auto_extensao_aviso_em = NULL
        WHERE ${SQL_BASE} AND d.auto_extensao_em IS NULL AND d.escolha_expirou_em IS NULL
          AND d.expira_em <= NOW() AND d.expira_em > NOW() - INTERVAL '${JANELA_EXTENSAO}'
          AND ${sqlAtivos(lado)} > 0
      RETURNING d.id, d.expira_em`)
    for (const d of r.rows) console.log(`[PrazoCurto] ${lado.tabela} ${d.id}: +${HORAS_EXTENSAO}h automáticas (tinha interessados) → ${new Date(d.expira_em).toISOString()}`)
    return r.rows.length
  } catch (err) {
    if (semColuna(err)) return 0
    throw err
  }
}

// Avisos da extensão automática, fora do silêncio noturno. Devolve quantos pedidos foram avisados.
const avisarExtensoesAutomaticas = async (lado, db = pool, agora = new Date()) => {
  let claim
  try {
    claim = await db.query(
      `UPDATE ${lado.tabela} d SET auto_extensao_aviso_em = $1::timestamptz
        WHERE d.auto_extensao_em IS NOT NULL AND d.auto_extensao_aviso_em IS NULL AND ${SQL_BASE} AND d.expira_em > $1::timestamptz
          AND ${sqlForaSilencio('$1')}
      RETURNING d.id, d.titulo, d.criado_por, d.expira_em, ${sqlAtivos(lado)} AS ativos`, [agora.toISOString()])
  } catch (err) {
    if (semColuna(err)) return 0
    throw err
  }
  for (const d of claim.rows) {
    const expira = new Date(d.expira_em).toISOString()
    avisarUsuario(d.criado_por, {
      titulo: TITULO_DONO_ESTENDIDO, corpo: corpoDonoEstendido(d.titulo, d.ativos),
      data: { tipo: `${lado.prefixoDono}_auto_estendido`, [lado.chave]: d.id, expira_em: expira },
      rotulo: `extensão automática ${lado.tabela} ${d.id}`,
    })
    const pros = await db.query(
      `SELECT DISTINCT u.id, u.push_token FROM ${lado.proposta} x JOIN usuarios u ON u.id = x.usuario_id
        WHERE x.${lado.fk} = $1 AND x.status = ANY($2::text[]) AND u.push_token IS NOT NULL`, [d.id, STATUS_ATIVOS])
    for (const p of pros.rows) {
      await enviarPushNotificacao(p.push_token, TITULO_PRO_ESTENDIDO, corpoProEstendido(d.titulo), { tipo: lado.tipoPro, [lado.chave]: d.id, expira_em: expira }, p.id)
    }
  }
  return claim.rows.length
}

module.exports = {
  LADOS, HORAS_EXTENSAO, migrarPrazoCurto, avisarPrazoAcabando, chaveDoAviso, TITULO_PUSH_ACABANDO, corpoPushAcabando,
  estenderAutomaticamente, avisarExtensoesAutomaticas, TITULO_DONO_ESTENDIDO, corpoDonoEstendido, TITULO_PRO_ESTENDIDO, corpoProEstendido,
}
