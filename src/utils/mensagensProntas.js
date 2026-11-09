// MENSAGENS PRONTAS — conversa por frases prontas entre o dono e o profissional ESCOLHIDO de uma
// demanda (obras e reparos). Não há texto livre: quem envia escolhe uma frase do catálogo abaixo
// pelo id, e é o texto do CATÁLOGO que é gravado e enviado — nada do que o app mandar vira
// mensagem. (É o que mantém fora daqui telefone, link e combinação por fora.)
//
// O catálogo é servido pelo servidor (GET /:tabela/:id/mensagens-prontas), por FASE do
// atendimento e por PAPEL de quem lê; trocar uma frase não pede versão nova do app.
//
// FASE — derivada do estado da demanda (faseDaDemanda), a mesma leitura do app
// (components/Agendamento.faseAgendamento):
//   aguardando_horario → há profissional escolhido e ainda não há horário combinado (inclui a
//                        proposta de horário sem resposta);
//   agendado           → horário combinado (chegada_prevista_em) e ninguém a caminho;
//   a_caminho          → "Estou a caminho" dado (a_caminho_em) até a chegada ser confirmada.
//   Sem fase (null): sem profissional escolhido, demanda fora de 'aberta', ou chegada já
//   confirmada (serviço em andamento) — o histórico continua legível, mas não se envia mais.
//
// LIMITES, por pessoa (papel) em cada fase de um mesmo atendimento (demanda + profissional
// escolhido): no máximo LIMITE_POR_FASE mensagens, e cada frase uma única vez. A unicidade é do
// banco (índice único), então dois toques simultâneos não duplicam.
//
// Módulo inerte fora de migrarMensagensProntas: constantes e funções puras.
const FASES = ['aguardando_horario', 'agendado', 'a_caminho']
const PAPEIS = ['dono', 'profissional']
const LIMITE_POR_FASE = 5

// ids ESTÁVEIS: são o que fica gravado (frase_id) e o que o app envia. Mudar o TEXTO de uma frase
// é livre (o histórico guarda o texto enviado); mudar ou reaproveitar um id não.
const CATALOGO = {
  aguardando_horario: {
    dono: [
      { id: 'ah_dono_manha',        texto: 'Pode vir pela manhã?' },
      { id: 'ah_dono_tarde',        texto: 'Prefiro à tarde' },
      { id: 'ah_dono_qualquer_dia', texto: 'Qualquer dia serve' },
      { id: 'ah_dono_fotos',        texto: 'Vou mandar fotos' },
      { id: 'ah_dono_vendo',        texto: 'Ainda estou vendo' },
    ],
    profissional: [
      { id: 'ah_prof_propus_horario', texto: 'Propus um horário, fica bom pra você?' },
      { id: 'ah_prof_fotos',          texto: 'Preciso de fotos do local?' },
      { id: 'ah_prof_horario_hoje',   texto: 'Vou enviar o horário hoje' },
      { id: 'ah_prof_outro_dia',      texto: 'Posso ir em outro dia' },
    ],
  },
  agendado: {
    dono: [
      { id: 'ag_dono_confirmado',   texto: 'Confirmado, te espero!' },
      { id: 'ag_dono_material',     texto: 'Eu compro o material' },
      { id: 'ag_dono_remarcar',     texto: 'Vou precisar remarcar' },
      { id: 'ag_dono_avise_sair',   texto: 'Me avise quando sair' },
    ],
    profissional: [
      { id: 'ag_prof_tudo_certo',     texto: 'Tudo certo, até lá!' },
      { id: 'ag_prof_lista_material', texto: 'Me passe a lista do material' },
      { id: 'ag_prof_levo_material',  texto: 'Vou levar o material' },
      { id: 'ag_prof_remarcar',       texto: 'Vou precisar remarcar' },
    ],
  },
  a_caminho: {
    dono: [
      { id: 'ac_dono_portao_aberto', texto: 'O portão está aberto' },
      { id: 'ac_dono_campainha',     texto: 'Toque a campainha' },
      { id: 'ac_dono_esperando',     texto: 'Estou te esperando' },
      { id: 'ac_dono_atraso_10',     texto: 'Vou atrasar 10 min' },
    ],
    profissional: [
      { id: 'ac_prof_chego_10',   texto: 'Chego em 10 minutos' },
      { id: 'ac_prof_chegando',   texto: 'Estou chegando' },
      { id: 'ac_prof_atraso_10',  texto: 'Vou atrasar 10 min' },
      { id: 'ac_prof_cheguei',    texto: 'Cheguei, estou no portão' },
    ],
  },
}

// Índice por id → { id, texto, fase, papel }. Um id repetido no catálogo derruba o boot: seria
// uma frase que nunca poderia ser enviada (ou enviada no lugar de outra).
const FRASES_POR_ID = new Map()
for (const fase of FASES) {
  for (const papel of PAPEIS) {
    for (const frase of CATALOGO[fase][papel]) {
      if (FRASES_POR_ID.has(frase.id)) throw new Error(`mensagensProntas: frase_id repetido no catálogo: ${frase.id}`)
      FRASES_POR_ID.set(frase.id, Object.freeze({ ...frase, fase, papel }))
    }
  }
}
const fraseDoCatalogo = (id) => (typeof id === 'string' ? FRASES_POR_ID.get(id.trim()) || null : null)
const frasesDe = (fase, papel) => (CATALOGO[fase]?.[papel] || []).map(f => ({ id: f.id, texto: f.texto }))

// Colunas da demanda que faseDaDemanda lê (para o SELECT de quem chama).
const COLUNAS_FASE = 'status, match_usuario_id, chegada_prevista_em, a_caminho_em, chegada_confirmada_em'
const faseDaDemanda = (d) => {
  if (!d || d.status !== 'aberta' || !d.match_usuario_id || d.chegada_confirmada_em) return null
  if (d.a_caminho_em) return 'a_caminho'
  if (d.chegada_prevista_em) return 'agendado'
  return 'aguardando_horario'
}

// Migração de boot (dentro da transação de routes/index.js). Idempotente; exportada para o teste
// rodar os MESMOS statements.
//   tipo/demanda_id  — a demanda ('obra' | 'reparo' + id), como em perguntas_demanda;
//   remetente_id     — a CONTA que enviou (ON DELETE CASCADE: sem conta, some o que ela enviou);
//   papel            — 'dono' | 'profissional';
//   profissional_id  — o profissional escolhido NAQUELE momento (match_usuario_id): a conversa é
//                      do atendimento, não da demanda — se o dono escolher outro profissional, o
//                      novo não lê a conversa do anterior e os limites recomeçam;
//   fase, frase_id, texto (o do catálogo no instante do envio), enviado_em.
const migrarMensagensProntas = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS mensagens_prontas_enviadas (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tipo            TEXT NOT NULL CHECK (tipo IN ('obra', 'reparo')),
      demanda_id      UUID NOT NULL,
      remetente_id    UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      papel           TEXT NOT NULL CHECK (papel IN ('dono', 'profissional')),
      profissional_id UUID NOT NULL,
      fase            TEXT NOT NULL CHECK (fase IN ('aguardando_horario', 'agendado', 'a_caminho')),
      frase_id        TEXT NOT NULL,
      texto           TEXT NOT NULL,
      enviado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  // "Cada frase uma vez por fase" (por papel, no atendimento) — e o que torna o envio idempotente.
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS mensagens_prontas_frase_unica_idx
    ON mensagens_prontas_enviadas (tipo, demanda_id, profissional_id, papel, fase, frase_id)`)
  await client.query(`CREATE INDEX IF NOT EXISTS mensagens_prontas_demanda_idx ON mensagens_prontas_enviadas (tipo, demanda_id, enviado_em)`)
}

module.exports = {
  FASES, PAPEIS, LIMITE_POR_FASE, CATALOGO, COLUNAS_FASE,
  fraseDoCatalogo, frasesDe, faseDaDemanda, migrarMensagensProntas,
}
