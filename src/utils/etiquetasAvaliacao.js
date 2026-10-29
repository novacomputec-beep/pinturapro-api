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
// Tabela DEFINITIVA aprovada pelo dono em 2026-10-29 (3 etiquetas por grupo e nível).
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
  construcao_pintura: { // Construção e pintura (toda obra)
    5: ['Acabamento perfeito', 'Trabalho caprichado', 'Deixou tudo limpo'],
    4: ['Bom acabamento', 'Bem organizado', 'Cumpriu o combinado'],
    3: ['Acabamento simples', 'Faltou capricho', 'Um pouco de sujeira'],
    2: ['Acabamento ruim', 'Desperdiçou material', 'Deixou sujeira'],
    1: ['Serviço mal feito', 'Abandonou a obra', 'Estragou material'],
  },
  reparos_casa: { // Reparos da casa
    5: ['Resolveu de vez', 'Serviço impecável', 'Deixou tudo limpo'],
    4: ['Resolveu o problema', 'Bom serviço', 'Organizado'],
    3: ['Resolveu em parte', 'Faltou capricho', 'Um pouco de sujeira'],
    2: ['Problema voltou', 'Serviço mal feito', 'Deixou sujeira'],
    1: ['Não resolveu', 'Piorou o problema', 'Estragou algo'],
  },
  eletrica_tec: { // Elétrica e tecnologia
    5: ['Resolveu de vez', 'Serviço muito seguro', 'Super organizado'],
    4: ['Resolveu o problema', 'Serviço seguro', 'Organizado'],
    3: ['Resolveu em parte', 'Faltou capricho', 'Pouco organizado'],
    2: ['Problema voltou', 'Serviço inseguro', 'Desorganizado'],
    1: ['Não resolveu', 'Serviço perigoso', 'Estragou algo'],
  },
  limpeza: { // Limpeza e cuidados da casa
    5: ['Ficou impecável', 'Muito caprichoso', 'Super atencioso'],
    4: ['Ficou limpo', 'Caprichoso', 'Atencioso'],
    3: ['Limpeza básica', 'Faltou capricho', 'Esqueceu partes'],
    2: ['Deixou a desejar', 'Pouco caprichoso', 'Esqueceu muita coisa'],
    1: ['Não limpou direito', 'Desleixado', 'Estragou algo'],
  },
  beleza: { // Beleza
    5: ['Ficou perfeito', 'Muito cuidadoso', 'Higiene impecável'],
    4: ['Ficou bonito', 'Cuidadoso', 'Higiênico'],
    3: ['Ficou razoável', 'Pouco cuidado', 'Higiene regular'],
    2: ['Não ficou como pedi', 'Descuidado', 'Pouca higiene'],
    1: ['Ficou muito ruim', 'Machucou', 'Sem higiene'],
  },
  festas: { // Festas e eventos
    5: ['Superou expectativas', 'Animou a festa', 'Muito profissional'],
    4: ['Caprichou', 'Agradou', 'Profissional'],
    3: ['Cumpriu o básico', 'Faltou capricho', 'Pouco animado'],
    2: ['Deixou a desejar', 'Pouco profissional', 'Desorganizado'],
    1: ['Estragou a festa', 'Faltou ao combinado', 'Nada profissional'],
  },
  cuidado: { // Cuidado (babá, cuidador, pet)
    5: ['Extremamente carinhoso', 'Muito responsável', 'Total confiança'],
    4: ['Carinhoso', 'Responsável', 'Confiável'],
    3: ['Atenção básica', 'Pouco carinho', 'Faltou cuidado'],
    2: ['Pouca atenção', 'Pouco responsável', 'Descuidado'],
    1: ['Negligente', 'Irresponsável', 'Não confio'],
  },
  transporte: { // Transporte e mecânica
    5: ['Muito cuidadoso', 'Resolveu de vez', 'Super ágil'],
    4: ['Cuidadoso', 'Resolveu o problema', 'Ágil'],
    3: ['Pouco cuidadoso', 'Resolveu em parte', 'Um pouco lento'],
    2: ['Descuidado', 'Problema voltou', 'Demorou demais'],
    1: ['Danificou algo', 'Não resolveu', 'Imprudente'],
  },
  seguranca: { // Segurança
    5: ['Muito atento', 'Total confiança', 'Muito profissional'],
    4: ['Atento', 'Confiável', 'Profissional'],
    3: ['Pouco atento', 'Cumpriu o básico', 'Faltou postura'],
    2: ['Desatento', 'Pouco confiável', 'Pouco profissional'],
    1: ['Negligente', 'Não confio', 'Nada profissional'],
  },
  digital_aulas: { // Digital e aulas
    5: ['Superou expectativas', 'Muito didático', 'Muito criativo'],
    4: ['Entregou bem', 'Didático', 'Criativo'],
    3: ['Entrega razoável', 'Pouco claro', 'Pouco criativo'],
    2: ['Entregou mal', 'Confuso', 'Fora do combinado'],
    1: ['Não entregou', 'Muito confuso', 'Nada do combinado'],
  },
  arte: { // Arte e criação
    5: ['Ficou perfeito', 'Muito criativo', 'Acabamento lindo'],
    4: ['Ficou bonito', 'Criativo', 'Bom acabamento'],
    3: ['Ficou razoável', 'Faltou capricho', 'Acabamento simples'],
    2: ['Não ficou como pedi', 'Fora do combinado', 'Acabamento ruim'],
    1: ['Ficou muito ruim', 'Nada do combinado', 'Estragou o material'],
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
