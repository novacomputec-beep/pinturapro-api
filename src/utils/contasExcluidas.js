// Registro de contas EXCLUÍDAS (dono, 11/11/2026). Até aqui a exclusão (DELETE /conta/excluir e o
// DELETE /usuarios/:id do admin) não deixava rastro no banco: tentativas_auth é limpo no sucesso e só
// saía o e-mail ao usuário. A tabela guarda UMA linha por conta apagada:
//   id          — o id que a conta tinha (usuarios.id), para casar com o que sobrou em push_entregas,
//                 eventos_responsabilidade, lembretes_push_enviados etc.;
//   nome, role  — como estavam;
//   cpf_hash    — sha256 dos dígitos do CPF/CNPJ (nunca o número), para ligar as contas da mesma
//                 pessoa e reconhecer um recadastro sem guardar o documento; NULL sem CPF;
//   excluido_em — relógio do banco;
//   por         — 'usuario' (self-service) ou o id do admin que excluiu.
// Gravado DENTRO da transação da exclusão, antes do DELETE da conta.
const crypto = require('crypto')

const migrarContasExcluidas = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS contas_excluidas (
      id          UUID PRIMARY KEY,
      nome        TEXT,
      cpf_hash    TEXT,
      role        TEXT,
      excluido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      por         TEXT NOT NULL
    )`)
  await client.query(`CREATE INDEX IF NOT EXISTS contas_excluidas_excluido_em_idx ON contas_excluidas (excluido_em DESC)`)
  await client.query(`CREATE INDEX IF NOT EXISTS contas_excluidas_cpf_hash_idx ON contas_excluidas (cpf_hash) WHERE cpf_hash IS NOT NULL`)
}

const hashCpf = (cpfCnpj) => {
  const digitos = String(cpfCnpj || '').replace(/\D/g, '')
  return digitos ? crypto.createHash('sha256').update(digitos).digest('hex') : null
}

// `por`: 'usuario' ou o id (uuid) do admin. ON CONFLICT: o id é PK — uma reexecução não duplica.
const registrarContaExcluida = async (client, { id, nome, cpf_cnpj, role }, por) => {
  await client.query(
    `INSERT INTO contas_excluidas (id, nome, cpf_hash, role, por) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET excluido_em = NOW(), por = EXCLUDED.por`,
    [id, nome || null, hashCpf(cpf_cnpj), role || null, String(por || 'usuario')]
  )
}

module.exports = { migrarContasExcluidas, registrarContaExcluida, hashCpf }
