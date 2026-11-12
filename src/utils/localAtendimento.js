// ONDE O SERVIÇO ACONTECE — beleza/cuidados pessoais/pet (dono, 12/11/2026).
//   reparos.local_atendimento: 'casa_cliente' | 'local_profissional' | 'tanto_faz' | NULL.
//     Só é aceito quando ALGUMA categoria do reparo está em CATEGORIAS_LOCAL_ATENDIMENTO; nas
//     demais categorias o campo é ignorado e gravado NULL. App antigo não manda → NULL.
//   usuarios.atende_casa_cliente / atende_local_proprio: BOOLEAN NOT NULL DEFAULT true (quem já
//     existe segue atendendo nos dois). PUT /auth/perfil aceita; os dois false → 400.
// FILTRO (o mesmo em todo lugar em que o profissional é alcançado por um reparo — push de demanda
// nova, e-mail, lembretes "ainda aberto", reanúncio/reabertura, oferta, "fora da área" e o feed):
//   'casa_cliente'        → fica de fora quem tem atende_casa_cliente = false;
//   'local_profissional'  → fica de fora quem tem atende_local_proprio = false;
//   'tanto_faz' ou NULL   → sem filtro. Obras nunca filtram.
const { categoriasDoReparo } = require('./categoriasApp')

// Slugs REAIS de CATEGORIAS_SERVICO (utils/categoriasApp): manicure/pedicure, cabelo, barbeiro,
// maquiagem, sobrancelha, depilação, massagem, podólogo e pet. 'tatuagem' saiu (dono, 12/11/2026):
// tatuagem é sempre no estúdio, a pergunta não faz sentido.
const CATEGORIAS_LOCAL_ATENDIMENTO = Object.freeze([
  'manicure', 'cabelo', 'barbeiro', 'maquiagem', 'design_sobrancelhas',
  'depilacao', 'massagem', 'podologo', 'pet',
])
const LOCAIS_ATENDIMENTO = Object.freeze(['casa_cliente', 'local_profissional', 'tanto_faz'])

// Alguma categoria da lista (array de slugs, ou um reparo { categoria, categorias }) aceita o campo?
const aceitaLocalAtendimento = (categoriasOuReparo) => {
  const lista = Array.isArray(categoriasOuReparo) ? categoriasOuReparo : categoriasDoReparo(categoriasOuReparo)
  return lista.some(c => CATEGORIAS_LOCAL_ATENDIMENTO.includes(c))
}

// Valor a gravar para `bruto` (o que veio no body) com estas categorias:
//   categoria fora da lista → { valor: null } (ignorado, qualquer que seja o bruto);
//   bruto ausente/null/'' → { valor: null };
//   bruto fora de LOCAIS_ATENDIMENTO → { erro } (400 para o cliente).
const normalizarLocalAtendimento = (bruto, categorias) => {
  if (!aceitaLocalAtendimento(categorias)) return { valor: null }
  if (bruto === undefined || bruto === null || bruto === '') return { valor: null }
  if (typeof bruto !== 'string' || !LOCAIS_ATENDIMENTO.includes(bruto)) {
    return { erro: `local_atendimento deve ser ${LOCAIS_ATENDIMENTO.join(', ')}` }
  }
  return { valor: bruto }
}

// O profissional `alias` atende onde o reparo pede? `exprLocal` = expressão SQL do
// local_atendimento (coluna da demanda já no FROM, ex.: 'r.local_atendimento').
// COALESCE: local NULL tem de dar VERDADEIRO (sem filtro) — sem ele, NULL = 'x' AND true é NULL e o
// NOT(...) descartaria justamente quem desligou uma das opções.
const sqlAtendeLocal = (exprLocal, alias = 'u') => `NOT (
          (COALESCE(${exprLocal}, 'tanto_faz') = 'casa_cliente' AND ${alias}.atende_casa_cliente IS FALSE)
       OR (COALESCE(${exprLocal}, 'tanto_faz') = 'local_profissional' AND ${alias}.atende_local_proprio IS FALSE))`
// O mesmo predicado a partir do ID da demanda (`paramDemanda` = placeholder). Obras → sempre verdadeiro.
const sqlAtendeLocalDaDemanda = (tabela, paramDemanda, alias = 'u') => {
  if (tabela === 'obras') return 'true'
  if (tabela !== 'reparos') throw new Error(`sqlAtendeLocalDaDemanda: tabela inválida ${tabela}`)
  return `NOT EXISTS (SELECT 1 FROM reparos la WHERE la.id = ${paramDemanda}::uuid
            AND NOT ${sqlAtendeLocal('la.local_atendimento', alias)})`
}

// Migração de boot (idempotente); exportada para os testes rodarem os MESMOS statements.
const migrarLocalAtendimento = async (client) => {
  await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS local_atendimento TEXT
    CHECK (local_atendimento IN ('casa_cliente', 'local_profissional', 'tanto_faz'))`)
  await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS atende_casa_cliente BOOLEAN NOT NULL DEFAULT true`)
  await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS atende_local_proprio BOOLEAN NOT NULL DEFAULT true`)
  // Reparo com local gravado mas SEM nenhuma categoria da lista atual (ex.: só 'tatuagem', que saiu
  // da lista em 12/11/2026) volta a NULL — sem filtro. Idempotente: depois da 1ª vez não acha nada.
  // Linha legada sem `categorias` usa [categoria], como categoriasDoReparo.
  const limpos = await client.query(
    `UPDATE reparos SET local_atendimento = NULL
      WHERE local_atendimento IS NOT NULL
        AND NOT (COALESCE(categorias, CASE WHEN categoria IS NULL THEN '{}'::text[] ELSE ARRAY[categoria] END) && $1::text[])
      RETURNING id`,
    [CATEGORIAS_LOCAL_ATENDIMENTO])
  if (limpos.rows.length > 0) console.log(`[migration] local_atendimento: ${limpos.rows.length} reparo(s) sem categoria elegível voltaram a NULL`)
}

module.exports = {
  CATEGORIAS_LOCAL_ATENDIMENTO, LOCAIS_ATENDIMENTO, aceitaLocalAtendimento, normalizarLocalAtendimento,
  sqlAtendeLocal, sqlAtendeLocalDaDemanda, migrarLocalAtendimento,
}
