// usuarios.outros_descricao — o que o profissional faz quando marca "Outros" nas especialidades
// (decisão do dono, 03/11/2026). Texto curto (≤ OUTROS_DESCRICAO_MAX), aparado, espaços
// colapsados. Regra única dos TRÊS caminhos que gravam especialidades de prestador
// (POST /auth/cadastro, PUT /auth/perfil, POST /auth/contas/reparador):
//   - lista com 'outros' → descrição OBRIGATÓRIA (400 OUTROS_DESCRICAO_OBRIGATORIA);
//   - lista sem 'outros' → a coluna vai a NULL (a descrição só existe junto do "Outros");
//   - contato (telefone, e-mail, @handle, link) vira "[contato removido]" pelo MESMO sanitizador
//     das descrições/propostas (moderacaoDemanda.sanitizarTexto); o chamador registra a
//     tentativa em tentativas_contato DEPOIS de gravar (registrarOutrosDescricao), com
//     penalidade só quando o contato era claro (temContatoClaro) — igual a candidatura/interesse.
// O teto conta o que o usuário digitou; a máscara pode alongar o texto gravado, e tudo bem.
const { sanitizarTexto, temContatoClaro } = require('./moderacaoDemanda')
const { registrarTentativaContato } = require('./tentativasContato')

const OUTROS_DESCRICAO_MAX = 40
const ERRO_OUTROS_DESCRICAO_OBRIGATORIA = Object.freeze({
  erro: 'Conte em poucas palavras o que você faz em "Outros"',
  codigo: 'OUTROS_DESCRICAO_OBRIGATORIA',
})
const ERRO_OUTROS_DESCRICAO_TAMANHO = Object.freeze({
  erro: `A descrição de "Outros" deve ter no máximo ${OUTROS_DESCRICAO_MAX} caracteres`,
  codigo: 'OUTROS_DESCRICAO_TAMANHO',
})

const temOutros = (especialidades) => Array.isArray(especialidades) && especialidades.includes('outros')

// bruto = valor do body (qualquer tipo); especialidades = a lista VALIDADA que vai ser gravada.
// Devolve { valor, removido, conta } (valor string ou null) ou { erro } (corpo pronto do 400).
const lerOutrosDescricao = (bruto, especialidades) => {
  if (!temOutros(especialidades)) return { valor: null, removido: false, conta: false }
  const texto = typeof bruto === 'string' ? bruto.replace(/\s+/g, ' ').trim() : ''
  if (!texto) return { erro: ERRO_OUTROS_DESCRICAO_OBRIGATORIA }
  if (texto.length > OUTROS_DESCRICAO_MAX) return { erro: ERRO_OUTROS_DESCRICAO_TAMANHO }
  const limpo = sanitizarTexto(texto)
  return { valor: limpo, removido: limpo !== texto, conta: temContatoClaro(texto) }
}

// Chamar DEPOIS de a gravação entrar (envio recusado não é tentativa). Fire-and-forget, nunca lança.
const registrarOutrosDescricao = (usuarioId, lido) => {
  if (!usuarioId || !lido || !lido.removido) return Promise.resolve(null)
  return registrarTentativaContato({ usuario_id: usuarioId, tipo: 'perfil', demanda_id: null, campo: 'outros_descricao', conta: lido.conta })
    .catch(err => console.error('[OutrosDescricao] tentativa de contato:', err.message))
}

module.exports = {
  OUTROS_DESCRICAO_MAX, ERRO_OUTROS_DESCRICAO_OBRIGATORIA, ERRO_OUTROS_DESCRICAO_TAMANHO,
  temOutros, lerOutrosDescricao, registrarOutrosDescricao,
}
