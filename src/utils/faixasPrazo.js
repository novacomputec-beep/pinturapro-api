// Tabela de faixas de prazo (tiers) das demandas — dicionário compartilhado.
//
// Cada demanda (reparo: prazo_atendimento_horas | obra: horas_para_expirar) cai em uma das 6
// faixas fixas abaixo. Esta tabela é a ÚNICA fonte de verdade para:
//   - os 3 marcos de expiração (offsets em MINUTOS antes de expira_em); o job dispara o marco N
//     quando (expira_em - now) <= offset_N;
//   - as opções de estender oferecidas para aquela faixa.
//
// Opções de estender:
//   tipo 'add' → soma `horas` ao expira_em atual (a faixa NÃO muda).
//   tipo 'set' → define expira_em = now + `horas` (a demanda passa a ser aquela nova faixa).
//
// MÓDULO INERTE: dados puros + um helper de lookup. Não importa nada, sem efeitos colaterais.
// Ainda NÃO é consumido por ninguém — os consumidores (job, estender, detalhe) entram em passos
// seguintes.

const FAIXAS = {
  1: {
    windowHours: 1,
    milestones: [15, 10, 5],
    extend: [
      { label: '+1h',    tipo: 'add', horas: 1 },
      { label: '+2h',    tipo: 'add', horas: 2 },
      { label: 'amanhã', tipo: 'set', horas: 24 },
    ],
  },
  2: {
    windowHours: 2,
    milestones: [30, 15, 10],
    extend: [
      { label: '+2h',    tipo: 'add', horas: 2 },
      { label: '+4h',    tipo: 'add', horas: 4 },
      { label: 'amanhã', tipo: 'set', horas: 24 },
    ],
  },
  4: {
    windowHours: 4,
    milestones: [60, 30, 15],
    extend: [
      { label: '+4h',    tipo: 'add', horas: 4 },
      { label: '+8h',    tipo: 'add', horas: 8 },
      { label: 'amanhã', tipo: 'set', horas: 24 },
    ],
  },
  8: {
    windowHours: 8,
    milestones: [120, 60, 30],
    extend: [
      { label: '+4h',    tipo: 'add', horas: 4 },
      { label: '+8h',    tipo: 'add', horas: 8 },
      { label: 'amanhã', tipo: 'set', horas: 24 },
    ],
  },
  24: {
    windowHours: 24,
    milestones: [120, 90, 30],
    extend: [
      { label: '+8h',          tipo: 'add', horas: 8 },
      { label: '+1 dia',       tipo: 'set', horas: 24 },
      { label: 'esta semana',  tipo: 'set', horas: 168 },
    ],
  },
  168: {
    windowHours: 168,
    milestones: [1440, 480, 240],
    extend: [
      { label: '+1 dia',    tipo: 'add', horas: 24 },
      { label: '+1 semana', tipo: 'set', horas: 168 },
    ],
  },
}

// Chaves em ordem crescente, derivadas de FAIXAS (não uma segunda lista a manter em sincronia).
const CHAVES_ORDENADAS = Object.keys(FAIXAS).map(Number).sort((a, b) => a - b)

// getFaixa(windowHours) → entrada da faixa para a janela dada.
// Match exato em {1,2,4,8,24,168}; fora disso, cai na MAIOR faixa que não excede a janela —
// 72 → 24, 720/1440/2160 → 168, e o mesmo para as horas arbitrárias que o estender aceita.
// Antes o match era exato e todo o resto voltava null, então demanda fora de faixa (inclusive
// o default de 720h de quem cadastra sem prazo) nunca recebia marco nenhum.
// Continua null quando não há faixa aplicável: janela < 1 (0 vem de NULL/'' via Number),
// negativa, NaN, Infinity ou string não-numérica. O chamador já trata esse null com log.
const getFaixa = (windowHours) => {
  const horas = Number(windowHours)
  if (!Number.isFinite(horas)) return null
  let escolhida = null
  for (const chave of CHAVES_ORDENADAS) {
    if (chave > horas) break
    escolhida = FAIXAS[chave]
  }
  return escolhida
}

// ============================================================
// FAIXA "HOJE" — prazo que vence no FIM DO DIA, não N horas depois
// ============================================================
// As faixas acima são todas DURAÇÕES: expira_em = publicação + windowHours. "Hoje" não é uma
// duração — é um INSTANTE do calendário (o fim do dia corrente em Brasília), então não cabe na
// tabela e precisa de um marcador próprio, gravado em obras.prazo_modo / reparos.prazo_modo.
//
// Por que um marcador em coluna, e não um valor sentinela em horas_para_expirar/
// prazo_atendimento_horas: essas colunas são lidas por getFaixa (marcos), pelo predicado dos
// dois crons (`IS NOT NULL`) e pela carência do estender. Um sentinela (0, -1) as
// atravessaria todas com significado errado. NULL em prazo_modo = faixa por duração, o
// comportamento de sempre.
const PRAZO_MODO_HOJE = 'hoje'

// Fuso de recuo quando o cliente não manda zona, manda algo malformado, ou manda uma zona que
// o Postgres não conhece. Era o valor fixo da primeira versão desta regra.
const TZ_PADRAO = 'America/Sao_Paulo'

// Fim do dia CORRENTE às 23:59:59.999999 NA ZONA DADA, como timestamptz.
// `zonaSql` é um TRECHO DE SQL que resolve para o nome da zona — um placeholder ($21::text) no
// create, ou uma expressão de coluna (COALESCE(prazo_timezone, ...)) nos caminhos que
// reconstroem. Nunca o nome da zona interpolado: o valor vem do cliente e entra como PARÂMETRO.
//
// Modelado em SQL_FIM_DO_MES_SP (src/routes/index.js), trocando 'month' por 'day': os dois
// AT TIME ZONE fazem coisas OPOSTAS e é isso que faz a conta fechar num banco UTC —
//   1º (timestamptz → timestamp) TIRA o fuso e devolve o relógio de parede LOCAL, para o
//      date_trunc cortar o dia do USUÁRIO;
//   2º (timestamp → timestamptz) RECOLOCA o fuso e devolve o instante UTC a gravar.
// Sem isso, 19/08 22:00 em SP já é 20/08 01:00 em UTC e o truncamento cairia um dia adiante —
// exatamente o erro que o comentário de JANELAS_CHEGADA descreve para o `new Date()` do
// container. Por isso a expressão é resolvida no Postgres, nunca no Node.
// SEM PISO: publicar 23:58 dá dois minutos de prazo, e é essa a regra pedida.
const sqlFimDoDia = (zonaSql) => `(
        date_trunc('day', (NOW() AT TIME ZONE ${zonaSql}))
        + INTERVAL '1 day' - INTERVAL '1 microsecond'
      ) AT TIME ZONE ${zonaSql}`

// Forma da primeira versão, fixa em São Paulo. Continua em uso no lado REPARO, que não tem
// faixa "Hoje" e cujo cliente não manda zona — ali prazo_modo é sempre NULL e o ramo nunca
// dispara, então não há o que parametrizar.
const SQL_FIM_DO_DIA_SP = sqlFimDoDia(`'${TZ_PADRAO}'`)

// Forma de nome IANA: exige ao menos uma barra (Region/City), aceita os níveis extras de
// America/Argentina/Buenos_Aires e os sinais de Etc/GMT+3. É só uma triagem de FORMATO —
// quem decide se a zona EXISTE é o Postgres, via pg_timezone_names.
const FORMATO_ZONA_IANA = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/

// Zona GRAVADA na linha, resolvida com segurança, para os caminhos que RECONSTROEM expira_em.
// `colunaQualificada` é a coluna da linha sendo atualizada (ex.: 'obras.prazo_timezone').
//
// A validação de create não basta aqui. Uma zona aceita hoje pode deixar de ser reconhecida
// depois — upgrade do Postgres que remove um link renomeado (Europe/Kiev → Europe/Kyiv), poda
// do tzdata, ou edição manual da linha. Consumida direta, `NOW() AT TIME ZONE <zona morta>`
// levanta SQLSTATE 22023 (time zone not recognized), e como os dois caminhos atualizam um LOTE
// num único statement, UMA linha ruim abortava o UPDATE INTEIRO: nenhuma obra do lote voltava
// ao feed, e o try/catch do cron transformava isso numa linha de log a cada minuto.
//
// O LEFT-lookup em pg_timezone_names torna a resolução POR LINHA e sem exceção: zona ausente
// do catálogo não devolve linha, o COALESCE cai no padrão, e as demais linhas do lote seguem.
// Também absorve o caso NULL (`= NULL` não casa nada), então substitui o COALESCE anterior.
//
// Custo: pg_timezone_names é uma função que enumera o tzdata (~500 linhas) a cada avaliação, e
// a expressão da zona aparece duas vezes no fim-do-dia — ou seja, 2 varreduras por linha do
// lote. Os lotes aqui são de obras que acabaram de expirar (unidades, não milhares), e o ramo
// só é avaliado quando prazo_modo = 'hoje'. Se um dia isso pesar, o passo seguinte é
// materializar o catálogo num CTE do próprio statement — não voltar a confiar na coluna crua.
const sqlZonaSegura = (colunaQualificada) => `COALESCE(
        (SELECT tz.name FROM pg_timezone_names tz WHERE tz.name = ${colunaQualificada}),
        '${TZ_PADRAO}')`

module.exports = { FAIXAS, getFaixa, PRAZO_MODO_HOJE, TZ_PADRAO, sqlFimDoDia, SQL_FIM_DO_DIA_SP, FORMATO_ZONA_IANA, sqlZonaSegura }
