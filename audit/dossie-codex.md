# Dossiê — Codex (auditoria externa do ProLar / PinturaPro)

**Data:** 2026-08-25 · **Base de código:** `pinturapro-api` em `main` @ `a71002c` · **Para quem:** um auditor externo (outra IA) sem acesso aos repositórios. Este arquivo dá o contexto; `fontes-codex-parte1.md` a `fontes-codex-parte4.md` trazem o código real, com caminho e número de linha. Tudo que está aqui foi lido do código e de consultas somente-leitura ao banco de produção; nenhum segredo, e-mail, CPF/CNPJ, token ou dado de pessoa real aparece nestes arquivos.

---

## 1. O que é o sistema, em termos simples

Um marketplace brasileiro de serviços residenciais, marca **ProLar** (nome interno do projeto: PinturaPro). Há **dois tipos de demanda** e **dois papéis**, mais um painel de administração:

- **Obra** (pintura / construção civil): o dono descreve a obra, pintores assinantes se candidatam com um valor, o dono escolhe um, os dois "casam" (match), o pintor vai até o local, a obra é executada e encerrada, e os dois se avaliam.
- **Reparo / serviço** (elétrica, hidráulica etc.): mesma coreografia, com prestadores "reparadores", prazos medidos em horas em vez de dias e nomes de tabela/rota diferentes.
- **Dono** (`role = dono_obra`, com `tipo_dono = 'pintura' | 'reparo'`): publica demandas, escolhe propostas, confirma chegada, encerra, avalia. Não paga assinatura.
- **Prestador** (`role = prestador`, com `tipo_prestador = 'pintor' | 'reparador'`): precisa de cadastro verificado (documento + selfie) e de **assinatura ativa** para ver o feed e propor. Pintor só vê obras; reparador só vê reparos.
- **Admin** (`role = admin`; existe também um papel `aprovador` de moderação, sem contas hoje): painel web para aprovar cadastros, aprovar obras, ver métricas, liberar suspensos, encerrar demandas, ligar/desligar a janela de lançamento.

Tudo que é regra existe **duas vezes** (obra × reparo). A Frente 3 da auditoria foi exatamente sobre as assimetrias entre as duas cópias.

## 2. Arquitetura

Três repositórios, um só backend:

| Repo | O que é | Stack | Deploy |
|---|---|---|---|
| `pinturapro-api` | A API REST (toda a regra de negócio) | Node.js + Express 5, `pg` (Postgres), JWT (`jsonwebtoken`), `bcrypt`, `helmet`, `express-rate-limit`, `multer`, Cloudinary (mídia), Expo push (`expo-server-sdk`), e-mail via SMTP/Brevo (`nodemailer`, `sib-api-v3-sdk`), PDF (`pdfkit`), PagBank (checkout + webhook), `speakeasy` (2FA do admin) | Railway, deploy automático a cada push em `main`; URL pública `https://pinturapro-api-production.up.railway.app/api` |
| `pinturapro-app` | App do dono e do prestador | React Native 0.73 / Expo SDK 50, axios; builds via EAS (APK e app-bundle Android); `API_URL` fixa no código | Google Play (aab); atualização exige nova build |
| `painel-admin` | Painel web do administrador | Um `index.html` (JS puro) servido por um Express mínimo com `Cache-Control: no-store`; fala com a mesma API via `Bearer <token>` | Hospedado à parte (URL não confirmada nesta sessão) |

**Onde vive o estado:** um único Postgres (Railway). Não há Redis nem fila. Estado em memória de processo, que NÃO sobrevive a redeploy nem é compartilhado entre réplicas: cache de autenticação/assinatura com TTL de 30 s (`src/middlewares/auth.js`), contadores de visita com flush periódico (`src/utils/visitas.js`), limitadores de taxa e mapa de IPs do upload em stream. Mídia (fotos/vídeos de demanda, documentos de verificação, foto de perfil) fica no Cloudinary — só a URL é guardada no banco.

**Esquema e migrações:** não há ferramenta de migração. `src/routes/index.js` abre com `migracaoPronta`, uma IIFE que roda **em todo boot**, antes de o servidor escutar (`server.js` aguarda a promise e só então chama `app.listen`): `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`, seeds de `configuracoes` e alguns backfills idempotentes. Consequência prática: uma migração que falhe derruba o deploy inteiro (o servidor nunca escuta), e o esquema "de verdade" é o que essa função produz — está integralmente em `fontes-codex` (seção 8).

**Crons:** `setInterval` dentro do processo da API (`server.js`, ~linhas 596–630): cronômetro do match (1 min, reparos e obras), marcos de expiração (1 min), auto-encerramento (5 min), proximidade (10 min, só reparos), baixo engajamento (8 h), expiração de assinaturas (1 h), avisos de vencimento (1 h), lembrete de avaliação (1 h), limpeza de mídias antigas (24 h). Com mais de uma réplica, cada uma roda o seu; os jobs foram escritos com "claim-then-send" (UPDATE … RETURNING como reivindicação) para não duplicar push.

**Segredos e configuração:** só por variável de ambiente. Nomes (sem valores): `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `PAGBANK_TOKEN`, `PAGBANK_ENV`, `WEBHOOK_ENFORCE_SIGNATURE`, `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM`, `EMAILS_ESPECIAIS`, `SUPABASE_*`, `MP_*` (Mercado Pago, legado), `FRONTEND_URL`, `ADMIN_URL`, mais as do Cloudinary e do Brevo. Nenhum valor aparece neste dossiê nem nos fontes.

## 3. Regras de negócio que o auditor precisa conhecer

### 3.1 Cadastro, verificação e papéis
- `POST /auth/cadastro` (`authController.cadastrar`): `tipo_conta` decide o papel — `dono_obra` → dono de pintura, `dono_reparo` → dono de reparo (ambos `role = dono_obra`), `prestador|pintor|construtor` → `role = prestador` com `tipo_prestador`. Prestador nasce com `verificacao_status = 'pendente'` e envia documento (frente/verso) + selfie para o Cloudinary **antes** de logar (rota pública `POST /auth/upload-verificacao`).
- Aprovação manual pelo admin (`POST /verificacao/:id/aprovar`): grava `verificacao_status = 'aprovado'` e põe a assinatura em `'ativa'` (com `proximo_vencimento` via `GREATEST`, ou `NULL` para `tipo = 'gratuito'`), e-mail + push. Reprovar (`/reprovar`) cancela a assinatura e promete estorno via PIX. Existe um **modo automático** (`configuracoes.aprovacao_automatica`) que aprova no cadastro e, ao ser ligado, ativa em lote os pendentes.
- Não existe middleware `exigirVerificado`: a verificação só fecha o acesso indiretamente, porque a assinatura do prestador fica `pendente_verificacao` até a aprovação.
- **Token:** JWT com `{id, role, tv}` (`tv` = `usuarios.token_version`, incrementado ao trocar senha → sessões antigas morrem); validade 7 dias (30 para admin). Admin tem 2FA opcional (TOTP) e um token intermediário de 5 min.
- **Gates** (`src/middlewares/auth.js` + `index.js` ~974–1136): `autenticar` (lê usuário com cache de 30 s), `exigirAssinaturaAtiva` (dono e admin passam; prestador precisa de linha `ativa` não vencida em `assinaturas`), `exigirNaoSuspenso` (`suspenso_em` bloqueia só a **entrada** em trabalho novo), `exigirPintor` / `exigirReparador` (tier estrito; NULL falha fechado; admin/aprovador passam), `exigirAdmin` (admin **ou** aprovador), `exigirSuperAdmin` (só admin — usado em tudo que é destrutivo ou global).

### 3.2 Assinatura e a janela de lançamento (dinheiro)
- Planos, em centavos no código: reparador **R$ 49,90/mês ou R$ 499,00/ano**; pintor (e demais) **R$ 99,90/mês ou R$ 999,00/ano**. Dono não paga (`exigirAssinaturaAtiva` o libera).
- Cobrança pelo PagBank: `POST /pagamentos/criar-assinatura` abre um checkout; `POST /pagamentos/webhook-pagbank` recebe o evento, **verifica a assinatura HMAC por padrão** (`WEBHOOK_ENFORCE_SIGNATURE`), confere o valor pago contra o plano do `reference_id`, registra em `webhook_eventos_pagbank` (o único "livro" financeiro — não há tabela `pagamentos`) e ativa/estende a assinatura. **Em produção nunca houve um pagamento real** (a tabela de eventos está vazia) — todo o fluxo pago é latente.
- **Janela de lançamento** (`configuracoes.lancamento_data_fim`): enquanto ativa, prestador que se cadastra ganha assinatura `tipo = 'gratuito'` com `valor_mensal > 0` (o preço do plano fica registrado) e `proximo_vencimento = NULL`. `GET /config/lancamento` é público (a tela de cadastro consulta antes do login). **Desligar** (`POST /config/lancamento` com `data_fim: null`, só superadmin) é porta de mão única: na mesma transação roda um backfill que dá a essa coorte um vencimento real = **1º dia do mês seguinte, 00:00 America/Sao_Paulo** (`GREATEST` com o vencimento atual, nunca encurta), zera `tipo` e re-arma os avisos. E-mails em `EMAILS_ESPECIAIS` ficam de fora. Hoje ~13 assinaturas estão nessa coorte; é a exposição financeira viva.
- **Acesso grátis permanente**: `POST /pagamentos/acesso-gratuito` (superadmin) grava `valor_mensal = 0`, `tipo = 'gratuito'` — nunca entra no backfill.
- **Expiração**: cron horário põe `status = 'expirada'` quando `proximo_vencimento < NOW()`, invalida o cache e avisa; três avisos antes (24 h / 12 h / 6 h) com bandas disjuntas.
- **Renovação** de prestador: não existe fluxo de renovação de fato (achado D5, aberto).

### 3.3 Ciclo de vida de uma demanda (obra e reparo)
Estados de `obras`/`reparos`: `status ∈ {rascunho, aberta, encerrada, cancelada}` e `status_aprovacao ∈ {pendente, aprovada, recusada, encerrada, cancelada}`. "Expirada" **não** é status: é `status <> 'encerrada' AND expira_em <= NOW()`, calculada nas leituras; nenhum cron muda o status de uma demanda vencida — ela some do feed (`expira_em > NOW()`) e o dono pode estender.

1. **Criação** (`POST /obras/dono`, `POST /reparos/dono`): limite de demandas vivas por dono (`configuracoes.limite_demandas_live_sem_historico`, contando obras + reparos juntos), geocodificação por cidade/UF, idempotência por `(criado_por, client_request_id)`. Prazo: `horas_para_expirar` (obra) / `prazo_atendimento_horas` (reparo), default 720 h; `expira_em = agora + prazo`. Faixa **"Hoje"** (`prazo_modo = 'hoje'`): `expira_em` = fim do dia na zona do dono (`prazo_timezone`, validada contra `pg_timezone_names`, fallback São Paulo). **Obra nasce `rascunho`/`pendente` e só publica na aprovação; reparo nasce `aberta`/`aprovada`** (publica na criação).
2. **Aprovação de obra** (admin ou flag `aprovacao_automatica_obras`): `aprovarEPublicarObra` grava `publicado_em = NOW()` e **reinicia** `expira_em`, avisa dono e pintores da cidade. A fila de reparo existe (`/reparos/aprovacao/*`) mas nada grava `pendente` em reparo — só age em reparo recusado.
3. **Feed** (`GET /obras` para pintor, `GET /reparos` para reparador): aberta + aprovada + não vencida + sem match + não bloqueado (por demanda `prestadores_bloqueados` e global `prestadores_bloqueados_dono`) + não recusado antes; filtros por categoria, cidade, raio, estado. Broadcast de push para prestadores assinantes da mesma cidade/UF na publicação.
4. **Proposta** (`POST /obras/:id/candidatura` → `candidaturas`; `POST /reparos/:id/interesse` → `interesse_reparos`): `valor_proposto` + `mensagem`, status `pendente`; uma por prestador por demanda (índice único). Nenhum caminho valida se a demanda está vencida (D28, aberto).
5. **Negociação**: dono responde (`aceitar | recusar | contraproposta` com `valor_contraproposta`, status `contraproposta_dono`); prestador responde (`aceitar | recusar | contraproposta` — volta a `pendente` com novo `valor_proposto`). Guardas: só demanda `aberta` e sem match (`obraAbertaParaNegociar`); só proposta `pendente`; candidato suspenso não pode ser aceito. Sem teto de rodadas.
6. **Match**: o aceite (de qualquer lado) grava `status = 'aceito'` na proposta e `match_usuario_id` + `match_feito_em` na demanda (`WHERE match_usuario_id IS NULL`), índices únicos parciais garantem **um só aceito por demanda**; dispara o contrato por e-mail (PDF) com `valor_acordado = COALESCE(contraproposta, proposto)` gravado em `contratos` (claim atômico `ON CONFLICT`), e recusa os concorrentes com push (`rejeitarConcorrentes`). `POST /:id/match` é o caminho legado em que o próprio prestador confirma um aceito.
7. **Chegada** (fábrica única para as duas tabelas): o prestador escolhe uma **janela** (`hoje 23:59`, `amanhã 12:00`, `amanhã 18:00`, zona SP, piso agora + 1 h) → `chegada_prevista_em` (write-once; se estoura `expira_em`, fica `pendente` até o dono aceitar, e o aceite estica `expira_em`); declara chegada (`chegada_declarada_por/em`); o dono confirma (`chegada_confirmada_em`) ou o auto-encerramento confirma sozinho após 6 h (obra) / 30 min (reparo).
8. **Cronômetro do match** (cron 1 min): prazo pós-match = `COALESCE(chegada_prevista_em, expira_em)`; a 5 min do fim avisa o dono (uma vez); ao zerar, **desfaz o match** (demanda volta ao feed com prazo novo = `agora + janela original`, marcos re-armados, `pedido_tempo_*` e `chegada_*` zerados), põe o prestador em `prestadores_bloqueados` daquela demanda, expira a proposta `aceito`, avisa os dois e **registra falta** — exceto se a janela foi recusada/ignorada pelo dono (isenção). Chegada declarada/confirmada congela o cronômetro.
9. **Pedido de tempo**: prestador pede (`aguardando_tempo` → dono pergunta quantos minutos → prestador informa → `aguardando_aprovacao`); dono aceita (`match_feito_em += minutos`; **o cron não lê `match_feito_em`, então isso não move o prazo do servidor** — anotado como simétrico nos dois lados) ou recusa (un-match igual ao cronômetro, sem falta).
10. **Desfazer manualmente** (`POST /:id/expirar-match`): dono, prestador do match ou admin; barrado após chegada declarada/confirmada, exceto o dono contestando uma declaração que não é dele; mesmo efeito do cron, sem falta.
11. **Encerramento** (`POST /:id/encerrar`): com match, exige chegada declarada (admin dispensa); dono e admin fecham na hora; o prestador só **solicita** (`encerramento_solicitado_por/em`) e o auto-encerramento fecha sozinho após **2 dias (obra) / 3 horas (reparo)** se o dono não responder. Grava `status = 'encerrada'`, `status_aprovacao = 'encerrada'`, `encerrado_em`. Cancelamento pelo dono (`DELETE /…/dono/:id`) só sem match (409 com profissional a caminho). Admin fecha pelo painel (`DELETE /obras/:id`; reparo só por `POST /reparos/:id/encerrar`, sem botão no painel).
12. **Avaliação** (`POST /avaliacoes`, por `contrato_tipo` + `contrato_id`): estrelas de um lado para o outro após encerrar; lembretes em 1 d / 3 d; `aval_dispensada_em`. **Denúncia** (`POST /denuncias`) entre as partes de um match; **bloqueio** global dono→prestador.
13. **Extensão de prazo** (`POST /:id/estender`): só dono, demanda `aberta` e sem match, 1–8760 h, dedupe de 5 min; **carência de 1 h após a publicação para faixa longa (> 24 h ou janela NULL)** nos dois lados; faixa "Hoje" estende por dias inteiros no fim do dia da zona; `extensao_maxima_horas` = 8760 − horas já empurradas além do vencimento original; `pode_estender_em` diz quando a carência libera. Marcos de expiração (`faixasPrazo.FAIXAS`: janelas 1/2/4/8/24/168 h com três avisos proporcionais) são re-armados.

### 3.4 Faltas e suspensão
`registrarFalta` (só pelos dois crons de cronômetro) insere em `faltas_profissional (usuario_id, tabela, demanda_id)`; **3 faltas não perdoadas em 90 dias → `usuarios.suspenso_em`** + push. Suspenso não entra em feed, proximidade, proposta nem aceite novo; o que já está em andamento segue. Admin lista (`GET /admin/suspensos`) e libera (`POST /admin/suspensos/:id/liberar`, perdoa as faltas). Nenhum caminho manual (expirar-match, recusar tempo, encerrar) gera falta, por desenho.

### 3.5 Mídia e leitura
Fotos/vídeos por demanda em `midias` (obra) / `midias_reparos` (reparo), com fila de órfãs e limpeza 7 dias após encerramento/cancelamento. Documentos de verificação no Cloudinary com URL de leitura assinada (passo 1 do D62). Endereço exato, ponto de referência e contato do outro lado só são revelados **após o match** (bairro e coordenadas saem antes, para distância).

## 4. O que já foi auditado e o que foi feito

Três passagens internas, todas somente-leitura no momento da auditoria, com evidência de ocorrência lida do banco de produção. Os arquivos completos (`audit/frente1-dinheiro.md`, `audit/frente2-acesso.md`, `audit/frente3-consistencia.md`) estão nas branches `audit/frente1-dinheiro`, `audit/frente2-acesso` e `audit/frente3-consistencia` do repositório da API; cada achado tem "o que quebra / onde / como se chega / já aconteceu? / risco". **98 achados, D1–D98.**

### 4.1 Frente 1 — Dinheiro (2026-08-24, D1–D45: 9 alta, 20 média, 16 baixa)
Escopo: assinaturas, PagBank, janela de lançamento, propostas/valor acordado, contrato. Evidência-chave: **zero pagamentos reais processados**; a exposição viva é a coorte grátis do lançamento.

| Achado | Estado |
|---|---|
| D1 webhook aceitava eventos não assinados; D2 plano vinha do `reference_id` sem conferir valor pago | **Corrigidos** (`6825cf3`): assinatura HMAC exigida por padrão, valor validado contra o plano |
| D7 backfill do lançamento podia encurtar vencimento | **Corrigido** (`b4bc8ac` + `fbbe6bd`): `GREATEST`, alvo = 1º dia do mês seguinte |
| D8 aceitar/contrapropor sem guarda de estado | **Corrigido** (`219e851`): só demanda aberta e sem match, só proposta pendente — obra e reparo |
| D9 contrato com valor errado; D27 valor NULL inconsistente no PDF | **Corrigidos** (`30e4bdb`, `68bfd69`): valor acordado congelado em `contratos.valor_acordado` |
| D10 `exigirAdmin` admite `aprovador` em rotas de dinheiro | **Corrigido** (`dfae12c`): lançamento e acesso grátis viraram `exigirSuperAdmin` |
| D13 contrato de reparo duplicável | **Corrigido** (`e3ab5d8`, via D79): índice único parcial em `contratos.interesse_id` + `ON CONFLICT` |
| D3, D4, D5, D6, D14, D16, D17, D22, D23, D24, D32, D33, D34, D44 (PagBank: segundo checkout, ativação após o 200, renovação inexistente, tempo comprado não registrado, estorno só logado, janela × `role='assinante'`, `lancamento_data_fim` ignorado no checkout…) | **Abertos, deliberadamente**: todo o fluxo pago é latente (nenhum pagamento real ainda); o dono decidiu redesenhar cobrança/renovação como um bloco, não remendar |
| D11, D31 (aprovar verificação sem guarda / replay reenvia e-mail) | **Abertos** (baixo impacto: só admin aciona) |
| D12, D15, D18, D19, D20, D21, D25, D26, D28, D29, D30, D35–D43, D45 | **Abertos**: validações de valor, TOCTOU de config, renegociação bloqueada após recusa (decisão de produto pendente), proposta em demanda vencida (D28), colisões/cosméticos |

### 4.2 Frente 2 — Acesso e autorização (2026-08-24, D46–D70: 7 alta, 10 média, 8 baixa)
Escopo: gates de papel, ownership, suspensos/não verificados, painel, token, uploads. Evidência-chave: painel realmente protegido no servidor; nenhum furo de ownership; **zero contas `aprovador`** (os "aprovador alcança X" são latentes); admin único sem 2FA ativo.

| Achado | Estado |
|---|---|
| D46–D50, D53–D55, D63, D65 (ações destrutivas/globais com `exigirAdmin`) | **Corrigidos** (`5619c98`): passaram a `exigirSuperAdmin` |
| D51 sem revogação de token | **Corrigido** (`3074dbe`): `token_version` no JWT, incrementado na troca/reset de senha |
| D52 `/candidaturas` sem `exigirNaoSuspenso` (+ `exigirPintor`) | **Corrigido** (`a2ec9ac`, `02746e9`) |
| D58 `/match` e `prestador-responder` exigindo assinatura para concluir negócio já em andamento | **Ajustados** (`af6aa0b`, `0ee0be6`): exigem só o tier; releitura de suspensão continua ausente (aberto) |
| D61 escopo da assinatura Cloudinary | **Corrigido** (`0af6b7c`): formato e tamanho presos |
| D62 PII de verificação pública no Cloudinary | **Parcial** (`e270ce4`): leitura por URL assinada; o asset ainda é público na origem (passo 2 pendente) |
| D56, D57 (cache de 30 s entre réplicas), D59 (sem `exigirVerificado`), D60, D64, D66–D70 (upload público sem throttle, URL arbitrária, abertura sem gate…) | **Abertos**: multi-réplica é hipótese (o número de réplicas na Railway não foi confirmado), verificação fecha via assinatura, Cloudinary depende de config da conta |

### 4.3 Frente 3 — Consistência dos dois lados (2026-08-25, D71–D98: 3 alta, 15 média, 10 baixa)
Escopo: obra × reparo em ciclo de vida, notificações, timers, lado do dono, penalidades e dados gravados. Evidência-chave: as três ALTAs eram latentes (dado ainda não tinha caído no furo); D74, D81 e D84 valiam ao vivo.

| Achado | Estado |
|---|---|
| D71 recusar tempo extra no reparo não expirava o interesse aceito (serviço travado) | **Corrigido** (`5d2d312`) |
| D72 dono cancelava obra com pintor a caminho | **Corrigido** (`4b816ea`): 409 como no reparo |
| D73 cron de reparos ignorava `prazo_atendimento_horas` NULL | **Corrigido** (`01c33f0`): `COALESCE(…, 720)`; era defesa em profundidade (0 linhas NULL) |
| D74 dono com assinatura lia obra alheia | **Corrigido** (`bb2cd68`): exige `role = prestador` fora de dono/match/admin |
| D75, D76 `pedido_tempo_*` não zerado no un-match (um lado cada) | **Corrigidos** (`5d2d312`) |
| D77 fila de aprovação de reparo esqueleto | **Corrigido** (`5566385`): relógio via `GREATEST`, push ao dono, recusa idempotente — defesa em profundidade (nada grava `pendente`) |
| D78 faixa "Hoje" do reparo em SP fixo | **Corrigido** (`d624f39`): `reparos.prazo_timezone` — dormente (app não envia `prazo_modo` para reparo) |
| D79 claim do contrato de reparo sem índice único | **Corrigido** (`e3ab5d8`) |
| D80 feed de reparos expunha colunas internas (lista negra, ids) | **Corrigido** (`bb2cd68`) |
| D81 feed omitia `prazo_atendimento_horas` (faixa de urgência nunca aparecia) | **Corrigido** (`949e6a0`) |
| D82, D83 rotas legadas de candidatura frouxas / colunas mortas | **Corrigidos** (`e3ab5d8`) |
| D84 dashboard só contava candidaturas | **Corrigido** (`949e6a0`): `interesses_pendentes` e `propostas_pendentes`; o painel ainda não renderiza o lado reparo |
| D85 `DELETE /obras/:id` incompleto; D87 broadcast × gate | **Corrigidos** (`5c2ec9d`); reparo continua sem botão de encerrar no painel (a API já tem) |
| D86 cadência 8 h × 24 h | **Corrigido** (`d624f39`): 24 h nos dois |
| D89 carência de estender só no reparo | **Corrigido** (`8c3061c`): 1 h nos dois lados + regra única de `extensao_maxima_horas` |
| D88 canal de mensagens só para obra (e aba morta no app) | **Aberto — decisão de produto** |
| D90–D98 (5 min sem filtro de status, marcos sem `status_aprovacao`, forma de listas, colunas mortas, upload legado, filtros do painel, badge só no reparo, `obra_proxima` morto, `POST /obras` do painel com push morto) | **Abertos — baixa**: cosméticos ou código legado que o painel/app ainda toca |

**Padrão de correção usado nas três frentes:** uma branch por achado, mudança mínima espelhando o lado já correto, verificação em `BEGIN … ROLLBACK` contra a base de produção com estado sintético, merge `--no-ff`, deploy verificado (uptime + rota).

## 5. Perguntas para o olhar externo

O que um leitor de primeira viagem vê e o autor não. Priorize estas:

1. **Máquina de estados.** Com `status` × `status_aprovacao` × `match_usuario_id` × `chegada_*` × `encerramento_solicitado_*` × `expira_em`, quais combinações são alcançáveis e não tratadas? Há transições que deixam a linha num estado que nenhuma rota nem cron consegue tirar dali? (As frentes 1–3 acharam vários; provavelmente há mais.)
2. **Concorrência sem transação.** Quase todo handler faz SELECT → decide em JS → UPDATE, sem `BEGIN`, confiando em índices únicos parciais e em `WHERE match_usuario_id IS NULL`. Onde isso ainda deixa "lost update" ou dupla ação (dois aceites, dois encerramentos, dois contratos, duas faltas)?
3. **O cron e as rotas competem pela mesma linha.** `verificarCronometro*`, `autoEncerrarPendentes`, `expirar-match`, `responder-tempo` e `chegada` escrevem as mesmas colunas. Que intercalações produzem push errado, bloqueio indevido ou falta injusta?
4. **A isenção de falta e a lista negra.** `prestadores_bloqueados` é por demanda e nunca expira; a isenção depende de `chegada_recusada_em`/`chegada_pendente_em`. É justa? É burlável (o prestador escolhe uma janela que o dono vai recusar)?
5. **Dinheiro que ainda não rodou.** O webhook do PagBank nunca processou um evento real. Lendo `pagamentoController.js` a frio: o que quebra na primeira cobrança de verdade (ordem 200 → ativação, idempotência, plano anual, renovação, estorno)?
6. **A porta de mão única do lançamento.** O desligamento faz backfill em transação. Há forma de a coorte grátis escapar (cadastro durante o desligamento, `EMAILS_ESPECIAIS` mal formatado, assinatura duplicada por usuário)?
7. **Cache de 30 s e réplicas.** Suspensão, deleção e expiração de assinatura invalidam só o processo local. Se a Railway subir duas réplicas, o que fica errado por até 30 s e o que fica errado para sempre (rate limit, mapa de IPs, contadores)?
8. **Migração no boot.** A IIFE roda `ALTER`/`CREATE INDEX` em produção a cada deploy, sem lock explícito e sem versão. Há alguma instrução que não seja idempotente, que trave a tabela sob carga, ou cuja falha derrube o serviço sem rollback?
9. **Timezone.** Faixa "Hoje" resolve na zona do dono, janelas de chegada resolvem em São Paulo, backfill do lançamento em São Paulo, o resto em UTC. Onde um dono fora de UTC-3 vê o dia errado?
10. **Superfície de leitura.** Fotos, coordenadas e propostas de qualquer demanda saem para qualquer prestador assinante do tier certo; endereço/contato só após o match. É o recorte certo? Algo mais vaza (nomes de candidatos concorrentes, valores propostos por outros, avaliações)?
11. **Rotas legadas ainda vivas.** `POST /candidaturas`, `/candidaturas/:id/aprovar|recusar`, `POST /obras` (admin), `/upload/dono`, `/upload/reparo`, `contratoService.gerarEEnviarContrato` (morto). Qual delas ainda pode produzir um estado que as rotas principais não sabem ler?
12. **O app e o painel confiam na API certa?** `API_URL` fixa no app; painel com token Bearer em `localStorage`; nenhum versionamento de API. O que uma build antiga do app faz com respostas novas (campos removidos do feed em D80, `pode_estender_em`, `propostas_pendentes`)?
13. **Denúncia, avaliação e bloqueio** validam participação pelo `match_usuario_id` atual da demanda, não pelo contrato histórico. Depois de um un-match e um novo match, quem consegue avaliar/denunciar quem?
14. **Exclusão de conta** (`DELETE /conta/excluir`) anula matches e apaga propostas, mas não avisa a outra parte nem limpa `chegada_*`. Que estados sobram para o dono cuja obra estava com um pintor que apagou a conta?

## 6. Deliberadamente fora de escopo

- **Front-ends** (`pinturapro-app`, `painel-admin`): só foram consultados para saber que rotas/campos usam; a autorização que importa é a do servidor. UX, navegação e o código do app não estão nos fontes.
- **Infra e contas externas:** configuração do Railway (réplicas, variáveis), da conta Cloudinary (entrega assinada, allowlist), do PagBank (sandbox × produção), do SMTP/Brevo e do Expo. Tudo que depende disso está marcado UNVERIFIED nas frentes.
- **Dados reais:** contagens agregadas de produção aparecem nas frentes; ids, e-mails, CPF/CNPJ, telefones, tokens e o `.env` foram excluídos deste dossiê e dos fontes.
- **Fluxo pago de ponta a ponta** (D3–D6, D14–D24): o dono decidiu redesenhá-lo antes de a primeira cobrança acontecer; críticas são bem-vindas, correções pontuais não.
- **Frente 4 (desempenho/custo)** ainda não foi feita: N+1, índices faltantes, `SELECT *` nas listagens, `express.json` com limite de 100 MB.

## 7. Como ler os fontes

`fontes-codex-parte1.md` … `parte4.md` (4 partes, cada uma abaixo de 150 KB para caber como anexo): cada bloco é `caminho:linha-inicial-linha-final — título`, com o código real e o número de linha prefixado em cada linha. As seções seguem a ordem deste dossiê: 1 gates · 2 dinheiro · 3 verificação/aprovação · 4 obra · 5 reparo (compare bloco a bloco com a 4) · 6 compartilhado · 7 crons · 8 migração de boot. Comentários foram preservados de propósito: em muitos pontos eles registram o racional de uma regra e o bug que ela fechou — o auditor pode (e deve) discordar deles.
