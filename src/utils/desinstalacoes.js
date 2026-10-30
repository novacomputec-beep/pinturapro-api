const { pool } = require('./supabase')

// Desinstalação PROVÁVEL do app: o Expo devolve DeviceNotRegistered (recibo ou ticket) quando o
// aparelho deixou de aceitar o token — quase sempre app desinstalado (também pode ser dado do
// app limpo ou permissão revogada no iOS). Só sinal, não certeza.
// Um único statement: nula o token em TODAS as linhas que o tenham (limpeza de sempre), marca
// usuarios.desinstalado_em só onde ainda era NULL e abre uma linha em desinstalacoes só para
// essas. O self-join (o) lê os valores ANTERIORES da linha — RETURNING de u já veria o token
// nulado. Re-detecção do mesmo usuário (outro token antigo, recibo atrasado) não duplica.
// Devolve { removidos, novos }. Lança — o chamador loga.
const marcarDesinstalados = async (tokens, db = pool) => {
  const lista = [...new Set(tokens)].filter(Boolean)
  if (lista.length === 0) return { removidos: 0, novos: 0 }
  const r = await db.query(
    `WITH alvo AS (
       UPDATE usuarios u
          SET push_token = NULL,
              desinstalado_em = COALESCE(u.desinstalado_em, NOW())
         FROM usuarios o
        WHERE o.id = u.id AND u.push_token = ANY($1::text[])
       RETURNING u.id, o.desinstalado_em IS NULL AS novo,
                 COALESCE(o.push_plataforma, o.plataforma) AS plataforma,
                 left(o.push_token, 30) AS token_prefix
     ), hist AS (
       INSERT INTO desinstalacoes (usuario_id, plataforma, token_prefix)
       SELECT id, plataforma, token_prefix FROM alvo WHERE novo
       RETURNING 1
     )
     SELECT (SELECT COUNT(*) FROM alvo)::int AS removidos, (SELECT COUNT(*) FROM hist)::int AS novos`,
    [lista]
  )
  return r.rows[0]
}

// O usuário voltou (registrou push token de novo, ou fez login pelo app): fecha a linha aberta
// do histórico e limpa usuarios.desinstalado_em. Sem desinstalação aberta é um no-op barato
// (o UPDATE de usuarios só toca a linha se desinstalado_em IS NOT NULL). Nunca lança nem
// espera — mesma convenção de registrarPlataforma.
const registrarReinstalacao = (usuarioId, db = pool) => {
  if (!usuarioId) return Promise.resolve()
  return db.query(
    `WITH u AS (
       UPDATE usuarios SET desinstalado_em = NULL WHERE id = $1 AND desinstalado_em IS NOT NULL RETURNING id
     )
     UPDATE desinstalacoes SET reinstalado_em = NOW() WHERE usuario_id = $1 AND reinstalado_em IS NULL`,
    [usuarioId]
  ).catch(err => console.error('[Desinstalacao] Erro ao registrar reinstalação:', err.message))
}

// Regra do dono: toda CONTAGEM de população do painel (cards, totais, cidades, planos,
// plataformas, crescimento, nichos, adoção de versão) ignora a desinstalação provável. Listas
// continuam trazendo essas contas, com desinstalado_em para o painel marcá-las. Não vale para
// endpoints do app nem para público de notificação (quem desinstalou já não tem push_token).
const sqlInstalado = (alias = 'u') => `${alias}.desinstalado_em IS NULL`

module.exports = { marcarDesinstalados, registrarReinstalacao, sqlInstalado }
