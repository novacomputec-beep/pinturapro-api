// Dicas do ProTudo — seção "💡 Dicas" do app: regras não óbvias da plataforma, por lado da
// conta (cliente = dono_reparo/dono_obra, profissional = reparador/pintor), agrupadas por tema.
//
// Fonte única de: DDL da tabela (migração em routes/index.js), seed (upsert idempotente por
// lado+tema+ordem, roda a cada boot), vocabulário fechado (lados, ações), validação do CRUD
// admin e a consulta agrupada que GET /dicas devolve.
//
// texto aceita marcação **negrito** (o app renderiza). acao = atalho opcional que o app
// oferece abaixo da dica; nenhuma dica é exibida como popup — só nas telas de Dicas.
// novo_ate = até quando a dica leva a etiqueta "NOVO" (data civil em America/Sao_Paulo).
//
// O seed atualiza texto/ícone/ordem do tema/acao/novo_ate das linhas que ele conhece, mas NUNCA
// mexe em `ativo` (o admin pode desligar uma dica do seed e ela fica desligada) nem apaga linhas
// que o admin criou além do seed.

const LADOS = ['cliente', 'profissional']
const ACOES = ['ativar_avisos', 'meus_pedidos', 'editar_perfil', 'especialidades', 'meus_perfis']
const TEMA_MAX = 60
const ICONE_MAX = 16
const TEXTO_MAX = 400
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/

const SQL_CRIAR_TABELA_DICAS = `
  CREATE TABLE IF NOT EXISTS dicas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lado TEXT NOT NULL CHECK (lado IN ('cliente','profissional')),
    tema TEXT NOT NULL,
    tema_icone TEXT,
    tema_ordem INTEGER NOT NULL DEFAULT 0,
    ordem INTEGER NOT NULL DEFAULT 0,
    texto TEXT NOT NULL,
    acao TEXT CHECK (acao IS NULL OR acao IN ('ativar_avisos','meus_pedidos','editar_perfil','especialidades','meus_perfis')),
    novo_ate DATE,
    ativo BOOLEAN NOT NULL DEFAULT true,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (lado, tema, ordem)
  )
`

// Seed. Cada tema: { lado, tema, icone, tema_ordem, dicas: [[ordem, texto, acao?, novo_ate?]] }.
const SEED_DICAS = [
  { lado: 'cliente', tema: 'Publicar o pedido', icone: '📝', tema_ordem: 1, dicas: [
    [1, 'Até 3 categorias. **Marcar "Outros"** faz o aviso chegar a todos os profissionais da cidade.'],
    [2, 'Esqueceu uma área? **Acrescente a categoria**: só os profissionais novos são avisados.', 'meus_pedidos', '2026-12-04'],
    [3, '**Obra passa por análise** antes de aparecer, e o prazo só começa a contar depois de aprovada.'],
    [4, 'Até concluir o 1º serviço, você pode ter **até 5 pedidos abertos** ao mesmo tempo.'],
  ] },
  { lado: 'cliente', tema: 'Prazo e valor', icone: '💰', tema_ordem: 2, dicas: [
    [1, 'Antes de vencer, você recebe **3 alertas**, só se ninguém tiver se interessado.'],
    [2, '**Aumentar o prazo** avisa só quem já se interessou; não reenvia o pedido para todos.', 'meus_pedidos'],
    [3, '**Aumentar o valor** pode uma vez, com no mínimo 10%, depois do aviso de pouco interesse ou de 2/3 do prazo. Aí o pedido é **reenviado a todos**.', 'meus_pedidos'],
    [4, 'Muita gente olhou e ninguém se interessou? O app sugere aumentar a oferta, mas **manter o seu valor também é escolha sua**.'],
  ] },
  { lado: 'cliente', tema: 'Escolher o profissional', icone: '👥', tema_ordem: 3, dicas: [
    [1, 'Tem interessados? **Responda em até 6 horas.** Depois disso vêm lembretes diários.', 'meus_pedidos'],
    [2, 'Sua resposta a uma pergunta **aparece para todos** os profissionais; quem perguntou fica anônimo.'],
  ] },
  { lado: 'cliente', tema: 'Depois do match', icone: '🚗', tema_ordem: 4, dicas: [
    [1, 'Seu **telefone e endereço completos** só aparecem quando o profissional toca em "Estou a caminho"; antes ele vê só seu primeiro nome.'],
    [2, 'O profissional tem **15 minutos de tolerância** e pode pedir mais tempo até 2 vezes. Sem sua resposta em 10 minutos, o pedido de tempo é aceito.'],
    [3, '**Cancelar com menos de 12 horas** de antecedência conta como falta. Cancelamento combinado pelos dois não conta.'],
    [4, 'Pediram para encerrar e você não respondeu? Encerra sozinho em **3 horas (serviço) ou 2 dias (obra)**.'],
    [5, 'Você tem **7 dias para avaliar**, com estrelas e até 5 elogios.'],
  ] },
  { lado: 'cliente', tema: 'Cuidados', icone: '🛡️', tema_ordem: 5, dicas: [
    [1, '**Telefone escrito no texto é escondido.** Na 3ª tentativa em 90 dias, a conta fica suspensa por 7 dias.'],
  ] },
  { lado: 'profissional', tema: 'Receber pedidos', icone: '📲', tema_ordem: 1, dicas: [
    [1, 'Os avisos chegam **só da sua cidade**. Para ver cidades vizinhas, use o **filtro de distância** no feed. Mantenha a cidade certa.', 'editar_perfil'],
    [2, 'Você recebe os pedidos das **suas especialidades e do grupo delas** (ex.: Elétrica recebe toda a área de Reparos da casa).', 'especialidades'],
    [3, 'Pedido marcado **"Outros"** chega por push a todos.'],
    [4, 'Abriu um pedido a mais de 5 km e depois passou perto? O app avisa **"Serviço próximo a você"**.'],
    [5, 'Notificações desligadas = só e-mail, e mais devagar. **Ative os avisos.**', 'ativar_avisos'],
  ] },
  { lado: 'profissional', tema: 'Sua proposta', icone: '✍️', tema_ordem: 2, dicas: [
    [1, '**Uma proposta por pedido.** O cliente aceita, recusa ou faz contraproposta.'],
    [2, '**1 pergunta por pedido**, até 200 caracteres, visível para todos e anônima.'],
    [3, 'Sem verificação aprovada você vê os pedidos, mas **não propõe nem pergunta**. Tenha à mão documento, selfie, chave PIX e 1 a 2 referências.'],
  ] },
  { lado: 'profissional', tema: 'No serviço', icone: '🛠️', tema_ordem: 3, dicas: [
    [1, 'Escolhido? **Combine o horário pelo app**: sem horário combinado você não leva falta.'],
    [2, '**15 minutos de tolerância.** Precisa de mais? Peça 15, 30 ou 60 min (até 2x) **antes** de estourar. Estourar desfaz o match.'],
    [3, '**3 faltas em 90 dias suspendem a conta.** Cancelar com menos de 12 horas conta como falta.'],
    [4, 'Terminou? **Peça o encerramento.** Sem resposta, fecha sozinho.'],
  ] },
  { lado: 'profissional', tema: 'Reputação', icone: '⭐', tema_ordem: 4, dicas: [
    [1, 'Sua média aparece desde a **1ª avaliação**. Com **3 notas 5** você ganha o selo **"Profissional bem avaliado"**.'],
    [2, 'Indicou 3 colegas aprovados? Ganha o selo **"Embaixador"**.'],
    [3, '**Telefone na mensagem é escondido.** Na 3ª tentativa em 90 dias, a conta fica suspensa por 7 dias.'],
  ] },
]

// Upsert idempotente por (lado, tema, ordem). `db` = client da transação da migração.
// Devolve quantas linhas foram tocadas (inseridas ou atualizadas).
const seedDicas = async (db) => {
  let n = 0
  for (const t of SEED_DICAS) {
    for (const [ordem, texto, acao = null, novoAte = null] of t.dicas) {
      await db.query(
        `INSERT INTO dicas (lado, tema, tema_icone, tema_ordem, ordem, texto, acao, novo_ate)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date)
         ON CONFLICT (lado, tema, ordem) DO UPDATE
           SET tema_icone = EXCLUDED.tema_icone, tema_ordem = EXCLUDED.tema_ordem, texto = EXCLUDED.texto,
               acao = EXCLUDED.acao, novo_ate = EXCLUDED.novo_ate`,
        [t.lado, t.tema, t.icone, t.tema_ordem, ordem, texto, acao, novoAte]
      )
      n++
    }
  }
  return n
}

// Lado da conta logada: role dono_obra (tipo_dono reparo ou obra) = cliente; prestador
// (reparador ou pintor) = profissional; admin/aprovador/outros = null (escolhe por ?lado).
const ladoDoUsuario = (u) => {
  if (!u) return null
  if (u.role === 'dono_obra') return 'cliente'
  if (u.role === 'prestador') return 'profissional'
  return null
}

const SELECT_DICA = `id, lado, tema, tema_icone, tema_ordem, ordem, texto, acao,
  to_char(novo_ate, 'YYYY-MM-DD') AS novo_ate,
  (novo_ate IS NOT NULL AND novo_ate >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date) AS nova,
  ativo, criado_em`

// Dicas ATIVAS de um lado, agrupadas por tema na ordem (tema_ordem, tema, ordem).
// { lado, total, temas: [{ tema, icone, ordem, dicas: [{ id, ordem, texto, acao, novo_ate, nova }] }] }
const listarDicasAgrupadas = async (db, lado) => {
  const r = await db.query(
    `SELECT ${SELECT_DICA} FROM dicas WHERE lado = $1 AND ativo ORDER BY tema_ordem, tema, ordem, criado_em`,
    [lado]
  )
  const temas = []
  for (const d of r.rows) {
    let t = temas[temas.length - 1]
    if (!t || t.tema !== d.tema) {
      t = { tema: d.tema, icone: d.tema_icone, ordem: d.tema_ordem, dicas: [] }
      temas.push(t)
    }
    t.dicas.push({ id: d.id, ordem: d.ordem, texto: d.texto, acao: d.acao, novo_ate: d.novo_ate, nova: d.nova === true })
  }
  return { lado, total: r.rows.length, temas }
}

// Valida o corpo do CRUD admin. parcial=true (PUT) aceita só os campos presentes; parcial=false
// (POST) exige lado, tema e texto. Devolve { erro } ou { valores } (só as chaves presentes,
// já normalizadas: strings aparadas, inteiros, null para "sem ação"/"sem data").
const validarDica = (body, { parcial = false } = {}) => {
  const b = body && typeof body === 'object' ? body : {}
  const v = {}
  const tem = (k) => b[k] !== undefined
  if (tem('lado') || !parcial) {
    if (!LADOS.includes(b.lado)) return { erro: `lado deve ser ${LADOS.join(' ou ')}` }
    v.lado = b.lado
  }
  if (tem('tema') || !parcial) {
    const s = typeof b.tema === 'string' ? b.tema.trim() : ''
    if (!s || s.length > TEMA_MAX) return { erro: `tema é obrigatório (até ${TEMA_MAX} caracteres)` }
    v.tema = s
  }
  if (tem('tema_icone')) {
    if (b.tema_icone === null || b.tema_icone === '') v.tema_icone = null
    else if (typeof b.tema_icone !== 'string' || b.tema_icone.trim().length > ICONE_MAX) return { erro: `tema_icone deve ter até ${ICONE_MAX} caracteres` }
    else v.tema_icone = b.tema_icone.trim()
  }
  for (const k of ['tema_ordem', 'ordem']) {
    if (!tem(k)) continue
    const n = Number(b[k])
    if (!Number.isInteger(n) || n < 0 || n > 9999) return { erro: `${k} deve ser um inteiro entre 0 e 9999` }
    v[k] = n
  }
  if (tem('texto') || !parcial) {
    const s = typeof b.texto === 'string' ? b.texto.trim() : ''
    if (!s || s.length > TEXTO_MAX) return { erro: `texto é obrigatório (até ${TEXTO_MAX} caracteres)` }
    v.texto = s
  }
  if (tem('acao')) {
    if (b.acao === null || b.acao === '') v.acao = null
    else if (!ACOES.includes(b.acao)) return { erro: `acao deve ser uma de: ${ACOES.join(', ')}` }
    else v.acao = b.acao
  }
  if (tem('novo_ate')) {
    if (b.novo_ate === null || b.novo_ate === '') v.novo_ate = null
    else if (typeof b.novo_ate !== 'string' || !RE_DATA.test(b.novo_ate) || Number.isNaN(Date.parse(b.novo_ate))) return { erro: 'novo_ate deve ser uma data AAAA-MM-DD' }
    else v.novo_ate = b.novo_ate
  }
  if (tem('ativo')) {
    if (typeof b.ativo !== 'boolean') return { erro: 'ativo deve ser true ou false' }
    v.ativo = b.ativo
  }
  return { valores: v }
}

module.exports = { LADOS, ACOES, SQL_CRIAR_TABELA_DICAS, SEED_DICAS, SELECT_DICA, seedDicas, ladoDoUsuario, listarDicasAgrupadas, validarDica }
