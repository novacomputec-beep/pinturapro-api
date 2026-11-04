#!/usr/bin/env node
// Testa pedirIndicacoes (alertaService) com o SQL REAL num Postgres em memória (PGlite):
// pool do repo trocado por um shim, Expo trocado por um fake que só coleta as mensagens,
// NOW() sombreado por public.now() para fixar a hora de São Paulo (janela 08–20h).
//   npm i -D @electric-sql/pglite && node scripts/testar-pedido-indicacao.js
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

const enviados = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { enviados.push(...chunk); return chunk.map((_, i) => ({ status: 'ok', id: `t${enviados.length}-${i}` })) }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}

let db
const shim = {
  query: (sql, params) => db.query(sql, params),
  connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }),
  on() {},
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  return origLoad.apply(this, arguments)
}

const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const NOW_DENTRO = '2026-11-04T17:00:00Z' // 14:00 São Paulo
const NOW_FORA   = '2026-11-05T01:00:00Z' // 22:00 São Paulo
const fixarAgora = (iso) => db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${iso}'::timestamptz $$`)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const main = async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, role text, tipo_prestador text, especialidades text[],
      push_token text, suspenso_em timestamptz, desinstalado_em timestamptz, cidade text, uf text, cpf_cnpj text, indicacao_pedida_em timestamptz);
    CREATE TABLE assinaturas (usuario_id uuid, status text, proximo_vencimento timestamptz);
    CREATE TABLE reparos (id uuid PRIMARY KEY, titulo text, cidade text, uf text, bairro text, categoria text, categorias text[], valor_estimado numeric,
      criado_por uuid, status text, status_aprovacao text, match_usuario_id uuid, expira_em timestamptz, push_novo_enviado_em timestamptz,
      indicacao_enviada_em timestamptz, criado_em timestamptz);
    CREATE TABLE obras (id uuid PRIMARY KEY, titulo text, cidade text, uf text, bairro text, categoria text, valor numeric,
      criado_por uuid, status text, status_aprovacao text, match_usuario_id uuid, expira_em timestamptz, push_novo_enviado_em timestamptz,
      indicacao_enviada_em timestamptz, criado_em timestamptz);
    CREATE TABLE interesse_reparos (reparo_id uuid, usuario_id uuid);
    CREATE TABLE candidaturas (obra_id uuid, usuario_id uuid);
    CREATE TABLE configuracoes (chave text, valor text);
    INSERT INTO configuracoes VALUES ('grupos_relacionados_ativo', 'true');
    SET search_path = public, pg_catalog;
  `)
  await fixarAgora(NOW_DENTRO)

  // Profissionais em Uberlândia/MG (todos com assinatura ativa e token, salvo onde indicado)
  const prof = async (n, { tipo = 'reparador', esp = ['faxina'], cidade = 'Uberlândia', uf = 'MG', suspenso = null, cpf = null, pedidaEm = null, role = 'prestador', token = true } = {}) => {
    await db.query(`INSERT INTO usuarios VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, $12)`,
      [U(n), `Prof ${n}`, `p${n}@x.invalid`, role, tipo, esp, token ? `ExponentPushToken[u${n}]` : null, suspenso, cidade, uf, cpf, pedidaEm])
    await db.query(`INSERT INTO assinaturas VALUES ($1, 'ativa', NULL)`, [U(n)])
  }
  await prof(99, { role: 'dono_obra', tipo: null, esp: null, cpf: '111.111.111-11', token: false }) // dono
  await prof(1, { esp: ['eletrica'] })                     // no grupo → fora
  await prof(2, { esp: ['eletronica'] })                   // mesmo grupo (Elétrica e tecnologia) → fora
  await prof(3, { esp: ['faxina'] })                       // entra
  await prof(4, { esp: ['manicure'], pedidaEm: '2026-11-03T17:00:00Z' }) // gap (1 dia) → fora
  await prof(5, { esp: ['manicure'], pedidaEm: '2026-10-31T16:00:00Z' }) // 4 dias → entra
  await prof(6, { esp: ['faxina'], suspenso: '2026-11-01T00:00:00Z' })   // suspenso → fora
  await prof(7, { tipo: 'pintor', esp: ['pintor'] })       // pintor: fora do reparo, entra na obra
  await prof(8, { esp: ['faxina'], cidade: 'Araguari' })   // outra cidade → fora
  await prof(10, { esp: null })                            // especialidades NULL → "fora do grupo" → entra
  await prof(11, { esp: ['faxina'], cpf: '11111111111' })  // outra conta do dono (mesmo CPF) → fora

  const reparo = (n, { categorias, horasAtras, bairro = 'Santa Mônica', valor = 150, interessado = null }) => db.query(
    `INSERT INTO reparos VALUES ($1, $2, 'Uberlândia', 'MG', $3, $4, $5, $6, $7, 'aberta', 'aprovada', NULL,
       now() + INTERVAL '5 days', now() - ($8 * INTERVAL '1 hour') + INTERVAL '1 minute', NULL, now() - ($8 * INTERVAL '1 hour'))`,
    [D(n), `Reparo ${n}`, bairro, categorias[0], categorias, valor, U(99), horasAtras]
  ).then(() => interessado && db.query(`INSERT INTO interesse_reparos VALUES ($1, $2)`, [D(n), interessado]))
  await reparo(1, { categorias: ['eletrica', 'hidraulica'], horasAtras: 50 })
  await reparo(2, { categorias: ['faxina'], horasAtras: 50, interessado: U(3) }) // tem interessado → não
  await reparo(3, { categorias: ['faxina'], horasAtras: 40 })                    // < 48h → não
  await reparo(4, { categorias: ['outros'], horasAtras: 60, valor: 0, bairro: null })
  await db.query(
    `INSERT INTO obras VALUES ($1, 'Pintura casa', 'Uberlândia', 'MG', 'Centro', 'residencial', 5000, $2, 'aberta', 'aprovada', NULL,
       now() + INTERVAL '10 days', now() - INTERVAL '49 hours', NULL, now() - INTERVAL '50 hours')`, [D(5), U(99)])

  const A = require(path.join(REPO, 'src/services/alertaService'))

  // 1) Fora da janela (22h SP): nenhum claim
  await fixarAgora(NOW_FORA)
  await A.pedirIndicacoes()
  const c0 = await db.query(`SELECT count(*)::int n FROM reparos WHERE indicacao_enviada_em IS NOT NULL`)
  ok(c0.rows[0].n === 0 && enviados.length === 0, 'fora da janela 08–20h: nenhum claim, nenhum push')

  // 2) Dentro da janela (14h SP): o cron real
  await fixarAgora(NOW_DENTRO)
  await A.pedirIndicacoes()
  const claimR = await db.query(`SELECT id FROM reparos WHERE indicacao_enviada_em IS NOT NULL ORDER BY id`)
  ok(JSON.stringify(claimR.rows.map(r => r.id)) === JSON.stringify([D(1), D(4)]), 'claim: só R1 (eletrica+hidraulica, 50h) e R4 (outros, 60h)', claimR.rows.map(r => r.id.slice(-2)))
  const claimO = await db.query(`SELECT count(*)::int n FROM obras WHERE indicacao_enviada_em IS NOT NULL`)
  ok(claimO.rows[0].n === 1, 'claim: obra O5 (50h, 0 candidaturas)')

  const porDemanda = (id) => enviados.filter(m => (m.data.reparo_id || m.data.obra_id) === id)
  const quem = (lista) => lista.map(m => m.to.replace(/\D/g, '')).map(Number).sort((a, b) => a - b)
  const r1 = porDemanda(D(1)), r4 = porDemanda(D(4)), o5 = porDemanda(D(5))
  const reparoTodos = [...r1, ...r4]
  ok(JSON.stringify(quem(reparoTodos)) === JSON.stringify([1, 2, 3, 5, 10]), 'reparos: público = U1,U2 (só via R4) + U3,U5,U10 — fora: grupo, gap 1d, suspenso, pintor, outra cidade, CPF do dono', quem(reparoTodos))
  ok(quem(r1).every(u => ![1, 2].includes(u)), 'R1 (Elétrica): U1/U2 do grupo Elétrica e tecnologia excluídos', quem(r1))
  ok(quem(r4).every(u => [1, 2, 3, 5, 10].includes(u)), 'R4 (outros sozinho): só quem não marcou outros', quem(r4))
  const porUsuario = {}
  for (const m of enviados) porUsuario[m.to] = (porUsuario[m.to] || 0) + 1
  ok(Object.values(porUsuario).every(n => n === 1), 'ninguém recebeu 2 pedidos no mesmo tique (gap entre demandas)', porUsuario)
  ok(JSON.stringify(quem(o5)) === JSON.stringify([7]), 'obra: só o pintor U7', quem(o5))

  const m1 = r1[0]
  ok(m1?.title === 'Conhece alguém que faz Elétrica? 🔧', 'título reparo com a categoria principal', m1?.title)
  ok(m1?.body === 'Tem um pedido de R$ 150 aberto em Santa Mônica. Indique o ProTudo para quem faz esse serviço!', 'corpo reparo', m1?.body)
  ok(m1?.data.tipo === 'novo_reparo' && m1?.data.reparo_id === D(1) && m1?.data.indicacao === true, 'data: novo_reparo + reparo_id + indicacao:true', m1?.data)
  const m4 = r4[0]
  ok(m4?.title === 'Conhece alguém que faz Outros? 🔧' && m4?.body === 'Tem um pedido aberto em Uberlândia. Indique o ProTudo para quem faz esse serviço!', 'sem valor e sem bairro: cai para cidade, sem "de R$"', [m4?.title, m4?.body])
  const mo = o5[0]
  ok(mo?.title === 'Conhece alguém que faz obra residencial? 🔧' && mo?.body === 'Tem um pedido de R$ 5.000 aberto em Centro. Indique o ProTudo para quem faz esse serviço!', 'título/corpo obra', [mo?.title, mo?.body])
  ok(mo?.data.tipo === 'nova_obra' && mo?.data.obra_id === D(5) && mo?.data.indicacao === true, 'data obra', mo?.data)

  const carimbos = await db.query(`SELECT id FROM usuarios WHERE indicacao_pedida_em = now() ORDER BY id`)
  ok(JSON.stringify(carimbos.rows.map(r => Number(r.id.slice(-2)))) === JSON.stringify([1, 2, 3, 5, 7, 10]), 'indicacao_pedida_em carimbado em quem recebeu', carimbos.rows.map(r => r.id.slice(-2)))

  // 3) Segundo tique: nada (uma vez por demanda)
  const antes = enviados.length
  await A.pedirIndicacoes()
  ok(enviados.length === antes, 'segundo tique: nenhum push novo (claim por demanda)')

  // 4) Demanda nova 3 dias depois: quem recebeu há 3 dias volta a ser elegível, U4 (gap de 4 dias agora) também
  await fixarAgora('2026-11-07T17:00:01Z')
  await db.query(`INSERT INTO reparos VALUES ($1, 'Reparo 6', 'Uberlândia', 'MG', 'Tibery', 'manicure', '{manicure}', 80, $2, 'aberta', 'aprovada', NULL,
     now() + INTERVAL '5 days', now() - INTERVAL '49 hours', NULL, now() - INTERVAL '50 hours')`, [D(6), U(99)])
  await A.pedirIndicacoes()
  ok(JSON.stringify(quem(porDemanda(D(6)))) === JSON.stringify([1, 2, 3, 10]), 'R6 (manicure) 3 dias depois: U1,U2,U3,U10 elegíveis de novo (gap vencido); U4/U5 (Beleza) fora', quem(porDemanda(D(6))))
  // R3 (faxina) completou 48h nesse meio-tempo: sobra U4 (gap de 4 dias, fora de Beleza... e de Limpeza) e U5; os demais acabaram de ser carimbados por R6.
  ok(JSON.stringify(quem(porDemanda(D(3)))) === JSON.stringify([4, 5]), 'R3 (faxina) no mesmo tique: só U4 e U5 — os outros já receberam por R6', quem(porDemanda(D(3))))

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
