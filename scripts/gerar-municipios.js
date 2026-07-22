#!/usr/bin/env node
// Gerador do dataset de municípios (src/data/municipios-br.json).
//
// POR QUE ESTE SCRIPT EXISTE: o JSON gerado alimenta a busca geográfica de TODOS os
// usuários. Ele precisa ser auditável e regenerável — nunca um blob de origem
// desconhecida. Rode `node scripts/gerar-municipios.js` para reproduzir o arquivo do
// zero e conferir o diff.
//
// FONTES (as duas são combinadas; nenhuma coordenada é inventada, estimada ou
// interpolada — o script FALHA se algum município ficar sem coordenada):
//
//   1) IBGE — Serviço de Dados, API de Localidades (AUTORITATIVA para código/nome/UF)
//      https://servicodados.ibge.gov.br/api/v1/localidades/municipios
//      É a mesma fonte já usada por src/utils/localidade.js:48-62. NÃO fornece
//      coordenadas — só id (código IBGE), nome e a árvore político-administrativa
//      de onde se extrai a sigla da UF. Daqui vêm `ibge`, `nome` e `uf`.
//
//   2) kelvins/municipios-brasileiros (AUTORITATIVA apenas para lat/lng)
//      https://github.com/kelvins/municipios-brasileiros
//      https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/json/municipios.json
//      Licença MIT (Copyright (c) 2016 Kelvin S. do Prado). Dataset comunitário
//      amplamente utilizado, chaveado por `codigo_ibge`. Daqui vêm SOMENTE `lat`/`lng`.
//      As coordenadas são pontos de SEDE municipal (a cidade propriamente dita), não
//      centroides geométricos do polígono do município — para ancorar busca por raio
//      isso é o desejável: o usuário pensa na cidade, não no centro de massa da área.
//
// LIMITAÇÃO DE PROCEDÊNCIA, DECLARADA: a fonte (2) é comunitária. Ela não documenta
// formalmente a origem upstream de cada coordenada. Foi validada por amostragem contra
// o Nominatim/OpenStreetMap (fonte independente) na geração — ver validarAmostra() —
// e o merge exige casamento 1:1 com a lista oficial do IBGE. Se um dia for preciso
// procedência oficial ponta a ponta, o substituto natural é a malha territorial do
// IBGE (centroides calculados dos polígonos) — troque apenas buscarCoordenadas().

const fs = require('fs')
const path = require('path')

const URL_IBGE = 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios'
const URL_COORDS = 'https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/json/municipios.json'
const SAIDA = path.join(__dirname, '..', 'src', 'data', 'municipios-br.json')

// 26 estados + DF.
const UFS_VALIDAS = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
  'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
])

// Caixa envolvente do Brasil, com folga. Extremos reais: norte +5,27 (Monte Caburaí/RR);
// sul -33,75 (Chuí/RS); leste -34,79 (Ponta do Seixas/PB) e -32,4 em Fernando de Noronha;
// oeste -73,99 (Mâncio Lima/AC).
const LIMITES_BR = { latMin: -34.0, latMax: 5.5, lngMin: -74.5, lngMax: -28.5 }

// Extrai a sigla da UF do município IBGE (lida com as duas formas do payload) —
// mesma lógica de src/utils/localidade.js:39-42.
const ufDoMunicipio = (m) =>
  m?.microrregiao?.mesorregiao?.UF?.sigla ||
  m?.['regiao-imediata']?.['regiao-intermediaria']?.UF?.sigla ||
  null

async function buscarJson(url, rotulo) {
  process.stdout.write(`[gerar-municipios] buscando ${rotulo}... `)
  const resp = await fetch(url, { headers: { 'User-Agent': 'pinturapro-gerar-municipios/1.0' } })
  if (!resp.ok) throw new Error(`${rotulo}: HTTP ${resp.status}`)
  const dados = await resp.json()
  console.log(`${dados.length} registros`)
  return dados
}

const buscarMunicipiosIbge = () => buscarJson(URL_IBGE, 'IBGE (nome/uf/codigo)')
const buscarCoordenadas = () => buscarJson(URL_COORDS, 'coordenadas (lat/lng)')

// Junta as duas fontes por código IBGE. Regra dura: TODO município do IBGE precisa de
// coordenada. Nenhum preenchimento por aproximação, média ou vizinho — se faltar, aborta.
function combinar(municipiosIbge, coordenadas) {
  const porCodigo = new Map(coordenadas.map((c) => [c.codigo_ibge, c]))
  const registros = []
  const semCoordenada = []
  const semUf = []

  for (const m of municipiosIbge) {
    const uf = ufDoMunicipio(m)
    if (!uf) { semUf.push(`${m.id} ${m.nome}`); continue }

    const c = porCodigo.get(m.id)
    if (!c || typeof c.latitude !== 'number' || typeof c.longitude !== 'number' ||
        !isFinite(c.latitude) || !isFinite(c.longitude)) {
      semCoordenada.push(`${m.id} ${m.nome}/${uf}`)
      continue
    }

    // nome/uf vêm do IBGE (grafia oficial); lat/lng vêm da fonte de coordenadas, SEM
    // arredondar ou transformar — o valor gravado é exatamente o valor da fonte.
    registros.push({ ibge: m.id, nome: m.nome, uf, lat: c.latitude, lng: c.longitude })
  }

  if (semUf.length > 0) {
    throw new Error(`${semUf.length} município(s) sem UF resolvida:\n  ${semUf.join('\n  ')}`)
  }
  if (semCoordenada.length > 0) {
    throw new Error(
      `${semCoordenada.length} município(s) do IBGE SEM coordenada na fonte. ` +
      `Abortado de propósito: preencher por estimativa é pior que não gerar.\n  ` +
      semCoordenada.join('\n  ')
    )
  }
  return registros
}

// Mesmas invariantes que src/utils/geoBusca.js reaplica no boot — falhar aqui é
// muito mais barato que falhar em produção.
function validar(registros) {
  const erros = []
  if (registros.length < 5560) erros.push(`registros de menos: ${registros.length} (< 5560)`)

  const codigosVistos = new Set()
  for (const r of registros) {
    const id = `${r.nome}/${r.uf}`
    if (!UFS_VALIDAS.has(r.uf)) erros.push(`${id}: uf inválida "${r.uf}"`)
    if (codigosVistos.has(r.ibge)) erros.push(`${id}: código IBGE duplicado ${r.ibge}`)
    codigosVistos.add(r.ibge)
    if (r.lat < LIMITES_BR.latMin || r.lat > LIMITES_BR.latMax ||
        r.lng < LIMITES_BR.lngMin || r.lng > LIMITES_BR.lngMax) {
      erros.push(`${id}: coordenada fora do Brasil (${r.lat}, ${r.lng})`)
    }
  }
  if (erros.length > 0) {
    throw new Error(`validação falhou (${erros.length}):\n  ${erros.slice(0, 30).join('\n  ')}`)
  }

  const porUf = registros.reduce((acc, r) => { acc[r.uf] = (acc[r.uf] || 0) + 1; return acc }, {})
  const ufsFaltando = [...UFS_VALIDAS].filter((uf) => !porUf[uf])
  if (ufsFaltando.length > 0) throw new Error(`UFs sem nenhum município: ${ufsFaltando.join(', ')}`)
  return porUf
}

// Conferência independente por amostragem: compara algumas coordenadas com o
// Nominatim/OpenStreetMap. Não altera nada — só imprime a distância para revisão
// humana. Um desvio de poucos km é esperado (ponto de sede x nó "place" do OSM);
// dezenas/centenas de km indicariam dataset trocado ou sinal invertido.
async function validarAmostra(registros) {
  const alvos = [['Patos de Minas', 'MG'], ['Ituiutaba', 'MG'], ['João Pessoa', 'PB'],
                 ['Manaus', 'AM'], ['Porto Alegre', 'RS'], ['Rio Branco', 'AC']]
  const haversine = (aLat, aLng, bLat, bLng) => {
    const R = 6371, rad = (x) => x * Math.PI / 180
    const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng)
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(h))
  }

  console.log('\n[gerar-municipios] conferência por amostragem (Nominatim/OSM, fonte independente):')
  for (const [nome, uf] of alvos) {
    const r = registros.find((x) => x.nome === nome && x.uf === uf)
    if (!r) { console.log(`  ${nome}/${uf}: AUSENTE no dataset`); continue }
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(`${nome}, ${uf}, Brasil`)}&format=json&limit=1`
      const resp = await fetch(url, { headers: { 'User-Agent': 'pinturapro-gerar-municipios/1.0 (validacao pontual)' } })
      const j = await resp.json()
      if (!j[0]) { console.log(`  ${nome}/${uf}: sem resposta do Nominatim (ignorado)`); continue }
      const dist = haversine(r.lat, r.lng, parseFloat(j[0].lat), parseFloat(j[0].lon))
      console.log(`  ${nome}/${uf}: dataset(${r.lat}, ${r.lng}) vs OSM → ${dist.toFixed(1)} km`)
    } catch (err) {
      console.log(`  ${nome}/${uf}: conferência indisponível (${err.message}) — ignorado`)
    }
    // Política de uso do Nominatim: no máximo 1 req/s.
    await new Promise((r) => setTimeout(r, 1200))
  }
}

async function main() {
  const [municipiosIbge, coordenadas] = await Promise.all([buscarMunicipiosIbge(), buscarCoordenadas()])

  const registros = combinar(municipiosIbge, coordenadas)
  const porUf = validar(registros)

  // Ordem estável (uf, nome) → o diff entre duas gerações mostra só mudança real de dado.
  registros.sort((a, b) => a.uf.localeCompare(b.uf) || a.nome.localeCompare(b.nome, 'pt-BR'))

  const saida = {
    _meta: {
      descricao: 'Municípios brasileiros com coordenadas da sede. NÃO EDITAR À MÃO — gerado por scripts/gerar-municipios.js',
      gerado_em: new Date().toISOString().slice(0, 10),
      total: registros.length,
      fontes: [
        { papel: 'codigo/nome/uf', nome: 'IBGE — API de Localidades', url: URL_IBGE, licenca: 'dados públicos IBGE' },
        { papel: 'lat/lng', nome: 'kelvins/municipios-brasileiros', url: URL_COORDS, licenca: 'MIT' }
      ]
    },
    municipios: registros
  }

  fs.mkdirSync(path.dirname(SAIDA), { recursive: true })
  fs.writeFileSync(SAIDA, JSON.stringify(saida), 'utf8')

  const kb = (fs.statSync(SAIDA).size / 1024).toFixed(0)
  console.log(`\n[gerar-municipios] OK — ${registros.length} municípios, ${Object.keys(porUf).length} UFs, ${kb} KB`)
  console.log(`[gerar-municipios] escrito em ${SAIDA}`)

  if (!process.argv.includes('--sem-amostra')) await validarAmostra(registros)
}

main().catch((err) => {
  console.error('\n[gerar-municipios] FALHOU — nenhum arquivo foi escrito:', err.message)
  process.exit(1)
})
