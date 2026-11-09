#!/usr/bin/env node
// Mensagens prontas entre o dono e o profissional escolhido (obras e reparos):
//   • catálogo servido pelo servidor por fase (aguardando_horario, agendado, a_caminho) e papel;
//   • GET  /:tabela/:id/mensagens-prontas — catálogo da fase + histórico; só o dono (qualquer conta
//     contratante da mesma pessoa) e o profissional escolhido (qualquer conta profissional dele);
//   • POST — só por frase_id (texto livre nunca é gravado); fase derivada do estado da demanda;
//     no máximo 5 por pessoa por fase, cada frase uma vez por fase; 409 FASE_INCORRETA /
//     FRASE_REPETIDA / LIMITE_ATINGIDO; push imediato ao outro lado com a frase, abrindo o detalhe.
// SQL REAL num Postgres em memória (PGlite); Expo/Brevo falsos que só coletam.
//   npm i -D @electric-sql/pglite && node scripts/testar-mensagens-prontas.js
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
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) } }
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
const { autenticar } = require(path.join(REPO, 'src/middlewares/auth'))
const mp = require(path.join(REPO, 'src/utils/mensagensProntas'))
const servico = require(path.join(REPO, 'src/services/mensagensProntasService'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 120))
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const tok = (nome) => `ExponentPushToken[${nome}]`

const DONO = U(1), DONO_IRMA = U(2), PROF = U(3), PROF_IRMA = U(4), ESTRANHO_PROF = U(5), ESTRANHO_DONO = U(6), OUTRO_PROF = U(7), DONO_SEM_TOKEN = U(8)
const h = { reparos: servico.handlers('reparos'), obras: servico.handlers('obras') }
const chamar = (handler, usuarioId, id, body = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params: { id }, body, usuario: { id: usuarioId } }, res)
})
const ver = (tabela, usuarioId, id) => chamar(h[tabela].listar, usuarioId, id)
const enviar = async (tabela, usuarioId, id, body) => { pushes.length = 0; emails.length = 0; silenciar(true); const r = await chamar(h[tabela].enviar, usuarioId, id, typeof body === 'string' ? { frase_id: body } : body); await assentar(); silenciar(false); return r }
const textos = (frases) => frases.map(f => f.texto)

// As frases pedidas, na ordem pedida.
const ESPERADO = {
  aguardando_horario: {
    dono: ['Pode vir pela manhã?', 'Prefiro à tarde', 'Qualquer dia serve', 'Vou mandar fotos', 'Ainda estou vendo'],
    profissional: ['Propus um horário, fica bom pra você?', 'Preciso de fotos do local?', 'Vou enviar o horário hoje', 'Posso ir em outro dia'],
  },
  agendado: {
    dono: ['Confirmado, te espero!', 'Eu compro o material', 'Vou precisar remarcar', 'Me avise quando sair'],
    profissional: ['Tudo certo, até lá!', 'Me passe a lista do material', 'Vou levar o material', 'Vou precisar remarcar'],
  },
  a_caminho: {
    dono: ['O portão está aberto', 'Toque a campainha', 'Estou te esperando', 'Vou atrasar 10 min'],
    profissional: ['Chego em 10 minutos', 'Estou chegando', 'Vou atrasar 10 min', 'Cheguei, estou no portão'],
  },
}

const main = async () => {
  // ═══ 0. Catálogo e fase (peças puras) ══════════════════════════════════════════════════════
  ok(igual(mp.FASES, ['aguardando_horario', 'agendado', 'a_caminho']) && mp.LIMITE_POR_FASE === 5, 'fases e limite de 5 por fase')
  for (const fase of mp.FASES) for (const papel of mp.PAPEIS) {
    ok(igual(textos(mp.frasesDe(fase, papel)), ESPERADO[fase][papel]), `catálogo ${fase} / ${papel}: as frases pedidas, na ordem`, textos(mp.frasesDe(fase, papel)))
  }
  const todosIds = mp.FASES.flatMap(f => mp.PAPEIS.flatMap(p => mp.frasesDe(f, p).map(x => x.id)))
  ok(todosIds.length === 25 && new Set(todosIds).size === 25, '25 frases, ids únicos', todosIds.length)
  const base = { status: 'aberta', match_usuario_id: PROF }
  ok(mp.faseDaDemanda(base) === 'aguardando_horario' && mp.faseDaDemanda({ ...base, chegada_pendente_em: new Date() }) === 'aguardando_horario',
     'fase: com profissional escolhido e sem horário combinado (mesmo com proposta pendente) → aguardando_horario')
  ok(mp.faseDaDemanda({ ...base, chegada_prevista_em: new Date() }) === 'agendado', 'fase: horário combinado → agendado')
  ok(mp.faseDaDemanda({ ...base, chegada_prevista_em: new Date(), a_caminho_em: new Date() }) === 'a_caminho' && mp.faseDaDemanda({ ...base, a_caminho_em: new Date() }) === 'a_caminho',
     'fase: "Estou a caminho" → a_caminho (com ou sem horário combinado)')
  ok(mp.faseDaDemanda({ status: 'aberta', match_usuario_id: null }) === null && mp.faseDaDemanda({ ...base, status: 'encerrada' }) === null
     && mp.faseDaDemanda({ ...base, a_caminho_em: new Date(), chegada_confirmada_em: new Date() }) === null && mp.faseDaDemanda(null) === null,
     'sem fase: sem profissional escolhido, demanda fechada ou chegada confirmada')

  // ═══ 1. Rotas registradas: só autenticar ═══════════════════════════════════════════════════
  for (const tabela of ['obras', 'reparos']) {
    const rotas = router.stack.filter(l => l.route && l.route.path === `/${tabela}/:id/mensagens-prontas`).map(l => l.route)
    const metodos = rotas.flatMap(r => Object.keys(r.methods)).sort()
    ok(igual(metodos, ['get', 'post']) && rotas.every(r => r.stack.length === 2 && r.stack[0].handle === autenticar),
       `rotas GET e POST /${tabela}/:id/mensagens-prontas registradas, só com autenticar`, metodos)
  }

  // ═══ 2. Banco ══════════════════════════════════════════════════════════════════════════════
  db = new PGlite()
  const colsDemanda = `id uuid PRIMARY KEY, titulo text, criado_por uuid, status text DEFAULT 'aberta', match_usuario_id uuid,
      chegada_pendente_em timestamptz, chegada_prevista_em timestamptz, a_caminho_em timestamptz, chegada_declarada_em timestamptz, chegada_confirmada_em timestamptz`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, role text, tipo_dono text, tipo_prestador text, cpf_cnpj text, push_token text,
      suspenso_em timestamptz, desinstalado_em timestamptz);
    CREATE TABLE obras (${colsDemanda});
    CREATE TABLE reparos (${colsDemanda});
  `)
  const cliente = { query: (s, p) => db.query(s, p) }
  await mp.migrarMensagensProntas(cliente)
  await mp.migrarMensagensProntas(cliente) // idempotente
  const colunas = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'mensagens_prontas_enviadas' ORDER BY ordinal_position`)).rows.map(x => x.column_name)
  ok(igual(colunas, ['id', 'tipo', 'demanda_id', 'remetente_id', 'papel', 'profissional_id', 'fase', 'frase_id', 'texto', 'enviado_em']), 'migração (2 execuções): tabela mensagens_prontas_enviadas', colunas)

  const usuario = (id, nome, role, tipo, cpf, token, email = `${nome.toLowerCase().replace(/\W/g, '')}@x.invalid`) => db.query(
    `INSERT INTO usuarios (id, nome, email, role, tipo_dono, tipo_prestador, cpf_cnpj, push_token) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, nome, email, role, role === 'dono_obra' ? tipo : null, role === 'prestador' ? tipo : null, cpf, token])
  await usuario(DONO, 'Maria', 'dono_obra', 'reparo', '111.111.111-11', tok('maria'), 'maria@x.invalid')
  await usuario(DONO_IRMA, 'Maria Obras', 'dono_obra', 'pintura', '11111111111', null)            // outra conta contratante da MESMA pessoa
  await usuario(PROF, 'Alex', 'prestador', 'reparador', '222.222.222-22', tok('alex'))
  await usuario(PROF_IRMA, 'Alex Pintor', 'prestador', 'pintor', '22222222222', null)             // outra conta profissional do MESMO CPF
  await usuario(ESTRANHO_PROF, 'Beto', 'prestador', 'reparador', '333.333.333-33', tok('beto'))
  await usuario(ESTRANHO_DONO, 'Outra Maria', 'dono_obra', 'reparo', '444.444.444-44', tok('outra'), 'maria@x.invalid') // MESMO e-mail, outro CPF
  await usuario(OUTRO_PROF, 'Caio', 'prestador', 'reparador', '555.555.555-55', tok('caio'))
  await usuario(DONO_SEM_TOKEN, 'Sem Token', 'dono_obra', 'reparo', '666.666.666-66', null)
  const demanda = (tabela, n, titulo, extra = {}) => db.query(
    `INSERT INTO ${tabela} (id, titulo, criado_por, status, match_usuario_id) VALUES ($1, $2, $3, $4, $5)`,
    [D(n), titulo, extra.dono || DONO, extra.status || 'aberta', extra.match === undefined ? PROF : extra.match])
  await demanda('reparos', 1, 'Trocar chuveiro')
  await demanda('obras', 2, 'Pintura da sala')
  await demanda('reparos', 3, 'Sem escolhido', { match: null })
  await demanda('reparos', 4, 'Troca de profissional')
  await demanda('reparos', 5, 'Dono sem token', { dono: DONO_SEM_TOKEN })
  const linhas = async (n) => (await db.query(`SELECT tipo, demanda_id, remetente_id, papel, profissional_id, fase, frase_id, texto FROM mensagens_prontas_enviadas WHERE demanda_id = $1 ORDER BY enviado_em, id`, [D(n)])).rows

  // ═══ 3. GET: catálogo da fase + histórico, só para quem participa ══════════════════════════
  let r = await ver('reparos', DONO, D(1))
  ok(r.status === 200 && r.body.fase === 'aguardando_horario' && r.body.papel === 'dono' && r.body.limite === 5 && r.body.restantes === 5
     && igual(textos(r.body.frases), ESPERADO.aguardando_horario.dono) && r.body.frases.every(f => f.id && f.enviada === false) && igual(r.body.historico, []),
     'GET do dono: fase aguardando_horario, as 5 frases do dono, 5 restantes, histórico vazio', { fase: r.body.fase, papel: r.body.papel, frases: r.body.frases?.length })
  r = await ver('reparos', PROF, D(1))
  ok(r.status === 200 && r.body.papel === 'profissional' && igual(textos(r.body.frases), ESPERADO.aguardando_horario.profissional), 'GET do profissional escolhido: as frases do profissional', textos(r.body.frases || []))
  r = await ver('reparos', DONO_IRMA, D(1))
  ok(r.status === 200 && r.body.papel === 'dono', 'GET da OUTRA conta contratante da mesma pessoa (mesmo CPF): é o dono')
  r = await ver('reparos', PROF_IRMA, D(1))
  ok(r.status === 200 && r.body.papel === 'profissional', 'GET da outra conta PROFISSIONAL do escolhido (mesmo CPF): é o profissional')
  ok((await ver('reparos', ESTRANHO_PROF, D(1))).status === 403, 'profissional que NÃO é o escolhido: 403')
  ok((await ver('reparos', ESTRANHO_DONO, D(1))).status === 403, 'outra pessoa com o MESMO E-MAIL do dono (CPF diferente): 403 — nunca por e-mail')
  ok((await ver('reparos', DONO, 'nao-e-uuid')).status === 404 && (await ver('reparos', DONO, D(999))).status === 404, 'id inválido ou inexistente: 404')
  ok((await ver('obras', DONO, D(1))).status === 404, 'a demanda é procurada na tabela da rota (reparo pedido em /obras: 404)')

  // ═══ 4. POST: só por frase_id; texto do catálogo; push ao outro lado ═══════════════════════
  r = await enviar('reparos', DONO, D(1), 'ah_dono_manha')
  ok(r.status === 201 && r.body.mensagem.texto === 'Pode vir pela manhã?' && r.body.mensagem.minha === true && r.body.fase === 'aguardando_horario' && r.body.restantes === 4
     && r.body.frases.find(f => f.id === 'ah_dono_manha').enviada === true, 'POST do dono: 201, frase gravada, 4 restantes', r.body)
  let l = await linhas(1)
  ok(l.length === 1 && igual(l[0], { tipo: 'reparo', demanda_id: D(1), remetente_id: DONO, papel: 'dono', profissional_id: PROF, fase: 'aguardando_horario', frase_id: 'ah_dono_manha', texto: 'Pode vir pela manhã?' }),
     'linha gravada: demanda (tipo/id), conta remetente, papel, fase, frase_id e texto', l[0])
  ok(pushes.length === 1 && pushes[0].to === tok('alex') && pushes[0].body === 'Pode vir pela manhã?' && pushes[0].title === '💬 Cliente · Trocar chuveiro',
     'push IMEDIATO ao profissional com o texto da frase', pushes[0] && { to: pushes[0].to, title: pushes[0].title, body: pushes[0].body })
  ok(pushes[0]?.data?.tipo === 'chegada_prevista' && pushes[0].data.reparo_id === D(1) && !pushes[0].data.obra_id,
     'push com data.tipo que o app já trata abrindo o DETALHE da demanda (chegada_prevista + reparo_id)', pushes[0]?.data)
  ok(emails.length === 0, 'só push: nenhum e-mail', emails.length)

  // texto livre nunca vira mensagem
  r = await enviar('reparos', DONO, D(1), { frase_id: 'ah_dono_tarde', texto: 'me liga no 34 99999-0000', mensagem: 'zap' })
  l = await linhas(1)
  ok(r.status === 201 && l[1].texto === 'Prefiro à tarde' && pushes[0].body === 'Prefiro à tarde', 'texto livre no corpo é IGNORADO: grava e envia o texto do catálogo', l[1]?.texto)
  r = await enviar('reparos', DONO, D(1), { texto: 'me liga no 34 99999-0000' })
  ok(r.status === 400 && r.body.codigo === 'FRASE_INVALIDA' && pushes.length === 0 && (await linhas(1)).length === 2, 'sem frase_id (só texto livre): 400 FRASE_INVALIDA, nada gravado nem enviado', r.body)
  ok((await enviar('reparos', DONO, D(1), 'nao_existe')).body.codigo === 'FRASE_INVALIDA' && (await enviar('reparos', DONO, D(1), { frase_id: 123 })).status === 400, 'frase_id desconhecido ou que não é texto: 400 FRASE_INVALIDA')
  r = await enviar('reparos', DONO, D(1), 'ah_prof_fotos')
  ok(r.status === 400 && r.body.codigo === 'FRASE_INVALIDA', 'frase do OUTRO papel (dono enviando frase do profissional): 400 FRASE_INVALIDA', r.body)
  ok((await enviar('reparos', ESTRANHO_PROF, D(1), 'ah_prof_fotos')).status === 403 && (await enviar('reparos', ESTRANHO_DONO, D(1), 'ah_dono_fotos')).status === 403, 'quem não participa não envia: 403')

  // ═══ 5. Regras: repetida, fase errada, limite ══════════════════════════════════════════════
  r = await enviar('reparos', DONO, D(1), 'ah_dono_manha')
  ok(r.status === 409 && r.body.codigo === 'FRASE_REPETIDA' && pushes.length === 0, 'mesma frase de novo na mesma fase: 409 FRASE_REPETIDA, sem push', r.body)
  r = await enviar('reparos', DONO_IRMA, D(1), 'ah_dono_manha')
  ok(r.status === 409 && r.body.codigo === 'FRASE_REPETIDA', 'a repetição vale por PESSOA: a outra conta do dono também leva 409 FRASE_REPETIDA', r.body)
  r = await enviar('reparos', DONO, D(1), 'ag_dono_confirmado')
  ok(r.status === 409 && r.body.codigo === 'FASE_INCORRETA' && r.body.fase === 'aguardando_horario', 'frase de OUTRA fase: 409 FASE_INCORRETA com a fase atual', r.body)
  // o profissional tem a cota dele (por papel): envia, e o push vai ao dono
  r = await enviar('reparos', PROF, D(1), 'ah_prof_propus_horario')
  ok(r.status === 201 && r.body.restantes === 4 && pushes.length === 1 && pushes[0].to === tok('maria') && pushes[0].title === '💬 Profissional · Trocar chuveiro'
     && pushes[0].body === 'Propus um horário, fica bom pra você?', 'POST do profissional: 201 e push ao DONO', pushes[0] && { to: pushes[0].to, title: pushes[0].title })
  r = await enviar('reparos', PROF_IRMA, D(1), 'ah_prof_fotos')
  l = await linhas(1)
  ok(r.status === 201 && r.body.restantes === 3 && l[l.length - 1].remetente_id === PROF_IRMA && l[l.length - 1].papel === 'profissional',
     'a outra conta profissional do escolhido envia como o profissional (mesma cota), com a conta remetente gravada', { restantes: r.body.restantes })
  // dono completa as 5 da fase
  for (const id of ['ah_dono_qualquer_dia', 'ah_dono_fotos', 'ah_dono_vendo']) r = await enviar('reparos', DONO, D(1), id)
  ok(r.status === 201 && r.body.restantes === 0, 'dono envia as 5 frases da fase: a 5ª sai e restam 0', { status: r.status, restantes: r.body.restantes })
  // LIMITE: o catálogo de hoje tem no máximo 5 por papel/fase; uma frase ANTIGA (já fora do catálogo)
  // enviada antes continua contando — é assim que o limite chega antes das frases acabarem.
  await db.query(`INSERT INTO mensagens_prontas_enviadas (tipo, demanda_id, remetente_id, papel, profissional_id, fase, frase_id, texto)
                  SELECT 'obra', $1, $2, 'profissional', $2, 'aguardando_horario', 'antiga_' || g, 'Frase antiga ' || g FROM generate_series(1, 4) g`, [D(2), PROF])
  r = await enviar('obras', PROF, D(2), 'ah_prof_propus_horario')
  ok(r.status === 201 && r.body.restantes === 0, 'obra: 4 enviadas + 1 → a 5ª sai', { status: r.status, restantes: r.body.restantes })
  ok(pushes[0]?.data?.tipo === 'chegada_prevista' && pushes[0].data.obra_id === D(2) && !pushes[0].data.reparo_id && pushes[0].to === tok('maria'), 'obra: push com obra_id (abre o detalhe da obra)', pushes[0]?.data)
  r = await enviar('obras', PROF, D(2), 'ah_prof_fotos')
  ok(r.status === 409 && r.body.codigo === 'LIMITE_ATINGIDO' && r.body.limite === 5 && pushes.length === 0, '6ª mensagem da pessoa na fase: 409 LIMITE_ATINGIDO, sem push', r.body)
  r = await enviar('obras', DONO_IRMA, D(2), 'ah_dono_manha')
  ok(r.status === 201 && pushes[0].to === tok('alex'), 'o limite é por lado: o dono (pela outra conta dele) ainda envia na mesma fase')
  // dois toques ao mesmo tempo na mesma frase: uma grava, a outra é repetida
  silenciar(true)
  const dupla = await Promise.all([chamar(h.obras.enviar, DONO, D(2), { frase_id: 'ah_dono_tarde' }), chamar(h.obras.enviar, DONO, D(2), { frase_id: 'ah_dono_tarde' })])
  await assentar(); silenciar(false)
  ok(igual(dupla.map(x => x.status).sort(), [201, 409]) && dupla.find(x => x.status === 409).body.codigo === 'FRASE_REPETIDA'
     && (await linhas(2)).filter(x => x.frase_id === 'ah_dono_tarde').length === 1, 'dois envios simultâneos da mesma frase: um 201, um 409, uma linha só', dupla.map(x => x.status))

  // ═══ 6. Histórico ══════════════════════════════════════════════════════════════════════════
  r = await ver('reparos', PROF, D(1))
  const hist = r.body.historico
  ok(hist.length === 7 && hist.filter(m => m.minha).length === 2 && hist.every(m => m.id && m.fase === 'aguardando_horario' && m.frase_id && m.texto && m.enviado_em)
     && r.body.restantes === 3 && r.body.frases.filter(f => f.enviada).length === 2, 'GET do profissional: histórico das duas partes em ordem, com "minha" e as frases já enviadas marcadas',
     { total: hist.length, minhas: hist.filter(m => m.minha).length })
  r = await ver('reparos', DONO_IRMA, D(1))
  ok(r.body.historico.filter(m => m.minha).length === 5 && r.body.restantes === 0, 'GET da outra conta do dono: as mensagens do dono são "minhas" (por pessoa)')

  // ═══ 7. Fase derivada do estado da demanda ═════════════════════════════════════════════════
  await db.query(`UPDATE reparos SET chegada_prevista_em = now() + INTERVAL '1 day' WHERE id = $1`, [D(1)])
  r = await ver('reparos', DONO, D(1))
  ok(r.body.fase === 'agendado' && igual(textos(r.body.frases), ESPERADO.agendado.dono) && r.body.restantes === 4 + 1 && r.body.historico.length === 7,
     'horário combinado → fase agendado: frases novas, cota nova (5), histórico preservado', { fase: r.body.fase, restantes: r.body.restantes })
  r = await enviar('reparos', DONO, D(1), 'ah_dono_manha')
  ok(r.status === 409 && r.body.codigo === 'FASE_INCORRETA' && r.body.fase === 'agendado', 'frase da fase anterior: 409 FASE_INCORRETA', r.body)
  ok((await enviar('reparos', DONO, D(1), 'ag_dono_confirmado')).status === 201 && (await enviar('reparos', PROF, D(1), 'ag_prof_remarcar')).status === 201, 'agendado: dono e profissional enviam as frases da fase')
  await db.query(`UPDATE reparos SET a_caminho_em = now() WHERE id = $1`, [D(1)])
  r = await ver('reparos', PROF, D(1))
  ok(r.body.fase === 'a_caminho' && igual(textos(r.body.frases), ESPERADO.a_caminho.profissional), '"Estou a caminho" → fase a_caminho', r.body.fase)
  await db.query(`UPDATE reparos SET chegada_declarada_em = now() WHERE id = $1`, [D(1)])
  r = await enviar('reparos', PROF, D(1), 'ac_prof_cheguei')
  ok(r.status === 201 && pushes[0].body === 'Cheguei, estou no portão', 'chegada declarada e ainda não confirmada: continua a_caminho ("Cheguei, estou no portão" sai)')
  ok((await enviar('reparos', DONO, D(1), 'ac_dono_atraso_10')).status === 201 && (await enviar('reparos', PROF, D(1), 'ac_prof_atraso_10')).status === 201,
     '"Vou atrasar 10 min" existe para os dois papéis, cada um com o seu id')
  await db.query(`UPDATE reparos SET chegada_confirmada_em = now() WHERE id = $1`, [D(1)])
  r = await ver('reparos', DONO, D(1))
  ok(r.body.fase === null && igual(r.body.frases, []) && r.body.restantes === 0 && r.body.historico.length === 12, 'chegada confirmada → sem fase: nada a enviar, histórico continua legível', { fase: r.body.fase, historico: r.body.historico.length })
  r = await enviar('reparos', DONO, D(1), 'ac_dono_esperando')
  ok(r.status === 409 && r.body.codigo === 'FASE_INCORRETA' && r.body.fase === null && pushes.length === 0, 'enviar sem fase: 409 FASE_INCORRETA (fase null)', r.body)
  await db.query(`UPDATE obras SET status = 'encerrada' WHERE id = $1`, [D(2)])
  r = await ver('obras', PROF, D(2))
  ok(r.body.fase === null && r.body.historico.length > 0 && (await enviar('obras', PROF, D(2), 'ah_prof_fotos')).body.codigo === 'FASE_INCORRETA', 'demanda encerrada: sem fase, histórico legível, envio 409 FASE_INCORRETA')

  // ═══ 8. Sem profissional escolhido / troca de profissional ═════════════════════════════════
  r = await ver('reparos', DONO, D(3))
  ok(r.status === 200 && r.body.fase === null && igual(r.body.frases, []) && igual(r.body.historico, []), 'sem profissional escolhido: o dono vê tudo vazio (fase null)')
  ok((await enviar('reparos', DONO, D(3), 'ah_dono_manha')).body.codigo === 'FASE_INCORRETA' && (await ver('reparos', PROF, D(3))).status === 403, 'sem escolhido: dono não envia (409) e nenhum profissional lê (403)')
  await enviar('reparos', DONO, D(4), 'ah_dono_manha')
  await enviar('reparos', PROF, D(4), 'ah_prof_fotos')
  await db.query(`UPDATE reparos SET match_usuario_id = $2 WHERE id = $1`, [D(4), OUTRO_PROF])
  r = await ver('reparos', OUTRO_PROF, D(4))
  ok(r.status === 200 && igual(r.body.historico, []) && r.body.restantes === 5, 'troca de profissional: o NOVO escolhido não lê a conversa do anterior', r.body.historico)
  ok((await ver('reparos', PROF, D(4))).status === 403, 'o profissional anterior não acessa mais: 403')
  r = await enviar('reparos', DONO, D(4), 'ah_dono_manha')
  ok(r.status === 201 && r.body.restantes === 4 && pushes[0].to === tok('caio'), 'com o novo profissional a conversa (e a cota) do dono recomeça; o push vai ao novo escolhido', { status: r.status, restantes: r.body.restantes })

  // ═══ 9. Outro lado sem token: grava e responde 201 mesmo assim ═════════════════════════════
  r = await enviar('reparos', PROF, D(5), 'ah_prof_horario_hoje')
  ok(r.status === 201 && pushes.length === 0 && emails.length === 0 && (await linhas(5)).length === 1, 'dono sem token de push: mensagem gravada (201), sem push e sem e-mail')

  const inesperados = erros.filter(e => !/sem banco|PAGBANK|migration/i.test(e))
  ok(inesperados.length === 0, 'nenhum erro logado', inesperados.slice(0, 4))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error = errOrig; console.error('ERRO', e); process.exit(1) })
