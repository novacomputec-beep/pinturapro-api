// Lembretes "ainda aberto" aos profissionais — CADÊNCIA (regra do dono, 10/11/2026), em PGlite:
//   • W ≤ 24h  → DOIS lembretes, em W/3 e 2W/3, a qualquer hora (inclusive de madrugada);
//   • W > 24h  → UM por dia durante toda a vida da demanda (sem fase semanal), só 08–20h SP,
//                gap mínimo de 20h entre dois lembretes;
//   • para no match e na expiração; a prévia (listarCandidatosLembrete) prevê o próximo;
//   • quem está no teto de 15 pushes/dia entra no resumo com texto de lembrete (ver também
//     testar-avisos-por-distancia.js).
// Uso: NODE_PATH=<pglite>/node_modules node scripts/testar-lembretes-cadencia.js
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

const pushes = []
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
  if (/brevoService$/.test(request)) return { enviarEmail: async () => {}, enviarEmailComAnexo: async () => {} }
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
// Relógio do banco (SP = UTC−3): sp('2026-11-10 08:00') → now() fixo nesse instante de São Paulo.
const sp = async (local) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${local}-03'::timestamptz $$`)
const PINTOR = U(1), RELE = U(2), DONO = U(900)
const tok = (id) => `ExponentPushToken[${id.slice(-3)}]`

const lembrar = async () => {
  silenciar(true); pushes.length = 0
  await alerta.lembrarDemandasSemResposta(); await assentar()
  silenciar(false)
  return pushes.filter(p => p.data?.lembrete)
}
const lembretesDe = async (lista, demandaId) => lista.filter(p => (p.data.obra_id || p.data.reparo_id) === demandaId).map(p => p.to)
const estado = async (tabela, id) => (await db.query(`SELECT lembretes_enviados AS n, to_char(lembrete_enviado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS ultimo FROM ${tabela} WHERE id = $1`, [id])).rows[0]
const previsto = async (tabela, id) => {
  const lados = await alerta.listarCandidatosLembrete(db)
  const d = lados.find(l => l.tabela === tabela)?.demandas.find(x => x.id === id)
  return d ? { fase: d.fase, proximo: d.proximo ? new Date(d.proximo).toISOString() : null, devida: d.devida_agora } : null
}
const isoSP = (local) => new Date(`${local}-03:00`).toISOString()

const main = async () => {
  db = new PGlite()
  await db.exec(`SET search_path = public, pg_catalog`)
  await sp('2026-11-10 10:00')
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, descricao text, categoria text, cidade text, uf text, bairro text, criado_por uuid, status text DEFAULT 'aberta',
      status_aprovacao text DEFAULT 'aprovada', match_usuario_id uuid, expira_em timestamptz, criado_em timestamptz DEFAULT now(), publicado_em timestamptz,
      prestadores_bloqueados uuid[], codigo_publico text, push_novo_enviado_em timestamptz DEFAULT now(), email_novo_pendente_em timestamptz, latitude numeric, longitude numeric,
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
  await require(path.join(REPO, 'src/utils/especialidadesInferidas')).migrarEspecialidadesInferidas(db)

  // reparos.local_atendimento + usuarios.atende_* (utils/localAtendimento) — a mesma migração de boot.

  await require(path.join(REPO, 'src/utils/localAtendimento')).migrarLocalAtendimento({ query: (s, p) => db.query(s, p) })
  const cliente = { query: (s, p) => db.query(s, p) }
  silenciar(true)
  await fa.migrarAvisosForaDaArea(cliente)
  await pd.migrarAvisosPorDistancia(cliente)
  silenciar(false)
  ok((await db.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'avisos_acima_do_teto' AND column_name = 'lembrete'`)).rows[0].n === 1,
     'migração: avisos_acima_do_teto.lembrete')

  for (const [id, nome, tipo, esp] of [[PINTOR, 'Pintor', 'pintor', ['pintor']], [RELE, 'Reparador', 'reparador', ['eletrica']]]) {
    await db.query(`INSERT INTO usuarios (id, nome, email, cidade, uf, role, tipo_prestador, cpf_cnpj, push_token, especialidades) VALUES ($1, $2, $3, 'Patos de Minas', 'MG', 'prestador', $4, $5, $6, $7)`,
      [id, nome, `${nome.toLowerCase()}@x.invalid`, tipo, id.slice(-11), tok(id), esp])
    await db.query(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [id])
  }
  await db.query(`INSERT INTO usuarios (id, nome, email, role, cidade, uf, cpf_cnpj) VALUES ($1, 'Dono', 'dono@x.invalid', 'dono_obra', 'Patos de Minas', 'MG', '10010010010')`, [DONO])

  const reparo = (id, titulo, horas, criadoSP) => db.query(
    `INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, criado_em, push_novo_enviado_em, expira_em)
     VALUES ($1, $2, 'eletrica', '{eletrica}', 'Patos de Minas', 'MG', 'Centro', $3, 150, $4::numeric, $5::timestamptz, $5::timestamptz, $5::timestamptz + $4::numeric * INTERVAL '1 hour')`,
    [id, titulo, DONO, horas, isoSP(criadoSP)])
  const obra = (id, titulo, horas, criadoSP) => db.query(
    `INSERT INTO obras (id, titulo, categoria, cidade, uf, bairro, criado_por, valor, horas_para_expirar, criado_em, publicado_em, push_novo_enviado_em, expira_em)
     VALUES ($1, $2, 'residencial', 'Patos de Minas', 'MG', 'Centro', $3, 1000, $4::numeric, $5::timestamptz, $5::timestamptz, $5::timestamptz, $5::timestamptz + $4::numeric * INTERVAL '1 hour')`,
    [id, titulo, DONO, horas, isoSP(criadoSP)])

  // ═══ 1. Fase CURTA (W = 12h): dois lembretes, em 4h e 8h, a qualquer hora ═════════════════════
  await reparo(D(1), 'Chuveiro (12h)', 12, '2026-11-10 10:00')
  let lem = await lembrar()
  ok(lem.length === 0, 'W=12h, recém-publicada (10:00): nada', lem.length)
  ok((await previsto('reparos', D(1)))?.fase === 'curta' && (await previsto('reparos', D(1)))?.proximo === isoSP('2026-11-10 14:00'), 'prévia: fase curta, próximo em W/3 = 14:00', await previsto('reparos', D(1)))
  await sp('2026-11-10 13:59'); lem = await lembrar()
  ok(lem.length === 0, '13:59 (antes de W/3): nada', lem.length)
  await sp('2026-11-10 14:00'); lem = await lembrar()
  ok((await lembretesDe(lem, D(1))).length === 1 && lem[0].to === tok(RELE) && lem[0].title === '🔔 Ainda aberto: Chuveiro (12h)', '14:00 (W/3): 1º lembrete ao reparador de elétrica', { n: lem.length, titulo: lem[0]?.title })
  ok((await estado('reparos', D(1))).n === 1, 'claim: lembretes_enviados = 1')
  await sp('2026-11-10 14:05'); lem = await lembrar()
  ok(lem.length === 0, '14:05: não repete a fatia', lem.length)
  ok((await previsto('reparos', D(1)))?.proximo === isoSP('2026-11-10 18:00'), 'prévia: próximo em 2W/3 = 18:00', await previsto('reparos', D(1)))
  await sp('2026-11-10 17:59'); lem = await lembrar()
  ok(lem.length === 0, '17:59: nada', lem.length)
  await sp('2026-11-10 18:00'); lem = await lembrar()
  ok((await lembretesDe(lem, D(1))).length === 1 && (await estado('reparos', D(1))).n === 2, '18:00 (2W/3): 2º lembrete', await estado('reparos', D(1)))
  await sp('2026-11-10 21:30'); lem = await lembrar()
  ok(lem.length === 0 && (await previsto('reparos', D(1)))?.proximo === null, '21:30: não há 3º lembrete; prévia sem próximo', await previsto('reparos', D(1)))
  // W = 6h publicada às 20:00 → lembretes às 22:00 e 00:00 (fora da janela 08–20, mesmo assim saem)
  await sp('2026-11-10 20:00')
  await reparo(D(2), 'Tomada (6h, noite)', 6, '2026-11-10 20:00')
  await sp('2026-11-10 22:00'); lem = await lembrar()
  ok((await lembretesDe(lem, D(2))).length === 1, 'W=6h publicada às 20:00: 1º lembrete às 22:00 (fase curta ignora a janela 08–20)', lem.length)
  await sp('2026-11-11 00:00'); lem = await lembrar()
  ok((await lembretesDe(lem, D(2))).length === 1, '00:00: 2º lembrete, de madrugada', lem.length)
  // fatia perdida (servidor parado entre 14:00 e 18:00) → só UM lembrete sai, não dois
  await reparo(D(3), 'Luz (12h, fatia perdida)', 12, '2026-11-10 20:00') // W/3 = 00:00, 2W/3 = 04:00
  await sp('2026-11-11 04:30'); lem = await lembrar()
  ok((await lembretesDe(lem, D(3))).length === 1, 'duas fatias passadas sem tique: sai UM lembrete (não repõe o perdido)', lem.length)
  await sp('2026-11-11 04:35'); lem = await lembrar()
  ok((await lembretesDe(lem, D(3))).length === 0 && (await estado('reparos', D(3))).n === 1, 'e nada no tique seguinte', await estado('reparos', D(3)))

  // ═══ 2. Fase DIÁRIA para W longa (30 dias): um por dia, a vida inteira, 08–20h ═══════════════
  await sp('2026-11-01 09:00')
  await obra(D(10), 'Fachada (30 dias)', 720, '2026-11-01 09:00')
  lem = await lembrar()
  ok(lem.length === 0 && (await previsto('obras', D(10)))?.fase === 'diaria', 'W=720h: fase DIÁRIA (não há mais fase semanal)', await previsto('obras', D(10)))
  ok((await previsto('obras', D(10)))?.proximo === isoSP('2026-11-02 09:00'), 'prévia: próximo amanhã às 09:00 (início da fatia 1)', await previsto('obras', D(10)))
  await sp('2026-11-02 07:30'); lem = await lembrar()
  ok(lem.length === 0, 'dia 2, 07:30: fatia ainda não começou (09:00)', lem.length)
  await sp('2026-11-02 09:05'); lem = await lembrar()
  ok((await lembretesDe(lem, D(10))).length === 1 && lem[0].to === tok(PINTOR), 'dia 2, 09:05: 1º lembrete diário ao pintor', lem.length)
  await sp('2026-11-02 19:55'); lem = await lembrar()
  ok(lem.length === 0, 'dia 2, 19:55: não repete no mesmo dia', lem.length)
  // dias 3..10: um por dia (o 8º dia era exatamente onde a regra antiga virava semanal)
  let diarios = 0
  for (let dia = 3; dia <= 10; dia++) {
    await sp(`2026-11-${String(dia).padStart(2, '0')} 09:05`); lem = await lembrar()
    diarios += (await lembretesDe(lem, D(10))).length
  }
  ok(diarios === 8 && (await estado('obras', D(10))).n === 9, 'dias 3 a 10: um lembrete por dia (9 no total) — sem fase semanal', await estado('obras', D(10)))
  // dia 11 fora da janela: 07:00 nada; 20:30 nada; dia 12 08:00 sai
  await sp('2026-11-11 07:00'); lem = await lembrar()
  ok(lem.length === 0, 'dia 11, 07:00: antes das 08h, adia', lem.length)
  await sp('2026-11-11 20:30'); lem = await lembrar()
  ok(lem.length === 0, 'dia 11, 20:30: depois das 20h, adia (fatia perdida)', lem.length)
  ok((await previsto('obras', D(10)))?.proximo === isoSP('2026-11-12 08:00'), 'prévia: próximo às 08:00 de amanhã', await previsto('obras', D(10)))
  await sp('2026-11-12 08:00'); lem = await lembrar()
  ok((await lembretesDe(lem, D(10))).length === 1, 'dia 12, 08:00: sai', lem.length)
  // gap mínimo de 20h: lembrete às 19:50 → no dia seguinte só a partir das 15:50
  await sp('2026-11-13 19:50'); lem = await lembrar()
  ok((await lembretesDe(lem, D(10))).length === 1, 'dia 13, 19:50: sai (fatia do dia 13)', lem.length)
  await sp('2026-11-14 09:00'); lem = await lembrar()
  ok(lem.length === 0, 'dia 14, 09:00: gap de 20h ainda não venceu (último 19:50)', lem.length)
  ok((await previsto('obras', D(10)))?.proximo === isoSP('2026-11-14 15:50'), 'prévia: próximo às 15:50 (gap de 20h)', await previsto('obras', D(10)))
  await sp('2026-11-14 15:51'); lem = await lembrar()
  ok((await lembretesDe(lem, D(10))).length === 1, 'dia 14, 15:51: sai (gap estrito de 20h vencido)', lem.length)
  // continua até o fim: dia 30 (último dia inteiro) ainda lembra; depois de expirar, não
  await sp('2026-11-30 09:00'); lem = await lembrar()
  ok((await lembretesDe(lem, D(10))).length === 1, 'dia 30 (faltam ~24h): ainda lembra', lem.length)
  await sp('2026-12-01 09:30'); lem = await lembrar()
  ok(lem.length === 0 && (await previsto('obras', D(10))) === null, 'expirada: nada e fora da prévia', lem.length)

  // ═══ 3. W = 72h (3 dias): diária como antes; match interrompe ════════════════════════════════
  await sp('2026-11-20 10:00')
  await reparo(D(20), 'Fiação (72h)', 72, '2026-11-20 10:00')
  await sp('2026-11-21 10:05'); lem = await lembrar()
  ok((await lembretesDe(lem, D(20))).length === 1, 'W=72h: lembrete no dia seguinte', lem.length)
  await db.query(`UPDATE reparos SET match_usuario_id = $2 WHERE id = $1`, [D(20), RELE])
  await sp('2026-11-22 10:05'); lem = await lembrar()
  ok(lem.length === 0 && (await previsto('reparos', D(20))) === null, 'com profissional escolhido: para', lem.length)
  // W via expira_em quando a coluna de prazo é NULL (demanda antiga): 48h → diária
  await sp('2026-11-20 10:00')
  await db.query(`INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, criado_em, push_novo_enviado_em, expira_em)
                  VALUES ($1, 'Sem prazo na coluna', 'eletrica', '{eletrica}', 'Patos de Minas', 'MG', 'Centro', $2, 100, NULL, now(), now(), now() + INTERVAL '48 hours')`, [D(21), DONO])
  ok((await previsto('reparos', D(21)))?.fase === 'diaria' && (await previsto('reparos', D(21)))?.proximo === isoSP('2026-11-21 10:00'), 'prazo NULL: W = expira_em − criado_em (48h) → diária, próximo amanhã 10:00', await previsto('reparos', D(21)))

  const inesperados = erros.filter(e => !/sem banco|PAGBANK|migration/i.test(e))
  ok(inesperados.length === 0, 'nenhum erro logado', inesperados.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error = errOrig; console.error('ERRO', e); process.exit(1) })
