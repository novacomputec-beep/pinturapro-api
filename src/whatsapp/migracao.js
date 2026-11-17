// Tabelas do robô de WhatsApp (Etapa 1). Tudo ADITIVO e idempotente: roda na migração de boot da
// API (dentro de um SAVEPOINT — falha aqui não impede a API de subir) e no início do worker.
// `client` = conexão já dentro de uma transação.
const { STATUS, CHAVE_PAUSADO, CHAVE_LOCK } = require('./config')

const migrarWhatsapp = async (client) => {
  // API e worker podem subir juntos: um espera o outro (lock solto no fim da transação).
  await client.query(`SELECT pg_advisory_xact_lock(${CHAVE_LOCK + 1})`)

  // FILA DE SAÍDA. A API só INSERE (services/whatsappFilaService); o worker envia e atualiza.
  // usuario_id SEM FK de propósito: excluir a conta não pode esbarrar no histórico de mensagens.
  // chave_dedupe: o mesmo item pendente nunca entra duas vezes (índice único parcial).
  // enviando_em: marcado ANTES de enviar; se o worker cair no meio, a linha vira 'falha' ao
  // voltar em vez de ser reenviada (no máximo uma vez, nunca duplicada).
  // agrupada_em: id da linha cuja mensagem carregou esta (vários itens da pessoa numa só).
  await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_mensagens (
      id                   BIGSERIAL PRIMARY KEY,
      tipo                 TEXT NOT NULL,
      usuario_id           UUID,
      telefone             TEXT NOT NULL,
      texto                TEXT NOT NULL,
      ref_tabela           TEXT,
      ref_id               UUID,
      chave_dedupe         TEXT,
      status               TEXT NOT NULL DEFAULT 'fila' CHECK (status IN (${STATUS.map(s => `'${s}'`).join(', ')})),
      wa_jid               TEXT,
      wa_message_id        TEXT,
      agrupada_em          BIGINT,
      tentativas           INTEGER NOT NULL DEFAULT 0,
      erro                 TEXT,
      proxima_tentativa_em TIMESTAMPTZ,
      enviando_em          TIMESTAMPTZ,
      criado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      enviada_em           TIMESTAMPTZ,
      entregue_em          TIMESTAMPTZ,
      lida_em              TIMESTAMPTZ,
      respondida_em        TIMESTAMPTZ,
      atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_mensagens_dedupe_key ON whatsapp_mensagens (chave_dedupe) WHERE chave_dedupe IS NOT NULL`)
  await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_mensagens_fila_idx ON whatsapp_mensagens (criado_em, id) WHERE status = 'fila'`)
  await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_mensagens_wa_id_idx ON whatsapp_mensagens (wa_message_id) WHERE wa_message_id IS NOT NULL`)
  await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_mensagens_criado_idx ON whatsapp_mensagens (criado_em DESC)`)

  // Sessão do Baileys (credenciais + chaves Signal), uma linha por chave. Nada em disco.
  await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      chave         TEXT PRIMARY KEY,
      valor         TEXT NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)

  // Mensagens RECEBIDAS. Etapa 1 só guarda (e trata "SAIR"); o casamento com a pergunta/pedido
  // (mensagem_ref) fica para a Etapa 2.
  await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_recebidas (
      id            BIGSERIAL PRIMARY KEY,
      wa_message_id TEXT NOT NULL UNIQUE,
      wa_jid        TEXT,
      telefone      TEXT,
      usuario_id    UUID,
      texto         TEXT,
      recebida_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      mensagem_ref  BIGINT,
      criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_recebidas_recebida_idx ON whatsapp_recebidas (recebida_em DESC)`)

  // Estado do worker (linha única): o worker escreve, a API lê para a aba do painel. `comando`
  // é o caminho inverso: a API pede ('desconectar') e o worker executa e limpa.
  await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_estado (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      conexao         TEXT NOT NULL DEFAULT 'desligado',
      qr              TEXT,
      qr_em           TIMESTAMPTZ,
      numero          TEXT,
      trava           TEXT,
      heartbeat_em    TIMESTAMPTZ,
      ultimo_envio_em TIMESTAMPTZ,
      ultimo_erro     TEXT,
      comando         TEXT,
      atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  await client.query(`INSERT INTO whatsapp_estado (id) VALUES (1) ON CONFLICT (id) DO NOTHING`)

  // Opt-out: "SAIR" no WhatsApp desliga. Default true (constante → ALTER instantâneo).
  await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS whatsapp_avisos BOOLEAN NOT NULL DEFAULT true`)

  // Pausa global: nasce desligada (a trava de teste do worker já segura tudo na Etapa 1).
  await client.query(
    `INSERT INTO configuracoes (chave, valor) SELECT $1, 'false' WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = $1)`,
    [CHAVE_PAUSADO])
}

module.exports = { migrarWhatsapp }
