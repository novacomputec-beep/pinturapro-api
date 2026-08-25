# Fontes — Codex (parte 3 de 4)

Código-fonte REAL de `pinturapro-api` (branch `main`), selecionado para o auditor externo julgar as regras descritas em `dossie-codex.md`. Cada bloco traz `caminho:linha-inicial-linha-final` e cada linha vem prefixada com o número dela no arquivo. Nada de `.env`, segredos ou dados de produção — todos os segredos são lidos de `process.env`. Comentários foram mantidos porque carregam o racional de cada regra.

Seções: 1 gates · 2 dinheiro · 3 verificação/aprovação · 4 ciclo de vida OBRA · 5 ciclo de vida REPARO · 6 compartilhado · 7 crons · 8 migração de boot.


## (continuação) 5. Ciclo de vida — lado REPARO (compare com a seção 4)

### src/routes/index.js:4358-4550 — pedir/perguntar/informar/responder-tempo (reparo) — recusa expira o interesse aceito

```js
4358| router.post('/reparos/:id/pedir-tempo', autenticar, async (req, res) => {
4359|   try {
4360|     const { motivo } = req.body
4361|     const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
4362|     if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
4363|     const r = reparo.rows[0]
4364| 
4365|     if (r.match_usuario_id !== req.usuario.id) {
4366|       return res.status(403).json({ erro: 'Apenas o prestador do match pode solicitar mais tempo' })
4367|     }
4368| 
4369|     await pool.query(
4370|       `UPDATE reparos SET pedido_tempo_status = 'aguardando_tempo', pedido_tempo_motivo = $1, pedido_tempo_minutos = NULL WHERE id = $2`,
4371|       [motivo, req.params.id]
4372|     )
4373| 
4374|     // Notifica o dono
4375|     const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.criado_por])
4376|     if (dono.rows[0]?.push_token) {
4377|       await enviarPushNotificacao(
4378|         dono.rows[0].push_token,
4379|         '⚠️ Prestador precisa de mais tempo!',
4380|         `Motivo: ${motivo}. Abra o app para responder.`,
4381|         { tipo: 'pedido_tempo', reparo_id: req.params.id }
4382|       )
4383|     }
4384| 
4385|     res.json({ mensagem: 'Solicitação enviada ao dono.' })
4386|   } catch (err) {
4387|     res.status(500).json({ erro: 'Erro ao solicitar mais tempo' })
4388|   }
4389| })
4390| 
4391| // Dono pergunta quanto tempo o prestador precisa — notifica prestador
4392| router.post('/reparos/:id/perguntar-tempo', autenticar, async (req, res) => {
4393|   try {
4394|     const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
4395|     if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
4396|     const r = reparo.rows[0]
4397| 
4398|     if (r.criado_por !== req.usuario.id) {
4399|       return res.status(403).json({ erro: 'Apenas o dono pode responder o pedido' })
4400|     }
4401| 
4402|     await pool.query(
4403|       `UPDATE reparos SET pedido_tempo_status = 'aguardando_minutos' WHERE id = $1`,
4404|       [req.params.id]
4405|     )
4406| 
4407|     // Notifica o prestador
4408|     const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
4409|     if (prestador.rows[0]?.push_token) {
4410|       await enviarPushNotificacao(
4411|         prestador.rows[0].push_token,
4412|         '⏱ Quanto tempo você precisa?',
4413|         'O solicitante quer saber quantos minutos a mais você precisa para chegar.',
4414|         { tipo: 'perguntar_tempo', reparo_id: req.params.id }
4415|       )
4416|     }
4417| 
4418|     res.json({ mensagem: 'Prestador notificado para informar o tempo.' })
4419|   } catch (err) {
4420|     res.status(500).json({ erro: 'Erro ao perguntar tempo' })
4421|   }
4422| })
4423| 
4424| // Prestador informa quantos minutos precisa — notifica dono para aceitar/recusar
4425| router.post('/reparos/:id/informar-tempo', autenticar, async (req, res) => {
4426|   try {
4427|     const { minutos } = req.body
4428|     if (!minutos || minutos <= 0) return res.status(400).json({ erro: 'Informe um tempo válido em minutos' })
4429| 
4430|     const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
4431|     if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
4432|     const r = reparo.rows[0]
4433| 
4434|     if (r.match_usuario_id !== req.usuario.id) {
4435|       return res.status(403).json({ erro: 'Apenas o prestador do match pode informar o tempo' })
4436|     }
4437| 
4438|     await pool.query(
4439|       `UPDATE reparos SET pedido_tempo_status = 'aguardando_aprovacao', pedido_tempo_minutos = $1 WHERE id = $2`,
4440|       [minutos, req.params.id]
4441|     )
4442| 
4443|     // Notifica o dono
4444|     const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.criado_por])
4445|     if (dono.rows[0]?.push_token) {
4446|       await enviarPushNotificacao(
4447|         dono.rows[0].push_token,
4448|         '⏳ Prestador precisa de mais tempo',
4449|         `Ele precisa de ${minutos} minuto(s) a mais. Aceitar ou recusar?`,
4450|         { tipo: 'aprovar_tempo', reparo_id: req.params.id }
4451|       )
4452|     }
4453| 
4454|     res.json({ mensagem: 'Dono notificado para aprovar o tempo.' })
4455|   } catch (err) {
4456|     res.status(500).json({ erro: 'Erro ao informar tempo' })
4457|   }
4458| })
4459| 
4460| // Dono aceita ou recusa o tempo extra
4461| router.post('/reparos/:id/responder-tempo', autenticar, async (req, res) => {
4462|   try {
4463|     const { aceito } = req.body
4464|     const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
4465|     if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
4466|     const r = reparo.rows[0]
4467| 
4468|     if (r.criado_por !== req.usuario.id) {
4469|       return res.status(403).json({ erro: 'Apenas o dono pode responder' })
4470|     }
4471| 
4472|     if (aceito) {
4473|       // Estende o cronômetro somando os minutos ao match_feito_em
4474|       const novoMatchFeitoEm = new Date(new Date(r.match_feito_em).getTime() + r.pedido_tempo_minutos * 60 * 1000)
4475|       await pool.query(
4476|         `UPDATE reparos SET match_feito_em = $1, pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL WHERE id = $2`,
4477|         [novoMatchFeitoEm.toISOString(), req.params.id]
4478|       )
4479| 
4480|       // Notifica prestador
4481|       const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
4482|       if (prestador.rows[0]?.push_token) {
4483|         await enviarPushNotificacao(
4484|           prestador.rows[0].push_token,
4485|           '✅ Tempo extra aceito!',
4486|           `O solicitante aceitou. Você tem mais ${r.pedido_tempo_minutos} minuto(s). Corra!`,
4487|           { tipo: 'tempo_aceito', reparo_id: req.params.id }
4488|         )
4489|       }
4490| 
4491|       res.json({ mensagem: 'Tempo extra concedido!', novo_match_feito_em: novoMatchFeitoEm })
4492|     } else {
4493|       // Recusou — bloqueia prestador e volta reparo para disponível.
4494|       // Mesmo CASE NULL-safe/idempotente dos outros quatro pontos de append (ver
4495|       // POST /obras/:id/expirar-match): array_append cru gravaria um NULL no array se o match
4496|       // já tivesse sido desfeito, e duplicaria o uuid numa rechamada.
4497|       // chegada_* zeradas — incluindo chegada_confirmada_em, pelo mesmo motivo explicado em
4498|       // POST /obras/:id/responder-tempo (este caminho não tem o guard que os outros têm).
4499|       await pool.query(
4500|         `WITH desfeito AS (
4501|            UPDATE reparos SET
4502|             match_feito_em = NULL,
4503|             match_usuario_id = NULL,
4504|             pedido_tempo_status = NULL,
4505|             pedido_tempo_motivo = NULL,
4506|             pedido_tempo_minutos = NULL,
4507|             chegada_janela = NULL,
4508|             chegada_prevista_em = NULL,
4509|             chegada_declarada_por = NULL,
4510|             chegada_declarada_em = NULL,
4511|             chegada_pendente_janela = NULL,
4512|             chegada_pendente_em = NULL,
4513|             chegada_recusada_em = NULL,
4514|             chegada_confirmada_em = NULL,
4515|             prestadores_bloqueados = CASE
4516|               WHEN $2::uuid IS NULL OR $2::uuid = ANY(COALESCE(prestadores_bloqueados, '{}'))
4517|               THEN prestadores_bloqueados
4518|               ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid) END
4519|            WHERE id = $1
4520|            RETURNING id
4521|          )
4522|          -- Interesse vencedor expira junto (D71 — paridade com POST /obras/:id/responder-tempo e
4523|          -- com os dois expirar-match): recusar o tempo extra é un-match como os outros, e sem
4524|          -- isto o serviço voltava ao feed com interesse_reparos_aceito_unico_idx ainda ocupado —
4525|          -- nenhum aceite novo passava (guard jaAceito → 409) e o próprio prestador bloqueado
4526|          -- ainda refazia o match sozinho por POST /reparos/:id/match, que só olha o 'aceito'.
4527|          UPDATE interesse_reparos SET status = 'expirado'
4528|           WHERE reparo_id IN (SELECT id FROM desfeito) AND usuario_id = $2::uuid AND status = 'aceito'`,
4529|         [req.params.id, r.match_usuario_id]
4530|       )
4531| 
4532|       // Notifica prestador
4533|       const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
4534|       if (prestador.rows[0]?.push_token) {
4535|         await enviarPushNotificacao(
4536|           prestador.rows[0].push_token,
4537|           '❌ Tempo extra recusado',
4538|           'O solicitante não aceitou. O serviço voltou para disponível.',
4539|           { tipo: 'tempo_recusado', reparo_id: req.params.id }
4540|         )
4541|       }
4542| 
4543|       res.json({ mensagem: 'Tempo recusado. Serviço disponível novamente.' })
4544|     }
4545|   } catch (err) {
4546|     res.status(500).json({ erro: 'Erro ao responder pedido de tempo' })
4547|   }
4548| })
4549| 
4550| // CORRIGIDO: aceita dono do reparo E prestador (não só prestador)
```

### src/routes/index.js:4551-4661 — GET /reparos/:id: gate de leitura, pode_estender_em, advisory

```js
4551| router.get('/reparos/:id', autenticar, async (req, res) => {
4552|   try {
4553|     // expirada: mesma expressão do GET /reparos/minhas — "expirado" não é status no banco,
4554|     // é um reparo NÃO encerrado cujo expira_em já passou. Calculado no SQL (relógio do
4555|     // servidor) para a tela de detalhe gatear o botão de estender sem comparar com o
4556|     // relógio do aparelho.
4557|     // pode_estender_em: instante a partir do qual POST /reparos/:id/estender para de recusar
4558|     // com 409. NULL = sem carência (faixa curta), pode estender já. Mesmas constantes do
4559|     // endpoint, então a regra não pode divergir do que ele enforça. Calculado no SQL, como
4560|     // `expirada`, para o app não depender do relógio do aparelho.
4561|     const result = await pool.query(
4562|       `SELECT *, (status <> 'encerrada' AND expira_em <= NOW()) AS expirada,
4563|               CASE WHEN prazo_atendimento_horas IS NULL OR prazo_atendimento_horas > $2::numeric
4564|                    THEN criado_em + ($3::numeric * INTERVAL '1 hour') END AS pode_estender_em
4565|          FROM reparos WHERE id = $1`,
4566|       [req.params.id, FAIXA_LONGA_REPARO_HORAS, CARENCIA_ESTENDER_REPARO_HORAS]
4567|     )
4568|     if (result.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
4569| 
4570|     const reparo = result.rows[0]
4571|     const ehDono           = reparo.criado_por === req.usuario.id
4572|     const ehPrestadorDoMatch = reparo.match_usuario_id === req.usuario.id
4573| 
4574|     // Dono sempre pode ver seu próprio reparo
4575|     // Prestador do match sempre pode ver
4576|     // Admin sempre pode ver
4577|     // Prestador comum precisa de assinatura ativa
4578|     if (!ehDono && !ehPrestadorDoMatch && req.usuario.role !== 'admin') {
4579|       if (req.usuario.role !== 'prestador') {
4580|         return res.status(403).json({ erro: 'Sem permissão para ver este serviço' })
4581|       }
4582|       const assinatura = await pool.query(
4583|         `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' AND (proximo_vencimento IS NULL OR proximo_vencimento > NOW()) LIMIT 1`,
4584|         [req.usuario.id]
4585|       )
4586|       if (assinatura.rows.length === 0) {
4587|         return res.status(403).json({ erro: 'Assinatura inativa. Renove seu plano para acessar os serviços.' })
4588|       }
4589|     }
4590| 
4591|     const midias    = await pool.query(`SELECT * FROM midias_reparos WHERE reparo_id = $1 ORDER BY ordem`, [req.params.id])
4592|     const interesse = await pool.query(
4593|       `SELECT id, status, valor_proposto, valor_contraproposta, rodada FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2`,
4594|       [req.params.id, req.usuario.id]
4595|     )
4596| 
4597|     // Se for dono ou admin, busca lista de interessados
4598|     let interessados = []
4599|     if (ehDono || req.usuario.role === 'admin') {
4600|       const result2 = await pool.query(
4601|         // Contato/endereço do prestador são revelados ao dono APENAS após o match
4602|         // (reparos.match_usuario_id aponta para o prestador que confirmou a ida), e
4603|         // só para o prestador efetivamente casado — nunca no mero aceite (status='aceito').
4604|         // EXCEÇÃO: bairro sai para todos os interessados, junto de cidade — mesma regra do
4605|         // lado obra. logradouro, numero e telefone continuam match-gated.
4606|         `SELECT ir.id, ir.usuario_id, ir.status, ir.mensagem, ir.criado_em,
4607|                 ir.valor_proposto, ir.valor_contraproposta, ir.rodada,
4608|                 u.nome, u.cidade, u.bairro, u.foto_url, u.anos_experiencia, u.especialidades, u.tamanho_equipe,
4609|                 CASE WHEN ir.usuario_id = $2 THEN u.logradouro ELSE NULL END as logradouro,
4610|                 CASE WHEN ir.usuario_id = $2 THEN u.numero ELSE NULL END as numero,
4611|                 CASE WHEN ir.usuario_id = $2 THEN u.telefone ELSE NULL END as telefone,
4612|                 (SELECT COUNT(*)::int FROM avaliacoes a WHERE a.avaliado_id = ir.usuario_id) AS avaliacoes_total,
4613|                 (SELECT COALESCE(ROUND(AVG(a.estrelas)::numeric, 1), 0) FROM avaliacoes a WHERE a.avaliado_id = ir.usuario_id) AS avaliacoes_media
4614|          FROM interesse_reparos ir
4615|          JOIN usuarios u ON ir.usuario_id = u.id
4616|          WHERE ir.reparo_id = $1
4617|          ORDER BY ir.criado_em ASC`,
4618|         [req.params.id, reparo.match_usuario_id]
4619|       )
4620|       interessados = result2.rows
4621|     }
4622| 
4623|     // Aceite do próprio requester. Procura a linha 'aceito' EXPLICITAMENTE em vez de
4624|     // olhar rows[0]: a query de meu_interesse não tem ORDER BY/LIMIT, então rows[0]
4625|     // é arbitrário e poderia ser um interesse recusado do mesmo reparo.
4626|     const meuAceite = interesse.rows.find(i => i.status === 'aceito')
4627| 
4628|     // Endereço exato e ponto de referência só para dono, prestador do match, prestador com
4629|     // interesse aceito ou admin (Finding 3.1). ponto_referencia sai junto pelo mesmo motivo
4630|     // do lado obra: é dica de localização, não descrição do serviço.
4631|     // Coordenadas permanecem para o cálculo de distância no cliente.
4632|     if (reparo.criado_por !== req.usuario.id && reparo.match_usuario_id !== req.usuario.id && !meuAceite && req.usuario.role !== 'admin') {
4633|       delete reparo.endereco_reparo
4634|       delete reparo.ponto_referencia
4635|     }
4636| 
4637|     // Advisory plano: /reparos/:id/estender não tem mais teto (o de 2x saiu), então não há
4638|     // orçamento a calcular — nem âncora, nem janela. O campo continua só porque o app filtra
4639|     // as opções por ele (ModalEstenderPrazo); a MESMA constante do endpoint, para os dois
4640|     // números não divergirem. NÃO reflete a carência de 1h das faixas longas: dentro da
4641|     // primeira hora o app ainda oferece opções que o endpoint recusa com 409.
4642|     // D89: regra única (restanteExtensao), a mesma de GET /obras/:id e dos dois endpoints.
4643|     const extensao_maxima_horas = restanteExtensao(ADVISORY_ESTENDER_REPARO_HORAS, reparo.criado_em, reparo.prazo_atendimento_horas, reparo.expira_em)
4644|     res.json({
4645|       reparo,
4646|       midias: midias.rows,
4647|       meu_interesse: interesse.rows[0] || null,
4648|       interessados,
4649|       extensao_maxima_horas,
4650|       pode_estender_em: reparo.pode_estender_em,
4651|     })
4652| 
4653|     // Contador de visitas em memória (mesmo racional do GET /obras/:id).
4654|     // Só conta visita se for prestador (não dono consultando o próprio reparo).
4655|     if (!ehDono) registrarVisita('reparos', req.params.id)
4656|   } catch (err) {
4657|     console.error('Erro ao buscar reparo:', err)
4658|     res.status(500).json({ erro: 'Erro ao buscar serviço' })
4659|   }
4660| })
4661| 
```


## 6. Compartilhado — concorrentes, avaliação, denúncia, painel, suspensos

### src/utils/rejeitarConcorrentes.js:1-62 — Recusa os concorrentes ao fechar o match (obra e reparo)

```js
 1| const { pool } = require('./supabase')
 2| const { enviarPushNotificacao } = require('../services/alertaService')
 3| 
 4| // Recusa as demais candidaturas/interesses da demanda e notifica os perdedores.
 5| //
 6| // Extraído dos dois handlers de /match, onde era código duplicado e onde CONTINUA rodando
 7| // (linhas legadas: demandas casadas antes do aceite passar a criar o match). Como hoje o
 8| // aceite já define match_usuario_id, /match sai no early-return idempotente e não varreria
 9| // mais nada — por isso os cinco caminhos de aceite também chamam esta função.
10| //
11| // Idempotente por construção: o filtro status NOT IN ('recusado','expirado') faz a segunda
12| // execução não retornar linha nenhuma, então ninguém recebe push repetido.
13| const CONFIG = {
14|   obra: {
15|     tabela:       'candidaturas',
16|     coluna:       'obra_id',
17|     mensagem:     'O solicitante escolheu outro profissional para esta obra.',
18|     tipo:         'candidatura_recusada',
19|     chavePayload: 'obra_id'
20|   },
21|   reparo: {
22|     tabela:       'interesse_reparos',
23|     coluna:       'reparo_id',
24|     mensagem:     'O solicitante escolheu outro prestador para este serviço.',
25|     tipo:         'interesse_recusado',
26|     chavePayload: 'reparo_id'
27|   }
28| }
29| 
30| // Retorna quantos foram recusados. Nunca lança para o chamador em fluxo normal — os
31| // chamadores usam .catch() e o efeito é secundário à resposta já enviada ao cliente.
32| const rejeitarConcorrentes = async (tipoDemanda, demandaId, vencedorUsuarioId) => {
33|   const cfg = CONFIG[tipoDemanda]
34|   if (!cfg) throw new Error(`rejeitarConcorrentes: tipoDemanda inválido "${tipoDemanda}"`)
35| 
36|   // tabela/coluna saem do CONFIG acima (whitelist fechada), nunca do request —
37|   // a interpolação no SQL é segura pelo mesmo motivo do POST /avaliacoes.
38|   const rejeitados = await pool.query(
39|     `UPDATE ${cfg.tabela} SET status = 'recusado'
40|      WHERE ${cfg.coluna} = $1 AND usuario_id != $2 AND status NOT IN ('recusado', 'expirado')
41|      RETURNING usuario_id`,
42|     [demandaId, vencedorUsuarioId]
43|   )
44|   const ids = rejeitados.rows.map(r => r.usuario_id)
45|   if (ids.length === 0) return 0
46| 
47|   const tokens = await pool.query(
48|     `SELECT push_token FROM usuarios WHERE id = ANY($1) AND push_token IS NOT NULL`,
49|     [ids]
50|   )
51|   tokens.rows.forEach(r => {
52|     enviarPushNotificacao(
53|       r.push_token,
54|       '❌ Outro profissional foi selecionado',
55|       cfg.mensagem,
56|       { tipo: cfg.tipo, [cfg.chavePayload]: demandaId }
57|     ).catch(() => {})
58|   })
59|   return ids.length
60| }
61| 
62| module.exports = { rejeitarConcorrentes }
```

### src/utils/faixasPrazo.js:1-164 — Faixas de prazo, marcos, extensões, fim do dia por zona

```js
  1| // Tabela de faixas de prazo (tiers) das demandas — dicionário compartilhado.
  2| //
  3| // Cada demanda (reparo: prazo_atendimento_horas | obra: horas_para_expirar) cai em uma das 6
  4| // faixas fixas abaixo. Esta tabela é a ÚNICA fonte de verdade para:
  5| //   - os 3 marcos de expiração (offsets em MINUTOS antes de expira_em); o job dispara o marco N
  6| //     quando (expira_em - now) <= offset_N;
  7| //   - as opções de estender oferecidas para aquela faixa.
  8| //
  9| // Opções de estender:
 10| //   tipo 'add' → soma `horas` ao expira_em atual (a faixa NÃO muda).
 11| //   tipo 'set' → define expira_em = now + `horas` (a demanda passa a ser aquela nova faixa).
 12| //
 13| // MÓDULO INERTE: dados puros + um helper de lookup. Não importa nada, sem efeitos colaterais.
 14| // Ainda NÃO é consumido por ninguém — os consumidores (job, estender, detalhe) entram em passos
 15| // seguintes.
 16| 
 17| const FAIXAS = {
 18|   1: {
 19|     windowHours: 1,
 20|     milestones: [15, 10, 5],
 21|     extend: [
 22|       { label: '+1h',    tipo: 'add', horas: 1 },
 23|       { label: '+2h',    tipo: 'add', horas: 2 },
 24|       { label: 'amanhã', tipo: 'set', horas: 24 },
 25|     ],
 26|   },
 27|   2: {
 28|     windowHours: 2,
 29|     milestones: [30, 15, 10],
 30|     extend: [
 31|       { label: '+2h',    tipo: 'add', horas: 2 },
 32|       { label: '+4h',    tipo: 'add', horas: 4 },
 33|       { label: 'amanhã', tipo: 'set', horas: 24 },
 34|     ],
 35|   },
 36|   4: {
 37|     windowHours: 4,
 38|     milestones: [60, 30, 15],
 39|     extend: [
 40|       { label: '+4h',    tipo: 'add', horas: 4 },
 41|       { label: '+8h',    tipo: 'add', horas: 8 },
 42|       { label: 'amanhã', tipo: 'set', horas: 24 },
 43|     ],
 44|   },
 45|   8: {
 46|     windowHours: 8,
 47|     milestones: [120, 60, 30],
 48|     extend: [
 49|       { label: '+4h',    tipo: 'add', horas: 4 },
 50|       { label: '+8h',    tipo: 'add', horas: 8 },
 51|       { label: 'amanhã', tipo: 'set', horas: 24 },
 52|     ],
 53|   },
 54|   24: {
 55|     windowHours: 24,
 56|     milestones: [120, 90, 30],
 57|     extend: [
 58|       { label: '+8h',          tipo: 'add', horas: 8 },
 59|       { label: '+1 dia',       tipo: 'set', horas: 24 },
 60|       { label: 'esta semana',  tipo: 'set', horas: 168 },
 61|     ],
 62|   },
 63|   168: {
 64|     windowHours: 168,
 65|     milestones: [1440, 480, 240],
 66|     extend: [
 67|       { label: '+1 dia',    tipo: 'add', horas: 24 },
 68|       { label: '+1 semana', tipo: 'set', horas: 168 },
 69|     ],
 70|   },
 71| }
 72| 
 73| // Chaves em ordem crescente, derivadas de FAIXAS (não uma segunda lista a manter em sincronia).
 74| const CHAVES_ORDENADAS = Object.keys(FAIXAS).map(Number).sort((a, b) => a - b)
 75| 
 76| // getFaixa(windowHours) → entrada da faixa para a janela dada.
 77| // Match exato em {1,2,4,8,24,168}; fora disso, cai na MAIOR faixa que não excede a janela —
 78| // 72 → 24, 720/1440/2160 → 168, e o mesmo para as horas arbitrárias que o estender aceita.
 79| // Antes o match era exato e todo o resto voltava null, então demanda fora de faixa (inclusive
 80| // o default de 720h de quem cadastra sem prazo) nunca recebia marco nenhum.
 81| // Continua null quando não há faixa aplicável: janela < 1 (0 vem de NULL/'' via Number),
 82| // negativa, NaN, Infinity ou string não-numérica. O chamador já trata esse null com log.
 83| const getFaixa = (windowHours) => {
 84|   const horas = Number(windowHours)
 85|   if (!Number.isFinite(horas)) return null
 86|   let escolhida = null
 87|   for (const chave of CHAVES_ORDENADAS) {
 88|     if (chave > horas) break
 89|     escolhida = FAIXAS[chave]
 90|   }
 91|   return escolhida
 92| }
 93| 
 94| // ============================================================
 95| // FAIXA "HOJE" — prazo que vence no FIM DO DIA, não N horas depois
 96| // ============================================================
 97| // As faixas acima são todas DURAÇÕES: expira_em = publicação + windowHours. "Hoje" não é uma
 98| // duração — é um INSTANTE do calendário (o fim do dia corrente em Brasília), então não cabe na
 99| // tabela e precisa de um marcador próprio, gravado em obras.prazo_modo / reparos.prazo_modo.
100| //
101| // Por que um marcador em coluna, e não um valor sentinela em horas_para_expirar/
102| // prazo_atendimento_horas: essas colunas são lidas por getFaixa (marcos), pelo predicado dos
103| // dois crons (`IS NOT NULL`) e pela carência do estender. Um sentinela (0, -1) as
104| // atravessaria todas com significado errado. NULL em prazo_modo = faixa por duração, o
105| // comportamento de sempre.
106| const PRAZO_MODO_HOJE = 'hoje'
107| 
108| // Fuso de recuo quando o cliente não manda zona, manda algo malformado, ou manda uma zona que
109| // o Postgres não conhece. Era o valor fixo da primeira versão desta regra.
110| const TZ_PADRAO = 'America/Sao_Paulo'
111| 
112| // Fim do dia CORRENTE às 23:59:59.999999 NA ZONA DADA, como timestamptz.
113| // `zonaSql` é um TRECHO DE SQL que resolve para o nome da zona — um placeholder ($21::text) no
114| // create, ou uma expressão de coluna (COALESCE(prazo_timezone, ...)) nos caminhos que
115| // reconstroem. Nunca o nome da zona interpolado: o valor vem do cliente e entra como PARÂMETRO.
116| //
117| // Modelado em SQL_FIM_DO_MES_SP (src/routes/index.js), trocando 'month' por 'day': os dois
118| // AT TIME ZONE fazem coisas OPOSTAS e é isso que faz a conta fechar num banco UTC —
119| //   1º (timestamptz → timestamp) TIRA o fuso e devolve o relógio de parede LOCAL, para o
120| //      date_trunc cortar o dia do USUÁRIO;
121| //   2º (timestamp → timestamptz) RECOLOCA o fuso e devolve o instante UTC a gravar.
122| // Sem isso, 19/08 22:00 em SP já é 20/08 01:00 em UTC e o truncamento cairia um dia adiante —
123| // exatamente o erro que o comentário de JANELAS_CHEGADA descreve para o `new Date()` do
124| // container. Por isso a expressão é resolvida no Postgres, nunca no Node.
125| // SEM PISO: publicar 23:58 dá dois minutos de prazo, e é essa a regra pedida.
126| const sqlFimDoDia = (zonaSql) => `(
127|         date_trunc('day', (NOW() AT TIME ZONE ${zonaSql}))
128|         + INTERVAL '1 day' - INTERVAL '1 microsecond'
129|       ) AT TIME ZONE ${zonaSql}`
130| 
131| // Forma da primeira versão, fixa em São Paulo. Continua em uso no lado REPARO, que não tem
132| // faixa "Hoje" e cujo cliente não manda zona — ali prazo_modo é sempre NULL e o ramo nunca
133| // dispara, então não há o que parametrizar.
134| const SQL_FIM_DO_DIA_SP = sqlFimDoDia(`'${TZ_PADRAO}'`)
135| 
136| // Forma de nome IANA: exige ao menos uma barra (Region/City), aceita os níveis extras de
137| // America/Argentina/Buenos_Aires e os sinais de Etc/GMT+3. É só uma triagem de FORMATO —
138| // quem decide se a zona EXISTE é o Postgres, via pg_timezone_names.
139| const FORMATO_ZONA_IANA = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/
140| 
141| // Zona GRAVADA na linha, resolvida com segurança, para os caminhos que RECONSTROEM expira_em.
142| // `colunaQualificada` é a coluna da linha sendo atualizada (ex.: 'obras.prazo_timezone').
143| //
144| // A validação de create não basta aqui. Uma zona aceita hoje pode deixar de ser reconhecida
145| // depois — upgrade do Postgres que remove um link renomeado (Europe/Kiev → Europe/Kyiv), poda
146| // do tzdata, ou edição manual da linha. Consumida direta, `NOW() AT TIME ZONE <zona morta>`
147| // levanta SQLSTATE 22023 (time zone not recognized), e como os dois caminhos atualizam um LOTE
148| // num único statement, UMA linha ruim abortava o UPDATE INTEIRO: nenhuma obra do lote voltava
149| // ao feed, e o try/catch do cron transformava isso numa linha de log a cada minuto.
150| //
151| // O LEFT-lookup em pg_timezone_names torna a resolução POR LINHA e sem exceção: zona ausente
152| // do catálogo não devolve linha, o COALESCE cai no padrão, e as demais linhas do lote seguem.
153| // Também absorve o caso NULL (`= NULL` não casa nada), então substitui o COALESCE anterior.
154| //
155| // Custo: pg_timezone_names é uma função que enumera o tzdata (~500 linhas) a cada avaliação, e
156| // a expressão da zona aparece duas vezes no fim-do-dia — ou seja, 2 varreduras por linha do
157| // lote. Os lotes aqui são de obras que acabaram de expirar (unidades, não milhares), e o ramo
158| // só é avaliado quando prazo_modo = 'hoje'. Se um dia isso pesar, o passo seguinte é
159| // materializar o catálogo num CTE do próprio statement — não voltar a confiar na coluna crua.
160| const sqlZonaSegura = (colunaQualificada) => `COALESCE(
161|         (SELECT tz.name FROM pg_timezone_names tz WHERE tz.name = ${colunaQualificada}),
162|         '${TZ_PADRAO}')`
163| 
164| module.exports = { FAIXAS, getFaixa, PRAZO_MODO_HOJE, TZ_PADRAO, sqlFimDoDia, SQL_FIM_DO_DIA_SP, FORMATO_ZONA_IANA, sqlZonaSegura }
```

### src/routes/index.js:5481-5660 — Avaliações (por contrato_tipo), dispensar, média, recebidas

```js
5481| router.post('/avaliacoes', autenticar, async (req, res) => {
5482|   try {
5483|     const { contrato_tipo, contrato_id, estrelas } = req.body
5484| 
5485|     if (!['reparo', 'obra'].includes(contrato_tipo)) {
5486|       return res.status(400).json({ erro: 'contrato_tipo deve ser reparo ou obra' })
5487|     }
5488|     const estrelasInt = parseInt(estrelas)
5489|     if (!estrelasInt || estrelasInt < 1 || estrelasInt > 5) {
5490|       return res.status(400).json({ erro: 'estrelas deve ser um número de 1 a 5' })
5491|     }
5492|     if (!contrato_id) {
5493|       return res.status(400).json({ erro: 'contrato_id é obrigatório' })
5494|     }
5495| 
5496|     // contrato_tipo já validado contra whitelist acima — interpolação de tabela é segura.
5497|     const tabela = contrato_tipo === 'reparo' ? 'reparos' : 'obras'
5498|     const contrato = await pool.query(
5499|       `SELECT criado_por, match_usuario_id, status FROM ${tabela} WHERE id = $1`,
5500|       [contrato_id]
5501|     )
5502|     if (contrato.rows.length === 0) return res.status(404).json({ erro: 'Contrato não encontrado' })
5503| 
5504|     const c = contrato.rows[0]
5505|     if (c.status !== 'encerrada') {
5506|       return res.status(400).json({ erro: 'Só é possível avaliar contratos encerrados' })
5507|     }
5508|     if (!c.match_usuario_id) {
5509|       return res.status(400).json({ erro: 'Este contrato não teve prestador vinculado' })
5510|     }
5511| 
5512|     // Avaliação é UNILATERAL: só o dono do contrato (criado_por) avalia o prestador do
5513|     // match. O prestador continua participante para todo o resto, mas não avalia de volta.
5514|     // Ordem das branches preserva a precedência do dono caso uid seja os dois lados.
5515|     const uid = req.usuario.id
5516|     let avaliado_id
5517|     if (uid === c.criado_por) {
5518|       avaliado_id = c.match_usuario_id       // dono avalia prestador
5519|     } else if (uid === c.match_usuario_id) {
5520|       return res.status(403).json({ erro: 'Apenas o dono do contrato pode avaliar' })
5521|     } else {
5522|       return res.status(403).json({ erro: 'Você não participou deste contrato' })
5523|     }
5524| 
5525|     const result = await pool.query(
5526|       `INSERT INTO avaliacoes (contrato_tipo, contrato_id, avaliador_id, avaliado_id, estrelas)
5527|        VALUES ($1, $2, $3, $4, $5)
5528|        ON CONFLICT (contrato_tipo, contrato_id, avaliador_id) DO NOTHING
5529|        RETURNING id`,
5530|       [contrato_tipo, contrato_id, uid, avaliado_id, estrelasInt]
5531|     )
5532|     if (result.rows.length === 0) {
5533|       return res.status(409).json({ erro: 'Você já avaliou este contrato' })
5534|     }
5535| 
5536|     res.status(201).json({ mensagem: 'Avaliação registrada!', id: result.rows[0].id })
5537|   } catch (err) {
5538|     console.error('[Avaliacoes] Erro:', err.message)
5539|     res.status(500).json({ erro: 'Erro ao registrar avaliação' })
5540|   }
5541| })
5542| 
5543| // POST /avaliacoes/dispensar — o dono declara que NÃO vai avaliar este contrato, e o
5544| // lembrete do job (lembrarAvaliacaoPendente, server.js) para de vez.
5545| // Existe porque a recusa só era guardada NO DISPOSITIVO: o servidor não sabia dela, então o
5546| // push cutucaria quem já tinha dito não — e uma reinstalação (ou um segundo aparelho)
5547| // ressuscitaria o card. Agora a escolha é do CONTRATO, não do aparelho.
5548| // Rota estática registrada depois de POST /avaliacoes e sem colisão com ela.
5549| // Escopo: só o dono (criado_por). O prestador não avalia (POST /avaliacoes lhe dá 403), então
5550| // também não tem o que dispensar — mesmas branches, mesma precedência, mesmos códigos.
5551| router.post('/avaliacoes/dispensar', autenticar, async (req, res) => {
5552|   try {
5553|     const { contrato_tipo, contrato_id } = req.body
5554| 
5555|     if (!['reparo', 'obra'].includes(contrato_tipo)) {
5556|       return res.status(400).json({ erro: 'contrato_tipo deve ser reparo ou obra' })
5557|     }
5558|     if (!contrato_id) {
5559|       return res.status(400).json({ erro: 'contrato_id é obrigatório' })
5560|     }
5561| 
5562|     // contrato_tipo já validado contra whitelist acima — interpolação de tabela é segura.
5563|     const tabela = contrato_tipo === 'reparo' ? 'reparos' : 'obras'
5564| 
5565|     // Ownership NO PRÓPRIO UPDATE (criado_por = $2), não numa checagem separada antes: o
5566|     // handler não tem por que ler a linha duas vezes, e o RETURNING já diz se pegou.
5567|     // aval_dispensada_em IS NULL preserva o PRIMEIRO timestamp — chamar de novo é no-op, não
5568|     // um carimbo novo. Sem status/match no WHERE de propósito: dispensar é sempre seguro, e
5569|     // amarrar a dispensa ao estado do contrato só criaria um caminho em que o dono clica
5570|     // "não quero" e mesmo assim continua elegível.
5571|     const upd = await pool.query(
5572|       `UPDATE ${tabela} SET aval_dispensada_em = NOW()
5573|         WHERE id = $1 AND criado_por = $2 AND aval_dispensada_em IS NULL
5574|        RETURNING id`,
5575|       [contrato_id, req.usuario.id]
5576|     )
5577|     if (upd.rowCount > 0) {
5578|       return res.json({ mensagem: 'Lembrete de avaliação dispensado.', dispensada: true })
5579|     }
5580| 
5581|     // rowCount 0 tem três causas — separadas aqui para não devolver 404 a quem só repetiu a
5582|     // chamada. Uma leitura só, e apenas neste caminho frio.
5583|     const c = await pool.query(`SELECT criado_por, aval_dispensada_em FROM ${tabela} WHERE id = $1`, [contrato_id])
5584|     if (c.rows.length === 0) return res.status(404).json({ erro: 'Contrato não encontrado' })
5585|     if (c.rows[0].criado_por !== req.usuario.id) {
5586|       return res.status(403).json({ erro: 'Apenas o dono do contrato pode dispensar a avaliação' })
5587|     }
5588|     // Já dispensado antes: idempotente, 200 — repetir a recusa não é erro.
5589|     res.json({ mensagem: 'Lembrete de avaliação já estava dispensado.', dispensada: true })
5590|   } catch (err) {
5591|     console.error('[Avaliacoes] Erro ao dispensar:', err.message)
5592|     res.status(500).json({ erro: 'Erro ao dispensar lembrete de avaliação' })
5593|   }
5594| })
5595| 
5596| // GET /avaliacoes/media/:usuario_id — média e total de estrelas recebidas por um usuário.
5597| router.get('/avaliacoes/media/:usuario_id', autenticar, async (req, res) => {
5598|   try {
5599|     const result = await pool.query(
5600|       `SELECT COUNT(*)::int AS total, COALESCE(ROUND(AVG(estrelas)::numeric, 1), 0) AS media
5601|        FROM avaliacoes WHERE avaliado_id = $1`,
5602|       [req.params.usuario_id]
5603|     )
5604|     res.json({ total: result.rows[0].total, media: parseFloat(result.rows[0].media) })
5605|   } catch (err) {
5606|     console.error('[Avaliacoes] Erro média:', err.message)
5607|     res.status(500).json({ erro: 'Erro ao buscar avaliações' })
5608|   }
5609| })
5610| 
5611| // GET /avaliacoes/recebidas — resumo das avaliações RECEBIDAS pelo usuário autenticado
5612| // (avaliado_id = req.usuario.id): média, total e a distribuição por estrela. Não devolve mais
5613| // as avaliações uma a uma — nada do avaliador jamais foi exposto aqui, e agora nem a linha
5614| // individual é; só contagens agregadas. Rota estática — registrada depois de
5615| // '/avaliacoes/media/:usuario_id' e não colide com ela (segmento 'recebidas' != 'media').
5616| router.get('/avaliacoes/recebidas', autenticar, async (req, res) => {
5617|   try {
5618|     const uid = req.usuario.id
5619| 
5620|     // Resumo (média + total + distribuição): computado on-read — não há coluna cacheada em
5621|     // usuarios. media/total seguem idênticos a GET /avaliacoes/media/:usuario_id acima (mesmo
5622|     // ROUND para 1 casa, mesmo COALESCE 0 para quem ainda não tem avaliação).
5623|     // Query ÚNICA: os cinco contadores são agregados condicionais na MESMA linha de
5624|     // total/media — o FILTER percorre as linhas já varridas pelo COUNT/AVG, sem I/O extra e
5625|     // sem uma segunda ida ao banco (índice avaliacoes_avaliado_idx cobre o WHERE).
5626|     // COUNT(*) FILTER nunca é NULL — é 0 quando nada casa —, então as cinco chaves existem
5627|     // sempre, zero-preenchidas. Somam total porque estrelas é INTEGER NOT NULL
5628|     // CHECK (estrelas BETWEEN 1 AND 5): não há bucket possível fora de 1..5, nem NULL.
5629|     const resumo = await pool.query(
5630|       `SELECT COUNT(*)::int AS total,
5631|               COALESCE(ROUND(AVG(estrelas)::numeric, 1), 0) AS media,
5632|               COUNT(*) FILTER (WHERE estrelas = 1)::int AS e1,
5633|               COUNT(*) FILTER (WHERE estrelas = 2)::int AS e2,
5634|               COUNT(*) FILTER (WHERE estrelas = 3)::int AS e3,
5635|               COUNT(*) FILTER (WHERE estrelas = 4)::int AS e4,
5636|               COUNT(*) FILTER (WHERE estrelas = 5)::int AS e5
5637|        FROM avaliacoes WHERE avaliado_id = $1`,
5638|       [uid]
5639|     )
5640| 
5641|     // Agregado sem GROUP BY sempre devolve exatamente uma linha, inclusive para quem não tem
5642|     // nenhuma avaliação (total 0, media 0, cinco contadores 0) — rows[0] nunca é undefined.
5643|     const r = resumo.rows[0]
5644|     res.json({
5645|       media: parseFloat(r.media),
5646|       total: r.total,
5647|       distribuicao: { '1': r.e1, '2': r.e2, '3': r.e3, '4': r.e4, '5': r.e5 }
5648|     })
5649|   } catch (err) {
5650|     console.error('[Avaliacoes] Erro recebidas:', err.message)
5651|     res.status(500).json({ erro: 'Erro ao buscar avaliações recebidas' })
5652|   }
5653| })
5654| 
5655| // DENÚNCIAS — o prestador do match denuncia o dono de um contrato encerrado.
5656| // Rota estática ('/denuncias'), sem conflito com padrões /:id, mesma convenção de
5657| // registro dedicado usada por avaliacoes.
5658| const CATEGORIAS_DENUNCIA = ['nao_pagamento', 'nao_compareceu', 'servico_diferente', 'assedio', 'local_inseguro', 'fraude', 'outro']
5659| const DESCRICAO_DENUNCIA_MAX = 2000
5660| 
```

### src/routes/index.js:5663-5735 — Denúncias

```js
5663| router.post('/denuncias', autenticar, async (req, res) => {
5664|   try {
5665|     const { contrato_tipo, contrato_id, categoria, descricao } = req.body
5666| 
5667|     if (!['reparo', 'obra'].includes(contrato_tipo)) {
5668|       return res.status(400).json({ erro: 'contrato_tipo deve ser reparo ou obra' })
5669|     }
5670|     if (!contrato_id) {
5671|       return res.status(400).json({ erro: 'contrato_id é obrigatório' })
5672|     }
5673|     if (!CATEGORIAS_DENUNCIA.includes(categoria)) {
5674|       return res.status(400).json({ erro: `categoria deve ser uma de: ${CATEGORIAS_DENUNCIA.join(', ')}` })
5675|     }
5676|     // Texto livre é o único campo aberto da tabela: exigir conteúdo e limitar tamanho aqui,
5677|     // já que o CHECK da coluna só garante NOT NULL.
5678|     const texto = typeof descricao === 'string' ? descricao.trim() : ''
5679|     if (!texto) {
5680|       return res.status(400).json({ erro: 'descricao é obrigatória' })
5681|     }
5682|     if (texto.length > DESCRICAO_DENUNCIA_MAX) {
5683|       return res.status(400).json({ erro: `descricao deve ter no máximo ${DESCRICAO_DENUNCIA_MAX} caracteres` })
5684|     }
5685| 
5686|     // contrato_tipo já validado contra whitelist acima — interpolação de tabela é segura.
5687|     const tabela = contrato_tipo === 'reparo' ? 'reparos' : 'obras'
5688|     const contrato = await pool.query(
5689|       `SELECT criado_por, match_usuario_id, status FROM ${tabela} WHERE id = $1`,
5690|       [contrato_id]
5691|     )
5692|     if (contrato.rows.length === 0) return res.status(404).json({ erro: 'Contrato não encontrado' })
5693| 
5694|     const c = contrato.rows[0]
5695|     if (c.status !== 'encerrada') {
5696|       return res.status(400).json({ erro: 'Só é possível denunciar contratos encerrados' })
5697|     }
5698|     if (!c.match_usuario_id) {
5699|       return res.status(400).json({ erro: 'Este contrato não teve prestador vinculado' })
5700|     }
5701| 
5702|     // Inverso da avaliação: só o prestador do match denuncia, e o denunciado é o dono.
5703|     const uid = req.usuario.id
5704|     if (uid !== c.match_usuario_id) {
5705|       if (uid === c.criado_por) {
5706|         return res.status(403).json({ erro: 'Apenas o profissional do contrato pode denunciar' })
5707|       }
5708|       return res.status(403).json({ erro: 'Você não participou deste contrato' })
5709|     }
5710| 
5711|     const result = await pool.query(
5712|       `INSERT INTO denuncias (contrato_tipo, contrato_id, denunciante_id, denunciado_id, categoria, descricao)
5713|        VALUES ($1, $2, $3, $4, $5, $6)
5714|        ON CONFLICT (contrato_tipo, contrato_id, denunciante_id) DO NOTHING
5715|        RETURNING id`,
5716|       [contrato_tipo, contrato_id, uid, c.criado_por, categoria, texto]
5717|     )
5718|     if (result.rows.length === 0) {
5719|       return res.status(409).json({ erro: 'Você já denunciou este contrato' })
5720|     }
5721| 
5722|     res.status(201).json({ mensagem: 'Denúncia registrada. Nossa equipe vai analisar.', id: result.rows[0].id })
5723|   } catch (err) {
5724|     console.error('[Denuncias] Erro:', err.message)
5725|     res.status(500).json({ erro: 'Erro ao registrar denúncia' })
5726|   }
5727| })
5728| 
5729| // SUGESTÕES — caixa de sugestões do usuário sobre o app.
5730| 
5731| const TEXTO_SUGESTAO_MAX = 2000
5732| 
5733| // POST /sugestoes — registra uma sugestão do usuário autenticado.
5734| // Autenticada com `autenticar`, o MESMO middleware de POST /denuncias: o autor sai de
5735| // req.usuario.id e nunca do corpo, então não há como sugerir em nome de outro.
```

### src/routes/index.js:5913-5961 — Dashboard do painel

```js
5913| router.get('/dashboard', autenticar, exigirAdmin, async (req, res) => {
5914|   try {
5915|     const [obras, assinaturas, candidaturas, interesses, obrasAprovacao, reparosAprovacao, reparos, mensagensPendentes] = await Promise.all([
5916|       pool.query(`SELECT COUNT(*) FROM obras WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()`),
5917|       // Métricas de assinaturas em uma única passagem:
5918|       // - ativos: todas as assinaturas ativas
5919|       // - gratuitos: ativas marcadas como gratuito OU sem valor mensal
5920|       // - receita: soma do valor_mensal apenas dos pagantes (exclui gratuitos e valor 0)
5921|       pool.query(`
5922|         SELECT
5923|           COUNT(*) FILTER (WHERE status = 'ativa') AS ativos,
5924|           COUNT(*) FILTER (WHERE status = 'ativa' AND (tipo = 'gratuito' OR valor_mensal = 0)) AS gratuitos,
5925|           COALESCE(SUM(valor_mensal) FILTER (
5926|             WHERE status = 'ativa' AND tipo IS DISTINCT FROM 'gratuito' AND valor_mensal > 0
5927|           ), 0) AS receita
5928|         FROM assinaturas
5929|       `),
5930|       pool.query(`SELECT COUNT(*) FROM candidaturas WHERE status = 'pendente'`),
5931|       // D84: propostas pendentes do lado reparo nunca entravam no painel — só candidaturas
5932|       // (obra) eram contadas, então o admin via 0 com interesses esperando resposta.
5933|       pool.query(`SELECT COUNT(*) FROM interesse_reparos WHERE status = 'pendente'`),
5934|       pool.query(`SELECT COUNT(*) FROM obras WHERE enviada_por_dono = true AND status_aprovacao = 'pendente'`),
5935|       pool.query(`SELECT COUNT(*) FROM reparos WHERE status_aprovacao = 'pendente'`),
5936|       pool.query(`SELECT COUNT(*) FROM reparos WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()`),
5937|       pool.query(`SELECT COUNT(*) FROM mensagens WHERE respondido = false`)
5938|     ])
5939|     const assinRow = assinaturas.rows[0]
5940|     res.json({
5941|       obras_abertas: parseInt(obras.rows[0].count),
5942|       reparos_abertos: parseInt(reparos.rows[0].count),
5943|       assinantes_ativos: parseInt(assinRow.ativos),
5944|       assinantes_gratuitos: parseInt(assinRow.gratuitos),
5945|       receita_mensal: parseFloat(assinRow.receita),
5946|       // candidaturas_pendentes mantém o significado antigo (só obra) para não mudar um campo
5947|       // que já existia; interesses_pendentes é o lado reparo e propostas_pendentes é a soma
5948|       // dos dois — o painel escolhe se mostra um número ou dois.
5949|       candidaturas_pendentes: parseInt(candidaturas.rows[0].count),
5950|       interesses_pendentes: parseInt(interesses.rows[0].count),
5951|       propostas_pendentes: parseInt(candidaturas.rows[0].count) + parseInt(interesses.rows[0].count),
5952|       obras_para_aprovar: parseInt(obrasAprovacao.rows[0].count),
5953|       reparos_para_aprovar: parseInt(reparosAprovacao.rows[0].count),
5954|       mensagens_pendentes: parseInt(mensagensPendentes.rows[0].count)
5955|     })
5956|   } catch (err) {
5957|     res.status(500).json({ erro: 'Erro ao buscar métricas' })
5958|   }
5959| })
5960| 
5961| // Health check
```

### src/routes/index.js:6046-6150 — Suspensos: listar faltas e liberar

```js
6046| router.get('/admin/suspensos', autenticar, exigirAdmin, async (req, res) => {
6047|   try {
6048|     const { page, limit, offset } = paginacaoAdmin(req.query)
6049| 
6050|     const lista = await pool.query(
6051|       `SELECT u.id, u.nome, u.email, u.telefone, u.role, u.tipo_prestador,
6052|               u.suspenso_em, u.suspenso_motivo,
6053|               (SELECT COUNT(*)::int FROM faltas_profissional f
6054|                 WHERE f.usuario_id = u.id
6055|                   AND f.perdoada_em IS NULL
6056|                   AND f.criado_em > NOW() - INTERVAL '${JANELA_FALTAS}') AS faltas_validas,
6057|               (SELECT COUNT(*)::int FROM faltas_profissional f WHERE f.usuario_id = u.id) AS faltas_total,
6058|               COALESCE((
6059|                 SELECT json_agg(x ORDER BY x.criado_em DESC)
6060|                   FROM (
6061|                     SELECT f.id, f.tabela, f.demanda_id, f.criado_em,
6062|                            f.perdoada_em, f.perdoada_por, up.nome AS perdoada_por_nome
6063|                       FROM faltas_profissional f
6064|                       LEFT JOIN usuarios up ON up.id = f.perdoada_por
6065|                      WHERE f.usuario_id = u.id
6066|                      ORDER BY f.criado_em DESC
6067|                      LIMIT 20
6068|                   ) x
6069|               ), '[]'::json) AS faltas
6070|        FROM usuarios u
6071|        WHERE u.suspenso_em IS NOT NULL
6072|        ORDER BY u.suspenso_em DESC
6073|        LIMIT $1 OFFSET $2`,
6074|       [limit, offset]
6075|     )
6076|     res.json({
6077|       suspensos: lista.rows,
6078|       page,
6079|       limit,
6080|       limite_faltas: FALTAS_PARA_SUSPENDER,
6081|       janela_faltas: JANELA_FALTAS,
6082|     })
6083|   } catch (err) {
6084|     console.error('[admin/suspensos]', err.message)
6085|     res.status(500).json({ erro: 'Erro ao listar profissionais suspensos' })
6086|   }
6087| })
6088| 
6089| // POST /admin/suspensos/:id/liberar — levanta a suspensão.
6090| // Transação: limpar a suspensão SEM perdoar as faltas devolveria o profissional ao feed com a
6091| // contagem ainda estourada, e a próxima falta o suspenderia de novo na hora. Os dois writes
6092| // vivem ou morrem juntos.
6093| router.post('/admin/suspensos/:id/liberar', autenticar, exigirAdmin, async (req, res) => {
6094|   const client = await pool.connect()
6095|   try {
6096|     await client.query('BEGIN')
6097|     // WHERE suspenso_em IS NOT NULL: rowCount = 0 distingue "não estava suspenso" (409) de
6098|     // "não existe" (404), sem uma leitura extra antes.
6099|     const alvo = await client.query(
6100|       `UPDATE usuarios SET suspenso_em = NULL, suspenso_motivo = NULL
6101|         WHERE id = $1 AND suspenso_em IS NOT NULL
6102|         RETURNING id, nome, email, push_token`,
6103|       [req.params.id]
6104|     )
6105|     if (alvo.rowCount === 0) {
6106|       await client.query('ROLLBACK')
6107|       const existe = await pool.query(`SELECT id FROM usuarios WHERE id = $1`, [req.params.id])
6108|       return existe.rows.length === 0
6109|         ? res.status(404).json({ erro: 'Usuário não encontrado' })
6110|         : res.status(409).json({ erro: 'Este usuário não está suspenso' })
6111|     }
6112|     // Perdoa exatamente as faltas CONTADAS (não perdoadas, dentro da janela) — as antigas já
6113|     // não contavam e não precisam ser tocadas. Depois disto a contagem dele volta a zero.
6114|     const perdoadas = await client.query(
6115|       `UPDATE faltas_profissional SET perdoada_em = NOW(), perdoada_por = $2::uuid
6116|         WHERE usuario_id = $1
6117|           AND perdoada_em IS NULL
6118|           AND criado_em > NOW() - INTERVAL '${JANELA_FALTAS}'
6119|         RETURNING id`,
6120|       [req.params.id, req.usuario.id]
6121|     )
6122|     await client.query('COMMIT')
6123| 
6124|     // Fora da transação: o cache é do processo, não do banco — derrubar antes de commitar
6125|     // deixaria a próxima request recarregar a linha AINDA suspensa e cachear isso de novo.
6126|     invalidarCacheAssinatura(req.params.id)
6127| 
6128|     res.json({
6129|       mensagem: 'Suspensão removida',
6130|       usuario_id: alvo.rows[0].id,
6131|       faltas_perdoadas: perdoadas.rowCount,
6132|     })
6133|     if (alvo.rows[0].push_token) {
6134|       enviarPushNotificacao(alvo.rows[0].push_token, '✅ Conta liberada',
6135|         'Sua suspensão foi removida. Você já pode voltar a pegar trabalhos.',
6136|         { tipo: 'conta_liberada' }).catch(() => {})
6137|     }
6138|   } catch (err) {
6139|     await client.query('ROLLBACK').catch(() => {})
6140|     console.error('[admin/suspensos/liberar]', err.message)
6141|     res.status(500).json({ erro: 'Erro ao remover suspensão' })
6142|   } finally {
6143|     client.release()
6144|   }
6145| })
6146| 
6147| // GET /admin/denuncias — fila de moderação. Colunas EXPLÍCITAS (nunca SELECT *).
6148| // titulo do contrato sai de um LEFT JOIN por tipo: contrato_id é polimórfico (obras OU
6149| // reparos), então não há FK única para seguir. denunciado_nome pode vir NULL quando o
6150| // denunciado excluiu a conta — a denúncia sobrevive anonimizada (ON DELETE SET NULL).
```

### src/routes/index.js:6359-6415 — Finalizadas (obras + reparos) para o painel

```js
6359| router.get('/admin/finalizadas', autenticar, exigirAdmin, async (req, res) => {
6360|   try {
6361|     const { page, limit, offset } = paginacaoAdmin(req.query)
6362|     // periodo desconhecido NÃO é 400: o painel manda o filtro na URL e um valor errado deve
6363|     // mostrar o mês atual, não uma tela de erro. A chave só entra na SQL depois de casar com
6364|     // o catálogo, então nada do cliente chega perto do texto da consulta.
6365|     const periodo = Object.prototype.hasOwnProperty.call(PERIODOS_FINALIZADAS, req.query.periodo)
6366|       ? req.query.periodo
6367|       : PERIODO_FINALIZADAS_PADRAO
6368|     const filtro = PERIODOS_FINALIZADAS[periodo]
6369| 
6370|     // ORDER BY com desempate por (encerrado_em, tipo, id): sem chave estável, duas linhas
6371|     // com o mesmo encerrado_em podem trocar de lugar entre páginas e uma delas some da
6372|     // paginação. NULLS LAST porque em DESC o padrão do Postgres é NULLS FIRST — sem isso
6373|     // uma linha sem data iria para o topo do painel.
6374|     const lista = await pool.query(
6375|       `SELECT f.tipo, f.id, f.titulo, f.cidade, f.uf, f.bairro, f.encerrado_em,
6376|               f.profissional_nome, f.valor_acordado
6377|          FROM (${SQL_FINALIZADAS}) f
6378|         WHERE ${filtro}
6379|         ORDER BY f.encerrado_em DESC NULLS LAST, f.tipo DESC, f.id DESC
6380|         LIMIT $1 OFFSET $2`,
6381|       [limit, offset]
6382|     )
6383| 
6384|     // Totais sobre TODAS as linhas do período — não sobre a página. Consulta separada (mesmo
6385|     // padrão de por_status em /admin/denuncias): com window function os totais sumiriam numa
6386|     // página vazia, que é exatamente quando o painel ainda precisa mostrar o resumo.
6387|     // valor_total usa COALESCE(...,0): sem linha nenhuma, SUM devolve NULL e o painel
6388|     // mostraria vazio onde o certo é R$ 0.
6389|     // ticket_medio é AVG, que IGNORA nulos: é a média dos valores CONHECIDOS, não
6390|     // valor_total/total_finalizadas — dividir pelo total afundaria o ticket toda vez que uma
6391|     // encerrada sem aceite entrasse na conta. Com zero linhas AVG devolve NULL (não é
6392|     // divisão por zero, não estoura): o painel recebe null e mostra "—".
6393|     const totais = await pool.query(
6394|       `SELECT COUNT(*)::int                                        AS total_finalizadas,
6395|               COALESCE(SUM(f.valor_acordado), 0)                   AS valor_total,
6396|               AVG(f.valor_acordado)                                AS ticket_medio,
6397|               COUNT(*) FILTER (WHERE f.tipo = 'obra')::int         AS total_obras,
6398|               COUNT(*) FILTER (WHERE f.tipo = 'reparo')::int       AS total_reparos
6399|          FROM (${SQL_FINALIZADAS}) f
6400|         WHERE ${filtro}`
6401|     )
6402| 
6403|     res.json({
6404|       page,
6405|       limit,
6406|       periodo,
6407|       totais: totais.rows[0],
6408|       finalizadas: lista.rows
6409|     })
6410|   } catch (err) {
6411|     console.error('[Finalizadas] Erro listagem admin:', err.message)
6412|     res.status(500).json({ erro: 'Erro ao buscar demandas finalizadas' })
6413|   }
6414| })
6415| 
```


## 7. Crons — cronômetro do match, faltas/suspensão, marcos, auto-encerramento, engajamento

### src/services/alertaService.js:1-24 — Cabeçalho: zonas seguras, normalização de cidade

```js
 1| const { pool } = require('../utils/supabase')
 2| const { Expo } = require('expo-server-sdk')
 3| const { getFaixa, PRAZO_MODO_HOJE, sqlFimDoDia, SQL_FIM_DO_DIA_SP, sqlZonaSegura } = require('../utils/faixasPrazo')
 4| // Ver src/routes/index.js: a obra guarda a zona do dono em prazo_timezone, validada contra
 5| // pg_timezone_names NA HORA DO USO — zona NULL ou que deixou de existir recua para o padrão em
 6| // vez de derrubar o UPDATE do lote inteiro. Só o lado OBRA tem zona — reparo não tem "Hoje".
 7| const SQL_ZONA_DA_OBRA = sqlZonaSegura('obras.prazo_timezone')
 8| // D78: o reparo também guarda a zona do dono (reparos.prazo_timezone) para a faixa "Hoje".
 9| const SQL_ZONA_DO_REPARO = sqlZonaSegura('reparos.prazo_timezone')
10| const { MARCA } = require('../utils/marca')
11| const { normalizar, sqlNormalizarCidade } = require('../utils/localidade')
12| // Cidade dobrada dos DOIS lados com a MESMA regra (ver utils/localidade): a do profissional
13| // aqui, a da demanda em JS com normalizar(). uf compara em caixa alta, que e como e gravado.
14| const SQL_CIDADE_PRESTADOR = sqlNormalizarCidade('u.cidade')
15| // Sem ciclo: middlewares/auth só importa jsonwebtoken e utils/supabase, nunca este serviço.
16| const { invalidarCacheAssinatura } = require('../middlewares/auth')
17| 
18| const expo = new Expo()
19| 
20| // Consulta os recibos de entrega (depois de um intervalo, pois o Expo processa a
21| // entrega de forma assíncrona) e remove tokens reportados como DeviceNotRegistered.
22| // Recebe pares { ticket, pushToken } de tickets já confirmados como 'ok'.
23| // É chamada em fire-and-forget — qualquer erro é apenas logado, nunca propagado.
24| const processarRecibos = async (ticketsComToken, delayMs = 15000) => {
```

### src/services/alertaService.js:149-1026 — Boas-vindas, broadcast de nova obra/reparo, baixo engajamento, marcos de expiração, match desfeito, registrarFalta (3 em 90 dias → suspensão), cronômetro reparos, cronômetro obras, auto-encerramento

```js
 149| const enviarBoasVindas = async (usuarioId) => {
 150|   try {
 151|     const result = await pool.query(
 152|       `SELECT push_token, nome, role FROM usuarios WHERE id = $1`,
 153|       [usuarioId]
 154|     )
 155|     if (!result.rows[0]?.push_token) return
 156| 
 157|     const { push_token, nome, role } = result.rows[0]
 158|     const primeiroNome = nome?.split(' ')[0] || 'bem-vindo'
 159| 
 160|     let mensagem = ''
 161|     if (role === 'assinante') {
 162|       mensagem = 'Explore obras de pintura disponíveis na sua região agora mesmo!'
 163|     } else if (role === 'prestador') {
 164|       mensagem = 'Explore serviços disponíveis na sua região agora mesmo!'
 165|     } else if (role === 'dono_obra') {
 166|       mensagem = 'Cadastre sua primeira obra ou serviço e encontre profissionais qualificados!'
 167|     }
 168| 
 169|     await enviarPushNotificacao(
 170|       push_token,
 171|       `🎉 Bem-vindo ao ${MARCA}, ${primeiroNome}!`,
 172|       mensagem,
 173|       { tipo: 'boas_vindas' }
 174|     )
 175|   } catch (err) {
 176|     console.error('Erro ao enviar boas vindas:', err)
 177|   }
 178| }
 179| 
 180| const notificarPintoresSobreNovaObra = async (obraId) => {
 181|   try {
 182|     const obraResult = await pool.query(
 183|       `SELECT titulo, cidade, uf FROM obras WHERE id = $1`,
 184|       [obraId]
 185|     )
 186|     if (obraResult.rows.length === 0) return
 187|     const obra = obraResult.rows[0]
 188| 
 189|     // Sem cidade OU sem uf na demanda nao ha alvo possivel: antes disto a consulta nao
 190|     // filtrava lugar nenhum e o aviso ia para o pais inteiro. Silencio e o comportamento
 191|     // correto aqui — melhor ninguem do que todos.
 192|     const cidadeObra = normalizar(obra.cidade)
 193|     const ufObra = String(obra.uf || '').trim().toUpperCase()
 194|     if (!cidadeObra || !ufObra) {
 195|       console.log('[Push] Obra sem cidade/uf — nenhum pintor notificado |', obraId)
 196|       return
 197|     }
 198| 
 199|     // cidade E uf, nunca cidade sozinha: ha municipios homonimos em estados diferentes.
 200|     // Prestador sem cidade ou sem uf fica de FORA (NULLIF ... IS NOT NULL) — sem lugar
 201|     // declarado nao da para afirmar que ele atende ali.
 202|     // LIMIT 500 mantido como rede de seguranca.
 203|     const pintores = await pool.query(
 204|       `SELECT u.push_token
 205|        FROM usuarios u
 206|        JOIN assinaturas a ON a.usuario_id = u.id
 207|        WHERE u.role = 'prestador' AND u.tipo_prestador = 'pintor'
 208|          AND a.status = 'ativa'
 209|          AND u.push_token IS NOT NULL
 210|          AND NULLIF(btrim(u.cidade), '') IS NOT NULL
 211|          AND NULLIF(btrim(u.uf), '')     IS NOT NULL
 212|          AND ${SQL_CIDADE_PRESTADOR} = $1
 213|          AND upper(btrim(u.uf)) = $2
 214|        LIMIT 500`,
 215|       [cidadeObra, ufObra]
 216|     )
 217| 
 218|     const total = await enviarPushEmLote(
 219|       pintores.rows,
 220|       '🎨 Nova obra disponível!',
 221|       `"${obra.titulo}" em ${obra.cidade} acabou de ser publicada!`,
 222|       { tipo: 'nova_obra', obra_id: obraId }
 223|     )
 224|     console.log(`Notificados ${total} pintores sobre nova obra`)
 225|   } catch (err) {
 226|     console.error('Erro ao notificar pintores:', err)
 227|   }
 228| }
 229| 
 230| const notificarPrestadoresSobreNovoReparo = async (reparoId) => {
 231|   try {
 232|     const reparoResult = await pool.query(
 233|       `SELECT titulo, cidade, uf, categoria FROM reparos WHERE id = $1`,
 234|       [reparoId]
 235|     )
 236|     if (reparoResult.rows.length === 0) return
 237|     const reparo = reparoResult.rows[0]
 238| 
 239|     const cidadeReparo = normalizar(reparo.cidade)
 240|     const ufReparo = String(reparo.uf || '').trim().toUpperCase()
 241|     if (!cidadeReparo || !ufReparo) {
 242|       console.log('[Push] Reparo sem cidade/uf — nenhum prestador notificado |', reparoId)
 243|       return
 244|     }
 245| 
 246|     // Mesma dobra de cidade+uf da obra. Alem disso ganha o JOIN em assinaturas com
 247|     // status='ativa', que faltava SO aqui: o aviso de trabalho novo ia para quem esta com a
 248|     // assinatura vencida e nem consegue demonstrar interesse depois de abrir o app.
 249|     // tipo_prestador = 'reparador' ESTRITO (D87), o mesmo predicado de exigirReparador: o
 250|     // "IS DISTINCT FROM 'pintor'" antigo incluía NULL/legado, que recebia o push e caía em
 251|     // 403 TIER_INCORRETO ao tocar. Paridade com o broadcast de obra (= 'pintor').
 252|     const prestadores = await pool.query(
 253|       `SELECT u.push_token
 254|        FROM usuarios u
 255|        JOIN assinaturas a ON a.usuario_id = u.id
 256|        WHERE u.role = 'prestador' AND u.tipo_prestador = 'reparador'
 257|          AND a.status = 'ativa'
 258|          AND u.push_token IS NOT NULL
 259|          AND NULLIF(btrim(u.cidade), '') IS NOT NULL
 260|          AND NULLIF(btrim(u.uf), '')     IS NOT NULL
 261|          AND ${SQL_CIDADE_PRESTADOR} = $1
 262|          AND upper(btrim(u.uf)) = $2
 263|        LIMIT 500`,
 264|       [cidadeReparo, ufReparo]
 265|     )
 266| 
 267|     const total = await enviarPushEmLote(
 268|       prestadores.rows,
 269|       '🔧 Novo serviço disponível!',
 270|       `"${reparo.titulo}" em ${reparo.cidade} — categoria: ${reparo.categoria}`,
 271|       { tipo: 'novo_reparo', reparo_id: reparoId }
 272|     )
 273|     console.log(`Notificados ${total} prestadores sobre novo reparo`)
 274|   } catch (err) {
 275|     console.error('Erro ao notificar prestadores:', err)
 276|   }
 277| }
 278| 
 279| const verificarObrasExpirando = async () => {
 280|   try {
 281|     const obras = await pool.query(`
 282|       SELECT o.id, o.titulo, u.push_token
 283|       FROM obras o
 284|       JOIN usuarios u ON o.criado_por = u.id
 285|       WHERE o.status = 'aberta'
 286|         AND o.expira_em BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
 287|         AND o.alerta_enviado_em IS NULL
 288|         AND u.push_token IS NOT NULL
 289|     `)
 290| 
 291|     // Atualiza alerta_enviado_em em lote antes de notificar
 292|     if (obras.rows.length > 0) {
 293|       const ids = obras.rows.map(o => o.id)
 294|       await pool.query(
 295|         `UPDATE obras SET alerta_enviado_em = NOW() WHERE id = ANY($1)`,
 296|         [ids]
 297|       )
 298|       await enviarPushEmLote(
 299|         obras.rows,
 300|         '⏰ Sua obra expira em 24 horas!',
 301|         'Sua obra será encerrada em breve. Renove para continuar recebendo candidatos.',
 302|         { tipo: 'obra_expirando' }
 303|       )
 304|     }
 305| 
 306|     const reparos = await pool.query(`
 307|       SELECT r.id, r.titulo, u.push_token
 308|       FROM reparos r
 309|       JOIN usuarios u ON r.criado_por = u.id
 310|       WHERE r.status = 'aberta'
 311|         AND r.expira_em BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
 312|         AND r.alerta_enviado_em IS NULL
 313|         AND u.push_token IS NOT NULL
 314|     `)
 315| 
 316|     if (reparos.rows.length > 0) {
 317|       const ids = reparos.rows.map(r => r.id)
 318|       await pool.query(
 319|         `UPDATE reparos SET alerta_enviado_em = NOW() WHERE id = ANY($1)`,
 320|         [ids]
 321|       )
 322|       await enviarPushEmLote(
 323|         reparos.rows,
 324|         '⏰ Seu serviço expira em 24 horas!',
 325|         'Seu serviço será encerrado em breve.',
 326|         { tipo: 'reparo_expirando' }
 327|       )
 328|     }
 329| 
 330|     console.log(`Expiração: ${obras.rows.length} obras e ${reparos.rows.length} reparos notificados`)
 331|   } catch (err) {
 332|     console.error('Erro ao verificar obras expirando:', err)
 333|   }
 334| }
 335| 
 336| const verificarObrasComBaixoEngajamento = async () => {
 337|   try {
 338|     console.log('Verificando obras com baixo engajamento...')
 339| 
 340|     const obras = await pool.query(`
 341|       SELECT o.id, o.titulo, o.total_visitas, u.push_token
 342|       FROM obras o
 343|       JOIN usuarios u ON o.criado_por = u.id
 344|       WHERE o.status = 'aberta'
 345|         AND o.status_aprovacao = 'aprovada'
 346|         AND o.match_usuario_id IS NULL
 347|         AND o.total_visitas >= 10
 348|         AND o.criado_em < NOW() - INTERVAL '1 day'
 349|         AND o.expira_em > NOW()
 350|         AND (o.alerta_enviado_em IS NULL OR o.alerta_enviado_em < NOW() - INTERVAL '24 hours')
 351|         AND NOT EXISTS (
 352|           SELECT 1 FROM candidaturas c
 353|           WHERE c.obra_id = o.id AND c.status IS DISTINCT FROM 'recusado'
 354|         )
 355|         AND u.push_token IS NOT NULL
 356|     `)
 357| 
 358|     if (obras.rows.length > 0) {
 359|       const ids = obras.rows.map(o => o.id)
 360|       await pool.query(`UPDATE obras SET alerta_enviado_em = NOW() WHERE id = ANY($1)`, [ids])
 361| 
 362|       // Envio individual aqui pois a mensagem inclui total_visitas específico de cada obra
 363|       for (const obra of obras.rows) {
 364|         await enviarPushNotificacao(
 365|           obra.push_token,
 366|           '💡 Considere aumentar sua oferta',
 367|           `Sua obra "${obra.titulo}" teve ${obra.total_visitas} visitas e nenhum interessado ainda.`,
 368|           { tipo: 'baixo_engajamento', obra_id: obra.id }
 369|         )
 370|       }
 371|     }
 372| 
 373|     const reparos = await pool.query(`
 374|       SELECT r.id, r.titulo, r.total_visitas, u.push_token
 375|       FROM reparos r
 376|       JOIN usuarios u ON r.criado_por = u.id
 377|       WHERE r.status = 'aberta'
 378|         AND r.status_aprovacao = 'aprovada'
 379|         AND r.match_usuario_id IS NULL
 380|         AND r.total_visitas >= 10
 381|         AND r.criado_em < NOW() - INTERVAL '1 day'
 382|         AND r.expira_em > NOW()
 383|         -- 24h como na obra (D86): o job roda a cada 8h, e com '8 hours' o dono de reparo era
 384|         -- cutucado até 3x por dia sobre a mesma demanda. O gate criado_em < NOW() - 1 day acima
 385|         -- já garante que só reparos com vida de dias chegam aqui, então a cadência de obra
 386|         -- (uma vez por dia) é a certa para os dois lados.
 387|         AND (r.alerta_enviado_em IS NULL OR r.alerta_enviado_em < NOW() - INTERVAL '24 hours')
 388|         AND NOT EXISTS (
 389|           SELECT 1 FROM interesse_reparos ir
 390|           WHERE ir.reparo_id = r.id AND ir.status IS DISTINCT FROM 'recusado'
 391|         )
 392|         AND u.push_token IS NOT NULL
 393|     `)
 394| 
 395|     if (reparos.rows.length > 0) {
 396|       const ids = reparos.rows.map(r => r.id)
 397|       await pool.query(`UPDATE reparos SET alerta_enviado_em = NOW() WHERE id = ANY($1)`, [ids])
 398| 
 399|       for (const reparo of reparos.rows) {
 400|         await enviarPushNotificacao(
 401|           reparo.push_token,
 402|           '💡 Considere aumentar sua oferta',
 403|           `Seu serviço "${reparo.titulo}" teve ${reparo.total_visitas} visitas e nenhum interessado ainda.`,
 404|           { tipo: 'baixo_engajamento_reparo', reparo_id: reparo.id }
 405|         )
 406|       }
 407|     }
 408| 
 409|     console.log(`Engajamento: ${obras.rows.length} obras e ${reparos.rows.length} reparos notificados`)
 410|   } catch (err) {
 411|     console.error('Erro ao verificar engajamento:', err)
 412|   }
 413| }
 414| 
 415| // Marcos de expiração PROPORCIONAIS à faixa de prazo da demanda (ver src/utils/faixasPrazo.js).
 416| // Alerta o dono de uma demanda SEM match e SEM interessados em 3 marcos cujos offsets VARIAM por
 417| // faixa: ex. faixa 1h → [15,10,5] min antes de expira_em; faixa 168h → [1 dia, 8h, 4h]. Cada push
 418| // tem deep-link para a tela de detalhe (onde fica o botão de estender).
 419| //
 420| // Bandas contíguas e DISJUNTAS a partir dos 3 offsets [m1>m2>m3]:
 421| //   marco_1: (m2, m1]   marco_2: (m3, m2]   marco_3: (0, m3]
 422| // Como não se sobrepõem, a demanda cai em no máximo uma banda por run → no máximo um push por marco
 423| // (reforçado pelo claim marco_N_em IS NULL). Demanda que só aparece já dentro da banda menor recebe
 424| // só aquele alerta (cobertura, não sequência). SEM backfill anti-rajada: as bandas disjuntas já
 425| // garantem no máximo um disparo por run, então o 1º run pós-deploy não gera rajada de alertas.
 426| //
 427| // Elegibilidade: status='aberta', match_usuario_id IS NULL, sem interesse (obras: NOT EXISTS
 428| // candidaturas; reparos: NOT EXISTS interesse_reparos), dono com push_token entregável. Obras
 429| // exigem status_aprovacao='aprovada' (reparos não, por decisão).
 430| //
 431| // Claim-then-send replica-safe: o SELECT reúne candidatos; o UPDATE ... WHERE marco_N_em IS NULL
 432| // RETURNING reivindica a coluna atomicamente — a 2ª réplica vê a coluna já preenchida e retorna 0
 433| // linhas, então só uma envia o push. Faixa desconhecida (getFaixa null) → pula com log, sem crash.
 434| 
 435| // Formata minutos em rótulo PT-BR curto: 5→"5 minutos", 60→"1 hora", 90→"1h30", 1440→"1 dia".
 436| const formatarTempoRestante = (min) => {
 437|   if (min >= 1440) { const d = Math.round(min / 1440); return d === 1 ? '1 dia' : `${d} dias` }
 438|   if (min >= 60) {
 439|     const h = Math.floor(min / 60), m = min % 60
 440|     if (m === 0) return h === 1 ? '1 hora' : `${h} horas`
 441|     return `${h}h${String(m).padStart(2, '0')}`
 442|   }
 443|   return `${min} minutos`
 444| }
 445| 
 446| // `interesse`: subconsulta do NOT EXISTS que suprime o alerta quando a demanda JÁ tem
 447| // interessado. Testava só a EXISTÊNCIA da linha, então uma candidatura/interesse já
 448| // RECUSADO calava o alerta para sempre — justamente quando o dono mais precisa dele
 449| // (demanda expirando e sem ninguém vivo na fila). Agora só linhas vivas suprimem.
 450| // IS DISTINCT FROM (e não <>) por ser NULL-safe: status NULL continua suprimindo, como hoje.
 451| const verificarMarcosExpiracao = async () => {
 452|   const lados = [
 453|     { tabela: 'obras',   idKey: 'obra_id',   janelaCol: 'horas_para_expirar',      substantivo: 'Sua obra',   verbo: 'Estenda o prazo',
 454|       tipoPrefixo: 'obra_expirando',   statusAprovacao: `AND d.status_aprovacao = 'aprovada'`, interesse: `SELECT 1 FROM candidaturas c WHERE c.obra_id = d.id AND c.status IS DISTINCT FROM 'recusado'` },
 455|     { tabela: 'reparos', idKey: 'reparo_id', janelaCol: 'prazo_atendimento_horas', substantivo: 'Seu serviço', verbo: 'Aumente o prazo',
 456|       tipoPrefixo: 'reparo_expirando', statusAprovacao: '',                          interesse: `SELECT 1 FROM interesse_reparos ir WHERE ir.reparo_id = d.id AND ir.status IS DISTINCT FROM 'recusado'` },
 457|   ]
 458| 
 459|   let totalEnviados = 0
 460|   try {
 461|     for (const lado of lados) {
 462|       // Candidatos elegíveis com algum marco pendente e expira_em dentro do MAIOR offset possível
 463|       // (1440min = 24h, faixa 168) — demandas mais distantes que isso não entram em banda nenhuma.
 464|       // COALESCE(janela, 720): linhas ANTIGAS gravadas com prazo NULL viravam Number(null)=0 no
 465|       // getFaixa, caíam no `faixa desconhecida` e nunca recebiam marco. 720 é o mesmo default que
 466|       // o create usa para o expira_em dessas linhas (e o que os dois crons já usam nas obras).
 467|       const candidatos = await pool.query(`
 468|         SELECT d.id, d.titulo, COALESCE(d.${lado.janelaCol}, 720) AS janela, d.expira_em,
 469|                d.marco_1_em, d.marco_2_em, d.marco_3_em, u.push_token
 470|         FROM ${lado.tabela} d
 471|         JOIN usuarios u ON d.criado_por = u.id
 472|         WHERE d.status = 'aberta'
 473|           ${lado.statusAprovacao}
 474|           AND d.match_usuario_id IS NULL
 475|           AND u.push_token IS NOT NULL AND u.push_token <> ''
 476|           AND NOT EXISTS (${lado.interesse})
 477|           AND (d.marco_1_em IS NULL OR d.marco_2_em IS NULL OR d.marco_3_em IS NULL)
 478|           AND d.expira_em > NOW()
 479|           AND d.expira_em <= NOW() + INTERVAL '1440 minutes'
 480|       `)
 481| 
 482|       for (const d of candidatos.rows) {
 483|         const faixa = getFaixa(Math.round(Number(d.janela)))
 484|         if (!faixa) {
 485|           console.warn(`[MarcosExpiracao] faixa desconhecida (janela=${d.janela}) — ${lado.tabela} ${d.id} ignorado`)
 486|           continue
 487|         }
 488|         const [m1, m2, m3] = faixa.milestones
 489|         const restante = (new Date(d.expira_em).getTime() - Date.now()) / 60000
 490| 
 491|         // Banda disjunta — no máximo um marco por run.
 492|         let alvo = null
 493|         if      (d.marco_1_em === null && restante <= m1 && restante > m2) alvo = { n: 1, col: 'marco_1_em', offset: m1 }
 494|         else if (d.marco_2_em === null && restante <= m2 && restante > m3) alvo = { n: 2, col: 'marco_2_em', offset: m2 }
 495|         else if (d.marco_3_em === null && restante <= m3 && restante > 0)  alvo = { n: 3, col: 'marco_3_em', offset: m3 }
 496|         if (!alvo) continue
 497| 
 498|         // Claim-then-send: reivindica a coluna no mesmo UPDATE (replica-safe).
 499|         const claim = await pool.query(
 500|           `UPDATE ${lado.tabela} SET ${alvo.col} = NOW() WHERE id = $1 AND ${alvo.col} IS NULL RETURNING id`,
 501|           [d.id]
 502|         )
 503|         if (claim.rows.length === 0) continue
 504| 
 505|         const label = formatarTempoRestante(alvo.offset)
 506|         const titulo = `⏰ ${lado.substantivo} está expirando`
 507|         const corpo = alvo.n === 3
 508|           ? `Última chance: ${lado.substantivo.toLowerCase()} '${d.titulo}' expira em menos de ${label} e ainda não tem interessados. ${lado.verbo} agora.`
 509|           : `${lado.substantivo} '${d.titulo}' expira em menos de ${label} e ainda não tem interessados. ${lado.verbo}.`
 510|         await enviarPushEmLote(
 511|           [{ push_token: d.push_token }],
 512|           titulo,
 513|           corpo,
 514|           { tipo: `${lado.tipoPrefixo}_${alvo.n}`, [lado.idKey]: d.id }
 515|         )
 516|         totalEnviados++
 517|       }
 518|     }
 519|     console.log(`[MarcosExpiracao] ${totalEnviados} alerta(s) de expiração enviado(s)`)
 520|   } catch (err) {
 521|     console.error('Erro ao verificar marcos de expiração:', err.message)
 522|   }
 523| }
 524| 
 525| // Avisa OS DOIS LADOS de um match desfeito pelo cronômetro — antes o ramo (b) dos dois crons
 526| // devolvia a demanda ao feed em silêncio, e o profissional descobria abrindo o app. Mesmos
 527| // título/tipo dos handlers POST /:id/expirar-match, para o app tratar tudo por 'match_expirado'.
 528| // `tabela` sai de literal no chamador, nunca do request.
 529| const ROTULOS_MATCH_DESFEITO = {
 530|   obras:   { chave: 'obra_id',   profissional: 'pintor',    artigo: 'A obra',   volta: 'A obra voltou' },
 531|   reparos: { chave: 'reparo_id', profissional: 'prestador', artigo: 'O serviço', volta: 'O serviço voltou' },
 532| }
 533| 
 534| const notificarMatchDesfeito = async (tabela, demanda) => {
 535|   const { chave, profissional, artigo, volta } = ROTULOS_MATCH_DESFEITO[tabela]
 536|   const alvos = [demanda.criado_por, demanda.match_usuario_id].filter(Boolean)
 537|   if (alvos.length === 0) return
 538|   const tokens = await pool.query(
 539|     `SELECT id, push_token FROM usuarios WHERE id = ANY($1::uuid[]) AND push_token IS NOT NULL`,
 540|     [alvos]
 541|   )
 542|   for (const u of tokens.rows) {
 543|     const paraDono = u.id === demanda.criado_por
 544|     enviarPushNotificacao(u.push_token, '⏰ Prazo expirado!',
 545|       paraDono
 546|         ? `O ${profissional} não chegou a tempo para "${demanda.titulo}". ${artigo} está disponível novamente.`
 547|         : `O prazo para chegar em "${demanda.titulo}" acabou. ${volta} para o feed.`,
 548|       { tipo: 'match_expirado', [chave]: demanda.id }).catch(() => {})
 549|   }
 550| }
 551| 
 552| // Faltas: só o CRONÔMETRO registra. Os handlers POST /:id/expirar-match e as recusas de tempo
 553| // extra também desfazem match, mas ali há um humano decidindo (dono ou admin, e o próprio
 554| // profissional pode chamar expirar-match) — contar aquilo como falta deixaria a suspensão ao
 555| // alcance de quem clica. O cron é a única evidência automática de "prazo venceu, ninguém chegou".
 556| const FALTAS_PARA_SUSPENDER = 3
 557| const JANELA_FALTAS = '90 days'
 558| const MOTIVO_SUSPENSAO = `${FALTAS_PARA_SUSPENDER} faltas (não comparecimento) em ${JANELA_FALTAS.replace('days', 'dias')}`
 559| 
 560| // Isenção: o profissional ofereceu uma janela e ela NUNCA virou compromisso — porque o dono
 561| // recusou (chegada_recusada_em) ou porque simplesmente não respondeu e a proposta morreu
 562| // pendente (chegada_pendente_em). Nos dois casos chegada_prevista_em segue NULL: não houve
 563| // horário acordado para ele furar. Cobrar falta aí puniria quem se ofereceu e ficou esperando —
 564| // e, no caso do silêncio, puniria o profissional por inação do DONO.
 565| // Se alguma janela chegou a VALER (chegada_prevista_em preenchida), a isenção cai: havia
 566| // compromisso firmado, e não comparecer é falta.
 567| // Espelhada no CASE de prestadores_bloqueados dos dois crons e dos dois expirar-match — as
 568| // duas punições (falta e bloqueio) andam sempre juntas.
 569| const isentoPorRecusa = (demanda) =>
 570|   !demanda.chegada_prevista_em &&
 571|   (!!demanda.chegada_recusada_em || !!demanda.chegada_pendente_em)
 572| 
 573| // Registra a falta e, ao cruzar o limite na janela móvel, suspende. `tabela` sai de literal no
 574| // chamador, nunca do request. Erros são engolidos: uma falha aqui não pode derrubar o cron nem
 575| // impedir que a demanda volte ao feed — o un-match já foi commitado quando isto roda.
 576| const registrarFalta = async (tabela, demanda) => {
 577|   if (!demanda.match_usuario_id) return
 578|   try {
 579|     await pool.query(
 580|       `INSERT INTO faltas_profissional (usuario_id, tabela, demanda_id) VALUES ($1, $2, $3)`,
 581|       [demanda.match_usuario_id, tabela, demanda.id]
 582|     )
 583|     // perdoada_em IS NULL: falta perdoada por um admin continua no histórico mas não conta.
 584|     const c = await pool.query(
 585|       `SELECT COUNT(*)::int AS n FROM faltas_profissional
 586|         WHERE usuario_id = $1
 587|           AND perdoada_em IS NULL
 588|           AND criado_em > NOW() - INTERVAL '${JANELA_FALTAS}'`,
 589|       [demanda.match_usuario_id]
 590|     )
 591|     if (c.rows[0].n < FALTAS_PARA_SUSPENDER) return
 592| 
 593|     // suspenso_em IS NULL no WHERE: suspende UMA vez. Sem isso, a 4ª, 5ª... falta reescreveria
 594|     // o timestamp (empurrando o início da suspensão para frente) e reenviaria o push a cada
 595|     // falta. rowCount = 0 significa "já estava suspenso" — nada a notificar.
 596|     const upd = await pool.query(
 597|       `UPDATE usuarios SET suspenso_em = NOW(), suspenso_motivo = $2
 598|         WHERE id = $1 AND suspenso_em IS NULL
 599|         RETURNING push_token`,
 600|       [demanda.match_usuario_id, MOTIVO_SUSPENSAO]
 601|     )
 602|     if (upd.rowCount === 0) return
 603|     // Derruba o usuário do cache de 30s de autenticar. Sem isto, quem estivesse com sessão
 604|     // quente continuaria passando por exigirNaoSuspenso (que lê req.usuario) por até 30
 605|     // segundos depois de suspenso — janela para pegar mais um trabalho. Os aceites já
 606|     // consultam o banco direto, mas os feeds e a criação de proposta dependem do cache.
 607|     invalidarCacheAssinatura(demanda.match_usuario_id)
 608|     console.log(`[Faltas] usuario ${demanda.match_usuario_id} suspenso — ${c.rows[0].n} faltas em ${JANELA_FALTAS}`)
 609|     if (upd.rows[0]?.push_token) {
 610|       enviarPushNotificacao(upd.rows[0].push_token, '🚫 Conta suspensa',
 611|         `Sua conta foi suspensa por ${MOTIVO_SUSPENSAO}. Fale com o suporte para regularizar.`,
 612|         { tipo: 'conta_suspensa' }).catch(() => {})
 613|     }
 614|   } catch (err) {
 615|     console.error(`[Faltas] Erro ao registrar falta em ${tabela}:`, err.message)
 616|   }
 617| }
 618| 
 619| // Cronômetro de matches de reparos.
 620| // O prazo do cronômetro inicia em match_feito_em e vai até COALESCE(chegada_prevista_em,
 621| // expira_em): quando o prestador promete uma janela de chegada, é ELA que passa a valer como
 622| // prazo — inclusive quando cai depois do expira_em original (o dono aceitou esperar até lá ao
 623| // ver a previsão). Sem previsão, nada muda: continua o expira_em.
 624| // (a) A 5 minutos do fim: avisa o dono uma única vez por match.
 625| // (b) Quando o cronômetro zera: devolve o reparo ao feed e limpa o match.
 626| // Os dois ramos param assim que a chegada é DECLARADA (por qualquer lado) ou CONFIRMADA: a
 627| // partir daí o prestador está no local, e nem faz sentido cobrar "ainda não chegou?" nem
 628| // devolver ao feed um reparo em atendimento.
 629| const verificarCronometroReparos = async () => {
 630|   try {
 631|     // (a) 5 minutos restantes → notifica o dono (uma vez por match)
 632|     const cincoMin = await pool.query(`
 633|       SELECT r.id, r.titulo, u.push_token
 634|       FROM reparos r
 635|       JOIN usuarios u ON r.criado_por = u.id
 636|       WHERE r.match_usuario_id IS NOT NULL
 637|         AND r.notif_5min_enviada = false
 638|         AND u.push_token IS NOT NULL
 639|         AND r.chegada_declarada_em IS NULL
 640|         AND r.chegada_confirmada_em IS NULL
 641|         AND COALESCE(r.chegada_prevista_em, r.expira_em) BETWEEN NOW() AND NOW() + INTERVAL '5 minutes'
 642|     `)
 643| 
 644|     if (cincoMin.rows.length > 0) {
 645|       const ids = cincoMin.rows.map(r => r.id)
 646|       await pool.query(`UPDATE reparos SET notif_5min_enviada = true WHERE id = ANY($1)`, [ids])
 647| 
 648|       for (const reparo of cincoMin.rows) {
 649|         await enviarPushNotificacao(
 650|           reparo.push_token,
 651|           '⏰ O prestador ainda não chegou?',
 652|           'Faltam 5 minutos. Se ele ainda não chegou, você pode aumentar o prazo ou aguardar o cronômetro zerar.',
 653|           { tipo: 'reparo_5min_restantes', reparo_id: reparo.id }
 654|         )
 655|       }
 656|     }
 657| 
 658|     // (b) Cronômetro zerou → devolve o reparo ao feed e limpa o match,
 659|     // reiniciando a contagem com o prazo original configurado na criação.
 660|     // status = 'aberta' no WHERE (espelha o cron de obras): sem ele, um reparo já
 661|     // ENCERRADO com expira_em vencido seria ressuscitado para o feed e perderia o
 662|     // match. Reparo casado permanece 'aberta' (/reparos/:id/match não mexe no status),
 663|     // então o filtro não exclui nenhuma linha legítima do cronômetro.
 664|     // SELECT antes do UPDATE porque RETURNING devolve a linha NOVA, em que match_usuario_id já
 665|     // é NULL — e é justamente ele que precisamos para bloquear e notificar o prestador. O mesmo
 666|     // predicado vai nos dois: o UPDATE continua sendo quem decide (linha que deixar de casar
 667|     // entre as duas queries simplesmente não é atualizada e não gera push).
 668|     // prazo_atendimento_horas NULL NÃO exclui mais a linha (D73 — paridade com o cron de obras):
 669|     // o prazo pós-match é COALESCE(chegada_prevista_em, expira_em), que independe da coluna;
 670|     // o filtro só servia para proteger o rebuild abaixo de "NULL * interval", e isso agora é
 671|     // COALESCE. Com o filtro, um reparo casado com prazo NULL ficava com match eterno: sem
 672|     // aviso de 5 min, sem voltar ao feed e sem falta.
 673|     const PRED_EXPIRADOS_REPAROS = `
 674|       status = 'aberta'
 675|         AND match_usuario_id IS NOT NULL
 676|         AND chegada_declarada_em IS NULL
 677|         AND chegada_confirmada_em IS NULL
 678|         AND COALESCE(chegada_prevista_em, expira_em) <= NOW()`
 679| 
 680|     // chegada_recusada_em/chegada_prevista_em entram no SELECT para a ISENÇÃO: match que morre
 681|     // depois de o dono recusar a janela, e sem nenhuma outra valendo, não gera falta nem bloqueio.
 682|     const candidatos = await pool.query(`
 683|       SELECT id, titulo, criado_por, match_usuario_id,
 684|              chegada_recusada_em, chegada_pendente_em, chegada_prevista_em
 685|         FROM reparos WHERE ${PRED_EXPIRADOS_REPAROS}
 686|     `)
 687| 
 688|     let expiradosCount = 0
 689|     if (candidatos.rows.length > 0) {
 690|       const expirados = await pool.query(`
 691|         WITH desfeitos AS (
 692|           UPDATE reparos SET
 693|             status = 'aberta',
 694|             match_feito_em = NULL,
 695|             match_usuario_id = NULL,
 696|             notif_5min_enviada = false,
 697|             -- Mesmo re-armamento do lado obra (ver o comentário lá): sem isto o reparo volta
 698|             -- ao feed com prazo novo e marcos velhos, e não recebe aviso de expiração nenhum.
 699|             marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL,
 700|             pedido_tempo_status = NULL,
 701|             pedido_tempo_motivo = NULL,
 702|             pedido_tempo_minutos = NULL,
 703|             chegada_janela = NULL,
 704|             chegada_prevista_em = NULL,
 705|             chegada_declarada_por = NULL,
 706|             chegada_declarada_em = NULL,
 707|             chegada_pendente_janela = NULL,
 708|             chegada_pendente_em = NULL,
 709|             chegada_recusada_em = NULL,
 710|             prestadores_bloqueados = CASE
 711|               -- Isenção: janela oferecida que nunca virou compromisso — recusada pelo dono OU
 712|               -- morta pendente sem resposta — e nenhuma outra valendo. Não bloqueia.
 713|               WHEN chegada_prevista_em IS NULL
 714|                    AND (chegada_recusada_em IS NOT NULL OR chegada_pendente_em IS NOT NULL)
 715|               THEN prestadores_bloqueados
 716|               WHEN match_usuario_id = ANY(COALESCE(prestadores_bloqueados, '{}'))
 717|               THEN prestadores_bloqueados
 718|               ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), match_usuario_id) END,
 719|             -- Faixa "Hoje": devolver ao feed NÃO pode dar 24h novas a quem escolheu "hoje" —
 720|             -- o prazo volta a ser o fim do dia CORRENTE (o dia em que o match morreu).
 721|             -- Sem este CASE, o cron reconstruiria a partir de prazo_atendimento_horas.
 722|             -- COALESCE(prazo_atendimento_horas, 720): mesma rede do cron de obras. 720h é o
 723|             -- default do PRÓPRIO create de reparo quando o cliente não manda prazo
 724|             -- (index.js: horasExpiracao = prazo || 720) e o que verificarMarcosExpiracao já
 725|             -- assume para reparo com prazo NULL — a segunda vida da linha ganha a mesma janela
 726|             -- da primeira, e os dois crons leem o mesmo número para a mesma linha.
 727|             -- O dia é o do DONO (reparos.prazo_timezone, D78), como no cron de obras — não o de SP.
 728|             expira_em = CASE WHEN prazo_modo = '${PRAZO_MODO_HOJE}' THEN ${sqlFimDoDia(SQL_ZONA_DO_REPARO)}
 729|                              ELSE NOW() + (COALESCE(prazo_atendimento_horas, 720) * INTERVAL '1 hour') END
 730|           WHERE id = ANY($1::uuid[]) AND ${PRED_EXPIRADOS_REPAROS}
 731|           RETURNING id
 732|         ), propostas AS (
 733|           -- A proposta vencedora expira JUNTO com o match, no mesmo statement: enquanto ela
 734|           -- ficava 'aceito' o serviço voltava ao feed mas nenhum aceite novo passava
 735|           -- (interesse_reparos_aceito_unico_idx ocupado + guard jaAceito → 409).
 736|           -- O par (reparo, prestador) vem dos dois arrays paralelos porque o RETURNING acima já
 737|           -- traz match_usuario_id NULL; o IN no CTE desfeitos limita aos reparos que o UPDATE
 738|           -- realmente pegou, então quem escapou do predicado na corrida não é tocado.
 739|           UPDATE interesse_reparos ir SET status = 'expirado'
 740|             FROM unnest($1::uuid[], $2::uuid[]) AS alvo(reparo_id, usuario_id)
 741|            WHERE ir.reparo_id = alvo.reparo_id AND ir.usuario_id = alvo.usuario_id
 742|              AND ir.status = 'aceito'
 743|              AND alvo.reparo_id IN (SELECT id FROM desfeitos)
 744|           RETURNING ir.id
 745|         )
 746|         SELECT id FROM desfeitos
 747|       `, [candidatos.rows.map(c => c.id), candidatos.rows.map(c => c.match_usuario_id)])
 748|       expiradosCount = expirados.rows.length
 749| 
 750|       // Só notifica e contabiliza falta para quem o UPDATE realmente pegou. Os dois lados
 751|       // continuam sendo avisados do fim do match mesmo na isenção — o que muda é só a punição.
 752|       // try/catch POR LINHA: notificarMatchDesfeito faz query de token e pode estourar. Sem o
 753|       // guard, uma linha ruim jogava para o catch da função e as SEGUINTES ficavam sem aviso e
 754|       // sem falta, com o un-match já commitado para todas. registrarFalta já se protege sozinha.
 755|       const atualizados = new Set(expirados.rows.map(r => r.id))
 756|       for (const c of candidatos.rows) {
 757|         if (!atualizados.has(c.id)) continue
 758|         try {
 759|           await notificarMatchDesfeito('reparos', c)
 760|         } catch (err) {
 761|           console.error(`[CronômetroReparos] falha ao notificar match desfeito ${c.id}:`, err.message)
 762|         }
 763|         if (!isentoPorRecusa(c)) await registrarFalta('reparos', c)
 764|       }
 765|     }
 766| 
 767|     console.log(`[CronômetroReparos] 5min notificados: ${cincoMin.rows.length} | matches expirados (devolvidos ao feed): ${expiradosCount}`)
 768|   } catch (err) {
 769|     console.error('Erro ao verificar cronômetro de reparos:', err.message)
 770|   }
 771| }
 772| 
 773| // Cronômetro de matches de obras — espelha verificarCronometroReparos com as colunas reais de obra.
 774| // Prazo pós-match: COALESCE(chegada_prevista_em, expira_em) — a janela prometida pelo pintor
 775| // manda quando existe; sem ela, segue o expira_em ORIGINAL (o match não reseta expira_em).
 776| // (a) A 5 minutos do fim: avisa o dono uma única vez por match (notif_5min_enviada).
 777| // (b) Quando o prazo zera: devolve a obra ao feed e limpa o match, reiniciando a janela
 778| //     PRÉ-match (horas_para_expirar) para a próxima rodada de candidatos.
 779| // Chegada declarada ou confirmada congela os dois ramos (mesma regra do cron de reparos).
 780| const verificarCronometroObras = async () => {
 781|   try {
 782|     // (a) 5 minutos restantes → notifica o dono (uma vez por match)
 783|     const cincoMin = await pool.query(`
 784|       SELECT o.id, o.titulo, u.push_token
 785|       FROM obras o
 786|       JOIN usuarios u ON o.criado_por = u.id
 787|       WHERE o.status = 'aberta'
 788|         AND o.match_usuario_id IS NOT NULL
 789|         AND o.notif_5min_enviada = false
 790|         AND u.push_token IS NOT NULL
 791|         AND o.chegada_declarada_em IS NULL
 792|         AND o.chegada_confirmada_em IS NULL
 793|         AND COALESCE(o.chegada_prevista_em, o.expira_em) BETWEEN NOW() AND NOW() + INTERVAL '5 minutes'
 794|     `)
 795| 
 796|     if (cincoMin.rows.length > 0) {
 797|       const ids = cincoMin.rows.map(o => o.id)
 798|       await pool.query(`UPDATE obras SET notif_5min_enviada = true WHERE id = ANY($1)`, [ids])
 799| 
 800|       for (const obra of cincoMin.rows) {
 801|         await enviarPushNotificacao(
 802|           obra.push_token,
 803|           '⏰ O pintor ainda não chegou?',
 804|           'Faltam 5 minutos. Se ele ainda não chegou, você pode aumentar o prazo ou aguardar o cronômetro zerar.',
 805|           { tipo: 'obra_5min_restantes', obra_id: obra.id }
 806|         )
 807|       }
 808|     }
 809| 
 810|     // (b) Cronômetro zerou → devolve a obra ao feed e limpa o match, reiniciando a contagem
 811|     // com a janela original. COALESCE(horas_para_expirar, 720): horas_para_expirar pode ser NULL
 812|     // em obras legadas; sem o COALESCE, NOW() + NULL = NULL e a obra sumiria do feed para sempre
 813|     // (expira_em > NOW() nunca casa NULL). 720h = default de criação (mesma base de index.js:960).
 814|     // SELECT antes do UPDATE pelo mesmo motivo do cron de reparos: RETURNING traz a linha nova,
 815|     // com match_usuario_id já NULL, e é ele que precisamos para bloquear e notificar o pintor.
 816|     const PRED_EXPIRADOS_OBRAS = `
 817|       status = 'aberta'
 818|         AND match_usuario_id IS NOT NULL
 819|         AND chegada_declarada_em IS NULL
 820|         AND chegada_confirmada_em IS NULL
 821|         AND COALESCE(chegada_prevista_em, expira_em) <= NOW()`
 822| 
 823|     // Mesma isenção do cron de reparos (ver isentoPorRecusa).
 824|     const candidatos = await pool.query(`
 825|       SELECT id, titulo, criado_por, match_usuario_id,
 826|              chegada_recusada_em, chegada_pendente_em, chegada_prevista_em
 827|         FROM obras WHERE ${PRED_EXPIRADOS_OBRAS}
 828|     `)
 829| 
 830|     let expiradosCount = 0
 831|     if (candidatos.rows.length > 0) {
 832|       const expirados = await pool.query(`
 833|         WITH desfeitos AS (
 834|           UPDATE obras SET
 835|             status = 'aberta',
 836|             match_feito_em = NULL,
 837|             match_usuario_id = NULL,
 838|             notif_5min_enviada = false,
 839|             -- Marcos re-armados junto com o expira_em novo, exatamente como POST
 840|             -- /obras/:id/estender já faz: a obra volta ao feed com prazo novo, então os 3
 841|             -- avisos de expiração precisam valer de novo. Sem isto ela carregava os marcos
 842|             -- já gastos da PRIMEIRA vida e não recebia aviso nenhum na segunda — o candidato
 843|             -- da query de marcos exige ao menos um marco NULL, então ela nem era varrida.
 844|             marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL,
 845|             -- pedido_tempo_* zerados como o cron de reparos já fazia (D76): sem isto a obra
 846|             -- voltava ao feed carregando o pedido de tempo do pintor que furou, e o próximo
 847|             -- match nascia "aguardando aprovação" de alguém que já saiu.
 848|             pedido_tempo_status = NULL,
 849|             pedido_tempo_motivo = NULL,
 850|             pedido_tempo_minutos = NULL,
 851|             chegada_janela = NULL,
 852|             chegada_prevista_em = NULL,
 853|             chegada_declarada_por = NULL,
 854|             chegada_declarada_em = NULL,
 855|             chegada_pendente_janela = NULL,
 856|             chegada_pendente_em = NULL,
 857|             chegada_recusada_em = NULL,
 858|             prestadores_bloqueados = CASE
 859|               -- Isenção: janela oferecida que nunca virou compromisso — recusada pelo dono OU
 860|               -- morta pendente sem resposta — e nenhuma outra valendo. Não bloqueia.
 861|               WHEN chegada_prevista_em IS NULL
 862|                    AND (chegada_recusada_em IS NOT NULL OR chegada_pendente_em IS NOT NULL)
 863|               THEN prestadores_bloqueados
 864|               WHEN match_usuario_id = ANY(COALESCE(prestadores_bloqueados, '{}'))
 865|               THEN prestadores_bloqueados
 866|               ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), match_usuario_id) END,
 867|             -- Faixa "Hoje" — mesma regra do cron de reparos: volta ao fim do dia corrente,
 868|             -- nunca a horas_para_expirar novas. O dia é o do DONO (prazo_timezone), não o de
 869|             -- São Paulo: para um dono em Rio Branco o cron resolveria o dia errado.
 870|             expira_em = CASE WHEN prazo_modo = '${PRAZO_MODO_HOJE}' THEN ${sqlFimDoDia(SQL_ZONA_DA_OBRA)}
 871|                              ELSE NOW() + (COALESCE(horas_para_expirar, 720) * INTERVAL '1 hour') END
 872|           WHERE id = ANY($1::uuid[]) AND ${PRED_EXPIRADOS_OBRAS}
 873|           RETURNING id
 874|         ), propostas AS (
 875|           -- Candidatura vencedora expira junto com o match (ver o cron de reparos para o
 876|           -- porquê dos dois arrays paralelos e do IN no CTE desfeitos).
 877|           UPDATE candidaturas c SET status = 'expirado'
 878|             FROM unnest($1::uuid[], $2::uuid[]) AS alvo(obra_id, usuario_id)
 879|            WHERE c.obra_id = alvo.obra_id AND c.usuario_id = alvo.usuario_id
 880|              AND c.status = 'aceito'
 881|              AND alvo.obra_id IN (SELECT id FROM desfeitos)
 882|           RETURNING c.id
 883|         )
 884|         SELECT id FROM desfeitos
 885|       `, [candidatos.rows.map(c => c.id), candidatos.rows.map(c => c.match_usuario_id)])
 886|       expiradosCount = expirados.rows.length
 887| 
 888|       // try/catch por linha pelo mesmo motivo do cron de reparos.
 889|       const atualizados = new Set(expirados.rows.map(o => o.id))
 890|       for (const c of candidatos.rows) {
 891|         if (!atualizados.has(c.id)) continue
 892|         try {
 893|           await notificarMatchDesfeito('obras', c)
 894|         } catch (err) {
 895|           console.error(`[CronômetroObras] falha ao notificar match desfeito ${c.id}:`, err.message)
 896|         }
 897|         if (!isentoPorRecusa(c)) await registrarFalta('obras', c)
 898|       }
 899|     }
 900| 
 901|     console.log(`[CronômetroObras] 5min notificados: ${cincoMin.rows.length} | matches expirados (devolvidos ao feed): ${expiradosCount}`)
 902|   } catch (err) {
 903|     console.error('Erro ao verificar cronômetro de obras:', err.message)
 904|   }
 905| }
 906| 
 907| // Encerramento assimétrico: fecha sozinho a solicitação do profissional que o dono não
 908| // confirmou no prazo. Sem isto um dono silencioso deixaria a demanda pendente para sempre.
 909| // status = 'aberta' no WHERE (mesma lição do cron de reparos): a demanda só é candidata
 910| // enquanto NÃO está encerrada. Notifica quem NÃO pediu — quem pediu já sabe.
 911| //
 912| // O prazo é POR TABELA, como já era o da chegada: um serviço é trabalho curto, começa e
 913| // termina no mesmo dia, e 3h de espera pela confirmação do dono cabem dentro dele; uma obra
 914| // corre noutra cadência, e fechar a solicitação do profissional em 3h ali seria errado — por
 915| // isso a obra mantém os 2 dias originais. O sufixo de cada constante é o nome da tabela a
 916| // que ela se aplica (lado.tabela), então casar constante e lado não exige tradução nenhuma.
 917| const AUTO_ENCERRAR_APOS_OBRAS   = '2 days'
 918| const AUTO_ENCERRAR_APOS_REPAROS = '3 hours'
 919| 
 920| // Rótulo pt-BR DERIVADO do próprio INTERVAL aplicado, em vez de escrito à mão ao lado dele:
 921| // o push anuncia exatamente o prazo que o WHERE cobra, e não há um segundo valor para
 922| // esquecer de mudar. Cobre as unidades usadas aqui; qualquer outra cai no fallback e o push
 923| // sai com o intervalo cru, o que é feio mas não quebra o encerramento (já commitado).
 924| const UNIDADES_PRAZO = { day: ['dia', 'dias'], hour: ['hora', 'horas'], minute: ['minuto', 'minutos'] }
 925| const rotuloPrazo = (intervalo) => {
 926|   const [qtd, unidade = ''] = intervalo.split(' ')
 927|   const par = UNIDADES_PRAZO[unidade.replace(/s$/, '')]
 928|   return par ? `${qtd} ${Number(qtd) === 1 ? par[0] : par[1]}` : intervalo
 929| }
 930| 
 931| // Auto-confirmação da chegada: o profissional declarou, o dono nunca respondeu. Vencido o
 932| // prazo a declaração vale por si — sem isto a demanda fica travada em "declarada mas não
 933| // confirmada" para sempre (e, como chegada_declarada_em congela os dois crons, também nunca
 934| // volta ao feed). O prazo é POR TABELA (chegadaApos): um reparo é uma visita curta, e 6h de
 935| // limbo cobriam o serviço inteiro; uma obra se mede em horas e mantém as 6h de antes.
 936| // chegadaRotulo anda junto do intervalo porque o mesmo prazo aparece no texto do push — se
 937| // só um dos dois mudasse, o profissional seria avisado de um prazo que não é o aplicado.
 938| 
 939| const autoEncerrarPendentes = async () => {
 940|   // tabela, coluna de id e prazos saem desta lista literal, nunca do request — interpolação segura.
 941|   const lados = [
 942|     { tabela: 'obras',   chave: 'obra_id',   tipoPush: 'obra_encerrada',    rotulo: 'a obra',
 943|       encerrarApos: AUTO_ENCERRAR_APOS_OBRAS,
 944|       chegadaApos: '6 hours',   chegadaRotulo: '6 horas' },
 945|     { tabela: 'reparos', chave: 'reparo_id', tipoPush: 'reparo_encerrado',  rotulo: 'o serviço',
 946|       encerrarApos: AUTO_ENCERRAR_APOS_REPAROS,
 947|       chegadaApos: '30 minutes', chegadaRotulo: '30 minutos' }
 948|   ]
 949|   for (const lado of lados) {
 950|     try {
 951|       const fechados = await pool.query(`
 952|         UPDATE ${lado.tabela} SET
 953|           status = 'encerrada',
 954|           status_aprovacao = 'encerrada',
 955|           encerrado_em = NOW(),
 956|           encerramento_solicitado_por = NULL,
 957|           encerramento_solicitado_em = NULL
 958|         WHERE status = 'aberta'
 959|           AND encerramento_solicitado_por IS NOT NULL
 960|           AND encerramento_solicitado_em <= NOW() - INTERVAL '${lado.encerrarApos}'
 961|         RETURNING id, titulo, criado_por, match_usuario_id, encerramento_solicitado_por
 962|       `)
 963|       for (const d of fechados.rows) {
 964|         // Quem NÃO solicitou é quem precisa ser avisado do fechamento automático.
 965|         const avisarId = d.encerramento_solicitado_por === d.criado_por ? d.match_usuario_id : d.criado_por
 966|         if (!avisarId) continue
 967|         const alvo = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [avisarId])
 968|         if (alvo.rows[0]?.push_token) {
 969|           enviarPushNotificacao(alvo.rows[0].push_token, '✅ Encerrado automaticamente',
 970|             `Sem confirmação em ${rotuloPrazo(lado.encerrarApos)}, ${lado.rotulo} "${d.titulo}" foi encerrad${lado.tabela === 'obras' ? 'a' : 'o'} automaticamente.`,
 971|             { tipo: lado.tipoPush, [lado.chave]: d.id }).catch(() => {})
 972|         }
 973|       }
 974|       if (fechados.rows.length > 0) {
 975|         console.log(`[AutoEncerrar] ${lado.tabela}: ${fechados.rows.length} encerrad(a)s por falta de confirmação`)
 976|       }
 977| 
 978|       // Chegada declarada há mais do que o prazo da tabela e nunca confirmada pelo dono →
 979|       // confirma sozinho. Query separada (não um SET a mais no UPDATE acima): são regras
 980|       // independentes — encerramento em duas mãos vs. chegada em duas mãos — com prazos e
 981|       // predicados próprios, e a maioria das linhas candidatas a uma não é candidata à outra.
 982|       const chegadas = await pool.query(`
 983|         UPDATE ${lado.tabela} SET chegada_confirmada_em = NOW()
 984|         WHERE chegada_declarada_em IS NOT NULL
 985|           AND chegada_confirmada_em IS NULL
 986|           AND chegada_declarada_em <= NOW() - INTERVAL '${lado.chegadaApos}'
 987|         RETURNING id, titulo, match_usuario_id
 988|       `)
 989|       for (const c of chegadas.rows) {
 990|         // Avisa o profissional, fechando a lacuna: era o ÚNICO caminho de confirmação que
 991|         // não notificava ninguém. tipo 'chegada_confirmada' é o mesmo do POST /:id/chegada
 992|         // (o app trata os dois igual); só o texto muda, porque aqui o dono NÃO confirmou —
 993|         // venceu o prazo. Mesma construção do aviso de encerramento automático acima.
 994|         if (!c.match_usuario_id) continue
 995|         const prof = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [c.match_usuario_id])
 996|         if (prof.rows[0]?.push_token) {
 997|           enviarPushNotificacao(prof.rows[0].push_token, '✅ Chegada confirmada!',
 998|             `Sem confirmação do solicitante em ${lado.chegadaRotulo}, sua chegada em "${c.titulo}" foi confirmada automaticamente.`,
 999|             { tipo: 'chegada_confirmada', [lado.chave]: c.id }).catch(() => {})
1000|         }
1001|       }
1002|       if (chegadas.rows.length > 0) {
1003|         console.log(`[AutoConfirmarChegada] ${lado.tabela}: ${chegadas.rows.length} chegada(s) confirmada(s) por decurso de prazo`)
1004|       }
1005|     } catch (err) {
1006|       console.error(`[AutoEncerrar] Erro em ${lado.tabela}:`, err.message)
1007|     }
1008|   }
1009| }
1010| 
1011| module.exports = {
1012|   enviarPushNotificacao,
1013|   enviarBoasVindas,
1014|   notificarPintoresSobreNovaObra,
1015|   notificarPrestadoresSobreNovoReparo,
1016|   verificarObrasExpirando,
1017|   verificarObrasComBaixoEngajamento,
1018|   verificarMarcosExpiracao,
1019|   verificarCronometroReparos,
1020|   verificarCronometroObras,
1021|   autoEncerrarPendentes,
1022|   // Exportadas para o painel admin (GET /admin/suspensos e o liberar) usarem EXATAMENTE a mesma
1023|   // janela e o mesmo limite que o cron aplica — antes a rota tinha uma cópia '90 days' própria,
1024|   // que passaria a mentir na primeira vez que este valor mudasse.
1025|   JANELA_FALTAS,
1026|   FALTAS_PARA_SUSPENDER
```

### server.js:227-375 — Proximidade (só reparos) e limpeza de mídias antigas

```js
227| const verificarPrestadoresProximos = async () => {
228|   try {
229|     // Redesenho: dispara sobre reparos ARMADOS (aberturas_detalhe.notificado=false — o reparador
230|     // abriu o detalhe estando a >5km do cadastro) quando a posição AO VIVO chega a <5km.
231|     // Reparadores + reparos APENAS (obras/pintores removidos). O dedup agora é
232|     // aberturas_detalhe.notificado (claim atômico), NÃO mais proximidade_notificacoes (vestigial).
233|     //
234|     // Uma linha = um par (reparador armado, reparo) elegível: reparo válido (aberta/aprovada/não
235|     // expirado/sem match/com coords — mesma validade do endpoint app-open), reparador com
236|     // localização fresca (<30min), assinatura ativa, tier ESTRITO reparador (= exigirReparador:
237|     // role='prestador' AND tipo_prestador='reparador'), push_token, e sem engajamento prévio.
238|     const armados = await pool.query(`
239|       SELECT ad.reparador_id, ad.reparo_id,
240|              r.titulo, r.cidade, r.coordenadas_origem,
241|              r.latitude  AS r_lat, r.longitude AS r_lng,
242|              lp.latitude AS p_lat, lp.longitude AS p_lng,
243|              u.push_token
244|       FROM aberturas_detalhe ad
245|       JOIN reparos r                 ON r.id = ad.reparo_id
246|       JOIN localizacoes_prestadores lp ON lp.usuario_id = ad.reparador_id
247|       JOIN usuarios u                ON u.id = ad.reparador_id
248|       JOIN assinaturas a             ON a.usuario_id = u.id AND a.status = 'ativa'
249|       WHERE ad.notificado = false
250|         AND r.status = 'aberta' AND r.status_aprovacao = 'aprovada'
251|         AND r.expira_em > NOW() AND r.match_usuario_id IS NULL
252|         AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL
253|         AND lp.atualizado_em > NOW() - INTERVAL '30 minutes'
254|         AND u.push_token IS NOT NULL
255|         AND u.role = 'prestador' AND u.tipo_prestador = 'reparador'
256|         -- Suspenso por faltas não recebe isca de trabalho novo. Aqui é filtro de QUERY (não
257|         -- middleware): quem dispara o cron é o servidor, não o prestador.
258|         AND u.suspenso_em IS NULL
259|         AND NOT (ad.reparador_id = ANY(COALESCE(r.prestadores_bloqueados, '{}')))
260|         AND NOT EXISTS (
261|           SELECT 1 FROM interesse_reparos ir
262|           WHERE ir.reparo_id = r.id AND ir.usuario_id = ad.reparador_id
263|         )
264|     `)
265| 
266|     let notifReparos = 0
267|     for (const par of armados.rows) {
268|       const distLat = Math.abs(par.p_lat - par.r_lat)
269|       const distLon = Math.abs(par.p_lng - par.r_lng)
270|       if (distLat > RAIO_GRAUS || distLon > RAIO_GRAUS) continue
271|       const dLat = distLat * 111
272|       const dLon = distLon * 111 * Math.cos(par.p_lat * Math.PI / 180)
273|       const distanciaKm = Math.sqrt(dLat * dLat + dLon * dLon)
274|       if (distanciaKm > RAIO_KM) continue
275|       // CLAIM ATÔMICO (replica-safe): só envia se a linha ainda está notificado=false. Réplicas
276|       // do cron e o endpoint /feed/checar-proximidade competem pela mesma linha — só uma vence
277|       // (RETURNING). Sem linha retornada → já notificado → pula o push. One-time por reparo.
278|       const claim = await pool.query(
279|         `UPDATE aberturas_detalhe SET notificado = true
280|          WHERE reparador_id = $1 AND reparo_id = $2 AND notificado = false
281|          RETURNING reparo_id`,
282|         [par.reparador_id, par.reparo_id]
283|       )
284|       if (claim.rowCount === 0) continue
285|       await enviarPushNotificacao(
286|         par.push_token,
287|         '📍 Serviço próximo a você!',
288|         textoProximidade('um serviço', par.titulo, par.cidade, par.coordenadas_origem, distanciaKm),
289|         { tipo: 'reparo_proximo', reparo_id: par.reparo_id }
290|       ).catch(err => console.error('Erro push proximidade reparo:', err))
291|       notifReparos++
292|     }
293| 
294|     console.log(`[Proximidade] pares armados elegíveis: ${armados.rows.length} | notif enviadas: ${notifReparos}`)
295|   } catch (err) {
296|     console.error('[Proximidade] Erro na verificação:', err.message)
297|   }
298| }
299| 
300| const deletarMidiasAntigas = async () => {
301|   try {
302|     // Reparos MORTOS (encerrados ou cancelados) há mais de 7 dias com mídias ainda não
303|     // removidas. 'cancelada' entra junto porque demanda cancelada retém mídia igual à
304|     // encerrada — só 'encerrada' deixava a de recusado/cancelado no Cloudinary para sempre.
305|     // Janela de 7 dias inalterada.
306|     const reparosAntigos = await pool.query(`
307|       SELECT r.id, mr.id as midia_id, mr.url, mr.tipo
308|       FROM reparos r
309|       JOIN midias_reparos mr ON mr.reparo_id = r.id
310|       WHERE r.status IN ('encerrada', 'cancelada')
311|         AND r.encerrado_em IS NOT NULL
312|         AND r.encerrado_em < NOW() - INTERVAL '7 days'
313|     `)
314|     // As chamadas ao Cloudinary seguem UMA POR MÍDIA — é trabalho de rede por arquivo, não
315|     // há o que agrupar. O que sai do laço é só o DELETE: junta os ids que de fato saíram do
316|     // Cloudinary e apaga tudo num statement, em vez de um DELETE por mídia.
317|     const removidosReparos = []
318|     for (const m of reparosAntigos.rows) {
319|       const sucesso = await deletarDoCloudinary(m.url, m.tipo)
320|       if (sucesso) removidosReparos.push(m.midia_id)
321|     }
322|     if (removidosReparos.length > 0) {
323|       await pool.query(`DELETE FROM midias_reparos WHERE id = ANY($1::uuid[])`, [removidosReparos])
324|     }
325|     if (reparosAntigos.rows.length > 0) {
326|       console.log(`[MidiasAntigas] ${reparosAntigos.rows.length} mídias de reparos processadas, ${removidosReparos.length} removida(s)`)
327|     }
328| 
329|     // Obras MORTAS (encerradas ou canceladas) há mais de 7 dias — mesmo racional do lado reparo.
330|     const obrasAntigas = await pool.query(`
331|       SELECT o.id, m.id as midia_id, m.url, m.tipo
332|       FROM obras o
333|       JOIN midias m ON m.obra_id = o.id
334|       WHERE o.status IN ('encerrada', 'cancelada')
335|         AND o.encerrado_em IS NOT NULL
336|         AND o.encerrado_em < NOW() - INTERVAL '7 days'
337|     `)
338|     const removidosObras = []
339|     for (const m of obrasAntigas.rows) {
340|       const sucesso = await deletarDoCloudinary(m.url, m.tipo)
341|       if (sucesso) removidosObras.push(m.midia_id)
342|     }
343|     if (removidosObras.length > 0) {
344|       await pool.query(`DELETE FROM midias WHERE id = ANY($1::uuid[])`, [removidosObras])
345|     }
346|     if (obrasAntigas.rows.length > 0) {
347|       console.log(`[MidiasAntigas] ${obrasAntigas.rows.length} mídias de obras processadas, ${removidosObras.length} removida(s)`)
348|     }
349| 
350|     // Terceiro braço: fila de ÓRFÃS — mídias cuja linha já sumiu (exclusão de conta, limpezas
351|     // do admin, troca de slot no upload). Os dois braços acima só enxergam mídia através da
352|     // demanda; sem esta fila, arquivo de linha apagada nunca mais era alcançado.
353|     // Sem janela de 7 dias aqui de propósito: a linha já não existe, não há o que reter.
354|     // LIMIT 200 porque uma exclusão de conta pode enfileirar muita coisa de uma vez — o resto
355|     // sai nas rodadas seguintes, já que a linha da fila só some quando o Cloudinary confirma.
356|     const orfas = await pool.query(`SELECT url, tipo FROM midias_orfas ORDER BY criado_em LIMIT 200`)
357|     if (orfas.rows.length > 0) {
358|       const urlsRemovidas = []
359|       for (const m of orfas.rows) {
360|         const sucesso = await deletarDoCloudinary(m.url, m.tipo)
361|         if (sucesso) urlsRemovidas.push(m.url)
362|       }
363|       // Só sai da fila o que o Cloudinary confirmou (o helper trata 'not found' como sucesso,
364|       // então arquivo já apagado também limpa a fila em vez de ficar preso para sempre).
365|       if (urlsRemovidas.length > 0) {
366|         await pool.query(`DELETE FROM midias_orfas WHERE url = ANY($1::text[])`, [urlsRemovidas])
367|       }
368|       console.log(`[MidiasAntigas] fila de órfãs: ${orfas.rows.length} processada(s), ${urlsRemovidas.length} removida(s)`)
369|     }
370|   } catch (err) {
371|     console.error('[MidiasAntigas] Erro:', err.message)
372|   }
373| }
374| 
375| const expirarAssinaturasVencidas = async () => {
```

### server.js:505-725 — Lembrete de avaliação, agendador (intervalos), boot: migração antes de listen, keep-alive

```js
505| const lembrarAvaliacaoPendente = async () => {
506|   let totalEnviados = 0
507|   try {
508|     for (const lado of LADOS_AVALIACAO) {
509|       // Candidatos: encerrados COM match, dentro do teto e com pelo menos um marco pendente.
510|       // push_token vazio/nulo já sai daqui — não há o que enviar.
511|       // O NOT EXISTS é o predicado de "ainda não avaliou": avaliacoes tem
512|       // UNIQUE(contrato_tipo, contrato_id, avaliador_id) e o avaliador é sempre o DONO
513|       // (POST /avaliacoes dá 403 no prestador), então a ausência da linha para
514|       // avaliador_id = d.criado_por é exatamente "este dono não avaliou este contrato".
515|       // Por avaliador_id, e não por contrato: linhas legadas prestador→dono não podem contar
516|       // como avaliação do dono. (Em produção não há nenhuma, mas o predicado não depende disso.)
517|       const candidatos = await pool.query(`
518|         SELECT d.id, d.titulo, d.encerrado_em, d.aval_marco_1_em, d.aval_marco_2_em, u.push_token
519|           FROM ${lado.tabela} d
520|           JOIN usuarios u ON u.id = d.criado_por
521|          WHERE d.status = 'encerrada'
522|            AND d.match_usuario_id IS NOT NULL
523|            AND d.encerrado_em IS NOT NULL
524|            AND d.aval_dispensada_em IS NULL
525|            AND (d.aval_marco_1_em IS NULL OR d.aval_marco_2_em IS NULL)
526|            AND d.encerrado_em <= NOW() - INTERVAL '${MARCOS_AVALIACAO[0].dias} days'
527|            AND d.encerrado_em >  NOW() - INTERVAL '${TETO_LEMBRETE_AVALIACAO_DIAS} days'
528|            AND u.push_token IS NOT NULL AND u.push_token <> ''
529|            AND NOT EXISTS (
530|              SELECT 1 FROM avaliacoes a
531|               WHERE a.contrato_tipo = '${lado.tipo}'
532|                 AND a.contrato_id = d.id
533|                 AND a.avaliador_id = d.criado_por
534|            )
535|       `)
536| 
537|       for (const d of candidatos.rows) {
538|         const decorridoDias = (Date.now() - new Date(d.encerrado_em).getTime()) / 86400000
539| 
540|         // Banda disjunta — no máximo um marco por run (mesma lógica do aviso de vencimento,
541|         // com o teto no lugar do piso 0 porque aqui o tempo corre para cima).
542|         const alvo = MARCOS_AVALIACAO.find((m, i) => {
543|           const topo = MARCOS_AVALIACAO[i + 1]?.dias ?? TETO_LEMBRETE_AVALIACAO_DIAS
544|           return d[m.col] === null && decorridoDias >= m.dias && decorridoDias < topo
545|         })
546|         if (!alvo) continue
547| 
548|         // Claim-then-send: reivindica a coluna no MESMO UPDATE. Linha já reivindicada por
549|         // outra réplica (ou por um run anterior) não volta no RETURNING e não gera 2º envio.
550|         const claim = await pool.query(
551|           `UPDATE ${lado.tabela} SET ${alvo.col} = NOW() WHERE id = $1 AND ${alvo.col} IS NULL RETURNING id`,
552|           [d.id]
553|         )
554|         if (claim.rows.length === 0) continue
555| 
556|         const titulo = alvo.n === 1 ? '⭐ Como foi o serviço?' : '⭐ Sua avaliação ainda ajuda'
557|         const corpo = alvo.n === 1
558|           ? `Avalie ${lado.profissional} de "${d.titulo}". Leva 10 segundos e ajuda outros solicitantes.`
559|           : `Você ainda não avaliou ${lado.rotulo} "${d.titulo}". Sua nota ajuda quem for contratar depois.`
560|         enviarPushNotificacao(d.push_token, titulo, corpo,
561|           { tipo: 'avaliacao_pendente', [lado.chave]: d.id }).catch(() => {})
562|         totalEnviados++
563|       }
564|     }
565|     console.log(`[LembreteAvaliacao] ${totalEnviados} lembrete(s) de avaliação enviado(s)`)
566|   } catch (err) {
567|     console.error('[LembreteAvaliacao] Erro:', err.message)
568|   }
569| }
570| 
571| const iniciarAgendador = () => {
572|   const INTERVALO_ENGAJAMENTO  = 8 * 60 * 60 * 1000
573|   const INTERVALO_EXPIRACAO    = 60 * 60 * 1000
574|   const INTERVALO_PROXIMIDADE  = 10 * 60 * 1000
575|   const INTERVALO_CRONOMETRO   = 60 * 1000
576|   const INTERVALO_AUTO_ENCERRAR = 5 * 60 * 1000
577| 
578|   setTimeout(() => {
579|     verificarObrasComBaixoEngajamento()
580|     // APOSENTADO: verificarObrasExpirando() enviava o texto fixo "expira em 24 horas!" para qualquer
581|     // demanda a <24h de expira_em, independente do tempo real restante. Substituído por
582|     // verificarMarcosExpiracao (marcos proporcionais à faixa de prazo). Função mantida em
583|     // alertaService.js, apenas não é mais agendada nem disparada no boot.
584|     // verificarObrasExpirando()
585|     verificarPrestadoresProximos()
586|     verificarMarcosExpiracao()
587|     verificarCronometroReparos()
588|     verificarCronometroObras()
589|     // Entram no warm-up porque o intervalo deles é de 24h e CADA deploy reinicia o timer:
590|     // com redeploys mais frequentes que um dia, o primeiro tique nunca chegava e a limpeza
591|     // simplesmente não acontecia. Aqui rodam ao menos uma vez por deploy.
592|     deletarMidiasAntigas()
593|     limparTentativasAntigas()
594|   }, 60 * 1000)
595| 
596|   setInterval(() => { verificarObrasComBaixoEngajamento() }, INTERVALO_ENGAJAMENTO)
597|   // APOSENTADO (ver comentário acima): expiração agora é notificada SÓ por verificarMarcosExpiracao.
598|   // setInterval(() => { verificarObrasExpirando() }, INTERVALO_EXPIRACAO)
599|   setInterval(() => { verificarPrestadoresProximos() }, INTERVALO_PROXIMIDADE)
600|   setInterval(() => { verificarMarcosExpiracao() }, INTERVALO_CRONOMETRO)
601|   setInterval(() => { verificarCronometroReparos() }, INTERVALO_CRONOMETRO)
602|   setInterval(() => { verificarCronometroObras() }, INTERVALO_CRONOMETRO)
603|   setInterval(() => { deletarMidiasAntigas() }, 24 * 60 * 60 * 1000)
604|   // Poda das tentativas de auth: a tabela acumula linhas de e-mails inexistentes, que é o
605|   // preço de contar TODOS (o que fecha o oráculo de existência de conta).
606|   setInterval(() => { limparTentativasAntigas() }, 24 * 60 * 60 * 1000)
607|   setInterval(() => { expirarAssinaturasVencidas() }, 60 * 60 * 1000)
608|   // De 5 em 5 minutos. Era de hora em hora, justificado pelo prazo (então de 2 dias) do
609|   // encerramento — mas a MESMA função também auto-confirma chegada, e esse prazo passou a ser
610|   // de 30 min nos reparos. Uma varredura horária é mais grossa que a própria janela: o reparo
611|   // ficava elegível aos 30 min e só era pego no tique seguinte (30–90 min reais, ~60 em média),
612|   // então o valor configurado virava um piso, não o comportamento. A 5 min a folga cai para
613|   // 30–35 min. O encerramento (2 dias numa obra, 3 horas num reparo) também não se importa
614|   // com a cadência mais fina; o custo é apenas o SELECT/UPDATE dos dois lados, indexado e
615|   // quase sempre vazio.
616|   setInterval(() => { autoEncerrarPendentes() }, INTERVALO_AUTO_ENCERRAR)
617|   // De hora em hora como o job de expiração: as bandas de 12h e 6h não existem numa cadência
618|   // diária — um tick por dia pularia as duas mais urgentes.
619|   setInterval(() => { notificarAssinaturasProximasVencimento() }, 60 * 60 * 1000)
620|   // De hora em hora, como o aviso de vencimento. As bandas aqui são de DIAS, então uma
621|   // cadência horária é folgada de sobra: o lembrete sai no máximo ~1h depois de o contrato
622|   // completar 1 (ou 3) dia(s) encerrado. Fora do warm-up pelo mesmo motivo que o aviso de
623|   // vencimento: nada aqui é urgente o bastante para justificar disparar a cada deploy.
624|   setInterval(() => { lembrarAvaliacaoPendente() }, 60 * 60 * 1000)
625|   // Descarga do buffer de visitas (src/utils/visitas.js): agrupa as visitas da janela num
626|   // UPDATE por tabela, em vez de um UPDATE por visualização no caminho de leitura.
627|   iniciarFlushVisitas()
628| 
629|   setInterval(async () => {
630|     try {
631|       // Toggle "Modo Auto": OFF ('false' ou ausente) → admin presente, exige revisão manual.
632|       // Nenhuma aprovação automática acontece enquanto estiver OFF.
633|       const cfg = await pool.query(`SELECT valor FROM configuracoes WHERE chave = 'aprovacao_automatica'`)
634|       if (cfg.rows[0]?.valor !== 'true') return
635| 
636|       const pendentes = await pool.query(`
637|         SELECT u.id, u.nome, u.email, u.push_token
638|         FROM usuarios u
639|         JOIN assinaturas a ON a.usuario_id = u.id
640|         WHERE u.verificacao_status = 'pendente'
641|           AND a.status = 'pendente_verificacao'
642|           AND a.atualizado_em < NOW() - INTERVAL '1 hour'
643|       `)
644|       if (pendentes.rows.length === 0) return
645|       let aprovados = 0
646|       for (const p of pendentes.rows) {
647|         // CLAIM primeiro: `AND status = 'pendente_verificacao'` faz a transição acontecer UMA
648|         // vez só. Quem perder a corrida (outra réplica, ou este mesmo tique reexecutado) leva
649|         // rowCount 0 e sai — por isso o UPDATE de usuarios, os caches e o push ficam TODOS
650|         // atrás dele. Antes o push saía de novo a cada passagem.
651|         const claim = await pool.query(`UPDATE assinaturas SET status = 'ativa', atualizado_em = NOW(),
652|           proximo_vencimento = CASE
653|             WHEN tipo = 'gratuito' THEN NULL
654|             WHEN plano = 'anual'   THEN GREATEST(proximo_vencimento, NOW() + INTERVAL '365 days')
655|             ELSE                        GREATEST(proximo_vencimento, NOW() + INTERVAL '30 days') END,
656|           marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL
657|          WHERE usuario_id = $1 AND status = 'pendente_verificacao'
658|          RETURNING id`, [p.id])
659|         if (claim.rowCount === 0) continue
660| 
661|         // aprovado_automaticamente = true → idoneidade ainda não revisada (auditável no painel)
662|         await pool.query(`UPDATE usuarios SET verificacao_status = 'aprovado', aprovado_automaticamente = true WHERE id = $1`, [p.id])
663|         // Assinatura recém-ativada: limpa o cache de assinatura (middlewares/auth, TTL 30s)
664|         // p/ o app não cair na tela de pagamento com um `false` ainda cacheado (B72-07).
665|         // O bug original vinha de haver DOIS mapas e a invalidação limpar só um; hoje é um só.
666|         invalidarCachesUsuario(p.id)
667|         if (p.push_token) {
668|           await enviarPushNotificacao(p.push_token, '✅ Cadastro aprovado!', `Bem-vindo ao ${MARCA}! Seu acesso está liberado.`, { tipo: 'verificacao_aprovada' }).catch(() => {})
669|         }
670|         aprovados++
671|       }
672|       console.log(`[Timeout] ${aprovados} prestadores auto-aprovados por timeout de 1h (Modo Auto ON)`)
673|     } catch (err) {
674|       console.error('[Timeout verificação] Erro:', err.message)
675|     }
676|   }, 10 * 60 * 1000)
677| 
678|   console.log(`Agendador iniciado — engajamento: 8h | expiração: 1h | proximidade: 10min | verificação timeout: 10min | marcos expiração (6h/60/30/15min, reparos+obras): 1min | cronômetro reparos: 1min | cronômetro obras: 1min | mídias antigas: 24h | expiração assinaturas: 1h | aviso vencimento: 1h | lembrete avaliação (1d/3d): 1h | flush de visitas: ${INTERVALO_FLUSH_MS / 1000}s`)
679| }
680| 
681| rotasApp.migracaoPronta
682|   .then(() => {
683|     const server = app.listen(PORT, () => {
684|       console.log(`
685| ╔══════════════════════════════════════╗
686| ║   ${`${MARCA} API — v1.0.0`.padEnd(35)}║
687| ║   Rodando em http://localhost:${PORT}   ║
688| ╚══════════════════════════════════════╝
689|   `)
690|       console.log('[PagBank] token:', process.env.PAGBANK_TOKEN ? 'configurado' : 'AUSENTE', '| env:', process.env.PAGBANK_ENV || 'production')
691|       iniciarAgendador()
692|     })
693| 
694|     // Keep-alive: o default do Node é 5s, curto demais para um proxy à frente (o edge da
695|     // Railway mantém a conexão upstream por bem mais que isso). Com 5s, o proxy pode
696|     // escrever numa conexão que o Node acabou de fechar e a requisição morre como 502 —
697|     // sem nunca virar log de aplicação.
698|     //
699|     // A ORDEM DOS DOIS VALORES É OBRIGATÓRIA: headersTimeout > keepAliveTimeout. O default
700|     // de headersTimeout no Node 18 é 60000, MENOR que os 65000 abaixo — deixá-lo como está
701|     // faria o Node abortar conexões no meio da requisição. Se um dia mexer em um, mexa nos
702|     // dois. NÃO mexer em requestTimeout: os 300s do default são o que permite os uploads
703|     // grandes (express.json/urlencoded aceitam 100mb).
704|     server.keepAliveTimeout = 65000
705|     server.headersTimeout   = 70000
706| 
707|     // Desligamento gracioso — existe por UM motivo: descarregar o buffer de visitas antes
708|     // de sair, para um redeploy normal não perder a janela de até 30s acumulada em memória.
709|     //
710|     // ATENÇÃO: registrar handler de SIGTERM SUBSTITUI o default do Node (que encerra o
711|     // processo na hora). Se este caminho não terminar em process.exit, o redeploy fica
712|     // pendurado até a plataforma mandar SIGKILL — por isso o exit vai no `finally`, que roda
713|     // mesmo se o flush falhar. `once`: um segundo sinal não reentra no handler.
714|     const encerrarGraciosamente = (sinal) => {
715|       console.log(`[Shutdown] ${sinal} recebido — descarregando visitas pendentes`)
716|       flushVisitas()
717|         .catch(err => console.error('[Shutdown] flush de visitas falhou:', err.message))
718|         .finally(() => process.exit(0))
719|     }
720|     process.once('SIGTERM', () => encerrarGraciosamente('SIGTERM'))
721|     process.once('SIGINT',  () => encerrarGraciosamente('SIGINT'))
722|   })
723|   .catch((err) => {
724|     console.error('Falha na migração de boot — servidor não iniciado:', err)
725|     process.exit(1)
```


## 8. Migração de boot (esquema é criado/alterado aqui, idempotente, antes de o servidor ouvir)

### src/routes/index.js:1-50 — Requires e constantes de zona

```js
 1| require('dotenv').config()
 2| const express = require('express')
 3| const router = express.Router()
 4| const { autenticar, exigirAssinaturaAtiva, exigirNaoSuspenso, corpoContaSuspensa, exigirAdmin, exigirSuperAdmin, invalidarCacheAssinatura, assinaturaAtivaCacheada } = require('../middlewares/auth')
 5| const { registrarVisita } = require('../utils/visitas')
 6| const { pool } = require('../utils/supabase')
 7| const { MARCA } = require('../utils/marca')
 8| const authCtrl         = require('../controllers/authController')
 9| const obrasCtrl        = require('../controllers/obrasController')
10| const candidaturasCtrl = require('../controllers/candidaturasController')
11| const mensagensCtrl    = require('../controllers/mensagensController')
12| const pagamentoCtrl    = require('../controllers/pagamentoController')
13| const { upload, uploadMidia } = require('../controllers/uploadController')
14| const { uploadArquivo, gerarAssinaturaCloudinary, uploadParaCloudinary, gerarUrlAssinadaVerificacao } = require('../services/uploadService')
15| const { uploadMidiaStream } = require('../controllers/uploadStreamController')
16| const { enviarPushNotificacao, notificarPintoresSobreNovaObra, notificarPrestadoresSobreNovoReparo, JANELA_FALTAS, FALTAS_PARA_SUSPENDER } = require('../services/alertaService')
17| const { ufDeCidade } = require('../utils/localidade')
18| // Módulo inerte (dados puros): o marcador da faixa "Hoje" e a expressão SQL do fim do dia em
19| // America/Sao_Paulo. Compartilhado com alertaService, que reconstrói expira_em nos crons.
20| const { PRAZO_MODO_HOJE, TZ_PADRAO, sqlFimDoDia, SQL_FIM_DO_DIA_SP, FORMATO_ZONA_IANA, sqlZonaSegura } = require('../utils/faixasPrazo')
21| // Zona a usar quando a obra reconstrói expira_em depois da criação: a que o cliente mandou,
22| // validada CONTRA O CATÁLOGO na hora do uso, com recuo para o padrão. Cobre tanto a linha
23| // gravada antes de prazo_timezone existir (NULL) quanto a zona que deixou de ser reconhecida
24| // — esta última abortava o UPDATE inteiro do lote antes desta guarda.
25| const SQL_ZONA_DA_OBRA = sqlZonaSegura('obras.prazo_timezone')
26| // Mesma zona segura para o reparo (D78): a faixa "Hoje" do reparo resolvia sempre em São Paulo
27| // e não guardava a zona do dono; agora grava prazo_timezone no create e lê daqui em todo
28| // ponto que reconstrói o fim do dia (aprovação, estender, cron).
29| const SQL_ZONA_DO_REPARO = sqlZonaSegura('reparos.prazo_timezone')
30| const { coordsDeCidade, resolverBusca, montarFiltroGeo } = require('../utils/geoBusca')
31| const { enviarContratoReparo, enviarContratoObra } = require('../controllers/contratosController')
32| const { rejeitarConcorrentes } = require('../utils/rejeitarConcorrentes')
33| const { enviarEmail } = require('../services/emailService')
34| const bcrypt = require('bcrypt')
35| 
36| // Envolve um DELETE de mídia para que, NO MESMO statement, as urls apagadas caiam na fila
37| // midias_orfas — de onde deletarMidiasAntigas as remove do Cloudinary. Um só comando: se o
38| // DELETE entra, o registro da órfã entra junto; não há janela em que a linha some sem deixar
39| // rastro do arquivo.
40| // O argumento é o DELETE COMPLETO, com `RETURNING url, tipo` — cada call site continua
41| // mostrando o próprio WHERE, que é o que varia entre eles.
42| // ON CONFLICT (url): a mesma url enfileirada de novo é a mesma exclusão.
43| const enfileirarOrfas = (deleteComReturning) => `
44|   WITH del AS (${deleteComReturning})
45|   INSERT INTO midias_orfas (url, tipo) SELECT url, tipo FROM del ON CONFLICT (url) DO NOTHING`
46| const jwt = require('jsonwebtoken')
47| const speakeasy = require('speakeasy')
48| 
49| // One-time column migrations — single transaction so all columns land atomically or none do
50| const migracaoPronta = (async () => {
```
