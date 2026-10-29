// Etiquetas da avaliação do profissional — FONTE ÚNICA da API (o app lê GET /config/
// etiquetas-avaliacao e nunca as grava em código).
//
// Estrutura: 11 grupos de especialidade × 5 níveis × 3 etiquetas, mais as UNIVERSAIS por
// nível (4–5: Pontual, Educado; 1–3: Atrasou, Mal-educado). Os 10 grupos de serviço são os
// MESMOS de utils/gruposCategorias (GRUPOS_RELACIONADOS, chaves em CHAVE_DO_GRUPO); o 11º,
// 'construcao_pintura' ("Construção e pintura"), cobre TODA obra (lado pintor/construtor:
// ESPECIALIDADES_OBRA). Reparo cujas categorias não caem em grupo nenhum (só 'outros')
// aceita apenas as universais.
//
// TABELA PROVISÓRIA: os textos abaixo são placeholders coerentes com cada grupo e serão
// substituídos pela tabela definitiva do dono (mesma forma: 3 por grupo e nível).
//
// Escrita (POST /avaliacoes): nota 1–5 + etiquetas[] validadas contra o(s) grupo(s) da
// demanda avaliada e o nível escolhido (validarEtiquetas). Sem texto livre.
// Selo "bem avaliado": SELO_MIN_CINCO_ESTRELAS avaliações 5★ (sqlSeloBemAvaliado).
const { GRUPOS_RELACIONADOS, CHAVE_DO_GRUPO, CHAVE_DO_SLUG } = require('./gruposCategorias')
const { ESPECIALIDADES_OBRA } = require('./especialidades')
const { categoriasDoReparo } = require('./categoriasApp')

const NIVEIS = { 5: 'Excelente', 4: 'Bom', 3: 'Regular', 2: 'Ruim', 1: 'Péssimo' }

const ETIQUETAS_UNIVERSAIS = {
  5: ['Pontual', 'Educado'],
  4: ['Pontual', 'Educado'],
  3: ['Atrasou', 'Mal-educado'],
  2: ['Atrasou', 'Mal-educado'],
  1: ['Atrasou', 'Mal-educado'],
}

const GRUPO_OBRA = { chave: 'construcao_pintura', nome: 'Construção e pintura', especialidades: ESPECIALIDADES_OBRA }

const ETIQUETAS_POR_GRUPO = {
  construcao_pintura: {
    5: ['Acabamento impecável', 'Obra no prazo', 'Deixou tudo limpo'],
    4: ['Bom acabamento', 'Cumpriu o combinado', 'Organizado'],
    3: ['Acabamento mediano', 'Pequenos atrasos', 'Precisou de retoques'],
    2: ['Acabamento ruim', 'Atrasou muito', 'Deixou sujeira'],
    1: ['Obra inacabada', 'Trabalho malfeito', 'Abandonou a obra'],
  },
  eletrica_tec: {
    5: ['Resolveu de primeira', 'Instalação segura', 'Explicou tudo'],
    4: ['Resolveu o problema', 'Serviço limpo', 'Boa comunicação'],
    3: ['Resolveu parcialmente', 'Demorou mais que o previsto', 'Faltou explicar'],
    2: ['Problema voltou', 'Instalação malfeita', 'Pouco cuidado'],
    1: ['Não resolveu', 'Deixou risco de segurança', 'Danificou algo'],
  },
  reparos_casa: {
    5: ['Reparo perfeito', 'Rápido e caprichoso', 'Deixou tudo limpo'],
    4: ['Reparo bem feito', 'Dentro do prazo', 'Cuidadoso'],
    3: ['Reparo mediano', 'Demorou', 'Faltou acabamento'],
    2: ['Reparo malfeito', 'Deixou bagunça', 'Pouco cuidado'],
    1: ['Não resolveu', 'Piorou o problema', 'Danificou algo'],
  },
  limpeza: {
    5: ['Limpeza impecável', 'Detalhista', 'Cuidou de tudo'],
    4: ['Limpeza bem feita', 'Caprichoso', 'Cuidou dos objetos'],
    3: ['Limpeza superficial', 'Faltaram detalhes', 'Demorou'],
    2: ['Limpeza malfeita', 'Deixou cantos sujos', 'Pouco cuidado'],
    1: ['Não limpou', 'Danificou objetos', 'Abandonou o serviço'],
  },
  beleza: {
    5: ['Resultado perfeito', 'Higiene impecável', 'Mãos de fada'],
    4: ['Bom resultado', 'Material limpo', 'Atencioso'],
    3: ['Resultado mediano', 'Demorou', 'Pouca atenção'],
    2: ['Resultado ruim', 'Higiene fraca', 'Machucou'],
    1: ['Resultado péssimo', 'Sem higiene', 'Causou dano'],
  },
  festas: {
    5: ['Festa impecável', 'Animou todo mundo', 'Tudo no horário'],
    4: ['Bom serviço', 'Organizado', 'Boa apresentação'],
    3: ['Serviço mediano', 'Faltou organização', 'Pequenos atrasos'],
    2: ['Serviço ruim', 'Desorganizado', 'Faltou material'],
    1: ['Não compareceu', 'Estragou a festa', 'Abandonou o evento'],
  },
  cuidado: {
    5: ['Muito atencioso', 'Confiança total', 'Carinhoso'],
    4: ['Atencioso', 'Responsável', 'Comunicativo'],
    3: ['Atenção mediana', 'Pouco comunicativo', 'Distraído'],
    2: ['Desatento', 'Pouco cuidado', 'Não seguiu orientações'],
    1: ['Negligente', 'Situação de risco', 'Abandonou o cuidado'],
  },
  transporte: {
    5: ['Direção segura', 'Carga intacta', 'Pontualidade total'],
    4: ['Direção cuidadosa', 'Carga bem tratada', 'Comunicativo'],
    3: ['Direção mediana', 'Pequenos danos', 'Pequenos atrasos'],
    2: ['Direção imprudente', 'Carga danificada', 'Muito atraso'],
    1: ['Não compareceu', 'Perdeu ou quebrou itens', 'Comportamento de risco'],
  },
  seguranca: {
    5: ['Atento o tempo todo', 'Postura exemplar', 'Confiança total'],
    4: ['Atento', 'Boa postura', 'Responsável'],
    3: ['Atenção mediana', 'Distraído às vezes', 'Pouca iniciativa'],
    2: ['Desatento', 'Postura inadequada', 'Ausentou-se'],
    1: ['Abandonou o posto', 'Negligente', 'Comportamento de risco'],
  },
  digital_aulas: {
    5: ['Entrega perfeita', 'Didático', 'Superou expectativas'],
    4: ['Boa entrega', 'Claro e objetivo', 'Dentro do prazo'],
    3: ['Entrega mediana', 'Precisou de ajustes', 'Atrasou entregas'],
    2: ['Entrega ruim', 'Pouco claro', 'Muitos atrasos'],
    1: ['Não entregou', 'Trabalho inutilizável', 'Sumiu'],
  },
  arte: {
    5: ['Trabalho impecável', 'Criativo', 'Acabamento perfeito'],
    4: ['Bom trabalho', 'Caprichoso', 'Cumpriu o combinado'],
    3: ['Trabalho mediano', 'Faltou acabamento', 'Demorou'],
    2: ['Trabalho ruim', 'Diferente do combinado', 'Pouco cuidado'],
    1: ['Trabalho inutilizável', 'Não entregou', 'Danificou material'],
  },
}

// Os 11 grupos na ordem de apresentação: os 10 de serviço (ordem de GRUPOS_RELACIONADOS) + obra.
const GRUPOS_AVALIACAO = [
  ...Object.entries(GRUPOS_RELACIONADOS).map(([nome, especialidades]) => ({ chave: CHAVE_DO_GRUPO[nome], nome, especialidades })),
  GRUPO_OBRA,
]

// Conferência na carga: todo grupo tem 5 níveis × 3 etiquetas, nenhuma repete uma universal.
const validarTabela = () => {
  const universais = new Set(Object.values(ETIQUETAS_UNIVERSAIS).flat())
  for (const g of GRUPOS_AVALIACAO) {
    const porNivel = ETIQUETAS_POR_GRUPO[g.chave]
    if (!porNivel) throw new Error(`etiquetasAvaliacao: grupo "${g.chave}" sem etiquetas`)
    for (const nivel of [1, 2, 3, 4, 5]) {
      const lista = porNivel[nivel]
      if (!Array.isArray(lista) || lista.length !== 3) throw new Error(`etiquetasAvaliacao: "${g.chave}" nível ${nivel} precisa de 3 etiquetas`)
      for (const e of lista) if (universais.has(e)) throw new Error(`etiquetasAvaliacao: "${e}" repete uma universal`)
    }
  }
}
validarTabela()

const SELO_MIN_CINCO_ESTRELAS = 3
const ETIQUETAS_MAX_POR_AVALIACAO = 5 // 3 do grupo + 2 universais

// Catálogo completo para GET /config/etiquetas-avaliacao (somente leitura).
const catalogoEtiquetas = () => ({
  niveis: Object.entries(NIVEIS).map(([nota, rotulo]) => ({ nota: Number(nota), rotulo })).sort((a, b) => b.nota - a.nota),
  universais: ETIQUETAS_UNIVERSAIS,
  grupos: GRUPOS_AVALIACAO.map(g => ({ ...g, etiquetas: ETIQUETAS_POR_GRUPO[g.chave] })),
  max_por_avaliacao: ETIQUETAS_MAX_POR_AVALIACAO,
  selo_bem_avaliado: { minimo_cinco_estrelas: SELO_MIN_CINCO_ESTRELAS },
})

// Grupo(s) da demanda avaliada: obra → ['construcao_pintura']; reparo → chave de cada categoria
// (categoriasDoReparo) que esteja em algum grupo, sem repetição. Vazio = só universais.
const gruposDaDemanda = (tabela, demanda) => {
  if (tabela === 'obras') return [GRUPO_OBRA.chave]
  const chaves = categoriasDoReparo(demanda).map(slug => CHAVE_DO_SLUG[slug]).filter(Boolean)
  return [...new Set(chaves)]
}

// Etiquetas permitidas para (grupos, nota): união das do(s) grupo(s) no nível + universais do nível.
const etiquetasPermitidas = (grupos, nota) => {
  const saida = new Set(ETIQUETAS_UNIVERSAIS[nota] || [])
  for (const g of grupos) for (const e of ETIQUETAS_POR_GRUPO[g]?.[nota] || []) saida.add(e)
  return saida
}

// Valida o corpo da escrita. Devolve { erro } ou { valor: etiquetas únicas na ordem enviada }.
// Lista ausente/vazia é válida (a nota basta). Nunca lança.
const validarEtiquetas = (bruto, grupos, nota) => {
  if (bruto == null) return { valor: [] }
  if (!Array.isArray(bruto) || !bruto.every(e => typeof e === 'string')) return { erro: 'etiquetas deve ser uma lista de textos' }
  const unicas = [...new Set(bruto.map(e => e.trim()).filter(Boolean))]
  if (unicas.length > ETIQUETAS_MAX_POR_AVALIACAO) return { erro: `Escolha no máximo ${ETIQUETAS_MAX_POR_AVALIACAO} etiquetas` }
  const permitidas = etiquetasPermitidas(grupos, nota)
  const invalidas = unicas.filter(e => !permitidas.has(e))
  if (invalidas.length > 0) return { erro: `etiqueta(s) fora do grupo/nível desta avaliação: ${invalidas.join(', ')}` }
  return { valor: unicas }
}

// Expressão SQL booleana do selo para um id de profissional (coluna ou placeholder tipado).
const sqlSeloBemAvaliado = (exprUsuarioId) =>
  `((SELECT COUNT(*) FROM avaliacoes sa WHERE sa.avaliado_id = ${exprUsuarioId} AND sa.estrelas = 5) >= ${SELO_MIN_CINCO_ESTRELAS})`

module.exports = {
  NIVEIS, ETIQUETAS_UNIVERSAIS, ETIQUETAS_POR_GRUPO, GRUPOS_AVALIACAO, GRUPO_OBRA,
  SELO_MIN_CINCO_ESTRELAS, ETIQUETAS_MAX_POR_AVALIACAO,
  catalogoEtiquetas, gruposDaDemanda, etiquetasPermitidas, validarEtiquetas, sqlSeloBemAvaliado,
}
