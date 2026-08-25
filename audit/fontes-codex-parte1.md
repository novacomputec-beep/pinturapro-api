# Fontes — Codex (parte 1 de 4)

Código-fonte REAL de `pinturapro-api` (branch `main`), selecionado para o auditor externo julgar as regras descritas em `dossie-codex.md`. Cada bloco traz `caminho:linha-inicial-linha-final` e cada linha vem prefixada com o número dela no arquivo. Nada de `.env`, segredos ou dados de produção — todos os segredos são lidos de `process.env`. Comentários foram mantidos porque carregam o racional de cada regra.

Seções: 1 gates · 2 dinheiro · 3 verificação/aprovação · 4 ciclo de vida OBRA · 5 ciclo de vida REPARO · 6 compartilhado · 7 crons · 8 migração de boot.


## 1. Portas de entrada — autenticação, papéis, tiers, suspensão, assinatura

### src/middlewares/auth.js:1-178 — Middleware inteiro: cache 30s, autenticar (JWT + token_version), exigirAssinaturaAtiva, exigirNaoSuspenso, exigirAdmin, exigirSuperAdmin

```js
  1| const jwt = require('jsonwebtoken')
  2| const { pool } = require('../utils/supabase')
  3| 
  4| // Cache simples em memória
  5| const cacheUsuarios = new Map()
  6| const cacheAssinaturas = new Map()
  7| // 30s (era 5 min): o cache é POR PROCESSO, então invalidarCacheAssinatura só limpa a réplica
  8| // que atendeu a requisição — com mais de uma, um prestador recém-aprovado seguiria barrado
  9| // nas outras até o TTL vencer. 30s limita essa janela sem largar o cache. As duas consultas
 10| // por trás dele são de uma linha por índice (usuarios_pkey e assinaturas_usuario_id_unico_idx),
 11| // então o custo dos misses extras é baixo.
 12| const CACHE_TTL = 30 * 1000
 13| 
 14| const getCacheUsuario = (id) => {
 15|   const entry = cacheUsuarios.get(id)
 16|   if (!entry) return null
 17|   if (Date.now() - entry.timestamp > CACHE_TTL) {
 18|     cacheUsuarios.delete(id)
 19|     return null
 20|   }
 21|   return entry.data
 22| }
 23| 
 24| const setCacheUsuario = (id, data) => {
 25|   cacheUsuarios.set(id, { data, timestamp: Date.now() })
 26| }
 27| 
 28| const getCacheAssinatura = (id) => {
 29|   const entry = cacheAssinaturas.get(id)
 30|   if (!entry) return null
 31|   if (Date.now() - entry.timestamp > CACHE_TTL) {
 32|     cacheAssinaturas.delete(id)
 33|     return null
 34|   }
 35|   return entry.data
 36| }
 37| 
 38| const setCacheAssinatura = (id, data) => {
 39|   cacheAssinaturas.set(id, { data, timestamp: Date.now() })
 40| }
 41| 
 42| // Invalida os caches em memória de um usuário. Chamado quando a assinatura muda
 43| // de estado (ex.: aprovação manual / auto-aprovação ativa a assinatura) para que
 44| // a próxima chamada a rota protegida releia o status real do banco em vez de
 45| // devolver um `false` cacheado por até 5 min — o que mandava o prestador recém-
 46| // aprovado para a tela de pagamento mesmo já tendo pago/sido aprovado (B72-07).
 47| const invalidarCacheAssinatura = (id) => {
 48|   cacheUsuarios.delete(id)
 49|   cacheAssinaturas.delete(id)
 50| }
 51| 
 52| // Fonte ÚNICA da resposta "este usuário tem assinatura ativa?", com o cache por trás.
 53| // Existia uma segunda cópia em routes/index.js (cachePrestadores) com a MESMA consulta e o
 54| // MESMO predicado: dois mapas guardando a mesma resposta, e por isso a invalidação precisava
 55| // lembrar de limpar os dois — que foi exatamente o esquecimento do B72-07. Agora exigirPrestador
 56| // (routes) e exigirAssinaturaAtiva (aqui) passam os dois por esta função.
 57| const assinaturaAtivaCacheada = async (usuarioId) => {
 58|   // getCacheAssinatura devolve null quando não há entrada ou ela expirou; `false` cacheado é
 59|   // resposta legítima e NÃO pode ir ao banco de novo.
 60|   let ativa = getCacheAssinatura(usuarioId)
 61|   if (ativa === null || ativa === undefined) {
 62|     const result = await pool.query(
 63|       `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' AND (proximo_vencimento IS NULL OR proximo_vencimento > NOW()) LIMIT 1`,
 64|       [usuarioId]
 65|     )
 66|     ativa = result.rows.length > 0
 67|     setCacheAssinatura(usuarioId, ativa)
 68|   }
 69|   return ativa
 70| }
 71| 
 72| const autenticar = async (req, res, next) => {
 73|   try {
 74|     const authHeader = req.headers.authorization
 75|     if (!authHeader || !authHeader.startsWith('Bearer ')) {
 76|       return res.status(401).json({ erro: 'Token não fornecido' })
 77|     }
 78|     const token = authHeader.split(' ')[1]
 79|     const decoded = jwt.verify(token, process.env.JWT_SECRET)
 80| 
 81|     if (decoded.tipo === '2fa_pendente') {
 82|       return res.status(401).json({ erro: 'Autenticação incompleta — código 2FA necessário' })
 83|     }
 84| 
 85|     // Tenta cache primeiro
 86|     let usuario = getCacheUsuario(decoded.id)
 87|     if (!usuario) {
 88|       const result = await pool.query(
 89|         'SELECT id, nome, email, role, ativo, tipo_prestador, suspenso_em, suspenso_motivo, token_version FROM usuarios WHERE id = $1',
 90|         [decoded.id]
 91|       )
 92|       if (result.rows.length === 0) {
 93|         return res.status(401).json({ erro: 'Usuário não encontrado' })
 94|       }
 95|       usuario = result.rows[0]
 96|       setCacheUsuario(decoded.id, usuario)
 97|     }
 98| 
 99|     if (!usuario.ativo) {
100|       return res.status(403).json({ erro: 'Conta desativada' })
101|     }
102| 
103|     // Revogação por troca de senha (D51): o JWT carrega a versão vigente na emissão (tv);
104|     // trocar a senha incrementa token_version e o token antigo deixa de casar. Token legado
105|     // sem 'tv' conta como 1, que casa com o default 1 das linhas — ninguém é deslogado no
106|     // deploy. Lê token_version do MESMO `usuario` (cache de 30s): a revogação é imediata na
107|     // réplica que processou a troca (ela invalida o cache local) e vale em até 30s nas demais.
108|     if ((decoded.tv ?? 1) !== usuario.token_version) {
109|       return res.status(401).json({ erro: 'Sua senha foi alterada. Faça login novamente.', codigo: 'TOKEN_REVOGADO' })
110|     }
111| 
112|     req.usuario = usuario
113|     next()
114|   } catch (err) {
115|     console.error('Erro auth:', err.message)
116|     return res.status(401).json({ erro: 'Token inválido ou expirado' })
117|   }
118| }
119| 
120| const exigirAssinaturaAtiva = async (req, res, next) => {
121|   if (req.usuario.role === 'admin' || req.usuario.role === 'aprovador' || req.usuario.role === 'dono_obra') {
122|     return next()
123|   }
124|   try {
125|     const assinaturaAtiva = await assinaturaAtivaCacheada(req.usuario.id)
126| 
127|     if (!assinaturaAtiva) {
128|       return res.status(403).json({
129|         erro: 'Assinatura inativa. Renove seu plano para acessar as obras.',
130|         codigo: 'ASSINATURA_INATIVA'
131|       })
132|     }
133|     next()
134|   } catch (err) {
135|     return res.status(500).json({ erro: 'Erro ao verificar assinatura' })
136|   }
137| }
138| 
139| // Suspensão por faltas (ver registrarFalta em alertaService). Fecha só a porta de ENTRADA em
140| // trabalho novo: feeds, proximidade e criação/aceite de proposta. Tudo que já está em
141| // andamento — match, chegada, encerramento, avaliação, denúncia, perfil, login — segue aberto,
142| // porque suspender alguém no meio de um serviço puniria o dono junto.
143| // admin/aprovador nunca são barrados (moderação não pode se autotrancar).
144| // suspenso_em vem de req.usuario, populado por autenticar — atenção ao cache de 5 min de lá.
145| // Corpo do 403 de conta suspensa, exportado para os pontos que checam a suspensão FORA do
146| // middleware (aceites, onde a decisão depende da action) não reescreverem o texto por conta
147| // própria e acabarem divergindo dele.
148| const corpoContaSuspensa = ({ suspenso_em, suspenso_motivo }) => ({
149|   erro: suspenso_motivo
150|     ? `Conta suspensa por ${suspenso_motivo}. Você não pode pegar novos trabalhos. Fale com o suporte para regularizar.`
151|     : 'Conta suspensa. Você não pode pegar novos trabalhos. Fale com o suporte para regularizar.',
152|   codigo: 'CONTA_SUSPENSA',
153|   suspenso_em,
154| })
155| 
156| const exigirNaoSuspenso = (req, res, next) => {
157|   if (req.usuario.role === 'admin' || req.usuario.role === 'aprovador') return next()
158|   if (req.usuario.suspenso_em) {
159|     return res.status(403).json(corpoContaSuspensa(req.usuario))
160|   }
161|   next()
162| }
163| 
164| const exigirAdmin = (req, res, next) => {
165|   if (!['admin', 'aprovador'].includes(req.usuario.role)) {
166|     return res.status(403).json({ erro: 'Acesso negado' })
167|   }
168|   next()
169| }
170| 
171| const exigirSuperAdmin = (req, res, next) => {
172|   if (req.usuario.role !== 'admin') {
173|     return res.status(403).json({ erro: 'Acesso restrito ao administrador' })
174|   }
175|   next()
176| }
177| 
178| module.exports = { autenticar, exigirAssinaturaAtiva, exigirNaoSuspenso, corpoContaSuspensa, exigirAdmin, exigirSuperAdmin, invalidarCacheAssinatura, assinaturaAtivaCacheada }
```

### src/routes/index.js:974-1136 — invalidarCachesUsuario, exigirPrestador (assinatura), exigirTipoPrestador/exigirPintor/exigirReparador, estaSuspenso, limite de demandas por dono

```js
 974| const invalidarCachesUsuario = (id) => {
 975|   invalidarCacheAssinatura(id)
 976| }
 977| 
 978| // Rate limit para /auth/verificar-disponibilidade (30 req / 60s por IP)
 979| const cacheVerifRate = new Map()
 980| const VERIF_LIMIT = 30
 981| const VERIF_WINDOW = 60 * 1000
 982| 
 983| const exigirPrestador = async (req, res, next) => {
 984|   try {
 985|     if (req.usuario.role !== 'prestador' && req.usuario.role !== 'admin') {
 986|       return res.status(403).json({ erro: 'Acesso restrito a prestadores de serviços domésticos' })
 987|     }
 988|     if (req.usuario.role === 'admin') return next()
 989| 
 990|     // Lê pelo cache COMPARTILHADO de middlewares/auth: é a mesma consulta e o mesmo predicado
 991|     // que exigirAssinaturaAtiva usa. A mensagem do 403 segue a daqui ("serviços"), diferente
 992|     // da de lá ("obras") — só a fonte da resposta foi unificada.
 993|     const ativa = await assinaturaAtivaCacheada(req.usuario.id)
 994|     if (!ativa) return res.status(403).json({ erro: 'Assinatura inativa. Renove seu plano para acessar os serviços.' })
 995|     next()
 996|   } catch (err) {
 997|     res.status(500).json({ erro: 'Erro de autenticação' })
 998|   }
 999| }
1000| 
1001| // Enforça o TIER do prestador no servidor (não só na UI): pintor/construtor
1002| // (tipo_prestador='pintor') só participa de OBRAS; reparador só participa de
1003| // REPAROS. Antes, nenhum feed/ação filtrava por tipo_prestador — a separação
1004| // existia só no app, então um pintor via reparos e um reparador via obras.
1005| // tipo_prestador vem em req.usuario (carregado no autenticar). admin/aprovador
1006| // passam (painel/moderação). Qualquer outro tier — inclusive prestador com
1007| // tipo_prestador NULL (legado) — falha FECHADO com 403, nunca vaza o feed errado.
1008| const exigirTipoPrestador = (tipoEsperado, msg) => (req, res, next) => {
1009|   if (req.usuario.role === 'admin' || req.usuario.role === 'aprovador') return next()
1010|   if (req.usuario.role !== 'prestador' || req.usuario.tipo_prestador !== tipoEsperado) {
1011|     return res.status(403).json({ erro: msg, codigo: 'TIER_INCORRETO' })
1012|   }
1013|   next()
1014| }
1015| // Verificar cada tier explicitamente (regra do projeto: um não replica o outro).
1016| const exigirPintor    = exigirTipoPrestador('pintor',    'Este recurso é exclusivo para prestadores de construção/pintura (obras).')
1017| const exigirReparador = exigirTipoPrestador('reparador', 'Este recurso é exclusivo para prestadores de serviços domésticos.')
1018| 
1019| // Rede de segurança de coordenadas na criação — simétrica ao `uf || ufDeCidade(cidade)`.
1020| // O app geocodifica no cliente (ViaCEP -> Nominatim) e isso falha em silêncio: CEP sem
1021| // logradouro, Nominatim sem resultado ou fora do ar. Uma demanda sem lat/lng nasce invisível
1022| // ao filtro por raio, ao cron de proximidade e ao rótulo de distância — então o centro do
1023| // município é o PISO, nunca a preferência.
1024| //   cliente mandou as duas  -> usa as do cliente          (origem 'cliente',       rua)
1025| //   cliente omitiu          -> centro do município        (origem 'centro_cidade', cidade)
1026| //   município não resolvido -> NULL + aviso, MAS CRIA     (origem NULL)
1027| // Nunca rejeita a criação: perder uma demanda real é pior que uma coordenada imprecisa.
1028| const resolverCoordenadas = (cidade, uf, latitude, longitude, rotulo) => {
1029|   if (latitude !== undefined && latitude !== null && longitude !== undefined && longitude !== null) {
1030|     return { lat: latitude, lng: longitude, origem: 'cliente' }
1031|   }
1032|   const centro = coordsDeCidade(cidade, uf)
1033|   if (centro) return { lat: centro.lat, lng: centro.lng, origem: 'centro_cidade' }
1034|   console.warn(`${rotulo} sem coordenadas do cliente e municipio nao resolvido — criando sem lat/lng | cidade=${cidade} uf=${uf}`)
1035|   return { lat: null, lng: null, origem: null }
1036| }
1037| 
1038| // Suspensão do OUTRO lado: nos aceites quem chama é o dono, então o middleware
1039| // exigirNaoSuspenso (que olha req.usuario) não serve — é preciso consultar o profissional
1040| // pelo id. Vai direto ao banco, sem o cache de 5 min de autenticar, porque um aceite é
1041| // irreversível: casa o profissional e dispara contrato.
1042| // Devolve a LINHA de suspensão (para compor a mensagem com o motivo) ou null. Truthy/falsy,
1043| // então serve tanto para `if (await estaSuspenso(x))` quanto para quem precisa do motivo.
1044| const estaSuspenso = async (usuarioId) => {
1045|   if (!usuarioId) return null
1046|   const r = await pool.query(`SELECT suspenso_em, suspenso_motivo FROM usuarios WHERE id = $1`, [usuarioId])
1047|   return r.rows[0]?.suspenso_em ? r.rows[0] : null
1048| }
1049| 
1050| const ERRO_ACEITE_SUSPENSO = {
1051|   erro: 'Este profissional está com a conta suspensa e não pode assumir novos trabalhos. Escolha outro candidato.',
1052|   codigo: 'PROFISSIONAL_SUSPENSO',
1053| }
1054| 
1055| // Teto de demandas SIMULTÂNEAS para dono que nunca concluiu nada. Quem já encerrou pelo menos
1056| // uma demanda (obra ou reparo) não tem teto — o limite existe só para conta nova que despeja
1057| // demandas sem nunca fechar nenhuma.
1058| // O teto EFETIVO vem de configuracoes ('limite_demandas_live_sem_historico', ver
1059| // lerLimiteDemandas); esta constante é só o padrão de fallback.
1060| const LIMITE_DEMANDAS_LIVE_SEM_HISTORICO = 5
1061| 
1062| // Teto efetivo, lido da tabela configuracoes a cada checagem (sem cache, como as demais
1063| // chaves). Cai no padrão quando a linha não existe ou o valor não é inteiro positivo
1064| // ('', 'abc', '0', '2.5', NULL): um teto NaN nunca dispararia (toda comparação com NaN é
1065| // falsa, liberando cadastro sem limite) e um teto 0 travaria qualquer dono sem histórico.
1066| const lerLimiteDemandas = async () => {
1067|   const r = await pool.query(`SELECT valor FROM configuracoes WHERE chave = 'limite_demandas_live_sem_historico'`)
1068|   const n = Number(r.rows[0]?.valor)
1069|   return Number.isInteger(n) && n > 0 ? n : LIMITE_DEMANDAS_LIVE_SEM_HISTORICO
1070| }
1071| 
1072| // "Live" = o que ocupa vaga agora:
1073| //   obras   → 'rascunho' (enviada, aguardando aprovação, ainda pode virar 'aberta')
1074| //             + 'aberta' aprovada e dentro do expira_em
1075| //   reparos → 'aberta' aprovada e dentro do expira_em (reparo não tem 'rascunho': nasce
1076| //             'aberta'/'aprovada', ver POST /reparos/dono)
1077| // expira_em > NOW() é obrigatório: expirada NÃO é status no banco — a linha continua 'aberta'
1078| // para sempre (ver comentário em /obras/admin), então contar só por status inflaria o teto e
1079| // travaria o dono permanentemente na primeira vez que duas demandas vencessem sem match.
1080| // O guard vale para os DOIS braços de obra: 'rascunho' também fica nesse status para sempre
1081| // (nenhum job mexe em obra pendente de aprovação), então sem ele uma obra enviada e nunca
1082| // analisada ocupava uma vaga do dono INDEFINIDAMENTE. Por isso ele saiu de dentro do braço
1083| // 'aberta' e subiu para o WHERE — mesma condição, agora aplicada aos dois casos.
1084| //
1085| // `tabela` é literal do call site ('obras' | 'reparos'), NUNCA vem do request — a interpolação
1086| // no SQL não é superfície de injeção.
1087| // Devolve { atingido, limite }: o teto efetivo acompanha a resposta para o 409 poder ecoá-lo
1088| // sem reler a configuração.
1089| const limiteDemandasAtingido = async (tabela, donoId, clientRequestId) => {
1090|   const limite = await lerLimiteDemandas()
1091|   // Retry com chave já gravada: pula o teto inteiro. Sem isso, o dono que bate no limite com a
1092|   // 2ª demanda e sofre timeout na resposta receberia 409 no retry — a demanda existe, mas o app
1093|   // mostraria erro. O ON CONFLICT do INSERT devolve a linha original; o teto não pode interferir.
1094|   if (clientRequestId) {
1095|     const jaExiste = await pool.query(
1096|       `SELECT 1 FROM ${tabela} WHERE criado_por = $1 AND client_request_id = $2 LIMIT 1`,
1097|       [donoId, clientRequestId]
1098|     )
1099|     if (jaExiste.rowCount > 0) return { atingido: false, limite }
1100|   }
1101|   const c = await pool.query(
1102|     `SELECT
1103|        (SELECT COUNT(*) FROM obras   WHERE criado_por = $1 AND status = 'encerrada')
1104|        + (SELECT COUNT(*) FROM reparos WHERE criado_por = $1 AND status = 'encerrada') AS encerradas,
1105|        (SELECT COUNT(*) FROM obras WHERE criado_por = $1
1106|           AND expira_em > NOW()
1107|           AND (status = 'rascunho'
1108|                OR (status = 'aberta' AND status_aprovacao = 'aprovada')))
1109|        + (SELECT COUNT(*) FROM reparos WHERE criado_por = $1
1110|             AND status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()) AS live`,
1111|     [donoId]
1112|   )
1113|   // COUNT() volta como string (bigint no pg) — sem Number() o >= compararia texto.
1114|   const encerradas = Number(c.rows[0].encerradas)
1115|   const live       = Number(c.rows[0].live)
1116|   return { atingido: encerradas === 0 && live >= limite, limite }
1117| }
1118| 
1119| // Payload do 409 — montado com o teto EFETIVO da checagem (antes era um objeto fixo, possível
1120| // só enquanto o teto era constante).
1121| // A saída pelo cancelamento entra no texto porque ela JÁ existe (DELETE /obras/dono/:id e
1122| // DELETE /reparos/dono/:id não exigem status nenhum, então valem inclusive para obra ainda
1123| // aguardando aprovação) — só não estava em lugar nenhum que o dono pudesse ler. Sem isso ele
1124| // via "você já tem N ativas" sem saber quais nem como liberar vaga.
1125| const erroLimiteDemandas = (limite) => ({
1126|   erro: `Você já tem ${limite} demandas ativas e nenhuma concluída. `
1127|       + `Conclua ou aguarde o encerramento de uma delas para publicar outra. `
1128|       + `Obras aguardando aprovação também ocupam vaga: cancelar uma delas em "Minhas obras" libera a vaga na hora.`,
1129|   codigo: 'LIMITE_DEMANDAS_ATIVAS',
1130|   limite_demandas_ativas: limite,
1131| })
1132| 
1133| // ============================================================
1134| // STATS PÚBLICOS (sem auth)
1135| // ============================================================
1136| // Cache de processo (valor único) para o payload público. Este endpoint é batido a
```

### src/controllers/authController.js:1-33 — gerarToken (payload, validade 7d/30d, token_version)

```js
 1| const bcrypt = require('bcrypt')
 2| const jwt = require('jsonwebtoken')
 3| const { pool } = require('../utils/supabase')
 4| const { invalidarCacheAssinatura } = require('../middlewares/auth')
 5| const { registrarTentativa, limparTentativas } = require('../utils/tentativasAuth')
 6| const { MARCA } = require('../utils/marca')
 7| const { validarEspecialidades } = require('../utils/especialidades')
 8| const nodemailer = require('nodemailer')
 9| const crypto = require('crypto')
10| 
11| // Hash de comparação para e-mail SEM conta no login — nivela o tempo de resposta dos dois
12| // caminhos (ver o uso em `login`). Gerado uma única vez a partir de 32 bytes aleatórios, com
13| // custo 10 (o mesmo de bcrypt.hash(senha, 10) do cadastro). Não é segredo: é um hash de valor
14| // descartado, nenhuma senha real se compara a ele e nada além do TEMPO depende dele.
15| const HASH_FICTICIO = '$2b$10$TurXFLIbHVFyg7b3h/.ame16E9jSv4PmsB5G47xyqYPM1rXeqDSda'
16| 
17| const gerarToken = (usuario) => jwt.sign(
18|   { id: usuario.id, role: usuario.role, tv: usuario.token_version ?? 1 },
19|   process.env.JWT_SECRET,
20|   { expiresIn: usuario.role === 'admin' ? '30d' : (process.env.JWT_EXPIRES_IN || '7d') }
21| )
22| 
23| const transporter = nodemailer.createTransport({
24|   host: process.env.SMTP_HOST,
25|   port: 587,
26|   secure: false,
27|   auth: {
28|     user: process.env.SMTP_USER,
29|     pass: process.env.SMTP_PASS
30|   }
31| })
32| 
33| const cadastrar = async (req, res) => {
```

### src/controllers/authController.js:33-279 — cadastrar: papéis, tipo_dono/tipo_prestador, verificacao_status, assinatura de lançamento

```js
 33| const cadastrar = async (req, res) => {
 34|   const ts = new Date().toISOString()
 35|   let client
 36|   try {
 37|     const { nome, email, telefone, senha, cidade, uf,
 38|             especialidades, anos_experiencia, tamanho_equipe,
 39|             cpf_cnpj, tipo_conta, plano, pix_reembolso, referencias,
 40|             verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url,
 41|             rg, rg_orgao, rg_estado, cep, latitude, longitude,
 42|             logradouro, numero, complemento, bairro } = req.body
 43| 
 44|     // PRESENÇA, nunca o valor: email e cpf_cnpj saíam em claro para o stdout e ficavam
 45|     // retidos no log da Railway. Mesmo estilo booleano já usado no log de campos obrigatórios
 46|     // logo abaixo — o diagnóstico ("veio email?", "veio documento?") é preservado.
 47|     console.log(`[CADASTRO][${ts}] ▶ inicio | tipo_conta=${tipo_conta} tem_email=${!!email} tem_cpf_cnpj=${!!cpf_cnpj} plano=${plano} tem_doc_frente=${!!verificacao_doc_frente_url} tem_doc_verso=${!!verificacao_doc_verso_url} tem_selfie=${!!verificacao_selfie_url}`)
 48| 
 49|     if (!nome || !email || !senha) {
 50|       console.log(`[CADASTRO][${ts}] ✗ 400 campos obrigatorios ausentes | nome=${!!nome} email=${!!email} senha=${!!senha}`)
 51|       return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' })
 52|     }
 53|     if (senha.length < 8) {
 54|       console.log(`[CADASTRO][${ts}] ✗ 400 senha curta | len=${senha.length}`)
 55|       return res.status(400).json({ erro: 'A senha deve ter pelo menos 8 caracteres' })
 56|     }
 57|     if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
 58|       console.log(`[CADASTRO][${ts}] ✗ 400 email invalido | tem_email=${!!email}`)
 59|       return res.status(400).json({ erro: 'E-mail inválido' })
 60|     }
 61| 
 62|     const emailNormalizado = email.toLowerCase().trim()
 63| 
 64|     // Hash FORA da transação: o bcrypt nativo roda na threadpool do libuv (não
 65|     // bloqueia o event loop), então não seguramos uma conexão/lock do Postgres
 66|     // durante o custo de CPU do hash — a transação abaixo fica curta.
 67|     console.log(`[CADASTRO][${ts}] ▶ gerando hash de senha`)
 68|     const senha_hash = await bcrypt.hash(senha, 10)
 69|     console.log(`[CADASTRO][${ts}] ✓ senha hash gerada`)
 70| 
 71|     let role = 'assinante'
 72|     if (tipo_conta === 'dono_obra') role = 'dono_obra'
 73|     else if (tipo_conta === 'prestador' || tipo_conta === 'pintor' || tipo_conta === 'construtor') role = 'prestador'
 74| 
 75|     // Validação do vocabulário FECHADO de especialidades (utils/especialidades). Roda aqui,
 76|     // depois de role estar resolvido, porque o mínimo de 1 só vale para profissional — dono
 77|     // não presta serviço e entra com lista vazia, que segue válida.
 78|     // Campo ausente vira [] (mesmo default de antes), então dono que não manda nada continua
 79|     // passando; profissional que não manda nada agora recebe 400, que é o ponto do fechamento.
 80|     const espCadastro = validarEspecialidades(especialidades || [], role === 'prestador')
 81|     if (espCadastro.erro) {
 82|       console.log(`[CADASTRO][${ts}] ✗ 400 especialidades | motivo=${espCadastro.erro}`)
 83|       return res.status(400).json({ erro: espCadastro.erro })
 84|     }
 85| 
 86|     // Define tipo_dono para distinguir donos de pintura vs reparo
 87|     let tipo_dono = null
 88|     if (tipo_conta === 'dono_obra') tipo_dono = 'pintura'
 89|     else if (tipo_conta === 'dono_reparo') { role = 'dono_obra'; tipo_dono = 'reparo' }
 90| 
 91|     // Define tipo_prestador para distinguir pintores/construtores de reparadores
 92|     let tipo_prestador = null
 93|     if (tipo_conta === 'pintor' || tipo_conta === 'construtor') tipo_prestador = 'pintor'
 94|     else if (tipo_conta === 'prestador') tipo_prestador = 'reparador'
 95| 
 96|     const verificacaoStatus = role === 'prestador' ? 'pendente' : 'nao_solicitada'
 97|     const planoEscolhido = plano || 'mensal'
 98| 
 99|     // Janela de lançamento: prestador entra SEM pagar mas AINDA aguarda aprovação
100|     // do admin (idoneidade nunca é pulada). A janela só remove o paywall — a fila de
101|     // aprovação continua. "gratuito não expira" é gravado no tipo da linha, não na
102|     // janela, então continua correto mesmo depois que a janela for desligada.
103|     // Config em banco (chave='lancamento_data_fim'): admin liga/desliga/estende pelo
104|     // painel, sem mexer no Railway. Lido no MESMO client da transação abaixo.
105| 
106|     // Transação única: o INSERT em usuarios e o INSERT em assinaturas commitam
107|     // JUNTOS ou nada. Antes, cada pool.query fazia autocommit isolado — se a
108|     // resposta se perdesse (timeout/rede) após o INSERT em usuarios já commitado,
109|     // o usuário ficava meio-criado e todo retry virava um 409 legítimo ("CPF só
110|     // no fim"). Agora, qualquer falha antes do COMMIT desfaz tudo → o retry é limpo.
111|     client = await pool.connect()
112|     await client.query('BEGIN')
113| 
114|     // Lê a janela de lançamento no MESMO client (snapshot consistente da transação).
115|     // gratuito só vale se há data_fim futura; NULL/vazio ou passado = janela desligada.
116|     const cfgLancamento = await client.query(`SELECT valor FROM configuracoes WHERE chave = 'lancamento_data_fim'`)
117|     const dataFimLancamento = cfgLancamento.rows[0]?.valor || null
118|     const lancamentoGratis = !!dataFimLancamento && new Date(dataFimLancamento) > new Date()
119| 
120|     // Pré-checagens amigáveis DENTRO da transação (mensagem limpa). Em corrida
121|     // real, o índice único (email + cpf_cnpj normalizado) é a garantia final e
122|     // cai no handler de 23505 abaixo.
123|     console.log(`[CADASTRO][${ts}] ▶ verificando email no banco | email=${emailNormalizado}`)
124|     const existente = await client.query('SELECT id FROM usuarios WHERE email = $1', [emailNormalizado])
125|     if (existente.rows.length > 0) {
126|       await client.query('ROLLBACK')
127|       console.log(`[CADASTRO][${ts}] ✗ 409 email duplicado | email=${emailNormalizado}`)
128|       return res.status(409).json({ erro: 'Este e-mail já está cadastrado.', codigo: 'email_duplicado' })
129|     }
130|     console.log(`[CADASTRO][${ts}] ✓ email disponivel`)
131| 
132|     if (cpf_cnpj) {
133|       const cpfLimpo = cpf_cnpj.replace(/\D/g, '')
134|       // cpfLimpo NÃO entra no log: é CPF/CNPJ em claro. O marcador de etapa basta.
135|       console.log(`[CADASTRO][${ts}] ▶ verificando cpf_cnpj no banco`)
136|       const cpfExistente = await client.query(
137|         `SELECT id FROM usuarios WHERE regexp_replace(cpf_cnpj, '[^0-9]', '', 'g') = $1`,
138|         [cpfLimpo]
139|       )
140|       if (cpfExistente.rows.length > 0) {
141|         await client.query('ROLLBACK')
142|         console.log(`[CADASTRO][${ts}] ✗ 409 cpf_cnpj duplicado`)
143|         return res.status(409).json({ erro: 'Este CPF/CNPJ já está cadastrado.', codigo: 'cpf_duplicado' })
144|       }
145|       console.log(`[CADASTRO][${ts}] ✓ cpf_cnpj disponivel`)
146|     }
147| 
148|     console.log(`[CADASTRO][${ts}] ▶ INSERT usuarios | role=${role} tipo_dono=${tipo_dono} tipo_prestador=${tipo_prestador} verificacao_status=${verificacaoStatus}`)
149|     const result = await client.query(
150|       `INSERT INTO usuarios (nome, email, telefone, senha_hash, cidade, uf,
151|         especialidades, anos_experiencia, tamanho_equipe, cpf_cnpj, role, ativo,
152|         tipo_dono, pix_reembolso, referencias,
153|         verificacao_doc_frente_url, verificacao_doc_verso_url, verificacao_selfie_url,
154|         verificacao_status, rg, rg_orgao, rg_estado, tipo_prestador, cep, latitude, longitude,
155|         logradouro, numero, complemento, bairro)
156|        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
157|        RETURNING id, nome, email, telefone, cidade, role, tipo_dono, tipo_prestador, foto_url`,
158|       [nome.trim(), emailNormalizado, telefone, senha_hash, cidade, uf || null,
159|        espCadastro.valor, anos_experiencia || 0,
160|        tamanho_equipe || 1, cpf_cnpj, role,
161|        tipo_dono,
162|        pix_reembolso || null,
163|        JSON.stringify(referencias || []),
164|        verificacao_doc_frente_url || null,
165|        verificacao_doc_verso_url || null,
166|        verificacao_selfie_url || null,
167|        verificacaoStatus,
168|        rg || null, rg_orgao || null, rg_estado || null,
169|        tipo_prestador,
170|        cep || null, latitude ?? null, longitude ?? null,
171|        logradouro || null, numero || null, complemento || null, bairro || null]
172|     )
173| 
174|     const usuario = result.rows[0]
175|     console.log(`[CADASTRO][${ts}] ✓ usuario criado | id=${usuario.id} role=${usuario.role} tipo_prestador=${usuario.tipo_prestador}`)
176| 
177|     if (role === 'dono_obra') {
178|       console.log(`[CADASTRO][${ts}] ▶ INSERT assinatura gratuita | usuario_id=${usuario.id}`)
179|       await client.query(
180|         `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo)
181|          VALUES ($1, 'mensal', 0, 'ativa', 'gratuito')`,
182|         [usuario.id]
183|       )
184|       console.log(`[CADASTRO][${ts}] ✓ assinatura gratuita criada`)
185|     } else if (role === 'prestador') {
186|       const valorMensal = tipo_prestador === 'pintor'
187|         ? (planoEscolhido === 'anual' ? 999.00 : 99.90)
188|         : (planoEscolhido === 'anual' ? 499.00 : 49.90)
189|       if (lancamentoGratis) {
190|         // Janela de lançamento: sem paywall, MAS ainda aguarda aprovação do admin.
191|         // status='pendente_verificacao' → app mostra tela de verificação (não libera).
192|         // tipo='gratuito' → a aprovação deixa proximo_vencimento NULL (nunca expira).
193|         // valor_mensal REAL (49.90/99.90) é preservado para uma conversão paga futura.
194|         // proximo_vencimento OMITIDO → NULL. verificacao_status continua 'pendente'.
195|         console.log(`[CADASTRO][${ts}] ▶ INSERT assinatura prestador GRATIS (lançamento) | usuario_id=${usuario.id} plano=${planoEscolhido} valor=${valorMensal}`)
196|         await client.query(
197|           `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo)
198|            VALUES ($1, $2, $3, 'pendente_verificacao', 'gratuito')`,
199|           [usuario.id, planoEscolhido, valorMensal]
200|         )
201|         console.log(`[CADASTRO][${ts}] ✓ assinatura pendente_verificacao gratuita criada | valor=${valorMensal}`)
202|       } else {
203|         console.log(`[CADASTRO][${ts}] ▶ INSERT assinatura prestador | usuario_id=${usuario.id} plano=${planoEscolhido} valor=${valorMensal}`)
204|         await client.query(
205|           `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status)
206|            VALUES ($1, $2, $3, 'pendente')`,
207|           [usuario.id, planoEscolhido, valorMensal]
208|         )
209|         console.log(`[CADASTRO][${ts}] ✓ assinatura pendente criada | valor=${valorMensal}`)
210|       }
211|     } else {
212|       const valorMensal = planoEscolhido === 'anual' ? 999.00 : 99.90
213|       console.log(`[CADASTRO][${ts}] ▶ INSERT assinatura assinante | usuario_id=${usuario.id} plano=${planoEscolhido} valor=${valorMensal}`)
214|       await client.query(
215|         `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status)
216|          VALUES ($1, $2, $3, 'pendente')`,
217|         [usuario.id, planoEscolhido, valorMensal]
218|       )
219|       console.log(`[CADASTRO][${ts}] ✓ assinatura pendente criada | valor=${valorMensal}`)
220|     }
221| 
222|     const assinaturaResult = await client.query(
223|       `SELECT status, tipo, plano, proximo_vencimento, valor_mensal FROM assinaturas WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
224|       [usuario.id]
225|     )
226|     const assinatura = assinaturaResult.rows[0] || null
227| 
228|     await client.query('COMMIT')
229| 
230|     const token = gerarToken(usuario)
231|     console.log(`[CADASTRO][${ts}] ✓ commit ok — token gerado | usuario_id=${usuario.id} — respondendo 201`)
232|     res.status(201).json({ usuario, token, assinatura })
233| 
234|     // E-mails especiais de teste — aprovação automática imediata (configurar via EMAILS_ESPECIAIS no Railway)
235|     const emailsEspeciais = (process.env.EMAILS_ESPECIAIS || '')
236|       .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
237|     if (emailsEspeciais.length > 0 && emailsEspeciais.includes(emailNormalizado)) {
238|       setImmediate(async () => {
239|         try {
240|           await pool.query(`UPDATE usuarios SET verificacao_status = 'aprovado', aprovado_automaticamente = true WHERE id = $1`, [usuario.id])
241|           await pool.query(`UPDATE assinaturas SET status = 'ativa', tipo = 'gratuito', atualizado_em = NOW() WHERE usuario_id = $1`, [usuario.id])
242|           console.log(`[Acesso especial] ${emailNormalizado} aprovado automaticamente`)
243|         } catch (err) {
244|           console.error('Erro ao aprovar e-mail especial:', err)
245|         }
246|       })
247|     }
248| 
249|     setImmediate(async () => {
250|       try {
251|         const { enviarBoasVindas } = require('../services/alertaService')
252|         await enviarBoasVindas(usuario.id)
253|       } catch (err) {
254|         console.error('Erro ao enviar boas-vindas:', err)
255|       }
256|     })
257| 
258|   } catch (err) {
259|     if (client) await client.query('ROLLBACK').catch(() => {})
260|     const ts2 = new Date().toISOString()
261|     // 23505 = unique_violation. Agora COBRE de fato o CPF: o índice único no
262|     // cpf_cnpj normalizado existe (migração em routes/index.js) e seu nome contém
263|     // "cpf", então a corrida real cai aqui e vira um 409 limpo em vez de 500.
264|     if (err.code === '23505') {
265|       console.error(`[CADASTRO][${ts2}] ✗ 409 unicidade BD | constraint=${err.constraint} | msg=${err.message}`)
266|       // `codigo` é a chave ESTÁVEL que o app usa p/ classificar sem depender do texto
267|       // em português. `erro` continua sendo a mensagem humana (retrocompatível).
268|       if (err.constraint?.includes('cpf')) return res.status(409).json({ erro: 'Este CPF/CNPJ já está cadastrado.', codigo: 'cpf_duplicado' })
269|       if (err.constraint?.includes('email')) return res.status(409).json({ erro: 'Este e-mail já está cadastrado.', codigo: 'email_duplicado' })
270|       return res.status(409).json({ erro: 'Dados já cadastrados. Verifique seu e-mail e CPF/CNPJ.', codigo: 'dados_duplicados' })
271|     }
272|     console.error(`[CADASTRO][${ts2}] ✗ ERRO INTERNO | msg="${err.message}" | code=${err.code}\n${err.stack}`)
273|     res.status(500).json({ erro: err.message || 'Erro ao criar conta' })
274|   } finally {
275|     if (client) client.release()
276|   }
277| }
278| 
279| const login = async (req, res) => {
```

### src/controllers/authController.js:279-383 — login: senha, 2FA do admin, token

```js
279| const login = async (req, res) => {
280|   try {
281|     const { email, senha } = req.body
282| 
283|     if (!email || !senha) {
284|       return res.status(400).json({ erro: 'E-mail e senha são obrigatórios' })
285|     }
286| 
287|     const emailNormalizado = email.toLowerCase().trim()
288| 
289|     // Contador por identidade ANTES de qualquer consulta e ANTES do bcrypt: identidade
290|     // trancada nem chega a queimar ~100ms de hash. Vale para e-mail inexistente também —
291|     // é isso que faz o 429 explícito não denunciar quais contas existem.
292|     const tentativa = await registrarTentativa('login', emailNormalizado)
293|     if (tentativa.excedeu) {
294|       return res.status(429).json({
295|         erro: `Muitas tentativas de login. Tente novamente em ${Math.ceil(tentativa.segundosRestantes / 60)} minuto(s), ou redefina sua senha.`,
296|         codigo: 'MUITAS_TENTATIVAS',
297|         retry_apos_segundos: tentativa.segundosRestantes,
298|       })
299|     }
300| 
301|     const result = await pool.query(
302|       'SELECT id, nome, email, telefone, cidade, role, senha_hash, ativo, foto_url, tipo_dono, tipo_prestador, boas_vindas_exibida, token_version FROM usuarios WHERE email = $1',
303|       [emailNormalizado]
304|     )
305| 
306|     if (result.rows.length === 0) {
307|       // E-mail sem conta: compara contra um hash FICTÍCIO em vez de sair na hora. O retorno
308|       // antecipado fazia o caminho "não existe" responder em ~1ms e o "existe" em ~65ms (custo
309|       // do bcrypt), e essa diferença sozinha já dizia quais e-mails estão cadastrados.
310|       // Agora os dois pagam o mesmo trabalho. O resultado é descartado de propósito — sempre
311|       // false, porque o hash vem de 32 bytes aleatórios que nenhuma senha submetida reproduz.
312|       // Custo 10, o mesmo de bcrypt.hash(senha, 10) usado no cadastro: com custo menor a
313|       // diferença de tempo voltaria.
314|       await bcrypt.compare(senha, HASH_FICTICIO)
315|       return res.status(401).json({ erro: 'E-mail ou senha incorretos' })
316|     }
317| 
318|     const usuario = result.rows[0]
319| 
320|     if (!usuario.ativo) {
321|       return res.status(403).json({ erro: 'Conta desativada' })
322|     }
323| 
324|     const senhaValida = await bcrypt.compare(senha, usuario.senha_hash)
325|     if (!senhaValida) {
326|       return res.status(401).json({ erro: 'E-mail ou senha incorretos' })
327|     }
328| 
329|     // Senha conferiu: apaga a linha (some, não zera — mantém a tabela pequena). Limpa ANTES
330|     // do 2FA de propósito: este contador defende a SENHA, e ela acabou de ser provada. Um
331|     // eventual contador de 2FA seria um controle à parte.
332|     await limparTentativas('login', emailNormalizado)
333| 
334|     if (usuario.role === 'admin') {
335|       const tfaResult = await pool.query(
336|         `SELECT dois_fa_ativo, dois_fa_secret FROM usuarios WHERE id = $1`,
337|         [usuario.id]
338|       )
339|       const tfa = tfaResult.rows[0]
340|       if (tfa?.dois_fa_ativo && tfa?.dois_fa_secret) {
341|         const tempToken = jwt.sign(
342|           { id: usuario.id, role: usuario.role, tipo: '2fa_pendente' },
343|           process.env.JWT_SECRET,
344|           { expiresIn: '5m' }
345|         )
346|         return res.status(200).json({ requer_2fa: true, temp_token: tempToken })
347|       }
348|     }
349| 
350|     const assinaturaResult = await pool.query(
351|       `SELECT status, tipo, plano, proximo_vencimento, valor_mensal FROM assinaturas
352|        WHERE usuario_id = $1
353|        ORDER BY CASE status WHEN 'ativa' THEN 1 WHEN 'pendente' THEN 2 ELSE 3 END, criado_em DESC
354|        LIMIT 1`,
355|       [usuario.id]
356|     )
357| 
358|     const token = gerarToken(usuario)
359| 
360|     res.json({
361|       usuario: {
362|         id: usuario.id,
363|         nome: usuario.nome,
364|         email: usuario.email,
365|         telefone: usuario.telefone || null,
366|         cidade: usuario.cidade || null,
367|         role: usuario.role,
368|         foto_url: usuario.foto_url || null,
369|         tipo_dono: usuario.tipo_dono || null,
370|         tipo_prestador: usuario.tipo_prestador || null,
371|         boas_vindas_exibida: usuario.boas_vindas_exibida ?? false
372|       },
373|       assinatura: assinaturaResult.rows[0] || null,
374|       token
375|     })
376| 
377|   } catch (err) {
378|     console.error('Erro no login:', err)
379|     res.status(500).json({ erro: 'Erro ao fazer login' })
380|   }
381| }
382| 
383| const perfil = async (req, res) => {
```

### server.js:107-200 — Rate limits por rota, body parsers (raw p/ webhook), raiz /, handler de erro

```js
107| app.use((req, res, next) => {
108|   if (ROTAS_SEM_SHEDDING.has(req.path)) return next()
109|   if (pool.waitingCount < POOL_FILA_MAX) return next()
110|   // Log com a fila e o total: é o que separa "pool pequeno demais" de "um endpoint ficou
111|   // lento" na hora do incidente.
112|   console.warn(`[Shedding] 503 | ${req.method} ${req.originalUrl} | waitingCount=${pool.waitingCount} totalCount=${pool.totalCount} idleCount=${pool.idleCount}`)
113|   res.set('Retry-After', '1')
114|   return res.status(503).json({
115|     erro: 'Servidor ocupado. Tente novamente em instantes.',
116|     codigo: 'SOBRECARGA',
117|   })
118| })
119| 
120| app.use(rateLimit({
121|   windowMs: 15 * 60 * 1000,
122|   max: 300,
123|   standardHeaders: true,
124|   legacyHeaders: false,
125|   message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
126| }))
127| 
128| app.use('/api/auth/login',    rateLimit({
129|   windowMs: 15 * 60 * 1000, max: 10,
130|   message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
131| }))
132| // 20/h (era 5/h): usuários de celular saem por CGNAT do carrier — muitos aparelhos
133| // reais compartilham o mesmo IP público, então 5/h bloqueava gente legítima. O limite
134| // também era consumido pelos próprios retries que os timeouts de cadastro provocavam.
135| app.use('/api/auth/cadastro', rateLimit({
136|   windowMs: 60 * 60 * 1000, max: 20,
137|   message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
138| }))
139| 
140| // Rotas sensíveis que até aqui só tinham o balde global de 300/15min — teto alto demais
141| // para o que cada uma faz. Mesmo formato dos dois limiters acima (montados ANTES de
142| // app.use('/api', rotasApp), senão não interceptam nada) e mesmo corpo de erro do global.
143| // Sem limiter no webhook do PagBank de propósito: as retentativas do gateway não podem
144| // ser estranguladas — um 429 lá vira pagamento não confirmado.
145| // 20/h (era 5/h) — não autenticada e dispara e-mail de saída a cada chamada.
146| // 20 e não 5 pelo mesmo CGNAT do cadastro acima: 5/h barrava aparelhos legítimos no mesmo IP.
147| app.use('/api/auth/esqueci-senha', rateLimit({
148|   windowMs: 60 * 60 * 1000, max: 20,
149|   message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
150| }))
151| // 20/h — não autenticada e aceita upload de arquivo (documentos de verificação).
152| app.use('/api/auth/upload-verificacao', rateLimit({
153|   windowMs: 60 * 60 * 1000, max: 20,
154|   message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
155| }))
156| // 60/h — não autenticada e emite assinatura de upload do Cloudinary.
157| app.use('/api/upload/assinatura-publica', rateLimit({
158|   windowMs: 60 * 60 * 1000, max: 60,
159|   message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
160| }))
161| // 20/h — autenticada, mas abre cobrança no gateway a cada chamada.
162| app.use('/api/pagamentos/criar-assinatura', rateLimit({
163|   windowMs: 60 * 60 * 1000, max: 20,
164|   message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' }
165| }))
166| 
167| // Webhook PagBank precisa do corpo cru (bytes exatos) p/ validar a assinatura
168| // SHA-256. Escopado só a esta rota — não retém buffers crus no resto da API.
169| app.use('/api/pagamentos/webhook-pagbank', express.raw({ type: '*/*', limit: '1mb' }))
170| app.use(express.json({ limit: '100mb' }))
171| app.use(express.urlencoded({ extended: true, limit: '100mb' }))
172| app.use('/api', rotasApp)
173| 
174| // Health check
175| app.get('/', async (req, res) => {
176|   try {
177|     await pool.query('SELECT 1')
178|     res.json({
179|       api: `${MARCA} API`,
180|       versao: '1.0.0',
181|       status: 'online',
182|       banco: 'conectado',
183|       uptime: Math.floor(process.uptime()) + 's'
184|     })
185|   } catch (err) {
186|     res.status(503).json({
187|       api: `${MARCA} API`,
188|       status: 'degradado',
189|       banco: 'erro',
190|       detalhe: err.message
191|     })
192|   }
193| })
194| 
195| app.use((req, res) => {
196|   res.status(404).json({ erro: 'Rota não encontrada' })
197| })
198| 
199| app.use((err, req, res, next) => {
200|   console.error('Erro não tratado:', err.message)
```


## 2. Dinheiro — assinaturas, PagBank, janela de lançamento, acesso grátis, contratos

### src/controllers/pagamentoController.js:1-442 — Controller de pagamento inteiro: preços, ativarAssinatura, criarAssinatura (checkout PagBank), webhook (assinatura + valor), darAcessoGratuito, listarAssinantes

```js
  1| const crypto = require('crypto')
  2| const { pool } = require('../utils/supabase')
  3| const { enviarEmail } = require('../services/brevoService')
  4| const { MARCA } = require('../utils/marca')
  5| 
  6| const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN
  7| const PAGBANK_URL = 'https://api.pagseguro.com'
  8| const APP_URL = 'https://pinturapro-api-production.up.railway.app/api'
  9| 
 10| // Verificação de assinatura do webhook: LIGADA por padrão. Só um WEBHOOK_ENFORCE_SIGNATURE
 11| // explicitamente igual a 'false' desliga — qualquer outro valor (ou a ausência) enforça.
 12| const WEBHOOK_ENFORCE = process.env.WEBHOOK_ENFORCE_SIGNATURE !== 'false'
 13| 
 14| // Aviso ALTO de boot: enforce ligado sem PAGBANK_TOKEN significa que TODO evento — inclusive
 15| // pagamentos legítimos — será rejeitado, porque sem o segredo não há como verificar assinatura.
 16| // Nomeia as duas variáveis para o operador saber exatamente o que configurar antes de ligar
 17| // os pagamentos. (Hoje o livro de webhook está vazio, então isto não perde nada — é guardrail.)
 18| if (WEBHOOK_ENFORCE && !PAGBANK_TOKEN) {
 19|   console.warn('[webhook-pagbank][BOOT] ATENÇÃO: verificação de assinatura LIGADA (WEBHOOK_ENFORCE_SIGNATURE != "false") mas PAGBANK_TOKEN AUSENTE — todo evento de pagamento será REJEITADO até PAGBANK_TOKEN ser configurado. Configure PAGBANK_TOKEN antes de habilitar pagamentos, ou defina WEBHOOK_ENFORCE_SIGNATURE=false para desligar a verificação.')
 20| }
 21| 
 22| const limparCpfCnpj = (str) => {
 23|   if (!str) return null
 24|   return str.replace(/\D/g, '')
 25| }
 26| 
 27| // Tabela de preços da assinatura — FONTE ÚNICA, em centavos. Usada tanto para COBRAR
 28| // (criarAssinatura) quanto para VALIDAR o valor pago no webhook, para que os dois lados
 29| // nunca divirjam. Devolve null quando o tier não é mapeável (não dá para cobrar às cegas).
 30| //   prestador+reparador → 4.990 / 49.900   |   prestador+pintor → 9.990 / 99.900
 31| //   demais papéis (dono/assinante genérico) → 9.990 / 99.900
 32| const precoAssinaturaCentavos = (role, tipoPrestador, plano) => {
 33|   const anual = plano === 'anual'
 34|   if (role === 'prestador') {
 35|     if (tipoPrestador === 'reparador') return anual ? 49900 : 4990
 36|     if (tipoPrestador === 'pintor')    return anual ? 99900 : 9990
 37|     return null // tier não mapeado
 38|   }
 39|   return anual ? 99900 : 9990
 40| }
 41| 
 42| const ativarAssinatura = async (usuarioId, plano) => {
 43|   // Upsert atômico (Finding 4.1): evita check-then-insert race que duplicava assinaturas.
 44|   // proximo_vencimento SOMA o período a partir de GREATEST(vencimento_atual, NOW()) — é uma
 45|   // COMPRA, então renovar antes do vencimento empilha em vez de zerar (pagar no dia 20 de 30
 46|   // dá 40 dias, não 30). GREATEST também impede o retrocesso: o valor nunca anda para trás.
 47|   // Em PostgreSQL GREATEST IGNORA NULL, então linha sem vencimento cai em NOW() + período.
 48|   await pool.query(
 49|     `INSERT INTO assinaturas (usuario_id, plano, status, atualizado_em, proximo_vencimento)
 50|      VALUES ($1, $2, 'ativa', NOW(),
 51|        CASE WHEN $2 = 'anual' THEN NOW() + INTERVAL '365 days' ELSE NOW() + INTERVAL '30 days' END)
 52|      ON CONFLICT (usuario_id) DO UPDATE SET
 53|        status = 'ativa',
 54|        plano = EXCLUDED.plano,
 55|        atualizado_em = NOW(),
 56|        proximo_vencimento = GREATEST(assinaturas.proximo_vencimento, NOW())
 57|          + CASE WHEN EXCLUDED.plano = 'anual' THEN INTERVAL '365 days' ELSE INTERVAL '30 days' END,
 58|        marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL`,
 59|     [usuarioId, plano || 'mensal']
 60|   )
 61| }
 62| 
 63| // Coloca prestador como pendente de verificação após pagamento
 64| const colocarPendentVerificacao = async (usuarioId, plano) => {
 65|   // Registra assinatura como paga mas acesso ainda pendente verificação (upsert atômico — Finding 4.1)
 66|   await pool.query(
 67|     `INSERT INTO assinaturas (usuario_id, plano, status, atualizado_em)
 68|      VALUES ($1, $2, 'pendente_verificacao', NOW())
 69|      ON CONFLICT (usuario_id) DO UPDATE SET
 70|        status = 'pendente_verificacao',
 71|        plano = EXCLUDED.plano,
 72|        atualizado_em = NOW()`,
 73|     [usuarioId, plano || 'mensal']
 74|   )
 75| 
 76|   // Atualiza status de verificação do usuário
 77|   await pool.query(
 78|     `UPDATE usuarios SET verificacao_status = 'pendente' WHERE id = $1 AND verificacao_status = 'nao_solicitada'`,
 79|     [usuarioId]
 80|   )
 81| 
 82|   // Busca dados do prestador para notificar
 83|   const usuario = await pool.query(
 84|     `SELECT nome, email, tipo_prestador, tipo_dono FROM usuarios WHERE id = $1`, [usuarioId]
 85|   )
 86|   if (usuario.rows.length === 0) return
 87| 
 88|   const { nome, email } = usuario.rows[0]
 89| 
 90|   enviarEmail({
 91|     para: email,
 92|     remetenteNome: MARCA,
 93|     assunto: `${MARCA} — Pagamento recebido! Verificação em andamento`,
 94|     html: `
 95|       <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
 96|         <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
 97|           <h1 style="color: #0a0a0a; margin: 0;">${MARCA}</h1>
 98|         </div>
 99|         <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
100|           <h2>Olá, ${nome}! 🎉</h2>
101|           <p>Seu pagamento foi recebido com sucesso!</p>
102|           <p style="background: #fff3cd; padding: 16px; border-radius: 8px; border-left: 4px solid #E8833A;">
103|             <strong>Seus dados estão sendo verificados.</strong><br>
104|             Em até <strong>1 hora</strong> você receberá a confirmação por e-mail e terá acesso completo ao ${MARCA}.
105|           </p>
106|           <p>Este processo é necessário para garantir a segurança de todos os usuários da plataforma.</p>
107|           <p><strong>Equipe ${MARCA}</strong></p>
108|         </div>
109|       </div>
110|     `
111|   }).catch(err => console.error('Erro ao enviar e-mail verificação:', err))
112| 
113|   const adminEmail = process.env.EMAIL_REMETENTE?.match(/^(.+?)\s*<(.+?)>$/)?.[2]
114|     || process.env.EMAIL_REMETENTE
115|     || '[e-mail redigido]'
116| 
117|   enviarEmail({
118|     para: adminEmail,
119|     assunto: `⚠️ Novo prestador aguardando verificação: ${nome}`,
120|     html: `
121|       <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px;">
122|         <h2>Novo prestador para verificar</h2>
123|         <p><strong>Nome:</strong> ${nome}</p>
124|         <p><strong>E-mail:</strong> ${email}</p>
125|         <p><strong>ID:</strong> ${usuarioId}</p>
126|         <p>Acesse o painel para aprovar ou reprovar em até 1 hora.</p>
127|         <a href="https://pinturapro-painel-production.up.railway.app" style="background: #E8833A; color: #000; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Abrir Painel</a>
128|       </div>
129|     `
130|   }).catch(err => console.error('Erro ao notificar admin:', err))
131| }
132| 
133| const criarAssinatura = async (req, res) => {
134|   try {
135|     const { plano = 'mensal' } = req.body
136|     const usuario = req.usuario
137| 
138|     const usuarioResult = await pool.query(
139|       'SELECT nome, email, cpf_cnpj, telefone, tipo_prestador FROM usuarios WHERE id = $1',
140|       [usuario.id]
141|     )
142|     const dadosUsuario = usuarioResult.rows[0]
143|     const taxId = limparCpfCnpj(dadosUsuario?.cpf_cnpj)
144| 
145|     if (!taxId || (taxId.length !== 11 && taxId.length !== 14)) {
146|       return res.status(400).json({ erro: 'CPF ou CNPJ inválido. Atualize seu perfil com um documento válido.' })
147|     }
148| 
149|     const telLimpo  = (dadosUsuario?.telefone || '').replace(/\D/g, '')
150|     const telArea   = telLimpo.substring(0, 2) || '34'
151|     const telNumero = telLimpo.substring(2)    || '999999999'
152| 
153|     const nomePlano = plano === 'anual' ? 'Anual' : 'Mensal'
154| 
155|     // Preço definido pelo TIER do prestador (tipo_prestador), NÃO pelo role:
156|     // todos os prestadores (pintor/construtor e reparador) têm role='prestador',
157|     // então usar role cobrava R$ 49,90 de todo mundo. O tier real é tipo_prestador.
158|     //   reparador           → R$ 49,90 / mês (R$ 499,00 anual)
159|     //   pintor (construção) → R$ 99,90 / mês (R$ 999,00 anual)
160|     const tipoPrestador = dadosUsuario?.tipo_prestador
161|     const valor = precoAssinaturaCentavos(usuario.role, tipoPrestador, plano)
162|     if (valor == null) {
163|       // Tier não mapeado: falha alto em vez de cobrar silenciosamente o plano barato.
164|       console.error(`[pagamento] tipo_prestador não mapeado para preço — usuario=${usuario.id} tipo_prestador=${JSON.stringify(tipoPrestador)}`)
165|       return res.status(422).json({ erro: 'Tipo de prestador não reconhecido para cobrança. Atualize seu cadastro ou contate o suporte.' })
166|     }
167|     const descricao = (usuario.role === 'prestador' && tipoPrestador === 'reparador')
168|       ? `${MARCA} Serviços — Plano ${nomePlano}`
169|       : `${MARCA} — Plano ${nomePlano}`
170| 
171|     const body = {
172|       reference_id: `${usuario.id}|${plano}`,
173|       customer: {
174|         name: dadosUsuario?.nome || `Cliente ${MARCA}`,
175|         email: dadosUsuario?.email || usuario.email,
176|         tax_id: taxId,
177|         phones: [{ country: '55', area: telArea, number: telNumero, type: 'MOBILE' }]
178|       },
179|       items: [{ reference_id: `plano_${plano}`, name: descricao, quantity: 1, unit_amount: valor }],
180|       payment_methods: [{ type: 'CREDIT_CARD' }, { type: 'PIX' }],
181|       redirect_url: `${APP_URL}/pagamentos/sucesso`,
182|       notification_urls: [`${APP_URL}/pagamentos/webhook-pagbank`]
183|     }
184| 
185|     const response = await fetch(`${PAGBANK_URL}/checkouts`, {
186|       method: 'POST',
187|       headers: {
188|         'Authorization': `Bearer ${PAGBANK_TOKEN}`,
189|         'Content-Type': 'application/json',
190|         'x-api-version': '4.0'
191|       },
192|       body: JSON.stringify(body)
193|     })
194| 
195|     const data = await response.json()
196| 
197|     if (!response.ok) {
198|       console.error('Erro PagBank:', JSON.stringify(data))
199|       return res.status(500).json({ erro: 'Erro ao criar pagamento', detalhe: data })
200|     }
201| 
202|     const linkPagamento = data.links?.find(l => l.rel === 'PAY')?.href
203|       || data.links?.find(l => l.rel === 'pay')?.href
204|       || data.links?.[0]?.href
205| 
206|     res.json({ init_point: linkPagamento, order_id: data.id, status: data.status })
207| 
208|   } catch (err) {
209|     console.error('Erro ao criar preferência PagBank:', err)
210|     res.status(500).json({ erro: 'Erro ao criar assinatura' })
211|   }
212| }
213| 
214| const sucesso = async (req, res) => {
215|   try {
216|     console.log(`Redirecionamento de sucesso — ${JSON.stringify(req.query)}`)
217|     res.redirect('https://pinturapro-painel-production.up.railway.app')
218|   } catch (err) {
219|     res.redirect('https://pinturapro-painel-production.up.railway.app')
220|   }
221| }
222| 
223| const webhookPagbank = async (req, res) => {
224|   try {
225|     // req.body é um Buffer cru (express.raw escopado à rota do webhook em server.js).
226|     const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
227| 
228|     // Autenticidade PagBank: SHA-256("{token}-{payload}") comparado em tempo
229|     // constante ao header x-authenticity-token.
230|     const assinaturaRecebida = (req.headers['x-authenticity-token'] || '').toLowerCase()
231|     const assinaturaEsperada = crypto
232|       .createHash('sha256')
233|       .update(`${process.env.PAGBANK_TOKEN || ''}-${rawBody}`)
234|       .digest('hex')
235|     const assinaturaValida =
236|       assinaturaRecebida.length === assinaturaEsperada.length &&
237|       crypto.timingSafeEqual(Buffer.from(assinaturaRecebida), Buffer.from(assinaturaEsperada))
238| 
239|     // Verificação LIGADA por padrão (D1). Só WEBHOOK_ENFORCE_SIGNATURE='false' desliga
240|     // (volta ao modo MONITOR, que só loga e processa mesmo sem assinatura válida).
241|     const enforce = WEBHOOK_ENFORCE
242|     const tokenConfigurado = !!process.env.PAGBANK_TOKEN
243|     console.log(`[webhook-pagbank] assinatura match=${assinaturaValida} | modo=${enforce ? 'enforce' : 'monitor'} | token=${tokenConfigurado ? 'ok' : 'AUSENTE'} | content-type=${req.headers['content-type'] || '(none)'}`)
244| 
245|     // Diagnóstico do ESQUEMA de assinatura, para a primeira entrega real revelar o que o
246|     // PagBank manda de fato. Só NOMES de header e TAMANHOS — nenhum valor de header, nenhum
247|     // trecho de payload, nunca o token. Puramente observacional: roda antes do early-return
248|     // de enforce (para aparecer também quando o evento é rejeitado) e não altera o fluxo.
249|     const tamAuthenticity = req.headers['x-authenticity-token'] != null
250|       ? String(req.headers['x-authenticity-token']).length : null
251|     const tamPayloadSignature = req.headers['x-payload-signature'] != null
252|       ? String(req.headers['x-payload-signature']).length : null
253|     console.log(`[webhook-pagbank] headers recebidos (apenas nomes): ${Object.keys(req.headers).join(', ') || '(nenhum)'}`)
254|     console.log(`[webhook-pagbank] tamanhos | x-authenticity-token=${tamAuthenticity ?? '(ausente)'} | x-payload-signature=${tamPayloadSignature ?? '(ausente)'} | sha256_hex_esperado=${assinaturaEsperada.length}`)
255| 
256|     if (enforce) {
257|       // Sem token não há como verificar: um segredo vazio é forjável (o atacante conhece o
258|       // algoritmo), então "assinatura válida" seria falso-positivo. Rejeita TUDO e grita.
259|       if (!tokenConfigurado) {
260|         console.error('[webhook-pagbank] REJEITADO: WEBHOOK_ENFORCE_SIGNATURE ligado mas PAGBANK_TOKEN AUSENTE — impossível verificar assinatura; nenhum evento é processado. Configure PAGBANK_TOKEN (ou WEBHOOK_ENFORCE_SIGNATURE=false para desligar).')
261|         return res.sendStatus(200)
262|       }
263|       if (!assinaturaValida) {
264|         console.warn(`[webhook-pagbank] REJEITADO: assinatura inválida ou ausente (enforce) — nada concedido | x-authenticity-token=${tamAuthenticity ?? '(ausente)'} | esperado_len=${assinaturaEsperada.length}`)
265|         return res.sendStatus(200)
266|       }
267|     }
268| 
269|     res.sendStatus(200)
270| 
271|     let payload = {}
272|     try { payload = JSON.parse(rawBody || '{}') } catch { payload = {} }
273|     const { reference_id, charges } = payload
274|     if (!reference_id || !charges?.length) return
275| 
276|     const charge = charges[0]
277| 
278|     // CLAIM atômico de idempotência — quem INSERE a linha ganha o direito de processar
279|     // (mesmo idioma do claim de contratosController). Entrega repetida do MESMO
280|     // (charge_id, status) não grava nada, não devolve linha e sai aqui: nenhum e-mail
281|     // reenviado, nenhum Telegram, nenhum proximo_vencimento empurrado de graça.
282|     // Fica ANTES do filtro de PAID de propósito, para o livro registrar TODO desfecho.
283|     // reference_id vai cru: o split continua onde estava, logo abaixo.
284|     if (charge.id) {
285|       const claim = await pool.query(
286|         `INSERT INTO webhook_eventos_pagbank (charge_id, status, reference_id, valor_centavos)
287|          VALUES ($1, $2, $3, $4)
288|          ON CONFLICT (charge_id, status) DO NOTHING
289|          RETURNING charge_id`,
290|         [charge.id, charge.status || '(sem status)', reference_id, charge.amount?.value ?? null]
291|       )
292|       if (claim.rowCount === 0) {
293|         console.log(`[webhook-pagbank] entrega duplicada ignorada | charge=${charge.id} | status=${charge.status}`)
294|         return
295|       }
296|     } else {
297|       // FALHA ABERTO: sem charge.id não existe chave de dedupe. Processar mesmo assim é
298|       // menos ruim que barrar um pagamento real por uma suposição errada sobre o payload —
299|       // este log denuncia que a suposição caiu.
300|       console.warn('[webhook-pagbank] charge.id ausente — sem chave de dedupe, seguindo SEM claim')
301|     }
302| 
303|     if (charge.status !== 'PAID') {
304|       console.log(`[webhook-pagbank] evento nao-PAID registrado | status=${charge.status} | nenhuma acao tomada`)
305|       return
306|     }
307| 
308|     const partes = reference_id.split('|')
309|     if (partes.length !== 2) return
310| 
311|     const [usuarioId, plano] = partes
312| 
313|     const usuarioResult = await pool.query(
314|       `SELECT id, role, nome, tipo_prestador FROM usuarios WHERE id = $1`, [usuarioId]
315|     )
316|     if (usuarioResult.rows.length === 0) return
317| 
318|     const usuario = usuarioResult.rows[0]
319| 
320|     // D2 — o plano concedido é validado contra o valor REALMENTE pago, pela MESMA tabela
321|     // que cobrou (precoAssinaturaCentavos). Divergência (a menor ou a maior), tier não
322|     // mapeável, ou ausência do valor no payload: REJEITA e loga, não concede nada. Sem isto,
323|     // o acesso vinha do texto do reference_id e um pagamento parcial/forjado valia o mesmo.
324|     const valorEsperado = precoAssinaturaCentavos(usuario.role, usuario.tipo_prestador, plano)
325|     const valorPago = charge.amount?.value
326|     if (valorEsperado == null) {
327|       console.error(`[webhook-pagbank] REJEITADO: preço não mapeável — usuario=${usuarioId} role=${usuario.role} tipo_prestador=${JSON.stringify(usuario.tipo_prestador)} plano=${plano}; nada concedido`)
328|       return
329|     }
330|     if (valorPago == null || Number(valorPago) !== valorEsperado) {
331|       console.error(`[webhook-pagbank] REJEITADO: valor pago (${valorPago}) != esperado (${valorEsperado} centavos) — usuario=${usuarioId} plano=${plano}; nada concedido`)
332|       return
333|     }
334| 
335|     // Prestadores ficam pendentes de verificação — donos de obra ativam direto
336|     if (usuario.role === 'prestador' || usuario.role === 'pintor' || usuario.role === 'assinante') {
337|       await colocarPendentVerificacao(usuarioId, plano)
338|       console.log(`Prestador ${usuarioId} aguardando verificação após pagamento`)
339| 
340|       const telegramToken  = process.env.TELEGRAM_BOT_TOKEN
341|       const telegramChatId = process.env.TELEGRAM_CHAT_ID
342|       if (telegramToken && telegramChatId) {
343|         try {
344|           const valorCentavos = charge.amount?.value
345|           const valorFmt = valorCentavos
346|             ? `R$ ${(valorCentavos / 100).toFixed(2).replace('.', ',')}`
347|             : plano
348|           const texto = `💰 Novo pagamento ${MARCA}!\nUsuario: ${usuario.nome}\nPlano: ${plano}\nValor: ${valorFmt}\nAguardando aprovacao no painel`
349|           fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage?chat_id=${telegramChatId}&text=${encodeURIComponent(texto)}`)
350|             .catch(e => console.error('Telegram notify error:', e.message))
351|         } catch (e) {
352|           console.error('Telegram notify error:', e.message)
353|         }
354|       }
355|     } else {
356|       await ativarAssinatura(usuarioId, plano)
357|       console.log(`Assinatura ativada via PagBank — usuário: ${usuarioId}, plano: ${plano}`)
358|     }
359| 
360|   } catch (err) {
361|     console.error('Erro no webhook PagBank:', err.message)
362|     if (!res.headersSent) res.sendStatus(200)
363|   }
364| }
365| 
366| const darAcessoGratuito = async (req, res) => {
367|   try {
368|     const { usuario_id } = req.body
369|     if (!usuario_id) return res.status(400).json({ erro: 'usuario_id é obrigatório' })
370| 
371|     const usuarioExiste = await pool.query(`SELECT id FROM usuarios WHERE id = $1`, [usuario_id])
372|     if (usuarioExiste.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })
373| 
374|     const assinaturaExiste = await pool.query(`SELECT id, status, tipo FROM assinaturas WHERE usuario_id = $1`, [usuario_id])
375|     if (assinaturaExiste.rows.length > 0) {
376|       // RECUSA em vez de converter: sobre uma assinatura PAGA ativa, este endpoint apagava o
377|       // caráter pago da linha (tipo='gratuito') sem registro nenhum, e a partir daí todo
378|       // caminho de aprovação leria tipo='gratuito' → proximo_vencimento = NULL, tornando o
379|       // usuário grátis para sempre. Acesso gratuito é para quem NÃO tem assinatura paga.
380|       // tipo NULL conta como "não gratuito" (linha paga nasce sem tipo) — !== já dá isso.
381|       const atual = assinaturaExiste.rows[0]
382|       if (atual.status === 'ativa' && atual.tipo !== 'gratuito') {
383|         return res.status(409).json({
384|           erro: 'Este usuário já tem uma assinatura paga ativa. Conceder acesso gratuito apagaria o registro pago — cancele ou aguarde o vencimento antes de conceder.',
385|           codigo: 'ASSINATURA_PAGA_ATIVA',
386|         })
387|       }
388|       // Aqui a linha ou já é gratuita, ou não está ativa (pendente/cancelada/expirada) — o
389|       // guard acima barrou a paga ativa, então tipo='gratuito' abaixo não apaga nada pago.
390|       // GREATEST: conceder acesso grátis nunca ENCURTA um vencimento já mais distante — sem
391|       // isto, um gratuito anual com 300 dias restantes caía para 30.
392|       await pool.query(
393|         `UPDATE assinaturas SET status = 'ativa', tipo = 'gratuito', atualizado_em = NOW(),
394|           proximo_vencimento = GREATEST(proximo_vencimento, NOW() + INTERVAL '30 days'),
395|           marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL
396|          WHERE usuario_id = $1`,
397|         [usuario_id]
398|       )
399|     } else {
400|       await pool.query(
401|         `INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo, proximo_vencimento)
402|          VALUES ($1, 'mensal', 0, 'ativa', 'gratuito', NOW() + INTERVAL '30 days')`,
403|         [usuario_id]
404|       )
405|     }
406| 
407|     await pool.query(
408|       `UPDATE usuarios SET verificacao_status = 'aprovado', aprovado_automaticamente = false WHERE id = $1`, [usuario_id]
409|     )
410| 
411|     res.json({ mensagem: 'Acesso gratuito concedido com sucesso' })
412|   } catch (err) {
413|     console.error('Erro ao conceder acesso gratuito:', err.message)
414|     res.status(500).json({ erro: 'Erro ao conceder acesso' })
415|   }
416| }
417| 
418| const listarAssinantes = async (req, res) => {
419|   try {
420|     const page   = parseInt(req.query.page)  || 1
421|     const limit  = parseInt(req.query.limit) || 200
422|     const offset = (page - 1) * limit
423| 
424|     const result = await pool.query(`
425|       SELECT u.id, u.nome, u.email, u.telefone, u.cidade, u.role,
426|              u.tipo_dono, u.tipo_prestador, u.verificacao_status, u.aprovado_automaticamente,
427|              a.status, a.plano, a.tipo, a.valor_mensal, a.criado_em
428|       FROM usuarios u
429|       LEFT JOIN assinaturas a ON a.usuario_id = u.id
430|       WHERE u.role IN ('assinante', 'prestador', 'dono_obra', 'pintor')
431|       ORDER BY u.role ASC, u.nome ASC
432|       LIMIT $1 OFFSET $2
433|     `, [limit, offset])
434| 
435|     res.json({ assinantes: result.rows, page, limit })
436|   } catch (err) {
437|     console.error('Erro ao listar assinantes:', err.message)
438|     res.status(500).json({ erro: 'Erro ao listar assinantes' })
439|   }
440| }
441| 
442| module.exports = { criarAssinatura, sucesso, webhookPagbank, darAcessoGratuito, listarAssinantes }
```

### src/routes/index.js:5230-5397 — Janela de lançamento (GET público, POST superadmin com backfill transacional), prévia, limite de demandas

```js
5230| const emailsEspeciais = () => (process.env.EMAILS_ESPECIAIS || '')
5231|   .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
5232| 
5233| // Primeiro dia (00:00) do mês que está a `nMeses` do mês CORRENTE, em America/Sao_Paulo,
5234| // como timestamptz. Os dois AT TIME ZONE fazem coisas OPOSTAS e é isso que faz a conta
5235| // fechar num banco UTC:
5236| //   1º (timestamptz → timestamp) TIRA o fuso e devolve o relógio de parede de SP, para o
5237| //      date_trunc contar o mês BRASILEIRO;
5238| //   2º (timestamp → timestamptz) RECOLOCA o fuso e devolve o instante UTC a gravar.
5239| // Sem isso, 31/08 22:00 em SP já é 01/09 01:00 em UTC e o truncamento cairia um mês adiante.
5240| // nMeses é literal inteiro controlado aqui (1 ou 2), nunca entrada de usuário.
5241| const SQL_PRIMEIRO_DIA_MES_SP = (nMeses) =>
5242|   `(date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '${nMeses} month') AT TIME ZONE 'America/Sao_Paulo'`
5243| 
5244| // Alvo do vencimento no desligamento da janela (regra de negócio do dono, final): SEMPRE o
5245| // PRIMEIRO DIA do próximo mês (00:00 America/Sao_Paulo), qualquer que seja o dia do
5246| // desligamento — o mês corrente fica grátis. Sem piso de 30 dias, sem salto de mês.
5247| const SQL_ALVO_BACKFILL_SP = SQL_PRIMEIRO_DIA_MES_SP(1)
5248| 
5249| // Backfill do desligamento da janela: a coorte que entrou grátis passa a ter vencimento real.
5250| // Alvo = tipo='gratuito' COM valor_mensal > 0, que isola os prestadores do lançamento —
5251| // dono_obra e darAcessoGratuito gravam valor_mensal = 0 e seguem grátis para sempre.
5252| // tipo = NULL (e não 'pago'): linha paga nasce com tipo NULL, e é o que faz os três CASE de
5253| // aprovação pararem de forçar proximo_vencimento = NULL. marco_* zerados para os avisos de
5254| // vencimento dispararem para esta coorte.
5255| // Idempotente por construção: depois de rodar, as linhas não casam mais tipo='gratuito'.
5256| // GREATEST (mesmo padrão de darAcessoGratuito :394 e das aprovações :4737/:4922) impede que o
5257| // backfill ENCURTE um prazo já mais distante: quem entrou grátis mas depois PAGOU carrega um
5258| // vencimento futuro que precisa sobreviver ao desligamento da janela. GREATEST ignora NULL no
5259| // Postgres, então a coorte sem vencimento cai no fim-do-mês, como antes.
5260| const SQL_BACKFILL_LANCAMENTO = `
5261|   UPDATE assinaturas a
5262|      SET proximo_vencimento = GREATEST(a.proximo_vencimento, ${SQL_ALVO_BACKFILL_SP}),
5263|          tipo          = NULL,
5264|          marco_1_em    = NULL,
5265|          marco_2_em    = NULL,
5266|          marco_3_em    = NULL,
5267|          atualizado_em = NOW()
5268|     FROM usuarios u
5269|    WHERE u.id = a.usuario_id
5270|      AND a.tipo = 'gratuito'
5271|      AND a.valor_mensal > 0
5272|      AND LOWER(u.email) <> ALL($1::text[])
5273|   RETURNING a.usuario_id`
5274| 
5275| // Status público — a tela de cadastro roda PRÉ-LOGIN, então NÃO exige token.
5276| // Só expõe se a promoção está ativa e até quando (não-sensível).
5277| router.get('/config/lancamento', async (req, res) => {
5278|   try {
5279|     const r = await pool.query(`SELECT valor FROM configuracoes WHERE chave = 'lancamento_data_fim'`)
5280|     const valor = r.rows[0]?.valor || null
5281|     res.json({ gratis: !!valor && new Date(valor) > new Date(), data_fim: valor })
5282|   } catch (err) {
5283|     res.status(500).json({ erro: 'Erro ao buscar janela de lançamento' })
5284|   }
5285| })
5286| 
5287| // Admin liga/estende/desliga a janela. data_fim = ISO futuro liga/estende; null desliga.
5288| // DESLIGAR é porta de mão única: roda o backfill da coorte na MESMA transação do flag —
5289| // ou os dois entram, ou nenhum. Sem isso a janela desligava e a coorte seguia grátis para
5290| // sempre, que é o defeito que este endpoint fecha. GET /config/lancamento/previa devolve a
5291| // contagem antes, para o painel confirmar com o número na tela.
5292| router.post('/config/lancamento', autenticar, exigirSuperAdmin, async (req, res) => {
5293|   const client = await pool.connect()
5294|   try {
5295|     const { data_fim } = req.body
5296|     // Desligar é porta de mão única (backfill irreversível), então só uma instrução
5297|     // EXPLÍCITA no body pode disparar: a chave data_fim PRESENTE com null ou ''.
5298|     // Chave ausente (body malformado, campo renomeado) não é instrução — antes ela
5299|     // caía no mesmo caminho do null e desligava a janela com backfill e tudo.
5300|     if (!Object.prototype.hasOwnProperty.call(req.body, 'data_fim')) {
5301|       return res.status(400).json({ erro: 'Nenhum campo para atualizar — envie data_fim (data ISO para ligar/estender, null para desligar)' })
5302|     }
5303|     // valor é NOT NULL na tabela: usar '' (não null) como estado "desligado" para
5304|     // nunca violar a constraint. Downstream trata '' e ausência como janela off.
5305|     let valor = ''
5306|     if (data_fim !== null && data_fim !== '') {
5307|       const d = new Date(data_fim)
5308|       if (isNaN(d.getTime())) return res.status(400).json({ erro: 'data_fim inválida — use uma data ISO válida ou null para desligar' })
5309|       valor = d.toISOString()
5310|     }
5311|     const desligando = valor === ''
5312| 
5313|     await client.query('BEGIN')
5314|     await client.query(
5315|       `UPDATE configuracoes SET valor = $1, atualizado_em = NOW() WHERE chave = 'lancamento_data_fim'`,
5316|       [valor]
5317|     )
5318| 
5319|     let afetados = 0
5320|     if (desligando) {
5321|       const backfill = await client.query(SQL_BACKFILL_LANCAMENTO, [emailsEspeciais()])
5322|       afetados = backfill.rowCount
5323|       // Trilha de auditoria em UMA linha: porta de mão única, então os ids afetados precisam
5324|       // ficar registrados. Só usuario_id (nada de e-mail/CPF).
5325|       console.log(`[Lancamento] janela DESLIGADA | backfill afetou ${afetados} assinatura(s) | usuario_ids: ${backfill.rows.map(r => r.usuario_id).join(',') || '(nenhum)'}`)
5326|     }
5327| 
5328|     await client.query('COMMIT')
5329|     res.json({ data_fim: valor || null, gratis: !!valor && new Date(valor) > new Date(), afetados })
5330|   } catch (err) {
5331|     await client.query('ROLLBACK').catch(() => {})
5332|     console.error('[Lancamento] Erro ao atualizar janela:', err.message)
5333|     res.status(500).json({ erro: 'Erro ao atualizar janela de lançamento' })
5334|   } finally {
5335|     client.release()
5336|   }
5337| })
5338| 
5339| // Prévia do desligamento — MESMO predicado do backfill, para o número da tela bater com o
5340| // que o POST vai fazer. Admin-only de propósito: o GET público acima expõe só se a promo
5341| // está ativa; tamanho de coorte é dado de negócio.
5342| router.get('/config/lancamento/previa', autenticar, exigirAdmin, async (req, res) => {
5343|   try {
5344|     const especiais = emailsEspeciais()
5345|     const r = await pool.query(`
5346|       SELECT
5347|         COUNT(*) FILTER (WHERE a.tipo = 'gratuito' AND a.valor_mensal > 0
5348|                            AND LOWER(u.email) <> ALL($1::text[]))::int AS afetados,
5349|         COUNT(*) FILTER (WHERE a.tipo = 'gratuito' AND a.valor_mensal > 0
5350|                            AND LOWER(u.email) = ANY($1::text[]))::int  AS especiais_preservados,
5351|         COUNT(*) FILTER (WHERE a.tipo = 'gratuito'
5352|                            AND COALESCE(a.valor_mensal, 0) = 0)::int   AS gratuitos_permanentes,
5353|         ${SQL_ALVO_BACKFILL_SP} AS data_alvo
5354|       FROM assinaturas a
5355|       JOIN usuarios u ON u.id = a.usuario_id
5356|     `, [especiais])
5357|     res.json(r.rows[0])
5358|   } catch (err) {
5359|     console.error('[Lancamento] Erro na prévia:', err.message)
5360|     res.status(500).json({ erro: 'Erro ao calcular prévia do desligamento' })
5361|   }
5362| })
5363| 
5364| // Teto de demandas simultâneas para dono sem histórico. Espelha os demais pares de config
5365| // (admin, leitura direta da chave). O GET devolve o teto EFETIVO — passa pelo mesmo
5366| // lerLimiteDemandas da checagem, então painel e regra nunca divergem.
5367| router.get('/config/limite-demandas', autenticar, exigirAdmin, async (req, res) => {
5368|   try {
5369|     res.json({ limite: await lerLimiteDemandas() })
5370|   } catch (err) {
5371|     res.status(500).json({ erro: 'Erro ao buscar limite de demandas' })
5372|   }
5373| })
5374| 
5375| // Admin ajusta o teto. Só inteiro positivo: os demais valores cairiam no padrão em silêncio.
5376| router.post('/config/limite-demandas', autenticar, exigirSuperAdmin, async (req, res) => {
5377|   try {
5378|     const { limite } = req.body
5379|     const n = Number(limite)
5380|     if (!Number.isInteger(n) || n <= 0) {
5381|       return res.status(400).json({ erro: 'limite inválido — use um número inteiro positivo' })
5382|     }
5383|     await pool.query(
5384|       `UPDATE configuracoes SET valor = $1, atualizado_em = NOW() WHERE chave = 'limite_demandas_live_sem_historico'`,
5385|       [String(n)]
5386|     )
5387|     res.json({ mensagem: 'Limite de demandas atualizado', limite: n })
5388|   } catch (err) {
5389|     res.status(500).json({ erro: 'Erro ao atualizar limite de demandas' })
5390|   }
5391| })
5392| 
5393| // ============================================================
5394| // LOCALIZAÇÃO DE PRESTADORES
5395| // ============================================================
5396| 
5397| // Prestador envia sua localização atual
```

### server.js:375-505 — expirarAssinaturasVencidas (cron 1h) e avisos de vencimento 24h/12h/6h

```js
375| const expirarAssinaturasVencidas = async () => {
376|   try {
377|     // O próprio UPDATE é o CLAIM: a linha só sai de 'ativa' UMA vez, então numa segunda
378|     // réplica (ou numa reexecução) o mesmo id não volta no RETURNING e ninguém recebe push
379|     // repetido. Substitui o SELECT + um UPDATE por linha — era N+1.
380|     // Filtro por LINHA, não por usuario_id: usuário com mais de uma assinatura não pode ter
381|     // as que ainda não venceram marcadas junto.
382|     // `FROM usuarios u` só para o RETURNING alcançar o push_token; é o mesmo inner join que
383|     // o SELECT anterior fazia, então assinatura sem usuário segue de fora, como antes.
384|     const vencidas = await pool.query(`
385|       UPDATE assinaturas a
386|          SET status = 'expirada', atualizado_em = NOW()
387|         FROM usuarios u
388|        WHERE u.id = a.usuario_id
389|          AND a.status = 'ativa'
390|          AND a.proximo_vencimento < NOW()
391|       RETURNING a.usuario_id, u.push_token
392|     `)
393|     if (vencidas.rowCount === 0) return
394| 
395|     for (const sub of vencidas.rows) {
396|       // Sem isto, o cache de assinatura (middlewares/auth, TTL 30s) seguiria servindo
397|       // 'ativa' para quem acabou de expirar. Havia um segundo mapa em routes que ficava
398|       // para trás na invalidação; hoje é um só.
399|       invalidarCachesUsuario(sub.usuario_id)
400|       if (sub.push_token) {
401|         enviarPushNotificacao(
402|           sub.push_token,
403|           '⚠️ Seu acesso expirou',
404|           'Sua assinatura venceu. Renove agora para continuar acessando os serviços.',
405|           { tipo: 'assinatura_expirada' }
406|         ).catch(() => {})
407|       }
408|     }
409|     console.log(`[ExpirarAssinaturas] ${vencidas.rowCount} assinatura(s) expirada(s)`)
410|   } catch (err) {
411|     console.error('[ExpirarAssinaturas] Erro:', err.message)
412|   }
413| }
414| 
415| // Três avisos de vencimento (24h / 12h / 6h), espelhando verificarMarcosExpiracao das
416| // demandas: bandas DISJUNTAS (no máximo um aviso por run e por assinatura) e claim-then-send.
417| // Compara TIMESTAMP, não DATE: o DATE() antigo tratava 00:30 e 23:50 do mesmo dia como iguais,
418| // então a antecedência real variava de minutos a quase 48h.
419| // tipo do payload segue 'assinatura_vence_amanha' nos TRÊS — o roteamento do app não muda;
420| // só título e corpo dizem quanto falta.
421| const MARCOS_VENCIMENTO = [
422|   { n: 1, col: 'marco_1_em', horas: 24, titulo: '⏰ Sua assinatura vence amanhã',
423|     corpo: 'Renove sua assinatura para não perder o acesso aos serviços disponíveis.' },
424|   { n: 2, col: 'marco_2_em', horas: 12, titulo: '⏰ Sua assinatura vence em 12 horas',
425|     corpo: 'Faltam menos de 12 horas. Renove para não perder o acesso aos serviços.' },
426|   { n: 3, col: 'marco_3_em', horas: 6,  titulo: '⚠️ Sua assinatura vence em 6 horas',
427|     corpo: 'Última chance: menos de 6 horas para renovar antes de perder o acesso.' },
428| ]
429| 
430| const notificarAssinaturasProximasVencimento = async () => {
431|   try {
432|     // Candidatas: ativas, com vencimento AINDA no futuro dentro da maior banda (24h) e com
433|     // pelo menos um marco pendente. push_token vazio/nulo já sai daqui — não há o que enviar.
434|     const candidatos = await pool.query(`
435|       SELECT a.id, a.proximo_vencimento, a.marco_1_em, a.marco_2_em, a.marco_3_em, u.push_token
436|       FROM assinaturas a
437|       JOIN usuarios u ON u.id = a.usuario_id
438|       WHERE a.status = 'ativa'
439|         AND a.proximo_vencimento IS NOT NULL
440|         AND a.proximo_vencimento > NOW()
441|         AND a.proximo_vencimento <= NOW() + INTERVAL '24 hours'
442|         AND (a.marco_1_em IS NULL OR a.marco_2_em IS NULL OR a.marco_3_em IS NULL)
443|         AND u.push_token IS NOT NULL AND u.push_token <> ''
444|     `)
445|     if (candidatos.rows.length === 0) return
446| 
447|     let totalEnviados = 0
448|     for (const sub of candidatos.rows) {
449|       const restanteHoras = (new Date(sub.proximo_vencimento).getTime() - Date.now()) / 3600000
450| 
451|       // Banda disjunta — no máximo um marco por run (mesma lógica de verificarMarcosExpiracao).
452|       const alvo = MARCOS_VENCIMENTO.find((m, i) => {
453|         const piso = MARCOS_VENCIMENTO[i + 1]?.horas ?? 0
454|         return sub[m.col] === null && restanteHoras <= m.horas && restanteHoras > piso
455|       })
456|       if (!alvo) continue
457| 
458|       // Claim-then-send: reivindica a coluna no MESMO UPDATE. Linha já reivindicada por outra
459|       // réplica (ou por um run anterior) não volta no RETURNING e não gera segundo envio.
460|       const claim = await pool.query(
461|         `UPDATE assinaturas SET ${alvo.col} = NOW() WHERE id = $1 AND ${alvo.col} IS NULL RETURNING id`,
462|         [sub.id]
463|       )
464|       if (claim.rows.length === 0) continue
465| 
466|       enviarPushNotificacao(sub.push_token, alvo.titulo, alvo.corpo, { tipo: 'assinatura_vence_amanha' })
467|         .catch(() => {})
468|       totalEnviados++
469|     }
470|     console.log(`[NotificarVencimento] ${totalEnviados} aviso(s) de vencimento enviado(s)`)
471|   } catch (err) {
472|     console.error('[NotificarVencimento] Erro:', err.message)
473|   }
474| }
475| 
476| // Dois lembretes para o dono avaliar o profissional (1 dia / 3 dias APÓS o encerramento),
477| // espelhando notificarAssinaturasProximasVencimento acima: bandas DISJUNTAS (no máximo um
478| // lembrete por run e por contrato) e claim-then-send nas colunas aval_marco_N_em.
479| // A diferença de forma em relação ao aviso de vencimento é só a direção do tempo: lá se conta
480| // quanto FALTA para proximo_vencimento (bandas decrescentes), aqui quanto JÁ PASSOU desde
481| // encerrado_em (bandas crescentes). O mecanismo é o mesmo.
482| //
483| // TETO_DIAS existe porque essa direção invertida traz um risco que o aviso de vencimento não
484| // tem: sem limite superior, a banda mais alta ficaria aberta para sempre e o PRIMEIRO run
485| // depois do deploy cutucaria de uma vez todo contrato encerrado e não avaliado da história —
486| // "avalie o serviço que você fechou há oito meses". Com o teto, contrato encerrado há mais de
487| // 7 dias nunca entra: os marcos ficam NULL e ninguém é incomodado. (Na verificação contra
488| // produção não havia nenhum elegível, então o 1º run dispara zero de qualquer forma; o teto é
489| // para daqui em diante.)
490| const MARCOS_AVALIACAO = [
491|   { n: 1, col: 'aval_marco_1_em', dias: 1 },
492|   { n: 2, col: 'aval_marco_2_em', dias: 3 },
493| ]
494| const TETO_LEMBRETE_AVALIACAO_DIAS = 7
495| 
496| // contrato_tipo é SINGULAR ('obra'/'reparo') e contrato_id é o id da DEMANDA — não o id da
497| // tabela `contratos`. Confirmado no banco de produção: as 3 avaliações existentes casam 3/3
498| // com obras/reparos e 0/3 com contratos. Trocar isso faria o NOT EXISTS nunca casar, e o job
499| // cutucaria justamente quem já avaliou.
500| const LADOS_AVALIACAO = [
501|   { tabela: 'obras',   tipo: 'obra',   chave: 'obra_id',   rotulo: 'a obra',    profissional: 'o pintor' },
502|   { tabela: 'reparos', tipo: 'reparo', chave: 'reparo_id', rotulo: 'o serviço', profissional: 'o profissional' },
503| ]
504| 
505| const lembrarAvaliacaoPendente = async () => {
```

### src/controllers/contratosController.js:220-441 — Claim atômico do contrato (obra: ON CONFLICT candidatura_id; reparo: ON CONFLICT interesse_id) e envio por e-mail com valor_acordado

```js
220| 
221| </body>
222| </html>
223|   `
224| }
225| 
226| // ============================================================
227| // ENVIO POR E-MAIL
228| // ============================================================
229| const enviarContratoReparo = async (reparoId) => {
230|   // Fora do try para o catch enxergar. claimInteresseId != null só quando ESTA execução
231|   // ganhou o claim; emailsEnviados marca o ponto a partir do qual liberar o claim passaria
232|   // a permitir um segundo e-mail em vez de uma retentativa.
233|   let claimInteresseId = null
234|   let emailsEnviados = false
235|   try {
236|     const result = await pool.query(
237|       `SELECT r.*,
238|               u_dono.nome as dono_nome, u_dono.email as dono_email,
239|               u_dono.telefone as dono_telefone, u_dono.cpf_cnpj as dono_cpf,
240|               u_dono.cidade as dono_cidade,
241|               u_prest.nome as prest_nome, u_prest.email as prest_email,
242|               u_prest.telefone as prest_telefone, u_prest.cpf_cnpj as prest_cpf,
243|               u_prest.cidade as prest_cidade,
244|               (SELECT ir.id FROM interesse_reparos ir
245|                 WHERE ir.reparo_id = r.id AND ir.usuario_id = r.match_usuario_id
246|                   AND ir.status = 'aceito'
247|                 ORDER BY ir.criado_em DESC LIMIT 1) as interesse_id,
248|               (SELECT COALESCE(ir.valor_contraproposta, ir.valor_proposto) FROM interesse_reparos ir
249|                 WHERE ir.reparo_id = r.id AND ir.usuario_id = r.match_usuario_id
250|                   AND ir.status = 'aceito'
251|                 ORDER BY ir.criado_em DESC LIMIT 1) as valor_acordado
252|        FROM reparos r
253|        JOIN usuarios u_dono  ON r.criado_por       = u_dono.id
254|        JOIN usuarios u_prest ON r.match_usuario_id = u_prest.id
255|        WHERE r.id = $1`,
256|       [reparoId]
257|     )
258|     if (result.rows.length === 0) {
259|       console.error(`[Contrato] Reparo ${reparoId} — query retornou 0 linhas (match_usuario_id ausente?) — e-mail NÃO enviado`)
260|       return
261|     }
262| 
263|     const r = result.rows[0]
264| 
265|     // Dedupe ANTES dos envios (era feito depois, então o 2º disparo reenviava os e-mails).
266|     // O INSERT ... WHERE NOT EXISTS vira um CLAIM atômico: quem inserir a linha ganha o
267|     // direito de enviar; quem não inserir já perdeu a corrida e sai sem enviar nada.
268|     // Chave = interesse_id (por contrato), não contrato_enviado (por reparo), senão um
269|     // reparo reaberto com OUTRO prestador ficaria bloqueado para sempre.
270|     if (r.interesse_id) {
271|       // Mesmo claim atômico do lado obra (ON CONFLICT no índice único, D79): o antigo
272|       // INSERT ... WHERE NOT EXISTS deixava duas execuções concorrentes passarem as duas.
273|       // O índice contratos_interesse_id_uniq é parcial (WHERE interesse_id IS NOT NULL),
274|       // então o ON CONFLICT precisa repetir o predicado para casar com ele.
275|       const claim = await pool.query(
276|         `INSERT INTO contratos (interesse_id, status, valor_acordado) VALUES ($1, 'enviado', $2)
277|          ON CONFLICT (interesse_id) WHERE interesse_id IS NOT NULL DO NOTHING
278|          RETURNING id`,
279|         [r.interesse_id, r.valor_acordado ?? null]
280|       )
281|       if (claim.rows.length === 0) {
282|         console.log(`[Contrato] Reparo ${reparoId} — já existe contrato para o interesse ${r.interesse_id}, e-mail NÃO reenviado`)
283|         return
284|       }
285|       claimInteresseId = r.interesse_id
286|     } else if (r.contrato_enviado) {
287|       // Sem interesse_id não há chave de dedupe por contrato; contrato_enviado é o único guard.
288|       console.log(`[Contrato] Reparo ${reparoId} — contrato_enviado já marcado e sem interesse_id, e-mail NÃO reenviado`)
289|       return
290|     }
291| 
292|     const dono      = { nome: r.dono_nome,  email: r.dono_email,  telefone: r.dono_telefone,  cpf_cnpj: r.dono_cpf  }
293|     const prestador = { nome: r.prest_nome, email: r.prest_email, telefone: r.prest_telefone, cpf_cnpj: r.prest_cpf }
294| 
295|     const html = gerarContratoReparo({ dono, prestador, reparo: r })
296| 
297|     const dadosPDF = {
298|       // Cidade de cada parte vem do cadastro da própria parte (usuarios.cidade);
299|       // só cai para a cidade da demanda quando o cadastro está sem cidade.
300|       contratante: { ...dono, cidade: r.dono_cidade || r.cidade },
301|       contratado:  { ...prestador, cidade: r.prest_cidade || r.cidade },
302|       servico: {
303|         tipo:       r.categoria || 'serviço',
304|         descricao:  r.titulo + (r.descricao ? ` — ${r.descricao}` : ''),
305|         endereco:   r.endereco_obra || `${r.cidade}${r.bairro ? ', ' + r.bairro : ''}`,
306|         valor:      r.valor_acordado,
307|         prazo_dias: r.prazo_atendimento_horas ? Math.max(1, Math.ceil(r.prazo_atendimento_horas / 24)) : 1,
308|         metragem:   null
309|       },
310|       marca: MARCA,
311|       cidade: r.cidade || 'Patos de Minas',
312|       data:   new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
313|     }
314| 
315|     const pdfBuffer    = await gerarContratoPDF(dadosPDF)
316|     const assunto      = `${MARCA} — Contrato de Serviço: ${r.titulo}`
317|     const nomeArquivo  = `contrato_servico_${String(reparoId).substring(0, 8)}.pdf`
318|     const remetenteNome = MARCA
319| 
320|     await enviarEmailComAnexo({ para: dono.email,      assunto, html, pdfBuffer, nomeArquivo, remetenteNome })
321|     await enviarEmailComAnexo({ para: prestador.email, assunto, html, pdfBuffer, nomeArquivo, remetenteNome })
322|     console.log(`[Contrato] Reparo ${reparoId} — enviado para ${dono.email} e ${prestador.email}`)
323|     emailsEnviados = true
324| 
325|     // A linha em `contratos` já foi criada pelo claim acima, antes dos envios.
326| 
327|     // Marca o reparo como tendo contrato enviado — só após todos os passos acima (Finding 3.2)
328|     await pool.query(`UPDATE reparos SET contrato_enviado = true WHERE id = $1`, [reparoId])
329|   } catch (err) {
330|     // Libera o claim para o próximo disparo poder reenviar. Só antes do envio: se os e-mails
331|     // já saíram, apagar a linha reabriria o caminho para um SEGUNDO e-mail, que é justamente
332|     // o que o claim existe para impedir. DELETE em try próprio — falhar aqui não pode
333|     // mascarar o erro original nem virar rejeição não tratada.
334|     if (claimInteresseId && !emailsEnviados) {
335|       try {
336|         await pool.query(`DELETE FROM contratos WHERE interesse_id = $1`, [claimInteresseId])
337|         console.log(`[Contrato] Reparo ${reparoId} — claim liberado após falha; envio segue retentável`)
338|       } catch (delErr) {
339|         console.error('[Contrato] Falha ao liberar claim do reparo:', delErr.message)
340|       }
341|     }
342|     console.error('[Contrato] Erro ao enviar contrato de reparo:', err.message)
343|   }
344| }
345| 
346| const enviarContratoObra = async (candidaturaId) => {
347|   // Ver enviarContratoReparo: claimFeito só quando ESTA execução ganhou o claim;
348|   // emailsEnviados separa "falhou antes do envio" (retentável) de "falhou depois".
349|   let claimFeito = false
350|   let emailsEnviados = false
351|   try {
352|     const result = await pool.query(
353|       `SELECT c.valor_oferta, c.mensagem_oferta,
354|               COALESCE(c.valor_contraproposta, c.valor_proposto) as valor_acordado, o.*,
355|               u_dono.nome  as dono_nome,  u_dono.email  as dono_email,
356|               u_dono.telefone  as dono_telefone,  u_dono.cpf_cnpj  as dono_cpf,
357|               u_dono.cidade  as dono_cidade,
358|               u_prest.nome as prest_nome, u_prest.email as prest_email,
359|               u_prest.telefone as prest_telefone, u_prest.cpf_cnpj as prest_cpf,
360|               u_prest.cidade as prest_cidade
361|        FROM candidaturas c
362|        JOIN obras o          ON c.obra_id    = o.id
363|        JOIN usuarios u_dono  ON o.criado_por = u_dono.id
364|        JOIN usuarios u_prest ON c.usuario_id = u_prest.id
365|        WHERE c.id = $1`,
366|       [candidaturaId]
367|     )
368|     if (result.rows.length === 0) {
369|       console.error(`[Contrato] Obra — candidatura ${candidaturaId} não encontrada (query 0 linhas) — e-mail NÃO enviado`)
370|       return
371|     }
372| 
373|     const r = result.rows[0]
374| 
375|     // Dedupe ANTES dos envios — mesmo claim atômico do reparo, chaveado por candidatura_id
376|     // (o índice único da tabela). DO NOTHING em vez do antigo DO UPDATE: linha já existente
377|     // significa contrato já enviado, então não há status a refrescar — há envio a evitar.
378|     const claim = await pool.query(
379|       `INSERT INTO contratos (candidatura_id, status, valor_acordado) VALUES ($1, 'enviado', $2)
380|        ON CONFLICT (candidatura_id) DO NOTHING
381|        RETURNING id`,
382|       [candidaturaId, r.valor_acordado ?? null]
383|     )
384|     if (claim.rows.length === 0) {
385|       console.log(`[Contrato] Obra — já existe contrato para a candidatura ${candidaturaId}, e-mail NÃO reenviado`)
386|       return
387|     }
388|     claimFeito = true
389| 
390|     const dono      = { nome: r.dono_nome,  email: r.dono_email,  telefone: r.dono_telefone,  cpf_cnpj: r.dono_cpf  }
391|     const prestador = { nome: r.prest_nome, email: r.prest_email, telefone: r.prest_telefone, cpf_cnpj: r.prest_cpf }
392|     const candidatura = { valor_acordado: r.valor_acordado }
393| 
394|     const html = gerarContratoObra({ dono, prestador, obra: r, candidatura })
395| 
396|     const dadosPDF = {
397|       // Cidade de cada parte vem do cadastro da própria parte (usuarios.cidade);
398|       // só cai para a cidade da demanda quando o cadastro está sem cidade.
399|       contratante: { ...dono, cidade: r.dono_cidade || r.cidade },
400|       contratado:  { ...prestador, cidade: r.prest_cidade || r.cidade },
401|       servico: {
402|         tipo:       r.categoria || 'pintura',
403|         descricao:  r.titulo,
404|         endereco:   r.endereco_obra || `${r.cidade}${r.bairro ? ', ' + r.bairro : ''}`,
405|         valor:      r.valor_acordado,
406|         prazo_dias: r.prazo_execucao_dias || 7,
407|         metragem:   r.metragem
408|       },
409|       marca: MARCA,
410|       cidade: r.cidade || 'Patos de Minas',
411|       data:   new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
412|     }
413| 
414|     const pdfBuffer   = await gerarContratoPDF(dadosPDF)
415|     const assunto     = `${MARCA} — Contrato de Prestação de Serviços: ${r.titulo}`
416|     const nomeArquivo = `contrato_obra_${String(r.id).substring(0, 8)}.pdf`
417|     const remetenteNome = MARCA
418| 
419|     await enviarEmailComAnexo({ para: dono.email,      assunto, html, pdfBuffer, nomeArquivo, remetenteNome })
420|     await enviarEmailComAnexo({ para: prestador.email, assunto, html, pdfBuffer, nomeArquivo, remetenteNome })
421|     console.log(`[Contrato] Obra ${r.id} — enviado para ${dono.email} e ${prestador.email}`)
422|     emailsEnviados = true
423| 
424|     // A linha em `contratos` já foi criada pelo claim acima, antes dos envios.
425| 
426|     // Marca a obra como tendo contrato enviado — só após todos os passos acima (Finding 3.2)
427|     await pool.query(`UPDATE obras SET contrato_enviado = true WHERE id = $1`, [r.id])
428|   } catch (err) {
429|     // Ver enviarContratoReparo: libera o claim só quando a falha foi ANTES do envio.
430|     if (claimFeito && !emailsEnviados) {
431|       try {
432|         await pool.query(`DELETE FROM contratos WHERE candidatura_id = $1`, [candidaturaId])
433|         console.log(`[Contrato] Obra — claim da candidatura ${candidaturaId} liberado após falha; envio segue retentável`)
434|       } catch (delErr) {
435|         console.error('[Contrato] Falha ao liberar claim da obra:', delErr.message)
436|       }
437|     }
438|     console.error('[Contrato] Erro ao enviar contrato de obra:', err.message)
439|   }
440| }
441| 
```


## 3. Verificação de profissionais e aprovação de demandas (admin)

### src/routes/index.js:4897-5230 — upload-verificacao, pendentes, aprovar (ativa assinatura), reprovar (cancela + PIX), confirmar-idoneidade, modo automático (prestadores e obras)

```js
4897| router.post('/auth/upload-verificacao', upload.single('arquivo'), async (req, res) => {
4898|   try {
4899|     if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' })
4900|     const resultado = await uploadArquivo(req.file)
4901|     // Retorna apenas a URL — o cadastro vai salvar junto com os dados do usuário
4902|     res.json({ url: resultado.secure_url })
4903|   } catch (err) {
4904|     console.error('Erro upload verificacao:', err)
4905|     res.status(500).json({ erro: 'Erro ao enviar documento' })
4906|   }
4907| })
4908| 
4909| // Lista prestadores pendentes de verificação (admin)
4910| router.get('/verificacao/pendentes', autenticar, exigirAdmin, async (req, res) => {
4911|   try {
4912|     const result = await pool.query(`
4913|       SELECT u.id, u.nome, u.email, u.telefone, u.cidade, u.cpf_cnpj,
4914|              u.verificacao_status, u.verificacao_doc_frente_url,
4915|              u.verificacao_doc_verso_url, u.verificacao_selfie_url,
4916|              u.referencias, u.pix_reembolso, u.criado_em,
4917|              u.anos_experiencia, u.tamanho_equipe,
4918|              u.rg, u.rg_orgao, u.rg_estado, u.aprovado_automaticamente,
4919|              a.plano, a.status as assinatura_status
4920|       FROM usuarios u
4921|       LEFT JOIN assinaturas a ON a.usuario_id = u.id
4922|       WHERE u.verificacao_status = 'pendente'
4923|         AND u.role IN ('prestador', 'pintor', 'assinante')
4924|       ORDER BY u.criado_em DESC
4925|     `)
4926|     // Adiciona URLs de leitura ASSINADAS ao lado das cruas (D62 passo 1). As cruas ficam —
4927|     // nada é privado ainda, então a tela atual segue funcionando com os assets públicos; a
4928|     // versão assinada acompanha o tipo de entrega da URL guardada e continuará resolvendo
4929|     // quando o passo 3 tornar os assets authenticated.
4930|     const prestadores = result.rows.map(p => ({
4931|       ...p,
4932|       verificacao_doc_frente_url_assinada: gerarUrlAssinadaVerificacao(p.verificacao_doc_frente_url),
4933|       verificacao_doc_verso_url_assinada:  gerarUrlAssinadaVerificacao(p.verificacao_doc_verso_url),
4934|       verificacao_selfie_url_assinada:     gerarUrlAssinadaVerificacao(p.verificacao_selfie_url),
4935|     }))
4936|     res.json({ prestadores })
4937|   } catch (err) {
4938|     res.status(500).json({ erro: 'Erro ao buscar pendentes' })
4939|   }
4940| })
4941| 
4942| // Aprovar prestador
4943| router.post('/verificacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
4944|   try {
4945|     const { id } = req.params
4946| 
4947|     const usuario = await pool.query(
4948|       `SELECT nome, email, tipo_prestador, tipo_dono FROM usuarios WHERE id = $1`, [id]
4949|     )
4950|     if (usuario.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })
4951| 
4952|     // Aprova verificação e ativa assinatura (revisão manual → idoneidade confirmada)
4953|     await pool.query(
4954|       `UPDATE usuarios SET verificacao_status = 'aprovado', aprovado_automaticamente = false WHERE id = $1`, [id]
4955|     )
4956|     await pool.query(
4957|       `UPDATE assinaturas SET status = 'ativa', atualizado_em = NOW(),
4958|         proximo_vencimento = CASE
4959|           WHEN tipo = 'gratuito' THEN NULL
4960|           WHEN plano = 'anual'   THEN GREATEST(proximo_vencimento, NOW() + INTERVAL '365 days')
4961|           ELSE                        GREATEST(proximo_vencimento, NOW() + INTERVAL '30 days') END,
4962|         marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL
4963|        WHERE usuario_id = $1`, [id]
4964|     )
4965| 
4966|     // Assinatura acabou de virar 'ativa' — derruba o cache para o app não cair na
4967|     // tela de pagamento por causa de um `ativa=false` ainda cacheado (B72-07).
4968|     invalidarCachesUsuario(id)
4969| 
4970|     // Notifica prestador por e-mail
4971|     const { nome, email } = usuario.rows[0]
4972|     const nodemailer = require('nodemailer')
4973|     const transporter = nodemailer.createTransport({
4974|       host: process.env.SMTP_HOST, port: 587, secure: false,
4975|       auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
4976|     })
4977|     transporter.sendMail({
4978|       from: `${MARCA} <${process.env.SMTP_USER}>`,
4979|       to: email,
4980|       subject: `✅ ${MARCA} — Cadastro aprovado! Bem-vindo!`,
4981|       html: `
4982|         <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
4983|           <div style="background: #4caf50; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
4984|             <h1 style="color: #fff; margin: 0;">✅ Cadastro Aprovado!</h1>
4985|           </div>
4986|           <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
4987|             <h2>Parabéns, ${nome}!</h2>
4988|             <p>Sua identidade foi verificada e seu acesso ao ${MARCA} está liberado.</p>
4989|             <p>Abra o aplicativo e comece a encontrar serviços na sua região agora mesmo!</p>
4990|             <p><strong>Equipe ${MARCA}</strong></p>
4991|           </div>
4992|         </div>
4993|       `
4994|     }).catch(err => console.error('Erro e-mail aprovação:', err))
4995| 
4996|     // Notificação push
4997|     const pushToken = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [id])
4998|     if (pushToken.rows[0]?.push_token) {
4999|       await enviarPushNotificacao(
5000|         pushToken.rows[0].push_token,
5001|         '✅ Cadastro aprovado!',
5002|         `Sua identidade foi verificada. Bem-vindo ao ${MARCA}!`,
5003|         { tipo: 'verificacao_aprovada' }
5004|       )
5005|     }
5006| 
5007|     res.json({ mensagem: 'Prestador aprovado com sucesso' })
5008|   } catch (err) {
5009|     res.status(500).json({ erro: 'Erro ao aprovar prestador' })
5010|   }
5011| })
5012| 
5013| // Reprovar prestador e fazer reembolso via PIX
5014| router.post('/verificacao/:id/reprovar', autenticar, exigirAdmin, async (req, res) => {
5015|   try {
5016|     const { id } = req.params
5017|     const { motivo } = req.body
5018| 
5019|     const usuario = await pool.query(
5020|       `SELECT nome, email, pix_reembolso, tipo_prestador, tipo_dono FROM usuarios WHERE id = $1`, [id]
5021|     )
5022|     if (usuario.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })
5023| 
5024|     const { nome, email, pix_reembolso } = usuario.rows[0]
5025| 
5026|     // Reprova e cancela assinatura
5027|     await pool.query(
5028|       `UPDATE usuarios SET verificacao_status = 'reprovado' WHERE id = $1`, [id]
5029|     )
5030|     await pool.query(
5031|       `UPDATE assinaturas SET status = 'cancelada', atualizado_em = NOW() WHERE usuario_id = $1`, [id]
5032|     )
5033| 
5034|     // Notifica prestador por e-mail com instrução de reembolso
5035|     const nodemailer = require('nodemailer')
5036|     const transporter = nodemailer.createTransport({
5037|       host: process.env.SMTP_HOST, port: 587, secure: false,
5038|       auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
5039|     })
5040|     transporter.sendMail({
5041|       from: `${MARCA} <${process.env.SMTP_USER}>`,
5042|       to: email,
5043|       subject: `${MARCA} — Informação sobre seu cadastro`,
5044|       html: `
5045|         <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
5046|           <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
5047|             <h1 style="color: #0a0a0a; margin: 0;">${MARCA}</h1>
5048|           </div>
5049|           <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
5050|             <h2>Olá, ${nome}</h2>
5051|             <p>Após análise, não foi possível aprovar seu cadastro no momento.</p>
5052|             ${motivo ? `<p><strong>Motivo:</strong> ${motivo}</p>` : ''}
5053|             <p style="background: #fff3cd; padding: 16px; border-radius: 8px; border-left: 4px solid #E8833A;">
5054|               <strong>Reembolso:</strong> O valor pago será devolvido para sua chave PIX 
5055|               <strong>${pix_reembolso || 'informada no cadastro'}</strong> em até 5 dias úteis.
5056|             </p>
5057|             <p>Se tiver dúvidas, entre em contato conosco respondendo este e-mail.</p>
5058|             <p><strong>Equipe ${MARCA}</strong></p>
5059|           </div>
5060|         </div>
5061|       `
5062|     }).catch(err => console.error('Erro e-mail reprovação:', err))
5063| 
5064|     // Notificação push
5065|     const pushToken = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [id])
5066|     if (pushToken.rows[0]?.push_token) {
5067|       await enviarPushNotificacao(
5068|         pushToken.rows[0].push_token,
5069|         '📋 Informação sobre seu cadastro',
5070|         'Acesse seu e-mail para mais detalhes sobre seu cadastro.',
5071|         { tipo: 'verificacao_reprovada' }
5072|       )
5073|     }
5074| 
5075|     res.json({
5076|       mensagem: 'Prestador reprovado',
5077|       pix_reembolso,
5078|       aviso: `Efetue o reembolso manualmente via PIX para a chave: ${pix_reembolso}`
5079|     })
5080|   } catch (err) {
5081|     res.status(500).json({ erro: 'Erro ao reprovar prestador' })
5082|   }
5083| })
5084| 
5085| // Confirma idoneidade de um prestador que foi auto-aprovado (limpa o flag de revisão pendente).
5086| // Não altera verificacao_status — apenas marca que um admin revisou o cadastro.
5087| router.post('/verificacao/:id/confirmar-idoneidade', autenticar, exigirAdmin, async (req, res) => {
5088|   try {
5089|     const r = await pool.query(
5090|       `UPDATE usuarios SET aprovado_automaticamente = false
5091|        WHERE id = $1 AND verificacao_status = 'aprovado'
5092|        RETURNING id`, [req.params.id]
5093|     )
5094|     if (r.rows.length === 0) return res.status(404).json({ erro: 'Prestador aprovado não encontrado' })
5095|     res.json({ mensagem: 'Idoneidade confirmada' })
5096|   } catch (err) {
5097|     res.status(500).json({ erro: 'Erro ao confirmar idoneidade' })
5098|   }
5099| })
5100| 
5101| // Modo automático — liga/desliga aprovação automática
5102| router.get('/verificacao/modo-automatico', autenticar, exigirAdmin, async (req, res) => {
5103|   try {
5104|     const result = await pool.query(
5105|       `SELECT valor FROM configuracoes WHERE chave = 'aprovacao_automatica'`
5106|     )
5107|     res.json({ ativo: result.rows[0]?.valor === 'true' })
5108|   } catch (err) {
5109|     res.status(500).json({ erro: 'Erro ao buscar configuração' })
5110|   }
5111| })
5112| 
5113| router.post('/verificacao/modo-automatico', autenticar, exigirSuperAdmin, async (req, res) => {
5114|   try {
5115|     const { ativo } = req.body
5116|     // Toggle GLOBAL: só um boolean explícito no body é instrução. Antes, chave ausente
5117|     // (ou valor não-boolean) caía no `ativo ? : 'false'` e DESLIGAVA a verificação
5118|     // automática em silêncio, respondendo "desativado" como se tivesse sido pedido.
5119|     // false explícito continua funcionando — a guarda é de tipo, não de truthiness.
5120|     if (typeof ativo !== 'boolean') {
5121|       return res.status(400).json({ erro: 'ativo é obrigatório e deve ser true ou false' })
5122|     }
5123|     await pool.query(
5124|       `UPDATE configuracoes SET valor = $1, atualizado_em = NOW() WHERE chave = 'aprovacao_automatica'`,
5125|       [ativo ? 'true' : 'false']
5126|     )
5127| 
5128|     // Se ligar modo automático, aprova todos os pendentes agora
5129|     if (ativo) {
5130|       const pendentes = await pool.query(
5131|         `SELECT u.id FROM usuarios u
5132|          JOIN assinaturas a ON a.usuario_id = u.id
5133|          WHERE u.verificacao_status = 'pendente'
5134|            AND a.status = 'pendente_verificacao'`
5135|       )
5136|       let aprovados = 0
5137|       for (const p of pendentes.rows) {
5138|         // CLAIM primeiro (mesmo padrão do cron de timeout em server.js): o
5139|         // `AND status = 'pendente_verificacao'` garante a transição UMA vez só, e o UPDATE de
5140|         // usuarios fica atrás do rowCount. Sem isso, dois toggles simultâneos (ou duas
5141|         // réplicas) reaprovariam o mesmo prestador.
5142|         const claim = await pool.query(`UPDATE assinaturas SET status = 'ativa', atualizado_em = NOW(),
5143|           proximo_vencimento = CASE
5144|             WHEN tipo = 'gratuito' THEN NULL
5145|             WHEN plano = 'anual'   THEN GREATEST(proximo_vencimento, NOW() + INTERVAL '365 days')
5146|             ELSE                        GREATEST(proximo_vencimento, NOW() + INTERVAL '30 days') END,
5147|           marco_1_em = NULL, marco_2_em = NULL, marco_3_em = NULL
5148|          WHERE usuario_id = $1 AND status = 'pendente_verificacao'
5149|          RETURNING id`, [p.id])
5150|         if (claim.rowCount === 0) continue
5151| 
5152|         // Aprovação em lote ao ligar o Modo Auto: também é não-revisada → marca automática
5153|         await pool.query(`UPDATE usuarios SET verificacao_status = 'aprovado', aprovado_automaticamente = true WHERE id = $1`, [p.id])
5154|         aprovados++
5155|       }
5156|       console.log(`[Modo automático] ${aprovados} prestadores aprovados automaticamente`)
5157|     }
5158| 
5159|     res.json({ mensagem: ativo ? 'Modo automático ativado' : 'Modo automático desativado', ativo })
5160|   } catch (err) {
5161|     res.status(500).json({ erro: 'Erro ao atualizar configuração' })
5162|   }
5163| })
5164| 
5165| // Aprovação automática de OBRAS — liga/desliga. Espelha o par acima (mesma forma de leitura
5166| // 'true', mesmo corpo { ativo }, mesma resposta). Não colide com /obras-aprovacao/:id/aprovar:
5167| // aquele tem dois segmentos após o prefixo, este tem um.
5168| router.get('/obras-aprovacao/modo-automatico', autenticar, exigirAdmin, async (req, res) => {
5169|   try {
5170|     const result = await pool.query(
5171|       `SELECT valor FROM configuracoes WHERE chave = 'aprovacao_automatica_obras'`
5172|     )
5173|     res.json({ ativo: result.rows[0]?.valor === 'true' })
5174|   } catch (err) {
5175|     res.status(500).json({ erro: 'Erro ao buscar configuração' })
5176|   }
5177| })
5178| 
5179| router.post('/obras-aprovacao/modo-automatico', autenticar, exigirSuperAdmin, async (req, res) => {
5180|   try {
5181|     const { ativo, aprovar_pendentes } = req.body
5182|     // Mesma guarda do toggle de prestadores acima: só boolean explícito é instrução;
5183|     // chave ausente/não-boolean era lida como false e desligava o modo em silêncio.
5184|     if (typeof ativo !== 'boolean') {
5185|       return res.status(400).json({ erro: 'ativo é obrigatório e deve ser true ou false' })
5186|     }
5187|     await pool.query(
5188|       `UPDATE configuracoes SET valor = $1, atualizado_em = NOW() WHERE chave = 'aprovacao_automatica_obras'`,
5189|       [ativo ? 'true' : 'false']
5190|     )
5191| 
5192|     // Ligar o modo automático só governa obras FUTURAS. A varredura retroativa da fila é
5193|     // OPT-IN por aprovar_pendentes: sem a flag nada é aprovado para trás, que é o
5194|     // comportamento de hoje. Espelha o toggle de prestadores, que aprova os pendentes na
5195|     // ativação — a diferença é que lá a varredura é implícita e aqui é pedida.
5196|     let aprovados = 0
5197|     if (ativo && aprovar_pendentes) {
5198|       const pendentes = await pool.query(
5199|         `SELECT id FROM obras WHERE enviada_por_dono = true AND status_aprovacao = 'pendente'`
5200|       )
5201|       for (const o of pendentes.rows) {
5202|         // aprovarEPublicarObra é a MESMA função da rota de aprovação do admin: mesmo UPDATE,
5203|         // mesmo reinício de publicado_em/expira_em e os mesmos dois avisos. Ela já traz a
5204|         // guarda de idempotência (status_aprovacao <> 'aprovada') e devolve null quando não
5205|         // houve transição, então contar as não-nulas dá o número REAL de aprovações.
5206|         const publicada = await aprovarEPublicarObra(o.id)
5207|         if (publicada) aprovados++
5208|       }
5209|       console.log(`[Modo automático obras] ${aprovados} obra(s) da fila aprovada(s) na ativação`)
5210|     }
5211| 
5212|     res.json({
5213|       mensagem: ativo ? 'Aprovação automática de obras ativada' : 'Aprovação automática de obras desativada',
5214|       ativo,
5215|       aprovados,
5216|     })
5217|   } catch (err) {
5218|     res.status(500).json({ erro: 'Erro ao atualizar configuração' })
5219|   }
5220| })
5221| 
5222| // ============================================================
5223| // JANELA DE LANÇAMENTO GRÁTIS (config em banco — sem Railway)
5224| // ============================================================
5225| 
5226| // Contas com acesso especial permanente — mesma leitura de EMAILS_ESPECIAIS do cadastro
5227| // (authController). NUNCA entram no backfill: seguem tipo='gratuito' para sempre.
5228| // Env ausente → lista vazia → `<> ALL('{}')` é verdadeiro para todos, ou seja, ninguém é
5229| // excluído, que é o default correto.
5230| const emailsEspeciais = () => (process.env.EMAILS_ESPECIAIS || '')
```

### src/routes/index.js:1885-1975 — notificarDonoSobreAnaliseObra, aprovarEPublicarObra (reinicia relógio), rotas aprovar/recusar obra

```js
1885| const notificarDonoSobreAnaliseObra = async (obraId, aprovada) => {
1886|   const info = await pool.query(
1887|     `SELECT u.push_token, o.titulo FROM obras o JOIN usuarios u ON o.criado_por = u.id WHERE o.id = $1`,
1888|     [obraId]
1889|   )
1890|   const { push_token, titulo } = info.rows[0] || {}
1891|   if (!push_token) return
1892|   await enviarPushNotificacao(
1893|     push_token,
1894|     aprovada ? '✅ Obra aprovada!' : '❌ Obra não aprovada',
1895|     aprovada
1896|       ? `"${titulo}" já está publicada e visível para os pintores.`
1897|       : `"${titulo}" não foi publicada desta vez. Toque para rever os detalhes e cadastrar novamente.`,
1898|     { tipo: aprovada ? 'obra_aprovada' : 'obra_recusada', obra_id: obraId }
1899|   )
1900| }
1901| 
1902| // Aprova e PUBLICA uma obra — fonte ÚNICA do efeito de aprovação. Tudo o que "publicar"
1903| // significa mora aqui: o UPDATE das duas colunas de status, o reinício de publicado_em/
1904| // expira_em e os dois avisos (broadcast aos pintores + desfecho ao dono). Quem aprova por
1905| // qualquer caminho (painel do admin ou flag de aprovação automática) chama esta função, para
1906| // que os caminhos não possam divergir.
1907| //
1908| // Aprovação PUBLICA a obra e reinicia o relógio a partir de agora: o expira_em setado na
1909| // criação correu durante a fila de aprovação, então uma obra podia ir ao ar já expirada.
1910| // publicado_em = NOW() é a âncora do ciclo de vida. COALESCE(..., 720) é obrigatório:
1911| // NOW() + NULL = NULL, e um expira_em NULL sumiria do feed e quebraria os classificadores
1912| // de histórico em JS (new Date(null)). Backfill garante que linhas antigas têm a coluna.
1913| // Guarda de idempotência (status_aprovacao <> 'aprovada'): o relógio só reinicia na
1914| // TRANSIÇÃO para aprovada. Sem ela, re-aprovar (duplo clique do admin) reiniciaria
1915| // publicado_em/expira_em — extensão grátis e backdoor no teto de vida 2x do PR2, cuja
1916| // âncora é publicado_em. Admite pendente E recusada (reaprovar rejeitada é fluxo válido);
1917| // bloqueia só quem já está aprovada. Como status e status_aprovacao são setados no mesmo
1918| // UPDATE, é impossível ficar aprovada com status ainda 'rascunho'.
1919| //
1920| // Devolve a linha atualizada na TRANSIÇÃO, ou null quando o UPDATE não mudou nada (já estava
1921| // aprovada — duplo clique do admin — ou o id não existe).
1922| const aprovarEPublicarObra = async (obraId) => {
1923|   const atualizada = await pool.query(
1924|     // Faixa "Hoje": o relógio reinicia na APROVAÇÃO (é ela que publica), então "hoje" é o dia
1925|     // em que o admin aprovou, não o dia do rascunho. Sem este CASE, aprovar uma obra "Hoje"
1926|     // reconstruiria expira_em a partir de horas_para_expirar e desfaria a regra em silêncio.
1927|     // O dia é o do DONO, não o do admin nem o do servidor: a zona sai de prazo_timezone,
1928|     // gravada no create. Sem isso, aprovar uma obra de Rio Branco resolveria o dia de SP.
1929|     `UPDATE obras SET status_aprovacao = 'aprovada', status = 'aberta',
1930|        publicado_em = NOW(),
1931|        expira_em = CASE WHEN prazo_modo = '${PRAZO_MODO_HOJE}' THEN ${sqlFimDoDia(SQL_ZONA_DA_OBRA)}
1932|                         ELSE NOW() + (COALESCE(horas_para_expirar, 720) * INTERVAL '1 hour') END
1933|      WHERE id = $1 AND status_aprovacao <> 'aprovada'
1934|      RETURNING *`, [obraId])
1935|   // Os DOIS avisos só na TRANSIÇÃO pendente/recusada → aprovada. rowCount 0 significa que o
1936|   // UPDATE não mudou nada: reavisar o dono seria ruído, e rebroadcastar aos pintores
1937|   // anunciaria como "nova" uma obra publicada dias atrás, para até 500 pessoas de uma vez.
1938|   if (atualizada.rowCount === 0) return null
1939|   notificarPintoresSobreNovaObra(obraId).catch(err => console.error('Erro notificar pintores:', err))
1940|   notificarDonoSobreAnaliseObra(obraId, true)
1941|     .catch(err => console.error('Erro notificar dono (obra aprovada):', err.message))
1942|   return atualizada.rows[0]
1943| }
1944| 
1945| router.post('/obras-aprovacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
1946|   try {
1947|     await aprovarEPublicarObra(req.params.id)
1948|     res.json({ mensagem: 'Obra aprovada e publicada!' })
1949|   } catch (err) {
1950|     res.status(500).json({ erro: 'Erro ao aprovar obra' })
1951|   }
1952| })
1953| 
1954| router.post('/obras-aprovacao/:id/recusar', autenticar, exigirAdmin, async (req, res) => {
1955|   try {
1956|     // Guarda de idempotência espelhando a da aprovação: sem ela, reprocessar uma recusa
1957|     // (duplo clique do admin) reavisaria o dono de uma decisão que ele já recebeu.
1958|     const atualizada = await pool.query(
1959|       // encerrado_em marca o início dos 7 dias de retenção de mídia (ver deletarMidiasAntigas):
1960|       // obra recusada também carrega mídia, e sem esta coluna o job nunca a enxerga.
1961|       // COALESCE preserva a data de um encerramento anterior em vez de reiniciar a contagem.
1962|       `UPDATE obras SET status_aprovacao = 'recusada', status = 'cancelada',
1963|               encerrado_em = COALESCE(encerrado_em, NOW())
1964|         WHERE id = $1 AND status_aprovacao <> 'recusada'
1965|         RETURNING id`, [req.params.id])
1966|     res.json({ mensagem: 'Obra recusada' })
1967|     if (atualizada.rowCount > 0) {
1968|       notificarDonoSobreAnaliseObra(req.params.id, false)
1969|         .catch(err => console.error('Erro notificar dono (obra recusada):', err.message))
1970|     }
1971|   } catch (err) {
1972|     res.status(500).json({ erro: 'Erro ao recusar obra' })
1973|   }
1974| })
1975| 
```

### src/routes/index.js:3203-3300 — Fila de aprovação de reparo: listar, aprovar (GREATEST no expira_em), recusar (idempotente)

```js
3203| router.get('/reparos/aprovacao', autenticar, exigirAdmin, async (req, res) => {
3204|   try {
3205|     const { page, limit, offset } = paginacaoAdmin(req.query)
3206| 
3207|     const result = await pool.query(
3208|       `SELECT r.*, u.nome as dono_nome, u.email as dono_email, u.telefone as dono_telefone
3209|        FROM reparos r JOIN usuarios u ON r.criado_por = u.id
3210|        WHERE r.status_aprovacao = 'pendente' ORDER BY r.criado_em DESC
3211|        LIMIT $1 OFFSET $2`,
3212|       [limit, offset]
3213|     )
3214|     res.json({ reparos: result.rows, page, limit })
3215|   } catch (err) {
3216|     res.status(500).json({ erro: 'Erro ao buscar reparos' })
3217|   }
3218| })
3219| 
3220| // Espelho de notificarDonoSobreAnaliseObra (D77): o dono do reparo passa a saber do desfecho
3221| // da análise, como o dono de obra já sabia. Mesmo formato; muda só o substantivo e a chave.
3222| const notificarDonoSobreAnaliseReparo = async (reparoId, aprovada) => {
3223|   const info = await pool.query(
3224|     `SELECT u.push_token, r.titulo FROM reparos r JOIN usuarios u ON r.criado_por = u.id WHERE r.id = $1`,
3225|     [reparoId]
3226|   )
3227|   const { push_token, titulo } = info.rows[0] || {}
3228|   if (!push_token) return
3229|   await enviarPushNotificacao(
3230|     push_token,
3231|     aprovada ? '✅ Serviço aprovado!' : '❌ Serviço não aprovado',
3232|     aprovada
3233|       ? `"${titulo}" já está publicado e visível para os prestadores.`
3234|       : `"${titulo}" não foi publicado desta vez. Toque para rever os detalhes e cadastrar novamente.`,
3235|     { tipo: aprovada ? 'reparo_aprovado' : 'reparo_recusado', reparo_id: reparoId }
3236|   )
3237| }
3238| 
3239| router.post('/reparos/aprovacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
3240|   try {
3241|     // Guarda de TRANSICAO, igual a de obras (ver POST /obras-aprovacao/:id/aprovar): o aviso
3242|     // so sai quando a linha REALMENTE saiu de pendente/recusada para aprovada. rowCount 0
3243|     // significa que o UPDATE nao mudou nada — reaprovar um reparo ja aprovado anunciaria
3244|     // como "novo" um item publicado dias atras, para ate 500 pessoas de uma vez. Sem esta
3245|     // clausula WHERE o UPDATE casava a linha toda vez e o rebroadcast era so uma questao de
3246|     // alguem clicar duas vezes.
3247|     //
3248|     // expira_em reiniciado na aprovação (D77 — espelho de aprovarEPublicarObra): o relógio
3249|     // gravado na criação correu enquanto o reparo esteve fora do ar (recusado/pendente), e
3250|     // sem isto ele voltava ao feed já vencido ou com o prazo gasto. Mesmo CASE da faixa
3251|     // "Hoje" do create de reparo (SQL_FIM_DO_DIA_SP) e mesmo COALESCE(..., 720) do cron.
3252|     // GREATEST(expira_em, ...) — mesma forma de chegada-prevista/responder (expira_em =
3253|     // GREATEST(expira_em, chegada_pendente_em)): a aprovação nunca ENCURTA um prazo que
3254|     // ainda está valendo; só empurra para frente o que já venceu ou venceria antes.
3255|     // Sem publicado_em: reparo publica na criação, então criado_em já é a âncora que
3256|     // publicado_em é para a obra, e nada no lado reparo lê uma âncora de publicação
3257|     // (a carência de /estender usa criado_em; o advisory é constante).
3258|     const atualizado = await pool.query(
3259|       `UPDATE reparos SET status_aprovacao = 'aprovada', status = 'aberta',
3260|          expira_em = GREATEST(expira_em,
3261|            CASE WHEN prazo_modo = '${PRAZO_MODO_HOJE}' THEN ${sqlFimDoDia(SQL_ZONA_DO_REPARO)}
3262|                 ELSE NOW() + (COALESCE(prazo_atendimento_horas, 720) * INTERVAL '1 hour') END)
3263|         WHERE id = $1 AND status_aprovacao IS DISTINCT FROM 'aprovada'`,
3264|       [req.params.id]
3265|     )
3266|     res.json({ mensagem: 'Reparo aprovado e publicado!' })
3267|     if (atualizado.rowCount === 0) return
3268|     notificarPrestadoresSobreNovoReparo(req.params.id).catch(err => console.error('Erro notificar prestadores:', err))
3269|     // Desfecho ao dono só na TRANSIÇÃO, como no lado obra.
3270|     notificarDonoSobreAnaliseReparo(req.params.id, true)
3271|       .catch(err => console.error('Erro notificar dono (reparo aprovado):', err.message))
3272|   } catch (err) {
3273|     res.status(500).json({ erro: 'Erro ao aprovar reparo' })
3274|   }
3275| })
3276| 
3277| router.post('/reparos/aprovacao/:id/recusar', autenticar, exigirAdmin, async (req, res) => {
3278|   try {
3279|     // Guarda de idempotência espelhando POST /obras-aprovacao/:id/recusar (D77): sem ela,
3280|     // reprocessar uma recusa (duplo clique do admin) reavisaria o dono de uma decisão que
3281|     // ele já recebeu. IS DISTINCT FROM é a forma NULL-safe do <> da obra, a mesma que o
3282|     // aprovar acima já usa.
3283|     // encerrado_em: idem ao lado obra — reparo recusado guarda mídia e sem esta coluna o
3284|     // deletarMidiasAntigas nunca o alcança. COALESCE preserva a data de um encerramento anterior.
3285|     const atualizado = await pool.query(
3286|       `UPDATE reparos SET status_aprovacao = 'recusada', status = 'cancelada',
3287|               encerrado_em = COALESCE(encerrado_em, NOW())
3288|         WHERE id = $1 AND status_aprovacao IS DISTINCT FROM 'recusada'
3289|         RETURNING id`, [req.params.id])
3290|     res.json({ mensagem: 'Reparo recusado' })
3291|     if (atualizado.rowCount > 0) {
3292|       notificarDonoSobreAnaliseReparo(req.params.id, false)
3293|         .catch(err => console.error('Erro notificar dono (reparo recusado):', err.message))
3294|     }
3295|   } catch (err) {
3296|     res.status(500).json({ erro: 'Erro ao recusar reparo' })
3297|   }
3298| })
3299| 
3300| router.get('/reparos/admin', autenticar, exigirAdmin, async (req, res) => {
```


## 4. Ciclo de vida — lado OBRA

### src/routes/index.js:1791-1860 — POST /obras/dono: criação (limite, geocodificação, faixa Hoje/zona, idempotência)

```js
1791| router.post('/obras/dono', autenticar, async (req, res) => {
1792|   try {
1793|     if (req.usuario.role !== 'dono_obra' && req.usuario.role !== 'admin') {
1794|       return res.status(403).json({ erro: 'Apenas donos de obra podem cadastrar obras' })
1795|     }
1796|     const { titulo, categoria, valor, cidade, bairro, uf, metragem, prazo_execucao_dias, horas_para_expirar, descricao, tags, endereco_obra, ponto_referencia, latitude, longitude, client_request_id } = req.body
1797|     // Antes de qualquer trabalho (geocoding, ufDeCidade): recusar cedo não gasta rede à toa.
1798|     const limiteObras = await limiteDemandasAtingido('obras', req.usuario.id, client_request_id)
1799|     if (limiteObras.atingido) {
1800|       return res.status(409).json(erroLimiteDemandas(limiteObras.limite))
1801|     }
1802|     const ufFinal = uf || await ufDeCidade(cidade)  // rede de segurança: deriva uf da cidade
1803|     const { lat: latFinal, lng: lngFinal, origem: coordOrigem } = resolverCoordenadas(cidade, ufFinal, latitude, longitude, '[obras/dono]')
1804|     // Janela original resolvida UMA vez: mesma base do expira_em e do horas_para_expirar gravado,
1805|     // sem risco de os dois divergirem. publicado_em fica NULL — obra nasce 'rascunho', só publica
1806|     // na aprovação. Validação do input segue DEFERIDA (não mexer nos creates).
1807|     const horasExpiracao = horas_para_expirar || 720
1808|     const expira_em = new Date(Date.now() + horasExpiracao * 3600 * 1000)
1809|     // Faixa "Hoje" (prazo_modo='hoje'): expira_em é o FIM DO DIA na zona DO USUÁRIO, não
1810|     // publicação + N horas. NULL/ausente = faixa por duração, exatamente como antes.
1811|     const prazoModo = req.body?.prazo_modo === PRAZO_MODO_HOJE ? PRAZO_MODO_HOJE : null
1812|     // Zona só importa no ramo 'hoje' — nas outras faixas nem consulta o banco.
1813|     // Três recuos, todos para TZ_PADRAO e NUNCA para a faixa por duração: o cliente omite
1814|     // `timezone` de propósito quando o aparelho não sabe dizer a zona, e nesse caso ele ainda
1815|     // pediu "Hoje". Cair na faixa de horas seria entregar outra coisa; recusar o request seria
1816|     // pior ainda. O valor RESOLVIDO é gravado, então os caminhos que reconstroem não precisam
1817|     // repetir a validação.
1818|     const prazoZona = prazoModo ? await resolverZonaCliente(req.body?.timezone) : null
1819|     // ON CONFLICT no índice parcial (criado_por, client_request_id): retries com a mesma chave
1820|     // retornam a obra já criada em vez de inserir duplicata. Sem chave (NULL) → insert normal.
1821|     //
1822|     // O CASE existe para que SÓ o ramo 'hoje' mude: as outras faixas continuam gravando o
1823|     // $10 calculado no Node acima, byte a byte o que gravavam antes. O ramo 'hoje' é resolvido
1824|     // no POSTGRES — o container roda em UTC e um new Date() daria o DIA errado nas horas finais
1825|     // do dia local (mesmo motivo documentado em JANELAS_CHEGADA).
1826|     // A zona entra como PARÂMETRO ($21), nunca interpolada: o valor vem do cliente.
1827|     const result = await pool.query(
1828|       `INSERT INTO obras (criado_por, titulo, categoria, valor, cidade, bairro, uf, metragem, prazo_execucao_dias, expira_em, descricao, tags, endereco_obra, ponto_referencia, latitude, longitude, coordenadas_origem, status, enviada_por_dono, status_aprovacao, client_request_id, horas_para_expirar, prazo_modo, prazo_timezone)
1829|        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
1830|                CASE WHEN $20::text = '${PRAZO_MODO_HOJE}' THEN ${sqlFimDoDia('$21::text')} ELSE $10::timestamptz END,
1831|                $11,$12,$13,$14,$15,$16,$17,'rascunho',true,'pendente',$18,$19,$20,$21)
1832|        ON CONFLICT (criado_por, client_request_id) WHERE client_request_id IS NOT NULL
1833|        DO UPDATE SET client_request_id = EXCLUDED.client_request_id
1834|        RETURNING *`,
1835|       [req.usuario.id, titulo, categoria, valor, cidade, bairro, ufFinal, metragem, prazo_execucao_dias, expira_em.toISOString(), descricao, tags || [], endereco_obra, ponto_referencia, latFinal, lngFinal, coordOrigem, client_request_id || null, horasExpiracao, prazoModo, prazoZona]
1836|     )
1837|     let obra = result.rows[0]
1838|     // Aprovação automática de obras (flag global em configuracoes, default 'false' = OFF).
1839|     // Ligada, publica na hora pela MESMA função da rota de aprovação do admin — mesmo UPDATE,
1840|     // mesmo reinício de relógio, mesmos avisos. Responde com a linha já publicada para o app
1841|     // não exibir "em análise" uma obra que acabou de ir ao ar.
1842|     // try/catch local de propósito: a obra JÁ existe: uma falha na publicação automática não
1843|     // pode virar 500 e mascarar a criação. Degrada para 'pendente' — a fila manual de hoje.
1844|     try {
1845|       const cfgAuto = await pool.query(`SELECT valor FROM configuracoes WHERE chave = 'aprovacao_automatica_obras'`)
1846|       if (cfgAuto.rows[0]?.valor === 'true') {
1847|         const publicada = await aprovarEPublicarObra(obra.id)
1848|         if (publicada) obra = publicada
1849|       }
1850|     } catch (err) {
1851|       console.error('[obras/dono] aprovacao automatica falhou:', err.message)
1852|     }
1853|     res.status(201).json(obra)
1854|   } catch (err) {
1855|     console.error('[obras/dono]', err.message)
1856|     res.status(500).json({ erro: 'Erro ao cadastrar obra' })
1857|   }
1858| })
1859| 
1860| router.get('/obras-aprovacao', autenticar, exigirAdmin, async (req, res) => {
```

### src/controllers/obrasController.js:1-60 — GET /obras: feed do pintor (filtros de status, expiração, match, bloqueios)

```js
 1| const { pool } = require('../utils/supabase')
 2| const { notificarNovaObra } = require('../services/notificacaoService')
 3| const { ufDeCidade } = require('../utils/localidade')
 4| const { resolverBusca, montarFiltroGeo } = require('../utils/geoBusca')
 5| 
 6| const listar = async (req, res) => {
 7|   try {
 8|     const { categoria, raio_km, lat, lng, page = 1, limit = 20 } = req.query
 9|     const offset = (parseInt(page) - 1) * parseInt(limit)
10| 
11|     let query = `
12|       SELECT o.id, o.titulo, o.categoria, o.valor, o.cidade, o.estado, o.bairro, o.uf,
13|              o.latitude, o.longitude, o.coordenadas_origem,
14|              o.metragem, o.prazo_execucao_dias, o.expira_em, o.tags, o.status,
15|              0 as distancia_metros,
16|              (SELECT COUNT(*) FROM midias WHERE obra_id = o.id) as total_midias,
17|              (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_candidaturas,
18|              (SELECT url FROM midias WHERE obra_id = o.id ORDER BY (url LIKE '%/video/upload/%'), ordem LIMIT 1) as foto_capa
19|       FROM obras o
20|       WHERE o.status = 'aberta'
21|       AND o.status_aprovacao = 'aprovada'
22|       AND o.expira_em > NOW()
23|       AND o.match_usuario_id IS NULL
24|       -- Lista negra desta obra: pintor que já teve um match desfeito aqui não vê o card de
25|       -- novo. Mesma expressão do feed de reparos (index.js, GET /reparos). Fica na BASE do
26|       -- WHERE, antes de qualquer filtro dinâmico, para valer em todos os modos de busca.
27|       AND NOT ($1::uuid = ANY(COALESCE(o.prestadores_bloqueados, '{}')))
28|       AND NOT EXISTS (
29|         SELECT 1 FROM prestadores_bloqueados_dono pb
30|         WHERE pb.dono_id = o.criado_por AND pb.prestador_id = $1
31|       )
32|       -- Obra que este pintor já recusou não volta ao feed: o card ficava visível mas
33|       -- POST /obras/:id/candidatura rejeita com 409 (guarda de duplicidade), então era
34|       -- um card em que ele não podia mais agir. Fica na BASE do WHERE, antes de qualquer
35|       -- filtro dinâmico, para valer em todos os modos (cidade, raio, estado e sem
36|       -- recorte). Só 'recusado' — pendente/contraproposta_dono/aceito seguem iguais.
37|       AND NOT EXISTS (
38|         SELECT 1 FROM candidaturas c
39|         WHERE c.obra_id = o.id AND c.usuario_id = $1 AND c.status = 'recusado'
40|       )
41|     `
42|     // $1 reservado para o usuario_id (filtro de bloqueio global por dono)
43|     const params = [req.usuario.id]
44| 
45|     if (categoria && categoria !== 'todas') {
46|       params.push(categoria)
47|       query += ` AND o.categoria = $${params.length}`
48|     }
49| 
50|     // Mesmo resolvedor compartilhado de /reparos (geoBusca): âncora e escopo separados,
51|     // e nenhum caminho degrada para "país inteiro". 'estado' e 'pais' seguem inalterados.
52|     // Sem raio_km a busca não tem recorte (comportamento de hoje, preservado): o metadado
53|     // reporta 'pais' porque é o que de fato acontece — o app sempre envia raio_km.
54|     let filtroMeta = { modo: raio_km || null, aplicado: (!raio_km || raio_km === 'pais') ? 'pais' : raio_km, degradado: false, motivo: null }
55|     let escopo = null
56|     let ancora = null
57| 
58|     const modoGeo = (raio_km === 'cidade' && req.usuario?.id) ? 'cidade'
59|       : (raio_km && raio_km !== 'pais' && raio_km !== 'estado' && !isNaN(parseFloat(raio_km))) ? 'raio'
60|       : null
```

### src/routes/index.js:1976-2073 — GET /obras (rota), /obras/admin, rotas admin, DELETE /obras/dono/:id (cancelar; 409 com pintor casado)

```js
1976| router.get('/obras', autenticar, exigirNaoSuspenso, exigirAssinaturaAtiva, exigirPintor, async (req, res) => {
1977|   try {
1978|     const { page, limit, offset } = paginacaoAdmin(req.query)
1979|     req.query.page  = page
1980|     req.query.limit = limit
1981|     req.query.offset = offset
1982|     return obrasCtrl.listar(req, res)
1983|   } catch (err) {
1984|     res.status(500).json({ erro: 'Erro ao buscar obras' })
1985|   }
1986| })
1987| 
1988| // Painel admin — lista obras por situação (finalizadas / canceladas-expiradas).
1989| // O GET /obras público só devolve obras abertas/aprovadas/não expiradas, então o
1990| // painel precisa deste endpoint para enxergar o histórico de obras encerradas e
1991| // canceladas. "Expirada" não é um status no banco: é uma obra ainda 'aberta' cujo
1992| // expira_em já passou — por isso o filtro 'canceladas' inclui esse caso.
1993| router.get('/obras/admin', autenticar, exigirAdmin, async (req, res) => {
1994|   try {
1995|     const filtro = req.query.filtro || 'finalizadas'
1996|     let where
1997|     if (filtro === 'finalizadas') {
1998|       where = `o.status = 'encerrada'`
1999|     } else if (filtro === 'canceladas') {
2000|       where = `(o.status IN ('cancelada', 'expirada') OR (o.status = 'aberta' AND o.expira_em <= NOW()))`
2001|     } else {
2002|       return res.status(400).json({ erro: 'Filtro inválido' })
2003|     }
2004|     const result = await pool.query(`
2005|       SELECT o.id, o.titulo, o.categoria, o.valor, o.cidade, o.uf, o.bairro,
2006|              o.metragem, o.prazo_execucao_dias, o.expira_em, o.tags, o.status,
2007|              (o.status = 'aberta' AND o.expira_em <= NOW()) AS expirada,
2008|              (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) AS total_candidaturas
2009|       FROM obras o
2010|       WHERE ${where}
2011|       ORDER BY o.expira_em DESC NULLS LAST, o.id DESC
2012|       LIMIT 200
2013|     `)
2014|     res.json({ obras: result.rows })
2015|   } catch (err) {
2016|     console.error('Erro ao listar obras (admin):', err)
2017|     res.status(500).json({ erro: 'Erro ao buscar obras' })
2018|   }
2019| })
2020| 
2021| router.post('/obras',       autenticar, exigirAdmin, obrasCtrl.criar)
2022| router.put('/obras/:id',    autenticar, exigirSuperAdmin, obrasCtrl.editar)
2023| router.delete('/obras/:id', autenticar, exigirSuperAdmin, obrasCtrl.encerrar)
2024| 
2025| // Dono pode excluir sua própria obra
2026| router.delete('/obras/dono/:id', autenticar, async (req, res) => {
2027|   try {
2028|     const obra = await pool.query(`SELECT id, match_usuario_id FROM obras WHERE id = $1 AND criado_por = $2`, [req.params.id, req.usuario.id])
2029|     if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
2030|     // Mesma guarda de DELETE /reparos/dono/:id (D72): com pintor casado, cancelar deixava a
2031|     // candidatura 'aceito', o contrato já enviado e o match preso numa obra 'cancelada' — sem
2032|     // push ao pintor e sem cron que desfizesse (todos exigem status = 'aberta'). A saída do
2033|     // dono continua sendo POST /obras/:id/expirar-match, que desfaz o match avisando os dois.
2034|     if (obra.rows[0].match_usuario_id) return res.status(409).json({ erro: 'Não é possível excluir uma obra com pintor a caminho' })
2035|     // encerrado_em: mesmo motivo do recusar acima — libera a obra cancelada para a limpeza
2036|     // de mídia depois de 7 dias. COALESCE não reinicia contagem já iniciada.
2037|     await pool.query(`UPDATE obras SET status = 'cancelada', status_aprovacao = 'cancelada',
2038|       encerrado_em = COALESCE(encerrado_em, NOW()) WHERE id = $1`, [req.params.id])
2039|     res.json({ mensagem: 'Obra removida com sucesso' })
2040|   } catch (err) {
2041|     res.status(500).json({ erro: 'Erro ao remover obra' })
2042|   }
2043| })
2044| 
2045| // Ponto de referência — a ÚNICA edição de demanda aberta ao dono. Até aqui o campo era
2046| // write-once no create (nem o PUT /obras/:id do admin o aceita), e é o que o profissional lê
2047| // para achar o lugar ("portão azul ao lado da padaria").
2048| //
2049| // Regras compartilhadas pelas duas verticais numa função só, de propósito: obra e reparo
2050| // divergirem em validação é um erro recorrente neste código.
2051| //   ausente   -> 400. Corpo vazio por engano não pode APAGAR a referência.
2052| //   null / '' -> NULL, que é o "limpar" explícito.
2053| //   > 200     -> 400. Referência maior que isso não é referência; também limita o campo como
2054| //                canal de texto livre para o profissional casado.
2055| const LIMITE_PONTO_REFERENCIA = 200
2056| const normalizarPontoReferencia = (bruto) => {
2057|   if (bruto === undefined) return { erro: 'Informe ponto_referencia' }
2058|   if (bruto !== null && typeof bruto !== 'string') return { erro: 'ponto_referencia deve ser texto' }
2059|   const texto = (bruto ?? '').trim()
2060|   if (texto.length > LIMITE_PONTO_REFERENCIA) {
2061|     return { erro: `ponto_referencia deve ter no máximo ${LIMITE_PONTO_REFERENCIA} caracteres` }
2062|   }
2063|   return { valor: texto === '' ? null : texto }
2064| }
2065| 
2066| // PATCH /obras/dono/:id/ponto-referencia
2067| // Segue permitido DEPOIS do match de propósito: o campo serve para o profissional chegar ao
2068| // local, então é justamente na ida dele que corrigir a referência importa. É seguro porque o
2069| // contrato NÃO carrega ponto_referencia (contratosController renderiza endereco_obra), então
2070| // editar aqui não mexe em nada já acordado — e o campo só é revelado a dono, casado, aceito e
2071| // admin, então a edição chega exatamente a quem precisa dela.
2072| // SÓ ponto_referencia entra: o corpo nunca é espalhado. valor, endereço, coordenadas, status e
2073| // prazos têm caminhos próprios (estender, aprovar, encerrar) e não podem virar editáveis aqui.
```

### src/controllers/obrasController.js:255-290 — DELETE /obras/:id (encerramento pelo painel)

```js
255| 
256| const encerrar = async (req, res) => {
257|   try {
258|     // Verifica se a obra existe antes de encerrar
259|     const existe = await pool.query(`SELECT id FROM obras WHERE id = $1`, [req.params.id])
260|     if (existe.rows.length === 0) {
261|       return res.status(404).json({ erro: 'Obra não encontrada' })
262|     }
263| 
264|     // encerrado_em é o relógio de que deletarMidiasAntigas depende (o job exige
265|     // encerrado_em IS NOT NULL): sem ele, obra encerrada por aqui guardava as mídias no
266|     // Cloudinary para sempre, ao contrário das encerradas pelo fluxo de duas mãos e pelo
267|     // cron de auto-encerramento, que já o preenchem.
268|     // COALESCE e não NOW() puro: este UPDATE não tem guarda de status, então reencerrar uma
269|     // obra já encerrada reiniciaria a contagem de 7 dias do zero.
270|     // Mesmo estado final de POST /obras/:id/encerrar (D85): status_aprovacao='encerrada'
271|     // (sem isso a obra ficava 'encerrada' com status_aprovacao 'aprovada', única linha assim
272|     // entre as encerradas) e limpeza de encerramento_solicitado_* (senão uma solicitação do
273|     // pintor ficava pendurada numa obra já fechada). encerrado_em segue COALESCE — este
274|     // caminho não tem o no-op idempotente do /encerrar, então reencerrar não pode reiniciar
275|     // os 7 dias de retenção de mídia.
276|     const result = await pool.query(
277|       `UPDATE obras SET status = 'encerrada', status_aprovacao = 'encerrada',
278|               encerrado_em = COALESCE(encerrado_em, NOW()),
279|               encerramento_solicitado_por = NULL, encerramento_solicitado_em = NULL
280|         WHERE id=$1 RETURNING id, titulo, status`,
281|       [req.params.id]
282|     )
283|     res.json(result.rows[0])
284|   } catch (err) {
285|     console.error('Erro ao encerrar obra:', err)
286|     res.status(500).json({ erro: 'Erro ao encerrar obra' })
287|   }
288| }
289| 
290| module.exports = { listar, detalhe, criar, editar, encerrar }
```
