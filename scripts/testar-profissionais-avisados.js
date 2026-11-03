#!/usr/bin/env node
// Testa contarProfissionaisAvisados (src/utils/profissionaisAvisados) com o SQL REAL, dentro de
// uma transação desfeita no fim (BEGIN … ROLLBACK): nada fica gravado. Precisa de DATABASE_URL
// no ambiente ou .env no cwd. Os ids são UUIDs fixos que nunca existem em produção; as linhas em
// push_entregas / email_alertas não têm FK para a demanda, então não é preciso criar reparo/obra.
//   node scripts/testar-profissionais-avisados.js
require('dotenv').config()
const { pool } = require('../src/utils/supabase')
const { contarProfissionaisAvisados } = require('../src/utils/profissionaisAvisados')

const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const DONO = U(99)

const main = async () => {
  const client = await pool.connect()
  let falhas = 0
  const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + extra : ''}`) }
  try {
    await client.query('BEGIN')
    // Usuários sintéticos (FK de push_entregas/email_alertas). Colunas mínimas + as NOT NULL
    // mais prováveis; se o esquema exigir outra, a transação falha e nada é gravado.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 99]) {
      await client.query(
        `INSERT INTO usuarios (id, nome, email, telefone, senha_hash, role)
         VALUES ($1, $2, $3, '34900000000', 'x', 'prestador')`,
        [U(n), `Teste Avisado ${n}`, `teste.avisado.${n}@example.invalid`]
      )
    }
    const push = (tipo, d, u, resultado, tentativas = 1) => client.query(
      `INSERT INTO push_entregas (tipo, demanda_id, usuario_id, resultado, tentativas) VALUES ($1, $2, $3, $4, $5)`,
      [tipo, d, u, resultado, tentativas])
    const email = (tipo, d, u) => client.query(
      `INSERT INTO email_alertas (tipo, demanda_id, usuario_id) VALUES ($1, $2, $3)`, [tipo, d, u])

    // Reparo D1: 1 push+e-mail, 2 push, 3 push falha, 4 push inválido, 5 só e-mail,
    // 6 só lembrete (e-mail), 7 só reanúncio (e-mail), DONO com e-mail → esperado 3 (1, 2, 5).
    await push('reparo', D(1), U(1), 'enviado')
    await email('reparo', D(1), U(1))
    await push('reparo', D(1), U(2), 'enviado', 3) // repescado: a MESMA linha, tentativas 3
    await push('reparo', D(1), U(3), 'falha')
    await push('reparo', D(1), U(4), 'invalido')
    await email('reparo', D(1), U(5))
    await email('lembrete_reparo#1', D(1), U(6))
    await email('reaberta_reparo', D(1), U(7))
    await email('reparo', D(1), DONO)
    ok(await contarProfissionaisAvisados('reparos', D(1), DONO, client) === 3,
      'reparo: push enviado ∪ e-mail, sem falha/inválido/lembrete/reanúncio/dono, reenvio conta 1 → 3')

    // Obra D2: 8 push 'obra'; 9 e-mail com tipo 'reparo' no MESMO id (tipo errado, não conta) → 1.
    await push('obra', D(2), U(8), 'enviado')
    await email('reparo', D(2), U(9))
    ok(await contarProfissionaisAvisados('obras', D(2), DONO, client) === 1, 'obra: só o tipo da própria tabela → 1')
    ok(await contarProfissionaisAvisados('reparos', D(2), DONO, client) === 1, 'reparos no id da obra: só o e-mail de tipo reparo → 1')

    // Demanda sem registro → 0; criadoPor nulo não derruba.
    ok(await contarProfissionaisAvisados('reparos', D(3), DONO, client) === 0, 'sem registros → 0')
    ok(await contarProfissionaisAvisados('reparos', D(1), null, client) === 4, 'criadoPor nulo: ninguém excluído → 4')
    let erro = null
    try { await contarProfissionaisAvisados('usuarios', D(1), DONO, client) } catch (e) { erro = e.message }
    ok(/tabela inválida/.test(erro || ''), 'tabela fora de obras/reparos → erro')
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  console.log(`\n${falhas} falha(s)`)
  await pool.end().catch(() => {})
  process.exit(falhas ? 1 : 0)
}

main().catch(async (e) => { console.error('ERRO', e.message); await pool.end().catch(() => {}); process.exit(1) })
