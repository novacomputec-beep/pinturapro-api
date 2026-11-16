// Valor de uma demanda (reparos.valor_estimado / obras.valor) — "quanto o dono quer pagar".
//
// Por que existe (09/11/2026): POST /reparos/dono e POST /obras/dono gravavam o que viesse no
// corpo sem conferir — só a moderação olhava o valor, e só para recusar ANÚNCIO (palavra de venda
// + valor vazio). Um pedido comum sem valor, com 0 ou com '' entrava e era publicado: foi assim que
// "Depilação na cera" foi ao feed com valor 0. Pedido sem valor não dá ao profissional como
// decidir, e o push/e-mail saem com "R$ 0".
//
// Regra ÚNICA para criar e editar, nos dois lados: número (ou texto numérico) FINITO e MAIOR QUE
// ZERO. Ausente, null, '', 0, negativo, NaN, booleano, lista ou objeto → erro com a mensagem que o
// app mostra tal como vem. `codigo` é a chave estável.
// Devolve { valor } (número, para gravar) OU { erro, codigo }. Nunca lança.
const MENSAGEM_VALOR_OBRIGATORIO = 'Informe quanto quer pagar'
const CODIGO_VALOR_OBRIGATORIO = 'VALOR_OBRIGATORIO'
const ERRO_VALOR_OBRIGATORIO = Object.freeze({ erro: MENSAGEM_VALOR_OBRIGATORIO, codigo: CODIGO_VALOR_OBRIGATORIO })

const validarValorDemanda = (bruto) => {
  const texto = typeof bruto === 'string' ? bruto.trim() : null
  const n = typeof bruto === 'number' ? bruto : (texto ? Number(texto) : NaN)
  if (!Number.isFinite(n) || n <= 0) return { ...ERRO_VALOR_OBRIGATORIO }
  return { valor: n }
}

// ─── VALOR A COMBINAR (arte aprovada, 16/11/2026 — reparos E obras) ─────────────────────────────
// O dono pode publicar SEM dizer quanto paga: valor_a_combinar = true e o valor (reparos.
// valor_estimado / obras.valor) fica NULL. Invariante: valor_a_combinar = true ⇔ valor NULL — é por
// ela que todo texto que já tratava "sem valor" (lembretes, página pública, resumo do canal) sai
// "Valor a combinar" sem saber da coluna nova. Quem dá o preço é o profissional: nesses pedidos a
// proposta EXIGE valor_proposto > 0, e o valor combinado é o da proposta escolhida
// (utils/valorAcordado — contrato/PDF, finalizadas, painel).
const ehVerdadeiro = (v) => v === true || v === 'true' || v === 1 || v === '1'
// Criar/editar: valor_a_combinar=true → { valor: null, valor_a_combinar: true } (o valor do corpo é
// ignorado); senão a regra de sempre (> 0) → { valor, valor_a_combinar: false } ou { erro, codigo }.
const resolverValorDemanda = (body, campo) => {
  if (ehVerdadeiro(body?.valor_a_combinar)) return { valor: null, valor_a_combinar: true }
  const r = validarValorDemanda(body?.[campo])
  if (r.erro) return r
  return { valor: r.valor, valor_a_combinar: false }
}
// Proposta (interesse/candidatura) em pedido "a combinar": valor_proposto obrigatório e > 0.
const MENSAGEM_VALOR_PROPOSTA_OBRIGATORIO = 'Informe quanto você cobra por este serviço.'
const ERRO_VALOR_PROPOSTA_OBRIGATORIO = Object.freeze({ erro: MENSAGEM_VALOR_PROPOSTA_OBRIGATORIO, codigo: CODIGO_VALOR_OBRIGATORIO, mensagem: MENSAGEM_VALOR_PROPOSTA_OBRIGATORIO })
const TABELAS_DEMANDA = new Set(['obras', 'reparos'])
// null = pode seguir; senão o corpo do 400. `db` = pool ou o client da transação da rota.
const exigirValorPropostaSeACombinar = async (db, tabela, id, valorProposto) => {
  if (!TABELAS_DEMANDA.has(tabela)) throw new Error(`exigirValorPropostaSeACombinar: tabela inválida ${tabela}`)
  const r = await db.query(`SELECT COALESCE(valor_a_combinar, false) AS a_combinar FROM ${tabela} WHERE id = $1`, [id])
  if (!r.rows[0]?.a_combinar) return null
  return validarValorDemanda(valorProposto).erro ? ERRO_VALOR_PROPOSTA_OBRIGATORIO : null
}
const ROTULO_VALOR_A_COMBINAR = 'Valor a combinar'

// Migração de boot (idempotente). obras.valor nasceu NOT NULL em produção: sem o DROP NOT NULL o
// INSERT de um pedido "a combinar" falharia. CORREÇÃO ÚNICA de dados (marcador em configuracoes):
// pedidos ABERTOS com valor <= 1,00 (ou sem valor) eram "a combinar" disfarçado de R$ 0,01 —
// viram valor_a_combinar = true com valor NULL. Só roda uma vez: um pedido novo de R$ 1 depois
// disso é R$ 1 mesmo. Devolve os pedidos corrigidos (para o log do boot).
const MARCADOR_BACKFILL = 'valor_a_combinar_backfill_em'
const migrarValorACombinar = async (client) => {
  await client.query(`ALTER TABLE obras   ADD COLUMN IF NOT EXISTS valor_a_combinar BOOLEAN NOT NULL DEFAULT false`)
  await client.query(`ALTER TABLE reparos ADD COLUMN IF NOT EXISTS valor_a_combinar BOOLEAN NOT NULL DEFAULT false`)
  await client.query(`ALTER TABLE obras   ALTER COLUMN valor DROP NOT NULL`)
  await client.query(`ALTER TABLE reparos ALTER COLUMN valor_estimado DROP NOT NULL`)
  const claim = await client.query(
    `INSERT INTO configuracoes (chave, valor) VALUES ($1, NOW()::text) ON CONFLICT (chave) DO NOTHING RETURNING chave`, [MARCADOR_BACKFILL])
  if (claim.rows.length === 0) return []
  const corrigidos = []
  for (const [tabela, coluna] of [['reparos', 'valor_estimado'], ['obras', 'valor']]) {
    const r = await client.query(
      `UPDATE ${tabela} d SET valor_a_combinar = true, ${coluna} = NULL
         FROM (SELECT id, ${coluna} AS valor_antes FROM ${tabela} WHERE status = 'aberta' AND (${coluna} IS NULL OR ${coluna} <= 1) FOR UPDATE) a
        WHERE d.id = a.id
        RETURNING d.id, d.titulo, a.valor_antes`)
    for (const x of r.rows) corrigidos.push({ tabela, id: x.id, titulo: x.titulo, valor_antes: x.valor_antes })
  }
  return corrigidos
}

// ─── COMPATIBILIDADE COM O APP JÁ INSTALADO (16/11/2026) ─────────────────────────────────────────
// As versões do app em campo não conhecem valor_a_combinar e podem quebrar com valor NULL. O BANCO
// continua com NULL (a invariante acima não muda); só a RESPOSTA ao app troca: em todo objeto com
// valor_a_combinar === true, o valor do PEDIDO (chaves `valor` / `valor_estimado`) que estiver
// null/undefined sai como '0.01' — texto, como o pg devolve qualquer numeric ("150.00"), e o
// mesmo número que esses pedidos tinham antes da coluna existir. valor_a_combinar: true segue no
// objeto: o app novo mostra o chip e ignora o 0,01. valor_proposto (a proposta do profissional) e
// valor_acordado NÃO são tocados. Só troca chave que JÁ existe no objeto.
// O PAINEL não passa por aqui (ehRotaDoPainel): lá o valor segue null, ao lado de valor_acordado.
const VALOR_COMPAT_APP = '0.01'
const CAMPOS_VALOR_DO_PEDIDO = ['valor', 'valor_estimado']
const PROFUNDIDADE_MAX = 8
// Percorre listas e objetos simples (linhas do pg, corpos montados pelas rotas) e corrige NO LUGAR.
const protegerValorParaApp = (dado, nivel = 0) => {
  if (dado === null || typeof dado !== 'object' || nivel > PROFUNDIDADE_MAX) return dado
  if (Array.isArray(dado)) { for (const item of dado) protegerValorParaApp(item, nivel + 1); return dado }
  if (dado instanceof Date || Buffer.isBuffer(dado)) return dado
  if (dado.valor_a_combinar === true) {
    for (const campo of CAMPOS_VALOR_DO_PEDIDO) {
      if (campo in dado && (dado[campo] === null || dado[campo] === undefined)) dado[campo] = VALOR_COMPAT_APP
    }
  }
  for (const chave of Object.keys(dado)) {
    const v = dado[chave]
    if (v !== null && typeof v === 'object') protegerValorParaApp(v, nivel + 1)
  }
  return dado
}
// Rotas do PAINEL (caminho relativo ao router montado em /api): /admin/*, as listas e filas de
// aprovação do painel e o CRUD de obra do painel (POST /obras, PUT|DELETE /obras/:id).
const ehRotaDoPainel = (req) => {
  const caminho = String(req?.path || '')
  const metodo = String(req?.method || 'GET').toUpperCase()
  const partes = caminho.split('/').filter(Boolean) // '/obras/admin' → ['obras', 'admin']
  if (partes[0] === 'admin' || partes[0] === 'obras-aprovacao') return true
  if ((partes[0] === 'obras' || partes[0] === 'reparos') && partes[1] === 'admin') return true
  if (partes[0] === 'reparos' && partes[1] === 'aprovacao') return true
  if (partes[0] === 'obras' && partes.length === 1 && metodo === 'POST') return true
  if (partes[0] === 'obras' && partes.length === 2 && (metodo === 'PUT' || metodo === 'DELETE')) return true
  return false
}
// Middleware do router do app (routes/index.js, antes de qualquer rota): embrulha res.json.
// Nunca derruba a resposta — falha na troca devolve o corpo como veio.
const middlewareValorParaApp = function valorACombinarParaApp(req, res, next) {
  if (ehRotaDoPainel(req)) return next()
  const jsonOriginal = res.json.bind(res)
  res.json = (corpo) => {
    try { protegerValorParaApp(corpo) } catch (err) { console.error('[valor a combinar] compat do app falhou:', err.message) }
    return jsonOriginal(corpo)
  }
  next()
}

module.exports = {
  protegerValorParaApp, ehRotaDoPainel, middlewareValorParaApp, VALOR_COMPAT_APP,
  validarValorDemanda, MENSAGEM_VALOR_OBRIGATORIO, CODIGO_VALOR_OBRIGATORIO, ERRO_VALOR_OBRIGATORIO,
  resolverValorDemanda, exigirValorPropostaSeACombinar, migrarValorACombinar,
  MENSAGEM_VALOR_PROPOSTA_OBRIGATORIO, ERRO_VALOR_PROPOSTA_OBRIGATORIO, ROTULO_VALOR_A_COMBINAR, MARCADOR_BACKFILL,
}
