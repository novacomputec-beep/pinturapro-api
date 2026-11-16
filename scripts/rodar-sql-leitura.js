#!/usr/bin/env node
// Roda um arquivo .sql de auditoria (scripts/sql/*.sql) em SOMENTE LEITURA e imprime o resultado
// de cada consulta. DATABASE_URL vem do ambiente (scripts/db-leitura.js; túnel em scripts/db-tunnel.md).
//   node scripts/rodar-sql-leitura.js scripts/sql/<arquivo>.sql [--json]
// Cada consulta roda em BEGIN TRANSACTION READ ONLY … ROLLBACK; arquivo que não for só
// SELECT/WITH é recusado antes de conectar. Consultas são separadas por ';' no fim da linha.
const fs = require('fs')
const { criarPoolLeitura } = require('./db-leitura')

const [, , arquivo, ...resto] = process.argv
const json = resto.includes('--json')
if (!arquivo) { console.error('uso: node scripts/rodar-sql-leitura.js <arquivo.sql> [--json]'); process.exit(2) }

const semComentarios = (s) => s.split('\n').filter(l => !/^\s*--/.test(l)).join('\n').trim()
const consultas = fs.readFileSync(arquivo, 'utf8').split(/;[ \t]*\r?\n/).map(semComentarios).filter(Boolean).map(s => s.replace(/;\s*$/, ''))
const proibida = consultas.find(q => !/^(SELECT|WITH)\b/i.test(q) || /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|COPY)\b/i.test(q.replace(/'(?:[^']|'')*'/g, "''")))
if (proibida) { console.error('RECUSADO: o arquivo tem consulta que não é só leitura:\n' + proibida.slice(0, 200)); process.exit(2) }

const main = async () => {
  const pool = criarPoolLeitura()
  const c = await pool.connect()
  try {
    for (const [i, q] of consultas.entries()) {
      await c.query('BEGIN TRANSACTION READ ONLY')
      try {
        const r = await c.query(q)
        console.log(`\n== consulta ${i + 1}/${consultas.length} (${r.rows.length} linha(s))`)
        for (const row of r.rows) {
          const chaves = Object.keys(row)
          console.log(json ? JSON.stringify(row) : chaves.length === 1 ? String(row[chaves[0]]) : chaves.map(k => `${k}: ${row[k]}`).join(' | '))
        }
      } finally {
        await c.query('ROLLBACK').catch(() => {})
      }
    }
  } finally {
    c.release()
    await pool.end()
  }
}
main().catch(e => { console.error('ERRO', e.code || '', e.message); process.exit(1) })
