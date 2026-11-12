#!/usr/bin/env node
// Testa PATCH /reparos/dono/:id/categorias e o aviso de categorias adicionadas
// (alertaService.notificarCategoriasAdicionadas) com o SQL REAL em Postgres em memória (PGlite).
// Expo e Brevo trocados por fakes que só coletam destinatários; handler chamado direto.
//   npm i -D @electric-sql/pglite && node scripts/testar-editar-categorias.js
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

const pushes = [], emails = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { pushes.push(...chunk); return chunk.map((_, i) => ({ status: 'ok', id: `t${pushes.length}-${i}` })) }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
const client = () => ({ query: (sql, params) => db.query(sql, params), release() {} })
const shim = {
  query: (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return db.query(sql, params) },
  connect: async () => { if (!db) throw new Error('sem banco (boot)'); return client() },
  on() {},
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async ({ para, assunto }) => { emails.push({ para, assunto }) } }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error
console.log = () => {}; console.error = () => {}
const router = require(path.join(REPO, 'src/routes/index.js'))
console.log = logOrig; console.error = errOrig
const A = require(path.join(REPO, 'src/services/alertaService'))

const layer = router.stack.find(l => l.route && l.route.path === '/reparos/dono/:id/categorias' && l.route.methods.patch)
const handler = layer.route.stack[layer.route.stack.length - 1].handle
const patch = (usuarioId, id, categorias) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params: { id }, body: { categorias }, usuario: { id: usuarioId, role: 'dono_obra' } }, res)
})
const esperar = (ms) => new Promise(r => setTimeout(r, ms))
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const quem = (lista, campo) => lista.map(m => Number(String(m[campo]).replace(/\D/g, ''))).sort((a, b) => a - b)
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const main = async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, role text, tipo_prestador text, especialidades text[], push_token text,
      suspenso_em timestamptz, desinstalado_em timestamptz, cidade text, uf text, cpf_cnpj text, indicacao_pedida_em timestamptz,
      latitude numeric, longitude numeric, raio_km_escolhido numeric);
    CREATE TABLE assinaturas (usuario_id uuid, status text, proximo_vencimento timestamptz);
    CREATE TABLE reparos (id uuid PRIMARY KEY, titulo text, cidade text, uf text, bairro text, categoria text, categorias text[], valor_estimado numeric,
      criado_por uuid, status text, status_aprovacao text, match_usuario_id uuid, expira_em timestamptz, push_novo_enviado_em timestamptz,
      criado_em timestamptz DEFAULT now(), codigo_publico text, latitude numeric, longitude numeric);
    CREATE TABLE interesse_reparos (reparo_id uuid, usuario_id uuid);
    CREATE TABLE avisos_fora_area (tabela text, demanda_id uuid, usuario_id uuid, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE lembretes_push_enviados (tabela text, demanda_id uuid, usuario_id uuid, motivo text, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE avisos_acima_do_teto (tabela text, demanda_id uuid, usuario_id uuid, criado_em timestamptz NOT NULL DEFAULT now(), resumo_em timestamptz, PRIMARY KEY (tabela, demanda_id, usuario_id));
    CREATE TABLE push_entregas (tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1,
      primeira_tentativa_em timestamptz DEFAULT now(), ultima_tentativa_em timestamptz DEFAULT now(), PRIMARY KEY (tipo, demanda_id, usuario_id));
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE configuracoes (chave text, valor text);
    INSERT INTO configuracoes VALUES ('grupos_relacionados_ativo', 'true');
  `)
  // reparos.local_atendimento + usuarios.atende_* (utils/localAtendimento) — a mesma migração de boot.
  await require(path.join(REPO, 'src/utils/localAtendimento')).migrarLocalAtendimento({ query: (s, p) => db.query(s, p) })
  const prof = async (n, esp, { token = true, suspenso = null, cpf = null, cidade = 'Uberlândia', role = 'prestador', tipo = 'reparador' } = {}) => {
    await db.query(`INSERT INTO usuarios VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, 'MG', $10, NULL)`,
      [U(n), `Prof ${n}`, `p${n}@x.invalid`, role, tipo, esp, token ? `ExponentPushToken[u${n}]` : null, suspenso, cidade, cpf])
    await db.query(`INSERT INTO assinaturas VALUES ($1, 'ativa', NULL)`, [U(n)])
  }
  await prof(99, null, { role: 'dono_obra', tipo: null, cpf: '111.111.111-11', token: false }) // dono
  await prof(1, ['eletrica'])        // avisado no original (push + e-mail)
  await prof(2, ['eletronica'])      // grupo antigo; push original FALHOU (linha 'falha'), sem e-mail
  await prof(3, ['climatizacao'])    // grupo antigo; nunca avisado (sem linha) → fora mesmo assim (excluirCategorias)
  await prof(4, ['hidraulica'])      // entra pelo grupo novo: push + e-mail
  await prof(5, ['alvenaria'])       // mesmo grupo de hidraulica (Reparos da casa): push + e-mail
  await prof(6, ['faxina'])          // fora dos dois
  await prof(7, ['hidraulica'], { token: false }) // sem token: só e-mail
  await prof(8, ['hidraulica'], { suspenso: '2026-11-01' }) // suspenso: nada
  await prof(9, ['hidraulica'])      // já tem linha em push_entregas (repescagem antiga): sem push, e-mail sim
  await prof(11, ['hidraulica'], { cpf: '11111111111' }) // outra conta do dono: nada
  await prof(12, ['hidraulica'], { cidade: 'Araguari' })  // outra cidade: nada

  await db.query(`INSERT INTO reparos VALUES ($1, 'Troca de fiação', 'Uberlândia', 'MG', 'Centro', 'eletrica', '{eletrica}', 300, $2, 'aberta', 'aprovada', NULL,
                  now() + INTERVAL '3 days', now() - INTERVAL '2 hours', now() - INTERVAL '2 hours', 'ABCDE')`, [D(1), U(99)])
  await db.query(`INSERT INTO push_entregas (tipo, demanda_id, usuario_id, resultado) VALUES ('reparo', $1, $2, 'enviado'), ('reparo', $1, $3, 'falha'), ('reparo', $1, $4, 'enviado')`, [D(1), U(1), U(2), U(9)])
  await db.query(`INSERT INTO email_alertas (tipo, demanda_id, usuario_id) VALUES ('reparo', $1, $2)`, [D(1), U(1)])
  // R2: ainda NÃO anunciado (push_novo_enviado_em NULL). R3: encerrado. R4: de outro dono.
  await db.query(`INSERT INTO reparos VALUES ($1, 'Pia', 'Uberlândia', 'MG', NULL, 'hidraulica', '{hidraulica}', 100, $2, 'aberta', 'aprovada', NULL, now() + INTERVAL '3 days', NULL, now(), 'FGHJK')`, [D(2), U(99)])
  await db.query(`INSERT INTO reparos VALUES ($1, 'Velho', 'Uberlândia', 'MG', NULL, 'faxina', '{faxina}', 100, $2, 'encerrada', 'aprovada', NULL, now() + INTERVAL '3 days', now(), now(), 'MNPQR')`, [D(3), U(99)])
  await db.query(`INSERT INTO reparos VALUES ($1, 'Alheio', 'Uberlândia', 'MG', NULL, 'faxina', '{faxina}', 100, $2, 'aberta', 'aprovada', NULL, now() + INTERVAL '3 days', now(), now(), 'STUVW')`, [D(4), U(1)])

  // --- validação
  let r = await patch(U(99), 'nao-e-uuid', ['eletrica'])
  ok(r.status === 404, 'id inválido → 404', r.body)
  r = await patch(U(99), D(1), [])
  ok(r.status === 400 && /obrigat/i.test(r.body.erro), 'lista vazia → 400', r.body)
  r = await patch(U(99), D(1), ['eletrica', 'hidraulica', 'faxina', 'pintura'])
  ok(r.status === 400 && /máximo 3/.test(r.body.erro), '4 categorias → 400', r.body)
  r = await patch(U(99), D(1), ['eletrica', 'eletrica'])
  ok(r.status === 400 && /repetidas/.test(r.body.erro), 'repetidas → 400', r.body)
  r = await patch(U(99), D(1), ['eletrica', 'pintor'])
  ok(r.status === 400 && /inválida: pintor/.test(r.body.erro), 'slug de obra → 400', r.body)
  r = await patch(U(99), D(4), ['faxina', 'eletrica'])
  ok(r.status === 404, 'reparo de outro dono → 404', r.body)
  r = await patch(U(99), D(3), ['faxina', 'eletrica'])
  ok(r.status === 409 && r.body.codigo === 'reparo_fechado', 'reparo encerrado → 409 reparo_fechado', r.body)
  ok(pushes.length === 0 && emails.length === 0, 'nada enviado até aqui')

  // --- R2 não anunciado: grava, mas não avisa (o aviso original sairá com a lista nova)
  r = await patch(U(99), D(2), ['hidraulica', 'eletrica'])
  await esperar(300)
  ok(r.status === 200 && r.body.aviso === 'nenhum' && JSON.stringify(r.body.adicionadas) === '["eletrica"]' && pushes.length === 0 && emails.length === 0,
     'reparo ainda não anunciado: salva, aviso = nenhum, zero envios', r.body)

  // --- R1: adiciona hidraulica (grupo Reparos da casa)
  r = await patch(U(99), D(1), ['eletrica', 'hidraulica'])
  ok(r.status === 200 && r.body.categoria === 'eletrica' && JSON.stringify(r.body.categorias) === '["eletrica","hidraulica"]'
     && JSON.stringify(r.body.adicionadas) === '["hidraulica"]' && r.body.removidas.length === 0 && r.body.aviso === 'disparado',
     'PATCH grava categorias/categoria, adicionadas=[hidraulica], aviso disparado', r.body)
  await esperar(600)
  ok(JSON.stringify(quem(pushes, 'to')) === JSON.stringify([4, 5]), 'push só a U4 e U5 (grupo novo, nunca avisados) — fora: já avisados, grupo antigo, sem token, suspenso, outra cidade, CPF do dono', quem(pushes, 'to'))
  ok(pushes[0]?.title === '⚡ Novo serviço disponível!' && /Troca de fiação.*Elétrica \+1/.test(pushes[0]?.body) && pushes[0]?.data.tipo === 'novo_reparo' && pushes[0]?.data.reparo_id === D(1),
     'texto = aviso de demanda nova (emoji da categoria principal, "Elétrica +1"), data novo_reparo', { title: pushes[0]?.title, body: pushes[0]?.body })
  ok(JSON.stringify(quem(emails, 'para')) === JSON.stringify([4, 5, 7, 9]), 'e-mail a U4, U5, U7 (sem token) e U9 (push já registrado, e-mail não) — U1 barrado pelo UNIQUE, U2/U3 pelo grupo antigo', quem(emails, 'para'))
  ok(emails[0]?.assunto === '⚡ Novo serviço disponível!', 'assunto do e-mail = título do push', emails[0]?.assunto)
  const entregas = await db.query(`SELECT usuario_id FROM push_entregas WHERE demanda_id = $1 ORDER BY usuario_id`, [D(1)])
  const ids = entregas.rows.map(x => Number(x.usuario_id.slice(-2)))
  ok(ids.join() === [1, 2, 4, 5, 9].join(), 'push_entregas ganhou U4 e U5 (edições futuras os veem como avisados)', ids)
  const ea = await db.query(`SELECT usuario_id FROM email_alertas WHERE demanda_id = $1 AND tipo = 'reparo'`, [D(1)])
  ok(ea.rows.length === 5, "email_alertas com tipo 'reparo' para os 4 novos + U1", ea.rows.length)

  // --- remover eletrica: nada
  const p0 = pushes.length, e0 = emails.length
  r = await patch(U(99), D(1), ['hidraulica'])
  await esperar(300)
  ok(r.status === 200 && JSON.stringify(r.body.removidas) === '["eletrica"]' && r.body.adicionadas.length === 0 && r.body.aviso === 'nenhum' && pushes.length === p0 && emails.length === e0,
     'remover categoria: removidas=[eletrica], aviso nenhum, zero envios', r.body)

  // --- adicionar 'outros': regra do Outros — push a TODO reparador da cidade ainda não avisado e fora do grupo antigo; e-mail só aos grupos (nada novo)
  r = await patch(U(99), D(1), ['hidraulica', 'outros'])
  await esperar(600)
  const novos = pushes.slice(p0)
  ok(r.body.aviso === 'disparado' && JSON.stringify(quem(novos, 'to')) === JSON.stringify([3, 6]),
     "'outros' adicionado: push a U3 e U6 (fora do grupo hidraulica e sem linha) — U1/U2/U4/U5/U9 já avisados, U8 suspenso, U11 CPF, U12 cidade", quem(novos, 'to'))
  ok(emails.length === e0, "'outros': e-mail fica restrito aos grupos — ninguém novo", emails.length - e0)

  // --- idempotência: repetir a mesma lista não adiciona nada
  const p1 = pushes.length
  r = await patch(U(99), D(1), ['hidraulica', 'outros'])
  await esperar(200)
  ok(r.body.adicionadas.length === 0 && r.body.aviso === 'nenhum' && pushes.length === p1, 'mesma lista de novo: nada', r.body)

  // --- chamada direta com reparo casado: null
  await db.query(`UPDATE reparos SET match_usuario_id = $2 WHERE id = $1`, [D(1), U(4)])
  const direto = await A.notificarCategoriasAdicionadas(D(1), ['hidraulica'])
  ok(direto === null, 'notificarCategoriasAdicionadas com match: null (não avisa)', direto)

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
