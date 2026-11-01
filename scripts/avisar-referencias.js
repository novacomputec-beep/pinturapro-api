#!/usr/bin/env node
// Aviso ÚNICO "Corrija suas referências" aos profissionais cujas referências gravadas têm
// problema pelas regras atuais (utils/referencias.problemaReferencias — a mesma de
// GET /auth/referencias): 'propria' (nome igual ao do usuário) ou 'repetido' (telefone repetido
// entre elas ou igual ao do próprio). Linhas antigas, gravadas antes de uma regra existir.
//
//   node scripts/avisar-referencias.js            → DRY-RUN (padrão): só lista nome, problema e
//                                                    se tem push token. Não grava, não envia.
//   node scripts/avisar-referencias.js --enviar   → envia de verdade (push + e-mail via
//                                                    entregarPushEEmail), com claim em email_alertas.
//
// Precisa de DATABASE_URL (e, para --enviar, BREVO_API_KEY/EXPO) no ambiente ou num .env no cwd.
//
// Elegíveis: role = 'prestador', ativo, não suspenso (suspenso_em IS NULL), não desinstalado
// (desinstalado_em IS NULL), com referências gravadas e problema ≠ null.
//
// Dedupe — NUNCA avisar duas vezes: claim em email_alertas ANTES do envio, pela chave
// "aviso:referencias_corrigir + usuario_id". O CHECK de email_alertas.tipo só aceita
// 'aviso:<evento>#<8 hex | número>' (sem UUID no tipo), então a chave é materializada como
//   tipo = 'aviso:referencias_corrigir#1', demanda_id = <usuario_id>, usuario_id = <usuario_id>
// (UNIQUE (tipo, demanda_id, usuario_id) → uma linha por usuário). O claim cobre push E e-mail:
// entregarPushEEmail não faz claim próprio aqui porque `data` não traz obra_id/reparo_id.
// Se o envio devolve 'falha' ou 'sem contato', o claim é desfeito para uma rodada futura tentar.
//
// Toque no push: data = { tipo: 'referencias_corrigir' } — o app deve abrir
// Perfil → MinhasReferencias (AppNavigator, switch de tipos).
require('dotenv').config()
const { pool } = require('../src/utils/supabase')
const { lerReferencias, problemaReferencias } = require('../src/utils/referencias')
const { entregarPushEEmail } = require('../src/services/alertaService')

const TIPO_PUSH = 'referencias_corrigir'
const TIPO_CLAIM = `aviso:${TIPO_PUSH}#1`
const TITULO = 'Corrija suas referências'
const CORPO = 'Uma das suas referências está com problema. Toque aqui para corrigir. Leva menos de 1 minuto.'
const CORPO_EMAIL = `${CORPO}\n\nNo app: Perfil → Minhas referências.`

const ROTULOS = { propria: 'própria (nome igual ao seu)', repetido: 'telefone repetido / próprio' }

const listarElegiveis = async () => {
  const r = await pool.query(`
    SELECT u.id, u.nome, u.email, u.telefone, u.push_token, u.referencias,
           EXISTS (SELECT 1 FROM email_alertas ea
                    WHERE ea.tipo = $1 AND ea.demanda_id = u.id AND ea.usuario_id = u.id) AS ja_avisado
      FROM usuarios u
     WHERE u.role = 'prestador'
       AND u.ativo = true
       AND u.suspenso_em IS NULL
       AND u.desinstalado_em IS NULL
       AND NULLIF(btrim(u.referencias), '') IS NOT NULL
     ORDER BY u.criado_em ASC`, [TIPO_CLAIM])
  return r.rows
    .map(u => ({ ...u, problema: problemaReferencias(lerReferencias(u.referencias), u) }))
    .filter(u => u.problema)
}

const reivindicar = async (usuarioId) => {
  const r = await pool.query(
    `INSERT INTO email_alertas (tipo, demanda_id, usuario_id) VALUES ($1, $2, $2)
     ON CONFLICT (tipo, demanda_id, usuario_id) DO NOTHING RETURNING usuario_id`,
    [TIPO_CLAIM, usuarioId]
  )
  return r.rowCount > 0
}
const desfazerClaim = (usuarioId) =>
  pool.query(`DELETE FROM email_alertas WHERE tipo = $1 AND demanda_id = $2 AND usuario_id = $2`, [TIPO_CLAIM, usuarioId])

const main = async () => {
  const enviar = process.argv.includes('--enviar')
  const elegiveis = await listarElegiveis()
  console.log(`${enviar ? 'ENVIO' : 'DRY-RUN'} — ${elegiveis.length} profissional(is) com referência com problema\n`)
  const contagem = { enviados: 0, pulados: 0, falhas: 0 }
  for (const u of elegiveis) {
    const linha = `${u.nome} <${u.email || 'sem e-mail'}> | ${ROTULOS[u.problema] || u.problema} | push token: ${u.push_token ? 'sim' : 'não'}${u.ja_avisado ? ' | JÁ AVISADO' : ''}`
    if (!enviar) { console.log('  ' + linha); continue }
    if (u.ja_avisado || !(await reivindicar(u.id))) { contagem.pulados++; console.log('  pulado (já avisado): ' + linha); continue }
    const via = await entregarPushEEmail({
      usuario_id: u.id, push_token: u.push_token, email: u.email, nome: u.nome,
      titulo: TITULO, corpo: CORPO, corpoEmail: CORPO_EMAIL,
      data: { tipo: TIPO_PUSH },
      rotulo: `referencias corrigir ${u.id}`,
    })
    if (via === 'falha' || via === 'sem contato') {
      contagem.falhas++
      await desfazerClaim(u.id)
      console.log(`  FALHA (${via}, claim desfeito): ` + linha)
    } else {
      contagem.enviados++
      console.log(`  enviado via ${via}: ` + linha)
    }
  }
  if (enviar) console.log(`\n${contagem.enviados} enviado(s), ${contagem.pulados} pulado(s), ${contagem.falhas} falha(s)`)
  else console.log(`\nNada enviado. Para enviar: node scripts/avisar-referencias.js --enviar`)
}

main()
  .catch(err => { console.error('[avisar-referencias] erro:', err.message); process.exitCode = 1 })
  .finally(() => pool.end())
