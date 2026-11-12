#!/usr/bin/env node
// SÓ LEITURA (transação READ ONLY): acha o serviço (reparo) mais recente de uma categoria, de um dono
// buscado pelo nome (todas as contas da pessoa, mesmo CPF), e despeja tudo o que diz quem/quando o
// tirou de aberto/agendado: a linha inteira do reparo, os interesses (status, status_antes_match,
// cancelado_*), desistencias, eventos_responsabilidade, push_recibos, lembretes_push_enviados,
// email_alertas e contas_excluidas dos interessados. Não escreve nada.
//   DATABASE_URL lido de um arquivo .env (nunca impresso):
//   node scripts/diagnostico-servico-dono.js <arquivo .env> "<nome do dono>" <categoria> [AAAA-MM-DD]
const fs = require('fs')
const { Pool } = require('pg')

const [, , arqEnv, nome, categoria, dia = new Date().toISOString().slice(0, 10)] = process.argv
if (!arqEnv || !nome || !categoria) { console.error('uso: <arquivo .env> "<nome do dono>" <categoria> [AAAA-MM-DD]'); process.exit(2) }
const url = (fs.readFileSync(arqEnv, 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m) || [])[1]
if (!url) { console.error('DATABASE_URL ausente no arquivo'); process.exit(2) }

const CPF = (a) => `NULLIF(regexp_replace(COALESCE(${a}.cpf_cnpj, ''), '[^0-9]', '', 'g'), '')`
const mostrar = (rotulo, rows) => { console.log(`\n== ${rotulo} (${rows.length})`); for (const r of rows) console.log(JSON.stringify(r)) }

const main = async () => {
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 })
  const c = await pool.connect()
  try {
    await c.query('BEGIN TRANSACTION READ ONLY')
    const donos = (await c.query(
      `SELECT u.id, u.nome, u.role, u.tipo_dono FROM usuarios u
        WHERE u.id IN (SELECT x.id FROM usuarios x, usuarios n
                        WHERE n.nome ILIKE '%' || $1 || '%' AND n.role IN ('dono_obra', 'admin')
                          AND (x.id = n.id OR (${CPF('x')} IS NOT NULL AND ${CPF('x')} = ${CPF('n')})))`, [nome])).rows
    mostrar('contas do dono', donos)
    if (!donos.length) return
    const ids = donos.map(d => d.id)
    const reparos = (await c.query(
      `SELECT to_jsonb(r) - 'descricao' AS r FROM reparos r
        WHERE r.criado_por = ANY($1::uuid[]) AND (r.categoria = $2 OR $2 = ANY(COALESCE(r.categorias, '{}')))
        ORDER BY r.criado_em DESC LIMIT 10`, [ids, categoria])).rows.map(x => x.r)
    mostrar(`reparos de ${categoria} (10 mais novos)`, reparos)
    // Candidato: o mais recente que NÃO está aberto+casado/aberto agora, com algum carimbo do dia; senão o mais novo.
    const doDia = (r) => Object.entries(r).some(([k, v]) => /_em$/.test(k) && typeof v === 'string' && v.startsWith(dia))
    const alvo = reparos.find(r => doDia(r) && !(r.status === 'aberta' && r.match_usuario_id)) || reparos[0]
    if (!alvo) return
    console.log(`\n>>> ALVO: ${alvo.id} código ${alvo.codigo_publico} status ${alvo.status}/${alvo.status_aprovacao} match ${alvo.match_usuario_id}`)
    const q = async (rotulo, sql) => mostrar(rotulo, (await c.query(sql, [alvo.id])).rows)
    await q('interesses', `SELECT ir.*, u.nome, u.suspenso_em, u.desinstalado_em, u.push_token IS NOT NULL AS tem_token
                             FROM interesse_reparos ir LEFT JOIN usuarios u ON u.id = ir.usuario_id WHERE ir.reparo_id = $1 ORDER BY ir.criado_em`)
    await q('desistencias', `SELECT * FROM desistencias WHERE tabela = 'reparos' AND demanda_id = $1 ORDER BY criado_em`)
    await q('eventos_responsabilidade', `SELECT * FROM eventos_responsabilidade WHERE tabela = 'reparos' AND demanda_id = $1 ORDER BY criado_em`)
    await q('push_recibos', `SELECT pr.usuario_id, u.nome, pr.tipo, pr.enviado_em, pr.status_ticket, pr.status_recibo FROM push_recibos pr LEFT JOIN usuarios u ON u.id = pr.usuario_id WHERE pr.demanda_id = $1 ORDER BY pr.enviado_em`)
    await q('lembretes_push_enviados', `SELECT * FROM lembretes_push_enviados WHERE demanda_id = $1 ORDER BY enviado_em`)
    await q('email_alertas', `SELECT * FROM email_alertas WHERE demanda_id = $1 ORDER BY created_at`)
    await q('contas_excluidas (interessados)', `SELECT * FROM contas_excluidas WHERE id IN (SELECT usuario_id FROM interesse_reparos WHERE reparo_id = $1)`)
    await q('contratos', `SELECT * FROM contratos WHERE interesse_id IN (SELECT id FROM interesse_reparos WHERE reparo_id = $1)`)
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    c.release()
    await pool.end()
  }
}
main().catch(e => { console.error('ERRO', e.code || '', e.message); process.exit(1) })
