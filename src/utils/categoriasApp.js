// Apresentação (emoji + rótulo) das categorias — CÓPIA VERBATIM de
// pinturapro-app/src/utils/categorias.js (CATEGORIAS_SERVICO, CATEGORIAS_CONSTRUCAO e
// CATEGORIAS_OBRA), gerada a partir do arquivo do app para os emojis saírem byte a byte
// iguais aos das telas. O SLUG é o contrato com o banco (reparos.categoria usa a lista de
// serviço; obras.categoria usa a de OBRA — residencial/comercial/...; a de construção é a
// das especialidades do lado pintor/construtor). Rótulo e emoji são só apresentação.
//
// Consumidor: alertaService (título e corpo do push "novo serviço" / "nova obra"). Slug
// fora da lista NÃO quebra nada: apresentacao*() devolve o emoji padrão e o slug cru.
// Mora em src/utils/ pela mesma convenção de especialidades.js (constante compartilhada
// e inerte). Sem ordenação: aqui só se faz lookup por slug.

const CATEGORIAS_SERVICO = [
  { slug: 'hidraulica',      rotulo: 'Hidráulica',        emoji: '🔧' },
  { slug: 'eletrica',        rotulo: 'Elétrica',          emoji: '⚡' },
  { slug: 'marcenaria',      rotulo: 'Marcenaria',        emoji: '🪚' },
  { slug: 'alvenaria',       rotulo: 'Alvenaria',         emoji: '🧱' },
  { slug: 'climatizacao',    rotulo: 'Climatização',      emoji: '❄️' },
  { slug: 'chaveiro',        rotulo: 'Chaveiro',          emoji: '🔑' },
  { slug: 'faxina',          rotulo: 'Faxina',            emoji: '🧹' },
  { slug: 'eletronica',      rotulo: 'Eletrônica',        emoji: '📱' },
  { slug: 'aula_particular', rotulo: 'Aula particular',   emoji: '📚' },
  { slug: 'cuidador',        rotulo: 'Cuidador',          emoji: '🤝' },
  { slug: 'jardineiro',      rotulo: 'Jardineiro',        emoji: '🌳' },
  { slug: 'manicure',        rotulo: 'Manicure/pedicure', emoji: '💅' },
  { slug: 'cabelo',          rotulo: 'Cabelo/penteados',  emoji: '✂️' },
  { slug: 'massagem',        rotulo: 'Massagens',         emoji: '💆' },
  { slug: 'mudancas',        rotulo: 'Mudanças',          emoji: '📦' },
  { slug: 'estofamento',     rotulo: 'Estofamento',       emoji: '🛋️' },
  { slug: 'baba',            rotulo: 'Babá',              emoji: '👶' },
  { slug: 'cozinheiro',      rotulo: 'Cozinheiro',        emoji: '🍳' },
  { slug: 'motorista',       rotulo: 'Motorista',         emoji: '🚗' },
  { slug: 'garcom',          rotulo: 'Garçom',            emoji: '🍽️' },
  { slug: 'dedetizacao',     rotulo: 'Dedetização',       emoji: '🐜' },
  { slug: 'montagem_moveis', rotulo: 'Montagem de móveis',  emoji: '🔩' },
  { slug: 'vigia',           rotulo: 'Vigia',              emoji: '👮' },
  { slug: 'maquiagem',       rotulo: 'Maquiagem',          emoji: '💄' },
  { slug: 'costura',         rotulo: 'Costura',            emoji: '🧵' },
  { slug: 'seguranca',       rotulo: 'Segurança',          emoji: '🛡️' },
  { slug: 'outros',          rotulo: 'Outros',            emoji: '➕' },
]

// Lado CONSTRUÇÃO — os quatro slugs de especialidade do pintor/construtor.
const CATEGORIAS_CONSTRUCAO = [
  { slug: 'engenheiro',        rotulo: 'Engenheiro',        emoji: '📐' },
  { slug: 'construtor',        rotulo: 'Construtor',        emoji: '🏗️' },
  { slug: 'pedreiro_servente', rotulo: 'Pedreiro/servente', emoji: '🧱' },
  { slug: 'pintor',            rotulo: 'Pintor',            emoji: '🖌️' },
]

// Categoria da OBRA (obras.categoria) — é esta que o broadcast de obra nova consulta.
const CATEGORIAS_OBRA = [
  { slug: 'residencial',    rotulo: 'Residencial',    emoji: '🏠' },
  { slug: 'comercial',      rotulo: 'Comercial',      emoji: '🏢' },
  { slug: 'galpao',         rotulo: 'Galpão',         emoji: '🏭' },
  { slug: 'rural',          rotulo: 'Rural',          emoji: '🌾' },
  { slug: 'institucional',  rotulo: 'Institucional',  emoji: '🏛️' },
  { slug: 'industrial',     rotulo: 'Industrial',     emoji: '⚙️' },
  { slug: 'saneamento',     rotulo: 'Saneamento',     emoji: '🚰' },
  { slug: 'infraestrutura', rotulo: 'Infraestrutura', emoji: '🛣️' },
  { slug: 'outros',         rotulo: 'Outros',         emoji: '➕' },
]

const paraMapa = (lista) => lista.reduce((mapa, c) => { mapa[c.slug] = c; return mapa }, {})
const MAPA_SERVICO    = paraMapa(CATEGORIAS_SERVICO)
const MAPA_CONSTRUCAO = paraMapa(CATEGORIAS_CONSTRUCAO)
const MAPA_OBRA       = paraMapa(CATEGORIAS_OBRA)

// { emoji, rotulo } de um slug. Slug ausente do mapa (legado, null): emoji padrão do
// chamador e o slug cru como rótulo (null se não havia slug) — nunca lança.
const apresentacao = (mapa, slug, emojiPadrao) => {
  const c = slug != null ? mapa[slug] : undefined
  if (c) return { emoji: c.emoji, rotulo: c.rotulo }
  return { emoji: emojiPadrao, rotulo: slug == null ? null : String(slug) }
}
const apresentacaoReparo     = (slug, emojiPadrao) => apresentacao(MAPA_SERVICO, slug, emojiPadrao)
const apresentacaoConstrucao = (slug, emojiPadrao) => apresentacao(MAPA_CONSTRUCAO, slug, emojiPadrao)
const apresentacaoObra       = (slug, emojiPadrao) => apresentacao(MAPA_OBRA, slug, emojiPadrao)

module.exports = {
  CATEGORIAS_SERVICO,
  CATEGORIAS_CONSTRUCAO,
  CATEGORIAS_OBRA,
  apresentacaoReparo,
  apresentacaoConstrucao,
  apresentacaoObra,
}
