require('dotenv').config()
const express = require('express')
const router = express.Router()
const { autenticar, exigirAssinaturaAtiva, exigirNaoSuspenso, corpoContaSuspensa, exigirAdmin, exigirSuperAdmin, invalidarCacheAssinatura, assinaturaAtivaCacheada } = require('../middlewares/auth')
const { registrarVisita } = require('../utils/visitas')
const { pool } = require('../utils/supabase')
const { MARCA } = require('../utils/marca')
const authCtrl         = require('../controllers/authController')
const obrasCtrl        = require('../controllers/obrasController')
const candidaturasCtrl = require('../controllers/candidaturasController')
const mensagensCtrl    = require('../controllers/mensagensController')
const pagamentoCtrl    = require('../controllers/pagamentoController')
const { upload, uploadMidia } = require('../controllers/uploadController')
const { uploadArquivo, gerarAssinaturaCloudinary, uploadParaCloudinary } = require('../services/uploadService')
const { uploadMidiaStream } = require('../controllers/uploadStreamController')
const { enviarPushNotificacao, notificarPintoresSobreNovaObra, notificarPrestadoresSobreNovoReparo, JANELA_FALTAS, FALTAS_PARA_SUSPENDER } = require('../services/alertaService')
const { ufDeCidade } = require('../utils/localidade')
// Módulo inerte (dados puros): o marcador da faixa "Hoje" e a expressão SQL do fim do dia em
// America/Sao_Paulo. Compartilhado com alertaService, que reconstrói expira_em nos crons.
const { PRAZO_MODO_HOJE, TZ_PADRAO, sqlFimDoDia, SQL_FIM_DO_DIA_SP, FORMATO_ZONA_IANA, sqlZonaSegura } = require('../utils/faixasPrazo')
// Zona a usar quando a obra reconstrói expira_em depois da criação: a que o cliente mandou,
// validada CONTRA O CATÁLOGO na hora do uso, com recuo para o padrão. Cobre tanto a linha
// gravada antes de prazo_timezone existir (NULL) quanto a zona que deixou de ser reconhecida
// — esta última abortava o UPDATE inteiro do lote antes desta guarda.
const SQL_ZONA_DA_OBRA = sqlZonaSegura('obras.prazo_timezone')
const { coordsDeCidade, resolverBusca, montarFiltroGeo } = require('../utils/geoBusca')
const { enviarContratoReparo, enviarContratoObra } = require('../controllers/contratosController')
const { rejeitarConcorrentes } = require('../utils/rejeitarConcorrentes')
const { enviarEmail } = require('../services/emailService')
const bcrypt = require('bcrypt')

// Envolve um DELETE de mídia para que, NO MESMO statement, as urls apagadas caiam na fila
// midias_orfas — de onde deletarMidiasAntigas as remove do Cloudinary. Um só comando: se o
// DELETE entra, o registro da órfã entra junto; não há janela em que a linha some sem deixar
// rastro do arquivo.
// O argumento é o DELETE COMPLETO, com `RETURNING url, tipo` — cada call site continua
// mostrando o próprio WHERE, que é o que varia entre eles.
// ON CONFLICT (url): a mesma url enfileirada de novo é a mesma exclusão.
const enfileirarOrfas = (deleteComReturning) => `
  WITH del AS (${deleteComReturning})
  INSERT INTO midias_orfas (url, tipo) SELECT url, tipo FROM del ON CONFLICT (url) DO NOTHING`
const jwt = require('jsonwebtoken')
const speakeasy = require('speakeasy')

// One-time column migrations — single transaction so all columns land atomically or none do
const migracaoPronta = (async () => {
  // pool.connect() dentro do try: erro de conexão (ex.: DB inacessível) é logado
  // em vez de virar unhandled rejection que derruba o processo (crash-loop / 502).
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    // Isenta ESTA transação do statement_timeout global de 10s do pool (utils/supabase.js).
    // A migração roda ANTES do app.listen (server.js aguarda migracaoPronta), e um CREATE
    // INDEX não-concorrente numa obras/reparos grande passa fácil dos 10s: o timeout mataria
    // o statement, a migração lançaria e o servidor NUNCA subiria. SET LOCAL só vale até o
    // COMMIT — a conexão volta ao pool com o teto normal.
    await client.query('SET LOCAL statement_timeout = 0')
    await client.query(`ALTER TABLE interesse_reparos ADD COLUMN IF NOT EXISTS valor_proposto NUMERIC`)
    await client.query(`ALTER TABLE interesse_reparos ADD COLUMN IF NOT EXISTS valor_contraproposta NUMERIC`)
    await client.query(`ALTER TABLE interesse_reparos ADD COLUMN IF NOT EXISTS rodada INTEGER DEFAULT 1`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS alerta_sem_interessados_em TIMESTAMP WITH TIME ZONE`)
    await client.query(`ALTER TABLE candidaturas ADD COLUMN IF NOT EXISTS valor_contraproposta NUMERIC`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS alerta_sem_interessados_em TIMESTAMP WITH TIME ZONE`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS match_feito_em TIMESTAMP WITH TIME ZONE`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS match_usuario_id UUID REFERENCES usuarios(id)`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS pedido_tempo_status VARCHAR(50)`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS pedido_tempo_motivo TEXT`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS pedido_tempo_minutos INTEGER`)
    // Flag "aviso de 5min já enviado" do cronômetro de obras (espelha reparos.notif_5min_enviada).
    // Evita reenviar o aviso pré-expiração a cada tick de 1min enquanto o match está na janela final.
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS notif_5min_enviada BOOLEAN DEFAULT false`)
    await client.query(`ALTER TABLE candidaturas ADD COLUMN IF NOT EXISTS valor_proposto NUMERIC`)
    await client.query(`ALTER TABLE candidaturas ADD COLUMN IF NOT EXISTS mensagem TEXT`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS uf VARCHAR(2)`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS endereco_reparo TEXT`)
    // Ponto de referência do local ("portão azul, ao lado da padaria"). Texto livre do dono,
    // mascarado nos detalhes junto com endereco_* — mesma sensibilidade, mesma regra.
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS ponto_referencia TEXT`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS latitude NUMERIC`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS longitude NUMERIC`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS notif_5min_enviada BOOLEAN DEFAULT false`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS uf VARCHAR(2)`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS endereco_obra TEXT`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS ponto_referencia TEXT`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS latitude NUMERIC`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS longitude NUMERIC`)
    // Procedência da coordenada: 'cliente' = veio do app (endereço exato, precisão de rua);
    // 'centro_cidade' = derivada da sede do município (precisão de cidade). NULL = linha
    // legada, origem desconhecida — o app deve tratar NULL como 'cliente' (comportamento de
    // hoje), por isso NÃO há backfill de origem para linhas antigas que já tinham coordenada.
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS coordenadas_origem TEXT`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS coordenadas_origem TEXT`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verificacao_status VARCHAR(50) DEFAULT 'nao_solicitada'`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verificacao_doc_frente_url TEXT`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verificacao_doc_verso_url TEXT`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verificacao_selfie_url TEXT`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tipo_dono VARCHAR(50)`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pix_reembolso VARCHAR(200)`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS referencias TEXT`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rg VARCHAR(20)`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rg_orgao VARCHAR(20)`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rg_estado VARCHAR(2)`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS dois_fa_secret VARCHAR(100)`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS dois_fa_ativo BOOLEAN DEFAULT false`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tipo_prestador VARCHAR(20)`)
    // Auditoria de aprovação: true = aprovado pelo job automático (Modo Auto ON) sem revisão
    // de idoneidade; false = aprovado/reprovado manualmente por admin; null = legado/não tocado.
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS aprovado_automaticamente BOOLEAN`)
    // Tela de boas-vindas única do prestador: false = ainda não exibida; true = já dispensada (não exibir de novo).
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS boas_vindas_exibida BOOLEAN DEFAULT false`)
    // Localização do prestador no cadastro (CEP → ViaCEP/Nominatim). Base p/ distância futura.
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cep VARCHAR(8)`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS latitude NUMERIC`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS longitude NUMERIC`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS logradouro VARCHAR(200)`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS numero VARCHAR(20)`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS complemento VARCHAR(100)`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bairro VARCHAR(100)`)
    // Diagnóstico de push: por que o usuário está sem push_token. Hoje só existe o sinal
    // push_token IS NULL, que confunde cinco estados distintos. push_status registra o
    // motivo, reportado pelo app. Valores aceitos (texto puro, sem CHECK — mesma convenção
    // de verificacao_status): 'concedida' (permissão dada), 'negada' (permissão recusada),
    // 'bloqueada' (recusa permanente, canAskAgain=false), 'erro_registro' (falha ao obter/
    // enviar o token), 'nao_solicitada' (app nunca chegou a pedir a permissão). Default
    // 'desconhecido' enquanto o app ainda não reportou.
    // push_status_em = quando o estado foi observado (sem default: NULL até o 1º report,
    // evitando o rewrite de tabela que um default volátil como NOW() forçaria). Colunas
    // aditivas: nenhuma query existente as lê.
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS push_status VARCHAR(50) DEFAULT 'desconhecido'`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS push_status_em TIMESTAMPTZ`)
    // Flag global "Modo Auto" — garante a existência da linha (tabela já existe em prod).
    // Default 'false' = OFF: novos prestadores aguardam revisão manual do admin.
    await client.query(`CREATE TABLE IF NOT EXISTS configuracoes (chave TEXT PRIMARY KEY, valor TEXT, atualizado_em TIMESTAMPTZ DEFAULT NOW())`)
    await client.query(`INSERT INTO configuracoes (chave, valor)
                        SELECT 'aprovacao_automatica', 'false'
                        WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = 'aprovacao_automatica')`)
    // Janela de lançamento grátis — valor = timestamp ISO enquanto o período está
    // ativo, string vazia '' quando desligado. Governa apenas NOVOS cadastros; linhas
    // tipo='gratuito' já criadas permanecem grátis (a lógica de aprovação mesclada
    // mantém proximo_vencimento NULL para elas). Admin liga/desliga pelo painel.
    // valor é NOT NULL: seed com '' (não NULL) para não violar a constraint no boot.
    await client.query(`INSERT INTO configuracoes (chave, valor)
                        SELECT 'lancamento_data_fim', ''
                        WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = 'lancamento_data_fim')`)
    // Flag global "Aprovação automática de OBRAS" — ligada, a obra enviada pelo dono é
    // publicada na hora, sem passar pela fila do admin. Default 'false' = OFF: mantém a
    // revisão manual de hoje. Mesma convenção das duas chaves acima (valor TEXT 'true'/'false').
    await client.query(`INSERT INTO configuracoes (chave, valor)
                        SELECT 'aprovacao_automatica_obras', 'false'
                        WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = 'aprovacao_automatica_obras')`)
    // Teto de demandas simultâneas para dono sem histórico (ver limiteDemandasAtingido).
    // valor = inteiro positivo em TEXT, como as demais chaves. Admin ajusta pelo painel.
    await client.query(`INSERT INTO configuracoes (chave, valor)
                        SELECT 'limite_demandas_live_sem_historico', '5'
                        WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = 'limite_demandas_live_sem_historico')`)
    // Resposta da equipe às dúvidas (mensagens): quem respondeu e quando. As DUAS colunas já
    // eram escritas por mensagensController.responder e lidas por porObra, mas nunca existiram
    // na tabela — as duas rotas estouravam 42703 e devolviam 500. Tipos batendo com o que o
    // controller grava: respondido_por = req.usuario.id (uuid), respondido_em = NOW() (timestamptz).
    await client.query(`ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS respondido_por UUID`)
    await client.query(`ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS respondido_em  TIMESTAMPTZ`)
    // Fila de dúvidas sem resposta: índice PARCIAL sobre o mesmo predicado que GET
    // /mensagens/pendentes e o contador do /dashboard usam (respondido = false). Chave
    // criado_em porque a listagem ordena por ela — o índice serve a contagem e à página.
    // Parcial de propósito: a fila é a minoria das linhas, e respondidas não entram no índice.
    await client.query(`CREATE INDEX IF NOT EXISTS mensagens_pendentes_idx ON mensagens (criado_em) WHERE respondido = false`)
    // Redundante: mesmo predicado parcial do mensagens_pendentes_idx acima e, dentro dele,
    // `respondido` é constante — a chave efetiva dos dois é (criado_em).
    await client.query(`DROP INDEX IF EXISTS idx_mensagens_respondido`)
    // Contratos de reparo: referência ao interesse aceito (paridade com candidatura_id de obra)
    await client.query(`ALTER TABLE contratos ADD COLUMN IF NOT EXISTS interesse_id uuid`)
    // Idempotência de criação de obra/reparo — evita duplicatas em retries após timeout/ERR_NETWORK
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS client_request_id TEXT`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS client_request_id TEXT`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS obras_criado_por_client_request_id_uniq ON obras (criado_por, client_request_id) WHERE client_request_id IS NOT NULL`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS reparos_criado_por_client_request_id_uniq ON reparos (criado_por, client_request_id) WHERE client_request_id IS NOT NULL`)
    // Previsão e confirmação de CHEGADA do profissional ao local (obras e reparos, mesmas colunas).
    //   chegada_janela        → rótulo escolhido pelo profissional ('hoje' | 'amanha_manha' | 'amanha_tarde')
    //   chegada_prevista_em   → instante-limite da janela, resolvido em America/Sao_Paulo. Escrito UMA vez.
    //   chegada_declarada_por → quem declarou a chegada PRIMEIRO (dono ou profissional)
    //   chegada_declarada_em  → quando essa primeira declaração entrou
    //   chegada_confirmada_em → chegada confirmada de fato; só o dono confirma (ver POST /:id/chegada)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_janela        TEXT`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_prevista_em   TIMESTAMPTZ`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_declarada_por UUID`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_declarada_em  TIMESTAMPTZ`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_confirmada_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_janela        TEXT`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_prevista_em   TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_declarada_por UUID`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_declarada_em  TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_confirmada_em TIMESTAMPTZ`)
    // Janela de chegada que estoura o expira_em: fica PENDENTE aqui até o dono responder, em vez
    // de virar chegada_prevista_em direto. Sem este par, prometer "amanhã à tarde" numa demanda
    // que vence hoje ou estenderia o prazo sem o dono saber, ou seria recusado sem negociação.
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_pendente_janela TEXT`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_pendente_em     TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_pendente_janela TEXT`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_pendente_em     TIMESTAMPTZ`)
    // Marca que o DONO recusou uma janela. Isenta o profissional de falta e de bloqueio quando o
    // match morre sem nenhuma janela valendo: ele ofereceu um horário, o dono disse não, e a
    // demanda venceu no prazo antigo — o no-show aí é da negociação, não dele.
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_recusada_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_recusada_em TIMESTAMPTZ`)
    // Lista negra POR OBRA, espelho de reparos.prestadores_bloqueados (que nasceu fora deste
    // arquivo — não há ALTER dele aqui). Mesmo nome de coluna nas duas tabelas de propósito: as
    // queries de feed ficam idênticas. Guarda os profissionais que já furaram ESTA demanda; é
    // por linha, não global (a lista global do dono é a tabela prestadores_bloqueados_dono).
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS prestadores_bloqueados UUID[]`)
    // O de reparos existe em produção desde antes deste arquivo, mas nunca teve ALTER aqui —
    // um banco novo (dev/staging) subia sem a coluna e quebrava feed e un-match. IF NOT EXISTS
    // torna isto no-op em produção e obrigatório em qualquer base limpa.
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS prestadores_bloqueados UUID[]`)
    // Índices para o filtro por raio (feed). PostGIS/GiST não é assumido como disponível,
    // então usamos btree em (latitude, longitude) — sempre disponível no Postgres padrão.
    // Acelera a pré-seleção de linhas com coordenadas; o haversine continua sendo calculado por linha.
    await client.query(`CREATE INDEX IF NOT EXISTS obras_lat_lng_idx ON obras (latitude, longitude)`)
    await client.query(`CREATE INDEX IF NOT EXISTS reparos_lat_lng_idx ON reparos (latitude, longitude)`)
    // Flag de contrato enviado — permite detectar matches cujo e-mail de contrato falhou (Finding 3.2)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS contrato_enviado BOOLEAN DEFAULT false`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS contrato_enviado BOOLEAN DEFAULT false`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS encerrado_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS encerrado_em TIMESTAMPTZ`)
    // Encerramento assimétrico: a chamada do PROFISSIONAL a /encerrar registra a solicitação,
    // e o DONO fecha de fato (o dono nunca solicita — encerrar, para ele, encerra na hora).
    // encerramento_solicitado_por IS NOT NULL É o estado pendente — sem status novo no banco:
    // a demanda segue 'aberta' até fechar, e encerrado_em continua significando "fechada de
    // verdade". _por diz QUEM pediu, que é como o handler distingue repetição do profissional
    // (mesma parte, segue pendente) de qualquer outra chamada, que fecha.
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS encerramento_solicitado_por UUID REFERENCES usuarios(id)`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS encerramento_solicitado_em  TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS encerramento_solicitado_por UUID REFERENCES usuarios(id)`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS encerramento_solicitado_em  TIMESTAMPTZ`)
    // Relógio de publicação da obra — traz a obra à paridade que o reparo já tem (criado_em é
    // o instante de publicação do reparo + prazo_atendimento_horas é a janela). horas_para_expirar
    // guarda a janela original; publicado_em guarda o instante em que a obra foi ao ar. A obra
    // nasce 'rascunho' e só publica na aprovação — por isso publicado_em fica NULL até lá (é
    // definido na aprovação), enquanto o reparo publica na criação. NUMERIC (não INTEGER): o
    // backfill deriva horas fracionárias, pois expira_em vem do Date.now() do app e criado_em do
    // NOW() do banco, então (expira_em - criado_em) carrega o atraso da request (sub-segundo).
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS horas_para_expirar NUMERIC`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS publicado_em TIMESTAMPTZ`)
    // Backfill idempotente (WHERE ... IS NULL) e NULL-safe. Correto porque NENHUM endpoint de
    // extensão jamais existiu: até aqui o expira_em de toda obra é exatamente criado_em + janela
    // original, então (expira_em - criado_em) reconstrói a janela. COALESCE p/ 720 cobre linha
    // com timestamp nulo — horas_para_expirar nunca fica NULL. publicado_em = criado_em porque
    // historicamente o relógio sempre correu desde a criação (rascunho existente é sobrescrito
    // por publicado_em = NOW() na aprovação, então o valor do backfill nele é inócuo).
    await client.query(`
      UPDATE obras SET horas_para_expirar = COALESCE(EXTRACT(EPOCH FROM (expira_em - criado_em)) / 3600, 720)
      WHERE horas_para_expirar IS NULL
    `)
    await client.query(`
      UPDATE obras SET publicado_em = criado_em
      WHERE publicado_em IS NULL
    `)
    // Marcos de expiração PROPORCIONAIS: NULL = marco ainda não disparado; o job seta o timestamp
    // ao disparar (claim). Ver verificarMarcosExpiracao + src/utils/faixasPrazo.js.
    // Marcos genéricos (1º/2º/3º) — os offsets variam por faixa de prazo (ver faixasPrazo.js), então
    // as colunas guardam só "qual marco já foi enviado", com o tempo definido pela faixa em código.
    // Passo 4/6: estas são as colunas ATIVAS — o job, os índices parciais e o estender usam elas.
    // As 4 antigas (marco_6h/60/30/15_em) NÃO são derrubadas neste boot (expand/contract): sua
    // remoção fica deferida ao passo 4b, quando o job novo estiver confirmado limpo em produção e o
    // container anterior já tiver saído.
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS marco_1_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS marco_2_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS marco_3_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS marco_1_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS marco_2_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS marco_3_em TIMESTAMPTZ`)
    // Idempotência de POST /reparos/:id/estender e de POST /obras/:id/estender — nenhum dos dois
    // tem client_request_id, então a chave de dedupe é a própria última extensão aplicada:
    // (instante, horas). Um retry com o MESMO horas dentro da janela curta devolve o prazo atual em
    // vez de somar de novo. NULL nas duas colunas = demanda que ainda não foi estendida (nenhum
    // backfill: não há histórico de onde tirar esses valores, e NULL já significa "sem extensão
    // recente" na guarda do UPDATE). obras recebeu as colunas depois do reparo: sem elas, cada
    // retry do app somava outra extensão inteira — exatamente o que a guarda do reparo já evitava.
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS ultima_extensao_em    TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS ultima_extensao_horas NUMERIC`)
    // Faixa "Hoje": prazo que vence no FIM DO DIA em Brasília, não N horas depois da publicação.
    // Marcador, não duração — ver PRAZO_MODO_HOJE em src/utils/faixasPrazo.js para o porquê de
    // não usar sentinela nas colunas de horas. NULL = faixa por duração (todo o histórico).
    // Aditiva e sem DEFAULT: nenhuma reescrita de tabela, nenhuma query existente a lê.
    // Os TRÊS caminhos que escrevem/reconstroem expira_em consultam esta coluna: o create, o
    // aprovarEPublicarObra e os dois crons de cronômetro (alertaService).
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS prazo_modo TEXT`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS prazo_modo TEXT`)
    // Zona IANA em que "Hoje" é resolvido, enviada pelo cliente no create. Coluna SEPARADA em
    // vez de embutir a zona no próprio prazo_modo ('hoje:America/Manaus'): prazo_modo continua
    // sendo o MODO, sem split_part no SQL dos dois caminhos que reconstroem expira_em, e uma
    // faixa futura pode entrar sem colidir com o parsing. NULL = usar TZ_PADRAO (linhas
    // gravadas antes desta mudança, e qualquer linha cujo cliente não mandou zona utilizável).
    // Só em OBRAS: o lado reparo não tem faixa "Hoje" e seu cliente não manda zona.
    // Aditiva e sem DEFAULT: nenhuma reescrita de tabela.
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS prazo_timezone TEXT`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS ultima_extensao_em    TIMESTAMPTZ`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS ultima_extensao_horas NUMERIC`)
    // Índice parcial do job de marcos (roda a cada 1min). Coluna líder expira_em: o range scan lê
    // só as demandas prestes a expirar. O WHERE parcial (TIME-FREE, sem NOW()) mantém o índice
    // pequeno: exclui match, não-aprovadas (obras) e as que já enviaram os 3 marcos genéricos.
    // Passo 4: DROP do índice antigo (predicado nos marco_6h/60/30/15) ANTES do CREATE porque reusa
    // o MESMO nome; recria com o predicado dos marcos genéricos (marco_1/2/3). Criado AQUI, no bloco
    // de boot, portanto ANTES de iniciarAgendador() registrar o job (server.js).
    await client.query(`DROP INDEX IF EXISTS obras_marcos_pendentes_idx`)
    await client.query(`DROP INDEX IF EXISTS reparos_marcos_pendentes_idx`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS obras_marcos_pendentes_idx ON obras (expira_em)
      WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND match_usuario_id IS NULL
        AND (marco_1_em IS NULL OR marco_2_em IS NULL OR marco_3_em IS NULL)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS reparos_marcos_pendentes_idx ON reparos (expira_em)
      WHERE status = 'aberta' AND match_usuario_id IS NULL
        AND (marco_1_em IS NULL OR marco_2_em IS NULL OR marco_3_em IS NULL)
    `)
    // As 4 colunas antigas de marco (marco_6h/60/30/15_em) NÃO são derrubadas aqui — padrão
    // expand/contract. O deploy do Railway é overlapping (sem railway.json → health-check default):
    // o container ANTIGO ainda roda o job de 1min e o /estender antigos durante a janela de overlap;
    // se derrubássemos as colunas agora, esse código antigo bateria em coluna inexistente (job:
    // erro engolido pelo try/catch, mas alertas perdidos; /estender: 500 pro usuário). As colunas
    // ficam órfãs mas inofensivas (o job novo e o /estender novo só usam marco_1/2/3_em).
    //
    // DEFERRED (4b): DROP COLUMN marco_6h/60/30/15_em on obras+reparos + drop old index — only after
    // the new milestone job is confirmed clean in prod and the previous container is gone;
    // unconditionally safe then because no running code will reference these columns.
    // Índice parcial do cronômetro de obras (job de 1min): coluna líder expira_em para o range
    // scan de matches prestes a expirar. Predicado TIME-FREE (só status e match_usuario_id, ambos
    // imutáveis) — Postgres proíbe NOW()/CURRENT_TIMESTAMP em índice parcial; o filtro temporal
    // (expira_em <= NOW()) vive no WHERE do JOB, não no índice. Pequeno: só obras casadas e abertas.
    await client.query(`
      CREATE INDEX IF NOT EXISTS obras_matches_pendentes_idx ON obras (expira_em)
      WHERE status = 'aberta' AND match_usuario_id IS NOT NULL
    `)
    // Sem backfill anti-rajada: as bandas disjuntas do job garantem no máximo UM marco por run
    // (a demanda cai em uma banda só), então o 1º run pós-deploy não gera rajada — cada demanda
    // dispara no máximo o marco da banda em que está agora. (O backfill antigo, que marcava os
    // marcos fixos já passados, saiu junto com as colunas antigas.)
    // "Esta semana" passou de 72h para 168h (7 dias). Reclassifica as demandas legadas de faixa:
    // 72 → 168, apenas a coluna de janela (o rótulo da faixa para os marcos proporcionais futuros).
    // NÃO mexe em expira_em — as linhas mantêm o prazo atual que já foi calculado a partir de 72h;
    // recalcular empurraria deadlines ao vivo. Idempotente: após rodar, nenhuma linha tem 72, então
    // re-executar a cada boot é no-op. Update de valor simples, sem risco de constraint (não lança).
    // Obras hoje não têm nenhuma linha 72 → no-op inofensivo, mantido por simetria com reparos.
    await client.query(`UPDATE reparos SET prazo_atendimento_horas = 168 WHERE prazo_atendimento_horas = 72`)
    await client.query(`UPDATE obras   SET horas_para_expirar      = 168 WHERE horas_para_expirar      = 72`)
    // Backfill one-time de encerrado_em para linhas já encerradas antes da coluna existir.
    // Usa match_feito_em como melhor aproximação, caindo para criado_em quando o item foi
    // encerrado sem nunca ter match. Idempotente via WHERE encerrado_em IS NULL.
    await client.query(`
      UPDATE obras SET encerrado_em = COALESCE(match_feito_em, criado_em)
      WHERE status = 'encerrada' AND encerrado_em IS NULL
    `)
    await client.query(`
      UPDATE reparos SET encerrado_em = COALESCE(match_feito_em, criado_em)
      WHERE status = 'encerrada' AND encerrado_em IS NULL
    `)
    // Índices para FKs e filtros quentes (feed + ownership). Sem eles, as subqueries
    // correlacionadas do feed e os lookups por usuário/obra/reparo fazem seq scan.
    // interesse_reparos_reparo_id_idx (reparo_id) NÃO é mais criado: é prefixo à esquerda do
    // idx_interesse_reparo_usuario (reparo_id, usuario_id), que já existe.
    await client.query(`CREATE INDEX IF NOT EXISTS interesse_reparos_usuario_id_idx ON interesse_reparos (usuario_id)`)
    // Redundante: duplicata exata do interesse_reparos_usuario_id_idx acima.
    await client.query(`DROP INDEX IF EXISTS idx_interesse_usuario_id`)
    // candidaturas_obra_id_idx (obra_id) NÃO é mais criado: é prefixo à esquerda do UNIQUE
    // candidaturas_obra_id_usuario_id_key (obra_id, usuario_id).
    await client.query(`CREATE INDEX IF NOT EXISTS candidaturas_usuario_id_idx ON candidaturas (usuario_id)`)
    // Redundante: duplicata exata do candidaturas_usuario_id_idx acima.
    await client.query(`DROP INDEX IF EXISTS idx_candidaturas_usuario_id`)
    await client.query(`CREATE INDEX IF NOT EXISTS midias_obra_id_idx ON midias (obra_id)`)
    // Redundante: duplicata exata do midias_obra_id_idx acima.
    await client.query(`DROP INDEX IF EXISTS idx_midias_obra_id`)
    await client.query(`CREATE INDEX IF NOT EXISTS midias_reparos_reparo_id_idx ON midias_reparos (reparo_id)`)
    // Redundante: duplicata exata do midias_reparos_reparo_id_idx acima.
    await client.query(`DROP INDEX IF EXISTS idx_midias_reparos_reparo_id`)
    // reparos_feed_idx: match_usuario_id incluído p/ paridade com obras_feed_idx — GET /reparos
    // também filtra match_usuario_id IS NULL, e a definição de 3 colunas parava antes disso.
    // DROP antes do CREATE porque IF NOT EXISTS casa por NOME: sem o drop a definição antiga
    // sobreviveria (mesmo padrão do obras_feed_idx logo abaixo).
    await client.query(`DROP INDEX IF EXISTS reparos_feed_idx`)
    await client.query(`CREATE INDEX IF NOT EXISTS reparos_feed_idx ON reparos (status, status_aprovacao, expira_em, match_usuario_id)`)
    // Redundantes: (status) e (status, status_aprovacao, expira_em) são prefixos à esquerda
    // do reparos_feed_idx acima.
    await client.query(`DROP INDEX IF EXISTS idx_reparos_status`)
    await client.query(`DROP INDEX IF EXISTS idx_reparos_status_expira`)
    // obras_feed_idx: inclui status_aprovacao e match_usuario_id p/ paridade com reparos_feed_idx,
    // e `valor DESC NULLS LAST` como coluna final — é a SEGUNDA chave do ORDER BY do feed
    // (`o.expira_em ASC, o.valor DESC NULLS LAST`). Um índice separado só em valor não serve a
    // uma ordenação de duas chaves; ela só é coberta pelo composto, na ordem das chaves.
    // DESC NULLS LAST explícito: em btree, DESC assume NULLS FIRST, que não é a ordem pedida.
    // Drop do índice antigo (mais estreito) antes de recriar com as colunas corretas.
    await client.query(`DROP INDEX IF EXISTS obras_feed_idx`)
    await client.query(`CREATE INDEX IF NOT EXISTS obras_feed_idx ON obras (status, status_aprovacao, expira_em, match_usuario_id, valor DESC NULLS LAST)`)
    // Redundante: (status) é prefixo à esquerda do obras_feed_idx acima.
    // idx_obras_status_expira NÃO cai: é (status, expira_em), e no feed status_aprovacao
    // fica ENTRE as duas colunas — não é prefixo deste índice.
    await client.query(`DROP INDEX IF EXISTS idx_obras_status`)
    // Filtro quente do cron de proximidade (15min): lp.atualizado_em > NOW() - 30min.
    await client.query(`CREATE INDEX IF NOT EXISTS localizacoes_prestadores_atualizado_em_idx ON localizacoes_prestadores (atualizado_em)`)

    // ---- Índices da auditoria de escala: cada um nomeia a query/job que serve ----
    // GET /obras (obrasController.listar): filtro `o.categoria = $n`. reparos já tinha
    // idx_reparos_categoria; obras não tinha equivalente.
    await client.query(`CREATE INDEX IF NOT EXISTS obras_categoria_idx ON obras (categoria)`)
    // GET /obras com raio_km='estado': filtro `o.uf = $n`.
    await client.query(`CREATE INDEX IF NOT EXISTS obras_uf_idx ON obras (uf)`)
    // GET /obras: `NOT ($1 = ANY(COALESCE(o.prestadores_bloqueados,'{}')))` — sem GIN a lista
    // negra é avaliada linha a linha. GIN é o método para busca de pertencimento em array.
    await client.query(`CREATE INDEX IF NOT EXISTS obras_prestadores_bloqueados_gin_idx ON obras USING GIN (prestadores_bloqueados)`)
    // (A segunda chave do ORDER BY do feed, `o.valor DESC NULLS LAST`, entra como coluna final
    // do obras_feed_idx acima — índice avulso em valor não cobriria ordenação de duas chaves.)
    // GET /obras/minhas: WHERE criado_por = $1 ... ORDER BY criado_em DESC — o índice só de
    // criado_por cobria o filtro e deixava a ordenação para um sort a cada chamada.
    await client.query(`CREATE INDEX IF NOT EXISTS obras_criado_por_criado_em_idx ON obras (criado_por, criado_em DESC)`)
    // Redundantes: ambos são só (criado_por), prefixo à esquerda do composto acima. Os CREATEs
    // deles foram removidos deste bloco — criar e derrubar a cada boot é trabalho jogado fora.
    await client.query(`DROP INDEX IF EXISTS obras_criado_por_idx`)
    await client.query(`DROP INDEX IF EXISTS idx_obras_criado_por`)
    // GET /reparos/minhas: idem.
    await client.query(`CREATE INDEX IF NOT EXISTS reparos_criado_por_criado_em_idx ON reparos (criado_por, criado_em DESC)`)
    // Redundantes: ambos são só (criado_por), prefixo à esquerda do composto acima. Os CREATEs
    // deles foram removidos deste bloco (mesmo motivo do lado obra).
    await client.query(`DROP INDEX IF EXISTS reparos_criado_por_idx`)
    await client.query(`DROP INDEX IF EXISTS idx_reparos_criado_por`)

    // ---- Redundantes cujo índice supersedente NÃO é criado por este bloco ----
    // (são índices de CONSTRAINT, nascidos com a tabela, ou índices legados já existentes —
    // então sempre existem antes destes drops, e a ordem "drop depois do create" é atendida.)
    // usuarios_email_key (UNIQUE em email) supersede — e ainda enforça a constraint.
    await client.query(`DROP INDEX IF EXISTS idx_usuarios_email`)
    // candidaturas_obra_id_usuario_id_key (UNIQUE em (obra_id, usuario_id)) supersede as três:
    // duas são o prefixo (obra_id), a outra é a mesma dupla de colunas. candidaturas_obra_id_idx
    // teve o CREATE removido daqui, mas segue no banco de deploys anteriores — só o drop o tira.
    await client.query(`DROP INDEX IF EXISTS idx_candidaturas_obra_id`)
    await client.query(`DROP INDEX IF EXISTS idx_candidaturas_obra_usuario`)
    await client.query(`DROP INDEX IF EXISTS candidaturas_obra_id_idx`)
    // idx_interesse_reparo_usuario (reparo_id, usuario_id), legado, supersede o prefixo (reparo_id).
    // interesse_reparos_reparo_id_idx idem: CREATE removido, mas a linha antiga persiste no banco.
    await client.query(`DROP INDEX IF EXISTS idx_interesse_reparo_id`)
    await client.query(`DROP INDEX IF EXISTS interesse_reparos_reparo_id_idx`)
    // Cron verificarCronometroReparos (60s): espelha obras_matches_pendentes_idx, que só
    // existia do lado obra — o lado reparo varria sem índice de apoio a cada minuto.
    await client.query(`
      CREATE INDEX IF NOT EXISTS reparos_matches_pendentes_idx ON reparos (expira_em)
      WHERE status = 'aberta' AND match_usuario_id IS NOT NULL
    `)
    // Cron autoEncerrarPendentes (5min), 1º predicado — encerramento em duas mãos vencido:
    // status='aberta' AND encerramento_solicitado_por IS NOT NULL AND encerramento_solicitado_em <= NOW()-prazo.
    await client.query(`
      CREATE INDEX IF NOT EXISTS obras_encerramento_pendente_idx ON obras (encerramento_solicitado_em)
      WHERE status = 'aberta' AND encerramento_solicitado_por IS NOT NULL
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS reparos_encerramento_pendente_idx ON reparos (encerramento_solicitado_em)
      WHERE status = 'aberta' AND encerramento_solicitado_por IS NOT NULL
    `)
    // Cron autoEncerrarPendentes (5min), 2º predicado — auto-confirmação de chegada:
    // chegada_declarada_em IS NOT NULL AND chegada_confirmada_em IS NULL AND chegada_declarada_em <= NOW()-prazo.
    await client.query(`
      CREATE INDEX IF NOT EXISTS obras_chegada_a_confirmar_idx ON obras (chegada_declarada_em)
      WHERE chegada_declarada_em IS NOT NULL AND chegada_confirmada_em IS NULL
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS reparos_chegada_a_confirmar_idx ON reparos (chegada_declarada_em)
      WHERE chegada_declarada_em IS NOT NULL AND chegada_confirmada_em IS NULL
    `)
    // Cron deletarMidiasAntigas (24h): varre encerrado_em das DEMANDAS (não das mídias) —
    // status IN ('encerrada','cancelada') AND encerrado_em IS NOT NULL AND < NOW()-7 dias.
    // O predicado inclui 'cancelada' junto com o job: demanda cancelada também guarda mídia
    // para sempre, e um índice mais estreito que a consulta deixaria de ser usado por ela.
    // DROP antes do CREATE porque IF NOT EXISTS casa por NOME — sem o drop a definição antiga
    // (só 'encerrada') sobreviveria (mesmo padrão do obras_feed_idx).
    await client.query(`DROP INDEX IF EXISTS obras_encerrado_em_idx`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS obras_encerrado_em_idx ON obras (encerrado_em)
      WHERE status IN ('encerrada', 'cancelada') AND encerrado_em IS NOT NULL
    `)
    await client.query(`DROP INDEX IF EXISTS reparos_encerrado_em_idx`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS reparos_encerrado_em_idx ON reparos (encerrado_em)
      WHERE status IN ('encerrada', 'cancelada') AND encerrado_em IS NOT NULL
    `)
    // No máximo um aceito por reparo/obra — enforce no nível do banco (Finding 2.1).
    // Dedup ANTES dos índices únicos: mantém o 'aceito' mais recente por job e rebaixa
    // os demais para 'recusado', senão o CREATE UNIQUE INDEX falha em dados legados.
    await client.query(`
      UPDATE interesse_reparos SET status = 'recusado'
      WHERE status = 'aceito'
      AND id NOT IN (
        SELECT DISTINCT ON (reparo_id) id
        FROM interesse_reparos
        WHERE status = 'aceito'
        ORDER BY reparo_id, criado_em DESC
      )
    `)
    await client.query(`
      UPDATE candidaturas SET status = 'recusado'
      WHERE status = 'aceito'
      AND id NOT IN (
        SELECT DISTINCT ON (obra_id) id
        FROM candidaturas
        WHERE status = 'aceito'
        ORDER BY obra_id, criado_em DESC
      )
    `)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS interesse_reparos_aceito_unico_idx ON interesse_reparos (reparo_id) WHERE status = 'aceito'`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS candidaturas_aceito_unica_idx ON candidaturas (obra_id) WHERE status = 'aceito'`)
    // Uma única assinatura por usuário (Finding 4.1). Dedup ANTES do índice único:
    // mantém a linha mais relevante por usuario_id (prefere 'ativa', depois mais recente).
    await client.query(`
      DELETE FROM assinaturas
      WHERE id NOT IN (
        SELECT DISTINCT ON (usuario_id) id
        FROM assinaturas
        ORDER BY usuario_id,
          CASE status WHEN 'ativa' THEN 1 WHEN 'pendente_verificacao' THEN 2 ELSE 3 END ASC,
          criado_em DESC
      )
    `)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS assinaturas_usuario_id_unico_idx ON assinaturas (usuario_id)`)
    // Redundantes sob o UNIQUE acima: (usuario_id) é a mesma coluna, e (usuario_id, status)
    // não acrescenta nada — sendo usuario_id único, no máximo uma linha casa por usuário.
    // O UNIQUE é alvo do ON CONFLICT (usuario_id) de ativarAssinatura e nunca pode cair.
    await client.query(`DROP INDEX IF EXISTS idx_assinaturas_usuario_id`)
    await client.query(`DROP INDEX IF EXISTS idx_assinaturas_usuario_status`)
    // Cron de expiração (1h) e aviso de vencimento (1h): WHERE status='ativa' AND proximo_vencimento < NOW().
    await client.query(`CREATE INDEX IF NOT EXISTS assinaturas_status_vencimento_idx ON assinaturas (status, proximo_vencimento)`)
    // Redundante: (status) é prefixo à esquerda do assinaturas_status_vencimento_idx acima.
    await client.query(`DROP INDEX IF EXISTS idx_assinaturas_status`)
    // Marcos do aviso de vencimento da ASSINATURA — mesmo padrão dos marcos de demanda
    // (obras/reparos.marco_1_em/2_em/3_em): a coluna é o CLAIM, preenchida no mesmo UPDATE
    // que reivindica o envio, então re-run ou segunda réplica nunca manda duas vezes.
    //   marco_1_em → faltando <= 24h  |  marco_2_em → <= 12h  |  marco_3_em → <= 6h
    // NULL = ainda não avisado. Todo caminho que empurra proximo_vencimento para frente
    // zera as três (senão o ciclo seguinte nunca mais avisaria).
    await client.query(`ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS marco_1_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS marco_2_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS marco_3_em TIMESTAMPTZ`)
    // Índice PARCIAL do predicado do job: só linhas ativas com algum marco pendente entram,
    // que é a minoria — as já avisadas nas três bandas saem do índice sozinhas.
    await client.query(`CREATE INDEX IF NOT EXISTS assinaturas_marcos_vencimento_idx
                        ON assinaturas (proximo_vencimento)
                        WHERE status = 'ativa'
                          AND (marco_1_em IS NULL OR marco_2_em IS NULL OR marco_3_em IS NULL)`)
    // Backfill do uf: linhas antigas têm cidade preenchida mas uf NULL, então sumiam do
    // filtro "Estado" (o.uf/r.uf) mesmo aparecendo em "Cidade". Cidades conhecidas e
    // inequívocas (todas em MG). Idempotente via WHERE uf IS NULL.
    await client.query(`UPDATE obras   SET uf = 'MG' WHERE uf IS NULL AND cidade = 'Patos de Minas'`)
    await client.query(`UPDATE reparos SET uf = 'MG' WHERE uf IS NULL AND cidade IN ('Patos de Minas', 'Formiga')`)
    // Backfill de coordenadas — mesmo espírito do backfill de uf acima. Linhas antigas
    // nasceram sem lat/lng porque o geocode do app é best-effort e falha em silêncio; sem
    // coordenada a demanda fica invisível ao filtro por raio (exige latitude IS NOT NULL),
    // ao cron de proximidade (server.js:107) e ao rótulo de distância do card. Preenche com
    // o CENTRO do município e marca coordenadas_origem='centro_cidade'.
    // Idempotente: WHERE latitude IS NULL AND longitude IS NULL → reexecução não casa nada.
    // Não-destrutivo: só toca linhas SEM as duas coordenadas, então nunca sobrescreve uma
    // coordenada real (ex.: o reparo de Ituiutaba, que já tem lat/lng corretas).
    // Município não resolvido (nome ambíguo sem uf, grafia fora do IBGE) → registra e PULA.
    for (const tabela of ['reparos', 'obras']) {
      const grupos = await client.query(
        `SELECT cidade, uf, COUNT(*)::int AS linhas
           FROM ${tabela}
          WHERE latitude IS NULL AND longitude IS NULL
            AND cidade IS NOT NULL AND btrim(cidade) <> ''
          GROUP BY cidade, uf`
      )
      let preenchidas = 0
      const naoResolvidos = []
      for (const g of grupos.rows) {
        const centro = coordsDeCidade(g.cidade, g.uf)
        if (!centro) {
          naoResolvidos.push(`${g.cidade}/${g.uf || 'sem uf'} (${g.linhas} linha[s])`)
          continue
        }
        const r = await client.query(
          `UPDATE ${tabela}
              SET latitude = $1, longitude = $2, coordenadas_origem = 'centro_cidade'
            WHERE latitude IS NULL AND longitude IS NULL
              AND cidade = $3 AND (uf = $4 OR (uf IS NULL AND $4 IS NULL))`,
          [centro.lat, centro.lng, g.cidade, g.uf]
        )
        if (r.rowCount > 0) {
          preenchidas += r.rowCount
          console.log(`[migration][coords] ${tabela}: ${r.rowCount} linha(s) em ${g.cidade}/${centro.uf} -> ${centro.lat}, ${centro.lng}`)
        }
      }
      // Meia-coordenada (só uma das duas colunas nula) é inútil para o raio, que exige as
      // duas. Não é preenchida de propósito — sobrescrever a metade preenchida apagaria um
      // dado real. Só reporta, para não sumir do radar.
      const meias = await client.query(
        `SELECT COUNT(*)::int AS n FROM ${tabela}
          WHERE (latitude IS NULL) <> (longitude IS NULL)`
      )
      console.log(`[migration][coords] ${tabela}: ${preenchidas} linha(s) preenchida(s)` +
        (naoResolvidos.length ? ` | municipio nao resolvido, PULADO: ${naoResolvidos.join(', ')}` : '') +
        (meias.rows[0].n ? ` | ATENCAO ${meias.rows[0].n} linha(s) com apenas uma coordenada (nao tocadas)` : ''))
    }
    // Backfill de tipo_prestador (fix de preço no checkout PagBank). Prestadores com
    // tipo_prestador NULL (linhas legadas/criadas fora do cadastro() — origem no painel-admin
    // ou insert manual) quebrariam o checkout novo, que exige 'reparador' ou 'pintor' e
    // devolve 422 caso contrário. Deriva o tier do valor_mensal JÁ gravado na assinatura no
    // ato do cadastro (evidência autoritativa do que a pessoa contratou):
    //   49.90 / 499.00 → reparador   |   99.90 / 999.00 → pintor
    // Idempotente: WHERE tipo_prestador IS NULL → 0 linhas em reexecução (no-op, não lança).
    // Não-destrutivo: só preenche NULLs, nunca sobrescreve um tier já definido. Um join sem
    // assinatura correspondente simplesmente não casa nenhuma linha (também no-op).
    await client.query(`
      UPDATE usuarios u SET tipo_prestador = 'reparador'
      FROM assinaturas a
      WHERE a.usuario_id = u.id
        AND u.role = 'prestador' AND u.tipo_prestador IS NULL
        AND a.valor_mensal IN (49.90, 499.00)
    `)
    await client.query(`
      UPDATE usuarios u SET tipo_prestador = 'pintor'
      FROM assinaturas a
      WHERE a.usuario_id = u.id
        AND u.role = 'prestador' AND u.tipo_prestador IS NULL
        AND a.valor_mensal IN (99.90, 999.00)
    `)
    // Limpeza de linhas órfãs deixadas por exclusões antigas que falhavam no meio da
    // transação (ver B72-01). Uma assinatura órfã (usuario_id de usuário já apagado)
    // não afeta o novo cadastro do mesmo CPF — ele recebe novo id — mas suja relatórios
    // e a base. Idempotente: só apaga o que não tem usuário correspondente.
    await client.query(`DELETE FROM assinaturas a WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = a.usuario_id)`)
    await client.query(`DELETE FROM localizacoes_prestadores lp WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = lp.usuario_id)`)
    // A1 — o app envia o cpf_cnpj JÁ MASCARADO e o INSERT o grava cru (só o índice
    // normaliza p/ dígitos). Mascarado, um CPF tem 14 chars ("123.456.789-00") e um CNPJ
    // tem 18 ("12.345.678/0001-90"). A coluna cabia o CPF (14) mas era estreita demais p/
    // o CNPJ (18): o INSERT era REJEITADO pelo Postgres (22001 value too long), caía no
    // catch como 500 e o app exibia "Conexão lenta"/"já cadastrado" — NENHUM CNPJ
    // conseguia se cadastrar. Alargamos p/ TEXT (não VARCHAR(14) — insuficiente p/ os 18
    // chars do CNPJ mascarado): varchar→text é BINÁRIO-COERCÍVEL → SEM rewrite da tabela
    // (só um ACCESS EXCLUSIVE lock breve) e TEXT remove qualquer teto de comprimento; quem
    // garante a unicidade real é o índice NORMALIZADO (dígitos), não o limite do varchar.
    //
    // ÍNDICE DEPENDENTE (usuarios_cpf_cnpj_normalizado_unico_idx): NÃO precisa de
    // DROP/CREATE manual. O ALTER COLUMN ... TYPE reconstrói automaticamente os índices
    // que dependem da coluna, de forma transacional, dentro deste mesmo BEGIN. E como o
    // índice é sobre uma EXPRESSÃO cujo tipo de saída é sempre `text`
    // (regexp_replace(...) retorna text tanto para varchar quanto para text de entrada),
    // a chave e a operator class do índice NÃO mudam — a reconstrução é trivialmente
    // válida, sem risco de incompatibilidade. Único bloqueador possível de um ALTER TYPE
    // seria uma VIEW/rule dependente da coluna (não há; ver query de pré-checagem no PR).
    //
    // Guardado por tipo: roda o ALTER UMA vez (quando ainda é varchar). Em boots
    // seguintes a coluna já é `text` e o bloco não faz NADA — sem lock, sem reindex.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'usuarios' AND column_name = 'cpf_cnpj'
            AND data_type <> 'text'
        ) THEN
          ALTER TABLE usuarios ALTER COLUMN cpf_cnpj TYPE TEXT;
        END IF;
      END $$;
    `)
    // Fail-loud: alargar a coluna NÃO altera valores já gravados, logo nenhum duplicado NOVO
    // pode surgir daqui. Ainda assim asseguramos alto — se por qualquer motivo existirem dois
    // cpf_cnpj que normalizam igual, aborta a migração (RAISE → catch → ROLLBACK → server não
    // sobe) com mensagem clara, em vez de deixar o CREATE UNIQUE INDEX abaixo falhar obscuro.
    await client.query(`
      DO $$
      DECLARE dups int;
      BEGIN
        SELECT count(*) INTO dups FROM (
          SELECT regexp_replace(cpf_cnpj, '[^0-9]', '', 'g') AS n
          FROM usuarios
          WHERE cpf_cnpj IS NOT NULL AND cpf_cnpj <> ''
          GROUP BY 1 HAVING count(*) > 1
        ) d;
        IF dups > 0 THEN
          RAISE EXCEPTION 'A1: % cpf_cnpj normalizados duplicados — migracao abortada', dups;
        END IF;
      END $$;
    `)
    // UNIQUE no CPF/CNPJ NORMALIZADO (só dígitos) — MESMA expressão dos lookups de
    // cadastro/pré-checagem (regexp_replace(cpf_cnpj,'[^0-9]','','g')). Faz duas coisas:
    //   1) impede CPFs duplicados por corrida (dois submits simultâneos passavam o
    //      SELECT e ambos inseriam, pois não havia constraint — o email já tinha, o CPF não);
    //   2) torna aqueles lookups INDEXÁVEIS, eliminando o Seq Scan (a base cresce rápido
    //      com tráfego pago). Partial WHERE: linhas com cpf_cnpj NULL/vazio não colidem
    //      entre si. Produção tem 0 duplicados hoje (verificado); se um dia houver, o CREATE
    //      falha alto e derruba a migração (transação → ROLLBACK → server não sobe), em vez
    //      de corromper dados. Nome contém "cpf" p/ o handler 23505 do cadastro casar.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS usuarios_cpf_cnpj_normalizado_unico_idx
      ON usuarios ((regexp_replace(cpf_cnpj, '[^0-9]', '', 'g')))
      WHERE cpf_cnpj IS NOT NULL AND cpf_cnpj <> ''
    `)
    // Lista de bloqueio global por dono (separada do array per-reparo prestadores_bloqueados).
    await client.query(`
      CREATE TABLE IF NOT EXISTS prestadores_bloqueados_dono (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dono_id UUID NOT NULL REFERENCES usuarios(id),
        prestador_id UUID NOT NULL REFERENCES usuarios(id),
        criado_em TIMESTAMP DEFAULT NOW(),
        UNIQUE(dono_id, prestador_id)
      )
    `)
    // Redundante: (dono_id) é prefixo à esquerda de prestadores_bloqueados_dono_dono_id_prestador_id_key
    // (UNIQUE), que também é o alvo do ON CONFLICT (dono_id, prestador_id) e nunca pode cair.
    // O CREATE foi removido: criar e derrubar o mesmo índice a cada boot é trabalho jogado fora.
    await client.query(`DROP INDEX IF EXISTS prestadores_bloqueados_dono_dono_idx`)
    await client.query(`CREATE INDEX IF NOT EXISTS prestadores_bloqueados_dono_prestador_idx ON prestadores_bloqueados_dono (prestador_id)`)
    // Faltas (não comparecimento) do profissional. Uma linha por match desfeito pelo CRONÔMETRO
    // — o profissional casou, o prazo venceu e ele nunca declarou chegada. Sem UNIQUE: o mesmo
    // par (profissional, demanda) pode faltar de novo se ele recasar com ela mais tarde, e cada
    // falta conta. `tabela` guarda 'obras' | 'reparos' porque demanda_id não é FK (aponta para
    // uma das duas tabelas), então não há REFERENCES nele.
    await client.query(`
      CREATE TABLE IF NOT EXISTS faltas_profissional (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id UUID NOT NULL REFERENCES usuarios(id),
        tabela TEXT NOT NULL,
        demanda_id UUID NOT NULL,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    // Índice da contagem da janela móvel (usuario_id + criado_em > NOW() - 90 dias).
    await client.query(`CREATE INDEX IF NOT EXISTS faltas_profissional_usuario_criado_idx ON faltas_profissional (usuario_id, criado_em)`)
    // Perdão de falta: linha perdoada continua no histórico (auditoria de quem foi liberado e
    // quando) mas sai da contagem dos 90 dias. Sem isto, liberar uma suspensão devolveria o
    // profissional já com 3 faltas válidas — a próxima falta o suspenderia na hora.
    await client.query(`ALTER TABLE faltas_profissional ADD COLUMN IF NOT EXISTS perdoada_em TIMESTAMPTZ`)
    // Quem perdoou. ON DELETE SET NULL de propósito: sem isso, apagar a conta de um admin que já
    // liberou alguém falharia por violação de FK e derrubaria a transação inteira de exclusão
    // (mesmo risco documentado no DELETE /usuarios/:id). A falta sobrevive com o autor anônimo.
    await client.query(`ALTER TABLE faltas_profissional ADD COLUMN IF NOT EXISTS perdoada_por UUID REFERENCES usuarios(id) ON DELETE SET NULL`)
    // Suspensão por acúmulo de faltas. suspenso_em É a flag: NULL = ativo, preenchido =
    // suspenso (mesma convenção de encerrado_em/chegada_confirmada_em — nada de booleano
    // paralelo que possa divergir do timestamp). suspenso_motivo guarda o porquê legível.
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS suspenso_em     TIMESTAMPTZ`)
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS suspenso_motivo TEXT`)
    // Avaliações 5 estrelas no encerramento — UNILATERAL: só o dono (criado_por) avalia o
    // prestador do match; o prestador recebe 403 em POST /avaliacoes (não avalia de volta).
    // UNIQUE(contrato_tipo, contrato_id, avaliador_id): cada avaliador avalia uma única vez
    // por contrato. Colunas seguem genéricas — ainda há linhas prestador→dono da regra antiga.
    await client.query(`
      CREATE TABLE IF NOT EXISTS avaliacoes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contrato_tipo TEXT NOT NULL CHECK (contrato_tipo IN ('reparo', 'obra')),
        contrato_id UUID NOT NULL,
        avaliador_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        avaliado_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        estrelas INTEGER NOT NULL CHECK (estrelas BETWEEN 1 AND 5),
        criado_em TIMESTAMP DEFAULT NOW(),
        UNIQUE(contrato_tipo, contrato_id, avaliador_id)
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS avaliacoes_avaliado_idx ON avaliacoes (avaliado_id)`)
    // Lembrete de avaliação pendente — MESMO padrão dos marcos de vencimento da assinatura
    // (assinaturas.marco_1_em/2_em/3_em): a coluna É o claim, preenchida no mesmo UPDATE que
    // reivindica o envio, então re-run ou segunda réplica nunca mandam duas vezes.
    //   aval_marco_1_em → 1 dia após encerrado_em  |  aval_marco_2_em → 3 dias após
    // NULL = ainda não lembrado. Nomes prefixados com aval_ porque marco_1_em/2_em/3_em já
    // existem nestas duas tabelas com outro significado (marcos de EXPIRAÇÃO, pré-match).
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS aval_marco_1_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS aval_marco_2_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS aval_marco_1_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS aval_marco_2_em TIMESTAMPTZ`)
    // "Não quero avaliar", registrado NO SERVIDOR (POST /avaliacoes/dispensar). Até aqui essa
    // escolha só existia no dispositivo: o job cutucaria quem já tinha dito não, e uma
    // reinstalação ressuscitaria o card. Preenchido = silenciado para sempre naquele contrato.
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS aval_dispensada_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS aval_dispensada_em TIMESTAMPTZ`)
    // Índice PARCIAL do predicado do job (espelha assinaturas_marcos_vencimento_idx): só
    // encerradas COM match, não dispensadas e com algum marco pendente entram — a minoria.
    // As já lembradas nas duas bandas, e as dispensadas, saem do índice sozinhas.
    // A checagem de "não avaliada" fica de fora: é um NOT EXISTS em avaliacoes, não uma
    // coluna da demanda, então não cabe num índice parcial daqui.
    await client.query(`CREATE INDEX IF NOT EXISTS obras_aval_pendente_idx
                        ON obras (encerrado_em)
                        WHERE status = 'encerrada' AND match_usuario_id IS NOT NULL
                          AND aval_dispensada_em IS NULL
                          AND (aval_marco_1_em IS NULL OR aval_marco_2_em IS NULL)`)
    await client.query(`CREATE INDEX IF NOT EXISTS reparos_aval_pendente_idx
                        ON reparos (encerrado_em)
                        WHERE status = 'encerrada' AND match_usuario_id IS NOT NULL
                          AND aval_dispensada_em IS NULL
                          AND (aval_marco_1_em IS NULL OR aval_marco_2_em IS NULL)`)
    // Denúncias do prestador contra o dono de um contrato encerrado. Espelha avaliacoes:
    // contrato_id é UUID solto (aponta para obras OU reparos, por isso sem FK) e o UNIQUE
    // (contrato_tipo, contrato_id, denunciante_id) garante UMA denúncia por contrato.
    // denunciado_id é NULLABLE com ON DELETE SET NULL de propósito: se o dono excluir a
    // conta, a denúncia SOBREVIVE anonimizada para o histórico de moderação — ao contrário
    // de avaliacoes, que cai por CASCADE. denunciante_id segue CASCADE (a denúncia é do
    // autor; sem autor não há o que apurar).
    await client.query(`
      CREATE TABLE IF NOT EXISTS denuncias (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contrato_tipo TEXT NOT NULL CHECK (contrato_tipo IN ('reparo', 'obra')),
        contrato_id UUID NOT NULL,
        denunciante_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        denunciado_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
        categoria TEXT NOT NULL CHECK (categoria IN ('nao_pagamento','nao_compareceu','servico_diferente','assedio','local_inseguro','fraude','outro')),
        descricao TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','em_analise','resolvida','arquivada')),
        criado_em TIMESTAMP DEFAULT NOW(),
        UNIQUE(contrato_tipo, contrato_id, denunciante_id)
      )
    `)
    // Caminho de acesso do painel admin: fila por status, mais recentes primeiro.
    await client.query(`CREATE INDEX IF NOT EXISTS denuncias_status_idx ON denuncias (status, criado_em DESC)`)
    // Visualizações de feed (proximidade): item visto no feed sem manifestar interesse.
    // notificado marca o push one-time já enviado. UNIQUE evita duplicar a mesma view.
    await client.query(`
      CREATE TABLE IF NOT EXISTS feed_visualizacoes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        item_tipo TEXT NOT NULL CHECK (item_tipo IN ('reparo', 'obra')),
        item_id UUID NOT NULL,
        notificado BOOLEAN DEFAULT false,
        criado_em TIMESTAMP DEFAULT NOW(),
        UNIQUE(usuario_id, item_tipo, item_id)
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS feed_visualizacoes_usuario_notif_idx ON feed_visualizacoes (usuario_id, notificado)`)
    // Cooldown DURÁVEL do cron de proximidade (verificarPrestadoresProximos). Substitui o Map em
    // memória (perdido a cada deploy, não compartilhado entre réplicas). Uma linha por par
    // (prestador, demanda); o claim atômico (INSERT ... ON CONFLICT DO UPDATE ... WHERE) só concede
    // se não houve notificação nas últimas 4h. PK cobre o conflito e o lookup — sem índice extra.
    await client.query(`
      CREATE TABLE IF NOT EXISTS proximidade_notificacoes (
        prestador_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        demanda_tipo  TEXT NOT NULL CHECK (demanda_tipo IN ('reparo','obra')),
        demanda_id    UUID NOT NULL,
        notificado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (prestador_id, demanda_tipo, demanda_id)
      )
    `)
    // Contador de envios por par (prestador, demanda): o cron insiste a cada ~10 min e para
    // no 3º aviso. DEFAULT 1 é o valor correto para as linhas que já existem — elas já
    // receberam pelo menos um envio. NOT NULL + DEFAULT em PG 11+ não reescreve a tabela
    // (o default fica no catálogo), então é barato mesmo com a tabela populada.
    await client.query(`ALTER TABLE proximidade_notificacoes ADD COLUMN IF NOT EXISTS envios INT NOT NULL DEFAULT 1`)
    // Armamento por abertura de detalhe (redesenho de proximidade — reparadores + reparos).
    // Uma linha = um reparador que ABRIU o detalhe de um reparo enquanto estava a >5km do
    // endereço de cadastro dele. notificado marca o push one-time (consumido num passo futuro;
    // nada lê esta tabela ainda). PK (reparador_id, reparo_id) torna re-aberturas idempotentes.
    // Tabela NOVA: colunas NOT NULL têm DEFAULT (ou são preenchidas no INSERT), então não há
    // risco de violar constraint em linhas existentes — não existem linhas.
    await client.query(`
      CREATE TABLE IF NOT EXISTS aberturas_detalhe (
        reparador_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        reparo_id    UUID NOT NULL REFERENCES reparos(id) ON DELETE CASCADE,
        aberto_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notificado   BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (reparador_id, reparo_id)
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS aberturas_detalhe_reparador_notif_idx ON aberturas_detalhe (reparador_id, notificado)`)
    // Livro-caixa de eventos do webhook PagBank. Serve a DOIS propósitos:
    //   1) idempotência — o INSERT ... ON CONFLICT DO NOTHING vira CLAIM atômico (mesmo
    //      idioma de contratosController): quem grava a linha processa o evento.
    //   2) registro dos desfechos NÃO-PAID (DECLINED, CANCELED, REFUNDED, WAITING), que
    //      hoje são descartados sem log nem estado.
    // PK (charge_id, status) e não charge_id sozinho: uma cobrança transita de verdade
    // (WAITING → PAID), e a chave simples faria a 1ª entrega bloquear o PAID seguinte.
    // Renovação legítima traz charge_id novo → linha nova → processa.
    // Sem FK para usuarios: reference_id é gravado CRU ("{usuario_id}|{plano}"), e o livro
    // não pode perder o registro de um evento por causa de um usuário apagado depois.
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_eventos_pagbank (
        charge_id      TEXT NOT NULL,
        status         TEXT NOT NULL,
        reference_id   TEXT,
        valor_centavos INT,
        recebido_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (charge_id, status)
      )
    `)
    // Tentativas de login / redefinição POR IDENTIDADE (ver src/utils/tentativasAuth.js).
    // Guarda interna ao lado dos limiters por IP: o de IP não vê ataque dirigido a UMA conta
    // e, nesta base, é enfraquecido pelo CGNAT das operadoras.
    // Chave é o e-mail SUBMETIDO (não usuario_id) e conta até para endereço sem conta — é o
    // que permite devolver 429 no login sem virar oráculo de existência.
    // Sem `bloqueado_ate`: "bloqueado" é tentativas >= limite dentro da janela, então o fim da
    // janela JÁ é o desbloqueio — um estado a menos para manter coerente.
    // Sem FK para usuarios: o identificador pode não ter conta e a linha deve sobreviver à
    // exclusão dela.
    await client.query(`
      CREATE TABLE IF NOT EXISTS tentativas_auth (
        acao          TEXT NOT NULL CHECK (acao IN ('login', 'reset')),
        identificador TEXT NOT NULL,
        tentativas    INT NOT NULL DEFAULT 0,
        janela_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (acao, identificador)
      )
    `)
    // A PK atende as buscas; este índice serve só à varredura diária por idade.
    await client.query(`CREATE INDEX IF NOT EXISTS tentativas_auth_janela_idx ON tentativas_auth (janela_em)`)
    // Fila de mídias cujo ARQUIVO ainda está no Cloudinary mas cuja LINHA já foi apagada.
    // deletarMidiasAntigas só enxerga mídia através da demanda; quando a linha some (exclusão
    // de conta, limpezas do admin, troca de slot no upload), o arquivo ficava órfão para
    // sempre — não havia mais nada apontando para ele. Todo DELETE de mídia agora enfileira
    // aqui NO MESMO statement, e o cron esvazia a fila.
    // PK na url: a mesma url enfileirada duas vezes é a mesma exclusão, não duas.
    // Sem FK: o ponto da tabela é justamente sobreviver ao sumiço da linha de origem.
    await client.query(`
      CREATE TABLE IF NOT EXISTS midias_orfas (
        url       TEXT PRIMARY KEY,
        tipo      TEXT,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // O cron varre em ordem de chegada com LIMIT — este índice serve a esse ORDER BY.
    await client.query(`CREATE INDEX IF NOT EXISTS midias_orfas_criado_em_idx ON midias_orfas (criado_em)`)
    // Sugestões livres do usuário sobre o app. Tabela NOVA e puramente aditiva: nada existente
    // lê ou escreve nela, e nenhum ALTER a acompanha. CREATE TABLE IF NOT EXISTS torna o re-run
    // de cada boot um no-op — a migração roda ANTES do app.listen e não pode falhar aqui.
    // usuario_id segue a convenção das demais tabelas do usuário (UUID REFERENCES usuarios(id)):
    // ON DELETE CASCADE porque a sugestão é do autor — sem conta, some junto, como em avaliacoes.
    // Sem UNIQUE: o mesmo usuário pode sugerir quantas vezes quiser, e cada uma conta.
    await client.query(`
      CREATE TABLE IF NOT EXISTS sugestoes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        texto TEXT NOT NULL,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await client.query('COMMIT')
    console.log('[migration] colunas verificadas com sucesso')
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    console.error('[migration] FALHOU — rollback executado:', err.message)
    throw err
  } finally {
    if (client) client.release()
  }
})()

// Limpa os caches em memória de um usuário. cachePrestadores, que vivia AQUI e guardava a
// mesma resposta de cacheAssinaturas (mesma consulta, mesmo predicado), foi removido — havia
// dois mapas para um dado só, e a invalidação precisava lembrar de limpar os dois. Restou um
// único ponto: invalidarCacheAssinatura, em middlewares/auth, que limpa usuários e assinaturas.
// A função continua exportada porque server.js e várias rotas já a chamam por este nome.
const invalidarCachesUsuario = (id) => {
  invalidarCacheAssinatura(id)
}

// Rate limit para /auth/verificar-disponibilidade (30 req / 60s por IP)
const cacheVerifRate = new Map()
const VERIF_LIMIT = 30
const VERIF_WINDOW = 60 * 1000

const exigirPrestador = async (req, res, next) => {
  try {
    if (req.usuario.role !== 'prestador' && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Acesso restrito a prestadores de serviços domésticos' })
    }
    if (req.usuario.role === 'admin') return next()

    // Lê pelo cache COMPARTILHADO de middlewares/auth: é a mesma consulta e o mesmo predicado
    // que exigirAssinaturaAtiva usa. A mensagem do 403 segue a daqui ("serviços"), diferente
    // da de lá ("obras") — só a fonte da resposta foi unificada.
    const ativa = await assinaturaAtivaCacheada(req.usuario.id)
    if (!ativa) return res.status(403).json({ erro: 'Assinatura inativa. Renove seu plano para acessar os serviços.' })
    next()
  } catch (err) {
    res.status(500).json({ erro: 'Erro de autenticação' })
  }
}

// Enforça o TIER do prestador no servidor (não só na UI): pintor/construtor
// (tipo_prestador='pintor') só participa de OBRAS; reparador só participa de
// REPAROS. Antes, nenhum feed/ação filtrava por tipo_prestador — a separação
// existia só no app, então um pintor via reparos e um reparador via obras.
// tipo_prestador vem em req.usuario (carregado no autenticar). admin/aprovador
// passam (painel/moderação). Qualquer outro tier — inclusive prestador com
// tipo_prestador NULL (legado) — falha FECHADO com 403, nunca vaza o feed errado.
const exigirTipoPrestador = (tipoEsperado, msg) => (req, res, next) => {
  if (req.usuario.role === 'admin' || req.usuario.role === 'aprovador') return next()
  if (req.usuario.role !== 'prestador' || req.usuario.tipo_prestador !== tipoEsperado) {
    return res.status(403).json({ erro: msg, codigo: 'TIER_INCORRETO' })
  }
  next()
}
// Verificar cada tier explicitamente (regra do projeto: um não replica o outro).
const exigirPintor    = exigirTipoPrestador('pintor',    'Este recurso é exclusivo para prestadores de construção/pintura (obras).')
const exigirReparador = exigirTipoPrestador('reparador', 'Este recurso é exclusivo para prestadores de serviços domésticos.')

// Rede de segurança de coordenadas na criação — simétrica ao `uf || ufDeCidade(cidade)`.
// O app geocodifica no cliente (ViaCEP -> Nominatim) e isso falha em silêncio: CEP sem
// logradouro, Nominatim sem resultado ou fora do ar. Uma demanda sem lat/lng nasce invisível
// ao filtro por raio, ao cron de proximidade e ao rótulo de distância — então o centro do
// município é o PISO, nunca a preferência.
//   cliente mandou as duas  -> usa as do cliente          (origem 'cliente',       rua)
//   cliente omitiu          -> centro do município        (origem 'centro_cidade', cidade)
//   município não resolvido -> NULL + aviso, MAS CRIA     (origem NULL)
// Nunca rejeita a criação: perder uma demanda real é pior que uma coordenada imprecisa.
const resolverCoordenadas = (cidade, uf, latitude, longitude, rotulo) => {
  if (latitude !== undefined && latitude !== null && longitude !== undefined && longitude !== null) {
    return { lat: latitude, lng: longitude, origem: 'cliente' }
  }
  const centro = coordsDeCidade(cidade, uf)
  if (centro) return { lat: centro.lat, lng: centro.lng, origem: 'centro_cidade' }
  console.warn(`${rotulo} sem coordenadas do cliente e municipio nao resolvido — criando sem lat/lng | cidade=${cidade} uf=${uf}`)
  return { lat: null, lng: null, origem: null }
}

// Suspensão do OUTRO lado: nos aceites quem chama é o dono, então o middleware
// exigirNaoSuspenso (que olha req.usuario) não serve — é preciso consultar o profissional
// pelo id. Vai direto ao banco, sem o cache de 5 min de autenticar, porque um aceite é
// irreversível: casa o profissional e dispara contrato.
// Devolve a LINHA de suspensão (para compor a mensagem com o motivo) ou null. Truthy/falsy,
// então serve tanto para `if (await estaSuspenso(x))` quanto para quem precisa do motivo.
const estaSuspenso = async (usuarioId) => {
  if (!usuarioId) return null
  const r = await pool.query(`SELECT suspenso_em, suspenso_motivo FROM usuarios WHERE id = $1`, [usuarioId])
  return r.rows[0]?.suspenso_em ? r.rows[0] : null
}

const ERRO_ACEITE_SUSPENSO = {
  erro: 'Este profissional está com a conta suspensa e não pode assumir novos trabalhos. Escolha outro candidato.',
  codigo: 'PROFISSIONAL_SUSPENSO',
}

// Teto de demandas SIMULTÂNEAS para dono que nunca concluiu nada. Quem já encerrou pelo menos
// uma demanda (obra ou reparo) não tem teto — o limite existe só para conta nova que despeja
// demandas sem nunca fechar nenhuma.
// O teto EFETIVO vem de configuracoes ('limite_demandas_live_sem_historico', ver
// lerLimiteDemandas); esta constante é só o padrão de fallback.
const LIMITE_DEMANDAS_LIVE_SEM_HISTORICO = 5

// Teto efetivo, lido da tabela configuracoes a cada checagem (sem cache, como as demais
// chaves). Cai no padrão quando a linha não existe ou o valor não é inteiro positivo
// ('', 'abc', '0', '2.5', NULL): um teto NaN nunca dispararia (toda comparação com NaN é
// falsa, liberando cadastro sem limite) e um teto 0 travaria qualquer dono sem histórico.
const lerLimiteDemandas = async () => {
  const r = await pool.query(`SELECT valor FROM configuracoes WHERE chave = 'limite_demandas_live_sem_historico'`)
  const n = Number(r.rows[0]?.valor)
  return Number.isInteger(n) && n > 0 ? n : LIMITE_DEMANDAS_LIVE_SEM_HISTORICO
}

// "Live" = o que ocupa vaga agora:
//   obras   → 'rascunho' (enviada, aguardando aprovação, ainda pode virar 'aberta')
//             + 'aberta' aprovada e dentro do expira_em
//   reparos → 'aberta' aprovada e dentro do expira_em (reparo não tem 'rascunho': nasce
//             'aberta'/'aprovada', ver POST /reparos/dono)
// expira_em > NOW() é obrigatório: expirada NÃO é status no banco — a linha continua 'aberta'
// para sempre (ver comentário em /obras/admin), então contar só por status inflaria o teto e
// travaria o dono permanentemente na primeira vez que duas demandas vencessem sem match.
// O guard vale para os DOIS braços de obra: 'rascunho' também fica nesse status para sempre
// (nenhum job mexe em obra pendente de aprovação), então sem ele uma obra enviada e nunca
// analisada ocupava uma vaga do dono INDEFINIDAMENTE. Por isso ele saiu de dentro do braço
// 'aberta' e subiu para o WHERE — mesma condição, agora aplicada aos dois casos.
//
// `tabela` é literal do call site ('obras' | 'reparos'), NUNCA vem do request — a interpolação
// no SQL não é superfície de injeção.
// Devolve { atingido, limite }: o teto efetivo acompanha a resposta para o 409 poder ecoá-lo
// sem reler a configuração.
const limiteDemandasAtingido = async (tabela, donoId, clientRequestId) => {
  const limite = await lerLimiteDemandas()
  // Retry com chave já gravada: pula o teto inteiro. Sem isso, o dono que bate no limite com a
  // 2ª demanda e sofre timeout na resposta receberia 409 no retry — a demanda existe, mas o app
  // mostraria erro. O ON CONFLICT do INSERT devolve a linha original; o teto não pode interferir.
  if (clientRequestId) {
    const jaExiste = await pool.query(
      `SELECT 1 FROM ${tabela} WHERE criado_por = $1 AND client_request_id = $2 LIMIT 1`,
      [donoId, clientRequestId]
    )
    if (jaExiste.rowCount > 0) return { atingido: false, limite }
  }
  const c = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM obras   WHERE criado_por = $1 AND status = 'encerrada')
       + (SELECT COUNT(*) FROM reparos WHERE criado_por = $1 AND status = 'encerrada') AS encerradas,
       (SELECT COUNT(*) FROM obras WHERE criado_por = $1
          AND expira_em > NOW()
          AND (status = 'rascunho'
               OR (status = 'aberta' AND status_aprovacao = 'aprovada')))
       + (SELECT COUNT(*) FROM reparos WHERE criado_por = $1
            AND status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()) AS live`,
    [donoId]
  )
  // COUNT() volta como string (bigint no pg) — sem Number() o >= compararia texto.
  const encerradas = Number(c.rows[0].encerradas)
  const live       = Number(c.rows[0].live)
  return { atingido: encerradas === 0 && live >= limite, limite }
}

// Payload do 409 — montado com o teto EFETIVO da checagem (antes era um objeto fixo, possível
// só enquanto o teto era constante).
// A saída pelo cancelamento entra no texto porque ela JÁ existe (DELETE /obras/dono/:id e
// DELETE /reparos/dono/:id não exigem status nenhum, então valem inclusive para obra ainda
// aguardando aprovação) — só não estava em lugar nenhum que o dono pudesse ler. Sem isso ele
// via "você já tem N ativas" sem saber quais nem como liberar vaga.
const erroLimiteDemandas = (limite) => ({
  erro: `Você já tem ${limite} demandas ativas e nenhuma concluída. `
      + `Conclua ou aguarde o encerramento de uma delas para publicar outra. `
      + `Obras aguardando aprovação também ocupam vaga: cancelar uma delas em "Minhas obras" libera a vaga na hora.`,
  codigo: 'LIMITE_DEMANDAS_ATIVAS',
  limite_demandas_ativas: limite,
})

// ============================================================
// STATS PÚBLICOS (sem auth)
// ============================================================
// Cache de processo (valor único) para o payload público. Este endpoint é batido a
// cada abertura do app, pré-login, por todos — sem cache ia direto ao Postgres com
// as subqueries agregadas a cada request. TTL 60s. Segue o precedente do repo (Map +
// timestamp + TTL em :334), mas aqui é um único valor global, então um objeto
// { payload, timestamp } basta. Process-local: com N réplicas cada uma guarda o seu —
// aceitável para um agregado que tolera 60s de defasagem.
let statsPublicoCache = { payload: null, timestamp: 0 }
const STATS_PUBLICO_TTL = 60 * 1000

router.get('/stats/publico', async (req, res) => {
  try {
    // Hit: serve da memória sem tocar o Postgres.
    if (statsPublicoCache.payload && Date.now() - statsPublicoCache.timestamp < STATS_PUBLICO_TTL) {
      return res.json(statsPublicoCache.payload)
    }

    const result = await pool.query(`
      SELECT
        COALESCE((SELECT SUM(valor_estimado) FROM reparos WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()), 0)
        + COALESCE((SELECT SUM(valor) FROM obras WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()), 0) AS total_valor,
        (SELECT COUNT(*) FROM reparos WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW())
        + (SELECT COUNT(*) FROM obras WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()) AS total_ativas,
        (SELECT COUNT(*) FROM obras WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW() AND match_usuario_id IS NULL) AS obras_abertas,
        (SELECT COUNT(*) FROM reparos WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW() AND match_usuario_id IS NULL) AS reparos_abertos
    `)
    // total_valor/total_ativas: legado, INTOCADO — mesma query mesclada obras+reparos,
    // sem match_usuario_id IS NULL (a build instalada renderiza estas duas chaves).
    // obras_abertas/reparos_abertos: novas, por vertical, com as MESMAS cláusulas do
    // feed (obrasController.js:19-22 e routes/index.js:1594-1595) — aberta + aprovada +
    // não expirada + SEM match — para o número bater com o que o prestador vê no feed.
    const row = result.rows[0]
    const payload = {
      total_valor_obras: parseFloat(row.total_valor) || 0,
      total_obras_ativas: parseInt(row.total_ativas) || 0,
      obras:   { demandas_abertas: parseInt(row.obras_abertas) || 0 },
      reparos: { demandas_abertas: parseInt(row.reparos_abertos) || 0 }
    }
    // Refill só após sucesso — uma falha cai no catch (500) e deixa o último payload
    // bom intacto, nunca envenena o cache.
    statsPublicoCache = { payload, timestamp: Date.now() }
    res.json(payload)
  } catch (err) {
    console.error('[stats/publico]', err.message)
    res.status(500).json({ erro: 'Erro ao buscar estatísticas' })
  }
})

// ============================================================
// AUTH
// ============================================================
router.post('/auth/cadastro',        authCtrl.cadastrar)
router.post('/auth/login',           authCtrl.login)
router.get('/auth/perfil',           autenticar, authCtrl.perfil)
router.put('/auth/perfil',           autenticar, authCtrl.atualizarPerfil)
router.post('/auth/alterar-senha',   autenticar, authCtrl.alterarSenha)
router.post('/auth/esqueci-senha',   authCtrl.esqueciSenha)

router.post('/auth/foto-perfil', autenticar, upload.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' })
    const resultado = await uploadArquivo(req.file)
    await pool.query('UPDATE usuarios SET foto_url = $1 WHERE id = $2', [resultado.secure_url, req.usuario.id])
    res.json({ foto_url: resultado.secure_url })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao enviar foto' })
  }
})

router.patch('/auth/foto-perfil', autenticar, async (req, res) => {
  try {
    const { foto_url } = req.body
    if (!foto_url) return res.status(400).json({ erro: 'URL da foto é obrigatória' })
    await pool.query('UPDATE usuarios SET foto_url = $1 WHERE id = $2', [foto_url, req.usuario.id])
    res.json({ foto_url })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar foto de perfil' })
  }
})

router.post('/auth/push-token', autenticar, async (req, res) => {
  try {
    const { token } = req.body
    // Esta rota só REGISTRA: token precisa vir e ser uma string não-vazia. Remover é
    // papel exclusivo de /auth/push-token/clear (o logout do app já usa essa rota).
    // Antes, body vazio (ou chave renomeada) gravava push_token = NULL e devolvia 200 —
    // matava todo push do usuário em silêncio; agora essa falha aparece como 400 e o
    // app a registra via push-status ('erro_registro').
    if (typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ erro: 'token é obrigatório — para remover o token use /auth/push-token/clear' })
    }
    await pool.query('UPDATE usuarios SET push_token = $1 WHERE id = $2', [token, req.usuario.id])
    res.json({ mensagem: 'Token registrado' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar token' })
  }
})

// Limpa o push_token da própria conta no logout, evitando que um device que
// troca de conta continue recebendo notificações do usuário anterior (só mexe
// na linha do req.usuario.id — nunca em outras contas).
router.post('/auth/push-token/clear', autenticar, async (req, res) => {
  try {
    await pool.query('UPDATE usuarios SET push_token = NULL WHERE id = $1', [req.usuario.id])
    res.json({ mensagem: 'Token removido' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover token' })
  }
})

// Registra o motivo de o usuário estar sem push_token (diagnóstico). Nunca escreve
// push_token — só push_status/push_status_em, e só na linha do req.usuario.id. Endpoint
// separado do /auth/push-token de propósito: aquele é o único caminho de escrita do token
// e não deve ser tocado. Os estados são mutuamente exclusivos (ou o app obteve token, ou
// falhou), então o app chama um endpoint ou o outro, nunca os dois.
router.post('/auth/push-status', autenticar, async (req, res) => {
  try {
    const { status } = req.body
    const permitidos = ['concedida', 'negada', 'bloqueada', 'erro_registro', 'nao_solicitada']
    if (!permitidos.includes(status)) {
      return res.status(400).json({ erro: 'Status inválido' })
    }
    await pool.query(
      'UPDATE usuarios SET push_status = $1, push_status_em = NOW() WHERE id = $2',
      [status, req.usuario.id]
    )
    res.json({ mensagem: 'Status registrado' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar status' })
  }
})

// Lista de bloqueio global por dono (prestadores_bloqueados_dono). Separada do array
// per-reparo prestadores_bloqueados — estes endpoints NÃO afetam o feed ainda.
router.post('/usuarios/bloquear-prestador', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'dono_obra') return res.status(403).json({ erro: 'Apenas donos podem bloquear prestadores' })
    const { prestador_id } = req.body
    if (!prestador_id) return res.status(400).json({ erro: 'prestador_id é obrigatório' })
    await pool.query(
      `INSERT INTO prestadores_bloqueados_dono (dono_id, prestador_id) VALUES ($1, $2) ON CONFLICT (dono_id, prestador_id) DO NOTHING`,
      [req.usuario.id, prestador_id]
    )
    res.json({ mensagem: 'Prestador bloqueado com sucesso' })
  } catch (err) {
    console.error('Erro ao bloquear prestador:', err)
    res.status(500).json({ erro: 'Erro ao bloquear prestador' })
  }
})

router.delete('/usuarios/desbloquear-prestador/:id', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'dono_obra') return res.status(403).json({ erro: 'Apenas donos podem desbloquear prestadores' })
    await pool.query(
      `DELETE FROM prestadores_bloqueados_dono WHERE dono_id = $1 AND prestador_id = $2`,
      [req.usuario.id, req.params.id]
    )
    res.json({ mensagem: 'Prestador desbloqueado com sucesso' })
  } catch (err) {
    console.error('Erro ao desbloquear prestador:', err)
    res.status(500).json({ erro: 'Erro ao desbloquear prestador' })
  }
})

router.get('/usuarios/prestadores-bloqueados', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'dono_obra') return res.status(403).json({ erro: 'Apenas donos podem ver esta lista' })
    const result = await pool.query(
      `SELECT pb.prestador_id, pb.criado_em, u.nome, u.foto_url,
              COUNT(*) OVER()::int AS _total
       FROM prestadores_bloqueados_dono pb
       JOIN usuarios u ON u.id = pb.prestador_id
       WHERE pb.dono_id = $1
       ORDER BY pb.criado_em DESC, pb.prestador_id DESC
       LIMIT 200`,
      [req.usuario.id]
    )
    const bloqueados = result.rows
    const total = bloqueados.length > 0 ? bloqueados[0]._total : 0
    bloqueados.forEach(b => delete b._total)
    res.json({ bloqueados, total })
  } catch (err) {
    console.error('Erro ao listar prestadores bloqueados:', err)
    res.status(500).json({ erro: 'Erro ao listar prestadores bloqueados' })
  }
})

// Marca a tela de boas-vindas do prestador como já exibida (one-time, irreversível).
router.post('/auth/boas-vindas-confirmada', autenticar, async (req, res) => {
  try {
    await pool.query('UPDATE usuarios SET boas_vindas_exibida = true WHERE id = $1', [req.usuario.id])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao confirmar boas-vindas' })
  }
})

// ============================================================
// USUARIOS
// ============================================================

// Contratos do usuário — PRIMEIRO passo de toda exclusão de conta.
//
// `contratos` não aponta para `usuarios`: o vínculo é INDIRETO, pela candidatura
// (fluxo obra, contratos.candidatura_id) ou pelo interesse (fluxo reparo,
// contratos.interesse_id).
//
// Os dois lados se comportam DIFERENTE, e nenhum deles bloqueia por FK:
//   • candidatura_id É uma FK → candidaturas, com ON DELETE CASCADE: apagar a
//     candidatura já leva o contrato junto. Nunca estourou 23503.
//   • interesse_id NÃO é FK — não existe constraint nenhuma nessa coluna
//     (verificado no pg_catalog). Apagar o interesse deixa o contrato apontando
//     para uma linha inexistente, em silêncio.
// Ou seja, este DELETE não existe para destravar FK: existe para não deixar
// linhas ÓRFÃS em contratos no fluxo reparo (mesma sujeira que a limpeza de
// assinaturas órfãs acima resolve). No fluxo obra ele é redundante com o CASCADE,
// e inofensivo.
//
// Cobre os DOIS lados do contrato, nos dois fluxos:
//   • usuário como PRESTADOR → candidaturas.usuario_id / interesse_reparos.usuario_id
//   • usuário como DONO      → candidaturas.obra_id → obras.criado_por
//                              interesse_reparos.reparo_id → reparos.criado_por
// Uma linha de contratos tem candidatura_id XOR interesse_id; o lado NULL
// simplesmente não casa em nenhum IN (NULL IN (...) → NULL, não apaga nada).
const SQL_DELETE_CONTRATOS_DO_USUARIO = `
  DELETE FROM contratos
   WHERE candidatura_id IN (
           SELECT c.id FROM candidaturas c
            WHERE c.usuario_id = $1
               OR c.obra_id IN (SELECT id FROM obras WHERE criado_por = $1)
         )
      OR interesse_id IN (
           SELECT ir.id FROM interesse_reparos ir
            WHERE ir.usuario_id = $1
               OR ir.reparo_id IN (SELECT id FROM reparos WHERE criado_por = $1)
         )
`

router.delete('/usuarios/:id', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    const { id } = req.params
    if (id === req.usuario.id) return res.status(400).json({ erro: 'Não é possível excluir sua própria conta' })

    const usuario = await client.query('SELECT id, role FROM usuarios WHERE id = $1', [id])
    if (usuario.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })
    if (usuario.rows[0].role === 'admin') return res.status(400).json({ erro: 'Não é possível excluir um administrador' })

    await client.query('BEGIN')

    // Contratos ANTES de candidaturas/interesse_reparos/obras/reparos (ver comentário
    // em SQL_DELETE_CONTRATOS_DO_USUARIO): evita contratos órfãos no fluxo reparo.
    await client.query(SQL_DELETE_CONTRATOS_DO_USUARIO, [id])

    // Cascade obras criadas por este usuário (dono_obra)
    const obrasRes = await client.query('SELECT id FROM obras WHERE criado_por = $1', [id])
    if (obrasRes.rows.length > 0) {
      const obraIds = obrasRes.rows.map(r => r.id)
      await client.query('DELETE FROM mensagens WHERE obra_id = ANY($1::uuid[])', [obraIds])
      await client.query('DELETE FROM candidaturas WHERE obra_id = ANY($1::uuid[])', [obraIds])
      await client.query(enfileirarOrfas(`DELETE FROM midias WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = $1) RETURNING url, tipo`), [id])
      await client.query('DELETE FROM obras WHERE criado_por = $1', [id])
    }

    // Cascade reparos criados por este usuário (dono_obra)
    const reparosRes = await client.query('SELECT id FROM reparos WHERE criado_por = $1', [id])
    if (reparosRes.rows.length > 0) {
      const reparoIds = reparosRes.rows.map(r => r.id)
      await client.query('DELETE FROM interesse_reparos WHERE reparo_id = ANY($1::uuid[])', [reparoIds])
      await client.query(enfileirarOrfas(`DELETE FROM midias_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por = $1) RETURNING url, tipo`), [id])
      await client.query('DELETE FROM reparos WHERE criado_por = $1', [id])
    }

    // NULL out match_usuario_id caso o prestador estivesse em atendimento
    await client.query('UPDATE obras SET match_usuario_id = NULL, match_feito_em = NULL WHERE match_usuario_id = $1', [id])
    await client.query('UPDATE reparos SET match_usuario_id = NULL, match_feito_em = NULL WHERE match_usuario_id = $1', [id])
    // Idem para solicitações de encerramento em aberto: a FK encerramento_solicitado_por
    // bloquearia o DELETE do usuário. Limpar a solicitação devolve a demanda ao estado normal.
    await client.query('UPDATE obras SET encerramento_solicitado_por = NULL, encerramento_solicitado_em = NULL WHERE encerramento_solicitado_por = $1', [id])
    await client.query('UPDATE reparos SET encerramento_solicitado_por = NULL, encerramento_solicitado_em = NULL WHERE encerramento_solicitado_por = $1', [id])

    // Cascade registros do próprio usuário como candidato/interessado
    await client.query('DELETE FROM assinaturas WHERE usuario_id = $1', [id])
    await client.query('DELETE FROM candidaturas WHERE usuario_id = $1', [id])
    await client.query('DELETE FROM mensagens WHERE autor_id = $1', [id])
    await client.query('DELETE FROM interesse_reparos WHERE usuario_id = $1', [id])
    // localizacoes_prestadores tem FK para usuarios (sem CASCADE) — todo prestador que
    // já compartilhou GPS tem linha aqui. Se não apagar, o DELETE FROM usuarios abaixo
    // estoura violação de FK e a transação INTEIRA sofre ROLLBACK, desfazendo inclusive
    // o DELETE da assinatura acima e deixando uma assinatura órfã/desatualizada (B72-01).
    await client.query('DELETE FROM localizacoes_prestadores WHERE usuario_id = $1', [id])
    await client.query(`DELETE FROM prestadores_bloqueados_dono WHERE dono_id = $1 OR prestador_id = $1`, [id])
    // faltas_profissional.usuario_id também é FK sem CASCADE — mesmo caso do
    // localizacoes_prestadores acima: qualquer profissional que já tenha faltado uma vez
    // derrubaria a transação inteira aqui. perdoada_por não precisa de limpeza (ON DELETE
    // SET NULL), então um admin que já liberou alguém é apagado sem tocar nas faltas dele.
    await client.query('DELETE FROM faltas_profissional WHERE usuario_id = $1', [id])
    // Mesma lacuna que DELETE /conta/excluir tinha (corrigida em af5d5fb), e mesma correção:
    // as 4 URLs de Cloudinary que moram na PRÓPRIA linha de usuarios (foto de perfil, frente e
    // verso do documento, selfie) entram na fila de órfãs no MESMO statement do DELETE. Sem
    // isto, o admin excluir um usuário apagava a única referência a esses arquivos e o
    // documento de identidade ficava no Cloudinary para sempre.
    //
    // NÃO usa o wrapper enfileirarOrfas: ele assume um DELETE que devolve UMA LINHA POR MÍDIA
    // já com as colunas (url, tipo), que é a forma de midias/midias_reparos. Aqui é uma linha
    // só com quatro colunas de URL, então o RETURNING é despivotado com unnest.
    //
    // CTE em vez de um SELECT antes do DELETE: as URLs saem do RETURNING da linha REALMENTE
    // apagada, então é impossível enfileirar arquivo de um usuário que não foi excluído.
    // WHERE u IS NOT NULL: coluna vazia não vira linha na fila.
    // 'foto' porque as quatro são imagens (/image/upload/ no Cloudinary) e deletarDoCloudinary
    // mapeia qualquer tipo != 'video' para resource_type 'image'.
    // DISTINCT + ON CONFLICT: mesmo arquivo em duas colunas entra uma vez, e URL já enfileirada
    // por outro caminho não duplica.
    await client.query(
      `WITH del AS (
         DELETE FROM usuarios WHERE id = $1
         RETURNING foto_url, verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url
       )
       INSERT INTO midias_orfas (url, tipo)
       SELECT DISTINCT u, 'foto'
         FROM del, unnest(ARRAY[
                del.foto_url,
                del.verificacao_doc_frente_url,
                del.verificacao_doc_verso_url,
                del.verificacao_selfie_url
              ]) AS u
        WHERE u IS NOT NULL
       ON CONFLICT (url) DO NOTHING`,
      [id]
    )

    await client.query('COMMIT')

    invalidarCachesUsuario(id)

    res.json({ mensagem: 'Usuário excluído com sucesso' })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Erro ao excluir usuário:', err)
    res.status(500).json({ erro: 'Erro ao excluir usuário' })
  } finally {
    client.release()
  }
})

// E-mail de confirmação de exclusão de conta (a Google Play exige avisar o usuário).
// Segue o mesmo caminho transacional (Brevo) usado em contratos/pagamentos/mensagens.
const enviarEmailExclusaoConta = (email, nome) =>
  enviarEmail({
    para: email,
    assunto: `${MARCA} — Sua conta foi excluída`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: #0a0a0a; margin: 0;">${MARCA}</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
          <h2>Olá, ${nome}!</h2>
          <p>Confirmamos que sua conta no ${MARCA} foi excluída permanentemente, junto com todos os dados associados (obras, reparos, candidaturas, mídias, assinaturas e avaliações).</p>
          <p>Esta ação é irreversível. Se você <strong>não</strong> solicitou esta exclusão, entre em contato conosco imediatamente respondendo este e-mail.</p>
          <p>Você pode criar uma nova conta a qualquer momento.</p>
          <p><strong>Equipe ${MARCA}</strong></p>
        </div>
      </div>
    `
  })

// DELETE /conta/excluir — usuário exclui a PRÓPRIA conta (self-service, exigência da Google Play).
// Requer confirmação por senha. Reproduz a cascata do DELETE /usuarios/:id (admin), sempre sobre
// req.usuario.id. Não altera o endpoint admin. avaliacoes cai por ON DELETE CASCADE.
router.delete('/conta/excluir', autenticar, async (req, res) => {
  const client = await pool.connect()
  try {
    const { senha } = req.body
    if (!senha) return res.status(400).json({ erro: 'Senha é obrigatória para confirmar a exclusão' })

    const userResult = await pool.query(
      `SELECT id, nome, email, senha_hash FROM usuarios WHERE id = $1`,
      [req.usuario.id]
    )
    if (userResult.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })

    const usuario = userResult.rows[0]
    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash)
    if (!senhaValida) return res.status(401).json({ erro: 'Senha incorreta' })

    const id = usuario.id

    await client.query('BEGIN')

    // Contratos ANTES de candidaturas/interesse_reparos/obras/reparos (ver comentário
    // em SQL_DELETE_CONTRATOS_DO_USUARIO): evita contratos órfãos no fluxo reparo.
    await client.query(SQL_DELETE_CONTRATOS_DO_USUARIO, [id])

    // Cascade obras criadas por este usuário (colunas idênticas ao DELETE /usuarios/:id)
    await client.query(`DELETE FROM mensagens WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = $1)`, [id])
    await client.query(`DELETE FROM candidaturas WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = $1)`, [id])
    await client.query(enfileirarOrfas(`DELETE FROM midias WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = $1) RETURNING url, tipo`), [id])
    await client.query(`DELETE FROM obras WHERE criado_por = $1`, [id])

    // Cascade reparos criados por este usuário
    await client.query(`DELETE FROM interesse_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por = $1)`, [id])
    await client.query(enfileirarOrfas(`DELETE FROM midias_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por = $1) RETURNING url, tipo`), [id])
    await client.query(`DELETE FROM reparos WHERE criado_por = $1`, [id])

    // NULL out match_usuario_id caso o usuário estivesse em atendimento
    await client.query(`UPDATE obras SET match_usuario_id = NULL, match_feito_em = NULL WHERE match_usuario_id = $1`, [id])
    await client.query(`UPDATE reparos SET match_usuario_id = NULL, match_feito_em = NULL WHERE match_usuario_id = $1`, [id])
    // Idem para solicitações de encerramento em aberto (FK encerramento_solicitado_por).
    await client.query(`UPDATE obras SET encerramento_solicitado_por = NULL, encerramento_solicitado_em = NULL WHERE encerramento_solicitado_por = $1`, [id])
    await client.query(`UPDATE reparos SET encerramento_solicitado_por = NULL, encerramento_solicitado_em = NULL WHERE encerramento_solicitado_por = $1`, [id])

    // Cascade registros do próprio usuário como candidato/interessado/autor
    await client.query(`DELETE FROM assinaturas WHERE usuario_id = $1`, [id])
    await client.query(`DELETE FROM candidaturas WHERE usuario_id = $1`, [id])
    await client.query(`DELETE FROM mensagens WHERE autor_id = $1`, [id])
    await client.query(`DELETE FROM interesse_reparos WHERE usuario_id = $1`, [id])
    await client.query(`DELETE FROM localizacoes_prestadores WHERE usuario_id = $1`, [id])
    await client.query(`DELETE FROM prestadores_bloqueados_dono WHERE dono_id = $1 OR prestador_id = $1`, [id])
    // FK sem CASCADE (ver o mesmo DELETE no caminho de exclusão pelo admin): sem isto, um
    // profissional com falta registrada não consegue mais excluir a própria conta.
    await client.query(`DELETE FROM faltas_profissional WHERE usuario_id = $1`, [id])

    // Conta em si (avaliacoes cai por ON DELETE CASCADE).
    //
    // As 4 URLs de Cloudinary que moram na PRÓPRIA linha de usuarios (foto de perfil, frente e
    // verso do documento, selfie) entram na fila de órfãs no MESMO statement do DELETE. Sem
    // isto, excluir a conta apagava a única referência a esses arquivos e o documento de
    // identidade ficava no Cloudinary para sempre: os dois braços do cron enxergam mídia só
    // através de obras/reparos, e midias_orfas só recebia o que passava por enfileirarOrfas.
    //
    // NÃO usa o wrapper enfileirarOrfas: ele assume um DELETE que devolve UMA LINHA POR MÍDIA
    // já com as colunas (url, tipo), que é a forma de midias/midias_reparos. Aqui é o oposto —
    // uma linha só, com quatro colunas de URL —, então o RETURNING precisa ser despivotado com
    // unnest antes de virar linhas da fila. Mesma ideia, forma diferente.
    //
    // CTE em vez de um SELECT antes do DELETE: as URLs saem do RETURNING da linha REALMENTE
    // apagada, então é impossível enfileirar arquivo de uma conta que não foi excluída (WHERE
    // sem correspondência → nenhuma linha no del → nenhuma inserção).
    // WHERE u IS NOT NULL: coluna vazia não vira linha na fila.
    // 'foto' porque as quatro são imagens (todas gravadas como /image/upload/ no Cloudinary) e
    // deletarDoCloudinary mapeia qualquer tipo != 'video' para resource_type 'image'.
    // DISTINCT + ON CONFLICT: o mesmo arquivo reaproveitado em duas colunas entra uma vez, e
    // URL já enfileirada por outro caminho não duplica.
    await client.query(
      `WITH del AS (
         DELETE FROM usuarios WHERE id = $1
         RETURNING foto_url, verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url
       )
       INSERT INTO midias_orfas (url, tipo)
       SELECT DISTINCT u, 'foto'
         FROM del, unnest(ARRAY[
                del.foto_url,
                del.verificacao_doc_frente_url,
                del.verificacao_doc_verso_url,
                del.verificacao_selfie_url
              ]) AS u
        WHERE u IS NOT NULL
       ON CONFLICT (url) DO NOTHING`,
      [id]
    )

    await client.query('COMMIT')

    invalidarCachesUsuario(id)

    // E-mail de confirmação — fire and forget, não bloqueia a resposta
    enviarEmailExclusaoConta(usuario.email, usuario.nome).catch(() => {})

    res.json({ mensagem: 'Conta excluída com sucesso.' })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[ExcluirConta] Erro:', err.message)
    res.status(500).json({ erro: 'Erro ao excluir conta. Tente novamente.' })
  } finally {
    client.release()
  }
})

// Paginação de TODA listagem paginada deste arquivo — as três telas de admin
// (/admin/suspensos, /admin/denuncias, /admin/sugestoes) e os seis feeds públicos
// (/obras, /obras/minhas, /obras-aprovacao, /reparos, /reparos/minhas,
// /reparos/aprovacao). Ponto ÚNICO: cópias do mesmo cálculo divergem na primeira vez
// que alguém mexer só numa. Sanitiza em vez de recusar — uma listagem não deve virar
// 400 por causa de um parâmetro estranho na URL:
//   page  < 1 ou não-numérico → 1     (impede o OFFSET negativo, que o Postgres rejeitava
//                                      com erro e o handler devolvia como 500)
//   limit < 1 ou não-numérico → 20    (o default de sempre)
//   limit > 100               → 100   (clampado, NÃO rejeitado)
// O teto de 100 não quebra nenhum chamador conhecido: o painel pede limit=20 fixo nas
// telas que paginam e nada passa nas de aprovação; o app não manda limit em nenhum dos
// seis feeds, então todos já recebiam 20. Quem lê data.limit para saber se há próxima
// página continua correto — o limit devolvido é o EFETIVO.
const PAGINACAO_ADMIN_PADRAO = 20
const PAGINACAO_ADMIN_MAX    = 100

const paginacaoAdmin = (query) => {
  const pageBruto  = parseInt(query.page)
  const limitBruto = parseInt(query.limit)
  const page  = Number.isFinite(pageBruto)  && pageBruto  >= 1 ? pageBruto : 1
  const limit = Number.isFinite(limitBruto) && limitBruto >= 1
    ? Math.min(limitBruto, PAGINACAO_ADMIN_MAX)
    : PAGINACAO_ADMIN_PADRAO
  return { page, limit, offset: (page - 1) * limit }
}

// ============================================================
// OBRAS
// ============================================================
router.get('/obras/minhas', autenticar, async (req, res) => {
  try {
    const { page, limit, offset } = paginacaoAdmin(req.query)

    const result = await pool.query(
      `SELECT o.*,
        -- "Expirada" não é status no banco: é uma obra NÃO encerrada cujo expira_em já
        -- passou — vale em qualquer status vivo (inclusive 'rascunho', que também tem
        -- expira_em desde a criação). Calculado no SQL (relógio do servidor) para o cliente
        -- não precisar comparar expira_em com o relógio do aparelho.
        (o.status <> 'encerrada' AND o.expira_em <= NOW()) AS expirada,
        (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_interessados,
        -- Conta 'pendente' E 'contraproposta_dono': uma obra em negociação (contraproposta
        -- enviada, aguardando o pintor) continua tendo interessado, e antes aparecia como zero.
        (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id AND status IN ('pendente', 'contraproposta_dono')) as candidaturas_pendentes,
        -- Candidatura pendente mais recente: deixa o app chavear o modal de nova proposta
        -- por candidatura, não por obra. Ordena por criado_em (id é UUID aleatório, então
        -- MAX(id) não é "a mais nova"); id DESC só desempata criado_em idêntico. NULL se
        -- não houver nenhuma pendente.
        (SELECT c.id FROM candidaturas c
          WHERE c.obra_id = o.id AND c.status = 'pendente'
          ORDER BY c.criado_em DESC, c.id DESC
          LIMIT 1) as candidatura_pendente_recente_id,
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) as foto_capa,
        (SELECT COALESCE(c.valor_contraproposta, c.valor_proposto)
           FROM candidaturas c
          WHERE c.obra_id = o.id AND c.usuario_id = o.match_usuario_id
          LIMIT 1) as valor_acordado
       FROM obras o WHERE o.criado_por = $1 AND o.status != 'cancelada' ORDER BY o.criado_em DESC
       LIMIT $2 OFFSET $3`,
      [req.usuario.id, limit, offset]
    )
    const agora = new Date()
    const eArquivada = o => o.status === 'encerrada' || (o.expira_em && new Date(o.expira_em) < agora)
    const obras     = result.rows.filter(o => !eArquivada(o))
    const historico = result.rows.filter(o =>  eArquivada(o))
    res.json({ obras, historico, page, limit })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar obras' })
  }
})

// GET /obras/meus-contratos — obras finalizadas (encerradas) em que o usuário foi o pintor do match
// IMPORTANTE: registrar antes de GET /obras/:id para não ser sombreado por :id='meus-contratos'
router.get('/obras/meus-contratos', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.titulo, o.categoria, o.valor, o.cidade, o.bairro, o.uf,
              o.match_feito_em, o.status,
              u.id AS dono_id, u.nome AS dono_nome, u.telefone AS dono_telefone,
              (SELECT url FROM midias WHERE obra_id = o.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) AS foto_capa,
              COALESCE(c.valor_contraproposta, c.valor_proposto) AS valor_acordado,
              EXISTS (
                SELECT 1 FROM avaliacoes a
                WHERE a.contrato_tipo = 'obra' AND a.contrato_id = o.id AND a.avaliador_id = $1
              ) AS ja_avaliei,
              -- Total ANTES do LIMIT, no mesmo statement: evita uma segunda query repetindo
              -- o WHERE — duplicar predicado é exatamente onde os dois lados divergem depois.
              COUNT(*) OVER()::int AS _total
       FROM obras o
       JOIN usuarios u ON o.criado_por = u.id
       LEFT JOIN candidaturas c ON c.obra_id = o.id AND c.usuario_id = $1
       WHERE o.match_usuario_id = $1 AND o.status = 'encerrada'
       -- o.id como desempate: match_feito_em sozinho não é determinístico, e com LIMIT um
       -- empate na borda faria a mesma linha aparecer duas vezes (ou sumir) num load-more.
       ORDER BY o.match_feito_em DESC NULLS LAST, o.id DESC
       LIMIT 200`,
      [req.usuario.id]
    )
    // _total sai de cada linha: os campos de cada item ficam EXATAMENTE como eram e `total`
    // entra AO LADO de `contratos`, sem aninhar nem renomear — o app não precisa mudar.
    const contratos = result.rows
    const total = contratos.length > 0 ? contratos[0]._total : 0
    contratos.forEach(c => delete c._total)
    res.json({ contratos, total })
  } catch (err) {
    console.error('[obras/meus-contratos]', err.message)
    res.status(500).json({ erro: 'Erro ao buscar contratos finalizados' })
  }
})

// GET /obras/meus-contratos-dono — obras finalizadas (encerradas) em que o usuário foi o dono (solicitante)
// IMPORTANTE: registrar antes de GET /obras/:id para não ser sombreado por :id='meus-contratos-dono'
router.get('/obras/meus-contratos-dono', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.titulo, o.categoria, o.valor, o.cidade, o.bairro, o.uf,
              o.match_feito_em, o.status,
              u.id AS prestador_id,
              u.nome AS prestador_nome, u.telefone AS prestador_telefone,
              u.logradouro, u.numero, u.bairro,
              (SELECT url FROM midias WHERE obra_id = o.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) AS foto_capa,
              COALESCE(c.valor_contraproposta, c.valor_proposto) AS valor_acordado,
              EXISTS (
                SELECT 1 FROM avaliacoes a
                WHERE a.contrato_tipo = 'obra' AND a.contrato_id = o.id AND a.avaliador_id = $1
              ) AS ja_avaliei,
              COUNT(*) OVER()::int AS _total
       FROM obras o
       LEFT JOIN usuarios u ON o.match_usuario_id = u.id
       LEFT JOIN candidaturas c ON c.obra_id = o.id AND c.usuario_id = o.match_usuario_id
       WHERE o.criado_por = $1 AND o.status = 'encerrada'
       ORDER BY o.match_feito_em DESC NULLS LAST, o.id DESC
       LIMIT 200`,
      [req.usuario.id]
    )
    const contratos = result.rows
    const total = contratos.length > 0 ? contratos[0]._total : 0
    contratos.forEach(c => delete c._total)
    res.json({ contratos, total })
  } catch (err) {
    console.error('[obras/meus-contratos-dono]', err.message)
    res.status(500).json({ erro: 'Erro ao buscar contratos finalizados' })
  }
})

// Resolve a zona IANA que o cliente manda no campo `timezone` do create, para a faixa "Hoje".
// Devolve SEMPRE uma zona utilizável — nunca lança, nunca recusa o request.
//
// Três recuos para TZ_PADRAO, todos deliberados:
//   ausente/não-string  → o cliente omite `timezone` quando o aparelho não sabe dizer a zona;
//   malformada          → não passa na triagem de formato (sem barra, lixo, tamanho absurdo);
//   desconhecida        → formato ok, mas o Postgres não tem essa zona no tzdata dele.
// O caso `desconhecida` é consultado no BANCO (pg_timezone_names) e não no ICU do Node: quem
// vai calcular o fim do dia é o Postgres, então é o catálogo DELE que decide. Isso também
// elimina a possibilidade de o INSERT estourar 'time zone "X" not recognized' no meio do CASE.
// A consulta só roda no ramo 'hoje', então não entra no caminho das outras faixas.
const resolverZonaCliente = async (bruto) => {
  if (typeof bruto !== 'string' || bruto.length > 64) return TZ_PADRAO
  const candidata = bruto.trim()
  if (!FORMATO_ZONA_IANA.test(candidata)) return TZ_PADRAO
  try {
    const r = await pool.query(`SELECT 1 FROM pg_timezone_names WHERE name = $1 LIMIT 1`, [candidata])
    if (r.rowCount === 0) {
      console.warn(`[obras/dono] timezone desconhecida pelo Postgres, usando ${TZ_PADRAO}`)
      return TZ_PADRAO
    }
    return candidata
  } catch (err) {
    // Falha ao consultar o catálogo não pode derrubar a criação da obra.
    console.error('[obras/dono] falha ao validar timezone:', err.message)
    return TZ_PADRAO
  }
}

router.post('/obras/dono', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'dono_obra' && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Apenas donos de obra podem cadastrar obras' })
    }
    const { titulo, categoria, valor, cidade, bairro, uf, metragem, prazo_execucao_dias, horas_para_expirar, descricao, tags, endereco_obra, ponto_referencia, latitude, longitude, client_request_id } = req.body
    // Antes de qualquer trabalho (geocoding, ufDeCidade): recusar cedo não gasta rede à toa.
    const limiteObras = await limiteDemandasAtingido('obras', req.usuario.id, client_request_id)
    if (limiteObras.atingido) {
      return res.status(409).json(erroLimiteDemandas(limiteObras.limite))
    }
    const ufFinal = uf || await ufDeCidade(cidade)  // rede de segurança: deriva uf da cidade
    const { lat: latFinal, lng: lngFinal, origem: coordOrigem } = resolverCoordenadas(cidade, ufFinal, latitude, longitude, '[obras/dono]')
    // Janela original resolvida UMA vez: mesma base do expira_em e do horas_para_expirar gravado,
    // sem risco de os dois divergirem. publicado_em fica NULL — obra nasce 'rascunho', só publica
    // na aprovação. Validação do input segue DEFERIDA (não mexer nos creates).
    const horasExpiracao = horas_para_expirar || 720
    const expira_em = new Date(Date.now() + horasExpiracao * 3600 * 1000)
    // Faixa "Hoje" (prazo_modo='hoje'): expira_em é o FIM DO DIA na zona DO USUÁRIO, não
    // publicação + N horas. NULL/ausente = faixa por duração, exatamente como antes.
    const prazoModo = req.body?.prazo_modo === PRAZO_MODO_HOJE ? PRAZO_MODO_HOJE : null
    // Zona só importa no ramo 'hoje' — nas outras faixas nem consulta o banco.
    // Três recuos, todos para TZ_PADRAO e NUNCA para a faixa por duração: o cliente omite
    // `timezone` de propósito quando o aparelho não sabe dizer a zona, e nesse caso ele ainda
    // pediu "Hoje". Cair na faixa de horas seria entregar outra coisa; recusar o request seria
    // pior ainda. O valor RESOLVIDO é gravado, então os caminhos que reconstroem não precisam
    // repetir a validação.
    const prazoZona = prazoModo ? await resolverZonaCliente(req.body?.timezone) : null
    // ON CONFLICT no índice parcial (criado_por, client_request_id): retries com a mesma chave
    // retornam a obra já criada em vez de inserir duplicata. Sem chave (NULL) → insert normal.
    //
    // O CASE existe para que SÓ o ramo 'hoje' mude: as outras faixas continuam gravando o
    // $10 calculado no Node acima, byte a byte o que gravavam antes. O ramo 'hoje' é resolvido
    // no POSTGRES — o container roda em UTC e um new Date() daria o DIA errado nas horas finais
    // do dia local (mesmo motivo documentado em JANELAS_CHEGADA).
    // A zona entra como PARÂMETRO ($21), nunca interpolada: o valor vem do cliente.
    const result = await pool.query(
      `INSERT INTO obras (criado_por, titulo, categoria, valor, cidade, bairro, uf, metragem, prazo_execucao_dias, expira_em, descricao, tags, endereco_obra, ponto_referencia, latitude, longitude, coordenadas_origem, status, enviada_por_dono, status_aprovacao, client_request_id, horas_para_expirar, prazo_modo, prazo_timezone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               CASE WHEN $20::text = '${PRAZO_MODO_HOJE}' THEN ${sqlFimDoDia('$21::text')} ELSE $10::timestamptz END,
               $11,$12,$13,$14,$15,$16,$17,'rascunho',true,'pendente',$18,$19,$20,$21)
       ON CONFLICT (criado_por, client_request_id) WHERE client_request_id IS NOT NULL
       DO UPDATE SET client_request_id = EXCLUDED.client_request_id
       RETURNING *`,
      [req.usuario.id, titulo, categoria, valor, cidade, bairro, ufFinal, metragem, prazo_execucao_dias, expira_em.toISOString(), descricao, tags || [], endereco_obra, ponto_referencia, latFinal, lngFinal, coordOrigem, client_request_id || null, horasExpiracao, prazoModo, prazoZona]
    )
    let obra = result.rows[0]
    // Aprovação automática de obras (flag global em configuracoes, default 'false' = OFF).
    // Ligada, publica na hora pela MESMA função da rota de aprovação do admin — mesmo UPDATE,
    // mesmo reinício de relógio, mesmos avisos. Responde com a linha já publicada para o app
    // não exibir "em análise" uma obra que acabou de ir ao ar.
    // try/catch local de propósito: a obra JÁ existe: uma falha na publicação automática não
    // pode virar 500 e mascarar a criação. Degrada para 'pendente' — a fila manual de hoje.
    try {
      const cfgAuto = await pool.query(`SELECT valor FROM configuracoes WHERE chave = 'aprovacao_automatica_obras'`)
      if (cfgAuto.rows[0]?.valor === 'true') {
        const publicada = await aprovarEPublicarObra(obra.id)
        if (publicada) obra = publicada
      }
    } catch (err) {
      console.error('[obras/dono] aprovacao automatica falhou:', err.message)
    }
    res.status(201).json(obra)
  } catch (err) {
    console.error('[obras/dono]', err.message)
    res.status(500).json({ erro: 'Erro ao cadastrar obra' })
  }
})

router.get('/obras-aprovacao', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { page, limit, offset } = paginacaoAdmin(req.query)

    const result = await pool.query(
      `SELECT o.*, u.nome as dono_nome, u.email as dono_email, u.telefone as dono_telefone,
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) as foto_capa
       FROM obras o JOIN usuarios u ON o.criado_por = u.id
       WHERE o.enviada_por_dono = true AND o.status_aprovacao = 'pendente'
       ORDER BY o.criado_em DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    res.json({ obras: result.rows, page, limit })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar obras para aprovação' })
  }
})

// Push para o DONO com o desfecho da análise da obra (a obra é a única vertical que passa
// por aprovação; reparo publica direto). Segue o padrão já usado no aviso de novo candidato
// (SELECT juntando usuarios pelo criado_por — ver mais abaixo, no /candidaturas).
// Sem push_token cadastrado simplesmente não há o que enviar — não é erro.
// Quem chama SEMPRE dispara fire-and-forget e só na TRANSIÇÃO de status: o painel do admin
// não pode esperar nem falhar por causa de uma notificação, e reprocessar não pode reavisar.
const notificarDonoSobreAnaliseObra = async (obraId, aprovada) => {
  const info = await pool.query(
    `SELECT u.push_token, o.titulo FROM obras o JOIN usuarios u ON o.criado_por = u.id WHERE o.id = $1`,
    [obraId]
  )
  const { push_token, titulo } = info.rows[0] || {}
  if (!push_token) return
  await enviarPushNotificacao(
    push_token,
    aprovada ? '✅ Obra aprovada!' : '❌ Obra não aprovada',
    aprovada
      ? `"${titulo}" já está publicada e visível para os pintores.`
      : `"${titulo}" não foi publicada desta vez. Toque para rever os detalhes e cadastrar novamente.`,
    { tipo: aprovada ? 'obra_aprovada' : 'obra_recusada', obra_id: obraId }
  )
}

// Aprova e PUBLICA uma obra — fonte ÚNICA do efeito de aprovação. Tudo o que "publicar"
// significa mora aqui: o UPDATE das duas colunas de status, o reinício de publicado_em/
// expira_em e os dois avisos (broadcast aos pintores + desfecho ao dono). Quem aprova por
// qualquer caminho (painel do admin ou flag de aprovação automática) chama esta função, para
// que os caminhos não possam divergir.
//
// Aprovação PUBLICA a obra e reinicia o relógio a partir de agora: o expira_em setado na
// criação correu durante a fila de aprovação, então uma obra podia ir ao ar já expirada.
// publicado_em = NOW() é a âncora do ciclo de vida. COALESCE(..., 720) é obrigatório:
// NOW() + NULL = NULL, e um expira_em NULL sumiria do feed e quebraria os classificadores
// de histórico em JS (new Date(null)). Backfill garante que linhas antigas têm a coluna.
// Guarda de idempotência (status_aprovacao <> 'aprovada'): o relógio só reinicia na
// TRANSIÇÃO para aprovada. Sem ela, re-aprovar (duplo clique do admin) reiniciaria
// publicado_em/expira_em — extensão grátis e backdoor no teto de vida 2x do PR2, cuja
// âncora é publicado_em. Admite pendente E recusada (reaprovar rejeitada é fluxo válido);
// bloqueia só quem já está aprovada. Como status e status_aprovacao são setados no mesmo
// UPDATE, é impossível ficar aprovada com status ainda 'rascunho'.
//
// Devolve a linha atualizada na TRANSIÇÃO, ou null quando o UPDATE não mudou nada (já estava
// aprovada — duplo clique do admin — ou o id não existe).
const aprovarEPublicarObra = async (obraId) => {
  const atualizada = await pool.query(
    // Faixa "Hoje": o relógio reinicia na APROVAÇÃO (é ela que publica), então "hoje" é o dia
    // em que o admin aprovou, não o dia do rascunho. Sem este CASE, aprovar uma obra "Hoje"
    // reconstruiria expira_em a partir de horas_para_expirar e desfaria a regra em silêncio.
    // O dia é o do DONO, não o do admin nem o do servidor: a zona sai de prazo_timezone,
    // gravada no create. Sem isso, aprovar uma obra de Rio Branco resolveria o dia de SP.
    `UPDATE obras SET status_aprovacao = 'aprovada', status = 'aberta',
       publicado_em = NOW(),
       expira_em = CASE WHEN prazo_modo = '${PRAZO_MODO_HOJE}' THEN ${sqlFimDoDia(SQL_ZONA_DA_OBRA)}
                        ELSE NOW() + (COALESCE(horas_para_expirar, 720) * INTERVAL '1 hour') END
     WHERE id = $1 AND status_aprovacao <> 'aprovada'
     RETURNING *`, [obraId])
  // Os DOIS avisos só na TRANSIÇÃO pendente/recusada → aprovada. rowCount 0 significa que o
  // UPDATE não mudou nada: reavisar o dono seria ruído, e rebroadcastar aos pintores
  // anunciaria como "nova" uma obra publicada dias atrás, para até 500 pessoas de uma vez.
  if (atualizada.rowCount === 0) return null
  notificarPintoresSobreNovaObra(obraId).catch(err => console.error('Erro notificar pintores:', err))
  notificarDonoSobreAnaliseObra(obraId, true)
    .catch(err => console.error('Erro notificar dono (obra aprovada):', err.message))
  return atualizada.rows[0]
}

router.post('/obras-aprovacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await aprovarEPublicarObra(req.params.id)
    res.json({ mensagem: 'Obra aprovada e publicada!' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar obra' })
  }
})

router.post('/obras-aprovacao/:id/recusar', autenticar, exigirAdmin, async (req, res) => {
  try {
    // Guarda de idempotência espelhando a da aprovação: sem ela, reprocessar uma recusa
    // (duplo clique do admin) reavisaria o dono de uma decisão que ele já recebeu.
    const atualizada = await pool.query(
      // encerrado_em marca o início dos 7 dias de retenção de mídia (ver deletarMidiasAntigas):
      // obra recusada também carrega mídia, e sem esta coluna o job nunca a enxerga.
      // COALESCE preserva a data de um encerramento anterior em vez de reiniciar a contagem.
      `UPDATE obras SET status_aprovacao = 'recusada', status = 'cancelada',
              encerrado_em = COALESCE(encerrado_em, NOW())
        WHERE id = $1 AND status_aprovacao <> 'recusada'
        RETURNING id`, [req.params.id])
    res.json({ mensagem: 'Obra recusada' })
    if (atualizada.rowCount > 0) {
      notificarDonoSobreAnaliseObra(req.params.id, false)
        .catch(err => console.error('Erro notificar dono (obra recusada):', err.message))
    }
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao recusar obra' })
  }
})

router.get('/obras', autenticar, exigirNaoSuspenso, exigirAssinaturaAtiva, exigirPintor, async (req, res) => {
  try {
    const { page, limit, offset } = paginacaoAdmin(req.query)
    req.query.page  = page
    req.query.limit = limit
    req.query.offset = offset
    return obrasCtrl.listar(req, res)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar obras' })
  }
})

// Painel admin — lista obras por situação (finalizadas / canceladas-expiradas).
// O GET /obras público só devolve obras abertas/aprovadas/não expiradas, então o
// painel precisa deste endpoint para enxergar o histórico de obras encerradas e
// canceladas. "Expirada" não é um status no banco: é uma obra ainda 'aberta' cujo
// expira_em já passou — por isso o filtro 'canceladas' inclui esse caso.
router.get('/obras/admin', autenticar, exigirAdmin, async (req, res) => {
  try {
    const filtro = req.query.filtro || 'finalizadas'
    let where
    if (filtro === 'finalizadas') {
      where = `o.status = 'encerrada'`
    } else if (filtro === 'canceladas') {
      where = `(o.status IN ('cancelada', 'expirada') OR (o.status = 'aberta' AND o.expira_em <= NOW()))`
    } else {
      return res.status(400).json({ erro: 'Filtro inválido' })
    }
    const result = await pool.query(`
      SELECT o.id, o.titulo, o.categoria, o.valor, o.cidade, o.uf, o.bairro,
             o.metragem, o.prazo_execucao_dias, o.expira_em, o.tags, o.status,
             (o.status = 'aberta' AND o.expira_em <= NOW()) AS expirada,
             (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) AS total_candidaturas
      FROM obras o
      WHERE ${where}
      ORDER BY o.expira_em DESC NULLS LAST, o.id DESC
      LIMIT 200
    `)
    res.json({ obras: result.rows })
  } catch (err) {
    console.error('Erro ao listar obras (admin):', err)
    res.status(500).json({ erro: 'Erro ao buscar obras' })
  }
})

router.post('/obras',       autenticar, exigirAdmin, obrasCtrl.criar)
router.put('/obras/:id',    autenticar, exigirAdmin, obrasCtrl.editar)
router.delete('/obras/:id', autenticar, exigirAdmin, obrasCtrl.encerrar)

// Dono pode excluir sua própria obra
router.delete('/obras/dono/:id', autenticar, async (req, res) => {
  try {
    const obra = await pool.query(`SELECT * FROM obras WHERE id = $1 AND criado_por = $2`, [req.params.id, req.usuario.id])
    if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    // encerrado_em: mesmo motivo do recusar acima — libera a obra cancelada para a limpeza
    // de mídia depois de 7 dias. COALESCE não reinicia contagem já iniciada.
    await pool.query(`UPDATE obras SET status = 'cancelada', status_aprovacao = 'cancelada',
      encerrado_em = COALESCE(encerrado_em, NOW()) WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Obra removida com sucesso' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover obra' })
  }
})

// Ponto de referência — a ÚNICA edição de demanda aberta ao dono. Até aqui o campo era
// write-once no create (nem o PUT /obras/:id do admin o aceita), e é o que o profissional lê
// para achar o lugar ("portão azul ao lado da padaria").
//
// Regras compartilhadas pelas duas verticais numa função só, de propósito: obra e reparo
// divergirem em validação é um erro recorrente neste código.
//   ausente   -> 400. Corpo vazio por engano não pode APAGAR a referência.
//   null / '' -> NULL, que é o "limpar" explícito.
//   > 200     -> 400. Referência maior que isso não é referência; também limita o campo como
//                canal de texto livre para o profissional casado.
const LIMITE_PONTO_REFERENCIA = 200
const normalizarPontoReferencia = (bruto) => {
  if (bruto === undefined) return { erro: 'Informe ponto_referencia' }
  if (bruto !== null && typeof bruto !== 'string') return { erro: 'ponto_referencia deve ser texto' }
  const texto = (bruto ?? '').trim()
  if (texto.length > LIMITE_PONTO_REFERENCIA) {
    return { erro: `ponto_referencia deve ter no máximo ${LIMITE_PONTO_REFERENCIA} caracteres` }
  }
  return { valor: texto === '' ? null : texto }
}

// PATCH /obras/dono/:id/ponto-referencia
// Segue permitido DEPOIS do match de propósito: o campo serve para o profissional chegar ao
// local, então é justamente na ida dele que corrigir a referência importa. É seguro porque o
// contrato NÃO carrega ponto_referencia (contratosController renderiza endereco_obra), então
// editar aqui não mexe em nada já acordado — e o campo só é revelado a dono, casado, aceito e
// admin, então a edição chega exatamente a quem precisa dela.
// SÓ ponto_referencia entra: o corpo nunca é espalhado. valor, endereço, coordenadas, status e
// prazos têm caminhos próprios (estender, aprovar, encerrar) e não podem virar editáveis aqui.
router.patch('/obras/dono/:id/ponto-referencia', autenticar, async (req, res) => {
  try {
    const { ponto_referencia } = req.body
    const { erro, valor } = normalizarPontoReferencia(ponto_referencia)
    if (erro) return res.status(400).json({ erro })

    // Posse DENTRO do UPDATE (mesmo padrão de DELETE /obras/dono/:id e do estender): sem
    // SELECT antes, sem janela entre checar e escrever. rowCount 0 = não é dele OU não existe,
    // e os dois viram 404 — 403 confirmaria que a obra existe para quem não é o dono.
    const upd = await pool.query(
      `UPDATE obras SET ponto_referencia = $2 WHERE id = $1 AND criado_por = $3
       RETURNING ponto_referencia`,
      [req.params.id, valor, req.usuario.id]
    )
    if (upd.rowCount === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    res.json({ ponto_referencia: upd.rows[0].ponto_referencia })
  } catch (err) {
    console.error('[obras/ponto-referencia]', err.message)
    res.status(500).json({ erro: 'Erro ao atualizar ponto de referência' })
  }
})

// Teto de segurança PLANO da extensão de obra: 365 dias. Substitui o antigo teto de 2x a
// janela original — não há mais orçamento derivado de publicado_em/horas_para_expirar; o
// único limite é absoluto, para barrar valor absurdo (ex.: um dígito a mais por engano).
const TETO_ESTENDER_OBRA_HORAS = 8760

// Janela de dedupe do estender de obra — espelha DEDUPE_ESTENDER_REPARO_MINUTOS. Sem
// client_request_id no corpo, a chave é (ultima_extensao_em, ultima_extensao_horas): repetir o
// MESMO horas dentro da janela é tratado como retry do mesmo clique — devolve o prazo atual sem
// somar de novo. Fora da janela, ou com horas diferente, é uma extensão nova e legítima (o dono
// pode estender duas vezes seguidas de propósito).
const DEDUPE_ESTENDER_OBRA_MINUTOS = 5

// POST /obras/:id/estender — dono estende o prazo da própria obra, respeitando o teto plano
// de 8760h. Re-arma TODOS os marcos de expiração (marco_6h/60/30/15_em = NULL):
// como expira_em foi empurrado para frente, os 4 alertas precisam re-disparar contra o novo
// prazo, senão a obra estendida mantém os marcos já gastos e não recebe nova contagem
// regressiva. (Substitui o antigo clear de alerta_sem_interessados_em, cujo job foi aposentado.)
router.post('/obras/:id/estender', autenticar, async (req, res) => {
  try {
    const obra = await pool.query(
      `SELECT id, criado_por, status, match_usuario_id, expira_em, criado_em, publicado_em, horas_para_expirar,
              prazo_modo, prazo_timezone
       FROM obras WHERE id = $1 AND criado_por = $2`,
      [req.params.id, req.usuario.id]
    )
    if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    const o = obra.rows[0]
    if (o.status !== 'aberta') return res.status(409).json({ erro: 'Só é possível estender uma obra aberta' })
    if (o.match_usuario_id) return res.status(409).json({ erro: 'Não é possível estender uma obra com pintor a caminho' })

    const horas = Number(req.body?.horas)
    if (!Number.isFinite(horas) || horas < 1) return res.status(400).json({ erro: 'horas inválido: informe um número >= 1' })
    if (horas > TETO_ESTENDER_OBRA_HORAS) {
      return res.status(400).json({ erro: `horas inválido: máximo de ${TETO_ESTENDER_OBRA_HORAS} (365 dias)`, extensao_maxima_horas: TETO_ESTENDER_OBRA_HORAS })
    }

    // Obra é SEMPRE estendida em dias inteiros — o modal do app manda dias * 24, mínimo 1 dia.
    // O endpoint, porém, aceita qualquer inteiro de horas, então o valor é convertido aqui:
    // CEIL para o dia seguinte em vez de recusar. Arredondar para CIMA e não para baixo porque
    // o dono pediu MAIS prazo: 30h vira 2 dias, nunca 1. horas >= 1 (validado acima) garante
    // dias >= 1, então não há extensão de zero dia.
    const diasExtensao = Math.max(1, Math.ceil(horas / 24))

    // Só o novo expira_em: sem orçamento a calcular, a query perdeu a metade budget_antes.
    //
    // Dois ramos, e só o de "Hoje" mudou:
    //
    // FAIXA POR DURAÇÃO (prazo_modo NULL) — byte a byte o que sempre foi.
    // GREATEST(expira_em, NOW()) preservado — obra já vencida estende a partir de agora, e
    // não de um vencimento no passado (senão "+2h" compraria menos de 2h de vida real).
    //
    // FAIXA "HOJE" — o prazo é um INSTANTE DE CALENDÁRIO, não uma duração, então somar horas
    // ao GREATEST convertia a meia-noite num horário de relógio para sempre: uma obra que
    // venceu à meia-noite e é estendida às 09:00 caía em 09:00, não em meia-noite.
    // Aqui a soma é de DIAS sobre o DIA, e o resultado volta a ser fim de dia:
    //   base = o DIA mais tardio entre o do prazo guardado e o de hoje, no fuso do dono —
    //          obra viva ganha dias a partir do PRÓPRIO prazo; obra vencida, a partir de hoje;
    //   fim  = fim daquele dia + N dias (o +1 dia -1 microssegundo é o mesmo fecho de dia de
    //          sqlFimDoDia, aplicado a um dia deslocado em vez de a hoje).
    // A zona passa pelo MESMO lookup seguro dos caminhos de rebuild: zona morta ou NULL recua
    // para São Paulo em vez de levantar 22023 (aqui derrubaria só esta request, mas o motivo
    // para não confiar na coluna crua é o mesmo).
    const cap = await pool.query(
      `SELECT CASE WHEN $4::text = '${PRAZO_MODO_HOJE}' THEN (
                     date_trunc('day', GREATEST(
                       $1::timestamptz AT TIME ZONE ${sqlZonaSegura('$3::text')},
                       NOW()           AT TIME ZONE ${sqlZonaSegura('$3::text')}
                     ))
                     + (($5::int + 1) * INTERVAL '1 day') - INTERVAL '1 microsecond'
                   ) AT TIME ZONE ${sqlZonaSegura('$3::text')}
                   ELSE GREATEST($1::timestamptz, NOW()) + ($2::numeric * INTERVAL '1 hour')
              END AS novo_expira_em`,
      [o.expira_em, horas, o.prazo_timezone, o.prazo_modo, diasExtensao]
    )

    // Guarda de dedupe DENTRO do UPDATE, não em um if antes dele: checar em uma query e gravar em
    // outra deixa a janela aberta para dois cliques simultâneos passarem os dois pela checagem e
    // somarem duas vezes. Aqui o próprio UPDATE decide — quem perder a corrida não casa mais com o
    // predicado e volta rowCount = 0. COALESCE(..., FALSE) porque linha nunca estendida tem as duas
    // colunas NULL: sem ele a comparação vira NULL, o NOT propaga NULL e o UPDATE não aplicaria a
    // PRIMEIRA extensão. Fail-open é o lado certo: na dúvida, estende.
    const upd = await pool.query(
      `UPDATE obras SET expira_em = $1,
         marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL,
         ultima_extensao_em = NOW(), ultima_extensao_horas = $5::numeric
       WHERE id = $2 AND criado_por = $3
         AND NOT COALESCE(
               ultima_extensao_em > NOW() - ($4::numeric * INTERVAL '1 minute')
               AND ultima_extensao_horas = $5::numeric, FALSE)
       RETURNING expira_em`,
      [cap.rows[0].novo_expira_em, req.params.id, req.usuario.id, DEDUPE_ESTENDER_OBRA_MINUTOS, horas]
    )

    // rowCount = 0 → o predicado de dedupe barrou (retry do mesmo horas na janela). Não é erro: o
    // cliente pediu um estado que o servidor já tem, então devolve o prazo ATUAL como sucesso, com
    // o mesmo shape do caminho normal. O re-SELECT também cobre a linha ter sumido entre o SELECT
    // inicial e o UPDATE (delete concorrente) — aí sim é 404.
    if (upd.rowCount === 0) {
      const atual = await pool.query(
        `SELECT expira_em FROM obras WHERE id = $1 AND criado_por = $2`,
        [req.params.id, req.usuario.id]
      )
      if (atual.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
      return res.json({ expira_em: atual.rows[0].expira_em, extensao_maxima_horas: TETO_ESTENDER_OBRA_HORAS - horas })
    }

    res.json({ expira_em: upd.rows[0].expira_em, extensao_maxima_horas: TETO_ESTENDER_OBRA_HORAS - horas })
  } catch (err) {
    console.error('[obras/estender]', err.message)
    res.status(500).json({ erro: 'Erro ao estender prazo da obra' })
  }
})

router.get('/obras/:id', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*,
        -- "Expirada" não é status no banco: é uma obra NÃO encerrada cujo expira_em já
        -- passou. Calculado no SQL (relógio do servidor) para a tela de detalhe gatear o
        -- botão de estender sem comparar com o relógio do aparelho. Mesma expressão do
        -- GET /obras/minhas.
        (o.status <> 'encerrada' AND o.expira_em <= NOW()) AS expirada,
        (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_candidaturas,
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) as foto_capa
       FROM obras o WHERE o.id = $1`,
      [req.params.id]
    )
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    const obra = result.rows[0]
    const ehDono = obra.criado_por === req.usuario.id
    const ehPintorDoMatch = obra.match_usuario_id === req.usuario.id

    if (!ehDono && !ehPintorDoMatch && req.usuario.role !== 'admin') {
      const assinatura = await pool.query(
        `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' AND (proximo_vencimento IS NULL OR proximo_vencimento > NOW()) LIMIT 1`,
        [req.usuario.id]
      )
      if (assinatura.rows.length === 0) {
        return res.status(403).json({ erro: 'Assinatura necessária para ver esta obra' })
      }
    }

    const midias = await pool.query(`SELECT * FROM midias WHERE obra_id = $1 ORDER BY ordem`, [req.params.id])
    const minhaCandidaturaResult = await pool.query(
      `SELECT id, status, valor_oferta, mensagem_oferta, valor_proposto, mensagem, valor_contraproposta FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2`,
      [req.params.id, req.usuario.id]
    )

    let candidatos = []
    if (ehDono || req.usuario.role === 'admin') {
      const candidatosResult = await pool.query(
        // Contato/endereço do pintor são revelados ao dono APENAS após o match
        // (obras.match_usuario_id aponta para o pintor que confirmou a ida), e só
        // para o pintor efetivamente casado — nunca no mero aceite (status='aceito').
        // EXCEÇÃO: bairro sai para todos os candidatos, junto de cidade — é granularidade
        // de região (ajuda o dono a julgar deslocamento), não endereço. logradouro, numero
        // e telefone continuam match-gated: só esses três localizam/contatam o pintor.
        `SELECT c.id, c.status, c.valor_proposto, c.valor_contraproposta, c.mensagem,
                u.nome, u.cidade, u.bairro, u.foto_url, c.usuario_id,
                u.anos_experiencia, u.especialidades, u.tamanho_equipe,
                CASE WHEN c.usuario_id = $2 THEN u.logradouro ELSE NULL END as logradouro,
                CASE WHEN c.usuario_id = $2 THEN u.numero ELSE NULL END as numero,
                CASE WHEN c.usuario_id = $2 THEN u.telefone ELSE NULL END as telefone,
                (SELECT COUNT(*)::int FROM avaliacoes a WHERE a.avaliado_id = c.usuario_id) AS avaliacoes_total,
                (SELECT COALESCE(ROUND(AVG(a.estrelas)::numeric, 1), 0) FROM avaliacoes a WHERE a.avaliado_id = c.usuario_id) AS avaliacoes_media
         FROM candidaturas c JOIN usuarios u ON u.id = c.usuario_id
         WHERE c.obra_id = $1 ORDER BY c.criado_em DESC`,
        [req.params.id, obra.match_usuario_id]
      )
      candidatos = candidatosResult.rows
    }

    // Aceite do próprio requester. Procura a linha 'aceito' EXPLICITAMENTE em vez de
    // olhar rows[0]: a query de minha_candidatura não tem ORDER BY/LIMIT, então rows[0]
    // é arbitrário e poderia ser uma candidatura recusada da mesma obra.
    const meuAceite = minhaCandidaturaResult.rows.find(c => c.status === 'aceito')

    // Endereço exato e ponto de referência só para dono, pintor do match, pintor com
    // candidatura aceita ou admin (Finding 3.1). ponto_referencia sai junto porque também
    // localiza o imóvel ("portão azul ao lado da padaria") — mascarar só o endereço
    // deixaria a dica de localização vazando para qualquer assinante.
    // Coordenadas permanecem para o cálculo de distância no cliente.
    if (obra.criado_por !== req.usuario.id && obra.match_usuario_id !== req.usuario.id && !meuAceite && req.usuario.role !== 'admin') {
      delete obra.endereco_obra
      delete obra.ponto_referencia
    }

    // Advisory: quanto o dono ainda pode estender, contra o teto plano de
    // TETO_ESTENDER_OBRA_HORAS (365 dias) — só p/ o app oferecer opções válidas.
    // "Horas já usadas" = o quanto expira_em já foi empurrado ALÉM do vencimento original
    // (âncora + janela), não o tempo decorrido: envelhecer sem estender não consome teto.
    // Anchor obra: COALESCE(publicado_em, criado_em); janela COALESCE(horas_para_expirar, 720).
    //
    // ATENÇÃO — este advisory é CUMULATIVO, mas POST /obras/:id/estender valida por REQUISIÇÃO
    // (rejeita 400 só se horas > 8760, sem somar extensões anteriores). Ou seja: o app oferece
    // no máximo o que sobra do total, e o endpoint aceitaria mais. Erra para o lado seguro
    // (nunca oferece o que tomaria 400), mas os dois só ficam idênticos quando o endpoint
    // também passar a descontar o acumulado.
    const ancoraObraMs = new Date(obra.publicado_em || obra.criado_em).getTime()
    const expiraOriginalObraMs = ancoraObraMs + (Number(obra.horas_para_expirar) || 720) * 3600 * 1000
    const horasUsadasObra = Math.max(0, (new Date(obra.expira_em).getTime() - expiraOriginalObraMs) / 3600000)
    const extensao_maxima_horas = Math.max(0, TETO_ESTENDER_OBRA_HORAS - horasUsadasObra)
    res.json({ obra, midias: midias.rows, minha_candidatura: minhaCandidaturaResult.rows[0] || null, candidatos, extensao_maxima_horas })

    // Contador de visitas — só incrementa um contador EM MEMÓRIA; quem grava é o flush
    // periódico (src/utils/visitas.js). Síncrono e sem I/O: nenhum lock de linha e nenhuma
    // conexão do pool no caminho de leitura mais quente da API.
    if (!ehDono) registrarVisita('obras', req.params.id)
  } catch (err) {
    console.error('Erro ao buscar obra:', err)
    res.status(500).json({ erro: 'Erro ao buscar obra' })
  }
})

// POST /obras/:id/candidatura — pintor se candidata a uma obra
router.post('/obras/:id/candidatura', autenticar, exigirNaoSuspenso, exigirAssinaturaAtiva, exigirPintor, async (req, res) => {
  try {
    const { mensagem, valor_proposto } = req.body
    const existente = await pool.query(
      `SELECT id FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2`,
      [req.params.id, req.usuario.id]
    )
    if (existente.rows.length > 0) return res.status(409).json({ erro: 'Você já se candidatou nesta obra' })
    const result = await pool.query(
      `INSERT INTO candidaturas (obra_id, usuario_id, mensagem, valor_proposto, status) VALUES ($1, $2, $3, $4, 'pendente') RETURNING *`,
      [req.params.id, req.usuario.id, mensagem, valor_proposto || null]
    )
    const donoInfo = await pool.query(
      `SELECT u.push_token, o.titulo FROM obras o JOIN usuarios u ON o.criado_por = u.id WHERE o.id = $1`,
      [req.params.id]
    )
    if (donoInfo.rows[0]?.push_token) {
      enviarPushNotificacao(donoInfo.rows[0].push_token, '🎨 Novo candidato!',
        `Um pintor se candidatou na obra "${donoInfo.rows[0].titulo}"`,
        { tipo: 'nova_candidatura', obra_id: req.params.id }).catch(() => {})
    }
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('Erro ao candidatar:', err)
    res.status(500).json({ erro: 'Erro ao registrar candidatura' })
  }
})

// POST /obras/:id/candidatura/:candidaturaId/responder — dono responde a uma candidatura
router.post('/obras/:id/candidatura/:candidaturaId/responder', autenticar, async (req, res) => {
  try {
    const { action, valor } = req.body
    const { id: obra_id, candidaturaId } = req.params
    const obra = await pool.query(`SELECT criado_por, titulo FROM obras WHERE id = $1`, [obra_id])
    if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    if (obra.rows[0].criado_por !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o dono pode responder' })
    const candidatura = await pool.query(
      `SELECT c.*, u.push_token FROM candidaturas c JOIN usuarios u ON c.usuario_id = u.id WHERE c.id = $1 AND c.obra_id = $2`,
      [candidaturaId, obra_id]
    )
    if (candidatura.rows.length === 0) return res.status(404).json({ erro: 'Candidatura não encontrada' })
    const cand = candidatura.rows[0]
    if (action === 'aceitar') {
      // Idempotência de retry: já aceita → devolve sucesso sem reprocessar (sem repetir
      // push nem o UPDATE do match). Sem isto o jaAceito abaixo não pega o próprio
      // registro (id != $2). Espelha o guard de .../pintor-responder.
      // O contrato É rechamado: se já foi enviado, o claim em enviarContratoObra sai cedo
      // sem e-mail; se o envio anterior falhou, o claim foi liberado e esta é a retentativa.
      if (cand.status === 'aceito') {
        enviarContratoObra(candidaturaId).catch(err => console.error('Erro ao enviar contrato obra:', err))
        return res.json({ mensagem: 'Candidatura aceita! Contrato enviado por e-mail.' })
      }
      const jaAceito = await pool.query(
        `SELECT id FROM candidaturas WHERE obra_id = $1 AND status = 'aceito' AND id != $2`,
        [req.params.id, candidaturaId]
      )
      if (jaAceito.rows.length > 0) {
        return res.status(409).json({ erro: 'Já existe um candidato aceito para esta obra' })
      }
      // Suspensão do CANDIDATO (não de quem chama — aqui quem chama é o dono). O aceite já casa
      // o profissional, então deixar passar entregaria trabalho novo a um suspenso.
      if (await estaSuspenso(cand.usuario_id)) {
        return res.status(409).json(ERRO_ACEITE_SUSPENSO)
      }
      await pool.query(`UPDATE candidaturas SET status = 'aceito' WHERE id = $1`, [candidaturaId])
      // O aceite já casa o profissional com a obra. Guard match_usuario_id IS NULL: torna o
      // write idempotente em retry e impede que um segundo aceite roube um match existente.
      await pool.query(
        `UPDATE obras SET match_usuario_id = $1, match_feito_em = NOW()
         WHERE id = $2 AND match_usuario_id IS NULL`,
        [cand.usuario_id, obra_id]
      )
      if (cand.push_token) {
        enviarPushNotificacao(cand.push_token, '🎉 Deu match!',
          `Parabéns! Você fechou negócio em "${obra.rows[0].titulo}"! Toque para ver os detalhes.`,
          { tipo: 'candidatura_aceita', obra_id }).catch(() => {})
      }
      enviarContratoObra(candidaturaId).catch(err => console.error('Erro ao enviar contrato obra:', err))
      // Recusa os demais candidatos e os notifica (antes ficava só no /match, que hoje sai
      // no early-return). Fire-and-forget: efeito secundário, não bloqueia a resposta.
      rejeitarConcorrentes('obra', obra_id, cand.usuario_id).catch(err => console.error('[obras/responder] rejeitarConcorrentes:', err.message))
      return res.json({ mensagem: 'Candidatura aceita! Contrato enviado por e-mail.' })
    }
    if (action === 'recusar') {
      await pool.query(`UPDATE candidaturas SET status = 'recusado' WHERE id = $1`, [candidaturaId])
      if (cand.push_token) {
        enviarPushNotificacao(cand.push_token, '❌ Candidatura não aceita',
          `Sua candidatura para "${obra.rows[0].titulo}" não foi selecionada desta vez.`,
          { tipo: 'candidatura_recusada', obra_id }).catch(() => {})
      }
      return res.json({ mensagem: 'Candidatura recusada.' })
    }
    if (action === 'contraproposta') {
      if (!valor) return res.status(400).json({ erro: 'Informe o valor da contraproposta' })
      await pool.query(
        `UPDATE candidaturas SET status = 'contraproposta_dono', valor_contraproposta = $2 WHERE id = $1`,
        [candidaturaId, valor]
      )
      if (cand.push_token) {
        enviarPushNotificacao(cand.push_token, '💬 Contraproposta recebida!',
          `O solicitante fez uma contraproposta para "${obra.rows[0].titulo}". Veja no app!`,
          { tipo: 'contraproposta_dono', obra_id }).catch(() => {})
      }
      return res.json({ mensagem: 'Contraproposta enviada!' })
    }
    res.status(400).json({ erro: 'Ação inválida' })
  } catch (err) {
    console.error('Erro ao responder candidatura:', err)
    res.status(500).json({ erro: 'Erro ao responder' })
  }
})

// POST /obras/:id/candidatura/:candidaturaId/pintor-responder — pintor responde a contraproposta
router.post('/obras/:id/candidatura/:candidaturaId/pintor-responder', autenticar, exigirPintor, async (req, res) => {
  try {
    const { action, valor } = req.body
    const { id: obra_id, candidaturaId } = req.params
    const candidatura = await pool.query(
      `SELECT * FROM candidaturas WHERE id = $1 AND obra_id = $2 AND usuario_id = $3`,
      [candidaturaId, obra_id, req.usuario.id]
    )
    if (candidatura.rows.length === 0) return res.status(404).json({ erro: 'Candidatura não encontrada' })
    if (candidatura.rows[0].status !== 'contraproposta_dono') {
      // Idempotência de retry: já aceita → sucesso em vez de 400, espelhando o guard de
      // .../prestador-responder (que este endpoint não tinha). O contrato é rechamado: se
      // já foi enviado, o claim em enviarContratoObra sai cedo sem e-mail; se o envio
      // anterior falhou, o claim foi liberado e esta é a retentativa.
      if (action === 'aceitar' && candidatura.rows[0].status === 'aceito') {
        enviarContratoObra(candidaturaId).catch(err => console.error('Erro ao enviar contrato obra:', err))
        return res.json({ mensagem: 'Contraproposta aceita! Contrato enviado por e-mail.' })
      }
      return res.status(400).json({ erro: 'Não há contraproposta pendente' })
    }
    const obra = await pool.query(`SELECT titulo, criado_por FROM obras WHERE id = $1`, [obra_id])
    const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [obra.rows[0].criado_por])
    if (action === 'contraproposta') {
      if (!valor) return res.status(400).json({ erro: 'Informe o valor da contraproposta' })
      // Volta para 'pendente' com o novo valor para reentrar no fluxo de resposta do dono
      await pool.query(`UPDATE candidaturas SET status = 'pendente', valor_proposto = $2, valor_contraproposta = NULL WHERE id = $1`, [candidaturaId, valor])
      if (dono.rows[0]?.push_token) {
        enviarPushNotificacao(dono.rows[0].push_token, '💬 Nova contraproposta do profissional!',
          `O pintor propôs R$ ${Number(valor).toLocaleString('pt-BR')} para "${obra.rows[0].titulo}". Veja no app!`,
          { tipo: 'contra_oferta', obra_id }).catch(() => {})
      }
      return res.json({ mensagem: 'Contraproposta enviada!' })
    }
    if (action === 'aceitar') {
      // Aceitar a contraproposta CASA o pintor — é entrada em trabalho novo, então a suspensão
      // vale aqui. Não é middleware porque só 'aceitar' entra: 'recusar' e 'contraproposta'
      // seguem liberados, senão o suspenso ficaria preso numa negociação sem poder encerrá-la.
      // Lê do banco, não de req.usuario: o cache de 5 min de autenticar não pode liberar um
      // aceite, que é irreversível (casa e dispara contrato).
      const suspensao = await estaSuspenso(req.usuario.id)
      if (suspensao) return res.status(403).json(corpoContaSuspensa(suspensao))
      await pool.query(`UPDATE candidaturas SET status = 'aceito' WHERE id = $1`, [candidaturaId])
      // O aceite já casa o profissional com a obra (ver POST .../responder).
      await pool.query(
        `UPDATE obras SET match_usuario_id = $1, match_feito_em = NOW()
         WHERE id = $2 AND match_usuario_id IS NULL`,
        [req.usuario.id, obra_id]
      )
      if (dono.rows[0]?.push_token) {
        enviarPushNotificacao(dono.rows[0].push_token, '🎉 Deu match!',
          `Parabéns! Você fechou negócio em "${obra.rows[0].titulo}"! Toque para ver os detalhes.`,
          { tipo: 'candidatura_aceita', obra_id }).catch(() => {})
      }
      enviarContratoObra(candidaturaId).catch(err => console.error('Erro ao enviar contrato obra:', err))
      // Recusa os demais candidatos e os notifica (ver POST .../responder).
      rejeitarConcorrentes('obra', obra_id, req.usuario.id).catch(err => console.error('[obras/pintor-responder] rejeitarConcorrentes:', err.message))
      return res.json({ mensagem: 'Contraproposta aceita! Contrato enviado por e-mail.' })
    }
    if (action === 'recusar') {
      await pool.query(`UPDATE candidaturas SET status = 'recusado' WHERE id = $1`, [candidaturaId])
      if (dono.rows[0]?.push_token) {
        enviarPushNotificacao(dono.rows[0].push_token, '❌ Proposta recusada',
          `O pintor recusou sua contraproposta para "${obra.rows[0].titulo}".`,
          { tipo: 'candidatura_recusada', obra_id }).catch(() => {})
      }
      return res.json({ mensagem: 'Proposta recusada.' })
    }
    res.status(400).json({ erro: 'Ação inválida' })
  } catch (err) {
    console.error('Erro ao responder contraproposta:', err)
    res.status(500).json({ erro: 'Erro ao responder' })
  }
})

// POST /obras/:id/match — pintor confirma ida ao local
router.post('/obras/:id/match', autenticar, exigirAssinaturaAtiva, exigirPintor, async (req, res) => {
  try {
    const obra = await pool.query(`SELECT * FROM obras WHERE id = $1 AND status = 'aberta'`, [req.params.id])
    if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    // Idempotente: o aceite já casa o pintor (POST .../responder), então o app que ainda
    // chama /match reencontra o PRÓPRIO match. Devolve 200 sem reescrever match_feito_em
    // (não reinicia a contagem) e sem reenviar o contrato. 409 fica só para match de outro.
    if (obra.rows[0].match_usuario_id) {
      if (obra.rows[0].match_usuario_id === req.usuario.id) {
        return res.json({
          mensagem: 'Match confirmado! Contagem regressiva iniciada.',
          match_feito_em: obra.rows[0].match_feito_em
        })
      }
      return res.status(409).json({ erro: 'Esta obra já tem um pintor a caminho' })
    }
    const candidaturaAceita = await pool.query(
      `SELECT id FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2 AND status = 'aceito'`,
      [req.params.id, req.usuario.id]
    )
    if (candidaturaAceita.rows.length === 0) return res.status(403).json({ erro: 'Sua candidatura ainda não foi aceita para esta obra.' })
    await pool.query(
      `UPDATE obras SET match_feito_em = NOW(), match_usuario_id = $1 WHERE id = $2`,
      [req.usuario.id, req.params.id]
    )
    const dono = await pool.query(
      `SELECT u.push_token FROM obras o JOIN usuarios u ON o.criado_por = u.id WHERE o.id = $1`,
      [req.params.id]
    )
    // Responde imediatamente; push e contrato rodam em segundo plano (não bloquear o cliente)
    res.json({ mensagem: 'Match confirmado! Contagem regressiva iniciada.', match_feito_em: new Date() })
    if (dono.rows[0]?.push_token) {
      enviarPushNotificacao(dono.rows[0].push_token, '🚀 Pintor a caminho!',
        `Um pintor confirmou que está indo até você para "${obra.rows[0].titulo}"`,
        { tipo: 'match_obra', obra_id: req.params.id }).catch(err => console.error('[obras/match] push falhou:', err.message))
    }
    enviarContratoObra(candidaturaAceita.rows[0].id).catch(err => console.error('Erro ao enviar contrato obra:', err))
    // Recusa os demais candidatos e os notifica — pós-resposta, não bloqueia o cliente
    // (Finding 3.1). Mantido aqui para linhas legadas: obras casadas por /match antes de o
    // aceite passar a criar o match. Os caminhos de aceite chamam a mesma função.
    await rejeitarConcorrentes('obra', req.params.id, req.usuario.id)
  } catch (err) {
    console.error('[obras/match]', err.message)
    res.status(500).json({ erro: 'Erro ao confirmar match' })
  }
})

// POST /obras/:id/encerrar — encerramento ASSIMÉTRICO: o DONO encerra na hora (foi quem
// recebeu e pagou o serviço, e a palavra dele encerra); o PINTOR apenas registra a
// solicitação, e o dono fecha de fato numa 2ª chamada. Admin e obra sem pintor casado também
// fecham na hora (não há contraparte para confirmar). Cron fecha sozinho vencido o prazo da
// tabela: 2 dias numa obra, 3 horas num reparo (AUTO_ENCERRAR_APOS_* em alertaService).
router.post('/obras/:id/encerrar', autenticar, async (req, res) => {
  try {
    const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
    if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    const o = obra.rows[0]
    const ehDono = o.criado_por === req.usuario.id
    const ehPintor = o.match_usuario_id === req.usuario.id
    const ehAdmin = req.usuario.role === 'admin'
    if (!ehDono && !ehPintor && !ehAdmin) return res.status(403).json({ erro: 'Sem permissão para encerrar esta obra' })

    // Já encerrada → no-op idempotente. Sem isto o UPDATE reescreveria encerrado_em e
    // empurraria para frente a exclusão de mídias de 7 dias (server.js:deletarMidiasAntigas).
    if (o.status === 'encerrada') {
      return res.json({ mensagem: 'Obra já encerrada.', encerramento: 'concluido' })
    }

    // Mesmo pré-requisito de chegada de POST /reparos/:id/encerrar — ver o comentário longo lá.
    // Sem NENHUMA declaração, bloqueia; declarada e não confirmada segue passando; sem match e
    // admin ficam de fora.
    if (!ehAdmin && o.match_usuario_id && !o.chegada_declarada_em) {
      return res.status(409).json({ erro: 'Antes de encerrar a obra, confirme se o profissional chegou ao local.' })
    }

    // Fecha na hora quando não há confirmação a pedir: o DONO (a palavra dele encerra — e
    // pendurá-lo numa confirmação alheia lhe custava o modal de avaliação, que só destrava
    // no fechamento de fato, quando ele já não está no app), o admin agindo por fora das
    // partes, ou obra que nunca teve pintor casado. Só o pintor passa pela solicitação.
    // A barreira de chegada acima já rodou para todos: quando o dono chega aqui com pintor
    // casado, ele mesmo já confirmou que o profissional esteve no local.
    const semContraparte = !o.match_usuario_id
    if (!ehAdmin && !ehDono && !semContraparte) {
      // 1ª chamada do pintor: registra a solicitação e avisa o dono. Não fecha.
      if (!o.encerramento_solicitado_por) {
        await pool.query(
          `UPDATE obras SET encerramento_solicitado_por = $1, encerramento_solicitado_em = NOW() WHERE id = $2`,
          [req.usuario.id, req.params.id]
        )
        const outroId = ehDono ? o.match_usuario_id : o.criado_por
        const outro = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [outroId])
        if (outro.rows[0]?.push_token) {
          enviarPushNotificacao(outro.rows[0].push_token, '🔔 Encerramento solicitado',
            `A outra parte pediu para encerrar a obra "${o.titulo}". Confirme no app.`,
            { tipo: 'encerramento_solicitado', obra_id: req.params.id }).catch(() => {})
        }
        return res.json({ mensagem: 'Encerramento solicitado. Aguardando confirmação da outra parte.', encerramento: 'pendente' })
      }
      // Pintor chamando de novo: segue pendente. Não fecha (só o dono fecha) e não reenvia push.
      if (o.encerramento_solicitado_por === req.usuario.id) {
        return res.json({ mensagem: 'Encerramento já solicitado. Aguardando a outra parte.', encerramento: 'pendente' })
      }
      // Dono confirmando → cai no fechamento abaixo.
    }

    await pool.query(
      `UPDATE obras SET status = 'encerrada', status_aprovacao = 'encerrada', encerrado_em = NOW(),
                       encerramento_solicitado_por = NULL, encerramento_solicitado_em = NULL
       WHERE id = $1`,
      [req.params.id]
    )
    // Pushes fire-and-forget: o UPDATE acima já commitou, então uma falha de push não pode
    // virar 500 para um encerramento que aconteceu.
    if (ehDono && o.match_usuario_id) {
      const pintor = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.match_usuario_id])
      if (pintor.rows[0]?.push_token) {
        enviarPushNotificacao(pintor.rows[0].push_token, '✅ Obra encerrada!',
          `O solicitante encerrou a obra "${o.titulo}".`, { tipo: 'obra_encerrada', obra_id: req.params.id }).catch(() => {})
      }
    } else if (ehPintor) {
      const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.criado_por])
      if (dono.rows[0]?.push_token) {
        enviarPushNotificacao(dono.rows[0].push_token, '✅ Serviço concluído!',
          `O pintor concluiu a obra "${o.titulo}".`, { tipo: 'obra_encerrada', obra_id: req.params.id }).catch(() => {})
      }
    }
    res.json({ mensagem: 'Obra encerrada com sucesso!', encerramento: 'concluido' })
  } catch (err) {
    console.error('[obras/encerrar]', err.message)
    res.status(500).json({ erro: 'Erro ao encerrar obra' })
  }
})

// POST /obras/:id/expirar-match — chamado quando o cronômetro expira
router.post('/obras/:id/expirar-match', autenticar, async (req, res) => {
  try {
    const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
    if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    const o = obra.rows[0]
    const ehDono = o.criado_por === req.usuario.id
    const ehPintor = o.match_usuario_id === req.usuario.id
    const ehAdmin = req.usuario.role === 'admin'
    if (!ehDono && !ehPintor && !ehAdmin) return res.status(403).json({ erro: 'Sem permissão' })
    // Chegada declarada/confirmada congela a expiração do match (mesma regra do cron): o pintor
    // está no local, expirar aqui devolveria ao feed uma obra em atendimento.
    //
    // EXCEÇÃO — o dono contesta uma chegada que NÃO foi ele quem declarou. Sem ela, uma chegada
    // declarada pelo pintor trancava a obra: o dono via "pintor presente" sem ter visto ninguém e
    // não tinha saída. Vale SÓ para o dono (pintor e admin seguem barrados em todos os casos), e
    // só enquanto a declaração é de outro e a obra não encerrou.
    // chegada_declarada_por NULL conta como "não é o dono" (!== já dá isso), liberando a
    // contestação em linha inconsistente em vez de trancá-la.
    const donoContesta = ehDono
      && o.chegada_declarada_por !== req.usuario.id
      && o.status !== 'encerrada'
    if ((o.chegada_declarada_em || o.chegada_confirmada_em) && !donoContesta) {
      return res.status(409).json({ erro: 'Chegada já declarada — o match não pode mais expirar' })
    }
    const pintorId = o.match_usuario_id
    // chegada_* zeradas junto com o match: a obra volta ao feed limpa. Sem isso, a previsão do
    // pintor ANTERIOR sobreviveria — o write-once de /chegada-prevista travaria o próximo, e o
    // cron leria uma chegada_prevista_em já vencida, expirando o novo match em ~1 minuto.
    // prestadores_bloqueados: o pintor que furou não volta a ver ESTA obra no feed. O CASE é
    // NULL-safe (match já desfeito → $2 NULL → array_append gravaria um NULL no array) e
    // idempotente (rechamada não duplica o mesmo uuid).
    const upd = await pool.query(
      `WITH desfeito AS (
         UPDATE obras SET match_feito_em = NULL, match_usuario_id = NULL, pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL,
                chegada_janela = NULL, chegada_prevista_em = NULL, chegada_declarada_por = NULL, chegada_declarada_em = NULL,
                chegada_pendente_janela = NULL, chegada_pendente_em = NULL, chegada_recusada_em = NULL,
                chegada_confirmada_em = NULL,
                prestadores_bloqueados = CASE
                  -- Isenção igual à do cron: janela oferecida que nunca virou compromisso —
                  -- recusada pelo dono OU pendente sem resposta — e nenhuma outra valendo. As
                  -- expressões do SET leem a linha ANTIGA, então estas três colunas ainda têm o
                  -- valor de antes, apesar de irem a NULL acima.
                  WHEN chegada_prevista_em IS NULL
                       AND (chegada_recusada_em IS NOT NULL OR chegada_pendente_em IS NOT NULL)
                  THEN prestadores_bloqueados
                  WHEN $2::uuid IS NULL OR $2::uuid = ANY(COALESCE(prestadores_bloqueados, '{}'))
                  THEN prestadores_bloqueados
                  ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid) END
          WHERE id = $1
            AND (
              (chegada_declarada_em IS NULL AND chegada_confirmada_em IS NULL)
              -- Espelha o donoContesta do JS relendo a linha VIVA: $3 é ehDono, e as outras duas
              -- condições são reavaliadas aqui. Se a obra encerrar ou o próprio dono declarar a
              -- chegada entre o SELECT e este UPDATE, o bypass morre e volta o 409 de sempre.
              OR ($3::boolean
                  AND chegada_declarada_por IS DISTINCT FROM criado_por
                  AND status IS DISTINCT FROM 'encerrada')
            )
          RETURNING id
       ), proposta AS (
         -- A candidatura vencedora morre JUNTO com o match, no mesmo statement. Sem isto ela
         -- continuava 'aceito' e ocupando candidaturas_aceito_unica_idx: a obra voltava ao feed
         -- mas nenhum aceite novo passava (guard jaAceito → 409, e o índice único barraria).
         -- Depende do CTE desfeito: se o UPDATE acima não pegou a linha (chegada declarada na
         -- corrida), o IN não casa nada e a candidatura fica intacta.
         UPDATE candidaturas SET status = 'expirado'
          WHERE obra_id IN (SELECT id FROM desfeito) AND usuario_id = $2::uuid AND status = 'aceito'
          RETURNING id
       )
       SELECT id FROM desfeito`,
      [req.params.id, pintorId, ehDono]
    )
    // rowCount = 0 (o SELECT final não devolveu linha) → a chegada foi declarada entre o SELECT e o UPDATE. Nada mudou no banco;
    // responder sucesso aqui avisaria os dois lados de uma expiração que não aconteceu, e o
    // pintor receberia "perdeu a obra" seguindo com o match na mão. Mesmo 409 do guard acima.
    if (upd.rowCount === 0) {
      return res.status(409).json({ erro: 'Chegada já declarada — o match não pode mais expirar' })
    }
    const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.criado_por])
    // Os dois lados são avisados: o dono porque a obra voltou ao feed, o pintor porque perdeu
    // o match E o acesso a esta obra. Antes só o dono sabia.
    const pintor = pintorId
      ? await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [pintorId])
      : { rows: [] }
    res.json({ mensagem: 'Match expirado, obra disponível novamente' })
    if (dono.rows[0]?.push_token) {
      enviarPushNotificacao(dono.rows[0].push_token, '⏰ Prazo expirado!',
        `O pintor não chegou a tempo para "${o.titulo}". A obra está disponível novamente.`,
        { tipo: 'match_expirado', obra_id: req.params.id }).catch(() => {})
    }
    if (pintor.rows[0]?.push_token) {
      enviarPushNotificacao(pintor.rows[0].push_token, '⏰ Prazo expirado!',
        `O prazo para chegar em "${o.titulo}" acabou. A obra voltou para o feed.`,
        { tipo: 'match_expirado', obra_id: req.params.id }).catch(() => {})
    }
    return
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao expirar match' })
  }
})

// POST /obras/:id/pedir-tempo — pintor solicita mais tempo
router.post('/obras/:id/pedir-tempo', autenticar, async (req, res) => {
  try {
    const { motivo } = req.body
    const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
    if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    const o = obra.rows[0]
    if (o.match_usuario_id !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o pintor do match pode solicitar mais tempo' })
    await pool.query(
      `UPDATE obras SET pedido_tempo_status = 'aguardando_tempo', pedido_tempo_motivo = $1, pedido_tempo_minutos = NULL WHERE id = $2`,
      [motivo, req.params.id]
    )
    const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.criado_por])
    if (dono.rows[0]?.push_token) {
      await enviarPushNotificacao(dono.rows[0].push_token, '⚠️ Pintor precisa de mais tempo!',
        `Motivo: ${motivo}. Abra o app para responder.`,
        { tipo: 'pedido_tempo', obra_id: req.params.id })
    }
    res.json({ mensagem: 'Solicitação enviada ao dono.' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao solicitar mais tempo' })
  }
})

// POST /obras/:id/perguntar-tempo — dono pergunta quantos minutos o pintor precisa
router.post('/obras/:id/perguntar-tempo', autenticar, async (req, res) => {
  try {
    const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
    if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    const o = obra.rows[0]
    if (o.criado_por !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o dono pode responder o pedido' })
    await pool.query(`UPDATE obras SET pedido_tempo_status = 'aguardando_minutos' WHERE id = $1`, [req.params.id])
    const pintor = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.match_usuario_id])
    if (pintor.rows[0]?.push_token) {
      await enviarPushNotificacao(pintor.rows[0].push_token, '⏱ Quanto tempo você precisa?',
        'O solicitante quer saber quantos minutos a mais você precisa para chegar.',
        { tipo: 'perguntar_tempo', obra_id: req.params.id })
    }
    res.json({ mensagem: 'Pintor notificado para informar o tempo.' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao perguntar tempo' })
  }
})

// POST /obras/:id/informar-tempo — pintor informa quantos minutos precisa
router.post('/obras/:id/informar-tempo', autenticar, async (req, res) => {
  try {
    const { minutos } = req.body
    if (!minutos || minutos <= 0) return res.status(400).json({ erro: 'Informe um tempo válido em minutos' })
    const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
    if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    const o = obra.rows[0]
    if (o.match_usuario_id !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o pintor do match pode informar o tempo' })
    await pool.query(
      `UPDATE obras SET pedido_tempo_status = 'aguardando_aprovacao', pedido_tempo_minutos = $1 WHERE id = $2`,
      [minutos, req.params.id]
    )
    const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.criado_por])
    if (dono.rows[0]?.push_token) {
      await enviarPushNotificacao(dono.rows[0].push_token, '⏳ Pintor precisa de mais tempo',
        `Ele precisa de ${minutos} minuto(s) a mais. Aceitar ou recusar?`,
        { tipo: 'aprovar_tempo', obra_id: req.params.id })
    }
    res.json({ mensagem: 'Dono notificado para aprovar o tempo.' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao informar tempo' })
  }
})

// POST /obras/:id/responder-tempo — dono aceita ou recusa tempo extra
router.post('/obras/:id/responder-tempo', autenticar, async (req, res) => {
  try {
    const { aceito } = req.body
    const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
    if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    const o = obra.rows[0]
    if (o.criado_por !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o dono pode responder' })
    if (aceito) {
      const novoMatchFeitoEm = new Date(new Date(o.match_feito_em).getTime() + o.pedido_tempo_minutos * 60 * 1000)
      await pool.query(
        `UPDATE obras SET match_feito_em = $1, pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL WHERE id = $2`,
        [novoMatchFeitoEm.toISOString(), req.params.id]
      )
      const pintor = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.match_usuario_id])
      if (pintor.rows[0]?.push_token) {
        await enviarPushNotificacao(pintor.rows[0].push_token, '✅ Tempo extra aceito!',
          `O solicitante aceitou. Você tem mais ${o.pedido_tempo_minutos} minuto(s). Corra!`,
          { tipo: 'tempo_aceito', obra_id: req.params.id })
      }
      res.json({ mensagem: 'Tempo extra concedido!', novo_match_feito_em: novoMatchFeitoEm })
    } else {
      const pintorId = o.match_usuario_id
      // Recusar o tempo extra desfaz o match, então é caminho de un-match como os outros: o
      // pintor entra na lista negra DESTA obra e não vê mais o card no feed. Paridade com
      // POST /reparos/:id/responder-tempo, que já bloqueava. Mesmo CASE NULL-safe/idempotente
      // dos demais un-matches (ver POST /obras/:id/expirar-match).
      // chegada_* zeradas como nos outros un-matches: a obra volta ao feed limpa.
      // chegada_confirmada_em entra na lista aqui E nos dois expirar-match — os três pontos que
      // conseguem tocar uma linha JÁ confirmada. Aqui nunca houve guard; lá o dono passou a furar
      // o 409 para contestar chegada declarada por outro, e com isso o WHERE deixou de proteger
      // a coluna (era esse o motivo de eles não precisarem dela). Deixá-la preenchida devolveria
      // ao feed uma demanda que o cron nunca mais conseguiria expirar (o job pula linhas com
      // chegada_confirmada_em) e cuja PRÓXIMA chegada já nasceria confirmada, porque o CASE de
      // POST /:id/chegada devolve o valor antigo quando a coluna não está NULL.
      // Os dois crons seguem sem precisar: o predicado deles exige chegada_confirmada_em IS NULL,
      // então a coluna nunca está preenchida nas linhas que eles pegam.
      await pool.query(
        `WITH desfeito AS (
           UPDATE obras SET match_feito_em = NULL, match_usuario_id = NULL, pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL,
                  chegada_janela = NULL, chegada_prevista_em = NULL, chegada_declarada_por = NULL, chegada_declarada_em = NULL,
                  chegada_pendente_janela = NULL, chegada_pendente_em = NULL, chegada_recusada_em = NULL,
                  chegada_confirmada_em = NULL,
                  prestadores_bloqueados = CASE
                    WHEN $2::uuid IS NULL OR $2::uuid = ANY(COALESCE(prestadores_bloqueados, '{}'))
                    THEN prestadores_bloqueados
                    ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid) END
            WHERE id = $1
            RETURNING id
         )
         -- Candidatura vencedora expira junto (ver POST /obras/:id/expirar-match): recusar o
         -- tempo extra é un-match como os outros, e sem isto a obra voltava ao feed com o
         -- índice de aceite ainda ocupado, sem poder ser fechada de novo.
         UPDATE candidaturas SET status = 'expirado'
          WHERE obra_id IN (SELECT id FROM desfeito) AND usuario_id = $2::uuid AND status = 'aceito'`,
        [req.params.id, pintorId]
      )
      const pintor = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [pintorId])
      if (pintor.rows[0]?.push_token) {
        await enviarPushNotificacao(pintor.rows[0].push_token, '❌ Tempo extra recusado',
          'O solicitante não aceitou. A obra voltou para disponível.',
          { tipo: 'tempo_recusado', obra_id: req.params.id })
      }
      res.json({ mensagem: 'Tempo recusado. Obra disponível novamente.' })
    }
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao responder pedido de tempo' })
  }
})

// ============================================================
// REPAROS
// ============================================================
router.get('/reparos/minhas', autenticar, async (req, res) => {
  try {
    const { page, limit, offset } = paginacaoAdmin(req.query)

    const result = await pool.query(
      `SELECT r.*,
        -- "Expirado" não é status no banco: é um reparo NÃO encerrado cujo expira_em já
        -- passou — vale em qualquer status vivo. Calculado no SQL (relógio do servidor)
        -- para o cliente não precisar comparar expira_em com o relógio do aparelho.
        (r.status <> 'encerrada' AND r.expira_em <= NOW()) AS expirada,
        (SELECT COUNT(*) FROM interesse_reparos WHERE reparo_id = r.id) as total_interessados,
        -- Conta 'pendente' E 'contraproposta_dono': um reparo em negociação (contraproposta
        -- enviada, aguardando o prestador) continua tendo interessado, e antes aparecia como zero.
        (SELECT COUNT(*) FROM interesse_reparos WHERE reparo_id = r.id AND status IN ('pendente', 'contraproposta_dono')) as interesses_pendentes,
        -- Interesse pendente mais recente: deixa o app chavear o modal de nova proposta
        -- por interesse, não por reparo. Ordena por criado_em (id é UUID aleatório, então
        -- MAX(id) não é "o mais novo"); id DESC só desempata criado_em idêntico. NULL se
        -- não houver nenhum pendente.
        (SELECT ir.id FROM interesse_reparos ir
          WHERE ir.reparo_id = r.id AND ir.status = 'pendente'
          ORDER BY ir.criado_em DESC, ir.id DESC
          LIMIT 1) as interesse_pendente_recente_id,
        (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) as foto_capa,
        (SELECT COALESCE(ir.valor_contraproposta, ir.valor_proposto)
           FROM interesse_reparos ir
          WHERE ir.reparo_id = r.id AND ir.usuario_id = r.match_usuario_id
          LIMIT 1) as valor_acordado
       FROM reparos r WHERE r.criado_por = $1 AND r.status != 'cancelada' ORDER BY r.criado_em DESC
       LIMIT $2 OFFSET $3`,
      [req.usuario.id, limit, offset]
    )
    const agora = new Date()
    const eArquivado = r => r.status === 'encerrada' || (r.expira_em && new Date(r.expira_em) < agora)
    const reparos   = result.rows.filter(r => !eArquivado(r))
    const historico = result.rows.filter(r =>  eArquivado(r))
    res.json({ reparos, historico, page, limit })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar serviços' })
  }
})

router.post('/reparos/dono', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'dono_obra' && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Apenas donos podem cadastrar serviços' })
    }
    const { titulo, categoria, descricao, valor_estimado, cidade, bairro, uf, tags, prazo_atendimento_horas, endereco_obra, ponto_referencia, latitude, longitude, client_request_id } = req.body
    // Mesmo teto do POST /obras/dono e sobre a MESMA contagem (obras + reparos): o limite é por
    // dono, não por tipo de demanda, senão 2 obras + 2 reparos passariam.
    const limiteReparos = await limiteDemandasAtingido('reparos', req.usuario.id, client_request_id)
    if (limiteReparos.atingido) {
      return res.status(409).json(erroLimiteDemandas(limiteReparos.limite))
    }
    const ufFinal = uf || await ufDeCidade(cidade)  // rede de segurança: deriva uf da cidade
    const { lat: latFinal, lng: lngFinal, origem: coordOrigem } = resolverCoordenadas(cidade, ufFinal, latitude, longitude, '[reparos/dono]')
    // Janela original resolvida UMA vez: mesma base do expira_em e do prazo_atendimento_horas
    // gravado, sem risco de os dois divergirem (mesmo padrão de POST /obras/dono). Antes a
    // coluna recebia NULL quando o cliente não mandava prazo, enquanto o expira_em ia a 720h —
    // a demanda ficava sem faixa e o job de marcos a pulava, sem alerta nenhum de expiração.
    const horasExpiracao = prazo_atendimento_horas || 720
    const expira_em = new Date(Date.now() + horasExpiracao * 3600 * 1000)
    // Faixa "Hoje" — mesma regra e mesmo CASE do POST /obras/dono (ver lá o racional completo):
    // só o ramo 'hoje' muda, resolvido no Postgres; as demais faixas gravam o $10 do Node.
    const prazoModo = req.body?.prazo_modo === PRAZO_MODO_HOJE ? PRAZO_MODO_HOJE : null
    // ON CONFLICT no índice parcial (criado_por, client_request_id): retries com a mesma chave
    // retornam o reparo já criado em vez de inserir duplicata. Sem chave (NULL) → insert normal.
    const result = await pool.query(
      `INSERT INTO reparos (criado_por, titulo, categoria, descricao, valor_estimado, cidade, bairro, uf, tags, status, status_aprovacao, expira_em, prazo_atendimento_horas, endereco_reparo, ponto_referencia, latitude, longitude, coordenadas_origem, client_request_id, prazo_modo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'aberta','aprovada',
               CASE WHEN $18::text = '${PRAZO_MODO_HOJE}' THEN ${SQL_FIM_DO_DIA_SP} ELSE $10::timestamptz END,
               $11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (criado_por, client_request_id) WHERE client_request_id IS NOT NULL
       DO UPDATE SET client_request_id = EXCLUDED.client_request_id
       RETURNING *`,
      [req.usuario.id, titulo, categoria, descricao, valor_estimado, cidade, bairro, ufFinal, tags || [], expira_em.toISOString(), horasExpiracao, endereco_obra, ponto_referencia, latFinal, lngFinal, coordOrigem, client_request_id || null, prazoModo]
    )
    res.status(201).json(result.rows[0])
    // ESTE e o unico envio que dispara no fluxo real, e por isso ele FICA. O INSERT acima
    // grava status_aprovacao='aprovada' direto: reparo nasce publicado, nao passa por fila de
    // aprovacao (as 16 linhas em producao estao todas em 'aprovada'/'encerrada', nenhuma
    // 'pendente'). Ou seja, a transicao para aprovada acontece AQUI, na criacao — e o envio
    // daqui e justamente "um envio, na transicao de aprovacao" que obras faz no endpoint de
    // aprovacao. Remove-lo deixaria o reparo sem nenhum aviso, porque
    // POST /reparos/aprovacao/:id/aprovar nunca chega a rodar para uma linha ja aprovada
    // (e agora, com a guarda de transicao la, nem notificaria).
    notificarPrestadoresSobreNovoReparo(result.rows[0].id).catch(err => console.error('Erro notificar prestadores:', err))
  } catch (err) {
    console.error('[reparos/dono]', err.message)
    res.status(500).json({ erro: 'Erro ao cadastrar serviço' })
  }
})

router.delete('/reparos/dono/:id', autenticar, async (req, res) => {
  try {
    const reparo = await pool.query(
      `SELECT id, match_usuario_id FROM reparos WHERE id = $1 AND criado_por = $2`,
      [req.params.id, req.usuario.id]
    )
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
    if (reparo.rows[0].match_usuario_id) return res.status(409).json({ erro: 'Não é possível excluir um serviço com prestador a caminho' })
    // CANCELA em vez de apagar, alinhando com DELETE /obras/dono/:id. Apagar a linha custava
    // duas coisas:
    //   - a mídia saía do banco antes de o cron poder limpá-la, então o arquivo ficava no
    //     Cloudinary sem nada apontando para ele (o ledger de órfãs cobre o caso, mas aqui
    //     não há motivo para apagar: basta deixar a linha e o cron recolhe no prazo);
    //   - apagava os interesse_reparos junto, deixando contratos (contratos.interesse_id não
    //     tem FK) e avaliações (contrato_id polimórfico) apontando para o vazio.
    // Com o cancelamento a linha permanece: deletarMidiasAntigas recolhe a mídia aos 7 dias
    // pelo braço 'cancelada', e contratos/avaliações continuam com referente.
    // encerrado_em é o relógio desses 7 dias; COALESCE não reinicia contagem já iniciada.
    await pool.query(
      `UPDATE reparos SET status = 'cancelada', status_aprovacao = 'cancelada',
              encerrado_em = COALESCE(encerrado_em, NOW())
        WHERE id = $1`,
      [req.params.id]
    )
    res.json({ mensagem: 'Serviço cancelado com sucesso' })
  } catch (err) {
    console.error('Erro ao cancelar reparo:', err)
    res.status(500).json({ erro: 'Erro ao cancelar serviço' })
  }
})

// PATCH /reparos/dono/:id/ponto-referencia — espelho exato do lado obra: mesma validação
// (normalizarPontoReferencia), mesma posse dentro do UPDATE, mesmo 404 em rowCount 0, e
// segue liberado depois do match pelo mesmo motivo (o contrato de reparo também renderiza
// endereco_obra, nunca ponto_referencia).
router.patch('/reparos/dono/:id/ponto-referencia', autenticar, async (req, res) => {
  try {
    const { ponto_referencia } = req.body
    const { erro, valor } = normalizarPontoReferencia(ponto_referencia)
    if (erro) return res.status(400).json({ erro })

    const upd = await pool.query(
      `UPDATE reparos SET ponto_referencia = $2 WHERE id = $1 AND criado_por = $3
       RETURNING ponto_referencia`,
      [req.params.id, valor, req.usuario.id]
    )
    if (upd.rowCount === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
    res.json({ ponto_referencia: upd.rows[0].ponto_referencia })
  } catch (err) {
    console.error('[reparos/ponto-referencia]', err.message)
    res.status(500).json({ erro: 'Erro ao atualizar ponto de referência' })
  }
})

// Carência para estender reparo de faixa longa. "Esta semana" é a faixa > 24h; prazo NULL
// entra junto porque é a janela mais longa que existe (o expira_em da criação usa o default
// de 720h) e o app sequer rotula esses reparos. Faixas curtas (<= 24h) seguem sem carência:
// quem marcou "1 hora" precisa poder corrigir na hora.
const CARENCIA_ESTENDER_REPARO_HORAS = 1
const FAIXA_LONGA_REPARO_HORAS = 24

// Teto de extensão do reparo — o de 2x saiu e por um tempo isto foi só advisory; hoje o
// endpoint TAMBÉM o enforça (400 quando horas > este valor), espelhando TETO_ESTENDER_OBRA_HORAS.
// Segue na resposta porque o app filtra as opções por ele (ModalEstenderPrazo). Valor generoso
// = "não gateia o menu": a maior opção do app é 168h, então isto só barra valor absurdo
// (ex.: um dígito a mais por engano). O nome ADVISORY_ ficou do período em que não era enforçado.
const ADVISORY_ESTENDER_REPARO_HORAS = 8760

// Janela de dedupe do estender. Sem client_request_id no corpo, a chave é (ultima_extensao_em,
// ultima_extensao_horas): repetir o MESMO horas dentro da janela é tratado como retry do mesmo
// clique — devolve o prazo atual sem somar de novo. Fora da janela, ou com horas diferente, é
// uma extensão nova e legítima (o dono pode estender duas vezes seguidas de propósito).
const DEDUPE_ESTENDER_REPARO_MINUTOS = 5

// POST /reparos/:id/estender — âncora criado_em SEM COALESCE: o reparo publica na criação,
// então criado_em é o instante de publicação e nunca é NULL (obra precisa de
// COALESCE(publicado_em, criado_em); reparo não). É essa mesma âncora que a carência usa.
// Re-arma TODOS os marcos de expiração (marco_6h/60/30/15_em = NULL), igual à obra: expira_em
// avança, então os 4 alertas re-disparam contra o novo prazo. (Substitui o clear de
// alerta_sem_interessados_em, cujo job foi aposentado.)
router.post('/reparos/:id/estender', autenticar, async (req, res) => {
  try {
    const reparo = await pool.query(
      `SELECT id, criado_por, status, match_usuario_id, expira_em, criado_em, prazo_atendimento_horas
       FROM reparos WHERE id = $1 AND criado_por = $2`,
      [req.params.id, req.usuario.id]
    )
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
    const r = reparo.rows[0]
    if (r.status !== 'aberta') return res.status(409).json({ erro: 'Só é possível estender um serviço aberto' })
    if (r.match_usuario_id) return res.status(409).json({ erro: 'Não é possível estender um serviço com prestador a caminho' })

    const horas = Number(req.body?.horas)
    if (!Number.isFinite(horas) || horas < 1) return res.status(400).json({ erro: 'horas inválido: informe um número >= 1' })
    // Teto plano, espelhando POST /obras/:id/estender: mesma posição (antes da query de
    // carência e do UPDATE), mesmo `>` estrito (8760 exato passa), mesmo 400 e o mesmo
    // extensao_maxima_horas no corpo do erro, p/ o cliente aprender o limite pela recusa.
    // Validação POR REQUISIÇÃO, sem somar extensões anteriores — igual à obra.
    if (horas > ADVISORY_ESTENDER_REPARO_HORAS) {
      return res.status(400).json({ erro: `horas inválido: máximo de ${ADVISORY_ESTENDER_REPARO_HORAS} (365 dias)`, extensao_maxima_horas: ADVISORY_ESTENDER_REPARO_HORAS })
    }

    // Carência e novo prazo na MESMA query: as duas comparações precisam do relógio do banco
    // (NOW()), não do relógio do processo, senão skew de container decide quem pode estender.
    const cap = await pool.query(
      `SELECT
         GREATEST($1::timestamptz, NOW()) + ($2::numeric * INTERVAL '1 hour') AS novo_expira_em,
         (NOW() >= $3::timestamptz + ($4::numeric * INTERVAL '1 hour')) AS carencia_cumprida`,
      [r.expira_em, horas, r.criado_em, CARENCIA_ESTENDER_REPARO_HORAS]
    )

    // Faixa longa (> 24h) e prazo NULL: só estende 1h após o cadastro. NULL entra via o
    // `=== null` explícito — Number(null) é 0, que passaria batido pela comparação numérica.
    const prazoReparo = r.prazo_atendimento_horas === null ? null : Number(r.prazo_atendimento_horas)
    const exigeCarencia = prazoReparo === null || prazoReparo > FAIXA_LONGA_REPARO_HORAS
    if (exigeCarencia && !cap.rows[0].carencia_cumprida) {
      return res.status(409).json({ erro: 'Aguarde 1 hora após o cadastro para estender' })
    }

    // Guarda de dedupe DENTRO do UPDATE, não em um if antes dele: checar em uma query e gravar em
    // outra deixa a janela aberta para dois cliques simultâneos passarem os dois pela checagem e
    // somarem duas vezes. Aqui o próprio UPDATE decide — quem perder a corrida não casa mais com o
    // predicado e volta rowCount = 0. COALESCE(..., FALSE) porque linha nunca estendida tem as duas
    // colunas NULL: sem ele a comparação vira NULL, o NOT propaga NULL e o UPDATE não aplicaria a
    // PRIMEIRA extensão. Fail-open é o lado certo: na dúvida, estende.
    const upd = await pool.query(
      `UPDATE reparos SET expira_em = $1,
         marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL,
         ultima_extensao_em = NOW(), ultima_extensao_horas = $5::numeric
       WHERE id = $2 AND criado_por = $3
         AND NOT COALESCE(
               ultima_extensao_em > NOW() - ($4::numeric * INTERVAL '1 minute')
               AND ultima_extensao_horas = $5::numeric, FALSE)
       RETURNING expira_em`,
      [cap.rows[0].novo_expira_em, req.params.id, req.usuario.id, DEDUPE_ESTENDER_REPARO_MINUTOS, horas]
    )

    // rowCount = 0 → o predicado de dedupe barrou (retry do mesmo horas na janela). Não é erro: o
    // cliente pediu um estado que o servidor já tem, então devolve o prazo ATUAL como sucesso, com
    // o mesmo shape do caminho normal. O re-SELECT também cobre a linha ter sumido entre o SELECT
    // inicial e o UPDATE (delete concorrente) — aí sim é 404.
    if (upd.rowCount === 0) {
      const atual = await pool.query(
        `SELECT expira_em FROM reparos WHERE id = $1 AND criado_por = $2`,
        [req.params.id, req.usuario.id]
      )
      if (atual.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
      return res.json({ expira_em: atual.rows[0].expira_em, extensao_maxima_horas: ADVISORY_ESTENDER_REPARO_HORAS })
    }

    res.json({ expira_em: upd.rows[0].expira_em, extensao_maxima_horas: ADVISORY_ESTENDER_REPARO_HORAS })
  } catch (err) {
    console.error('[reparos/estender]', err.message)
    res.status(500).json({ erro: 'Erro ao estender prazo do serviço' })
  }
})

router.get('/reparos/aprovacao', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { page, limit, offset } = paginacaoAdmin(req.query)

    const result = await pool.query(
      `SELECT r.*, u.nome as dono_nome, u.email as dono_email, u.telefone as dono_telefone
       FROM reparos r JOIN usuarios u ON r.criado_por = u.id
       WHERE r.status_aprovacao = 'pendente' ORDER BY r.criado_em DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    res.json({ reparos: result.rows, page, limit })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar reparos' })
  }
})

router.post('/reparos/aprovacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    // Guarda de TRANSICAO, igual a de obras (ver POST /obras-aprovacao/:id/aprovar): o aviso
    // so sai quando a linha REALMENTE saiu de pendente/recusada para aprovada. rowCount 0
    // significa que o UPDATE nao mudou nada — reaprovar um reparo ja aprovado anunciaria
    // como "novo" um item publicado dias atras, para ate 500 pessoas de uma vez. Sem esta
    // clausula WHERE o UPDATE casava a linha toda vez e o rebroadcast era so uma questao de
    // alguem clicar duas vezes.
    const atualizado = await pool.query(
      `UPDATE reparos SET status_aprovacao = 'aprovada', status = 'aberta'
        WHERE id = $1 AND status_aprovacao IS DISTINCT FROM 'aprovada'`,
      [req.params.id]
    )
    res.json({ mensagem: 'Reparo aprovado e publicado!' })
    if (atualizado.rowCount === 0) return
    notificarPrestadoresSobreNovoReparo(req.params.id).catch(err => console.error('Erro notificar prestadores:', err))
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar reparo' })
  }
})

router.post('/reparos/aprovacao/:id/recusar', autenticar, exigirAdmin, async (req, res) => {
  try {
    // encerrado_em: idem ao lado obra — reparo recusado guarda mídia e sem esta coluna o
    // deletarMidiasAntigas nunca o alcança.
    await pool.query(`UPDATE reparos SET status_aprovacao = 'recusada', status = 'cancelada',
      encerrado_em = COALESCE(encerrado_em, NOW()) WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Reparo recusado' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao recusar reparo' })
  }
})

router.get('/reparos/admin', autenticar, exigirAdmin, async (req, res) => {
  try {
    const filtro = req.query.filtro || 'finalizadas'
    let where
    if (filtro === 'finalizadas') {
      where = `r.status = 'encerrada'`
    } else if (filtro === 'canceladas') {
      where = `(r.status IN ('cancelada', 'expirada') OR (r.status = 'aberta' AND r.expira_em <= NOW()))`
    } else if (filtro === 'abertas') {
      where = `r.status = 'aberta' AND r.status_aprovacao = 'aprovada' AND r.expira_em > NOW()`
    } else {
      return res.status(400).json({ erro: 'Filtro inválido' })
    }
    const result = await pool.query(`
      SELECT r.id, r.titulo, r.categoria, r.valor_estimado, r.cidade, r.uf, r.bairro,
             r.expira_em, r.status,
             (r.status = 'aberta' AND r.expira_em <= NOW()) AS expirada,
             (SELECT COUNT(*) FROM interesse_reparos WHERE reparo_id = r.id) AS total_interessados
      FROM reparos r
      WHERE ${where}
      ORDER BY r.expira_em DESC NULLS LAST, r.id DESC
      LIMIT 200
    `)
    res.json({ reparos: result.rows })
  } catch (err) {
    console.error('Erro ao listar reparos (admin):', err)
    res.status(500).json({ erro: 'Erro ao buscar reparos' })
  }
})

router.get('/reparos/meus-interesses', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'prestador') return res.status(403).json({ erro: 'Acesso restrito a prestadores' })
    const result = await pool.query(`
      SELECT ir.id, ir.status, ir.valor_proposto, ir.valor_contraproposta, ir.rodada, ir.criado_em,
             r.id as reparo_id, r.titulo, r.categoria, r.descricao, r.valor_estimado,
             r.cidade, r.bairro, r.latitude, r.longitude, r.expira_em, r.status as reparo_status, r.prazo_atendimento_horas,
             r.match_usuario_id, r.match_feito_em,
             -- Encerramento assimétrico: só o PRESTADOR cria solicitação pendente. O dono não
             -- solicita — ele encerra na hora, e é ele quem confirma a solicitação do prestador.
             -- Para o lado do prestador: _por = próprio usuário → ele pediu e aguarda o dono
             -- fechar; NULL = nenhuma solicitação em aberto. _por nunca é o dono daqui em
             -- diante (linhas antigas do desenho simétrico podem ter, e fecham na 1ª chamada).
             r.encerramento_solicitado_por, r.encerramento_solicitado_em,
             -- Chegada: o prestador precisa ver a janela que ele mesmo prometeu e se o dono já
             -- confirmou a chegada (declarada por ele + confirmada = atendimento em curso).
             r.chegada_janela, r.chegada_prevista_em, r.chegada_declarada_por,
             r.chegada_declarada_em, r.chegada_confirmada_em,
             -- Janela pendente de resposta do dono e marca de recusa (ver o mesmo bloco em
             -- GET /candidaturas/minhas): sem elas o prestador não enxerga a proposta que fez.
             r.chegada_pendente_janela, r.chegada_pendente_em, r.chegada_recusada_em,
             -- "Expirado" não é status no banco: é um reparo NÃO encerrado cujo expira_em já
             -- passou. Mesma expressão de GET /reparos/minhas e GET /reparos/:id, calculada no
             -- SQL (relógio do servidor) para o app não depender do relógio do aparelho.
             (r.status <> 'encerrada' AND r.expira_em <= NOW()) AS reparo_expirada,
             (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) as foto_capa
      FROM interesse_reparos ir
      JOIN reparos r ON ir.reparo_id = r.id
      WHERE ir.usuario_id = $1
      ORDER BY ir.criado_em DESC
    `, [req.usuario.id])
    const agora = new Date()
    // Arquiva por dois motivos independentes. O primeiro é o interesse em si: quem foi
    // recusado (inclusive em massa por rejeitarConcorrentes, quando o dono fecha match
    // com outro) não tem mais nada a fazer ali, e antes seguia vendo o reparo em ativos
    // até o dono encerrar. O segundo é o reparo estar fora de jogo — 'cancelada' e
    // 'expirada' contam junto com 'encerrada'; sem elas um reparo vencido voltava para
    // ativos assim que o status saía de 'aberta'. A checagem por data continua valendo
    // só enquanto o status ainda é 'aberta', para o vencimento que ninguém processou.
    const INTERESSE_MORTO = ['recusado', 'expirado']
    const REPARO_MORTO    = ['encerrada', 'cancelada', 'expirada']
    const eArquivado = item =>
      INTERESSE_MORTO.includes(item.status) ||
      REPARO_MORTO.includes(item.reparo_status) ||
      (item.reparo_status === 'aberta' && item.expira_em && new Date(item.expira_em) < agora)
    const ativos    = result.rows.filter(item => !eArquivado(item))
    const historico = result.rows.filter(item =>  eArquivado(item))
    res.json({ ativos, historico })
  } catch (err) {
    console.error('[meus-interesses]', err.message)
    res.status(500).json({ erro: 'Erro ao buscar seus interesses' })
  }
})

// GET /reparos/meus-contratos — reparos finalizados (encerrados) em que o usuário foi o prestador do match
router.get('/reparos/meus-contratos', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'prestador') return res.status(403).json({ erro: 'Acesso restrito a prestadores' })
    const result = await pool.query(
      `SELECT r.id, r.titulo, r.categoria, r.descricao, r.valor_estimado, r.cidade, r.bairro, r.uf,
              r.match_feito_em, r.status,
              u.id AS dono_id, u.nome AS dono_nome, u.telefone AS dono_telefone,
              (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) AS foto_capa,
              COALESCE(ir.valor_contraproposta, ir.valor_proposto) AS valor_acordado,
              EXISTS (
                SELECT 1 FROM avaliacoes a
                WHERE a.contrato_tipo = 'reparo' AND a.contrato_id = r.id AND a.avaliador_id = $1
              ) AS ja_avaliei,
              COUNT(*) OVER()::int AS _total
       FROM reparos r
       JOIN usuarios u ON r.criado_por = u.id
       LEFT JOIN interesse_reparos ir ON ir.reparo_id = r.id AND ir.usuario_id = $1
       WHERE r.match_usuario_id = $1 AND r.status = 'encerrada'
       ORDER BY r.match_feito_em DESC NULLS LAST, r.id DESC
       LIMIT 200`,
      [req.usuario.id]
    )
    const contratos = result.rows
    const total = contratos.length > 0 ? contratos[0]._total : 0
    contratos.forEach(c => delete c._total)
    res.json({ contratos, total })
  } catch (err) {
    console.error('[reparos/meus-contratos]', err.message)
    res.status(500).json({ erro: 'Erro ao buscar contratos finalizados' })
  }
})

// GET /reparos/meus-contratos-dono — reparos finalizados (encerrados) em que o usuário foi o dono (solicitante)
// IMPORTANTE: registrar antes de GET /reparos/:id para não ser sombreado por :id='meus-contratos-dono'
router.get('/reparos/meus-contratos-dono', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.titulo, r.categoria, r.descricao, r.valor_estimado, r.cidade, r.bairro, r.uf,
              r.match_feito_em, r.status,
              u.id AS prestador_id,
              u.nome AS prestador_nome, u.telefone AS prestador_telefone,
              u.logradouro, u.numero, u.bairro,
              (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) AS foto_capa,
              COALESCE(ir.valor_contraproposta, ir.valor_proposto) AS valor_acordado,
              EXISTS (
                SELECT 1 FROM avaliacoes a
                WHERE a.contrato_tipo = 'reparo' AND a.contrato_id = r.id AND a.avaliador_id = $1
              ) AS ja_avaliei,
              COUNT(*) OVER()::int AS _total
       FROM reparos r
       LEFT JOIN usuarios u ON r.match_usuario_id = u.id
       LEFT JOIN interesse_reparos ir ON ir.reparo_id = r.id AND ir.usuario_id = r.match_usuario_id
       WHERE r.criado_por = $1 AND r.status = 'encerrada'
       ORDER BY r.match_feito_em DESC NULLS LAST, r.id DESC
       LIMIT 200`,
      [req.usuario.id]
    )
    const contratos = result.rows
    const total = contratos.length > 0 ? contratos[0]._total : 0
    contratos.forEach(c => delete c._total)
    res.json({ contratos, total })
  } catch (err) {
    console.error('[reparos/meus-contratos-dono]', err.message)
    res.status(500).json({ erro: 'Erro ao buscar contratos finalizados' })
  }
})

router.get('/reparos', autenticar, exigirNaoSuspenso, exigirPrestador, exigirReparador, async (req, res) => {
  try {
    const { page, limit, offset } = paginacaoAdmin(req.query)
    const { categoria, raio_km, lat, lng } = req.query

    // $1 reservado para o usuario_id (filtro de bloqueados)
    const params = [req.usuario.id]

    let query = `
      SELECT r.id, r.titulo, r.categoria, r.descricao, r.valor_estimado, r.cidade, r.bairro, r.uf,
             r.latitude, r.longitude, r.coordenadas_origem,
             r.status, r.status_aprovacao, r.expira_em, r.criado_em, r.criado_por,
             r.match_feito_em, r.match_usuario_id, r.pedido_tempo_status,
             r.prestadores_bloqueados, r.client_request_id,
        (SELECT COUNT(*) FROM interesse_reparos WHERE reparo_id = r.id) as total_interessados,
        (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) as foto_capa
      FROM reparos r
      WHERE r.status = 'aberta' AND r.status_aprovacao = 'aprovada' AND r.expira_em > NOW()
        AND r.match_usuario_id IS NULL
        AND NOT ($1::uuid = ANY(COALESCE(r.prestadores_bloqueados, '{}')))
        AND NOT EXISTS (
          SELECT 1 FROM prestadores_bloqueados_dono pb
          WHERE pb.dono_id = r.criado_por AND pb.prestador_id = $1
        )
        -- Reparo que este prestador já recusou não volta ao feed: o card ficava visível
        -- mas POST /reparos/:id/interesse rejeita com 409 (guarda de duplicidade), então
        -- era um card em que ele não podia mais agir. Fica na BASE do WHERE, antes de
        -- qualquer filtro dinâmico, para valer em todos os modos (cidade, raio, estado e
        -- sem recorte). Só 'recusado' — pendente/contraproposta_dono/aceito seguem iguais.
        AND NOT EXISTS (
          SELECT 1 FROM interesse_reparos ir
          WHERE ir.reparo_id = r.id AND ir.usuario_id = $1 AND ir.status = 'recusado'
        )`

    if (categoria && categoria !== 'todas') {
      params.push(categoria)
      query += ` AND r.categoria = $${params.length}`
    }

    // Modos 'cidade' e raio numérico passam pelo resolvedor compartilhado (geoBusca):
    // ele decide a ÂNCORA (centro do raio) e o ESCOPO (recorte textual) separadamente e
    // garante que nenhum caminho degrade para "país inteiro". 'estado' e 'pais' seguem
    // no fluxo original logo abaixo, inalterados.
    // Sem raio_km a busca não tem recorte (comportamento de hoje, preservado): o metadado
    // reporta 'pais' porque é o que de fato acontece — o app sempre envia raio_km.
    let filtroMeta = { modo: raio_km || null, aplicado: (!raio_km || raio_km === 'pais') ? 'pais' : raio_km, degradado: false, motivo: null }
    let escopo = null
    let ancora = null

    const modoGeo = raio_km === 'cidade' ? 'cidade'
      : (raio_km && raio_km !== 'pais' && raio_km !== 'estado' && !isNaN(parseFloat(raio_km))) ? 'raio'
      : null

    if (modoGeo) {
      const busca = await resolverBusca({
        cidade_busca: req.query.cidade_busca,
        uf_busca: req.query.uf_busca,
        lat, lng,
        usuarioId: req.usuario.id
      })
      escopo = busca.escopo
      ancora = busca.ancora
      const filtro = montarFiltroGeo({
        alias: 'r', modo: modoGeo, raio: parseFloat(raio_km), escopo, ancora, params
      })
      filtroMeta = filtro.meta
      // Nada resolvido: devolve vazio SEM consultar. Varrer o país inteiro para um usuário
      // que não sabemos localizar é exatamente o bug que este passo elimina.
      if (filtro.sql === null) {
        return res.json({ reparos: [], page, limit, filtro: filtroMeta, escopo, ancora })
      }
      query += filtro.sql
    } else if (raio_km === 'estado') {
      let uf = (req.query.uf_busca || '').trim()
      if (!uf) {
        const ufResult = await pool.query(`SELECT uf FROM usuarios WHERE id = $1`, [req.usuario.id])
        uf = ufResult.rows[0]?.uf
      }
      if (uf) {
        params.push(uf)
        query += ` AND r.uf = $${params.length}`
      }
    }

    params.push(limit)
    query += ` ORDER BY r.expira_em ASC, r.valor_estimado DESC NULLS LAST LIMIT $${params.length}`
    params.push(offset)
    query += ` OFFSET $${params.length}`

    const result = await pool.query(query, params)
    res.json({ reparos: result.rows, page, limit, filtro: filtroMeta, escopo, ancora })
  } catch (err) {
    console.error('Erro ao buscar reparos:', err)
    res.status(500).json({ erro: 'Erro ao buscar serviços' })
  }
})

router.post('/reparos/:id/interesse', autenticar, exigirNaoSuspenso, exigirPrestador, exigirReparador, async (req, res) => {
  try {
    const { mensagem, valor_proposto } = req.body
    const existente = await pool.query(`SELECT id FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id])
    if (existente.rows.length > 0) return res.status(409).json({ erro: 'Você já demonstrou interesse neste serviço' })
    const result = await pool.query(
      `INSERT INTO interesse_reparos (reparo_id, usuario_id, mensagem, valor_proposto, rodada) VALUES ($1, $2, $3, $4, 1) RETURNING *`,
      [req.params.id, req.usuario.id, mensagem, valor_proposto || null]
    )
    // Notify dono
    const donoInfo = await pool.query(
      `SELECT u.push_token, r.titulo FROM reparos r JOIN usuarios u ON r.criado_por = u.id WHERE r.id = $1`,
      [req.params.id]
    )
    if (donoInfo.rows[0]?.push_token) {
      enviarPushNotificacao(donoInfo.rows[0].push_token, '🔧 Novo interesse!',
        `Um prestador demonstrou interesse no serviço "${donoInfo.rows[0].titulo}"`,
        { tipo: 'novo_interesse', reparo_id: req.params.id }).catch(() => {})
    }
    res.status(201).json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar interesse' })
  }
})

// POST /reparos/:id/abertura — "arma" o reparador para este reparo quando ele ABRE o
// detalhe ("Ver serviço") estando a >5km do ENDEREÇO DE CADASTRO (usuarios.latitude/
// longitude, NÃO GPS ao vivo). Aqui NÃO há push nem checagem de GPS ao vivo — só grava a
// linha de armamento. O disparo do push (quando a posição AO VIVO chega a <5km de um reparo
// armado) fica no cron verificarPrestadoresProximos e no POST /feed/checar-proximidade.
router.post('/reparos/:id/abertura', autenticar, exigirPrestador, exigirReparador, async (req, res) => {
  try {
    // Mesmas condições de validade que a checagem de proximidade usa (index.js:3300-3313
    // e o cron server.js:152-161): aberta/aprovada, não expirada, sem match, com coords.
    const reparoResult = await pool.query(
      `SELECT latitude, longitude FROM reparos
       WHERE id = $1 AND status = 'aberta' AND status_aprovacao = 'aprovada'
         AND expira_em > NOW() AND match_usuario_id IS NULL
         AND latitude IS NOT NULL AND longitude IS NOT NULL`,
      [req.params.id]
    )
    // Reparo inexistente/inválido → responde OK mas NÃO arma (idempotente, sem erro ao app).
    if (reparoResult.rows.length === 0) return res.json({ armado: false })

    const reparo = reparoResult.rows[0]

    // Coords de CADASTRO do reparador (não GPS ao vivo).
    const usuarioResult = await pool.query(
      `SELECT latitude, longitude FROM usuarios WHERE id = $1`,
      [req.usuario.id]
    )
    const usuario = usuarioResult.rows[0]

    // Qualquer lado sem coords → não arma (não dá pra medir distância).
    if (!usuario || usuario.latitude == null || usuario.longitude == null) {
      return res.json({ armado: false })
    }

    // MESMA fórmula planar de 5km do código de proximidade existente
    // (index.js:3333-3335, espelhando server.js:183-185). RAIO_KM = 5.
    const RAIO_KM = 5
    const lat = parseFloat(usuario.latitude)
    const lng = parseFloat(usuario.longitude)
    const dLat = Math.abs(lat - reparo.latitude) * 111
    const dLon = Math.abs(lng - reparo.longitude) * 111 * Math.cos(lat * Math.PI / 180)
    const distanciaKm = Math.sqrt(dLat * dLat + dLon * dLon)

    // <=5km: já está perto — não arma. >5km: arma (upsert idempotente, nunca reseta notificado).
    if (distanciaKm <= RAIO_KM) return res.json({ armado: false })

    await pool.query(
      `INSERT INTO aberturas_detalhe (reparador_id, reparo_id)
       VALUES ($1, $2)
       ON CONFLICT (reparador_id, reparo_id) DO NOTHING`,
      [req.usuario.id, req.params.id]
    )
    res.json({ armado: true })
  } catch (err) {
    console.error('[AberturaDetalhe] Erro:', err.message)
    res.status(500).json({ erro: 'Erro ao registrar abertura' })
  }
})

router.post('/reparos/:id/match', autenticar, exigirPrestador, exigirReparador, async (req, res) => {
  try {
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1 AND status = 'aberta'`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
    // Idempotente: o aceite já casa o prestador (POST .../responder), então o app que ainda
    // chama /match reencontra o PRÓPRIO match. Devolve 200 sem reescrever match_feito_em
    // (não reinicia a contagem) e sem reenviar o contrato. 409 fica só para match de outro.
    if (reparo.rows[0].match_usuario_id) {
      if (reparo.rows[0].match_usuario_id === req.usuario.id) {
        return res.json({
          mensagem: 'Match confirmado! Contagem regressiva iniciada.',
          match_feito_em: reparo.rows[0].match_feito_em
        })
      }
      return res.status(409).json({ erro: 'Este serviço já tem um prestador a caminho' })
    }
    const interesseAceito = await pool.query(
      `SELECT id FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2 AND status = 'aceito'`,
      [req.params.id, req.usuario.id]
    )
    if (interesseAceito.rows.length === 0) return res.status(403).json({ erro: 'Sua proposta ainda não foi aceita para este serviço.' })
    await pool.query(
      `UPDATE reparos SET match_feito_em = NOW(), match_usuario_id = $1 WHERE id = $2`,
      [req.usuario.id, req.params.id]
    )
    const dono = await pool.query(
      `SELECT u.push_token FROM reparos r JOIN usuarios u ON r.criado_por = u.id WHERE r.id = $1`,
      [req.params.id]
    )
    // Responde imediatamente; push e contrato rodam em segundo plano (não bloquear o cliente)
    res.json({ mensagem: 'Match confirmado! Contagem regressiva iniciada.', match_feito_em: new Date() })
    if (dono.rows[0]?.push_token) {
      enviarPushNotificacao(
        dono.rows[0].push_token,
        '🚀 Profissional a caminho!',
        `Um prestador confirmou que está indo até você para "${reparo.rows[0].titulo}"`,
        { tipo: 'match_reparo', reparo_id: req.params.id }
      ).catch(err => console.error('[reparos/match] push falhou:', err.message))
    }
    // Envia contrato por e-mail para dono e prestador
    enviarContratoReparo(req.params.id).catch(err => console.error('Erro ao enviar contrato reparo:', err))
    // Recusa os demais interessados e os notifica — pós-resposta, não bloqueia o cliente
    // (Finding 3.1). Mantido aqui para linhas legadas: reparos casados por /match antes de o
    // aceite passar a criar o match. Os caminhos de aceite chamam a mesma função.
    await rejeitarConcorrentes('reparo', req.params.id, req.usuario.id)
  } catch (err) {
    console.error('[reparos/match]', err.message)
    res.status(500).json({ erro: 'Erro ao confirmar match' })
  }
})

// Dono responde a uma proposta (aceitar / recusar / contraproposta)
router.post('/reparos/:id/interesse/:interesse_id/responder', autenticar, async (req, res) => {
  try {
    const { action, valor } = req.body
    const { id: reparo_id, interesse_id } = req.params

    const reparo = await pool.query(`SELECT criado_por, titulo FROM reparos WHERE id = $1`, [reparo_id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
    if (reparo.rows[0].criado_por !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o dono pode responder' })

    const interesse = await pool.query(
      `SELECT ir.*, u.push_token FROM interesse_reparos ir JOIN usuarios u ON ir.usuario_id = u.id WHERE ir.id = $1 AND ir.reparo_id = $2`,
      [interesse_id, reparo_id]
    )
    if (interesse.rows.length === 0) return res.status(404).json({ erro: 'Interesse não encontrado' })
    const int = interesse.rows[0]

    if (action === 'aceitar') {
      // Idempotência de retry: já aceito → devolve sucesso sem reprocessar (sem repetir
      // push nem o UPDATE do match). Sem isto o jaAceito abaixo não pega o próprio
      // registro (id != $2). Espelha o guard de .../prestador-responder.
      // O contrato É rechamado: se já foi enviado, o claim em enviarContratoReparo sai cedo
      // sem e-mail; se o envio anterior falhou, o claim foi liberado e esta é a retentativa.
      if (int.status === 'aceito') {
        enviarContratoReparo(reparo_id).catch(err => console.error('Erro ao enviar contrato reparo:', err))
        return res.json({ mensagem: 'Proposta aceita! Contrato enviado por e-mail.' })
      }
      const jaAceito = await pool.query(
        `SELECT id FROM interesse_reparos WHERE reparo_id = $1 AND status = 'aceito' AND id != $2`,
        [req.params.id, interesse_id]
      )
      if (jaAceito.rows.length > 0) {
        return res.status(409).json({ erro: 'Já existe um prestador aceito para este serviço' })
      }
      // Suspensão do INTERESSADO (quem chama aqui é o dono) — ver POST .../responder de obra.
      if (await estaSuspenso(int.usuario_id)) {
        return res.status(409).json(ERRO_ACEITE_SUSPENSO)
      }
      await pool.query(`UPDATE interesse_reparos SET status = 'aceito' WHERE id = $1`, [interesse_id])
      // O aceite já casa o prestador com o reparo. Guard match_usuario_id IS NULL: torna o
      // write idempotente em retry e impede que um segundo aceite roube um match existente.
      await pool.query(
        `UPDATE reparos SET match_usuario_id = $1, match_feito_em = NOW()
         WHERE id = $2 AND match_usuario_id IS NULL`,
        [int.usuario_id, reparo_id]
      )
      if (int.push_token) {
        enviarPushNotificacao(int.push_token, '🎉 Deu match!',
          `Parabéns! Você fechou negócio em "${reparo.rows[0].titulo}"! Toque para ver os detalhes.`,
          { tipo: 'interesse_aceito', reparo_id }).catch(() => {})
      }
      // match_usuario_id já foi definido acima, então o contrato pode sair agora — mesmo
      // ponto do fluxo em que a obra envia o dela (POST .../responder).
      enviarContratoReparo(reparo_id).catch(err => console.error('Erro ao enviar contrato reparo:', err))
      // Recusa os demais interessados e os notifica (antes ficava só no /match, que hoje
      // sai no early-return). Fire-and-forget: não bloqueia a resposta.
      rejeitarConcorrentes('reparo', reparo_id, int.usuario_id).catch(err => console.error('[reparos/responder] rejeitarConcorrentes:', err.message))
      return res.json({ mensagem: 'Proposta aceita! Contrato enviado por e-mail.' })
    }

    if (action === 'recusar') {
      await pool.query(`UPDATE interesse_reparos SET status = 'recusado' WHERE id = $1`, [interesse_id])
      if (int.push_token) {
        enviarPushNotificacao(int.push_token, '❌ Proposta não aceita',
          `Sua proposta para "${reparo.rows[0].titulo}" não foi selecionada desta vez.`,
          { tipo: 'interesse_recusado', reparo_id }).catch(() => {})
      }
      return res.json({ mensagem: 'Proposta recusada.' })
    }

    if (action === 'contraproposta') {
      if (!valor) return res.status(400).json({ erro: 'Informe o valor da contraproposta' })
      await pool.query(
        `UPDATE interesse_reparos SET status = 'contraproposta_dono', valor_contraproposta = $2, rodada = 2 WHERE id = $1`,
        [interesse_id, valor]
      )
      if (int.push_token) {
        enviarPushNotificacao(int.push_token, '💬 Contraproposta recebida!',
          `O solicitante fez uma contraproposta para "${reparo.rows[0].titulo}". Veja no app!`,
          { tipo: 'contraproposta_dono', reparo_id }).catch(() => {})
      }
      return res.json({ mensagem: 'Contraproposta enviada!' })
    }

    res.status(400).json({ erro: 'Ação inválida' })
  } catch (err) {
    console.error('Erro ao responder interesse:', err)
    res.status(500).json({ erro: 'Erro ao responder' })
  }
})

// Prestador responde a uma contraproposta do dono
router.post('/reparos/:id/interesse/:interesse_id/prestador-responder', autenticar, exigirPrestador, exigirReparador, async (req, res) => {
  try {
    const { action, valor } = req.body
    const { id: reparo_id, interesse_id } = req.params

    const interesse = await pool.query(
      `SELECT * FROM interesse_reparos WHERE id = $1 AND reparo_id = $2 AND usuario_id = $3`,
      [interesse_id, reparo_id, req.usuario.id]
    )
    if (interesse.rows.length === 0) return res.status(404).json({ erro: 'Interesse não encontrado' })
    if (interesse.rows[0].status !== 'contraproposta_dono') {
      // Idempotency for accept retries: if already accepted, return success silently.
      // O contrato é rechamado: se já foi enviado, o claim em enviarContratoReparo sai cedo
      // sem e-mail; se o envio anterior falhou, o claim foi liberado e esta é a retentativa.
      if (action === 'aceitar' && interesse.rows[0].status === 'aceito') {
        enviarContratoReparo(reparo_id).catch(err => console.error('Erro ao enviar contrato reparo:', err))
        return res.json({ mensagem: 'Contraproposta aceita! Contrato enviado por e-mail.' })
      }
      return res.status(400).json({ erro: 'Não há contraproposta pendente' })
    }

    const reparo = await pool.query(`SELECT titulo, criado_por FROM reparos WHERE id = $1`, [reparo_id])
    const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [reparo.rows[0].criado_por])

    if (action === 'contraproposta') {
      if (!valor) return res.status(400).json({ erro: 'Informe o valor da contraproposta' })
      // Volta para 'pendente' com o novo valor para reentrar no fluxo de resposta do dono
      await pool.query(`UPDATE interesse_reparos SET status = 'pendente', valor_proposto = $2, valor_contraproposta = NULL WHERE id = $1`, [interesse_id, valor])
      if (dono.rows[0]?.push_token) {
        enviarPushNotificacao(dono.rows[0].push_token, '💬 Nova contraproposta do profissional!',
          `O prestador propôs R$ ${Number(valor).toLocaleString('pt-BR')} para "${reparo.rows[0].titulo}". Veja no app!`,
          { tipo: 'contra_oferta', reparo_id }).catch(() => {})
      }
      return res.json({ mensagem: 'Contraproposta enviada!' })
    }

    if (action === 'aceitar') {
      // Mesma trava do pintor-responder de obra: só 'aceitar' é barrado; 'recusar' e
      // 'contraproposta' continuam liberados para o suspenso encerrar a negociação.
      const suspensao = await estaSuspenso(req.usuario.id)
      if (suspensao) return res.status(403).json(corpoContaSuspensa(suspensao))
      await pool.query(`UPDATE interesse_reparos SET status = 'aceito' WHERE id = $1`, [interesse_id])
      // O aceite já casa o prestador com o reparo (ver POST .../responder).
      await pool.query(
        `UPDATE reparos SET match_usuario_id = $1, match_feito_em = NOW()
         WHERE id = $2 AND match_usuario_id IS NULL`,
        [req.usuario.id, reparo_id]
      )
      if (dono.rows[0]?.push_token) {
        enviarPushNotificacao(dono.rows[0].push_token, '🎉 Deu match!',
          `Parabéns! Você fechou negócio em "${reparo.rows[0].titulo}"! Toque para ver os detalhes.`,
          { tipo: 'interesse_aceito', reparo_id }).catch(() => {})
      }
      // match_usuario_id já foi definido acima, então o contrato pode sair agora.
      enviarContratoReparo(reparo_id).catch(err => console.error('Erro ao enviar contrato reparo:', err))
      // Recusa os demais interessados e os notifica (ver POST .../responder).
      rejeitarConcorrentes('reparo', reparo_id, req.usuario.id).catch(err => console.error('[reparos/prestador-responder] rejeitarConcorrentes:', err.message))
      return res.json({ mensagem: 'Contraproposta aceita! Contrato enviado por e-mail.' })
    }

    if (action === 'recusar') {
      await pool.query(`UPDATE interesse_reparos SET status = 'recusado' WHERE id = $1`, [interesse_id])
      if (dono.rows[0]?.push_token) {
        enviarPushNotificacao(dono.rows[0].push_token, '❌ Proposta recusada',
          `O prestador recusou sua contraproposta para "${reparo.rows[0].titulo}".`,
          { tipo: 'interesse_recusado', reparo_id }).catch(() => {})
      }
      return res.json({ mensagem: 'Proposta recusada.' })
    }

    res.status(400).json({ erro: 'Ação inválida' })
  } catch (err) {
    console.error('Erro ao responder contraproposta:', err)
    res.status(500).json({ erro: 'Erro ao responder' })
  }
})

// Encerramento assimétrico — ver POST /obras/:id/encerrar para o racional completo.
router.post('/reparos/:id/encerrar', autenticar, async (req, res) => {
  try {
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
    const r = reparo.rows[0]
    const ehDono      = r.criado_por === req.usuario.id
    const ehPrestador = r.match_usuario_id === req.usuario.id
    const ehAdmin     = req.usuario.role === 'admin'
    if (!ehDono && !ehPrestador && !ehAdmin) return res.status(403).json({ erro: 'Sem permissão para encerrar este serviço' })

    // Já encerrado → no-op idempotente (não reescreve encerrado_em).
    if (r.status === 'encerrada') {
      return res.json({ mensagem: 'Serviço já encerrado.', encerramento: 'concluido' })
    }

    // Chegada é pré-requisito do encerramento. Sem NENHUMA declaração não há registro de que o
    // profissional esteve no local, e encerrar apagaria a única evidência que sustenta falta e
    // reputação. DECLARADA e ainda não confirmada passa de propósito: esse caso já tem fluxo
    // próprio (o dono confirma, ou autoEncerrarPendentes auto-confirma vencido o prazo), e
    // travá-lo puniria o profissional pelo silêncio do dono.
    // Só vale com contraparte casada — demanda que nunca teve match não teve quem chegasse, e
    // bloquear deixaria o dono sem como encerrar. Admin mantém a saída de emergência de sempre.
    if (!ehAdmin && r.match_usuario_id && !r.chegada_declarada_em) {
      return res.status(409).json({ erro: 'Antes de encerrar o serviço, confirme se o profissional chegou ao local.' })
    }

    const semContraparte = !r.match_usuario_id
    if (!ehAdmin && !ehDono && !semContraparte) {
      if (!r.encerramento_solicitado_por) {
        await pool.query(
          `UPDATE reparos SET encerramento_solicitado_por = $1, encerramento_solicitado_em = NOW() WHERE id = $2`,
          [req.usuario.id, req.params.id]
        )
        const outroId = ehDono ? r.match_usuario_id : r.criado_por
        const outro = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [outroId])
        if (outro.rows[0]?.push_token) {
          enviarPushNotificacao(outro.rows[0].push_token, '🔔 Encerramento solicitado',
            `A outra parte pediu para encerrar o serviço "${r.titulo}". Confirme no app.`,
            { tipo: 'encerramento_solicitado', reparo_id: req.params.id }).catch(() => {})
        }
        return res.json({ mensagem: 'Encerramento solicitado. Aguardando confirmação da outra parte.', encerramento: 'pendente' })
      }
      if (r.encerramento_solicitado_por === req.usuario.id) {
        return res.json({ mensagem: 'Encerramento já solicitado. Aguardando a outra parte.', encerramento: 'pendente' })
      }
    }

    await pool.query(
      `UPDATE reparos SET status = 'encerrada', status_aprovacao = 'encerrada', encerrado_em = NOW(),
                         encerramento_solicitado_por = NULL, encerramento_solicitado_em = NULL
       WHERE id = $1`,
      [req.params.id]
    )
    if (ehDono && r.match_usuario_id) {
      const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
      if (prestador.rows[0]?.push_token) {
        enviarPushNotificacao(prestador.rows[0].push_token, '✅ Serviço encerrado!',
          `O solicitante encerrou o serviço "${r.titulo}".`, { tipo: 'reparo_encerrado', reparo_id: req.params.id }).catch(() => {})
      }
    } else if (ehPrestador) {
      const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.criado_por])
      if (dono.rows[0]?.push_token) {
        enviarPushNotificacao(dono.rows[0].push_token, '✅ Serviço concluído!',
          `O prestador concluiu o serviço "${r.titulo}".`, { tipo: 'reparo_encerrado', reparo_id: req.params.id }).catch(() => {})
      }
    }
    res.json({ mensagem: 'Serviço encerrado com sucesso!', encerramento: 'concluido' })
  } catch (err) {
    console.error('[reparos/encerrar]', err.message)
    res.status(500).json({ erro: 'Erro ao encerrar serviço' })
  }
})

router.post('/reparos/:id/expirar-match', autenticar, async (req, res) => {
  try {
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
    const r = reparo.rows[0]
    const ehDono      = r.criado_por === req.usuario.id
    const ehPrestador = r.match_usuario_id === req.usuario.id
    const ehAdmin     = req.usuario.role === 'admin'
    if (!ehDono && !ehPrestador && !ehAdmin) {
      return res.status(403).json({ erro: 'Sem permissão para expirar este match' })
    }
    // Chegada declarada/confirmada congela a expiração do match (mesma regra do cron): o
    // prestador está no local — expirar aqui ainda o mandaria para a lista negra do reparo.
    //
    // EXCEÇÃO — o dono contesta chegada declarada por outro (ver POST /obras/:id/expirar-match
    // para o racional completo). Só o dono passa; prestador e admin seguem barrados.
    const donoContesta = ehDono
      && r.chegada_declarada_por !== req.usuario.id
      && r.status !== 'encerrada'
    if ((r.chegada_declarada_em || r.chegada_confirmada_em) && !donoContesta) {
      return res.status(409).json({ erro: 'Chegada já declarada — o match não pode mais expirar' })
    }
    // Grava o prestador na lista negra antes de limpar o match.
    // chegada_* zeradas junto: o reparo volta ao feed limpo (ver /obras/:id/expirar-match).
    // O CASE substitui o array_append cru: é NULL-safe (match já desfeito gravaria um NULL no
    // array) e idempotente (rechamada não duplica o mesmo uuid).
    const prestadorId = r.match_usuario_id
    const upd = await pool.query(
      `WITH desfeito AS (
         UPDATE reparos SET
           match_feito_em = NULL,
           match_usuario_id = NULL,
           chegada_janela = NULL,
           chegada_prevista_em = NULL,
           chegada_declarada_por = NULL,
           chegada_declarada_em = NULL,
           chegada_pendente_janela = NULL,
           chegada_pendente_em = NULL,
           chegada_recusada_em = NULL,
           chegada_confirmada_em = NULL,
           prestadores_bloqueados = CASE
             -- Isenção por janela não honrada pelo dono (ver POST /obras/:id/expirar-match e o
             -- CASE dos crons): recusada OU pendente sem resposta, e nenhuma outra valendo.
             WHEN chegada_prevista_em IS NULL
                  AND (chegada_recusada_em IS NOT NULL OR chegada_pendente_em IS NOT NULL)
             THEN prestadores_bloqueados
             WHEN $2::uuid IS NULL OR $2::uuid = ANY(COALESCE(prestadores_bloqueados, '{}'))
             THEN prestadores_bloqueados
             ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid) END
          WHERE id = $1
            AND (
              (chegada_declarada_em IS NULL AND chegada_confirmada_em IS NULL)
              -- Espelha o donoContesta relendo a linha VIVA (ver /obras/:id/expirar-match).
              OR ($3::boolean
                  AND chegada_declarada_por IS DISTINCT FROM criado_por
                  AND status IS DISTINCT FROM 'encerrada')
            )
          RETURNING id
       ), proposta AS (
         -- A proposta vencedora expira junto com o match, no mesmo statement — senão ela seguia
         -- 'aceito' ocupando interesse_reparos_aceito_unico_idx e o serviço voltava ao feed sem
         -- poder ser aceito de novo (ver POST /obras/:id/expirar-match).
         UPDATE interesse_reparos SET status = 'expirado'
          WHERE reparo_id IN (SELECT id FROM desfeito) AND usuario_id = $2::uuid AND status = 'aceito'
          RETURNING id
       )
       SELECT id FROM desfeito`,
      [req.params.id, prestadorId, ehDono]
    )
    // rowCount = 0 (o SELECT final não devolveu linha) → chegada declarada entre o SELECT e o UPDATE (ver /obras/:id/expirar-match).
    // Sai antes de qualquer push: nada expirou, e o prestador segue com o match.
    if (upd.rowCount === 0) {
      return res.status(409).json({ erro: 'Chegada já declarada — o match não pode mais expirar' })
    }
    // Este endpoint não notificava NINGUÉM. Agora avisa os dois lados, como o de obra.
    const donoR = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.criado_por])
    const prestadorR = prestadorId
      ? await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [prestadorId])
      : { rows: [] }
    res.json({ mensagem: 'Match expirado, serviço disponível novamente' })
    if (donoR.rows[0]?.push_token) {
      enviarPushNotificacao(donoR.rows[0].push_token, '⏰ Prazo expirado!',
        `O prestador não chegou a tempo para "${r.titulo}". O serviço está disponível novamente.`,
        { tipo: 'match_expirado', reparo_id: req.params.id }).catch(() => {})
    }
    if (prestadorR.rows[0]?.push_token) {
      enviarPushNotificacao(prestadorR.rows[0].push_token, '⏰ Prazo expirado!',
        `O prazo para chegar em "${r.titulo}" acabou. O serviço voltou para o feed.`,
        { tipo: 'match_expirado', reparo_id: req.params.id }).catch(() => {})
    }
    return
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao expirar match' })
  }
})

// ============================================================
// CHEGADA — previsão e confirmação (obras e reparos)
// ============================================================
// Dois passos independentes:
//   1) POST /:id/chegada-prevista — o profissional casado escolhe UMA janela. Write-once:
//      a primeira escolhida vale, as seguintes devolvem a que já está gravada (o dono se
//      programou em cima dela; deixar o profissional reescrever esvaziaria a promessa).
//   2) POST /:id/chegada — dono OU profissional declara que a chegada aconteceu. Só a
//      palavra do DONO confirma (chegada_confirmada_em); o profissional sozinho apenas
//      declara e fica aguardando.
//
// `tabela` sai SEMPRE de literal no registro da rota (logo abaixo), nunca do request —
// a interpolação no SQL não é superfície de injeção. Mesmo padrão de autoEncerrarPendentes.

const TZ_CHEGADA = 'America/Sao_Paulo'

// Offsets a partir da MEIA-NOITE local de hoje (America/Sao_Paulo):
//   hoje         → hoje 23:59
//   amanha_manha → amanhã 12:00
//   amanha_tarde → amanhã 18:00
// Resolvidos no Postgres com o fuso explícito, não no relógio do processo: o container do
// Railway roda em UTC, então `new Date()` daria o dia errado entre 21:00 e 00:00 de Brasília.
const JANELAS_CHEGADA = {
  hoje:         { dias: 0, horas: 23, minutos: 59, rotulo: 'ainda hoje' },
  amanha_manha: { dias: 1, horas: 12, minutos: 0,  rotulo: 'amanhã de manhã' },
  amanha_tarde: { dias: 1, horas: 18, minutos: 0,  rotulo: 'amanhã à tarde' },
}

// Rótulos por tabela para os pushes: a chave do payload segue a convenção das notificações de
// match (obra_id / reparo_id) e o substantivo acompanha o tier (pintor em obra, prestador em
// reparo), como em '🚀 Pintor a caminho!' vs '🚀 Profissional a caminho!'.
const ROTULOS_CHEGADA = {
  obras:   { chave: 'obra_id',   profissional: 'pintor' },
  reparos: { chave: 'reparo_id', profissional: 'prestador' },
}

const criarHandlerChegadaPrevista = (tabela) => async (req, res) => {
  try {
    const { janela } = req.body || {}
    // hasOwnProperty e não `JANELAS_CHEGADA[janela]`: 'constructor'/'toString' vêm do
    // protótipo e passariam por um teste de truthiness.
    if (typeof janela !== 'string' || !Object.prototype.hasOwnProperty.call(JANELAS_CHEGADA, janela)) {
      return res.status(400).json({
        erro: 'janela inválida',
        janelas_validas: Object.keys(JANELAS_CHEGADA),
      })
    }
    const alvo = await pool.query(
      `SELECT titulo, criado_por, match_usuario_id FROM ${tabela} WHERE id = $1`,
      [req.params.id]
    )
    if (alvo.rows.length === 0) return res.status(404).json({ erro: 'Demanda não encontrada' })
    // Só o profissional CASADO — nem o dono, nem um profissional que apenas se candidatou.
    if (!alvo.rows[0].match_usuario_id || alvo.rows[0].match_usuario_id !== req.usuario.id) {
      return res.status(403).json({ erro: 'Apenas o profissional do match pode informar a previsão de chegada' })
    }

    const { dias, horas, minutos, rotulo } = JANELAS_CHEGADA[janela]
    // Write-once DENTRO do UPDATE (os dois _em NULL no WHERE), não em um if antes: dois toques
    // simultâneos passariam os dois por uma checagem separada e o segundo sobrescreveria a
    // janela já prometida ao dono. O par PENDENTE entra no guard junto — enquanto uma proposta
    // aguarda resposta do dono, o profissional não troca a aposta por baixo dela.
    //
    // GREATEST(..., NOW() + 1 hour) = PISO da previsão. 'hoje' escolhido às 23:55 renderia
    // 23:59 — 4 minutos, e às 23:59:30 já nasceria VENCIDA, com o dono recebendo uma promessa
    // impossível. O piso empurra esses casos para NOW() + 1h.
    //
    // A previsão calculada cai em UM dos dois pares, decidido no próprio SQL (CTE `calc` para
    // não repetir a expressão quatro vezes):
    //   cabe no expira_em  → chegada_janela/chegada_prevista_em, como antes.
    //   estoura o expira_em → chegada_pendente_*, aguardando o dono. NÃO mexe no prazo aqui:
    //      esticar a demanda por decisão unilateral do profissional é exatamente o que o
    //      fluxo de aprovação existe para evitar.
    // COALESCE(expira_em, 'infinity'): demanda sem prazo não tem o que estourar — cabe sempre.
    // Os dois CASE são mutuamente exclusivos, então nunca gravam nos dois pares.
    const upd = await pool.query(
      `WITH calc AS (
         SELECT GREATEST(
           (
             date_trunc('day', NOW() AT TIME ZONE $3::text)
             + ($4::int * INTERVAL '1 day')
             + ($5::int * INTERVAL '1 hour')
             + ($6::int * INTERVAL '1 minute')
           ) AT TIME ZONE $3::text,
           NOW() + INTERVAL '1 hour'
         ) AS prevista
       )
       UPDATE ${tabela} d SET
         chegada_janela = CASE
           WHEN c.prevista <= COALESCE(d.expira_em, 'infinity'::timestamptz) THEN $2::text
           ELSE d.chegada_janela END,
         chegada_prevista_em = CASE
           WHEN c.prevista <= COALESCE(d.expira_em, 'infinity'::timestamptz) THEN c.prevista
           ELSE d.chegada_prevista_em END,
         chegada_pendente_janela = CASE
           WHEN c.prevista > COALESCE(d.expira_em, 'infinity'::timestamptz) THEN $2::text
           ELSE d.chegada_pendente_janela END,
         chegada_pendente_em = CASE
           WHEN c.prevista > COALESCE(d.expira_em, 'infinity'::timestamptz) THEN c.prevista
           ELSE d.chegada_pendente_em END
       FROM calc c
       WHERE d.id = $1 AND d.match_usuario_id = $7
         AND d.chegada_prevista_em IS NULL AND d.chegada_pendente_em IS NULL
       RETURNING d.chegada_janela, d.chegada_prevista_em,
                 d.chegada_pendente_janela, d.chegada_pendente_em`,
      [req.params.id, janela, TZ_CHEGADA, dias, horas, minutos, req.usuario.id]
    )
    if (upd.rowCount > 0) {
      // Push só no write REAL: o caminho de baixo (previsão já gravada) é retry/reabertura da
      // tela, e reavisar o dono a cada toque viraria spam de uma promessa que não mudou.
      // Token buscado ANTES do res.json: um throw depois da resposta cairia no catch e tentaria
      // responder duas vezes (mesmo cuidado de candidaturasController.aprovar).
      const { chave, profissional } = ROTULOS_CHEGADA[tabela]
      const pendente = !!upd.rows[0].chegada_pendente_em
      const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [alvo.rows[0].criado_por])
      res.json(upd.rows[0])
      if (dono.rows[0]?.push_token) {
        // Dois textos porque são duas perguntas diferentes: um informa, o outro PEDE resposta.
        enviarPushNotificacao(
          dono.rows[0].push_token,
          pendente ? '📅 Chegada depois do prazo' : '📅 Previsão de chegada!',
          pendente
            ? `O ${profissional} só consegue chegar ${rotulo} em "${alvo.rows[0].titulo}", depois do prazo. Aceitar ou recusar?`
            : `O ${profissional} informou que chega ${rotulo} para "${alvo.rows[0].titulo}"`,
          { tipo: pendente ? 'chegada_prevista_pendente' : 'chegada_prevista', [chave]: req.params.id }
        ).catch(() => {})
      }
      return
    }

    // rowCount = 0 → já havia previsão (gravada ou pendente). Não é erro: devolve o que vale.
    const atual = await pool.query(
      `SELECT chegada_janela, chegada_prevista_em, chegada_pendente_janela, chegada_pendente_em
         FROM ${tabela} WHERE id = $1`,
      [req.params.id]
    )
    if (atual.rows.length === 0) return res.status(404).json({ erro: 'Demanda não encontrada' })
    res.json(atual.rows[0])
  } catch (err) {
    console.error(`[${tabela}/chegada-prevista]`, err.message)
    res.status(500).json({ erro: 'Erro ao registrar previsão de chegada' })
  }
}

const criarHandlerChegada = (tabela) => async (req, res) => {
  try {
    const alvo = await pool.query(
      `SELECT titulo, criado_por, match_usuario_id, chegada_declarada_em, chegada_confirmada_em
         FROM ${tabela} WHERE id = $1`,
      [req.params.id]
    )
    if (alvo.rows.length === 0) return res.status(404).json({ erro: 'Demanda não encontrada' })
    const d = alvo.rows[0]
    const ehDono         = d.criado_por === req.usuario.id
    const ehProfissional = !!d.match_usuario_id && d.match_usuario_id === req.usuario.id
    if (!ehDono && !ehProfissional) {
      return res.status(403).json({ erro: 'Apenas o dono ou o profissional do match podem declarar a chegada' })
    }

    // COALESCE em todos os campos = idempotente: rechamar não desloca timestamp já gravado,
    // e a declaração do profissional (que veio primeiro) não é apagada pela do dono.
    //
    // chegada_confirmada_em:
    //   dono         → NOW() na hora (a palavra do dono basta).
    //   profissional → só se o DONO já tinha declarado antes. As expressões do SET leem a
    //                  linha ANTIGA, então `chegada_declarada_por = criado_por` aqui testa
    //                  quem declarou ANTES desta chamada, não o valor que estamos gravando.
    const upd = await pool.query(
      `UPDATE ${tabela} SET
         chegada_declarada_por = COALESCE(chegada_declarada_por, $2::uuid),
         chegada_declarada_em  = COALESCE(chegada_declarada_em, NOW()),
         chegada_confirmada_em = CASE
           WHEN chegada_confirmada_em IS NOT NULL THEN chegada_confirmada_em
           WHEN $3::boolean THEN NOW()
           WHEN chegada_declarada_por = criado_por THEN NOW()
           ELSE NULL
         END
       WHERE id = $1
       RETURNING chegada_declarada_por, chegada_declarada_em, chegada_confirmada_em`,
      [req.params.id, req.usuario.id, ehDono]
    )
    // Transições NULL → preenchido, comparando o estado lido antes com o RETURNING. Só a
    // transição notifica: rechamar o endpoint não reenvia push, porque na segunda vez o campo
    // já estava preenchido ANTES.
    const declarouAgora  = !d.chegada_declarada_em  && !!upd.rows[0].chegada_declarada_em
    const confirmouAgora = !d.chegada_confirmada_em && !!upd.rows[0].chegada_confirmada_em
    const { chave, profissional } = ROTULOS_CHEGADA[tabela]

    // Tokens buscados ANTES do res.json: um throw depois da resposta cairia no catch e tentaria
    // responder duas vezes (mesmo cuidado de candidaturasController.aprovar).
    const avisarDono = declarouAgora && ehProfissional
    const avisarProf = confirmouAgora && !!d.match_usuario_id
    const tokenDono = avisarDono
      ? (await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [d.criado_por])).rows[0]?.push_token
      : null
    const tokenProf = avisarProf
      ? (await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [d.match_usuario_id])).rows[0]?.push_token
      : null

    res.json(upd.rows[0])

    // Profissional declarou → o dono precisa confirmar.
    if (tokenDono) {
      enviarPushNotificacao(tokenDono, '📍 Chegada informada!',
        `O ${profissional} informou que chegou em "${d.titulo}". Confirme no app.`,
        { tipo: 'chegada_declarada', [chave]: req.params.id }).catch(() => {})
    }
    // Chegada confirmada → avisa o profissional. Vale tanto para o dono declarando direto
    // quanto para o dono confirmando uma declaração anterior do profissional.
    if (tokenProf) {
      enviarPushNotificacao(tokenProf, '✅ Chegada confirmada!',
        `O solicitante confirmou sua chegada em "${d.titulo}".`,
        { tipo: 'chegada_confirmada', [chave]: req.params.id }).catch(() => {})
    }
  } catch (err) {
    console.error(`[${tabela}/chegada]`, err.message)
    res.status(500).json({ erro: 'Erro ao registrar chegada' })
  }
}

// POST /:id/chegada-prevista/responder — o dono responde à janela que estourou o prazo.
// aceito=true  → a pendente vira a valer e o expira_em ESTICA até ela (senão o cron mataria o
//                match no prazo velho, um minuto depois de o dono ter dito sim).
// aceito=false → limpa só a pendente. O profissional NÃO é bloqueado, NÃO perde o match e volta
//                a poder escolher outra janela (o guard write-once do outro handler olha os dois
//                _em, e ambos ficam NULL de novo).
const criarHandlerChegadaPrevistaResponder = (tabela) => async (req, res) => {
  try {
    const { aceito } = req.body || {}
    if (typeof aceito !== 'boolean') {
      return res.status(400).json({ erro: 'aceito é obrigatório e deve ser booleano' })
    }
    const alvo = await pool.query(
      `SELECT titulo, criado_por, match_usuario_id, chegada_pendente_janela, chegada_pendente_em
         FROM ${tabela} WHERE id = $1`,
      [req.params.id]
    )
    if (alvo.rows.length === 0) return res.status(404).json({ erro: 'Demanda não encontrada' })
    const d = alvo.rows[0]
    // Só o DONO responde: é o prazo dele que está sendo esticado.
    if (d.criado_por !== req.usuario.id) {
      return res.status(403).json({ erro: 'Apenas o dono pode responder à previsão de chegada' })
    }
    if (!d.chegada_pendente_em) {
      return res.status(409).json({ erro: 'Não há previsão de chegada aguardando resposta' })
    }

    // chegada_pendente_em IS NOT NULL repetido no WHERE: duas respostas simultâneas não aplicam
    // o aceite duas vezes (a segunda volta rowCount = 0 e cai no 409 acima na próxima tentativa).
    // GREATEST no expira_em em vez de atribuição direta: se o dono tiver estendido o prazo para
    // além da janela nesse meio-tempo, aceitar não pode ENCURTAR a demanda.
    // match_usuario_id não é tocado em nenhum dos dois ramos — responder nunca desfaz o match.
    const upd = aceito
      ? await pool.query(
          `UPDATE ${tabela} SET
             chegada_janela = chegada_pendente_janela,
             chegada_prevista_em = chegada_pendente_em,
             expira_em = GREATEST(expira_em, chegada_pendente_em),
             chegada_pendente_janela = NULL,
             chegada_pendente_em = NULL
           WHERE id = $1 AND chegada_pendente_em IS NOT NULL
           RETURNING chegada_janela, chegada_prevista_em, expira_em`,
          [req.params.id]
        )
      : await pool.query(
          // chegada_recusada_em marca a recusa para o cron não cobrar falta de quem ofereceu
          // horário e ouviu não. Só o ramo da recusa grava — aceitar não deixa marca.
          `UPDATE ${tabela} SET chegada_pendente_janela = NULL, chegada_pendente_em = NULL,
                                chegada_recusada_em = NOW()
           WHERE id = $1 AND chegada_pendente_em IS NOT NULL
           RETURNING chegada_janela, chegada_prevista_em, expira_em`,
          [req.params.id]
        )
    if (upd.rowCount === 0) {
      return res.status(409).json({ erro: 'Não há previsão de chegada aguardando resposta' })
    }

    const { chave, profissional } = ROTULOS_CHEGADA[tabela]
    const rotuloPendente = JANELAS_CHEGADA[d.chegada_pendente_janela]?.rotulo || d.chegada_pendente_janela
    const prof = d.match_usuario_id
      ? await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [d.match_usuario_id])
      : { rows: [] }
    res.json(upd.rows[0])
    if (prof.rows[0]?.push_token) {
      enviarPushNotificacao(
        prof.rows[0].push_token,
        aceito ? '✅ Janela aprovada!' : '❌ Janela recusada',
        aceito
          ? `O solicitante aceitou sua chegada ${rotuloPendente} em "${d.titulo}". O prazo foi estendido.`
          : `O solicitante não pode esperar até ${rotuloPendente} em "${d.titulo}". Escolha outra janela no app.`,
        { tipo: aceito ? 'chegada_prevista_aceita' : 'chegada_prevista_recusada', [chave]: req.params.id }
      ).catch(() => {})
    }
  } catch (err) {
    console.error(`[${tabela}/chegada-prevista/responder]`, err.message)
    res.status(500).json({ erro: 'Erro ao responder previsão de chegada' })
  }
}

router.post('/obras/:id/chegada-prevista',   autenticar, criarHandlerChegadaPrevista('obras'))
router.post('/reparos/:id/chegada-prevista', autenticar, criarHandlerChegadaPrevista('reparos'))
router.post('/obras/:id/chegada-prevista/responder',   autenticar, criarHandlerChegadaPrevistaResponder('obras'))
router.post('/reparos/:id/chegada-prevista/responder', autenticar, criarHandlerChegadaPrevistaResponder('reparos'))
router.post('/obras/:id/chegada',            autenticar, criarHandlerChegada('obras'))
router.post('/reparos/:id/chegada',          autenticar, criarHandlerChegada('reparos'))

// Prestador solicita mais tempo — envia motivo e notifica dono
router.post('/reparos/:id/pedir-tempo', autenticar, async (req, res) => {
  try {
    const { motivo } = req.body
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
    const r = reparo.rows[0]

    if (r.match_usuario_id !== req.usuario.id) {
      return res.status(403).json({ erro: 'Apenas o prestador do match pode solicitar mais tempo' })
    }

    await pool.query(
      `UPDATE reparos SET pedido_tempo_status = 'aguardando_tempo', pedido_tempo_motivo = $1, pedido_tempo_minutos = NULL WHERE id = $2`,
      [motivo, req.params.id]
    )

    // Notifica o dono
    const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.criado_por])
    if (dono.rows[0]?.push_token) {
      await enviarPushNotificacao(
        dono.rows[0].push_token,
        '⚠️ Prestador precisa de mais tempo!',
        `Motivo: ${motivo}. Abra o app para responder.`,
        { tipo: 'pedido_tempo', reparo_id: req.params.id }
      )
    }

    res.json({ mensagem: 'Solicitação enviada ao dono.' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao solicitar mais tempo' })
  }
})

// Dono pergunta quanto tempo o prestador precisa — notifica prestador
router.post('/reparos/:id/perguntar-tempo', autenticar, async (req, res) => {
  try {
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
    const r = reparo.rows[0]

    if (r.criado_por !== req.usuario.id) {
      return res.status(403).json({ erro: 'Apenas o dono pode responder o pedido' })
    }

    await pool.query(
      `UPDATE reparos SET pedido_tempo_status = 'aguardando_minutos' WHERE id = $1`,
      [req.params.id]
    )

    // Notifica o prestador
    const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
    if (prestador.rows[0]?.push_token) {
      await enviarPushNotificacao(
        prestador.rows[0].push_token,
        '⏱ Quanto tempo você precisa?',
        'O solicitante quer saber quantos minutos a mais você precisa para chegar.',
        { tipo: 'perguntar_tempo', reparo_id: req.params.id }
      )
    }

    res.json({ mensagem: 'Prestador notificado para informar o tempo.' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao perguntar tempo' })
  }
})

// Prestador informa quantos minutos precisa — notifica dono para aceitar/recusar
router.post('/reparos/:id/informar-tempo', autenticar, async (req, res) => {
  try {
    const { minutos } = req.body
    if (!minutos || minutos <= 0) return res.status(400).json({ erro: 'Informe um tempo válido em minutos' })

    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
    const r = reparo.rows[0]

    if (r.match_usuario_id !== req.usuario.id) {
      return res.status(403).json({ erro: 'Apenas o prestador do match pode informar o tempo' })
    }

    await pool.query(
      `UPDATE reparos SET pedido_tempo_status = 'aguardando_aprovacao', pedido_tempo_minutos = $1 WHERE id = $2`,
      [minutos, req.params.id]
    )

    // Notifica o dono
    const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.criado_por])
    if (dono.rows[0]?.push_token) {
      await enviarPushNotificacao(
        dono.rows[0].push_token,
        '⏳ Prestador precisa de mais tempo',
        `Ele precisa de ${minutos} minuto(s) a mais. Aceitar ou recusar?`,
        { tipo: 'aprovar_tempo', reparo_id: req.params.id }
      )
    }

    res.json({ mensagem: 'Dono notificado para aprovar o tempo.' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao informar tempo' })
  }
})

// Dono aceita ou recusa o tempo extra
router.post('/reparos/:id/responder-tempo', autenticar, async (req, res) => {
  try {
    const { aceito } = req.body
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
    const r = reparo.rows[0]

    if (r.criado_por !== req.usuario.id) {
      return res.status(403).json({ erro: 'Apenas o dono pode responder' })
    }

    if (aceito) {
      // Estende o cronômetro somando os minutos ao match_feito_em
      const novoMatchFeitoEm = new Date(new Date(r.match_feito_em).getTime() + r.pedido_tempo_minutos * 60 * 1000)
      await pool.query(
        `UPDATE reparos SET match_feito_em = $1, pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL WHERE id = $2`,
        [novoMatchFeitoEm.toISOString(), req.params.id]
      )

      // Notifica prestador
      const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
      if (prestador.rows[0]?.push_token) {
        await enviarPushNotificacao(
          prestador.rows[0].push_token,
          '✅ Tempo extra aceito!',
          `O solicitante aceitou. Você tem mais ${r.pedido_tempo_minutos} minuto(s). Corra!`,
          { tipo: 'tempo_aceito', reparo_id: req.params.id }
        )
      }

      res.json({ mensagem: 'Tempo extra concedido!', novo_match_feito_em: novoMatchFeitoEm })
    } else {
      // Recusou — bloqueia prestador e volta reparo para disponível.
      // Mesmo CASE NULL-safe/idempotente dos outros quatro pontos de append (ver
      // POST /obras/:id/expirar-match): array_append cru gravaria um NULL no array se o match
      // já tivesse sido desfeito, e duplicaria o uuid numa rechamada.
      // chegada_* zeradas — incluindo chegada_confirmada_em, pelo mesmo motivo explicado em
      // POST /obras/:id/responder-tempo (este caminho não tem o guard que os outros têm).
      await pool.query(
        `UPDATE reparos SET
          match_feito_em = NULL,
          match_usuario_id = NULL,
          pedido_tempo_status = NULL,
          pedido_tempo_motivo = NULL,
          pedido_tempo_minutos = NULL,
          chegada_janela = NULL,
          chegada_prevista_em = NULL,
          chegada_declarada_por = NULL,
          chegada_declarada_em = NULL,
          chegada_pendente_janela = NULL,
          chegada_pendente_em = NULL,
          chegada_recusada_em = NULL,
          chegada_confirmada_em = NULL,
          prestadores_bloqueados = CASE
            WHEN $2::uuid IS NULL OR $2::uuid = ANY(COALESCE(prestadores_bloqueados, '{}'))
            THEN prestadores_bloqueados
            ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid) END
         WHERE id = $1`,
        [req.params.id, r.match_usuario_id]
      )

      // Notifica prestador
      const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
      if (prestador.rows[0]?.push_token) {
        await enviarPushNotificacao(
          prestador.rows[0].push_token,
          '❌ Tempo extra recusado',
          'O solicitante não aceitou. O serviço voltou para disponível.',
          { tipo: 'tempo_recusado', reparo_id: req.params.id }
        )
      }

      res.json({ mensagem: 'Tempo recusado. Serviço disponível novamente.' })
    }
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao responder pedido de tempo' })
  }
})

// CORRIGIDO: aceita dono do reparo E prestador (não só prestador)
router.get('/reparos/:id', autenticar, async (req, res) => {
  try {
    // expirada: mesma expressão do GET /reparos/minhas — "expirado" não é status no banco,
    // é um reparo NÃO encerrado cujo expira_em já passou. Calculado no SQL (relógio do
    // servidor) para a tela de detalhe gatear o botão de estender sem comparar com o
    // relógio do aparelho.
    // pode_estender_em: instante a partir do qual POST /reparos/:id/estender para de recusar
    // com 409. NULL = sem carência (faixa curta), pode estender já. Mesmas constantes do
    // endpoint, então a regra não pode divergir do que ele enforça. Calculado no SQL, como
    // `expirada`, para o app não depender do relógio do aparelho.
    const result = await pool.query(
      `SELECT *, (status <> 'encerrada' AND expira_em <= NOW()) AS expirada,
              CASE WHEN prazo_atendimento_horas IS NULL OR prazo_atendimento_horas > $2::numeric
                   THEN criado_em + ($3::numeric * INTERVAL '1 hour') END AS pode_estender_em
         FROM reparos WHERE id = $1`,
      [req.params.id, FAIXA_LONGA_REPARO_HORAS, CARENCIA_ESTENDER_REPARO_HORAS]
    )
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })

    const reparo = result.rows[0]
    const ehDono           = reparo.criado_por === req.usuario.id
    const ehPrestadorDoMatch = reparo.match_usuario_id === req.usuario.id

    // Dono sempre pode ver seu próprio reparo
    // Prestador do match sempre pode ver
    // Admin sempre pode ver
    // Prestador comum precisa de assinatura ativa
    if (!ehDono && !ehPrestadorDoMatch && req.usuario.role !== 'admin') {
      if (req.usuario.role !== 'prestador') {
        return res.status(403).json({ erro: 'Sem permissão para ver este serviço' })
      }
      const assinatura = await pool.query(
        `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' AND (proximo_vencimento IS NULL OR proximo_vencimento > NOW()) LIMIT 1`,
        [req.usuario.id]
      )
      if (assinatura.rows.length === 0) {
        return res.status(403).json({ erro: 'Assinatura inativa. Renove seu plano para acessar os serviços.' })
      }
    }

    const midias    = await pool.query(`SELECT * FROM midias_reparos WHERE reparo_id = $1 ORDER BY ordem`, [req.params.id])
    const interesse = await pool.query(
      `SELECT id, status, valor_proposto, valor_contraproposta, rodada FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2`,
      [req.params.id, req.usuario.id]
    )

    // Se for dono ou admin, busca lista de interessados
    let interessados = []
    if (ehDono || req.usuario.role === 'admin') {
      const result2 = await pool.query(
        // Contato/endereço do prestador são revelados ao dono APENAS após o match
        // (reparos.match_usuario_id aponta para o prestador que confirmou a ida), e
        // só para o prestador efetivamente casado — nunca no mero aceite (status='aceito').
        // EXCEÇÃO: bairro sai para todos os interessados, junto de cidade — mesma regra do
        // lado obra. logradouro, numero e telefone continuam match-gated.
        `SELECT ir.id, ir.usuario_id, ir.status, ir.mensagem, ir.criado_em,
                ir.valor_proposto, ir.valor_contraproposta, ir.rodada,
                u.nome, u.cidade, u.bairro, u.foto_url, u.anos_experiencia, u.especialidades, u.tamanho_equipe,
                CASE WHEN ir.usuario_id = $2 THEN u.logradouro ELSE NULL END as logradouro,
                CASE WHEN ir.usuario_id = $2 THEN u.numero ELSE NULL END as numero,
                CASE WHEN ir.usuario_id = $2 THEN u.telefone ELSE NULL END as telefone,
                (SELECT COUNT(*)::int FROM avaliacoes a WHERE a.avaliado_id = ir.usuario_id) AS avaliacoes_total,
                (SELECT COALESCE(ROUND(AVG(a.estrelas)::numeric, 1), 0) FROM avaliacoes a WHERE a.avaliado_id = ir.usuario_id) AS avaliacoes_media
         FROM interesse_reparos ir
         JOIN usuarios u ON ir.usuario_id = u.id
         WHERE ir.reparo_id = $1
         ORDER BY ir.criado_em ASC`,
        [req.params.id, reparo.match_usuario_id]
      )
      interessados = result2.rows
    }

    // Aceite do próprio requester. Procura a linha 'aceito' EXPLICITAMENTE em vez de
    // olhar rows[0]: a query de meu_interesse não tem ORDER BY/LIMIT, então rows[0]
    // é arbitrário e poderia ser um interesse recusado do mesmo reparo.
    const meuAceite = interesse.rows.find(i => i.status === 'aceito')

    // Endereço exato e ponto de referência só para dono, prestador do match, prestador com
    // interesse aceito ou admin (Finding 3.1). ponto_referencia sai junto pelo mesmo motivo
    // do lado obra: é dica de localização, não descrição do serviço.
    // Coordenadas permanecem para o cálculo de distância no cliente.
    if (reparo.criado_por !== req.usuario.id && reparo.match_usuario_id !== req.usuario.id && !meuAceite && req.usuario.role !== 'admin') {
      delete reparo.endereco_reparo
      delete reparo.ponto_referencia
    }

    // Advisory plano: /reparos/:id/estender não tem mais teto (o de 2x saiu), então não há
    // orçamento a calcular — nem âncora, nem janela. O campo continua só porque o app filtra
    // as opções por ele (ModalEstenderPrazo); a MESMA constante do endpoint, para os dois
    // números não divergirem. NÃO reflete a carência de 1h das faixas longas: dentro da
    // primeira hora o app ainda oferece opções que o endpoint recusa com 409.
    const extensao_maxima_horas = ADVISORY_ESTENDER_REPARO_HORAS
    res.json({
      reparo,
      midias: midias.rows,
      meu_interesse: interesse.rows[0] || null,
      interessados,
      extensao_maxima_horas,
      pode_estender_em: reparo.pode_estender_em,
    })

    // Contador de visitas em memória (mesmo racional do GET /obras/:id).
    // Só conta visita se for prestador (não dono consultando o próprio reparo).
    if (!ehDono) registrarVisita('reparos', req.params.id)
  } catch (err) {
    console.error('Erro ao buscar reparo:', err)
    res.status(500).json({ erro: 'Erro ao buscar serviço' })
  }
})

router.post('/upload/reparo', autenticar, upload.single('arquivo'), async (req, res) => {
  try {
    const { reparo_id, ordem } = req.body
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' })
    const reparoOwner = await pool.query(`SELECT criado_por FROM reparos WHERE id = $1`, [reparo_id])
    if (reparoOwner.rows.length === 0 || reparoOwner.rows[0].criado_por !== req.usuario.id) {
      return res.status(403).json({ erro: 'Sem permissão para esta ação' })
    }
    const resultado = await uploadArquivo(req.file)
    const tipo = req.file.mimetype.startsWith('video/') ? 'video' : 'foto'
    const result = await pool.query(
      `INSERT INTO midias_reparos (reparo_id, tipo, url, ordem) VALUES ($1, $2, $3, $4) RETURNING *`,
      [reparo_id, tipo, resultado.secure_url, ordem || 1]
    )
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao fazer upload' })
  }
})

// Assinatura para upload direto ao Cloudinary (para vídeos grandes)
router.post('/auth/verificar-disponibilidade', async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown'
  const now = Date.now()
  const entry = cacheVerifRate.get(ip) || { count: 0, windowStart: now }
  if (now - entry.windowStart > VERIF_WINDOW) { entry.count = 0; entry.windowStart = now }
  entry.count++
  cacheVerifRate.set(ip, entry)
  if (entry.count > VERIF_LIMIT) {
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um momento e tente novamente.' })
  }

  const ts = new Date().toISOString()
  const { email, cpf_cnpj } = req.body
  console.log(`[VERIF][${ts}] ▶ inicio | email=${email} cpf_cnpj=${cpf_cnpj}`)
  try {
    if (email) {
      const emailNormalizado = email.toLowerCase().trim()
      console.log(`[VERIF][${ts}] ▶ checando email no banco | email=${emailNormalizado}`)
      const existe = await pool.query('SELECT id FROM usuarios WHERE email = $1', [emailNormalizado])
      if (existe.rows.length > 0) {
        console.log(`[VERIF][${ts}] ✗ 409 email duplicado | email=${emailNormalizado}`)
        return res.status(409).json({ erro: 'Este e-mail já está cadastrado.', codigo: 'email_duplicado' })
      }
      console.log(`[VERIF][${ts}] ✓ email disponivel`)
    }
    if (cpf_cnpj) {
      const cpfLimpo = cpf_cnpj.replace(/\D/g, '')
      console.log(`[VERIF][${ts}] ▶ checando cpf_cnpj no banco | cpfLimpo=${cpfLimpo}`)
      const existe = await pool.query(
        `SELECT id FROM usuarios WHERE regexp_replace(cpf_cnpj, '[^0-9]', '', 'g') = $1`,
        [cpfLimpo]
      )
      if (existe.rows.length > 0) {
        console.log(`[VERIF][${ts}] ✗ 409 cpf_cnpj duplicado | cpfLimpo=${cpfLimpo}`)
        return res.status(409).json({ erro: 'Este CPF/CNPJ já está cadastrado.', codigo: 'cpf_duplicado' })
      }
      console.log(`[VERIF][${ts}] ✓ cpf_cnpj disponivel`)
    }
    console.log(`[VERIF][${ts}] ✓ disponivel: true — respondendo 200`)
    res.json({ disponivel: true })
  } catch (err) {
    console.error(`[VERIF][${ts}] ✗ ERRO INTERNO | msg="${err.message}" | code=${err.code}\n${err.stack}`)
    res.status(500).json({ erro: 'Erro ao verificar disponibilidade' })
  }
})

router.get('/upload/assinatura-publica', (req, res) => {
  const ts = new Date().toISOString()
  console.log(`[ASSINATURA][${ts}] ▶ GET /upload/assinatura-publica`)
  try {
    const params = gerarAssinaturaCloudinary('pinturapro/verificacao')
    console.log(`[ASSINATURA][${ts}] ✓ assinatura gerada | folder=${params.folder} timestamp=${params.timestamp}`)
    res.json(params)
  } catch (err) {
    console.error(`[ASSINATURA][${ts}] ✗ ERRO | msg="${err.message}" | code=${err.code}\n${err.stack}`)
    res.status(500).json({ erro: 'Erro ao gerar assinatura de upload' })
  }
})

// Upload server-mediado de UMA mídia (imagem OU vídeo) em STREAMING (phone → API →
// Cloudinary), sem bufferizar o arquivo em memória. Contexto no próprio handler: com token
// válido = autenticado (obra/reparo, aceita vídeo); sem token = pré-auth (cadastro) com
// rate limit + só imagem. Fase 2 — aditivo; nenhum fluxo atual usa esta rota ainda.
router.post('/upload/midia', uploadMidiaStream)

const CLOUDINARY_FOLDERS_PERMITIDAS = new Set([
  'pinturapro/videos',
  'pinturapro/fotos',
  'pinturapro/perfil',
  'pinturapro/verificacao',
])

router.get('/upload/assinatura-cloudinary', autenticar, (req, res) => {
  try {
    const folder = req.query.folder || 'pinturapro/videos'
    if (!CLOUDINARY_FOLDERS_PERMITIDAS.has(folder)) {
      return res.status(400).json({ erro: 'Pasta de upload não permitida' })
    }
    const params = gerarAssinaturaCloudinary(folder)
    res.json(params)
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao gerar assinatura de upload' })
  }
})

// Salva URL de mídia após upload direto ao Cloudinary
router.post('/upload/reparo-url', autenticar, async (req, res) => {
  try {
    const { reparo_id, url, tipo = 'video', ordem = 1 } = req.body
    if (!reparo_id || !url) return res.status(400).json({ erro: 'reparo_id e url são obrigatórios' })
    const reparoOwner = await pool.query(`SELECT criado_por FROM reparos WHERE id = $1`, [reparo_id])
    if (reparoOwner.rows.length === 0 || reparoOwner.rows[0].criado_por !== req.usuario.id) {
      return res.status(403).json({ erro: 'Sem permissão para esta ação' })
    }
    // Idempotente por slot (reparo_id, ordem): um retry após resposta perdida
    // (ex.: Wi-Fi + dados móveis trocando a rota) substitui a mídia em vez de duplicar.
    const result = await pool.query(
      // A mídia SUBSTITUÍDA vai para a fila de órfãs: sem isso, trocar a foto de um slot
      // deixava o arquivo antigo no Cloudinary para sempre — vazamento na edição comum, não
      // só na exclusão. `url IS DISTINCT FROM $3` é obrigatório: reenviar a MESMA url para o
      // mesmo slot apaga e reinsere a linha, e sem o guard enfileiraríamos um arquivo que
      // continua em uso — o cron o apagaria por baixo da mídia viva.
      `WITH del AS (DELETE FROM midias_reparos WHERE reparo_id = $1 AND ordem = $4 RETURNING url, tipo),
            orfas AS (INSERT INTO midias_orfas (url, tipo)
                      SELECT url, tipo FROM del WHERE url IS DISTINCT FROM $3
                      ON CONFLICT (url) DO NOTHING)
       INSERT INTO midias_reparos (reparo_id, tipo, url, ordem) VALUES ($1, $2, $3, $4) RETURNING *`,
      [reparo_id, tipo, url, ordem]
    )
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar mídia' })
  }
})

// Salva URL de mídia de obra após upload direto ao Cloudinary
router.post('/upload/obra-url', autenticar, async (req, res) => {
  try {
    const { obra_id, url, tipo = 'video', ordem = 1 } = req.body
    if (!obra_id || !url) return res.status(400).json({ erro: 'obra_id e url são obrigatórios' })
    const obraOwner = await pool.query(`SELECT criado_por FROM obras WHERE id = $1`, [obra_id])
    if (obraOwner.rows.length === 0 || obraOwner.rows[0].criado_por !== req.usuario.id) {
      return res.status(403).json({ erro: 'Sem permissão para esta ação' })
    }
    // Idempotente por slot (obra_id, ordem): retry após resposta perdida substitui em vez de duplicar.
    const result = await pool.query(
      // Mesmo racional do /upload/reparo-url: mídia substituída vai para a fila de órfãs, e
      // `url IS DISTINCT FROM $3` evita enfileirar um arquivo que está sendo reinserido.
      `WITH del AS (DELETE FROM midias WHERE obra_id = $1 AND ordem = $4 RETURNING url, tipo),
            orfas AS (INSERT INTO midias_orfas (url, tipo)
                      SELECT url, tipo FROM del WHERE url IS DISTINCT FROM $3
                      ON CONFLICT (url) DO NOTHING)
       INSERT INTO midias (obra_id, tipo, url, ordem) VALUES ($1, $2, $3, $4) RETURNING *`,
      [obra_id, tipo, url, ordem]
    )
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar mídia' })
  }
})

// Buscar usuário por e-mail (admin)
router.post('/admin/buscar-usuario', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ erro: 'E-mail obrigatório' })
    const result = await pool.query(
      `SELECT id, nome, email, role FROM usuarios WHERE email = $1`,
      [email.toLowerCase().trim()]
    )
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar usuário' })
  }
})

// Limpar dados de teste (admin) — apaga tudo exceto admins
router.post('/admin/limpar-testes', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // CONTRATOS primeiro — não por FK: candidatura_id é CASCADE (cai sozinho) e
    // interesse_id não tem constraint nenhuma. É para não deixar contratos do fluxo
    // reparo órfãos ao apagar interesse_reparos. Wipe total é correto aqui — esta
    // rotina apaga todos os dados não-admin.
    await client.query(`DELETE FROM contratos`)
    await client.query(`DELETE FROM interesse_reparos`)
    await client.query(enfileirarOrfas(`DELETE FROM midias_reparos RETURNING url, tipo`))
    await client.query(`DELETE FROM reparos`)
    await client.query(`DELETE FROM candidaturas`)
    await client.query(enfileirarOrfas(`DELETE FROM midias RETURNING url, tipo`))
    // mensagens ANTES de obras (mesma ordem do DELETE /usuarios/:id e de limpar-usuarios).
    // Hoje mensagens.obra_id é ON DELETE CASCADE, então a ordem inversa não quebrava; a
    // ordem explícita não depende disso — filho antes do pai vale para as duas FKs.
    await client.query(`DELETE FROM mensagens`)
    await client.query(`DELETE FROM obras`)
    await client.query(`DELETE FROM assinaturas WHERE usuario_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    await client.query(`DELETE FROM localizacoes_prestadores WHERE usuario_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    await client.query(`DELETE FROM prestadores_bloqueados_dono WHERE dono_id IN (SELECT id FROM usuarios WHERE role != 'admin') OR prestador_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    // faltas_profissional.usuario_id é FK SEM CASCADE (ver DDL) — todo profissional que já
    // faltou uma vez estourava 23503 aqui e derrubava a transação inteira, que é o erro real
    // por trás do 500 "Erro ao limpar dados de teste". Escopado a role != 'admin' igual aos
    // DELETEs vizinhos: as faltas de um admin não são dado de teste.
    // perdoada_por não precisa de limpeza (ON DELETE SET NULL).
    await client.query(`DELETE FROM faltas_profissional WHERE usuario_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    await client.query(`DELETE FROM usuarios WHERE role != 'admin'`)
    await client.query('COMMIT')
    res.json({ mensagem: 'Dados de teste removidos com sucesso!' })
  } catch (err) {
    // .catch: se a conexão morreu, o próprio ROLLBACK lança e a resposta 500 nunca sai —
    // o cliente fica pendurado em vez de receber o erro.
    await client.query('ROLLBACK').catch(() => {})
    console.error('Erro ao limpar testes:', err)
    res.status(500).json({ erro: 'Erro ao limpar dados de teste' })
  } finally {
    client.release()
  }
})

// ============================================================
// VERIFICAÇÃO DE PRESTADORES
// ============================================================

// Upload de documentos de verificação (sem autenticação — usuário ainda não tem token)
router.post('/auth/upload-verificacao', upload.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' })
    const resultado = await uploadArquivo(req.file)
    // Retorna apenas a URL — o cadastro vai salvar junto com os dados do usuário
    res.json({ url: resultado.secure_url })
  } catch (err) {
    console.error('Erro upload verificacao:', err)
    res.status(500).json({ erro: 'Erro ao enviar documento' })
  }
})

// Lista prestadores pendentes de verificação (admin)
router.get('/verificacao/pendentes', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.nome, u.email, u.telefone, u.cidade, u.cpf_cnpj,
             u.verificacao_status, u.verificacao_doc_frente_url,
             u.verificacao_doc_verso_url, u.verificacao_selfie_url,
             u.referencias, u.pix_reembolso, u.criado_em,
             u.anos_experiencia, u.tamanho_equipe,
             u.rg, u.rg_orgao, u.rg_estado, u.aprovado_automaticamente,
             a.plano, a.status as assinatura_status
      FROM usuarios u
      LEFT JOIN assinaturas a ON a.usuario_id = u.id
      WHERE u.verificacao_status = 'pendente'
        AND u.role IN ('prestador', 'pintor', 'assinante')
      ORDER BY u.criado_em DESC
    `)
    res.json({ prestadores: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar pendentes' })
  }
})

// Aprovar prestador
router.post('/verificacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { id } = req.params

    const usuario = await pool.query(
      `SELECT nome, email, tipo_prestador, tipo_dono FROM usuarios WHERE id = $1`, [id]
    )
    if (usuario.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })

    // Aprova verificação e ativa assinatura (revisão manual → idoneidade confirmada)
    await pool.query(
      `UPDATE usuarios SET verificacao_status = 'aprovado', aprovado_automaticamente = false WHERE id = $1`, [id]
    )
    await pool.query(
      `UPDATE assinaturas SET status = 'ativa', atualizado_em = NOW(),
        proximo_vencimento = CASE
          WHEN tipo = 'gratuito' THEN NULL
          WHEN plano = 'anual'   THEN GREATEST(proximo_vencimento, NOW() + INTERVAL '365 days')
          ELSE                        GREATEST(proximo_vencimento, NOW() + INTERVAL '30 days') END,
        marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL
       WHERE usuario_id = $1`, [id]
    )

    // Assinatura acabou de virar 'ativa' — derruba o cache para o app não cair na
    // tela de pagamento por causa de um `ativa=false` ainda cacheado (B72-07).
    invalidarCachesUsuario(id)

    // Notifica prestador por e-mail
    const { nome, email } = usuario.rows[0]
    const nodemailer = require('nodemailer')
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: 587, secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
    transporter.sendMail({
      from: `${MARCA} <${process.env.SMTP_USER}>`,
      to: email,
      subject: `✅ ${MARCA} — Cadastro aprovado! Bem-vindo!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #4caf50; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #fff; margin: 0;">✅ Cadastro Aprovado!</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2>Parabéns, ${nome}!</h2>
            <p>Sua identidade foi verificada e seu acesso ao ${MARCA} está liberado.</p>
            <p>Abra o aplicativo e comece a encontrar serviços na sua região agora mesmo!</p>
            <p><strong>Equipe ${MARCA}</strong></p>
          </div>
        </div>
      `
    }).catch(err => console.error('Erro e-mail aprovação:', err))

    // Notificação push
    const pushToken = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [id])
    if (pushToken.rows[0]?.push_token) {
      await enviarPushNotificacao(
        pushToken.rows[0].push_token,
        '✅ Cadastro aprovado!',
        `Sua identidade foi verificada. Bem-vindo ao ${MARCA}!`,
        { tipo: 'verificacao_aprovada' }
      )
    }

    res.json({ mensagem: 'Prestador aprovado com sucesso' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar prestador' })
  }
})

// Reprovar prestador e fazer reembolso via PIX
router.post('/verificacao/:id/reprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { motivo } = req.body

    const usuario = await pool.query(
      `SELECT nome, email, pix_reembolso, tipo_prestador, tipo_dono FROM usuarios WHERE id = $1`, [id]
    )
    if (usuario.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })

    const { nome, email, pix_reembolso } = usuario.rows[0]

    // Reprova e cancela assinatura
    await pool.query(
      `UPDATE usuarios SET verificacao_status = 'reprovado' WHERE id = $1`, [id]
    )
    await pool.query(
      `UPDATE assinaturas SET status = 'cancelada', atualizado_em = NOW() WHERE usuario_id = $1`, [id]
    )

    // Notifica prestador por e-mail com instrução de reembolso
    const nodemailer = require('nodemailer')
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: 587, secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
    transporter.sendMail({
      from: `${MARCA} <${process.env.SMTP_USER}>`,
      to: email,
      subject: `${MARCA} — Informação sobre seu cadastro`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #0a0a0a; margin: 0;">${MARCA}</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2>Olá, ${nome}</h2>
            <p>Após análise, não foi possível aprovar seu cadastro no momento.</p>
            ${motivo ? `<p><strong>Motivo:</strong> ${motivo}</p>` : ''}
            <p style="background: #fff3cd; padding: 16px; border-radius: 8px; border-left: 4px solid #E8833A;">
              <strong>Reembolso:</strong> O valor pago será devolvido para sua chave PIX 
              <strong>${pix_reembolso || 'informada no cadastro'}</strong> em até 5 dias úteis.
            </p>
            <p>Se tiver dúvidas, entre em contato conosco respondendo este e-mail.</p>
            <p><strong>Equipe ${MARCA}</strong></p>
          </div>
        </div>
      `
    }).catch(err => console.error('Erro e-mail reprovação:', err))

    // Notificação push
    const pushToken = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [id])
    if (pushToken.rows[0]?.push_token) {
      await enviarPushNotificacao(
        pushToken.rows[0].push_token,
        '📋 Informação sobre seu cadastro',
        'Acesse seu e-mail para mais detalhes sobre seu cadastro.',
        { tipo: 'verificacao_reprovada' }
      )
    }

    res.json({
      mensagem: 'Prestador reprovado',
      pix_reembolso,
      aviso: `Efetue o reembolso manualmente via PIX para a chave: ${pix_reembolso}`
    })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao reprovar prestador' })
  }
})

// Confirma idoneidade de um prestador que foi auto-aprovado (limpa o flag de revisão pendente).
// Não altera verificacao_status — apenas marca que um admin revisou o cadastro.
router.post('/verificacao/:id/confirmar-idoneidade', autenticar, exigirAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE usuarios SET aprovado_automaticamente = false
       WHERE id = $1 AND verificacao_status = 'aprovado'
       RETURNING id`, [req.params.id]
    )
    if (r.rows.length === 0) return res.status(404).json({ erro: 'Prestador aprovado não encontrado' })
    res.json({ mensagem: 'Idoneidade confirmada' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao confirmar idoneidade' })
  }
})

// Modo automático — liga/desliga aprovação automática
router.get('/verificacao/modo-automatico', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT valor FROM configuracoes WHERE chave = 'aprovacao_automatica'`
    )
    res.json({ ativo: result.rows[0]?.valor === 'true' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar configuração' })
  }
})

router.post('/verificacao/modo-automatico', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { ativo } = req.body
    // Toggle GLOBAL: só um boolean explícito no body é instrução. Antes, chave ausente
    // (ou valor não-boolean) caía no `ativo ? : 'false'` e DESLIGAVA a verificação
    // automática em silêncio, respondendo "desativado" como se tivesse sido pedido.
    // false explícito continua funcionando — a guarda é de tipo, não de truthiness.
    if (typeof ativo !== 'boolean') {
      return res.status(400).json({ erro: 'ativo é obrigatório e deve ser true ou false' })
    }
    await pool.query(
      `UPDATE configuracoes SET valor = $1, atualizado_em = NOW() WHERE chave = 'aprovacao_automatica'`,
      [ativo ? 'true' : 'false']
    )

    // Se ligar modo automático, aprova todos os pendentes agora
    if (ativo) {
      const pendentes = await pool.query(
        `SELECT u.id FROM usuarios u
         JOIN assinaturas a ON a.usuario_id = u.id
         WHERE u.verificacao_status = 'pendente'
           AND a.status = 'pendente_verificacao'`
      )
      let aprovados = 0
      for (const p of pendentes.rows) {
        // CLAIM primeiro (mesmo padrão do cron de timeout em server.js): o
        // `AND status = 'pendente_verificacao'` garante a transição UMA vez só, e o UPDATE de
        // usuarios fica atrás do rowCount. Sem isso, dois toggles simultâneos (ou duas
        // réplicas) reaprovariam o mesmo prestador.
        const claim = await pool.query(`UPDATE assinaturas SET status = 'ativa', atualizado_em = NOW(),
          proximo_vencimento = CASE
            WHEN tipo = 'gratuito' THEN NULL
            WHEN plano = 'anual'   THEN GREATEST(proximo_vencimento, NOW() + INTERVAL '365 days')
            ELSE                        GREATEST(proximo_vencimento, NOW() + INTERVAL '30 days') END,
          marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL
         WHERE usuario_id = $1 AND status = 'pendente_verificacao'
         RETURNING id`, [p.id])
        if (claim.rowCount === 0) continue

        // Aprovação em lote ao ligar o Modo Auto: também é não-revisada → marca automática
        await pool.query(`UPDATE usuarios SET verificacao_status = 'aprovado', aprovado_automaticamente = true WHERE id = $1`, [p.id])
        aprovados++
      }
      console.log(`[Modo automático] ${aprovados} prestadores aprovados automaticamente`)
    }

    res.json({ mensagem: ativo ? 'Modo automático ativado' : 'Modo automático desativado', ativo })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar configuração' })
  }
})

// Aprovação automática de OBRAS — liga/desliga. Espelha o par acima (mesma forma de leitura
// 'true', mesmo corpo { ativo }, mesma resposta). Não colide com /obras-aprovacao/:id/aprovar:
// aquele tem dois segmentos após o prefixo, este tem um.
router.get('/obras-aprovacao/modo-automatico', autenticar, exigirAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT valor FROM configuracoes WHERE chave = 'aprovacao_automatica_obras'`
    )
    res.json({ ativo: result.rows[0]?.valor === 'true' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar configuração' })
  }
})

router.post('/obras-aprovacao/modo-automatico', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { ativo, aprovar_pendentes } = req.body
    // Mesma guarda do toggle de prestadores acima: só boolean explícito é instrução;
    // chave ausente/não-boolean era lida como false e desligava o modo em silêncio.
    if (typeof ativo !== 'boolean') {
      return res.status(400).json({ erro: 'ativo é obrigatório e deve ser true ou false' })
    }
    await pool.query(
      `UPDATE configuracoes SET valor = $1, atualizado_em = NOW() WHERE chave = 'aprovacao_automatica_obras'`,
      [ativo ? 'true' : 'false']
    )

    // Ligar o modo automático só governa obras FUTURAS. A varredura retroativa da fila é
    // OPT-IN por aprovar_pendentes: sem a flag nada é aprovado para trás, que é o
    // comportamento de hoje. Espelha o toggle de prestadores, que aprova os pendentes na
    // ativação — a diferença é que lá a varredura é implícita e aqui é pedida.
    let aprovados = 0
    if (ativo && aprovar_pendentes) {
      const pendentes = await pool.query(
        `SELECT id FROM obras WHERE enviada_por_dono = true AND status_aprovacao = 'pendente'`
      )
      for (const o of pendentes.rows) {
        // aprovarEPublicarObra é a MESMA função da rota de aprovação do admin: mesmo UPDATE,
        // mesmo reinício de publicado_em/expira_em e os mesmos dois avisos. Ela já traz a
        // guarda de idempotência (status_aprovacao <> 'aprovada') e devolve null quando não
        // houve transição, então contar as não-nulas dá o número REAL de aprovações.
        const publicada = await aprovarEPublicarObra(o.id)
        if (publicada) aprovados++
      }
      console.log(`[Modo automático obras] ${aprovados} obra(s) da fila aprovada(s) na ativação`)
    }

    res.json({
      mensagem: ativo ? 'Aprovação automática de obras ativada' : 'Aprovação automática de obras desativada',
      ativo,
      aprovados,
    })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar configuração' })
  }
})

// ============================================================
// JANELA DE LANÇAMENTO GRÁTIS (config em banco — sem Railway)
// ============================================================

// Contas com acesso especial permanente — mesma leitura de EMAILS_ESPECIAIS do cadastro
// (authController). NUNCA entram no backfill: seguem tipo='gratuito' para sempre.
// Env ausente → lista vazia → `<> ALL('{}')` é verdadeiro para todos, ou seja, ninguém é
// excluído, que é o default correto.
const emailsEspeciais = () => (process.env.EMAILS_ESPECIAIS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

// Fim do mês CORRENTE às 23:59:59.999999 em America/Sao_Paulo, como timestamptz.
// Os dois AT TIME ZONE fazem coisas OPOSTAS e é isso que faz a conta fechar num banco UTC:
//   1º (timestamptz → timestamp) TIRA o fuso e devolve o relógio de parede de SP, para o
//      date_trunc contar o mês BRASILEIRO;
//   2º (timestamp → timestamptz) RECOLOCA o fuso e devolve o instante UTC a gravar.
// Sem isso, 31/08 22:00 em SP já é 01/09 01:00 em UTC e o truncamento cairia um mês adiante.
const SQL_FIM_DO_MES_SP = `(
        date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))
        + INTERVAL '1 month' - INTERVAL '1 microsecond'
      ) AT TIME ZONE 'America/Sao_Paulo'`

// Backfill do desligamento da janela: a coorte que entrou grátis passa a ter vencimento real.
// Alvo = tipo='gratuito' COM valor_mensal > 0, que isola os prestadores do lançamento —
// dono_obra e darAcessoGratuito gravam valor_mensal = 0 e seguem grátis para sempre.
// tipo = NULL (e não 'pago'): linha paga nasce com tipo NULL, e é o que faz os três CASE de
// aprovação pararem de forçar proximo_vencimento = NULL. marco_* zerados para os avisos de
// vencimento dispararem para esta coorte.
// Idempotente por construção: depois de rodar, as linhas não casam mais tipo='gratuito'.
const SQL_BACKFILL_LANCAMENTO = `
  UPDATE assinaturas a
     SET proximo_vencimento = ${SQL_FIM_DO_MES_SP},
         tipo          = NULL,
         marco_1_em    = NULL,
         marco_2_em    = NULL,
         marco_3_em    = NULL,
         atualizado_em = NOW()
    FROM usuarios u
   WHERE u.id = a.usuario_id
     AND a.tipo = 'gratuito'
     AND a.valor_mensal > 0
     AND LOWER(u.email) <> ALL($1::text[])
  RETURNING a.usuario_id`

// Status público — a tela de cadastro roda PRÉ-LOGIN, então NÃO exige token.
// Só expõe se a promoção está ativa e até quando (não-sensível).
router.get('/config/lancamento', async (req, res) => {
  try {
    const r = await pool.query(`SELECT valor FROM configuracoes WHERE chave = 'lancamento_data_fim'`)
    const valor = r.rows[0]?.valor || null
    res.json({ gratis: !!valor && new Date(valor) > new Date(), data_fim: valor })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar janela de lançamento' })
  }
})

// Admin liga/estende/desliga a janela. data_fim = ISO futuro liga/estende; null desliga.
// DESLIGAR é porta de mão única: roda o backfill da coorte na MESMA transação do flag —
// ou os dois entram, ou nenhum. Sem isso a janela desligava e a coorte seguia grátis para
// sempre, que é o defeito que este endpoint fecha. GET /config/lancamento/previa devolve a
// contagem antes, para o painel confirmar com o número na tela.
router.post('/config/lancamento', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    const { data_fim } = req.body
    // Desligar é porta de mão única (backfill irreversível), então só uma instrução
    // EXPLÍCITA no body pode disparar: a chave data_fim PRESENTE com null ou ''.
    // Chave ausente (body malformado, campo renomeado) não é instrução — antes ela
    // caía no mesmo caminho do null e desligava a janela com backfill e tudo.
    if (!Object.prototype.hasOwnProperty.call(req.body, 'data_fim')) {
      return res.status(400).json({ erro: 'Nenhum campo para atualizar — envie data_fim (data ISO para ligar/estender, null para desligar)' })
    }
    // valor é NOT NULL na tabela: usar '' (não null) como estado "desligado" para
    // nunca violar a constraint. Downstream trata '' e ausência como janela off.
    let valor = ''
    if (data_fim !== null && data_fim !== '') {
      const d = new Date(data_fim)
      if (isNaN(d.getTime())) return res.status(400).json({ erro: 'data_fim inválida — use uma data ISO válida ou null para desligar' })
      valor = d.toISOString()
    }
    const desligando = valor === ''

    await client.query('BEGIN')
    await client.query(
      `UPDATE configuracoes SET valor = $1, atualizado_em = NOW() WHERE chave = 'lancamento_data_fim'`,
      [valor]
    )

    let afetados = 0
    if (desligando) {
      const backfill = await client.query(SQL_BACKFILL_LANCAMENTO, [emailsEspeciais()])
      afetados = backfill.rowCount
      // Trilha de auditoria em UMA linha: porta de mão única, então os ids afetados precisam
      // ficar registrados. Só usuario_id (nada de e-mail/CPF).
      console.log(`[Lancamento] janela DESLIGADA | backfill afetou ${afetados} assinatura(s) | usuario_ids: ${backfill.rows.map(r => r.usuario_id).join(',') || '(nenhum)'}`)
    }

    await client.query('COMMIT')
    res.json({ data_fim: valor || null, gratis: !!valor && new Date(valor) > new Date(), afetados })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[Lancamento] Erro ao atualizar janela:', err.message)
    res.status(500).json({ erro: 'Erro ao atualizar janela de lançamento' })
  } finally {
    client.release()
  }
})

// Prévia do desligamento — MESMO predicado do backfill, para o número da tela bater com o
// que o POST vai fazer. Admin-only de propósito: o GET público acima expõe só se a promo
// está ativa; tamanho de coorte é dado de negócio.
router.get('/config/lancamento/previa', autenticar, exigirAdmin, async (req, res) => {
  try {
    const especiais = emailsEspeciais()
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE a.tipo = 'gratuito' AND a.valor_mensal > 0
                           AND LOWER(u.email) <> ALL($1::text[]))::int AS afetados,
        COUNT(*) FILTER (WHERE a.tipo = 'gratuito' AND a.valor_mensal > 0
                           AND LOWER(u.email) = ANY($1::text[]))::int  AS especiais_preservados,
        COUNT(*) FILTER (WHERE a.tipo = 'gratuito'
                           AND COALESCE(a.valor_mensal, 0) = 0)::int   AS gratuitos_permanentes,
        ${SQL_FIM_DO_MES_SP} AS data_alvo
      FROM assinaturas a
      JOIN usuarios u ON u.id = a.usuario_id
    `, [especiais])
    res.json(r.rows[0])
  } catch (err) {
    console.error('[Lancamento] Erro na prévia:', err.message)
    res.status(500).json({ erro: 'Erro ao calcular prévia do desligamento' })
  }
})

// Teto de demandas simultâneas para dono sem histórico. Espelha os demais pares de config
// (admin, leitura direta da chave). O GET devolve o teto EFETIVO — passa pelo mesmo
// lerLimiteDemandas da checagem, então painel e regra nunca divergem.
router.get('/config/limite-demandas', autenticar, exigirAdmin, async (req, res) => {
  try {
    res.json({ limite: await lerLimiteDemandas() })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar limite de demandas' })
  }
})

// Admin ajusta o teto. Só inteiro positivo: os demais valores cairiam no padrão em silêncio.
router.post('/config/limite-demandas', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { limite } = req.body
    const n = Number(limite)
    if (!Number.isInteger(n) || n <= 0) {
      return res.status(400).json({ erro: 'limite inválido — use um número inteiro positivo' })
    }
    await pool.query(
      `UPDATE configuracoes SET valor = $1, atualizado_em = NOW() WHERE chave = 'limite_demandas_live_sem_historico'`,
      [String(n)]
    )
    res.json({ mensagem: 'Limite de demandas atualizado', limite: n })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar limite de demandas' })
  }
})

// ============================================================
// LOCALIZAÇÃO DE PRESTADORES
// ============================================================

// Prestador envia sua localização atual
router.post('/prestadores/localizacao', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'prestador') {
      return res.status(403).json({ erro: 'Apenas prestadores enviam localização' })
    }
    const { latitude, longitude } = req.body
    if (!latitude || !longitude) return res.status(400).json({ erro: 'Latitude e longitude são obrigatórios' })

    await pool.query(
      `INSERT INTO localizacoes_prestadores (usuario_id, latitude, longitude, atualizado_em)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (usuario_id) DO UPDATE SET latitude = $2, longitude = $3, atualizado_em = NOW()`,
      [req.usuario.id, latitude, longitude]
    )
    res.json({ mensagem: 'Localização atualizada' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar localização' })
  }
})

// ============================================================
// UPLOAD
// ============================================================
router.post('/upload',      autenticar, exigirAdmin, upload.single('arquivo'), uploadMidia)
router.post('/upload/dono', autenticar,              upload.single('arquivo'), uploadMidia)

// ============================================================
// CANDIDATURAS
// ============================================================
router.post('/candidaturas', autenticar, exigirAssinaturaAtiva, async (req, res) => {
  try {
    const { obra_id, referencias, valor_oferta, mensagem_oferta } = req.body
    const obraResult = await pool.query(`SELECT id, titulo, status FROM obras WHERE id = $1 AND status = 'aberta'`, [obra_id])
    if (obraResult.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada ou não está disponível' })
    const existente = await pool.query(`SELECT id FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2`, [obra_id, req.usuario.id])
    if (existente.rows.length > 0) return res.status(409).json({ erro: 'Você já demonstrou interesse nesta obra' })
    const result = await pool.query(
      `INSERT INTO candidaturas (obra_id, usuario_id, referencias, valor_oferta, mensagem_oferta, status)
       VALUES ($1, $2, $3, $4, $5, 'pendente') RETURNING *`,
      [obra_id, req.usuario.id, referencias, valor_oferta || null, mensagem_oferta || null]
    )
    const dono = await pool.query(
      `SELECT u.push_token, o.titulo FROM obras o JOIN usuarios u ON o.criado_por = u.id WHERE o.id = $1`,
      [obra_id]
    )
    if (dono.rows[0]?.push_token) {
      const temOferta = valor_oferta && valor_oferta > 0
      await enviarPushNotificacao(
        dono.rows[0].push_token,
        temOferta ? '🎨 Nova contra-oferta recebida!' : '👀 Novo interesse na sua obra!',
        temOferta
          ? `Um pintor fez uma oferta de R$ ${Number(valor_oferta).toLocaleString('pt-BR')} para "${dono.rows[0].titulo}"`
          : `Um pintor demonstrou interesse em "${dono.rows[0].titulo}"`,
        { tipo: 'nova_candidatura', obra_id }
      )
    }
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('Erro ao candidatar:', err)
    res.status(500).json({ erro: 'Erro ao registrar candidatura' })
  }
})

router.get('/candidaturas/minhas',        autenticar, candidaturasCtrl.minhas)
router.get('/candidaturas/pendentes',     autenticar, exigirAdmin, candidaturasCtrl.pendentes)
router.get('/candidaturas/obra/:obra_id', autenticar, candidaturasCtrl.porObra)
router.post('/candidaturas/:id/aprovar',  autenticar, candidaturasCtrl.aprovar)
router.post('/candidaturas/:id/recusar',  autenticar, candidaturasCtrl.recusar)

// AVALIAÇÕES — sistema bilateral 5 estrelas no encerramento do contrato.
// Rotas estáticas ('/avaliacoes', '/avaliacoes/media/:usuario_id') não conflitam com
// nenhum padrão /:id, mas seguem a convenção de registro dedicado como meus-contratos.

// POST /avaliacoes — só o dono do contrato avalia o prestador do match (unilateral).
router.post('/avaliacoes', autenticar, async (req, res) => {
  try {
    const { contrato_tipo, contrato_id, estrelas } = req.body

    if (!['reparo', 'obra'].includes(contrato_tipo)) {
      return res.status(400).json({ erro: 'contrato_tipo deve ser reparo ou obra' })
    }
    const estrelasInt = parseInt(estrelas)
    if (!estrelasInt || estrelasInt < 1 || estrelasInt > 5) {
      return res.status(400).json({ erro: 'estrelas deve ser um número de 1 a 5' })
    }
    if (!contrato_id) {
      return res.status(400).json({ erro: 'contrato_id é obrigatório' })
    }

    // contrato_tipo já validado contra whitelist acima — interpolação de tabela é segura.
    const tabela = contrato_tipo === 'reparo' ? 'reparos' : 'obras'
    const contrato = await pool.query(
      `SELECT criado_por, match_usuario_id, status FROM ${tabela} WHERE id = $1`,
      [contrato_id]
    )
    if (contrato.rows.length === 0) return res.status(404).json({ erro: 'Contrato não encontrado' })

    const c = contrato.rows[0]
    if (c.status !== 'encerrada') {
      return res.status(400).json({ erro: 'Só é possível avaliar contratos encerrados' })
    }
    if (!c.match_usuario_id) {
      return res.status(400).json({ erro: 'Este contrato não teve prestador vinculado' })
    }

    // Avaliação é UNILATERAL: só o dono do contrato (criado_por) avalia o prestador do
    // match. O prestador continua participante para todo o resto, mas não avalia de volta.
    // Ordem das branches preserva a precedência do dono caso uid seja os dois lados.
    const uid = req.usuario.id
    let avaliado_id
    if (uid === c.criado_por) {
      avaliado_id = c.match_usuario_id       // dono avalia prestador
    } else if (uid === c.match_usuario_id) {
      return res.status(403).json({ erro: 'Apenas o dono do contrato pode avaliar' })
    } else {
      return res.status(403).json({ erro: 'Você não participou deste contrato' })
    }

    const result = await pool.query(
      `INSERT INTO avaliacoes (contrato_tipo, contrato_id, avaliador_id, avaliado_id, estrelas)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (contrato_tipo, contrato_id, avaliador_id) DO NOTHING
       RETURNING id`,
      [contrato_tipo, contrato_id, uid, avaliado_id, estrelasInt]
    )
    if (result.rows.length === 0) {
      return res.status(409).json({ erro: 'Você já avaliou este contrato' })
    }

    res.status(201).json({ mensagem: 'Avaliação registrada!', id: result.rows[0].id })
  } catch (err) {
    console.error('[Avaliacoes] Erro:', err.message)
    res.status(500).json({ erro: 'Erro ao registrar avaliação' })
  }
})

// POST /avaliacoes/dispensar — o dono declara que NÃO vai avaliar este contrato, e o
// lembrete do job (lembrarAvaliacaoPendente, server.js) para de vez.
// Existe porque a recusa só era guardada NO DISPOSITIVO: o servidor não sabia dela, então o
// push cutucaria quem já tinha dito não — e uma reinstalação (ou um segundo aparelho)
// ressuscitaria o card. Agora a escolha é do CONTRATO, não do aparelho.
// Rota estática registrada depois de POST /avaliacoes e sem colisão com ela.
// Escopo: só o dono (criado_por). O prestador não avalia (POST /avaliacoes lhe dá 403), então
// também não tem o que dispensar — mesmas branches, mesma precedência, mesmos códigos.
router.post('/avaliacoes/dispensar', autenticar, async (req, res) => {
  try {
    const { contrato_tipo, contrato_id } = req.body

    if (!['reparo', 'obra'].includes(contrato_tipo)) {
      return res.status(400).json({ erro: 'contrato_tipo deve ser reparo ou obra' })
    }
    if (!contrato_id) {
      return res.status(400).json({ erro: 'contrato_id é obrigatório' })
    }

    // contrato_tipo já validado contra whitelist acima — interpolação de tabela é segura.
    const tabela = contrato_tipo === 'reparo' ? 'reparos' : 'obras'

    // Ownership NO PRÓPRIO UPDATE (criado_por = $2), não numa checagem separada antes: o
    // handler não tem por que ler a linha duas vezes, e o RETURNING já diz se pegou.
    // aval_dispensada_em IS NULL preserva o PRIMEIRO timestamp — chamar de novo é no-op, não
    // um carimbo novo. Sem status/match no WHERE de propósito: dispensar é sempre seguro, e
    // amarrar a dispensa ao estado do contrato só criaria um caminho em que o dono clica
    // "não quero" e mesmo assim continua elegível.
    const upd = await pool.query(
      `UPDATE ${tabela} SET aval_dispensada_em = NOW()
        WHERE id = $1 AND criado_por = $2 AND aval_dispensada_em IS NULL
       RETURNING id`,
      [contrato_id, req.usuario.id]
    )
    if (upd.rowCount > 0) {
      return res.json({ mensagem: 'Lembrete de avaliação dispensado.', dispensada: true })
    }

    // rowCount 0 tem três causas — separadas aqui para não devolver 404 a quem só repetiu a
    // chamada. Uma leitura só, e apenas neste caminho frio.
    const c = await pool.query(`SELECT criado_por, aval_dispensada_em FROM ${tabela} WHERE id = $1`, [contrato_id])
    if (c.rows.length === 0) return res.status(404).json({ erro: 'Contrato não encontrado' })
    if (c.rows[0].criado_por !== req.usuario.id) {
      return res.status(403).json({ erro: 'Apenas o dono do contrato pode dispensar a avaliação' })
    }
    // Já dispensado antes: idempotente, 200 — repetir a recusa não é erro.
    res.json({ mensagem: 'Lembrete de avaliação já estava dispensado.', dispensada: true })
  } catch (err) {
    console.error('[Avaliacoes] Erro ao dispensar:', err.message)
    res.status(500).json({ erro: 'Erro ao dispensar lembrete de avaliação' })
  }
})

// GET /avaliacoes/media/:usuario_id — média e total de estrelas recebidas por um usuário.
router.get('/avaliacoes/media/:usuario_id', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total, COALESCE(ROUND(AVG(estrelas)::numeric, 1), 0) AS media
       FROM avaliacoes WHERE avaliado_id = $1`,
      [req.params.usuario_id]
    )
    res.json({ total: result.rows[0].total, media: parseFloat(result.rows[0].media) })
  } catch (err) {
    console.error('[Avaliacoes] Erro média:', err.message)
    res.status(500).json({ erro: 'Erro ao buscar avaliações' })
  }
})

// GET /avaliacoes/recebidas — resumo das avaliações RECEBIDAS pelo usuário autenticado
// (avaliado_id = req.usuario.id): média, total e a distribuição por estrela. Não devolve mais
// as avaliações uma a uma — nada do avaliador jamais foi exposto aqui, e agora nem a linha
// individual é; só contagens agregadas. Rota estática — registrada depois de
// '/avaliacoes/media/:usuario_id' e não colide com ela (segmento 'recebidas' != 'media').
router.get('/avaliacoes/recebidas', autenticar, async (req, res) => {
  try {
    const uid = req.usuario.id

    // Resumo (média + total + distribuição): computado on-read — não há coluna cacheada em
    // usuarios. media/total seguem idênticos a GET /avaliacoes/media/:usuario_id acima (mesmo
    // ROUND para 1 casa, mesmo COALESCE 0 para quem ainda não tem avaliação).
    // Query ÚNICA: os cinco contadores são agregados condicionais na MESMA linha de
    // total/media — o FILTER percorre as linhas já varridas pelo COUNT/AVG, sem I/O extra e
    // sem uma segunda ida ao banco (índice avaliacoes_avaliado_idx cobre o WHERE).
    // COUNT(*) FILTER nunca é NULL — é 0 quando nada casa —, então as cinco chaves existem
    // sempre, zero-preenchidas. Somam total porque estrelas é INTEGER NOT NULL
    // CHECK (estrelas BETWEEN 1 AND 5): não há bucket possível fora de 1..5, nem NULL.
    const resumo = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(ROUND(AVG(estrelas)::numeric, 1), 0) AS media,
              COUNT(*) FILTER (WHERE estrelas = 1)::int AS e1,
              COUNT(*) FILTER (WHERE estrelas = 2)::int AS e2,
              COUNT(*) FILTER (WHERE estrelas = 3)::int AS e3,
              COUNT(*) FILTER (WHERE estrelas = 4)::int AS e4,
              COUNT(*) FILTER (WHERE estrelas = 5)::int AS e5
       FROM avaliacoes WHERE avaliado_id = $1`,
      [uid]
    )

    // Agregado sem GROUP BY sempre devolve exatamente uma linha, inclusive para quem não tem
    // nenhuma avaliação (total 0, media 0, cinco contadores 0) — rows[0] nunca é undefined.
    const r = resumo.rows[0]
    res.json({
      media: parseFloat(r.media),
      total: r.total,
      distribuicao: { '1': r.e1, '2': r.e2, '3': r.e3, '4': r.e4, '5': r.e5 }
    })
  } catch (err) {
    console.error('[Avaliacoes] Erro recebidas:', err.message)
    res.status(500).json({ erro: 'Erro ao buscar avaliações recebidas' })
  }
})

// DENÚNCIAS — o prestador do match denuncia o dono de um contrato encerrado.
// Rota estática ('/denuncias'), sem conflito com padrões /:id, mesma convenção de
// registro dedicado usada por avaliacoes.
const CATEGORIAS_DENUNCIA = ['nao_pagamento', 'nao_compareceu', 'servico_diferente', 'assedio', 'local_inseguro', 'fraude', 'outro']
const DESCRICAO_DENUNCIA_MAX = 2000

// POST /denuncias — UNILATERAL e espelhada em POST /avaliacoes: lá só o dono avalia o
// prestador, aqui só o prestador do match denuncia o dono.
router.post('/denuncias', autenticar, async (req, res) => {
  try {
    const { contrato_tipo, contrato_id, categoria, descricao } = req.body

    if (!['reparo', 'obra'].includes(contrato_tipo)) {
      return res.status(400).json({ erro: 'contrato_tipo deve ser reparo ou obra' })
    }
    if (!contrato_id) {
      return res.status(400).json({ erro: 'contrato_id é obrigatório' })
    }
    if (!CATEGORIAS_DENUNCIA.includes(categoria)) {
      return res.status(400).json({ erro: `categoria deve ser uma de: ${CATEGORIAS_DENUNCIA.join(', ')}` })
    }
    // Texto livre é o único campo aberto da tabela: exigir conteúdo e limitar tamanho aqui,
    // já que o CHECK da coluna só garante NOT NULL.
    const texto = typeof descricao === 'string' ? descricao.trim() : ''
    if (!texto) {
      return res.status(400).json({ erro: 'descricao é obrigatória' })
    }
    if (texto.length > DESCRICAO_DENUNCIA_MAX) {
      return res.status(400).json({ erro: `descricao deve ter no máximo ${DESCRICAO_DENUNCIA_MAX} caracteres` })
    }

    // contrato_tipo já validado contra whitelist acima — interpolação de tabela é segura.
    const tabela = contrato_tipo === 'reparo' ? 'reparos' : 'obras'
    const contrato = await pool.query(
      `SELECT criado_por, match_usuario_id, status FROM ${tabela} WHERE id = $1`,
      [contrato_id]
    )
    if (contrato.rows.length === 0) return res.status(404).json({ erro: 'Contrato não encontrado' })

    const c = contrato.rows[0]
    if (c.status !== 'encerrada') {
      return res.status(400).json({ erro: 'Só é possível denunciar contratos encerrados' })
    }
    if (!c.match_usuario_id) {
      return res.status(400).json({ erro: 'Este contrato não teve prestador vinculado' })
    }

    // Inverso da avaliação: só o prestador do match denuncia, e o denunciado é o dono.
    const uid = req.usuario.id
    if (uid !== c.match_usuario_id) {
      if (uid === c.criado_por) {
        return res.status(403).json({ erro: 'Apenas o profissional do contrato pode denunciar' })
      }
      return res.status(403).json({ erro: 'Você não participou deste contrato' })
    }

    const result = await pool.query(
      `INSERT INTO denuncias (contrato_tipo, contrato_id, denunciante_id, denunciado_id, categoria, descricao)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (contrato_tipo, contrato_id, denunciante_id) DO NOTHING
       RETURNING id`,
      [contrato_tipo, contrato_id, uid, c.criado_por, categoria, texto]
    )
    if (result.rows.length === 0) {
      return res.status(409).json({ erro: 'Você já denunciou este contrato' })
    }

    res.status(201).json({ mensagem: 'Denúncia registrada. Nossa equipe vai analisar.', id: result.rows[0].id })
  } catch (err) {
    console.error('[Denuncias] Erro:', err.message)
    res.status(500).json({ erro: 'Erro ao registrar denúncia' })
  }
})

// SUGESTÕES — caixa de sugestões do usuário sobre o app.

const TEXTO_SUGESTAO_MAX = 2000

// POST /sugestoes — registra uma sugestão do usuário autenticado.
// Autenticada com `autenticar`, o MESMO middleware de POST /denuncias: o autor sai de
// req.usuario.id e nunca do corpo, então não há como sugerir em nome de outro.
router.post('/sugestoes', autenticar, async (req, res) => {
  try {
    const { texto } = req.body
    // texto é o único campo, e é livre: exigir conteúdo e limitar tamanho aqui, já que a
    // coluna só garante NOT NULL (mesma checagem que descricao recebe em /denuncias).
    const conteudo = typeof texto === 'string' ? texto.trim() : ''
    if (!conteudo) {
      return res.status(400).json({ erro: 'texto é obrigatório' })
    }
    if (conteudo.length > TEXTO_SUGESTAO_MAX) {
      return res.status(400).json({ erro: `texto deve ter no máximo ${TEXTO_SUGESTAO_MAX} caracteres` })
    }

    const result = await pool.query(
      `INSERT INTO sugestoes (usuario_id, texto) VALUES ($1, $2) RETURNING id`,
      [req.usuario.id, conteudo]
    )

    res.status(201).json({ mensagem: 'Sugestão registrada. Obrigado!', id: result.rows[0].id })
  } catch (err) {
    console.error('[Sugestoes] Erro:', err.message)
    res.status(500).json({ erro: 'Erro ao registrar sugestão' })
  }
})

// FEED — visualizações de proximidade. Rota estática ('/feed/visualizacoes'), sem
// conflito com padrões /:id, seguindo a convenção de registro dedicado como avaliacoes.

// POST /feed/visualizacoes — registra em lote os itens vistos no feed (sem interesse).
router.post('/feed/visualizacoes', autenticar, async (req, res) => {
  try {
    const { itens } = req.body
    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ erro: 'itens deve ser um array não-vazio' })
    }
    if (itens.length > 50) {
      return res.status(400).json({ erro: 'Máximo de 50 itens por chamada' })
    }

    // Filtra ANTES de montar o lote: item inválido é ignorado em silêncio (era o `continue`
    // do laço), nunca vira erro. Dois arrays paralelos para o unnest lá embaixo.
    const tipos = []
    const ids = []
    for (const item of itens) {
      if (!item || !['reparo', 'obra'].includes(item.tipo) || !item.id) continue
      tipos.push(item.tipo)
      ids.push(item.id)
    }
    if (tipos.length === 0) return res.json({ registrados: 0 })

    // UM statement no lugar de um INSERT por item — eram até 50 round trips por chamada.
    // unnest() casa os dois arrays em linhas; rowCount conta só o que ENTROU de fato, então
    // `registrados` mantém exatamente o significado do laço (visualizações novas, sem as
    // repetidas). ON CONFLICT DO NOTHING também absorve duplicata DENTRO do mesmo lote:
    // a primeira entra e as repetidas são ignoradas, igual ao laço item a item.
    const result = await pool.query(
      `INSERT INTO feed_visualizacoes (usuario_id, item_tipo, item_id)
       SELECT $1, t.tipo, t.id
         FROM unnest($2::text[], $3::uuid[]) AS t(tipo, id)
       ON CONFLICT (usuario_id, item_tipo, item_id) DO NOTHING`,
      [req.usuario.id, tipos, ids]
    )

    res.json({ registrados: result.rowCount })
  } catch (err) {
    console.error('[FeedVisualizacoes] Erro:', err.message)
    res.status(500).json({ erro: 'Erro ao registrar visualizações' })
  }
})

// POST /feed/checar-proximidade — chamado na abertura do app com a localização AO VIVO.
// Redesenho: dispara sobre reparos ARMADOS (aberturas_detalhe.notificado=false — o reparador
// abriu o detalhe estando a >5km do cadastro), NÃO sobre impressões de feed. Reparadores +
// reparos apenas (gate exigirReparador, estrito tipo_prestador='reparador'). Quando a posição
// ao vivo chega a <5km de um reparo armado, envia UM push (o mais próximo) e marca notificado
// via CLAIM ATÔMICO. One-time por reparo, para sempre.
router.post('/feed/checar-proximidade', autenticar, exigirNaoSuspenso, exigirPrestador, exigirReparador, async (req, res) => {
  try {
    const { latitude, longitude } = req.body
    const lat = parseFloat(latitude)
    const lng = parseFloat(longitude)
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ erro: 'latitude e longitude são obrigatórios' })
    }

    const RAIO_KM = 5
    const RAIO_GRAUS = RAIO_KM / 111

    // Reparos ARMADOS não notificados: reparo válido (aberta/aprovada/não expirado/sem match/
    // com coords — mesma validade da checagem anterior e do cron server.js:152-161), dentro do
    // bbox da posição ao vivo, e sem engajamento (interesse_reparos). Obras removidas — só reparos.
    const reparos = await pool.query(
      `SELECT r.id, r.titulo, r.latitude, r.longitude
       FROM aberturas_detalhe ad
       JOIN reparos r ON r.id = ad.reparo_id
       WHERE ad.reparador_id = $1 AND ad.notificado = false
         AND r.status = 'aberta' AND r.status_aprovacao = 'aprovada'
         AND r.expira_em > NOW() AND r.match_usuario_id IS NULL
         AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL
         AND ABS(r.latitude - $2) < $4 AND ABS(r.longitude - $3) < $4
         AND NOT ($1::uuid = ANY(COALESCE(r.prestadores_bloqueados, '{}')))
         AND NOT EXISTS (
           SELECT 1 FROM interesse_reparos ir WHERE ir.reparo_id = r.id AND ir.usuario_id = $1
         )`,
      [req.usuario.id, lat, lng, RAIO_GRAUS]
    )

    // Distância planar exata (mesma fórmula de verificarPrestadoresProximos server.js:183-185).
    const candidatos = reparos.rows
      .map(item => {
        const dLat = Math.abs(lat - item.latitude) * 111
        const dLon = Math.abs(lng - item.longitude) * 111 * Math.cos(lat * Math.PI / 180)
        return { ...item, distanciaKm: Math.sqrt(dLat * dLat + dLon * dLon) }
      })
      .filter(item => item.distanciaKm <= RAIO_KM)
      .sort((a, b) => a.distanciaKm - b.distanciaKm)

    if (candidatos.length === 0) return res.json({ notificado: false })

    // Só o mais próximo por chamada — evita spam de push na abertura do app.
    const alvo = candidatos[0]

    // CLAIM ATÔMICO (replica-safe): concede o envio só se a linha ainda está notificado=false.
    // Réplicas do cron / chamadas concorrentes de app-open competem pela mesma linha — só uma
    // vence (RETURNING). Sem linha retornada → outra já notificou → não envia.
    const claim = await pool.query(
      `UPDATE aberturas_detalhe SET notificado = true
       WHERE reparador_id = $1 AND reparo_id = $2 AND notificado = false
       RETURNING reparo_id`,
      [req.usuario.id, alvo.id]
    )
    if (claim.rowCount === 0) return res.json({ notificado: false })

    const tokenResult = await pool.query(
      `SELECT push_token FROM usuarios WHERE id = $1`,
      [req.usuario.id]
    )
    const pushToken = tokenResult.rows[0]?.push_token
    if (pushToken) {
      const kmTexto = alvo.distanciaKm < 1 ? 'menos de 1 km' : `${alvo.distanciaKm.toFixed(1)} km`
      enviarPushNotificacao(
        pushToken,
        '📍 Oportunidade perto de você!',
        `"${alvo.titulo}" está a ${kmTexto} de onde você está agora. Que tal dar uma olhada?`,
        { tipo: 'reparo_proximo', reparo_id: alvo.id }
      ).catch(() => {})
    }

    res.json({ notificado: true, item: { tipo: 'reparo', id: alvo.id, titulo: alvo.titulo, distancia_km: Number(alvo.distanciaKm.toFixed(1)) } })
  } catch (err) {
    console.error('[ChecarProximidade] Erro:', err.message)
    res.status(500).json({ erro: 'Erro ao checar proximidade' })
  }
})

// ============================================================
// MENSAGENS
// ============================================================
router.post('/mensagens',                 autenticar, exigirAssinaturaAtiva, mensagensCtrl.enviar)
router.get('/mensagens/obra/:obra_id',    autenticar, mensagensCtrl.porObra)
router.get('/mensagens/pendentes',        autenticar, exigirAdmin, mensagensCtrl.pendentes)
router.post('/mensagens/:id/responder',   autenticar, exigirAdmin, mensagensCtrl.responder)

// ============================================================
// PAGAMENTOS
// ============================================================
router.post('/pagamentos/criar-assinatura',   autenticar, pagamentoCtrl.criarAssinatura)
router.post('/pagamentos/webhook-pagbank',    pagamentoCtrl.webhookPagbank)
router.get('/pagamentos/sucesso',             pagamentoCtrl.sucesso)
router.get('/pagamentos/falha',               (req, res) => res.redirect('https://pinturapro-painel-production.up.railway.app'))
router.get('/pagamentos/pendente',            (req, res) => res.redirect('https://pinturapro-painel-production.up.railway.app'))
router.post('/pagamentos/acesso-gratuito',    autenticar, exigirAdmin, pagamentoCtrl.darAcessoGratuito)
router.get('/pagamentos/assinantes',          autenticar, exigirAdmin, pagamentoCtrl.listarAssinantes)

// ============================================================
// DASHBOARD
// ============================================================
router.get('/dashboard', autenticar, exigirAdmin, async (req, res) => {
  try {
    const [obras, assinaturas, candidaturas, obrasAprovacao, reparosAprovacao, reparos, mensagensPendentes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM obras WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()`),
      // Métricas de assinaturas em uma única passagem:
      // - ativos: todas as assinaturas ativas
      // - gratuitos: ativas marcadas como gratuito OU sem valor mensal
      // - receita: soma do valor_mensal apenas dos pagantes (exclui gratuitos e valor 0)
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'ativa') AS ativos,
          COUNT(*) FILTER (WHERE status = 'ativa' AND (tipo = 'gratuito' OR valor_mensal = 0)) AS gratuitos,
          COALESCE(SUM(valor_mensal) FILTER (
            WHERE status = 'ativa' AND tipo IS DISTINCT FROM 'gratuito' AND valor_mensal > 0
          ), 0) AS receita
        FROM assinaturas
      `),
      pool.query(`SELECT COUNT(*) FROM candidaturas WHERE status = 'pendente'`),
      pool.query(`SELECT COUNT(*) FROM obras WHERE enviada_por_dono = true AND status_aprovacao = 'pendente'`),
      pool.query(`SELECT COUNT(*) FROM reparos WHERE status_aprovacao = 'pendente'`),
      pool.query(`SELECT COUNT(*) FROM reparos WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()`),
      pool.query(`SELECT COUNT(*) FROM mensagens WHERE respondido = false`)
    ])
    const assinRow = assinaturas.rows[0]
    res.json({
      obras_abertas: parseInt(obras.rows[0].count),
      reparos_abertos: parseInt(reparos.rows[0].count),
      assinantes_ativos: parseInt(assinRow.ativos),
      assinantes_gratuitos: parseInt(assinRow.gratuitos),
      receita_mensal: parseFloat(assinRow.receita),
      candidaturas_pendentes: parseInt(candidaturas.rows[0].count),
      obras_para_aprovar: parseInt(obrasAprovacao.rows[0].count),
      reparos_para_aprovar: parseInt(reparosAprovacao.rows[0].count),
      mensagens_pendentes: parseInt(mensagensPendentes.rows[0].count)
    })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar métricas' })
  }
})

// Health check
router.get('/health', (req, res) => res.json({ status: 'ok', versao: '1.0.0' }))

// ============================================================
// ADMIN — LIMPEZA SELETIVA
// ============================================================
router.post('/admin/limpar-usuarios', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // IDs dos usuários alvo (todos exceto admin) — base do cascade abaixo
    const alvos = await client.query(`SELECT id FROM usuarios WHERE role != 'admin'`)
    const ids = alvos.rows.map(r => r.id)
    await client.query(`DELETE FROM assinaturas WHERE usuario_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    await client.query(`DELETE FROM localizacoes_prestadores WHERE usuario_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    // Cascade das obras criadas pelos usuários alvo (filho antes do pai; mensagens
    // antes de obras por causa da FK mensagens.obra_id)
    await client.query(`DELETE FROM mensagens WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = ANY($1))`, [ids])
    await client.query(enfileirarOrfas(`DELETE FROM midias WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = ANY($1)) RETURNING url, tipo`), [ids])
    // CONTRATOS primeiro — não por FK: candidatura_id é CASCADE e interesse_id não tem
    // constraint. É para não deixar contratos do fluxo reparo órfãos ao apagar os
    // interesse_reparos logo abaixo.
    // Escopado aos usuários alvo (mesma cobertura do passo 0 de limpar-teste.js):
    // prestador (candidaturas/interesse_reparos.usuario_id) e dono (via
    // obras.criado_por / reparos.criado_por). Contratos entre admins não são tocados.
    await client.query(`
      DELETE FROM contratos
       WHERE candidatura_id IN (
               SELECT c.id FROM candidaturas c
                WHERE c.usuario_id = ANY($1)
                   OR c.obra_id IN (SELECT id FROM obras WHERE criado_por = ANY($1))
             )
          OR interesse_id IN (
               SELECT ir.id FROM interesse_reparos ir
                WHERE ir.usuario_id = ANY($1)
                   OR ir.reparo_id IN (SELECT id FROM reparos WHERE criado_por = ANY($1))
             )
    `, [ids])
    await client.query(`DELETE FROM candidaturas WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = ANY($1))`, [ids])
    await client.query(`DELETE FROM obras WHERE criado_por = ANY($1)`, [ids])
    // Cascade dos reparos criados pelos usuários alvo
    await client.query(enfileirarOrfas(`DELETE FROM midias_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por = ANY($1)) RETURNING url, tipo`), [ids])
    await client.query(`DELETE FROM interesse_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por = ANY($1))`, [ids])
    await client.query(`DELETE FROM reparos WHERE criado_por = ANY($1)`, [ids])
    // Registros dos usuários alvo como participantes (candidato/interessado/autor) em
    // itens de terceiros — necessário antes do DELETE FROM usuarios por causa das FKs
    await client.query(`DELETE FROM candidaturas WHERE usuario_id = ANY($1)`, [ids])
    await client.query(`DELETE FROM interesse_reparos WHERE usuario_id = ANY($1)`, [ids])
    await client.query(`DELETE FROM mensagens WHERE autor_id = ANY($1)`, [ids])
    await client.query(`DELETE FROM prestadores_bloqueados_dono WHERE dono_id IN (SELECT id FROM usuarios WHERE role != 'admin') OR prestador_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    // Ponteiros de obras/reparos SOBREVIVENTES (de admins) para usuários que vão sumir.
    // As quatro colunas são FK para usuarios SEM CASCADE: um match em aberto ou uma
    // solicitação de encerramento pendente de um usuário alvo estoura 23503 no DELETE
    // abaixo. Mesmo tratamento do DELETE /usuarios/:id e do passo 2 de limpar-teste.js.
    await client.query(`UPDATE obras   SET match_usuario_id = NULL, match_feito_em = NULL WHERE match_usuario_id = ANY($1)`, [ids])
    await client.query(`UPDATE reparos SET match_usuario_id = NULL, match_feito_em = NULL WHERE match_usuario_id = ANY($1)`, [ids])
    await client.query(`UPDATE obras   SET encerramento_solicitado_por = NULL, encerramento_solicitado_em = NULL WHERE encerramento_solicitado_por = ANY($1)`, [ids])
    await client.query(`UPDATE reparos SET encerramento_solicitado_por = NULL, encerramento_solicitado_em = NULL WHERE encerramento_solicitado_por = ANY($1)`, [ids])
    // candidaturas.aprovado_por: FK sem CASCADE e nullable. Sobrevivem aqui as candidaturas
    // de admins em obras de admins — se um usuário alvo tiver aprovado alguma, o DELETE
    // abaixo estoura 23503. Anular preserva a candidatura e perde só quem aprovou.
    await client.query(`UPDATE candidaturas SET aprovado_por = NULL WHERE aprovado_por = ANY($1)`, [ids])
    // faltas_profissional.usuario_id: FK sem CASCADE, mesmo 23503 documentado em
    // /admin/limpar-testes e no DELETE /usuarios/:id. perdoada_por é ON DELETE SET NULL.
    await client.query(`DELETE FROM faltas_profissional WHERE usuario_id = ANY($1)`, [ids])
    await client.query(`DELETE FROM usuarios WHERE role != 'admin'`)
    await client.query('COMMIT')
    res.json({ mensagem: 'Usuários removidos com sucesso' })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Erro ao limpar usuários:', err)
    res.status(500).json({ erro: 'Erro ao limpar usuários' })
  } finally { client.release() }
})

// ============================================================
// SUSPENSÕES POR FALTA (admin)
// ============================================================
// JANELA_FALTAS e FALTAS_PARA_SUSPENDER vêm de alertaService, onde o cron as aplica — uma
// cópia local aqui mentiria para o admin na primeira vez que o valor mudasse lá.
//
// GET /admin/suspensos — quem está suspenso agora, com as faltas de cada um.
// faltas_validas = as que ainda contam (não perdoadas, dentro da janela); faltas_total inclui
// perdoadas e antigas, para o admin ver o histórico completo antes de decidir. limite e janela
// saem na resposta para a tela exibir "3 de 3 em 90 dias" sem hardcodar a regra no app.
router.get('/admin/suspensos', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { page, limit, offset } = paginacaoAdmin(req.query)

    const lista = await pool.query(
      `SELECT u.id, u.nome, u.email, u.telefone, u.role, u.tipo_prestador,
              u.suspenso_em, u.suspenso_motivo,
              (SELECT COUNT(*)::int FROM faltas_profissional f
                WHERE f.usuario_id = u.id
                  AND f.perdoada_em IS NULL
                  AND f.criado_em > NOW() - INTERVAL '${JANELA_FALTAS}') AS faltas_validas,
              (SELECT COUNT(*)::int FROM faltas_profissional f WHERE f.usuario_id = u.id) AS faltas_total,
              COALESCE((
                SELECT json_agg(x ORDER BY x.criado_em DESC)
                  FROM (
                    SELECT f.id, f.tabela, f.demanda_id, f.criado_em,
                           f.perdoada_em, f.perdoada_por, up.nome AS perdoada_por_nome
                      FROM faltas_profissional f
                      LEFT JOIN usuarios up ON up.id = f.perdoada_por
                     WHERE f.usuario_id = u.id
                     ORDER BY f.criado_em DESC
                     LIMIT 20
                  ) x
              ), '[]'::json) AS faltas
       FROM usuarios u
       WHERE u.suspenso_em IS NOT NULL
       ORDER BY u.suspenso_em DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    res.json({
      suspensos: lista.rows,
      page,
      limit,
      limite_faltas: FALTAS_PARA_SUSPENDER,
      janela_faltas: JANELA_FALTAS,
    })
  } catch (err) {
    console.error('[admin/suspensos]', err.message)
    res.status(500).json({ erro: 'Erro ao listar profissionais suspensos' })
  }
})

// POST /admin/suspensos/:id/liberar — levanta a suspensão.
// Transação: limpar a suspensão SEM perdoar as faltas devolveria o profissional ao feed com a
// contagem ainda estourada, e a próxima falta o suspenderia de novo na hora. Os dois writes
// vivem ou morrem juntos.
router.post('/admin/suspensos/:id/liberar', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // WHERE suspenso_em IS NOT NULL: rowCount = 0 distingue "não estava suspenso" (409) de
    // "não existe" (404), sem uma leitura extra antes.
    const alvo = await client.query(
      `UPDATE usuarios SET suspenso_em = NULL, suspenso_motivo = NULL
        WHERE id = $1 AND suspenso_em IS NOT NULL
        RETURNING id, nome, email, push_token`,
      [req.params.id]
    )
    if (alvo.rowCount === 0) {
      await client.query('ROLLBACK')
      const existe = await pool.query(`SELECT id FROM usuarios WHERE id = $1`, [req.params.id])
      return existe.rows.length === 0
        ? res.status(404).json({ erro: 'Usuário não encontrado' })
        : res.status(409).json({ erro: 'Este usuário não está suspenso' })
    }
    // Perdoa exatamente as faltas CONTADAS (não perdoadas, dentro da janela) — as antigas já
    // não contavam e não precisam ser tocadas. Depois disto a contagem dele volta a zero.
    const perdoadas = await client.query(
      `UPDATE faltas_profissional SET perdoada_em = NOW(), perdoada_por = $2::uuid
        WHERE usuario_id = $1
          AND perdoada_em IS NULL
          AND criado_em > NOW() - INTERVAL '${JANELA_FALTAS}'
        RETURNING id`,
      [req.params.id, req.usuario.id]
    )
    await client.query('COMMIT')

    // Fora da transação: o cache é do processo, não do banco — derrubar antes de commitar
    // deixaria a próxima request recarregar a linha AINDA suspensa e cachear isso de novo.
    invalidarCacheAssinatura(req.params.id)

    res.json({
      mensagem: 'Suspensão removida',
      usuario_id: alvo.rows[0].id,
      faltas_perdoadas: perdoadas.rowCount,
    })
    if (alvo.rows[0].push_token) {
      enviarPushNotificacao(alvo.rows[0].push_token, '✅ Conta liberada',
        'Sua suspensão foi removida. Você já pode voltar a pegar trabalhos.',
        { tipo: 'conta_liberada' }).catch(() => {})
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[admin/suspensos/liberar]', err.message)
    res.status(500).json({ erro: 'Erro ao remover suspensão' })
  } finally {
    client.release()
  }
})

// GET /admin/denuncias — fila de moderação. Colunas EXPLÍCITAS (nunca SELECT *).
// titulo do contrato sai de um LEFT JOIN por tipo: contrato_id é polimórfico (obras OU
// reparos), então não há FK única para seguir. denunciado_nome pode vir NULL quando o
// denunciado excluiu a conta — a denúncia sobrevive anonimizada (ON DELETE SET NULL).
router.get('/admin/denuncias', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { page, limit, offset } = paginacaoAdmin(req.query)

    const STATUS_DENUNCIA = ['aberta', 'em_analise', 'resolvida', 'arquivada']
    const { status } = req.query
    if (status && !STATUS_DENUNCIA.includes(status)) {
      return res.status(400).json({ erro: `status deve ser um de: ${STATUS_DENUNCIA.join(', ')}` })
    }

    const filtro = status ? `WHERE d.status = $3` : ``
    const params = status ? [limit, offset, status] : [limit, offset]

    const lista = await pool.query(
      `SELECT d.id, d.contrato_tipo, d.contrato_id, d.categoria, d.descricao,
              d.status, d.criado_em,
              d.denunciante_id, ud.nome AS denunciante_nome, ud.email AS denunciante_email,
              d.denunciado_id,  ua.nome AS denunciado_nome,  ua.email AS denunciado_email,
              COALESCE(o.titulo, r.titulo) AS contrato_titulo
       FROM denuncias d
       JOIN usuarios ud ON ud.id = d.denunciante_id
       LEFT JOIN usuarios ua ON ua.id = d.denunciado_id
       LEFT JOIN obras   o ON d.contrato_tipo = 'obra'   AND o.id = d.contrato_id
       LEFT JOIN reparos r ON d.contrato_tipo = 'reparo' AND r.id = d.contrato_id
       ${filtro}
       ORDER BY d.criado_em DESC
       LIMIT $1 OFFSET $2`,
      params
    )

    const totais = await pool.query(
      `SELECT status, COUNT(*)::int AS total FROM denuncias GROUP BY status`
    )

    res.json({
      page,
      limit,
      por_status: totais.rows,
      denuncias: lista.rows
    })
  } catch (err) {
    console.error('[Denuncias] Erro listagem admin:', err.message)
    res.status(500).json({ erro: 'Erro ao buscar denúncias' })
  }
})

// PATCH /admin/denuncias/:id — move a denúncia na fila de moderação.
router.patch('/admin/denuncias/:id', autenticar, exigirAdmin, async (req, res) => {
  try {
    const STATUS_DENUNCIA = ['aberta', 'em_analise', 'resolvida', 'arquivada']
    const { status } = req.body
    if (!STATUS_DENUNCIA.includes(status)) {
      return res.status(400).json({ erro: `status deve ser um de: ${STATUS_DENUNCIA.join(', ')}` })
    }
    const result = await pool.query(
      `UPDATE denuncias SET status = $1 WHERE id = $2 RETURNING id, status`,
      [status, req.params.id]
    )
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Denúncia não encontrada' })
    res.json(result.rows[0])
  } catch (err) {
    console.error('[Denuncias] Erro ao atualizar status:', err.message)
    res.status(500).json({ erro: 'Erro ao atualizar denúncia' })
  }
})

// GET /admin/sugestoes — caixa de sugestões do app. ESPELHA GET /admin/denuncias:
// mesmo par de middlewares (autenticar + exigirAdmin, ou seja admin E aprovador), mesma
// paginação (page/limit com defaults 1 e 20, offset calculado, LIMIT $1 OFFSET $2), mesma
// ordem (criado_em DESC) e colunas EXPLÍCITAS — nunca SELECT *. Somente leitura.
// Como lá, a resposta não traz total de linhas; e ambas usam paginacaoAdmin, então o teto
// de 100 e o saneamento de page/limit valem igualmente aqui e lá.
// `por_status` não tem equivalente aqui (sugestoes não tem coluna status), então a resposta
// traz só page, limit e a lista.
// JOIN (interno, não LEFT) em usuarios, exatamente como o de denunciante_id lá: usuario_id é
// NOT NULL e ON DELETE CASCADE, então a sugestão de um autor excluído deixa de existir junto
// com ele — não existe linha órfã para o join derrubar.
router.get('/admin/sugestoes', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { page, limit, offset } = paginacaoAdmin(req.query)

    const lista = await pool.query(
      `SELECT s.id, s.texto, s.criado_em,
              s.usuario_id, u.nome AS usuario_nome, u.email AS usuario_email
       FROM sugestoes s
       JOIN usuarios u ON u.id = s.usuario_id
       ORDER BY s.criado_em DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )

    res.json({
      page,
      limit,
      sugestoes: lista.rows
    })
  } catch (err) {
    console.error('[Sugestoes] Erro listagem admin:', err.message)
    res.status(500).json({ erro: 'Erro ao buscar sugestões' })
  }
})

// DELETE /admin/sugestoes — exclusão DEFINITIVA, em lote. Gate MAIS ESTRITO que o da
// listagem, de propósito: autenticar + exigirSuperAdmin, que exige role === 'admin'.
// A listagem (GET acima) segue em exigirAdmin, que também aceita 'aprovador' — ler a caixa
// de sugestões é trabalho de moderação, apagar em definitivo não é. Sem token é 401 no
// autenticar; com token de aprovador (ou de qualquer outra role) é 403 no exigirSuperAdmin,
// antes de o handler rodar. A rota não decide nada de acesso sozinha.
// Hard delete de verdade: a linha some da tabela. Não há coluna de soft-delete nem flag de
// arquivo em sugestoes, e nada no schema referencia sugestoes.id (é a ponta da FK, não o
// alvo), então o DELETE não cascateia nem esbarra em constraint de terceiros.
// UM statement com = ANY($1::uuid[]), nunca um laço: N ids viram uma ida ao banco.
// Os ids são VALIDADOS contra o formato UUID antes da query. Isso não é ornamento: eles
// entram como parâmetro (jamais interpolados, então não há injeção possível), mas um valor
// fora do formato faria o cast ::uuid[] estourar no Postgres e o handler devolver 500 —
// a validação transforma esse caso em 400, que é o que ele é.
// ids repetidos são inofensivos: ANY testa pertinência, a linha é apagada uma única vez, e
// rowCount conta LINHAS apagadas — não ids recebidos. Pelo mesmo motivo, id inexistente não
// derruba a chamada: apenas não entra na conta.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Mesmo teto da paginação (100) — um único número para "quanto o admin manipula por vez".
const IDS_POR_CHAMADA_MAX = PAGINACAO_ADMIN_MAX

router.delete('/admin/sugestoes', autenticar, exigirSuperAdmin, async (req, res) => {
  try {
    // req.body?.ids, não desestruturação direta: no Express 5 o body-parser NÃO define
    // req.body quando a requisição chega sem corpo ou com outro content-type (verificado),
    // e `const { ids } = req.body` estouraria um TypeError — devolvendo 500 para o que é,
    // na verdade, uma chamada malformada. Com o ?. o caso cai no 400 logo abaixo.
    const ids = req.body?.ids

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ erro: 'ids deve ser um array não-vazio' })
    }
    if (ids.length > IDS_POR_CHAMADA_MAX) {
      return res.status(400).json({ erro: `Máximo de ${IDS_POR_CHAMADA_MAX} ids por chamada` })
    }
    if (!ids.every(id => typeof id === 'string' && UUID_RE.test(id))) {
      return res.status(400).json({ erro: 'ids deve conter apenas UUIDs válidos' })
    }

    const result = await pool.query(
      `DELETE FROM sugestoes WHERE id = ANY($1::uuid[])`,
      [ids]
    )

    res.json({ apagadas: result.rowCount })
  } catch (err) {
    console.error('[Sugestoes] Erro ao apagar:', err.message)
    res.status(500).json({ erro: 'Erro ao apagar sugestões' })
  }
})

// GET /admin/finalizadas — obras E reparos encerrados numa resposta só, para o painel.
// Gate igual ao da LISTAGEM de sugestões (autenticar + exigirAdmin): ler histórico é
// trabalho de moderação, então 'aprovador' entra. Nada aqui escreve — é só leitura.
// Paginação pelo helper compartilhado paginacaoAdmin, sem cópia nova.
//
// valor_acordado sai do PROPOSTA ACEITA, nunca de obras.valor / reparos.valor_estimado:
// essas duas são o orçamento/estimativa de quem PUBLICOU a demanda, não o preço de
// fechamento. A convenção do repo para o número final é COALESCE(valor_contraproposta,
// valor_proposto) — contraproposta quando houve negociação, proposta original quando não —
// vinda de candidaturas (obras) e interesse_reparos (reparos), sempre em status='aceito'.
// Os JOINs são LEFT de propósito: demanda encerrada SEM aceite registrado continua na
// lista, com valor_acordado NULL. Sumir com a linha esconderia justamente o caso
// interessante (encerrou sem fechar preço), e a contagem de finalizadas passaria a
// discordar do total real.
// Não há risco de a linha duplicar por dois aceites: candidaturas_aceito_unica_idx e
// interesse_reparos_aceito_unico_idx são UNIQUE parciais em (obra_id)/(reparo_id) WHERE
// status='aceito', então o LEFT JOIN casa no máximo uma linha e nem lista nem totais
// contam duas vezes.
// UNION ALL, não UNION: os dois lados são conjuntos distintos por construção, e o UNION
// pagaria um DISTINCT inútil sobre a base inteira. Colisão de id entre uma obra e um
// reparo não quebra nada — a identidade de cada linha é o par (tipo, id), o id nunca é
// usado sozinho como chave, e nada é agrupado por ele.
const PERIODOS_FINALIZADAS = {
  // date_trunc na zona de São Paulo (e de volta para timestamptz): "mês atual" é o mês de
  // quem opera o painel, não o do UTC — senão as primeiras/últimas horas do mês caem na
  // caixa errada.
  mes_atual:     `f.encerrado_em >= date_trunc('month', NOW() AT TIME ZONE '${TZ_PADRAO}') AT TIME ZONE '${TZ_PADRAO}'`,
  mes_anterior:  `f.encerrado_em >= (date_trunc('month', NOW() AT TIME ZONE '${TZ_PADRAO}') - INTERVAL '1 month') AT TIME ZONE '${TZ_PADRAO}'
                  AND f.encerrado_em < date_trunc('month', NOW() AT TIME ZONE '${TZ_PADRAO}') AT TIME ZONE '${TZ_PADRAO}'`,
  ultimos_90:    `f.encerrado_em >= NOW() - INTERVAL '90 days'`,
  tudo:          `TRUE`,
}
const PERIODO_FINALIZADAS_PADRAO = 'mes_atual'

// Fonte única das duas consultas (lista e totais): um CTE só, escrito uma vez. Duas cópias
// deste SELECT divergiriam no primeiro ajuste, e aí os totais deixariam de descrever a
// lista que estão acompanhando.
const SQL_FINALIZADAS = `
  SELECT 'obra'::text AS tipo, o.id, o.titulo, o.cidade, o.uf, o.bairro, o.encerrado_em,
         u.nome AS profissional_nome,
         COALESCE(cd.valor_contraproposta, cd.valor_proposto) AS valor_acordado
    FROM obras o
    LEFT JOIN usuarios u      ON u.id = o.match_usuario_id
    LEFT JOIN candidaturas cd ON cd.obra_id = o.id AND cd.status = 'aceito'
   WHERE o.status = 'encerrada'
  UNION ALL
  SELECT 'reparo'::text AS tipo, r.id, r.titulo, r.cidade, r.uf, r.bairro, r.encerrado_em,
         u.nome AS profissional_nome,
         COALESCE(ir.valor_contraproposta, ir.valor_proposto) AS valor_acordado
    FROM reparos r
    LEFT JOIN usuarios u           ON u.id = r.match_usuario_id
    LEFT JOIN interesse_reparos ir ON ir.reparo_id = r.id AND ir.status = 'aceito'
   WHERE r.status = 'encerrada'
`

router.get('/admin/finalizadas', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { page, limit, offset } = paginacaoAdmin(req.query)
    // periodo desconhecido NÃO é 400: o painel manda o filtro na URL e um valor errado deve
    // mostrar o mês atual, não uma tela de erro. A chave só entra na SQL depois de casar com
    // o catálogo, então nada do cliente chega perto do texto da consulta.
    const periodo = Object.prototype.hasOwnProperty.call(PERIODOS_FINALIZADAS, req.query.periodo)
      ? req.query.periodo
      : PERIODO_FINALIZADAS_PADRAO
    const filtro = PERIODOS_FINALIZADAS[periodo]

    // ORDER BY com desempate por (encerrado_em, tipo, id): sem chave estável, duas linhas
    // com o mesmo encerrado_em podem trocar de lugar entre páginas e uma delas some da
    // paginação. NULLS LAST porque em DESC o padrão do Postgres é NULLS FIRST — sem isso
    // uma linha sem data iria para o topo do painel.
    const lista = await pool.query(
      `SELECT f.tipo, f.id, f.titulo, f.cidade, f.uf, f.bairro, f.encerrado_em,
              f.profissional_nome, f.valor_acordado
         FROM (${SQL_FINALIZADAS}) f
        WHERE ${filtro}
        ORDER BY f.encerrado_em DESC NULLS LAST, f.tipo DESC, f.id DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    )

    // Totais sobre TODAS as linhas do período — não sobre a página. Consulta separada (mesmo
    // padrão de por_status em /admin/denuncias): com window function os totais sumiriam numa
    // página vazia, que é exatamente quando o painel ainda precisa mostrar o resumo.
    // valor_total usa COALESCE(...,0): sem linha nenhuma, SUM devolve NULL e o painel
    // mostraria vazio onde o certo é R$ 0.
    // ticket_medio é AVG, que IGNORA nulos: é a média dos valores CONHECIDOS, não
    // valor_total/total_finalizadas — dividir pelo total afundaria o ticket toda vez que uma
    // encerrada sem aceite entrasse na conta. Com zero linhas AVG devolve NULL (não é
    // divisão por zero, não estoura): o painel recebe null e mostra "—".
    const totais = await pool.query(
      `SELECT COUNT(*)::int                                        AS total_finalizadas,
              COALESCE(SUM(f.valor_acordado), 0)                   AS valor_total,
              AVG(f.valor_acordado)                                AS ticket_medio,
              COUNT(*) FILTER (WHERE f.tipo = 'obra')::int         AS total_obras,
              COUNT(*) FILTER (WHERE f.tipo = 'reparo')::int       AS total_reparos
         FROM (${SQL_FINALIZADAS}) f
        WHERE ${filtro}`
    )

    res.json({
      page,
      limit,
      periodo,
      totais: totais.rows[0],
      finalizadas: lista.rows
    })
  } catch (err) {
    console.error('[Finalizadas] Erro listagem admin:', err.message)
    res.status(500).json({ erro: 'Erro ao buscar demandas finalizadas' })
  }
})

router.post('/admin/limpar-obras', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM candidaturas`)
    await client.query(enfileirarOrfas(`DELETE FROM midias RETURNING url, tipo`))
    await client.query(`DELETE FROM obras`)
    await client.query('COMMIT')
    res.json({ mensagem: 'Obras removidas com sucesso' })
  } catch (err) {
    // .catch: sem isso, uma conexão morta faz o próprio ROLLBACK lançar dentro do catch
    // e a resposta 500 nunca é enviada — o cliente fica pendurado.
    await client.query('ROLLBACK').catch(() => {})
    console.error('Erro ao limpar obras:', err)
    res.status(500).json({ erro: 'Erro ao limpar obras' })
  } finally { client.release() }
})

router.post('/admin/limpar-reparos', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // contratos.interesse_id NÃO tem FK (ao contrário do que dizem os comentários antigos —
    // só contratos.candidatura_id → candidaturas é constraint de verdade). Sem esta linha o
    // DELETE abaixo não falhava: apagava os interesse_reparos e deixava os contratos do fluxo
    // reparo apontando para linhas inexistentes, em silêncio.
    // `interesse_id IS NOT NULL` (e não `IN (SELECT id FROM interesse_reparos)`) de propósito:
    // varre também os órfãos que execuções anteriores já deixaram para trás. Contratos do
    // fluxo obra (candidatura_id) não são tocados — quem os apaga é limpar-obras, via CASCADE.
    await client.query(`DELETE FROM contratos WHERE interesse_id IS NOT NULL`)
    await client.query(`DELETE FROM interesse_reparos`)
    await client.query(enfileirarOrfas(`DELETE FROM midias_reparos RETURNING url, tipo`))
    await client.query(`DELETE FROM reparos`)
    await client.query('COMMIT')
    res.json({ mensagem: 'Reparos removidos com sucesso' })
  } catch (err) {
    // .catch: mesmo motivo de limpar-obras — ROLLBACK que lança engole o 500.
    await client.query('ROLLBACK').catch(() => {})
    console.error('Erro ao limpar reparos:', err)
    res.status(500).json({ erro: 'Erro ao limpar reparos' })
  } finally { client.release() }
})

router.post('/admin/limpar-mensagens', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM mensagens`)
    await client.query('COMMIT')
    res.json({ mensagem: 'Mensagens removidas com sucesso' })
  } catch (err) {
    // Transação + log alinhados com os outros /admin/limpar-*: antes o erro era engolido
    // sem nenhum rastro e o admin recebia só o 500 genérico, sem nada para diagnosticar.
    await client.query('ROLLBACK').catch(() => {})
    console.error('Erro ao limpar mensagens:', err)
    res.status(500).json({ erro: 'Erro ao limpar mensagens' })
  } finally { client.release() }
})

// ============================================================
// ADMIN — SEGURANÇA (SENHA + 2FA)
// ============================================================
router.post('/admin/trocar-senha', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { senha_atual, nova_senha } = req.body
    if (!nova_senha || nova_senha.length < 8) return res.status(400).json({ erro: 'Nova senha deve ter ao menos 8 caracteres' })
    const result = await pool.query(`SELECT senha_hash FROM usuarios WHERE id = $1`, [req.usuario.id])
    const ok = await bcrypt.compare(senha_atual, result.rows[0].senha_hash)
    if (!ok) return res.status(401).json({ erro: 'Senha atual incorreta' })
    const hash = await bcrypt.hash(nova_senha, 10)
    await pool.query(`UPDATE usuarios SET senha_hash = $1 WHERE id = $2`, [hash, req.usuario.id])
    res.json({ mensagem: 'Senha alterada com sucesso' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao trocar senha' })
  }
})

router.post('/admin/2fa/setup', autenticar, exigirAdmin, async (req, res) => {
  try {
    const adminResult = await pool.query(`SELECT email FROM usuarios WHERE id = $1`, [req.usuario.id])
    const email = adminResult.rows[0]?.email || 'admin'
    // Rótulo mostrado no app autenticador. Só vale para QR gerados a partir daqui: quem já
    // se cadastrou continua vendo o rótulo antigo no aparelho até refazer o setup.
    const secret = speakeasy.generateSecret({ name: `${MARCA} Admin (${email})`, length: 20 })
    await pool.query(`UPDATE usuarios SET dois_fa_secret = $1, dois_fa_ativo = false WHERE id = $2`, [secret.base32, req.usuario.id])
    res.json({ secret: secret.base32, otpauth_url: secret.otpauth_url })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao configurar 2FA' })
  }
})

router.post('/admin/2fa/verificar', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { token, ativar } = req.body
    const result = await pool.query(`SELECT dois_fa_secret FROM usuarios WHERE id = $1`, [req.usuario.id])
    const secret = result.rows[0]?.dois_fa_secret
    if (!secret) return res.status(400).json({ erro: 'Configure o 2FA primeiro clicando em "Gerar QR Code"' })
    const valido = speakeasy.totp.verify({ secret, encoding: 'base32', token: String(token), window: 1 })
    if (!valido) return res.status(401).json({ erro: 'Código inválido. Verifique o app autenticador.' })
    if (ativar !== undefined) {
      await pool.query(`UPDATE usuarios SET dois_fa_ativo = $1 WHERE id = $2`, [!!ativar, req.usuario.id])
    }
    res.json({ valido: true, mensagem: ativar ? '✅ 2FA ativado com sucesso!' : '2FA desativado' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao verificar 2FA' })
  }
})

router.post('/admin/2fa/login-verificar', async (req, res) => {
  try {
    const { temp_token, codigo } = req.body
    if (!temp_token || !codigo) return res.status(400).json({ erro: 'temp_token e codigo são obrigatórios' })

    let payload
    try {
      payload = jwt.verify(temp_token, process.env.JWT_SECRET)
    } catch (e) {
      return res.status(401).json({ erro: 'Token temporário inválido ou expirado' })
    }

    if (payload.tipo !== '2fa_pendente' || payload.role !== 'admin') {
      return res.status(401).json({ erro: 'Token inválido' })
    }

    const userResult = await pool.query(
      `SELECT id, nome, email, role, dois_fa_secret, dois_fa_ativo FROM usuarios WHERE id = $1`,
      [payload.id]
    )
    if (userResult.rows.length === 0) return res.status(401).json({ erro: 'Usuário não encontrado' })

    const usuario = userResult.rows[0]
    if (!usuario.dois_fa_ativo || !usuario.dois_fa_secret) {
      return res.status(401).json({ erro: '2FA não configurado' })
    }

    const valido = speakeasy.totp.verify({
      secret: usuario.dois_fa_secret,
      encoding: 'base32',
      token: String(codigo),
      window: 1
    })

    if (!valido) return res.status(401).json({ erro: 'Código 2FA inválido' })

    const token = jwt.sign(
      { id: usuario.id, role: usuario.role },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    )

    const assinaturaResult = await pool.query(
      `SELECT status, plano, proximo_vencimento, valor_mensal FROM assinaturas WHERE usuario_id = $1 LIMIT 1`,
      [usuario.id]
    )

    res.json({
      token,
      usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, role: usuario.role },
      assinatura: assinaturaResult.rows[0] || null
    })
  } catch (err) {
    console.error('[2FA login-verificar] Erro:', err.message)
    res.status(500).json({ erro: 'Erro ao verificar 2FA' })
  }
})

module.exports = router
module.exports.migracaoPronta = migracaoPronta
// Exportado para os jobs de server.js. Hoje é um repasse para invalidarCacheAssinatura —
// mantido como nome estável porque server.js e várias rotas já chamam assim.
module.exports.invalidarCachesUsuario = invalidarCachesUsuario