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
const { enviarPushNotificacao, notificarPintoresSobreNovaObra, notificarPrestadoresSobreNovoReparo } = require('../services/alertaService')
const { ufDeCidade } = require('../utils/localidade')
const { enviarContratoReparo, enviarContratoObra } = require('../controllers/contratosController')
const bcrypt = require('bcryptjs')
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
    // Flag global "Modo Auto" — garante a existência da linha (tabela já existe em prod).
    // Default 'false' = OFF: novos prestadores aguardam revisão manual do admin.
    await client.query(`CREATE TABLE IF NOT EXISTS configuracoes (chave TEXT PRIMARY KEY, valor TEXT, atualizado_em TIMESTAMPTZ DEFAULT NOW())`)
    await client.query(`INSERT INTO configuracoes (chave, valor)
                        SELECT 'aprovacao_automatica', 'false'
                        WHERE NOT EXISTS (SELECT 1 FROM configuracoes WHERE chave = 'aprovacao_automatica')`)
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
    await client.query(`CREATE INDEX IF NOT EXISTS obras_feed_idx ON obras (status, expira_em)`)
    // Backfill do uf: linhas antigas têm cidade preenchida mas uf NULL, então sumiam do
    // filtro "Estado" (o.uf/r.uf) mesmo aparecendo em "Cidade". Cidades conhecidas e
    // inequívocas (todas em MG). Idempotente via WHERE uf IS NULL.
    await client.query(`UPDATE obras   SET uf = 'MG' WHERE uf IS NULL AND cidade = 'Patos de Minas'`)
    await client.query(`UPDATE reparos SET uf = 'MG' WHERE uf IS NULL AND cidade IN ('Patos de Minas', 'Formiga')`)
    // Limpeza de linhas órfãs deixadas por exclusões antigas que falhavam no meio da
    // transação (ver B72-01). Uma assinatura órfã (usuario_id de usuário já apagado)
    // não afeta o novo cadastro do mesmo CPF — ele recebe novo id — mas suja relatórios
    // e a base. Idempotente: só apaga o que não tem usuário correspondente.
    await client.query(`DELETE FROM assinaturas a WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = a.usuario_id)`)
    await client.query(`DELETE FROM localizacoes_prestadores lp WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = lp.usuario_id)`)
    await client.query('COMMIT')
    console.log('[migration] colunas verificadas com sucesso')
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    console.error('[migration] FALHOU — rollback executado:', err.message)
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
      `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' LIMIT 1`,
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

// ============================================================
// STATS PÚBLICOS (sem auth)
// ============================================================
router.get('/stats/publico', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE((SELECT SUM(valor_estimado) FROM reparos WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()), 0)
        + COALESCE((SELECT SUM(valor) FROM obras WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()), 0) AS total_valor,
        (SELECT COUNT(*) FROM reparos WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW())
        + (SELECT COUNT(*) FROM obras WHERE status = 'aberta' AND status_aprovacao = 'aprovada' AND expira_em > NOW()) AS total_ativas
    `)
    const row = result.rows[0]
    res.json({
      total_valor_obras: parseFloat(row.total_valor) || 0,
      total_obras_ativas: parseInt(row.total_ativas) || 0
    })
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
router.delete('/usuarios/:id', autenticar, exigirAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    const { id } = req.params
    if (id === req.usuario.id) return res.status(400).json({ erro: 'Não é possível excluir sua própria conta' })

    const usuario = await client.query('SELECT id, role FROM usuarios WHERE id = $1', [id])
    if (usuario.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' })
    if (usuario.rows[0].role === 'admin') return res.status(400).json({ erro: 'Não é possível excluir um administrador' })

    await client.query('BEGIN')

    // Cascade obras criadas por este usuário (dono_obra)
    const obrasRes = await client.query('SELECT id FROM obras WHERE criado_por = $1', [id])
    if (obrasRes.rows.length > 0) {
      const obraIds = obrasRes.rows.map(r => r.id)
      await client.query('DELETE FROM mensagens WHERE obra_id = ANY($1::uuid[])', [obraIds])
      await client.query(
        'DELETE FROM negociacoes WHERE candidatura_id IN (SELECT id FROM candidaturas WHERE obra_id = ANY($1::uuid[]))',
        [obraIds]
      )
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
    await client.query(
      'DELETE FROM negociacoes WHERE candidatura_id IN (SELECT id FROM candidaturas WHERE usuario_id = $1)',
      [id]
    )
    await client.query('DELETE FROM assinaturas WHERE usuario_id = $1', [id])
    await client.query('DELETE FROM candidaturas WHERE usuario_id = $1', [id])
    await client.query('DELETE FROM mensagens WHERE autor_id = $1', [id])
    await client.query('DELETE FROM interesse_reparos WHERE usuario_id = $1', [id])
    await client.query('DELETE FROM negociacoes WHERE autor_id = $1', [id])
    // localizacoes_prestadores tem FK para usuarios (sem CASCADE) — todo prestador que
    // já compartilhou GPS tem linha aqui. Se não apagar, o DELETE FROM usuarios abaixo
    // estoura violação de FK e a transação INTEIRA sofre ROLLBACK, desfazendo inclusive
    // o DELETE da assinatura acima e deixando uma assinatura órfã/desatualizada (B72-01).
    await client.query('DELETE FROM localizacoes_prestadores WHERE usuario_id = $1', [id])
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
        (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_interessados,
        (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id AND status = 'pendente') as candidaturas_pendentes,
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) as foto_capa,
        (SELECT COALESCE(c.valor_contraproposta, c.valor_proposto)
           FROM candidaturas c
          WHERE c.obra_id = o.id AND c.usuario_id = o.match_usuario_id
          LIMIT 1) as valor_acordado
       FROM obras o WHERE o.criado_por = $1 AND o.status != 'cancelada' ORDER BY o.criado_em DESC
       LIMIT $2 OFFSET $3`,
      [req.usuario.id, limit, offset]
    )
    const agora = new Date()
    const eArquivada = o => o.status === 'encerrada' || (o.status === 'aberta' && o.expira_em && new Date(o.expira_em) < agora)
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
              u.nome AS dono_nome, u.telefone AS dono_telefone,
              (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) AS foto_capa,
              COALESCE(c.valor_contraproposta, c.valor_proposto) AS valor_acordado
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
              u.nome AS prestador_nome, u.telefone AS prestador_telefone,
              u.logradouro, u.numero, u.bairro,
              (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) AS foto_capa,
              COALESCE(c.valor_contraproposta, c.valor_proposto) AS valor_acordado
       FROM obras o
       JOIN usuarios u ON o.match_usuario_id = u.id
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
    const expira_em = new Date(Date.now() + (horas_para_expirar || 720) * 3600 * 1000)
    // ON CONFLICT no índice parcial (criado_por, client_request_id): retries com a mesma chave
    // retornam a obra já criada em vez de inserir duplicata. Sem chave (NULL) → insert normal.
    const result = await pool.query(
      `INSERT INTO obras (criado_por, titulo, categoria, valor, cidade, bairro, uf, metragem, prazo_execucao_dias, expira_em, descricao, tags, endereco_obra, latitude, longitude, status, enviada_por_dono, status_aprovacao, client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'rascunho',true,'pendente',$16)
       ON CONFLICT (criado_por, client_request_id) WHERE client_request_id IS NOT NULL
       DO UPDATE SET client_request_id = EXCLUDED.client_request_id
       RETURNING *`,
      [req.usuario.id, titulo, categoria, valor, cidade, bairro, ufFinal, metragem, prazo_execucao_dias, expira_em.toISOString(), descricao, tags || [], endereco_obra, latitude, longitude, client_request_id || null]
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
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) as foto_capa
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

router.post('/obras-aprovacao/:id/aprovar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE obras SET status_aprovacao = 'aprovada', status = 'aberta' WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Obra aprovada e publicada!' })
    notificarPintoresSobreNovaObra(req.params.id).catch(err => console.error('Erro notificar pintores:', err))
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao aprovar obra' })
  }
})

router.post('/obras-aprovacao/:id/recusar', autenticar, exigirAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE obras SET status_aprovacao = 'recusada', status = 'cancelada' WHERE id = $1`, [req.params.id])
    res.json({ mensagem: 'Obra recusada' })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao recusar obra' })
  }
})

router.get('/obras', autenticar, exigirAssinaturaAtiva, async (req, res) => {
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

router.get('/obras/:id', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*,
        (SELECT COUNT(*) FROM candidaturas WHERE obra_id = o.id) as total_candidaturas,
        (SELECT url FROM midias WHERE obra_id = o.id ORDER BY ordem LIMIT 1) as foto_capa
       FROM obras o WHERE o.id = $1`,
      [req.params.id]
    )
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    const obra = result.rows[0]
    const ehDono = obra.criado_por === req.usuario.id
    const ehPintorDoMatch = obra.match_usuario_id === req.usuario.id

    if (!ehDono && !ehPintorDoMatch && req.usuario.role !== 'admin') {
      const assinatura = await pool.query(
        `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' LIMIT 1`,
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
        `SELECT c.id, c.status, c.valor_proposto, c.valor_contraproposta, c.mensagem,
                u.nome, u.cidade, u.foto_url, c.usuario_id,
                CASE WHEN c.status = 'aceito' THEN u.logradouro ELSE NULL END as logradouro,
                CASE WHEN c.status = 'aceito' THEN u.numero ELSE NULL END as numero,
                CASE WHEN c.status = 'aceito' THEN u.bairro ELSE NULL END as bairro,
                CASE WHEN c.status = 'aceito' THEN u.telefone ELSE NULL END as telefone
         FROM candidaturas c JOIN usuarios u ON u.id = c.usuario_id
         WHERE c.obra_id = $1 ORDER BY c.criado_em DESC`,
        [req.params.id]
      )
      candidatos = candidatosResult.rows
    }

    // Endereço exato só para dono, pintor do match ou admin (Finding 3.1).
    // Coordenadas permanecem para o cálculo de distância no cliente.
    if (obra.criado_por !== req.usuario.id && obra.match_usuario_id !== req.usuario.id && req.usuario.role !== 'admin') {
      delete obra.endereco_obra
    }

    res.json({ obra, midias: midias.rows, minha_candidatura: minhaCandidaturaResult.rows[0] || null, candidatos })
  } catch (err) {
    console.error('Erro ao buscar obra:', err)
    res.status(500).json({ erro: 'Erro ao buscar obra' })
  }
})

// POST /obras/:id/candidatura — pintor se candidata a uma obra
router.post('/obras/:id/candidatura', autenticar, async (req, res) => {
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
router.post('/obras/:id/candidatura/:candidaturaId/pintor-responder', autenticar, async (req, res) => {
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
router.post('/obras/:id/match', autenticar, async (req, res) => {
  try {
    const obra = await pool.query(`SELECT * FROM obras WHERE id = $1 AND status = 'aberta'`, [req.params.id])
    if (obra.rows.length === 0) return res.status(404).json({ erro: 'Obra não encontrada' })
    if (obra.rows[0].match_usuario_id) return res.status(409).json({ erro: 'Esta obra já tem um pintor a caminho' })
    const candidaturaAceita = await pool.query(
      `SELECT id FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2 AND status IN ('aceito','aprovada')`,
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
    await pool.query(`UPDATE obras SET status = 'encerrada', status_aprovacao = 'encerrada' WHERE id = $1`, [req.params.id])
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
        (SELECT COUNT(*) FROM interesse_reparos WHERE reparo_id = r.id) as total_interessados,
        (SELECT COUNT(*) FROM interesse_reparos WHERE reparo_id = r.id AND status = 'pendente') as interesses_pendentes,
        (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY ordem LIMIT 1) as foto_capa,
        (SELECT COALESCE(ir.valor_contraproposta, ir.valor_proposto)
           FROM interesse_reparos ir
          WHERE ir.reparo_id = r.id AND ir.usuario_id = r.match_usuario_id
          LIMIT 1) as valor_acordado
       FROM reparos r WHERE r.criado_por = $1 AND r.status != 'cancelada' ORDER BY r.criado_em DESC
       LIMIT $2 OFFSET $3`,
      [req.usuario.id, limit, offset]
    )
    const agora = new Date()
    const eArquivado = r => r.status === 'encerrada' || (r.status === 'aberta' && r.expira_em && new Date(r.expira_em) < agora)
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
    const horasExpiracao = prazo_atendimento_horas || 720
    const expira_em = new Date(Date.now() + horasExpiracao * 3600 * 1000)
    // ON CONFLICT no índice parcial (criado_por, client_request_id): retries com a mesma chave
    // retornam o reparo já criado em vez de inserir duplicata. Sem chave (NULL) → insert normal.
    const result = await pool.query(
      `INSERT INTO reparos (criado_por, titulo, categoria, descricao, valor_estimado, cidade, bairro, uf, tags, status, status_aprovacao, expira_em, prazo_atendimento_horas, endereco_reparo, latitude, longitude, client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'aberta','aprovada',$10,$11,$12,$13,$14,$15)
       ON CONFLICT (criado_por, client_request_id) WHERE client_request_id IS NOT NULL
       DO UPDATE SET client_request_id = EXCLUDED.client_request_id
       RETURNING *`,
      [req.usuario.id, titulo, categoria, descricao, valor_estimado, cidade, bairro, ufFinal, tags || [], expira_em.toISOString(), prazo_atendimento_horas || null, endereco_obra, latitude, longitude, client_request_id || null]
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

router.get('/reparos/meus-interesses', autenticar, exigirPrestador, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ir.id, ir.status, ir.valor_proposto, ir.valor_contraproposta, ir.rodada, ir.criado_em,
             r.id as reparo_id, r.titulo, r.categoria, r.descricao, r.valor_estimado,
             r.cidade, r.bairro, r.latitude, r.longitude, r.expira_em, r.status as reparo_status, r.prazo_atendimento_horas,
             (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY ordem LIMIT 1) as foto_capa
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
router.get('/reparos/meus-contratos', autenticar, exigirPrestador, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.titulo, r.categoria, r.descricao, r.valor_estimado, r.cidade, r.bairro, r.uf,
              r.match_feito_em, r.status,
              u.nome AS dono_nome, u.telefone AS dono_telefone,
              (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY ordem LIMIT 1) AS foto_capa,
              COALESCE(ir.valor_contraproposta, ir.valor_proposto) AS valor_acordado
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
              u.nome AS prestador_nome, u.telefone AS prestador_telefone,
              u.logradouro, u.numero, u.bairro,
              (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY ordem LIMIT 1) AS foto_capa,
              COALESCE(ir.valor_contraproposta, ir.valor_proposto) AS valor_acordado
       FROM reparos r
       JOIN usuarios u ON r.match_usuario_id = u.id
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

router.get('/reparos', autenticar, exigirPrestador, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit
    const { categoria, raio_km, lat, lng } = req.query

    // $1 reservado para o usuario_id (filtro de bloqueados)
    const params = [req.usuario.id]

    let query = `
      SELECT r.id, r.titulo, r.categoria, r.descricao, r.valor_estimado, r.cidade, r.bairro, r.uf,
             r.latitude, r.longitude,
             r.status, r.status_aprovacao, r.expira_em, r.criado_em, r.criado_por,
             r.match_feito_em, r.match_usuario_id, r.pedido_tempo_status,
             r.prestadores_bloqueados, r.client_request_id,
        (SELECT COUNT(*) FROM interesse_reparos WHERE reparo_id = r.id) as total_interessados,
        (SELECT url FROM midias_reparos WHERE reparo_id = r.id ORDER BY ordem LIMIT 1) as foto_capa
      FROM reparos r
      WHERE r.status = 'aberta' AND r.status_aprovacao = 'aprovada' AND r.expira_em > NOW()
        AND r.match_usuario_id IS NULL
        AND NOT ($1::uuid = ANY(COALESCE(r.prestadores_bloqueados, '{}')))`

    if (categoria && categoria !== 'todas') {
      params.push(categoria)
      query += ` AND r.categoria = $${params.length}`
    }

    if (raio_km === 'cidade') {
      let cidade = (req.query.cidade_busca || '').trim()
      if (!cidade) {
        const cidadeResult = await pool.query(`SELECT cidade FROM usuarios WHERE id = $1`, [req.usuario.id])
        cidade = cidadeResult.rows[0]?.cidade
      }
      if (cidade) {
        params.push(cidade)
        query += ` AND r.cidade = $${params.length}`
      }
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
    } else if (raio_km && raio_km !== 'pais' && lat && lng) {
      const raio = parseFloat(raio_km)
      const latNum = parseFloat(lat)
      const lngNum = parseFloat(lng)
      if (!isNaN(raio) && !isNaN(latNum) && !isNaN(lngNum)) {
        // Raio cumulativo: inclui reparos dentro de X km (com coordenadas) OU da cidade do
        // usuário (mesmo sem coordenadas geocodificadas — "sem lat/lng" não pode significar "invisível")
        const cidadeResult = await pool.query(`SELECT cidade FROM usuarios WHERE id = $1`, [req.usuario.id])
        const cidade = cidadeResult.rows[0]?.cidade
        // Pré-filtro por bounding box (sargável → usa o índice btree (latitude, longitude))
        // antes do haversine exato por linha. A caixa é um superconjunto do círculo de raio
        // R (usa cos na latitude da borda mais próxima do polo), então não há falsos negativos:
        // o haversine continua sendo o filtro exato.
        const KM_POR_GRAU = 111.045
        const latDelta = raio / KM_POR_GRAU
        const cosBorda = Math.cos(Math.min(89.9, Math.abs(latNum) + latDelta) * Math.PI / 180)
        const lngDelta = cosBorda > 0.0001 ? raio / (KM_POR_GRAU * cosBorda) : 180
        const latMin = latNum - latDelta
        const latMax = latNum + latDelta
        const lngMin = Math.max(-180, lngNum - lngDelta)
        const lngMax = Math.min(180, lngNum + lngDelta)
        const latIdx = params.length + 1
        const lngIdx = params.length + 2
        const raioIdx = params.length + 3
        const latMinIdx = params.length + 4
        const latMaxIdx = params.length + 5
        const lngMinIdx = params.length + 6
        const lngMaxIdx = params.length + 7
        params.push(latNum, lngNum, raio, latMin, latMax, lngMin, lngMax)
        let condicao = `(r.latitude IS NOT NULL AND r.longitude IS NOT NULL
          AND r.latitude BETWEEN $${latMinIdx} AND $${latMaxIdx}
          AND r.longitude BETWEEN $${lngMinIdx} AND $${lngMaxIdx}
          AND (6371 * acos(LEAST(1.0, cos(radians($${latIdx})) * cos(radians(r.latitude::float)) * cos(radians(r.longitude::float) - radians($${lngIdx})) + sin(radians($${latIdx})) * sin(radians(r.latitude::float))))) <= $${raioIdx})`
        if (cidade) {
          params.push(cidade)
          condicao = `(${condicao} OR r.cidade = $${params.length})`
        }
        query += ` AND ${condicao}`
      }
    }

    params.push(limit)
    query += ` ORDER BY r.expira_em ASC, r.valor_estimado DESC NULLS LAST LIMIT $${params.length}`
    params.push(offset)
    query += ` OFFSET $${params.length}`

    const result = await pool.query(query, params)
    res.json({ reparos: result.rows, page, limit })
  } catch (err) {
    console.error('Erro ao buscar reparos:', err)
    res.status(500).json({ erro: 'Erro ao buscar reparos' })
  }
})

router.post('/reparos/:id/interesse', autenticar, exigirPrestador, async (req, res) => {
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

router.post('/reparos/:id/match', autenticar, exigirPrestador, async (req, res) => {
  try {
    const reparo = await pool.query(`SELECT * FROM reparos WHERE id = $1 AND status = 'aberta'`, [req.params.id])
    if (reparo.rows.length === 0) return res.status(404).json({ erro: 'Reparo não encontrado' })
    if (reparo.rows[0].match_usuario_id) return res.status(409).json({ erro: 'Este reparo já tem um prestador a caminho' })
    const interesseAceito = await pool.query(
      `SELECT id FROM interesse_reparos WHERE reparo_id = $1 AND usuario_id = $2 AND status IN ('aceito','aprovada')`,
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
router.post('/reparos/:id/interesse/:interesse_id/prestador-responder', autenticar, exigirPrestador, async (req, res) => {
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
    await pool.query(`UPDATE reparos SET status = 'encerrada', status_aprovacao = 'encerrada' WHERE id = $1`, [req.params.id])
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
    const result = await pool.query(`SELECT * FROM reparos WHERE id = $1`, [req.params.id])
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
        `SELECT status FROM assinaturas WHERE usuario_id = $1 AND status = 'ativa' LIMIT 1`,
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
        `SELECT ir.id, ir.usuario_id, ir.status, ir.mensagem, ir.criado_em,
                ir.valor_proposto, ir.valor_contraproposta, ir.rodada,
                u.nome, u.cidade,
                CASE WHEN ir.status = 'aceito' THEN u.logradouro ELSE NULL END as logradouro,
                CASE WHEN ir.status = 'aceito' THEN u.numero ELSE NULL END as numero,
                CASE WHEN ir.status = 'aceito' THEN u.bairro ELSE NULL END as bairro,
                CASE WHEN ir.status = 'aceito' THEN u.telefone ELSE NULL END as telefone
         FROM interesse_reparos ir
         JOIN usuarios u ON ir.usuario_id = u.id
         WHERE ir.reparo_id = $1
         ORDER BY ir.criado_em ASC`,
        [req.params.id]
      )
      interessados = result2.rows
    }

    // Endereço exato só para dono, prestador do match ou admin (Finding 3.1).
    // Coordenadas permanecem para o cálculo de distância no cliente.
    if (reparo.criado_por !== req.usuario.id && reparo.match_usuario_id !== req.usuario.id && req.usuario.role !== 'admin') {
      delete reparo.endereco_reparo
    }

    res.json({
      reparo,
      midias: midias.rows,
      meu_interesse: interesse.rows[0] || null,
      interessados,
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
        return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' })
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
        return res.status(409).json({ erro: 'Este CPF/CNPJ já está cadastrado.' })
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
    await client.query(`DELETE FROM interesse_reparos`)
    await client.query(`DELETE FROM midias_reparos`)
    await client.query(`DELETE FROM reparos`)
    await client.query(`DELETE FROM negociacoes`)
    await client.query(`DELETE FROM candidaturas`)
    await client.query(`DELETE FROM midias`)
    await client.query(`DELETE FROM obras`)
    await client.query(`DELETE FROM mensagens`)
    await client.query(`DELETE FROM assinaturas WHERE usuario_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
    await client.query(`DELETE FROM localizacoes_prestadores WHERE usuario_id IN (SELECT id FROM usuarios WHERE role != 'admin')`)
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
      `UPDATE assinaturas SET status = 'ativa', atualizado_em = NOW() WHERE usuario_id = $1`, [id]
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
        await pool.query(`UPDATE assinaturas SET status = 'ativa', atualizado_em = NOW() WHERE usuario_id = $1`, [p.id])
      }
      console.log(`[Modo automático] ${pendentes.rows.length} prestadores aprovados automaticamente`)
    }

    res.json({ mensagem: ativo ? 'Modo automático ativado' : 'Modo automático desativado', ativo })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar configuração' })
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

router.post('/candidaturas/:id/negociar', autenticar, async (req, res) => {
  try {
    const { valor, mensagem } = req.body
    const { id } = req.params
    const candidatura = await pool.query(
      `SELECT c.*, o.criado_por as dono_id, o.titulo, u.push_token
       FROM candidaturas c JOIN obras o ON c.obra_id = o.id JOIN usuarios u ON c.usuario_id = u.id
       WHERE c.id = $1`, [id]
    )
    if (candidatura.rows.length === 0) return res.status(404).json({ erro: 'Candidatura não encontrada' })
    const cand = candidatura.rows[0]
    if (req.usuario.id !== cand.dono_id && req.usuario.id !== cand.usuario_id) return res.status(403).json({ erro: 'Sem permissão' })
    const negociacao = await pool.query(
      `INSERT INTO negociacoes (candidatura_id, autor_id, tipo, valor, mensagem) VALUES ($1, $2, 'contra_oferta', $3, $4) RETURNING *`,
      [id, req.usuario.id, valor, mensagem]
    )
    const ehDono = req.usuario.id === cand.dono_id
    if (!ehDono) {
      const donoResult = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [cand.dono_id])
      if (donoResult.rows[0]?.push_token) {
        await enviarPushNotificacao(donoResult.rows[0].push_token, '🎨 Nova contra-oferta!',
          `Um pintor propôs R$ ${Number(valor).toLocaleString('pt-BR')} para "${cand.titulo}"`,
          { tipo: 'contra_oferta', candidatura_id: id })
      }
    } else if (cand.push_token) {
      await enviarPushNotificacao(cand.push_token, '🎨 O dono fez uma contra-oferta!',
        `Nova proposta de R$ ${Number(valor).toLocaleString('pt-BR')} para "${cand.titulo}"`,
        { tipo: 'contra_oferta', candidatura_id: id })
    }
    res.status(201).json(negociacao.rows[0])
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar negociação' })
  }
})

// [DEAD CODE — fluxo legado 'aprovada'] Nenhuma tela do app atual chama este
// endpoint; o aceite vivo usa /obras/:id/candidatura/:id/responder → status
// 'aceito'. Emite push 'candidatura_aprovada', que portanto NÃO é disparado pelo
// app atual (confirmado por busca em todo o app, jun/2026). Mantido só por
// compatibilidade com builds antigos / possível uso pelo painel admin.
// Dono responds to a candidatura: aceitar | recusar | contraproposta
router.post('/candidaturas/:id/dono-responder', autenticar, async (req, res) => {
  try {
    const { action, valor, mensagem } = req.body
    const { id } = req.params
    const candidatura = await pool.query(
      `SELECT c.*, o.criado_por as dono_id, o.titulo, u.push_token as pintor_token
       FROM candidaturas c JOIN obras o ON c.obra_id = o.id JOIN usuarios u ON c.usuario_id = u.id
       WHERE c.id = $1`, [id]
    )
    if (candidatura.rows.length === 0) return res.status(404).json({ erro: 'Candidatura não encontrada' })
    const cand = candidatura.rows[0]
    if (req.usuario.id !== cand.dono_id) return res.status(403).json({ erro: 'Apenas o dono pode responder' })

    if (action === 'aceitar') {
      await pool.query(`UPDATE candidaturas SET status = 'aprovada' WHERE id = $1`, [id])
      if (cand.pintor_token) {
        enviarPushNotificacao(cand.pintor_token, '✅ Candidatura aprovada!',
          `O dono aprovou sua candidatura para "${cand.titulo}". Entre em contato!`,
          { tipo: 'candidatura_aprovada', candidatura_id: id }).catch(() => {})
      }
      return res.json({ mensagem: 'Candidatura aprovada!' })
    }
    if (action === 'recusar') {
      await pool.query(`UPDATE candidaturas SET status = 'recusada' WHERE id = $1`, [id])
      if (cand.pintor_token) {
        enviarPushNotificacao(cand.pintor_token, '❌ Candidatura não selecionada',
          `Sua candidatura para "${cand.titulo}" não foi selecionada desta vez.`,
          { tipo: 'candidatura_recusada', candidatura_id: id }).catch(() => {})
      }
      return res.json({ mensagem: 'Candidatura recusada.' })
    }
    if (action === 'contraproposta') {
      if (!valor) return res.status(400).json({ erro: 'Informe o valor da contraproposta' })
      await pool.query(
        `INSERT INTO negociacoes (candidatura_id, autor_id, tipo, valor, mensagem) VALUES ($1, $2, 'contra_oferta', $3, $4)`,
        [id, req.usuario.id, valor, mensagem || null]
      )
      if (cand.pintor_token) {
        enviarPushNotificacao(cand.pintor_token, '💬 O dono fez uma proposta!',
          `Nova proposta de R$ ${Number(valor).toLocaleString('pt-BR')} para "${cand.titulo}". Veja no app!`,
          { tipo: 'contra_oferta', candidatura_id: id }).catch(() => {})
      }
      return res.json({ mensagem: 'Contraproposta enviada!' })
    }
    res.status(400).json({ erro: 'Ação inválida' })
  } catch (err) {
    console.error('Erro ao responder candidatura (dono):', err)
    res.status(500).json({ erro: 'Erro ao responder' })
  }
})

// [DEAD CODE — fluxo legado 'aprovada'] Não é chamado por nenhuma tela do app
// atual (ver nota em /candidaturas/:id/dono-responder). Emite 'candidatura_aprovada'.
// Pintor responds to dono's counter-offer: aceitar | recusar
router.post('/candidaturas/:id/pintor-responder', autenticar, async (req, res) => {
  try {
    const { action } = req.body
    const { id } = req.params
    const candidatura = await pool.query(
      `SELECT c.*, o.criado_por as dono_id, o.titulo
       FROM candidaturas c JOIN obras o ON c.obra_id = o.id
       WHERE c.id = $1 AND c.usuario_id = $2`, [id, req.usuario.id]
    )
    if (candidatura.rows.length === 0) return res.status(404).json({ erro: 'Candidatura não encontrada' })
    const cand = candidatura.rows[0]
    const dono = await pool.query(`SELECT push_token FROM usuarios WHERE id = $1`, [cand.dono_id])

    if (action === 'aceitar') {
      await pool.query(`UPDATE candidaturas SET status = 'aprovada' WHERE id = $1`, [id])
      if (dono.rows[0]?.push_token) {
        enviarPushNotificacao(dono.rows[0].push_token, '✅ Proposta aceita!',
          `O pintor aceitou sua proposta para "${cand.titulo}"!`,
          { tipo: 'candidatura_aprovada', candidatura_id: id }).catch(() => {})
      }
      return res.json({ mensagem: 'Proposta aceita!' })
    }
    if (action === 'recusar') {
      await pool.query(`UPDATE candidaturas SET status = 'recusada' WHERE id = $1`, [id])
      if (dono.rows[0]?.push_token) {
        enviarPushNotificacao(dono.rows[0].push_token, '❌ Proposta recusada',
          `O pintor recusou sua proposta para "${cand.titulo}".`,
          { tipo: 'candidatura_recusada', candidatura_id: id }).catch(() => {})
      }
      return res.json({ mensagem: 'Proposta recusada.' })
    }
    res.status(400).json({ erro: 'Ação inválida' })
  } catch (err) {
    console.error('Erro ao responder candidatura (pintor):', err)
    res.status(500).json({ erro: 'Erro ao responder' })
  }
})

router.get('/candidaturas/:id/negociacoes', autenticar, async (req, res) => {
  try {
    const ownership = await pool.query(
      `SELECT c.usuario_id, o.criado_por as dono_id FROM candidaturas c
       JOIN obras o ON c.obra_id = o.id WHERE c.id = $1`,
      [req.params.id]
    )
    if (ownership.rows.length === 0) return res.status(404).json({ erro: 'Candidatura não encontrada' })
    const { usuario_id, dono_id } = ownership.rows[0]
    if (req.usuario.id !== usuario_id && req.usuario.id !== dono_id) {
      return res.status(403).json({ erro: 'Sem permissão para ver estas negociações' })
    }
    const result = await pool.query(
      `SELECT n.*, u.nome as autor_nome, u.role as autor_role FROM negociacoes n
       JOIN usuarios u ON n.autor_id = u.id WHERE n.candidatura_id = $1 ORDER BY n.criado_em ASC`,
      [req.params.id]
    )
    res.json({ negociacoes: result.rows })
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar negociações' })
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
    const [obras, assinaturas, candidaturas, obrasAprovacao, reparosAprovacao] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM obras WHERE status = 'aberta'`),
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
      pool.query(`SELECT COUNT(*) FROM reparos WHERE status_aprovacao = 'pendente'`)
    ])
    const assinRow = assinaturas.rows[0]
    res.json({
      obras_abertas: parseInt(obras.rows[0].count),
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
    await client.query(`DELETE FROM negociacoes WHERE candidatura_id IN (SELECT id FROM candidaturas WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = ANY($1)))`, [ids])
    await client.query(`DELETE FROM mensagens WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = ANY($1))`, [ids])
    await client.query(`DELETE FROM midias WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = ANY($1))`, [ids])
    await client.query(`DELETE FROM candidaturas WHERE obra_id IN (SELECT id FROM obras WHERE criado_por = ANY($1))`, [ids])
    await client.query(`DELETE FROM obras WHERE criado_por = ANY($1)`, [ids])
    // Cascade dos reparos criados pelos usuários alvo
    await client.query(`DELETE FROM midias_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por = ANY($1))`, [ids])
    await client.query(`DELETE FROM interesse_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por = ANY($1))`, [ids])
    await client.query(`DELETE FROM reparos WHERE criado_por = ANY($1)`, [ids])
    // Registros dos usuários alvo como participantes (candidato/interessado/autor) em
    // itens de terceiros — necessário antes do DELETE FROM usuarios por causa das FKs
    await client.query(`DELETE FROM negociacoes WHERE autor_id = ANY($1)`, [ids])
    await client.query(`DELETE FROM negociacoes WHERE candidatura_id IN (SELECT id FROM candidaturas WHERE usuario_id = ANY($1))`, [ids])
    await client.query(`DELETE FROM candidaturas WHERE usuario_id = ANY($1)`, [ids])
    await client.query(`DELETE FROM interesse_reparos WHERE usuario_id = ANY($1)`, [ids])
    await client.query(`DELETE FROM mensagens WHERE autor_id = ANY($1)`, [ids])
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
    await client.query(`DELETE FROM negociacoes WHERE candidatura_id IN (SELECT id FROM candidaturas)`)
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
    await client.query(`DELETE FROM negociacoes`)
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
    const hash = await bcrypt.hash(nova_senha, 12)
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

module.exports = router
module.exports.migracaoPronta = migracaoPronta