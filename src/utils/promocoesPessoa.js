// "Receber promoções" (usuarios.aceita_promocoes) é preferência da PESSOA, não da conta.
// Pessoa = CPF/CNPJ NORMALIZADO, a mesma identidade de utils/tipoConta.sqlContasDaPessoa, mas
// SEM o recorte por role: dono_obra e prestador da mesma pessoa compartilham a escolha (decisão
// do dono, 12/11/2026). Conta sem CPF casa só consigo mesma (NULL = NULL é NULL). Inclui contas
// inativas, como sqlContasDaPessoa. A leitura (GET /auth/perfil) continua na conta logada; como
// toda escrita passa por aqui, as contas da pessoa ficam iguais.
const { sqlCpfNormalizado } = require('./demandaPropria')

// Conjunto de ids de TODAS as contas da pessoa de `param` (a própria sempre incluída).
const sqlTodasContasDaPessoa = (param = '$1') => `
      SELECT eu.id FROM usuarios eu WHERE eu.id = ${param}::uuid
      UNION
      SELECT irma.id FROM usuarios irma
        JOIN usuarios eu ON eu.id = ${param}::uuid
       WHERE ${sqlCpfNormalizado('irma.cpf_cnpj')} = ${sqlCpfNormalizado('eu.cpf_cnpj')}`

// PATCH /auth/preferencias: $1 = boolean, $2 = conta logada. RETURNING uma linha por conta gravada.
const SQL_PROMOCOES_DA_PESSOA = `UPDATE usuarios SET aceita_promocoes = $1::boolean
   WHERE id IN (${sqlTodasContasDaPessoa('$2')})
   RETURNING id, aceita_promocoes`

// Sync ÚNICO (migração, guardada por marcador em configuracoes): pessoa com valores MISTOS fica
// toda em true. A escolha explícita mais recente não é conhecida (não há timestamp), então o
// empate favorece ON. Só toca contas false com CPF que tenham alguma irmã true; pessoa toda false
// segue false, conta sem CPF não é tocada.
const SQL_SYNC_PROMOCOES_POR_PESSOA = `UPDATE usuarios u SET aceita_promocoes = true
   WHERE u.aceita_promocoes = false
     AND ${sqlCpfNormalizado('u.cpf_cnpj')} IS NOT NULL
     AND EXISTS (SELECT 1 FROM usuarios o
                  WHERE o.id <> u.id AND o.aceita_promocoes = true
                    AND ${sqlCpfNormalizado('o.cpf_cnpj')} = ${sqlCpfNormalizado('u.cpf_cnpj')})
   RETURNING u.id`

module.exports = { sqlTodasContasDaPessoa, SQL_PROMOCOES_DA_PESSOA, SQL_SYNC_PROMOCOES_POR_PESSOA }
