#!/usr/bin/env node
// Aviso de demanda por DISTÂNCIA + teto diário de pushes (decisão do dono, 10/11/2026):
//   • alcance = MESMA cidade + UF (sempre, qualquer que seja o raio) OU a até min(raio escolhido,
//     50 km) da demanda, pelas coordenadas do perfil — a distância só SOMA cidades vizinhas; sem
//     coordenadas (do profissional ou da demanda) ou com "minha cidade" → só a própria cidade;
//   • vale para obra e serviço, push e e-mail, na demanda NOVA, no lembrete e no reanúncio; os
//     demais filtros continuam (especialidade, pode_obras, assinatura, suspensão, desinstalado,
//     conta do criador, teto de e-mails);
//   • teto de 15 pushes de demanda por pessoa por dia (São Paulo), contando "fora da área",
//     lembrete e reanúncio; a demanda nova que passa vira, no máximo 1 vez por dia e só entre 08h e
//     20h, "Mais N pedidos perto de você hoje" — com um data.tipo que o app JÁ abre no feed;
//   • demandas que saem JUNTAS: o que resta do teto vai às mais próximas do profissional;
//   • o feed não muda — só passa a registrar o raio que o app manda.
// Caso real que motivou: obra 673E2 em Lagoa Formosa, zero avisos (profissionais em Patos de Minas).
// SQL REAL num Postgres em memória (PGlite); Expo/Brevo falsos; NOW() sombreado por public.now().
//   npm i -D @electric-sql/pglite && node scripts/testar-avisos-por-distancia.js
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
require(path.join(REPO, 'src/routes/index.js'))
const alerta = require(path.join(REPO, 'src/services/alertaService'))
const fa = require(path.join(REPO, 'src/utils/avisosForaDaArea'))
const pd = require(path.join(REPO, 'src/utils/avisosPorDistancia'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 250))
const ordenado = (l) => [...l].sort()
const igual = (a, b) => JSON.stringify(ordenado(a)) === JSON.stringify(ordenado(b))
const fixarAgora = (iso) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${iso}'::timestamptz $$`)
const km = (a, b) => {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(h))
}
// Coordenadas reais das sedes
const LF = [-18.7786, -46.4075]      // Lagoa Formosa
const PATOS = [-18.5789, -46.5181]   // Patos de Minas  (~25 km de LF)
const CARMO = [-19.0008, -46.3161]   // Carmo do Paranaíba (~26 km de LF)
const PATROC = [-18.9439, -46.9925]  // Patrocínio (~64 km de LF)
const UDI = [-18.9186, -48.2772]     // Uberlândia (~197 km)
const NORTE40 = [-18.2189, -46.5181] // ponto 40 km ao norte de Patos de Minas (zona rural de Presidente Olegário)

// Profissionais (todos com assinatura ativa, token e e-mail, salvo a observação)
const P = {
  LFA:   { n: 1,  tipo: 'pintor', cidade: 'Lagoa Formosa',  em: LF },                       // na cidade, com coordenadas
  PAT:   { n: 2,  tipo: 'pintor', cidade: 'Patos de Minas', em: PATOS },                    // nunca escolheu raio → 50
  PAT10: { n: 3,  tipo: 'pintor', cidade: 'Patos de Minas', em: PATOS, raio: 10 },          // raio menor que a distância
  PAT30: { n: 4,  tipo: 'pintor', cidade: 'Patos de Minas', em: PATOS, raio: 30 },
  PTR:   { n: 5,  tipo: 'pintor', cidade: 'Patrocínio',     em: PATROC, raio: 200 },        // 64 km: o teto de 50 corta
  PTRN:  { n: 6,  tipo: 'pintor', cidade: 'Patrocínio',     em: PATROC },                   // 64 km, sem raio
  PATC:  { n: 7,  tipo: 'pintor', cidade: 'Patos de Minas', em: PATOS, raio: 0 },           // escolheu "minha cidade"
  LFC:   { n: 8,  tipo: 'pintor', cidade: 'Lagoa Formosa',  em: LF, raio: 0 },              // "minha cidade", na cidade
  LFSC:  { n: 9,  tipo: 'pintor', cidade: 'Lagoa Formosa',  em: null },                     // SEM coordenadas, na cidade
  PATSC: { n: 10, tipo: 'pintor', cidade: 'Patos de Minas', em: null },                     // SEM coordenadas, cidade vizinha
  UDI:   { n: 11, tipo: 'pintor', cidade: 'Uberlândia',     em: UDI, raio: 100 },
  SUSP:  { n: 12, tipo: 'pintor', cidade: 'Patos de Minas', em: PATOS, suspenso: true },
  SEMA:  { n: 13, tipo: 'pintor', cidade: 'Patos de Minas', em: PATOS, assinatura: 'cancelada' },
  DESI:  { n: 14, tipo: 'pintor', cidade: 'Patos de Minas', em: PATOS, desinstalado: true },
  RELE:  { n: 15, tipo: 'reparador', esp: ['eletrica'], cidade: 'Patos de Minas', em: PATOS },  // serviço: casa a especialidade
  RFAX:  { n: 16, tipo: 'reparador', esp: ['faxina'],   cidade: 'Patos de Minas', em: PATOS },  // serviço: não casa
  ROBR:  { n: 17, tipo: 'reparador', esp: ['faxina', 'pedreiro_servente'], cidade: 'Carmo do Paranaíba', em: CARMO }, // pode obras, ~26 km
  RLF:   { n: 18, tipo: 'reparador', esp: ['faxina'],   cidade: 'Lagoa Formosa', em: LF },      // não pode obras: "fora da área" da obra
  LFX:   { n: 19, tipo: 'pintor', cidade: 'Lagoa Formosa',  em: [-18.6706, -46.4075], raio: 5 }, // da cidade, a 12 km da obra, raio de 5 km
}
Object.values(P).forEach(p => { p.id = U(p.n) })
const DONO = U(900), CRIADOR_PROF = U(901)
const tok = (id) => `ExponentPushToken[${id.slice(-3)}]`
const nome = (t) => Object.entries(P).find(([, p]) => tok(p.id) === t)?.[0] || (t === tok(CRIADOR_PROF) ? 'CRIADOR' : t)
const quem = (lista) => ordenado(lista.map(x => nome(x.to)))
const nomesPorId = (ids) => ordenado(ids.map(id => Object.entries(P).find(([, p]) => p.id === id)?.[0] || id))

const main = async () => {
  // ═══ 0. Peças puras ════════════════════════════════════════════════════════════════════════
  ok(pd.RAIO_MAX_KM === 50 && pd.TETO_PUSH_DEMANDA_DIA === 15, 'constantes: teto de 50 km e de 15 pushes por dia')
  ok(pd.interpretarRaio('30') === 30 && pd.interpretarRaio(12.5) === 12.5 && pd.interpretarRaio('cidade') === 0 && pd.interpretarRaio('estado') === null && pd.interpretarRaio('pais') === null,
     'raio do feed: número → km; "cidade" → 0; "estado"/"pais" → sem limite próprio')
  ok([undefined, null, '', 'abc', '-5', '0'].every(v => pd.interpretarRaio(v) === undefined), 'raio ausente ou inválido não é registrado')
  ok(alerta.mensagemResumoTeto(3).data.tipo === 'novo_reparo' && alerta.mensagemResumoTeto(2, true).data.tipo === 'nova_obra'
     && !('obra_id' in alerta.mensagemResumoTeto(2, true).data) && !('reparo_id' in alerta.mensagemResumoTeto(3).data),
     'resumo: data.tipo que o app já trata (novo_reparo / nova_obra) e SEM id de demanda → o toque abre o feed')
  ok(Math.round(km(LF, PATOS)) === 25 && km(LF, PATROC) > 50 && km(LF, CARMO) < 50, 'distâncias da semente: Patos ~25 km, Carmo < 50 km, Patrocínio > 50 km',
     { patos: +km(LF, PATOS).toFixed(1), carmo: +km(LF, CARMO).toFixed(1), patrocinio: +km(LF, PATROC).toFixed(1) })

  db = new PGlite()
  await db.exec(`SET search_path = public, pg_catalog`)
  await fixarAgora('2026-11-10T15:00:00Z') // terça, 12:00 em São Paulo
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, descricao text, categoria text, cidade text, uf text, bairro text, criado_por uuid, status text DEFAULT 'aberta',
      status_aprovacao text DEFAULT 'aprovada', match_usuario_id uuid, expira_em timestamptz, criado_em timestamptz DEFAULT now(), publicado_em timestamptz,
      prestadores_bloqueados uuid[], codigo_publico text, push_novo_enviado_em timestamptz, email_novo_pendente_em timestamptz, latitude numeric, longitude numeric,
      lembretes_enviados int DEFAULT 0, lembrete_enviado_em timestamptz`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, cidade text, uf text, role text, tipo_prestador text, cpf_cnpj text, ativo boolean DEFAULT true,
      push_token text, suspenso_em timestamptz, desinstalado_em timestamptz, especialidades text[], indicacao_pedida_em timestamptz, latitude numeric, longitude numeric);
    CREATE TABLE assinaturas (usuario_id uuid, status text, proximo_vencimento timestamptz);
    CREATE TABLE reparos (${colsDemanda}, categorias text[], valor_estimado numeric, prazo_atendimento_horas numeric);
    CREATE TABLE obras (${colsDemanda}, valor numeric, horas_para_expirar numeric, push_aprovada_enviado_em timestamptz, enviada_por_dono boolean);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, criado_em timestamptz DEFAULT now());
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, criado_em timestamptz DEFAULT now());
    CREATE TABLE prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid);
    CREATE TABLE push_entregas (tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, primeira_tentativa_em timestamptz NOT NULL DEFAULT now(),
      ultima_tentativa_em timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tipo, demanda_id, usuario_id));
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz);
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true');
  `)
  const cliente = { query: (s, p) => db.query(s, p) }
  silenciar(true)
  await fa.migrarAvisosForaDaArea(cliente)
  await pd.migrarAvisosPorDistancia(cliente)
  await pd.migrarAvisosPorDistancia(cliente) // idempotente
  silenciar(false)
  ok((await db.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'usuarios' AND column_name = 'raio_km_escolhido'`)).rows[0].n === 1
     && (await db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'avisos_acima_do_teto'`)).rows[0].n === 1,
     'migração (2 execuções): usuarios.raio_km_escolhido e avisos_acima_do_teto')

  for (const [rot, p] of Object.entries(P)) {
    await db.query(
      `INSERT INTO usuarios (id, nome, email, cidade, uf, role, tipo_prestador, cpf_cnpj, push_token, especialidades, latitude, longitude, raio_km_escolhido, suspenso_em, desinstalado_em, avisos_todas_areas)
       VALUES ($1::uuid, $2, $3, $4, 'MG', 'prestador', $5, $6, $7, $8::text[], $9, $10, $11, ${p.suspenso ? 'now()' : 'NULL'}, ${p.desinstalado ? 'now()' : 'NULL'}, $12)`,
      [p.id, `${rot} Teste`, `${rot.toLowerCase()}@x.invalid`, p.cidade, p.tipo, String(p.n).padStart(11, '7'), tok(p.id), p.esp || ['pintor'], p.em?.[0] ?? null, p.em?.[1] ?? null, p.raio ?? null, rot === 'RLF'])
    await db.query(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1::uuid, $2)`, [p.id, p.assinatura || 'ativa'])
  }
  await db.query(`INSERT INTO usuarios (id, nome, email, role, cidade, uf, cpf_cnpj, avisos_todas_areas) VALUES ($1, 'Elis', 'elis@x.invalid', 'dono_obra', 'Lagoa Formosa', 'MG', '100.100.100-10', false)`, [DONO])
  // conta PROFISSIONAL da própria dona (mesmo CPF), a 25 km: nunca é avisada do pedido dela
  await db.query(`INSERT INTO usuarios (id, nome, email, role, tipo_prestador, cidade, uf, cpf_cnpj, push_token, especialidades, latitude, longitude, avisos_todas_areas)
                  VALUES ($1, 'Elis Pintora', 'elisp@x.invalid', 'prestador', 'pintor', 'Patos de Minas', 'MG', '10010010010', $2, '{pintor}', $3, $4, false)`, [CRIADOR_PROF, tok(CRIADOR_PROF), PATOS[0], PATOS[1]])
  await db.query(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [CRIADOR_PROF])

  const obra = (id, titulo, em = LF, cidade = 'Lagoa Formosa') => db.query(
    `INSERT INTO obras (id, titulo, categoria, cidade, uf, bairro, criado_por, valor, horas_para_expirar, expira_em, publicado_em, latitude, longitude)
     VALUES ($1::uuid, $2, 'residencial', $3, 'MG', 'Centro', $4::uuid, 3500, 240, now() + INTERVAL '10 days', now() - INTERVAL '20 minutes', $5, $6)`, [id, titulo, cidade, DONO, em?.[0] ?? null, em?.[1] ?? null])
  const reparo = (id, titulo, categoria, em = LF, cidade = 'Lagoa Formosa') => db.query(
    `INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, expira_em, criado_em, latitude, longitude)
     VALUES ($1::uuid, $2, $3, ARRAY[$3], $4, 'MG', 'Centro', $5::uuid, 150, 240, now() + INTERVAL '10 days', now() - INTERVAL '20 minutes', $6, $7)`, [id, titulo, categoria, cidade, DONO, em?.[0] ?? null, em?.[1] ?? null])
  const publicar = async (tabela, id) => {
    silenciar(true)
    pushes.length = 0; emails.length = 0
    await alerta.dispararPushNovoComClaim(tabela, id, tabela === 'obras' ? alerta.notificarPintoresSobreNovaObra : alerta.notificarPrestadoresSobreNovoReparo)
    await assentar()
    silenciar(false)
    return { normal: pushes.filter(p => !p.data?.fora_da_area), fora: pushes.filter(p => p.data?.fora_da_area) }
  }
  const emailados = async (id, tipo) => nomesPorId((await db.query(`SELECT usuario_id FROM email_alertas WHERE tipo = $2 AND demanda_id = $1`, [id, tipo])).rows.map(x => x.usuario_id))
  const acimaDoTeto = async (id) => nomesPorId((await db.query(`SELECT usuario_id FROM avisos_acima_do_teto WHERE demanda_id = $1`, [id])).rows.map(x => x.usuario_id))

  // ═══ 1. OBRA em Lagoa Formosa (o caso 673E2): raio, teto de 50 km, recuos ══════════════════
  await obra(D(1), 'telhadista')
  let r = await publicar('obras', D(1))
  const ESPERADO_OBRA = ['LFA', 'LFC', 'LFSC', 'LFX', 'PAT', 'PAT30', 'ROBR']
  ok(igual(quem(r.normal), ESPERADO_OBRA), 'push NOVA OBRA em Lagoa Formosa: quem é da cidade + quem está a até min(raio, 50 km)', quem(r.normal))
  ok(quem(r.normal).includes('LFX'), 'MESMA CIDADE recebe SEMPRE: profissional de Lagoa Formosa a 12 km da obra com raio de 5 km → recebe (a distância só soma, nunca tira)')
  ok(quem(r.normal).includes('PAT'), 'profissional de Patos de Minas (25 km) que nunca escolheu raio → recebe (padrão 50 km) — antes: ZERO avisos')
  ok(quem(r.normal).includes('PAT30') && !quem(r.normal).includes('PAT10'), 'raio escolhido: 30 km alcança os 25 km; 10 km não')
  ok(!quem(r.normal).includes('PTR') && !quem(r.normal).includes('PTRN'), 'teto de 50 km: a 64 km não recebe, nem com raio escolhido de 200 km')
  ok(!quem(r.normal).includes('UDI'), 'a 197 km não recebe')
  ok(quem(r.normal).includes('LFC') && !quem(r.normal).includes('PATC'), '"minha cidade" (raio 0): recebe só quem é da cidade da obra')
  ok(quem(r.normal).includes('LFSC') && !quem(r.normal).includes('PATSC'), 'profissional SEM coordenadas: recuo para mesma cidade + UF')
  ok(quem(r.normal).includes('ROBR'), 'reparador com especialidade de obra a 26 km: pode_obras continua valendo, agora por distância')
  ok(!quem(r.normal).some(n => ['SUSP', 'SEMA', 'DESI', 'RELE', 'RFAX', 'CRIADOR'].includes(n)),
     'filtros mantidos: suspenso, sem assinatura, desinstalado, quem não pode obras e a conta do criador ficam de fora', quem(r.normal))
  ok(igual(await emailados(D(1), 'obra'), ESPERADO_OBRA), 'E-MAIL nova obra: o MESMO público do push (por distância)', await emailados(D(1), 'obra'))
  ok(igual(quem(r.fora), ['RLF']) , '"fora da sua área" continua por CIDADE: só o reparador de Lagoa Formosa', quem(r.fora))

  // demanda SEM coordenadas → recuo para a cidade, para todos
  await obra(D(2), 'obra sem coordenadas', null)
  r = await publicar('obras', D(2))
  ok(igual(quem(r.normal), ['LFA', 'LFC', 'LFSC', 'LFX']), 'obra SEM coordenadas: só mesma cidade + UF (ninguém de fora)', quem(r.normal))

  // ═══ 2. SERVIÇO: distância + especialidade ═════════════════════════════════════════════════
  await reparo(D(3), 'Trocar tomada', 'eletrica')
  r = await publicar('reparos', D(3))
  ok(igual(quem(r.normal), ['RELE']), 'push NOVO SERVIÇO (elétrica) em Lagoa Formosa: reparador de elétrica de Patos (25 km); o de faxina não (especialidade mantida)', quem(r.normal))
  ok(igual(await emailados(D(3), 'reparo'), ['RELE']), 'e-mail do serviço: mesmo público', await emailados(D(3), 'reparo'))

  // ═══ 3. REANÚNCIO: mesmo alcance (cidade OU distância) e conta no teto ═════════════════════
  const reanunciar = async (id) => { silenciar(true); pushes.length = 0; emails.length = 0; await alerta.reanunciarDemanda('obras', id); await assentar(); silenciar(false); return pushes.filter(p => p.data?.reaberta) }
  let rea = await reanunciar(D(1))
  ok(igual(quem(rea), ESPERADO_OBRA), 'push de REANÚNCIO: mesmo alcance da demanda nova (cidade OU até min(raio, 50 km))', quem(rea))
  ok(igual(await emailados(D(1), 'reaberta_obra'), ESPERADO_OBRA), 'e-mail de reanúncio: mesmo alcance', await emailados(D(1), 'reaberta_obra'))
  ok((await db.query(`SELECT count(*)::int AS n FROM lembretes_push_enviados WHERE demanda_id = $1 AND motivo = 'reanuncio'`, [D(1)])).rows[0].n === ESPERADO_OBRA.length,
     'reanúncio enviado fica registrado (lembretes_push_enviados) para contar no teto')

  // ═══ 4. Raio do feed fica registrado (o feed não muda) ═════════════════════════════════════
  let escritas = 0
  const contador = { query: (s, p) => { escritas++; return db.query(s, p) } }
  pd.registrarRaioEscolhido(P.PAT10.id, '40', contador); await assentar()
  pd.registrarRaioEscolhido(P.PAT10.id, '40', contador); await assentar()
  pd.registrarRaioEscolhido(P.PAT10.id, 'abc', contador); await assentar()
  const raioAgora = async (p) => (await db.query(`SELECT raio_km_escolhido FROM usuarios WHERE id = $1`, [p.id])).rows[0].raio_km_escolhido
  ok(Number(await raioAgora(P.PAT10)) === 40 && escritas === 1, 'feed com raio_km=40 grava o raio UMA vez (repetição e valor inválido não vão ao banco)', { raio: await raioAgora(P.PAT10), escritas })
  pd.registrarRaioEscolhido(P.PAT30.id, 'cidade', contador); await assentar()
  pd.registrarRaioEscolhido(P.PTR.id, 'estado', contador); await assentar()
  ok(Number(await raioAgora(P.PAT30)) === 0 && await raioAgora(P.PTR) === null, 'feed com "cidade" grava 0; com "estado" grava sem limite próprio (vale o teto de 50 km)')
  await obra(D(4), 'calha')
  r = await publicar('obras', D(4))
  ok(quem(r.normal).includes('PAT10') && !quem(r.normal).includes('PAT30') && !quem(r.normal).includes('PTR'),
     'depois de mudar o raio no feed: quem ampliou para 40 km passa a receber; quem escolheu "minha cidade" deixa; a 64 km continua fora', quem(r.normal))
  await db.query(`UPDATE usuarios SET raio_km_escolhido = 30 WHERE id = $1`, [P.PAT30.id])
  await db.query(`UPDATE usuarios SET raio_km_escolhido = 10 WHERE id = $1`, [P.PAT10.id])

  // ═══ 5. TETO de 15 pushes de demanda por dia ═══════════════════════════════════════════════
  // PAT já recebeu hoje D1 e D4 (2). Completa 14 com outras demandas → a próxima é a 15ª; a seguinte passa do teto.
  const usadosHoje = async (p) => (await db.query(`SELECT ${pd.sqlPushesDeDemandaHoje('u.id')}::int AS n FROM usuarios u WHERE u.id = $1`, [p.id])).rows[0].n
  ok(await usadosHoje(P.PAT) === 3, 'contagem do dia de PAT: 3 pushes de demanda (2 novas + 1 reanúncio — o reanúncio CONTA no teto)', await usadosHoje(P.PAT))
  await db.query(`INSERT INTO push_entregas (tipo, demanda_id, usuario_id, resultado) SELECT 'obra', gen_random_uuid(), $1::uuid, 'enviado' FROM generate_series(1, 11)`, [P.PAT.id])
  await db.query(`INSERT INTO push_entregas (tipo, demanda_id, usuario_id, resultado) VALUES ('obra', gen_random_uuid(), $1, 'falha')`, [P.PAT.id])
  ok(await usadosHoje(P.PAT) === 14, 'push que FALHOU não conta no teto', await usadosHoje(P.PAT))
  await obra(D(5), 'a 15ª do dia')
  r = await publicar('obras', D(5))
  ok(quem(r.normal).includes('PAT') && await usadosHoje(P.PAT) === 15, '15ª demanda do dia: ainda sai', await usadosHoje(P.PAT))
  await fixarAgora('2026-11-10T16:00:00Z') // 13:00
  await obra(D(6), 'a 16ª do dia')
  r = await publicar('obras', D(6))
  ok(!quem(r.normal).includes('PAT') && quem(r.normal).includes('PAT30'), '16ª demanda: PAT (no teto) NÃO recebe push; os demais recebem normalmente', quem(r.normal))
  ok(igual(await acimaDoTeto(D(6)), ['PAT']), 'a demanda que passou do teto fica registrada para o resumo', await acimaDoTeto(D(6)))
  ok((await emailados(D(6), 'obra')).includes('PAT'), 'o teto é só de PUSH: o e-mail da demanda continua indo')
  ok((await db.query(`SELECT count(*)::int AS n FROM push_entregas WHERE demanda_id = $1 AND usuario_id = $2`, [D(6), P.PAT.id])).rows[0].n === 0, 'sem linha em push_entregas para quem ficou acima do teto')
  // "fora da área" CONTA no teto e é limitado por ele
  // RLF (faxina, Lagoa Formosa) recebeu "fora da área" das 5 obras de hoje e do serviço de elétrica: 6.
  ok(await usadosHoje(P.RLF) === 6, 'RLF: os 6 avisos "fora da área" de hoje contam no mesmo teto', await usadosHoje(P.RLF))
  await db.query(`INSERT INTO avisos_fora_area (tabela, demanda_id, usuario_id) SELECT 'obras', gen_random_uuid(), $1::uuid FROM generate_series(1, 9)`, [P.RLF.id])
  await obra(D(7), 'a 17ª do dia')
  r = await publicar('obras', D(7))
  ok(quem(r.fora).length === 0 && (await acimaDoTeto(D(7))).includes('RLF') && (await acimaDoTeto(D(7))).includes('PAT'),
     'com 15 no dia, o push "fora da área" também é segurado e vai para o resumo', { fora: quem(r.fora), acima: await acimaDoTeto(D(7)) })

  // reanúncio com a pessoa NO TETO: não sai para ela e NÃO entra no resumo (não é pedido novo)
  rea = await reanunciar(D(5))
  ok(!quem(rea).includes('PAT') && quem(rea).includes('PAT30'), 'reanúncio com PAT no teto: PAT não recebe; quem tem saldo recebe', quem(rea))
  ok(!(await acimaDoTeto(D(5))).includes('PAT'), 'reanúncio acima do teto não entra no "Mais N pedidos"', await acimaDoTeto(D(5)))

  // ═══ 6. Push-RESUMO: no máximo 1 por dia, 08–20h, só pedidos ainda abertos ═════════════════
  const rodarResumo = async () => { silenciar(true); pushes.length = 0; emails.length = 0; await alerta.enviarResumosAcimaDoTeto(); await assentar(); silenciar(false); return pushes.filter(p => p.data?.resumo === true) }
  await fixarAgora('2026-11-10T16:30:00Z') // 13:30 — 30 min depois do primeiro pedido de fora
  let res = await rodarResumo()
  ok(res.length === 0, 'resumo: antes de 60 min do primeiro pedido de fora, ainda não sai (junta os seguintes)', res.length)
  await fixarAgora('2026-11-10T17:05:00Z') // 14:05
  res = await rodarResumo()
  const doPat = res.find(p => p.to === tok(P.PAT.id))
  ok(doPat && doPat.title === 'Mais 2 pedidos perto de você hoje' && doPat.body === 'Toque para ver.' && doPat.data.total === 2,
     'resumo ao PAT: "Mais 2 pedidos perto de você hoje" / "Toque para ver."', doPat && { titulo: doPat.title, corpo: doPat.body, data: doPat.data })
  ok(doPat && doPat.data.tipo === 'nova_obra' && !doPat.data.obra_id && !doPat.data.reparo_id,
     'resumo: data.tipo "nova_obra" sem obra_id — o roteador de toques do app atual cai em navegar(abaFeed)', doPat?.data)
  const doRlf = res.find(p => p.to === tok(P.RLF.id))
  ok(doRlf && doRlf.title === 'Mais 1 pedido perto de você hoje', 'resumo ao RLF: singular "Mais 1 pedido perto de você hoje"', doRlf?.title)
  ok(res.length === 2 && emails.length === 0, 'um resumo por pessoa, só push', { resumos: res.length, emails: emails.length })
  res = await rodarResumo()
  ok(res.length === 0, 'tique seguinte: nada (claim)', res.length)
  // mais pedidos acima do teto no MESMO dia → não há segundo resumo hoje
  await obra(D(8), 'a 18ª do dia')
  await publicar('obras', D(8))
  await fixarAgora('2026-11-10T19:30:00Z') // 16:30
  res = await rodarResumo()
  ok(res.length === 0 && (await acimaDoTeto(D(8))).includes('PAT'), 'no máximo UM resumo por dia: o pedido seguinte fica para o próximo', res.length)
  // à noite passa mais um; de madrugada não sai; de manhã sai com o que continua aberto
  await fixarAgora('2026-11-11T01:00:00Z') // 22:00 de terça
  await obra(D(9), 'publicada às 22h')
  await db.query(`INSERT INTO push_entregas (tipo, demanda_id, usuario_id, resultado) SELECT 'obra', gen_random_uuid(), $1::uuid, 'enviado' FROM generate_series(1, 1)`, [P.PAT.id])
  await publicar('obras', D(9))
  res = await rodarResumo()
  ok(res.length === 0, '22:00: fora do horário, o resumo não sai', res.length)
  await db.query(`UPDATE obras SET match_usuario_id = $2 WHERE id = $1`, [D(8), P.LFA.id]) // a 18ª já tem profissional
  await fixarAgora('2026-11-11T11:05:00Z') // quarta, 08:05
  res = await rodarResumo()
  const manha = res.find(p => p.to === tok(P.PAT.id))
  ok(manha && manha.data.total === 1 && manha.title === 'Mais 1 pedido perto de você hoje', 'quarta 08:05: resumo com o que sobrou da véspera e CONTINUA aberto (a que já tem profissional não conta)', manha && manha.title)
  ok(await usadosHoje(P.PAT) === 0, 'dia novo: a contagem do teto zera', await usadosHoje(P.PAT))

  // ═══ 7. Demandas que saem JUNTAS: as mais próximas primeiro ════════════════════════════════
  // PAT tem 13 usados → restam 2. A rede de segurança dispara 3 obras no mesmo tique, da mais
  // distante para a mais próxima: PAT deve receber as DUAS mais próximas.
  await db.query(`INSERT INTO push_entregas (tipo, demanda_id, usuario_id, resultado) SELECT 'obra', gen_random_uuid(), $1::uuid, 'enviado' FROM generate_series(1, 13)`, [P.PAT.id])
  await fixarAgora('2026-11-11T15:00:00Z') // quarta 12:00
  await db.query(`INSERT INTO obras (id, titulo, categoria, cidade, uf, bairro, criado_por, valor, expira_em, publicado_em, latitude, longitude) VALUES
     ($1, 'longe (~40 km de Patos)',         'residencial', 'Presidente Olegário', 'MG', 'Centro', $4, 1000, now() + INTERVAL '5 days', now() - INTERVAL '40 minutes', $5, $6),
     ($2, 'meio (Lagoa Formosa, ~25 km)',    'residencial', 'Lagoa Formosa',      'MG', 'Centro', $4, 1000, now() + INTERVAL '5 days', now() - INTERVAL '30 minutes', $7, $8),
     ($3, 'perto (Patos, 0 km)',             'residencial', 'Patos de Minas',     'MG', 'Centro', $4, 1000, now() + INTERVAL '5 days', now() - INTERVAL '20 minutes', $9, $10)`,
    [D(20), D(21), D(22), DONO, NORTE40[0], NORTE40[1], LF[0], LF[1], PATOS[0], PATOS[1]])
  ok(km(PATOS, NORTE40) < 50 && km(PATOS, NORTE40) > km(PATOS, LF), 'a obra mais distante está dentro dos 50 km de Patos (sem o teto, PAT receberia as três)', +km(PATOS, NORTE40).toFixed(1))
  silenciar(true)
  pushes.length = 0
  await alerta.enviarPushNovoPendente()
  await assentar()
  silenciar(false)
  const doPatLote = pushes.filter(p => p.to === tok(P.PAT.id) && p.data?.tipo === 'nova_obra').map(p => p.data.obra_id)
  ok(igual(doPatLote, [D(21), D(22)]), 'lote de 3 com 2 vagas no teto: PAT recebe as DUAS MAIS PRÓXIMAS, mesmo a mais distante sendo processada primeiro', doPatLote.map(x => x.slice(-2)))
  ok(igual(await acimaDoTeto(D(20)), ['PAT']), 'a mais distante é a que fica para o resumo', await acimaDoTeto(D(20)))
  ok(pushes.filter(p => p.to === tok(P.PAT30.id) && p.data?.tipo === 'nova_obra').length === 2, 'quem não está no teto recebe tudo o que alcança (PAT30: Lagoa Formosa e Patos; a de 40 km passa do raio de 30)')

  // ═══ 8. LEMBRETE "ainda aberto": mesmo alcance e conta no teto ══════════════════════════════
  // Serviço de elétrica em Lagoa Formosa, publicado há 25 h (janela de 72 h → lembrete diário devido).
  // Não há reparador de elétrica em Lagoa Formosa: pela regra antiga, ninguém seria lembrado.
  const reparoAntigo = (id, titulo) => db.query(
    `INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, expira_em, criado_em, push_novo_enviado_em, latitude, longitude)
     VALUES ($1::uuid, $2, 'eletrica', '{eletrica}', 'Lagoa Formosa', 'MG', 'Centro', $3::uuid, 150, 72, now() + INTERVAL '47 hours', now() - INTERVAL '25 hours', now() - INTERVAL '25 hours', $4, $5)`, [id, titulo, DONO, LF[0], LF[1]])
  const lembrar = async () => { silenciar(true); pushes.length = 0; await alerta.lembrarDemandasSemResposta(); await assentar(); silenciar(false); return pushes.filter(p => p.data?.lembrete) }
  await reparoAntigo(D(30), 'Chuveiro queimado')
  const antesRele = await usadosHoje(P.RELE)
  let lem = await lembrar()
  ok(igual(quem(lem), ['RELE']) && lem[0].data.reparo_id === D(30), 'LEMBRETE do serviço em Lagoa Formosa: chega ao reparador de elétrica de Patos (25 km) — antes, ninguém', quem(lem))
  ok(await usadosHoje(P.RELE) === antesRele + 1, 'lembrete enviado CONTA no teto diário', { antes: antesRele, depois: await usadosHoje(P.RELE) })
  await db.query(`INSERT INTO push_entregas (tipo, demanda_id, usuario_id, resultado) SELECT 'reparo', gen_random_uuid(), $1::uuid, 'enviado' FROM generate_series(1, $2::int)`, [P.RELE.id, 15 - (antesRele + 1)])
  await reparoAntigo(D(31), 'Tomada sem energia')
  lem = await lembrar()
  ok(lem.length === 0 && (await acimaDoTeto(D(31))).length === 0, 'lembrete com a pessoa no teto (15): não sai e não entra no resumo', { pushes: quem(lem), acima: await acimaDoTeto(D(31)) })

  const inesperados = erros.filter(e => !/sem banco|PAGBANK|migration/i.test(e))
  ok(inesperados.length === 0, 'nenhum erro logado', inesperados.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error = errOrig; console.error('ERRO', e); process.exit(1) })
