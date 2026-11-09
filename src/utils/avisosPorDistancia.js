const { pool } = require('./supabase')
const { sqlProfissionalDaPessoa } = require('./tipoConta')

// AVISO DE DEMANDA POR DISTÂNCIA + TETO DIÁRIO DE PUSH (decisão do dono, 10/11/2026).
// As peças de dados; o público e o envio em si moram em alertaService (broadcastPaginado,
// reivindicarEmailsNovaDemanda, enviarResumosAcimaDoTeto).
//
// 1. ALCANCE — o aviso de demanda (obra e serviço, push e e-mail) deixou de exigir a MESMA cidade.
//    Recebe quem é da MESMA CIDADE + UF (sempre, qualquer que seja o raio escolhido) OU está a até
//    min(raio escolhido, 50 km) da demanda, medido entre as coordenadas do PERFIL do profissional
//    (usuarios.latitude/longitude — endereço de cadastro) e as da demanda. A distância só SOMA as
//    cidades vizinhas; nunca tira a própria cidade. Foi o caso da obra 673E2 (Lagoa Formosa): com
//    o filtro por nome de cidade, nenhum profissional de Patos de Minas, a 25 km, era avisado.
//      • raio escolhido = usuarios.raio_km_escolhido: o último raio que o app mandou no feed
//        (registrarRaioEscolhido — o FEED em si não muda). NULL (nunca escolheu, ou estado/país)
//        → 50 km; 0 (escolheu "minha cidade") → só a própria cidade.
//      • SEM coordenadas de um dos lados (perfil antigo, demanda sem geocodificação) → só a
//        mesma cidade + UF, como antes.
//    Vale para o aviso de demanda NOVA, o lembrete "ainda aberto" e o reanúncio. Oferta aumentada,
//    pedido de indicação e "fora da sua área" continuam só por cidade.
//
// 2. TETO — no máximo 15 pushes de demanda por PESSOA por dia de São Paulo, somando demanda nova,
//    "fora da sua área", lembrete e reanúncio. Demanda NOVA (e "fora da área") que passa do teto
//    NÃO vira push: fica em avisos_acima_do_teto e sai, no máximo UMA vez por dia e só entre 08h e
//    20h, num push-resumo "Mais N pedidos perto de você hoje". Lembrete e reanúncio acima do teto
//    simplesmente não saem (não são pedido NOVO para entrar no "Mais N"). O e-mail não é afetado
//    (tem o teto dele).
//    Quando várias demandas saem JUNTAS (rede de segurança, fila da manhã do "fora da área", tique
//    dos lembretes), o que resta do teto vai às mais PRÓXIMAS de cada profissional (sqlMaisPertoNoLote).
const RAIO_MAX_KM = 50
const TETO_PUSH_DEMANDA_DIA = 15

// Migração de boot (dentro da transação de routes/index.js). Idempotente; exportada para o teste
// rodar os MESMOS statements.
const migrarAvisosPorDistancia = async (client) => {
  await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS raio_km_escolhido NUMERIC`)
  await client.query(`
    CREATE TABLE IF NOT EXISTS avisos_acima_do_teto (
      tabela     TEXT NOT NULL CHECK (tabela IN ('obras', 'reparos')),
      demanda_id UUID NOT NULL,
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resumo_em  TIMESTAMPTZ,
      PRIMARY KEY (tabela, demanda_id, usuario_id)
    )`)
  await client.query(`CREATE INDEX IF NOT EXISTS avisos_acima_do_teto_usuario_idx ON avisos_acima_do_teto (usuario_id, criado_em)`)
  await client.query(`CREATE INDEX IF NOT EXISTS avisos_acima_do_teto_pendente_idx ON avisos_acima_do_teto (criado_em) WHERE resumo_em IS NULL`)
  // Lembrete "ainda aberto" e reanúncio não gravam push_entregas (uma demanda tem vários); este
  // log existe só para eles contarem no teto diário. Sem PK: a mesma demanda lembra mais de uma vez.
  await client.query(`
    CREATE TABLE IF NOT EXISTS lembretes_push_enviados (
      tabela     TEXT NOT NULL CHECK (tabela IN ('obras', 'reparos')),
      demanda_id UUID NOT NULL,
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      motivo     TEXT NOT NULL CHECK (motivo IN ('lembrete', 'reanuncio')),
      enviado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  await client.query(`CREATE INDEX IF NOT EXISTS lembretes_push_enviados_usuario_idx ON lembretes_push_enviados (usuario_id, enviado_em)`)
}

// ─── raio escolhido ─────────────────────────────────────────────────────────────────────────
// O app manda raio_km em TODA chamada do feed ('cidade', um número de km, 'estado' ou 'pais'); o
// servidor nunca guardou. Aqui ele passa a lembrar o último, só para o aviso: número > 0 → o
// número; 'cidade' → 0; 'estado'/'pais' → NULL (sem limite próprio: vale o teto de 50 km).
// Valor ausente ou que não se entende → não mexe. Fire-and-forget com dedupe em memória (o feed é
// o caminho de leitura mais quente da API): só vai ao banco quando o valor MUDA neste processo, e
// o UPDATE ainda é condicional. Nunca lança.
const raiosVistos = new Map()
const MAX_RAIOS_VISTOS = 20000
const interpretarRaio = (bruto) => {
  if (bruto === undefined || bruto === null || bruto === '') return undefined
  const texto = String(bruto).trim().toLowerCase()
  if (texto === 'cidade') return 0
  if (texto === 'estado' || texto === 'pais') return null
  const n = Number(texto)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : undefined
}
const registrarRaioEscolhido = (usuarioId, bruto, db = pool) => {
  try {
    const raio = interpretarRaio(bruto)
    if (!usuarioId || raio === undefined) return
    const chave = String(usuarioId)
    if (raiosVistos.get(chave) === raio) return
    if (raiosVistos.size >= MAX_RAIOS_VISTOS) raiosVistos.clear()
    raiosVistos.set(chave, raio)
    Promise.resolve(db.query(
      `UPDATE usuarios SET raio_km_escolhido = $2::numeric WHERE id = $1 AND raio_km_escolhido IS DISTINCT FROM $2::numeric`,
      [usuarioId, raio]
    )).catch(() => { raiosVistos.delete(chave) })
  } catch (_) { /* registro acessório: nunca derruba o feed */ }
}

// ─── SQL ────────────────────────────────────────────────────────────────────────────────────
// Distância em km (haversine) entre dois pontos dados como EXPRESSÕES SQL (coluna ou placeholder).
// LEAST(1, …) protege o asin de um arredondamento acima de 1.
const sqlKm = (latA, lngA, latB, lngB) => `(6371 * 2 * asin(sqrt(LEAST(1,
          power(sin(radians((${latB})::float8 - (${latA})::float8) / 2), 2)
          + cos(radians((${latA})::float8)) * cos(radians((${latB})::float8))
            * power(sin(radians((${lngB})::float8 - (${lngA})::float8) / 2), 2)))))`
// Raio efetivo do profissional: min(escolhido, 50); nunca escolheu → 50.
const sqlRaioEfetivo = (alias = 'u') => `LEAST(COALESCE(${alias}.raio_km_escolhido, ${RAIO_MAX_KM}), ${RAIO_MAX_KM})`
// O profissional `alias` alcança a demanda em (pLat, pLng)? MESMA CIDADE (`sqlMesmaCidade`, o
// predicado completo que quem chama já usava, sobre o mesmo alias) — SEMPRE, qualquer que seja o
// raio — OU, com coordenadas dos dois lados e raio > 0, distância ≤ raio efetivo. A distância só
// acrescenta as cidades vizinhas; sem coordenadas (ou com "minha cidade") sobra a regra de cidade.
const sqlAlcance = ({ pLat, pLng, sqlMesmaCidade, alias = 'u' }) => `(${sqlMesmaCidade}
           OR COALESCE(${pLat}::float8 IS NOT NULL AND ${pLng}::float8 IS NOT NULL
                AND ${alias}.latitude IS NOT NULL AND ${alias}.longitude IS NOT NULL
                AND COALESCE(${alias}.raio_km_escolhido, ${RAIO_MAX_KM}) > 0
                AND ${sqlKm(`${alias}.latitude`, `${alias}.longitude`, pLat, pLng)} <= ${sqlRaioEfetivo(alias)}, false))`

// Pushes de demanda que a PESSOA de `exprId` já recebeu hoje (dia de São Paulo): os do aviso de
// demanda nova (push_entregas 'enviado') + os "fora da sua área" (avisos_fora_area) + os de
// lembrete e reanúncio (lembretes_push_enviados).
const SQL_INICIO_DO_DIA_SP = `(date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`
const sqlPushesDeDemandaHoje = (exprId = 'u.id') => `(
          (SELECT count(*) FROM push_entregas teto_pe
            WHERE teto_pe.resultado = 'enviado' AND teto_pe.primeira_tentativa_em >= ${SQL_INICIO_DO_DIA_SP}
              AND ${sqlProfissionalDaPessoa('teto_pe.usuario_id', exprId)})
        + (SELECT count(*) FROM avisos_fora_area teto_af
            WHERE teto_af.enviado_em >= ${SQL_INICIO_DO_DIA_SP}
              AND ${sqlProfissionalDaPessoa('teto_af.usuario_id', exprId)})
        + (SELECT count(*) FROM lembretes_push_enviados teto_lp
            WHERE teto_lp.enviado_em >= ${SQL_INICIO_DO_DIA_SP}
              AND ${sqlProfissionalDaPessoa('teto_lp.usuario_id', exprId)}))`
// Demandas do LOTE (as que saem junto com esta e ainda não foram processadas) que estão MAIS
// PERTO do profissional do que esta: elas têm preferência no que resta do teto. pLats/pLngs =
// placeholders de float8[] com as coordenadas do lote; pLat/pLng = as desta demanda. Sem
// coordenadas de algum lado não há como comparar: conta 0 (vale a ordem de chegada).
const sqlMaisPertoNoLote = ({ pLats, pLngs, pLat, pLng, alias = 'u' }) => `(
          SELECT count(*) FROM unnest(${pLats}::float8[], ${pLngs}::float8[]) AS lote(lat, lng)
           WHERE ${alias}.latitude IS NOT NULL AND ${alias}.longitude IS NOT NULL
             AND ${pLat}::float8 IS NOT NULL AND ${pLng}::float8 IS NOT NULL
             AND lote.lat IS NOT NULL AND lote.lng IS NOT NULL
             AND ${sqlKm(`${alias}.latitude`, `${alias}.longitude`, 'lote.lat', 'lote.lng')}
                 < ${sqlKm(`${alias}.latitude`, `${alias}.longitude`, pLat, pLng)})`

// Registra quem ficou ACIMA do teto nesta demanda (contas representantes da pessoa) — a base do
// push-resumo. Repetição (retry do envio) não duplica.
const registrarAcimaDoTeto = async (tabela, demandaId, usuarioIds, db = pool) => {
  if (!usuarioIds || usuarioIds.length === 0) return 0
  await db.query(
    `INSERT INTO avisos_acima_do_teto (tabela, demanda_id, usuario_id)
     SELECT $1, $2::uuid, x FROM unnest($3::uuid[]) AS x
     ON CONFLICT (tabela, demanda_id, usuario_id) DO NOTHING`,
    [tabela, demandaId, usuarioIds])
  return usuarioIds.length
}
const limparAcimaDoTetoAntigos = async (db = pool) => {
  await db.query(`DELETE FROM avisos_acima_do_teto WHERE criado_em < NOW() - INTERVAL '7 days'`)
  await db.query(`DELETE FROM lembretes_push_enviados WHERE enviado_em < NOW() - INTERVAL '7 days'`)
}
// Lembrete / reanúncio que SAIU (resultado 'enviado'): entra na contagem do teto diário.
const registrarLembretesPush = async (tabela, demandaId, motivo, resultados, db = pool) => {
  const ids = (resultados || []).filter(r => r.resultado === 'enviado').map(r => r.id)
  if (ids.length === 0) return 0
  await db.query(
    `INSERT INTO lembretes_push_enviados (tabela, demanda_id, usuario_id, motivo)
     SELECT $1, $2::uuid, x, $4 FROM unnest($3::uuid[]) AS x`,
    [tabela, demandaId, ids, motivo])
  return ids.length
}

module.exports = {
  RAIO_MAX_KM, TETO_PUSH_DEMANDA_DIA, SQL_INICIO_DO_DIA_SP,
  migrarAvisosPorDistancia, interpretarRaio, registrarRaioEscolhido,
  sqlKm, sqlRaioEfetivo, sqlAlcance, sqlPushesDeDemandaHoje, sqlMaisPertoNoLote,
  registrarAcimaDoTeto, limparAcimaDoTetoAntigos, registrarLembretesPush,
}
