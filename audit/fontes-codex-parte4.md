# Fontes — Codex (parte 4 de 4)

Código-fonte REAL de `pinturapro-api` (branch `main`), selecionado para o auditor externo julgar as regras descritas em `dossie-codex.md`. Cada bloco traz `caminho:linha-inicial-linha-final` e cada linha vem prefixada com o número dela no arquivo. Nada de `.env`, segredos ou dados de produção — todos os segredos são lidos de `process.env`. Comentários foram mantidos porque carregam o racional de cada regra.

Seções: 1 gates · 2 dinheiro · 3 verificação/aprovação · 4 ciclo de vida OBRA · 5 ciclo de vida REPARO · 6 compartilhado · 7 crons · 8 migração de boot.


## (continuação) 8. Migração de boot (esquema é criado/alterado aqui, idempotente, antes de o servidor ouvir)

### src/routes/index.js:50-967 — migracaoPronta: CREATE TABLE/ALTER TABLE IF NOT EXISTS, índices, configuracoes, backfills

```js
 50| const migracaoPronta = (async () => {
 51|   // pool.connect() dentro do try: erro de conexão (ex.: DB inacessível) é logado
 52|   // em vez de virar unhandled rejection que derruba o processo (crash-loop / 502).
 53|   let client
 54|   try {
 55|     client = await pool.connect()
 56|     await client.query('BEGIN')
 57|     // Isenta ESTA transação do statement_timeout global de 10s do pool (utils/supabase.js).
 58|     // A migração roda ANTES do app.listen (server.js aguarda migracaoPronta), e um CREATE
 59|     // INDEX não-concorrente numa obras/reparos grande passa fácil dos 10s: o timeout mataria
 60|     // o statement, a migração lançaria e o servidor NUNCA subiria. SET LOCAL só vale até o
 61|     // COMMIT — a conexão volta ao pool com o teto normal.
 62|     await client.query('SET LOCAL statement_timeout = 0')
 63|     await client.query(`ALTER TABLE interesse_reparos ADD COLUMN IF NOT EXISTS valor_proposto NUMERIC`)
 64|     await client.query(`ALTER TABLE interesse_reparos ADD COLUMN IF NOT EXISTS valor_contraproposta NUMERIC`)
 65|     await client.query(`ALTER TABLE interesse_reparos ADD COLUMN IF NOT EXISTS rodada INTEGER DEFAULT 1`)
 66|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS alerta_sem_interessados_em TIMESTAMP WITH TIME ZONE`)
 67|     await client.query(`ALTER TABLE candidaturas ADD COLUMN IF NOT EXISTS valor_contraproposta NUMERIC`)
 68|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS alerta_sem_interessados_em TIMESTAMP WITH TIME ZONE`)
 69|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS match_feito_em TIMESTAMP WITH TIME ZONE`)
 70|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS match_usuario_id UUID REFERENCES usuarios(id)`)
 71|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS pedido_tempo_status VARCHAR(50)`)
 72|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS pedido_tempo_motivo TEXT`)
 73|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS pedido_tempo_minutos INTEGER`)
 74|     // Flag "aviso de 5min já enviado" do cronômetro de obras (espelha reparos.notif_5min_enviada).
 75|     // Evita reenviar o aviso pré-expiração a cada tick de 1min enquanto o match está na janela final.
 76|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS notif_5min_enviada BOOLEAN DEFAULT false`)
 77|     await client.query(`ALTER TABLE candidaturas ADD COLUMN IF NOT EXISTS valor_proposto NUMERIC`)
 78|     await client.query(`ALTER TABLE candidaturas ADD COLUMN IF NOT EXISTS mensagem TEXT`)
 79|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS uf VARCHAR(2)`)
 80|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS endereco_reparo TEXT`)
 81|     // Ponto de referência do local ("portão azul, ao lado da padaria"). Texto livre do dono,
 82|     // mascarado nos detalhes junto com endereco_* — mesma sensibilidade, mesma regra.
 83|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS ponto_referencia TEXT`)
 84|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS latitude NUMERIC`)
 85|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS longitude NUMERIC`)
 86|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS notif_5min_enviada BOOLEAN DEFAULT false`)
 87|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS uf VARCHAR(2)`)
 88|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS endereco_obra TEXT`)
 89|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS ponto_referencia TEXT`)
 90|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS latitude NUMERIC`)
 91|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS longitude NUMERIC`)
 92|     // Procedência da coordenada: 'cliente' = veio do app (endereço exato, precisão de rua);
 93|     // 'centro_cidade' = derivada da sede do município (precisão de cidade). NULL = linha
 94|     // legada, origem desconhecida — o app deve tratar NULL como 'cliente' (comportamento de
 95|     // hoje), por isso NÃO há backfill de origem para linhas antigas que já tinham coordenada.
 96|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS coordenadas_origem TEXT`)
 97|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS coordenadas_origem TEXT`)
 98|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verificacao_status VARCHAR(50) DEFAULT 'nao_solicitada'`)
 99|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verificacao_doc_frente_url TEXT`)
100|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verificacao_doc_verso_url TEXT`)
101|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verificacao_selfie_url TEXT`)
102|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tipo_dono VARCHAR(50)`)
103|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pix_reembolso VARCHAR(200)`)
104|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS referencias TEXT`)
105|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rg VARCHAR(20)`)
106|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rg_orgao VARCHAR(20)`)
107|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rg_estado VARCHAR(2)`)
108|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS dois_fa_secret VARCHAR(100)`)
109|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS dois_fa_ativo BOOLEAN DEFAULT false`)
110|     // Versão de token: revogação de sessão por troca de senha (D51). O JWT carrega a versão
111|     // vigente na emissão; trocar a senha incrementa a coluna e os tokens antigos param de casar.
112|     // NOT NULL DEFAULT 1: linhas existentes viram versão 1 (= tokens legados sem 'tv', tratados
113|     // como 1 no autenticar), então o deploy NÃO desloga ninguém.
114|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1`)
115|     // Redefinição de senha por código (DDL existia só em prod, criada fora da migração — aqui
116|     // para um banco novo não nascer sem elas). reset_token guarda o HASH bcrypt do código.
117|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token TEXT`)
118|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token_expira TIMESTAMPTZ`)
119|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tipo_prestador VARCHAR(20)`)
120|     // Auditoria de aprovação: true = aprovado pelo job automático (Modo Auto ON) sem revisão
121|     // de idoneidade; false = aprovado/reprovado manualmente por admin; null = legado/não tocado.
122|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS aprovado_automaticamente BOOLEAN`)
123|     // Tela de boas-vindas única do prestador: false = ainda não exibida; true = já dispensada (não exibir de novo).
124|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS boas_vindas_exibida BOOLEAN DEFAULT false`)
125|     // Localização do prestador no cadastro (CEP → ViaCEP/Nominatim). Base p/ distância futura.
126|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cep VARCHAR(8)`)
127|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS latitude NUMERIC`)
128|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS longitude NUMERIC`)
129|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS logradouro VARCHAR(200)`)
130|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS numero VARCHAR(20)`)
131|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS complemento VARCHAR(100)`)
132|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bairro VARCHAR(100)`)
133|     // Diagnóstico de push: por que o usuário está sem push_token. Hoje só existe o sinal
134|     // push_token IS NULL, que confunde cinco estados distintos. push_status registra o
135|     // motivo, reportado pelo app. Valores aceitos (texto puro, sem CHECK — mesma convenção
136|     // de verificacao_status): 'concedida' (permissão dada), 'negada' (permissão recusada),
137|     // 'bloqueada' (recusa permanente, canAskAgain=false), 'erro_registro' (falha ao obter/
138|     // enviar o token), 'nao_solicitada' (app nunca chegou a pedir a permissão). Default
139|     // 'desconhecido' enquanto o app ainda não reportou.
140|     // push_status_em = quando o estado foi observado (sem default: NULL até o 1º report,
141|     // evitando o rewrite de tabela que um default volátil como NOW() forçaria). Colunas
142|     // aditivas: nenhuma query existente as lê.
143|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS push_status VARCHAR(50) DEFAULT 'desconhecido'`)
144|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS push_status_em TIMESTAMPTZ`)
145|     // Flag global "Modo Auto" — garante a existência da linha (tabela já existe em prod).
146|     // Default 'false' = OFF: novos prestadores aguardam revisão manual do admin.
147|     await client.query(`CREATE TABLE IF NOT EXISTS configuracoes (chave TEXT PRIMARY KEY, valor TEXT, atualizado_em TIMESTAMPTZ DEFAULT NOW())`)
148|     await client.query(`INSERT INTO configuracoes (chave, valor)
149|                         SELECT 'aprovacao_automatica', 'false'
150|                         WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = 'aprovacao_automatica')`)
151|     // Janela de lançamento grátis — valor = timestamp ISO enquanto o período está
152|     // ativo, string vazia '' quando desligado. Governa apenas NOVOS cadastros; linhas
153|     // tipo='gratuito' já criadas permanecem grátis (a lógica de aprovação mesclada
154|     // mantém proximo_vencimento NULL para elas). Admin liga/desliga pelo painel.
155|     // valor é NOT NULL: seed com '' (não NULL) para não violar a constraint no boot.
156|     await client.query(`INSERT INTO configuracoes (chave, valor)
157|                         SELECT 'lancamento_data_fim', ''
158|                         WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = 'lancamento_data_fim')`)
159|     // Flag global "Aprovação automática de OBRAS" — ligada, a obra enviada pelo dono é
160|     // publicada na hora, sem passar pela fila do admin. Default 'false' = OFF: mantém a
161|     // revisão manual de hoje. Mesma convenção das duas chaves acima (valor TEXT 'true'/'false').
162|     await client.query(`INSERT INTO configuracoes (chave, valor)
163|                         SELECT 'aprovacao_automatica_obras', 'false'
164|                         WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = 'aprovacao_automatica_obras')`)
165|     // Teto de demandas simultâneas para dono sem histórico (ver limiteDemandasAtingido).
166|     // valor = inteiro positivo em TEXT, como as demais chaves. Admin ajusta pelo painel.
167|     await client.query(`INSERT INTO configuracoes (chave, valor)
168|                         SELECT 'limite_demandas_live_sem_historico', '5'
169|                         WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = 'limite_demandas_live_sem_historico')`)
170|     // Resposta da equipe às dúvidas (mensagens): quem respondeu e quando. As DUAS colunas já
171|     // eram escritas por mensagensController.responder e lidas por porObra, mas nunca existiram
172|     // na tabela — as duas rotas estouravam 42703 e devolviam 500. Tipos batendo com o que o
173|     // controller grava: respondido_por = req.usuario.id (uuid), respondido_em = NOW() (timestamptz).
174|     await client.query(`ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS respondido_por UUID`)
175|     await client.query(`ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS respondido_em  TIMESTAMPTZ`)
176|     // Fila de dúvidas sem resposta: índice PARCIAL sobre o mesmo predicado que GET
177|     // /mensagens/pendentes e o contador do /dashboard usam (respondido = false). Chave
178|     // criado_em porque a listagem ordena por ela — o índice serve a contagem e à página.
179|     // Parcial de propósito: a fila é a minoria das linhas, e respondidas não entram no índice.
180|     await client.query(`CREATE INDEX IF NOT EXISTS mensagens_pendentes_idx ON mensagens (criado_em) WHERE respondido = false`)
181|     // Redundante: mesmo predicado parcial do mensagens_pendentes_idx acima e, dentro dele,
182|     // `respondido` é constante — a chave efetiva dos dois é (criado_em).
183|     await client.query(`DROP INDEX IF EXISTS idx_mensagens_respondido`)
184|     // Contratos de reparo: referência ao interesse aceito (paridade com candidatura_id de obra)
185|     await client.query(`ALTER TABLE contratos ADD COLUMN IF NOT EXISTS interesse_id uuid`)
186|     // Valor ACORDADO congelado no ENVIO do contrato: COALESCE(valor_contraproposta,
187|     // valor_proposto) da candidatura/interesse aceito no instante da emissão — torna o PDF
188|     // emitido um registro auditável, imune a edições posteriores da candidatura/interesse.
189|     // NUMERIC nullable (mesma convenção de valor_proposto/valor_contraproposta); NULL = caso
190|     // "a combinar entre as partes". Coluna aditiva: nenhuma query existente a lê. Fica ao lado
191|     // do ALTER de interesse_id de propósito — os dois dependem de contratos já existir.
192|     await client.query(`ALTER TABLE contratos ADD COLUMN IF NOT EXISTS valor_acordado NUMERIC`)
193|     // Índice único PARCIAL em interesse_id (D79): o claim do contrato de reparo era
194|     // INSERT ... WHERE NOT EXISTS sem índice — duas execuções concorrentes passavam as duas e
195|     // gravavam dois contratos (e dois e-mails). Parcial porque a linha de obra tem
196|     // interesse_id NULL; mesmo padrão dos índices de client_request_id acima. Sem duplicatas
197|     // em produção na data da migração (verificado), então o CREATE não falha no boot.
198|     await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS contratos_interesse_id_uniq ON contratos (interesse_id) WHERE interesse_id IS NOT NULL`)
199|     // Idempotência de criação de obra/reparo — evita duplicatas em retries após timeout/ERR_NETWORK
200|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS client_request_id TEXT`)
201|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS client_request_id TEXT`)
202|     await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS obras_criado_por_client_request_id_uniq ON obras (criado_por, client_request_id) WHERE client_request_id IS NOT NULL`)
203|     await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS reparos_criado_por_client_request_id_uniq ON reparos (criado_por, client_request_id) WHERE client_request_id IS NOT NULL`)
204|     // Previsão e confirmação de CHEGADA do profissional ao local (obras e reparos, mesmas colunas).
205|     //   chegada_janela        → rótulo escolhido pelo profissional ('hoje' | 'amanha_manha' | 'amanha_tarde')
206|     //   chegada_prevista_em   → instante-limite da janela, resolvido em America/Sao_Paulo. Escrito UMA vez.
207|     //   chegada_declarada_por → quem declarou a chegada PRIMEIRO (dono ou profissional)
208|     //   chegada_declarada_em  → quando essa primeira declaração entrou
209|     //   chegada_confirmada_em → chegada confirmada de fato; só o dono confirma (ver POST /:id/chegada)
210|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_janela        TEXT`)
211|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_prevista_em   TIMESTAMPTZ`)
212|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_declarada_por UUID`)
213|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_declarada_em  TIMESTAMPTZ`)
214|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_confirmada_em TIMESTAMPTZ`)
215|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_janela        TEXT`)
216|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_prevista_em   TIMESTAMPTZ`)
217|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_declarada_por UUID`)
218|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_declarada_em  TIMESTAMPTZ`)
219|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_confirmada_em TIMESTAMPTZ`)
220|     // Janela de chegada que estoura o expira_em: fica PENDENTE aqui até o dono responder, em vez
221|     // de virar chegada_prevista_em direto. Sem este par, prometer "amanhã à tarde" numa demanda
222|     // que vence hoje ou estenderia o prazo sem o dono saber, ou seria recusado sem negociação.
223|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_pendente_janela TEXT`)
224|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_pendente_em     TIMESTAMPTZ`)
225|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_pendente_janela TEXT`)
226|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_pendente_em     TIMESTAMPTZ`)
227|     // Marca que o DONO recusou uma janela. Isenta o profissional de falta e de bloqueio quando o
228|     // match morre sem nenhuma janela valendo: ele ofereceu um horário, o dono disse não, e a
229|     // demanda venceu no prazo antigo — o no-show aí é da negociação, não dele.
230|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS chegada_recusada_em TIMESTAMPTZ`)
231|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS chegada_recusada_em TIMESTAMPTZ`)
232|     // Lista negra POR OBRA, espelho de reparos.prestadores_bloqueados (que nasceu fora deste
233|     // arquivo — não há ALTER dele aqui). Mesmo nome de coluna nas duas tabelas de propósito: as
234|     // queries de feed ficam idênticas. Guarda os profissionais que já furaram ESTA demanda; é
235|     // por linha, não global (a lista global do dono é a tabela prestadores_bloqueados_dono).
236|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS prestadores_bloqueados UUID[]`)
237|     // O de reparos existe em produção desde antes deste arquivo, mas nunca teve ALTER aqui —
238|     // um banco novo (dev/staging) subia sem a coluna e quebrava feed e un-match. IF NOT EXISTS
239|     // torna isto no-op em produção e obrigatório em qualquer base limpa.
240|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS prestadores_bloqueados UUID[]`)
241|     // Índices para o filtro por raio (feed). PostGIS/GiST não é assumido como disponível,
242|     // então usamos btree em (latitude, longitude) — sempre disponível no Postgres padrão.
243|     // Acelera a pré-seleção de linhas com coordenadas; o haversine continua sendo calculado por linha.
244|     await client.query(`CREATE INDEX IF NOT EXISTS obras_lat_lng_idx ON obras (latitude, longitude)`)
245|     await client.query(`CREATE INDEX IF NOT EXISTS reparos_lat_lng_idx ON reparos (latitude, longitude)`)
246|     // Flag de contrato enviado — permite detectar matches cujo e-mail de contrato falhou (Finding 3.2)
247|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS contrato_enviado BOOLEAN DEFAULT false`)
248|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS contrato_enviado BOOLEAN DEFAULT false`)
249|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS encerrado_em TIMESTAMPTZ`)
250|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS encerrado_em TIMESTAMPTZ`)
251|     // Encerramento assimétrico: a chamada do PROFISSIONAL a /encerrar registra a solicitação,
252|     // e o DONO fecha de fato (o dono nunca solicita — encerrar, para ele, encerra na hora).
253|     // encerramento_solicitado_por IS NOT NULL É o estado pendente — sem status novo no banco:
254|     // a demanda segue 'aberta' até fechar, e encerrado_em continua significando "fechada de
255|     // verdade". _por diz QUEM pediu, que é como o handler distingue repetição do profissional
256|     // (mesma parte, segue pendente) de qualquer outra chamada, que fecha.
257|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS encerramento_solicitado_por UUID REFERENCES usuarios(id)`)
258|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS encerramento_solicitado_em  TIMESTAMPTZ`)
259|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS encerramento_solicitado_por UUID REFERENCES usuarios(id)`)
260|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS encerramento_solicitado_em  TIMESTAMPTZ`)
261|     // Relógio de publicação da obra — traz a obra à paridade que o reparo já tem (criado_em é
262|     // o instante de publicação do reparo + prazo_atendimento_horas é a janela). horas_para_expirar
263|     // guarda a janela original; publicado_em guarda o instante em que a obra foi ao ar. A obra
264|     // nasce 'rascunho' e só publica na aprovação — por isso publicado_em fica NULL até lá (é
265|     // definido na aprovação), enquanto o reparo publica na criação. NUMERIC (não INTEGER): o
266|     // backfill deriva horas fracionárias, pois expira_em vem do Date.now() do app e criado_em do
267|     // NOW() do banco, então (expira_em - criado_em) carrega o atraso da request (sub-segundo).
268|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS horas_para_expirar NUMERIC`)
269|     await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS publicado_em TIMESTAMPTZ`)
270|     // Backfill idempotente (WHERE ... IS NULL) e NULL-safe. Correto porque NENHUM endpoint de
271|     // extensão jamais existiu: até aqui o expira_em de toda obra é exatamente criado_em + janela
272|     // original, então (expira_em - criado_em) reconstrói a janela. COALESCE p/ 720 cobre linha
273|     // com timestamp nulo — horas_para_expirar nunca fica NULL. publicado_em = criado_em porque
274|     // historicamente o relógio sempre correu desde a criação (rascunho existente é sobrescrito
275|     // por publicado_em = NOW() na aprovação, então o valor do backfill nele é inócuo).
276|     await client.query(`
277|       UPDATE obras SET horas_para_expirar = COALESCE(EXTRACT(EPOCH FROM (expira_em - criado_em)) / 3600, 720)
278|       WHERE horas_para_expirar IS NULL
279|     `)
280|     await client.query(`
281|       UPDATE obras SET publicado_em = criado_em
282|       WHERE publicado_em IS NULL
283|     `)
284|     // Marcos de expiração PROPORCIONAIS: NULL = marco ainda não disparado; o job seta o timestamp
285|     // ao disparar (claim). Ver verificarMarcosExpiracao + src/utils/faixasPrazo.js.
286|     // Marcos genéricos (1º/2º/3º) — os offsets variam por faixa de prazo (ver faixasPrazo.js), então
287|     // as colunas guardam só "qual marco já foi enviado", com o tempo definido pela faixa em código.
288|     // Passo 4/6: estas são as colunas ATIVAS — o job, os índices parciais e o estender usam elas.
289|     // As 4 antigas (marco_6h/60/30/15_em) NÃO são derrubadas neste boot (expand/contract): sua
290|     // remoção fica deferida ao passo 4b, quando o job novo estiver confirmado limpo em produção e o
291|     // container anterior já tiver saído.
292|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS marco_1_em TIMESTAMPTZ`)
293|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS marco_2_em TIMESTAMPTZ`)
294|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS marco_3_em TIMESTAMPTZ`)
295|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS marco_1_em TIMESTAMPTZ`)
296|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS marco_2_em TIMESTAMPTZ`)
297|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS marco_3_em TIMESTAMPTZ`)
298|     // Idempotência de POST /reparos/:id/estender e de POST /obras/:id/estender — nenhum dos dois
299|     // tem client_request_id, então a chave de dedupe é a própria última extensão aplicada:
300|     // (instante, horas). Um retry com o MESMO horas dentro da janela curta devolve o prazo atual em
301|     // vez de somar de novo. NULL nas duas colunas = demanda que ainda não foi estendida (nenhum
302|     // backfill: não há histórico de onde tirar esses valores, e NULL já significa "sem extensão
303|     // recente" na guarda do UPDATE). obras recebeu as colunas depois do reparo: sem elas, cada
304|     // retry do app somava outra extensão inteira — exatamente o que a guarda do reparo já evitava.
305|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS ultima_extensao_em    TIMESTAMPTZ`)
306|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS ultima_extensao_horas NUMERIC`)
307|     // Faixa "Hoje": prazo que vence no FIM DO DIA em Brasília, não N horas depois da publicação.
308|     // Marcador, não duração — ver PRAZO_MODO_HOJE em src/utils/faixasPrazo.js para o porquê de
309|     // não usar sentinela nas colunas de horas. NULL = faixa por duração (todo o histórico).
310|     // Aditiva e sem DEFAULT: nenhuma reescrita de tabela, nenhuma query existente a lê.
311|     // Os TRÊS caminhos que escrevem/reconstroem expira_em consultam esta coluna: o create, o
312|     // aprovarEPublicarObra e os dois crons de cronômetro (alertaService).
313|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS prazo_modo TEXT`)
314|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS prazo_modo TEXT`)
315|     // Zona IANA em que "Hoje" é resolvido, enviada pelo cliente no create. Coluna SEPARADA em
316|     // vez de embutir a zona no próprio prazo_modo ('hoje:America/Manaus'): prazo_modo continua
317|     // sendo o MODO, sem split_part no SQL dos dois caminhos que reconstroem expira_em, e uma
318|     // faixa futura pode entrar sem colidir com o parsing. NULL = usar TZ_PADRAO (linhas
319|     // gravadas antes desta mudança, e qualquer linha cujo cliente não mandou zona utilizável).
320|     // Só em OBRAS: o lado reparo não tem faixa "Hoje" e seu cliente não manda zona.
321|     // Aditiva e sem DEFAULT: nenhuma reescrita de tabela.
322|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS prazo_timezone TEXT`)
323|     // D78: o reparo passa a guardar a zona do dono para a faixa "Hoje", como a obra.
324|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS prazo_timezone TEXT`)
325|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS ultima_extensao_em    TIMESTAMPTZ`)
326|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS ultima_extensao_horas NUMERIC`)
327|     // Índice parcial do job de marcos (roda a cada 1min). Coluna líder expira_em: o range scan lê
328|     // só as demandas prestes a expirar. O WHERE parcial (TIME-FREE, sem NOW()) mantém o índice
329|     // pequeno: exclui match, não-aprovadas (obras) e as que já enviaram os 3 marcos genéricos.
330|     // Passo 4: DROP do índice antigo (predicado nos marco_6h/60/30/15) ANTES do CREATE porque reusa
331|     // o MESMO nome; recria com o predicado dos marcos genéricos (marco_1/2/3). Criado AQUI, no bloco
332|     // de boot, portanto ANTES de iniciarAgendador() registrar o job (server.js).
333|     await client.query(`DROP INDEX IF EXISTS obras_marcos_pendentes_idx`)
334|     await client.query(`DROP INDEX IF EXISTS reparos_marcos_pendentes_idx`)
335|     await client.query(`
336|       CREATE INDEX IF NOT EXISTS obras_marcos_pendentes_idx ON obras (expira_em)
337|       WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND match_usuario_id IS NULL
338|         AND (marco_1_em IS NULL OR marco_2_em IS NULL OR marco_3_em IS NULL)
339|     `)
340|     await client.query(`
341|       CREATE INDEX IF NOT EXISTS reparos_marcos_pendentes_idx ON reparos (expira_em)
342|       WHERE status = 'aberta' AND match_usuario_id IS NULL
343|         AND (marco_1_em IS NULL OR marco_2_em IS NULL OR marco_3_em IS NULL)
344|     `)
345|     // As 4 colunas antigas de marco (marco_6h/60/30/15_em) NÃO são derrubadas aqui — padrão
346|     // expand/contract. O deploy do Railway é overlapping (sem railway.json → health-check default):
347|     // o container ANTIGO ainda roda o job de 1min e o /estender antigos durante a janela de overlap;
348|     // se derrubássemos as colunas agora, esse código antigo bateria em coluna inexistente (job:
349|     // erro engolido pelo try/catch, mas alertas perdidos; /estender: 500 pro usuário). As colunas
350|     // ficam órfãs mas inofensivas (o job novo e o /estender novo só usam marco_1/2/3_em).
351|     //
352|     // DEFERRED (4b): DROP COLUMN marco_6h/60/30/15_em on obras+reparos + drop old index — only after
353|     // the new milestone job is confirmed clean in prod and the previous container is gone;
354|     // unconditionally safe then because no running code will reference these columns.
355|     // Índice parcial do cronômetro de obras (job de 1min): coluna líder expira_em para o range
356|     // scan de matches prestes a expirar. Predicado TIME-FREE (só status e match_usuario_id, ambos
357|     // imutáveis) — Postgres proíbe NOW()/CURRENT_TIMESTAMP em índice parcial; o filtro temporal
358|     // (expira_em <= NOW()) vive no WHERE do JOB, não no índice. Pequeno: só obras casadas e abertas.
359|     await client.query(`
360|       CREATE INDEX IF NOT EXISTS obras_matches_pendentes_idx ON obras (expira_em)
361|       WHERE status = 'aberta' AND match_usuario_id IS NOT NULL
362|     `)
363|     // Sem backfill anti-rajada: as bandas disjuntas do job garantem no máximo UM marco por run
364|     // (a demanda cai em uma banda só), então o 1º run pós-deploy não gera rajada — cada demanda
365|     // dispara no máximo o marco da banda em que está agora. (O backfill antigo, que marcava os
366|     // marcos fixos já passados, saiu junto com as colunas antigas.)
367|     // "Esta semana" passou de 72h para 168h (7 dias). Reclassifica as demandas legadas de faixa:
368|     // 72 → 168, apenas a coluna de janela (o rótulo da faixa para os marcos proporcionais futuros).
369|     // NÃO mexe em expira_em — as linhas mantêm o prazo atual que já foi calculado a partir de 72h;
370|     // recalcular empurraria deadlines ao vivo. Idempotente: após rodar, nenhuma linha tem 72, então
371|     // re-executar a cada boot é no-op. Update de valor simples, sem risco de constraint (não lança).
372|     // Obras hoje não têm nenhuma linha 72 → no-op inofensivo, mantido por simetria com reparos.
373|     await client.query(`UPDATE reparos SET prazo_atendimento_horas = 168 WHERE prazo_atendimento_horas = 72`)
374|     await client.query(`UPDATE obras   SET horas_para_expirar      = 168 WHERE horas_para_expirar      = 72`)
375|     // Backfill one-time de encerrado_em para linhas já encerradas antes da coluna existir.
376|     // Usa match_feito_em como melhor aproximação, caindo para criado_em quando o item foi
377|     // encerrado sem nunca ter match. Idempotente via WHERE encerrado_em IS NULL.
378|     await client.query(`
379|       UPDATE obras SET encerrado_em = COALESCE(match_feito_em, criado_em)
380|       WHERE status = 'encerrada' AND encerrado_em IS NULL
381|     `)
382|     await client.query(`
383|       UPDATE reparos SET encerrado_em = COALESCE(match_feito_em, criado_em)
384|       WHERE status = 'encerrada' AND encerrado_em IS NULL
385|     `)
386|     // Índices para FKs e filtros quentes (feed + ownership). Sem eles, as subqueries
387|     // correlacionadas do feed e os lookups por usuário/obra/reparo fazem seq scan.
388|     // interesse_reparos_reparo_id_idx (reparo_id) NÃO é mais criado: é prefixo à esquerda do
389|     // idx_interesse_reparo_usuario (reparo_id, usuario_id), que já existe.
390|     await client.query(`CREATE INDEX IF NOT EXISTS interesse_reparos_usuario_id_idx ON interesse_reparos (usuario_id)`)
391|     // Redundante: duplicata exata do interesse_reparos_usuario_id_idx acima.
392|     await client.query(`DROP INDEX IF EXISTS idx_interesse_usuario_id`)
393|     // candidaturas_obra_id_idx (obra_id) NÃO é mais criado: é prefixo à esquerda do UNIQUE
394|     // candidaturas_obra_id_usuario_id_key (obra_id, usuario_id).
395|     await client.query(`CREATE INDEX IF NOT EXISTS candidaturas_usuario_id_idx ON candidaturas (usuario_id)`)
396|     // Redundante: duplicata exata do candidaturas_usuario_id_idx acima.
397|     await client.query(`DROP INDEX IF EXISTS idx_candidaturas_usuario_id`)
398|     await client.query(`CREATE INDEX IF NOT EXISTS midias_obra_id_idx ON midias (obra_id)`)
399|     // Redundante: duplicata exata do midias_obra_id_idx acima.
400|     await client.query(`DROP INDEX IF EXISTS idx_midias_obra_id`)
401|     await client.query(`CREATE INDEX IF NOT EXISTS midias_reparos_reparo_id_idx ON midias_reparos (reparo_id)`)
402|     // Redundante: duplicata exata do midias_reparos_reparo_id_idx acima.
403|     await client.query(`DROP INDEX IF EXISTS idx_midias_reparos_reparo_id`)
404|     // reparos_feed_idx: match_usuario_id incluído p/ paridade com obras_feed_idx — GET /reparos
405|     // também filtra match_usuario_id IS NULL, e a definição de 3 colunas parava antes disso.
406|     // DROP antes do CREATE porque IF NOT EXISTS casa por NOME: sem o drop a definição antiga
407|     // sobreviveria (mesmo padrão do obras_feed_idx logo abaixo).
408|     await client.query(`DROP INDEX IF EXISTS reparos_feed_idx`)
409|     await client.query(`CREATE INDEX IF NOT EXISTS reparos_feed_idx ON reparos (status, status_aprovacao, expira_em, match_usuario_id)`)
410|     // Redundantes: (status) e (status, status_aprovacao, expira_em) são prefixos à esquerda
411|     // do reparos_feed_idx acima.
412|     await client.query(`DROP INDEX IF EXISTS idx_reparos_status`)
413|     await client.query(`DROP INDEX IF EXISTS idx_reparos_status_expira`)
414|     // obras_feed_idx: inclui status_aprovacao e match_usuario_id p/ paridade com reparos_feed_idx,
415|     // e `valor DESC NULLS LAST` como coluna final — é a SEGUNDA chave do ORDER BY do feed
416|     // (`o.expira_em ASC, o.valor DESC NULLS LAST`). Um índice separado só em valor não serve a
417|     // uma ordenação de duas chaves; ela só é coberta pelo composto, na ordem das chaves.
418|     // DESC NULLS LAST explícito: em btree, DESC assume NULLS FIRST, que não é a ordem pedida.
419|     // Drop do índice antigo (mais estreito) antes de recriar com as colunas corretas.
420|     await client.query(`DROP INDEX IF EXISTS obras_feed_idx`)
421|     await client.query(`CREATE INDEX IF NOT EXISTS obras_feed_idx ON obras (status, status_aprovacao, expira_em, match_usuario_id, valor DESC NULLS LAST)`)
422|     // Redundante: (status) é prefixo à esquerda do obras_feed_idx acima.
423|     // idx_obras_status_expira NÃO cai: é (status, expira_em), e no feed status_aprovacao
424|     // fica ENTRE as duas colunas — não é prefixo deste índice.
425|     await client.query(`DROP INDEX IF EXISTS idx_obras_status`)
426|     // Filtro quente do cron de proximidade (15min): lp.atualizado_em > NOW() - 30min.
427|     await client.query(`CREATE INDEX IF NOT EXISTS localizacoes_prestadores_atualizado_em_idx ON localizacoes_prestadores (atualizado_em)`)
428| 
429|     // ---- Índices da auditoria de escala: cada um nomeia a query/job que serve ----
430|     // GET /obras (obrasController.listar): filtro `o.categoria = $n`. reparos já tinha
431|     // idx_reparos_categoria; obras não tinha equivalente.
432|     await client.query(`CREATE INDEX IF NOT EXISTS obras_categoria_idx ON obras (categoria)`)
433|     // GET /obras com raio_km='estado': filtro `o.uf = $n`.
434|     await client.query(`CREATE INDEX IF NOT EXISTS obras_uf_idx ON obras (uf)`)
435|     // GET /obras: `NOT ($1 = ANY(COALESCE(o.prestadores_bloqueados,'{}')))` — sem GIN a lista
436|     // negra é avaliada linha a linha. GIN é o método para busca de pertencimento em array.
437|     await client.query(`CREATE INDEX IF NOT EXISTS obras_prestadores_bloqueados_gin_idx ON obras USING GIN (prestadores_bloqueados)`)
438|     // (A segunda chave do ORDER BY do feed, `o.valor DESC NULLS LAST`, entra como coluna final
439|     // do obras_feed_idx acima — índice avulso em valor não cobriria ordenação de duas chaves.)
440|     // GET /obras/minhas: WHERE criado_por = $1 ... ORDER BY criado_em DESC — o índice só de
441|     // criado_por cobria o filtro e deixava a ordenação para um sort a cada chamada.
442|     await client.query(`CREATE INDEX IF NOT EXISTS obras_criado_por_criado_em_idx ON obras (criado_por, criado_em DESC)`)
443|     // Redundantes: ambos são só (criado_por), prefixo à esquerda do composto acima. Os CREATEs
444|     // deles foram removidos deste bloco — criar e derrubar a cada boot é trabalho jogado fora.
445|     await client.query(`DROP INDEX IF EXISTS obras_criado_por_idx`)
446|     await client.query(`DROP INDEX IF EXISTS idx_obras_criado_por`)
447|     // GET /reparos/minhas: idem.
448|     await client.query(`CREATE INDEX IF NOT EXISTS reparos_criado_por_criado_em_idx ON reparos (criado_por, criado_em DESC)`)
449|     // Redundantes: ambos são só (criado_por), prefixo à esquerda do composto acima. Os CREATEs
450|     // deles foram removidos deste bloco (mesmo motivo do lado obra).
451|     await client.query(`DROP INDEX IF EXISTS reparos_criado_por_idx`)
452|     await client.query(`DROP INDEX IF EXISTS idx_reparos_criado_por`)
453| 
454|     // ---- Redundantes cujo índice supersedente NÃO é criado por este bloco ----
455|     // (são índices de CONSTRAINT, nascidos com a tabela, ou índices legados já existentes —
456|     // então sempre existem antes destes drops, e a ordem "drop depois do create" é atendida.)
457|     // usuarios_email_key (UNIQUE em email) supersede — e ainda enforça a constraint.
458|     await client.query(`DROP INDEX IF EXISTS idx_usuarios_email`)
459|     // candidaturas_obra_id_usuario_id_key (UNIQUE em (obra_id, usuario_id)) supersede as três:
460|     // duas são o prefixo (obra_id), a outra é a mesma dupla de colunas. candidaturas_obra_id_idx
461|     // teve o CREATE removido daqui, mas segue no banco de deploys anteriores — só o drop o tira.
462|     await client.query(`DROP INDEX IF EXISTS idx_candidaturas_obra_id`)
463|     await client.query(`DROP INDEX IF EXISTS idx_candidaturas_obra_usuario`)
464|     await client.query(`DROP INDEX IF EXISTS candidaturas_obra_id_idx`)
465|     // idx_interesse_reparo_usuario (reparo_id, usuario_id), legado, supersede o prefixo (reparo_id).
466|     // interesse_reparos_reparo_id_idx idem: CREATE removido, mas a linha antiga persiste no banco.
467|     await client.query(`DROP INDEX IF EXISTS idx_interesse_reparo_id`)
468|     await client.query(`DROP INDEX IF EXISTS interesse_reparos_reparo_id_idx`)
469|     // Cron verificarCronometroReparos (60s): espelha obras_matches_pendentes_idx, que só
470|     // existia do lado obra — o lado reparo varria sem índice de apoio a cada minuto.
471|     await client.query(`
472|       CREATE INDEX IF NOT EXISTS reparos_matches_pendentes_idx ON reparos (expira_em)
473|       WHERE status = 'aberta' AND match_usuario_id IS NOT NULL
474|     `)
475|     // Cron autoEncerrarPendentes (5min), 1º predicado — encerramento em duas mãos vencido:
476|     // status='aberta' AND encerramento_solicitado_por IS NOT NULL AND encerramento_solicitado_em <= NOW()-prazo.
477|     await client.query(`
478|       CREATE INDEX IF NOT EXISTS obras_encerramento_pendente_idx ON obras (encerramento_solicitado_em)
479|       WHERE status = 'aberta' AND encerramento_solicitado_por IS NOT NULL
480|     `)
481|     await client.query(`
482|       CREATE INDEX IF NOT EXISTS reparos_encerramento_pendente_idx ON reparos (encerramento_solicitado_em)
483|       WHERE status = 'aberta' AND encerramento_solicitado_por IS NOT NULL
484|     `)
485|     // Cron autoEncerrarPendentes (5min), 2º predicado — auto-confirmação de chegada:
486|     // chegada_declarada_em IS NOT NULL AND chegada_confirmada_em IS NULL AND chegada_declarada_em <= NOW()-prazo.
487|     await client.query(`
488|       CREATE INDEX IF NOT EXISTS obras_chegada_a_confirmar_idx ON obras (chegada_declarada_em)
489|       WHERE chegada_declarada_em IS NOT NULL AND chegada_confirmada_em IS NULL
490|     `)
491|     await client.query(`
492|       CREATE INDEX IF NOT EXISTS reparos_chegada_a_confirmar_idx ON reparos (chegada_declarada_em)
493|       WHERE chegada_declarada_em IS NOT NULL AND chegada_confirmada_em IS NULL
494|     `)
495|     // Cron deletarMidiasAntigas (24h): varre encerrado_em das DEMANDAS (não das mídias) —
496|     // status IN ('encerrada','cancelada') AND encerrado_em IS NOT NULL AND < NOW()-7 dias.
497|     // O predicado inclui 'cancelada' junto com o job: demanda cancelada também guarda mídia
498|     // para sempre, e um índice mais estreito que a consulta deixaria de ser usado por ela.
499|     // DROP antes do CREATE porque IF NOT EXISTS casa por NOME — sem o drop a definição antiga
500|     // (só 'encerrada') sobreviveria (mesmo padrão do obras_feed_idx).
501|     await client.query(`DROP INDEX IF EXISTS obras_encerrado_em_idx`)
502|     await client.query(`
503|       CREATE INDEX IF NOT EXISTS obras_encerrado_em_idx ON obras (encerrado_em)
504|       WHERE status IN ('encerrada', 'cancelada') AND encerrado_em IS NOT NULL
505|     `)
506|     await client.query(`DROP INDEX IF EXISTS reparos_encerrado_em_idx`)
507|     await client.query(`
508|       CREATE INDEX IF NOT EXISTS reparos_encerrado_em_idx ON reparos (encerrado_em)
509|       WHERE status IN ('encerrada', 'cancelada') AND encerrado_em IS NOT NULL
510|     `)
511|     // No máximo um aceito por reparo/obra — enforce no nível do banco (Finding 2.1).
512|     // Dedup ANTES dos índices únicos: mantém o 'aceito' mais recente por job e rebaixa
513|     // os demais para 'recusado', senão o CREATE UNIQUE INDEX falha em dados legados.
514|     await client.query(`
515|       UPDATE interesse_reparos SET status = 'recusado'
516|       WHERE status = 'aceito'
517|       AND id NOT IN (
518|         SELECT DISTINCT ON (reparo_id) id
519|         FROM interesse_reparos
520|         WHERE status = 'aceito'
521|         ORDER BY reparo_id, criado_em DESC
522|       )
523|     `)
524|     await client.query(`
525|       UPDATE candidaturas SET status = 'recusado'
526|       WHERE status = 'aceito'
527|       AND id NOT IN (
528|         SELECT DISTINCT ON (obra_id) id
529|         FROM candidaturas
530|         WHERE status = 'aceito'
531|         ORDER BY obra_id, criado_em DESC
532|       )
533|     `)
534|     await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS interesse_reparos_aceito_unico_idx ON interesse_reparos (reparo_id) WHERE status = 'aceito'`)
535|     await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS candidaturas_aceito_unica_idx ON candidaturas (obra_id) WHERE status = 'aceito'`)
536|     // Uma única assinatura por usuário (Finding 4.1). Dedup ANTES do índice único:
537|     // mantém a linha mais relevante por usuario_id (prefere 'ativa', depois mais recente).
538|     await client.query(`
539|       DELETE FROM assinaturas
540|       WHERE id NOT IN (
541|         SELECT DISTINCT ON (usuario_id) id
542|         FROM assinaturas
543|         ORDER BY usuario_id,
544|           CASE status WHEN 'ativa' THEN 1 WHEN 'pendente_verificacao' THEN 2 ELSE 3 END ASC,
545|           criado_em DESC
546|       )
547|     `)
548|     await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS assinaturas_usuario_id_unico_idx ON assinaturas (usuario_id)`)
549|     // Redundantes sob o UNIQUE acima: (usuario_id) é a mesma coluna, e (usuario_id, status)
550|     // não acrescenta nada — sendo usuario_id único, no máximo uma linha casa por usuário.
551|     // O UNIQUE é alvo do ON CONFLICT (usuario_id) de ativarAssinatura e nunca pode cair.
552|     await client.query(`DROP INDEX IF EXISTS idx_assinaturas_usuario_id`)
553|     await client.query(`DROP INDEX IF EXISTS idx_assinaturas_usuario_status`)
554|     // Cron de expiração (1h) e aviso de vencimento (1h): WHERE status='ativa' AND proximo_vencimento < NOW().
555|     await client.query(`CREATE INDEX IF NOT EXISTS assinaturas_status_vencimento_idx ON assinaturas (status, proximo_vencimento)`)
556|     // Redundante: (status) é prefixo à esquerda do assinaturas_status_vencimento_idx acima.
557|     await client.query(`DROP INDEX IF EXISTS idx_assinaturas_status`)
558|     // Marcos do aviso de vencimento da ASSINATURA — mesmo padrão dos marcos de demanda
559|     // (obras/reparos.marco_1_em/2_em/3_em): a coluna é o CLAIM, preenchida no mesmo UPDATE
560|     // que reivindica o envio, então re-run ou segunda réplica nunca manda duas vezes.
561|     //   marco_1_em → faltando <= 24h  |  marco_2_em → <= 12h  |  marco_3_em → <= 6h
562|     // NULL = ainda não avisado. Todo caminho que empurra proximo_vencimento para frente
563|     // zera as três (senão o ciclo seguinte nunca mais avisaria).
564|     await client.query(`ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS marco_1_em TIMESTAMPTZ`)
565|     await client.query(`ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS marco_2_em TIMESTAMPTZ`)
566|     await client.query(`ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS marco_3_em TIMESTAMPTZ`)
567|     // Índice PARCIAL do predicado do job: só linhas ativas com algum marco pendente entram,
568|     // que é a minoria — as já avisadas nas três bandas saem do índice sozinhas.
569|     await client.query(`CREATE INDEX IF NOT EXISTS assinaturas_marcos_vencimento_idx
570|                         ON assinaturas (proximo_vencimento)
571|                         WHERE status = 'ativa'
572|                           AND (marco_1_em IS NULL OR marco_2_em IS NULL OR marco_3_em IS NULL)`)
573|     // Backfill do uf: linhas antigas têm cidade preenchida mas uf NULL, então sumiam do
574|     // filtro "Estado" (o.uf/r.uf) mesmo aparecendo em "Cidade". Cidades conhecidas e
575|     // inequívocas (todas em MG). Idempotente via WHERE uf IS NULL.
576|     await client.query(`UPDATE obras   SET uf = 'MG' WHERE uf IS NULL AND cidade = 'Patos de Minas'`)
577|     await client.query(`UPDATE reparos SET uf = 'MG' WHERE uf IS NULL AND cidade IN ('Patos de Minas', 'Formiga')`)
578|     // Backfill de coordenadas — mesmo espírito do backfill de uf acima. Linhas antigas
579|     // nasceram sem lat/lng porque o geocode do app é best-effort e falha em silêncio; sem
580|     // coordenada a demanda fica invisível ao filtro por raio (exige latitude IS NOT NULL),
581|     // ao cron de proximidade (server.js:107) e ao rótulo de distância do card. Preenche com
582|     // o CENTRO do município e marca coordenadas_origem='centro_cidade'.
583|     // Idempotente: WHERE latitude IS NULL AND longitude IS NULL → reexecução não casa nada.
584|     // Não-destrutivo: só toca linhas SEM as duas coordenadas, então nunca sobrescreve uma
585|     // coordenada real (ex.: o reparo de Ituiutaba, que já tem lat/lng corretas).
586|     // Município não resolvido (nome ambíguo sem uf, grafia fora do IBGE) → registra e PULA.
587|     for (const tabela of ['reparos', 'obras']) {
588|       const grupos = await client.query(
589|         `SELECT cidade, uf, COUNT(*)::int AS linhas
590|            FROM ${tabela}
591|           WHERE latitude IS NULL AND longitude IS NULL
592|             AND cidade IS NOT NULL AND btrim(cidade) <> ''
593|           GROUP BY cidade, uf`
594|       )
595|       let preenchidas = 0
596|       const naoResolvidos = []
597|       for (const g of grupos.rows) {
598|         const centro = coordsDeCidade(g.cidade, g.uf)
599|         if (!centro) {
600|           naoResolvidos.push(`${g.cidade}/${g.uf || 'sem uf'} (${g.linhas} linha[s])`)
601|           continue
602|         }
603|         const r = await client.query(
604|           `UPDATE ${tabela}
605|               SET latitude = $1, longitude = $2, coordenadas_origem = 'centro_cidade'
606|             WHERE latitude IS NULL AND longitude IS NULL
607|               AND cidade = $3 AND (uf = $4 OR (uf IS NULL AND $4 IS NULL))`,
608|           [centro.lat, centro.lng, g.cidade, g.uf]
609|         )
610|         if (r.rowCount > 0) {
611|           preenchidas += r.rowCount
612|           console.log(`[migration][coords] ${tabela}: ${r.rowCount} linha(s) em ${g.cidade}/${centro.uf} -> ${centro.lat}, ${centro.lng}`)
613|         }
614|       }
615|       // Meia-coordenada (só uma das duas colunas nula) é inútil para o raio, que exige as
616|       // duas. Não é preenchida de propósito — sobrescrever a metade preenchida apagaria um
617|       // dado real. Só reporta, para não sumir do radar.
618|       const meias = await client.query(
619|         `SELECT COUNT(*)::int AS n FROM ${tabela}
620|           WHERE (latitude IS NULL) <> (longitude IS NULL)`
621|       )
622|       console.log(`[migration][coords] ${tabela}: ${preenchidas} linha(s) preenchida(s)` +
623|         (naoResolvidos.length ? ` | municipio nao resolvido, PULADO: ${naoResolvidos.join(', ')}` : '') +
624|         (meias.rows[0].n ? ` | ATENCAO ${meias.rows[0].n} linha(s) com apenas uma coordenada (nao tocadas)` : ''))
625|     }
626|     // Backfill de tipo_prestador (fix de preço no checkout PagBank). Prestadores com
627|     // tipo_prestador NULL (linhas legadas/criadas fora do cadastro() — origem no painel-admin
628|     // ou insert manual) quebrariam o checkout novo, que exige 'reparador' ou 'pintor' e
629|     // devolve 422 caso contrário. Deriva o tier do valor_mensal JÁ gravado na assinatura no
630|     // ato do cadastro (evidência autoritativa do que a pessoa contratou):
631|     //   49.90 / 499.00 → reparador   |   99.90 / 999.00 → pintor
632|     // Idempotente: WHERE tipo_prestador IS NULL → 0 linhas em reexecução (no-op, não lança).
633|     // Não-destrutivo: só preenche NULLs, nunca sobrescreve um tier já definido. Um join sem
634|     // assinatura correspondente simplesmente não casa nenhuma linha (também no-op).
635|     await client.query(`
636|       UPDATE usuarios u SET tipo_prestador = 'reparador'
637|       FROM assinaturas a
638|       WHERE a.usuario_id = u.id
639|         AND u.role = 'prestador' AND u.tipo_prestador IS NULL
640|         AND a.valor_mensal IN (49.90, 499.00)
641|     `)
642|     await client.query(`
643|       UPDATE usuarios u SET tipo_prestador = 'pintor'
644|       FROM assinaturas a
645|       WHERE a.usuario_id = u.id
646|         AND u.role = 'prestador' AND u.tipo_prestador IS NULL
647|         AND a.valor_mensal IN (99.90, 999.00)
648|     `)
649|     // Limpeza de linhas órfãs deixadas por exclusões antigas que falhavam no meio da
650|     // transação (ver B72-01). Uma assinatura órfã (usuario_id de usuário já apagado)
651|     // não afeta o novo cadastro do mesmo CPF — ele recebe novo id — mas suja relatórios
652|     // e a base. Idempotente: só apaga o que não tem usuário correspondente.
653|     await client.query(`DELETE FROM assinaturas a WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = a.usuario_id)`)
654|     await client.query(`DELETE FROM localizacoes_prestadores lp WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = lp.usuario_id)`)
655|     // A1 — o app envia o cpf_cnpj JÁ MASCARADO e o INSERT o grava cru (só o índice
656|     // normaliza p/ dígitos). Mascarado, um CPF tem 14 chars ("[cpf redigido]") e um CNPJ
657|     // tem 18 ("12.345.678/0001-90"). A coluna cabia o CPF (14) mas era estreita demais p/
658|     // o CNPJ (18): o INSERT era REJEITADO pelo Postgres (22001 value too long), caía no
659|     // catch como 500 e o app exibia "Conexão lenta"/"já cadastrado" — NENHUM CNPJ
660|     // conseguia se cadastrar. Alargamos p/ TEXT (não VARCHAR(14) — insuficiente p/ os 18
661|     // chars do CNPJ mascarado): varchar→text é BINÁRIO-COERCÍVEL → SEM rewrite da tabela
662|     // (só um ACCESS EXCLUSIVE lock breve) e TEXT remove qualquer teto de comprimento; quem
663|     // garante a unicidade real é o índice NORMALIZADO (dígitos), não o limite do varchar.
664|     //
665|     // ÍNDICE DEPENDENTE (usuarios_cpf_cnpj_normalizado_unico_idx): NÃO precisa de
666|     // DROP/CREATE manual. O ALTER COLUMN ... TYPE reconstrói automaticamente os índices
667|     // que dependem da coluna, de forma transacional, dentro deste mesmo BEGIN. E como o
668|     // índice é sobre uma EXPRESSÃO cujo tipo de saída é sempre `text`
669|     // (regexp_replace(...) retorna text tanto para varchar quanto para text de entrada),
670|     // a chave e a operator class do índice NÃO mudam — a reconstrução é trivialmente
671|     // válida, sem risco de incompatibilidade. Único bloqueador possível de um ALTER TYPE
672|     // seria uma VIEW/rule dependente da coluna (não há; ver query de pré-checagem no PR).
673|     //
674|     // Guardado por tipo: roda o ALTER UMA vez (quando ainda é varchar). Em boots
675|     // seguintes a coluna já é `text` e o bloco não faz NADA — sem lock, sem reindex.
676|     await client.query(`
677|       DO $$
678|       BEGIN
679|         IF EXISTS (
680|           SELECT 1 FROM information_schema.columns
681|           WHERE table_name = 'usuarios' AND column_name = 'cpf_cnpj'
682|             AND data_type <> 'text'
683|         ) THEN
684|           ALTER TABLE usuarios ALTER COLUMN cpf_cnpj TYPE TEXT;
685|         END IF;
686|       END $$;
687|     `)
688|     // Fail-loud: alargar a coluna NÃO altera valores já gravados, logo nenhum duplicado NOVO
689|     // pode surgir daqui. Ainda assim asseguramos alto — se por qualquer motivo existirem dois
690|     // cpf_cnpj que normalizam igual, aborta a migração (RAISE → catch → ROLLBACK → server não
691|     // sobe) com mensagem clara, em vez de deixar o CREATE UNIQUE INDEX abaixo falhar obscuro.
692|     await client.query(`
693|       DO $$
694|       DECLARE dups int;
695|       BEGIN
696|         SELECT count(*) INTO dups FROM (
697|           SELECT regexp_replace(cpf_cnpj, '[^0-9]', '', 'g') AS n
698|           FROM usuarios
699|           WHERE cpf_cnpj IS NOT NULL AND cpf_cnpj <> ''
700|           GROUP BY 1 HAVING count(*) > 1
701|         ) d;
702|         IF dups > 0 THEN
703|           RAISE EXCEPTION 'A1: % cpf_cnpj normalizados duplicados — migracao abortada', dups;
704|         END IF;
705|       END $$;
706|     `)
707|     // UNIQUE no CPF/CNPJ NORMALIZADO (só dígitos) — MESMA expressão dos lookups de
708|     // cadastro/pré-checagem (regexp_replace(cpf_cnpj,'[^0-9]','','g')). Faz duas coisas:
709|     //   1) impede CPFs duplicados por corrida (dois submits simultâneos passavam o
710|     //      SELECT e ambos inseriam, pois não havia constraint — o email já tinha, o CPF não);
711|     //   2) torna aqueles lookups INDEXÁVEIS, eliminando o Seq Scan (a base cresce rápido
712|     //      com tráfego pago). Partial WHERE: linhas com cpf_cnpj NULL/vazio não colidem
713|     //      entre si. Produção tem 0 duplicados hoje (verificado); se um dia houver, o CREATE
714|     //      falha alto e derruba a migração (transação → ROLLBACK → server não sobe), em vez
715|     //      de corromper dados. Nome contém "cpf" p/ o handler 23505 do cadastro casar.
716|     await client.query(`
717|       CREATE UNIQUE INDEX IF NOT EXISTS usuarios_cpf_cnpj_normalizado_unico_idx
718|       ON usuarios ((regexp_replace(cpf_cnpj, '[^0-9]', '', 'g')))
719|       WHERE cpf_cnpj IS NOT NULL AND cpf_cnpj <> ''
720|     `)
721|     // Lista de bloqueio global por dono (separada do array per-reparo prestadores_bloqueados).
722|     await client.query(`
723|       CREATE TABLE IF NOT EXISTS prestadores_bloqueados_dono (
724|         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
725|         dono_id UUID NOT NULL REFERENCES usuarios(id),
726|         prestador_id UUID NOT NULL REFERENCES usuarios(id),
727|         criado_em TIMESTAMP DEFAULT NOW(),
728|         UNIQUE(dono_id, prestador_id)
729|       )
730|     `)
731|     // Redundante: (dono_id) é prefixo à esquerda de prestadores_bloqueados_dono_dono_id_prestador_id_key
732|     // (UNIQUE), que também é o alvo do ON CONFLICT (dono_id, prestador_id) e nunca pode cair.
733|     // O CREATE foi removido: criar e derrubar o mesmo índice a cada boot é trabalho jogado fora.
734|     await client.query(`DROP INDEX IF EXISTS prestadores_bloqueados_dono_dono_idx`)
735|     await client.query(`CREATE INDEX IF NOT EXISTS prestadores_bloqueados_dono_prestador_idx ON prestadores_bloqueados_dono (prestador_id)`)
736|     // Faltas (não comparecimento) do profissional. Uma linha por match desfeito pelo CRONÔMETRO
737|     // — o profissional casou, o prazo venceu e ele nunca declarou chegada. Sem UNIQUE: o mesmo
738|     // par (profissional, demanda) pode faltar de novo se ele recasar com ela mais tarde, e cada
739|     // falta conta. `tabela` guarda 'obras' | 'reparos' porque demanda_id não é FK (aponta para
740|     // uma das duas tabelas), então não há REFERENCES nele.
741|     await client.query(`
742|       CREATE TABLE IF NOT EXISTS faltas_profissional (
743|         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
744|         usuario_id UUID NOT NULL REFERENCES usuarios(id),
745|         tabela TEXT NOT NULL,
746|         demanda_id UUID NOT NULL,
747|         criado_em TIMESTAMPTZ DEFAULT NOW()
748|       )
749|     `)
750|     // Índice da contagem da janela móvel (usuario_id + criado_em > NOW() - 90 dias).
751|     await client.query(`CREATE INDEX IF NOT EXISTS faltas_profissional_usuario_criado_idx ON faltas_profissional (usuario_id, criado_em)`)
752|     // Perdão de falta: linha perdoada continua no histórico (auditoria de quem foi liberado e
753|     // quando) mas sai da contagem dos 90 dias. Sem isto, liberar uma suspensão devolveria o
754|     // profissional já com 3 faltas válidas — a próxima falta o suspenderia na hora.
755|     await client.query(`ALTER TABLE faltas_profissional ADD COLUMN IF NOT EXISTS perdoada_em TIMESTAMPTZ`)
756|     // Quem perdoou. ON DELETE SET NULL de propósito: sem isso, apagar a conta de um admin que já
757|     // liberou alguém falharia por violação de FK e derrubaria a transação inteira de exclusão
758|     // (mesmo risco documentado no DELETE /usuarios/:id). A falta sobrevive com o autor anônimo.
759|     await client.query(`ALTER TABLE faltas_profissional ADD COLUMN IF NOT EXISTS perdoada_por UUID REFERENCES usuarios(id) ON DELETE SET NULL`)
760|     // Suspensão por acúmulo de faltas. suspenso_em É a flag: NULL = ativo, preenchido =
761|     // suspenso (mesma convenção de encerrado_em/chegada_confirmada_em — nada de booleano
762|     // paralelo que possa divergir do timestamp). suspenso_motivo guarda o porquê legível.
763|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS suspenso_em     TIMESTAMPTZ`)
764|     await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS suspenso_motivo TEXT`)
765|     // Avaliações 5 estrelas no encerramento — UNILATERAL: só o dono (criado_por) avalia o
766|     // prestador do match; o prestador recebe 403 em POST /avaliacoes (não avalia de volta).
767|     // UNIQUE(contrato_tipo, contrato_id, avaliador_id): cada avaliador avalia uma única vez
768|     // por contrato. Colunas seguem genéricas — ainda há linhas prestador→dono da regra antiga.
769|     await client.query(`
770|       CREATE TABLE IF NOT EXISTS avaliacoes (
771|         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
772|         contrato_tipo TEXT NOT NULL CHECK (contrato_tipo IN ('reparo', 'obra')),
773|         contrato_id UUID NOT NULL,
774|         avaliador_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
775|         avaliado_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
776|         estrelas INTEGER NOT NULL CHECK (estrelas BETWEEN 1 AND 5),
777|         criado_em TIMESTAMP DEFAULT NOW(),
778|         UNIQUE(contrato_tipo, contrato_id, avaliador_id)
779|       )
780|     `)
781|     await client.query(`CREATE INDEX IF NOT EXISTS avaliacoes_avaliado_idx ON avaliacoes (avaliado_id)`)
782|     // Lembrete de avaliação pendente — MESMO padrão dos marcos de vencimento da assinatura
783|     // (assinaturas.marco_1_em/2_em/3_em): a coluna É o claim, preenchida no mesmo UPDATE que
784|     // reivindica o envio, então re-run ou segunda réplica nunca mandam duas vezes.
785|     //   aval_marco_1_em → 1 dia após encerrado_em  |  aval_marco_2_em → 3 dias após
786|     // NULL = ainda não lembrado. Nomes prefixados com aval_ porque marco_1_em/2_em/3_em já
787|     // existem nestas duas tabelas com outro significado (marcos de EXPIRAÇÃO, pré-match).
788|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS aval_marco_1_em TIMESTAMPTZ`)
789|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS aval_marco_2_em TIMESTAMPTZ`)
790|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS aval_marco_1_em TIMESTAMPTZ`)
791|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS aval_marco_2_em TIMESTAMPTZ`)
792|     // "Não quero avaliar", registrado NO SERVIDOR (POST /avaliacoes/dispensar). Até aqui essa
793|     // escolha só existia no dispositivo: o job cutucaria quem já tinha dito não, e uma
794|     // reinstalação ressuscitaria o card. Preenchido = silenciado para sempre naquele contrato.
795|     await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS aval_dispensada_em TIMESTAMPTZ`)
796|     await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS aval_dispensada_em TIMESTAMPTZ`)
797|     // Índice PARCIAL do predicado do job (espelha assinaturas_marcos_vencimento_idx): só
798|     // encerradas COM match, não dispensadas e com algum marco pendente entram — a minoria.
799|     // As já lembradas nas duas bandas, e as dispensadas, saem do índice sozinhas.
800|     // A checagem de "não avaliada" fica de fora: é um NOT EXISTS em avaliacoes, não uma
801|     // coluna da demanda, então não cabe num índice parcial daqui.
802|     await client.query(`CREATE INDEX IF NOT EXISTS obras_aval_pendente_idx
803|                         ON obras (encerrado_em)
804|                         WHERE status = 'encerrada' AND match_usuario_id IS NOT NULL
805|                           AND aval_dispensada_em IS NULL
806|                           AND (aval_marco_1_em IS NULL OR aval_marco_2_em IS NULL)`)
807|     await client.query(`CREATE INDEX IF NOT EXISTS reparos_aval_pendente_idx
808|                         ON reparos (encerrado_em)
809|                         WHERE status = 'encerrada' AND match_usuario_id IS NOT NULL
810|                           AND aval_dispensada_em IS NULL
811|                           AND (aval_marco_1_em IS NULL OR aval_marco_2_em IS NULL)`)
812|     // Denúncias do prestador contra o dono de um contrato encerrado. Espelha avaliacoes:
813|     // contrato_id é UUID solto (aponta para obras OU reparos, por isso sem FK) e o UNIQUE
814|     // (contrato_tipo, contrato_id, denunciante_id) garante UMA denúncia por contrato.
815|     // denunciado_id é NULLABLE com ON DELETE SET NULL de propósito: se o dono excluir a
816|     // conta, a denúncia SOBREVIVE anonimizada para o histórico de moderação — ao contrário
817|     // de avaliacoes, que cai por CASCADE. denunciante_id segue CASCADE (a denúncia é do
818|     // autor; sem autor não há o que apurar).
819|     await client.query(`
820|       CREATE TABLE IF NOT EXISTS denuncias (
821|         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
822|         contrato_tipo TEXT NOT NULL CHECK (contrato_tipo IN ('reparo', 'obra')),
823|         contrato_id UUID NOT NULL,
824|         denunciante_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
825|         denunciado_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
826|         categoria TEXT NOT NULL CHECK (categoria IN ('nao_pagamento','nao_compareceu','servico_diferente','assedio','local_inseguro','fraude','outro')),
827|         descricao TEXT NOT NULL,
828|         status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','em_analise','resolvida','arquivada')),
829|         criado_em TIMESTAMP DEFAULT NOW(),
830|         UNIQUE(contrato_tipo, contrato_id, denunciante_id)
831|       )
832|     `)
833|     // Caminho de acesso do painel admin: fila por status, mais recentes primeiro.
834|     await client.query(`CREATE INDEX IF NOT EXISTS denuncias_status_idx ON denuncias (status, criado_em DESC)`)
835|     // Visualizações de feed (proximidade): item visto no feed sem manifestar interesse.
836|     // notificado marca o push one-time já enviado. UNIQUE evita duplicar a mesma view.
837|     await client.query(`
838|       CREATE TABLE IF NOT EXISTS feed_visualizacoes (
839|         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
840|         usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
841|         item_tipo TEXT NOT NULL CHECK (item_tipo IN ('reparo', 'obra')),
842|         item_id UUID NOT NULL,
843|         notificado BOOLEAN DEFAULT false,
844|         criado_em TIMESTAMP DEFAULT NOW(),
845|         UNIQUE(usuario_id, item_tipo, item_id)
846|       )
847|     `)
848|     await client.query(`CREATE INDEX IF NOT EXISTS feed_visualizacoes_usuario_notif_idx ON feed_visualizacoes (usuario_id, notificado)`)
849|     // Cooldown DURÁVEL do cron de proximidade (verificarPrestadoresProximos). Substitui o Map em
850|     // memória (perdido a cada deploy, não compartilhado entre réplicas). Uma linha por par
851|     // (prestador, demanda); o claim atômico (INSERT ... ON CONFLICT DO UPDATE ... WHERE) só concede
852|     // se não houve notificação nas últimas 4h. PK cobre o conflito e o lookup — sem índice extra.
853|     await client.query(`
854|       CREATE TABLE IF NOT EXISTS proximidade_notificacoes (
855|         prestador_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
856|         demanda_tipo  TEXT NOT NULL CHECK (demanda_tipo IN ('reparo','obra')),
857|         demanda_id    UUID NOT NULL,
858|         notificado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
859|         PRIMARY KEY (prestador_id, demanda_tipo, demanda_id)
860|       )
861|     `)
862|     // Contador de envios por par (prestador, demanda): o cron insiste a cada ~10 min e para
863|     // no 3º aviso. DEFAULT 1 é o valor correto para as linhas que já existem — elas já
864|     // receberam pelo menos um envio. NOT NULL + DEFAULT em PG 11+ não reescreve a tabela
865|     // (o default fica no catálogo), então é barato mesmo com a tabela populada.
866|     await client.query(`ALTER TABLE proximidade_notificacoes ADD COLUMN IF NOT EXISTS envios INT NOT NULL DEFAULT 1`)
867|     // Armamento por abertura de detalhe (redesenho de proximidade — reparadores + reparos).
868|     // Uma linha = um reparador que ABRIU o detalhe de um reparo enquanto estava a >5km do
869|     // endereço de cadastro dele. notificado marca o push one-time (consumido num passo futuro;
870|     // nada lê esta tabela ainda). PK (reparador_id, reparo_id) torna re-aberturas idempotentes.
871|     // Tabela NOVA: colunas NOT NULL têm DEFAULT (ou são preenchidas no INSERT), então não há
872|     // risco de violar constraint em linhas existentes — não existem linhas.
873|     await client.query(`
874|       CREATE TABLE IF NOT EXISTS aberturas_detalhe (
875|         reparador_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
876|         reparo_id    UUID NOT NULL REFERENCES reparos(id) ON DELETE CASCADE,
877|         aberto_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
878|         notificado   BOOLEAN NOT NULL DEFAULT false,
879|         PRIMARY KEY (reparador_id, reparo_id)
880|       )
881|     `)
882|     await client.query(`CREATE INDEX IF NOT EXISTS aberturas_detalhe_reparador_notif_idx ON aberturas_detalhe (reparador_id, notificado)`)
883|     // Livro-caixa de eventos do webhook PagBank. Serve a DOIS propósitos:
884|     //   1) idempotência — o INSERT ... ON CONFLICT DO NOTHING vira CLAIM atômico (mesmo
885|     //      idioma de contratosController): quem grava a linha processa o evento.
886|     //   2) registro dos desfechos NÃO-PAID (DECLINED, CANCELED, REFUNDED, WAITING), que
887|     //      hoje são descartados sem log nem estado.
888|     // PK (charge_id, status) e não charge_id sozinho: uma cobrança transita de verdade
889|     // (WAITING → PAID), e a chave simples faria a 1ª entrega bloquear o PAID seguinte.
890|     // Renovação legítima traz charge_id novo → linha nova → processa.
891|     // Sem FK para usuarios: reference_id é gravado CRU ("{usuario_id}|{plano}"), e o livro
892|     // não pode perder o registro de um evento por causa de um usuário apagado depois.
893|     await client.query(`
894|       CREATE TABLE IF NOT EXISTS webhook_eventos_pagbank (
895|         charge_id      TEXT NOT NULL,
896|         status         TEXT NOT NULL,
897|         reference_id   TEXT,
898|         valor_centavos INT,
899|         recebido_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
900|         PRIMARY KEY (charge_id, status)
901|       )
902|     `)
903|     // Tentativas de login / redefinição POR IDENTIDADE (ver src/utils/tentativasAuth.js).
904|     // Guarda interna ao lado dos limiters por IP: o de IP não vê ataque dirigido a UMA conta
905|     // e, nesta base, é enfraquecido pelo CGNAT das operadoras.
906|     // Chave é o e-mail SUBMETIDO (não usuario_id) e conta até para endereço sem conta — é o
907|     // que permite devolver 429 no login sem virar oráculo de existência.
908|     // Sem `bloqueado_ate`: "bloqueado" é tentativas >= limite dentro da janela, então o fim da
909|     // janela JÁ é o desbloqueio — um estado a menos para manter coerente.
910|     // Sem FK para usuarios: o identificador pode não ter conta e a linha deve sobreviver à
911|     // exclusão dela.
912|     await client.query(`
913|       CREATE TABLE IF NOT EXISTS tentativas_auth (
914|         acao          TEXT NOT NULL CHECK (acao IN ('login', 'reset', 'reset_confirmar')),
915|         identificador TEXT NOT NULL,
916|         tentativas    INT NOT NULL DEFAULT 0,
917|         janela_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
918|         PRIMARY KEY (acao, identificador)
919|       )
920|     `)
921|     // Amplia o CHECK do acao para incluir 'reset_confirmar' (adivinhação do código de
922|     // redefinição). CREATE TABLE IF NOT EXISTS não altera tabela existente, então em bancos
923|     // já criados o CHECK antigo (login,reset) rejeitaria o novo acao — drop-and-add idempotente.
924|     await client.query(`ALTER TABLE tentativas_auth DROP CONSTRAINT IF EXISTS tentativas_auth_acao_check`)
925|     await client.query(`ALTER TABLE tentativas_auth ADD CONSTRAINT tentativas_auth_acao_check CHECK (acao IN ('login', 'reset', 'reset_confirmar'))`)
926|     // A PK atende as buscas; este índice serve só à varredura diária por idade.
927|     await client.query(`CREATE INDEX IF NOT EXISTS tentativas_auth_janela_idx ON tentativas_auth (janela_em)`)
928|     // Fila de mídias cujo ARQUIVO ainda está no Cloudinary mas cuja LINHA já foi apagada.
929|     // deletarMidiasAntigas só enxerga mídia através da demanda; quando a linha some (exclusão
930|     // de conta, limpezas do admin, troca de slot no upload), o arquivo ficava órfão para
931|     // sempre — não havia mais nada apontando para ele. Todo DELETE de mídia agora enfileira
932|     // aqui NO MESMO statement, e o cron esvazia a fila.
933|     // PK na url: a mesma url enfileirada duas vezes é a mesma exclusão, não duas.
934|     // Sem FK: o ponto da tabela é justamente sobreviver ao sumiço da linha de origem.
935|     await client.query(`
936|       CREATE TABLE IF NOT EXISTS midias_orfas (
937|         url       TEXT PRIMARY KEY,
938|         tipo      TEXT,
939|         criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
940|       )
941|     `)
942|     // O cron varre em ordem de chegada com LIMIT — este índice serve a esse ORDER BY.
943|     await client.query(`CREATE INDEX IF NOT EXISTS midias_orfas_criado_em_idx ON midias_orfas (criado_em)`)
944|     // Sugestões livres do usuário sobre o app. Tabela NOVA e puramente aditiva: nada existente
945|     // lê ou escreve nela, e nenhum ALTER a acompanha. CREATE TABLE IF NOT EXISTS torna o re-run
946|     // de cada boot um no-op — a migração roda ANTES do app.listen e não pode falhar aqui.
947|     // usuario_id segue a convenção das demais tabelas do usuário (UUID REFERENCES usuarios(id)):
948|     // ON DELETE CASCADE porque a sugestão é do autor — sem conta, some junto, como em avaliacoes.
949|     // Sem UNIQUE: o mesmo usuário pode sugerir quantas vezes quiser, e cada uma conta.
950|     await client.query(`
951|       CREATE TABLE IF NOT EXISTS sugestoes (
952|         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
953|         usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
954|         texto TEXT NOT NULL,
955|         criado_em TIMESTAMPTZ DEFAULT NOW()
956|       )
957|     `)
958|     await client.query('COMMIT')
959|     console.log('[migration] colunas verificadas com sucesso')
960|   } catch (err) {
961|     if (client) await client.query('ROLLBACK').catch(() => {})
962|     console.error('[migration] FALHOU — rollback executado:', err.message)
963|     throw err
964|   } finally {
965|     if (client) client.release()
966|   }
967| })()
```
