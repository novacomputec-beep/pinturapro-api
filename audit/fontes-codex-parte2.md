# Fontes — Codex (parte 2 de 4)

Código-fonte REAL de `pinturapro-api` (branch `main`), selecionado para o auditor externo julgar as regras descritas em `dossie-codex.md`. Cada bloco traz `caminho:linha-inicial-linha-final` e cada linha vem prefixada com o número dela no arquivo. Nada de `.env`, segredos ou dados de produção — todos os segredos são lidos de `process.env`. Comentários foram mantidos porque carregam o racional de cada regra.

Seções: 1 gates · 2 dinheiro · 3 verificação/aprovação · 4 ciclo de vida OBRA · 5 ciclo de vida REPARO · 6 compartilhado · 7 crons · 8 migração de boot.


## (continuação) 4. Ciclo de vida — lado OBRA

### src/routes/index.js:2100-2238 — POST /obras/:id/estender: teto, carência 1h, faixa Hoje, dedupe, regra única restanteExtensao

```js
2100| 
2101| // Carência para estender obra de faixa longa (D89 — decisão do dono: a mesma regra dos dois
2102| // lados). Espelha CARENCIA_ESTENDER_REPARO_HORAS / FAIXA_LONGA_REPARO_HORAS: faixa > 24h ou
2103| // janela NULL só estende 1h após a PUBLICAÇÃO; faixas curtas (<= 24h) seguem sem carência.
2104| // A âncora da obra é COALESCE(publicado_em, criado_em) — a obra publica na aprovação, o
2105| // reparo na criação; é a mesma âncora que o advisory e o relógio de vida já usam.
2106| const CARENCIA_ESTENDER_OBRA_HORAS = 1
2107| const FAIXA_LONGA_OBRA_HORAS = 24
2108| 
2109| // Regra ÚNICA de "quanto ainda dá para estender" (D89), usada pelo endpoint e pelo detalhe
2110| // dos DOIS lados: teto plano menos as horas que expira_em já foi empurrado ALÉM do vencimento
2111| // original (âncora + janela). Envelhecer sem estender não consome teto. Antes eram três
2112| // números: obra-endpoint = 8760 − horas desta request; obra-detalhe = este acumulado;
2113| // reparo = 8760 constante.
2114| const restanteExtensao = (teto, ancora, janelaHoras, expiraEm) => {
2115|   const ancoraMs = new Date(ancora).getTime()
2116|   const expiraOriginalMs = ancoraMs + (Number(janelaHoras) || 720) * 3600 * 1000
2117|   const horasUsadas = Math.max(0, (new Date(expiraEm).getTime() - expiraOriginalMs) / 3600000)
2118|   return Math.max(0, teto - horasUsadas)
2119| }
2120| 
2121| // Janela de dedupe do estender de obra — espelha DEDUPE_ESTENDER_REPARO_MINUTOS. Sem
2122| // client_request_id no corpo, a chave é (ultima_extensao_em, ultima_extensao_horas): repetir o
2123| // MESMO horas dentro da janela é tratado como retry do mesmo clique — devolve o prazo atual sem
2124| // somar de novo. Fora da janela, ou com horas diferente, é uma extensão nova e legítima (o dono
2125| // pode estender duas vezes seguidas de propósito).
2126| const DEDUPE_ESTENDER_OBRA_MINUTOS = 5
2127| 
2128| // POST /obras/:id/estender — dono estende o prazo da própria obra, respeitando o teto plano
2129| // de 8760h. Re-arma TODOS os marcos de expiração (marco_6h/60/30/15_em = NULL):
2130| // como expira_em foi empurrado para frente, os 4 alertas precisam re-disparar contra o novo
2131| // prazo, senão a obra estendida mantém os marcos já gastos e não recebe nova contagem
2132| // regressiva. (Substitui o antigo clear de alerta_sem_interessados_em, cujo job foi aposentado.)
2133| router.post('/obras/:id/estender', autenticar, async (req, res) => {
2134|   try {
2135|     const obra = await pool.query(
2136|       `SELECT id, criado_por, status, match_usuario_id, expira_em, criado_em, publicado_em, horas_para_expirar,
2137|               prazo_modo, prazo_timezone
2138|        FROM obras WHERE id = $1 AND criado_por = $2`,
2139|       [req.params.id, req.usuario.id]
2140|     )
2141|     if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
2142|     const o = obra.rows[0]
2143|     if (o.status !== 'aberta') return res.status(409).json({ erro: 'Só é possível estender uma obra aberta' })
2144|     if (o.match_usuario_id) return res.status(409).json({ erro: 'Não é possível estender uma obra com pintor a caminho' })
2145| 
2146|     const horas = Number(req.body?.horas)
2147|     if (!Number.isFinite(horas) || horas < 1) return res.status(400).json({ erro: 'horas inválido: informe um número >= 1' })
2148|     if (horas > TETO_ESTENDER_OBRA_HORAS) {
2149|       return res.status(400).json({ erro: `horas inválido: máximo de ${TETO_ESTENDER_OBRA_HORAS} (365 dias)`, extensao_maxima_horas: TETO_ESTENDER_OBRA_HORAS })
2150|     }
2151| 
2152|     // Obra é SEMPRE estendida em dias inteiros — o modal do app manda dias * 24, mínimo 1 dia.
2153|     // O endpoint, porém, aceita qualquer inteiro de horas, então o valor é convertido aqui:
2154|     // CEIL para o dia seguinte em vez de recusar. Arredondar para CIMA e não para baixo porque
2155|     // o dono pediu MAIS prazo: 30h vira 2 dias, nunca 1. horas >= 1 (validado acima) garante
2156|     // dias >= 1, então não há extensão de zero dia.
2157|     const diasExtensao = Math.max(1, Math.ceil(horas / 24))
2158| 
2159|     // Só o novo expira_em: sem orçamento a calcular, a query perdeu a metade budget_antes.
2160|     //
2161|     // Dois ramos, e só o de "Hoje" mudou:
2162|     //
2163|     // FAIXA POR DURAÇÃO (prazo_modo NULL) — byte a byte o que sempre foi.
2164|     // GREATEST(expira_em, NOW()) preservado — obra já vencida estende a partir de agora, e
2165|     // não de um vencimento no passado (senão "+2h" compraria menos de 2h de vida real).
2166|     //
2167|     // FAIXA "HOJE" — o prazo é um INSTANTE DE CALENDÁRIO, não uma duração, então somar horas
2168|     // ao GREATEST convertia a meia-noite num horário de relógio para sempre: uma obra que
2169|     // venceu à meia-noite e é estendida às 09:00 caía em 09:00, não em meia-noite.
2170|     // Aqui a soma é de DIAS sobre o DIA, e o resultado volta a ser fim de dia:
2171|     //   base = o DIA mais tardio entre o do prazo guardado e o de hoje, no fuso do dono —
2172|     //          obra viva ganha dias a partir do PRÓPRIO prazo; obra vencida, a partir de hoje;
2173|     //   fim  = fim daquele dia + N dias (o +1 dia -1 microssegundo é o mesmo fecho de dia de
2174|     //          sqlFimDoDia, aplicado a um dia deslocado em vez de a hoje).
2175|     // A zona passa pelo MESMO lookup seguro dos caminhos de rebuild: zona morta ou NULL recua
2176|     // para São Paulo em vez de levantar 22023 (aqui derrubaria só esta request, mas o motivo
2177|     // para não confiar na coluna crua é o mesmo).
2178|     const cap = await pool.query(
2179|       `SELECT CASE WHEN $4::text = '${PRAZO_MODO_HOJE}' THEN (
2180|                      date_trunc('day', GREATEST(
2181|                        $1::timestamptz AT TIME ZONE ${sqlZonaSegura('$3::text')},
2182|                        NOW()           AT TIME ZONE ${sqlZonaSegura('$3::text')}
2183|                      ))
2184|                      + (($5::int + 1) * INTERVAL '1 day') - INTERVAL '1 microsecond'
2185|                    ) AT TIME ZONE ${sqlZonaSegura('$3::text')}
2186|                    ELSE GREATEST($1::timestamptz, NOW()) + ($2::numeric * INTERVAL '1 hour')
2187|               END AS novo_expira_em,
2188|               -- Carência no relógio do banco (D89), como no reparo: âncora de publicação + 1h.
2189|               (NOW() >= $6::timestamptz + ($7::numeric * INTERVAL '1 hour')) AS carencia_cumprida`,
2190|       [o.expira_em, horas, o.prazo_timezone, o.prazo_modo, diasExtensao, o.publicado_em || o.criado_em, CARENCIA_ESTENDER_OBRA_HORAS]
2191|     )
2192| 
2193|     // Faixa longa (> 24h) e janela NULL: só estende 1h após a publicação — regra idêntica à de
2194|     // POST /reparos/:id/estender (`=== null` explícito porque Number(null) é 0).
2195|     const janelaObra = o.horas_para_expirar === null ? null : Number(o.horas_para_expirar)
2196|     const exigeCarencia = janelaObra === null || janelaObra > FAIXA_LONGA_OBRA_HORAS
2197|     if (exigeCarencia && !cap.rows[0].carencia_cumprida) {
2198|       return res.status(409).json({ erro: 'Aguarde 1 hora após a publicação para estender' })
2199|     }
2200| 
2201|     // Guarda de dedupe DENTRO do UPDATE, não em um if antes dele: checar em uma query e gravar em
2202|     // outra deixa a janela aberta para dois cliques simultâneos passarem os dois pela checagem e
2203|     // somarem duas vezes. Aqui o próprio UPDATE decide — quem perder a corrida não casa mais com o
2204|     // predicado e volta rowCount = 0. COALESCE(..., FALSE) porque linha nunca estendida tem as duas
2205|     // colunas NULL: sem ele a comparação vira NULL, o NOT propaga NULL e o UPDATE não aplicaria a
2206|     // PRIMEIRA extensão. Fail-open é o lado certo: na dúvida, estende.
2207|     const upd = await pool.query(
2208|       `UPDATE obras SET expira_em = $1,
2209|          marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL,
2210|          ultima_extensao_em = NOW(), ultima_extensao_horas = $5::numeric
2211|        WHERE id = $2 AND criado_por = $3
2212|          AND NOT COALESCE(
2213|                ultima_extensao_em > NOW() - ($4::numeric * INTERVAL '1 minute')
2214|                AND ultima_extensao_horas = $5::numeric, FALSE)
2215|        RETURNING expira_em`,
2216|       [cap.rows[0].novo_expira_em, req.params.id, req.usuario.id, DEDUPE_ESTENDER_OBRA_MINUTOS, horas]
2217|     )
2218| 
2219|     // rowCount = 0 → o predicado de dedupe barrou (retry do mesmo horas na janela). Não é erro: o
2220|     // cliente pediu um estado que o servidor já tem, então devolve o prazo ATUAL como sucesso, com
2221|     // o mesmo shape do caminho normal. O re-SELECT também cobre a linha ter sumido entre o SELECT
2222|     // inicial e o UPDATE (delete concorrente) — aí sim é 404.
2223|     if (upd.rowCount === 0) {
2224|       const atual = await pool.query(
2225|         `SELECT expira_em FROM obras WHERE id = $1 AND criado_por = $2`,
2226|         [req.params.id, req.usuario.id]
2227|       )
2228|       if (atual.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
2229|       return res.json({ expira_em: atual.rows[0].expira_em, extensao_maxima_horas: restanteExtensao(TETO_ESTENDER_OBRA_HORAS, o.publicado_em || o.criado_em, o.horas_para_expirar, atual.rows[0].expira_em) })
2230|     }
2231| 
2232|     res.json({ expira_em: upd.rows[0].expira_em, extensao_maxima_horas: restanteExtensao(TETO_ESTENDER_OBRA_HORAS, o.publicado_em || o.criado_em, o.horas_para_expirar, upd.rows[0].expira_em) })
2233|   } catch (err) {
2234|     console.error('[obras/estender]', err.message)
2235|     res.status(500).json({ erro: 'Erro ao estender prazo da obra' })
2236|   }
2237| })
2238| 
```

### src/routes/index.js:2239-2350 — GET /obras/:id: gate de leitura, mascaramento de endereço/contato, pode_estender_em, advisory

```js
2239| router.get('/obras/:id', autenticar, async (req, res) => {
2240|   try {
2241|     const result = await pool.query(
2242|       `SELECT o.*,
2243|         -- "Expirada" não é status no banco: é uma obra NÃO encerrada cujo expira_em já
2244|         -- passou. Calculado no SQL (relógio do servidor) para a tela de detalhe gatear o
2245|         -- botão de estender sem comparar com o relógio do aparelho. Mesma expressão do
2246|         -- GET /obras/minhas.
2247|         (o.status <> 'encerrada' AND o.expira_em <= NOW()) AS expirada,
2248|         -- pode_estender_em (D89): mesmo campo e mesma regra de GET /reparos/:id — instante a
2249|         -- partir do qual POST /obras/:id/estender para de recusar com 409; NULL = faixa curta,
2250|         -- sem carência. Âncora COALESCE(publicado_em, criado_em), as mesmas constantes do endpoint.
2251|         CASE WHEN o.horas_para_expirar IS NULL OR o.horas_para_expirar > $2::numeric
2252|              THEN COALESCE(o.publicado_em, o.criado_em) + ($3::numeric * INTERVAL '1 hour') END AS pode_estender_em,
2253|         (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_candidaturas,
2254|         (SELECT url FROM midias WHERE obra_id = o.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) as foto_capa
2255|        FROM obras o WHERE o.id = $1`,
2256|       [req.params.id, FAIXA_LONGA_OBRA_HORAS, CARENCIA_ESTENDER_OBRA_HORAS]
2257|     )
2258|     if (result.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
2259|     const obra = result.rows[0]
2260|     const ehDono = obra.criado_por === req.usuario.id
2261|     const ehPintorDoMatch = obra.match_usuario_id === req.usuario.id
2262| 
2263|     if (!ehDono && !ehPintorDoMatch && req.usuario.role !== 'admin') {
2264|       // Mesma guarda de GET /reparos/:id (D74): quem não é o dono desta obra, nem o pintor do
2265|       // match, nem admin, só passa se for prestador — e aí precisa de assinatura. Sem esta
2266|       // linha, qualquer dono_obra com linha ativa em `assinaturas` (todos os donos, hoje) lia
2267|       // fotos, coordenadas e a lista de propostas de obras de outros donos.
2268|       if (req.usuario.role !== 'prestador') {
2269|         return res.status(403).json({ erro: 'Sem permissão para ver esta obra' })
2270|       }
2271|       const assinatura = await pool.query(
2272|         `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' AND (proximo_vencimento IS NULL OR proximo_vencimento > NOW()) LIMIT 1`,
2273|         [req.usuario.id]
2274|       )
2275|       if (assinatura.rows.length === 0) {
2276|         return res.status(403).json({ erro: 'Assinatura necessária para ver esta obra' })
2277|       }
2278|     }
2279| 
2280|     const midias = await pool.query(`SELECT * FROM midias WHERE obra_id = $1 ORDER BY ordem`, [req.params.id])
2281|     const minhaCandidaturaResult = await pool.query(
2282|       `SELECT id, status, valor_oferta, mensagem_oferta, valor_proposto, mensagem, valor_contraproposta FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2`,
2283|       [req.params.id, req.usuario.id]
2284|     )
2285| 
2286|     let candidatos = []
2287|     if (ehDono || req.usuario.role === 'admin') {
2288|       const candidatosResult = await pool.query(
2289|         // Contato/endereço do pintor são revelados ao dono APENAS após o match
2290|         // (obras.match_usuario_id aponta para o pintor que confirmou a ida), e só
2291|         // para o pintor efetivamente casado — nunca no mero aceite (status='aceito').
2292|         // EXCEÇÃO: bairro sai para todos os candidatos, junto de cidade — é granularidade
2293|         // de região (ajuda o dono a julgar deslocamento), não endereço. logradouro, numero
2294|         // e telefone continuam match-gated: só esses três localizam/contatam o pintor.
2295|         `SELECT c.id, c.status, c.valor_proposto, c.valor_contraproposta, c.mensagem,
2296|                 u.nome, u.cidade, u.bairro, u.foto_url, c.usuario_id,
2297|                 u.anos_experiencia, u.especialidades, u.tamanho_equipe,
2298|                 CASE WHEN c.usuario_id = $2 THEN u.logradouro ELSE NULL END as logradouro,
2299|                 CASE WHEN c.usuario_id = $2 THEN u.numero ELSE NULL END as numero,
2300|                 CASE WHEN c.usuario_id = $2 THEN u.telefone ELSE NULL END as telefone,
2301|                 (SELECT COUNT(*)::int FROM avaliacoes a WHERE a.avaliado_id = c.usuario_id) AS avaliacoes_total,
2302|                 (SELECT COALESCE(ROUND(AVG(a.estrelas)::numeric, 1), 0) FROM avaliacoes a WHERE a.avaliado_id = c.usuario_id) AS avaliacoes_media
2303|          FROM candidaturas c JOIN usuarios u ON u.id = c.usuario_id
2304|          WHERE c.obra_id = $1 ORDER BY c.criado_em DESC`,
2305|         [req.params.id, obra.match_usuario_id]
2306|       )
2307|       candidatos = candidatosResult.rows
2308|     }
2309| 
2310|     // Aceite do próprio requester. Procura a linha 'aceito' EXPLICITAMENTE em vez de
2311|     // olhar rows[0]: a query de minha_candidatura não tem ORDER BY/LIMIT, então rows[0]
2312|     // é arbitrário e poderia ser uma candidatura recusada da mesma obra.
2313|     const meuAceite = minhaCandidaturaResult.rows.find(c => c.status === 'aceito')
2314| 
2315|     // Endereço exato e ponto de referência só para dono, pintor do match, pintor com
2316|     // candidatura aceita ou admin (Finding 3.1). ponto_referencia sai junto porque também
2317|     // localiza o imóvel ("portão azul ao lado da padaria") — mascarar só o endereço
2318|     // deixaria a dica de localização vazando para qualquer assinante.
2319|     // Coordenadas permanecem para o cálculo de distância no cliente.
2320|     if (obra.criado_por !== req.usuario.id && obra.match_usuario_id !== req.usuario.id && !meuAceite && req.usuario.role !== 'admin') {
2321|       delete obra.endereco_obra
2322|       delete obra.ponto_referencia
2323|     }
2324| 
2325|     // Advisory: quanto o dono ainda pode estender, contra o teto plano de
2326|     // TETO_ESTENDER_OBRA_HORAS (365 dias) — só p/ o app oferecer opções válidas.
2327|     // "Horas já usadas" = o quanto expira_em já foi empurrado ALÉM do vencimento original
2328|     // (âncora + janela), não o tempo decorrido: envelhecer sem estender não consome teto.
2329|     // Anchor obra: COALESCE(publicado_em, criado_em); janela COALESCE(horas_para_expirar, 720).
2330|     //
2331|     // ATENÇÃO — este advisory é CUMULATIVO, mas POST /obras/:id/estender valida por REQUISIÇÃO
2332|     // (rejeita 400 só se horas > 8760, sem somar extensões anteriores). Ou seja: o app oferece
2333|     // no máximo o que sobra do total, e o endpoint aceitaria mais. Erra para o lado seguro
2334|     // (nunca oferece o que tomaria 400), mas os dois só ficam idênticos quando o endpoint
2335|     // também passar a descontar o acumulado.
2336|     // Regra única (restanteExtensao) — o endpoint devolve o MESMO número após estender.
2337|     const extensao_maxima_horas = restanteExtensao(TETO_ESTENDER_OBRA_HORAS, obra.publicado_em || obra.criado_em, obra.horas_para_expirar, obra.expira_em)
2338|     res.json({ obra, midias: midias.rows, minha_candidatura: minhaCandidaturaResult.rows[0] || null, candidatos, extensao_maxima_horas, pode_estender_em: obra.pode_estender_em })
2339| 
2340|     // Contador de visitas — só incrementa um contador EM MEMÓRIA; quem grava é o flush
2341|     // periódico (src/utils/visitas.js). Síncrono e sem I/O: nenhum lock de linha e nenhuma
2342|     // conexão do pool no caminho de leitura mais quente da API.
2343|     if (!ehDono) registrarVisita('obras', req.params.id)
2344|   } catch (err) {
2345|     console.error('Erro ao buscar obra:', err)
2346|     res.status(500).json({ erro: 'Erro ao buscar obra' })
2347|   }
2348| })
2349| 
2350| // POST /obras/:id/candidatura — pintor se candidata a uma obra
```

### src/routes/index.js:2351-2610 — candidatura → responder (dono: aceitar/recusar/contraproposta) → pintor-responder → match

```js
2351| router.post('/obras/:id/candidatura', autenticar, exigirNaoSuspenso, exigirAssinaturaAtiva, exigirPintor, async (req, res) => {
2352|   try {
2353|     const { mensagem, valor_proposto } = req.body
2354|     const existente = await pool.query(
2355|       `SELECT id FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2`,
2356|       [req.params.id, req.usuario.id]
2357|     )
2358|     if (existente.rows.length > 0) return res.status(409).json({ erro: 'Você já se candidatou nesta obra' })
2359|     const result = await pool.query(
2360|       `INSERT INTO candidaturas (obra_id, usuario_id, mensagem, valor_proposto, status) VALUES ($1, $2, $3, $4, 'pendente') RETURNING *`,
2361|       [req.params.id, req.usuario.id, mensagem, valor_proposto || null]
2362|     )
2363|     const donoInfo = await pool.query(
2364|       `SELECT u.push_token, o.titulo FROM obras o JOIN usuarios u ON o.criado_por = u.id WHERE o.id = $1`,
2365|       [req.params.id]
2366|     )
2367|     if (donoInfo.rows[0]?.push_token) {
2368|       enviarPushNotificacao(donoInfo.rows[0].push_token, '🎨 Novo candidato!',
2369|         `Um pintor se candidatou na obra "${donoInfo.rows[0].titulo}"`,
2370|         { tipo: 'nova_candidatura', obra_id: req.params.id }).catch(() => {})
2371|     }
2372|     res.status(201).json(result.rows[0])
2373|   } catch (err) {
2374|     console.error('Erro ao candidatar:', err)
2375|     res.status(500).json({ erro: 'Erro ao registrar candidatura' })
2376|   }
2377| })
2378| 
2379| // POST /obras/:id/candidatura/:candidaturaId/responder — dono responde a uma candidatura
2380| router.post('/obras/:id/candidatura/:candidaturaId/responder', autenticar, async (req, res) => {
2381|   try {
2382|     const { action, valor } = req.body
2383|     const { id: obra_id, candidaturaId } = req.params
2384|     const obra = await pool.query(`SELECT criado_por, titulo, status, match_usuario_id FROM obras WHERE id = $1`, [obra_id])
2385|     if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
2386|     if (obra.rows[0].criado_por !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o dono pode responder' })
2387|     // Guarda de estado da DEMANDA (D8): aceitar/contrapropor só numa obra viva e ainda não
2388|     // casada. Sem isto, uma obra 'encerrada' podia ser reaberta e o valor reescrito pós-fechamento.
2389|     const obraAbertaParaNegociar = obra.rows[0].status === 'aberta' && !obra.rows[0].match_usuario_id
2390|     const candidatura = await pool.query(
2391|       `SELECT c.*, u.push_token FROM candidaturas c JOIN usuarios u ON c.usuario_id = u.id WHERE c.id = $1 AND c.obra_id = $2`,
2392|       [candidaturaId, obra_id]
2393|     )
2394|     if (candidatura.rows.length === 0) return res.status(404).json({ erro: 'Candidatura não encontrada' })
2395|     const cand = candidatura.rows[0]
2396|     if (action === 'aceitar') {
2397|       // Idempotência de retry: já aceita → devolve sucesso sem reprocessar (sem repetir
2398|       // push nem o UPDATE do match). Sem isto o jaAceito abaixo não pega o próprio
2399|       // registro (id != $2). Espelha o guard de .../pintor-responder.
2400|       // O contrato É rechamado: se já foi enviado, o claim em enviarContratoObra sai cedo
2401|       // sem e-mail; se o envio anterior falhou, o claim foi liberado e esta é a retentativa.
2402|       if (cand.status === 'aceito') {
2403|         enviarContratoObra(candidaturaId).catch(err => console.error('Erro ao enviar contrato obra:', err))
2404|         return res.json({ mensagem: 'Candidatura aceita! Contrato enviado por e-mail.' })
2405|       }
2406|       // Guarda de estado (D8): só uma candidatura 'pendente' pode ser aceita. Isto bloqueia
2407|       // o dono aceitar a PRÓPRIA contraproposta ('contraproposta_dono' — é a vez do pintor) e
2408|       // ressuscitar 'recusado'/'expirado'. Recusa clara, nunca 500 nem no-op silencioso.
2409|       if (!obraAbertaParaNegociar) {
2410|         return res.status(409).json({ erro: 'Esta obra não está mais aberta para negociação.' })
2411|       }
2412|       if (cand.status !== 'pendente') {
2413|         return res.status(409).json({ erro: 'Esta candidatura não está mais disponível para aceite.' })
2414|       }
2415|       const jaAceito = await pool.query(
2416|         `SELECT id FROM candidaturas WHERE obra_id = $1 AND status = 'aceito' AND id != $2`,
2417|         [req.params.id, candidaturaId]
2418|       )
2419|       if (jaAceito.rows.length > 0) {
2420|         return res.status(409).json({ erro: 'Já existe um candidato aceito para esta obra' })
2421|       }
2422|       // Suspensão do CANDIDATO (não de quem chama — aqui quem chama é o dono). O aceite já casa
2423|       // o profissional, então deixar passar entregaria trabalho novo a um suspenso.
2424|       if (await estaSuspenso(cand.usuario_id)) {
2425|         return res.status(409).json(ERRO_ACEITE_SUSPENSO)
2426|       }
2427|       await pool.query(`UPDATE candidaturas SET status = 'aceito' WHERE id = $1`, [candidaturaId])
2428|       // O aceite já casa o profissional com a obra. Guard match_usuario_id IS NULL: torna o
2429|       // write idempotente em retry e impede que um segundo aceite roube um match existente.
2430|       await pool.query(
2431|         `UPDATE obras SET match_usuario_id = $1, match_feito_em = NOW()
2432|          WHERE id = $2 AND match_usuario_id IS NULL`,
2433|         [cand.usuario_id, obra_id]
2434|       )
2435|       if (cand.push_token) {
2436|         enviarPushNotificacao(cand.push_token, '🎉 Deu match!',
2437|           `Parabéns! Você fechou negócio em "${obra.rows[0].titulo}"! Toque para ver os detalhes.`,
2438|           { tipo: 'candidatura_aceita', obra_id }).catch(() => {})
2439|       }
2440|       enviarContratoObra(candidaturaId).catch(err => console.error('Erro ao enviar contrato obra:', err))
2441|       // Recusa os demais candidatos e os notifica (antes ficava só no /match, que hoje sai
2442|       // no early-return). Fire-and-forget: efeito secundário, não bloqueia a resposta.
2443|       rejeitarConcorrentes('obra', obra_id, cand.usuario_id).catch(err => console.error('[obras/responder] rejeitarConcorrentes:', err.message))
2444|       return res.json({ mensagem: 'Candidatura aceita! Contrato enviado por e-mail.' })
2445|     }
2446|     if (action === 'recusar') {
2447|       await pool.query(`UPDATE candidaturas SET status = 'recusado' WHERE id = $1`, [candidaturaId])
2448|       if (cand.push_token) {
2449|         enviarPushNotificacao(cand.push_token, '❌ Candidatura não aceita',
2450|           `Sua candidatura para "${obra.rows[0].titulo}" não foi selecionada desta vez.`,
2451|           { tipo: 'candidatura_recusada', obra_id }).catch(() => {})
2452|       }
2453|       return res.json({ mensagem: 'Candidatura recusada.' })
2454|     }
2455|     if (action === 'contraproposta') {
2456|       if (!valor) return res.status(400).json({ erro: 'Informe o valor da contraproposta' })
2457|       // Guarda de estado (D8): contrapropor só numa obra viva e sobre candidatura 'pendente'.
2458|       // Bloqueia reescrever o valor depois de aceito, recusado, expirado ou já fechado.
2459|       if (!obraAbertaParaNegociar) {
2460|         return res.status(409).json({ erro: 'Esta obra não está mais aberta para negociação.' })
2461|       }
2462|       if (cand.status !== 'pendente') {
2463|         return res.status(409).json({ erro: 'Esta candidatura não está mais em negociação.' })
2464|       }
2465|       await pool.query(
2466|         `UPDATE candidaturas SET status = 'contraproposta_dono', valor_contraproposta = $2 WHERE id = $1`,
2467|         [candidaturaId, valor]
2468|       )
2469|       if (cand.push_token) {
2470|         enviarPushNotificacao(cand.push_token, '💬 Contraproposta recebida!',
2471|           `O solicitante fez uma contraproposta para "${obra.rows[0].titulo}". Veja no app!`,
2472|           { tipo: 'contraproposta_dono', obra_id }).catch(() => {})
2473|       }
2474|       return res.json({ mensagem: 'Contraproposta enviada!' })
2475|     }
2476|     res.status(400).json({ erro: 'Ação inválida' })
2477|   } catch (err) {
2478|     console.error('Erro ao responder candidatura:', err)
2479|     res.status(500).json({ erro: 'Erro ao responder' })
2480|   }
2481| })
2482| 
2483| // POST /obras/:id/candidatura/:candidaturaId/pintor-responder — pintor responde a contraproposta
2484| router.post('/obras/:id/candidatura/:candidaturaId/pintor-responder', autenticar, exigirPintor, async (req, res) => {
2485|   try {
2486|     const { action, valor } = req.body
2487|     const { id: obra_id, candidaturaId } = req.params
2488|     const candidatura = await pool.query(
2489|       `SELECT * FROM candidaturas WHERE id = $1 AND obra_id = $2 AND usuario_id = $3`,
2490|       [candidaturaId, obra_id, req.usuario.id]
2491|     )
2492|     if (candidatura.rows.length === 0) return res.status(404).json({ erro: 'Candidatura não encontrada' })
2493|     if (candidatura.rows[0].status !== 'contraproposta_dono') {
2494|       // Idempotência de retry: já aceita → sucesso em vez de 400, espelhando o guard de
2495|       // .../prestador-responder (que este endpoint não tinha). O contrato é rechamado: se
2496|       // já foi enviado, o claim em enviarContratoObra sai cedo sem e-mail; se o envio
2497|       // anterior falhou, o claim foi liberado e esta é a retentativa.
2498|       if (action === 'aceitar' && candidatura.rows[0].status === 'aceito') {
2499|         enviarContratoObra(candidaturaId).catch(err => console.error('Erro ao enviar contrato obra:', err))
2500|         return res.json({ mensagem: 'Contraproposta aceita! Contrato enviado por e-mail.' })
2501|       }
2502|       return res.status(400).json({ erro: 'Não há contraproposta pendente' })
2503|     }
2504|     const obra = await pool.query(`SELECT titulo, criado_por FROM obras WHERE id = $1`, [obra_id])
2505|     const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [obra.rows[0].criado_por])
2506|     if (action === 'contraproposta') {
2507|       if (!valor) return res.status(400).json({ erro: 'Informe o valor da contraproposta' })
2508|       // Volta para 'pendente' com o novo valor para reentrar no fluxo de resposta do dono
2509|       await pool.query(`UPDATE candidaturas SET status = 'pendente', valor_proposto = $2, valor_contraproposta = NULL WHERE id = $1`, [candidaturaId, valor])
2510|       if (dono.rows[0]?.push_token) {
2511|         enviarPushNotificacao(dono.rows[0].push_token, '💬 Nova contraproposta do profissional!',
2512|           `O pintor propôs R$ ${Number(valor).toLocaleString('pt-BR')} para "${obra.rows[0].titulo}". Veja no app!`,
2513|           { tipo: 'contra_oferta', obra_id }).catch(() => {})
2514|       }
2515|       return res.json({ mensagem: 'Contraproposta enviada!' })
2516|     }
2517|     if (action === 'aceitar') {
2518|       // Aceitar a contraproposta CASA o pintor — é entrada em trabalho novo, então a suspensão
2519|       // vale aqui. Não é middleware porque só 'aceitar' entra: 'recusar' e 'contraproposta'
2520|       // seguem liberados, senão o suspenso ficaria preso numa negociação sem poder encerrá-la.
2521|       // Lê do banco, não de req.usuario: o cache de 5 min de autenticar não pode liberar um
2522|       // aceite, que é irreversível (casa e dispara contrato).
2523|       const suspensao = await estaSuspenso(req.usuario.id)
2524|       if (suspensao) return res.status(403).json(corpoContaSuspensa(suspensao))
2525|       await pool.query(`UPDATE candidaturas SET status = 'aceito' WHERE id = $1`, [candidaturaId])
2526|       // O aceite já casa o profissional com a obra (ver POST .../responder).
2527|       await pool.query(
2528|         `UPDATE obras SET match_usuario_id = $1, match_feito_em = NOW()
2529|          WHERE id = $2 AND match_usuario_id IS NULL`,
2530|         [req.usuario.id, obra_id]
2531|       )
2532|       if (dono.rows[0]?.push_token) {
2533|         enviarPushNotificacao(dono.rows[0].push_token, '🎉 Deu match!',
2534|           `Parabéns! Você fechou negócio em "${obra.rows[0].titulo}"! Toque para ver os detalhes.`,
2535|           { tipo: 'candidatura_aceita', obra_id }).catch(() => {})
2536|       }
2537|       enviarContratoObra(candidaturaId).catch(err => console.error('Erro ao enviar contrato obra:', err))
2538|       // Recusa os demais candidatos e os notifica (ver POST .../responder).
2539|       rejeitarConcorrentes('obra', obra_id, req.usuario.id).catch(err => console.error('[obras/pintor-responder] rejeitarConcorrentes:', err.message))
2540|       return res.json({ mensagem: 'Contraproposta aceita! Contrato enviado por e-mail.' })
2541|     }
2542|     if (action === 'recusar') {
2543|       await pool.query(`UPDATE candidaturas SET status = 'recusado' WHERE id = $1`, [candidaturaId])
2544|       if (dono.rows[0]?.push_token) {
2545|         enviarPushNotificacao(dono.rows[0].push_token, '❌ Proposta recusada',
2546|           `O pintor recusou sua contraproposta para "${obra.rows[0].titulo}".`,
2547|           { tipo: 'candidatura_recusada', obra_id }).catch(() => {})
2548|       }
2549|       return res.json({ mensagem: 'Proposta recusada.' })
2550|     }
2551|     res.status(400).json({ erro: 'Ação inválida' })
2552|   } catch (err) {
2553|     console.error('Erro ao responder contraproposta:', err)
2554|     res.status(500).json({ erro: 'Erro ao responder' })
2555|   }
2556| })
2557| 
2558| // POST /obras/:id/match — pintor confirma ida ao local
2559| router.post('/obras/:id/match', autenticar, exigirPintor, async (req, res) => {
2560|   try {
2561|     const obra = await pool.query(`SELECT * FROM obras WHERE id = $1 AND status = 'aberta'`, [req.params.id])
2562|     if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
2563|     // Idempotente: o aceite já casa o pintor (POST .../responder), então o app que ainda
2564|     // chama /match reencontra o PRÓPRIO match. Devolve 200 sem reescrever match_feito_em
2565|     // (não reinicia a contagem) e sem reenviar o contrato. 409 fica só para match de outro.
2566|     if (obra.rows[0].match_usuario_id) {
2567|       if (obra.rows[0].match_usuario_id === req.usuario.id) {
2568|         return res.json({
2569|           mensagem: 'Match confirmado! Contagem regressiva iniciada.',
2570|           match_feito_em: obra.rows[0].match_feito_em
2571|         })
2572|       }
2573|       return res.status(409).json({ erro: 'Esta obra já tem um pintor a caminho' })
2574|     }
2575|     const candidaturaAceita = await pool.query(
2576|       `SELECT id FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2 AND status = 'aceito'`,
2577|       [req.params.id, req.usuario.id]
2578|     )
2579|     if (candidaturaAceita.rows.length === 0) return res.status(403).json({ erro: 'Sua candidatura ainda não foi aceita para esta obra.' })
2580|     await pool.query(
2581|       `UPDATE obras SET match_feito_em = NOW(), match_usuario_id = $1 WHERE id = $2`,
2582|       [req.usuario.id, req.params.id]
2583|     )
2584|     const dono = await pool.query(
2585|       `SELECT u.push_token FROM obras o JOIN usuarios u ON o.criado_por = u.id WHERE o.id = $1`,
2586|       [req.params.id]
2587|     )
2588|     // Responde imediatamente; push e contrato rodam em segundo plano (não bloquear o cliente)
2589|     res.json({ mensagem: 'Match confirmado! Contagem regressiva iniciada.', match_feito_em: new Date() })
2590|     if (dono.rows[0]?.push_token) {
2591|       enviarPushNotificacao(dono.rows[0].push_token, '🚀 Pintor a caminho!',
2592|         `Um pintor confirmou que está indo até você para "${obra.rows[0].titulo}"`,
2593|         { tipo: 'match_obra', obra_id: req.params.id }).catch(err => console.error('[obras/match] push falhou:', err.message))
2594|     }
2595|     enviarContratoObra(candidaturaAceita.rows[0].id).catch(err => console.error('Erro ao enviar contrato obra:', err))
2596|     // Recusa os demais candidatos e os notifica — pós-resposta, não bloqueia o cliente
2597|     // (Finding 3.1). Mantido aqui para linhas legadas: obras casadas por /match antes de o
2598|     // aceite passar a criar o match. Os caminhos de aceite chamam a mesma função.
2599|     await rejeitarConcorrentes('obra', req.params.id, req.usuario.id)
2600|   } catch (err) {
2601|     console.error('[obras/match]', err.message)
2602|     res.status(500).json({ erro: 'Erro ao confirmar match' })
2603|   }
2604| })
2605| 
2606| // POST /obras/:id/encerrar — encerramento ASSIMÉTRICO: o DONO encerra na hora (foi quem
2607| // recebeu e pagou o serviço, e a palavra dele encerra); o PINTOR apenas registra a
2608| // solicitação, e o dono fecha de fato numa 2ª chamada. Admin e obra sem pintor casado também
2609| // fecham na hora (não há contraparte para confirmar). Cron fecha sozinho vencido o prazo da
2610| // tabela: 2 dias numa obra, 3 horas num reparo (AUTO_ENCERRAR_APOS_* em alertaService).
```

### src/routes/index.js:2611-2935 — encerrar (duas mãos), expirar-match (un-match + bloqueio + proposta expirada), pedir/perguntar/informar/responder-tempo

```js
2611| router.post('/obras/:id/encerrar', autenticar, async (req, res) => {
2612|   try {
2613|     const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
2614|     if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
2615|     const o = obra.rows[0]
2616|     const ehDono = o.criado_por === req.usuario.id
2617|     const ehPintor = o.match_usuario_id === req.usuario.id
2618|     const ehAdmin = req.usuario.role === 'admin'
2619|     if (!ehDono && !ehPintor && !ehAdmin) return res.status(403).json({ erro: 'Sem permissão para encerrar esta obra' })
2620| 
2621|     // Já encerrada → no-op idempotente. Sem isto o UPDATE reescreveria encerrado_em e
2622|     // empurraria para frente a exclusão de mídias de 7 dias (server.js:deletarMidiasAntigas).
2623|     if (o.status === 'encerrada') {
2624|       return res.json({ mensagem: 'Obra já encerrada.', encerramento: 'concluido' })
2625|     }
2626| 
2627|     // Mesmo pré-requisito de chegada de POST /reparos/:id/encerrar — ver o comentário longo lá.
2628|     // Sem NENHUMA declaração, bloqueia; declarada e não confirmada segue passando; sem match e
2629|     // admin ficam de fora.
2630|     if (!ehAdmin && o.match_usuario_id && !o.chegada_declarada_em) {
2631|       return res.status(409).json({ erro: 'Antes de encerrar a obra, confirme se o profissional chegou ao local.' })
2632|     }
2633| 
2634|     // Fecha na hora quando não há confirmação a pedir: o DONO (a palavra dele encerra — e
2635|     // pendurá-lo numa confirmação alheia lhe custava o modal de avaliação, que só destrava
2636|     // no fechamento de fato, quando ele já não está no app), o admin agindo por fora das
2637|     // partes, ou obra que nunca teve pintor casado. Só o pintor passa pela solicitação.
2638|     // A barreira de chegada acima já rodou para todos: quando o dono chega aqui com pintor
2639|     // casado, ele mesmo já confirmou que o profissional esteve no local.
2640|     const semContraparte = !o.match_usuario_id
2641|     if (!ehAdmin && !ehDono && !semContraparte) {
2642|       // 1ª chamada do pintor: registra a solicitação e avisa o dono. Não fecha.
2643|       if (!o.encerramento_solicitado_por) {
2644|         await pool.query(
2645|           `UPDATE obras SET encerramento_solicitado_por = $1, encerramento_solicitado_em = NOW() WHERE id = $2`,
2646|           [req.usuario.id, req.params.id]
2647|         )
2648|         const outroId = ehDono ? o.match_usuario_id : o.criado_por
2649|         const outro = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [outroId])
2650|         if (outro.rows[0]?.push_token) {
2651|           enviarPushNotificacao(outro.rows[0].push_token, '🔔 Encerramento solicitado',
2652|             `A outra parte pediu para encerrar a obra "${o.titulo}". Confirme no app.`,
2653|             { tipo: 'encerramento_solicitado', obra_id: req.params.id }).catch(() => {})
2654|         }
2655|         return res.json({ mensagem: 'Encerramento solicitado. Aguardando confirmação da outra parte.', encerramento: 'pendente' })
2656|       }
2657|       // Pintor chamando de novo: segue pendente. Não fecha (só o dono fecha) e não reenvia push.
2658|       if (o.encerramento_solicitado_por === req.usuario.id) {
2659|         return res.json({ mensagem: 'Encerramento já solicitado. Aguardando a outra parte.', encerramento: 'pendente' })
2660|       }
2661|       // Dono confirmando → cai no fechamento abaixo.
2662|     }
2663| 
2664|     await pool.query(
2665|       `UPDATE obras SET status = 'encerrada', status_aprovacao = 'encerrada', encerrado_em = NOW(),
2666|                        encerramento_solicitado_por = NULL, encerramento_solicitado_em = NULL
2667|        WHERE id = $1`,
2668|       [req.params.id]
2669|     )
2670|     // Pushes fire-and-forget: o UPDATE acima já commitou, então uma falha de push não pode
2671|     // virar 500 para um encerramento que aconteceu.
2672|     if (ehDono && o.match_usuario_id) {
2673|       const pintor = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.match_usuario_id])
2674|       if (pintor.rows[0]?.push_token) {
2675|         enviarPushNotificacao(pintor.rows[0].push_token, '✅ Obra encerrada!',
2676|           `O solicitante encerrou a obra "${o.titulo}".`, { tipo: 'obra_encerrada', obra_id: req.params.id }).catch(() => {})
2677|       }
2678|     } else if (ehPintor) {
2679|       const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.criado_por])
2680|       if (dono.rows[0]?.push_token) {
2681|         enviarPushNotificacao(dono.rows[0].push_token, '✅ Serviço concluído!',
2682|           `O pintor concluiu a obra "${o.titulo}".`, { tipo: 'obra_encerrada', obra_id: req.params.id }).catch(() => {})
2683|       }
2684|     }
2685|     res.json({ mensagem: 'Obra encerrada com sucesso!', encerramento: 'concluido' })
2686|   } catch (err) {
2687|     console.error('[obras/encerrar]', err.message)
2688|     res.status(500).json({ erro: 'Erro ao encerrar obra' })
2689|   }
2690| })
2691| 
2692| // POST /obras/:id/expirar-match — chamado quando o cronômetro expira
2693| router.post('/obras/:id/expirar-match', autenticar, async (req, res) => {
2694|   try {
2695|     const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
2696|     if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
2697|     const o = obra.rows[0]
2698|     const ehDono = o.criado_por === req.usuario.id
2699|     const ehPintor = o.match_usuario_id === req.usuario.id
2700|     const ehAdmin = req.usuario.role === 'admin'
2701|     if (!ehDono && !ehPintor && !ehAdmin) return res.status(403).json({ erro: 'Sem permissão' })
2702|     // Chegada declarada/confirmada congela a expiração do match (mesma regra do cron): o pintor
2703|     // está no local, expirar aqui devolveria ao feed uma obra em atendimento.
2704|     //
2705|     // EXCEÇÃO — o dono contesta uma chegada que NÃO foi ele quem declarou. Sem ela, uma chegada
2706|     // declarada pelo pintor trancava a obra: o dono via "pintor presente" sem ter visto ninguém e
2707|     // não tinha saída. Vale SÓ para o dono (pintor e admin seguem barrados em todos os casos), e
2708|     // só enquanto a declaração é de outro e a obra não encerrou.
2709|     // chegada_declarada_por NULL conta como "não é o dono" (!== já dá isso), liberando a
2710|     // contestação em linha inconsistente em vez de trancá-la.
2711|     const donoContesta = ehDono
2712|       && o.chegada_declarada_por !== req.usuario.id
2713|       && o.status !== 'encerrada'
2714|     if ((o.chegada_declarada_em || o.chegada_confirmada_em) && !donoContesta) {
2715|       return res.status(409).json({ erro: 'Chegada já declarada — o match não pode mais expirar' })
2716|     }
2717|     const pintorId = o.match_usuario_id
2718|     // chegada_* zeradas junto com o match: a obra volta ao feed limpa. Sem isso, a previsão do
2719|     // pintor ANTERIOR sobreviveria — o write-once de /chegada-prevista travaria o próximo, e o
2720|     // cron leria uma chegada_prevista_em já vencida, expirando o novo match em ~1 minuto.
2721|     // prestadores_bloqueados: o pintor que furou não volta a ver ESTA obra no feed. O CASE é
2722|     // NULL-safe (match já desfeito → $2 NULL → array_append gravaria um NULL no array) e
2723|     // idempotente (rechamada não duplica o mesmo uuid).
2724|     const upd = await pool.query(
2725|       `WITH desfeito AS (
2726|          UPDATE obras SET match_feito_em = NULL, match_usuario_id = NULL, pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL,
2727|                 chegada_janela = NULL, chegada_prevista_em = NULL, chegada_declarada_por = NULL, chegada_declarada_em = NULL,
2728|                 chegada_pendente_janela = NULL, chegada_pendente_em = NULL, chegada_recusada_em = NULL,
2729|                 chegada_confirmada_em = NULL,
2730|                 prestadores_bloqueados = CASE
2731|                   -- Isenção igual à do cron: janela oferecida que nunca virou compromisso —
2732|                   -- recusada pelo dono OU pendente sem resposta — e nenhuma outra valendo. As
2733|                   -- expressões do SET leem a linha ANTIGA, então estas três colunas ainda têm o
2734|                   -- valor de antes, apesar de irem a NULL acima.
2735|                   WHEN chegada_prevista_em IS NULL
2736|                        AND (chegada_recusada_em IS NOT NULL OR chegada_pendente_em IS NOT NULL)
2737|                   THEN prestadores_bloqueados
2738|                   WHEN $2::uuid IS NULL OR $2::uuid = ANY(COALESCE(prestadores_bloqueados, '{}'))
2739|                   THEN prestadores_bloqueados
2740|                   ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid) END
2741|           WHERE id = $1
2742|             AND (
2743|               (chegada_declarada_em IS NULL AND chegada_confirmada_em IS NULL)
2744|               -- Espelha o donoContesta do JS relendo a linha VIVA: $3 é ehDono, e as outras duas
2745|               -- condições são reavaliadas aqui. Se a obra encerrar ou o próprio dono declarar a
2746|               -- chegada entre o SELECT e este UPDATE, o bypass morre e volta o 409 de sempre.
2747|               OR ($3::boolean
2748|                   AND chegada_declarada_por IS DISTINCT FROM criado_por
2749|                   AND status IS DISTINCT FROM 'encerrada')
2750|             )
2751|           RETURNING id
2752|        ), proposta AS (
2753|          -- A candidatura vencedora morre JUNTO com o match, no mesmo statement. Sem isto ela
2754|          -- continuava 'aceito' e ocupando candidaturas_aceito_unica_idx: a obra voltava ao feed
2755|          -- mas nenhum aceite novo passava (guard jaAceito → 409, e o índice único barraria).
2756|          -- Depende do CTE desfeito: se o UPDATE acima não pegou a linha (chegada declarada na
2757|          -- corrida), o IN não casa nada e a candidatura fica intacta.
2758|          UPDATE candidaturas SET status = 'expirado'
2759|           WHERE obra_id IN (SELECT id FROM desfeito) AND usuario_id = $2::uuid AND status = 'aceito'
2760|           RETURNING id
2761|        )
2762|        SELECT id FROM desfeito`,
2763|       [req.params.id, pintorId, ehDono]
2764|     )
2765|     // rowCount = 0 (o SELECT final não devolveu linha) → a chegada foi declarada entre o SELECT e o UPDATE. Nada mudou no banco;
2766|     // responder sucesso aqui avisaria os dois lados de uma expiração que não aconteceu, e o
2767|     // pintor receberia "perdeu a obra" seguindo com o match na mão. Mesmo 409 do guard acima.
2768|     if (upd.rowCount === 0) {
2769|       return res.status(409).json({ erro: 'Chegada já declarada — o match não pode mais expirar' })
2770|     }
2771|     const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.criado_por])
2772|     // Os dois lados são avisados: o dono porque a obra voltou ao feed, o pintor porque perdeu
2773|     // o match E o acesso a esta obra. Antes só o dono sabia.
2774|     const pintor = pintorId
2775|       ? await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [pintorId])
2776|       : { rows: [] }
2777|     res.json({ mensagem: 'Match expirado, obra disponível novamente' })
2778|     if (dono.rows[0]?.push_token) {
2779|       enviarPushNotificacao(dono.rows[0].push_token, '⏰ Prazo expirado!',
2780|         `O pintor não chegou a tempo para "${o.titulo}". A obra está disponível novamente.`,
2781|         { tipo: 'match_expirado', obra_id: req.params.id }).catch(() => {})
2782|     }
2783|     if (pintor.rows[0]?.push_token) {
2784|       enviarPushNotificacao(pintor.rows[0].push_token, '⏰ Prazo expirado!',
2785|         `O prazo para chegar em "${o.titulo}" acabou. A obra voltou para o feed.`,
2786|         { tipo: 'match_expirado', obra_id: req.params.id }).catch(() => {})
2787|     }
2788|     return
2789|   } catch (err) {
2790|     res.status(500).json({ erro: 'Erro ao expirar match' })
2791|   }
2792| })
2793| 
2794| // POST /obras/:id/pedir-tempo — pintor solicita mais tempo
2795| router.post('/obras/:id/pedir-tempo', autenticar, async (req, res) => {
2796|   try {
2797|     const { motivo } = req.body
2798|     const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
2799|     if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
2800|     const o = obra.rows[0]
2801|     if (o.match_usuario_id !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o pintor do match pode solicitar mais tempo' })
2802|     await pool.query(
2803|       `UPDATE obras SET pedido_tempo_status = 'aguardando_tempo', pedido_tempo_motivo = $1, pedido_tempo_minutos = NULL WHERE id = $2`,
2804|       [motivo, req.params.id]
2805|     )
2806|     const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.criado_por])
2807|     if (dono.rows[0]?.push_token) {
2808|       await enviarPushNotificacao(dono.rows[0].push_token, '⚠️ Pintor precisa de mais tempo!',
2809|         `Motivo: ${motivo}. Abra o app para responder.`,
2810|         { tipo: 'pedido_tempo', obra_id: req.params.id })
2811|     }
2812|     res.json({ mensagem: 'Solicitação enviada ao dono.' })
2813|   } catch (err) {
2814|     res.status(500).json({ erro: 'Erro ao solicitar mais tempo' })
2815|   }
2816| })
2817| 
2818| // POST /obras/:id/perguntar-tempo — dono pergunta quantos minutos o pintor precisa
2819| router.post('/obras/:id/perguntar-tempo', autenticar, async (req, res) => {
2820|   try {
2821|     const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
2822|     if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
2823|     const o = obra.rows[0]
2824|     if (o.criado_por !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o dono pode responder o pedido' })
2825|     await pool.query(`UPDATE obras SET pedido_tempo_status = 'aguardando_minutos' WHERE id = $1`, [req.params.id])
2826|     const pintor = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.match_usuario_id])
2827|     if (pintor.rows[0]?.push_token) {
2828|       await enviarPushNotificacao(pintor.rows[0].push_token, '⏱ Quanto tempo você precisa?',
2829|         'O solicitante quer saber quantos minutos a mais você precisa para chegar.',
2830|         { tipo: 'perguntar_tempo', obra_id: req.params.id })
2831|     }
2832|     res.json({ mensagem: 'Pintor notificado para informar o tempo.' })
2833|   } catch (err) {
2834|     res.status(500).json({ erro: 'Erro ao perguntar tempo' })
2835|   }
2836| })
2837| 
2838| // POST /obras/:id/informar-tempo — pintor informa quantos minutos precisa
2839| router.post('/obras/:id/informar-tempo', autenticar, async (req, res) => {
2840|   try {
2841|     const { minutos } = req.body
2842|     if (!minutos || minutos <= 0) return res.status(400).json({ erro: 'Informe um tempo válido em minutos' })
2843|     const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
2844|     if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
2845|     const o = obra.rows[0]
2846|     if (o.match_usuario_id !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o pintor do match pode informar o tempo' })
2847|     await pool.query(
2848|       `UPDATE obras SET pedido_tempo_status = 'aguardando_aprovacao', pedido_tempo_minutos = $1 WHERE id = $2`,
2849|       [minutos, req.params.id]
2850|     )
2851|     const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.criado_por])
2852|     if (dono.rows[0]?.push_token) {
2853|       await enviarPushNotificacao(dono.rows[0].push_token, '⏳ Pintor precisa de mais tempo',
2854|         `Ele precisa de ${minutos} minuto(s) a mais. Aceitar ou recusar?`,
2855|         { tipo: 'aprovar_tempo', obra_id: req.params.id })
2856|     }
2857|     res.json({ mensagem: 'Dono notificado para aprovar o tempo.' })
2858|   } catch (err) {
2859|     res.status(500).json({ erro: 'Erro ao informar tempo' })
2860|   }
2861| })
2862| 
2863| // POST /obras/:id/responder-tempo — dono aceita ou recusa tempo extra
2864| router.post('/obras/:id/responder-tempo', autenticar, async (req, res) => {
2865|   try {
2866|     const { aceito } = req.body
2867|     const obra = await pool.query(`SELECT * FROM obras WHERE id = $1`, [req.params.id])
2868|     if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
2869|     const o = obra.rows[0]
2870|     if (o.criado_por !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o dono pode responder' })
2871|     if (aceito) {
2872|       const novoMatchFeitoEm = new Date(new Date(o.match_feito_em).getTime() + o.pedido_tempo_minutos * 60 * 1000)
2873|       await pool.query(
2874|         `UPDATE obras SET match_feito_em = $1, pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL WHERE id = $2`,
2875|         [novoMatchFeitoEm.toISOString(), req.params.id]
2876|       )
2877|       const pintor = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [o.match_usuario_id])
2878|       if (pintor.rows[0]?.push_token) {
2879|         await enviarPushNotificacao(pintor.rows[0].push_token, '✅ Tempo extra aceito!',
2880|           `O solicitante aceitou. Você tem mais ${o.pedido_tempo_minutos} minuto(s). Corra!`,
2881|           { tipo: 'tempo_aceito', obra_id: req.params.id })
2882|       }
2883|       res.json({ mensagem: 'Tempo extra concedido!', novo_match_feito_em: novoMatchFeitoEm })
2884|     } else {
2885|       const pintorId = o.match_usuario_id
2886|       // Recusar o tempo extra desfaz o match, então é caminho de un-match como os outros: o
2887|       // pintor entra na lista negra DESTA obra e não vê mais o card no feed. Paridade com
2888|       // POST /reparos/:id/responder-tempo, que já bloqueava. Mesmo CASE NULL-safe/idempotente
2889|       // dos demais un-matches (ver POST /obras/:id/expirar-match).
2890|       // chegada_* zeradas como nos outros un-matches: a obra volta ao feed limpa.
2891|       // chegada_confirmada_em entra na lista aqui E nos dois expirar-match — os três pontos que
2892|       // conseguem tocar uma linha JÁ confirmada. Aqui nunca houve guard; lá o dono passou a furar
2893|       // o 409 para contestar chegada declarada por outro, e com isso o WHERE deixou de proteger
2894|       // a coluna (era esse o motivo de eles não precisarem dela). Deixá-la preenchida devolveria
2895|       // ao feed uma demanda que o cron nunca mais conseguiria expirar (o job pula linhas com
2896|       // chegada_confirmada_em) e cuja PRÓXIMA chegada já nasceria confirmada, porque o CASE de
2897|       // POST /:id/chegada devolve o valor antigo quando a coluna não está NULL.
2898|       // Os dois crons seguem sem precisar: o predicado deles exige chegada_confirmada_em IS NULL,
2899|       // então a coluna nunca está preenchida nas linhas que eles pegam.
2900|       await pool.query(
2901|         `WITH desfeito AS (
2902|            UPDATE obras SET match_feito_em = NULL, match_usuario_id = NULL, pedido_tempo_status = NULL, pedido_tempo_motivo = NULL, pedido_tempo_minutos = NULL,
2903|                   chegada_janela = NULL, chegada_prevista_em = NULL, chegada_declarada_por = NULL, chegada_declarada_em = NULL,
2904|                   chegada_pendente_janela = NULL, chegada_pendente_em = NULL, chegada_recusada_em = NULL,
2905|                   chegada_confirmada_em = NULL,
2906|                   prestadores_bloqueados = CASE
2907|                     WHEN $2::uuid IS NULL OR $2::uuid = ANY(COALESCE(prestadores_bloqueados, '{}'))
2908|                     THEN prestadores_bloqueados
2909|                     ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid) END
2910|             WHERE id = $1
2911|             RETURNING id
2912|          )
2913|          -- Candidatura vencedora expira junto (ver POST /obras/:id/expirar-match): recusar o
2914|          -- tempo extra é un-match como os outros, e sem isto a obra voltava ao feed com o
2915|          -- índice de aceite ainda ocupado, sem poder ser fechada de novo.
2916|          UPDATE candidaturas SET status = 'expirado'
2917|           WHERE obra_id IN (SELECT id FROM desfeito) AND usuario_id = $2::uuid AND status = 'aceito'`,
2918|         [req.params.id, pintorId]
2919|       )
2920|       const pintor = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [pintorId])
2921|       if (pintor.rows[0]?.push_token) {
2922|         await enviarPushNotificacao(pintor.rows[0].push_token, '❌ Tempo extra recusado',
2923|           'O solicitante não aceitou. A obra voltou para disponível.',
2924|           { tipo: 'tempo_recusado', obra_id: req.params.id })
2925|       }
2926|       res.json({ mensagem: 'Tempo recusado. Obra disponível novamente.' })
2927|     }
2928|   } catch (err) {
2929|     res.status(500).json({ erro: 'Erro ao responder pedido de tempo' })
2930|   }
2931| })
2932| 
2933| // ============================================================
2934| // REPAROS
2935| // ============================================================
```

### src/controllers/candidaturasController.js:88-278 — Rotas legadas usadas pelo painel: pendentes, aprovar (guarda de obra aberta), recusar (push)

```js
 88| const pendentes = async (req, res) => {
 89|   try {
 90|     const page   = parseInt(req.query.page)  || 1
 91|     const limit  = parseInt(req.query.limit) || 20
 92|     const offset = (page - 1) * limit
 93| 
 94|     const result = await pool.query(
 95|       `SELECT c.id, c.status, c.referencias, c.criado_em,
 96|               o.id as obra_id, o.titulo, o.categoria, o.valor, o.cidade,
 97|               u.id as pintor_id, u.nome as pintor_nome, u.email as pintor_email,
 98|               u.telefone, u.cidade as pintor_cidade, u.anos_experiencia, u.tamanho_equipe
 99|        FROM candidaturas c
100|        JOIN obras o ON c.obra_id = o.id
101|        JOIN usuarios u ON c.usuario_id = u.id
102|        WHERE c.status = 'pendente'
103|        ORDER BY c.criado_em ASC
104|        LIMIT $1 OFFSET $2`,
105|       [limit, offset]
106|     )
107|     res.json({ candidaturas: result.rows, page, limit })
108|   } catch (err) {
109|     console.error('Erro ao buscar candidaturas pendentes:', err)
110|     res.status(500).json({ erro: 'Erro ao buscar candidaturas pendentes' })
111|   }
112| }
113| 
114| const aprovar = async (req, res) => {
115|   try {
116|     const { id } = req.params
117| 
118|     // usuario_id entra no SELECT porque a checagem de suspensão precisa dele ANTES do UPDATE
119|     // (o RETURNING * lá embaixo só chega depois de o aceite já ter sido gravado).
120|     const existe = await pool.query(`SELECT id, status, obra_id, usuario_id FROM candidaturas WHERE id = $1`, [id])
121|     if (existe.rows.length === 0) {
122|       return res.status(404).json({ erro: 'Candidatura não encontrada' })
123|     }
124| 
125|     // titulo entra aqui para compor o push "Deu match!" no fim da função, sem query extra.
126|     const obraCheck = await pool.query(
127|       `SELECT criado_por, titulo, status, match_usuario_id FROM obras WHERE id = $1`,
128|       [existe.rows[0].obra_id]
129|     )
130|     if (
131|       obraCheck.rows.length === 0 ||
132|       (obraCheck.rows[0].criado_por !== req.usuario.id && req.usuario.role !== 'admin')
133|     ) {
134|       return res.status(403).json({ erro: 'Sem permissão para esta ação' })
135|     }
136| 
137|     // Guarda de estado da DEMANDA (D82 — mesma de POST /obras/:id/candidatura/:cid/responder e
138|     // do lado reparo): aceitar só numa obra viva e ainda não casada. Sem isto, este caminho
139|     // (usado pelo painel) casava uma obra 'encerrada'/'cancelada' — o UPDATE em obras só
140|     // exigia match_usuario_id IS NULL.
141|     const obraAbertaParaNegociar = obraCheck.rows[0].status === 'aberta' && !obraCheck.rows[0].match_usuario_id
142|     if (!obraAbertaParaNegociar) {
143|       return res.status(409).json({ erro: 'Esta obra não está mais aberta para negociação.' })
144|     }
145| 
146|     if (existe.rows[0].status !== 'pendente') {
147|       return res.status(400).json({ erro: 'Candidatura já foi processada' })
148|     }
149| 
150|     const jaAceito = await pool.query(
151|       `SELECT id FROM candidaturas WHERE obra_id = $1 AND status = 'aceito' AND id != $2`,
152|       [existe.rows[0].obra_id, id]
153|     )
154|     if (jaAceito.rows.length > 0) {
155|       return res.status(409).json({ erro: 'Já existe um candidato aceito para esta obra' })
156|     }
157| 
158|     // Suspensão do CANDIDATO (quem chama aqui é o dono ou um admin). Terceiro caminho de
159|     // aceite, junto de POST /obras/:id/candidatura/:candidaturaId/responder e o equivalente
160|     // de reparo — todos casam o profissional, então todos precisam da mesma trava.
161|     const suspenso = await pool.query(
162|       `SELECT suspenso_em FROM usuarios WHERE id = $1`,
163|       [existe.rows[0].usuario_id]
164|     )
165|     if (suspenso.rows[0]?.suspenso_em) {
166|       return res.status(409).json({
167|         erro: 'Este profissional está com a conta suspensa e não pode assumir novos trabalhos. Escolha outro candidato.',
168|         codigo: 'PROFISSIONAL_SUSPENSO',
169|       })
170|     }
171| 
172|     const result = await pool.query(
173|       `UPDATE candidaturas SET status = 'aceito', aprovado_por = $1
174|        WHERE id = $2 RETURNING *`,
175|       [req.usuario.id, id]
176|     )
177| 
178|     // O aceite já casa o profissional com a obra. usuario_id/obra_id saem do RETURNING *
179|     // acima, então não é preciso alargar o SELECT de `existe`. Guard match_usuario_id IS
180|     // NULL: idempotente em retry e impede que um segundo aceite roube um match existente.
181|     await pool.query(
182|       `UPDATE obras SET match_usuario_id = $1, match_feito_em = NOW()
183|        WHERE id = $2 AND match_usuario_id IS NULL`,
184|       [result.rows[0].usuario_id, result.rows[0].obra_id]
185|     )
186| 
187|     // Token do aprovado, buscado antes da resposta para o push logo abaixo não precisar de
188|     // await depois do res.json (throw pós-resposta cairia no catch e tentaria responder 2x).
189|     const vencedor = await pool.query(
190|       `SELECT push_token FROM usuarios WHERE id = $1`,
191|       [result.rows[0].usuario_id]
192|     )
193| 
194|     res.json(result.rows[0])
195| 
196|     // Push "Deu match!" para o profissional aprovado — paridade com os outros quatro
197|     // caminhos de aceite, que sempre notificam a contraparte. Este endpoint não notificava
198|     // ninguém. Mesmo título, texto e payload usados em .../responder.
199|     if (vencedor.rows[0]?.push_token) {
200|       enviarPushNotificacao(vencedor.rows[0].push_token, '🎉 Deu match!',
201|         `Parabéns! Você fechou negócio em "${obraCheck.rows[0].titulo}"! Toque para ver os detalhes.`,
202|         { tipo: 'candidatura_aceita', obra_id: result.rows[0].obra_id }).catch(() => {})
203|     }
204| 
205|     // Envia contrato por e-mail de forma assíncrona sem bloquear a resposta
206|     enviarContratoObra(id).catch(err =>
207|       console.error('Erro ao enviar contrato de obra:', err)
208|     )
209| 
210|     // Recusa os demais candidatos e os notifica (antes só o /match fazia isso, e hoje ele
211|     // sai no early-return idempotente). Este endpoint nunca enviou push nenhum; agora ao
212|     // menos os perdedores são avisados. Assíncrono, como o contrato acima.
213|     rejeitarConcorrentes('obra', result.rows[0].obra_id, result.rows[0].usuario_id).catch(err =>
214|       console.error('[candidaturas/aprovar] rejeitarConcorrentes:', err.message)
215|     )
216| 
217|   } catch (err) {
218|     // 23505 = unique_violation. O único write daqui é o UPDATE acima, e o único
219|     // índice único que ele pode violar é candidaturas_aceito_unica_idx (UNIQUE em
220|     // obra_id WHERE status='aceito') — ou seja: outro aceite para a mesma obra
221|     // entrou entre o SELECT do jaAceito e o UPDATE. O guard acima resolve o caso
222|     // comum; este catch fecha a corrida. Mesma resposta nos dois caminhos.
223|     if (err.code === '23505') {
224|       return res.status(409).json({ erro: 'Já existe um candidato aceito para esta obra' })
225|     }
226|     console.error('Erro ao aprovar candidatura:', err)
227|     res.status(500).json({ erro: 'Erro ao aprovar candidatura' })
228|   }
229| }
230| 
231| const recusar = async (req, res) => {
232|   try {
233|     const { id } = req.params
234| 
235|     const existe = await pool.query(`SELECT id, status, obra_id, usuario_id FROM candidaturas WHERE id = $1`, [id])
236|     if (existe.rows.length === 0) {
237|       return res.status(404).json({ erro: 'Candidatura não encontrada' })
238|     }
239| 
240|     const obraCheck = await pool.query(
241|       `SELECT criado_por, titulo FROM obras WHERE id = $1`,
242|       [existe.rows[0].obra_id]
243|     )
244|     if (
245|       obraCheck.rows.length === 0 ||
246|       (obraCheck.rows[0].criado_por !== req.usuario.id && req.usuario.role !== 'admin')
247|     ) {
248|       return res.status(403).json({ erro: 'Sem permissão para esta ação' })
249|     }
250| 
251|     if (existe.rows[0].status !== 'pendente') {
252|       return res.status(400).json({ erro: 'Candidatura já foi processada' })
253|     }
254| 
255|     const result = await pool.query(
256|       `UPDATE candidaturas SET status = 'recusado', aprovado_por = $1
257|        WHERE id = $2 RETURNING *`,
258|       [req.usuario.id, id]
259|     )
260| 
261|     res.json(result.rows[0])
262| 
263|     // Aviso ao pintor recusado (D82): mesmo push de POST /obras/:id/candidatura/:cid/responder
264|     // e do lado reparo — este caminho (painel) era o único que recusava em silêncio.
265|     const pintor = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [existe.rows[0].usuario_id])
266|     if (pintor.rows[0]?.push_token) {
267|       enviarPushNotificacao(pintor.rows[0].push_token, '❌ Candidatura não aceita',
268|         `Sua candidatura para "${obraCheck.rows[0].titulo}" não foi selecionada desta vez.`,
269|         { tipo: 'candidatura_recusada', obra_id: existe.rows[0].obra_id }).catch(() => {})
270|     }
271| 
272|   } catch (err) {
273|     console.error('Erro ao recusar candidatura:', err)
274|     res.status(500).json({ erro: 'Erro ao recusar candidatura' })
275|   }
276| }
277| 
278| module.exports = { minhas, porObra, pendentes, aprovar, recusar }
```

### src/routes/index.js:5427-5474 — POST /candidaturas (rota legada) e registro das rotas de candidatura

```js
5427| router.post('/candidaturas', autenticar, exigirNaoSuspenso, exigirAssinaturaAtiva, exigirPintor, async (req, res) => {
5428|   try {
5429|     // D83: este caminho gravava valor_oferta/mensagem_oferta, colunas que NENHUM leitor de
5430|     // preço usa (contrato, finalizadas, minhas, meus-contratos leem valor_proposto/
5431|     // valor_contraproposta) — a candidatura aceita por aqui virava contrato "a combinar".
5432|     // Passa a gravar as mesmas colunas de POST /obras/:id/candidatura; os nomes antigos
5433|     // seguem aceitos no corpo como sinônimos. Hoje nenhum cliente chama esta rota (app usa
5434|     // /obras/:id/candidatura; painel só lista/aprova/recusa).
5435|     const { obra_id, referencias } = req.body
5436|     const valor_proposto = req.body.valor_proposto ?? req.body.valor_oferta ?? null
5437|     const mensagem = req.body.mensagem ?? req.body.mensagem_oferta ?? null
5438|     const obraResult = await pool.query(`SELECT id, titulo, status FROM obras WHERE id = $1 AND status = 'aberta'`, [obra_id])
5439|     if (obraResult.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada ou não está disponível' })
5440|     const existente = await pool.query(`SELECT id FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2`, [obra_id, req.usuario.id])
5441|     if (existente.rows.length > 0) return res.status(409).json({ erro: 'Você já demonstrou interesse nesta obra' })
5442|     const result = await pool.query(
5443|       `INSERT INTO candidaturas (obra_id, usuario_id, referencias, valor_proposto, mensagem, status)
5444|        VALUES ($1, $2, $3, $4, $5, 'pendente') RETURNING *`,
5445|       [obra_id, req.usuario.id, referencias, valor_proposto || null, mensagem || null]
5446|     )
5447|     const valor_oferta = valor_proposto
5448|     const dono = await pool.query(
5449|       `SELECT u.push_token, o.titulo FROM obras o JOIN usuarios u ON o.criado_por = u.id WHERE o.id = $1`,
5450|       [obra_id]
5451|     )
5452|     if (dono.rows[0]?.push_token) {
5453|       const temOferta = valor_oferta && valor_oferta > 0
5454|       await enviarPushNotificacao(
5455|         dono.rows[0].push_token,
5456|         temOferta ? '🎨 Nova contra-oferta recebida!' : '👀 Novo interesse na sua obra!',
5457|         temOferta
5458|           ? `Um pintor fez uma oferta de R$ ${Number(valor_oferta).toLocaleString('pt-BR')} para "${dono.rows[0].titulo}"`
5459|           : `Um pintor demonstrou interesse em "${dono.rows[0].titulo}"`,
5460|         { tipo: 'nova_candidatura', obra_id }
5461|       )
5462|     }
5463|     res.status(201).json(result.rows[0])
5464|   } catch (err) {
5465|     console.error('Erro ao candidatar:', err)
5466|     res.status(500).json({ erro: 'Erro ao registrar candidatura' })
5467|   }
5468| })
5469| 
5470| router.get('/candidaturas/minhas',        autenticar, candidaturasCtrl.minhas)
5471| router.get('/candidaturas/pendentes',     autenticar, exigirAdmin, candidaturasCtrl.pendentes)
5472| router.get('/candidaturas/obra/:obra_id', autenticar, candidaturasCtrl.porObra)
5473| router.post('/candidaturas/:id/aprovar',  autenticar, candidaturasCtrl.aprovar)
5474| router.post('/candidaturas/:id/recusar',  autenticar, candidaturasCtrl.recusar)
```


## 5. Ciclo de vida — lado REPARO (compare com a seção 4)

### src/routes/index.js:2977-3110 — POST /reparos/dono (nasce aberto/aprovado), DELETE /reparos/dono/:id, ponto de referência

```js
2977| router.post('/reparos/dono', autenticar, async (req, res) => {
2978|   try {
2979|     if (req.usuario.role !== 'dono_obra' && req.usuario.role !== 'admin') {
2980|       return res.status(403).json({ erro: 'Apenas donos podem cadastrar serviços' })
2981|     }
2982|     const { titulo, categoria, descricao, valor_estimado, cidade, bairro, uf, tags, prazo_atendimento_horas, endereco_obra, ponto_referencia, latitude, longitude, client_request_id } = req.body
2983|     // Mesmo teto do POST /obras/dono e sobre a MESMA contagem (obras + reparos): o limite é por
2984|     // dono, não por tipo de demanda, senão 2 obras + 2 reparos passariam.
2985|     const limiteReparos = await limiteDemandasAtingido('reparos', req.usuario.id, client_request_id)
2986|     if (limiteReparos.atingido) {
2987|       return res.status(409).json(erroLimiteDemandas(limiteReparos.limite))
2988|     }
2989|     const ufFinal = uf || await ufDeCidade(cidade)  // rede de segurança: deriva uf da cidade
2990|     const { lat: latFinal, lng: lngFinal, origem: coordOrigem } = resolverCoordenadas(cidade, ufFinal, latitude, longitude, '[reparos/dono]')
2991|     // Janela original resolvida UMA vez: mesma base do expira_em e do prazo_atendimento_horas
2992|     // gravado, sem risco de os dois divergirem (mesmo padrão de POST /obras/dono). Antes a
2993|     // coluna recebia NULL quando o cliente não mandava prazo, enquanto o expira_em ia a 720h —
2994|     // a demanda ficava sem faixa e o job de marcos a pulava, sem alerta nenhum de expiração.
2995|     const horasExpiracao = prazo_atendimento_horas || 720
2996|     const expira_em = new Date(Date.now() + horasExpiracao * 3600 * 1000)
2997|     // Faixa "Hoje" — mesma regra e mesmo CASE do POST /obras/dono (ver lá o racional completo):
2998|     // só o ramo 'hoje' muda, resolvido no Postgres; as demais faixas gravam o $10 do Node.
2999|     const prazoModo = req.body?.prazo_modo === PRAZO_MODO_HOJE ? PRAZO_MODO_HOJE : null
3000|     // Zona do DONO para a faixa "Hoje" (D78 — mesmo par de POST /obras/dono): validada contra
3001|     // pg_timezone_names e gravada em prazo_timezone; o fim do dia é o do dono, não o de SP.
3002|     const prazoZona = prazoModo ? await resolverZonaCliente(req.body?.timezone) : null
3003|     // ON CONFLICT no índice parcial (criado_por, client_request_id): retries com a mesma chave
3004|     // retornam o reparo já criado em vez de inserir duplicata. Sem chave (NULL) → insert normal.
3005|     const result = await pool.query(
3006|       `INSERT INTO reparos (criado_por, titulo, categoria, descricao, valor_estimado, cidade, bairro, uf, tags, status, status_aprovacao, expira_em, prazo_atendimento_horas, endereco_reparo, ponto_referencia, latitude, longitude, coordenadas_origem, client_request_id, prazo_modo, prazo_timezone)
3007|        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'aberta','aprovada',
3008|                CASE WHEN $18::text = '${PRAZO_MODO_HOJE}' THEN ${sqlFimDoDia('$19::text')} ELSE $10::timestamptz END,
3009|                $11,$12,$13,$14,$15,$16,$17,$18,$19)
3010|        ON CONFLICT (criado_por, client_request_id) WHERE client_request_id IS NOT NULL
3011|        DO UPDATE SET client_request_id = EXCLUDED.client_request_id
3012|        RETURNING *`,
3013|       [req.usuario.id, titulo, categoria, descricao, valor_estimado, cidade, bairro, ufFinal, tags || [], expira_em.toISOString(), horasExpiracao, endereco_obra, ponto_referencia, latFinal, lngFinal, coordOrigem, client_request_id || null, prazoModo, prazoZona]
3014|     )
3015|     res.status(201).json(result.rows[0])
3016|     // ESTE e o unico envio que dispara no fluxo real, e por isso ele FICA. O INSERT acima
3017|     // grava status_aprovacao='aprovada' direto: reparo nasce publicado, nao passa por fila de
3018|     // aprovacao (as 16 linhas em producao estao todas em 'aprovada'/'encerrada', nenhuma
3019|     // 'pendente'). Ou seja, a transicao para aprovada acontece AQUI, na criacao — e o envio
3020|     // daqui e justamente "um envio, na transicao de aprovacao" que obras faz no endpoint de
3021|     // aprovacao. Remove-lo deixaria o reparo sem nenhum aviso, porque
3022|     // POST /reparos/aprovacao/:id/aprovar nunca chega a rodar para uma linha ja aprovada
3023|     // (e agora, com a guarda de transicao la, nem notificaria).
3024|     notificarPrestadoresSobreNovoReparo(result.rows[0].id).catch(err => console.error('Erro notificar prestadores:', err))
3025|   } catch (err) {
3026|     console.error('[reparos/dono]', err.message)
3027|     res.status(500).json({ erro: 'Erro ao cadastrar serviço' })
3028|   }
3029| })
3030| 
3031| router.delete('/reparos/dono/:id', autenticar, async (req, res) => {
3032|   try {
3033|     const reparo = await pool.query(
3034|       `SELECT id, match_usuario_id FROM reparos WHERE id = $1 AND criado_por = $2`,
3035|       [req.params.id, req.usuario.id]
3036|     )
3037|     if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
3038|     if (reparo.rows[0].match_usuario_id) return res.status(409).json({ erro: 'Não é possível excluir um serviço com prestador a caminho' })
3039|     // CANCELA em vez de apagar, alinhando com DELETE /obras/dono/:id. Apagar a linha custava
3040|     // duas coisas:
3041|     //   - a mídia saía do banco antes de o cron poder limpá-la, então o arquivo ficava no
3042|     //     Cloudinary sem nada apontando para ele (o ledger de órfãs cobre o caso, mas aqui
3043|     //     não há motivo para apagar: basta deixar a linha e o cron recolhe no prazo);
3044|     //   - apagava os interesse_reparos junto, deixando contratos (contratos.interesse_id não
3045|     //     tem FK) e avaliações (contrato_id polimórfico) apontando para o vazio.
3046|     // Com o cancelamento a linha permanece: deletarMidiasAntigas recolhe a mídia aos 7 dias
3047|     // pelo braço 'cancelada', e contratos/avaliações continuam com referente.
3048|     // encerrado_em é o relógio desses 7 dias; COALESCE não reinicia contagem já iniciada.
3049|     await pool.query(
3050|       `UPDATE reparos SET status = 'cancelada', status_aprovacao = 'cancelada',
3051|               encerrado_em = COALESCE(encerrado_em, NOW())
3052|         WHERE id = $1`,
3053|       [req.params.id]
3054|     )
3055|     res.json({ mensagem: 'Serviço cancelado com sucesso' })
3056|   } catch (err) {
3057|     console.error('Erro ao cancelar reparo:', err)
3058|     res.status(500).json({ erro: 'Erro ao cancelar serviço' })
3059|   }
3060| })
3061| 
3062| // PATCH /reparos/dono/:id/ponto-referencia — espelho exato do lado obra: mesma validação
3063| // (normalizarPontoReferencia), mesma posse dentro do UPDATE, mesmo 404 em rowCount 0, e
3064| // segue liberado depois do match pelo mesmo motivo (o contrato de reparo também renderiza
3065| // endereco_obra, nunca ponto_referencia).
3066| router.patch('/reparos/dono/:id/ponto-referencia', autenticar, async (req, res) => {
3067|   try {
3068|     const { ponto_referencia } = req.body
3069|     const { erro, valor } = normalizarPontoReferencia(ponto_referencia)
3070|     if (erro) return res.status(400).json({ erro })
3071| 
3072|     const upd = await pool.query(
3073|       `UPDATE reparos SET ponto_referencia = $2 WHERE id = $1 AND criado_por = $3
3074|        RETURNING ponto_referencia`,
3075|       [req.params.id, valor, req.usuario.id]
3076|     )
3077|     if (upd.rowCount === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
3078|     res.json({ ponto_referencia: upd.rows[0].ponto_referencia })
3079|   } catch (err) {
3080|     console.error('[reparos/ponto-referencia]', err.message)
3081|     res.status(500).json({ erro: 'Erro ao atualizar ponto de referência' })
3082|   }
3083| })
3084| 
3085| // Carência para estender reparo de faixa longa. "Esta semana" é a faixa > 24h; prazo NULL
3086| // entra junto porque é a janela mais longa que existe (o expira_em da criação usa o default
3087| // de 720h) e o app sequer rotula esses reparos. Faixas curtas (<= 24h) seguem sem carência:
3088| // quem marcou "1 hora" precisa poder corrigir na hora.
3089| const CARENCIA_ESTENDER_REPARO_HORAS = 1
3090| const FAIXA_LONGA_REPARO_HORAS = 24
3091| 
3092| // Teto de extensão do reparo — o de 2x saiu e por um tempo isto foi só advisory; hoje o
3093| // endpoint TAMBÉM o enforça (400 quando horas > este valor), espelhando TETO_ESTENDER_OBRA_HORAS.
3094| // Segue na resposta porque o app filtra as opções por ele (ModalEstenderPrazo). Valor generoso
3095| // = "não gateia o menu": a maior opção do app é 168h, então isto só barra valor absurdo
3096| // (ex.: um dígito a mais por engano). O nome ADVISORY_ ficou do período em que não era enforçado.
3097| const ADVISORY_ESTENDER_REPARO_HORAS = 8760
3098| 
3099| // Janela de dedupe do estender. Sem client_request_id no corpo, a chave é (ultima_extensao_em,
3100| // ultima_extensao_horas): repetir o MESMO horas dentro da janela é tratado como retry do mesmo
3101| // clique — devolve o prazo atual sem somar de novo. Fora da janela, ou com horas diferente, é
3102| // uma extensão nova e legítima (o dono pode estender duas vezes seguidas de propósito).
3103| const DEDUPE_ESTENDER_REPARO_MINUTOS = 5
3104| 
3105| // POST /reparos/:id/estender — âncora criado_em SEM COALESCE: o reparo publica na criação,
3106| // então criado_em é o instante de publicação e nunca é NULL (obra precisa de
3107| // COALESCE(publicado_em, criado_em); reparo não). É essa mesma âncora que a carência usa.
3108| // Re-arma TODOS os marcos de expiração (marco_6h/60/30/15_em = NULL), igual à obra: expira_em
3109| // avança, então os 4 alertas re-disparam contra o novo prazo. (Substitui o clear de
3110| // alerta_sem_interessados_em, cujo job foi aposentado.)
```

### src/routes/index.js:3111-3202 — POST /reparos/:id/estender: carência 1h, faixa Hoje, dedupe

```js
3111| router.post('/reparos/:id/estender', autenticar, async (req, res) => {
3112|   try {
3113|     const reparo = await pool.query(
3114|       `SELECT id, criado_por, status, match_usuario_id, expira_em, criado_em, prazo_atendimento_horas,
3115|               prazo_modo, prazo_timezone
3116|        FROM reparos WHERE id = $1 AND criado_por = $2`,
3117|       [req.params.id, req.usuario.id]
3118|     )
3119|     if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
3120|     const r = reparo.rows[0]
3121|     if (r.status !== 'aberta') return res.status(409).json({ erro: 'Só é possível estender um serviço aberto' })
3122|     if (r.match_usuario_id) return res.status(409).json({ erro: 'Não é possível estender um serviço com prestador a caminho' })
3123| 
3124|     const horas = Number(req.body?.horas)
3125|     if (!Number.isFinite(horas) || horas < 1) return res.status(400).json({ erro: 'horas inválido: informe um número >= 1' })
3126|     // Teto plano, espelhando POST /obras/:id/estender: mesma posição (antes da query de
3127|     // carência e do UPDATE), mesmo `>` estrito (8760 exato passa), mesmo 400 e o mesmo
3128|     // extensao_maxima_horas no corpo do erro, p/ o cliente aprender o limite pela recusa.
3129|     // Validação POR REQUISIÇÃO, sem somar extensões anteriores — igual à obra.
3130|     if (horas > ADVISORY_ESTENDER_REPARO_HORAS) {
3131|       return res.status(400).json({ erro: `horas inválido: máximo de ${ADVISORY_ESTENDER_REPARO_HORAS} (365 dias)`, extensao_maxima_horas: ADVISORY_ESTENDER_REPARO_HORAS })
3132|     }
3133| 
3134|     // Carência e novo prazo na MESMA query: as duas comparações precisam do relógio do banco
3135|     // (NOW()), não do relógio do processo, senão skew de container decide quem pode estender.
3136|     // Faixa "Hoje" (D78 — mesmo CASE de POST /obras/:id/estender): quem escolheu "hoje" estende
3137|     // por DIAS inteiros e volta ao fim do dia na zona gravada em prazo_timezone; somar horas ao
3138|     // fim do dia converteria a meia-noite num horário de relógio. Fora de "hoje", segue
3139|     // GREATEST(expira_em, NOW()) + horas.
3140|     const diasExtensao = Math.max(1, Math.ceil(horas / 24))
3141|     const cap = await pool.query(
3142|       `SELECT
3143|          CASE WHEN $6::text = '${PRAZO_MODO_HOJE}' THEN (
3144|                 date_trunc('day', GREATEST(
3145|                   $1::timestamptz AT TIME ZONE ${sqlZonaSegura('$5::text')},
3146|                   NOW()           AT TIME ZONE ${sqlZonaSegura('$5::text')}
3147|                 ))
3148|                 + (($7::int + 1) * INTERVAL '1 day') - INTERVAL '1 microsecond'
3149|               ) AT TIME ZONE ${sqlZonaSegura('$5::text')}
3150|               ELSE GREATEST($1::timestamptz, NOW()) + ($2::numeric * INTERVAL '1 hour')
3151|          END AS novo_expira_em,
3152|          (NOW() >= $3::timestamptz + ($4::numeric * INTERVAL '1 hour')) AS carencia_cumprida`,
3153|       [r.expira_em, horas, r.criado_em, CARENCIA_ESTENDER_REPARO_HORAS, r.prazo_timezone, r.prazo_modo, diasExtensao]
3154|     )
3155| 
3156|     // Faixa longa (> 24h) e prazo NULL: só estende 1h após o cadastro. NULL entra via o
3157|     // `=== null` explícito — Number(null) é 0, que passaria batido pela comparação numérica.
3158|     const prazoReparo = r.prazo_atendimento_horas === null ? null : Number(r.prazo_atendimento_horas)
3159|     const exigeCarencia = prazoReparo === null || prazoReparo > FAIXA_LONGA_REPARO_HORAS
3160|     if (exigeCarencia && !cap.rows[0].carencia_cumprida) {
3161|       return res.status(409).json({ erro: 'Aguarde 1 hora após o cadastro para estender' })
3162|     }
3163| 
3164|     // Guarda de dedupe DENTRO do UPDATE, não em um if antes dele: checar em uma query e gravar em
3165|     // outra deixa a janela aberta para dois cliques simultâneos passarem os dois pela checagem e
3166|     // somarem duas vezes. Aqui o próprio UPDATE decide — quem perder a corrida não casa mais com o
3167|     // predicado e volta rowCount = 0. COALESCE(..., FALSE) porque linha nunca estendida tem as duas
3168|     // colunas NULL: sem ele a comparação vira NULL, o NOT propaga NULL e o UPDATE não aplicaria a
3169|     // PRIMEIRA extensão. Fail-open é o lado certo: na dúvida, estende.
3170|     const upd = await pool.query(
3171|       `UPDATE reparos SET expira_em = $1,
3172|          marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL,
3173|          ultima_extensao_em = NOW(), ultima_extensao_horas = $5::numeric
3174|        WHERE id = $2 AND criado_por = $3
3175|          AND NOT COALESCE(
3176|                ultima_extensao_em > NOW() - ($4::numeric * INTERVAL '1 minute')
3177|                AND ultima_extensao_horas = $5::numeric, FALSE)
3178|        RETURNING expira_em`,
3179|       [cap.rows[0].novo_expira_em, req.params.id, req.usuario.id, DEDUPE_ESTENDER_REPARO_MINUTOS, horas]
3180|     )
3181| 
3182|     // rowCount = 0 → o predicado de dedupe barrou (retry do mesmo horas na janela). Não é erro: o
3183|     // cliente pediu um estado que o servidor já tem, então devolve o prazo ATUAL como sucesso, com
3184|     // o mesmo shape do caminho normal. O re-SELECT também cobre a linha ter sumido entre o SELECT
3185|     // inicial e o UPDATE (delete concorrente) — aí sim é 404.
3186|     if (upd.rowCount === 0) {
3187|       const atual = await pool.query(
3188|         `SELECT expira_em FROM reparos WHERE id = $1 AND criado_por = $2`,
3189|         [req.params.id, req.usuario.id]
3190|       )
3191|       if (atual.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
3192|       return res.json({ expira_em: atual.rows[0].expira_em, extensao_maxima_horas: restanteExtensao(ADVISORY_ESTENDER_REPARO_HORAS, r.criado_em, r.prazo_atendimento_horas, atual.rows[0].expira_em) })
3193|     }
3194| 
3195|     // D89: mesma regra única da obra — desconta o já consumido, em vez do 8760 constante.
3196|     res.json({ expira_em: upd.rows[0].expira_em, extensao_maxima_horas: restanteExtensao(ADVISORY_ESTENDER_REPARO_HORAS, r.criado_em, r.prazo_atendimento_horas, upd.rows[0].expira_em) })
3197|   } catch (err) {
3198|     console.error('[reparos/estender]', err.message)
3199|     res.status(500).json({ erro: 'Erro ao estender prazo do serviço' })
3200|   }
3201| })
3202| 
```

### src/routes/index.js:3452-3688 — GET /reparos (feed), interesse, abertura (detalhe visto), match

```js
3452| router.get('/reparos', autenticar, exigirNaoSuspenso, exigirPrestador, exigirReparador, async (req, res) => {
3453|   try {
3454|     const { page, limit, offset } = paginacaoAdmin(req.query)
3455|     const { categoria, raio_km, lat, lng } = req.query
3456| 
3457|     // $1 reservado para o usuario_id (filtro de bloqueados)
3458|     const params = [req.usuario.id]
3459| 
3460|     let query = `
3461|       SELECT r.id, r.titulo, r.categoria, r.valor_estimado, r.cidade, r.bairro, r.uf,
3462|              r.latitude, r.longitude, r.coordenadas_origem,
3463|              -- prazo_atendimento_horas (D81): o card do feed no app lê exatamente este campo
3464|              -- para a faixa de urgência ("🔴 URGENTE / Atender em até Nh") e devolve null
3465|              -- sem ele — o SELECT nunca o incluiu, então a faixa nunca aparecia.
3466|              -- Só o que o card lê (D80 — mesma forma do feed de obras): criado_por,
3467|              -- match_usuario_id, match_feito_em, pedido_tempo_status, prestadores_bloqueados
3468|              -- (a lista negra de quem furou NESTE reparo), client_request_id, status_aprovacao,
3469|              -- criado_em e descricao saíam para todo reparador assinante sem nada no app lê-los.
3470|              r.status, r.expira_em, r.prazo_atendimento_horas,
3471|         (SELECT COUNT(*) FROM interesse_reparos WHERE reparo_id = r.id) as total_interessados,
3472|         (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) as foto_capa
3473|       FROM reparos r
3474|       WHERE r.status = 'aberta' AND r.status_aprovacao = 'aprovada' AND r.expira_em > NOW()
3475|         AND r.match_usuario_id IS NULL
3476|         AND NOT ($1::uuid = ANY(COALESCE(r.prestadores_bloqueados, '{}')))
3477|         AND NOT EXISTS (
3478|           SELECT 1 FROM prestadores_bloqueados_dono pb
3479|           WHERE pb.dono_id = r.criado_por AND pb.prestador_id = $1
3480|         )
3481|         -- Reparo que este prestador já recusou não volta ao feed: o card ficava visível
3482|         -- mas POST /reparos/:id/interesse rejeita com 409 (guarda de duplicidade), então
3483|         -- era um card em que ele não podia mais agir. Fica na BASE do WHERE, antes de
3484|         -- qualquer filtro dinâmico, para valer em todos os modos (cidade, raio, estado e
3485|         -- sem recorte). Só 'recusado' — pendente/contraproposta_dono/aceito seguem iguais.
3486|         AND NOT EXISTS (
3487|           SELECT 1 FROM interesse_reparos ir
3488|           WHERE ir.reparo_id = r.id AND ir.usuario_id = $1 AND ir.status = 'recusado'
3489|         )`
3490| 
3491|     if (categoria && categoria !== 'todas') {
3492|       params.push(categoria)
3493|       query += ` AND r.categoria = $${params.length}`
3494|     }
3495| 
3496|     // Modos 'cidade' e raio numérico passam pelo resolvedor compartilhado (geoBusca):
3497|     // ele decide a ÂNCORA (centro do raio) e o ESCOPO (recorte textual) separadamente e
3498|     // garante que nenhum caminho degrade para "país inteiro". 'estado' e 'pais' seguem
3499|     // no fluxo original logo abaixo, inalterados.
3500|     // Sem raio_km a busca não tem recorte (comportamento de hoje, preservado): o metadado
3501|     // reporta 'pais' porque é o que de fato acontece — o app sempre envia raio_km.
3502|     let filtroMeta = { modo: raio_km || null, aplicado: (!raio_km || raio_km === 'pais') ? 'pais' : raio_km, degradado: false, motivo: null }
3503|     let escopo = null
3504|     let ancora = null
3505| 
3506|     const modoGeo = raio_km === 'cidade' ? 'cidade'
3507|       : (raio_km && raio_km !== 'pais' && raio_km !== 'estado' && !isNaN(parseFloat(raio_km))) ? 'raio'
3508|       : null
3509| 
3510|     if (modoGeo) {
3511|       const busca = await resolverBusca({
3512|         cidade_busca: req.query.cidade_busca,
3513|         uf_busca: req.query.uf_busca,
3514|         lat, lng,
3515|         usuarioId: req.usuario.id
3516|       })
3517|       escopo = busca.escopo
3518|       ancora = busca.ancora
3519|       const filtro = montarFiltroGeo({
3520|         alias: 'r', modo: modoGeo, raio: parseFloat(raio_km), escopo, ancora, params
3521|       })
3522|       filtroMeta = filtro.meta
3523|       // Nada resolvido: devolve vazio SEM consultar. Varrer o país inteiro para um usuário
3524|       // que não sabemos localizar é exatamente o bug que este passo elimina.
3525|       if (filtro.sql === null) {
3526|         return res.json({ reparos: [], page, limit, filtro: filtroMeta, escopo, ancora })
3527|       }
3528|       query += filtro.sql
3529|     } else if (raio_km === 'estado') {
3530|       let uf = (req.query.uf_busca || '').trim()
3531|       if (!uf) {
3532|         const ufResult = await pool.query(`SELECT uf FROM usuarios WHERE id = $1`, [req.usuario.id])
3533|         uf = ufResult.rows[0]?.uf
3534|       }
3535|       if (uf) {
3536|         params.push(uf)
3537|         query += ` AND r.uf = $${params.length}`
3538|       }
3539|     }
3540| 
3541|     params.push(limit)
3542|     query += ` ORDER BY r.expira_em ASC, r.valor_estimado DESC NULLS LAST LIMIT $${params.length}`
3543|     params.push(offset)
3544|     query += ` OFFSET $${params.length}`
3545| 
3546|     const result = await pool.query(query, params)
3547|     res.json({ reparos: result.rows, page, limit, filtro: filtroMeta, escopo, ancora })
3548|   } catch (err) {
3549|     console.error('Erro ao buscar reparos:', err)
3550|     res.status(500).json({ erro: 'Erro ao buscar serviços' })
3551|   }
3552| })
3553| 
3554| router.post('/reparos/:id/interesse', autenticar, exigirNaoSuspenso, exigirPrestador, exigirReparador, async (req, res) => {
3555|   try {
3556|     const { mensagem, valor_proposto } = req.body
3557|     const existente = await pool.query(`SELECT id FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id])
3558|     if (existente.rows.length > 0) return res.status(409).json({ erro: 'Você já demonstrou interesse neste serviço' })
3559|     const result = await pool.query(
3560|       `INSERT INTO interesse_reparos (reparo_id, usuario_id, mensagem, valor_proposto, rodada) VALUES ($1, $2, $3, $4, 1) RETURNING *`,
3561|       [req.params.id, req.usuario.id, mensagem, valor_proposto || null]
3562|     )
3563|     // Notify dono
3564|     const donoInfo = await pool.query(
3565|       `SELECT u.push_token, r.titulo FROM reparos r JOIN usuarios u ON r.criado_por = u.id WHERE r.id = $1`,
3566|       [req.params.id]
3567|     )
3568|     if (donoInfo.rows[0]?.push_token) {
3569|       enviarPushNotificacao(donoInfo.rows[0].push_token, '🔧 Novo interesse!',
3570|         `Um prestador demonstrou interesse no serviço "${donoInfo.rows[0].titulo}"`,
3571|         { tipo: 'novo_interesse', reparo_id: req.params.id }).catch(() => {})
3572|     }
3573|     res.status(201).json(result.rows[0])
3574|   } catch (err) {
3575|     res.status(500).json({ erro: 'Erro ao registrar interesse' })
3576|   }
3577| })
3578| 
3579| // POST /reparos/:id/abertura — "arma" o reparador para este reparo quando ele ABRE o
3580| // detalhe ("Ver serviço") estando a >5km do ENDEREÇO DE CADASTRO (usuarios.latitude/
3581| // longitude, NÃO GPS ao vivo). Aqui NÃO há push nem checagem de GPS ao vivo — só grava a
3582| // linha de armamento. O disparo do push (quando a posição AO VIVO chega a <5km de um reparo
3583| // armado) fica no cron verificarPrestadoresProximos e no POST /feed/checar-proximidade.
3584| router.post('/reparos/:id/abertura', autenticar, exigirPrestador, exigirReparador, async (req, res) => {
3585|   try {
3586|     // Mesmas condições de validade que a checagem de proximidade usa (index.js:3300-3313
3587|     // e o cron server.js:152-161): aberta/aprovada, não expirada, sem match, com coords.
3588|     const reparoResult = await pool.query(
3589|       `SELECT latitude, longitude FROM reparos
3590|        WHERE id = $1 AND status = 'aberta' AND status_aprovacao = 'aprovada'
3591|          AND expira_em > NOW() AND match_usuario_id IS NULL
3592|          AND latitude IS NOT NULL AND longitude IS NOT NULL`,
3593|       [req.params.id]
3594|     )
3595|     // Reparo inexistente/inválido → responde OK mas NÃO arma (idempotente, sem erro ao app).
3596|     if (reparoResult.rows.length === 0) return res.json({ armado: false })
3597| 
3598|     const reparo = reparoResult.rows[0]
3599| 
3600|     // Coords de CADASTRO do reparador (não GPS ao vivo).
3601|     const usuarioResult = await pool.query(
3602|       `SELECT latitude, longitude FROM usuarios WHERE id = $1`,
3603|       [req.usuario.id]
3604|     )
3605|     const usuario = usuarioResult.rows[0]
3606| 
3607|     // Qualquer lado sem coords → não arma (não dá pra medir distância).
3608|     if (!usuario || usuario.latitude == null || usuario.longitude == null) {
3609|       return res.json({ armado: false })
3610|     }
3611| 
3612|     // MESMA fórmula planar de 5km do código de proximidade existente
3613|     // (index.js:3333-3335, espelhando server.js:183-185). RAIO_KM = 5.
3614|     const RAIO_KM = 5
3615|     const lat = parseFloat(usuario.latitude)
3616|     const lng = parseFloat(usuario.longitude)
3617|     const dLat = Math.abs(lat - reparo.latitude) * 111
3618|     const dLon = Math.abs(lng - reparo.longitude) * 111 * Math.cos(lat * Math.PI / 180)
3619|     const distanciaKm = Math.sqrt(dLat * dLat + dLon * dLon)
3620| 
3621|     // <=5km: já está perto — não arma. >5km: arma (upsert idempotente, nunca reseta notificado).
3622|     if (distanciaKm <= RAIO_KM) return res.json({ armado: false })
3623| 
3624|     await pool.query(
3625|       `INSERT INTO aberturas_detalhe (reparador_id, reparo_id)
3626|        VALUES ($1, $2)
3627|        ON CONFLICT (reparador_id, reparo_id) DO NOTHING`,
3628|       [req.usuario.id, req.params.id]
3629|     )
3630|     res.json({ armado: true })
3631|   } catch (err) {
3632|     console.error('[AberturaDetalhe] Erro:', err.message)
3633|     res.status(500).json({ erro: 'Erro ao registrar abertura' })
3634|   }
3635| })
3636| 
3637| router.post('/reparos/:id/match', autenticar, exigirReparador, async (req, res) => {
3638|   try {
3639|     const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1 AND status = 'aberta'`, [req.params.id])
3640|     if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
3641|     // Idempotente: o aceite já casa o prestador (POST .../responder), então o app que ainda
3642|     // chama /match reencontra o PRÓPRIO match. Devolve 200 sem reescrever match_feito_em
3643|     // (não reinicia a contagem) e sem reenviar o contrato. 409 fica só para match de outro.
3644|     if (reparo.rows[0].match_usuario_id) {
3645|       if (reparo.rows[0].match_usuario_id === req.usuario.id) {
3646|         return res.json({
3647|           mensagem: 'Match confirmado! Contagem regressiva iniciada.',
3648|           match_feito_em: reparo.rows[0].match_feito_em
3649|         })
3650|       }
3651|       return res.status(409).json({ erro: 'Este serviço já tem um prestador a caminho' })
3652|     }
3653|     const interesseAceito = await pool.query(
3654|       `SELECT id FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2 AND status = 'aceito'`,
3655|       [req.params.id, req.usuario.id]
3656|     )
3657|     if (interesseAceito.rows.length === 0) return res.status(403).json({ erro: 'Sua proposta ainda não foi aceita para este serviço.' })
3658|     await pool.query(
3659|       `UPDATE reparos SET match_feito_em = NOW(), match_usuario_id = $1 WHERE id = $2`,
3660|       [req.usuario.id, req.params.id]
3661|     )
3662|     const dono = await pool.query(
3663|       `SELECT u.push_token FROM reparos r JOIN usuarios u ON r.criado_por = u.id WHERE r.id = $1`,
3664|       [req.params.id]
3665|     )
3666|     // Responde imediatamente; push e contrato rodam em segundo plano (não bloquear o cliente)
3667|     res.json({ mensagem: 'Match confirmado! Contagem regressiva iniciada.', match_feito_em: new Date() })
3668|     if (dono.rows[0]?.push_token) {
3669|       enviarPushNotificacao(
3670|         dono.rows[0].push_token,
3671|         '🚀 Profissional a caminho!',
3672|         `Um prestador confirmou que está indo até você para "${reparo.rows[0].titulo}"`,
3673|         { tipo: 'match_reparo', reparo_id: req.params.id }
3674|       ).catch(err => console.error('[reparos/match] push falhou:', err.message))
3675|     }
3676|     // Envia contrato por e-mail para dono e prestador
3677|     enviarContratoReparo(req.params.id).catch(err => console.error('Erro ao enviar contrato reparo:', err))
3678|     // Recusa os demais interessados e os notifica — pós-resposta, não bloqueia o cliente
3679|     // (Finding 3.1). Mantido aqui para linhas legadas: reparos casados por /match antes de o
3680|     // aceite passar a criar o match. Os caminhos de aceite chamam a mesma função.
3681|     await rejeitarConcorrentes('reparo', req.params.id, req.usuario.id)
3682|   } catch (err) {
3683|     console.error('[reparos/match]', err.message)
3684|     res.status(500).json({ erro: 'Erro ao confirmar match' })
3685|   }
3686| })
3687| 
3688| // Dono responde a uma proposta (aceitar / recusar / contraproposta)
```

### src/routes/index.js:3689-4086 — responder (dono), prestador-responder, encerrar, expirar-match

```js
3689| router.post('/reparos/:id/interesse/:interesse_id/responder', autenticar, async (req, res) => {
3690|   try {
3691|     const { action, valor } = req.body
3692|     const { id: reparo_id, interesse_id } = req.params
3693| 
3694|     const reparo = await pool.query(`SELECT criado_por, titulo, status, match_usuario_id FROM reparos WHERE id = $1`, [reparo_id])
3695|     if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
3696|     if (reparo.rows[0].criado_por !== req.usuario.id) return res.status(403).json({ erro: 'Apenas o dono pode responder' })
3697|     // Guarda de estado da DEMANDA (D8): espelha a obra — aceitar/contrapropor só num serviço
3698|     // vivo e ainda não casado, para não reabrir um encerrado nem reescrever valor pós-fechamento.
3699|     const reparoAbertoParaNegociar = reparo.rows[0].status === 'aberta' && !reparo.rows[0].match_usuario_id
3700| 
3701|     const interesse = await pool.query(
3702|       `SELECT ir.*, u.push_token FROM interesse_reparos ir JOIN usuarios u ON ir.usuario_id = u.id WHERE ir.id = $1 AND ir.reparo_id = $2`,
3703|       [interesse_id, reparo_id]
3704|     )
3705|     if (interesse.rows.length === 0) return res.status(404).json({ erro: 'Interesse não encontrado' })
3706|     const int = interesse.rows[0]
3707| 
3708|     if (action === 'aceitar') {
3709|       // Idempotência de retry: já aceito → devolve sucesso sem reprocessar (sem repetir
3710|       // push nem o UPDATE do match). Sem isto o jaAceito abaixo não pega o próprio
3711|       // registro (id != $2). Espelha o guard de .../prestador-responder.
3712|       // O contrato É rechamado: se já foi enviado, o claim em enviarContratoReparo sai cedo
3713|       // sem e-mail; se o envio anterior falhou, o claim foi liberado e esta é a retentativa.
3714|       if (int.status === 'aceito') {
3715|         enviarContratoReparo(reparo_id).catch(err => console.error('Erro ao enviar contrato reparo:', err))
3716|         return res.json({ mensagem: 'Proposta aceita! Contrato enviado por e-mail.' })
3717|       }
3718|       // Guarda de estado (D8): só um interesse 'pendente' pode ser aceito — bloqueia aceitar a
3719|       // própria contraproposta do dono, e ressuscitar 'recusado'/'expirado'.
3720|       if (!reparoAbertoParaNegociar) {
3721|         return res.status(409).json({ erro: 'Este serviço não está mais aberto para negociação.' })
3722|       }
3723|       if (int.status !== 'pendente') {
3724|         return res.status(409).json({ erro: 'Esta proposta não está mais disponível para aceite.' })
3725|       }
3726|       const jaAceito = await pool.query(
3727|         `SELECT id FROM interesse_reparos WHERE reparo_id = $1 AND status = 'aceito' AND id != $2`,
3728|         [req.params.id, interesse_id]
3729|       )
3730|       if (jaAceito.rows.length > 0) {
3731|         return res.status(409).json({ erro: 'Já existe um prestador aceito para este serviço' })
3732|       }
3733|       // Suspensão do INTERESSADO (quem chama aqui é o dono) — ver POST .../responder de obra.
3734|       if (await estaSuspenso(int.usuario_id)) {
3735|         return res.status(409).json(ERRO_ACEITE_SUSPENSO)
3736|       }
3737|       await pool.query(`UPDATE interesse_reparos SET status = 'aceito' WHERE id = $1`, [interesse_id])
3738|       // O aceite já casa o prestador com o reparo. Guard match_usuario_id IS NULL: torna o
3739|       // write idempotente em retry e impede que um segundo aceite roube um match existente.
3740|       await pool.query(
3741|         `UPDATE reparos SET match_usuario_id = $1, match_feito_em = NOW()
3742|          WHERE id = $2 AND match_usuario_id IS NULL`,
3743|         [int.usuario_id, reparo_id]
3744|       )
3745|       if (int.push_token) {
3746|         enviarPushNotificacao(int.push_token, '🎉 Deu match!',
3747|           `Parabéns! Você fechou negócio em "${reparo.rows[0].titulo}"! Toque para ver os detalhes.`,
3748|           { tipo: 'interesse_aceito', reparo_id }).catch(() => {})
3749|       }
3750|       // match_usuario_id já foi definido acima, então o contrato pode sair agora — mesmo
3751|       // ponto do fluxo em que a obra envia o dela (POST .../responder).
3752|       enviarContratoReparo(reparo_id).catch(err => console.error('Erro ao enviar contrato reparo:', err))
3753|       // Recusa os demais interessados e os notifica (antes ficava só no /match, que hoje
3754|       // sai no early-return). Fire-and-forget: não bloqueia a resposta.
3755|       rejeitarConcorrentes('reparo', reparo_id, int.usuario_id).catch(err => console.error('[reparos/responder] rejeitarConcorrentes:', err.message))
3756|       return res.json({ mensagem: 'Proposta aceita! Contrato enviado por e-mail.' })
3757|     }
3758| 
3759|     if (action === 'recusar') {
3760|       await pool.query(`UPDATE interesse_reparos SET status = 'recusado' WHERE id = $1`, [interesse_id])
3761|       if (int.push_token) {
3762|         enviarPushNotificacao(int.push_token, '❌ Proposta não aceita',
3763|           `Sua proposta para "${reparo.rows[0].titulo}" não foi selecionada desta vez.`,
3764|           { tipo: 'interesse_recusado', reparo_id }).catch(() => {})
3765|       }
3766|       return res.json({ mensagem: 'Proposta recusada.' })
3767|     }
3768| 
3769|     if (action === 'contraproposta') {
3770|       if (!valor) return res.status(400).json({ erro: 'Informe o valor da contraproposta' })
3771|       // Guarda de estado (D8): contrapropor só num serviço vivo e sobre interesse 'pendente'.
3772|       if (!reparoAbertoParaNegociar) {
3773|         return res.status(409).json({ erro: 'Este serviço não está mais aberto para negociação.' })
3774|       }
3775|       if (int.status !== 'pendente') {
3776|         return res.status(409).json({ erro: 'Esta proposta não está mais em negociação.' })
3777|       }
3778|       await pool.query(
3779|         `UPDATE interesse_reparos SET status = 'contraproposta_dono', valor_contraproposta = $2, rodada = 2 WHERE id = $1`,
3780|         [interesse_id, valor]
3781|       )
3782|       if (int.push_token) {
3783|         enviarPushNotificacao(int.push_token, '💬 Contraproposta recebida!',
3784|           `O solicitante fez uma contraproposta para "${reparo.rows[0].titulo}". Veja no app!`,
3785|           { tipo: 'contraproposta_dono', reparo_id }).catch(() => {})
3786|       }
3787|       return res.json({ mensagem: 'Contraproposta enviada!' })
3788|     }
3789| 
3790|     res.status(400).json({ erro: 'Ação inválida' })
3791|   } catch (err) {
3792|     console.error('Erro ao responder interesse:', err)
3793|     res.status(500).json({ erro: 'Erro ao responder' })
3794|   }
3795| })
3796| 
3797| // Prestador responde a uma contraproposta do dono
3798| router.post('/reparos/:id/interesse/:interesse_id/prestador-responder', autenticar, exigirReparador, async (req, res) => {
3799|   try {
3800|     const { action, valor } = req.body
3801|     const { id: reparo_id, interesse_id } = req.params
3802| 
3803|     const interesse = await pool.query(
3804|       `SELECT * FROM interesse_reparos WHERE id = $1 AND reparo_id = $2 AND usuario_id = $3`,
3805|       [interesse_id, reparo_id, req.usuario.id]
3806|     )
3807|     if (interesse.rows.length === 0) return res.status(404).json({ erro: 'Interesse não encontrado' })
3808|     if (interesse.rows[0].status !== 'contraproposta_dono') {
3809|       // Idempotency for accept retries: if already accepted, return success silently.
3810|       // O contrato é rechamado: se já foi enviado, o claim em enviarContratoReparo sai cedo
3811|       // sem e-mail; se o envio anterior falhou, o claim foi liberado e esta é a retentativa.
3812|       if (action === 'aceitar' && interesse.rows[0].status === 'aceito') {
3813|         enviarContratoReparo(reparo_id).catch(err => console.error('Erro ao enviar contrato reparo:', err))
3814|         return res.json({ mensagem: 'Contraproposta aceita! Contrato enviado por e-mail.' })
3815|       }
3816|       return res.status(400).json({ erro: 'Não há contraproposta pendente' })
3817|     }
3818| 
3819|     const reparo = await pool.query(`SELECT titulo, criado_por FROM reparos WHERE id = $1`, [reparo_id])
3820|     const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [reparo.rows[0].criado_por])
3821| 
3822|     if (action === 'contraproposta') {
3823|       if (!valor) return res.status(400).json({ erro: 'Informe o valor da contraproposta' })
3824|       // Volta para 'pendente' com o novo valor para reentrar no fluxo de resposta do dono
3825|       await pool.query(`UPDATE interesse_reparos SET status = 'pendente', valor_proposto = $2, valor_contraproposta = NULL WHERE id = $1`, [interesse_id, valor])
3826|       if (dono.rows[0]?.push_token) {
3827|         enviarPushNotificacao(dono.rows[0].push_token, '💬 Nova contraproposta do profissional!',
3828|           `O prestador propôs R$ ${Number(valor).toLocaleString('pt-BR')} para "${reparo.rows[0].titulo}". Veja no app!`,
3829|           { tipo: 'contra_oferta', reparo_id }).catch(() => {})
3830|       }
3831|       return res.json({ mensagem: 'Contraproposta enviada!' })
3832|     }
3833| 
3834|     if (action === 'aceitar') {
3835|       // Mesma trava do pintor-responder de obra: só 'aceitar' é barrado; 'recusar' e
3836|       // 'contraproposta' continuam liberados para o suspenso encerrar a negociação.
3837|       const suspensao = await estaSuspenso(req.usuario.id)
3838|       if (suspensao) return res.status(403).json(corpoContaSuspensa(suspensao))
3839|       await pool.query(`UPDATE interesse_reparos SET status = 'aceito' WHERE id = $1`, [interesse_id])
3840|       // O aceite já casa o prestador com o reparo (ver POST .../responder).
3841|       await pool.query(
3842|         `UPDATE reparos SET match_usuario_id = $1, match_feito_em = NOW()
3843|          WHERE id = $2 AND match_usuario_id IS NULL`,
3844|         [req.usuario.id, reparo_id]
3845|       )
3846|       if (dono.rows[0]?.push_token) {
3847|         enviarPushNotificacao(dono.rows[0].push_token, '🎉 Deu match!',
3848|           `Parabéns! Você fechou negócio em "${reparo.rows[0].titulo}"! Toque para ver os detalhes.`,
3849|           { tipo: 'interesse_aceito', reparo_id }).catch(() => {})
3850|       }
3851|       // match_usuario_id já foi definido acima, então o contrato pode sair agora.
3852|       enviarContratoReparo(reparo_id).catch(err => console.error('Erro ao enviar contrato reparo:', err))
3853|       // Recusa os demais interessados e os notifica (ver POST .../responder).
3854|       rejeitarConcorrentes('reparo', reparo_id, req.usuario.id).catch(err => console.error('[reparos/prestador-responder] rejeitarConcorrentes:', err.message))
3855|       return res.json({ mensagem: 'Contraproposta aceita! Contrato enviado por e-mail.' })
3856|     }
3857| 
3858|     if (action === 'recusar') {
3859|       await pool.query(`UPDATE interesse_reparos SET status = 'recusado' WHERE id = $1`, [interesse_id])
3860|       if (dono.rows[0]?.push_token) {
3861|         enviarPushNotificacao(dono.rows[0].push_token, '❌ Proposta recusada',
3862|           `O prestador recusou sua contraproposta para "${reparo.rows[0].titulo}".`,
3863|           { tipo: 'interesse_recusado', reparo_id }).catch(() => {})
3864|       }
3865|       return res.json({ mensagem: 'Proposta recusada.' })
3866|     }
3867| 
3868|     res.status(400).json({ erro: 'Ação inválida' })
3869|   } catch (err) {
3870|     console.error('Erro ao responder contraproposta:', err)
3871|     res.status(500).json({ erro: 'Erro ao responder' })
3872|   }
3873| })
3874| 
3875| // Encerramento assimétrico — ver POST /obras/:id/encerrar para o racional completo.
3876| router.post('/reparos/:id/encerrar', autenticar, async (req, res) => {
3877|   try {
3878|     const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
3879|     if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
3880|     const r = reparo.rows[0]
3881|     const ehDono      = r.criado_por === req.usuario.id
3882|     const ehPrestador = r.match_usuario_id === req.usuario.id
3883|     const ehAdmin     = req.usuario.role === 'admin'
3884|     if (!ehDono && !ehPrestador && !ehAdmin) return res.status(403).json({ erro: 'Sem permissão para encerrar este serviço' })
3885| 
3886|     // Já encerrado → no-op idempotente (não reescreve encerrado_em).
3887|     if (r.status === 'encerrada') {
3888|       return res.json({ mensagem: 'Serviço já encerrado.', encerramento: 'concluido' })
3889|     }
3890| 
3891|     // Chegada é pré-requisito do encerramento. Sem NENHUMA declaração não há registro de que o
3892|     // profissional esteve no local, e encerrar apagaria a única evidência que sustenta falta e
3893|     // reputação. DECLARADA e ainda não confirmada passa de propósito: esse caso já tem fluxo
3894|     // próprio (o dono confirma, ou autoEncerrarPendentes auto-confirma vencido o prazo), e
3895|     // travá-lo puniria o profissional pelo silêncio do dono.
3896|     // Só vale com contraparte casada — demanda que nunca teve match não teve quem chegasse, e
3897|     // bloquear deixaria o dono sem como encerrar. Admin mantém a saída de emergência de sempre.
3898|     if (!ehAdmin && r.match_usuario_id && !r.chegada_declarada_em) {
3899|       return res.status(409).json({ erro: 'Antes de encerrar o serviço, confirme se o profissional chegou ao local.' })
3900|     }
3901| 
3902|     const semContraparte = !r.match_usuario_id
3903|     if (!ehAdmin && !ehDono && !semContraparte) {
3904|       if (!r.encerramento_solicitado_por) {
3905|         await pool.query(
3906|           `UPDATE reparos SET encerramento_solicitado_por = $1, encerramento_solicitado_em = NOW() WHERE id = $2`,
3907|           [req.usuario.id, req.params.id]
3908|         )
3909|         const outroId = ehDono ? r.match_usuario_id : r.criado_por
3910|         const outro = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [outroId])
3911|         if (outro.rows[0]?.push_token) {
3912|           enviarPushNotificacao(outro.rows[0].push_token, '🔔 Encerramento solicitado',
3913|             `A outra parte pediu para encerrar o serviço "${r.titulo}". Confirme no app.`,
3914|             { tipo: 'encerramento_solicitado', reparo_id: req.params.id }).catch(() => {})
3915|         }
3916|         return res.json({ mensagem: 'Encerramento solicitado. Aguardando confirmação da outra parte.', encerramento: 'pendente' })
3917|       }
3918|       if (r.encerramento_solicitado_por === req.usuario.id) {
3919|         return res.json({ mensagem: 'Encerramento já solicitado. Aguardando a outra parte.', encerramento: 'pendente' })
3920|       }
3921|     }
3922| 
3923|     await pool.query(
3924|       `UPDATE reparos SET status = 'encerrada', status_aprovacao = 'encerrada', encerrado_em = NOW(),
3925|                          encerramento_solicitado_por = NULL, encerramento_solicitado_em = NULL
3926|        WHERE id = $1`,
3927|       [req.params.id]
3928|     )
3929|     if (ehDono && r.match_usuario_id) {
3930|       const prestador = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.match_usuario_id])
3931|       if (prestador.rows[0]?.push_token) {
3932|         enviarPushNotificacao(prestador.rows[0].push_token, '✅ Serviço encerrado!',
3933|           `O solicitante encerrou o serviço "${r.titulo}".`, { tipo: 'reparo_encerrado', reparo_id: req.params.id }).catch(() => {})
3934|       }
3935|     } else if (ehPrestador) {
3936|       const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.criado_por])
3937|       if (dono.rows[0]?.push_token) {
3938|         enviarPushNotificacao(dono.rows[0].push_token, '✅ Serviço concluído!',
3939|           `O prestador concluiu o serviço "${r.titulo}".`, { tipo: 'reparo_encerrado', reparo_id: req.params.id }).catch(() => {})
3940|       }
3941|     }
3942|     res.json({ mensagem: 'Serviço encerrado com sucesso!', encerramento: 'concluido' })
3943|   } catch (err) {
3944|     console.error('[reparos/encerrar]', err.message)
3945|     res.status(500).json({ erro: 'Erro ao encerrar serviço' })
3946|   }
3947| })
3948| 
3949| router.post('/reparos/:id/expirar-match', autenticar, async (req, res) => {
3950|   try {
3951|     const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
3952|     if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Serviço não encontrado' })
3953|     const r = reparo.rows[0]
3954|     const ehDono      = r.criado_por === req.usuario.id
3955|     const ehPrestador = r.match_usuario_id === req.usuario.id
3956|     const ehAdmin     = req.usuario.role === 'admin'
3957|     if (!ehDono && !ehPrestador && !ehAdmin) {
3958|       return res.status(403).json({ erro: 'Sem permissão para expirar este match' })
3959|     }
3960|     // Chegada declarada/confirmada congela a expiração do match (mesma regra do cron): o
3961|     // prestador está no local — expirar aqui ainda o mandaria para a lista negra do reparo.
3962|     //
3963|     // EXCEÇÃO — o dono contesta chegada declarada por outro (ver POST /obras/:id/expirar-match
3964|     // para o racional completo). Só o dono passa; prestador e admin seguem barrados.
3965|     const donoContesta = ehDono
3966|       && r.chegada_declarada_por !== req.usuario.id
3967|       && r.status !== 'encerrada'
3968|     if ((r.chegada_declarada_em || r.chegada_confirmada_em) && !donoContesta) {
3969|       return res.status(409).json({ erro: 'Chegada já declarada — o match não pode mais expirar' })
3970|     }
3971|     // Grava o prestador na lista negra antes de limpar o match.
3972|     // chegada_* zeradas junto: o reparo volta ao feed limpo (ver /obras/:id/expirar-match).
3973|     // O CASE substitui o array_append cru: é NULL-safe (match já desfeito gravaria um NULL no
3974|     // array) e idempotente (rechamada não duplica o mesmo uuid).
3975|     const prestadorId = r.match_usuario_id
3976|     const upd = await pool.query(
3977|       `WITH desfeito AS (
3978|          UPDATE reparos SET
3979|            match_feito_em = NULL,
3980|            match_usuario_id = NULL,
3981|            -- pedido_tempo_* zerados como em POST /obras/:id/expirar-match e no cron de reparos
3982|            -- (D75): sem isto o serviço voltava ao feed com um pedido de tempo do prestador
3983|            -- anterior, e o próximo match nascia "aguardando aprovação" de alguém que já saiu.
3984|            pedido_tempo_status = NULL,
3985|            pedido_tempo_motivo = NULL,
3986|            pedido_tempo_minutos = NULL,
3987|            chegada_janela = NULL,
3988|            chegada_prevista_em = NULL,
3989|            chegada_declarada_por = NULL,
3990|            chegada_declarada_em = NULL,
3991|            chegada_pendente_janela = NULL,
3992|            chegada_pendente_em = NULL,
3993|            chegada_recusada_em = NULL,
3994|            chegada_confirmada_em = NULL,
3995|            prestadores_bloqueados = CASE
3996|              -- Isenção por janela não honrada pelo dono (ver POST /obras/:id/expirar-match e o
3997|              -- CASE dos crons): recusada OU pendente sem resposta, e nenhuma outra valendo.
3998|              WHEN chegada_prevista_em IS NULL
3999|                   AND (chegada_recusada_em IS NOT NULL OR chegada_pendente_em IS NOT NULL)
4000|              THEN prestadores_bloqueados
4001|              WHEN $2::uuid IS NULL OR $2::uuid = ANY(COALESCE(prestadores_bloqueados, '{}'))
4002|              THEN prestadores_bloqueados
4003|              ELSE array_append(COALESCE(prestadores_bloqueados, '{}'), $2::uuid) END
4004|           WHERE id = $1
4005|             AND (
4006|               (chegada_declarada_em IS NULL AND chegada_confirmada_em IS NULL)
4007|               -- Espelha o donoContesta relendo a linha VIVA (ver /obras/:id/expirar-match).
4008|               OR ($3::boolean
4009|                   AND chegada_declarada_por IS DISTINCT FROM criado_por
4010|                   AND status IS DISTINCT FROM 'encerrada')
4011|             )
4012|           RETURNING id
4013|        ), proposta AS (
4014|          -- A proposta vencedora expira junto com o match, no mesmo statement — senão ela seguia
4015|          -- 'aceito' ocupando interesse_reparos_aceito_unico_idx e o serviço voltava ao feed sem
4016|          -- poder ser aceito de novo (ver POST /obras/:id/expirar-match).
4017|          UPDATE interesse_reparos SET status = 'expirado'
4018|           WHERE reparo_id IN (SELECT id FROM desfeito) AND usuario_id = $2::uuid AND status = 'aceito'
4019|           RETURNING id
4020|        )
4021|        SELECT id FROM desfeito`,
4022|       [req.params.id, prestadorId, ehDono]
4023|     )
4024|     // rowCount = 0 (o SELECT final não devolveu linha) → chegada declarada entre o SELECT e o UPDATE (ver /obras/:id/expirar-match).
4025|     // Sai antes de qualquer push: nada expirou, e o prestador segue com o match.
4026|     if (upd.rowCount === 0) {
4027|       return res.status(409).json({ erro: 'Chegada já declarada — o match não pode mais expirar' })
4028|     }
4029|     // Este endpoint não notificava NINGUÉM. Agora avisa os dois lados, como o de obra.
4030|     const donoR = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [r.criado_por])
4031|     const prestadorR = prestadorId
4032|       ? await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [prestadorId])
4033|       : { rows: [] }
4034|     res.json({ mensagem: 'Match expirado, serviço disponível novamente' })
4035|     if (donoR.rows[0]?.push_token) {
4036|       enviarPushNotificacao(donoR.rows[0].push_token, '⏰ Prazo expirado!',
4037|         `O prestador não chegou a tempo para "${r.titulo}". O serviço está disponível novamente.`,
4038|         { tipo: 'match_expirado', reparo_id: req.params.id }).catch(() => {})
4039|     }
4040|     if (prestadorR.rows[0]?.push_token) {
4041|       enviarPushNotificacao(prestadorR.rows[0].push_token, '⏰ Prazo expirado!',
4042|         `O prazo para chegar em "${r.titulo}" acabou. O serviço voltou para o feed.`,
4043|         { tipo: 'match_expirado', reparo_id: req.params.id }).catch(() => {})
4044|     }
4045|     return
4046|   } catch (err) {
4047|     res.status(500).json({ erro: 'Erro ao expirar match' })
4048|   }
4049| })
4050| 
4051| // ============================================================
4052| // CHEGADA — previsão e confirmação (obras e reparos)
4053| // ============================================================
4054| // Dois passos independentes:
4055| //   1) POST /:id/chegada-prevista — o profissional casado escolhe UMA janela. Write-once:
4056| //      a primeira escolhida vale, as seguintes devolvem a que já está gravada (o dono se
4057| //      programou em cima dela; deixar o profissional reescrever esvaziaria a promessa).
4058| //   2) POST /:id/chegada — dono OU profissional declara que a chegada aconteceu. Só a
4059| //      palavra do DONO confirma (chegada_confirmada_em); o profissional sozinho apenas
4060| //      declara e fica aguardando.
4061| //
4062| // `tabela` sai SEMPRE de literal no registro da rota (logo abaixo), nunca do request —
4063| // a interpolação no SQL não é superfície de injeção. Mesmo padrão de autoEncerrarPendentes.
4064| 
4065| const TZ_CHEGADA = 'America/Sao_Paulo'
4066| 
4067| // Offsets a partir da MEIA-NOITE local de hoje (America/Sao_Paulo):
4068| //   hoje         → hoje 23:59
4069| //   amanha_manha → amanhã 12:00
4070| //   amanha_tarde → amanhã 18:00
4071| // Resolvidos no Postgres com o fuso explícito, não no relógio do processo: o container do
4072| // Railway roda em UTC, então `new Date()` daria o dia errado entre 21:00 e 00:00 de Brasília.
4073| const JANELAS_CHEGADA = {
4074|   hoje:         { dias: 0, horas: 23, minutos: 59, rotulo: 'ainda hoje' },
4075|   amanha_manha: { dias: 1, horas: 12, minutos: 0,  rotulo: 'amanhã de manhã' },
4076|   amanha_tarde: { dias: 1, horas: 18, minutos: 0,  rotulo: 'amanhã à tarde' },
4077| }
4078| 
4079| // Rótulos por tabela para os pushes: a chave do payload segue a convenção das notificações de
4080| // match (obra_id / reparo_id) e o substantivo acompanha o tier (pintor em obra, prestador em
4081| // reparo), como em '🚀 Pintor a caminho!' vs '🚀 Profissional a caminho!'.
4082| const ROTULOS_CHEGADA = {
4083|   obras:   { chave: 'obra_id',   profissional: 'pintor' },
4084|   reparos: { chave: 'reparo_id', profissional: 'prestador' },
4085| }
4086| 
```

### src/routes/index.js:4087-4356 — Fábrica compartilhada de chegada: chegada-prevista (janelas), chegada (declarar/confirmar), responder janela — registrada para obras E reparos

```js
4087| const criarHandlerChegadaPrevista = (tabela) => async (req, res) => {
4088|   try {
4089|     const { janela } = req.body || {}
4090|     // hasOwnProperty e não `JANELAS_CHEGADA[janela]`: 'constructor'/'toString' vêm do
4091|     // protótipo e passariam por um teste de truthiness.
4092|     if (typeof janela !== 'string' || !Object.prototype.hasOwnProperty.call(JANELAS_CHEGADA, janela)) {
4093|       return res.status(400).json({
4094|         erro: 'janela inválida',
4095|         janelas_validas: Object.keys(JANELAS_CHEGADA),
4096|       })
4097|     }
4098|     const alvo = await pool.query(
4099|       `SELECT titulo, criado_por, match_usuario_id FROM ${tabela} WHERE id = $1`,
4100|       [req.params.id]
4101|     )
4102|     if (alvo.rows.length === 0) return res.status(404).json({ erro: 'Demanda não encontrada' })
4103|     // Só o profissional CASADO — nem o dono, nem um profissional que apenas se candidatou.
4104|     if (!alvo.rows[0].match_usuario_id || alvo.rows[0].match_usuario_id !== req.usuario.id) {
4105|       return res.status(403).json({ erro: 'Apenas o profissional do match pode informar a previsão de chegada' })
4106|     }
4107| 
4108|     const { dias, horas, minutos, rotulo } = JANELAS_CHEGADA[janela]
4109|     // Write-once DENTRO do UPDATE (os dois _em NULL no WHERE), não em um if antes: dois toques
4110|     // simultâneos passariam os dois por uma checagem separada e o segundo sobrescreveria a
4111|     // janela já prometida ao dono. O par PENDENTE entra no guard junto — enquanto uma proposta
4112|     // aguarda resposta do dono, o profissional não troca a aposta por baixo dela.
4113|     //
4114|     // GREATEST(..., NOW() + 1 hour) = PISO da previsão. 'hoje' escolhido às 23:55 renderia
4115|     // 23:59 — 4 minutos, e às 23:59:30 já nasceria VENCIDA, com o dono recebendo uma promessa
4116|     // impossível. O piso empurra esses casos para NOW() + 1h.
4117|     //
4118|     // A previsão calculada cai em UM dos dois pares, decidido no próprio SQL (CTE `calc` para
4119|     // não repetir a expressão quatro vezes):
4120|     //   cabe no expira_em  → chegada_janela/chegada_prevista_em, como antes.
4121|     //   estoura o expira_em → chegada_pendente_*, aguardando o dono. NÃO mexe no prazo aqui:
4122|     //      esticar a demanda por decisão unilateral do profissional é exatamente o que o
4123|     //      fluxo de aprovação existe para evitar.
4124|     // COALESCE(expira_em, 'infinity'): demanda sem prazo não tem o que estourar — cabe sempre.
4125|     // Os dois CASE são mutuamente exclusivos, então nunca gravam nos dois pares.
4126|     const upd = await pool.query(
4127|       `WITH calc AS (
4128|          SELECT GREATEST(
4129|            (
4130|              date_trunc('day', NOW() AT TIME ZONE $3::text)
4131|              + ($4::int * INTERVAL '1 day')
4132|              + ($5::int * INTERVAL '1 hour')
4133|              + ($6::int * INTERVAL '1 minute')
4134|            ) AT TIME ZONE $3::text,
4135|            NOW() + INTERVAL '1 hour'
4136|          ) AS prevista
4137|        )
4138|        UPDATE ${tabela} d SET
4139|          chegada_janela = CASE
4140|            WHEN c.prevista <= COALESCE(d.expira_em, 'infinity'::timestamptz) THEN $2::text
4141|            ELSE d.chegada_janela END,
4142|          chegada_prevista_em = CASE
4143|            WHEN c.prevista <= COALESCE(d.expira_em, 'infinity'::timestamptz) THEN c.prevista
4144|            ELSE d.chegada_prevista_em END,
4145|          chegada_pendente_janela = CASE
4146|            WHEN c.prevista > COALESCE(d.expira_em, 'infinity'::timestamptz) THEN $2::text
4147|            ELSE d.chegada_pendente_janela END,
4148|          chegada_pendente_em = CASE
4149|            WHEN c.prevista > COALESCE(d.expira_em, 'infinity'::timestamptz) THEN c.prevista
4150|            ELSE d.chegada_pendente_em END
4151|        FROM calc c
4152|        WHERE d.id = $1 AND d.match_usuario_id = $7
4153|          AND d.chegada_prevista_em IS NULL AND d.chegada_pendente_em IS NULL
4154|        RETURNING d.chegada_janela, d.chegada_prevista_em,
4155|                  d.chegada_pendente_janela, d.chegada_pendente_em`,
4156|       [req.params.id, janela, TZ_CHEGADA, dias, horas, minutos, req.usuario.id]
4157|     )
4158|     if (upd.rowCount > 0) {
4159|       // Push só no write REAL: o caminho de baixo (previsão já gravada) é retry/reabertura da
4160|       // tela, e reavisar o dono a cada toque viraria spam de uma promessa que não mudou.
4161|       // Token buscado ANTES do res.json: um throw depois da resposta cairia no catch e tentaria
4162|       // responder duas vezes (mesmo cuidado de candidaturasController.aprovar).
4163|       const { chave, profissional } = ROTULOS_CHEGADA[tabela]
4164|       const pendente = !!upd.rows[0].chegada_pendente_em
4165|       const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [alvo.rows[0].criado_por])
4166|       res.json(upd.rows[0])
4167|       if (dono.rows[0]?.push_token) {
4168|         // Dois textos porque são duas perguntas diferentes: um informa, o outro PEDE resposta.
4169|         enviarPushNotificacao(
4170|           dono.rows[0].push_token,
4171|           pendente ? '📅 Chegada depois do prazo' : '📅 Previsão de chegada!',
4172|           pendente
4173|             ? `O ${profissional} só consegue chegar ${rotulo} em "${alvo.rows[0].titulo}", depois do prazo. Aceitar ou recusar?`
4174|             : `O ${profissional} informou que chega ${rotulo} para "${alvo.rows[0].titulo}"`,
4175|           { tipo: pendente ? 'chegada_prevista_pendente' : 'chegada_prevista', [chave]: req.params.id }
4176|         ).catch(() => {})
4177|       }
4178|       return
4179|     }
4180| 
4181|     // rowCount = 0 → já havia previsão (gravada ou pendente). Não é erro: devolve o que vale.
4182|     const atual = await pool.query(
4183|       `SELECT chegada_janela, chegada_prevista_em, chegada_pendente_janela, chegada_pendente_em
4184|          FROM ${tabela} WHERE id = $1`,
4185|       [req.params.id]
4186|     )
4187|     if (atual.rows.length === 0) return res.status(404).json({ erro: 'Demanda não encontrada' })
4188|     res.json(atual.rows[0])
4189|   } catch (err) {
4190|     console.error(`[${tabela}/chegada-prevista]`, err.message)
4191|     res.status(500).json({ erro: 'Erro ao registrar previsão de chegada' })
4192|   }
4193| }
4194| 
4195| const criarHandlerChegada = (tabela) => async (req, res) => {
4196|   try {
4197|     const alvo = await pool.query(
4198|       `SELECT titulo, criado_por, match_usuario_id, chegada_declarada_em, chegada_confirmada_em
4199|          FROM ${tabela} WHERE id = $1`,
4200|       [req.params.id]
4201|     )
4202|     if (alvo.rows.length === 0) return res.status(404).json({ erro: 'Demanda não encontrada' })
4203|     const d = alvo.rows[0]
4204|     const ehDono         = d.criado_por === req.usuario.id
4205|     const ehProfissional = !!d.match_usuario_id && d.match_usuario_id === req.usuario.id
4206|     if (!ehDono && !ehProfissional) {
4207|       return res.status(403).json({ erro: 'Apenas o dono ou o profissional do match podem declarar a chegada' })
4208|     }
4209| 
4210|     // COALESCE em todos os campos = idempotente: rechamar não desloca timestamp já gravado,
4211|     // e a declaração do profissional (que veio primeiro) não é apagada pela do dono.
4212|     //
4213|     // chegada_confirmada_em:
4214|     //   dono         → NOW() na hora (a palavra do dono basta).
4215|     //   profissional → só se o DONO já tinha declarado antes. As expressões do SET leem a
4216|     //                  linha ANTIGA, então `chegada_declarada_por = criado_por` aqui testa
4217|     //                  quem declarou ANTES desta chamada, não o valor que estamos gravando.
4218|     const upd = await pool.query(
4219|       `UPDATE ${tabela} SET
4220|          chegada_declarada_por = COALESCE(chegada_declarada_por, $2::uuid),
4221|          chegada_declarada_em  = COALESCE(chegada_declarada_em, NOW()),
4222|          chegada_confirmada_em = CASE
4223|            WHEN chegada_confirmada_em IS NOT NULL THEN chegada_confirmada_em
4224|            WHEN $3::boolean THEN NOW()
4225|            WHEN chegada_declarada_por = criado_por THEN NOW()
4226|            ELSE NULL
4227|          END
4228|        WHERE id = $1
4229|        RETURNING chegada_declarada_por, chegada_declarada_em, chegada_confirmada_em`,
4230|       [req.params.id, req.usuario.id, ehDono]
4231|     )
4232|     // Transições NULL → preenchido, comparando o estado lido antes com o RETURNING. Só a
4233|     // transição notifica: rechamar o endpoint não reenvia push, porque na segunda vez o campo
4234|     // já estava preenchido ANTES.
4235|     const declarouAgora  = !d.chegada_declarada_em  && !!upd.rows[0].chegada_declarada_em
4236|     const confirmouAgora = !d.chegada_confirmada_em && !!upd.rows[0].chegada_confirmada_em
4237|     const { chave, profissional } = ROTULOS_CHEGADA[tabela]
4238| 
4239|     // Tokens buscados ANTES do res.json: um throw depois da resposta cairia no catch e tentaria
4240|     // responder duas vezes (mesmo cuidado de candidaturasController.aprovar).
4241|     const avisarDono = declarouAgora && ehProfissional
4242|     const avisarProf = confirmouAgora && !!d.match_usuario_id
4243|     const tokenDono = avisarDono
4244|       ? (await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [d.criado_por])).rows[0]?.push_token
4245|       : null
4246|     const tokenProf = avisarProf
4247|       ? (await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [d.match_usuario_id])).rows[0]?.push_token
4248|       : null
4249| 
4250|     res.json(upd.rows[0])
4251| 
4252|     // Profissional declarou → o dono precisa confirmar.
4253|     if (tokenDono) {
4254|       enviarPushNotificacao(tokenDono, '📍 Chegada informada!',
4255|         `O ${profissional} informou que chegou em "${d.titulo}". Confirme no app.`,
4256|         { tipo: 'chegada_declarada', [chave]: req.params.id }).catch(() => {})
4257|     }
4258|     // Chegada confirmada → avisa o profissional. Vale tanto para o dono declarando direto
4259|     // quanto para o dono confirmando uma declaração anterior do profissional.
4260|     if (tokenProf) {
4261|       enviarPushNotificacao(tokenProf, '✅ Chegada confirmada!',
4262|         `O solicitante confirmou sua chegada em "${d.titulo}".`,
4263|         { tipo: 'chegada_confirmada', [chave]: req.params.id }).catch(() => {})
4264|     }
4265|   } catch (err) {
4266|     console.error(`[${tabela}/chegada]`, err.message)
4267|     res.status(500).json({ erro: 'Erro ao registrar chegada' })
4268|   }
4269| }
4270| 
4271| // POST /:id/chegada-prevista/responder — o dono responde à janela que estourou o prazo.
4272| // aceito=true  → a pendente vira a valer e o expira_em ESTICA até ela (senão o cron mataria o
4273| //                match no prazo velho, um minuto depois de o dono ter dito sim).
4274| // aceito=false → limpa só a pendente. O profissional NÃO é bloqueado, NÃO perde o match e volta
4275| //                a poder escolher outra janela (o guard write-once do outro handler olha os dois
4276| //                _em, e ambos ficam NULL de novo).
4277| const criarHandlerChegadaPrevistaResponder = (tabela) => async (req, res) => {
4278|   try {
4279|     const { aceito } = req.body || {}
4280|     if (typeof aceito !== 'boolean') {
4281|       return res.status(400).json({ erro: 'aceito é obrigatório e deve ser booleano' })
4282|     }
4283|     const alvo = await pool.query(
4284|       `SELECT titulo, criado_por, match_usuario_id, chegada_pendente_janela, chegada_pendente_em
4285|          FROM ${tabela} WHERE id = $1`,
4286|       [req.params.id]
4287|     )
4288|     if (alvo.rows.length === 0) return res.status(404).json({ erro: 'Demanda não encontrada' })
4289|     const d = alvo.rows[0]
4290|     // Só o DONO responde: é o prazo dele que está sendo esticado.
4291|     if (d.criado_por !== req.usuario.id) {
4292|       return res.status(403).json({ erro: 'Apenas o dono pode responder à previsão de chegada' })
4293|     }
4294|     if (!d.chegada_pendente_em) {
4295|       return res.status(409).json({ erro: 'Não há previsão de chegada aguardando resposta' })
4296|     }
4297| 
4298|     // chegada_pendente_em IS NOT NULL repetido no WHERE: duas respostas simultâneas não aplicam
4299|     // o aceite duas vezes (a segunda volta rowCount = 0 e cai no 409 acima na próxima tentativa).
4300|     // GREATEST no expira_em em vez de atribuição direta: se o dono tiver estendido o prazo para
4301|     // além da janela nesse meio-tempo, aceitar não pode ENCURTAR a demanda.
4302|     // match_usuario_id não é tocado em nenhum dos dois ramos — responder nunca desfaz o match.
4303|     const upd = aceito
4304|       ? await pool.query(
4305|           `UPDATE ${tabela} SET
4306|              chegada_janela = chegada_pendente_janela,
4307|              chegada_prevista_em = chegada_pendente_em,
4308|              expira_em = GREATEST(expira_em, chegada_pendente_em),
4309|              chegada_pendente_janela = NULL,
4310|              chegada_pendente_em = NULL
4311|            WHERE id = $1 AND chegada_pendente_em IS NOT NULL
4312|            RETURNING chegada_janela, chegada_prevista_em, expira_em`,
4313|           [req.params.id]
4314|         )
4315|       : await pool.query(
4316|           // chegada_recusada_em marca a recusa para o cron não cobrar falta de quem ofereceu
4317|           // horário e ouviu não. Só o ramo da recusa grava — aceitar não deixa marca.
4318|           `UPDATE ${tabela} SET chegada_pendente_janela = NULL, chegada_pendente_em = NULL,
4319|                                 chegada_recusada_em = NOW()
4320|            WHERE id = $1 AND chegada_pendente_em IS NOT NULL
4321|            RETURNING chegada_janela, chegada_prevista_em, expira_em`,
4322|           [req.params.id]
4323|         )
4324|     if (upd.rowCount === 0) {
4325|       return res.status(409).json({ erro: 'Não há previsão de chegada aguardando resposta' })
4326|     }
4327| 
4328|     const { chave, profissional } = ROTULOS_CHEGADA[tabela]
4329|     const rotuloPendente = JANELAS_CHEGADA[d.chegada_pendente_janela]?.rotulo || d.chegada_pendente_janela
4330|     const prof = d.match_usuario_id
4331|       ? await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [d.match_usuario_id])
4332|       : { rows: [] }
4333|     res.json(upd.rows[0])
4334|     if (prof.rows[0]?.push_token) {
4335|       enviarPushNotificacao(
4336|         prof.rows[0].push_token,
4337|         aceito ? '✅ Janela aprovada!' : '❌ Janela recusada',
4338|         aceito
4339|           ? `O solicitante aceitou sua chegada ${rotuloPendente} em "${d.titulo}". O prazo foi estendido.`
4340|           : `O solicitante não pode esperar até ${rotuloPendente} em "${d.titulo}". Escolha outra janela no app.`,
4341|         { tipo: aceito ? 'chegada_prevista_aceita' : 'chegada_prevista_recusada', [chave]: req.params.id }
4342|       ).catch(() => {})
4343|     }
4344|   } catch (err) {
4345|     console.error(`[${tabela}/chegada-prevista/responder]`, err.message)
4346|     res.status(500).json({ erro: 'Erro ao responder previsão de chegada' })
4347|   }
4348| }
4349| 
4350| router.post('/obras/:id/chegada-prevista',   autenticar, criarHandlerChegadaPrevista('obras'))
4351| router.post('/reparos/:id/chegada-prevista', autenticar, criarHandlerChegadaPrevista('reparos'))
4352| router.post('/obras/:id/chegada-prevista/responder',   autenticar, criarHandlerChegadaPrevistaResponder('obras'))
4353| router.post('/reparos/:id/chegada-prevista/responder', autenticar, criarHandlerChegadaPrevistaResponder('reparos'))
4354| router.post('/obras/:id/chegada',            autenticar, criarHandlerChegada('obras'))
4355| router.post('/reparos/:id/chegada',          autenticar, criarHandlerChegada('reparos'))
4356| 
```
