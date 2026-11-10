#!/usr/bin/env node
// (A) E-MAIL de demanda nova × teto diário (190 de demanda, dentro dos 250):
//     1. o que sobra do teto vai PRIMEIRO a quem não tem push_token;
//     2. o que o teto cortou (parcial ou total) fica marcado na demanda (email_novo_pendente_em) e
//        sai no dia seguinte, a partir das 08h, mais antiga primeiro, ANTES dos lembretes;
//     3. os lembretes "ainda aberto" têm sub-teto próprio de 60 dentro dos 190.
// (B) Obra criada pelo PAINEL: o push passa pelo claim (carimba push_novo_enviado_em) e a rede de
//     segurança não avisa de novo 10 minutos depois.
// (C) VALOR obrigatório e > 0 ao criar e ao editar serviço e obra: "Informe quanto quer pagar".
// SQL REAL num Postgres em memória (PGlite); Expo/Brevo falsos; NOW() sombreado por public.now().
//   npm i -D @electric-sql/pglite && node scripts/testar-emails-teto-valor.js
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
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async () => {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const erros = []
const silenciar = (v) => {
  console.log = v ? () => {} : logOrig
  console.warn = v ? () => {} : warnOrig
  console.error = v ? (...a) => { erros.push(a.map(x => x?.message || String(x)).join(' ')) } : errOrig
}
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const alerta = require(path.join(REPO, 'src/services/alertaService'))
const obrasCtrl = require(path.join(REPO, 'src/controllers/obrasController'))
const fa = require(path.join(REPO, 'src/utils/avisosForaDaArea'))
const { validarValorDemanda } = require(path.join(REPO, 'src/utils/valorDemanda'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 250))
const ordenado = (l) => [...l].sort()
const igual = (a, b) => JSON.stringify(ordenado(a)) === JSON.stringify(ordenado(b))
const fixarAgora = (iso) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${iso}'::timestamptz $$`)
const handler = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const chamar = (h, { usuario, params = {}, query = {}, body = {} }) => new Promise(resolve => {
  const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  Promise.resolve(h({ params, query, body, usuario, get: () => '', headers: {}, ip: '127.0.0.1' }, res)).catch(e => resolve({ status: 599, body: { erro: String(e.message) } }))
})
const DONO = { id: U(900), role: 'dono_obra', nome: 'Dona', email: 'dona@x.invalid' }
const ADM = { id: U(901), role: 'admin', nome: 'Admin', email: 'adm@x.invalid' }
// 20 reparadores de elétrica: U1..U12 COM token, U13..U20 SEM token (ids maiores, para a ordem
// "sem token primeiro" não se confundir com a ordem por id). 3 pintores para a obra do painel.
const COM_TOKEN = Array.from({ length: 12 }, (_, i) => U(i + 1))
const SEM_TOKEN = Array.from({ length: 8 }, (_, i) => U(i + 13))

const main = async () => {
  // ═══ (C) validador de valor — sem banco ═══════════════════════════════════════════════════
  for (const [v, esperado] of [[150, 150], ['150', 150], [' 99.90 ', 99.9], [0.5, 0.5]]) {
    ok(validarValorDemanda(v).valor === esperado, `valor ${JSON.stringify(v)} → aceito (${esperado})`, validarValorDemanda(v))
  }
  for (const v of [undefined, null, '', '   ', 0, '0', -5, '-1', 'abc', NaN, Infinity, true, [5], { v: 5 }]) {
    const r = validarValorDemanda(v)
    ok(r.erro === 'Informe quanto quer pagar' && r.codigo === 'VALOR_OBRIGATORIO' && !('valor' in r), `valor ${typeof v === 'number' ? String(v) : JSON.stringify(v)} → "Informe quanto quer pagar"`, r)
  }

  db = new PGlite()
  await db.exec(`SET search_path = public, pg_catalog`)
  await fixarAgora('2026-11-10T15:00:00Z') // terça, 12:00 em São Paulo
  const colsDemanda = `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), titulo text, descricao text, categoria text, cidade text, uf text, bairro text, criado_por uuid, status text DEFAULT 'aberta',
      status_aprovacao text DEFAULT 'aprovada', match_usuario_id uuid, expira_em timestamptz, criado_em timestamptz DEFAULT now(), publicado_em timestamptz,
      prestadores_bloqueados uuid[], codigo_publico text, push_novo_enviado_em timestamptz, email_novo_pendente_em timestamptz, tags text[], latitude numeric, longitude numeric,
      lembretes_enviados int DEFAULT 0, lembrete_enviado_em timestamptz, valor_aumentado_em timestamptz`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, latitude numeric, longitude numeric, raio_km_escolhido numeric, nome text, email text, cidade text, uf text, role text, tipo_prestador text, cpf_cnpj text, ativo boolean DEFAULT true,
      push_token text, suspenso_em timestamptz, desinstalado_em timestamptz, especialidades text[], indicacao_pedida_em timestamptz);
    CREATE TABLE assinaturas (usuario_id uuid, status text, proximo_vencimento timestamptz);
    CREATE TABLE reparos (${colsDemanda}, categorias text[], valor_estimado numeric, prazo_atendimento_horas numeric);
    CREATE TABLE obras (${colsDemanda}, valor numeric, horas_para_expirar numeric, metragem numeric, prazo_execucao_dias int, push_aprovada_enviado_em timestamptz, enviada_por_dono boolean);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, criado_em timestamptz DEFAULT now());
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, criado_em timestamptz DEFAULT now());
    CREATE TABLE prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid);
    CREATE TABLE lembretes_push_enviados (tabela text, demanda_id uuid, usuario_id uuid, motivo text, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE avisos_acima_do_teto (tabela text, demanda_id uuid, usuario_id uuid, criado_em timestamptz NOT NULL DEFAULT now(), resumo_em timestamptz, PRIMARY KEY (tabela, demanda_id, usuario_id));
    CREATE TABLE push_entregas (primeira_tentativa_em timestamptz NOT NULL DEFAULT now(), tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, ultima_tentativa_em timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz);
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true');
  `)
  // Responsabilidade pós-match (eventos_responsabilidade, dias_credito_*, aviso_resposta_final_em) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/responsabilidade')).migrarResponsabilidade(db)
  silenciar(true)
  await fa.migrarAvisosForaDaArea({ query: (s, p) => db.query(s, p) })
  silenciar(false)
  await db.query(`UPDATE usuarios SET avisos_todas_areas = false`)
  const usr = (id, nome, tipo, esp, token) => db.query(
    `INSERT INTO usuarios (id, nome, email, cidade, uf, role, tipo_prestador, cpf_cnpj, push_token, especialidades, avisos_todas_areas)
     VALUES ($1::uuid, $2, $3, 'Uberlândia', 'MG', 'prestador', $4, $5, $6, $7::text[], false)`,
    [id, nome, `${nome.toLowerCase().replace(/\s/g, '')}@x.invalid`, tipo, id.slice(-6), token, esp])
  for (const id of COM_TOKEN) await usr(id, `Rep ${id.slice(-2)}`, 'reparador', ['eletrica'], `ExponentPushToken[${id.slice(-3)}]`)
  for (const id of SEM_TOKEN) await usr(id, `Rep ${id.slice(-2)}`, 'reparador', ['eletrica'], null)
  for (const n of [31, 32, 33]) await usr(U(n), `Pintor ${n}`, 'pintor', ['pintor'], `ExponentPushToken[0${n}]`)
  await db.query(`INSERT INTO usuarios (id, nome, email, role, cidade, uf, cpf_cnpj) VALUES ($1, 'Dona', 'dona@x.invalid', 'dono_obra', 'Uberlândia', 'MG', '900'), ($2, 'Admin', 'adm@x.invalid', 'admin', NULL, NULL, NULL)`, [DONO.id, ADM.id])
  await db.query(`INSERT INTO assinaturas (usuario_id, status) SELECT id, 'ativa' FROM usuarios WHERE role = 'prestador'`)
  const reparo = (id, titulo, categoria = 'eletrica') => db.query(
    `INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, expira_em, push_novo_enviado_em)
     VALUES ($1::uuid, $2, $3, ARRAY[$3], 'Uberlândia', 'MG', 'Centro', $4::uuid, 150, 240, now() + INTERVAL '10 days', now())`, [id, titulo, categoria, DONO.id])
  const encher = (n, tipo = 'reparo') => db.query(
    `INSERT INTO email_alertas (tipo, demanda_id, usuario_id) SELECT $2, gen_random_uuid(), gen_random_uuid() FROM generate_series(1, $1::int)`, [n, tipo])
  const recebidos = async (id, tipo = 'reparo') => (await db.query(`SELECT usuario_id FROM email_alertas WHERE tipo = $2 AND demanda_id = $1`, [id, tipo])).rows.map(x => x.usuario_id)
  const pendente = async (tabela, id) => (await db.query(`SELECT email_novo_pendente_em FROM ${tabela} WHERE id = $1`, [id])).rows[0].email_novo_pendente_em
  const enviar = async (fn) => { silenciar(true); emails.length = 0; const r = await fn(); await assentar(); silenciar(false); return r }

  // ═══ (A1) sobra do teto → sem token primeiro; corte marca a demanda ═══════════════════════
  await encher(180)                       // 180 de 190 já gastos hoje
  await encher(40, 'aviso:qualquer#1')    // avisos críticos NÃO contam
  let o = await alerta.orcamentoEmailsDeDemanda()
  ok(o.restante === 10 && o.restanteLembretes === 10, 'orçamento: 180 gastos → restam 10; linhas "aviso:" não contam', o)
  await reparo(D(1), 'Trocar tomada')
  await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(1)))
  let r1 = await recebidos(D(1))
  ok(r1.length === 10 && emails.length === 10, 'D1 com 20 elegíveis e 10 de orçamento: saem 10 (não zero, não todos)', { claims: r1.length, enviados: emails.length })
  ok(SEM_TOKEN.every(id => r1.includes(id)), 'os 8 SEM token recebem primeiro', r1.filter(id => SEM_TOKEN.includes(id)).length)
  ok(igual(r1.filter(id => COM_TOKEN.includes(id)), [U(1), U(2)]), 'as 2 vagas restantes vão aos com token, por id', r1.filter(id => COM_TOKEN.includes(id)).map(x => x.slice(-2)))
  ok(await pendente('reparos', D(1)) !== null, 'corte PARCIAL: D1 fica marcada (email_novo_pendente_em)')
  await fixarAgora('2026-11-10T16:00:00Z')
  await reparo(D(2), 'Instalar chuveiro')
  await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(2)))
  ok((await recebidos(D(2))).length === 0 && emails.length === 0 && await pendente('reparos', D(2)) !== null,
     'D2 publicada com o teto ESGOTADO: zero e-mails hoje, mas fica marcada (antes era zero para sempre)')
  // mesmo dia: o cron não tem orçamento
  await enviar(() => alerta.enviarEmailsPendentesNovaDemanda())
  ok(emails.length === 0 && (await recebidos(D(1))).length === 10, 'cron no MESMO dia: sem orçamento, nada sai', emails.length)

  // ═══ (A2) dia seguinte: o que faltou sai, a partir das 08h, mais antiga primeiro ══════════
  await fixarAgora('2026-11-11T09:30:00Z') // quarta, 06:30 SP — orçamento novo, mas fora da janela
  await enviar(() => alerta.enviarEmailsPendentesNovaDemanda())
  ok(emails.length === 0, 'dia seguinte às 06:30: ainda não (e-mail atrasado só entre 08h e 20h)', emails.length)
  await fixarAgora('2026-11-11T11:05:00Z') // quarta, 08:05 SP
  await enviar(() => alerta.enviarEmailsPendentesNovaDemanda())
  r1 = await recebidos(D(1))
  const r2 = await recebidos(D(2))
  ok(r1.length === 20 && igual(r1, [...COM_TOKEN, ...SEM_TOKEN]), 'D1: os 10 que faltavam receberam — 20 de 20, ninguém em dobro', r1.length)
  ok(r2.length === 20, 'D2: os 20 receberam no dia seguinte', r2.length)
  ok(emails.length === 30, 'dia seguinte: 30 e-mails (10 + 20), nenhum repetido', emails.length)
  const ordem = (await db.query(`SELECT demanda_id, min(ctid::text) AS primeiro FROM email_alertas WHERE created_at = now() GROUP BY demanda_id`)).rows
  ok(await pendente('reparos', D(1)) === null && await pendente('reparos', D(2)) === null, 'as duas demandas saem da lista de pendentes', ordem.length)
  await enviar(() => alerta.enviarEmailsPendentesNovaDemanda())
  ok(emails.length === 0, 'tique seguinte: nada a reenviar', emails.length)

  // corte no dia seguinte: mais ANTIGA primeiro, e o resto segue marcado
  await fixarAgora('2026-11-12T15:00:00Z') // quinta 12:00
  await encher(190)
  await reparo(D(3), 'Mais antiga')
  await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(3)))
  await fixarAgora('2026-11-12T16:00:00Z')
  await reparo(D(4), 'Mais nova')
  await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(4)))
  await reparo(D(5), 'Marcada mas já com profissional')
  await db.query(`UPDATE reparos SET email_novo_pendente_em = now(), match_usuario_id = $2 WHERE id = $1`, [D(5), U(1)])
  ok((await recebidos(D(3))).length === 0 && (await recebidos(D(4))).length === 0, 'D3 e D4 publicadas com o teto esgotado: zero hoje')
  await fixarAgora('2026-11-13T12:00:00Z') // sexta 09:00
  await encher(165)                         // hoje só restam 25
  await enviar(() => alerta.enviarEmailsPendentesNovaDemanda())
  const r3 = await recebidos(D(3)), r4 = await recebidos(D(4))
  ok(r3.length === 20 && r4.length === 5, 'com 25 de orçamento: a mais ANTIGA (D3) recebe inteira e a mais nova (D4) fica com 5', { D3: r3.length, D4: r4.length })
  ok(r4.every(id => SEM_TOKEN.includes(id)), 'os 5 da D4 são de quem NÃO tem token', r4.map(x => x.slice(-2)))
  ok(await pendente('reparos', D(3)) === null && await pendente('reparos', D(4)) !== null, 'D3 quitada; D4 continua marcada para o dia seguinte')
  ok(await pendente('reparos', D(5)) === null && (await recebidos(D(5))).length === 0, 'demanda que já tem profissional perde a marca sem enviar nada')

  // ═══ (A3) sub-teto dos lembretes: 60 dentro dos 190 ═══════════════════════════════════════
  await fixarAgora('2026-11-14T15:00:00Z') // sábado 12:00, dia novo
  await encher(55, 'lembrete_reparo#1')
  o = await alerta.orcamentoEmailsDeDemanda()
  ok(o.restante === 135 && o.restanteLembretes === 5, 'orçamento: 55 lembretes hoje → lembretes só têm mais 5; demanda nova tem 135', o)
  const ladoLembrete = alerta.LADOS_LEMBRETE.find(l => l.tabela === 'reparos')
  const comoLembrete = (n) => ({ tipo: `${ladoLembrete.tipoEmail}#${n}`, mensagem: ladoLembrete.mensagem, interesse: ladoLembrete.interesse, somenteSemToken: true })
  await reparo(D(6), 'Aberta há dias')
  await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(6), comoLembrete(1)))
  ok((await recebidos(D(6), 'lembrete_reparo#1')).length === 5 && emails.length === 5, 'lembrete com 8 elegíveis (sem token): só 5 saem — sub-teto de 60', emails.length)
  ok(await pendente('reparos', D(6)) === null, 'lembrete cortado NÃO marca pendência (ele se repete sozinho)')
  await reparo(D(7), 'Outra aberta')
  await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(7), comoLembrete(1)))
  ok(emails.length === 0, 'sub-teto de lembretes esgotado (60): o próximo lembrete do dia não sai', emails.length)
  await reparo(D(8), 'Demanda nova no mesmo dia')
  await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(8)))
  ok((await recebidos(D(8))).length === 20 && await pendente('reparos', D(8)) === null,
     'demanda NOVA no mesmo dia recebe os 20 e-mails: os lembretes não a deixam mais sem orçamento', (await recebidos(D(8))).length)
  o = await alerta.orcamentoEmailsDeDemanda()
  ok(o.restante === 110 && o.restanteLembretes === 0 && alerta.EMAIL_ALERTAS_TETO_LEMBRETES === 60 && alerta.EMAIL_ALERTAS_TETO_DEMANDA === 190, 'orçamento ao fim: 80 gastos, lembretes zerados', o)

  // ═══ (B) obra criada pelo PAINEL: carimbo no claim, sem segundo push ══════════════════════
  await fixarAgora('2026-11-16T15:00:00Z') // segunda 12:00
  silenciar(true)
  pushes.length = 0; emails.length = 0
  const criada = await chamar(obrasCtrl.criar, { usuario: ADM, body: { titulo: 'Pintura de fachada', categoria: 'comercial', valor: 12000, cidade: 'Uberlândia', uf: 'MG', bairro: 'Centro' } })
  await assentar()
  silenciar(false)
  ok(criada.status === 201 && Number(criada.body.valor) === 12000, 'POST /obras (painel) com valor válido → 201', criada.status === 201 ? criada.body.titulo : criada.body)
  const obraId = criada.body.id
  const carimbo = (await db.query(`SELECT push_novo_enviado_em FROM obras WHERE id = $1`, [obraId])).rows[0]?.push_novo_enviado_em
  const pushNova = () => pushes.filter(p => p.data?.tipo === 'nova_obra' && p.data.obra_id === obraId && !p.data.fora_da_area)
  ok(pushNova().length === 3 && !!carimbo, 'obra do painel: push aos 3 pintores E push_novo_enviado_em carimbado', { pushes: pushNova().length, carimbo: !!carimbo })
  ok((await recebidos(obraId, 'obra')).length === 3, 'obra do painel: o e-mail sai junto (antes só saía depois da rede de segurança)', (await recebidos(obraId, 'obra')).length)
  await fixarAgora('2026-11-16T15:20:00Z') // 20 min depois: a rede de segurança roda
  silenciar(true)
  await alerta.enviarPushNovoPendente()
  await assentar()
  silenciar(false)
  ok(pushNova().length === 3, 'rede de segurança 20 min depois: NENHUM segundo push', pushNova().length)

  // ═══ (C) valor obrigatório nas rotas ══════════════════════════════════════════════════════
  const semValor = (r) => r.status === 400 && r.body.erro === 'Informe quanto quer pagar' && r.body.codigo === 'VALOR_OBRIGATORIO'
  const hReparo = handler('post', '/reparos/dono'), hObra = handler('post', '/obras/dono')
  silenciar(true)
  const antesReparos = (await db.query(`SELECT count(*)::int AS n FROM reparos`)).rows[0].n
  const antesObras = (await db.query(`SELECT count(*)::int AS n FROM obras`)).rows[0].n
  const casos = [['sem o campo', {}], ['0', { v: 0 }], ['"0"', { v: '0' }], ['vazio', { v: '' }], ['null', { v: null }], ['negativo', { v: -10 }], ['texto', { v: 'a combinar' }]]
  const resReparo = [], resObra = [], resPainel = []
  for (const [, c] of casos) {
    const corpo = 'v' in c ? { valor_estimado: c.v } : {}
    resReparo.push(await chamar(hReparo, { usuario: DONO, body: { titulo: 'Depilação na cera', categoria: 'depilacao', cidade: 'Uberlândia', uf: 'MG', ...corpo } }))
    const corpoObra = 'v' in c ? { valor: c.v } : {}
    resObra.push(await chamar(hObra, { usuario: DONO, body: { titulo: 'Reforma', categoria: 'residencial', cidade: 'Uberlândia', uf: 'MG', ...corpoObra } }))
    resPainel.push(await chamar(obrasCtrl.criar, { usuario: ADM, body: { titulo: 'Reforma', categoria: 'residencial', cidade: 'Uberlândia', uf: 'MG', ...corpoObra } }))
  }
  // com valor válido a criação passa DESTE ponto (cai na validação seguinte: cidade)
  const passaReparo = await chamar(hReparo, { usuario: DONO, body: { titulo: 'Depilação na cera', categoria: 'depilacao', valor_estimado: 80 } })
  const passaObra = await chamar(hObra, { usuario: DONO, body: { titulo: 'Reforma', categoria: 'residencial', valor: '5000' } })
  const anuncio = await chamar(hReparo, { usuario: DONO, body: { titulo: 'Vendo geladeira nova', categoria: 'outros', cidade: 'Uberlândia', uf: 'MG' } })
  silenciar(false)
  casos.forEach(([nome], i) => ok(semValor(resReparo[i]), `POST /reparos/dono com valor ${nome} → 400 "Informe quanto quer pagar"`, resReparo[i].body))
  casos.forEach(([nome], i) => ok(semValor(resObra[i]), `POST /obras/dono com valor ${nome} → 400 "Informe quanto quer pagar"`, resObra[i].body))
  casos.forEach(([nome], i) => ok(semValor(resPainel[i]), `POST /obras (painel) com valor ${nome} → 400 "Informe quanto quer pagar"`, resPainel[i].body))
  ok((await db.query(`SELECT count(*)::int AS n FROM reparos`)).rows[0].n === antesReparos && (await db.query(`SELECT count(*)::int AS n FROM obras`)).rows[0].n === antesObras, 'nenhuma demanda sem valor foi gravada')
  ok(passaReparo.status === 400 && passaReparo.body.erro === 'Cidade é obrigatória', 'serviço COM valor passa pela regra (cai na validação seguinte, de cidade)', passaReparo.body)
  ok(passaObra.body.codigo !== 'VALOR_OBRIGATORIO' && passaObra.body.erro !== 'Informe quanto quer pagar', 'obra COM valor (texto numérico "5000") passa pela regra', { status: passaObra.status, erro: passaObra.body.erro })
  ok(anuncio.status === 400 && anuncio.body.codigo !== 'VALOR_OBRIGATORIO' && !!anuncio.body.codigo, 'anúncio (palavra de venda + sem valor) continua recebendo a mensagem da moderação, não a de valor', anuncio.body)
  // edição
  silenciar(true)
  const ed0 = await chamar(obrasCtrl.editar, { usuario: ADM, params: { id: obraId }, body: { valor: 0 } })
  const edNeg = await chamar(obrasCtrl.editar, { usuario: ADM, params: { id: obraId }, body: { valor: '-3' } })
  const edOk = await chamar(obrasCtrl.editar, { usuario: ADM, params: { id: obraId }, body: { valor: 15000 } })
  const edOutro = await chamar(obrasCtrl.editar, { usuario: ADM, params: { id: obraId }, body: { bairro: 'Tibery' } })
  const aum0 = await chamar(handler('post', '/reparos/:id/aumentar-valor'), { usuario: DONO, params: { id: D(8) }, body: { valor: 0 } })
  const aumObra = await chamar(handler('post', '/obras/:id/aumentar-valor'), { usuario: DONO, params: { id: obraId }, body: {} })
  silenciar(false)
  ok(semValor(ed0) && semValor(edNeg), 'PUT /obras/:id (painel) com valor 0 ou negativo → 400 "Informe quanto quer pagar"', [ed0.body, edNeg.body])
  const valorAgora = Number((await db.query(`SELECT valor FROM obras WHERE id = $1`, [obraId])).rows[0].valor)
  ok(edOk.status === 200 && edOutro.status === 200 && valorAgora === 15000, 'PUT /obras/:id com valor válido grava; edição de outro campo não mexe no valor', { ok: edOk.status, outro: edOutro.status, valor: valorAgora })
  ok(aum0.status === 400 && aum0.body.erro === 'Informe quanto quer pagar' && aum0.body.codigo === 'VALOR_INVALIDO', 'POST /reparos/:id/aumentar-valor com 0 → 400 com a mesma mensagem (código VALOR_INVALIDO mantido)', aum0.body)
  ok(aumObra.status === 400 && aumObra.body.erro === 'Informe quanto quer pagar', 'POST /obras/:id/aumentar-valor sem valor → 400 com a mesma mensagem', aumObra.body)

  const inesperados = erros.filter(e => !/sem banco|PAGBANK|migration|Moderacao|moderação/i.test(e))
  ok(inesperados.length === 0, 'nenhum erro logado', inesperados.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error = errOrig; console.error('ERRO', e); process.exit(1) })
