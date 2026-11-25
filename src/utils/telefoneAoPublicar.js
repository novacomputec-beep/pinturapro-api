// Telefone do DONO informado AO PUBLICAR um pedido (dono, 25/11/2026). POST /reparos/dono e
// POST /obras/dono aceitam `telefone` (opcional): quando a conta NÃO tem telefone, ele é validado
// como celular brasileiro (DDD + 9 dígitos começando em 9 = 11 dígitos; aceita máscara, +55 e 0 de
// tronco) e gravado na conta — é por ele que o robô de WhatsApp alcança o dono (pergunta sem
// resposta, novo interessado…). Conta que JÁ tem telefone: o campo é ignorado, nunca sobrescreve.
// Inválido → 400 TELEFONE_INVALIDO, nada gravado (nem o pedido).
const { pool } = require('./supabase')
const { normalizarTelefoneWhatsapp } = require('./telefoneWhatsapp')

const ERRO_TELEFONE_INVALIDO = Object.freeze({
  erro: 'Telefone inválido. Informe um celular com DDD (11 dígitos), por exemplo (34) 99999-0000.',
  codigo: 'TELEFONE_INVALIDO',
})

// "Tem telefone" = ao menos um dígito gravado (a MESMA noção em JS e em SQL).
const temTelefone = (telefone) => /\d/.test(String(telefone ?? ''))
const sqlSemTelefone = (coluna = 'telefone') => `(NULLIF(regexp_replace(COALESCE(${coluna}, ''), '[^0-9]', '', 'g'), '') IS NULL)`

// Celular brasileiro → os 11 dígitos nacionais (DDD + número), ou null.
const celularValido = (bruto) => {
  if (typeof bruto !== 'string' && typeof bruto !== 'number') return null
  const n = normalizarTelefoneWhatsapp(bruto)
  return n.status_numero === 'ok' ? n.telefone_wa.slice(2) : null
}

// ANTES de gravar o pedido. Devolve { erro } (responder 400 com ele), { gravar: '34999990000' }
// (chamar gravarTelefoneDoDono depois que o pedido entrar) ou {} (nada a fazer: campo ausente/
// vazio, ou a conta já tem telefone).
const avaliarTelefoneAoPublicar = async (usuarioId, bruto, db = pool) => {
  if (bruto === undefined || bruto === null || (typeof bruto === 'string' && !bruto.trim())) return {}
  const r = await db.query(`SELECT telefone FROM usuarios WHERE id = $1`, [usuarioId])
  if (temTelefone(r.rows[0]?.telefone)) return {}
  const celular = celularValido(bruto)
  return celular ? { gravar: celular } : { erro: ERRO_TELEFONE_INVALIDO }
}

// DEPOIS de o pedido entrar. A condição no UPDATE garante que um telefone gravado nesse meio
// tempo não é sobrescrito. Nunca lança (o pedido já foi criado). Devolve true se gravou.
const gravarTelefoneDoDono = async (usuarioId, celular, db = pool) => {
  if (!celular) return false
  try {
    const r = await db.query(
      `UPDATE usuarios SET telefone = $2 WHERE id = $1 AND ${sqlSemTelefone('telefone')} RETURNING id`, [usuarioId, celular])
    return r.rows.length > 0
  } catch (err) {
    console.error('[telefone ao publicar]', err.message)
    return false
  }
}

module.exports = { ERRO_TELEFONE_INVALIDO, temTelefone, sqlSemTelefone, celularValido, avaliarTelefoneAoPublicar, gravarTelefoneDoDono }
