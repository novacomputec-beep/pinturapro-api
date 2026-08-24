# Auditoria — Frente 1: Dinheiro

**Data:** 2026-08-24
**Escopo:** Todo caminho onde dinheiro é decidido, cobrado, registrado ou exibido — assinaturas (criação, ativação, renovação, expiração, reativação), cobrança via PagBank, janela de lançamento grátis, propostas e contrapropostas, o valor acordado, e o encerramento de uma demanda (obra e reparo).
**Método:** Leitura de código (`src/controllers/pagamentoController.js`, `src/controllers/contratosController.js`, `src/controllers/obrasController.js`, `src/controllers/authController.js`, `src/routes/index.js`, `src/middlewares/auth.js`, `src/services/*`, `server.js`) mais consultas **somente-leitura** ao Postgres de produção para confirmar schema e ocorrência. Nada foi modificado, nenhuma escrita foi feita no banco.

## Evidência decisiva de ocorrência (lida de produção, somente-leitura)

- **Tabela `webhook_eventos_pagbank` está VAZIA** (0 linhas, 0 eventos `PAID`, 0 charges distintos). É o único livro financeiro do sistema — não existe tabela `pagamentos`. Ou seja: **nenhum pagamento real via PagBank jamais foi processado**. Todos os defeitos de webhook/assinatura abaixo são latentes: existem no código mas ainda não cobraram nem ativaram ninguém indevidamente.
- **`contratos` tem 6 linhas, com ZERO duplicatas** por `candidatura_id` e por `interesse_id`. Os defeitos de contrato duplicado ainda não se materializaram.
- **`assinaturas`:** 13 linhas casam o alvo do backfill de lançamento (`tipo='gratuito' AND valor_mensal > 0`), 6 são gratuito-permanente (`valor_mensal = 0`), 0 estão em `pendente_verificacao` neste momento. A **exposição financeira viva hoje é essa coorte de 13 linhas**, não pagamentos reais.
- **Schema confirmado:** existem as tabelas `assinaturas`, `candidaturas`, `contratos`, `interesse_reparos`, `webhook_eventos_pagbank`. `contratos` NÃO tem coluna de valor (só `candidatura_id`, `interesse_id`, `status`, datas). Índices únicos presentes: `contratos_candidatura_id_key` (candidatura_id), `candidaturas_obra_id_usuario_id_key`, `candidaturas_aceito_unica_idx` (parcial em status='aceito'), `idx_interesse_reparo_usuario` (reparo_id, usuario_id, ÚNICO), `interesse_reparos_aceito_unico_idx`, `assinaturas_usuario_id_unico_idx`, `webhook_eventos_pagbank` PK (charge_id, status). **Não existe índice único em `contratos.interesse_id`.**

## Resumo para quem não programa

O sistema de dinheiro do aplicativo tem duas partes: cobrar assinaturas dos profissionais e registrar o valor combinado entre dono e prestador em cada serviço. A boa notícia, confirmada olhando o banco de produção, é que **até agora nenhuma cobrança de assinatura de verdade passou pelo sistema** — o "livro caixa" está vazio —, então nenhum dos problemas de cobrança já prejudicou alguém financeiramente. A má notícia é que, do jeito que o código está, quando as cobranças começarem, várias coisas podem dar errado: a porta que recebe o aviso de "pagamento aprovado" hoje aceita avisos falsos de qualquer um da internet, um profissional pode ser cobrado duas vezes, e quem paga pode não receber o acesso. Na parte de valores combinados, o número que vai para o contrato em PDF assinado não é o valor negociado, e sim a estimativa inicial — eles podem divergir —, e há caminhos em que o dono consegue mudar o preço depois que o serviço já foi fechado. O único ponto que exige atenção imediata mesmo sem cobranças ativas é um grupo de 13 assinaturas de cortesia que, quando a promoção de lançamento for encerrada, podem ter a data de vencimento encurtada por um erro de cálculo. Nada disso foi corrigido nesta passagem — este documento só cataloga.

**Contagem:** 45 achados — 9 ALTA, 20 MÉDIA, 16 BAIXA (2 dos quais marcados UNVERIFIED). Ordenados por severidade e, dentro de cada nível, por raio de alcance.

---

## ALTA

### D1. [ALTA] Webhook do PagBank aceita eventos não assinados
- **O que quebra:** A rota que recebe a confirmação de pagamento não exige assinatura de autenticidade por padrão — ela apenas anota se a assinatura bate e processa o evento de qualquer forma. Qualquer pessoa na internet pode enviar um "pagamento aprovado" falso.
- **Onde:** src/controllers/pagamentoController.js:226,240 (variável `WEBHOOK_ENFORCE_SIGNATURE` ausente de `.env.example`)
- **Como se chega:** Um POST anônimo para `/api/pagamentos/webhook` com corpo `{"reference_id":"<uuid-da-vítima>|anual","charges":[{"id":"x","status":"PAID"}]}` ativa 365 dias de assinatura para qualquer usuário. A rota não tem autenticação, é isenta de rate limit (server.js:143) e de load shedding (server.js:101).
- **Já aconteceu?:** Não. `webhook_eventos_pagbank` está vazia — nenhum evento (legítimo ou forjado) foi processado.
- **Risco se não corrigir:** Qualquer um concede assinatura paga a qualquer conta de graça, sem deixar rastro atribuível.

### D2. [ALTA] Plano concedido vem do texto do reference_id, sem conferir o valor pago
- **O que quebra:** O que o usuário ganha (mensal ou anual) é decidido pelo texto que acompanha o evento, nunca pelo valor efetivamente cobrado. Um pagamento parcial, estornado ou forjado concede o mesmo acesso que um pagamento cheio.
- **Onde:** src/controllers/pagamentoController.js:279-317 (`charge.amount.value` só alimenta a mensagem do Telegram)
- **Como se chega:** Evento com `reference_id` terminando em `|anual` e qualquer `amount` (ou nenhum) concede um ano.
- **Já aconteceu?:** Não. Livro de webhook vazio.
- **Risco se não corrigir:** Descolamento total entre o que foi pago e o que foi entregue; base para fraude e para conceder acesso sem receber.

### D3. [ALTA] criarAssinatura não impede segundo checkout para quem já tem assinatura ativa
- **O que quebra:** Não há verificação de assinatura já ativa/pendente antes de abrir uma nova cobrança. O app pode abrir um segundo checkout PagBank para quem já pagou.
- **Onde:** src/controllers/pagamentoController.js:106-120
- **Como se chega:** Usuário com assinatura ativa toca "assinar" de novo (ou o app reenvia); rate limit é 20/h (server.js:162). Dois checkouts pagos = cobrança dupla sem segundo período creditado (agravado por D6).
- **Já aconteceu?:** Não. Nenhuma cobrança real ocorreu ainda.
- **Risco se não corrigir:** Cobrança em duplicidade de clientes reais assim que o fluxo de pagamento entrar em uso.

### D4. [ALTA] Ativação roda depois do 200 e depois do claim de idempotência — pagou e não ativou
- **O que quebra:** O webhook responde "recebido" (200) e grava o registro de deduplicação ANTES de efetivamente ativar a assinatura. Se a ativação falhar (queda de banco, pool esgotado), o PagBank não reenvia (por desenho) e a reentrega é descartada como duplicata. O usuário é cobrado e nunca ativado.
- **Onde:** src/controllers/pagamentoController.js:245 (sendStatus 200), :260-271 (claim antes do trabalho), :321 (catch só loga)
- **Como se chega:** Falha transitória exatamente entre o claim e `ativarAssinatura`/`colocarPendentVerificacao`. Não há job de reconciliação em lugar nenhum.
- **Já aconteceu?:** Não. Livro de webhook vazio.
- **Risco se não corrigir:** Cliente paga, não recebe acesso, e não há como detectar nem reprocessar automaticamente.

### D5. [ALTA] Renovação de prestador é um beco sem saída — perde o acesso e nada o devolve
- **O que quebra:** Todo pagamento de prestador força a assinatura de volta para `pendente_verificacao`, mas o `verificacao_status` só é reposto para `pendente` quando ainda está em `nao_solicitada`. Um prestador já aprovado que renova mantém `verificacao_status='aprovado'`, cai para pendente na assinatura, some das filas de aprovação e nenhum caminho o reativa.
- **Onde:** src/controllers/pagamentoController.js:39-53; fila em src/routes/index.js:4709; cron Modo Auto em server.js:640
- **Como se chega:** Prestador ativo/expirado paga para renovar → perde acesso `ativa` na hora e fica invisível para `/verificacao/pendentes` e para o cron.
- **Já aconteceu?:** Não. 0 linhas em `pendente_verificacao` hoje e nenhum pagamento processado.
- **Risco se não corrigir:** Todo prestador que renovar perde o acesso permanentemente até intervenção manual no banco.

### D6. [ALTA] Pagamento de prestador não registra tempo comprado
- **O que quebra:** O caminho do prestador (`colocarPendentVerificacao`) nunca toca `proximo_vencimento`; a aprovação depois concede `GREATEST(vencimento, NOW()+período)` em vez de somar período ao vencimento. Vários pagamentos antes de uma aprovação colapsam num único período de 30/365 dias.
- **Onde:** src/controllers/pagamentoController.js:39-47 vs src/routes/index.js:4735-4738
- **Como se chega:** Prestador paga duas vezes antes de o admin aprovar → recebe um período só. A garantia de empilhamento documentada em `ativarAssinatura` (:17-19) não existe no caminho do prestador, que é o único que pagadores reais usam.
- **Já aconteceu?:** Não. Nenhum pagamento real.
- **Risco se não corrigir:** Cliente paga por período que não recebe.

### D7. [ALTA] Backfill de lançamento move o vencimento para TRÁS (sem GREATEST)
- **O que quebra:** Ao encerrar a janela grátis, o backfill grava `proximo_vencimento` incondicionalmente, sem `GREATEST` — é a única escrita do sistema que pode ANTECIPAR um vencimento. Um usuário da coorte que efetivamente pagou mantém `tipo='gratuito'`, casa o predicado do backfill e tem seu prazo (ex.: 365 dias pagos) truncado para o fim do mês corrente.
- **Onde:** src/routes/index.js:5030 (backfill sem GREATEST); conflitos que deixam a linha em tipo=gratuito em pagamentoController.js:39-47 e :353-359
- **Como se chega:** Admin desliga a janela; qualquer linha `tipo='gratuito' AND valor_mensal>0` é reescrita para fim-do-mês, mesmo que represente um pagamento real.
- **Já aconteceu?:** Não — a janela está LIGADA (`lancamento_data_fim` = 2027-01-01) e o backfill nunca rodou (as 13 linhas-alvo continuam intactas). É a exposição viva mais próxima.
- **Risco se não corrigir:** No dia em que a janela for encerrada, até 13 assinaturas podem ter o vencimento encurtado de uma vez.

### D8. [ALTA] "aceitar" e "contraproposta" sem guarda de estado — valor mexido depois do acordo e do encerramento
- **O que quebra:** Aceitar não valida o estado da proposta (o dono pode aceitar a própria contraproposta sem o profissional concordar, ou ressuscitar propostas `recusado`/`expirado`), e a rota de contraproposta não checa estado nenhum — permite reescrever o valor DEPOIS do acordo e DEPOIS do encerramento. Como o valor final é derivado em leitura de `COALESCE(valor_contraproposta, valor_proposto)` e os JOINs de `/admin/finalizadas` exigem `status='aceito'`, reabrir uma demanda encerrada zera o histórico de valor do painel.
- **Onde:** src/routes/index.js:2314-2336 e 3536-3557 (aceitar); :2364-2369 e 3589-3594 (contraproposta); JOINs/totais em :6098,6106,6146-6147
- **Como se chega:** Dono de obra já `encerrada` chama `responder{action:'contraproposta', valor:1}`; só há checagem de `criado_por`, então `valor_contraproposta` é reescrito e o status volta a `contraproposta_dono`, derrubando `valor_total`/`ticket_medio`.
- **Já aconteceu?:** Desconhecido — não há trilha histórica de valor (contratos não guarda valor); não é reconstruível pelo estado atual.
- **Risco se não corrigir:** Preço combinado alterado unilateralmente após o fechamento e distorção dos números financeiros do painel admin.

### D9. [ALTA] Contrato em PDF carrega o valor errado
- **O que quebra:** O documento enviado às partes usa, no reparo, a estimativa do dono (`valor_estimado`) e, na obra, `valor_oferta`/`obras.valor` — nunca o valor negociado (`valor_proposto`/`valor_contraproposta`). Se o prestador propôs 350 sobre uma estimativa de 200, o PDF assinado diz 200 enquanto `/admin/finalizadas` diz 350.
- **Onde:** src/controllers/contratosController.js:26 e :292 (reparo, `valor_estimado`); :140 e :390 (obra, `valor_oferta`/`obras.valor`)
- **Como se chega:** Qualquer aceite via `/obras/:id/candidatura/.../responder`, `/pintor-responder` ou aceite de reparo.
- **Já aconteceu?:** Provavelmente sim para os 6 contratos existentes, mas não confirmável — `contratos` não guarda o valor, então não dá para comparar o PDF emitido com o negociado a posteriori.
- **Risco se não corrigir:** Documento assinado juridicamente divergente do valor realmente acordado.

---

## MÉDIA

### D10. [MÉDIA] exigirAdmin admite o papel 'aprovador'
- **O que quebra:** O papel de moderação `aprovador` passa por `exigirAdmin`, alcançando todas as ações que movem dinheiro.
- **Onde:** src/middlewares/auth.js:156
- **Como se chega:** Um `aprovador` chama conceder assinatura grátis (routes:5666), aprovar verificação com ativação (routes:4720), desligar a janela de lançamento com backfill irreversível (routes:5060) ou apagar o livro de contratos/assinaturas (routes:4637,5718,6185). Só `/admin/sugestoes` usa `exigirSuperAdmin`.
- **Já aconteceu?:** Desconhecido — não auditei os logs de quem tem papel `aprovador` nem o histórico de chamadas dessas rotas.
- **Risco se não corrigir:** Moderador de baixo privilégio dispara ações financeiras irreversíveis.

### D11. [MÉDIA] /verificacao/:id/aprovar sem guarda de estado
- **O que quebra:** O UPDATE de assinatura filtra só por `usuario_id`, sem `AND status='pendente_verificacao'`. Ressuscita assinatura `cancelada`/expirada entregando 30 ou 365 dias sem pagamento e desfaz um `/reprovar` anterior.
- **Onde:** src/routes/index.js:4730-4741 (compare com o claim correto do lote em :4919-4926)
- **Como se chega:** Admin/aprovador chama aprovar sobre uma assinatura já cancelada.
- **Já aconteceu?:** Não confirmável pelo estado atual (0 pendentes agora).
- **Risco se não corrigir:** Concessão de período pago sem pagamento e reversão silenciosa de uma reprovação.

### D12. [MÉDIA] darAcessoGratuito não zera valor_mensal no ramo de UPDATE
- **O que quebra:** Ao conceder acesso grátis a uma linha já existente, o código grava `tipo='gratuito'` mas não zera `valor_mensal`. O comentário do backfill (routes:5023) assume que `darAcessoGratuito` grava `valor_mensal=0` — verdade só no ramo de INSERT (:362), não no de UPDATE.
- **Onde:** src/controllers/pagamentoController.js:353-359
- **Como se chega:** Admin concede acesso grátis a um prestador que pagou e aguarda verificação (`pendente_verificacao`, `valor_mensal=99.90`) → linha vira `tipo='gratuito'` com `valor_mensal>0`, entrando no alvo do backfill.
- **Já aconteceu?:** Não confirmável diretamente; das 13 linhas-alvo atuais não dá para saber quais vieram por este caminho.
- **Risco se não corrigir:** Acesso "grátis permanente" concedido por um admin é silenciosamente convertido em pagante no encerramento da janela.

### D13. [MÉDIA] Contrato de reparo pode duplicar linha e e-mail
- **O que quebra:** O "claim" de idempotência do contrato de reparo é um `INSERT ... SELECT ... WHERE NOT EXISTS`, que não é atômico, e **não existe índice único em `contratos.interesse_id`** (confirmado no schema — só `candidatura_id` tem único). Dois aceites concorrentes passam ambos pelo NOT EXISTS.
- **Onde:** src/controllers/contratosController.js:261-266; ausência de único confirmada em produção
- **Como se chega:** Duplo toque ou `comRetry` sobre o aceite de reparo → duas linhas em `contratos` e dois PDFs para as duas partes.
- **Já aconteceu?:** Não. `contratos` tem 6 linhas, 0 duplicatas por interesse_id.
- **Risco se não corrigir:** Contrato e e-mail duplicados sob concorrência (o caminho de obra está protegido pelo único em candidatura_id; o de reparo não).

### D14. [MÉDIA] criarAssinatura abre um checkout novo a cada chamada (sem dedupe)
- **O que quebra:** Não há `client_request_id`, dedupe nem persistência do checkout (ao contrário de obras/reparos, que têm índice único de `client_request_id`). `comRetry` sobre resposta lenta do gateway gera vários links de pagamento vivos para a mesma assinatura.
- **Onde:** src/controllers/pagamentoController.js:169-190 (contraste com src/routes/index.js:176-177)
- **Como se chega:** App reenvia o pedido de checkout após timeout → múltiplos links pagáveis; se dois forem pagos, D6 garante que o segundo não compra nada e não há registro para estornar.
- **Já aconteceu?:** Não. Nenhum pagamento real.
- **Risco se não corrigir:** Vários links de cobrança simultâneos para uma só assinatura.

### D15. [MÉDIA] Bugs de validação de valor nas contrapropostas (0 legítimo, string, negativo, NULL)
- **O que quebra:** `if (!valor)` rejeita um valor 0 legítimo (cortesia/garantia) com "Informe o valor"; `valor_proposto || null` converte uma proposta de 0 em NULL; e o `valor` não é validado como número, então string não-numérica gera erro 500 genérico e valores negativos são aceitos e viram o valor acordado.
- **Onde:** src/routes/index.js:2282,2365,2408,3392,3590,3636 (e o legado 5205)
- **Como se chega:** Contraproposta de R$ 0, ou cliente/curl enviando `valor:"1.234,56"` ou `valor:-500`.
- **Já aconteceu?:** Desconhecido — não varri as colunas de valor por linhas negativas/NULL nesta passagem.
- **Risco se não corrigir:** Valor acordado zerado, nulo, negativo ou 500 em negociação legítima.

### D16. [MÉDIA] dono_obra que paga troca acesso permanente por acesso que expira
- **O que quebra:** Um `dono_obra` é precificado em R$99,90 sem guarda de papel, roteado para `ativarAssinatura`, que sobrescreve um `proximo_vencimento` NULL (nunca expira) com `NOW()+30d`. Trinta dias depois o cron de expiração o rebaixa para `expirada`.
- **Onde:** src/controllers/pagamentoController.js:149-153, :29,:297; cron em server.js:384-392
- **Como se chega:** Dono de obra paga uma assinatura (o app permite) → perde, em 30 dias, o acesso que tinha de graça.
- **Já aconteceu?:** Não. Nenhum pagamento real processado.
- **Risco se não corrigir:** Cliente que paga fica em situação pior do que antes de pagar.

### D17. [MÉDIA] Eventos de estorno/cancelamento só são logados, sem revogação
- **O que quebra:** Um evento `REFUNDED`/`CANCELED`/chargeback que chega depois do `PAID` apenas registra uma linha; a assinatura mantém o período concedido e não há caminho de revogação.
- **Onde:** src/controllers/pagamentoController.js:279-282
- **Como se chega:** Cliente paga, ganha acesso, estorna — e continua com acesso.
- **Já aconteceu?:** Não. Livro de webhook vazio.
- **Risco se não corrigir:** Acesso concedido sobrevive ao estorno do pagamento que o custeou.

### D18. [MÉDIA] valor_acordado exibido sem filtro de status='aceito' e com LIMIT 1 sem ORDER BY
- **O que quebra:** Em `/obras/minhas`, `/reparos/minhas` e nos quatro endpoints de "meus contratos", o valor é derivado por `COALESCE(contraproposta, proposto)` sem filtrar `status='aceito'` e com `LIMIT 1` sem `ORDER BY` — então mostra valor de proposta em estado `contraproposta_dono`/`recusado`/`expirado` como se fosse acordado, divergindo de `/admin/finalizadas`.
- **Onde:** src/routes/index.js:1636-1639, 2860-2863, 1673, 1712, 3237, 3272
- **Como se chega:** Dono abre a lista após qualquer contraproposta pendente.
- **Já aconteceu?:** Desconhecido — é comportamento de exibição, não deixa registro.
- **Risco se não corrigir:** As partes veem um "valor acordado" que o painel admin não reconhece.

### D19. [MÉDIA] Reprovação promete estorno PIX incondicionalmente, sem registrar montante
- **O que quebra:** A reprovação cancela a assinatura e envia e-mail dizendo "o valor pago será devolvido" mesmo para usuários da janela de lançamento que não pagaram nada, e não registra montante nem lançamento para os que pagaram (estorno é manual).
- **Onde:** src/routes/index.js:4804-4839 (estorno manual em :4855)
- **Como se chega:** Admin reprova qualquer prestador, pagante ou não.
- **Já aconteceu?:** Não confirmável — não auditei e-mails enviados; nenhum pagamento real existe para estornar.
- **Risco se não corrigir:** Promessa de estorno a quem não pagou e ausência de base contábil para quem pagou.

### D20. [MÉDIA] Aviso de encerramento da janela é só push e best-effort
- **O que quebra:** No fechamento da janela, a notificação à coorte é apenas push e filtra quem tem `push_token` nulo/vazio, com faixas que só alcançam 24h; não há e-mail neste caminho. Quem não tem permissão de push vai de grátis a `expirada` sem aviso.
- **Onde:** server.js:443; expiração em server.js:384-392; alvo de tempo em src/routes/index.js:5016
- **Como se chega:** Admin encerra a janela tarde no mês (o alvo é fim-do-mês), deixando minutos até a expiração.
- **Já aconteceu?:** Não. Janela nunca foi encerrada.
- **Risco se não corrigir:** Usuário perde acesso sem qualquer notificação efetiva.

### D21. [MÉDIA] Isenção de contas especiais depende de variável de ambiente no momento da execução
- **O que quebra:** A lista de e-mails preservados no backfill é lida de `EMAILS_ESPECIAIS` quando o backfill roda, e o cadastro concede `tipo='gratuito'` sem zerar `valor_mensal`. Se a variável for alterada/reordenada antes do fechamento da janela, essas contas "permanentes" viram pagáveis com prazo de fim-de-mês.
- **Onde:** src/routes/index.js:5007; src/controllers/authController.js:240
- **Como se chega:** Alguém edita `EMAILS_ESPECIAIS` no ambiente e depois a janela é encerrada.
- **Já aconteceu?:** Não. Backfill nunca rodou.
- **Risco se não corrigir:** Contas de cortesia protegidas por env perdem a proteção silenciosamente.

### D22. [MÉDIA] Janela de lançamento não se aplica a role='assinante'
- **O que quebra:** Um cadastro cujo `tipo_conta` não é reconhecido cai no ramo pago de R$99,90/`pendente` mesmo com a janela aberta, enquanto o webhook trata `assinante` como prestador.
- **Onde:** src/controllers/authController.js:210-218; webhook em src/controllers/pagamentoController.js:297
- **Como se chega:** Cadastro com `tipo_conta` inesperado durante a janela grátis.
- **Já aconteceu?:** Desconhecido — não contei linhas com role='assinante' nesta passagem.
- **Risco se não corrigir:** Usuário é cobrado durante um período que deveria ser grátis.

### D23. [MÉDIA] criarAssinatura nunca consulta lancamento_data_fim
- **O que quebra:** Abrir checkout não verifica se a janela grátis está ativa. Um membro da coorte (`tipo='gratuito'`) pode abrir cobrança e pagar preço cheio por um período que hoje é grátis.
- **Onde:** src/controllers/pagamentoController.js:106
- **Como se chega:** Usuário da coorte toca "assinar" durante a janela.
- **Já aconteceu?:** Não. Nenhum pagamento real.
- **Risco se não corrigir:** Cobrança de quem já tem o período de graça.

### D24. [MÉDIA] Backfill não reescreve status — coorte pendente ganha 30 dias de graça na aprovação
- **O que quebra:** O backfill reescreve `tipo` e `proximo_vencimento` mas não `status`. Linhas da coorte ainda em `pendente_verificacao` viram `tipo=NULL`, e uma aprovação posterior pega o ramo `GREATEST(pv, NOW()+30d)`, concedendo 30 dias de acesso pago que ninguém pagou.
- **Onde:** src/routes/index.js:5028-5041; aprovação em :4737
- **Como se chega:** Janela encerra com linhas da coorte em `pendente_verificacao`; admin aprova depois.
- **Já aconteceu?:** Não. 0 linhas em `pendente_verificacao` hoje e backfill nunca rodou.
- **Risco se não corrigir:** Concessão de período pago sem pagamento após o encerramento da janela.

### D25. [MÉDIA] PUT /obras/:id (admin) altera obras.valor sem validação nem guarda de status
- **O que quebra:** A edição de obra troca `obras.valor` sem validar e sem checar o estado da obra; como o contrato lê `obras.valor`, o número nas listagens deixa de bater com o PDF já enviado. (`criar` valida; `editar` não.)
- **Onde:** src/controllers/obrasController.js (handler `editar`) e o SQL de UPDATE correspondente
- **Como se chega:** Admin edita uma obra já casada/encerrada. (Nota: a rota recebeu correção de atualização parcial em outra frente; a validação de valor e a guarda de status continuam ausentes.)
- **Já aconteceu?:** Desconhecido — não há histórico de valor para comparar.
- **Risco se não corrigir:** Valor de referência da obra alterado após o contrato, divergindo do documento emitido.

### D26. [MÉDIA] POST /obras/dono e POST /reparos/dono gravam valor sem validação
- **O que quebra:** Ambas gravam `valor`/`valor_estimado` sem nenhuma validação (o comentário assume validação "DEFERIDA"). NULL, negativo ou string chegam ao banco e, no reparo, direto para a cláusula de pagamento do contrato.
- **Onde:** src/routes/index.js:1794-1801 e 2904-2911
- **Como se chega:** Dono cria obra/reparo sem informar valor ou com valor inválido.
- **Já aconteceu?:** Desconhecido — não varri as demandas por valores inválidos nesta passagem.
- **Risco se não corrigir:** Valor inválido propaga para o contrato e para os cálculos do painel.

### D27. [MÉDIA] Contrato com valor NULL sai com "R$ 0,00" e "valor não informado" no mesmo PDF
- **O que quebra:** Com `obras.valor` NULL, a cláusula de valor mostra "R$ 0,00" (via `Number(null)`→0) e o valor por extenso vira "valor não informado" (via `parseFloat(null)`→NaN) no mesmo documento.
- **Onde:** src/services/contratoService.js:72-73 e 288-296
- **Como se chega:** Obra criada pelo dono sem valor e aceita sem contraproposta.
- **Já aconteceu?:** Desconhecido — não abri os 6 PDFs existentes.
- **Risco se não corrigir:** Documento assinado internamente contraditório sobre o valor.

### D28. [MÉDIA] Criar candidatura/interesse não verifica o status da demanda
- **O que quebra:** As rotas novas não checam o estado da demanda (a rota legada `/candidaturas` checa). É possível propor valor em obra `encerrada`, `rascunho`, expirada ou já casada, e esse valor entra na cadeia se o dono depois aceitar.
- **Onde:** src/routes/index.js:2272-2283 e 3385-3393 (legado que checa: :5198)
- **Como se chega:** Prestador (ou curl) manda proposta numa demanda que não deveria mais aceitar.
- **Já aconteceu?:** Desconhecido — não cruzei propostas com status de demanda nesta passagem.
- **Risco se não corrigir:** Propostas em demandas mortas contaminam a cadeia de valor.

### D29. [MÉDIA] Renegociação bloqueada para sempre após recusa/expiração
- **O que quebra:** O guard de duplicidade barra por (demanda, usuário) sem olhar status, então um profissional `recusado`/`expirado` recebe 409 para sempre e não consegue reapresentar proposta.
- **Onde:** src/routes/index.js:2275-2279 e 3388-3389; `rejeitarConcorrentes` marca perdedores como `recusado` em src/utils/rejeitarConcorrentes.js:39-43
- **Como se chega:** Dono recusa por engano, ou o profissional perde uma disputa; não há caminho de volta.
- **Já aconteceu?:** Desconhecido — comportamento de bloqueio não deixa registro distinto.
- **Risco se não corrigir:** Negócio legítimo impedido de reabrir, sem saída pela interface.

---

## BAIXA

### D30. [BAIXA] Duplo toque em /obras/:id/candidatura devolve 500 em vez de 409
- **O que quebra:** O índice único pega a corrida, mas o catch não trata `23505`, então o app vê 5xx e o `comRetry` tenta de novo.
- **Onde:** src/routes/index.js:2275-2283, catch em :2294 (compare com candidaturasController.js:214)
- **Como se chega:** Duplo toque no botão de candidatar-se.
- **Já aconteceu?:** Desconhecido — não auditei logs de 5xx.
- **Risco se não corrigir:** Erro confuso e retries desnecessários; o valor em si fica protegido pelo único.

### D31. [BAIXA] Replay de /verificacao/:id/aprovar reenvia e-mail e push
- **O que quebra:** A aprovação individual não tem claim, então cada retry reenvia e-mail e push de aprovação (o valor é seguro porque `GREATEST` limita a extensão).
- **Onde:** src/routes/index.js:4754-4782 (o lote ao lado usa claim correto em :4919-4927)
- **Como se chega:** `comRetry` ou duplo clique do admin.
- **Já aconteceu?:** Desconhecido.
- **Risco se não corrigir:** Spam de notificação de aprovação.

### D32. [BAIXA] plano vem cru do reference_id sem validação
- **O que quebra:** Qualquer valor diferente de `'anual'` na segunda parte do `reference_id` cai silenciosamente no ramo de 30 dias.
- **Onde:** src/controllers/pagamentoController.js:284-287
- **Como se chega:** `reference_id` com plano inesperado.
- **Já aconteceu?:** Não. Livro de webhook vazio.
- **Risco se não corrigir:** Concessão de plano incorreta por entrada malformada.

### D33. [BAIXA] Ativação por webhook não invalida os caches de autenticação
- **O que quebra:** Os caminhos de ativação do webhook não importam `invalidarCachesUsuario` (ao contrário de server.js:666 e routes:4745), então quem acabou de pagar pode manter um `false` em cache por até 30s por réplica.
- **Onde:** src/controllers/pagamentoController.js (sem import de invalidação)
- **Como se chega:** Usuário paga e tenta usar o recurso imediatamente.
- **Já aconteceu?:** Não. Nenhum pagamento real.
- **Risco se não corrigir:** Atraso curto de acesso após pagar.

### D34. [BAIXA] webhook_eventos_pagbank cresce sem limite e nunca é lido de volta
- **O que quebra:** A tabela registra o que o webhook alegou, mas nada a relê; não há reconciliação de "pagou mas não ativou".
- **Onde:** src/routes/index.js:866-874
- **Como se chega:** Uso normal ao longo do tempo.
- **Já aconteceu?:** Não. Tabela vazia hoje.
- **Risco se não corrigir:** Sem base para reconciliar D4 e crescimento indefinido.

### D35. [BAIXA] Contraproposta do profissional sobrescreve valor_proposto (sem histórico de rodadas)
- **O que quebra:** A contraproposta do prestador grava por cima de `valor_proposto`, apagando a proposta original; o rótulo "proposta original" na UI passa a mentir.
- **Onde:** src/routes/index.js:2410 e 3638
- **Como se chega:** Qualquer negociação com duas ou mais voltas.
- **Já aconteceu?:** Desconhecido — o dado antigo é sobrescrito, então não é reconstruível.
- **Risco se não corrigir:** Perda de trilha da negociação.

### D36. [BAIXA] rodada é fixada em 2 e nunca incrementada; obras não têm a coluna
- **O que quebra:** O contador de rodadas não protege contra ping-pong ilimitado de contrapropostas no servidor.
- **Onde:** src/routes/index.js:3592 vs 3638; ausência em candidaturas (:63/:73)
- **Como se chega:** Contrapropostas sucessivas via API.
- **Já aconteceu?:** Desconhecido.
- **Risco se não corrigir:** Negociação sem trava de rodadas no servidor.

### D37. [BAIXA] UPDATE de aceite não repete o status no WHERE — lost update sob concorrência
- **O que quebra:** Um `aceitar` e um `contraproposta` concorrentes se sobrescrevem; o índice único só protege contra dois aceites na mesma demanda.
- **Onde:** src/routes/index.js:2336 e 3557
- **Como se chega:** Dono com duas abas ou retry do app.
- **Já aconteceu?:** Desconhecido.
- **Risco se não corrigir:** Estado final da negociação imprevisível sob corrida.

### D38. [BAIXA] Push de contraproposta gera "R$ NaN"
- **O que quebra:** `Number(valor).toLocaleString` sem saneamento produz "R$ NaN" na notificação quando o valor vem como string formatada.
- **Onde:** src/routes/index.js:2413 e 3641
- **Como se chega:** Contraproposta com valor em formato de string.
- **Já aconteceu?:** Desconhecido — não auditei o conteúdo de pushes enviados.
- **Risco se não corrigir:** Notificação com valor ilegível.

### D39. [BAIXA] Colisão de nome de coluna bairro nas listagens de encerrados
- **O que quebra:** O `bairro` da demanda é sobrescrito pelo `bairro` do profissional na mesma linha de resultado.
- **Onde:** src/routes/index.js:1698/1702 (obras) e 3258/3262 (reparos)
- **Como se chega:** Qualquer chamada a `/…/meus-contratos-dono`.
- **Já aconteceu?:** Sim, é determinístico na resposta dessas rotas (não deixa dado gravado errado, só exibição).
- **Risco se não corrigir:** Bairro exibido incorreto nas telas de histórico.

### D40. [BAIXA] Código morto gerarEEnviarContrato usa obras.valor e ON CONFLICT DO UPDATE
- **O que quebra:** Função que ninguém importa hoje, mas que, se religada, usa `obras.valor` e faz `ON CONFLICT DO UPDATE` em `contratos`, furando o claim anti-reenvio de e-mail.
- **Onde:** src/services/contratoService.js:217-285 e 274-278
- **Como se chega:** Só se alguém reconectar a função.
- **Já aconteceu?:** Não. Sem importadores.
- **Risco se não corrigir:** Armadilha para regressão futura de reenvio de contrato.

### D41. [BAIXA] GET /config/lancamento e a leitura no cadastro são reads separados (TOCTOU)
- **O que quebra:** Um cliente que viu `gratis:true` pode completar o cadastro depois de a janela fechar e cair no ramo pago sem explicação.
- **Onde:** src/routes/index.js:5045; leitura no cadastro em src/controllers/authController.js:115-117
- **Como se chega:** Janela fecha entre a tela de cadastro e o envio.
- **Já aconteceu?:** Não. Janela nunca fechou.
- **Risco se não corrigir:** Cobrança inesperada por corrida na virada da janela.

### D42. [BAIXA] Encerramento da janela é irreversível e só tem console.log como trilha
- **O que quebra:** O único registro de quem foi convertido é um `console.log` de ids; nenhuma tabela guarda quem foi convertido, quando ou de qual vencimento anterior.
- **Onde:** src/routes/index.js:5093
- **Como se chega:** Admin encerra a janela.
- **Já aconteceu?:** Não. Backfill nunca rodou.
- **Risco se não corrigir:** A truncagem de D7 não pode ser desfeita nem reconstruída.

### D43. [BAIXA] Cláusula 4 do contrato de reparo vira linha em branco com valor 0 ou NULL
- **O que quebra:** Checagem falsy (`valor ?`) deixa a cláusula de valor do contrato de reparo em branco quando o valor é 0 ou NULL.
- **Onde:** src/controllers/contratosController.js:92
- **Como se chega:** Reparo com valor 0/NULL aceito.
- **Já aconteceu?:** Desconhecido — não abri os PDFs existentes.
- **Risco se não corrigir:** Contrato com cláusula de valor vazia.

### D44. [BAIXA] Webhook só inspeciona charges[0] — **UNVERIFIED**
- **O que quebra:** Se um payload trouxer mais de uma cobrança, só a primeira é considerada; as demais são silenciosamente ignoradas.
- **Onde:** src/controllers/pagamentoController.js:252
- **Como se chega:** PagBank enviar múltiplas charges num só evento — **não confirmado** que o PagBank faça isso; o código simplesmente não tem laço.
- **Já aconteceu?:** Não. Livro de webhook vazio.
- **Risco se não corrigir:** Perda potencial de cobranças em lote, se o gateway as agrupar.

### D45. [BAIXA] ticket_medio sem ROUND / formatação de SUM/AVG — **UNVERIFIED**
- **O que quebra:** `SUM`/`AVG` de NUMERIC voltam do driver como string sem arredondamento e `ticket_medio` não tem `ROUND`; não dá para confirmar pelo código como o painel formata.
- **Onde:** src/routes/index.js:6146-6147
- **Como se chega:** Abrir o painel de finalizadas — **não confirmado** que o resultado apareça malformatado, depende do front.
- **Já aconteceu?:** Desconhecido.
- **Risco se não corrigir:** Possível exibição de ticket médio com casas decimais estranhas.

---

## O que NÃO foi auditado nesta passagem, e por quê

- **Frentes fora do escopo de dinheiro:** notificações/push (exceto onde tocam expiração de assinatura), feed/busca geográfica, upload de mídia, moderação/denúncias, autenticação e senha — pedido explícito de focar só em dinheiro nesta Frente 1.
- **Front-ends:** o app (`pinturapro-app`) e o painel (`painel-admin`) foram consultados só para identificar *quais* rotas de dinheiro são chamadas; não auditei a lógica de valor no lado cliente (formatação, arredondamento, exibição) — as duas ressalvas UNVERIFIED (D38, D45) dependem disso e ficaram em aberto.
- **Integração real com o PagBank:** não há credencial de sandbox nem tráfego real (livro vazio), então o formato exato do payload/headers do webhook (incluindo D44, múltiplas charges, e o esquema de assinatura) não pôde ser confirmado contra o gateway — só contra o código.
- **DDL de `contratos` no repositório:** a tabela e seus índices foram confirmados *em produção* (existe, com único em candidatura_id e sem único em interesse_id), mas o `CREATE TABLE contratos` não está no repo; não rastreei por qual migração/handa ela foi criada.
- **Varreduras de dados por ocorrência:** confirmei ocorrência onde uma consulta agregada barata bastava (livro de webhook, duplicatas de contrato, tamanho da coorte). Não fiz varreduras linha-a-linha por valores negativos/NULL em `candidaturas`/`interesse_reparos`/demandas (D15, D26, D28) nem contei linhas por papel (D22) — são consultas maiores que preferi não rodar sem necessidade; por isso esses "Já aconteceu?" ficaram como Desconhecido.
- **Logs de aplicação e de acesso:** não tenho acesso aos logs do Railway nesta sessão, então defeitos cujo único rastro seria um log (D10 uso do papel aprovador, D30 5xx, D31/D38 notificações) ficaram como Desconhecido.
- **Correção:** nenhuma. Esta passagem é só levantamento; as correções vêm depois da sua revisão com o usuário.
