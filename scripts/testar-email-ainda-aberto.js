#!/usr/bin/env node
// E-mail com texto de demanda NOVA que sai TARDE usa o texto "ainda aberto" (alertaService,
// montarEmailNovaDemanda): assunto "⏳ Pedido ainda aberto: <título>", corpo
// "\"<título>\" em <cidade> ainda está esperando profissional — categoria: <categoria>." e o MESMO
// botão. Vale para o que ficou para o dia seguinte (email_novo_pendente_em, cron das 08h — sempre,
// mesmo < 6 h) e para qualquer envio > 6 h depois do anúncio (push_novo_enviado_em; sem ele, a
// publicação). Obras e reparos. O lembrete (mensagem própria) não muda.
// SQL REAL em PGlite; Expo/Brevo falsos; NOW() sombreado por public.now().
//   npm i -D @electric-sql/pglite && node scripts/testar-email-ainda-aberto.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

const emails = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { return chunk.map((_, i) => ({ status: 'ok', id: `t${i}` })) }
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
const alerta = require(path.join(REPO, 'src/services/alertaService'))
const fa = require(path.join(REPO, 'src/utils/avisosForaDaArea'))
const { apresentacaoObra, apresentacaoReparoLista } = require(path.join(REPO, 'src/utils/categoriasApp'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 200))
const fixarAgora = (iso) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${iso}'::timestamptz $$`)
const DONO = U(900)
const NOVO_SERVICO = /Novo serviço disponível!$/
const NOVA_OBRA = /Nova obra disponível!$/
const html2txt = (h) => String(h).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

const main = async () => {
  db = new PGlite()
  await db.exec(`SET search_path = public, pg_catalog`)
  await fixarAgora('2026-11-10T15:00:00Z') // terça 12:00 SP
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
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz);
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true');
  `)
  await require(path.join(REPO, 'src/utils/responsabilidade')).migrarResponsabilidade(db)
  await require(path.join(REPO, 'src/utils/especialidadesInferidas')).migrarEspecialidadesInferidas(db)
  silenciar(true)
  await fa.migrarAvisosForaDaArea({ query: (s, p) => db.query(s, p) })
  silenciar(false)
  // 1 reparador de elétrica e 1 pintor, ambos sem token (e-mail sempre sai para eles).
  await db.query(`INSERT INTO usuarios (id, nome, email, cidade, uf, role, tipo_prestador, cpf_cnpj, especialidades, avisos_todas_areas) VALUES
    ($1::uuid, 'Rui Reparador', 'rui@x.invalid', 'Uberlândia', 'MG', 'prestador', 'reparador', '111', ARRAY['eletrica'], false),
    ($2::uuid, 'Pia Pintora',   'pia@x.invalid', 'Uberlândia', 'MG', 'prestador', 'pintor',    '222', ARRAY['pintor'],   false),
    ($3::uuid, 'Dona',          'dona@x.invalid','Uberlândia', 'MG', 'dono_obra', NULL,        '900', NULL,              false)`, [U(1), U(2), DONO])
  await db.query(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1::uuid, 'ativa'), ($2::uuid, 'ativa')`, [U(1), U(2)])

  // anunciadaHa: horas desde o anúncio (push_novo_enviado_em); null = sem carimbo. criadaHa: idade da linha.
  const reparo = (id, titulo, { anunciadaHa = 0, criadaHa = 0 } = {}) => db.query(
    `INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, expira_em, criado_em, push_novo_enviado_em, codigo_publico)
     VALUES ($1::uuid, $2, 'eletrica', ARRAY['eletrica'], 'Uberlândia', 'MG', 'Centro', $3::uuid, 150, 240, now() + INTERVAL '10 days',
             now() - make_interval(hours => $4::int), CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(mins => $5::int) END, 'ABCDE')`,
    [id, titulo, DONO, criadaHa, anunciadaHa === null ? null : Math.round(anunciadaHa * 60)])
  const obra = (id, titulo, categoria, { anunciadaHa = 0 } = {}) => db.query(
    `INSERT INTO obras (id, titulo, categoria, cidade, uf, bairro, criado_por, valor, expira_em, criado_em, publicado_em, push_novo_enviado_em)
     VALUES ($1::uuid, $2, $3, 'Uberlândia', 'MG', 'Centro', $4::uuid, 900, now() + INTERVAL '10 days', now() - INTERVAL '2 days', now() - INTERVAL '2 days',
             now() - make_interval(mins => $5::int))`,
    [id, titulo, categoria, DONO, Math.round(anunciadaHa * 60)])
  const enviar = async (fn) => { silenciar(true); emails.length = 0; await fn(); await assentar(); silenciar(false); return [...emails] }
  const rotuloReparo = apresentacaoReparoLista({ categoria: 'eletrica', categorias: ['eletrica'] }, '🔧').rotulo
  const corpoReparo = (t) => `"${t}" em Uberlândia ainda está esperando profissional — categoria: ${rotuloReparo}.`

  // ── reparo anunciado agora: texto de sempre ──
  await reparo(D(1), 'Trocar tomada')
  let m = await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(1)))
  ok(m.length === 1 && NOVO_SERVICO.test(m[0].assunto), 'reparo anunciado agora: "Novo serviço disponível!"', m.map(x => x.assunto))
  const botaoNovo = (m[0]?.html.match(/href="([^"]+)"/) || [])[1]

  // ── 5h59 depois do anúncio: ainda "Novo" ──
  await reparo(D(2), 'Quase seis horas', { anunciadaHa: 5.98, criadaHa: 6 })
  m = await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(2)))
  ok(m.length === 1 && NOVO_SERVICO.test(m[0].assunto), 'anunciado há 5h59: ainda "Novo serviço disponível!"', m.map(x => x.assunto))

  // ── 7 h depois do anúncio: "ainda aberto", mesmo botão ──
  await reparo(D(3), 'Instalar chuveiro', { anunciadaHa: 7, criadaHa: 7 })
  m = await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(3)))
  ok(m.length === 1 && m[0].assunto === '⏳ Pedido ainda aberto: Instalar chuveiro', 'reparo anunciado há 7 h: assunto "⏳ Pedido ainda aberto: <título>"', m.map(x => x.assunto))
  ok(m.length === 1 && html2txt(m[0].html).includes(`<p>${corpoReparo('Instalar chuveiro')}</p>`), 'corpo exato com cidade e categoria', html2txt(m[0]?.html).match(/<p>"[^<]*<\/p>/)?.[0])
  ok(m.length === 1 && !/disponível!/.test(m[0].html) && (m[0].html.match(/href="([^"]+)"/) || [])[1] === botaoNovo && m[0].html.includes('>Ver o pedido<'),
     'nenhum "disponível!" no HTML; mesmo botão/link do e-mail de demanda nova', (m[0]?.html.match(/href="([^"]+)"/) || [])[1])

  // ── sem carimbo de anúncio: âncora = criação ──
  await reparo(D(4), 'Sem carimbo velho', { anunciadaHa: null, criadaHa: 8 })
  m = await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(4)))
  ok(m.length === 1 && m[0].assunto === '⏳ Pedido ainda aberto: Sem carimbo velho', 'sem push_novo_enviado_em e criado há 8 h: "ainda aberto"', m.map(x => x.assunto))
  // aprovação manual hoje de um reparo criado ontem: o anúncio (agora) manda — texto "Novo"
  await reparo(D(5), 'Aprovado agora', { anunciadaHa: 0, criadaHa: 20 })
  m = await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(5)))
  ok(m.length === 1 && NOVO_SERVICO.test(m[0].assunto), 'criado há 20 h mas anunciado agora (aprovação manual): "Novo"', m.map(x => x.assunto))

  // ── obras ──
  await obra(D(11), 'Pintar fachada', 'pintura', { anunciadaHa: 0 })
  m = await enviar(() => alerta.enviarEmailsNovaDemanda('obras', D(11)))
  ok(m.length === 1 && NOVA_OBRA.test(m[0].assunto), 'obra anunciada agora: "Nova obra disponível!"', m.map(x => x.assunto))
  await obra(D(12), 'Pintar muro', 'pintura', { anunciadaHa: 9 })
  m = await enviar(() => alerta.enviarEmailsNovaDemanda('obras', D(12)))
  const rotuloObra = apresentacaoObra('pintura', '🎨').rotulo
  ok(m.length === 1 && m[0].assunto === '⏳ Pedido ainda aberto: Pintar muro'
     && html2txt(m[0].html).includes(`<p>"Pintar muro" em Uberlândia ainda está esperando profissional${rotuloObra ? ` — categoria: ${rotuloObra}` : ''}.</p>`),
     'obra anunciada há 9 h: assunto e corpo "ainda aberto"', { assunto: m[0]?.assunto, rotuloObra })
  await obra(D(13), 'Obra sem categoria', null, { anunciadaHa: 9 })
  m = await enviar(() => alerta.enviarEmailsNovaDemanda('obras', D(13)))
  ok(m.length === 1 && html2txt(m[0].html).includes('<p>"Obra sem categoria" em Uberlândia ainda está esperando profissional.</p>'), 'obra sem categoria: corpo sem o trecho de categoria', html2txt(m[0]?.html).match(/<p>"[^<]*<\/p>/)?.[0])

  // ── adiado (email_novo_pendente_em → cron das 08h): "ainda aberto" mesmo com < 6 h ──
  await fixarAgora('2026-11-11T12:00:00Z') // quarta 09:00 SP
  await db.query(`INSERT INTO email_alertas (tipo, demanda_id, usuario_id) SELECT 'reparo', gen_random_uuid(), gen_random_uuid() FROM generate_series(1, 190)`)
  await reparo(D(6), 'Cortado pelo teto', { anunciadaHa: 0 })
  m = await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(6)))
  const marca = (await db.query(`SELECT email_novo_pendente_em FROM reparos WHERE id = $1`, [D(6)])).rows[0].email_novo_pendente_em
  ok(m.length === 0 && marca !== null, 'teto esgotado: nada sai, demanda marcada como pendente')
  await db.query(`DELETE FROM email_alertas WHERE demanda_id <> ALL($1::uuid[])`, [[D(1), D(2), D(3), D(4), D(5), D(11), D(12), D(13), D(6)]])
  await fixarAgora('2026-11-11T13:00:00Z') // 1 h depois do anúncio, orçamento liberado
  m = await enviar(() => alerta.enviarEmailsPendentesNovaDemanda())
  ok(m.length === 1 && m[0].assunto === '⏳ Pedido ainda aberto: Cortado pelo teto' && html2txt(m[0].html).includes(corpoReparo('Cortado pelo teto')),
     'pendente reenviado pelo cron (anunciado há só 1 h): "ainda aberto"', m.map(x => x.assunto))
  ok((await db.query(`SELECT count(*)::int AS n FROM email_alertas WHERE tipo = 'reparo' AND demanda_id = $1`, [D(6)])).rows[0].n === 1, 'o claim continua com o tipo de demanda nova (dedupe intacto)')

  // ── reanúncio (match desfeito, tipo reaberta_*) de pedido antigo: "ainda aberto" ──
  await reparo(D(7), 'Reaberto', { anunciadaHa: 30, criadaHa: 30 })
  m = await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(7), { tipo: 'reaberta_reparo', somenteSemToken: false }))
  ok(m.length === 1 && m[0].assunto === '⏳ Pedido ainda aberto: Reaberto', 'reanúncio de pedido de ontem: "ainda aberto"', m.map(x => x.assunto))

  // ── lembrete (mensagem própria): intocado ──
  const ladoLembrete = alerta.LADOS_LEMBRETE.find(l => l.tabela === 'reparos')
  await reparo(D(8), 'Lembrete velho', { anunciadaHa: 48, criadaHa: 48 })
  m = await enviar(() => alerta.enviarEmailsNovaDemanda('reparos', D(8), { tipo: `${ladoLembrete.tipoEmail}#1`, mensagem: ladoLembrete.mensagem, interesse: ladoLembrete.interesse, somenteSemToken: true }))
  const esperadoLembrete = ladoLembrete.mensagem({ titulo: 'Lembrete velho', cidade: 'Uberlândia', categoria: 'eletrica', categorias: ['eletrica'], valor: 150, interessados: 0 }, D(8)).titulo
  ok(m.length === 1 && m[0].assunto === esperadoLembrete && !m[0].assunto.startsWith('⏳ Pedido ainda aberto:'), 'lembrete segue com o próprio texto', m.map(x => x.assunto))

  ok(erros.length === 0, 'nenhum erro logado', erros.slice(0, 3))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
