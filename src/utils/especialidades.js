// Vocabulário FECHADO das especialidades do profissional — DUAS listas, uma por lado:
//   - REPARADOR (tipo_prestador = 'reparador'): as 27 categorias de SERVIÇO doméstico;
//   - OBRA (tipo_prestador = 'pintor', que cobre pintor E construtor): os 4 papéis de obra.
// Mesmo estilo de slug nas duas: minúsculas, sem acento, '_' como separador (aula_particular).
//
// Mora em src/utils/ porque é a convenção deste repo para constante compartilhada e inerte:
// mesmo lugar de faixasPrazo.js (FAIXAS/PRAZO_MODO_HOJE), marca.js (MARCA) e localidade.js
// (FALLBACK_CIDADE_UF). Definido UMA vez aqui e lido pelos DOIS caminhos de escrita
// (POST /auth/cadastro e PUT /auth/perfil) — duas listas divergiriam no primeiro slug novo.
//
// A ordem é a da lista de serviços do app; 'outros' fecha a lista, como nas telas.
// Slug novo entra ANTES de 'outros', nunca no meio: a ordem existente é a das telas.
// Esta lista também é o vocabulário de reparos.categoria — o broadcast de reparo novo
// (alertaService.notificarPrestadoresSobreNovoReparo) casa categoria × especialidades.
const ESPECIALIDADES_REPARADOR = [
  'hidraulica', 'eletrica', 'marcenaria', 'alvenaria', 'climatizacao',
  'chaveiro', 'faxina', 'eletronica', 'aula_particular', 'cuidador',
  'jardineiro', 'manicure', 'cabelo', 'massagem', 'mudancas',
  'estofamento', 'baba', 'cozinheiro', 'motorista', 'garcom',
  'dedetizacao', 'montagem_moveis', 'vigia', 'maquiagem', 'costura', 'seguranca',
  'artesanato', 'barbeiro', 'confeiteiro', 'editor_video', 'filmagem_fotografia',
  'personal_trainer', 'podologo', 'profissional_home_office', 'salgadeiro',
  'outros',
]

// Lado da OBRA (pintor/construtor): exatamente estes quatro, na ordem das telas.
const ESPECIALIDADES_OBRA = ['engenheiro', 'construtor', 'pedreiro_servente', 'pintor']

// Nome antigo mantido como alias da lista de reparador (era a única lista até aqui).
const ESPECIALIDADES_VALIDAS = ESPECIALIDADES_REPARADOR

// Qual lista vale para um lado. lado = tipo_prestador ('pintor' | 'reparador' | null).
// Só 'pintor' cai na lista de obra; 'reparador' E null/desconhecido caem na lista de
// reparador — que é EXATAMENTE o comportamento de antes deste split (uma lista só, a de
// serviços), então conta sem tipo_prestador (legado, ou cadastro sem tipo_conta) não muda.
const listaPorLado = (lado) => (lado === 'pintor' ? ESPECIALIDADES_OBRA : ESPECIALIDADES_REPARADOR)

// Sets para o teste de pertinência não virar um scan por item a cada validação.
const SETS_POR_LISTA = new Map([
  [ESPECIALIDADES_REPARADOR, new Set(ESPECIALIDADES_REPARADOR)],
  [ESPECIALIDADES_OBRA, new Set(ESPECIALIDADES_OBRA)],
])

const ESPECIALIDADES_MIN = 1
const ESPECIALIDADES_MAX = 5

// Rótulo humano de um slug de categoria/especialidade ('eletrica' → 'Elétrica'), para o
// que sai ao usuário em texto (contrato em HTML e PDF; o push de demanda nova lê as mesmas
// listas via apresentacaoReparo/apresentacaoObra, que também devolvem o emoji). Os rótulos
// vêm de categoriasApp.js, que já é a cópia verbatim das listas do app — NÃO se duplica a
// lista aqui: duas cópias divergiriam no primeiro rótulo alterado. Um mapa só, com os três
// lados (serviço, construção, obra): os slugs não colidem entre listas, salvo 'outros',
// que tem o mesmo rótulo nas duas.
//
// Slug fora do mapa (legado, texto livre): com `padrao` informado volta o padrão — é o
// caso do contrato, que nunca imprime slug cru; sem `padrao` volta o slug CRU. null e
// undefined caem no `padrao` quando há um, senão voltam como vieram.
const { CATEGORIAS_SERVICO, CATEGORIAS_CONSTRUCAO, CATEGORIAS_OBRA } = require('./categoriasApp')
const ROTULO_POR_SLUG = new Map(
  [...CATEGORIAS_SERVICO, ...CATEGORIAS_CONSTRUCAO, ...CATEGORIAS_OBRA].map(c => [c.slug, c.rotulo])
)
const rotuloCategoria = (slug, padrao) => {
  const rotulo = slug == null ? undefined : ROTULO_POR_SLUG.get(slug)
  if (rotulo !== undefined) return rotulo
  if (padrao !== undefined) return padrao
  return slug == null ? slug : String(slug)
}

// Valida o que está sendo ESCRITO, nunca o que já está gravado.
//
// Ponto crítico desta função: ela só é chamada para um valor que veio no corpo da
// requisição. Profissional antigo carrega texto livre em usuarios.especialidades
// ('Faz tudo', 'Acho') e NADA aqui olha para a linha existente — salvar o perfil sem
// mandar o campo não passa por aqui, não falha, e a coluna fica como está. Nenhuma
// migração, nenhuma reescrita de linha legada.
//
// ehProfissional decide só o MÍNIMO: profissional precisa declarar de 1 a 5 serviços
// (é por eles que ele é encontrado); dono não presta serviço nenhum, então lista vazia
// é o estado correto dele — e continua sendo aceita.
//
// Duplicata é COLAPSADA, não recusada: mandar o mesmo slug duas vezes é um deslize de
// interface, não um erro do usuário. A contagem roda DEPOIS do colapso, então
// ['faxina','faxina'] vale 1 e não estoura o teto.
//
// lado = tipo_prestador do usuário (ver listaPorLado): decide CONTRA QUAL lista o valor é
// validado. MIN/MAX não dependem do lado.
//
// Devolve { erro } OU { valor }. Nunca lança.
const validarEspecialidades = (bruto, ehProfissional, lado = null) => {
  if (!Array.isArray(bruto)) {
    return { erro: 'especialidades deve ser uma lista' }
  }
  if (!bruto.every(e => typeof e === 'string')) {
    return { erro: 'especialidades deve conter apenas textos' }
  }

  const limpas = bruto.map(e => e.trim()).filter(Boolean)
  const validos = SETS_POR_LISTA.get(listaPorLado(lado))
  const invalidas = [...new Set(limpas.filter(e => !validos.has(e)))]
  if (invalidas.length > 0) {
    return { erro: `especialidades inválida(s): ${invalidas.join(', ')}` }
  }

  const unicas = [...new Set(limpas)]

  if (ehProfissional && unicas.length < ESPECIALIDADES_MIN) {
    return { erro: `Selecione ao menos ${ESPECIALIDADES_MIN} especialidade` }
  }
  if (unicas.length > ESPECIALIDADES_MAX) {
    return { erro: `Selecione no máximo ${ESPECIALIDADES_MAX} especialidades` }
  }

  return { valor: unicas }
}

module.exports = {
  ESPECIALIDADES_VALIDAS,
  ESPECIALIDADES_REPARADOR,
  ESPECIALIDADES_OBRA,
  listaPorLado,
  ESPECIALIDADES_MIN,
  ESPECIALIDADES_MAX,
  validarEspecialidades,
  rotuloCategoria,
}
