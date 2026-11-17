#!/usr/bin/env node
// WORKER do robô de WhatsApp — serviço SEPARADO na Railway (start: node src/whatsapp/worker.js).
// A API só insere em whatsapp_mensagens; este processo mantém a conexão, envia a fila (uma
// mensagem a cada 20–40 s, 08–21h de São Paulo), grava recibos e guarda o que chega.
// Segurança: sem WHATSAPP_SOMENTE_PARA nada é enviado (config.lerTrava). UMA réplica só — um
// pg_advisory_lock de sessão impede duas instâncias de abrirem a mesma sessão do WhatsApp.
// Dependências fora de src/whatsapp: utils/supabase (e o auditoriaDemanda que ele carrega) —
// ver config.WATCH_PATHS.
require('dotenv').config()
const { pool } = require('../utils/supabase')
const { migrarWhatsapp } = require('./migracao')
const { validarAdaptador } = require('./adaptador')
const { criarAdaptadorBaileys } = require('./adaptadorBaileys')
const { processarProxima, recuperarInterrompidas, aplicarStatus } = require('./fila')
const { registrarRecebida } = require('./entrada')
const { lerTrava, intervaloMs, ESPERA_FILA_VAZIA_MS, CHAVE_LOCK } = require('./config')

let parando = false
let acordar = null
const dormir = (ms) => new Promise(resolve => {
  const t = setTimeout(() => { acordar = null; resolve() }, ms)
  acordar = () => { clearTimeout(t); acordar = null; resolve() }
})

// O worker escreve o que a aba do painel lê (GET /admin/whatsapp/status).
const SQL_GRAVAR_ESTADO =
  `UPDATE whatsapp_estado
      SET conexao = $1, qr = $2,
          -- conectado_em: início da conexão ATUAL (as colunas à direita leem a linha antiga).
          conectado_em = CASE WHEN $1::text <> 'conectado' THEN NULL
                              WHEN conexao = 'conectado' THEN COALESCE(conectado_em, NOW())
                              ELSE NOW() END,
          qr_em = CASE WHEN $2::text IS NULL THEN NULL WHEN qr IS DISTINCT FROM $2::text THEN NOW() ELSE qr_em END,
          numero = $3, trava = $4, heartbeat_em = NOW(), atualizado_em = NOW()
    WHERE id = 1`
const gravarEstado = (estado, trava) => pool.query(SQL_GRAVAR_ESTADO,
  [estado.conexao, estado.qr || null, estado.numero || null, trava.modo === 'ausente' ? null : trava.texto])
  .catch(err => console.error('[whatsapp] falha ao gravar estado:', err.message))

const migrar = async () => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL statement_timeout = 0')
    await migrarWhatsapp(client)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const iniciar = async () => {
  const trava = lerTrava()
  console.log(trava.modo === 'ausente'
    ? '[whatsapp] WHATSAPP_SOMENTE_PARA ausente ou inválida — NADA será enviado (defina um número ou TODOS)'
    : `[whatsapp] trava de envio: ${trava.texto}`)
  await migrar()

  // Lock de SESSÃO numa conexão dedicada, segurada enquanto o processo viver.
  const clienteLock = await pool.connect()
  clienteLock.on('error', (err) => { console.error('[whatsapp] conexão do lock caiu:', err.message); process.exit(1) })
  for (;;) {
    const r = await clienteLock.query(`SELECT pg_try_advisory_lock(${CHAVE_LOCK}) AS ok`)
    if (r.rows[0].ok) break
    console.log('[whatsapp] outro worker está ativo — aguardando 10 s (deixe UMA réplica só)')
    await dormir(10000)
    if (parando) return
  }

  const perdidas = await recuperarInterrompidas(pool)
  if (perdidas) console.log(`[whatsapp] ${perdidas} mensagem(ns) interrompida(s) no envio anterior marcada(s) como falha`)

  const adaptador = validarAdaptador(criarAdaptadorBaileys({ db: pool }))
  adaptador.aoMudarEstado((estado) => { console.log(`[whatsapp] conexão: ${estado.conexao}`); return gravarEstado(estado, trava) })
  adaptador.aoReceber((msg) => registrarRecebida(pool, msg).then(r => { if (r.saiu) console.log(`[whatsapp] pedido de saída (SAIR): ${r.usuarios.length} conta(s)`) }))
  adaptador.aoAtualizarStatus((s) => aplicarStatus(pool, s))
  await gravarEstado(adaptador.estado(), trava)
  await adaptador.conectar()
  const batimento = setInterval(() => gravarEstado(adaptador.estado(), trava), 30000)

  const encerrar = async (sinal) => {
    if (parando) return
    parando = true
    console.log(`[whatsapp] ${sinal} — encerrando (a sessão continua válida)`)
    clearInterval(batimento)
    if (acordar) acordar()
    await adaptador.desconectar({ apagarSessao: false }).catch(() => {})
    await gravarEstado({ conexao: 'desligado', qr: null, numero: adaptador.estado().numero }, trava)
    await clienteLock.query(`SELECT pg_advisory_unlock(${CHAVE_LOCK})`).catch(() => {})
    clienteLock.release()
    await pool.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', () => encerrar('SIGTERM'))
  process.on('SIGINT', () => encerrar('SIGINT'))

  let ultimoMotivo = null
  while (!parando) {
    let espera = ESPERA_FILA_VAZIA_MS
    try {
      // Pedido do painel (POST /admin/whatsapp/desconectar): encerra a sessão e pede novo QR.
      const cmd = await pool.query(`SELECT comando FROM whatsapp_estado WHERE id = 1`)
      const comando = cmd.rows[0]?.comando || null
      if (comando) await pool.query(`UPDATE whatsapp_estado SET comando = NULL WHERE id = 1`)
      if (comando === 'desconectar') {
        console.log('[whatsapp] painel pediu para desconectar — sessão apagada, novo QR a seguir')
        await adaptador.desconectar({ apagarSessao: true })
        await adaptador.conectar()
      }
      const r = await processarProxima({ db: pool, adaptador })
      if (r.motivo !== ultimoMotivo && r.motivo !== 'enviada') console.log(`[whatsapp] fila: ${r.motivo}`)
      ultimoMotivo = r.motivo
      if (r.enviou) {
        console.log(`[whatsapp] enviada (${r.ids.length} item(ns)) id=${r.waMessageId}`)
        await pool.query(`UPDATE whatsapp_estado SET ultimo_envio_em = NOW(), ultimo_erro = NULL WHERE id = 1`)
      } else if (r.motivo === 'erro_no_envio') {
        await pool.query(`UPDATE whatsapp_estado SET ultimo_erro = $1 WHERE id = 1`, [String(r.erro).slice(0, 300)])
      }
      if (r.falouComWhatsapp) espera = intervaloMs()
    } catch (err) {
      console.error('[whatsapp] erro no laço da fila:', err.message)
      espera = 10000
    }
    await dormir(espera)
  }
}

if (require.main === module) {
  if (!process.env.DATABASE_URL) { console.error('[whatsapp] DATABASE_URL ausente'); process.exit(1) }
  process.on('unhandledRejection', (err) => console.error('[whatsapp] rejeição não tratada:', err?.message || err))
  iniciar().catch(err => { console.error('[whatsapp] falha ao iniciar:', err); process.exit(1) })
}

module.exports = { iniciar, SQL_GRAVAR_ESTADO }
