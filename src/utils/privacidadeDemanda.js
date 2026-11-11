// Privacidade do LOCAL da demanda nas respostas ao profissional (dono, 11/11/2026).
//
// O que o dono informou ao abrir a demanda — endereço exato (endereco_obra / endereco_reparo,
// texto livre), ponto de referência e coordenadas exatas — só chega ao profissional ESCOLHIDO e
// só DEPOIS de dia e hora combinados (chegada_prevista_em gravado). Antes disso, e para qualquer
// outro leitor profissional (feed, detalhe de assinante, candidato com proposta aceita mas ainda
// sem match), a API devolve:
//   - latitude/longitude ARREDONDADAS a CASAS_COORDENADA decimais (3 → passo de 0,001° ≈ 110 m):
//     o app continua calculando a distância aproximada e desenhando o ponto no mapa, mas não
//     recebe a casa. Tipo preservado (NUMERIC chega como string do pg; número fica número);
//   - endereco_* e ponto_referencia = null e `endereco_liberado: false`.
// O dono (qualquer conta contratante da pessoa) e o admin recebem tudo exato, com
// `endereco_liberado: true`.
//
// Só a RESPOSTA é alterada: toda conta de distância e alcance do servidor (sqlAlcance, filtro por
// raio do feed, avisos por distância) segue nas colunas exatas do banco.
const CASAS_COORDENADA = 3
const FATOR = 10 ** CASAS_COORDENADA

const arredondarCoordenada = (v) => {
  if (v === null || v === undefined || v === '') return v
  const n = Number(v)
  if (!Number.isFinite(n)) return v
  const arredondado = Math.round(n * FATOR) / FATOR
  return typeof v === 'string' ? arredondado.toFixed(CASAS_COORDENADA) : arredondado
}

// Arredonda latitude/longitude da linha (muta e devolve a própria linha).
const ofuscarCoordenadas = (linha) => {
  if (!linha) return linha
  if ('latitude' in linha) linha.latitude = arredondarCoordenada(linha.latitude)
  if ('longitude' in linha) linha.longitude = arredondarCoordenada(linha.longitude)
  return linha
}

const ofuscarCoordenadasLista = (linhas) => { for (const l of linhas) ofuscarCoordenadas(l); return linhas }

// Quem pode ver o local exato: dono/admin sempre; o profissional do match só com horário combinado.
const localLiberado = ({ ehDono = false, ehAdmin = false, ehProfissionalDoMatch = false, demanda }) =>
  ehDono || ehAdmin || (ehProfissionalDoMatch && !!demanda?.chegada_prevista_em)

// Aplica a regra inteira à linha de detalhe: endereço/ponto de referência + coordenadas +
// endereco_liberado. Muta e devolve a própria linha. Procura os dois nomes de coluna de endereço
// porque a função serve às duas tabelas.
const aplicarPrivacidadeLocal = (linha, acesso) => {
  if (!linha) return linha
  const liberado = localLiberado({ ...acesso, demanda: linha })
  if (!liberado) {
    for (const campo of ['endereco_obra', 'endereco_reparo', 'ponto_referencia']) {
      if (campo in linha) linha[campo] = null
    }
    ofuscarCoordenadas(linha)
  }
  linha.endereco_liberado = liberado
  return linha
}

module.exports = { CASAS_COORDENADA, arredondarCoordenada, ofuscarCoordenadas, ofuscarCoordenadasLista, localLiberado, aplicarPrivacidadeLocal }
