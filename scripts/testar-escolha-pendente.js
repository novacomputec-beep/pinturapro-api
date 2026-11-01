#!/usr/bin/env node
// Testa as BANDAS proporcionais dos avisos "Seu pedido vai expirar" (escolhaPendenteService):
// avalia o SQL real de sqlJanelaMarco contra linhas sintéticas (VALUES) no Postgres — só SELECT,
// nenhuma tabela é lida ou escrita. Precisa de DATABASE_URL no ambiente ou .env no cwd.
//   node scripts/testar-escolha-pendente.js
require('dotenv').config()
const { pool } = require('../src/utils/supabase')
const S = require('../src/services/escolhaPendenteService')

const H = 3600
// [vida L (h), restante (h), primeiro?, final?, rótulo]
const CASOS = [
  [23, 22.9, false, false, '"amanhã" (23h): minutos depois de criar — NADA (bug: saía o "24h")'],
  [23, 6.0,  false, false, '23h: faltam 6h — ainda não (banda 25% = 5h45)'],
  [23, 5.5,  true,  false, '23h: faltam 5h30 — primeiro'],
  [23, 1.9,  true,  true,  '23h: faltam 1h54 — final (banda 2h; 3h45 depois do primeiro)'],
  [24, 23.9, false, false, '24h: minutos depois de criar — nada'],
  [24, 5.9,  true,  false, '24h: faltam 5h54 — primeiro (banda 6h)'],
  [72, 23.0, false, false, '3 dias: faltam 23h — ainda não (banda 25% = 18h)'],
  [72, 17.5, true,  false, '3 dias: faltam 17h30 — primeiro'],
  [72, 1.9,  true,  true,  '3 dias: faltam 1h54 — final'],
  [168, 23.5, true, false, '7 dias: faltam 23h30 — primeiro (banda teto 24h)'],
  [168, 2.5,  true, false, '7 dias: faltam 2h30 — final ainda não'],
  [168, 1.9,  true, true,  '7 dias: faltam 1h54 — final'],
  [720, 23.5, true, false, '30 dias: faltam 23h30 — primeiro (teto 24h)'],
  [720, 1.9,  true, true,  '30 dias: faltam 1h54 — final'],
  [6, 1.4,   true,  false, '6h: faltam 1h24 — primeiro (banda 1h30)'],
  [6, 0.5,   true,  false, '6h: faltam 30min — final PULADO (cairia 54min depois do primeiro)'],
]
// primeiro já enviado há X min (adiado pelo silêncio): final só se X ≥ 60
const CASOS_ADIADO = [
  [72, 1.9, 30,  false, '3 dias, primeiro saiu há 30min — final pulado'],
  [72, 1.9, 61,  true,  '3 dias, primeiro saiu há 61min — final sai'],
]

const main = async () => {
  const lado = S.LADOS[0] // reparos: âncora = criado_em
  let falhas = 0
  const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra ? ' | ' + extra : ''}`) }
  const avaliar = async (L, restante, avisadoMin) => {
    const r = await pool.query(`
      SELECT (${S.sqlBanda(lado, S.MARCO_PRIMEIRO)})::text AS banda1, (${S.sqlBanda(lado, S.MARCO_FINAL)})::text AS banda2,
             (${S.sqlJanelaMarco(lado, S.MARCO_PRIMEIRO)}) AS primeiro,
             (${S.sqlJanelaMarco(lado, S.MARCO_FINAL)}) AS final
        FROM (VALUES (NOW() + $1::int * INTERVAL '1 second', NOW() + ($1::int - $2::int) * INTERVAL '1 second',
                      CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() - $3::int * INTERVAL '1 minute' END))
             AS d(expira_em, criado_em, escolha_aviso_24h_em)`,
      [Math.round(restante * H), Math.round(L * H), avisadoMin ?? null])
    return r.rows[0]
  }
  const fmt = (iv) => String(iv).replace(/:00(\.\d+)?$/, '')
  for (const [L, rest, p, f, rot] of CASOS) {
    const r = await avaliar(L, rest, null)
    ok(r.primeiro === p && r.final === f, rot, `bandas ${fmt(r.banda1)}/${fmt(r.banda2)} → primeiro=${r.primeiro} final=${r.final}`)
  }
  for (const [L, rest, min, f, rot] of CASOS_ADIADO) {
    const r = await avaliar(L, rest, min)
    ok(r.final === f, rot, `final=${r.final}`)
  }
  ok(S.rotuloRestante(330) === '6 horas' && S.rotuloRestante(119) === '2 horas' && S.rotuloRestante(45) === '1 hora' && S.rotuloRestante(1050) === '18 horas', 'rotuloRestante: 330→6 horas, 119→2 horas, 45→1 hora, 1050→18 horas')
  console.log(`\n${CASOS.length + CASOS_ADIADO.length + 1} casos, ${falhas} falha(s)`)
  process.exitCode = falhas ? 1 : 0
}
main().catch(err => { console.error('erro:', err.message); process.exitCode = 1 }).finally(() => pool.end())
