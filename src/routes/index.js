require('dotenv').config()
const express = require('express')
const router = express.Router()
const { autenticar, exigirAssinaturaAtiva, exigirAdmin, invalidarCacheAssinatura } = require('../middlewares/auth')
const { pool } = require('../utils/supabase')
const { marcaPorTipo } = require('../utils/marca')
const authCtrl         = require('../controllers/authController')
const obrasCtrl        = require('../controllers/obrasController')
const candidaturasCtrl = require('../controllers/candidaturasController')
const mensagensCtrl    = require('../controllers/mensagensController')
const pagamentoCtrl    = require('../controllers/pagamentoController')
const { upload, uploadMidia } = require('../controllers/uploadController')
const { uploadArquivo, gerarAssinaturaCloudinary, uploadParaCloudinary } = require('../services/uploadService')
const { uploadMidiaStream } = require('../controllers/uploadStreamController')
const { enviarPushNotificacao, notificarPintoresSobreNovaObra, notificarPrestadoresSobreNovoReparo } = require('../services/alertaService')
const { ufDeCidade } = require('../utils/localidade')
const { coordsDeCidade, resolverBusca, montarFiltroGeo } = require('../utils/geoBusca')
const { enviarContratoReparo, enviarContratoObra } = require('../controllers/contratosController')
const { enviarEmail } = require('../services/emailService')
const bcrypt = require('bcrypt')
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
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS latitude NUMERIC`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS longitude NUMERIC`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS notif_5min_enviada BOOLEAN DEFAULT false`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS uf VARCHAR(2)`)
    await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS endereco_obra TEXT`)
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
    // push_token IS NULL, que confunde quatro estados distintos. push_status registra o
    // motivo, reportado pelo app. Valores aceitos (texto puro, sem CHECK — mesma convenção
    // de verificacao_status): 'concedida' (permissão dada), 'negada' (permissão recusada),
    // 'bloqueada' (recusa permanente, canAskAgain=false), 'erro_registro' (falha ao obter/
    // enviar o token). Default 'desconhecido' enquanto o app ainda não reportou.
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
    // Contratos de reparo: referência ao interesse aceito (paridade com candidatura_id de obra)
    await client.query(`ALTER TABLE contratos ADD COLUMN IF NOT EXISTS interesse_id uuid`)
    // Idempotência de criação de obra/reparo — evita duplicatas em retries após timeout/ERR_NETWORK
    await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS client_request_id TEXT`)
    await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS client_request_id TEXT`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS obras_criado_por_client_request_id_uniq ON obras (criado_por, client_request_id) WHERE client_request_id IS NOT NULL`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS reparos_criado_por_client_request_id_uniq ON reparos (criado_por, client_request_id) WHERE client_request_id IS NOT NULL`)
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
    await client.query(`CREATE INDEX IF NOT EXISTS interesse_reparos_reparo_id_idx ON interesse_reparos (reparo_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS interesse_reparos_usuario_id_idx ON interesse_reparos (usuario_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS candidaturas_obra_id_idx ON candidaturas (obra_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS candidaturas_usuario_id_idx ON candidaturas (usuario_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS midias_obra_id_idx ON midias (obra_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS midias_reparos_reparo_id_idx ON midias_reparos (reparo_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS reparos_criado_por_idx ON reparos (criado_por)`)
    await client.query(`CREATE INDEX IF NOT EXISTS reparos_feed_idx ON reparos (status, status_aprovacao, expira_em)`)
    await client.query(`CREATE INDEX IF NOT EXISTS obras_criado_por_idx ON obras (criado_por)`)
    // obras_feed_idx: inclui status_aprovacao e match_usuario_id p/ paridade com reparos_feed_idx.
    // Drop do índice antigo (mais estreito) antes de recriar com as colunas corretas.
    await client.query(`DROP INDEX IF EXISTS obras_feed_idx`)
    await client.query(`CREATE INDEX IF NOT EXISTS obras_feed_idx ON obras (status, status_aprovacao, expira_em, match_usuario_id)`)
    // Filtro quente do cron de proximidade (15min): lp.atualizado_em > NOW() - 30min.
    await client.query(`CREATE INDEX IF NOT EXISTS localizacoes_prestadores_atualizado_em_idx ON localizacoes_prestadores (atualizado_em)`)
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
    // Cron de expiração (1h) e aviso de vencimento (24h): WHERE status='ativa' AND proximo_vencimento < NOW().
    await client.query(`CREATE INDEX IF NOT EXISTS assinaturas_status_vencimento_idx ON assinaturas (status, proximo_vencimento)`)
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
    await client.query(`CREATE INDEX IF NOT EXISTS prestadores_bloqueados_dono_dono_idx ON prestadores_bloqueados_dono (dono_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS prestadores_bloqueados_dono_prestador_idx ON prestadores_bloqueados_dono (prestador_id)`)
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

// Cache de assinatura para prestadores
const cachePrestadores = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutos

// Limpa TODOS os caches em memória de um usuário (deste módulo + middleware de auth).
// Usar sempre que a assinatura do usuário for ativada, para o app ver o status novo
// na hora em vez de esperar o TTL de 5 min — evita o redirect indevido para o PagBank.
const invalidarCachesUsuario = (id) => {
  cachePrestadores.delete(id)
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

    const cached = cachePrestadores.get(req.usuario.id)
    if (cached !== null && cached !== undefined && Date.now() - cached.timestamp < CACHE_TTL) {
      if (!cached.ativa) return res.status(403).json({ erro: 'Assinatura inativa. Renove seu plano para acessar os reparos.' })
      return next()
    }

    const assinatura = await pool.query(
      `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' AND (proximo_vencimento IS NULL OR proximo_vencimento > NOW()) LIMIT 1`,
      [req.usuario.id]
    )
    const ativa = assinatura.rows.length > 0
    cachePrestadores.set(req.usuario.id, { ativa, timestamp: Date.now() })

    if (!ativa) return res.status(403).json({ erro: 'Assinatura inativa. Renove seu plano para acessar os reparos.' })
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
const exigirReparador = exigirTipoPrestador('reparador', 'Este recurso é exclusivo para prestadores de reparos domésticos.')

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
    const permitidos = ['concedida', 'negada', 'bloqueada', 'erro_registro']
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
      `SELECT pb.prestador_id, pb.criado_em, u.nome, u.foto_url
       FROM prestadores_bloqueados_dono pb
       JOIN usuarios u ON u.id = pb.prestador_id
       WHERE pb.dono_id = $1
       ORDER BY pb.criado_em DESC`,
      [req.usuario.id]
    )
    res.json({ bloqueados: result.rows })
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
// (fluxo obra, contratos.candidatura_id → candidaturas.id) ou pelo interesse
// (fluxo reparo, contratos.interesse_id → interesse_reparos.id). Como as cascatas
// de exclusão apagavam candidaturas/interesse_reparos SEM apagar os contratos que
// os referenciam, um usuário COM contrato podia derrubar a transação inteira por
// violação de FK (23503) → ROLLBACK → a conta (e o cpf_cnpj dela) SOBREVIVIA, e o
// app só mostrava "Erro ao excluir conta". Apagando os contratos antes dos pais, a
// FK deixa de bloquear. Onde a FK não existir, isto ainda é necessário: sem ele
// ficam linhas ÓRFÃS em contratos apontando para candidaturas/interesses que não
// existem mais (mesma sujeira que a limpeza de assinaturas órfãs acima resolve).
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
    // em SQL_DELETE_CONTRATOS_DO_USUARIO): a FK indireta bloqueava a exclusão.
    await client.query(SQL_DELETE_CONTRATOS_DO_USUARIO, [id])

    // Cascade obras criadas por este usuário (dono_obra)
    const obrasRes = await client.query('SELECT id FROM obras WHERE criado_por = $1', [id])
    if (obrasRes.rows.length > 0) {
      const obraIds = obrasRes.rows.map(r => r.id)
      await client.query('DELETE FROM mensagens WHERE obra_id = ANY($1::uuid[])', [obraIds])
      await client.query('DELETE FROM candidaturas WHERE obra_id = ANY($1::uuid[])', [obraIds])
      await client.query(`DELETE FROM midias WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = $1)`, [id])
      await client.query('DELETE FROM obras WHERE criado_por = $1', [id])
    }

    // Cascade reparos criados por este usuário (dono_obra)
    const reparosRes = await client.query('SELECT id FROM reparos WHERE criado_por = $1', [id])
    if (reparosRes.rows.length > 0) {
      const reparoIds = reparosRes.rows.map(r => r.id)
      await client.query('DELETE FROM interesse_reparos WHERE reparo_id = ANY($1::uuid[])', [reparoIds])
      await client.query(`DELETE FROM midias_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por = $1)`, [id])
      await client.query('DELETE FROM reparos WHERE criado_por = $1', [id])
    }

    // NULL out match_usuario_id caso o prestador estivesse em atendimento
    await client.query('UPDATE obras SET match_usuario_id = NULL, match_feito_em = NULL WHERE match_usuario_id = $1', [id])
    await client.query('UPDATE reparos SET match_usuario_id = NULL, match_feito_em = NULL WHERE match_usuario_id = $1', [id])

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
    await client.query('DELETE FROM usuarios WHERE id = $1', [id])

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
    assunto: 'ArrumaPro — Sua conta foi excluída',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: #0a0a0a; margin: 0;">ArrumaPro</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
          <h2>Olá, ${nome}!</h2>
          <p>Confirmamos que sua conta no ArrumaPro foi excluída permanentemente, junto com todos os dados associados (obras, reparos, candidaturas, mídias, assinaturas e avaliações).</p>
          <p>Esta ação é irreversível. Se você <strong>não</strong> solicitou esta exclusão, entre em contato conosco imediatamente respondendo este e-mail.</p>
          <p>Você pode criar uma nova conta a qualquer momento.</p>
          <p><strong>Equipe ArrumaPro</strong></p>
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
    // em SQL_DELETE_CONTRATOS_DO_USUARIO): a FK indireta bloqueava a exclusão e fazia
    // esta transação inteira sofrer ROLLBACK, deixando a conta e o cpf_cnpj no banco.
    await client.query(SQL_DELETE_CONTRATOS_DO_USUARIO, [id])

    // Cascade obras criadas por este usuário (colunas idênticas ao DELETE /usuarios/:id)
    await client.query(`DELETE FROM mensagens WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = $1)`, [id])
    await client.query(`DELETE FROM candidaturas WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = $1)`, [id])
    await client.query(`DELETE FROM midias WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = $1)`, [id])
    await client.query(`DELETE FROM obras WHERE criado_por = $1`, [id])

    // Cascade reparos criados por este usuário
    await client.query(`DELETE FROM interesse_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por = $1)`, [id])
    await client.query(`DELETE FROM midias_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por = $1)`, [id])
    await client.query(`DELETE FROM reparos WHERE criado_por = $1`, [id])

    // NULL out match_usuario_id caso o usuário estivesse em atendimento
    await client.query(`UPDATE obras SET match_usuario_id = NULL, match_feito_em = NULL WHERE match_usuario_id = $1`, [id])
    await client.query(`UPDATE reparos SET match_usuario_id = NULL, match_feito_em = NULL WHERE match_usuario_id = $1`, [id])

    // Cascade registros do próprio usuário como candidato/interessado/autor
    await client.query(`DELETE FROM assinaturas WHERE usuario_id = $1`, [id])
    await client.query(`DELETE FROM candidaturas WHERE usuario_id = $1`, [id])
    await client.query(`DELETE FROM mensagens WHERE autor_id = $1`, [id])
    await client.query(`DELETE FROM interesse_reparos WHERE usuario_id = $1`, [id])
    await client.query(`DELETE FROM localizacoes_prestadores WHERE usuario_id = $1`, [id])
    await client.query(`DELETE FROM prestadores_bloqueados_dono WHERE dono_id = $1 OR prestador_id = $1`, [id])

    // Conta em si (avaliacoes cai por ON DELETE CASCADE)
    await client.query(`DELETE FROM usuarios WHERE id = $1`, [id])

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

// ============================================================
// OBRAS
// ============================================================
router.get('/obras/minhas', autenticar, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

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
              ) AS ja_avaliei
       FROM obras o
       JOIN usuarios u ON o.criado_por = u.id
       LEFT JOIN candidaturas c ON c.obra_id = o.id AND c.usuario_id = $1
       WHERE o.match_usuario_id = $1 AND o.status = 'encerrada'
       ORDER BY o.match_feito_em DESC NULLS LAST`,
      [req.usuario.id]
    )
    res.json({ contratos: result.rows })
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
              ) AS ja_avaliei
       FROM obras o
       LEFT JOIN usuarios u ON o.match_usuario_id = u.id
       LEFT JOIN candidaturas c ON c.obra_id = o.id AND c.usuario_id = o.match_usuario_id
       WHERE o.criado_por = $1 AND o.status = 'encerrada'
       ORDER BY o.match_feito_em DESC NULLS LAST`,
      [req.usuario.id]
    )
    res.json({ contratos: result.rows })
  } catch (err) {
    console.error('[obras/meus-contratos-dono]', err.message)
    res.status(500).json({ erro: 'Erro ao buscar contratos finalizados' })
  }
})

router.post('/obras/dono', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'dono_obra' && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Apenas donos de obra podem cadastrar obras' })
    }
    const { titulo, categoria, valor, cidade, bairro, uf, metragem, prazo_execucao_dias, horas_para_expirar, descricao, tags, endereco_obra, latitude, longitude, client_request_id } = req.body
    const ufFinal = uf || await ufDeCidade(cidade)  // rede de segurança: deriva uf da cidade
    const { lat: latFinal, lng: lngFinal, origem: coordOrigem } = resolverCoordenadas(cidade, ufFinal, latitude, longitude, '[obras/dono]')
    // Janela original resolvida UMA vez: mesma base do expira_em e do horas_para_expirar gravado,
    // sem risco de os dois divergirem. publicado_em fica NULL — obra nasce 'rascunho', só publica
    // na aprovação. Validação do input segue DEFERIDA (não mexer nos creates).
    const horasExpiracao = horas_para_expirar || 720
    const expira_em = new Date(Date.now() + horasExpiracao * 3600 * 1000)
    // ON CONFLICT no índice parcial (criado_por, client_request_id): retries com a mesma chave
    // retornam a obra já criada em vez de inserir duplicata. Sem chave (NULL) → insert normal.
    const result = await pool.query(
      `INSERT INTO obras (criado_por, titulo, categoria, valor, cidade, bairro, uf, metragem, prazo_execucao_dias, expira_em, descricao, tags, endereco_obra, latitude, longitude, coordenadas_origem, status, enviada_por_dono, status_aprovacao, client_request_id, horas_para_expirar)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'rascunho',true,'pendente',$17,$18)
       ON CONFLICT (criado_por, client_request_id) WHERE client_request_id IS NOT NULL
       DO UPDATE SET client_request_id = EXCLUDED.client_request_id
       RETURNING *`,
      [req.usuario.id, titulo, categoria, valor, cidade, bairro, ufFinal, metragem, prazo_execucao_dias, expira_em.toISOString(), descricao, tags || [], endereco_obra, latFinal, lngFinal, coordOrigem, client_request_id || null, horasExpiracao]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('[obras/dono]', err.message)
    res.status(500).json({ erro: 'Erro ao cadastrar obra' })
  }
})

router.get('/obras-aprovacao', autenticar, exigirAdmin, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

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

router.post('/obras-aprovacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
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
    const atualizada = await pool.query(
      `UPDATE obras SET status_aprovacao = 'aprovada', status = 'aberta',
         publicado_em = NOW(),
         expira_em = NOW() + (COALESCE(horas_para_expirar, 720) * INTERVAL '1 hour')
       WHERE id = $1 AND status_aprovacao <> 'aprovada'
       RETURNING id`, [req.params.id])
    res.json({ mensagem: 'Obra aprovada e publicada!' })
    // Os DOIS avisos só na TRANSIÇÃO pendente/recusada → aprovada. rowCount 0 significa que o
    // UPDATE não mudou nada (já estava aprovada — duplo clique do admin — ou o id não existe):
    // reavisar o dono seria ruído, e rebroadcastar aos pintores anunciaria como "nova" uma obra
    // publicada dias atrás, para até 500 pessoas de uma vez.
    if (atualizada.rowCount > 0) {
      notificarPintoresSobreNovaObra(req.params.id).catch(err => console.error('Erro notificar pintores:', err))
      notificarDonoSobreAnaliseObra(req.params.id, true)
        .catch(err => console.error('Erro notificar dono (obra aprovada):', err.message))
    }
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar obra' })
  }
})

router.post('/obras-aprovacao/:id/recusar', autenticar, exigirAdmin, async (req, res) => {
  try {
    // Guarda de idempotência espelhando a da aprovação: sem ela, reprocessar uma recusa
    // (duplo clique do admin) reavisaria o dono de uma decisão que ele já recebeu.
    const atualizada = await pool.query(
      `UPDATE obras SET status_aprovacao = 'recusada', status = 'cancelada'
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

router.get('/obras', autenticar, exigirAssinaturaAtiva, exigirPintor, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit
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
    await pool.query(`UPDATE obras SET status = 'cancelada', status_aprovacao = 'cancelada' WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Obra removida com sucesso' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover obra' })
  }
})

// Teto de segurança PLANO da extensão de obra: 365 dias. Substitui o antigo teto de 2x a
// janela original — não há mais orçamento derivado de publicado_em/horas_para_expirar; o
// único limite é absoluto, para barrar valor absurdo (ex.: um dígito a mais por engano).
const TETO_ESTENDER_OBRA_HORAS = 8760

// POST /obras/:id/estender — dono estende o prazo da própria obra, respeitando o teto plano
// de 8760h. Re-arma TODOS os marcos de expiração (marco_6h/60/30/15_em = NULL):
// como expira_em foi empurrado para frente, os 4 alertas precisam re-disparar contra o novo
// prazo, senão a obra estendida mantém os marcos já gastos e não recebe nova contagem
// regressiva. (Substitui o antigo clear de alerta_sem_interessados_em, cujo job foi aposentado.)
router.post('/obras/:id/estender', autenticar, async (req, res) => {
  try {
    const obra = await pool.query(
      `SELECT id, criado_por, status, match_usuario_id, expira_em, criado_em, publicado_em, horas_para_expirar
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

    // Só o novo expira_em: sem orçamento a calcular, a query perdeu a metade budget_antes.
    // GREATEST(expira_em, NOW()) preservado — obra já vencida estende a partir de agora, e
    // não de um vencimento no passado (senão "+2h" compraria menos de 2h de vida real).
    const cap = await pool.query(
      `SELECT GREATEST($1::timestamptz, NOW()) + ($2::numeric * INTERVAL '1 hour') AS novo_expira_em`,
      [o.expira_em, horas]
    )

    const upd = await pool.query(
      `UPDATE obras SET expira_em = $1,
         marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL
       WHERE id = $2 AND criado_por = $3 RETURNING expira_em`,
      [cap.rows[0].novo_expira_em, req.params.id, req.usuario.id]
    )
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

    if (!ehDono) {
      await pool.query(`UPDATE obras SET total_visitas = COALESCE(total_visitas, 0) + 1 WHERE id = $1`, [req.params.id])
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
        `SELECT c.id, c.status, c.valor_proposto, c.valor_contraproposta, c.mensagem,
                u.nome, u.cidade, u.foto_url, c.usuario_id,
                u.anos_experiencia, u.especialidades, u.tamanho_equipe,
                CASE WHEN c.usuario_id = $2 THEN u.logradouro ELSE NULL END as logradouro,
                CASE WHEN c.usuario_id = $2 THEN u.numero ELSE NULL END as numero,
                CASE WHEN c.usuario_id = $2 THEN u.bairro ELSE NULL END as bairro,
                CASE WHEN c.usuario_id = $2 THEN u.telefone ELSE NULL END as telefone,
                (SELECT COUNT(*)::int FROM avaliacoes a WHERE a.avaliado_id = c.usuario_id) AS avaliacoes_total,
                (SELECT COALESCE(ROUND(AVG(a.estrelas)::numeric, 1), 0) FROM avaliacoes a WHERE a.avaliado_id = c.usuario_id) AS avaliacoes_media
         FROM candidaturas c JOIN usuarios u ON u.id = c.usuario_id
         WHERE c.obra_id = $1 ORDER BY c.criado_em DESC`,
        [req.params.id, obra.match_usuario_id]
      )
      candidatos = candidatosResult.rows
    }

    // Endereço exato só para dono, pintor do match ou admin (Finding 3.1).
    // Coordenadas permanecem para o cálculo de distância no cliente.
    if (obra.criado_por !== req.usuario.id && obra.match_usuario_id !== req.usuario.id && req.usuario.role !== 'admin') {
      delete obra.endereco_obra
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
  } catch (err) {
    console.error('Erro ao buscar obra:', err)
    res.status(500).json({ erro: 'Erro ao buscar obra' })
  }
})

// POST /obras/:id/candidatura — pintor se candidata a uma obra
router.post('/obras/:id/candidatura', autenticar, exigirAssinaturaAtiva, exigirPintor, async (req, res) => {
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
      const jaAceito = await pool.query(
        `SELECT id FROM candidaturas WHERE obra_id = $1 AND status = 'aceito' AND id != $2`,
        [req.params.id, candidaturaId]
      )
      if (jaAceito.rows.length > 0) {
        return res.status(409).json({ erro: 'Já existe um candidato aceito para esta obra' })
      }
      await pool.query(`UPDATE candidaturas SET status = 'aceito' WHERE id = $1`, [candidaturaId])
      if (cand.push_token) {
        enviarPushNotificacao(cand.push_token, '🎉 Deu match!',
          `Parabéns! Você fechou negócio em "${obra.rows[0].titulo}"! Toque para ver os detalhes.`,
          { tipo: 'candidatura_aceita', obra_id }).catch(() => {})
      }
      enviarContratoObra(candidaturaId).catch(err => console.error('Erro ao enviar contrato obra:', err))
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
    if (candidatura.rows[0].status !== 'contraproposta_dono') return res.status(400).json({ erro: 'Não há contraproposta pendente' })
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
      await pool.query(`UPDATE candidaturas SET status = 'aceito' WHERE id = $1`, [candidaturaId])
      if (dono.rows[0]?.push_token) {
        enviarPushNotificacao(dono.rows[0].push_token, '🎉 Deu match!',
          `Parabéns! Você fechou negócio em "${obra.rows[0].titulo}"! Toque para ver os detalhes.`,
          { tipo: 'candidatura_aceita', obra_id }).catch(() => {})
      }
      enviarContratoObra(candidaturaId).catch(err => console.error('Erro ao enviar contrato obra:', err))
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
    if (obra.rows[0].match_usuario_id) return res.status(409).json({ erro: 'Esta obra já tem um pintor a caminho' })
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
    // Recusa os demais candidatos e os notifica — pós-resposta, não bloqueia o cliente (Finding 3.1)
    const rejeitadosResult = await pool.query(
      `UPDATE candidaturas SET status = 'recusado' WHERE obra_id = $1 AND usuario_id != $2 AND status NOT IN ('recusado', 'expirado') RETURNING usuario_id`,
      [req.params.id, req.usuario.id]
    )
    const rejeitadosIds = rejeitadosResult.rows.map(r => r.usuario_id)
    if (rejeitadosIds.length > 0) {
      const tokens = await pool.query(
        `SELECT push_token FROM usuarios WHERE id = ANY($1) AND push_token IS NOT NULL`,
        [rejeitadosIds]
      )
      tokens.rows.forEach(r => {
        enviarPushNotificacao(r.push_token, '❌ Outro profissional foi selecionado',
          'O solicitante escolheu outro profissional para esta obra.',
          { tipo: 'candidatura_recusada', obra_id: req.params.id }).catch(() => {})
      })
    }
  } catch (err) {
    console.error('[obras/match]', err.message)
    res.status(500).json({ erro: 'Erro ao confirmar match' })
  }
})

// POST /obras/:id/encerrar — dono ou pintor encerra a obra
router.post('/obras/:id/encerrar', autenticar, async (req, res) => {
  try {
    const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
    if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    const o = obra.rows[0]
    const ehDono = o.criado_por === req.usuario.id
    const ehPintor = o.match_usuario_id === req.usuario.id
    const ehAdmin = req.usuario.role === 'admin'
    if (!ehDono && !ehPintor && !ehAdmin) return res.status(403).json({ erro: 'Sem permissão para encerrar esta obra' })
    await pool.query(`UPDATE obras SET status = 'encerrada', status_aprovacao = 'encerrada', encerrado_em = NOW() WHERE id = $1`, [req.params.id])
    if (ehDono && o.match_usuario_id) {
      const pintor = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.match_usuario_id])
      if (pintor.rows[0]?.push_token) {
        await enviarPushNotificacao(pintor.rows[0].push_token, '✅ Obra encerrada!',
          `O solicitante encerrou a obra "${o.titulo}".`, { tipo: 'obra_encerrada', obra_id: req.params.id })
      }
    } else if (ehPintor) {
      const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.criado_por])
      if (dono.rows[0]?.push_token) {
        await enviarPushNotificacao(dono.rows[0].push_token, '✅ Serviço concluído!',
          `O pintor concluiu a obra "${o.titulo}".`, { tipo: 'obra_encerrada', obra_id: req.params.id })
      }
    }
    res.json({ mensagem: 'Obra encerrada com sucesso!' })
  } catch (err) {
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
    const pintorId = o.match_usuario_id
    await pool.query(
      `UPDATE obras SET match_feito_em = NULL, match_usuario_id = NULL, pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL WHERE id = $1`,
      [req.params.id]
    )
    const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.criado_por])
    if (dono.rows[0]?.push_token) {
      enviarPushNotificacao(dono.rows[0].push_token, '⏰ Prazo expirado!',
        `O pintor não chegou a tempo para "${o.titulo}". A obra está disponível novamente.`,
        { tipo: 'match_expirado', obra_id: req.params.id }).catch(() => {})
    }
    res.json({ mensagem: 'Match expirado, obra disponível novamente' })
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
      await pool.query(
        `UPDATE obras SET match_feito_em = NULL, match_usuario_id = NULL, pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL WHERE id = $1`,
        [req.params.id]
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
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

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
    res.status(500).json({ erro: 'Erro ao buscar reparos' })
  }
})

router.post('/reparos/dono', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'dono_obra' && req.usuario.role !== 'admin') {
      return res.status(403).json({ erro: 'Apenas donos podem cadastrar reparos' })
    }
    const { titulo, categoria, descricao, valor_estimado, cidade, bairro, uf, tags, prazo_atendimento_horas, endereco_obra, latitude, longitude, client_request_id } = req.body
    const ufFinal = uf || await ufDeCidade(cidade)  // rede de segurança: deriva uf da cidade
    const { lat: latFinal, lng: lngFinal, origem: coordOrigem } = resolverCoordenadas(cidade, ufFinal, latitude, longitude, '[reparos/dono]')
    const horasExpiracao = prazo_atendimento_horas || 720
    const expira_em = new Date(Date.now() + horasExpiracao * 3600 * 1000)
    // ON CONFLICT no índice parcial (criado_por, client_request_id): retries com a mesma chave
    // retornam o reparo já criado em vez de inserir duplicata. Sem chave (NULL) → insert normal.
    const result = await pool.query(
      `INSERT INTO reparos (criado_por, titulo, categoria, descricao, valor_estimado, cidade, bairro, uf, tags, status, status_aprovacao, expira_em, prazo_atendimento_horas, endereco_reparo, latitude, longitude, coordenadas_origem, client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'aberta','aprovada',$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (criado_por, client_request_id) WHERE client_request_id IS NOT NULL
       DO UPDATE SET client_request_id = EXCLUDED.client_request_id
       RETURNING *`,
      [req.usuario.id, titulo, categoria, descricao, valor_estimado, cidade, bairro, ufFinal, tags || [], expira_em.toISOString(), prazo_atendimento_horas || null, endereco_obra, latFinal, lngFinal, coordOrigem, client_request_id || null]
    )
    res.status(201).json(result.rows[0])
    notificarPrestadoresSobreNovoReparo(result.rows[0].id).catch(err => console.error('Erro notificar prestadores:', err))
  } catch (err) {
    console.error('[reparos/dono]', err.message)
    res.status(500).json({ erro: 'Erro ao cadastrar reparo' })
  }
})

router.delete('/reparos/dono/:id', autenticar, async (req, res) => {
  try {
    const reparo = await pool.query(
      `SELECT id, match_usuario_id FROM reparos WHERE id = $1 AND criado_por = $2`,
      [req.params.id, req.usuario.id]
    )
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    if (reparo.rows[0].match_usuario_id) return res.status(409).json({ erro: 'Não é possível excluir um reparo com prestador a caminho' })
    await pool.query(`DELETE FROM midias_reparos WHERE reparo_id = $1`, [req.params.id])
    await pool.query(`DELETE FROM interesse_reparos WHERE reparo_id = $1`, [req.params.id])
    await pool.query(`DELETE FROM reparos WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Reparo excluído com sucesso' })
  } catch (err) {
    console.error('Erro ao deletar reparo:', err)
    res.status(500).json({ erro: 'Erro ao excluir reparo' })
  }
})

// Carência para estender reparo de faixa longa. "Esta semana" é a faixa > 24h; prazo NULL
// entra junto porque é a janela mais longa que existe (o expira_em da criação usa o default
// de 720h) e o app sequer rotula esses reparos. Faixas curtas (<= 24h) seguem sem carência:
// quem marcou "1 hora" precisa poder corrigir na hora.
const CARENCIA_ESTENDER_REPARO_HORAS = 1
const FAIXA_LONGA_REPARO_HORAS = 24

// Advisory de extensão do reparo. Não há mais teto no servidor (o de 2x saiu), mas o campo
// continua na resposta porque o app filtra as opções por ele (ModalEstenderPrazo). Valor
// generoso = "não gateia o menu"; NÃO é enforçado por nada.
const ADVISORY_ESTENDER_REPARO_HORAS = 8760

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
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    const r = reparo.rows[0]
    if (r.status !== 'aberta') return res.status(409).json({ erro: 'Só é possível estender um reparo aberto' })
    if (r.match_usuario_id) return res.status(409).json({ erro: 'Não é possível estender um reparo com prestador a caminho' })

    const horas = Number(req.body?.horas)
    if (!Number.isFinite(horas) || horas < 1) return res.status(400).json({ erro: 'horas inválido: informe um número >= 1' })

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

    const upd = await pool.query(
      `UPDATE reparos SET expira_em = $1,
         marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL
       WHERE id = $2 AND criado_por = $3 RETURNING expira_em`,
      [cap.rows[0].novo_expira_em, req.params.id, req.usuario.id]
    )
    res.json({ expira_em: upd.rows[0].expira_em, extensao_maxima_horas: ADVISORY_ESTENDER_REPARO_HORAS })
  } catch (err) {
    console.error('[reparos/estender]', err.message)
    res.status(500).json({ erro: 'Erro ao estender prazo do reparo' })
  }
})

router.get('/reparos/aprovacao', autenticar, exigirAdmin, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

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
    await pool.query(`UPDATE reparos SET status_aprovacao = 'aprovada', status = 'aberta' WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Reparo aprovado e publicado!' })
    notificarPrestadoresSobreNovoReparo(req.params.id).catch(err => console.error('Erro notificar prestadores:', err))
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar reparo' })
  }
})

router.post('/reparos/aprovacao/:id/recusar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE reparos SET status_aprovacao = 'recusada', status = 'cancelada' WHERE id = $1`, [req.params.id])
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
             (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) as foto_capa
      FROM interesse_reparos ir
      JOIN reparos r ON ir.reparo_id = r.id
      WHERE ir.usuario_id = $1
      ORDER BY ir.criado_em DESC
    `, [req.usuario.id])
    const agora = new Date()
    const eArquivado = item =>
      item.reparo_status === 'encerrada' ||
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
              ) AS ja_avaliei
       FROM reparos r
       JOIN usuarios u ON r.criado_por = u.id
       LEFT JOIN interesse_reparos ir ON ir.reparo_id = r.id AND ir.usuario_id = $1
       WHERE r.match_usuario_id = $1 AND r.status = 'encerrada'
       ORDER BY r.match_feito_em DESC NULLS LAST`,
      [req.usuario.id]
    )
    res.json({ contratos: result.rows })
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
              ) AS ja_avaliei
       FROM reparos r
       LEFT JOIN usuarios u ON r.match_usuario_id = u.id
       LEFT JOIN interesse_reparos ir ON ir.reparo_id = r.id AND ir.usuario_id = r.match_usuario_id
       WHERE r.criado_por = $1 AND r.status = 'encerrada'
       ORDER BY r.match_feito_em DESC NULLS LAST`,
      [req.usuario.id]
    )
    res.json({ contratos: result.rows })
  } catch (err) {
    console.error('[reparos/meus-contratos-dono]', err.message)
    res.status(500).json({ erro: 'Erro ao buscar contratos finalizados' })
  }
})

router.get('/reparos', autenticar, exigirPrestador, exigirReparador, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit
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
    res.status(500).json({ erro: 'Erro ao buscar reparos' })
  }
})

router.post('/reparos/:id/interesse', autenticar, exigirPrestador, exigirReparador, async (req, res) => {
  try {
    const { mensagem, valor_proposto } = req.body
    const existente = await pool.query(`SELECT id FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id])
    if (existente.rows.length > 0) return res.status(409).json({ erro: 'Você já demonstrou interesse neste reparo' })
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
        `Um prestador demonstrou interesse no reparo "${donoInfo.rows[0].titulo}"`,
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
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    if (reparo.rows[0].match_usuario_id) return res.status(409).json({ erro: 'Este reparo já tem um prestador a caminho' })
    const interesseAceito = await pool.query(
      `SELECT id FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2 AND status = 'aceito'`,
      [req.params.id, req.usuario.id]
    )
    if (interesseAceito.rows.length === 0) return res.status(403).json({ erro: 'Sua proposta ainda não foi aceita para este reparo.' })
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
    // Recusa os demais interessados e os notifica — pós-resposta, não bloqueia o cliente (Finding 3.1)
    const rejeitadosResult = await pool.query(
      `UPDATE interesse_reparos SET status = 'recusado' WHERE reparo_id = $1 AND usuario_id != $2 AND status NOT IN ('recusado', 'expirado') RETURNING usuario_id`,
      [req.params.id, req.usuario.id]
    )
    const rejeitadosIds = rejeitadosResult.rows.map(r => r.usuario_id)
    if (rejeitadosIds.length > 0) {
      const tokens = await pool.query(
        `SELECT push_token FROM usuarios WHERE id = ANY($1) AND push_token IS NOT NULL`,
        [rejeitadosIds]
      )
      tokens.rows.forEach(r => {
        enviarPushNotificacao(r.push_token, '❌ Outro profissional foi selecionado',
          'O solicitante escolheu outro prestador para este reparo.',
          { tipo: 'interesse_recusado', reparo_id: req.params.id }).catch(() => {})
      })
    }
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
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    if (reparo.rows[0].criado_por !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o dono pode responder' })

    const interesse = await pool.query(
      `SELECT ir.*, u.push_token FROM interesse_reparos ir JOIN usuarios u ON ir.usuario_id = u.id WHERE ir.id = $1 AND ir.reparo_id = $2`,
      [interesse_id, reparo_id]
    )
    if (interesse.rows.length === 0) return res.status(404).json({ erro: 'Interesse não encontrado' })
    const int = interesse.rows[0]

    if (action === 'aceitar') {
      const jaAceito = await pool.query(
        `SELECT id FROM interesse_reparos WHERE reparo_id = $1 AND status = 'aceito' AND id != $2`,
        [req.params.id, interesse_id]
      )
      if (jaAceito.rows.length > 0) {
        return res.status(409).json({ erro: 'Já existe um prestador aceito para este reparo' })
      }
      await pool.query(`UPDATE interesse_reparos SET status = 'aceito' WHERE id = $1`, [interesse_id])
      if (int.push_token) {
        enviarPushNotificacao(int.push_token, '🎉 Deu match!',
          `Parabéns! Você fechou negócio em "${reparo.rows[0].titulo}"! Toque para ver os detalhes.`,
          { tipo: 'interesse_aceito', reparo_id }).catch(() => {})
      }
      // O contrato é enviado quando o prestador confirma a ida (/reparos/:id/match),
      // ponto em que match_usuario_id é definido. Aqui ainda é nulo, então não envia.
      return res.json({ mensagem: 'Proposta aceita! O prestador foi notificado para confirmar a ida.' })
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
      // Idempotency for accept retries: if already accepted, return success silently
      if (action === 'aceitar' && interesse.rows[0].status === 'aceito') {
        return res.json({ mensagem: 'Contraproposta aceita! Confirme sua ida para gerar o contrato.' })
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
      await pool.query(`UPDATE interesse_reparos SET status = 'aceito' WHERE id = $1`, [interesse_id])
      if (dono.rows[0]?.push_token) {
        enviarPushNotificacao(dono.rows[0].push_token, '🎉 Deu match!',
          `Parabéns! Você fechou negócio em "${reparo.rows[0].titulo}"! Toque para ver os detalhes.`,
          { tipo: 'interesse_aceito', reparo_id }).catch(() => {})
      }
      // Contrato é enviado quando o prestador confirma a ida (/reparos/:id/match).
      return res.json({ mensagem: 'Contraproposta aceita! Confirme sua ida para gerar o contrato.' })
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

router.post('/reparos/:id/encerrar', autenticar, async (req, res) => {
  try {
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    const r = reparo.rows[0]
    const ehDono      = r.criado_por === req.usuario.id
    const ehPrestador = r.match_usuario_id === req.usuario.id
    const ehAdmin     = req.usuario.role === 'admin'
    if (!ehDono && !ehPrestador && !ehAdmin) return res.status(403).json({ erro: 'Sem permissão para encerrar este reparo' })
    await pool.query(`UPDATE reparos SET status = 'encerrada', status_aprovacao = 'encerrada', encerrado_em = NOW() WHERE id = $1`, [req.params.id])
    if (ehDono && r.match_usuario_id) {
      const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
      if (prestador.rows[0]?.push_token) {
        await enviarPushNotificacao(prestador.rows[0].push_token, '✅ Reparo encerrado!',
          `O solicitante encerrou o reparo "${r.titulo}".`, { tipo: 'reparo_encerrado', reparo_id: req.params.id })
      }
    } else if (ehPrestador) {
      const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.criado_por])
      if (dono.rows[0]?.push_token) {
        await enviarPushNotificacao(dono.rows[0].push_token, '✅ Serviço concluído!',
          `O prestador concluiu o reparo "${r.titulo}".`, { tipo: 'reparo_encerrado', reparo_id: req.params.id })
      }
    }
    res.json({ mensagem: 'Reparo encerrado com sucesso!' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao encerrar reparo' })
  }
})

router.post('/reparos/:id/expirar-match', autenticar, async (req, res) => {
  try {
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    const r = reparo.rows[0]
    const ehDono      = r.criado_por === req.usuario.id
    const ehPrestador = r.match_usuario_id === req.usuario.id
    const ehAdmin     = req.usuario.role === 'admin'
    if (!ehDono && !ehPrestador && !ehAdmin) {
      return res.status(403).json({ erro: 'Sem permissão para expirar este match' })
    }
    // Grava o prestador na lista negra antes de limpar o match
    await pool.query(
      `UPDATE reparos SET
        match_feito_em = NULL,
        match_usuario_id = NULL,
        prestadores_bloqueados = array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid)
       WHERE id = $1`,
      [req.params.id, r.match_usuario_id]
    )
    res.json({ mensagem: 'Match expirado, reparo disponível novamente' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao expirar match' })
  }
})

// Prestador solicita mais tempo — envia motivo e notifica dono
router.post('/reparos/:id/pedir-tempo', autenticar, async (req, res) => {
  try {
    const { motivo } = req.body
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
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
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
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
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
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
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
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
      // Recusou — bloqueia prestador e volta reparo para disponível
      await pool.query(
        `UPDATE reparos SET
          match_feito_em = NULL,
          match_usuario_id = NULL,
          pedido_tempo_status = NULL,
          pedido_tempo_motivo = NULL,
          pedido_tempo_minutos = NULL,
          prestadores_bloqueados = array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid)
         WHERE id = $1`,
        [req.params.id, r.match_usuario_id]
      )

      // Notifica prestador
      const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
      if (prestador.rows[0]?.push_token) {
        await enviarPushNotificacao(
          prestador.rows[0].push_token,
          '❌ Tempo extra recusado',
          'O solicitante não aceitou. O reparo voltou para disponível.',
          { tipo: 'tempo_recusado', reparo_id: req.params.id }
        )
      }

      res.json({ mensagem: 'Tempo recusado. Reparo disponível novamente.' })
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
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })

    const reparo = result.rows[0]
    const ehDono           = reparo.criado_por === req.usuario.id
    const ehPrestadorDoMatch = reparo.match_usuario_id === req.usuario.id

    // Dono sempre pode ver seu próprio reparo
    // Prestador do match sempre pode ver
    // Admin sempre pode ver
    // Prestador comum precisa de assinatura ativa
    if (!ehDono && !ehPrestadorDoMatch && req.usuario.role !== 'admin') {
      if (req.usuario.role !== 'prestador') {
        return res.status(403).json({ erro: 'Sem permissão para ver este reparo' })
      }
      const assinatura = await pool.query(
        `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' AND (proximo_vencimento IS NULL OR proximo_vencimento > NOW()) LIMIT 1`,
        [req.usuario.id]
      )
      if (assinatura.rows.length === 0) {
        return res.status(403).json({ erro: 'Assinatura inativa. Renove seu plano para acessar os reparos.' })
      }
    }

    // Só conta visita se for prestador (não dono consultando o próprio reparo)
    if (!ehDono) {
      await pool.query(`UPDATE reparos SET total_visitas = COALESCE(total_visitas, 0) + 1 WHERE id = $1`, [req.params.id])
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
        `SELECT ir.id, ir.usuario_id, ir.status, ir.mensagem, ir.criado_em,
                ir.valor_proposto, ir.valor_contraproposta, ir.rodada,
                u.nome, u.cidade, u.foto_url, u.anos_experiencia, u.especialidades, u.tamanho_equipe,
                CASE WHEN ir.usuario_id = $2 THEN u.logradouro ELSE NULL END as logradouro,
                CASE WHEN ir.usuario_id = $2 THEN u.numero ELSE NULL END as numero,
                CASE WHEN ir.usuario_id = $2 THEN u.bairro ELSE NULL END as bairro,
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

    // Endereço exato só para dono, prestador do match ou admin (Finding 3.1).
    // Coordenadas permanecem para o cálculo de distância no cliente.
    if (reparo.criado_por !== req.usuario.id && reparo.match_usuario_id !== req.usuario.id && req.usuario.role !== 'admin') {
      delete reparo.endereco_reparo
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
  } catch (err) {
    console.error('Erro ao buscar reparo:', err)
    res.status(500).json({ erro: 'Erro ao buscar reparo' })
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
      `WITH del AS (DELETE FROM midias_reparos WHERE reparo_id = $1 AND ordem = $4)
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
      `WITH del AS (DELETE FROM midias WHERE obra_id = $1 AND ordem = $4)
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
    // CONTRATOS primeiro: contratos.candidatura_id → candidaturas.id e
    // contratos.interesse_id → interesse_reparos.id. Sem isso a transação faz
    // rollback na FK ao apagar candidaturas/interesse_reparos. Wipe total é
    // correto aqui — esta rotina apaga todos os dados não-admin.
    await client.query(`DELETE FROM contratos`)
    await client.query(`DELETE FROM interesse_reparos`)
    await client.query(`DELETE FROM midias_reparos`)
    await client.query(`DELETE FROM reparos`)
    await client.query(`DELETE FROM candidaturas`)
    await client.query(`DELETE FROM midias`)
    await client.query(`DELETE FROM obras`)
    await client.query(`DELETE FROM mensagens`)
    await client.query(`DELETE FROM assinaturas WHERE usuario_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    await client.query(`DELETE FROM localizacoes_prestadores WHERE usuario_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    await client.query(`DELETE FROM prestadores_bloqueados_dono WHERE dono_id IN (SELECT id FROM usuarios WHERE role != 'admin') OR prestador_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    await client.query(`DELETE FROM usuarios WHERE role != 'admin'`)
    await client.query('COMMIT')
    res.json({ mensagem: 'Dados de teste removidos com sucesso!' })
  } catch (err) {
    await client.query('ROLLBACK')
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
          WHEN plano = 'anual'   THEN NOW() + INTERVAL '365 days'
          ELSE NOW() + INTERVAL '30 days' END
       WHERE usuario_id = $1`, [id]
    )

    // Assinatura acabou de virar 'ativa' — derruba o cache para o app não cair na
    // tela de pagamento por causa de um `ativa=false` ainda cacheado (B72-07).
    invalidarCachesUsuario(id)

    // Notifica prestador por e-mail
    const { nome, email } = usuario.rows[0]
    const marca = marcaPorTipo(usuario.rows[0])
    const nodemailer = require('nodemailer')
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: 587, secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
    transporter.sendMail({
      from: `${marca} <${process.env.SMTP_USER}>`,
      to: email,
      subject: `✅ ${marca} — Cadastro aprovado! Bem-vindo!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #4caf50; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #fff; margin: 0;">✅ Cadastro Aprovado!</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2>Parabéns, ${nome}!</h2>
            <p>Sua identidade foi verificada e seu acesso ao ${marca} está liberado.</p>
            <p>Abra o aplicativo e comece a encontrar serviços na sua região agora mesmo!</p>
            <p><strong>Equipe ${marca}</strong></p>
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
        'Sua identidade foi verificada. Bem-vindo ao ArrumaPro!',
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
    const marca = marcaPorTipo(usuario.rows[0])

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
      from: `${marca} <${process.env.SMTP_USER}>`,
      to: email,
      subject: `${marca} — Informação sobre seu cadastro`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #0a0a0a; margin: 0;">${marca}</h1>
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
            <p><strong>Equipe ${marca}</strong></p>
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
      for (const p of pendentes.rows) {
        // Aprovação em lote ao ligar o Modo Auto: também é não-revisada → marca automática
        await pool.query(`UPDATE usuarios SET verificacao_status = 'aprovado', aprovado_automaticamente = true WHERE id = $1`, [p.id])
        await pool.query(`UPDATE assinaturas SET status = 'ativa', atualizado_em = NOW(),
          proximo_vencimento = CASE
            WHEN tipo = 'gratuito' THEN NULL
            WHEN plano = 'anual'   THEN NOW() + INTERVAL '365 days'
            ELSE NOW() + INTERVAL '30 days' END
         WHERE usuario_id = $1`, [p.id])
      }
      console.log(`[Modo automático] ${pendentes.rows.length} prestadores aprovados automaticamente`)
    }

    res.json({ mensagem: ativo ? 'Modo automático ativado' : 'Modo automático desativado', ativo })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar configuração' })
  }
})

// ============================================================
// JANELA DE LANÇAMENTO GRÁTIS (config em banco — sem Railway)
// ============================================================

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
router.post('/config/lancamento', autenticar, exigirAdmin, async (req, res) => {
  try {
    const { data_fim } = req.body
    // valor é NOT NULL na tabela: usar '' (não null) como estado "desligado" para
    // nunca violar a constraint. Downstream trata '' e ausência como janela off.
    let valor = ''
    if (data_fim !== null && data_fim !== undefined && data_fim !== '') {
      const d = new Date(data_fim)
      if (isNaN(d.getTime())) return res.status(400).json({ erro: 'data_fim inválida — use uma data ISO válida ou null para desligar' })
      valor = d.toISOString()
    }
    await pool.query(
      `UPDATE configuracoes SET valor = $1, atualizado_em = NOW() WHERE chave = 'lancamento_data_fim'`,
      [valor]
    )
    res.json({ data_fim: valor || null, gratis: !!valor && new Date(valor) > new Date() })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar janela de lançamento' })
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

// GET /avaliacoes/recebidas — lista as avaliações RECEBIDAS pelo usuário autenticado
// (avaliado_id = req.usuario.id), com o nome de quem avaliou (transparência estilo iFood)
// e um resumo (média + total) para o cabeçalho da tela. Rota estática — registrada depois de
// '/avaliacoes/media/:usuario_id' e não colide com ela (segmento 'recebidas' != 'media').
router.get('/avaliacoes/recebidas', autenticar, async (req, res) => {
  try {
    const uid = req.usuario.id
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit

    // Resumo (média + total): computado on-read — não há coluna cacheada em usuarios.
    // Espelha GET /avaliacoes/media/:usuario_id acima.
    const resumo = await pool.query(
      `SELECT COUNT(*)::int AS total, COALESCE(ROUND(AVG(estrelas)::numeric, 1), 0) AS media
       FROM avaliacoes WHERE avaliado_id = $1`,
      [uid]
    )

    // Lista paginada. Colunas EXPLÍCITAS (nunca SELECT *): do avaliador expõe SÓ u.nome —
    // jamais email/telefone/CPF/qualquer outro PII. comentario ainda não existe no schema
    // (a avaliação só grava estrelas) → devolvido como NULL, placeholder de contrato até a
    // captura de comentário existir no write-path e no app.
    const lista = await pool.query(
      `SELECT a.id,
              a.estrelas      AS nota,
              NULL::text      AS comentario,
              a.criado_em     AS created_at,
              a.contrato_tipo AS contrato_tipo,
              u.nome          AS avaliador_nome
       FROM avaliacoes a
       JOIN usuarios u ON u.id = a.avaliador_id
       WHERE a.avaliado_id = $1
       ORDER BY a.criado_em DESC
       LIMIT $2 OFFSET $3`,
      [uid, limit, offset]
    )

    res.json({
      media: parseFloat(resumo.rows[0].media),
      total: resumo.rows[0].total,
      page,
      limit,
      avaliacoes: lista.rows
    })
  } catch (err) {
    console.error('[Avaliacoes] Erro recebidas:', err.message)
    res.status(500).json({ erro: 'Erro ao buscar avaliações recebidas' })
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

    let registrados = 0
    for (const item of itens) {
      if (!item || !['reparo', 'obra'].includes(item.tipo) || !item.id) continue
      const result = await pool.query(
        `INSERT INTO feed_visualizacoes (usuario_id, item_tipo, item_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (usuario_id, item_tipo, item_id) DO NOTHING`,
        [req.usuario.id, item.tipo, item.id]
      )
      registrados += result.rowCount
    }

    res.json({ registrados })
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
router.post('/feed/checar-proximidade', autenticar, exigirPrestador, exigirReparador, async (req, res) => {
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
    const [obras, assinaturas, candidaturas, obrasAprovacao, reparosAprovacao, reparos] = await Promise.all([
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
      pool.query(`SELECT COUNT(*) FROM reparos WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()`)
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
      reparos_para_aprovar: parseInt(reparosAprovacao.rows[0].count)
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
    await client.query(`DELETE FROM midias WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = ANY($1))`, [ids])
    // CONTRATOS primeiro: contratos.candidatura_id → candidaturas.id e
    // contratos.interesse_id → interesse_reparos.id. Sem isso a transação faz
    // rollback na FK ao apagar candidaturas/interesse_reparos.
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
    await client.query(`DELETE FROM midias_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por = ANY($1))`, [ids])
    await client.query(`DELETE FROM interesse_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por = ANY($1))`, [ids])
    await client.query(`DELETE FROM reparos WHERE criado_por = ANY($1)`, [ids])
    // Registros dos usuários alvo como participantes (candidato/interessado/autor) em
    // itens de terceiros — necessário antes do DELETE FROM usuarios por causa das FKs
    await client.query(`DELETE FROM candidaturas WHERE usuario_id = ANY($1)`, [ids])
    await client.query(`DELETE FROM interesse_reparos WHERE usuario_id = ANY($1)`, [ids])
    await client.query(`DELETE FROM mensagens WHERE autor_id = ANY($1)`, [ids])
    await client.query(`DELETE FROM prestadores_bloqueados_dono WHERE dono_id IN (SELECT id FROM usuarios WHERE role != 'admin') OR prestador_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    await client.query(`DELETE FROM usuarios WHERE role != 'admin'`)
    await client.query('COMMIT')
    res.json({ mensagem: 'Usuários removidos com sucesso' })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Erro ao limpar usuários:', err)
    res.status(500).json({ erro: 'Erro ao limpar usuários' })
  } finally { client.release() }
})

router.post('/admin/limpar-obras', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM candidaturas`)
    await client.query(`DELETE FROM midias`)
    await client.query(`DELETE FROM obras`)
    await client.query('COMMIT')
    res.json({ mensagem: 'Obras removidas com sucesso' })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Erro ao limpar obras:', err)
    res.status(500).json({ erro: 'Erro ao limpar obras' })
  } finally { client.release() }
})

router.post('/admin/limpar-reparos', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM interesse_reparos`)
    await client.query(`DELETE FROM midias_reparos`)
    await client.query(`DELETE FROM reparos`)
    await client.query('COMMIT')
    res.json({ mensagem: 'Reparos removidos com sucesso' })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Erro ao limpar reparos:', err)
    res.status(500).json({ erro: 'Erro ao limpar reparos' })
  } finally { client.release() }
})

router.post('/admin/limpar-mensagens', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM mensagens`)
    res.json({ mensagem: 'Mensagens removidas com sucesso' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao limpar mensagens' })
  }
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
    const secret = speakeasy.generateSecret({ name: `PinturaPro Admin (${email})`, length: 20 })
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