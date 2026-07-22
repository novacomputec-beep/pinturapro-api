// Resolução geográfica da busca: coordenadas de município + a cascata que decide
// DE ONDE a busca é medida e SOBRE QUAL recorte ela filtra.
//
// Nada aqui é usado ainda — este módulo é a base para trocar, num passo seguinte, o
// filtro geográfico de /reparos (src/routes/index.js:1864-1926) e /obras
// (src/controllers/obrasController.js:36-98), que hoje degradam para "país inteiro"
// quando seus guards não resolvem.
//
// Dataset: src/data/municipios-br.json, gerado por scripts/gerar-municipios.js
// (procedência e fontes documentadas lá). Fica todo em memória: ~5,6 mil registros,
// dois índices Map, custo de lookup O(1) e ZERO chamada de rede no caminho da request
// — de propósito, para não repetir a dependência de Nominatim que hoje é o ponto único
// de falha das coordenadas (o app geocodifica no cliente, e quando falha grava NULL).

const { pool } = require('./supabase')
const { normalizar } = require('./localidade')
const dataset = require('../data/municipios-br.json')

const UFS_VALIDAS = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
  'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
])

// Caixa envolvente do Brasil, com folga (mesmos limites de scripts/gerar-municipios.js).
const LIMITES_BR = { latMin: -34.0, latMax: 5.5, lngMin: -74.5, lngMax: -28.5 }

const MINIMO_REGISTROS = 5560   // o país tem ~5.570; abaixo disso o arquivo está truncado
const MAXIMO_DESCARTES = 10     // anomalias pontuais toleradas antes de considerar o arquivo podre

// ─── Portão de sanidade (boot) ────────────────────────────────────────────────
// DECISÃO: falha ESTRUTURAL derruba o boot; anomalia PONTUAL descarta a linha e segue.
//
// Estrutural (arquivo ausente/ilegível, formato errado, contagem abaixo do mínimo, ou
// descartes acima do limite) é defeito de DEPLOY, não condição de runtime: o dataset é
// estático e versionado, então ou o build está certo ou está errado — não há como se
// recuperar sozinho. Derrubar aqui é o comportamento seguro porque a Railway só troca o
// deployment quando o novo fica saudável: um build quebrado NÃO substitui o que está no
// ar, ele simplesmente não sobe. É também o que server.js:389-404 já faz com a migração
// de boot (process.exit(1) e servidor não inicia).
//
// Já uma linha isolada com uf estranha ou coordenada fora da caixa não justifica derrubar
// login, pagamento e chat: descartamos a linha (com log alto) e aquele município apenas
// deixa de ter âncora — cai no filtro textual por cidade/uf, que é justamente o fallback
// seguro. O que NÃO fazemos em hipótese alguma é "consertar" a coordenada por estimativa.
const carregar = () => {
  const registros = Array.isArray(dataset) ? dataset : dataset?.municipios
  if (!Array.isArray(registros)) {
    throw new Error('[geoBusca] municipios-br.json inválido: esperado array ou { municipios: [...] }')
  }
  if (registros.length < MINIMO_REGISTROS) {
    throw new Error(`[geoBusca] municipios-br.json truncado: ${registros.length} registros (mínimo ${MINIMO_REGISTROS}). Rode scripts/gerar-municipios.js`)
  }

  const validos = []
  const descartados = []
  for (const r of registros) {
    const uf = String(r?.uf || '').toUpperCase()
    const lat = Number(r?.lat)
    const lng = Number(r?.lng)
    if (!r?.nome || !UFS_VALIDAS.has(uf) || !isFinite(lat) || !isFinite(lng) ||
        lat < LIMITES_BR.latMin || lat > LIMITES_BR.latMax ||
        lng < LIMITES_BR.lngMin || lng > LIMITES_BR.lngMax) {
      descartados.push(`${r?.nome || '?'}/${r?.uf || '?'} (${r?.lat}, ${r?.lng})`)
      continue
    }
    validos.push({ ibge: r.ibge, nome: r.nome, uf, lat, lng })
  }

  if (descartados.length > MAXIMO_DESCARTES) {
    throw new Error(`[geoBusca] ${descartados.length} registros inválidos (limite ${MAXIMO_DESCARTES}) — dataset não confiável:\n  ${descartados.slice(0, 20).join('\n  ')}`)
  }
  if (descartados.length > 0) {
    console.warn(`[geoBusca] ${descartados.length} município(s) descartado(s) por dado inválido — sem âncora, cairão no filtro por cidade/uf:\n  ${descartados.join('\n  ')}`)
  }
  if (validos.length < MINIMO_REGISTROS) {
    throw new Error(`[geoBusca] apenas ${validos.length} municípios válidos (mínimo ${MINIMO_REGISTROS})`)
  }
  return validos
}

const MUNICIPIOS = carregar()

// Dois índices, construídos uma única vez no require:
//   porCidadeUf — 'patos de minas|MG' → registro   (chave exata, resolve homônimos)
//   porCidade   — 'patos de minas'    → registro | null
// O null é deliberado: nome que existe em mais de uma UF vira null e, sem UF informada,
// coordsDeCidade devolve null em vez de chutar um estado. Mesma política do ufDeCidade
// em src/utils/localidade.js:77 — na dúvida, não adivinha.
const porCidadeUf = new Map()
const porCidade = new Map()

for (const m of MUNICIPIOS) {
  const chave = normalizar(m.nome)
  porCidadeUf.set(`${chave}|${m.uf}`, m)
  if (!porCidade.has(chave)) porCidade.set(chave, m)
  else if (porCidade.get(chave)?.uf !== m.uf) porCidade.set(chave, null)
}

console.log(`[geoBusca] ${MUNICIPIOS.length} municípios carregados | ${porCidadeUf.size} chaves cidade+uf | ${porCidade.size} nomes distintos`)

// Coordenadas da sede de um município. Devolve null quando não encontra E quando o nome
// é ambíguo sem UF — nunca uma escolha arbitrária entre homônimos.
//
// `pais` já entra na assinatura (hoje só 'BR') para que a internacionalização futura
// troque só o miolo deste módulo: as chamadas nas rotas não mudam quando o dataset virar
// tabela/multi-país.
const coordsDeCidade = (cidade, uf, pais = 'BR') => {
  if (!cidade || String(pais).toUpperCase() !== 'BR') return null
  const chave = normalizar(cidade)

  const ufNorm = String(uf || '').trim().toUpperCase()
  if (ufNorm) {
    const exato = porCidadeUf.get(`${chave}|${ufNorm}`)
    if (exato) return { nome: exato.nome, uf: exato.uf, lat: exato.lat, lng: exato.lng }
  }

  const unico = porCidade.get(chave)
  if (!unico) return null   // inexistente (undefined) ou ambíguo (null)
  return { nome: unico.nome, uf: unico.uf, lat: unico.lat, lng: unico.lng }
}

// Resolve, ANTES de montar a query, dois conceitos que precisam continuar separados:
//
//   escopo — a cidade/uf que define PERTENCIMENTO (o filtro textual e a metade
//            cumulativa "OR cidade = ..." do raio)
//   ancora — o CENTRO a partir do qual a distância é medida
//
// Por que separados: se a âncora também ditasse o escopo, o caminho com GPS perderia a
// cláusula de cidade (a âncora do GPS não tem cidade associada) e as demandas com
// latitude/longitude NULL sumiriam do feed — exatamente a regressão que se quer evitar.
// Hoje esse "OR r.cidade" existe em src/routes/index.js:1920-1923 e vem da cidade do
// usuário; mantê-lo no escopo preserva o comportamento atual desse caminho.
//
// Cascata da ÂNCORA (decidida com o dono):
//   1. cidade escolhida  → coordenadas DELA (o GPS do aparelho é ignorado de propósito:
//      quem escolhe uma cidade quer ver AQUELA cidade, não o entorno de onde ele está)
//   2. GPS do aparelho
//   3. cidade do próprio usuário → coordenadas dela
//   4. nenhuma  → sem raio possível (quem chama decide o fallback: cidade → uf → vazio,
//      nunca "país inteiro")
const resolverBusca = async ({ cidade_busca, uf_busca, lat, lng, usuarioId }) => {
  const cidadeEscolhida = String(cidade_busca || '').trim()
  const ufEscolhida = String(uf_busca || '').trim().toUpperCase()

  // 1. Cidade escolhida manda em tudo — inclusive sobre um GPS válido.
  if (cidadeEscolhida) {
    const c = coordsDeCidade(cidadeEscolhida, ufEscolhida)
    return {
      escopo: { cidade: cidadeEscolhida, uf: ufEscolhida || c?.uf || null, origem: 'cidade_busca' },
      ancora: c
        ? { lat: c.lat, lng: c.lng, origem: 'cidade_busca' }
        : { lat: null, lng: null, origem: null }
    }
  }

  // Sem cidade escolhida, o escopo é sempre o do próprio usuário — mesmo quando a âncora
  // vier do GPS. É isso que preserva a metade "OR cidade = <cidade do usuário>" de hoje.
  let cidadeUsuario = null
  let ufUsuario = null
  if (usuarioId) {
    try {
      const { rows } = await pool.query('SELECT cidade, uf FROM usuarios WHERE id = $1', [usuarioId])
      cidadeUsuario = String(rows[0]?.cidade || '').trim() || null
      ufUsuario = String(rows[0]?.uf || '').trim().toUpperCase() || null
    } catch (err) {
      // Falha ao ler o perfil não pode virar 500 no feed: segue sem escopo do usuário e
      // quem chama aplica o fallback (que nunca é "país inteiro").
      console.error('[geoBusca] falha ao ler cidade/uf do usuário:', err.message)
    }
  }
  const escopo = { cidade: cidadeUsuario, uf: ufUsuario, origem: 'usuario' }

  // 2. GPS do aparelho.
  const latNum = parseFloat(lat)
  const lngNum = parseFloat(lng)
  if (!isNaN(latNum) && !isNaN(lngNum)) {
    return { escopo, ancora: { lat: latNum, lng: lngNum, origem: 'gps' } }
  }

  // 3. Cidade do próprio usuário.
  const c = cidadeUsuario ? coordsDeCidade(cidadeUsuario, ufUsuario) : null
  if (c) return { escopo, ancora: { lat: c.lat, lng: c.lng, origem: 'cidade_usuario' } }

  // 4. Sem âncora.
  return { escopo, ancora: { lat: null, lng: null, origem: null } }
}

module.exports = { coordsDeCidade, resolverBusca, MUNICIPIOS }
