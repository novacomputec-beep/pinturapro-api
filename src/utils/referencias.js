// Referência "própria": a pessoa indicou a si mesma como referência. Regra única, usada em todo
// caminho que GRAVA usuarios.referencias (cadastro, POST /auth/verificacao) e na ficha do admin
// (GET /admin/usuarios/:id/verificacao, campo `propria`):
//   - telefone: dígitos da referência iguais aos dígitos do telefone do próprio usuário; ou
//   - nome: nome normalizado (minúsculas, sem acento, espaços colapsados, sem pontas) IGUAL ao
//     nome completo normalizado do usuário. Só igualdade: "um contido no outro" barrava a
//     referência "José" (um homônimo, o pai, um colega) para o usuário "José Carlos".
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
  if (nome && meuNome && nome === meuNome) return true
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

// usuarios.referencias guarda JSON de [{ nome, telefone[, relacao] }] (cadastro, verificação e
// PUT /auth/referencias gravam JSON.stringify). O VALOR que chega aqui depende do tipo da coluna:
// TEXT → a string JSON; json/jsonb → node-pg já entrega o array/objeto parseado (e uma linha
// gravada duplamente codificada chega como string JSON dentro do JSON). Formas aceitas, em
// qualquer tipo de coluna: lista de objetos, UM objeto solto (= uma referência), lista de
// nomes (strings), { referencias: [...] }, string JSON com até 2 níveis de codificação e o
// legado de um nome solto. Devolve sempre uma lista de { nome, telefone } (string aparada ou
// null; com `relacao: true`, também relacao — ficha do admin), sem itens vazios; nunca lança.
const campoTexto = (v) => {
  if (v == null) return null
  const s = String(v).trim()
  return s || null
}
const lerReferencias = (bruto, { relacao = false } = {}) => {
  let v = bruto
  for (let i = 0; i < 2 && typeof v === 'string'; i++) {
    const s = v.trim()
    if (!/^[[{"]/.test(s)) break
    try { v = JSON.parse(s) } catch (_) { break }
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.referencias)) v = v.referencias
  if (v && typeof v === 'object' && !Array.isArray(v)) v = [v]
  if (Array.isArray(v)) {
    return v
      .map(x => (typeof x === 'string' ? { nome: x } : x))
      .filter(x => x && typeof x === 'object' && !Array.isArray(x))
      .map(x => {
        const item = { nome: campoTexto(x.nome), telefone: campoTexto(x.telefone) }
        if (relacao) item.relacao = campoTexto(x.relacao ?? x.parentesco)
        return item
      })
      .filter(x => x.nome || x.telefone)
  }
  if (typeof v === 'string' && v.trim()) {
    const item = { nome: v.trim(), telefone: null }
    if (relacao) item.relacao = null
    return [item]
  }
  return []
}

// Problema das referências gravadas, pelas mesmas regras que recusam na escrita:
// 'repetido' (telefone repetido entre elas ou igual ao do usuário), 'propria' (nome igual ao
// do usuário) ou null. Lista vazia = null (sem referência não há problema a apontar).
const problemaReferencias = (refs, usuario) => {
  if (!Array.isArray(refs) || refs.length === 0) return null
  if (erroTelefoneReferencias(refs, usuario)) return 'repetido'
  if (temReferenciaPropria(refs, usuario)) return 'propria'
  return null
}

// Os dois campos que o app lê do objeto `usuario` (GET /auth/perfil, POST /auth/login e a
// resposta do cadastro — o app guarda o usuario do login até a próxima releitura do perfil, então
// os três precisam trazê-los): tem_referencias e referencias_problema (null|'propria'|'repetido').
const camposReferencias = (bruto, usuario) => {
  const refs = lerReferencias(bruto)
  return { tem_referencias: refs.length > 0, referencias_problema: problemaReferencias(refs, usuario) }
}

const REFERENCIAS_MAX = 2
const ERRO_REFERENCIAS_OBRIGATORIAS = {
  erro: `Informe de 1 a ${REFERENCIAS_MAX} referências, cada uma com nome e telefone`,
  codigo: 'REFERENCIAS_OBRIGATORIAS',
}
// Lê { referencias } do body: 1 a 2 itens, cada um com nome (≤ 200) e telefone (≤ 30), aparados.
// Devolve { refs } ou { erro } (corpo pronto para o 400) — mesmas regras do POST /auth/verificacao.
const lerReferenciasBody = (referencias) => {
  const texto = (v) => typeof v === 'string' ? v.trim() : ''
  const refs = Array.isArray(referencias)
    ? referencias.map(r => ({ nome: texto(r?.nome), telefone: texto(r?.telefone) }))
    : []
  if (refs.length < 1 || refs.length > REFERENCIAS_MAX
      || refs.some(r => !r.nome || !r.telefone || r.nome.length > 200 || r.telefone.length > 30)) {
    return { erro: ERRO_REFERENCIAS_OBRIGATORIAS }
  }
  return { refs }
}
// Validação completa de uma lista já lida contra o usuário (telefone antes de nome, como no
// cadastro e na verificação). Devolve o corpo do 400 ou null.
const erroReferencias = (refs, usuario) =>
  erroTelefoneReferencias(refs, usuario) || (temReferenciaPropria(refs, usuario) ? ERRO_REFERENCIA_PROPRIA : null)

module.exports = {
  normalizarNome, referenciaPropria, temReferenciaPropria, ERRO_REFERENCIA_PROPRIA,
  telefoneNormalizado, erroTelefoneReferencias, ERRO_REFERENCIAS_TELEFONE,
  lerReferencias, problemaReferencias, camposReferencias, lerReferenciasBody, erroReferencias,
  REFERENCIAS_MAX, ERRO_REFERENCIAS_OBRIGATORIAS,
}
