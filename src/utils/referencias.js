// Referência "própria": a pessoa indicou a si mesma como referência. Regra única, usada em todo
// caminho que GRAVA usuarios.referencias (cadastro, POST /auth/verificacao) e na ficha do admin
// (GET /admin/usuarios/:id/verificacao, campo `propria`):
//   - telefone: dígitos da referência iguais aos dígitos do telefone do próprio usuário; ou
//   - nome: nome normalizado (minúsculas, sem acento, espaços colapsados, sem pontas) igual ao
//     nome completo normalizado do usuário, ou um contido no outro.
// Lado vazio (sem telefone / sem nome) não casa — nunca inventa coincidência.
const normalizarNome = (v) => String(v || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()

const digitos = (v) => String(v || '').replace(/\D/g, '')

const referenciaPropria = (ref, usuario) => {
  if (!ref || typeof ref !== 'object') return false
  const tel = digitos(ref.telefone)
  const meuTel = digitos(usuario?.telefone)
  if (tel && meuTel && tel === meuTel) return true
  const nome = normalizarNome(ref.nome)
  const meuNome = normalizarNome(usuario?.nome)
  if (nome && meuNome && (nome === meuNome || nome.includes(meuNome) || meuNome.includes(nome))) return true
  return false
}

const temReferenciaPropria = (refs, usuario) =>
  Array.isArray(refs) && refs.some(r => referenciaPropria(r, usuario))

const ERRO_REFERENCIA_PROPRIA = {
  erro: 'A referência precisa ser outra pessoa, não você.',
  codigo: 'REFERENCIA_PROPRIA',
}

// Telefone de referência comparável: só dígitos, sem o DDI 55 (quando o número vem com ele) e
// sem zeros à esquerda (0 de longa distância) — "(81) 99999-0000", "+55 81 99999-0000" e
// "081999990000" são o mesmo número.
const telefoneNormalizado = (v) => {
  let d = digitos(v)
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2)
  return d.replace(/^0+/, '')
}
const ERRO_REFERENCIAS_TELEFONE = {
  erro: 'Use duas pessoas diferentes, e não o seu próprio telefone.',
  codigo: 'REFERENCIAS_TELEFONE_REPETIDO',
}
// Erro de telefone das referências (null = ok): duas referências com o mesmo número, ou uma com
// o número do próprio profissional. Vale em todo caminho que grava usuarios.referencias.
const erroTelefoneReferencias = (refs, usuario) => {
  if (!Array.isArray(refs)) return null
  const tels = refs.map(r => telefoneNormalizado(r?.telefone)).filter(Boolean)
  if (new Set(tels).size !== tels.length) return ERRO_REFERENCIAS_TELEFONE
  const meu = telefoneNormalizado(usuario?.telefone)
  if (meu && tels.includes(meu)) return ERRO_REFERENCIAS_TELEFONE
  return null
}

module.exports = {
  normalizarNome, referenciaPropria, temReferenciaPropria, ERRO_REFERENCIA_PROPRIA,
  telefoneNormalizado, erroTelefoneReferencias, ERRO_REFERENCIAS_TELEFONE,
}
