// Agendamento livre de chegada (dia + hora) em cima das colunas de janela de chegada
// (chegada_pendente_* / chegada_prevista_em) — obras e reparos, mesmas colunas.
//
// Fluxo: o profissional casado propõe um instante (POST /:id/chegada-prevista {data_hora});
// fica em chegada_pendente_em com chegada_pendente_janela = 'agendado', chegada_proposta_por =
// quem propôs e chegada_pendente_rodada = nº da proposta. O outro lado aceita ou contrapropõe
// (POST /:id/chegada-prevista/responder {acao}); cada LADO tem SUGESTOES_MAX_POR_LADO
// sugestões (proposta ou contraproposta) por match — a seguinte leva 400 e só resta aceitar
// (contadores sugestoes_horario_dono / sugestoes_horario_profissional, zerados em
// SQL_ZERAR_AGENDA: match novo, un-match, remarcar). Aceito, o instante
// vira chegada_prevista_em — e a partir daí os crons de cronômetro, o lembrete e a falta leem a
// MESMA coluna que já liam. Os três rótulos antigos ('hoje' | 'amanha_manha' | 'amanha_tarde')
// continuam valendo para os apps já nas lojas.
//
// Módulo inerte (constantes, regex, fragmentos SQL e um formatador): nada aqui toca o banco.
const TZ_AGENDA = 'America/Sao_Paulo'
const JANELA_AGENDADO = 'agendado'
const SUGESTOES_MAX_POR_LADO = 6
const ERRO_LIMITE_SUGESTOES = 'Você atingiu o limite de sugestões. Confirme o horário proposto.'
// Coluna-contador do lado que está sugerindo e quantas sugestões ainda lhe restam (nunca < 0).
const colunaSugestoes = (ehDono) => (ehDono ? 'sugestoes_horario_dono' : 'sugestoes_horario_profissional')
const sugestoesRestantes = (linha, ehDono) =>
  Math.max(0, SUGESTOES_MAX_POR_LADO - (Number(linha?.[colunaSugestoes(ehDono)]) || 0))
const RESPOSTAS_COMPARECIMENTO = ['sim', 'nao', 'remarcar']
// Vigia: 1h depois do horário aceito sem chegada declarada, o dono é perguntado; a falta
// automática espera até 24h depois do horário por essa resposta.
const VIGIA_ATRASO = '1 hour'
const ESPERA_RESPOSTA_COMPARECIMENTO = '24 hours'
// Lembrete que ficou devido há mais de 60 min não é enviado (horário aceito depois do instante
// do lembrete): seria "amanhã às 14:00" dito hoje.
const LEMBRETE_AGENDA_JANELA = '60 minutes'
// Prazo mínimo que a demanda ganha quando o dono pede para remarcar: sem ele, o expira_em
// (muitas vezes já vencido no momento da vigia) mataria o match no tique seguinte do cron.
const PRAZO_MINIMO_REMARCAR = '24 hours'

// ISO 8601 local ou com fuso: 2026-10-23T14:00, 2026-10-23 14:00:00, 2026-10-23T14:00-03:00,
// 2026-10-23T17:00Z. Sem fuso, o instante é lido em America/Sao_Paulo (no Postgres, nunca no
// relógio do processo — o container roda em UTC).
const RE_DATA_HORA = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/
const temFuso = (texto) => /(Z|[+-]\d{2}:?\d{2})$/.test(texto)
// Resolve o texto do parâmetro `param` em timestamptz; `paramTemFuso` é o booleano de temFuso.
// ::text antes dos dois casts: o parâmetro é TEXTO nos dois ramos (sem o ::text o Postgres
// inferiria o tipo do parâmetro pelo primeiro uso e o segundo ramo viraria um cast
// timestamptz→timestamp dependente do fuso da sessão).
const sqlDataHora = (param, paramTemFuso) =>
  `CASE WHEN ${paramTemFuso}::boolean THEN ${param}::text::timestamptz ELSE (${param}::text::timestamp AT TIME ZONE '${TZ_AGENDA}') END`

// Colunas próprias do agendamento, zeradas junto com as chegada_* em todo match novo e em todo
// un-match (SQL_LIMPAR_CHEGADA em routes, crons de cronômetro, expirar-match, responder-tempo).
// a_caminho_em ("Estou a caminho", POST /:id/match) entra na mesma lista: é estado DESTE
// match — e é o que libera a troca de telefones em GET /:id, que não pode sobreviver ao
// profissional seguinte. Também cai no 'remarcar' do comparecimento, que usa esta lista.
// lembrete_agendar_offsets (alertaService.lembrarAgendarAtendimento): antecedências já
// avisadas do "Agende seu atendimento" — estado DESTE match, então o profissional seguinte
// (ou o mesmo, após 'remarcar') começa com a lista vazia.
const SQL_ZERAR_AGENDA = `chegada_proposta_por = NULL, chegada_pendente_rodada = 0,
              lembrete_agenda_vespera_em = NULL, lembrete_agenda_2h_em = NULL, lembrete_agenda_hora_em = NULL,
              vigia_comparecimento_em = NULL, comparecimento_resposta = NULL, comparecimento_respondido_em = NULL,
              a_caminho_em = NULL, lembrete_agendar_offsets = '{}',
              chegada_proposta_em = NULL, lembrete_resposta_1h_em = NULL, lembrete_resposta_antes_em = NULL,
              sugestoes_horario_dono = 0, sugestoes_horario_profissional = 0`

// Isenção de falta e de bloqueio quando o match morre sem horário valendo: o dono recusou a
// janela (chegada_recusada_em) OU a proposta que ficou sem resposta era do PROFISSIONAL
// (aguardava o dono). Proposta do DONO sem resposta do profissional NÃO isenta — a inação é
// dele. COALESCE(chegada_proposta_por, match_usuario_id): linhas anteriores à coluna (toda
// pendência era do profissional) continuam isentas. Em SET de UPDATE as colunas leem a linha
// ANTIGA, então match_usuario_id ainda é o profissional que está saindo.
const SQL_ISENCAO_FALTA = `chegada_prevista_em IS NULL
                   AND (chegada_recusada_em IS NOT NULL
                        OR (chegada_pendente_em IS NOT NULL
                            AND COALESCE(chegada_proposta_por, match_usuario_id) = match_usuario_id))`
// Mesma regra em JS, para o candidato lido antes do UPDATE do cron.
const isentoDeFalta = (d) =>
  !d.chegada_prevista_em &&
  (!!d.chegada_recusada_em ||
    (!!d.chegada_pendente_em && (d.chegada_proposta_por || d.match_usuario_id) === d.match_usuario_id))

// Espera pela resposta do dono à vigia antes de o cron desfazer o match de um horário
// AGENDADO vencido: 'nao' libera na hora; sem resposta, libera 24h depois do horário. Janela
// de rótulo antigo (ou sem janela) segue a regra de sempre — sem espera.
const SQL_ESPERA_COMPARECIMENTO = `(chegada_janela IS DISTINCT FROM '${JANELA_AGENDADO}'
             OR comparecimento_resposta = 'nao'
             OR chegada_prevista_em + INTERVAL '${ESPERA_RESPOSTA_COMPARECIMENTO}' <= NOW())`

// "Qui, 23/10 às 14:00" em America/Sao_Paulo. Aceita Date ou string parseável.
const DIAS_SEMANA = { Sun: 'Dom', Mon: 'Seg', Tue: 'Ter', Wed: 'Qua', Thu: 'Qui', Fri: 'Sex', Sat: 'Sáb' }
const fmtDia = new Intl.DateTimeFormat('en-US', { timeZone: TZ_AGENDA, weekday: 'short' })
const fmtPartes = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ_AGENDA, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
const formatarDataHoraSP = (valor) => {
  const data = valor instanceof Date ? valor : new Date(valor)
  if (Number.isNaN(data.getTime())) return String(valor)
  const p = Object.fromEntries(fmtPartes.formatToParts(data).map(x => [x.type, x.value]))
  return `${DIAS_SEMANA[fmtDia.format(data)] || ''}, ${p.day}/${p.month} às ${p.hour}:${p.minute}`
}

module.exports = {
  TZ_AGENDA, JANELA_AGENDADO, SUGESTOES_MAX_POR_LADO, ERRO_LIMITE_SUGESTOES, colunaSugestoes, sugestoesRestantes,
  RESPOSTAS_COMPARECIMENTO,
  VIGIA_ATRASO, ESPERA_RESPOSTA_COMPARECIMENTO, LEMBRETE_AGENDA_JANELA, PRAZO_MINIMO_REMARCAR,
  RE_DATA_HORA, temFuso, sqlDataHora,
  SQL_ZERAR_AGENDA, SQL_ISENCAO_FALTA, isentoDeFalta, SQL_ESPERA_COMPARECIMENTO,
  formatarDataHoraSP,
}
