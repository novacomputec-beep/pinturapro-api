// Resolve o UF (sigla do estado) a partir do nome da cidade — escala nacional.
//
// Rede de segurança server-side: quando uma criação/edição recebe `cidade` mas não `uf`,
// derivamos o `uf` para que o filtro "Estado" (o.uf / r.uf) nunca perca a linha.
//
// Fonte de verdade: API IBGE de municípios (a MESMA usada pelo SeletorLocalidade no app),
// buscada na primeira utilização e mantida em cache na memória por toda a vida do processo.
// Fallback estático com as principais cidades para quando a IBGE estiver indisponível.
// Assim qualquer cidade brasileira é resolvida automaticamente, sem manutenção manual.

const IBGE_MUNICIPIOS = 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios'

// Normaliza para casar nomes: minúsculas, sem acento, espaços colapsados.
const normalizar = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')

// Fallback estático — capitais + grandes municípios. Chaves normalizadas.
// Só é usado quando a IBGE não responde. Lista enxuta de propósito (cobre o grosso do tráfego).
const FALLBACK_CIDADE_UF = {
  'sao paulo': 'SP', 'rio de janeiro': 'RJ', 'brasilia': 'DF', 'salvador': 'BA',
  'fortaleza': 'CE', 'belo horizonte': 'MG', 'manaus': 'AM', 'curitiba': 'PR',
  'recife': 'PE', 'goiania': 'GO', 'belem': 'PA', 'porto alegre': 'RS',
  'guarulhos': 'SP', 'campinas': 'SP', 'sao luis': 'MA', 'maceio': 'AL',
  'natal': 'RN', 'campo grande': 'MS', 'teresina': 'PI', 'joao pessoa': 'PB',
  'florianopolis': 'SC', 'aracaju': 'SE', 'cuiaba': 'MT', 'porto velho': 'RO',
  'macapa': 'AP', 'rio branco': 'AC', 'boa vista': 'RR', 'palmas': 'TO',
  'vitoria': 'ES', 'uberlandia': 'MG', 'patos de minas': 'MG', 'formiga': 'MG',
  'ribeirao preto': 'SP', 'sorocaba': 'SP', 'contagem': 'MG', 'juiz de fora': 'MG',
  'londrina': 'PR', 'joinville': 'SC', 'niteroi': 'RJ', 'caxias do sul': 'RS',
  'uberaba': 'MG', 'montes claros': 'MG', 'duque de caxias': 'RJ', 'osasco': 'SP',
}

// Extrai a sigla do UF de um município IBGE (lida com as duas formas do payload).
const ufDoMunicipio = (m) =>
  m?.microrregiao?.mesorregiao?.UF?.sigla ||
  m?.['regiao-imediata']?.['regiao-intermediaria']?.UF?.sigla ||
  null

// Cache do mapa IBGE: nome normalizado -> uf. Valor null marca nome ambíguo (>1 estado).
let cacheIbge = null        // Map<string, string|null>
let carregandoIbge = null   // Promise em voo — evita fetches concorrentes na primeira chamada

async function carregarIbge() {
  const resp = await fetch(IBGE_MUNICIPIOS)
  if (!resp.ok) throw new Error(`IBGE HTTP ${resp.status}`)
  const municipios = await resp.json()
  const mapa = new Map()
  for (const m of municipios) {
    const nome = normalizar(m.nome)
    const uf = ufDoMunicipio(m)
    if (!nome || !uf) continue
    if (!mapa.has(nome)) mapa.set(nome, uf)
    else if (mapa.get(nome) !== uf) mapa.set(nome, null) // existe em mais de um estado
  }
  console.log(`[localidade] cache IBGE carregado: ${mapa.size} cidades`)
  return mapa
}

// Retorna a sigla do UF (ex.: 'MG') ou null quando desconhecida / ambígua / indisponível.
async function ufDeCidade(cidade) {
  if (!cidade) return null
  const chave = normalizar(cidade)

  // 1) IBGE (cache em memória por toda a vida do processo)
  try {
    if (!cacheIbge) {
      if (!carregandoIbge) carregandoIbge = carregarIbge()
      cacheIbge = await carregandoIbge
    }
    const uf = cacheIbge.get(chave)
    if (uf) return uf                              // resolvido (não-ambíguo)
    if (uf === null) return FALLBACK_CIDADE_UF[chave] || null  // ambíguo: não chuta
    // undefined → não encontrada no IBGE: cai no fallback
  } catch (err) {
    console.warn('[localidade] IBGE indisponível, usando fallback estático | msg:', err.message)
    carregandoIbge = null // libera para nova tentativa numa próxima chamada
  }

  // 2) Fallback estático
  return FALLBACK_CIDADE_UF[chave] || null
}

module.exports = { ufDeCidade, FALLBACK_CIDADE_UF, normalizar }
