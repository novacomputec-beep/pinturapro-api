// limpar-teste.js — remove linhas de teste da tabela `usuarios` em produção,
// PRESERVANDO exatamente três contas. Usa o módulo `pg` (já instalado neste repo).
//
// Segurança:
//   • Sem --confirm  → apenas PRÉ-CHECAGEM (somente leitura). NADA é apagado.
//   • Com  --confirm → executa a exclusão numa ÚNICA transação; COMMIT só se não
//                      houver erro; qualquer erro faz ROLLBACK (nada é apagado).
//
// Uso (o DATABASE_URL NUNCA fica no código — passe pelo ambiente):
//   # Preview (não altera nada):
//   DATABASE_URL='postgres://...' node limpar-teste.js
//   # Executar de fato, após conferir os números do preview:
//   DATABASE_URL='postgres://...' node limpar-teste.js --confirm
//
// (No PowerShell:  $env:DATABASE_URL='...'; node limpar-teste.js  [--confirm] )

const { Pool } = require('pg')

// ── Configuração ────────────────────────────────────────────────────────────
const PRESERVAR = [
  'higorrusso10@gmail.com',
  'professorluizmelo@gmail.com',
  'pinturapro.oficial@gmail.com',   // ADMIN — login do painel, NUNCA apagar
]
const CONFIRM = process.argv.includes('--confirm')

// Tabelas cujos vínculos com `usuarios` este script trata EXPLICITAMENTE. Usada no
// cross-check de FKs para alertar sobre qualquer tabela dependente não coberta.
const TABELAS_TRATADAS = new Set([
  'obras', 'reparos', 'assinaturas', 'candidaturas', 'mensagens', 'interesse_reparos',
  'midias', 'midias_reparos', 'localizacoes_prestadores',
  'prestadores_bloqueados_dono', 'avaliacoes', 'feed_visualizacoes', 'usuarios',
])

if (!process.env.DATABASE_URL) {
  console.error('ERRO: DATABASE_URL não está definida no ambiente. Abortando (nada foi feito).')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL.trim(),
  ssl: { rejectUnauthorized: false },   // igual ao pool do app (Railway/Supabase)
})

// Predicado do conjunto a DELETAR: todo usuário cujo e-mail NÃO é um dos preservados.
// lower() porque o cadastro normaliza e-mails para minúsculas. E-mail NULL não entra
// no conjunto (é preservado por precaução — o check final acusaria se sobrar algo).
const ONDE_DELETAR = `lower(email) <> ALL($1::text[])`
const PARAMS = [PRESERVAR]

async function main() {
  const client = await pool.connect()
  try {
    // ══ PRÉ-CHECAGEM (somente leitura) ═══════════════════════════════════════
    console.log('══════════════════════════════════════════════════════════')
    console.log(' PRÉ-CHECAGEM (somente leitura — nada é alterado)')
    console.log('══════════════════════════════════════════════════════════')

    // 1) Os dois e-mails preservados existem mesmo?
    const pres = await client.query(
      `SELECT lower(email) AS email, role FROM usuarios
       WHERE lower(email) = ANY($1::text[]) ORDER BY email`,
      [PRESERVAR]
    )
    const encontrados = pres.rows.map(r => r.email)
    for (const e of PRESERVAR) {
      const linha = pres.rows.find(r => r.email === e)
      console.log(`  preservar ${e}: ${linha ? `ENCONTRADO ✓ (role=${linha.role})` : 'NÃO ENCONTRADO ✗'}`)
    }
    if (encontrados.length !== PRESERVAR.length) {
      console.error('\nABORTANDO: um ou ambos e-mails preservados não existem no banco.')
      console.error('Confira os endereços — NADA foi alterado.')
      return
    }

    // 2) Totais.
    const { rows: [{ n: total }] } = await client.query(`SELECT count(*)::int AS n FROM usuarios`)
    const { rows: [{ n: aDeletar }] } = await client.query(
      `SELECT count(*)::int AS n FROM usuarios WHERE ${ONDE_DELETAR}`, PARAMS)
    console.log(`\n  usuarios no total:     ${total}`)
    console.log(`  a PRESERVAR:           ${total - aDeletar}   (esperado: ${PRESERVAR.length})`)
    console.log(`  a DELETAR:             ${aDeletar}`)

    // 3) REDE DE SEGURANÇA — independe da lista PRESERVAR. NENHUM admin pode cair na
    //    exclusão. Se qualquer usuário com role='admin' ainda estiver no conjunto a
    //    deletar, ABORTA aqui — ANTES de qualquer escrita, valendo ou não o --confirm.
    //    (No app, admin = role='admin'; é o que o middleware exigirAdmin verifica.)
    const admins = await client.query(
      `SELECT id, lower(email) AS email FROM usuarios
       WHERE ${ONDE_DELETAR} AND role = 'admin' ORDER BY email`, PARAMS)
    if (admins.rows.length > 0) {
      console.error(`\n  ✗ ABORTANDO — ${admins.rows.length} conta(s) ADMIN estão no conjunto a DELETAR:`)
      admins.rows.forEach(r => console.error(`      - ${r.email}  (${r.id})`))
      console.error('    Um admin NUNCA pode ser apagado. Adicione o e-mail à lista PRESERVAR')
      console.error('    e rode o preview de novo. NADA foi alterado.')
      process.exitCode = 1
      return
    }
    console.log(`\n  ✓ rede de segurança: nenhum admin (role='admin') no conjunto a deletar.`)

    // 4) Cross-check: toda FK que referencia `usuarios`. Alerta se houver alguma
    //    sem ON DELETE CASCADE que este script não trata (evita surpresa/órfão).
    const fks = await client.query(`
      SELECT tc.table_name, kcu.column_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu       ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc  ON rc.constraint_name  = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'usuarios'
      ORDER BY rc.delete_rule, tc.table_name`)
    console.log('\n  FKs que referenciam usuarios:')
    const naoTratadas = []
    for (const r of fks.rows) {
      const cascade = r.delete_rule === 'CASCADE'
      const tratada = TABELAS_TRATADAS.has(r.table_name)
      const marca = tratada ? '✓ tratada' : cascade ? '✓ cascata' : '✗ NÃO TRATADA'
      console.log(`      ${r.table_name}.${r.column_name}  [${r.delete_rule}]  ${marca}`)
      if (!tratada && !cascade) naoTratadas.push(`${r.table_name}.${r.column_name}`)
    }
    if (naoTratadas.length > 0) {
      console.log(`\n  ⚠ FK(s) sem CASCADE não tratadas: ${naoTratadas.join(', ')}`)
      console.log('    O DELETE de usuarios falharia por FK e faria ROLLBACK (seguro), mas')
      console.log('    me avise para eu incluir essas tabelas ANTES de rodar com --confirm.')
    }

    // Sem --confirm: para por aqui.
    if (!CONFIRM) {
      console.log('\n──────────────────────────────────────────────────────────')
      console.log(' PREVIEW apenas — NADA foi alterado.')
      console.log(' Se os números acima estão corretos, rode de novo com --confirm')
      console.log('──────────────────────────────────────────────────────────')
      return
    }

    // ══ EXECUÇÃO (--confirm) ═════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════════════════')
    console.log(' EXECUTANDO EXCLUSÃO (transação única)')
    console.log('══════════════════════════════════════════════════════════')

    const contagens = {}
    const del = async (rotulo, sql) => {          // executa e imprime a contagem
      const r = await client.query(sql)
      contagens[rotulo] = r.rowCount
      console.log(`  ${rotulo}: ${r.rowCount}`)
    }

    await client.query('BEGIN')
    try {
      // Conjunto CONGELADO de ids a deletar (mesmo predicado do preview).
      await client.query(
        `CREATE TEMP TABLE _del ON COMMIT DROP AS SELECT id FROM usuarios WHERE ${ONDE_DELETAR}`,
        PARAMS)

      // 1) Itens CRIADOS pelos usuários a deletar + filhos (filhos primeiro).
      await del('mensagens (de obras deletadas)',   `DELETE FROM mensagens WHERE obra_id IN (SELECT id FROM obras WHERE criado_por IN (SELECT id FROM _del))`)
      await del('candidaturas (de obras deletadas)', `DELETE FROM candidaturas WHERE obra_id IN (SELECT id FROM obras WHERE criado_por IN (SELECT id FROM _del))`)
      await del('midias (de obras deletadas)',       `DELETE FROM midias WHERE obra_id IN (SELECT id FROM obras WHERE criado_por IN (SELECT id FROM _del))`)
      await del('obras',                             `DELETE FROM obras WHERE criado_por IN (SELECT id FROM _del)`)
      await del('interesse_reparos (de reparos deletados)', `DELETE FROM interesse_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por IN (SELECT id FROM _del))`)
      await del('midias_reparos (de reparos deletados)',    `DELETE FROM midias_reparos WHERE reparo_id IN (SELECT id FROM reparos WHERE criado_por IN (SELECT id FROM _del))`)
      await del('reparos',                           `DELETE FROM reparos WHERE criado_por IN (SELECT id FROM _del)`)

      // 2) Des-matchear itens SOBREVIVENTES (dos preservados) que apontam p/ deletados.
      await del('obras.match_usuario_id → NULL',   `UPDATE obras   SET match_usuario_id=NULL, match_feito_em=NULL WHERE match_usuario_id IN (SELECT id FROM _del)`)
      await del('reparos.match_usuario_id → NULL', `UPDATE reparos SET match_usuario_id=NULL, match_feito_em=NULL WHERE match_usuario_id IN (SELECT id FROM _del)`)

      // 3) Participação própria dos usuários a deletar (filhos primeiro).
      await del('candidaturas (próprias)',        `DELETE FROM candidaturas WHERE usuario_id IN (SELECT id FROM _del)`)
      await del('mensagens (autor)',              `DELETE FROM mensagens WHERE autor_id IN (SELECT id FROM _del)`)
      await del('interesse_reparos (próprios)',   `DELETE FROM interesse_reparos WHERE usuario_id IN (SELECT id FROM _del)`)
      await del('assinaturas',                    `DELETE FROM assinaturas WHERE usuario_id IN (SELECT id FROM _del)`)
      await del('localizacoes_prestadores',       `DELETE FROM localizacoes_prestadores WHERE usuario_id IN (SELECT id FROM _del)`)
      await del('prestadores_bloqueados_dono',    `DELETE FROM prestadores_bloqueados_dono WHERE dono_id IN (SELECT id FROM _del) OR prestador_id IN (SELECT id FROM _del)`)

      // 4) avaliacoes + feed_visualizacoes: deletadas explicitamente p/ contagem
      //    (também cairiam por ON DELETE CASCADE ao remover usuarios).
      await del('avaliacoes',                     `DELETE FROM avaliacoes WHERE avaliador_id IN (SELECT id FROM _del) OR avaliado_id IN (SELECT id FROM _del)`)
      await del('feed_visualizacoes',             `DELETE FROM feed_visualizacoes WHERE usuario_id IN (SELECT id FROM _del)`)

      // 5) Os próprios usuários.
      await del('usuarios',                       `DELETE FROM usuarios WHERE id IN (SELECT id FROM _del)`)

      await client.query('COMMIT')
      console.log('\n  ✓ COMMIT — transação concluída SEM erros.')
    } catch (err) {
      await client.query('ROLLBACK')
      console.error('\n  ✗ ERRO durante a exclusão → ROLLBACK. NADA foi apagado.')
      console.error('   ', err.message)
      process.exitCode = 1
      return
    }

    // ══ VERIFICAÇÃO FINAL (somente leitura) ══════════════════════════════════
    console.log('\n══════════════════════════════════════════════════════════')
    console.log(' VERIFICAÇÃO FINAL (somente leitura)')
    console.log('══════════════════════════════════════════════════════════')
    const restam = await client.query(`SELECT lower(email) AS email, role FROM usuarios ORDER BY email`)
    console.log(`  usuarios restantes: ${restam.rows.length}`)
    restam.rows.forEach(r => console.log(`      - ${r.email}  (role=${r.role})`))

    const restantes = restam.rows.map(r => r.email).sort()
    const esperado = [...PRESERVAR].map(e => e.toLowerCase()).sort()
    const ok = restantes.length === esperado.length && esperado.every((e, i) => e === restantes[i])
    console.log(ok
      ? `\n  ✓ CONFIRMADO: restam APENAS as ${esperado.length} contas preservadas.`
      : `\n  ✗ ATENÇÃO: o conjunto restante NÃO é exatamente as ${esperado.length} contas preservadas — revise acima.`)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(async (err) => {
  console.error('Erro fatal:', err.message)
  process.exitCode = 1
  try { await pool.end() } catch {}
})
