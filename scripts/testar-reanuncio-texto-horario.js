#!/usr/bin/env node
// REANÚNCIO COM TEXTO E HORÁRIO PRÓPRIOS + "AINDA ABERTO" NO PRIMEIRO AVISO ATRASADO (dono, 21/11/2026).
// Caso WM4F2: o profissional cancelou o match às 06:07 e 211 pessoas receberam, de madrugada,
// "Novo serviço disponível!" de um pedido de 2 dias (alertaService.reanunciarDemanda).
//  1) reanúncio: push "🔁 Pedido disponível de novo: <título>" (corpo, data e público de sempre);
//  2) reanúncio só entre 07:00 e 22:00 (São Paulo): fora disso nada sai (push nem e-mail), fica
//     marcado em reanuncio_pendente_em e sai no 1º tique das 07:00 — pelo cronômetro de 1 min;
//     se a demanda deixou de valer no meio-tempo, a marca cai sem aviso;
//  3) rede de segurança (enviarPushNovoPendente) e repescagem por destinatário
//     (reenviarEntregasFalhas): pedido com mais de 6h sai com o texto "🔔 Ainda aberto: …"; até 6h
//     segue "Novo serviço disponível!"; data e push_entregas não mudam;
//  4) o que NÃO muda: a rota (claim direto) segue "Novo serviço disponível!" seja qual for a idade.
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; Expo/Brevo falsos; NOW() sombreado por public.now().
//   npm i -D @electric-sql/pglite && node scripts/testar-reanuncio-texto-horario.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

const pushes = []
const emails = []
let falharTokens = true
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  // Token com "falha" → ticket de erro enquanto falharTokens estiver ligado; os demais saem.
  async sendPushNotificationsAsync(chunk) {
    return chunk.map((m, i) => {
      if (falharTokens && /falha/.test(m.to)) return { status: 'error', message: 'falha simulada', details: { error: 'MessageRateExceeded' } }
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
const { migrarReaberturaMatch } = require(path.join(REPO, 'src/utils/reaberturaMatch'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const O = (n) => `0b0a0000-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 300))
const fixarAgora = (iso) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${iso}'::timestamptz $$`)
const DONO = U(900)
const P = {
  COM_PUSH:  { n: 1, tipo: 'reparador', esp: ['salgadeiro'], token: 'ok' },
  SEM_TOKEN: { n: 2, tipo: 'reparador', esp: ['salgadeiro'] },
  JA_PROPOS: { n: 3, tipo: 'reparador', esp: ['salgadeiro'], token: 'ok' },
  FALHA:     { n: 4, tipo: 'reparador', esp: ['salgadeiro'], token: 'falha' },
  PINTOR:    { n: 5, tipo: 'pintor',    esp: null, token: 'ok' },
}
for (const [nome, p] of Object.entries(P)) { p.nome = nome; p.id = U(p.n); p.email = `${nome.toLowerCase()}@x.invalid`; p.tok = p.token ? `ExponentPushToken[${nome}-${p.token}]` : null }
const nomeDoToken = (t) => Object.values(P).find(p => p.tok === t)?.nome || t
const nomeDoEmail = (e) => Object.values(P).find(p => p.email === e)?.nome || e
const ordenado = (l) => [...l].sort()
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const NOVO = /Novo serviço disponível!$/
const para = (nome) => pushes.filter(p => p.to === P[nome].tok)

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  // A coluna nova nasce pela MESMA migração do boot (idempotente sobre o esquema de produção).
  await db.exec(`ALTER TABLE reparos DROP COLUMN IF EXISTS reanuncio_pendente_em; ALTER TABLE obras DROP COLUMN IF EXISTS reanuncio_pendente_em`)
  await migrarReaberturaMatch({ query: (s, p) => db.query(s, p) })
  await migrarReaberturaMatch({ query: (s, p) => db.query(s, p) })
  await db.exec(`
    CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_push_entregas_uq ON push_entregas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_configuracoes_uq ON configuracoes (chave);
    CREATE UNIQUE INDEX t_acima_teto_uq ON avisos_acima_do_teto (tabela, demanda_id, usuario_id);
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true'), ('email_resumo_diario', 'false');
    ALTER TABLE reparos ALTER COLUMN status SET DEFAULT 'aberta', ALTER COLUMN status_aprovacao SET DEFAULT 'aprovada';
    ALTER TABLE obras ALTER COLUMN status SET DEFAULT 'aberta', ALTER COLUMN status_aprovacao SET DEFAULT 'aprovada';
    SET search_path = public, pg_catalog;
  `)
  await fixarAgora('2026-11-10T15:00:00Z') // terça, 12:00 em São Paulo
  await db.exec(`
    ALTER TABLE email_alertas ALTER COLUMN created_at SET DEFAULT now();
    ALTER TABLE push_entregas ALTER COLUMN primeira_tentativa_em SET DEFAULT now(), ALTER COLUMN ultima_tentativa_em SET DEFAULT now();
    ALTER TABLE lembretes_push_enviados ALTER COLUMN enviado_em SET DEFAULT now();
    ALTER TABLE avisos_acima_do_teto ALTER COLUMN criado_em SET DEFAULT now();
    ALTER TABLE reparos ALTER COLUMN criado_em SET DEFAULT now();
    ALTER TABLE obras ALTER COLUMN criado_em SET DEFAULT now();
  `)
  await db.query(`INSERT INTO usuarios (id, nome, email, role, cidade, uf, cpf_cnpj, avisos_todas_areas) VALUES ($1, 'Dona', 'dona@x.invalid', 'dono_obra', 'Patos de Minas', 'MG', '90000000000', false)`, [DONO])
  for (const p of Object.values(P)) {
    await db.query(
      `INSERT INTO usuarios (id, nome, email, role, tipo_prestador, cidade, uf, cpf_cnpj, push_token, especialidades, avisos_todas_areas)
       VALUES ($1, $2, $3, 'prestador', $4, 'Patos de Minas', 'MG', $5, $6, $7::text[], false)`,
      [p.id, `${p.nome} Teste`, p.email, p.tipo, String(p.n).padStart(11, '5'), p.tok, p.esp])
    await db.query(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [p.id])
  }
  // anunciado: horas atrás em que o primeiro aviso saiu (null = nunca saiu → rede de segurança).
  const reparo = (id, titulo, { criadoHa = 48, anunciado = 48 } = {}) => db.query(
    `INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, expira_em, criado_em, push_novo_enviado_em)
     VALUES ($1, $2, 'salgadeiro', '{salgadeiro}', 'Patos de Minas', 'MG', 'Centro', $3, 200, 720, now() + INTERVAL '20 days',
             now() - make_interval(mins => $4::int), CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(mins => $5::int) END)`,
    [id, titulo, DONO, Math.round(criadoHa * 60), anunciado === null ? null : Math.round(anunciado * 60)])
  const rodar = async (fn) => { silenciar(true); pushes.length = 0; emails.length = 0; const r = await fn(); await assentar(); silenciar(false); return r }
  const marca = async (id, tabela = 'reparos') => (await db.query(`SELECT reanuncio_pendente_em FROM ${tabela} WHERE id = $1`, [id])).rows[0].reanuncio_pendente_em !== null
  const logReanuncio = async (id) => (await db.query(`SELECT count(*)::int AS n FROM lembretes_push_enviados WHERE demanda_id = $1 AND motivo = 'reanuncio'`, [id])).rows[0].n
  const claimsEmail = async (id, tipo) => ordenado((await db.query(`SELECT usuario_id FROM email_alertas WHERE demanda_id = $1 AND tipo = $2`, [id, tipo])).rows.map(x => Object.values(P).find(p => p.id === x.usuario_id)?.nome))
  const encerrarTudo = () => db.query(`UPDATE reparos SET status = 'encerrada'`)

  // ═══ 1. Reanúncio de dia: texto próprio ════════════════════════════════════════════════════
  await reparo(D(1), 'Cozinheira e garçom')
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status) VALUES ($1, $2, 'pendente')`, [D(1), P.JA_PROPOS.id])
  await rodar(() => A.reanunciarDemanda('reparos', D(1)))
  let p = para('COM_PUSH')
  ok(p.length === 1 && p[0].title === '🔁 Pedido disponível de novo: Cozinheira e garçom', '12:00 reanúncio: título "🔁 Pedido disponível de novo: <título>"', pushes.map(x => x.title))
  ok(p[0]?.title === A.tituloReanuncio('Cozinheira e garçom') && !pushes.some(x => NOVO.test(x.title)), 'ninguém recebe "Novo serviço disponível!" no reanúncio')
  ok(p[0]?.body === '"Cozinheira e garçom" em Patos de Minas — categoria: Salgadeiro' && igual(p[0]?.data, { tipo: 'novo_reparo', reparo_id: D(1), reaberta: true }),
     'corpo e data de sempre (novo_reparo + reaberta → o toque abre o mesmo detalhe)', { body: p[0]?.body, data: p[0]?.data })
  ok(igual(ordenado(pushes.map(x => nomeDoToken(x.to))), ['COM_PUSH']) && await logReanuncio(D(1)) === 1,
     'público de sempre: quem já propôs fica de fora; conta no teto como reanúncio', pushes.map(x => nomeDoToken(x.to)))
  ok(igual(await claimsEmail(D(1), 'reaberta_reparo'), ['COM_PUSH', 'FALHA', 'SEM_TOKEN']) && emails.every(e => /^⏳ Pedido ainda aberto: /.test(e.assunto)),
     'e-mail do reanúncio não mudou (tipo reaberta_reparo, assunto "Pedido ainda aberto")', emails.map(e => `${nomeDoEmail(e.para)}: ${e.assunto}`))
  ok(!(await marca(D(1))), 'de dia nada fica marcado para depois')

  // ═══ 2. Reanúncio de madrugada: adiado para as 07:00 ═══════════════════════════════════════
  await encerrarTudo()
  await fixarAgora('2026-11-11T09:07:00Z') // 06:07 em São Paulo (a hora do caso WM4F2)
  await reparo(D(2), 'Garçom para evento')
  await rodar(() => A.reanunciarDemanda('reparos', D(2)))
  ok(pushes.length === 0 && emails.length === 0 && await logReanuncio(D(2)) === 0, '06:07: NADA sai (push nem e-mail)', { pushes: pushes.length, emails: emails.length })
  ok(await marca(D(2)), '06:07: fica marcado em reanuncio_pendente_em')
  await fixarAgora('2026-11-11T09:59:00Z') // 06:59
  await rodar(() => A.verificarCronometroReparos())
  ok(pushes.length === 0 && emails.length === 0 && await marca(D(2)), '06:59 (cronômetro): ainda nada, segue marcado')
  await fixarAgora('2026-11-11T10:00:00Z') // 07:00
  await rodar(() => A.verificarCronometroReparos())
  p = para('COM_PUSH')
  ok(p.length === 1 && p[0].title === '🔁 Pedido disponível de novo: Garçom para evento' && p[0].data.reaberta === true, '07:00 (cronômetro): o reanúncio adiado sai, com o texto próprio', pushes.map(x => x.title))
  ok(pushes.length === 2 && emails.length === 4 && !(await marca(D(2))), '07:00: 2 pushes e 4 e-mails saem juntos e a marca é limpa', { pushes: pushes.length, emails: emails.length })
  await rodar(() => A.verificarCronometroReparos())
  ok(pushes.length === 0 && emails.length === 0 && await logReanuncio(D(2)) === 2, 'tique seguinte: ninguém recebe de novo')
  // 22:00 em ponto já é silêncio; 21:59 ainda não.
  await fixarAgora('2026-11-12T00:59:00Z') // 21:59
  await reparo(D(3), 'Churrasqueiro sábado')
  await rodar(() => A.reanunciarDemanda('reparos', D(3)))
  ok(para('COM_PUSH').length === 1 && !(await marca(D(3))), '21:59: sai na hora')
  await fixarAgora('2026-11-12T01:00:00Z') // 22:00
  await reparo(D(4), 'Copeira domingo')
  await rodar(() => A.reanunciarDemanda('reparos', D(4)))
  ok(pushes.length === 0 && emails.length === 0 && await marca(D(4)), '22:00: adiado')
  // Dois cancelamentos na mesma noite: a marca não é reescrita e sai UM reanúncio.
  const marcadoEm = async (id) => (await db.query(`SELECT reanuncio_pendente_em FROM reparos WHERE id = $1`, [id])).rows[0].reanuncio_pendente_em
  const m1 = String(await marcadoEm(D(4)))
  await fixarAgora('2026-11-12T05:00:00Z') // 02:00
  await rodar(() => A.reanunciarDemanda('reparos', D(4)))
  ok(String(await marcadoEm(D(4))) === m1 && pushes.length === 0, '02:00, cancelou de novo: mesma marca, nada sai')
  // Novo match antes das 07:00: a marca cai a qualquer hora, sem aviso.
  await reparo(D(5), 'Bartender festa')
  await rodar(() => A.reanunciarDemanda('reparos', D(5)))
  await db.query(`UPDATE reparos SET match_usuario_id = $2 WHERE id = $1`, [D(5), P.JA_PROPOS.id])
  await rodar(() => A.enviarReanunciosAdiados('reparos'))
  ok(!(await marca(D(5))) && await marca(D(4)) && pushes.length === 0 && emails.length === 0, '02:00: pedido que ganhou novo match perde a marca sem aviso; o outro segue marcado')
  await db.query(`UPDATE reparos SET match_usuario_id = NULL WHERE id = $1`, [D(5)])
  await fixarAgora('2026-11-12T10:01:00Z') // 07:01
  await rodar(() => A.enviarReanunciosAdiados('reparos'))
  ok(igual(ordenado(pushes.map(x => `${nomeDoToken(x.to)}: ${x.title}`)), ['COM_PUSH: 🔁 Pedido disponível de novo: Copeira domingo', 'JA_PROPOS: 🔁 Pedido disponível de novo: Copeira domingo']) && !(await marca(D(4))), '07:01: só o que ficou marcado é reanunciado, uma vez por pessoa', pushes.map(x => x.title))

  // ═══ 3. Rede de segurança: pedido com mais de 6h sai como "Ainda aberto" ═══════════════════
  await encerrarTudo()
  await fixarAgora('2026-11-12T15:00:00Z') // 12:00
  await reparo(D(10), 'Salgados antigos', { criadoHa: 7, anunciado: null })
  await reparo(D(11), 'Salgados recentes', { criadoHa: 0.5, anunciado: null })
  await reparo(D(12), 'Salgados de 5h59', { criadoHa: 5.98, anunciado: null })
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status) VALUES ($1, $2, 'pendente')`, [D(12), P.JA_PROPOS.id])
  falharTokens = false
  await rodar(() => A.enviarPushNovoPendente())
  falharTokens = true
  const de = (id) => pushes.filter(x => x.data?.reparo_id === id && x.to === P.COM_PUSH.tok)
  p = de(D(10))
  ok(p.length === 1 && p[0].title === '🔔 Ainda aberto: Salgados antigos' && p[0].body === 'Salgadeiro · R$ 200 · Ninguém respondeu ainda, chegue primeiro!',
     'rede de segurança, pedido de 7h: texto "Ainda aberto" (o do lembrete)', p.map(x => [x.title, x.body]))
  ok(igual(p[0]?.data, { tipo: 'novo_reparo', reparo_id: D(10) }), 'data segue o de demanda nova (sem lembrete: true)', p[0]?.data)
  p = de(D(11))
  ok(p.length === 1 && NOVO.test(p[0].title) && p[0].body === '"Salgados recentes" em Patos de Minas — categoria: Salgadeiro', 'rede de segurança, pedido de 30 min: "Novo serviço disponível!" como sempre', p.map(x => x.title))
  ok(de(D(12)).length === 1 && NOVO.test(de(D(12))[0].title), 'pedido de 5h59: ainda "Novo serviço disponível!"', de(D(12)).map(x => x.title))
  const carimbos = (await db.query(`SELECT count(*)::int AS n FROM reparos WHERE id = ANY($1::uuid[]) AND push_novo_enviado_em IS NOT NULL`, [[D(10), D(11), D(12)]])).rows[0].n
  const entregas = (await db.query(`SELECT count(*)::int AS n FROM push_entregas WHERE tipo = 'reparo' AND demanda_id = $1 AND resultado = 'enviado'`, [D(10)])).rows[0].n
  ok(carimbos === 3 && entregas === 3, 'claim e push_entregas como sempre (3 carimbados; 3 entregas registradas no pedido antigo)', { carimbos, entregas })
  await rodar(() => A.enviarPushNovoPendente())
  ok(pushes.length === 0, 'rodar de novo: ninguém recebe duas vezes', pushes.map(x => x.title))

  // ═══ 4. Repescagem por destinatário ════════════════════════════════════════════════════════
  await encerrarTudo()
  await reparo(D(20), 'Empadas antigas', { criadoHa: 30, anunciado: 30 })
  await reparo(D(21), 'Empadas recentes', { criadoHa: 1, anunciado: 1 })
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status) VALUES ($1, $2, 'pendente')`, [D(20), P.JA_PROPOS.id])
  await db.query(`INSERT INTO push_entregas (tipo, demanda_id, usuario_id, resultado, tentativas, primeira_tentativa_em, ultima_tentativa_em)
                  VALUES ('reparo', $1, $3, 'falha', 1, now() - INTERVAL '30 hours', now() - INTERVAL '15 minutes'),
                         ('reparo', $2, $3, 'falha', 1, now() - INTERVAL '1 hour', now() - INTERVAL '15 minutes')`, [D(20), D(21), P.FALHA.id])
  falharTokens = false
  await rodar(() => A.enviarPushNovoPendente())
  falharTokens = true
  const rep = (id) => pushes.filter(x => x.data?.reparo_id === id)
  ok(rep(D(20)).length === 1 && rep(D(20))[0].to === P.FALHA.tok && rep(D(20))[0].title === '🔔 Ainda aberto: Empadas antigas'
     && rep(D(20))[0].body === 'Salgadeiro · R$ 200 · Ainda sem profissional definido — mande sua proposta!' && igual(rep(D(20))[0].data, { tipo: 'novo_reparo', reparo_id: D(20) }),
     'repescagem, pedido de 30h: "Ainda aberto" (corpo pelo nº de interessados), data de demanda nova', rep(D(20)).map(x => [x.title, x.body, x.data]))
  ok(rep(D(21)).length === 1 && NOVO.test(rep(D(21))[0].title), 'repescagem, pedido de 1h: "Novo serviço disponível!" como sempre', rep(D(21)).map(x => x.title))
  const res = (await db.query(`SELECT resultado, tentativas FROM push_entregas WHERE demanda_id = $1 AND usuario_id = $2`, [D(20), P.FALHA.id])).rows[0]
  ok(res.resultado === 'enviado' && res.tentativas === 2, 'push_entregas: a falha vira "enviado" com 2 tentativas', res)

  // ═══ 5. O que não muda: a rota segue "Novo", e o lado obra usa as colunas dele ═════════════
  await encerrarTudo()
  await reparo(D(30), 'Aprovado tarde', { criadoHa: 60, anunciado: null })
  await rodar(() => A.dispararPushNovoComClaim('reparos', D(30), A.notificarPrestadoresSobreNovoReparo))
  ok(para('COM_PUSH').length === 1 && NOVO.test(para('COM_PUSH')[0].title), 'rota (claim direto), pedido de 60h: segue "Novo serviço disponível!"', pushes.map(x => x.title))
  await db.query(
    `INSERT INTO obras (id, titulo, categoria, criado_por, valor, horas_para_expirar, cidade, uf, bairro, criado_em, publicado_em, expira_em)
     VALUES ($1, 'Pintura antiga', 'residencial', $3, 3000, 480, 'Patos de Minas', 'MG', 'Centro', now() - INTERVAL '3 days', now() - INTERVAL '8 hours', now() + INTERVAL '10 days'),
            ($2, 'Pintura recente', 'residencial', $3, 3000, 480, 'Patos de Minas', 'MG', 'Centro', now() - INTERVAL '3 days', now() - INTERVAL '20 minutes', now() + INTERVAL '10 days')`,
    [O(1), O(2), DONO])
  await rodar(() => A.enviarPushNovoPendente())
  const obra = (id) => pushes.filter(x => x.data?.obra_id === id && x.to === P.PINTOR.tok)
  ok(obra(O(1)).length === 1 && obra(O(1))[0].title === '🔔 Ainda aberto: Pintura antiga' && /R\$ 3\.000 · Ninguém respondeu ainda/.test(obra(O(1))[0].body) && igual(obra(O(1))[0].data, { tipo: 'nova_obra', obra_id: O(1) }),
     'obra publicada há 8h (rede de segurança): "Ainda aberto", âncora = publicado_em', obra(O(1)).map(x => [x.title, x.body, x.data]))
  ok(obra(O(2)).length === 1 && /Nova obra disponível!$/.test(obra(O(2))[0].title), 'obra criada há 3 dias mas publicada há 20 min: "Nova obra disponível!"', obra(O(2)).map(x => x.title))
  await fixarAgora('2026-11-13T05:00:00Z') // 02:00
  await db.query(`UPDATE obras SET push_novo_enviado_em = now() WHERE push_novo_enviado_em IS NULL`)
  await rodar(() => A.reanunciarDemanda('obras', O(1)))
  ok(pushes.length === 0 && await marca(O(1), 'obras'), 'obra, 02:00: reanúncio adiado')
  await fixarAgora('2026-11-13T11:00:00Z') // 08:00
  await rodar(() => A.verificarCronometroObras())
  ok(obra(O(1)).length === 1 && obra(O(1))[0].title === '🔁 Pedido disponível de novo: Pintura antiga' && !(await marca(O(1), 'obras')), 'obra, 08:00 (cronômetro): sai com o texto próprio', pushes.map(x => x.title))

  const errosReais = erros.filter(e => !/sem banco|migration|falha simulada/i.test(e))
  ok(errosReais.length === 0, 'nenhum erro logado', errosReais.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
