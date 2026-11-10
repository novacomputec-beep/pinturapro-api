// RESPONSABILIDADE PÓS-MATCH (dono, 10/11/2026) — eventos por PESSOA (CPF normalizado,
// utils/tipoConta), janela móvel de JANELA_DIAS (90) dias, obras e reparos.
//
//   compromisso_nao_cumprido — do PROFISSIONAL escolhido que ignorou os lembretes "Agende" e
//       perdeu o match pelo "escolher outro" ou pelo "desfazer escolha" do dono
//       (desfazerEscolhaService). Vem acompanhado da falta de sempre (faltas_profissional +
//       suspensão por faltas). Sai ao dono em cada candidatura/interesse como
//       compromissos_nao_cumpridos_90d e cumpriu_todos (tem serviço encerrado e zero eventos
//       na janela). A desistência voluntária ANTES de horário combinado ("Não vou conseguir",
//       cancelamentoMatchService 'livre') continua sem penalidade — é o que o 1º lembrete pede.
//   cliente_nao_respondeu — do DONO que deixou a proposta de horário do PROFISSIONAL vencer sem
//       responder (alertaService.expirarPropostasDeHorario; a contraproposta do dono que o
//       profissional deixa vencer NÃO conta). 1º evento na janela: só marca. Do 2º em diante:
//       bloqueio de BLOQUEIO_PEDIDOS_DIAS (7) dias para CRIAR demanda nova (bloqueio_ate na
//       linha; POST /obras/dono e /reparos/dono → 409 PEDIDOS_BLOQUEADOS com liberado_em). As
//       demandas existentes seguem intactas. Sai aos profissionais em feed e detalhe como
//       cliente_nao_respondeu_90d. Compensação ao profissional afetado: CREDITO_DIAS_COMPENSACAO
//       (7) dias de assinatura (responsabilidadeService) — credito_dias na linha.
//
// Crédito de assinatura (sem cobrança): usuarios.dias_credito_compensacao é o TOTAL já creditado
// à conta; assinaturas.dias_credito_aplicados, quanto desse total já foi somado ao
// proximo_vencimento. A diferença é o crédito pendente — aplicado quando a assinatura é paga e
// ativa (status 'ativa', tipo ≠ 'gratuito', vencimento futuro), na hora do evento ou pela
// varredura (aplicarCreditosPendentes), que também cobre quem só começa a pagar depois (fim da
// janela de lançamento, pagamento, aprovação). Mesmo desenho de meses_bonus_indicacao.
//
// Módulo inerte fora de migrarResponsabilidade: constantes e expressões SQL.
const { sqlContasDaPessoa, sqlContasProfissionaisDaPessoa } = require('./tipoConta')

const JANELA_DIAS = 90
const EVENTOS_PARA_BLOQUEIO = 2
const BLOQUEIO_PEDIDOS_DIAS = 7
const CREDITO_DIAS_COMPENSACAO = 7
const TIPOS_EVENTO = ['compromisso_nao_cumprido', 'cliente_nao_respondeu']
const MOTIVO_PROPOSTA_VENCIDA = 'proposta_vencida'
// Última chance ao dono antes da proposta do profissional vencer (aviso único por proposta).
const AVISO_FINAL_ANTES_MIN = 60

const sqlJanela = (col = 'criado_em') => `${col} > NOW() - INTERVAL '${JANELA_DIAS} days'`

// Eventos do PROFISSIONAL (pessoa de exprUsuarioId, contas 'prestador') na janela.
const sqlCompromissosNaoCumpridos90d = (exprUsuarioId) =>
  `(SELECT COUNT(*)::int FROM eventos_responsabilidade ev
     WHERE ev.tipo_evento = 'compromisso_nao_cumprido' AND ${sqlJanela('ev.criado_em')}
       AND ev.usuario_id IN (${sqlContasProfissionaisDaPessoa(exprUsuarioId)}))`
// Serviços ENCERRADOS com este profissional (qualquer conta profissional da pessoa), obras + reparos.
const sqlServicosEncerrados = (exprUsuarioId) =>
  `((SELECT COUNT(*) FROM obras eo WHERE eo.status = 'encerrada' AND eo.match_usuario_id IN (${sqlContasProfissionaisDaPessoa(exprUsuarioId)}))
   + (SELECT COUNT(*) FROM reparos er WHERE er.status = 'encerrada' AND er.match_usuario_id IN (${sqlContasProfissionaisDaPessoa(exprUsuarioId)})))`
// true só com serviço encerrado E zero eventos na janela; false nos demais casos (nunca NULL).
const sqlCumpriuTodos = (exprUsuarioId) =>
  `(${sqlServicosEncerrados(exprUsuarioId)} > 0 AND ${sqlCompromissosNaoCumpridos90d(exprUsuarioId)} = 0)`

// Eventos do DONO (pessoa de exprCriadoPor, contas contratantes) na janela.
const sqlClienteNaoRespondeu90d = (exprCriadoPor) =>
  `(SELECT COUNT(*)::int FROM eventos_responsabilidade ev
     WHERE ev.tipo_evento = 'cliente_nao_respondeu' AND ${sqlJanela('ev.criado_em')}
       AND ev.usuario_id IN (${sqlContasDaPessoa(exprCriadoPor)}))`
// Fim do bloqueio de pedidos novos da pessoa do dono, ou NULL quando não está bloqueada.
const sqlPedidosLiberadoEm = (exprUsuarioId) =>
  `(SELECT MAX(ev.bloqueio_ate) FROM eventos_responsabilidade ev
     WHERE ev.tipo_evento = 'cliente_nao_respondeu' AND ev.bloqueio_ate > NOW()
       AND ev.usuario_id IN (${sqlContasDaPessoa(exprUsuarioId)}))`

// Predicado de assinatura PAGA e ativa (alias `a`): é nela que o crédito vira dias de vencimento.
const SQL_ASSINATURA_PAGA_ATIVA = `a.status = 'ativa' AND a.tipo IS DISTINCT FROM 'gratuito'
       AND a.proximo_vencimento IS NOT NULL AND a.proximo_vencimento > NOW()`
// Aplica o crédito PENDENTE (total creditado − já aplicado) ao vencimento das assinaturas pagas
// e ativas; `filtro` restringe a uma conta ('a.usuario_id = $1'). Idempotente: depois de rodar,
// aplicados = creditado. Nunca cria cobrança — só move proximo_vencimento para a frente.
const sqlAplicarCreditoPendente = (filtro = 'true') => `
  UPDATE assinaturas a
     SET proximo_vencimento = a.proximo_vencimento + (u.dias_credito_compensacao - a.dias_credito_aplicados) * INTERVAL '1 day',
         dias_credito_aplicados = u.dias_credito_compensacao,
         atualizado_em = NOW()
    FROM usuarios u
   WHERE u.id = a.usuario_id AND ${filtro}
     AND ${SQL_ASSINATURA_PAGA_ATIVA}
     AND u.dias_credito_compensacao > a.dias_credito_aplicados
  RETURNING a.usuario_id, a.proximo_vencimento, u.dias_credito_compensacao AS creditados`

// Migração de boot (dentro da transação de routes/index.js). Idempotente; exportada para o teste
// rodar os MESMOS statements.
//   usuario_id       — a CONTA que recebeu o evento (a contagem é por pessoa, na leitura);
//   outro_usuario_id — a outra parte (dono no compromisso_nao_cumprido; profissional no
//                      cliente_nao_respondeu), para a ficha do painel;
//   tabela/demanda_id — a demanda; motivo — 'escolheu_outro' | 'escolha_desfeita' | 'proposta_vencida';
//   bloqueio_ate     — só no cliente_nao_respondeu do 2º evento em diante: fim do bloqueio;
//   credito_dias / credito_aplicado_em — compensação ao profissional e quando virou vencimento
//                      (NULL = guardado para quando a cobrança começar).
const migrarResponsabilidade = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS eventos_responsabilidade (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tipo_evento         TEXT NOT NULL CHECK (tipo_evento IN ('compromisso_nao_cumprido', 'cliente_nao_respondeu')),
      usuario_id          UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      outro_usuario_id    UUID,
      tabela              TEXT NOT NULL CHECK (tabela IN ('obras', 'reparos')),
      demanda_id          UUID NOT NULL,
      motivo              TEXT,
      bloqueio_ate        TIMESTAMPTZ,
      credito_dias        INTEGER NOT NULL DEFAULT 0,
      credito_aplicado_em TIMESTAMPTZ,
      criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  // Um compromisso_nao_cumprido por (profissional, demanda): o un-match é um só, e dois caminhos
  // (desfazer / escolher outro) nunca duplicam o evento.
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS eventos_resp_compromisso_unico_idx
    ON eventos_responsabilidade (tabela, demanda_id, usuario_id) WHERE tipo_evento = 'compromisso_nao_cumprido'`)
  await client.query(`CREATE INDEX IF NOT EXISTS eventos_resp_usuario_idx ON eventos_responsabilidade (usuario_id, tipo_evento, criado_em)`)
  await client.query(`CREATE INDEX IF NOT EXISTS eventos_resp_criado_idx ON eventos_responsabilidade (criado_em)`)
  await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS dias_credito_compensacao INTEGER NOT NULL DEFAULT 0`)
  await client.query(`ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS dias_credito_aplicados INTEGER NOT NULL DEFAULT 0`)
  // Claim do aviso final ao dono (responsabilidadeService.avisarRespostaFinalDono); zerado a cada proposta.
  for (const tabela of ['obras', 'reparos']) {
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS aviso_resposta_final_em TIMESTAMPTZ`)
  }
}

module.exports = {
  JANELA_DIAS, EVENTOS_PARA_BLOQUEIO, BLOQUEIO_PEDIDOS_DIAS, CREDITO_DIAS_COMPENSACAO, TIPOS_EVENTO,
  MOTIVO_PROPOSTA_VENCIDA, AVISO_FINAL_ANTES_MIN,
  sqlCompromissosNaoCumpridos90d, sqlCumpriuTodos, sqlClienteNaoRespondeu90d, sqlPedidosLiberadoEm,
  SQL_ASSINATURA_PAGA_ATIVA, sqlAplicarCreditoPendente, migrarResponsabilidade,
}
