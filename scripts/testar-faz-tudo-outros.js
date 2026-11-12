#!/usr/bin/env node
// "Faz-tudo" (dono, 11/11/2026): quem marcou 'outros' em especialidades entra no público de TODA
// demanda aberta — obras e reparos, qualquer categoria, sem exigir pode_obras/pode_servicos — em push e
// e-mail, e em tudo que passa por broadcastPaginado / reivindicarEmailsNovaDemanda (demanda nova,
// reanúncio, oferta aumentada; o lembrete usa o mesmo caminho). Alcance (mesma cidade OU até
// min(raio, 50 km)), suspensão, assinatura, exclusão do criador (por CPF) e "fora da sua área" seguem
// como estão. Demanda só 'outros' continua indo a todos, como hoje.
// SQL REAL num Postgres em memória (PGlite); Expo/Brevo falsos que só coletam.
//   npm i -D @electric-sql/pglite && node scripts/testar-faz-tudo-outros.js
process.env.JWT_SECRET = 'segredo-de-teste'
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

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
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error
console.log = () => {}; console.error = () => {}
require(path.join(REPO, 'src/routes/index.js'))
const alerta = require(path.join(REPO, 'src/services/alertaService'))
const fa = require(path.join(REPO, 'src/utils/avisosForaDaArea'))
console.log = logOrig; console.error = errOrig

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 150))
const tok = (id) => `ExponentPushToken[${id.slice(-3)}]`
const ordenado = (l) => [...l].sort()
const igual = (a, b) => JSON.stringify(ordenado(a)) === JSON.stringify(ordenado(b))
const quieto = async (fn) => { console.log = () => {}; console.error = () => {}; try { return await fn() } finally { await assentar(); console.log = logOrig; console.error = errOrig } }
const fixarAgora = (iso) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${iso}'::timestamptz $$`)
const UDI = [-18.9186, -48.2772], ARAGUARI = [-18.6472, -48.1872] /* ~33 km de Uberlândia */, UBERABA = [-19.7472, -47.9381] /* ~100 km */

const main = async () => {
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, descricao text, categoria text, cidade text, uf text, bairro text, criado_por uuid, status text DEFAULT 'aberta',
      status_aprovacao text DEFAULT 'aprovada', encerrado_em timestamptz, match_usuario_id uuid, match_feito_em timestamptz, expira_em timestamptz,
      criado_em timestamptz DEFAULT now(), publicado_em timestamptz, a_caminho_em timestamptz, prestadores_bloqueados uuid[], codigo_publico text,
      push_novo_enviado_em timestamptz, email_novo_pendente_em timestamptz, valor_aumentado_em timestamptz, latitude numeric, longitude numeric, tags text[]`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, latitude numeric, longitude numeric, raio_km_escolhido numeric, nome text, email text, telefone text, cidade text, uf text, role text, tipo_dono text, tipo_prestador text, cpf_cnpj text,
      ativo boolean DEFAULT true, push_token text, criado_em timestamptz DEFAULT now(), suspenso_em timestamptz, suspenso_motivo text, desinstalado_em timestamptz,
      foto_url text, senha_hash text, boas_vindas_exibida boolean DEFAULT false, token_version int NOT NULL DEFAULT 1, verificacao_status text DEFAULT 'aprovado',
      referencias jsonb, especialidades text[], anos_experiencia int, tamanho_equipe int, aceita_promocoes boolean, indicacao_pedida_em timestamptz);
    CREATE TABLE assinaturas (usuario_id uuid, plano text, valor_mensal numeric, status text, tipo text, proximo_vencimento timestamptz, criado_em timestamptz DEFAULT now());
    CREATE TABLE obras (${colsDemanda}, valor numeric, horas_para_expirar numeric);
    CREATE TABLE reparos (${colsDemanda}, categorias text[], valor_estimado numeric, prazo_atendimento_horas numeric);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, status text DEFAULT 'pendente', valor_proposto numeric,
      valor_contraproposta numeric, mensagem text, referencias text, criado_em timestamptz DEFAULT now());
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, status text DEFAULT 'pendente');
    CREATE TABLE avaliacoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contrato_tipo text, contrato_id uuid, avaliador_id uuid, avaliado_id uuid, estrelas int, etiquetas text[], criado_em timestamptz DEFAULT now());
    CREATE TABLE prestadores_bloqueados_dono (dono_id uuid, prestador_id uuid, UNIQUE (dono_id, prestador_id));
    CREATE TABLE lembretes_push_enviados (tabela text, demanda_id uuid, usuario_id uuid, motivo text, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE avisos_acima_do_teto (tabela text, demanda_id uuid, usuario_id uuid, criado_em timestamptz NOT NULL DEFAULT now(), resumo_em timestamptz, lembrete boolean NOT NULL DEFAULT false, PRIMARY KEY (tabela, demanda_id, usuario_id));
    CREATE TABLE push_entregas (primeira_tentativa_em timestamptz NOT NULL DEFAULT now(), tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, ultima_tentativa_em timestamptz DEFAULT now(),
      criado_em timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz DEFAULT now());
    CREATE TABLE tentativas_contato (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, tipo text, demanda_id uuid, campo text, criado_em timestamptz DEFAULT now());
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true'), ('multiplas_contas', 'true');
    SET search_path = public, pg_catalog;
  `)
  await require(path.join(REPO, 'src/utils/especialidadesInferidas')).migrarEspecialidadesInferidas(db)

  // reparos.local_atendimento + usuarios.atende_* (utils/localAtendimento) — a mesma migração de boot.

  await require(path.join(REPO, 'src/utils/localAtendimento')).migrarLocalAtendimento({ query: (s, p) => db.query(s, p) })
  await quieto(() => fa.migrarAvisosForaDaArea({ query: (s, p) => db.query(s, p) }))
  await fixarAgora('2026-11-10T15:00:00Z') // terça, 12:00 em São Paulo — dentro da janela do "fora da área"

  // Contas (Uberlândia/MG, assinatura ativa, token, salvo observação). cpf distinto salvo onde dito.
  const C = {
    DONO:    { n: 1,  role: 'dono_obra', tipo_dono: 'pintura', cpf: '11111111111' },
    P:       { n: 2,  tipo: 'pintor',    esp: ['pintor'] },                                  // só obra
    RS:      { n: 3,  tipo: 'reparador', esp: ['eletrica'] },                                // só elétrica
    FT:      { n: 4,  tipo: 'reparador', esp: ['outros'] },                                  // FAZ-TUDO: reparador sem obra, sem elétrica
    FTP:     { n: 5,  tipo: 'pintor',    esp: ['pintor', 'outros'] },                        // faz-tudo do lado obra (não pode serviços)
    FTEMAIL: { n: 6,  tipo: 'reparador', esp: ['outros'], semToken: true },                  // faz-tudo sem token → só e-mail
    FTSUS:   { n: 7,  tipo: 'reparador', esp: ['outros'], suspenso: true },
    FTLONGE: { n: 8,  tipo: 'reparador', esp: ['outros'], cidade: 'Uberaba', em: UBERABA },   // 100 km, fora do alcance
    FTPERTO: { n: 9,  tipo: 'reparador', esp: ['outros'], cidade: 'Araguari', em: ARAGUARI }, // 33 km, dentro do raio padrão (50)
    FTDONO:  { n: 10, tipo: 'reparador', esp: ['outros'], cpf: '11111111111' },             // conta irmã do DONO → criador, excluído
    FTOFF:   { n: 11, tipo: 'reparador', esp: ['outros'], assinatura: 'cancelada' },
    RFORA:   { n: 12, tipo: 'reparador', esp: ['faxina'] },                                  // nem elétrica nem outros → "fora da sua área"
  }
  for (const [nome, c] of Object.entries(C)) {
    c.id = U(c.n)
    const role = c.role || 'prestador'
    await db.query(
      `INSERT INTO usuarios (id, nome, email, telefone, cidade, uf, role, tipo_dono, tipo_prestador, cpf_cnpj, push_token, suspenso_em, especialidades, referencias, latitude, longitude)
       VALUES ($1::uuid, $2, $3, '34999990000', $4, 'MG', $5, $6, $7, $8, $9, ${c.suspenso ? 'now()' : 'NULL'}, $10::text[], '[]'::jsonb, $11, $12)`,
      [c.id, `${nome} Teste`, `${nome.toLowerCase()}@x.invalid`, c.cidade || 'Uberlândia', role, c.tipo_dono || null, c.tipo ?? null,
       c.cpf || String(c.n).padStart(11, '9'), c.semToken ? null : tok(c.id), c.esp ?? null, (c.em || UDI)[0], (c.em || UDI)[1]])
    if (role === 'prestador') await db.query(`INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo) VALUES ($1::uuid, 'mensal', 49.90, $2, 'gratuito')`, [c.id, c.assinatura || 'ativa'])
  }
  const { DONO, P, RS, FT, FTP, FTEMAIL, FTPERTO, RFORA } = C
  const OBRA = D(1), R_ELE = D(2), R_FAX = D(3), R_OUT = D(4)
  await db.query(`INSERT INTO obras (id, titulo, categoria, cidade, uf, bairro, criado_por, valor, horas_para_expirar, expira_em, publicado_em, latitude, longitude)
                  VALUES ($1::uuid, 'Reforma da casa', 'residencial', 'Uberlândia', 'MG', 'Centro', $2::uuid, 8000, 720, now() + INTERVAL '20 days', now(), $3, $4)`, [OBRA, DONO.id, ...UDI])
  const reparo = (id, titulo, cat) => db.query(
    `INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, expira_em, latitude, longitude)
     VALUES ($1::uuid, $2, $3, ARRAY[$3], 'Uberlândia', 'MG', 'Centro', $4::uuid, 150, 48, now() + INTERVAL '2 days', $5, $6)`, [id, titulo, cat, DONO.id, ...UDI])
  await reparo(R_ELE, 'Trocar tomada', 'eletrica')
  await reparo(R_FAX, 'Faxina pós-obra', 'faxina')
  await reparo(R_OUT, 'Coisa sem categoria', 'outros')

  const paraQuem = () => ordenado(pushes.map(p => p.to))
  const T = (...cs) => ordenado(cs.map(c => tok(c.id)))
  const emailsDe = async (tipo, id) => ordenado((await db.query(`SELECT usuario_id FROM email_alertas WHERE demanda_id = $1 AND tipo = $2`, [id, tipo])).rows.map(r => r.usuario_id))
  const IDS = (...cs) => ordenado(cs.map(c => c.id))

  // ═══ 0. Predicado ═══════════════════════════════════════════════════════════════════════════
  const ft = (await db.query(`SELECT u.id FROM usuarios u WHERE ${alerta.sqlFazTudo('u')} ORDER BY u.id`)).rows.map(r => r.id)
  ok(igual(ft, IDS(FT, FTP, FTEMAIL, C.FTSUS, C.FTLONGE, FTPERTO, C.FTDONO, C.FTOFF)), 'sqlFazTudo: quem tem outros em especialidades (NULL/[] não quebra)', ft.length)

  // ═══ 1. OBRA nova: push + e-mail ═══════════════════════════════════════════════════════════
  pushes.length = 0
  await quieto(() => alerta.notificarPintoresSobreNovaObra(OBRA))
  ok(igual(paraQuem(), T(P, FTP, FT, FTPERTO)),
     'push NOVA OBRA: pintor, pintor+outros e o faz-tudo reparador SEM especialidade de obra (Uberlândia e Araguari a 33 km); fora: só elétrica, faxina, suspenso, 100 km, sem assinatura, conta irmã do dono',
     { recebeu: paraQuem(), esperado: T(P, FTP, FT, FTPERTO) })
  emails.length = 0
  await quieto(() => alerta.enviarEmailsNovaDemanda('obras', OBRA))
  ok(igual(await emailsDe('obra', OBRA), IDS(P, FTP, FT, FTPERTO, FTEMAIL)), 'E-MAIL nova obra: mesmo público + o faz-tudo sem token', (await emailsDe('obra', OBRA)).length)

  // ═══ 2. REPARO de elétrica ══════════════════════════════════════════════════════════════════
  pushes.length = 0
  await quieto(() => alerta.notificarPrestadoresSobreNovoReparo(R_ELE))
  ok(igual(paraQuem(), T(RS, FT, FTP, FTPERTO)), 'push NOVO SERVIÇO (elétrica): quem casa (RS) + faz-tudo — inclusive o pintor+outros, que não "pode serviços"; pintor puro NÃO', paraQuem())
  await quieto(() => alerta.enviarEmailsNovaDemanda('reparos', R_ELE))
  ok(igual(await emailsDe('reparo', R_ELE), IDS(RS, FT, FTP, FTPERTO, FTEMAIL)), 'e-mail serviço de elétrica: RS + faz-tudo (com e sem token)', (await emailsDe('reparo', R_ELE)).length)

  // ═══ 3. REPARO de faxina (ninguém "casa" além do faz-tudo; RFORA casa) ═════════════════════
  pushes.length = 0
  await quieto(() => alerta.notificarPrestadoresSobreNovoReparo(R_FAX))
  ok(igual(paraQuem(), T(RFORA, FT, FTP, FTPERTO)), 'push serviço de faxina: faxineiro + faz-tudo; RS (elétrica) e pintor puro NÃO', paraQuem())

  // ═══ 4. REPARO só 'outros': continua indo a TODO reparador elegível (como hoje) + faz-tudo ═══
  pushes.length = 0
  await quieto(() => alerta.notificarPrestadoresSobreNovoReparo(R_OUT))
  ok(igual(paraQuem(), T(RS, RFORA, FT, FTP, FTPERTO)), "push serviço só 'outros': todo reparador da cidade (RS, RFORA) + faz-tudo (inclusive o pintor+outros)", paraQuem())
  await quieto(() => alerta.enviarEmailsNovaDemanda('reparos', R_OUT))
  ok(igual(await emailsDe('reparo', R_OUT), IDS(FT, FTP, FTPERTO, FTEMAIL)), "e-mail serviço só 'outros': só quem marcou 'outros' (como hoje) — RS e RFORA não", (await emailsDe('reparo', R_OUT)).length)

  // ═══ 5. Reanúncio e oferta aumentada (mesmo broadcast) ══════════════════════════════════════
  pushes.length = 0; emails.length = 0
  await quieto(() => alerta.reanunciarDemanda('reparos', R_FAX))
  ok(igual(paraQuem(), T(RFORA, FT, FTP, FTPERTO)), 'REANÚNCIO do serviço de faxina: faz-tudo incluído', paraQuem().length)
  ok(igual(await emailsDe('reaberta_reparo', R_FAX), IDS(RFORA, FT, FTP, FTPERTO, FTEMAIL)), 'e-mail do reanúncio: mesmo público, faz-tudo com e sem token', (await emailsDe('reaberta_reparo', R_FAX)).length)
  pushes.length = 0
  await db.query(`UPDATE obras SET valor = 9000, valor_aumentado_em = now() WHERE id = $1`, [OBRA])
  await quieto(() => alerta.notificarOfertaAumentadaObra(OBRA))
  ok(igual(paraQuem(), T(P, FTP, FT, FTPERTO)), 'OFERTA AUMENTADA da obra: faz-tudo incluído', paraQuem().length)

  // ═══ 6. "Fora da sua área": o faz-tudo já está no público normal → não recebe o aviso extra ══
  await db.query(`UPDATE reparos SET push_novo_enviado_em = now() - INTERVAL '10 minutes' WHERE id = $1`, [R_ELE])
  pushes.length = 0
  await quieto(() => alerta.avisarForaDaAreaDemanda('reparos', R_ELE))
  ok(igual(paraQuem(), T(P, RFORA)), 'FORA DA ÁREA (serviço de elétrica): faxineiro e pintor puro (como hoje); NENHUM faz-tudo — já é público normal de toda demanda', paraQuem())

  // ═══ 7. Exclusão do criador por CPF e já manifestado ═════════════════════════════════════════
  const dupla = (await db.query(`SELECT count(*)::int AS n FROM push_entregas WHERE demanda_id = $1 AND usuario_id = $2`, [R_ELE, C.FTDONO.id])).rows[0].n
  ok(dupla === 0, 'faz-tudo com o CPF do dono (conta irmã do criador) nunca recebeu nada', dupla)
  await db.query(`INSERT INTO interesse_reparos (reparo_id, usuario_id, status) VALUES ($1, $2, 'pendente')`, [R_FAX, FT.id])
  pushes.length = 0
  await quieto(() => alerta.reanunciarDemanda('reparos', R_FAX))
  ok(!paraQuem().includes(tok(FT.id)) && paraQuem().includes(tok(FTP.id)), 'faz-tudo que JÁ demonstrou interesse fica fora do reanúncio (exclusão de manifestados vale igual)', paraQuem())

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { errOrig('MAIN FALHOU:', e && (e.stack || e)); process.exit(1) })
