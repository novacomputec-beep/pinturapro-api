// ANTI-CONTATO (dono, 26/11/2026 — arte aprovada "anti-contato-previa"). Contato escrito no texto
// de um pedido, de uma pergunta ou de uma resposta: telefone (inclusive disfarçado), e-mail,
// @perfil, link e frase de convite ("me chama no zap").
//
// CAMADA 1 (regras) — este arquivo. O texto é DOBRADO (minúsculas, sem acento, um caractere por
// caractere do original, para o trecho achado poder ser devolvido como foi escrito) e:
//   - TELEFONE: sequência de 8+ dígitos (com ou sem DDD) em que valem algarismos, dígitos por
//     extenso ("meia" = 6), a letra O entre dígitos (= 0) e, entre um dígito e outro, espaços,
//     pontos, traços, parênteses e emojis são ignorados; a sequência pode atravessar até 3 linhas.
//     Ex.: "3quatro nove999 cinco 8dois meia 2". Ficam de fora valor (R$, "10.000 - 15.000"), CEP,
//     CPF e intervalo de anos.
//   - E-MAIL (inclusive "fulano arroba gmail ponto com"), @perfil, link (http, www, domínio, wa.me,
//     "site ponto com") e frases de convite (zap, whats, me chama, meu número, liga pra mim…).
// CAMADA 2 (IA) — NÃO construída: depende de ANTHROPIC_API_KEY, que não existe nos serviços.
//
// ONDE VALE:
//   - publicar (POST /reparos/dono, POST /obras/dono) e editar (PUT /obras/:id) título + descrição:
//     app que manda suporta_contato_no_texto: true → 409 CONTATO_NO_TEXTO com o trecho, NADA
//     gravado; app antigo (sem o campo) publica como sempre e o pedido fica MARCADO
//     (contato_no_texto + trecho) para o painel;
//   - pergunta e resposta: o trecho vira "••••" e o texto é gravado;
//   - varredura ÚNICA dos pedidos abertos (boot): marca os que já têm contato no texto;
//   - robô de WhatsApp, tipo 'contato_no_texto' (services/whatsappContatoNoTextoService).
const { TLDS } = require('./moderacaoDemanda')
const { normalizarTelefone } = require('../whatsapp/config')

const CODIGO_CONTATO = 'CONTATO_NO_TEXTO'
const MASCARA = '••••'
const MIN_DIGITOS = 8
const MAX_LINHAS = 3
const MAX_VAO = 20            // caracteres ignorados entre um dígito e o seguinte
const MAX_TRECHO = 160
const CHAVE_VARREDURA = 'contato_no_texto_varredura'
const TABELAS = ['reparos', 'obras']

// Dobra SEM mudar o tamanho: cada unidade do original vira exatamente uma (letra/dígito ASCII em
// minúscula, ou o próprio caractere; o que não cabe em um caractere vira espaço).
const dobrar = (texto) => {
  let saida = ''
  for (const ponto of texto) {
    let f = ponto
    if (ponto.length > 1 || ponto.charCodeAt(0) > 127) {
      f = ponto.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      if (f.length !== 1) f = ' '
    } else f = ponto.toLowerCase()
    saida += f + ' '.repeat(ponto.length - 1)
  }
  return saida
}

const ehLetra = (c) => c !== undefined && /[a-z]/.test(c) || (c !== undefined && c.charCodeAt(0) > 127 && /\p{L}/u.test(c))
const ehAlgarismo = (c) => c !== undefined && c >= '0' && c <= '9'
// O que INTERROMPE uma sequência de dígitos (além de letra): pontuação de frase, valor, data, hora.
const QUEBRA = new Set([',', ';', ':', '/', '\\', '$', '%', '=', '!', '?', '"', "'", '#', '@', '&', '<', '>'])
const PALAVRAS = [['zero', '0'], ['uma', '1'], ['um', '1'], ['dois', '2'], ['duas', '2'], ['tres', '3'], ['quatro', '4'],
  ['cinco', '5'], ['seis', '6'], ['meia', '6'], ['sete', '7'], ['oito', '8'], ['nove', '9']]

// Dígito (algarismo ou por extenso) que começa em i, ou null. Palavra só vale inteira: sem letra
// colada antes nem depois (dígito colado pode: "3quatro", "nove999").
const digitoEm = (f, i) => {
  if (ehAlgarismo(f[i])) return { valor: f[i], fim: i + 1, palavra: false }
  if (ehLetra(f[i - 1])) return null
  for (const [palavra, valor] of PALAVRAS) {
    if (f.startsWith(palavra, i) && !ehLetra(f[i + palavra.length])) return { valor, fim: i + palavra.length, palavra: true }
  }
  return null
}
// Próximo dígito depois de um vão de separadores a partir de i (para o "O" = 0).
const temDigitoAdiante = (f, i) => {
  for (let j = i; j < f.length && j - i <= MAX_VAO; j++) {
    if (digitoEm(f, j)) return true
    if (ehLetra(f[j]) || QUEBRA.has(f[j])) return false
  }
  return false
}

// Sequências de dígitos do texto dobrado: [{ inicio, fim, digitos, palavras }].
const sequenciasDeDigitos = (f) => {
  const saida = []
  let i = 0
  while (i < f.length) {
    const primeiro = digitoEm(f, i)
    if (!primeiro) { i++; continue }
    const seq = { inicio: i, fim: primeiro.fim, digitos: primeiro.valor, palavras: primeiro.palavra ? 1 : 0 }
    let j = primeiro.fim, linhas = 1
    while (j < f.length) {
      const d = digitoEm(f, j)
      if (d) { seq.digitos += d.valor; seq.fim = d.fim; if (d.palavra) seq.palavras++; j = d.fim; continue }
      const c = f[j]
      // "O" sozinho entre dígitos vale zero ("99O88", "9 o 8").
      if (c === 'o' && !ehLetra(f[j - 1]) && !ehLetra(f[j + 1]) && temDigitoAdiante(f, j + 1)) { seq.digitos += '0'; seq.fim = j + 1; j++; continue }
      if (ehLetra(c) || QUEBRA.has(c)) break
      if (c === '\n' && ++linhas > MAX_LINHAS) break
      if (j - seq.fim >= MAX_VAO) break
      j++
    }
    saida.push(seq)
    i = Math.max(seq.fim, i + 1)
  }
  return saida
}

const RE_CEP = /^\d{5}-\d{3}$|^\d{2}\.\d{3}-\d{3}$/
const RE_CPF = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/
const RE_MILHAR = /^\d{1,2}\.\d{3}\.\d{3}$/
const RE_LISTA_DE_VALORES = /^\d{1,3}\.\d{3}(?:\s*[-–—]\s*\d{1,3}\.\d{3})+$/
const RE_ANOS = /^(?:(?:19|20)\d{2}[\s.\-–—]*){2,}$/
// Sequência com 8+ dígitos que NÃO é telefone: valor, CEP, CPF, anos.
const naoEhTelefone = (texto, seq) => {
  const trecho = texto.slice(seq.inicio, seq.fim).trim()
  const antes = texto.slice(Math.max(0, seq.inicio - 12), seq.inicio).toLowerCase()
  const depois = texto.slice(seq.fim, seq.fim + 12).toLowerCase()
  if (/r\$\s*$/.test(antes) || /\b(?:cep|cpf|cnpj|rg)\s*[:.\-nº°o]*\s*$/.test(antes)) return true
  if (/^,\d/.test(depois) || /^\s*(?:reais|mil\b|m2|m²|metros)/.test(depois)) return true
  if (seq.palavras === 0 && (RE_CEP.test(trecho) || RE_CPF.test(trecho) || RE_MILHAR.test(trecho) || RE_LISTA_DE_VALORES.test(trecho) || RE_ANOS.test(trecho))) return true
  return false
}

const PONTO = '(?:\\s*\\.\\s*|\\s+ponto\\s+)'
// Dentro de um endereço falado: ponto colado ou a palavra "ponto" (o ponto final da frase não emenda).
const PONTO_FALADO = '(?:\\.|\\s+ponto\\s+)'
const PADROES = [
  ['email', /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g],
  // "fulano arroba gmail ponto com", "fulano (at) gmail.com", "fulano @ gmail ponto com"
  ['email', new RegExp(`[a-z0-9._+-]+\\s*(?:\\barroba\\b|\\(at\\)|\\[at\\]|\\(a\\))\\s*[a-z0-9-]+(?:${PONTO_FALADO}[a-z0-9-]+){1,3}`, 'g')],
  ['email', /[a-z0-9._+-]+\s*@\s*[a-z0-9-]+(?:\s+ponto\s+[a-z0-9-]+){1,3}/g],
  ['email', new RegExp(`\\b(?:gmail|hotmail|outlook|yahoo|icloud|bol|uol|live)${PONTO}com(?:${PONTO}br)?\\b`, 'g')],
  ['link', /\bhttps?:\/\/\S+|\bwww\.\S+/g],
  ['link', /\b(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|t\.me|bit\.ly|linktr\.ee)(?:\/\S*)?/g],
  ['link', new RegExp(`\\b(?:[a-z0-9-]+\\.)*[a-z0-9-]*[a-z][a-z0-9-]*\\.(?:${TLDS.map(t => t.replace('.', '\\.')).join('|')})\\b(?:\\/\\S*)?`, 'g')],
  ['link', /\b[a-z0-9-]{2,}\s+ponto\s+com(?:\s+ponto\s+br)?\b/g],
  ['perfil', /(?<![a-z0-9._])@\s?[a-z0-9_.]{2,}/g],
  ['convite', /\b(?:whats\s?app|whats|whatzap|watsapp?|uatsapp?|wpp|zapzap|zap|telegram|insta(?:gram)?)\b/g],
  ['convite', /\bme\s+cham(?:a|e|ar|em)\b/g],
  ['convite', /\bmeu\s+(?:numero|contato)\b/g],
  ['convite', /\blig(?:a|ue|ar)\s+(?:pra|para|pro)\s+(?:mim|eu|o\s+meu|meu)\b|\bme\s+lig(?:a|ue|ar|uem)\b/g],
]

// Todos os contatos do texto: [{ tipo, inicio, fim, trecho, telefone? }], em ordem, sem sobreposição
// (posições sobre o texto em NFC — o que mascararContatos devolve).
const encontrarContatos = (bruto) => {
  if (typeof bruto !== 'string' || !bruto) return []
  const texto = bruto.normalize('NFC')
  const f = dobrar(texto)
  const achados = []
  for (const seq of sequenciasDeDigitos(f)) {
    if (seq.digitos.length < MIN_DIGITOS || naoEhTelefone(texto, seq)) continue
    // "(34) 9…" e "+55 34…": o parêntese/o mais que abre o número faz parte do trecho.
    let inicio = seq.inicio
    while (inicio > 0 && (texto[inicio - 1] === '(' || texto[inicio - 1] === '+')) inicio--
    achados.push({ tipo: 'telefone', inicio, fim: seq.fim, telefone: seq.digitos })
  }
  for (const [tipo, re] of PADROES) {
    re.lastIndex = 0
    for (let m; (m = re.exec(f));) {
      if (m[0].length === 0) { re.lastIndex++; continue }
      achados.push({ tipo, inicio: m.index, fim: m.index + m[0].length })
    }
  }
  achados.sort((a, b) => a.inicio - b.inicio || b.fim - a.fim)
  const unidos = []
  for (const a of achados) {
    const u = unidos[unidos.length - 1]
    if (u && a.inicio < u.fim) {
      if (a.fim > u.fim) u.fim = a.fim
      if (a.tipo === 'telefone' && !u.telefone) { u.tipo = 'telefone'; u.telefone = a.telefone }
    } else unidos.push({ ...a })
  }
  for (const u of unidos) u.trecho = texto.slice(u.inicio, u.fim).trim().slice(0, MAX_TRECHO)
  return unidos
}

// Título + descrição (ou qualquer lista de textos) como UM texto: o número partido entre o título
// e a descrição também conta. Devolve null ou { tipo, trecho, trechos, telefone } — telefone = o
// primeiro número do texto em E.164 (+55…), quando tem DDD; senão null.
const detectarContato = (...textos) => {
  const achados = encontrarContatos(textos.filter(t => typeof t === 'string' && t).join('\n'))
  if (achados.length === 0) return null
  let telefone = null
  for (const a of achados) {
    if (a.telefone && (telefone = normalizarTelefone(a.telefone))) break
  }
  return { tipo: achados[0].tipo, trecho: achados[0].trecho, trechos: achados.map(a => a.trecho), telefone }
}

// Pergunta/resposta: cada trecho vira "••••". Devolve { texto, removido, trechos }.
const mascararContatos = (bruto) => {
  const achados = encontrarContatos(bruto)
  if (achados.length === 0) return { texto: bruto, removido: false, trechos: [] }
  const texto = bruto.normalize('NFC')
  let saida = '', cursor = 0
  for (const a of achados) { saida += texto.slice(cursor, a.inicio) + MASCARA; cursor = a.fim }
  return { texto: saida + texto.slice(cursor), removido: true, trechos: achados.map(a => a.trecho) }
}

const corpoRecusa = (achado) => ({
  erro: `Seu pedido tem um contato no texto: "${achado.trecho}". Retire telefone, e-mail, redes sociais e links. As dúvidas dos profissionais chegam pelas perguntas do pedido, dentro do app.`,
  codigo: CODIGO_CONTATO, contato_no_texto: true, tipo: achado.tipo, trecho: achado.trecho, trechos: achado.trechos,
})
const appSuporta = (body) => body?.suporta_contato_no_texto === true || body?.suporta_contato_no_texto === 'true'
// Publicação: {} (nada achado), { barrar: corpo do 409 } (app que suporta) ou { marcar: achado }.
const decidirContato = (body, achado) => (!achado ? {} : appSuporta(body) ? { barrar: corpoRecusa(achado) } : { marcar: achado })

// Marca (ou desmarca, com achado null) o pedido. Nunca lança: o pedido já existe.
const gravarContatoNoTexto = async (tabela, linha, achado, db) => {
  try {
    await (db || require('./supabase').pool).query(
      `UPDATE ${tabela} SET contato_no_texto = $2::boolean, contato_no_texto_trecho = $3, contato_no_texto_telefone = $4,
              contato_no_texto_em = CASE WHEN $2::boolean THEN NOW() ELSE NULL END WHERE id = $1`,
      [linha.id, !!achado, achado?.trecho ?? null, achado?.telefone ?? null])
    linha.contato_no_texto = !!achado
    linha.contato_no_texto_trecho = achado?.trecho ?? null
  } catch (err) {
    console.error(`[contato no texto] marca em ${tabela} ${linha?.id}:`, err.message)
  }
  return linha
}

// Colunas + a varredura ÚNICA dos pedidos abertos (a chave em configuracoes guarda o resultado e
// impede a segunda passada). Devolve o resultado da varredura, ou null se ela já tinha rodado.
const migrarContatoNoTexto = async (client) => {
  for (const tabela of TABELAS) {
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS contato_no_texto BOOLEAN NOT NULL DEFAULT false`)
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS contato_no_texto_trecho TEXT`)
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS contato_no_texto_telefone TEXT`)
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS contato_no_texto_em TIMESTAMPTZ`)
  }
  const ja = await client.query(`SELECT 1 FROM configuracoes WHERE chave = $1`, [CHAVE_VARREDURA])
  if (ja.rows.length > 0) return null
  const resultado = { em: new Date().toISOString(), analisados: 0, marcados: 0, reparos: 0, obras: 0 }
  for (const tabela of TABELAS) {
    // Aberto = no ar, ou obra esperando aprovação.
    const r = await client.query(
      `SELECT id, titulo, descricao FROM ${tabela}
        WHERE status = 'aberta' OR (status = 'rascunho' AND status_aprovacao = 'pendente')`)
    for (const d of r.rows) {
      resultado.analisados++
      const achado = detectarContato(d.titulo, d.descricao)
      if (!achado) continue
      await client.query(
        `UPDATE ${tabela} SET contato_no_texto = true, contato_no_texto_trecho = $2, contato_no_texto_telefone = $3, contato_no_texto_em = NOW() WHERE id = $1`,
        [d.id, achado.trecho, achado.telefone])
      resultado.marcados++
      resultado[tabela]++
    }
  }
  await client.query(`INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)`, [CHAVE_VARREDURA, JSON.stringify(resultado)])
  console.log(`[contato no texto] varredura única: ${resultado.marcados} de ${resultado.analisados} pedidos abertos marcados (${resultado.reparos} serviços, ${resultado.obras} obras)`)
  return resultado
}

module.exports = {
  CODIGO_CONTATO, MASCARA, CHAVE_VARREDURA, dobrar, sequenciasDeDigitos, encontrarContatos, detectarContato, mascararContatos,
  corpoRecusa, decidirContato, gravarContatoNoTexto, migrarContatoNoTexto,
}
