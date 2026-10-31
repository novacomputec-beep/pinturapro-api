const { pool } = require('../utils/supabase')
const { TZ_AGENDA } = require('../utils/agendamento')
const { entregarPushEEmail, entregarLembrete, semSobreposicao } = require('./alertaService')

// Demanda ABERTA, sem profissional escolhido e com interessados PENDENTES (interesse_reparos /
// candidaturas com status 'pendente' — o profissional espera o dono; 'contraproposta_dono' é o
// dono esperando o profissional e não conta). Quatro avisos, todos por claim atômico na própria
// linha da demanda (UPDATE ... WHERE coluna devida RETURNING), então réplicas e tiques repetidos
// nunca duplicam:
//   (1) lembrete DIÁRIO ao dono "N profissionais aguardam sua escolha" (escolha_lembrete_em):
//       no máx. um por dia de São Paulo, silêncio 22:00–07:00 SP, só quando o interessado
//       pendente mais antigo tem ao menos LEMBRETE_CARENCIA_HORAS (o push "Novo interesse" já
//       avisou na hora) e só fora das últimas 24h antes de expira_em (ali valem os avisos 2).
//       Push a cada dia + no máx. 1 e-mail/dia (entregarLembrete → claim 'lembrete#AAAAMMDD'
//       em email_alertas).
//   (2) aviso ao dono 24h e 2h antes de expira_em (escolha_aviso_24h_em / _2h_em). Roda o de
//       2h primeiro, e ele grava também o de 24h. Só quando a demanda viveu mais que o marco
//       (anúncio de 12h nunca recebe o "24h" no minuto em que surge o 1º interessado).
//       Silêncio 22:00–07:00 SP nos dois: o de 24h é ADIADO (banda (0, 24h], sai no 1º tique
//       das 07:00 — o texto diz "menos de 2 horas" se já for o caso); o de 2h é PULADO quando o
//       seu horário (expira_em − 2h) cai no silêncio, mesmo que o tique chegue depois das 07:00.
//   (3) no vencimento (escolha_expirou_em): dono "Seu pedido expirou" e CADA interessado
//       pendente "O cliente não escolheu a tempo". Silêncio 22:00–07:00 SP: adiado para o 1º
//       tique das 07:00. Só até EXPIROU_JANELA_HORAS depois de expira_em — vencidas antigas não
//       recebem rajada no deploy (a noite inteira cabe nessa janela). O interesse segue
//       'pendente': o dono ainda pode aceitar, e estendendo o prazo a demanda volta ao feed.
//   (4) avisarPrazoEstendido — chamada por POST /…/estender quando a demanda já tinha passado
//       por (3): cada interessado pendente sabe que o prazo foi aumentado e o interesse vale.
// (2) e (3) são eventos críticos: push + e-mail sempre (entregarPushEEmail). O
// expira_em entra em `data` para o dedupe do e-mail (hash de título+corpo+data) distinguir um
// ciclo do outro depois de uma extensão.
// Sem sobreposição com os marcos "Aumente o prazo" (verificarMarcosExpiracao) nem com o baixo
// engajamento: esses exigem NENHUM interessado vivo, aqui exige-se ao menos um pendente.
// Colunas zeradas (exceto escolha_lembrete_em) nos mesmos pontos que zeram marco_N_em: os dois
// /estender e os crons que devolvem a demanda ao feed quando o match expira.
// Toques (data.tipo), todos já roteados pelo app (AppNavigator.navegarParaNotificacao):
//   dono: (1) novo_interesse / nova_candidatura → detalhe (lista de interessados);
//         (2)(3) reparo_expirando_… / obra_expirando_… (prefixo) → detalhe;
//   profissional: (3) interesse_recusado / candidatura_recusada → aba dos seus interesses;
//                 (4) novo_reparo / nova_obra → detalhe da demanda no feed.
const LEMBRETE_CARENCIA_HORAS = 6
const EXPIROU_JANELA_HORAS = 24

const LADOS = [
  { tabela: 'reparos', chave: 'reparo_id', interesse: 'interesse_reparos', coluna: 'reparo_id',
    ancora: 'd.criado_em', aprovacao: '',
    tipoDiario: 'novo_interesse', prefixoDono: 'reparo_expirando', tipoProExpirou: 'interesse_recusado', tipoProEstendido: 'novo_reparo' },
  { tabela: 'obras', chave: 'obra_id', interesse: 'candidaturas', coluna: 'obra_id',
    ancora: 'COALESCE(d.publicado_em, d.criado_em)', aprovacao: `AND d.status_aprovacao = 'aprovada'`,
    tipoDiario: 'nova_candidatura', prefixoDono: 'obra_expirando', tipoProExpirou: 'candidatura_recusada', tipoProEstendido: 'nova_obra' },
]

const sqlPendentes = (lado) => `(SELECT count(*)::int FROM ${lado.interesse} x WHERE x.${lado.coluna} = d.id AND x.status = 'pendente')`
const sqlPendenteMaisAntigo = (lado) => `(SELECT min(x.criado_em) FROM ${lado.interesse} x WHERE x.${lado.coluna} = d.id AND x.status = 'pendente')`
const SQL_BASE = (lado) => `d.status = 'aberta' AND d.match_usuario_id IS NULL ${lado.aprovacao}`
const SQL_HORA_SP = `EXTRACT(HOUR FROM (NOW() AT TIME ZONE '${TZ_AGENDA}'))`
const SQL_FORA_SILENCIO = `${SQL_HORA_SP} >= 7 AND ${SQL_HORA_SP} < 22`
// O mesmo teste para um instante qualquer (o horário "devido" do aviso de 2h).
const sqlForaSilencioEm = (instante) => {
  const h = `EXTRACT(HOUR FROM ((${instante}) AT TIME ZONE '${TZ_AGENDA}'))`
  return `${h} >= 7 AND ${h} < 22`
}
const RETORNO = (lado) => `d.id, d.titulo, d.criado_por, d.expira_em, ${sqlPendentes(lado)} AS pendentes,
             u.push_token, u.email, u.nome`

const profissionais = (n) => (n === 1 ? '1 profissional aguarda' : `${n} profissionais aguardam`)
const dataDono = (lado, tipo, d) => ({ tipo, [lado.chave]: d.id, expira_em: new Date(d.expira_em).toISOString() })

// Interessados pendentes com contato, para (3) e (4).
const listarPendentes = async (lado, demandaId) => (await pool.query(
  `SELECT u.id, u.push_token, u.email, u.nome FROM ${lado.interesse} x JOIN usuarios u ON u.id = x.usuario_id
    WHERE x.${lado.coluna} = $1 AND x.status = 'pendente'`, [demandaId])).rows

const lembrarDiario = async (lado) => {
  const claim = await pool.query(`
    UPDATE ${lado.tabela} d SET escolha_lembrete_em = NOW()
      FROM usuarios u
     WHERE u.id = d.criado_por AND ${SQL_BASE(lado)}
       AND d.expira_em > NOW() + INTERVAL '24 hours'
       AND ${sqlPendenteMaisAntigo(lado)} < NOW() - INTERVAL '${LEMBRETE_CARENCIA_HORAS} hours'
       AND (d.escolha_lembrete_em IS NULL
            OR (d.escolha_lembrete_em AT TIME ZONE '${TZ_AGENDA}')::date < (NOW() AT TIME ZONE '${TZ_AGENDA}')::date)
       AND ${SQL_FORA_SILENCIO}
 RETURNING ${RETORNO(lado)}`)
  for (const d of claim.rows) {
    const via = await entregarLembrete({
      usuario_id: d.criado_por, push_token: d.push_token, email: d.email, nome: d.nome,
      titulo: `👥 ${profissionais(d.pendentes)} sua escolha`,
      corpo: `Pedido "${d.titulo}": veja as propostas e escolha um profissional no app.`,
      data: { tipo: lado.tipoDiario, [lado.chave]: d.id, lembrete: true },
      rotulo: `escolha pendente diário ${lado.tabela} ${d.id}`,
    })
    console.log(`[EscolhaPendente] diário ${lado.tabela} ${d.id} pendentes=${d.pendentes} → dono via ${via}`)
  }
}

const MARCOS = [
  // Ordem importa: o de 2h roda antes e grava também o de 24h. O de 2h exige que o seu horário
  // devido esteja fora do silêncio (senão é pulado de vez); o de 24h só exige o AGORA fora do
  // silêncio (adiado), e a banda dele vai até 0 para o adiado ainda sair de manhã.
  { nome: '2h',  max: '2 hours',  set: 'escolha_aviso_2h_em = NOW(), escolha_aviso_24h_em = COALESCE(d.escolha_aviso_24h_em, NOW())', col: 'escolha_aviso_2h_em',
    silencio: `${SQL_FORA_SILENCIO} AND ${sqlForaSilencioEm(`d.expira_em - INTERVAL '2 hours'`)}` },
  { nome: '24h', max: '24 hours', set: 'escolha_aviso_24h_em = NOW()', col: 'escolha_aviso_24h_em', silencio: SQL_FORA_SILENCIO },
]
const rotuloRestante = (restanteMin) => (Number(restanteMin) <= 120 ? '2 horas' : '24 horas')
const avisarAntesDeExpirar = async (lado) => {
  for (const m of MARCOS) {
    const claim = await pool.query(`
      UPDATE ${lado.tabela} d SET ${m.set}
        FROM usuarios u
       WHERE u.id = d.criado_por AND ${SQL_BASE(lado)}
         AND d.expira_em > NOW() AND d.expira_em <= NOW() + INTERVAL '${m.max}'
         AND d.expira_em - ${lado.ancora} > INTERVAL '${m.max}'
         AND d.${m.col} IS NULL
         AND ${sqlPendentes(lado)} > 0
         AND ${m.silencio}
   RETURNING ${RETORNO(lado)}, EXTRACT(EPOCH FROM (d.expira_em - NOW())) / 60 AS restante_min`)
    for (const d of claim.rows) {
      const via = await entregarPushEEmail({
        usuario_id: d.criado_por, push_token: d.push_token, email: d.email, nome: d.nome,
        titulo: '⏰ Seu pedido vai expirar',
        corpo: `"${d.titulo}" expira em menos de ${rotuloRestante(d.restante_min)} e ${profissionais(d.pendentes)} sua escolha. Escolha um profissional ou aumente o prazo.`,
        data: dataDono(lado, `${lado.prefixoDono}_escolha_${m.nome}`, d),
        rotulo: `escolha pendente ${m.nome} ${lado.tabela} ${d.id}`,
      })
      console.log(`[EscolhaPendente] aviso ${m.nome} ${lado.tabela} ${d.id} pendentes=${d.pendentes} → dono via ${via}`)
    }
  }
}

const avisarExpirou = async (lado) => {
  const claim = await pool.query(`
    UPDATE ${lado.tabela} d SET escolha_expirou_em = NOW()
      FROM usuarios u
     WHERE u.id = d.criado_por AND ${SQL_BASE(lado)}
       AND d.expira_em <= NOW() AND d.expira_em > NOW() - INTERVAL '${EXPIROU_JANELA_HORAS} hours'
       AND d.escolha_expirou_em IS NULL
       AND ${sqlPendentes(lado)} > 0
       AND ${SQL_FORA_SILENCIO}
 RETURNING ${RETORNO(lado)}`)
  for (const d of claim.rows) {
    const via = await entregarPushEEmail({
      usuario_id: d.criado_por, push_token: d.push_token, email: d.email, nome: d.nome,
      titulo: '⌛ Seu pedido expirou',
      corpo: `"${d.titulo}" expirou sem profissional escolhido e ${profissionais(d.pendentes)} sua escolha. Aumente o prazo para reabrir.`,
      data: dataDono(lado, `${lado.prefixoDono}_escolha_expirou`, d),
      rotulo: `escolha pendente expirou ${lado.tabela} ${d.id}`,
    })
    const pros = await listarPendentes(lado, d.id)
    for (const p of pros) {
      await entregarPushEEmail({
        usuario_id: p.id, ator_id: d.criado_por, push_token: p.push_token, email: p.email, nome: p.nome,
        titulo: '⌛ O cliente não escolheu a tempo',
        corpo: `O prazo de "${d.titulo}" acabou sem escolha. Se o cliente aumentar o prazo, seu interesse continua valendo e avisaremos você.`,
        data: dataDono(lado, lado.tipoProExpirou, d),
        rotulo: `escolha pendente expirou profissional ${lado.tabela} ${d.id} ${p.id}`,
      })
    }
    console.log(`[EscolhaPendente] expirou ${lado.tabela} ${d.id} → dono via ${via}; ${pros.length} interessado(s) avisado(s)`)
  }
}

const verificarEscolhaPendente = semSobreposicao('verificarEscolhaPendente', async () => {
  for (const lado of LADOS) {
    for (const passo of [avisarExpirou, avisarAntesDeExpirar, lembrarDiario]) {
      try { await passo(lado) } catch (err) { console.error(`[EscolhaPendente] ${passo.name} ${lado.tabela}:`, err.message) }
    }
  }
})

// (4) Chamada fire-and-forget por POST /…/estender DEPOIS do UPDATE, só quando a demanda já
// tinha recebido o aviso de vencimento (escolha_expirou_em, lido antes de o UPDATE zerá-lo).
// ator_id = o dono que estendeu. Nunca lança.
const avisarPrazoEstendido = async (tabela, demandaId, atorId) => {
  try {
    const lado = LADOS.find(l => l.tabela === tabela)
    const d = (await pool.query(`SELECT id, titulo, expira_em FROM ${lado.tabela} WHERE id = $1`, [demandaId])).rows[0]
    if (!d) return
    const pros = await listarPendentes(lado, d.id)
    for (const p of pros) {
      await entregarPushEEmail({
        usuario_id: p.id, ator_id: atorId, push_token: p.push_token, email: p.email, nome: p.nome,
        titulo: '🔄 Prazo aumentado',
        corpo: `O cliente aumentou o prazo de "${d.titulo}". Seu interesse continua valendo — aguarde a escolha.`,
        data: { ...dataDono(lado, lado.tipoProEstendido, d), prazo_estendido: true },
        rotulo: `escolha pendente prazo estendido ${lado.tabela} ${d.id} ${p.id}`,
      })
    }
    console.log(`[EscolhaPendente] prazo estendido ${lado.tabela} ${d.id} → ${pros.length} interessado(s) avisado(s)`)
  } catch (err) {
    console.error(`[EscolhaPendente] prazo estendido ${tabela} ${demandaId}:`, err.message)
  }
}

module.exports = { verificarEscolhaPendente, avisarPrazoEstendido, LEMBRETE_CARENCIA_HORAS, EXPIROU_JANELA_HORAS }
