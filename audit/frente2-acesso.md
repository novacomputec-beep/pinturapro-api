# Auditoria — Frente 2: Acesso e Autorização

**Data:** 2026-08-24
**Escopo:** Controle de acesso de toda a API: gates de papel (role) em endpoints que mudam estado, verificação de propriedade (ownership) em ações por id, o que contas suspensas/não-verificadas ainda conseguem fazer, o gate do painel admin, ciclo de vida de token/sessão (expiração, refresh, revogação), e uploads/leitura de mídia (incluindo caminhos não autenticados).
**Método:** Leitura de código (`src/routes/index.js` ~6300 linhas, `src/controllers/*`, `src/middlewares/auth.js`, `src/services/*`, `server.js`) mais consultas **somente-leitura** ao Postgres de produção para confirmar ocorrência. Nada foi modificado, nenhuma escrita no banco.
**Relação com a auditoria de 12/08/2026:** aquela passagem encontrou dois furos em rotas de mensagens; **ambos foram reverificados e continuam fechados** (ver abaixo). Esta passagem foca no que não foi coberto e no código que mudou desde então. Numeração de achados continua de D46 (Frente 1 foi até D45).

## Evidência decisiva de ocorrência (lida de produção, somente-leitura)

- **Distribuição de papéis:** 13 `prestador`, 6 `dono_obra`, **1 `admin`, ZERO `aprovador`**. Todos os achados de "o papel `aprovador` alcança ação destrutiva/global" são portanto **LATENTES**: são excesso de privilégio real no código, mas não exploráveis hoje porque nenhuma conta `aprovador` existe. No instante em que uma for criada — que é o propósito do papel — passam a valer. Não há usuários suspensos no momento (0 com `suspenso_em`).
- **O único admin NÃO tem 2FA ativo** (`dois_fa_ativo = false`). Combinado com a ausência total de revogação de token (D51), o único token privilegiado da plataforma não tem segundo fator nem como ser morto antes da expiração natural (30 dias).
- **Modelo de papéis (auth.js):** `exigirAdmin` (auth.js:156) admite `admin` E `aprovador`; `exigirSuperAdmin` (auth.js:163) admite só `admin`. O TTL do cache de autenticação é **30s** (auth.js:12) — vários comentários no código ainda dizem "5 min" e estão desatualizados. Não existe middleware `exigirVerificado` em lugar nenhum.
- **Furos de mensagens de 12/08 — ambos ainda FECHADOS:** `POST /mensagens` (`enviar`) exige que o remetente seja `obra.criado_por` ou tenha candidatura na obra (mensagensController.js:26-34); `GET /mensagens/obra/:obra_id` (`porObra`) usa por padrão o ramo restrito `WHERE m.autor_id = req.usuario.id`, só `admin` vê a thread inteira (mensagensController.js:85-105).
- **Painel:** todo endpoint de painel/admin carrega `exigirAdmin` (ou mais estrito), enforçado no servidor; `role` é embutido do banco na emissão do token, não dá para auto-escalar. Nenhum endpoint de dado de painel é alcançável por token não-admin — a única ressalva é o escopo `aprovador` acima. **Parte 4 (painel): verificada, sem furo.**
- **Ownership:** toda mutação por `:id` que tracei restringe a escrita ao chamador (`criado_por`/`match_usuario_id`/`usuario_id`/admin). **Nenhum furo novo de ownership.** Parte 2: verificada, sem furo.

## Resumo para quem não programa

O controle de quem-pode-o-quê está, no geral, correto: o painel é protegido de verdade no servidor (não só escondido na tela), ninguém consegue mexer no cadastro de outra pessoa pelo id, e os dois furos de mensagens da auditoria anterior seguem tapados. Os problemas desta passagem são de dois tipos. Primeiro, um papel de moderação chamado "aprovador" tem, no código, poder para APAGAR usuários e zerar tabelas inteiras — coisas que deveriam ser exclusivas do administrador; hoje isso não faz mal porque não existe nenhuma conta "aprovador", mas no dia em que criarem uma, ela nasce com um poder perigoso. Segundo, e mais sério porque vale HOJE: quando alguém troca a senha, some da conta ou é suspenso, o "crachá" digital (token) que já estava emitido continua valendo — não há como cancelá-lo antes de ele expirar sozinho (7 dias para usuário comum, 30 dias para o admin). Como o único admin também não usa a verificação em duas etapas, se o token dele vazar, o invasor tem acesso total por até 30 dias sem nada que o interrompa. Há ainda contas suspensas que conseguem pegar trabalho novo por uma brecha, e alguns caminhos de upload de arquivo abertos sem login. Nada disso foi corrigido — este documento só cataloga.

**Contagem:** 25 achados — 7 ALTA, 10 MÉDIA, 8 BAIXA. Ordenados por severidade e, dentro de cada nível, por raio de alcance. Numerados D46–D70.

---

## ALTA

### D46. [ALTA] DELETE /usuarios/:id apaga qualquer usuário não-admin com só exigirAdmin
- **O que quebra:** Um `aprovador` (papel de moderação) pode deletar qualquer dono/prestador, cascateando todas as obras/reparos/mensagens/candidaturas/interesses dele. Irreversível. Só um alvo `admin` é barrado (index.js:1355).
- **Onde:** src/routes/index.js:1347 (gate `exigirAdmin`)
- **Como se chega:** Token com role `aprovador` chama DELETE /usuarios/<id-da-vítima>. Deveria ser `exigirSuperAdmin` — a comparação é a própria `DELETE /admin/sugestoes` (index.js:6079), a deleção MENOS destrutiva do arquivo, que é a única corretamente super-admin.
- **Já aconteceu?:** Não. Nenhuma conta `aprovador` existe hoje (latente).
- **Risco se não corrigir:** Um moderador (ou um token de moderador vazado) apaga usuários e todo o histórico deles.

### D47. [ALTA] POST /admin/limpar-usuarios zera todos os usuários não-admin com só exigirAdmin
- **O que quebra:** Apaga todos os usuários não-admin e cascateia tudo. Um `aprovador` alcança.
- **Onde:** src/routes/index.js:5772 (gate `exigirAdmin`)
- **Como se chega:** Token `aprovador` chama a rota. Deveria ser `exigirSuperAdmin`.
- **Já aconteceu?:** Não (latente, sem `aprovador`).
- **Risco se não corrigir:** Destruição em massa da base por um papel que não deveria ter esse poder.

### D48. [ALTA] POST /admin/limpar-testes zera todos os dados não-admin com só exigirAdmin
- **O que quebra:** Wipe de usuarios, obras, reparos, candidaturas, interesses, assinaturas, faltas etc. (tudo que não é admin).
- **Onde:** src/routes/index.js:4682 (gate `exigirAdmin`)
- **Como se chega:** Token `aprovador`. Deveria ser `exigirSuperAdmin`.
- **Já aconteceu?:** Não (latente).
- **Risco se não corrigir:** Um moderador limpa a plataforma inteira.

### D49. [ALTA] POST /admin/limpar-obras trunca obras+candidaturas+midias com só exigirAdmin
- **O que quebra:** Truncamento de obras, candidaturas e mídias.
- **Onde:** src/routes/index.js:6221 (gate `exigirAdmin`)
- **Como se chega:** Token `aprovador`. Deveria ser `exigirSuperAdmin`.
- **Já aconteceu?:** Não (latente).
- **Risco se não corrigir:** Perda em massa de obras e propostas.

### D50. [ALTA] POST /admin/limpar-reparos trunca reparos+interesse+contratos com só exigirAdmin
- **O que quebra:** Truncamento de reparos, interesse_reparos e contratos.
- **Onde:** src/routes/index.js:6239 (gate `exigirAdmin`)
- **Como se chega:** Token `aprovador`. Deveria ser `exigirSuperAdmin`.
- **Já aconteceu?:** Não (latente).
- **Risco se não corrigir:** Perda em massa de reparos e do livro de contratos.

### D51. [ALTA] Nenhuma revogação de token; troca de senha não invalida sessões
- **O que quebra:** Não existe token-version, `passwordChangedAt`, denylist nem refresh. Trocar a senha só faz `UPDATE senha_hash`; um token já emitido (inclusive roubado) continua válido até a expiração natural — 7 dias para usuário comum, 30 dias para admin. Deletar/suspender a conta só barra na expiração do cache de 30s (ver D56/D57), não mata o token.
- **Onde:** src/controllers/authController.js:16-20 (gerarToken, sem versão), :482 (alterarSenha só troca hash); src/routes/index.js:6291 (trocar-senha admin); src/middlewares/auth.js:72-108 (autenticar não checa versão)
- **Como se chega:** Qualquer JWT previamente emitido segue aceito após troca de senha; nada o cancela.
- **Já aconteceu?:** Desconhecido — sem denylist não há registro do que foi revogado. Vale HOJE (não é latente).
- **Risco se não corrigir:** Token vazado do único admin (que não tem 2FA) dá acesso total por até 30 dias, sem botão de pânico. Trocar a senha não protege contra sessão comprometida.

### D52. [ALTA] POST /candidaturas não tem exigirNaoSuspenso — suspenso pega trabalho novo
- **O que quebra:** A rota gêmea `/obras/:id/candidatura` (index.js:2279) exige `exigirNaoSuspenso`, mas `/candidaturas` insere uma candidatura equivalente só com `exigirAssinaturaAtiva` — um pintor suspenso registra proposta de trabalho novo por ela.
- **Onde:** src/routes/index.js:5249 (falta `exigirNaoSuspenso`)
- **Como se chega:** Pintor suspenso por faltas chama POST /candidaturas em vez de /obras/:id/candidatura.
- **Já aconteceu?:** Não confirmável; 0 usuários suspensos hoje.
- **Risco se não corrigir:** A suspensão por faltas — que existe para tirar mau prestador do fluxo — é contornável por uma rota irmã.

---

## MÉDIA

### D53. [MÉDIA] POST /admin/limpar-mensagens trunca a tabela mensagens com só exigirAdmin
- **O que quebra:** Truncamento de toda a tabela de mensagens.
- **Onde:** src/routes/index.js:6264 (gate `exigirAdmin`)
- **Como se chega:** Token `aprovador`. Deveria ser `exigirSuperAdmin`.
- **Já aconteceu?:** Não (latente).
- **Risco se não corrigir:** Perda de todo o histórico de dúvidas/conversas por um moderador.

### D54. [MÉDIA] POST /verificacao/modo-automatico — aprovador aciona flag global + ativação de assinaturas em massa
- **O que quebra:** Liga/desliga um flag GLOBAL e, ao ligar, ativa em lote as assinaturas pagas de todos os prestadores pendentes (estado financeiro em massa) — delegado a um moderador.
- **Onde:** src/routes/index.js:4935 (gate `exigirAdmin`)
- **Como se chega:** Token `aprovador`. Deveria ser `exigirSuperAdmin`.
- **Já aconteceu?:** Não (latente).
- **Risco se não corrigir:** Moderador altera regra global e concede acesso pago em massa.

### D55. [MÉDIA] POST /obras-aprovacao/modo-automatico — aprovador aciona flag global de auto-aprovação de obras
- **O que quebra:** Liga/desliga o flag global que publica obras do dono sem revisão.
- **Onde:** src/routes/index.js:5001 (gate `exigirAdmin`)
- **Como se chega:** Token `aprovador`. Deveria ser `exigirSuperAdmin`.
- **Já aconteceu?:** Não (latente).
- **Risco se não corrigir:** Moderador desliga a revisão manual de obras da plataforma inteira.

### D56. [MÉDIA] Token de conta DELETADA funciona por até 30s nas outras réplicas
- **O que quebra:** `autenticar` devolve 401 só quando realmente consulta o banco; `getCacheUsuario` serve a linha cacheada por até 30s. Os dois caminhos de deleção chamam `invalidarCachesUsuario`, mas isso limpa só o processo local — em outra réplica a conta deletada segue autenticando até o TTL.
- **Onde:** src/middlewares/auth.js:14-22,86-97; invalidação local em src/routes/index.js:1443,1574
- **Como se chega:** Conta é deletada numa réplica; requisições com o token antigo caem noutra réplica por até 30s.
- **Já aconteceu?:** Desconhecido (janela curta, não deixa rastro).
- **Risco se não corrigir:** Janela de 30s de acesso pós-deleção por réplica.

### D57. [MÉDIA] Usuário recém-SUSPENSO mantém acesso a rotas com middleware por até 30s nas outras réplicas
- **O que quebra:** `exigirNaoSuspenso` lê `suspenso_em` do `req.usuario` cacheado (30s). O cron de suspensão seta `suspenso_em` e invalida o cache só do processo que rodou — nas outras réplicas o suspenso passa nos feeds/proximidade/candidatura por até 30s. Os aceites, que leem `suspenso_em` fresco do banco, barram na hora.
- **Onde:** src/middlewares/auth.js:12,147-150; cron em src/services/alertaService.js:588-598
- **Como se chega:** Suspensão aplicada; token do suspenso cai noutra réplica dentro da janela.
- **Já aconteceu?:** Desconhecido; 0 suspensos hoje.
- **Risco se não corrigir:** Suspensão demora até 30s para valer em ambiente multi-réplica.

### D58. [MÉDIA] /obras/:id/match e /reparos/:id/match não têm gate nem releitura de suspensão
- **O que quebra:** Nenhum dos dois carrega `exigirNaoSuspenso` nem relê `suspenso_em` do banco. Um prestador suspenso DEPOIS do aceite ainda confirma o match e dispara o contrato.
- **Onde:** src/routes/index.js:2487 (obras), 3495 (reparos)
- **Como se chega:** Prestador é suspenso após ser aceito e chama /match.
- **Já aconteceu?:** Desconhecido; 0 suspensos hoje.
- **Risco se não corrigir:** Suspensão não impede o suspenso de fechar o negócio já em andamento.

### D59. [MÉDIA] Não há exigirVerificado — prestador pendente alcança uploads/GPS/criação de demanda
- **O que quebra:** A verificação de identidade é enforçada só INDIRETAMENTE, pela assinatura estar `pendente_verificacao` (não `ativa`), o que incidentalmente barra candidatura/interesse/aceite/mensagem. Todo endpoint só-`autenticar` segue aberto a uma conta pendente: uploads, `/prestadores/localizacao`, criação de demanda como dono, leitura de detalhe/threads.
- **Onde:** src/routes/index.js:4503,4587,4610,4640,5244,5220,1764,2905 (só `autenticar`); ausência de middleware de verificação (grep vazio)
- **Como se chega:** Prestador com verificação pendente usa qualquer rota só-`autenticar`.
- **Já aconteceu?:** Desconhecido — comportamento por desenho da ausência do gate.
- **Risco se não corrigir:** A proteção de "só verificado age" é acidental (depende do estado da assinatura), não uma checagem real; muda se o acoplamento assinatura↔verificação mudar.

### D60. [MÉDIA] Gerador de assinatura Cloudinary SEM autenticação
- **O que quebra:** `GET /upload/assinatura-publica` não tem `autenticar` — qualquer um obtém uma assinatura válida para empurrar arquivos para `pinturapro/verificacao`. Só um limite de 60/h por IP (server.js:157) freia.
- **Onde:** src/routes/index.js:4570
- **Como se chega:** Requisição anônima ao endpoint devolve a assinatura; o cliente sobe arquivos assinados direto no Cloudinary.
- **Já aconteceu?:** Desconhecido — não auditei o conteúdo do bucket.
- **Risco se não corrigir:** Abuso de armazenamento/CDN e hospedagem de conteúdo arbitrário sob a conta do projeto.

### D61. [MÉDIA] Escopo da assinatura Cloudinary é irrestrito
- **O que quebra:** `gerarAssinaturaCloudinary` assina só `{timestamp, folder}` — o upload assinado não tem limite de tamanho, tipo, `resource_type` nem `public_id`. Qualquer tipo/tamanho de arquivo passa.
- **Onde:** src/services/uploadService.js:61-66 (usado por /upload/assinatura-publica:4570 e /upload/assinatura-cloudinary:4596)
- **Como se chega:** Com a assinatura (autenticada ou não, D60), sobe-se arquivo arbitrário.
- **Já aconteceu?:** Desconhecido.
- **Risco se não corrigir:** Abuso de armazenamento e hospedagem de arquivos arbitrários.

### D62. [MÉDIA] PII de verificação (documento + selfie) armazenada como asset PÚBLICO no Cloudinary
- **O que quebra:** Frente/verso do documento e selfie são gravados como asset Cloudinary `upload` padrão (entrega pública), não assinada/autenticada — quem tiver a URL vê o documento sem token.
- **Onde:** src/services/uploadService.js:29-33 + src/controllers/uploadStreamController.js:124 (pasta `pinturapro/verificacao`)
- **Como se chega:** A URL persiste no banco, em logs e no cliente admin; quem a obtiver abre o documento.
- **Já aconteceu?:** Desconhecido; a adivinhação do `public_id` aleatório é difícil, mas a URL vaza por outros meios. **UNVERIFIED** se a conta/pasta Cloudinary impõe entrega assinada/restrita (config fora do código).
- **Risco se não corrigir:** Vazamento de documento de identidade por posse de URL.

---

## BAIXA

### D63. [BAIXA] POST /config/limite-demandas — aprovador muda limite global
- **O que quebra:** Altera um limite global da plataforma (teto de demandas simultâneas).
- **Onde:** src/routes/index.js:5198 (gate `exigirAdmin`)
- **Como se chega:** Token `aprovador`. Config global, discutível se deveria ser admin-only.
- **Já aconteceu?:** Não (latente).
- **Risco se não corrigir:** Moderador altera regra de negócio global.

### D64. [BAIXA] POST /verificacao/:id/reprovar cancela assinatura e cria obrigação de estorno PIX — UNVERIFIED
- **O que quebra:** Reprovar tem efeito financeiro (cancela a assinatura e promete estorno). Feito por `aprovador`.
- **Onde:** src/routes/index.js:4836
- **Como se chega:** Token `aprovador` reprova um prestador. Borderline: aprovar/reprovar é a função declarada do `aprovador`.
- **Já aconteceu?:** Não (latente). **UNVERIFIED** se o efeito financeiro delegado é intencional.
- **Risco se não corrigir:** Efeito financeiro disparado por moderador, possivelmente por desenho.

### D65. [BAIXA] PUT/DELETE /obras/:id — aprovador edita/encerra qualquer obra sem escopo de criado_por
- **O que quebra:** `obrasCtrl.editar` e `encerrar` agem sobre QUALQUER obra por id só com `exigirAdmin`, sem escopo de dono — um `aprovador` reescreve `valor`/`status` ou força o encerramento de obra alheia.
- **Onde:** src/routes/index.js:1995-1996; src/controllers/obrasController.js:197,256
- **Como se chega:** Token `aprovador` chama PUT/DELETE /obras/<id>. Borderline (superfície de CRUD admin).
- **Já aconteceu?:** Não (latente).
- **Risco se não corrigir:** Moderador altera valor/estado de obra de qualquer usuário.

### D66. [BAIXA] /reparos/:id/abertura sem gate de suspensão
- **O que quebra:** Reparador suspenso arma a proximidade. Efeito limitado: o cron filtra `suspenso_em IS NULL` (server.js:258), então o suspenso não recebe os disparos.
- **Onde:** src/routes/index.js:3442
- **Como se chega:** Reparador suspenso chama /abertura.
- **Já aconteceu?:** Desconhecido; 0 suspensos hoje.
- **Risco se não corrigir:** Inconsistência de gate; impacto contido pelo filtro do cron.

### D67. [BAIXA] Suspenso/não-verificado ainda lê detalhe de demanda e threads de mensagem
- **O que quebra:** GETs só-`autenticar` de detalhe de demanda e thread de obra seguem abertos a conta suspensa/pendente.
- **Onde:** src/routes/index.js:2177,4393,5708
- **Como se chega:** Conta suspensa/pendente lê os GETs.
- **Já aconteceu?:** Desconhecido — leitura, não deixa rastro.
- **Risco se não corrigir:** Suspensão fecha a escrita mas não a leitura (provavelmente aceitável, listado por completude).

### D68. [BAIXA] POST /auth/upload-verificacao sem autenticação (pré-cadastro)
- **O que quebra:** Upload mediado pelo servidor (multer, filtrado por tipo, 150MB) sem contexto de dono, pré-cadastro. Só limite de 20/h por IP (server.js:152).
- **Onde:** src/routes/index.js:4729
- **Como se chega:** Requisição anônima sobe arquivo pelo servidor para o Cloudinary.
- **Já aconteceu?:** Desconhecido.
- **Risco se não corrigir:** Vetor de flood de armazenamento pré-cadastro.

### D69. [BAIXA] /upload/midia (stream) sem throttle por usuário, 100MB, sem exigir assinatura
- **O que quebra:** Caminho de upload por stream aceita vídeo de 100MB para QUALQUER JWT válido (assinatura não exigida); só o balde global de 300/15min por IP se aplica.
- **Onde:** src/controllers/uploadStreamController.js:112-124 + src/routes/index.js:4587
- **Como se chega:** Qualquer conta autenticada sobe vídeos grandes repetidamente.
- **Já aconteceu?:** Desconhecido. **UNVERIFIED** a eficácia do mapa de IP em memória entre réplicas (reseta no redeploy, por processo).
- **Risco se não corrigir:** Flood de armazenamento por conta autenticada.

### D70. [BAIXA] /upload/obra-url e /upload/reparo-url aceitam url arbitrária do cliente
- **O que quebra:** As rotas gravam uma string `url` fornecida pelo cliente numa linha de mídia, sem validar que é um asset Cloudinary que o chamador subiu — o dono persiste qualquer URL externa.
- **Onde:** src/routes/index.js:4642-4657 e 4612-4630
- **Como se chega:** Dono manda `{url: "<qualquer coisa>"}` no corpo.
- **Já aconteceu?:** Desconhecido — não varri as linhas de mídia por URLs não-Cloudinary.
- **Risco se não corrigir:** URL/​conteúdo externo persistido e depois renderizado nos clientes.

---

## O que NÃO foi auditado nesta passagem, e por quê

- **Reforço do lado Cloudinary:** se a conta/pasta impõe entrega assinada, controle de acesso ou allowlist de transformação — não determinável pelo código (config vive na conta Cloudinary). Isso amortece ou não D60/D61/D62; marcado UNVERIFIED.
- **Eficácia dos rate limits entre réplicas:** os limitadores e o mapa de IP do stream-upload são por processo/memória (resetam no redeploy). O comportamento real com várias réplicas Railway não é confirmável pelo código (D69).
- **Frente 1 (dinheiro):** o endpoint de dinheiro `darAcessoGratuito`/`lancamento` com escopo `aprovador` (D10) foi excluído por já estar reportado; não reabri a análise financeira aqui.
- **Conteúdo real dos buckets e logs:** não inspecionei o que está armazenado no Cloudinary nem os logs do Railway (sem acesso nesta sessão), então os "Já aconteceu?" de upload/PII ficaram Desconhecido.
- **Superfície de leitura por desenho:** a exposição de fotos de obra/reparo a qualquer assinante (não só às partes) é decisão de produto do marketplace (endereço/contato são gated por match, fotos não) — notada, não flagada como defeito.
- **Front-ends (app e painel):** consultados só para confirmar quais rotas são chamadas; não auditei lógica de autorização no cliente — a autorização que importa é a do servidor, que é o que esta passagem cobriu.
- **Correção:** nenhuma. Esta passagem é só levantamento; correções vêm após revisão com o usuário.
