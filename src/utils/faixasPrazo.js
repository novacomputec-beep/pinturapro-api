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

module.exports = { FAIXAS, getFaixa }
