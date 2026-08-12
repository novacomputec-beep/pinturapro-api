const { pool } = require('./supabase')

// Contador de tentativas POR IDENTIDADE (e-mail submetido), guarda interna ao lado dos
// limiters por IP de server.js — que continuam existindo como guarda grossa de volume.
// O limiter por IP não enxerga um ataque DIRIGIDO a uma conta (atacante trocando de IP), e
// nesta base ele já é fraco por outro motivo: os usuários saem por CGNAT da operadora, então
// muitos aparelhos reais dividem o mesmo IP público (ver comentário do limiter de cadastro).
//
// Chave é o E-MAIL SUBMETIDO, não o usuario_id, e conta MESMO para endereço sem conta. É isso
// que torna seguro devolver um 429 explícito no login: um e-mail inexistente tranca igual a um
// real, então o status não vira oráculo de existência de conta. Se contasse só para contas
// existentes, o 429 denunciaria quais e-mails existem.
//
// Tabela sem FK para usuarios: o identificador pode não ter conta, e a linha deve sobreviver
// à exclusão da conta.
const LIMITES = {
  // 6ª tentativa em 15 min é barrada. Humano digitando errado raramente passa de três, e
  // gerenciador de senha não erra em sequência.
  login: { max: 5, janela: '15 minutes' },
  // Não é ataque de adivinhação: é bomba de e-mail / enumeração. Três por hora é folgado
  // para uso real e inútil como canal de abuso.
  reset: { max: 3, janela: '1 hour' },
}

// Registra a tentativa e DEVOLVE o total da janela — checar e incrementar no MESMO statement
// elimina a corrida do read-then-write, então duas réplicas incrementando ao mesmo tempo
// chegam a contas corretas.
//
// Janela FIXA, ancorada na primeira tentativa — deliberadamente NÃO deslizante: tentativa
// durante o bloqueio incrementa mas NÃO empurra janela_em. Se empurrasse, um atacante
// manteria a conta da vítima trancada para sempre martelando — o controle de segurança
// viraria negação de serviço contra o dono legítimo.
const registrarTentativa = async (acao, identificador) => {
  const { max, janela } = LIMITES[acao]
  const r = await pool.query(
    `INSERT INTO tentativas_auth (acao, identificador, tentativas, janela_em)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (acao, identificador) DO UPDATE SET
       tentativas = CASE WHEN tentativas_auth.janela_em < NOW() - $3::interval
                         THEN 1 ELSE tentativas_auth.tentativas + 1 END,
       janela_em  = CASE WHEN tentativas_auth.janela_em < NOW() - $3::interval
                         THEN NOW() ELSE tentativas_auth.janela_em END
     RETURNING tentativas,
               GREATEST(0, CEIL(EXTRACT(EPOCH FROM (janela_em + $3::interval - NOW()))))::int
                 AS segundos_restantes`,
    [acao, identificador, janela]
  )
  const { tentativas, segundos_restantes } = r.rows[0]
  return { excedeu: tentativas > max, tentativas, segundosRestantes: segundos_restantes }
}

// Some com a linha em vez de zerar: mantém a tabela pequena. Chamado quando a senha confere.
const limparTentativas = async (acao, identificador) => {
  await pool.query(`DELETE FROM tentativas_auth WHERE acao = $1 AND identificador = $2`, [acao, identificador])
}

// Varredura diária. A tabela acumula linhas de e-mails inexistentes (é o preço de contar
// todos, que é o que fecha o oráculo), então precisa de poda.
const limparTentativasAntigas = async () => {
  try {
    const r = await pool.query(`DELETE FROM tentativas_auth WHERE janela_em < NOW() - INTERVAL '1 day'`)
    if (r.rowCount > 0) console.log(`[TentativasAuth] ${r.rowCount} registro(s) antigo(s) removido(s)`)
  } catch (err) {
    console.error('[TentativasAuth] Erro na limpeza:', err.message)
  }
}

module.exports = { registrarTentativa, limparTentativas, limparTentativasAntigas, LIMITES }
