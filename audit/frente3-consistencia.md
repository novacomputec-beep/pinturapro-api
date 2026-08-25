# Auditoria — Frente 3: Consistência dos Dois Lados (obra × reparo, dono × prestador)

**Data:** 2026-08-25
**Base de código:** `main` em `f5403a9` (inclui as correções de hoje: D52, gates de `/match` e `prestador-responder`, `exigirPintor` em `/candidaturas`).
**Escopo:** Toda regra do sistema existe duas vezes — obra (pintura; `obras`/`candidaturas`/`midias`) e reparo (serviço; `reparos`/`interesse_reparos`/`midias_reparos`) — e para dois papéis (dono, prestador). Esta passagem compara os dois lados ponto a ponto em seis dimensões: (1) ciclo de vida, (2) notificações e push, (3) timers e prazos, (4) o lado do dono, (5) cancelamento/recusa/penalidades, (6) dados gravados. Defeito aqui é **assimetria**: algo que funciona num lado e não no outro.
**Método:** Leitura de código (`src/routes/index.js` 6429 linhas, `src/services/alertaService.js`, `server.js`, `src/controllers/*`, `src/utils/rejeitarConcorrentes.js`, `faixasPrazo.js`), leitura do app (`pinturapro-app`) e do painel (`painel-admin`) só para confirmar quais rotas/campos são usados, e consultas **somente-leitura** ao Postgres de produção para confirmar ocorrência e esquema (`information_schema`, `pg_indexes`). Nada foi modificado; nenhuma escrita no banco. Numeração continua de D71 (Frente 2 foi até D70).
**O que NÃO é achado aqui:** divergências deliberadas e documentadas no código (prazos de auto-encerramento 2d/6h obra vs 3h/30min reparo; obra nasce `rascunho`/`pendente` e reparo nasce `aberta`/`aprovada`; proximidade só reparo) foram conferidas e ficam registradas na seção "Simétrico/decidido", não como defeito.

## Evidência decisiva de ocorrência (lida de produção, somente-leitura)

- **Esquema:** `obras` (63 col.) e `reparos` (59 col.) compartilham 51 colunas. Só obras: `valor, estado, metragem, prazo_execucao_dias, enviada_por_dono, horas_para_expirar, publicado_em, prazo_timezone`. Só reparos: `valor_estimado, prazo_atendimento_horas, prazo_estimado_horas (morta — nenhum código lê/escreve), endereco_reparo`. `candidaturas` tem `referencias, observacoes_admin, aprovado_por, atualizado_em (nunca gravada), valor_oferta, mensagem_oferta`; `interesse_reparos` tem `rodada`.
- **Índices (pg_indexes):** `contratos` tem UNIQUE só em `candidatura_id` (`contratos_candidatura_id_key`); **não existe índice único em `contratos.interesse_id`** — confirma D79. `candidaturas_aceito_unica_idx` e `interesse_reparos_aceito_unico_idx` (parciais em `status='aceito'`) existem nos dois lados — é o que torna D71 um bloqueio real.
- **Defaults de coluna:** `reparos.status_aprovacao` default `'pendente'` e `reparos.status` default `'rascunho'`, mas o INSERT do reparo grava `'aberta'/'aprovada'` explicitamente (index.js:2947); `obras.status_aprovacao` default `'aprovada'`, então o POST /obras do painel (que não grava a coluna) publica direto.
- **Estado hoje:** obras 5 abertas / 1 encerrada; reparos 11 abertas / 5 encerradas; **0 canceladas** nos dois lados; **0 reparos com `prazo_atendimento_horas` NULL**; 0 linhas com `prazo_modo` preenchido; 0 `pedido_tempo_status` residual sem match; 0 proposta `'aceito'` órfã (sem match); 0 chegada residual sem match. Ou seja: **as três ALTAs são latentes hoje** — o código tem o furo, o dado ainda não caiu nele.
- **Vivo hoje:** (a) **6 de 6 donos (`dono_obra`) têm linha `ativa` em `assinaturas`** → D74 (leitura de detalhe de obra alheia) é exercível por qualquer dono agora; (b) `/dashboard` mostra **0 propostas pendentes enquanto há 2 `interesse_reparos` pendentes** (D84); (c) `interesse_reparos.rodada` = 1 nas 15 linhas (D93); (d) `midias.url_thumbnail` NULL nas 5 linhas (D94); (e) 0 usuários com `role='assinante'` (D98 — o push do POST /obras do painel não alcança ninguém).
- **`contratos.valor_acordado` NULL nos 6 contratos** embora as propostas aceitas tenham valor (120/500/50/80/120): os 6 são de 11–20/08 e a gravação de `valor_acordado` entrou em 24/08 (`68bfd69`, `30e4bdb`) — legado, **simétrico**, não é achado desta frente; fica anotado para o relatório de finalizadas.
- **Usuários:** 3 `dono_obra/pintura`, 3 `dono_obra/reparo`, 3 `prestador/pintor`, 12 `prestador/reparador`, 1 admin; 0 prestador com `tipo_prestador` fora de pintor/reparador (D87 latente).

## Resumo para quem não programa

O sistema é, na prática, dois aplicativos gêmeos — um para obras de pintura, outro para serviços de reparo — escritos como cópias um do outro. Quando uma regra é corrigida ou melhorada de um lado, nem sempre a mesma correção chega ao outro. Esta auditoria percorreu os dois lados passo a passo, do cadastro à avaliação final, e encontrou 28 pontos onde eles se comportam diferente. Três são graves: (1) quando o dono de um **reparo** recusa o pedido de "mais tempo" do profissional, o serviço volta para a vitrine mas fica **travado** — nenhum outro profissional consegue ser aceito nele, porque a proposta antiga continua marcada como "aceita" (no lado obra isso foi consertado em 08/08 e não foi replicado); (2) o dono de uma **obra** consegue "excluir" a obra mesmo com pintor já contratado e a caminho — sem aviso nenhum ao pintor, que fica com um contrato apontando para uma obra cancelada (no lado reparo isso é bloqueado); (3) um reparo sem prazo de atendimento nunca é devolvido à vitrine nem gera falta ao profissional que não aparece (o dono do projeto já sabe deste). Nenhum desses três está acontecendo hoje na base — o dado ainda não caiu no buraco — mas o buraco existe. Dos pontos médios, o que já vale hoje: qualquer dono consegue abrir o detalhe (fotos, coordenadas) de obras de outros donos, coisa que o lado reparo bloqueia; o painel conta "propostas pendentes" só de obras e ignora reparos; e o card de reparo na vitrine nunca mostra a urgência ("atender em até Nh") porque a API não manda o campo que o app espera. Nada foi corrigido — este documento só cataloga.

**Contagem:** 28 achados — 3 ALTA, 15 MÉDIA, 10 BAIXA. Numerados D71–D98. Cada título segue o formato `[GRAVIDADE] o que diverge — onde (obra | reparo) — lado correto e por quê`.

---

## ALTA

### D71. [ALTA] Recusar "tempo extra" desfaz o match sem expirar a proposta 'aceito' no lado reparo — obra index.js:2843-2861 | reparo index.js:4366-4386 — obra está certa: sem isso o reparo volta ao feed com `interesse_reparos_aceito_unico_idx` ocupado e nenhum novo aceite passa
- **O que quebra:** `POST /reparos/:id/responder-tempo` com `aceito=false` zera match/chegada/pedido_tempo e bloqueia o prestador, mas **não toca `interesse_reparos`**. O interesse do prestador expulso continua `status='aceito'`: (1) o guard `jaAceito` (index.js:3597-3603) devolve 409 "Já existe um prestador aceito" para qualquer novo aceite, e o índice parcial único barra o UPDATE; (2) o próprio prestador bloqueado ainda passa em `POST /reparos/:id/match` (3510-3530: status aberta, match NULL, interesse 'aceito') e refaz o match sozinho apesar de estar em `prestadores_bloqueados`; (3) `/reparos/minhas` e `/admin/finalizadas` atribuem `valor_acordado` ao prestador expulso. O push "voltou para disponível" (4392-4397) promete algo que não acontece.
- **Onde (obra):** src/routes/index.js:2843-2861 — CTE `desfeito` + `UPDATE candidaturas SET status='expirado' WHERE ... status='aceito'` (fix `bd299a4`, 08/08, com comentário explicando exatamente este bug).
- **Onde (reparo):** src/routes/index.js:4366-4386 — só `UPDATE reparos`. O `expirar-match` de reparo (3872-3886) e o cron (alertaService.js:696-708) fazem o expirar; só o `responder-tempo` ficou de fora.
- **Como se chega:** Prestador de reparo pede tempo → dono recusa → serviço volta ao feed → ninguém consegue ser aceito nele.
- **Já aconteceu?:** Não (0 interesse 'aceito' com reparo sem match hoje).
- **Risco se não corrigir:** Serviço "aberto" mas inaceitável; dono precisa cancelar e recriar; prestador bloqueado consegue voltar pelo `/match`.

### D72. [ALTA] Dono cancela obra com pintor casado/a caminho; reparo bloqueia com 409 — obra index.js:2014-2023 | reparo index.js:2971-2978 — reparo está certo: cancelar demanda com profissional em deslocamento sem aviso é quebra de fluxo silenciosa
- **O que quebra:** `DELETE /obras/dono/:id` só checa `criado_por` e grava `status='cancelada'` — não olha `match_usuario_id` nem `status`. Com pintor casado: candidatura fica `'aceito'`, contrato já enviado, `match_usuario_id` preso, nenhum push ao pintor; os crons não pegam (exigem `status='aberta'`, alertaService.js:765/798), então o match nunca expira nem gera falta. Também permite virar uma obra `'encerrada'` em `'cancelada'` (some de `/admin/finalizadas`, avaliações apontam para linha cancelada). O app mostra a lixeira igual para os dois tipos (pinturapro-app MinhasObrasScreen.js:189-195).
- **Onde (obra):** src/routes/index.js:2014-2023.
- **Onde (reparo):** src/routes/index.js:2971-2978 — `if (match_usuario_id) return 409 'Não é possível excluir um serviço com prestador a caminho'`.
- **Como se chega:** Dono de obra com pintor aceito toca "excluir" em Minhas Obras.
- **Já aconteceu?:** Não (0 obras canceladas hoje).
- **Risco se não corrigir:** Pintor viaja para obra cancelada; `/candidaturas/minhas` mostra match numa obra morta; sem falta, sem aviso, sem desfazer.

### D73. [ALTA] Cronômetro de reparos ignora reparo casado com `prazo_atendimento_horas` NULL (nem aviso de 5 min, nem devolução ao feed, nem falta); cronômetro de obras cobre com COALESCE — obra alertaService.js:765-803 (847 `COALESCE(horas_para_expirar,720)`) | reparo alertaService.js:628,663 (`prazo_atendimento_horas IS NOT NULL` nos dois ramos; 710-711 sem COALESCE) — obra está certa: a penalidade por não comparecer existe num lado só
- **O que quebra:** Reparo casado com prazo NULL nunca entra no ramo (a) nem no (b): match "eterno", sem push de 5 min, sem `registrarFalta`, sem voltar ao feed. Só o `expirar-match` manual desfaz (sem falta, por desenho).
- **Onde (obra):** src/services/alertaService.js:765-776, 798-803, 846-847.
- **Onde (reparo):** src/services/alertaService.js:622-634, 660-666, 710-711.
- **Como se chega:** Linha legada ou inserida fora do app (o create atual grava `|| 720`, index.js:2938).
- **Já aconteceu?:** Não hoje (0 reparos com prazo NULL). **Já conhecido do dono do projeto e deferido por decisão dele** (memória `reparo-prazo-null-expiry-alert-bug`) — relatado aqui por ser assimetria, não para reabrir.
- **Risco se não corrigir:** Prestador que fura em reparo sem prazo não é penalizado e o dono fica preso ao match.

---

## MÉDIA

### D74. [MÉDIA] `GET /obras/:id` não checa role — qualquer `dono_obra` com assinatura lê detalhe de obra alheia; `GET /reparos/:id` devolve 403 a não-prestador — obra index.js:2207-2215 | reparo index.js:4436-4438 — reparo está certo: gate mais frouxo do lado obra, e **6 de 6 donos têm assinatura `ativa` em prod**, então vale hoje
- **O que quebra:** Não-dono/não-match/não-admin cai direto na consulta de `assinaturas`; role não é olhada. Endereço/contato ficam mascarados (gate por match), mas mídias, coordenadas, bairro e lista de propostas (nomes, avaliações) saem.
- **Onde (obra):** src/routes/index.js:2207-2215. **Onde (reparo):** src/routes/index.js:4436-4438 (`if (role !== 'prestador') return 403`).
- **Como se chega:** Dono com assinatura ativa chama GET /obras/<id de outro dono>.
- **Já aconteceu?:** Desconhecido (sem log de leitura); condição presente em 100% dos donos.
- **Risco se não corrigir:** Dono enxerga obras e propostas de concorrentes; reparo já fecha isso.

### D75. [MÉDIA] `POST /reparos/:id/expirar-match` não zera `pedido_tempo_status/motivo/minutos`; o de obra zera — obra index.js:2669 | reparo index.js:3851-3861 — obra está certa: un-match tem de limpar todo o estado da rodada anterior (o cron de reparos limpa, alertaService.js:688-690)
- **O que quebra:** Reparo volta ao feed com `pedido_tempo_status='aguardando_aprovacao'` (o feed expõe a coluna, 3342; DetalheReparoScreen lê 7 vezes); o próximo prestador casado herda um pedido de tempo alheio e o dono vê botões de aceitar/recusar tempo de quem já saiu; `responder-tempo aceito=true` (4341-4345 não valida estado) soma os minutos do antigo ao `match_feito_em` do novo.
- **Já aconteceu?:** Não (0 residual hoje). **Risco:** modal fantasma e prazo somado errado no match seguinte.

### D76. [MÉDIA] Cron `verificarCronometroObras` não zera `pedido_tempo_*` ao desfazer o match; `verificarCronometroReparos` zera — obra alertaService.js:816-835 | reparo alertaService.js:684-690 — reparo está certo (espelho invertido de D75)
- **O que quebra:** Obra devolvida ao feed pelo cron carrega o pedido de tempo do pintor que furou para o próximo match.
- **Já aconteceu?:** Não (0 residual). **Risco:** igual a D75, no lado obra.

### D77. [MÉDIA] Fila de aprovação admin do reparo é um esqueleto: aprovar não reinicia `expira_em` (nem há `publicado_em`) e não avisa o dono; recusar não tem guarda de idempotência nem push — obra index.js:1910-1930 (`aprovarEPublicarObra`), 1942-1961, 1873-1891 | reparo index.js:3145-3160, 3166-3176 — obra está certa
- **O que quebra:** (a) reparo recusado (`status='cancelada'`, `encerrado_em` gravado) e reaprovado volta `'aberta'` com o `expira_em` original (possivelmente vencido → invisível no feed) e `encerrado_em` sujo (nenhum lado limpa na reaprovação); obra reaprovada ganha relógio novo. (b) Dono de reparo não recebe `obra_recusada`/`obra_aprovada` equivalente — como reparo nasce aprovado (2947), a recusa na prática **cancela um serviço já publicado sem avisar o dono**. App só trata `obra_recusada` (AppNavigator.js:171-175).
- **Como se chega:** Admin recusa reparo no painel (o painel hoje não expõe a fila de reparos; rota existe).
- **Já aconteceu?:** Não (0 reparos recusados/pendentes). **Risco:** dono só descobre abrindo "Meus Reparos"; reaprovação publica com relógio gasto.

### D78. [MÉDIA] Faixa "Hoje" (`prazo_modo='hoje'`): obra resolve o fim do dia na zona do dono e estende por dias; reparo usa São Paulo fixo, não grava zona e o estender ignora `prazo_modo` — obra index.js:1806,1818,1919,2142-2151; alertaService.js:840-841 | reparo index.js:2948 (`SQL_FIM_DO_DIA_SP`), 3077 (`GREATEST(expira_em,NOW())+horas`); alertaService.js:704-705 — obra está certa
- **O que quebra:** Dono fora de UTC-3 tem o "hoje" do reparo no dia errado; estender um reparo "hoje" converte meia-noite em horário de relógio (defeito descrito e corrigido no comentário 2128-2140 do lado obra). `faixasPrazo.js:129-131` afirma que reparo "não tem faixa Hoje", mas o INSERT tem o ramo.
- **Já aconteceu?:** Não — **dormente**: o app não envia `prazo_modo` para reparo (CadastrarReparoScreen.js:275-290) e há 0 linhas com `prazo_modo` em prod. Backend aceita.

### D79. [MÉDIA] Claim do contrato de reparo é `INSERT … WHERE NOT EXISTS` sem índice único em `contratos.interesse_id` (confirmado em prod: só `contratos_candidatura_id_key`); obra usa `ON CONFLICT (candidatura_id)` — obra contratosController.js:374-379 | reparo contratosController.js:271-276 — obra está certa: duas execuções concorrentes passam as duas pelo NOT EXISTS
- **O que quebra:** Os 5 caminhos de aceite disparam `enviarContratoReparo` em fire-and-forget e o retry do dono (index.js:3585-3589) rechama; corrida = 2 linhas em `contratos` e 2 e-mails.
- **Já aconteceu?:** Não (0 `interesse_id` duplicado). **Risco:** contrato duplicado no livro; era UNVERIFIED nos relatórios parciais e foi **confirmado por `pg_indexes`**.

### D80. [MÉDIA] Feed de reparos expõe colunas internas que o feed de obras não expõe: `criado_por, match_usuario_id, match_feito_em, pedido_tempo_status, prestadores_bloqueados, client_request_id, status_aprovacao` — obra obrasController.js:12-18 | reparo index.js:3339-3343 — obra está certa: `prestadores_bloqueados` (lista de UUIDs de quem furou naquele reparo) vai para qualquer reparador assinante
- **Já aconteceu?:** É forma de resposta (acontece em toda chamada). **Risco:** vazamento de lista negra e de id do dono no card.

### D81. [MÉDIA] Feed de reparos **omite** `prazo_atendimento_horas`, e o card do app usa esse campo para a faixa de urgência — API index.js:3339-3343 (SELECT sem a coluna) | app FeedReparosScreen.js:34-35 (`if (!horas) return null`), 107, 127 — obra está certa (o card de obra usa só `expira_em`, que o feed devolve): o campo-chave do produto reparo ("🔴 URGENTE / Atender em até Nh") nunca aparece na vitrine
- **Já aconteceu?:** Sim, em toda listagem (silencioso: o app trata ausência como "sem urgência"). **Risco:** reparador não distingue urgente de 7 dias no feed.

### D82. [MÉDIA] `POST /candidaturas/:id/aprovar|recusar` (usado pelo painel: index.html:1486/1491) existe só para obra e é mais frouxo que o `/responder`: `aprovar` não checa obra aberta/sem match, `recusar` não avisa o pintor — obra candidaturasController.js:143-238, 240-274; index.js:5320-5321 | reparo index.js:3562-3669 (`reparoAbertoParaNegociar`, push em toda recusa) — reparo está certo nas guardas
- **O que quebra:** Pelo controller o dono/admin aceita candidatura de obra `'encerrada'` (o UPDATE em obras só exige `match_usuario_id IS NULL`); pintor recusado por esse caminho não recebe `candidatura_recusada` (o `/responder` envia, 2390-2395).
- **Já aconteceu?:** Não (0 candidaturas com `aprovado_por` em obra não-aberta). **Risco:** match em obra fechada; pintor sem aviso.

### D83. [MÉDIA] `POST /candidaturas` grava `valor_oferta/mensagem_oferta/referencias`, mas todo leitor de preço (contrato, finalizadas, minhas, meus-contratos) lê `valor_proposto/valor_contraproposta` — obra index.js:5291-5293 vs 2302-2304 | reparo index.js:3432-3434 (único caminho, coerente) — reparo está certo: candidatura por essa rota aceita gera contrato "a combinar" e `valor_acordado` NULL
- **Já aconteceu?:** Não (0 candidaturas com `valor_oferta`); app atual usa `/obras/:id/candidatura` com `valor_proposto` (DetalheObraScreen.js:417); `api.js:258` ainda aponta para `/candidaturas` mas não tem chamador. Endpoint vivo, cliente morto.

### D84. [MÉDIA] `/dashboard` conta "propostas pendentes" só em `candidaturas`; `interesse_reparos` não entra — obra index.js:5777 | reparo (nada) — obra-only é o erro: **hoje o painel mostra 0 enquanto há 2 interesses pendentes**
- **Já aconteceu?:** Sim, agora. **Risco:** relatório do painel ignora metade do marketplace (11 reparos abertos vs 5 obras).

### D85. [MÉDIA] Encerramento/cancelamento por admin: `DELETE /obras/:id` (painel index.html:1460) grava `status='encerrada'` sem `status_aprovacao='encerrada'` e sem limpar `encerramento_solicitado_*`; reparo não tem rota admin nenhuma — obra obrasController.js:270-273 vs POST /obras/:id/encerrar index.js:2607-2611 | reparo index.js:3779-3783 (só o encerrar comum) — ambos errados: obra tem dois caminhos admin inconsistentes, reparo não tem nenhum no painel
- **Já aconteceu?:** Não (0 obras encerradas com `status_aprovacao<>'encerrada'`). **Risco:** linha inconsistente com todas as outras encerradas; solicitação pendente pendurada; admin não consegue encerrar reparo pelo painel.

### D86. [MÉDIA] Alerta de baixo engajamento rearma a cada 24h na obra e a cada 8h no reparo (job roda a cada 8h) — obra alertaService.js:345 | reparo alertaService.js:378 — nenhum lado documenta; o resto da função é cópia byte a byte, parece esquecimento
- **Já aconteceu?:** Não (0 `alerta_enviado_em` nos dois lados). **Risco:** dono de reparo é cutucado 3× mais.

### D87. [MÉDIA] Broadcast de novo reparo mira `tipo_prestador IS DISTINCT FROM 'pintor'` (inclui NULL/legado), mas o gate `exigirReparador` exige `'reparador'` estrito; obra alinha broadcast e gate — obra alertaService.js:205 (`= 'pintor'`, igual a `exigirPintor` index.js:1004) | reparo alertaService.js:251 vs index.js:996-1005 — obra está certa: push deve ir só a quem consegue agir
- **Já aconteceu?:** Não (0 prestador fora de pintor/reparador). **Risco:** quem recebe `novo_reparo` toca e cai em 403 TIER_INCORRETO.

### D88. [MÉDIA] Canal de dúvidas (`/mensagens`) existe só para obra, e do lado obra a aba "Mensagens" do dono é inoperante — obra mensagensController.js:5-59, index.js:5741-5744; app AppNavigator.js:754 (aba), MensagensScreen.js:55-63 (lista via `/candidaturas/minhas`, vazio para dono) | reparo: nenhuma rota, `DonoReparoTabNavigator` sem aba (AppNavigator.js:721-727, comentário 673 "obra-only") — nenhum lado está certo: dono de pintura vê aba morta, dono de reparo não tem canal. O push `nova_mensagem` que o app roteia (AppNavigator:119) não é emitido por nenhum caminho da API
- **Já aconteceu?:** 0 mensagens em prod. **Risco:** confusão de produto; canal inexistente para reparo.

---

## BAIXA

### D89. [BAIXA] Estender: reparo tem carência de 1h para faixa longa (>24h ou prazo NULL) e devolve `pode_estender_em`; obra não tem carência; `extensao_maxima_horas` é `8760-horas` na obra e constante 8760 no reparo, e o detalhe da obra calcula um advisory cumulativo diferente dos dois — obra index.js:2096-2190, 2182-2185, 2270-2283 | reparo index.js:3028-3034, 3075-3088, 3116-3121, 4418-4423 — regra de produto deliberada (comentário 3075-3076), mas o app trata os modais igual e o dono de obra estende no segundo 1; três números diferentes para a "mesma" regra
- **Já aconteceu?:** n/a. **Risco:** contrato de API inconsistente; app não lê `extensao_maxima_horas` (grep vazio), só `pode_estender_em`.

### D90. [BAIXA] Push de 5 minutos no lado reparo não exige `status='aberta'`; obra exige — obra alertaService.js:769 | reparo alertaService.js:623-634 (só o ramo (b), 661, filtra) — obra está certa: reparo encerrado pelo admin (que dispensa chegada, 3772) com match e sem chegada declarada receberia "O prestador ainda não chegou?"
- **Já aconteceu?:** Não (0 candidatos hoje).

### D91. [BAIXA] Marcos de expiração: obra exige `status_aprovacao='aprovada'`; reparo não filtra aprovação — obra alertaService.js:442-450 | reparo alertaService.js:451-452 (comentário "por decisão") — obra está certa; impacto baixo porque reparo nasce aprovado e recusa vira `cancelada`
- **Já aconteceu?:** Não (0 reparos abertos não-aprovados).

### D92. [BAIXA] Forma do detalhe/listas diverge em campos secundários: `meu_interesse` não traz `mensagem` (obra traz), candidatos em `DESC` e interessados em `ASC`, `/reparos/meus-contratos-dono` devolve `descricao` (obra não), `total_candidaturas/foto_capa` no objeto só na obra — obra index.js:2223, 2245, 1720-1721, 2200-2202 | reparo index.js:4450, 4474, 3300-3301, 4418-4422 — obra está certa em `mensagem` (prestador não revê o texto que enviou); o resto é cosmético (app não lê os campos divergentes)

### D93. [BAIXA] Colunas de proposta exclusivas por lado, sem uso: `rodada` só em `interesse_reparos` (nasce 1, vira 2 na contraproposta do dono, nunca avança; prod: 15/15 = 1); `aprovado_por` só gravado pelo controller legado; `candidaturas.atualizado_em` nunca gravada — obra candidaturasController.js:164-166 | reparo index.js:3433, 3652 — nenhum lado limita rodadas; colunas só confundem o painel

### D94. [BAIXA] Upload multipart legado: `/upload/dono` (obra) grava `url_thumbnail`, aceita admin e distingue 404/403; `/upload/reparo` não grava thumbnail, não aceita admin e devolve 403 para tudo — obra uploadController.js:17-33 | reparo index.js:4518-4534 — obra está certa; efeito prático nulo: app usa só `/upload/obra-url` e `/upload/reparo-url` (midia.js:173-176), que são espelhos e nenhum grava thumbnail (prod: 0/5 com thumbnail). Não existe exclusão de mídia pelo dono em nenhum lado

### D95. [BAIXA] `/obras/admin` não tem filtro `'abertas'` e devolve colunas diferentes de `/reparos/admin`; o painel usa `GET /obras` (feed de pintor, com `exigirPintor/exigirAssinaturaAtiva`) para listar obras abertas — obra index.js:1985-1991; painel index.html:1417 | reparo index.js:3181-3190 — reparo está certo. UNVERIFIED: se o admin passa nesses gates em `GET /obras`

### D96. [BAIXA] App: badge "Profissional a caminho" na lista do dono só para reparo — MinhasObrasScreen.js:138 (`tipo === 'reparo' && match_feito_em && match_usuario_id`) | `/obras/minhas` devolve os mesmos campos (index.js:1639-1665) — reparo está certo: dono de obra não vê na lista que há pintor a caminho

### D97. [BAIXA] Proximidade (cron + `/feed/checar-proximidade`) cobre só reparos por decisão explícita, mas o app ainda roteia `obra_proxima`, que nenhum backend emite — reparo server.js:285-290, index.js:5723-5728 | obra server.js:229-232, index.js:5673 ("Obras removidas"); app AppNavigator.js:164-167 — reparo está certo (decisão); caso morto no app

### D98. [BAIXA] `POST /obras` (admin, painel index.html:1275) usa `notificacaoService.notificarNovaObra`, que filtra `role='assinante'` (0 usuários) — ninguém recebe o push; `contratoService.gerarEEnviarContrato` (lê `obras.valor`, não o acordado) não é chamado por rota nenhuma; reparo não tem criação por admin — obra obrasController.js:185, notificacaoService.js:34-58, contratoService.js:224-292 | reparo: sem equivalente — código morto/legado do lado obra; só relevante porque o painel chama a rota

---

## Simétrico / decidido (verificado, não numerado)

Pontos comparados e **iguais nos dois lados** (para o leitor saber o que foi coberto): criação (mesmo gate, mesmo `limiteDemandasAtingido` obras+reparos, mesma idempotência por `client_request_id`, mesmo default 720h, nenhum lado valida campos obrigatórios); feed (mesmos filtros de status/aprovação/expiração/match/bloqueios per-demanda e globais, mesma ordem); proposta (mesma unicidade por SELECT-then-INSERT — corrida possível nos dois; nenhum dos três caminhos checa expirada/casada/cancelada); resposta do dono e do prestador (guardas D8, `jaAceito`, `estaSuspenso`, contrato, `rejeitarConcorrentes`, pushes); `/match`; contrato (claim atômico antes do e-mail, `valor_acordado = COALESCE(contraproposta, proposto)` nos dois desde 24/08); encerramento manual e `autoEncerrarPendentes` (mesmas colunas: `status`, `status_aprovacao`, `encerrado_em`, limpeza de solicitação; prazos 2d/6h vs 3h/30min **deliberados**); `expirar-match` manual (exceto D75); pedir/perguntar/informar-tempo e responder-tempo aceito; fábrica única de chegada-prevista/chegada/responder; `verificarMarcosExpiracao` (exceto D91); `registrarFalta` (3 faltas/90 dias, uma só função, coluna `tabela`), suspensão, `/admin/suspensos` e `/liberar`; denúncias e avaliações polimórficas por `contrato_tipo`; `lembrarAvaliacaoPendente` (1d/3d, as duas tabelas); `deletarMidiasAntigas` (as duas tabelas de mídia, 7 dias); exclusão de conta (contratos por `candidatura_id` e `interesse_id`, órfãs das duas mídias, match zerado nas duas tabelas); bloqueio global dono→prestador aplicado nos dois feeds (o comentário em index.js:1257 "NÃO afetam o feed ainda" está desatualizado); nenhuma rota de dono checa `tipo_dono` nos dois lados (dono 'reparo' cria obra e vice-versa — o app oferece os dois cadastros).

**Ambos os lados errados, de forma simétrica** (anotado, fora da contagem por não ser assimetria): (a) "tempo extra aceito" soma minutos a `match_feito_em`, mas os crons decidem por `COALESCE(chegada_prevista_em, expira_em)` — o servidor expira o match (e registra falta) no prazo antigo mesmo após o dono aceitar; (b) push de 5 min diz "você pode aumentar o prazo" e `/estender` devolve 409 com match; (c) cancelamento pelo dono não avisa nem fecha propostas pendentes; (d) exclusão de conta do prestador com match ativo não avisa o dono e não zera `chegada_*` (write-once de `/chegada-prevista` trava o próximo profissional); (e) dono pode "recusar" proposta já `'aceito'` sem guarda, deixando match órfão; (f) `expirar-match` manual não reseta `notif_5min_enviada`/marcos; (g) `contratos.status` nunca sai de `'enviado'`; (h) `encerrado_em` não é limpo na reaprovação; (i) `verificarObrasExpirando` cobre as duas tabelas e está desagendado para as duas (server.js:598); (j) broadcast de demanda nova não filtra suspensos, bloqueios nem raio nos dois lados; (k) `/match` sem checagem de suspensão nos dois (D58, já reportado).

---

## O que NÃO foi auditado nesta passagem, e por quê

- **Painel admin em runtime:** conferi só quais rotas o `index.html` chama (POST /obras, DELETE /obras/:id, /candidaturas/:id/aprovar|recusar, GET /obras para abertas). Se o admin realmente passa nos gates de `GET /obras` (D95) e o que o painel faz com a fila de reparos não foi executado — UNVERIFIED.
- **Telas do app além dos greps:** AppNavigator, MinhasObrasScreen, FeedReparosScreen, CadastrarReparoScreen, DetalheObra/ReparoScreen, MensagensScreen e `api.js` foram lidos nos pontos citados; não auditei celebração de match, RetomadaMatchHost em profundidade nem como o cronômetro visível é calculado (relevante para o item simétrico (a)).
- **Rotas sem par:** `POST /obras` (admin), `PUT/DELETE /obras/:id`, `/reparos/:id/abertura`, cron de proximidade — só têm um lado; anotadas onde tocam o painel (D85, D95, D97, D98), não comparadas.
- **Efeito das ALTAs em produção:** todas latentes (0 linhas no estado defeituoso). Não há log de push nem de leitura para responder "já aconteceu" em D74/D81/D87; ficaram como "em toda chamada"/"desconhecido".
- **Entrega real de push/e-mail** (tokens, recibos, Brevo) e **Cloudinary**: sem acesso a logs nesta sessão.
- **Frentes 1 e 2:** achados de dinheiro e de acesso já catalogados (D1–D70) não foram reabertos; onde uma assimetria toca um deles (D58, D9/D27 sobre `valor_acordado`) está referenciado, não duplicado.
- **Correção:** nenhuma. Esta passagem é só levantamento; correções vêm após revisão com o usuário. Em particular D73 é deferido por decisão explícita do dono do projeto.
