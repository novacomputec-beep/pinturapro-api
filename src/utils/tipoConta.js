const { pool } = require('./supabase')

// TIPO da conta — a unidade de unicidade das múltiplas contas: o mesmo e-mail (e o mesmo
// CPF/CNPJ) pode existir em até 4 contas, UMA por tipo. Não há coluna "tipo": ele é derivado
// de role/tipo_dono/tipo_prestador, e a MESMA derivação vive em três lugares que precisam
// concordar — a expressão SQL abaixo (usada nos índices únicos da migração e nos lookups),
// tipoDaLinha (JS, sobre uma linha já lida) e tipoDeTipoConta (o tipo_conta que o app manda).
//
// Os 4 tipos de cadastro: dono_obra | dono_reparo | pintor | reparador. pintor e construtor
// são o MESMO tipo (o cadastro grava ambos como tipo_prestador 'pintor'). Linha legada com
// tipo_dono/tipo_prestador NULL cai no tipo "de pintura" do seu role (o produto original, de
// antes de existir reparo). admin e assinante (cadastro sem tipo_conta) ficam com o próprio role: não
// são tipos de cadastro, mas a expressão precisa ser total para o índice cobrir toda linha.
const TIPOS_CADASTRO = ['dono_obra', 'dono_reparo', 'pintor', 'reparador']
const MAX_CONTAS_POR_EMAIL = TIPOS_CADASTRO.length

// alias = prefixo da tabela ('' na migração — expressão de índice não aceita alias — ou 'u').
// IMUTÁVEL (só CASE/igualdade sobre colunas da própria linha), como índice de expressão exige.
// ATENÇÃO: o Postgres só usa/casa o índice se a expressão for IDÊNTICA à do CREATE INDEX;
// mudar isto aqui exige recriar os dois índices da migração.
const sqlTipoConta = (alias = '') => {
  const p = alias ? `${alias}.` : ''
  return `(CASE
    WHEN ${p}role = 'prestador' AND ${p}tipo_prestador = 'reparador' THEN 'reparador'
    WHEN ${p}role = 'prestador' THEN 'pintor'
    WHEN ${p}role = 'dono_obra' AND ${p}tipo_dono = 'reparo' THEN 'dono_reparo'
    WHEN ${p}role = 'dono_obra' THEN 'dono_obra'
    ELSE ${p}role
  END)`
}

const tipoDaLinha = (u) => {
  if (u.role === 'prestador') return u.tipo_prestador === 'reparador' ? 'reparador' : 'pintor'
  if (u.role === 'dono_obra') return u.tipo_dono === 'reparo' ? 'dono_reparo' : 'dono_obra'
  return u.role
}

// tipo_conta do app (vocabulário do cadastro) → tipo. 'prestador' no cadastro É o reparador.
// Aceita também os nomes canônicos (o login devolve `contas[].tipo` canônico e o app o manda
// de volta). Ausente/desconhecido → null: quem chama decide o que "sem tipo" significa.
const tipoDeTipoConta = (tipoConta) => {
  switch (tipoConta) {
    case 'dono_obra': return 'dono_obra'
    case 'dono_reparo': return 'dono_reparo'
    case 'pintor':
    case 'construtor': return 'pintor'
    case 'prestador':
    case 'reparador': return 'reparador'
    default: return null
  }
}

// Tipo pedido num CADASTRO/CONTA VINCULADA a partir do corpo inteiro: tipo_conta E os campos
// que o app manda junto (tipo_dono, tipo_prestador, role). O app de dono de SERVIÇO chegou a
// mandar tipo_conta 'dono_obra' com tipo_dono 'reparo' — lido só o tipo_conta, virava
// 'dono_obra' e colidia com a conta de pintura da mesma pessoa (falso cpf_duplicado /
// tipo_duplicado). Regra: tipo_dono 'reparo' (ou 'servico') manda em qualquer dono;
// tipo_prestador 'reparador' manda em qualquer profissional; sem tipo_conta, role decide.
// Desconhecido → null (quem chama decide: cadastro legado 'assinante', rota 400).
const ladoReparo = (v) => ['reparo', 'reparos', 'servico', 'serviço', 'servicos', 'serviços'].includes(String(v || '').toLowerCase())
const tipoDoCadastro = ({ tipo_conta, tipo_dono, tipo_prestador, role } = {}) => {
  const base = tipoDeTipoConta(tipo_conta)
    || (role === 'dono_obra' ? 'dono_obra' : role === 'prestador' ? 'pintor' : null)
  if (base === 'dono_obra' || base === 'dono_reparo') {
    if (ladoReparo(tipo_dono)) return 'dono_reparo'
    if (tipo_dono === 'pintura') return 'dono_obra'
    return base
  }
  if (base === 'pintor' || base === 'reparador') {
    if (tipo_prestador === 'reparador') return 'reparador'
    if (tipo_prestador === 'pintor') return 'pintor'
    return base
  }
  return null
}
// Inverso: role / tipo_dono / tipo_prestador que a linha de usuarios recebe para um tipo.
const colunasDoTipo = (tipo) => ({
  dono_obra:   { role: 'dono_obra', tipo_dono: 'pintura', tipo_prestador: null },
  dono_reparo: { role: 'dono_obra', tipo_dono: 'reparo',  tipo_prestador: null },
  pintor:      { role: 'prestador', tipo_dono: null, tipo_prestador: 'pintor' },
  reparador:   { role: 'prestador', tipo_dono: null, tipo_prestador: 'reparador' },
}[tipo] || null)

// Chave global (configuracoes.multiplas_contas, 'true'/'false', default 'false'). Lida a cada
// uso, sem cache, como as demais chaves — desligada, todo caminho responde como antes das
// múltiplas contas. `db` = client da transação quando a leitura precisa do mesmo snapshot.
const multiplasContasAtivo = async (db = pool) => {
  const r = await db.query(`SELECT valor FROM configuracoes WHERE chave = 'multiplas_contas'`)
  return r.rows[0]?.valor === 'true'
}

module.exports = { TIPOS_CADASTRO, MAX_CONTAS_POR_EMAIL, sqlTipoConta, tipoDaLinha, tipoDeTipoConta, tipoDoCadastro, colunasDoTipo, multiplasContasAtivo }
