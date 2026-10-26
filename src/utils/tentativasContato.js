// Texto livre que UMA parte mostra à OUTRA (mensagem da candidatura/interesse, referências da
// candidatura antiga, pergunta e resposta, denúncia): contato removido na ESCRITA (o que vai
// ao banco já sai limpo) e na LEITURA (linha antiga, gravada antes do filtro, é mascarada ao
// sair em GET /obras/:id, GET /reparos/:id e nas listas de candidatos/interessados).
//
// O sanitizador é o MESMO das descrições (moderacaoDemanda.sanitizarTexto): telefone em
// qualquer formato, dígitos por extenso, e-mail, link, @handle e "whats/zap + número" viram
// "[contato removido]"; preço, medida, ano e CEP ficam. Cada campo que mudou na escrita vira
// UMA linha em tentativas_contato (migração de boot em routes/index.js), lida por
// GET /admin/tentativas-contato — fire-and-forget: falha no registro é log, nunca 500.
const { pool } = require('./supabase')
const { sanitizarTexto } = require('./moderacaoDemanda')

const registrarTentativaContato = ({ usuario_id, tipo, demanda_id, campo }, db = pool) =>
  db.query(
    `INSERT INTO tentativas_contato (usuario_id, tipo, demanda_id, campo) VALUES ($1, $2, $3, $4)`,
    [usuario_id, tipo, demanda_id || null, campo]
  ).catch(err => console.error(`[TentativaContato] ${tipo}/${campo} de ${usuario_id}:`, err.message))

// Sanitiza string, lista de strings e objeto com strings (referencias da candidatura antiga
// chega em qualquer um destes formatos); número, null e undefined voltam como vieram.
const limparProfundo = (v) => {
  if (typeof v === 'string') return sanitizarTexto(v)
  if (Array.isArray(v)) return v.map(limparProfundo)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limparProfundo(x)]))
  return v
}
const mudou = (antes, depois) => JSON.stringify(antes) !== JSON.stringify(depois)

// ESCRITA. campos = { nome: valor } como veio do body; contexto = { usuario_id, tipo, demanda_id }.
// Devolve { valores (limpos, mesmas chaves), removidos (nomes dos campos que mudaram) } e
// registra uma tentativa por campo alterado.
const limparCamposEscrita = (campos, contexto) => {
  const valores = {}
  const removidos = []
  for (const [campo, valor] of Object.entries(campos)) {
    const limpo = limparProfundo(valor)
    valores[campo] = limpo
    if (mudou(valor, limpo)) {
      removidos.push(campo)
      registrarTentativaContato({ ...contexto, campo })
    }
  }
  return { valores, removidos }
}

// LEITURA. Mascara os campos listados numa linha (ou em cada linha de uma lista) — linha
// antiga com contato aparece como "[contato removido]", sem reescrever o banco. Devolve a
// mesma referência; null/undefined passam.
const mascararLinha = (linha, campos) => {
  if (!linha || typeof linha !== 'object') return linha
  for (const campo of campos) {
    if (linha[campo] != null) linha[campo] = limparProfundo(linha[campo])
  }
  return linha
}
const mascararLista = (linhas, campos) => (Array.isArray(linhas) ? linhas.map(l => mascararLinha(l, campos)) : linhas)

module.exports = { registrarTentativaContato, limparProfundo, limparCamposEscrita, mascararLinha, mascararLista }
