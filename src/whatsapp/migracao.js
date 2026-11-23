// Tabelas do robô de WhatsApp (Etapa 1). Tudo ADITIVO e idempotente: roda na migração de boot da
// API (dentro de um SAVEPOINT — falha aqui não impede a API de subir) e no início do worker.
// `client` = conexão já dentro de uma transação.
const { STATUS, CHAVE_PAUSADO, CHAVE_LOCK, CHAVE_CANAL_AUTO, STATUS_POST_CANAL } = require('./config')

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
  // Desde quando a conexão atual está aberta (o worker grava; NULL fora de 'conectado').
  await client.query(`ALTER TABLE whatsapp_estado ADD COLUMN IF NOT EXISTS conectado_em TIMESTAMPTZ`)

  // ETAPA 2 (pergunta sem resposta).
  //   dados: o que o worker precisa para REDIGIR a mensagem na hora do envio (o texto depende de
  //          quantas perguntas saem juntas e de ser a primeira mensagem da pessoa);
  //   item_numero: o número (1–5) que a pergunta recebeu na mensagem agrupada — é por ele que a
  //          resposta "2 sim…" acha a pergunta; NULL em mensagem de uma pergunta só;
  //   resposta: o que a pessoa respondeu a esta mensagem (painel).
  await client.query(`ALTER TABLE whatsapp_mensagens ADD COLUMN IF NOT EXISTS dados JSONB`)
  await client.query(`ALTER TABLE whatsapp_mensagens ADD COLUMN IF NOT EXISTS item_numero INTEGER`)
  await client.query(`ALTER TABLE whatsapp_mensagens ADD COLUMN IF NOT EXISTS resposta TEXT`)
  //   sandbox: SIMULAÇÃO do painel (POST /admin/whatsapp/simular-pergunta, 18/11/2026) — pergunta
  //          de mentira, sem pedido nem pergunta de verdade (ref_id NULL). Sai e é respondida como
  //          as outras, mas a resposta NÃO vai para o app: fica só em `resposta`, para o painel.
  await client.query(`ALTER TABLE whatsapp_mensagens ADD COLUMN IF NOT EXISTS sandbox BOOLEAN NOT NULL DEFAULT false`)
  //   citada_wa_message_id: mensagem que a pessoa citou ao responder; midia: 'audio', 'imagem'…
  //   (NULL = texto); processada_em/resultado: a API (services/whatsappPerguntasService) casa a
  //   resposta com a pergunta e marca aqui — o worker só guarda.
  await client.query(`ALTER TABLE whatsapp_recebidas ADD COLUMN IF NOT EXISTS citada_wa_message_id TEXT`)
  await client.query(`ALTER TABLE whatsapp_recebidas ADD COLUMN IF NOT EXISTS midia TEXT`)
  await client.query(`ALTER TABLE whatsapp_recebidas ADD COLUMN IF NOT EXISTS processada_em TIMESTAMPTZ`)
  await client.query(`ALTER TABLE whatsapp_recebidas ADD COLUMN IF NOT EXISTS resultado TEXT`)
  await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_recebidas_pendentes_idx ON whatsapp_recebidas (id) WHERE processada_em IS NULL`)

  // Opt-out: "SAIR" no WhatsApp desliga. Default true (constante → ALTER instantâneo).
  await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS whatsapp_avisos BOOLEAN NOT NULL DEFAULT true`)

  // Pausa global: nasce desligada (a trava de teste do worker já segura tudo na Etapa 1).
  await client.query(
    `INSERT INTO configuracoes (chave, valor) SELECT $1, 'false' WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = $1)`,
    [CHAVE_PAUSADO])

  // CANAL (newsletter) — post automático (23/11/2026). whatsapp_canal_posts é a fila E o registro:
  // a API insere 'pendente' (ou 'pulado' no dia sem pedidos), o worker posta e grava o resultado.
  //   origem: 'auto' (18:00) | 'manual' (postar-agora); dia: data de São Paulo;
  //   índice único (dia) só para 'auto' → no máximo UM post automático por dia, mesmo com réplicas;
  //   enviando_em: marcado ANTES de postar — worker que cai no meio vira 'falha', nunca posta em dobro.
  await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_canal_posts (
      id            BIGSERIAL PRIMARY KEY,
      origem        TEXT NOT NULL CHECK (origem IN ('auto', 'manual')),
      dia           DATE NOT NULL,
      cidade        TEXT NOT NULL,
      texto         TEXT,
      total         INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN (${STATUS_POST_CANAL.map(s => `'${s}'`).join(', ')})),
      erro          TEXT,
      canal_jid     TEXT,
      wa_message_id TEXT,
      enviando_em   TIMESTAMPTZ,
      criado_por    UUID,
      criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      postado_em    TIMESTAMPTZ
    )`)
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_canal_posts_auto_dia_key ON whatsapp_canal_posts (dia) WHERE origem = 'auto'`)
  await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_canal_posts_pendentes_idx ON whatsapp_canal_posts (id) WHERE status = 'pendente'`)
  // O que o worker descobriu do canal (a API lê): JID, nome, papel do número do robô e se é admin.
  for (const col of ['canal_convite TEXT', 'canal_jid TEXT', 'canal_nome TEXT', 'canal_papel TEXT', 'canal_admin BOOLEAN', 'canal_erro TEXT', 'canal_verificado_em TIMESTAMPTZ']) {
    await client.query(`ALTER TABLE whatsapp_estado ADD COLUMN IF NOT EXISTS ${col}`)
  }
  // Post automático das 18:00: nasce DESLIGADO.
  await client.query(
    `INSERT INTO configuracoes (chave, valor) SELECT $1, 'false' WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = $1)`,
    [CHAVE_CANAL_AUTO])
}

module.exports = { migrarWhatsapp }
