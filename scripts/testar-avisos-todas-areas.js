#!/usr/bin/env node
// Aviso "FORA DA SUA ÁREA" (decisão do dono, 09/11/2026): quando um serviço ou uma obra é publicado,
// os profissionais da MESMA CIDADE que não estão no público normal e têm
// usuarios.avisos_todas_areas = true (DEFAULT TRUE para todos) recebem SÓ PUSH:
//   "📣 Pedido em <cidade> (fora da sua área)" / "<emoji> <título> · <bairro> · R$ <valor>. Sabe
//   fazer ou conhece quem faz? Toque para ver."
// Cobre: migração (coluna, backfill único, chave de config), preferência no login/perfil e
// PUT /auth/perfil, público (fora do normal por PESSOA, um por pessoa, suspensão e bloqueios por
// pessoa), nenhum e-mail, horário de silêncio (08–20h SP, adiado para o cron), uma vez por demanda,
// teto diário por pessoa (limite_avisos_fora_area_dia; 0 = sem limite) e os endpoints do painel.
// SQL REAL num Postgres em memória (PGlite); Expo/Brevo falsos; NOW() sombreado por public.now().
//   npm i -D @electric-sql/pglite && node scripts/testar-avisos-todas-areas.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

const pushes = []
const emails = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { pushes.push(...chunk); return chunk.map((_, i) => ({ status: 'ok', id: `t${pushes.length}-${i}` })) }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
const shim = {
  query: (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return db.query(sql, params) },
  connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: (s, p) => db.query(s, p), release() {} } },
  on() {},
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) }, enviarEmailComAnexo: async () => {} }
  if (/utils[\\/]plataforma$/.test(request)) return { ...origLoad.apply(this, arguments), registrarPlataforma() {}, detectarPlataforma() { return false } }
  if (/utils[\\/]desinstalacoes$/.test(request)) return { ...origLoad.apply(this, arguments), registrarReinstalacao() {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error
const erros = []
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.error = v ? (...a) => { erros.push(a.join(' ')) } : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const authCtrl = require(path.join(REPO, 'src/controllers/authController'))
const alerta = require(path.join(REPO, 'src/services/alertaService'))
const fa = require(path.join(REPO, 'src/utils/avisosForaDaArea'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 200))
const tok = (id) => `ExponentPushToken[${id.slice(-3)}]`
const ordenado = (l) => [...l].sort()
const igual = (a, b) => JSON.stringify(ordenado(a)) === JSON.stringify(ordenado(b))
// 2026-11-10 é terça. Horário de Brasília = UTC-3.
const fixarAgora = (iso) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${iso}'::timestamptz $$`)
const handler = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const chamar = (h, { usuario, params = {}, query = {}, body = {} }) => new Promise(resolve => {
  const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  h({ params, query, body, usuario, get: () => '', headers: {}, ip: '127.0.0.1' }, res)
})

// Todos em Uberlândia/MG, assinatura ativa, token, avisos_todas_areas no padrão (TRUE), salvo a observação.
const C = {
  DONO: { n: 1,  role: 'dono_obra', cpf: '100.100.100-10' },
  RE:   { n: 2,  tipo: 'reparador', esp: ['eletrica'],           cpf: '02' },  // público NORMAL do serviço de elétrica
  RG:   { n: 3,  tipo: 'reparador', esp: ['climatizacao'],       cpf: '03' },  // normal pelo GRUPO de elétrica
  RF:   { n: 4,  tipo: 'reparador', esp: ['faxina'],             cpf: '04' },  // fora da área no serviço E na obra
  PN:   { n: 5,  tipo: 'pintor',    esp: ['pintor'],             cpf: '05' },  // fora da área no serviço; normal na obra
  PS:   { n: 6,  tipo: 'pintor',    esp: ['pintor', 'eletrica'], cpf: '06' },  // pintor com elétrica: normal nos dois
  OFF:  { n: 7,  tipo: 'reparador', esp: ['faxina'],             cpf: '07', avisos: false },   // desligou o aviso
  SUS:  { n: 8,  tipo: 'reparador', esp: ['faxina'],             cpf: '08', suspenso: true },
  DP:   { n: 9,  tipo: 'pintor',    esp: ['pintor'],             cpf: '111.111.111-11' },      // PESSOA "D": a conta irmã está no público normal
  DR:   { n: 10, tipo: 'reparador', esp: ['eletrica'],           cpf: '11111111111' },
  TP:   { n: 11, tipo: 'pintor',    esp: ['pintor'],             cpf: '222.222.222-22' },      // PESSOA "T": as duas contas fora da área no serviço
  TR:   { n: 12, tipo: 'reparador', esp: ['faxina'],             cpf: '22222222222' },
  SP:   { n: 13, tipo: 'pintor',    esp: ['pintor'],             cpf: '333.333.333-33' },      // PESSOA "S": conta irmã SUSPENSA
  SR:   { n: 14, tipo: 'reparador', esp: ['faxina'],             cpf: '33333333333', suspenso: true },
  BP:   { n: 15, tipo: 'pintor',    esp: ['pintor'],             cpf: '444.444.444-44' },      // PESSOA "B": o dono bloqueou a conta irmã
  BR:   { n: 16, tipo: 'reparador', esp: ['faxina'],             cpf: '44444444444', semToken: true },
  LN:   { n: 17, tipo: 'reparador', esp: ['faxina'],             cpf: '17' },  // entra na lista negra de uma demanda
  FORA: { n: 18, tipo: 'reparador', esp: ['faxina'],             cpf: '18', cidade: 'Uberaba' },
  SASS: { n: 19, tipo: 'reparador', esp: ['faxina'],             cpf: '19', assinatura: 'cancelada' },
  STOK: { n: 20, tipo: 'pintor',    esp: ['pintor'],             cpf: '20', semToken: true },  // sem token: não recebe (nem por e-mail)
  NL:   { n: 21, tipo: null,        esp: ['faxina'],             cpf: '21' },  // legado, tipo NULL
  CR:   { n: 22, tipo: 'reparador', esp: ['faxina'],             cpf: '10010010010' },         // conta profissional do PRÓPRIO criador
  ADM:  { n: 23, role: 'admin', cpf: null },
}
Object.values(C).forEach(c => { c.id = U(c.n) })
const nomes = (tokens) => ordenado(tokens.map(t => Object.entries(C).find(([, c]) => tok(c.id) === t)?.[0] || t))

const main = async () => {
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, categoria text, cidade text, uf text, bairro text, criado_por uuid, status text DEFAULT 'aberta',
      status_aprovacao text DEFAULT 'aprovada', match_usuario_id uuid, expira_em timestamptz, criado_em timestamptz, publicado_em timestamptz,
      prestadores_bloqueados uuid[], codigo_publico text, push_novo_enviado_em timestamptz`
  // Esquema de ANTES da funcionalidade: a migração (os MESMOS statements do boot) é quem cria o resto.
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, telefone text, cidade text, uf text, role text, tipo_dono text, tipo_prestador text, cpf_cnpj text,
      ativo boolean DEFAULT true, push_token text, criado_em timestamptz, suspenso_em timestamptz, suspenso_motivo text, desinstalado_em timestamptz,
      foto_url text, senha_hash text, boas_vindas_exibida boolean DEFAULT false, token_version int NOT NULL DEFAULT 1, verificacao_status text DEFAULT 'aprovado',
      referencias jsonb, especialidades text[], anos_experiencia int, tamanho_equipe int, aceita_promocoes boolean, indicacao_pedida_em timestamptz);
    CREATE TABLE assinaturas (usuario_id uuid, plano text, valor_mensal numeric, status text, tipo text, proximo_vencimento timestamptz, criado_em timestamptz);
    CREATE TABLE obras (${colsDemanda}, valor numeric);
    CREATE TABLE reparos (${colsDemanda}, categorias text[], valor_estimado numeric);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, criado_em timestamptz);
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, criado_em timestamptz);
    CREATE TABLE avaliacoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contrato_tipo text, contrato_id uuid, avaliador_id uuid, avaliado_id uuid, estrelas int, etiquetas text[], criado_em timestamptz);
    CREATE TABLE prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid, UNIQUE (dono_id, prestador_id));
    CREATE TABLE push_entregas (tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, ultima_tentativa_em timestamptz, UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT '2026-11-10T15:00:00Z', UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz);
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true'), ('multiplas_contas', 'true');
    SET search_path = public, pg_catalog;
  `)
  await fixarAgora('2026-11-10T15:00:00Z') // terça, 12:00 em São Paulo — dentro da janela
  for (const [nome, c] of Object.entries(C)) {
    const role = c.role || 'prestador'
    await db.query(
      `INSERT INTO usuarios (id, nome, email, telefone, cidade, uf, role, tipo_prestador, cpf_cnpj, push_token, suspenso_em, especialidades, referencias)
       VALUES ($1::uuid, $2, $3, '34999990000', $4, 'MG', $5, $6, $7, $8, ${c.suspenso ? `'2026-11-01T12:00:00Z'` : 'NULL'}, $9::text[], '[]'::jsonb)`,
      [c.id, `${nome} Teste`, `${nome.toLowerCase()}@x.invalid`, c.cidade || 'Uberlândia', role, c.tipo ?? null, c.cpf, c.semToken ? null : tok(c.id), c.esp ?? null])
    if (role === 'prestador') await db.query(`INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo) VALUES ($1::uuid, 'mensal', 49.90, $2, 'gratuito')`, [c.id, c.assinatura || 'ativa'])
  }
  const { DONO, RE, RG, RF, PN, PS, OFF, SUS, DP, DR, TP, TR, SP, SR, BP, BR, LN, FORA, SASS, STOK, NL, CR, ADM } = C
  const reparo = (id, titulo, categoria, { anunciado = null, valor = 150, bairro = 'Centro' } = {}) => db.query(
    `INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, expira_em, criado_em, push_novo_enviado_em)
     VALUES ($1::uuid, $2, $3, ARRAY[$3], 'Uberlândia', 'MG', $4, $5::uuid, $6, now() + INTERVAL '2 days', now(), $7::timestamptz)`, [id, titulo, categoria, bairro, DONO.id, valor, anunciado])
  const obra = (id, titulo, { anunciado = null, valor = 8000 } = {}) => db.query(
    `INSERT INTO obras (id, titulo, categoria, cidade, uf, bairro, criado_por, valor, expira_em, criado_em, publicado_em, push_novo_enviado_em)
     VALUES ($1::uuid, $2, 'residencial', 'Uberlândia', 'MG', 'Santa Mônica', $3::uuid, $4, now() + INTERVAL '20 days', now(), now(), $5::timestamptz)`, [id, titulo, DONO.id, valor, anunciado])

  // ═══ 1. Migração: coluna DEFAULT TRUE, backfill ÚNICO das já anunciadas, chave do teto ═════
  await reparo(D(90), 'Antigo já anunciado', 'faxina', { anunciado: '2026-11-10T14:00:00Z' })
  await reparo(D(91), 'Antigo ainda não anunciado', 'faxina')
  const cliente = { query: (s, p) => db.query(s, p) }
  silenciar(true)
  await fa.migrarAvisosForaDaArea(cliente)
  silenciar(false)
  let r = await db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE avisos_todas_areas)::int AS ligados FROM usuarios`)
  ok(r.rows[0].n === Object.keys(C).length && r.rows[0].ligados === r.rows[0].n, 'migração: avisos_todas_areas = TRUE para TODOS os usuários existentes', r.rows[0])
  r = await db.query(`SELECT id, aviso_fora_area_em IS NOT NULL AS marcado FROM reparos ORDER BY id`)
  ok(r.rows.find(x => x.id === D(90)).marcado === true && r.rows.find(x => x.id === D(91)).marcado === false,
     'backfill: demanda JÁ anunciada fica marcada (não dispara no deploy); a ainda não anunciada fica NULL', r.rows.map(x => x.marcado))
  ok(await fa.lerLimiteAvisosForaDaArea() === 0, 'chave limite_avisos_fora_area_dia nasce 0 (sem limite)')
  await reparo(D(92), 'Anunciado depois do 1º boot', 'faxina', { anunciado: '2026-11-10T14:30:00Z' })
  await db.query(`UPDATE configuracoes SET valor = '3' WHERE chave = 'limite_avisos_fora_area_dia'`)
  silenciar(true)
  await fa.migrarAvisosForaDaArea(cliente)   // 2º boot: idempotente
  silenciar(false)
  r = await db.query(`SELECT aviso_fora_area_em FROM reparos WHERE id = $1`, [D(92)])
  ok(r.rows[0].aviso_fora_area_em === null && await fa.lerLimiteAvisosForaDaArea() === 3, '2º boot: o backfill NÃO roda de novo e o teto gravado pelo painel é preservado')
  await db.query(`UPDATE configuracoes SET valor = '0' WHERE chave = 'limite_avisos_fora_area_dia'`)
  await db.query(`DELETE FROM reparos`)
  await db.query(`INSERT INTO usuarios (id, nome, role, tipo_prestador, cidade, uf) VALUES ($1, 'Novo depois da migração', 'prestador', 'reparador', 'Uberlândia', 'MG')`, [U(99)])
  r = await db.query(`SELECT avisos_todas_areas FROM usuarios WHERE id = $1`, [U(99)])
  ok(r.rows[0].avisos_todas_areas === true, 'conta NOVA nasce com avisos_todas_areas = TRUE (DEFAULT da coluna)')
  await db.query(`DELETE FROM usuarios WHERE id = $1`, [U(99)])
  await db.query(`UPDATE usuarios SET avisos_todas_areas = false WHERE id = $1`, [OFF.id])

  // ═══ 2. Preferência: login, perfil e PUT /auth/perfil ═════════════════════════════════════
  const linha = async (id) => (await db.query(`SELECT * FROM usuarios WHERE id = $1`, [id])).rows[0]
  const sessao = async (c) => (await authCtrl.montarSessao(await linha(c.id), { headers: {}, get: () => '' })).usuario
  ok((await sessao(RF)).avisos_todas_areas === true && (await sessao(OFF)).avisos_todas_areas === false, 'login (montarSessao): avisos_todas_areas true por padrão; false para quem desligou')
  const semCampo = { ...(await linha(RF.id)) }; delete semCampo.avisos_todas_areas
  ok((await authCtrl.montarSessao(semCampo, { headers: {}, get: () => '' })).usuario.avisos_todas_areas === true, 'linha sem o campo (conta vinculada recém-criada) → true')
  r = await chamar(authCtrl.perfil, { usuario: await linha(OFF.id) })
  ok(r.status === 200 && r.body.usuario.avisos_todas_areas === false, 'GET /auth/perfil devolve avisos_todas_areas', r.body.usuario?.avisos_todas_areas)
  r = await chamar(authCtrl.atualizarPerfil, { usuario: await linha(PN.id), body: { avisos_todas_areas: false } })
  ok(r.status === 200 && r.body.avisos_todas_areas === false && (await linha(PN.id)).avisos_todas_areas === false && r.body.especialidades.join() === 'pintor',
     'PUT /auth/perfil { avisos_todas_areas: false } (só esse campo) → 200, gravado, resto intacto', r.body)
  r = await chamar(authCtrl.atualizarPerfil, { usuario: await linha(PN.id), body: { nome: 'PN Outro Nome' } })
  ok(r.status === 200 && r.body.avisos_todas_areas === false, 'PUT /auth/perfil sem o campo não mexe na preferência', r.body.avisos_todas_areas)
  for (const ruim of ['false', 0, null, 'sim']) {
    r = await chamar(authCtrl.atualizarPerfil, { usuario: await linha(PN.id), body: { avisos_todas_areas: ruim } })
    ok(r.status === 400, `PUT /auth/perfil com avisos_todas_areas = ${JSON.stringify(ruim)} → 400 (só booleano)`, r.body)
  }
  r = await chamar(authCtrl.atualizarPerfil, { usuario: await linha(PN.id), body: { avisos_todas_areas: true } })
  ok(r.status === 200 && r.body.avisos_todas_areas === true, 'PUT /auth/perfil religa', r.body.avisos_todas_areas)

  // ═══ 3. Serviço publicado: público normal × fora da área ══════════════════════════════════
  await db.query(`INSERT INTO prestadores_bloqueados_dono (dono_id, prestador_id) VALUES ($1, $2)`, [DONO.id, BR.id])
  const publicar = async (tabela, id) => {
    silenciar(true)
    pushes.length = 0; emails.length = 0
    const enviou = await alerta.dispararPushNovoComClaim(tabela, id, tabela === 'obras' ? alerta.notificarPintoresSobreNovaObra : alerta.notificarPrestadoresSobreNovoReparo)
    await assentar()
    silenciar(false)
    const fora = pushes.filter(p => p.data?.fora_da_area === true)
    const normal = pushes.filter(p => !p.data?.fora_da_area)
    return { enviou, fora, normal, foraNomes: nomes(fora.map(p => p.to)), normalNomes: nomes(normal.map(p => p.to)) }
  }
  await reparo(D(1), 'Trocar tomada', 'eletrica')
  await db.query(`UPDATE reparos SET prestadores_bloqueados = ARRAY[$2::uuid] WHERE id = $1`, [D(1), LN.id])
  let p = await publicar('reparos', D(1))
  ok(p.enviou === true && igual(p.normalNomes, ['DR', 'PS', 'RE', 'RG']), 'serviço de elétrica — público NORMAL inalterado: elétrica, grupo, pintor com elétrica', p.normalNomes)
  ok(igual(p.foraNomes, ['PN', 'RF', 'TR']),
     'FORA DA ÁREA: reparador de faxina (RF), pintor sem serviço (PN) e a pessoa T UMA vez (TR) — e mais ninguém', p.foraNomes)
  ok(!p.foraNomes.includes('DP'), 'pessoa cuja OUTRA conta está no público normal (DP/DR) não recebe o aviso de "fora da área"')
  ok(!p.foraNomes.includes('OFF'), 'quem desligou avisos_todas_areas não recebe')
  ok(!p.foraNomes.includes('SUS') && !p.foraNomes.includes('SP'), 'suspenso não recebe — nem pela conta irmã de uma pessoa suspensa (SP/SR)')
  ok(!p.foraNomes.includes('BP') && !p.foraNomes.includes('LN'), 'bloqueios: pessoa bloqueada pelo dono (via conta irmã BR) e conta na lista negra da demanda não recebem')
  ok(!p.foraNomes.some(n => ['FORA', 'SASS', 'NL', 'CR', 'DONO', 'ADM'].includes(n)), 'outra cidade, sem assinatura, tipo NULL, conta do próprio criador, dono e admin: nada')
  const av = p.fora.find(x => x.to === tok(RF.id))
  ok(av && av.title === '📣 Pedido em Uberlândia (fora da sua área)', 'título do push', av?.title)
  ok(av && av.body === '⚡ Trocar tomada · Centro · R$ 150. Sabe fazer ou conhece quem faz? Toque para ver.', 'corpo do push', av?.body)
  ok(av && av.data.tipo === 'novo_reparo' && av.data.reparo_id === D(1) && av.data.fora_da_area === true, 'data: mesmo tipo/id do aviso de serviço novo + fora_da_area', av?.data)
  // só push: nenhum e-mail a quem está fora da área, nada no teto do Brevo
  const emailados = (await db.query(`SELECT usuario_id FROM email_alertas WHERE demanda_id = $1`, [D(1)])).rows.map(x => x.usuario_id)
  ok(igual(emailados, [RE.id, RG.id, PS.id, DR.id]) && emails.length === 4, 'e-mail só ao público NORMAL (4): o aviso fora da área é SÓ PUSH e não gasta o teto do Brevo', { email_alertas: emailados.length, enviados: emails.length })
  ok(!p.fora.some(x => x.to === tok(STOK.id)) && !emailados.includes(STOK.id), 'fora da área SEM token: não recebe nada (não há e-mail de reserva)')
  const log = (await db.query(`SELECT usuario_id FROM avisos_fora_area WHERE tabela = 'reparos' AND demanda_id = $1`, [D(1)])).rows.map(x => x.usuario_id)
  ok(igual(log, [RF.id, PN.id, TR.id]), 'avisos_fora_area registra os 3 envios (base do teto diário)', log.length)
  const pe = (await db.query(`SELECT count(*)::int AS n FROM push_entregas WHERE demanda_id = $1`, [D(1)])).rows[0].n
  ok(pe === 4, 'push_entregas ("profissionais avisados") continua só com o público normal', pe)
  // uma vez por demanda
  silenciar(true)
  pushes.length = 0
  const denovo = await alerta.avisarForaDaAreaDemanda('reparos', D(1))
  await alerta.avisarForaDaArea()
  silenciar(false)
  ok(denovo === null && pushes.length === 0, 'uma vez por demanda: rechamar o gancho ou rodar o cron não reenvia', pushes.length)

  // ═══ 4. Obra publicada ════════════════════════════════════════════════════════════════════
  await obra(D(2), 'Reforma da casa')
  p = await publicar('obras', D(2))
  ok(igual(p.normalNomes, ['BP', 'DP', 'PN', 'PS', 'TP']), 'obra — público NORMAL: quem pode trabalhar em obras (pintores), um por pessoa', p.normalNomes)
  // LN entra: a lista negra dela é do serviço D(1), não desta obra.
  ok(igual(p.foraNomes, ['LN', 'RE', 'RF', 'RG']), 'obra — FORA DA ÁREA: reparadores sem especialidade de obra cuja pessoa não tem conta de pintor', p.foraNomes)
  ok(!p.foraNomes.includes('TR') && !p.foraNomes.includes('DR'), 'reparador cuja conta irmã é pintor (TR, DR) já está no público normal da obra: sem aviso')
  const avo = p.fora.find(x => x.to === tok(RE.id))
  ok(avo && avo.title === '📣 Pedido em Uberlândia (fora da sua área)' && avo.body === '🏠 Reforma da casa · Santa Mônica · R$ 8.000. Sabe fazer ou conhece quem faz? Toque para ver.',
     'obra: título e corpo (emoji da categoria da obra, bairro, valor)', avo && { titulo: avo.title, corpo: avo.body })
  ok(avo && avo.data.tipo === 'nova_obra' && avo.data.obra_id === D(2) && avo.data.fora_da_area === true, 'obra: data nova_obra + fora_da_area', avo?.data)
  const m = alerta.mensagemForaDaArea(alerta.LADOS_FORA_AREA.find(l => l.tabela === 'reparos'), { id: D(1), titulo: 'Sem bairro nem valor', cidade: 'Uberlândia', bairro: ' ', valor: null, categoria: 'faxina', categorias: ['faxina'] })
  ok(m.corpo === '🧹 Sem bairro nem valor. Sabe fazer ou conhece quem faz? Toque para ver.', 'corpo sem bairro e sem valor não deixa separador sobrando', m.corpo)

  // ═══ 5. Horário de silêncio (08–20h de São Paulo) ═════════════════════════════════════════
  await fixarAgora('2026-11-11T01:30:00Z') // terça, 22:30 em São Paulo
  await reparo(D(3), 'Vazamento à noite', 'hidraulica')
  p = await publicar('reparos', D(3))
  r = await db.query(`SELECT push_novo_enviado_em IS NOT NULL AS anunciado, aviso_fora_area_em FROM reparos WHERE id = $1`, [D(3)])
  ok(p.enviou === true && r.rows[0].anunciado && p.fora.length === 0 && r.rows[0].aviso_fora_area_em === null,
     '22:30: o aviso de demanda nova sai como sempre, o "fora da área" NÃO — e a demanda fica devida', { fora: p.fora.length })
  silenciar(true)
  pushes.length = 0
  await alerta.avisarForaDaArea()
  silenciar(false)
  ok(pushes.length === 0, 'cron às 22:30: nada', pushes.length)
  await fixarAgora('2026-11-11T11:05:00Z') // quarta, 08:05 em São Paulo
  silenciar(true)
  pushes.length = 0; emails.length = 0
  await alerta.avisarForaDaArea()
  await assentar()
  const manha = nomes(pushes.filter(x => x.data?.fora_da_area && x.data.reparo_id === D(3)).map(x => x.to))
  pushes.length = 0
  await alerta.avisarForaDaArea()
  silenciar(false)
  ok(manha.length > 0 && manha.includes('RF') && manha.includes('PN') && emails.length === 0, '08:05 do dia seguinte: o cron envia o aviso devido (só push)', manha)
  ok(pushes.length === 0, 'tique seguinte do cron: nada (claim por demanda)', pushes.length)
  // demanda que ficou devida além de 24h, casada ou encerrada: não avisa mais
  await reparo(D(4), 'Anunciado há 30h', 'faxina', { anunciado: '2026-11-10T05:00:00Z' })
  await reparo(D(5), 'Já casado', 'faxina', { anunciado: '2026-11-11T11:00:00Z' })
  await db.query(`UPDATE reparos SET match_usuario_id = $2 WHERE id = $1`, [D(5), RF.id])
  await reparo(D(6), 'Ainda não anunciado', 'faxina')
  silenciar(true)
  pushes.length = 0
  await alerta.avisarForaDaArea()
  silenciar(false)
  ok(pushes.length === 0, 'não avisa: anunciada há mais de 24h, com match, ou ainda não anunciada', pushes.map(x => x.data?.reparo_id))

  // ═══ 6. Teto diário por PESSOA (limite_avisos_fora_area_dia) e endpoints do painel ════════
  const hGet = handler('get', '/config/limite-avisos-fora-area')
  const hPost = handler('post', '/config/limite-avisos-fora-area')
  r = await chamar(hGet, { usuario: await linha(ADM.id) })
  ok(r.status === 200 && r.body.limite === 0, 'GET /config/limite-avisos-fora-area → 0 (sem limite)', r.body)
  for (const ruim of [-1, 1.5, 'abc', '', null, 5000]) {
    r = await chamar(hPost, { usuario: await linha(ADM.id), body: { limite: ruim } })
    ok(r.status === 400, `POST limite = ${JSON.stringify(ruim)} → 400`, r.body)
  }
  r = await chamar(hPost, { usuario: await linha(ADM.id), body: { limite: 2 } })
  ok(r.status === 200 && r.body.limite === 2 && await fa.lerLimiteAvisosForaDaArea() === 2, 'POST limite = 2 → gravado', r.body)
  // Quarta 08:05. Hoje (dia de SP): RF, PN e a pessoa T já receberam 1 aviso cada (o do cron da manhã, D3).
  await reparo(D(7), 'Segundo do dia', 'hidraulica')
  p = await publicar('reparos', D(7))
  ok(p.foraNomes.includes('RF') && p.foraNomes.includes('PN'), 'teto 2: o 2º aviso do dia ainda sai', p.foraNomes)
  await reparo(D(8), 'Terceiro do dia', 'eletrica')
  p = await publicar('reparos', D(8))
  ok(!p.foraNomes.includes('RF') && !p.foraNomes.includes('PN') && !p.foraNomes.includes('TR') && !p.foraNomes.includes('TP'),
     'teto 2 atingido: o 3º aviso do dia NÃO sai (pessoa T contada pelas duas contas)', p.foraNomes)
  ok(p.normalNomes.length > 0, 'o teto não toca o aviso NORMAL de demanda nova', p.normalNomes)
  // por pessoa: os 2 de hoje da pessoa T foram pela conta TR; tirando o token dela, a TP não "ganha" um 3º
  await db.query(`UPDATE usuarios SET push_token = NULL WHERE id = $1`, [TR.id])
  await reparo(D(9), 'Quarto do dia', 'hidraulica')
  p = await publicar('reparos', D(9))
  ok(!p.foraNomes.includes('TP'), 'teto é da PESSOA: a outra conta (TP) não recebe depois de a conta TR ter esgotado o dia', p.foraNomes)
  await db.query(`UPDATE usuarios SET push_token = $2 WHERE id = $1`, [TR.id, tok(TR.id)])
  // dia seguinte: zera
  await fixarAgora('2026-11-12T15:00:00Z') // quinta, 12:00 SP
  await reparo(D(10), 'No dia seguinte', 'hidraulica')
  p = await publicar('reparos', D(10))
  ok(p.foraNomes.includes('RF') && p.foraNomes.includes('PN') && p.foraNomes.includes('TR'), 'dia seguinte (São Paulo): o teto zera', p.foraNomes)
  r = await chamar(hPost, { usuario: await linha(ADM.id), body: { limite: '0' } })
  ok(r.status === 200 && r.body.limite === 0, 'POST limite = "0" → sem limite', r.body)
  for (const n of [11, 12, 13]) await reparo(D(n), `Sem limite ${n}`, 'hidraulica')
  let recebidos = 0
  for (const n of [11, 12, 13]) { p = await publicar('reparos', D(n)); if (p.foraNomes.includes('RF')) recebidos++ }
  ok(recebidos === 3, 'limite 0: todos os avisos do dia saem', recebidos)
  // limpeza do log antigo (cron)
  await fixarAgora('2026-11-25T15:00:00Z')
  silenciar(true)
  await alerta.avisarForaDaArea()
  silenciar(false)
  r = await db.query(`SELECT count(*)::int AS n FROM avisos_fora_area`)
  ok(r.rows[0].n === 0, 'cron limpa o log com mais de 7 dias', r.rows[0].n)

  const inesperados = erros.filter(e => !/sem banco|PAGBANK|migration/i.test(e))
  ok(inesperados.length === 0, 'nenhum erro logado durante os envios', inesperados.slice(0, 3))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error = errOrig; console.error('ERRO', e); process.exit(1) })
