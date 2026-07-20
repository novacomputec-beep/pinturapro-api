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

// getFaixa(windowHours) → entrada da faixa para MATCH EXATO em {1,2,4,8,24,168}.
// Retorna null para qualquer outro valor (legado fora de faixa, NULL, float, string não-numérica).
// Os chamadores tratam o null (fallback definido em passo posterior — ex.: maior faixa <= janela).
const getFaixa = (windowHours) => FAIXAS[windowHours] || null

module.exports = { FAIXAS, getFaixa }
