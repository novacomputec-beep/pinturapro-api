// PEDIDO QUE PARECE ANÚNCIO (dono, 24/11/2026). Profissional que publica "pedido" para divulgar o
// próprio trabalho. Complementa utils/moderacaoDemanda (venda com valor zero → 400; contato vira
// "[contato removido]"), que segue igual.
//
// 1) DETECÇÃO na publicação (POST /reparos/dono e POST /obras/dono) — avaliarSuspeitaAnuncio:
//      - 'profissional_da_especialidade': o MESMO CPF tem conta profissional com a especialidade do
//        pedido (reparo: as categorias; obra: as especialidades inferidas do texto);
//      - texto de quem oferece: "faço", "ofereço", "orçamento grátis", "atendo", "trabalho com";
//      - 'telefone' no texto ORIGINAL (antes de a moderação mascarar).
//    O app novo manda confirmar_pedido_real: false na 1ª tentativa → 409 SUSPEITA_ANUNCIO com
//    suspeita_anuncio: true e os motivos, NADA gravado; o usuário confirma e o app reenvia com
//    confirmar_pedido_real: true → publica, com a marca gravada (suspeita_anuncio + motivos) para o
//    painel. App antigo não manda o campo: publica como sempre, com a marca gravada.
// 2) PAINEL — POST /admin/demandas/:tipo/:id/marcar-anuncio (routes/adminAnuncios.js):
//    tira o pedido do ar (status 'cancelada', cancelada_por 'admin', anuncio_em), manda pelo robô de
//    WhatsApp (tipo 'avulsa') o aviso ao dono do pedido e conta UMA ocorrência
//    (anuncios_ocorrencias). A 3ª ocorrência da pessoa em 90 dias → 7 dias sem publicar, pelo
//    mecanismo de utils/penalidadesAuto (verificarPenalidadeAnuncios).
const { pool } = require('./supabase')
const { normalizar } = require('./localidade')
const { temTelefone } = require('./moderacaoDemanda')
const { inferirEspecialidades } = require('./especialidadesInferidas')
const { sqlCpfNormalizado } = require('./demandaPropria')
const { primeiroNome } = require('../whatsapp/textos')
const { LINK_INDICACAO } = require('./indicacoes')
const { rotuloCategoria } = require('./especialidades')

const CODIGO_SUSPEITA = 'SUSPEITA_ANUNCIO'
const MENSAGEM_SUSPEITA = 'Este pedido parece um anúncio do seu trabalho. Os pedidos são para quem quer contratar um serviço. Se você quer mesmo contratar, confirme para publicar.'
const MOTIVO_PROFISSIONAL = 'profissional_da_especialidade'
const MOTIVO_TELEFONE = 'telefone'
// Sem conta profissional (ou sem código de indicação): o link de baixar o app, sem código.
const LINK_APP = 'https://protudo.app.br/baixar'
const TABELAS = Object.freeze({ reparo: 'reparos', obra: 'obras' })

// Sobre o texto DOBRADO (minúsculas, sem acento). Palavra inteira: "refaço", "satisfaço" e
// "atendimento" não casam.
const FRASES = [
  ['faço', /\bfaco\b/], ['ofereço', /\bofereco\b/], ['orçamento grátis', /\borcamentos? gratis\b/],
  ['atendo', /\batendo\b/], ['trabalho com', /\btrabalho com\b/],
]
const motivosDoTexto = (...textos) => {
  const original = textos.filter(t => typeof t === 'string').join('\n')
  const dobrado = normalizar(original)
  const motivos = FRASES.filter(([, re]) => re.test(dobrado)).map(([rotulo]) => rotulo)
  if (temTelefone(original)) motivos.push(MOTIVO_TELEFONE)
  return motivos
}

// Especialidades que o pedido procura.
const especialidadesDoPedido = (tabela, { titulo, descricao, categorias }) =>
  (tabela === 'obras' ? inferirEspecialidades({ titulo, descricao }) : (Array.isArray(categorias) ? categorias : [])).filter(s => s && s !== 'outros')

// titulo/descricao = texto ORIGINAL do corpo. Devolve { suspeita, motivos }. Nunca lança: erro de
// banco na consulta do CPF vira log e só o texto decide.
const avaliarSuspeitaAnuncio = async ({ usuarioId, tabela, titulo, descricao, categorias }, db = pool) => {
  const motivos = []
  const slugs = especialidadesDoPedido(tabela, { titulo, descricao, categorias })
  if (usuarioId && slugs.length > 0) {
    try {
      const r = await db.query(
        `SELECT 1 FROM usuarios eu
           JOIN usuarios p ON p.role = 'prestador' AND ${sqlCpfNormalizado('p.cpf_cnpj')} = ${sqlCpfNormalizado('eu.cpf_cnpj')}
          WHERE eu.id = $1::uuid AND p.especialidades && $2::text[] LIMIT 1`, [usuarioId, slugs])
      if (r.rows.length > 0) motivos.push(MOTIVO_PROFISSIONAL)
    } catch (err) {
      console.error('[Anuncio] consulta do CPF:', err.message)
    }
  }
  motivos.push(...motivosDoTexto(titulo, descricao))
  return { suspeita: motivos.length > 0, motivos }
}

// O que fazer com o corpo da publicação: { barrar: corpo do 409 } ou { marcar: true/false }.
const decidirPublicacao = (body, avaliacao) => {
  if (!avaliacao.suspeita) return { marcar: false }
  const veio = body != null && Object.prototype.hasOwnProperty.call(body, 'confirmar_pedido_real')
  const confirmou = body?.confirmar_pedido_real === true || body?.confirmar_pedido_real === 'true'
  if (veio && !confirmou) {
    return { barrar: { erro: MENSAGEM_SUSPEITA, codigo: CODIGO_SUSPEITA, suspeita_anuncio: true, motivos: avaliacao.motivos } }
  }
  return { marcar: true, motivos: avaliacao.motivos }
}

// Grava a marca no pedido recém-criado e a devolve na linha. Nunca lança (o pedido já existe).
const gravarSuspeita = async (tabela, linha, motivos, db = pool) => {
  try {
    await db.query(`UPDATE ${tabela} SET suspeita_anuncio = true, suspeita_anuncio_motivos = $2::text[] WHERE id = $1`, [linha.id, motivos])
    linha.suspeita_anuncio = true
    linha.suspeita_anuncio_motivos = motivos
  } catch (err) {
    console.error(`[Anuncio] marca em ${tabela} ${linha?.id}:`, err.message)
  }
  return linha
}

const migrarSuspeitaAnuncio = async (client) => {
  for (const tabela of Object.values(TABELAS)) {
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS suspeita_anuncio BOOLEAN NOT NULL DEFAULT false`)
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS suspeita_anuncio_motivos TEXT[]`)
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS anuncio_em TIMESTAMPTZ`)
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS anuncio_por UUID`)
  }
  await client.query(`
    CREATE TABLE IF NOT EXISTS anuncios_ocorrencias (
      id         BIGSERIAL PRIMARY KEY,
      usuario_id UUID NOT NULL,
      tabela     TEXT NOT NULL CHECK (tabela IN ('reparos', 'obras')),
      demanda_id UUID NOT NULL,
      titulo     TEXT,
      admin_id   UUID,
      criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tabela, demanda_id)
    )`)
  await client.query(`CREATE INDEX IF NOT EXISTS anuncios_ocorrencias_usuario_idx ON anuncios_ocorrencias (usuario_id, criado_em DESC)`)
}

// O link é o convite do PRÓPRIO profissional (o mesmo que o app monta: utils/indicacoes.LINK_INDICACAO).
const textoAnuncioRemovido = ({ nome, titulo, codigo_indicacao }) =>
  `Oi, ${primeiroNome(nome)}! 👋 Aqui é o *ProTudo*. Tiramos do ar o seu pedido *"${titulo}"* porque ele parece um anúncio do seu trabalho, e os pedidos são para quem quer contratar. 😉 Para divulgar seus serviços, compartilhe o seu link do ProTudo: ${codigo_indicacao ? LINK_INDICACAO(codigo_indicacao) : LINK_APP}`

// Painel ("também é profissional: {especialidade}"): em cada linha (que tem `id`), a especialidade
// do pedido que o DONO também exerce numa conta profissional do mesmo CPF —
// dono_profissional_especialidade (slug) e dono_profissional_especialidade_rotulo; null quando não
// há. Reparo: as categorias; obra: as especialidades inferidas. Nunca lança.
const anexarEspecialidadeProfissionalDoDono = async (tabela, linhas, db = pool) => {
  const lista = Array.isArray(linhas) ? linhas : []
  for (const l of lista) { l.dono_profissional_especialidade = null; l.dono_profissional_especialidade_rotulo = null }
  if (lista.length === 0 || !Object.values(TABELAS).includes(tabela)) return linhas
  const slugs = tabela === 'obras' ? `COALESCE(d.especialidades_inferidas, '{}'::text[])` : `COALESCE(NULLIF(d.categorias, '{}'::text[]), ARRAY[d.categoria]::text[])`
  try {
    const r = await db.query(
      `SELECT d.id, ${slugs} AS slugs,
              (SELECT array_agg(DISTINCT e) FROM usuarios dn
                 JOIN usuarios p ON p.role = 'prestador' AND ${sqlCpfNormalizado('p.cpf_cnpj')} = ${sqlCpfNormalizado('dn.cpf_cnpj')}
                CROSS JOIN LATERAL unnest(COALESCE(p.especialidades, '{}'::text[])) AS e
                WHERE dn.id = d.criado_por) AS do_dono
         FROM ${tabela} d WHERE d.id = ANY($1::uuid[])`, [lista.map(l => l.id)])
    const porId = new Map(r.rows.map(x => [x.id, x]))
    for (const l of lista) {
      const x = porId.get(l.id)
      const slug = (x?.slugs || []).find(s => s && s !== 'outros' && (x.do_dono || []).includes(s))
      if (slug) { l.dono_profissional_especialidade = slug; l.dono_profissional_especialidade_rotulo = rotuloCategoria(slug) }
    }
  } catch (err) {
    console.error(`[Anuncio] especialidade profissional do dono (${tabela}):`, err.message)
  }
  return linhas
}

// Painel: marca o pedido como anúncio. Devolve { ok: true, ... } ou { ok: false, status, erro, codigo }.
const marcarComoAnuncio = async ({ tipo, id, adminId }, db = pool) => {
  const tabela = TABELAS[tipo]
  if (!tabela) return { ok: false, status: 400, erro: "tipo deve ser 'reparo' ou 'obra'" }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) return { ok: false, status: 400, erro: 'id inválido' }
  const d = (await db.query(
    `SELECT d.id, d.titulo, d.status, d.criado_por, d.match_usuario_id, d.anuncio_em, u.nome, u.telefone, u.whatsapp_avisos,
            (SELECT p.codigo_indicacao FROM usuarios p
              WHERE p.role = 'prestador' AND p.codigo_indicacao IS NOT NULL
                AND ${sqlCpfNormalizado('p.cpf_cnpj')} = ${sqlCpfNormalizado('u.cpf_cnpj')}
              ORDER BY p.id LIMIT 1) AS codigo_indicacao
       FROM ${tabela} d LEFT JOIN usuarios u ON u.id = d.criado_por WHERE d.id = $1::uuid`, [id])).rows[0]
  if (!d) return { ok: false, status: 404, erro: 'Pedido não encontrado' }
  if (d.anuncio_em) return { ok: false, status: 409, erro: 'Este pedido já foi marcado como anúncio.', codigo: 'JA_MARCADO' }
  if (d.match_usuario_id) return { ok: false, status: 409, erro: 'Este pedido já tem um profissional escolhido. Cancele o atendimento antes de marcar como anúncio.', codigo: 'MATCH_ATIVO' }
  // anuncio_em IS NULL no WHERE: dois cliques não contam duas ocorrências.
  const upd = await db.query(
    `UPDATE ${tabela} SET status = 'cancelada', status_aprovacao = 'cancelada', cancelada_por = 'admin',
            encerrado_em = COALESCE(encerrado_em, NOW()), suspeita_anuncio = true, anuncio_em = NOW(), anuncio_por = $2::uuid
      WHERE id = $1::uuid AND anuncio_em IS NULL AND match_usuario_id IS NULL RETURNING id`, [id, adminId || null])
  if (upd.rows.length === 0) return { ok: false, status: 409, erro: 'O pedido mudou enquanto você marcava. Atualize a lista.', codigo: 'ESTADO_MUDOU' }
  await db.query(
    `INSERT INTO anuncios_ocorrencias (usuario_id, tabela, demanda_id, titulo, admin_id) VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid)
     ON CONFLICT (tabela, demanda_id) DO NOTHING`, [d.criado_por, tabela, id, d.titulo, adminId || null])
  console.log(`[Anuncio] admin ${adminId} marcou ${tabela} ${id} ("${d.titulo}") como anúncio — dono ${d.criado_por}`)

  // Aviso pelo robô (tipo 'avulsa': sempre ligado; pausa, janela 08–21h, trava e ritmo valem no worker).
  let whatsapp
  if (d.whatsapp_avisos === false) whatsapp = { ok: false, motivo: 'saiu' }
  else {
    whatsapp = await require('../services/whatsappFilaService').enfileirar({
      tipo: 'avulsa', usuarioId: d.criado_por, telefone: d.telefone, texto: textoAnuncioRemovido(d),
      refTabela: tabela, refId: id, chaveDedupe: `anuncio:${tabela}:${id}` }, db)
  }
  const penalidade = await require('./penalidadesAuto').verificarPenalidadeAnuncios(d.criado_por, db)
  const ocorrencias = (await db.query(
    `SELECT COUNT(*)::int AS n FROM anuncios_ocorrencias WHERE usuario_id = $1::uuid`, [d.criado_por])).rows[0].n
  return { ok: true, tipo, id, usuario_id: d.criado_por, titulo: d.titulo, whatsapp: whatsapp.ok ? 'fila' : whatsapp.motivo, ocorrencias, penalidade }
}

module.exports = {
  CODIGO_SUSPEITA, MENSAGEM_SUSPEITA, MOTIVO_PROFISSIONAL, MOTIVO_TELEFONE, LINK_APP, motivosDoTexto, especialidadesDoPedido,
  anexarEspecialidadeProfissionalDoDono,
  avaliarSuspeitaAnuncio, decidirPublicacao, gravarSuspeita, migrarSuspeitaAnuncio, textoAnuncioRemovido, marcarComoAnuncio,
}
