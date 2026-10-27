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

module.exports = { normalizarNome, referenciaPropria, temReferenciaPropria, ERRO_REFERENCIA_PROPRIA }
