#!/usr/bin/env node
// E-MAIL DE DEMANDA NOVA só para quem NÃO tem push entregável (dono, 20/11/2026 — caso U94JN: uma
// demanda com ~280 elegíveis gastava sozinha o teto de 190 e as seguintes saíam com ZERO e-mails).
//  1) na hora: só sem token, desinstalado ou push falho; especialidade EXATA primeiro, depois o grupo;
//     quem só entra pelo faz-tudo ('outros') nunca recebe; quem recebeu o push não recebe;
//  2) quem recebeu o push ganha UMA linha no resumo das 19:00 quando email_resumo_diario está ligada;
//  3) o cron do que ficou devido limpa de uma vez pedido cancelado, encerrado, vencido ou com
//     profissional escolhido (match OU proposta aceita), mesmo sem orçamento e fora do horário;
//  4) o e-mail do lembrete "ainda aberto" só sai entre 08h e 20h (São Paulo) — o push da fase curta
//     continua a qualquer hora.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; Expo/Brevo falsos; NOW() sombreado por public.now().
//   npm i -D @electric-sql/pglite && node scripts/testar-email-demanda-nova-sem-push.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

const pushes = []
const emails = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  // Token com "falha" → ticket de erro (push falho); os demais saem.
  async sendPushNotificationsAsync(chunk) {
    return chunk.map((m, i) => {
      if (/falha/.test(m.to)) return { status: 'error', message: 'falha simulada', details: { error: 'MessageRateExceeded' } }
      pushes.push(m); return { status: 'ok', id: `t${pushes.length}-${i}` }
    })
  }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
const q = async (sql, params) => { if (!db) throw new Error('sem banco (boot)'); const r = await db.query(sql, params); r.rowCount = r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0); return r }
const shim = { query: q, connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: q, release() {} } }, on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) }, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async () => {} }
  return origLoad.apply(this, arguments)
}
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const erros = []
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { errOrig('unhandled', e && (e.stack || e)); process.exit(1) } })
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? (...a) => erros.push(a.map(x => x?.message || String(x)).join(' ').slice(0, 300)) : errOrig }
silenciar(true)
const A = require(path.join(REPO, 'src/services/alertaService'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 300))
const fixarAgora = (iso) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${iso}'::timestamptz $$`)
const DONO = U(900)
// id BAIXO no grupo e ALTO na especialidade exata: a ordem do e-mail não pode ser só "por id".
const P = {
  EX_PUSH:  { n: 1,  esp: ['salgadeiro'], token: 'ok' },
  GR_SEM:   { n: 2,  esp: ['garcom'] },
  GR_FALHA: { n: 3,  esp: ['cozinheiro'], token: 'falha' },
  GR_PUSH:  { n: 4,  esp: ['confeiteiro'], token: 'ok' },
  FT_SEM:   { n: 5,  esp: ['outros'] },
  FT_PUSH:  { n: 6,  esp: ['outros'], token: 'ok' },
  FORA:     { n: 7,  esp: ['eletrica'] },
  SEM_MAIL: { n: 8,  esp: ['salgadeiro'], semEmail: true },
  EX_DESI:  { n: 11, esp: ['salgadeiro'], token: 'ok', desinstalado: true },
  EX_SEM:   { n: 12, esp: ['salgadeiro', 'confeiteiro'] },
}
for (const [nome, p] of Object.entries(P)) { p.nome = nome; p.id = U(p.n); p.email = p.semEmail ? null : `${nome.toLowerCase()}@x.invalid`; p.tok = p.token ? `ExponentPushToken[${nome}-${p.token}]` : null }
const nomeDoEmail = (e) => Object.values(P).find(p => p.email === e)?.nome || e
const nomeDoToken = (t) => Object.values(P).find(p => p.tok === t)?.nome || t
const nomeDoId = (id) => Object.values(P).find(p => p.id === id)?.nome || id
const ordenado = (l) => [...l].sort()
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`
    CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_push_entregas_uq ON push_entregas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_configuracoes_uq ON configuracoes (chave);
    CREATE UNIQUE INDEX t_acima_teto_uq ON avisos_acima_do_teto (tabela, demanda_id, usuario_id);
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true'), ('email_resumo_diario', 'false');
    ALTER TABLE reparos ALTER COLUMN status SET DEFAULT 'aberta', ALTER COLUMN status_aprovacao SET DEFAULT 'aprovada';
    SET search_path = public, pg_catalog;
  `)
  await fixarAgora('2026-11-10T15:00:00Z') // terça, 12:00 em São Paulo
  // Os DEFAULT now() do esquema foram criados antes do relógio falso: religa os que este teste lê por data.
  await db.exec(`
    ALTER TABLE email_alertas ALTER COLUMN created_at SET DEFAULT now();
    ALTER TABLE push_entregas ALTER COLUMN primeira_tentativa_em SET DEFAULT now(), ALTER COLUMN ultima_tentativa_em SET DEFAULT now();
    ALTER TABLE lembretes_push_enviados ALTER COLUMN enviado_em SET DEFAULT now();
    ALTER TABLE avisos_acima_do_teto ALTER COLUMN criado_em SET DEFAULT now();
    ALTER TABLE email_resumo_itens ALTER COLUMN criado_em SET DEFAULT now();
    ALTER TABLE reparos ALTER COLUMN criado_em SET DEFAULT now();
  `)
  await db.query(`INSERT INTO usuarios (id, nome, email, role, cidade, uf, cpf_cnpj, avisos_todas_areas) VALUES ($1, 'Dona', 'dona@x.invalid', 'dono_obra', 'Patos de Minas', 'MG', '90000000000', false)`, [DONO])
  for (const p of Object.values(P)) {
    await db.query(
      `INSERT INTO usuarios (id, nome, email, role, tipo_prestador, cidade, uf, cpf_cnpj, push_token, especialidades, desinstalado_em, avisos_todas_areas)
       VALUES ($1, $2, $3, 'prestador', 'reparador', 'Patos de Minas', 'MG', $4, $5, $6::text[], ${p.desinstalado ? 'now()' : 'NULL'}, false)`,
      [p.id, `${p.nome} Teste`, p.email, String(p.n).padStart(11, '5'), p.tok, p.esp])
    await db.query(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [p.id])
  }
  const reparo = (id, titulo, extra = {}) => db.query(
    `INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, expira_em, criado_em, codigo_publico)
     VALUES ($1, $2, 'salgadeiro', '{salgadeiro}', 'Patos de Minas', 'MG', 'Centro', $3, 200, $4::numeric,
             COALESCE($5::timestamptz, now() + make_interval(hours => $4::int)), COALESCE($6::timestamptz, now()), $7)`,
    [id, titulo, DONO, extra.prazo ?? 240, extra.expira ?? null, extra.criado ?? null, extra.codigo ?? null])
  // Publica como a rota: claim + push + (fire-and-forget) e-mail. Devolve o que saiu.
  const publicar = async (id) => {
    silenciar(true); pushes.length = 0; emails.length = 0
    await A.dispararPushNovoComClaim('reparos', id, A.notificarPrestadoresSobreNovoReparo)
    await assentar(); silenciar(false)
    return { push: ordenado(pushes.map(p => nomeDoToken(p.to))), email: emails.map(e => nomeDoEmail(e.para)) }
  }
  const rodar = async (fn) => { silenciar(true); pushes.length = 0; emails.length = 0; const r = await fn(); await assentar(); silenciar(false); return r }
  const claims = async (id, tipo = 'reparo') => ordenado((await db.query(`SELECT usuario_id FROM email_alertas WHERE tipo = $2 AND demanda_id = $1`, [id, tipo])).rows.map(x => nomeDoId(x.usuario_id)))
  const pendente = async (id) => (await db.query(`SELECT email_novo_pendente_em FROM reparos WHERE id = $1`, [id])).rows[0].email_novo_pendente_em !== null
  const encher = (n, tipo = 'reparo') => db.query(`INSERT INTO email_alertas (tipo, demanda_id, usuario_id) SELECT $2, gen_random_uuid(), gen_random_uuid() FROM generate_series(1, $1::int)`, [n, tipo])
  const itensResumo = async (id) => ordenado((await db.query(`SELECT usuario_id FROM email_resumo_itens WHERE demanda_id = $1`, [id])).rows.map(x => nomeDoId(x.usuario_id)))

  // ═══ 1. Quem recebe na hora, e em que ordem ════════════════════════════════════════════════
  await reparo(D(1), 'Salgados para festa', { codigo: 'AAAA2' })
  let r = await publicar(D(1))
  ok(igual(r.push, ['EX_PUSH', 'FT_PUSH', 'GR_PUSH']), 'push de demanda nova: especialidade, grupo e faz-tudo com token (o push não mudou)', r.push)
  const entregas = Object.fromEntries((await db.query(`SELECT usuario_id, resultado FROM push_entregas WHERE demanda_id = $1`, [D(1)])).rows.map(x => [nomeDoId(x.usuario_id), x.resultado]))
  ok(entregas.GR_FALHA === 'falha' && entregas.EX_PUSH === 'enviado', 'push_entregas: GR_FALHA ficou "falha", EX_PUSH "enviado"', entregas)
  ok(igual(r.email, ['EX_DESI', 'EX_SEM', 'GR_SEM', 'GR_FALHA']),
     'e-mail na hora, NESTA ordem: especialidade exata (desinstalado, sem token) e depois o grupo (sem token, push falho)', r.email)
  ok(!r.email.some(n => ['EX_PUSH', 'GR_PUSH'].includes(n)), 'quem RECEBEU o push não recebe e-mail na hora')
  ok(!r.email.some(n => ['FT_SEM', 'FT_PUSH'].includes(n)), 'faz-tudo (só "outros"), com ou sem token: nunca recebe este e-mail')
  ok(!r.email.includes('FORA') && emails.length === 4, 'fora do grupo e conta sem e-mail: nada (4 envios no total)', emails.length)
  ok(emails.every(e => /Novo serviço disponível!$/.test(e.assunto) && e.html.includes('https://protudo.app.br/p/AAAA2')), 'mesmo assunto e mesmo botão de sempre', emails.map(e => e.assunto))
  ok(igual(await claims(D(1)), ordenado(['EX_DESI', 'EX_SEM', 'GR_SEM', 'GR_FALHA'])) && !(await pendente(D(1))), 'email_alertas: 4 claims (tipo reparo); nada pendente')
  r = await rodar(() => A.enviarEmailsNovaDemanda('reparos', D(1)))
  ok(emails.length === 0, 'repetir o caminho: ninguém recebe de novo', emails.length)
  // push que falhou e DEPOIS saiu (repescagem): quem ainda não tinha e-mail deixa de ser "sem push"
  await reparo(D(2), 'Coxinhas')
  await db.query(`INSERT INTO push_entregas (tipo, demanda_id, usuario_id, resultado) VALUES ('reparo', $1, $2, 'enviado'), ('reparo', $1, $3, 'falha')`, [D(2), P.GR_FALHA.id, P.EX_PUSH.id])
  await rodar(() => A.enviarEmailsNovaDemanda('reparos', D(2)))
  const e2 = emails.map(e => nomeDoEmail(e.para))
  ok(!e2.includes('GR_FALHA') && e2.includes('EX_PUSH'), 'o que vale é o resultado do push DESTA demanda: "enviado" → sem e-mail; "falha" → e-mail, mesmo com token', e2)
  ok(igual(e2.slice(0, 3), ['EX_PUSH', 'EX_DESI', 'EX_SEM']), 'os de especialidade exata continuam na frente', e2)

  // ═══ 2. Resumo das 19:00 para quem recebeu o push ══════════════════════════════════════════
  ok((await itensResumo(D(1))).length === 0, 'chave email_resumo_diario DESLIGADA: nada entra no resumo')
  const marcadas = (await db.query(`SELECT count(*)::int AS n FROM push_entregas WHERE demanda_id = $1 AND resultado = 'enviado' AND resumo_em IS NOT NULL`, [D(1)])).rows[0].n
  ok(marcadas === 3, 'mesmo desligada, os pushes enviados ficam marcados (ligar a chave depois não despeja pedidos antigos)', marcadas)
  await db.query(`UPDATE configuracoes SET valor = 'true' WHERE chave = 'email_resumo_diario'`)
  await rodar(() => A.enviarEmailsNovaDemanda('reparos', D(1)))
  ok((await itensResumo(D(1))).length === 0 && emails.length === 0, 'chave ligada depois: o pedido antigo NÃO entra no resumo')
  await reparo(D(3), 'Empadas', { codigo: 'BBBB3' })
  r = await publicar(D(3))
  ok(igual(await itensResumo(D(3)), ['EX_PUSH', 'GR_PUSH']), 'chave LIGADA: quem recebeu o push ganha uma linha do pedido no resumo — o faz-tudo (FT_PUSH) não', await itensResumo(D(3)))
  ok(igual(r.email, ['EX_DESI', 'EX_SEM', 'GR_SEM', 'GR_FALHA']), 'com a chave ligada, o e-mail na hora de quem NÃO tem push continua igual', r.email)
  const linha = (await db.query(`SELECT tipo, demanda_tabela, titulo, linha FROM email_resumo_itens WHERE demanda_id = $1 LIMIT 1`, [D(3)])).rows[0]
  ok(linha && linha.tipo === 'novo_reparo' && linha.demanda_tabela === 'reparos' && /Novo serviço disponível!$/.test(linha.titulo) && linha.linha.includes('"Empadas" em Patos de Minas'), 'linha do resumo: título e texto do aviso de demanda nova', linha)
  await rodar(() => A.enviarEmailsNovaDemanda('reparos', D(3)))
  ok((await itensResumo(D(3))).length === 2 && emails.length === 0, 'repetir o caminho: a linha do resumo não duplica', (await itensResumo(D(3))).length)
  await db.query(`UPDATE configuracoes SET valor = 'false' WHERE chave = 'email_resumo_diario'`)

  // ═══ 3. Teto: corta o GRUPO antes; o que ficou devido sai no dia seguinte ══════════════════
  await fixarAgora('2026-11-11T15:00:00Z') // quarta 12:00 — orçamento novo
  await encher(188)                        // restam 2
  await reparo(D(4), 'Risoles')
  r = await publicar(D(4))
  ok(igual(r.email, ['EX_DESI', 'EX_SEM']) && await pendente(D(4)), 'com 2 de orçamento: saem os 2 de especialidade EXATA; o grupo fica devido (pedido marcado)', r.email)
  await fixarAgora('2026-11-12T11:05:00Z') // quinta 08:05
  await rodar(() => A.enviarEmailsPendentesNovaDemanda())
  ok(igual(emails.map(e => nomeDoEmail(e.para)), ['GR_SEM', 'GR_FALHA']) && !(await pendente(D(4))) && emails.every(e => /^⏳ Pedido ainda aberto: Risoles$/.test(e.assunto)),
     'dia seguinte 08:05: os 2 do grupo recebem ("ainda aberto"), ninguém em dobro, marca limpa', emails.map(e => [nomeDoEmail(e.para), e.assunto]))

  // ═══ 4. Faxina do que ficou devido: cancelado, encerrado, vencido, com escolhido ═══════════
  await fixarAgora('2026-11-13T01:00:00Z') // quinta 22:00 — FORA da janela
  await encher(190)                        // e SEM orçamento
  const casos = { cancelado: D(10), encerrado: D(11), vencido: D(12), comMatch: D(13), propostaAceita: D(14), recusadoNaAprovacao: D(15), vivo: D(16) }
  for (const id of Object.values(casos)) await reparo(id, `Pendente ${id.slice(-2)}`)
  await db.query(`UPDATE reparos SET email_novo_pendente_em = now() - interval '1 day', push_novo_enviado_em = now() - interval '1 day' WHERE id = ANY($1::uuid[])`, [Object.values(casos)])
  await db.query(`UPDATE reparos SET status = 'cancelada' WHERE id = $1`, [casos.cancelado])
  await db.query(`UPDATE reparos SET status = 'encerrada' WHERE id = $1`, [casos.encerrado])
  await db.query(`UPDATE reparos SET expira_em = now() - interval '1 minute' WHERE id = $1`, [casos.vencido])
  await db.query(`UPDATE reparos SET match_usuario_id = $2 WHERE id = $1`, [casos.comMatch, P.EX_PUSH.id])
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status) VALUES ($1, $2, 'aceito')`, [casos.propostaAceita, P.EX_PUSH.id])
  await db.query(`UPDATE reparos SET status_aprovacao = 'recusada' WHERE id = $1`, [casos.recusadoNaAprovacao])
  await rodar(() => A.enviarEmailsPendentesNovaDemanda())
  const marcas = {}
  for (const [k, id] of Object.entries(casos)) marcas[k] = await pendente(id)
  ok(!marcas.cancelado && !marcas.encerrado && !marcas.vencido && !marcas.comMatch && !marcas.propostaAceita && !marcas.recusadoNaAprovacao,
     '22:00 e sem orçamento: cancelado, encerrado, vencido, com match, com proposta aceita e recusado perdem a marca de uma vez', marcas)
  ok(marcas.vivo && emails.length === 0, 'o pedido vivo continua marcado e nada é enviado fora do horário / sem orçamento', { vivo: marcas.vivo, emails: emails.length })
  await fixarAgora('2026-11-13T11:05:00Z') // sexta 08:05 — orçamento novo
  await rodar(() => A.enviarEmailsPendentesNovaDemanda())
  const mortos = Object.entries(casos).filter(([k]) => k !== 'vivo').map(([, id]) => id)
  const paraMortos = (await db.query(`SELECT count(*)::int AS n FROM email_alertas WHERE demanda_id = ANY($1::uuid[])`, [mortos])).rows[0].n
  ok(paraMortos === 0 && igual(await claims(casos.vivo), ordenado(['EX_DESI', 'EX_SEM', 'GR_SEM'])) && !(await pendente(casos.vivo)),
     '08:05: só o pedido vivo recebe (os 3 sem push entregável); os outros 6 pedidos, zero e-mails', { paraMortos, vivo: await claims(casos.vivo) })

  // ═══ 4b. Ordem da fila: quem VENCE primeiro sai primeiro; a menos de 1h do fim, não sai ═══
  await fixarAgora('2026-11-14T15:00:00Z') // sábado 12:00 — orçamento novo
  await encher(187)                        // restam 3: dá para UM pedido (3 sem push cada)
  const ANTIGA = D(30), RECENTE = D(31), QUASE = D(32)
  await reparo(ANTIGA, 'Marcada há 3 dias, prazo longo')                                  // vence em 10 dias
  await reparo(RECENTE, 'Marcada há 1 hora, vence hoje', { expira: '2026-11-14T20:00:00Z' }) // vence em 5 h
  await reparo(QUASE, 'Vence em 30 minutos', { expira: '2026-11-14T15:30:00Z' })
  await db.query(`UPDATE reparos SET push_novo_enviado_em = now() - interval '3 days', email_novo_pendente_em = now() - interval '3 days' WHERE id = $1`, [ANTIGA])
  await db.query(`UPDATE reparos SET push_novo_enviado_em = now() - interval '1 hour', email_novo_pendente_em = now() - interval '1 hour' WHERE id = $1`, [RECENTE])
  await db.query(`UPDATE reparos SET push_novo_enviado_em = now() - interval '2 days', email_novo_pendente_em = now() - interval '2 days' WHERE id = $1`, [QUASE])
  await rodar(() => A.enviarEmailsPendentesNovaDemanda())
  ok((await claims(RECENTE)).length === 3 && !(await pendente(RECENTE)) && emails.length === 3 && emails.every(e => /Marcada há 1 hora/.test(e.assunto)),
     'orçamento para um pedido: sai o que VENCE primeiro (marcado há 1 h), não o marcado há mais tempo — antes o antigo passava na frente', { recente: (await claims(RECENTE)).length, emails: emails.map(e => e.assunto) })
  ok((await claims(ANTIGA)).length === 0 && await pendente(ANTIGA), 'o de prazo longo espera a vez: zero hoje, continua marcado')
  ok((await claims(QUASE)).length === 0 && await pendente(QUASE), 'a menos de 1 h do fim: pulado (não envia), mesmo sendo o primeiro da fila; segue marcado até vencer')
  await fixarAgora('2026-11-15T15:00:00Z') // domingo 12:00 — orçamento novo, QUASE já venceu
  await rodar(() => A.enviarEmailsPendentesNovaDemanda())
  ok((await claims(ANTIGA)).length === 3 && !(await pendente(ANTIGA)) && (await claims(QUASE)).length === 0 && !(await pendente(QUASE)),
     'dia seguinte: o de prazo longo recebe; o que venceu perdeu a marca sem nenhum e-mail', { antiga: (await claims(ANTIGA)).length, quase: (await claims(QUASE)).length })

  // ═══ 5. E-mail do lembrete só entre 08h e 20h (São Paulo) ══════════════════════════════════
  await db.query(`UPDATE reparos SET status = 'encerrada'`) // só os dois pedidos abaixo ficam abertos
  // Prazo de 12h (fase curta: lembra em W/3 e 2W/3, a qualquer hora). Criado às 23:00 → 1ª fatia às 03:00.
  await fixarAgora('2026-11-17T06:20:00Z') // terça 03:20 SP
  await reparo(D(20), 'Salgados de madrugada', { prazo: 12, criado: '2026-11-17T02:00:00Z' })
  await db.query(`UPDATE reparos SET push_novo_enviado_em = criado_em WHERE id = $1`, [D(20)])
  await rodar(() => A.lembrarDemandasSemResposta())
  const lembreteDe = async (id) => (await db.query(`SELECT count(*)::int AS n FROM email_alertas WHERE demanda_id = $1 AND tipo LIKE 'lembrete\\_%'`, [id])).rows[0].n
  ok(pushes.some(p => /^🔔 Ainda aberto: Salgados de madrugada$/.test(p.title)), '03:20: o PUSH do lembrete da fase curta continua saindo a qualquer hora', pushes.map(p => p.title))
  ok(emails.length === 0 && await lembreteDe(D(20)) === 0, '03:20: NENHUM e-mail de lembrete (antes saía — caso de 19–20/11)', { emails: emails.length, claims: await lembreteDe(D(20)) })
  // Criado às 05:00 → 1ª fatia às 09:00; às 10:00 está dentro da janela.
  await fixarAgora('2026-11-17T13:00:00Z') // terça 10:00 SP
  await reparo(D(21), 'Salgados de manhã', { prazo: 12, criado: '2026-11-17T08:00:00Z' })
  await db.query(`UPDATE reparos SET push_novo_enviado_em = criado_em WHERE id = $1`, [D(21)])
  await rodar(() => A.lembrarDemandasSemResposta())
  const paraManha = emails.filter(e => /Salgados de manhã/.test(e.assunto)).map(e => nomeDoEmail(e.para))
  ok(paraManha.includes('EX_SEM') && paraManha.includes('GR_SEM') && await lembreteDe(D(21)) > 0, '10:00: o e-mail do lembrete sai (a quem não tem token, como sempre)', paraManha)
  ok(!paraManha.some(n => ['EX_PUSH', 'GR_PUSH', 'FT_PUSH'].includes(n)), 'lembrete: quem tem token segue sem e-mail (regra de sempre)')

  const errosReais = erros.filter(e => !/sem banco|migration|falha simulada/i.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
