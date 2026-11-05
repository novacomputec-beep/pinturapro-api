#!/usr/bin/env node
// Testa "desfazer escolha" (services/desfazerEscolhaService): POST /:tabela/dono/:id/desfazer-match
// e a expressão desfazer_liberado_em de GET /:id, com o SQL REAL num Postgres em memória (PGlite).
// pool trocado por um shim; alertaService trocado por um fake que só coleta avisos/reanúncios;
// NOW() sombreado por public.now() para andar o relógio.
// Espera = 10% de (prazo − match), mínimo 1h, máximo 48h; prazo = COALESCE(chegada_prevista_em, expira_em).
//   npm i -D @electric-sql/pglite && node scripts/testar-desfazer-escolha.js
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

const avisos = []
const reanuncios = []
let db
const shim = {
  query: (sql, params) => db.query(sql, params),
  connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }),
  on() {},
}
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/(^|[\\/])alertaService$/.test(request)) { // './alertaService' (services) e '../services/alertaService'
    return {
      entregarPushEEmail: async (a) => { avisos.push(a); return 'push+e-mail' },
      entregarPushOuEmail: async (a) => { avisos.push(a); return 'push' },
      registrarFaltaUsuario: async () => {},
      reanunciarDemanda: async (tabela, id) => { reanuncios.push(`${tabela}:${id}`) },
    }
  }
  return origLoad.apply(this, arguments)
}

const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const T0 = Date.parse('2026-11-05T13:00:00Z') // match de todas as demandas
const emMin = (min) => new Date(T0 + min * 60000).toISOString()
const fixarAgora = (min) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${emMin(min)}'::timestamptz $$`)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const chamar = (handler, usuario, params) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, body: {}, usuario }, res)
})

const main = async () => {
  db = new PGlite()
  // Colunas de SQL_LIMPAR_MATCH + SQL_ZERAR_AGENDA + as lidas pelo serviço.
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, criado_por uuid, status text DEFAULT 'aberta', status_aprovacao text, encerrado_em timestamptz,
      match_usuario_id uuid, match_feito_em timestamptz, expira_em timestamptz, criado_em timestamptz DEFAULT now(),
      chegada_prevista_em timestamptz, chegada_pendente_em timestamptz, chegada_pendente_janela text, chegada_janela text,
      chegada_declarada_por uuid, chegada_declarada_em timestamptz, chegada_recusada_em timestamptz, chegada_confirmada_em timestamptz,
      a_caminho_em timestamptz, pedido_tempo_status text, pedido_tempo_motivo text, pedido_tempo_minutos int,
      aviso_match_enviado_em timestamptz, lembrete_chegada_enviado_em timestamptz,
      chegada_proposta_por uuid, chegada_pendente_rodada int DEFAULT 0, lembrete_agenda_vespera_em timestamptz, lembrete_agenda_2h_em timestamptz,
      lembrete_agenda_hora_em timestamptz, vigia_comparecimento_em timestamptz, comparecimento_resposta text, comparecimento_respondido_em timestamptz,
      lembrete_agendar_offsets int[] DEFAULT '{}', lembrete_agendar_ultimo_em timestamptz, lembrete_agendar_dono_em timestamptz,
      chegada_proposta_em timestamptz, lembrete_resposta_1h_em timestamptz, lembrete_resposta_antes_em timestamptz, lembrete_resposta_ultimo_em timestamptz,
      sugestoes_horario_dono int DEFAULT 0, sugestoes_horario_profissional int DEFAULT 0, prazo_chegada_extra_em timestamptz, aviso_atraso_enviado_em timestamptz,
      pedido_atraso_minutos int, pedido_atraso_motivo text, pedido_atraso_em timestamptz, pedido_atraso_status text, pedido_atraso_respondido_em timestamptz,
      pedidos_atraso_usados int DEFAULT 0, cancelamento_pedido_por uuid, cancelamento_pedido_motivo text, cancelamento_pedido_detalhe text,
      cancelamento_pedido_em timestamptz, cancelamento_pedido_expira_em timestamptz, prestadores_bloqueados uuid[]`
  const colsProposta = (fk) => `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${fk} uuid, usuario_id uuid, status text, cancelado_por uuid, cancelado_motivo text,
      cancelado_detalhe text, cancelado_em timestamptz, cancelado_acordo boolean DEFAULT false`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, push_token text);
    CREATE TABLE reparos (${colsDemanda});
    CREATE TABLE obras (${colsDemanda});
    CREATE TABLE interesse_reparos (${colsProposta('reparo_id')});
    CREATE TABLE candidaturas (${colsProposta('obra_id')});
    SET search_path = public, pg_catalog;
  `)
  await db.query(`INSERT INTO usuarios VALUES ($1, 'Dono', 'dono@x.invalid', NULL), ($2, 'Prof', 'prof@x.invalid', 'ExponentPushToken[prof]'), ($3, 'Outro', 'outro@x.invalid', NULL)`, [U(99), U(1), U(2)])
  await fixarAgora(0)
  // Demandas casadas em T0 com prazo contado de T0: 10 dias (espera 24h), 2h (10% = 12 min → piso 1h),
  // 30 dias (72h → teto 48h), 40h (espera 4h).
  const cenarios = [
    { n: 1, tabela: 'reparos', proposta: 'interesse_reparos', fk: 'reparo_id', rotulo: '10 dias', prazoMin: 10 * 1440, esperaMin: 24 * 60 },
    { n: 2, tabela: 'obras',   proposta: 'candidaturas',      fk: 'obra_id',   rotulo: '2 horas', prazoMin: 120,       esperaMin: 60 },
    { n: 3, tabela: 'obras',   proposta: 'candidaturas',      fk: 'obra_id',   rotulo: '30 dias', prazoMin: 30 * 1440, esperaMin: 48 * 60 },
    { n: 4, tabela: 'reparos', proposta: 'interesse_reparos', fk: 'reparo_id', rotulo: '40 horas', prazoMin: 40 * 60,  esperaMin: 4 * 60 },
  ]
  for (const c of cenarios) {
    await db.query(`INSERT INTO ${c.tabela} (id, titulo, criado_por, match_usuario_id, match_feito_em, expira_em) VALUES ($1, $2, $3, $4, now(), now() + ($5 * INTERVAL '1 minute'))`,
      [D(c.n), `Demanda ${c.rotulo}`, U(99), U(1), c.prazoMin])
    await db.query(`INSERT INTO ${c.proposta} (${c.fk}, usuario_id, status) VALUES ($1, $2, 'aceito'), ($1, $3, 'recusado')`, [D(c.n), U(1), U(2)])
  }
  const S = require(path.join(REPO, 'src/services/desfazerEscolhaService'))
  const { SQL_LIMPAR_MATCH } = require(path.join(REPO, 'src/services/cancelamentoMatchService'))
  void SQL_LIMPAR_MATCH
  const h = { reparos: S.handler('reparos'), obras: S.handler('obras') }
  const desfazer = (c, usuario = { id: U(99) }) => chamar(h[c.tabela], usuario, { id: D(c.n) })
  const liberadoEm = async (c) => (await db.query(`SELECT ${S.sqlDesfazerLiberadoEm()} AS l FROM ${c.tabela} WHERE id = $1`, [D(c.n)])).rows[0].l
  const linha = async (c) => (await db.query(`SELECT * FROM ${c.tabela} WHERE id = $1`, [D(c.n)])).rows[0]
  const proposta = async (c) => (await db.query(`SELECT * FROM ${c.proposta} WHERE ${c.fk} = $1 AND usuario_id = $2`, [D(c.n), U(1)])).rows[0]
  const [c10d, c2h, c30d, c40h] = cenarios

  // 1) desfazer_liberado_em = match + espera (10%, piso 1h, teto 48h)
  for (const c of cenarios) {
    const l = await liberadoEm(c)
    ok(l && new Date(l).toISOString() === emMin(c.esperaMin), `desfazer_liberado_em ${c.rotulo}: match + ${c.esperaMin / 60}h`, l)
  }

  // 2) guardas
  let r = await desfazer(c10d, { id: U(1) })
  ok(r.status === 403, 'profissional não pode desfazer: 403', r.body)
  r = await desfazer(c10d, { id: U(2) })
  ok(r.status === 403, 'terceiro não pode desfazer: 403', r.body)
  r = await chamar(h.reparos, { id: U(99) }, { id: 'nao-e-uuid' })
  ok(r.status === 404, 'id inválido: 404', r.body)
  r = await desfazer(c10d)
  ok(r.status === 409 && r.body.codigo === 'AGUARDE' && new Date(r.body.liberado_em).toISOString() === emMin(24 * 60) && /a partir de/.test(r.body.erro), 'cedo demais (T0): 409 AGUARDE com liberado_em', r.body)
  await fixarAgora(24 * 60 - 1)
  r = await desfazer(c10d)
  ok(r.status === 409 && r.body.codigo === 'AGUARDE', '10 dias a 23h59: ainda AGUARDE', r.body.codigo)
  await fixarAgora(59)
  r = await desfazer(c2h)
  ok(r.status === 409 && r.body.codigo === 'AGUARDE', '2 horas a 59 min: AGUARDE (piso 1h)', r.body.codigo)

  // horário proposto / combinado / a caminho / sem match / fechada
  await fixarAgora(48 * 60)
  await db.query(`UPDATE reparos SET chegada_pendente_em = now() + INTERVAL '1 day' WHERE id = $1`, [D(c40h.n)])
  r = await desfazer(c40h)
  ok(r.status === 409 && r.body.codigo === 'HORARIO_EM_NEGOCIACAO' && await liberadoEm(c40h) === null, 'horário proposto: 409 HORARIO_EM_NEGOCIACAO e desfazer_liberado_em null', r.body.codigo)
  await db.query(`UPDATE reparos SET chegada_pendente_em = NULL, chegada_prevista_em = now() + INTERVAL '1 day' WHERE id = $1`, [D(c40h.n)])
  r = await desfazer(c40h)
  ok(r.status === 409 && r.body.codigo === 'HORARIO_EM_NEGOCIACAO' && await liberadoEm(c40h) === null, 'horário combinado: 409 e null', r.body.codigo)
  await db.query(`UPDATE reparos SET chegada_prevista_em = NULL, a_caminho_em = now() WHERE id = $1`, [D(c40h.n)])
  r = await desfazer(c40h)
  ok(r.status === 409 && r.body.codigo === 'A_CAMINHO' && await liberadoEm(c40h) === null, 'a caminho: 409 A_CAMINHO e null', r.body.codigo)
  await db.query(`UPDATE reparos SET a_caminho_em = NULL, status = 'encerrada' WHERE id = $1`, [D(c40h.n)])
  r = await desfazer(c40h)
  ok(r.status === 409 && r.body.codigo === 'DEMANDA_FECHADA', 'encerrada: 409 DEMANDA_FECHADA', r.body.codigo)
  await db.query(`UPDATE reparos SET status = 'aberta', match_usuario_id = NULL WHERE id = $1`, [D(c40h.n)])
  r = await desfazer(c40h)
  ok(r.status === 409 && r.body.codigo === 'SEM_MATCH' && await liberadoEm(c40h) === null, 'sem match: 409 SEM_MATCH e null', r.body.codigo)

  // 3) desfaz de fato (10 dias às 48h; 2h à 1h já passou). Aviso e reanúncio saem DEPOIS da
  //    resposta (fire-and-forget): espera um instante antes de conferir.
  const assentar = () => new Promise(resolve => setTimeout(resolve, 100))
  r = await desfazer(c10d); await assentar()
  ok(r.status === 200 && r.body.profissional_id === U(1), '10 dias às 48h: 200', r.body)
  let d = await linha(c10d)
  ok(d.match_usuario_id === null && d.match_feito_em === null && d.status === 'aberta' && d.a_caminho_em === null && d.lembrete_agendar_ultimo_em === null,
     'match/agenda zerados, demanda segue aberta', { match: d.match_usuario_id, status: d.status })
  ok(new Date(d.expira_em).toISOString() === emMin(10 * 1440), 'expira_em preservado (prazo que restava)', d.expira_em)
  ok(d.prestadores_bloqueados === null, 'profissional NÃO entra em prestadores_bloqueados')
  let p = await proposta(c10d)
  ok(p.status === 'cancelado' && p.cancelado_por === U(99) && p.cancelado_motivo === 'escolha_desfeita' && p.cancelado_acordo === false && !!p.cancelado_em, "proposta vencedora: 'cancelado', motivo escolha_desfeita, pelo dono", { status: p.status, motivo: p.cancelado_motivo })
  ok(avisos.length === 1 && avisos[0].usuario_id === U(1) && avisos[0].ator_id === U(99) && /desfez/.test(avisos[0].titulo) && avisos[0].data.reparo_id === D(c10d.n) && avisos[0].data.tipo === 'interesse_recusado',
     'push + e-mail ao profissional (tipo interesse_recusado)', avisos[0] && { titulo: avisos[0].titulo, data: avisos[0].data })
  ok(reanuncios.includes(`reparos:${D(c10d.n)}`), 'reanúncio aos profissionais', reanuncios)
  ok(await liberadoEm(c10d) === null, 'depois: desfazer_liberado_em null')
  r = await desfazer(c10d)
  ok(r.status === 409 && r.body.codigo === 'SEM_MATCH', 'repetir: 409 SEM_MATCH', r.body.codigo)

  // obra de 2h: prazo já venceu (T0+48h > T0+2h) → expira_em sobe ao piso NOW()+1h
  r = await desfazer(c2h); await assentar()
  ok(r.status === 200, 'obra 2h às 48h: 200', r.body)
  d = await linha(c2h)
  ok(new Date(d.expira_em).toISOString() === emMin(48 * 60 + 60), 'prazo vencido → expira_em = agora + 1h (piso)', d.expira_em)
  p = await proposta(c2h)
  ok(p.status === 'cancelado' && p.cancelado_motivo === 'escolha_desfeita', "candidatura 'cancelado' escolha_desfeita")
  ok(avisos[1]?.data.obra_id === D(c2h.n) && avisos[1]?.data.tipo === 'candidatura_recusada', 'aviso da obra (tipo candidatura_recusada)', avisos[1]?.data)
  const outro = (await db.query(`SELECT status FROM candidaturas WHERE obra_id = $1 AND usuario_id = $2`, [D(c2h.n), U(2)])).rows[0]
  ok(outro.status === 'recusado', "concorrente recusado no match segue 'recusado'")

  // 30 dias: teto 48h — exatamente às 48h libera
  r = await desfazer(c30d)
  ok(r.status === 200, '30 dias: às 48h (teto) → 200', r.body)

  // 4) cancelamentos frequentes: escolha_desfeita não conta (mesma consulta do serviço)
  const n = (await db.query(
    `SELECT (SELECT COUNT(*) FROM candidaturas WHERE cancelado_por = $1 AND cancelado_em > NOW() - ($2::int * INTERVAL '1 day') AND cancelado_motivo IS DISTINCT FROM 'escolha_desfeita')
          + (SELECT COUNT(*) FROM interesse_reparos WHERE cancelado_por = $1 AND cancelado_em > NOW() - ($2::int * INTERVAL '1 day') AND cancelado_motivo IS DISTINCT FROM 'escolha_desfeita') AS n`,
    [U(99), 90])).rows[0].n
  ok(Number(n) === 0, 'escolha_desfeita fora da contagem de cancelamentos frequentes', n)

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
