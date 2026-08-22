// Vocabulário FECHADO das especialidades do profissional (as 21 categorias de SERVIÇO).
//
// Mora em src/utils/ porque é a convenção deste repo para constante compartilhada e inerte:
// mesmo lugar de faixasPrazo.js (FAIXAS/PRAZO_MODO_HOJE), marca.js (MARCA) e localidade.js
// (FALLBACK_CIDADE_UF). Definido UMA vez aqui e lido pelos DOIS caminhos de escrita
// (POST /auth/cadastro e PUT /auth/perfil) — duas listas divergiriam no primeiro slug novo.
//
// A ordem é a da lista de serviços do app; 'outros' fecha a lista, como nas telas.
const ESPECIALIDADES_VALIDAS = [
  'hidraulica', 'eletrica', 'marcenaria', 'alvenaria', 'climatizacao',
  'chaveiro', 'faxina', 'eletronica', 'aula_particular', 'cuidador',
  'jardineiro', 'manicure', 'cabelo', 'massagem', 'mudancas',
  'estofamento', 'baba', 'cozinheiro', 'motorista', 'garcom', 'outros',
]

// Set para o teste de pertinência não virar um scan por item a cada validação.
const ESPECIALIDADES_SET = new Set(ESPECIALIDADES_VALIDAS)

const ESPECIALIDADES_MIN = 1
const ESPECIALIDADES_MAX = 5

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
// Devolve { erro } OU { valor }. Nunca lança.
const validarEspecialidades = (bruto, ehProfissional) => {
  if (!Array.isArray(bruto)) {
    return { erro: 'especialidades deve ser uma lista' }
  }
  if (!bruto.every(e => typeof e === 'string')) {
    return { erro: 'especialidades deve conter apenas textos' }
  }

  const limpas = bruto.map(e => e.trim()).filter(Boolean)
  const invalidas = [...new Set(limpas.filter(e => !ESPECIALIDADES_SET.has(e)))]
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
  ESPECIALIDADES_MIN,
  ESPECIALIDADES_MAX,
  validarEspecialidades,
}
