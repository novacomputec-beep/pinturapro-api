#!/usr/bin/env node
// PEDIDOS SALVOS (utils/demandasSalvas) e PEDIDO QUE PARECE ANÚNCIO (utils/suspeitaAnuncio) — dono, 24/11/2026.
//  1) salvar: POST /salvos alterna; GET /salvos lista; feed com salvo; dono com salvos_count;
//     push "❤️ Um pedido que você salvou termina em…" uma vez, com 6 h ou menos, fora do silêncio;
//  2) anúncio: detecção por CPF/especialidade e por texto; 409 antes de gravar quando o app manda
//     confirmar_pedido_real sem ser true; publica com a marca quando confirma (ou app antigo);
//     POST /admin/demandas/:tipo/:id/marcar-anuncio tira do ar, enfileira o WhatsApp, conta a
//     ocorrência; a 3ª em 90 dias bloqueia a publicação por 7 dias (utils/penalidadesAuto).
// SQL REAL em PGlite com o ESQUEMA DE PRODUÇÃO; rotas reais; Expo/Brevo falsos.
//   npm i -D @electric-sql/pglite && node scripts/testar-salvos-e-anuncios.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

const pushes = [], emails = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) { pushes.push(...chunk); return chunk.map((_, i) => ({ status: 'ok', id: `t${pushes.length}-${i}` })) }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
const q = async (sql, params) => {
  if (!db) throw new Error('sem banco (boot)')
  const r = await db.query(sql, params)
  if (r && r.rowCount === undefined) r.rowCount = r.rows.length || r.affectedRows || 0
  return r
}
const shim = { query: q, connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: q, release() {} } }, on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async (e) => { emails.push(e) }, enviarEmailComAnexo: async () => {} }
  if (/services[\\/]emailService$/.test(request)) return { enviarEmail: async (e) => { emails.push(e) } }
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
const P = require(path.join(REPO, 'src/utils/penalidadesAuto'))
const S = require(path.join(REPO, 'src/utils/demandasSalvas'))
const A = require(path.join(REPO, 'src/utils/suspeitaAnuncio'))
const alerta = require(path.join(REPO, 'src/services/alertaService'))
const { migrarWhatsapp } = require(path.join(REPO, 'src/whatsapp/migracao'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 200))
const rotasDe = (r) => r.stack.flatMap(l => (l.route ? [l.route] : l.handle?.stack ? rotasDe(l.handle) : []))
const ROTAS = rotasDe(router)
const rota = (metodo, caminho) => { const r = ROTAS.find(x => x.path === caminho && x.methods[metodo]); if (!r) throw new Error(`rota ${metodo} ${caminho} não encontrada`); return r }
const nomes = (metodo, caminho) => rota(metodo, caminho).stack.map(l => l.handle.name || l.name)
// Handler final da rota (e o que ele faz depois de responder).
const chamar = async (metodo, caminho, { usuario, params = {}, query = {}, body = {} } = {}) => {
  silenciar(true)
  try {
    let resp = null
    const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resp = resp || { status: this.statusCode, body: b }; return this } }
    const pilha = rota(metodo, caminho).stack
    await pilha[pilha.length - 1].handle({ method: metodo.toUpperCase(), path: caminho, params, query, body, usuario, get: () => '', headers: {}, ip: '127.0.0.1' }, res)
    await assentar()
    return resp
  } finally { silenciar(false) }
}
const passar = async (mw, usuario) => {
  let resp = null, passou = false
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resp = { status: this.statusCode, body: b }; return this } }
  await mw({ usuario }, res, () => { passou = true })
  return passou ? { passou: true } : resp
}

const ADM = { id: U(900), role: 'admin' }
const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  await db.exec(`
    CREATE UNIQUE INDEX t_email_alertas_uq ON email_alertas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_push_entregas_uq ON push_entregas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_configuracoes_uq ON configuracoes (chave);
    CREATE UNIQUE INDEX t_acima_teto_uq ON avisos_acima_do_teto (tabela, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_fora_area_uq ON avisos_fora_area (tabela, demanda_id, usuario_id);
    CREATE UNIQUE INDEX t_reparos_crid_uq ON reparos (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE UNIQUE INDEX t_obras_crid_uq ON obras (criado_por, client_request_id) WHERE client_request_id IS NOT NULL;
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true'), ('email_resumo_diario', 'false');
  `)
  await P.migrarPenalidadesAuto(shim)
  await q('BEGIN'); await migrarWhatsapp(shim); await q('COMMIT')
  // A fixture traz as tabelas/colunas sem chaves: aqui valem as das migrações de boot.
  await db.exec(`DROP TABLE demandas_salvas; DROP TABLE anuncios_ocorrencias;
    ALTER TABLE reparos DROP COLUMN suspeita_anuncio, DROP COLUMN suspeita_anuncio_motivos, DROP COLUMN anuncio_em, DROP COLUMN anuncio_por;
    ALTER TABLE obras DROP COLUMN suspeita_anuncio, DROP COLUMN suspeita_anuncio_motivos, DROP COLUMN anuncio_em, DROP COLUMN anuncio_por;`)
  await S.migrarDemandasSalvas(shim); await S.migrarDemandasSalvas(shim)
  await A.migrarSuspeitaAnuncio(shim); await A.migrarSuspeitaAnuncio(shim)
  const colunas = (await q(`SELECT table_name, column_name FROM information_schema.columns WHERE column_name IN ('suspeita_anuncio', 'suspeita_anuncio_motivos', 'anuncio_em', 'anuncio_por') AND table_name IN ('reparos', 'obras')`)).rows
  ok(colunas.length === 8 && (await q(`SELECT count(*)::int AS n FROM demandas_salvas`)).rows[0].n === 0 && (await q(`SELECT count(*)::int AS n FROM anuncios_ocorrencias`)).rows[0].n === 0,
     'migrações (2x, idempotentes): demandas_salvas, anuncios_ocorrencias e as 4 colunas em reparos e obras', colunas.length)

  const usr = async (n, nome, role, extra = {}) => {
    const c = { id: U(n), nome, email: `u${n}@x.invalid`, role, cpf_cnpj: String(n).padStart(11, '0'), ativo: true, cidade: 'Patos de Minas', uf: 'MG', telefone: `349${String(n).padStart(8, '0')}`,
      push_token: `ExponentPushToken[u${n}]`, ...(role === 'prestador' ? { tipo_prestador: 'reparador' } : { tipo_dono: 'reparo' }), ...extra }
    const ks = Object.keys(c)
    await q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => c[k]))
    if (role === 'prestador') await q(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [c.id])
    return { id: c.id, role, nome, tipo_prestador: c.tipo_prestador }
  }
  await usr(900, 'Admin', 'admin')
  const dono = await usr(1, 'Carlos Eletricista Souza', 'dono_obra', { cpf_cnpj: '111.111.111-11' })
  await usr(2, 'Carlos Pro', 'prestador', { cpf_cnpj: '11111111111', especialidades: ['eletrica', 'pintor'] })   // MESMO CPF do dono
  const donoIrmao = await usr(3, 'Carlos Outro Perfil', 'dono_obra', { cpf_cnpj: '11111111111', tipo_dono: 'pintura' })
  const cliente = await usr(4, 'Maria Cliente', 'dono_obra')
  const cliente2 = await usr(5, 'Joana Cliente', 'dono_obra')
  const saiu = await usr(6, 'Pedro Saiu', 'dono_obra')
  await q(`UPDATE usuarios SET whatsapp_avisos = false WHERE id = $1`, [saiu.id])
  const pro1 = await usr(10, 'Ana Pro', 'prestador', { especialidades: ['eletrica', 'faxina'] })
  const pro2 = await usr(11, 'Bia Pro', 'prestador', { especialidades: ['eletrica'] })
  const proSemToken = await usr(12, 'Caio Pro', 'prestador', { especialidades: ['eletrica'], push_token: null })
  const pintor = await usr(13, 'Davi Pintor', 'prestador', { tipo_prestador: 'pintor', especialidades: ['pintor'] })

  let nDemanda = 0
  const demanda = async (tabela, criadoPor, titulo, extra = {}) => {
    const id = D(++nDemanda)
    const c = { id, titulo, criado_por: criadoPor.id, status: 'aberta', status_aprovacao: 'aprovada', cidade: 'Patos de Minas', uf: 'MG',
      ...(tabela === 'reparos' ? { categoria: 'eletrica', categorias: ['eletrica'], valor_estimado: 100 } : { categoria: 'residencial', valor: 1000 }), ...extra }
    const ks = Object.keys(c)
    await q(`INSERT INTO ${tabela} (${ks.join(', ')}, expira_em) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')}, NOW() + INTERVAL '48 hours')`, ks.map(k => c[k]))
    return id
  }

  // ═══ 1. SALVAR ═════════════════════════════════════════════════════════════════════════════
  const R1 = await demanda('reparos', cliente, 'Trocar tomadas da sala', { descricao: 'Texto reservado', endereco_reparo: 'Rua Secreta, 10' })
  const R2 = await demanda('reparos', cliente, 'Instalar chuveiro')
  const O1 = await demanda('obras', cliente, 'Pintura da fachada')
  ok(nomes('post', '/salvos').join() === 'autenticar,soProfissional,' + nomes('post', '/salvos').slice(-1) && nomes('get', '/salvos').slice(0, 2).join() === 'autenticar,soProfissional',
     'POST e GET /salvos: autenticar + só profissional', nomes('post', '/salvos'))
  const soProfissional = rota('post', '/salvos').stack[1].handle
  ok((await passar(soProfissional, pro1)).passou === true && (await passar(soProfissional, cliente)).status === 403, 'contratante não salva pedido (403); profissional passa')

  let r = await chamar('post', '/salvos', { usuario: pro1, body: { tipo: 'reparo', demanda_id: R1 } })
  ok(r.status === 200 && r.body.salvo === true && r.body.tipo === 'reparo' && r.body.demanda_id === R1, 'POST /salvos: 1ª vez salva', r)
  r = await chamar('post', '/salvos', { usuario: pro1, body: { tipo: 'reparo', demanda_id: R1 } })
  ok(r.status === 200 && r.body.salvo === false && (await q(`SELECT 1 FROM demandas_salvas`)).rows.length === 0, 'POST /salvos de novo: tira (alterna)', r)
  r = await chamar('post', '/salvos', { usuario: pro1, body: { tipo: 'reparo', demanda_id: R1 } })
  const linha = (await q(`SELECT * FROM demandas_salvas`)).rows[0]
  ok(r.body.salvo === true && linha.usuario_id === pro1.id && linha.tipo === 'reparo' && linha.demanda_id === R1 && !!linha.criado_em && linha.aviso_fim_em === null,
     'linha: usuário, tipo reparo, id do pedido, criado_em', linha)
  await chamar('post', '/salvos', { usuario: pro2, body: { tipo: 'reparo', demanda_id: R1 } })
  await chamar('post', '/salvos', { usuario: pintor, body: { tipo: 'obra', demanda_id: O1 } })
  await chamar('post', '/salvos', { usuario: pro1, body: { tipo: 'obra', demanda_id: O1 } })
  const e1 = await chamar('post', '/salvos', { usuario: pro1, body: { tipo: 'servico', demanda_id: R1 } })
  const e2 = await chamar('post', '/salvos', { usuario: pro1, body: { tipo: 'reparo', demanda_id: 'abc' } })
  const e3 = await chamar('post', '/salvos', { usuario: pro1, body: { tipo: 'reparo', demanda_id: D(999) } })
  const e4 = await chamar('post', '/salvos', { usuario: pro1, body: { tipo: 'obra', demanda_id: R1 } })
  ok(e1.status === 400 && e2.status === 400 && e3.status === 404 && e4.status === 404, 'tipo inválido e id malformado: 400; pedido inexistente (ou do outro tipo): 404', [e1.status, e2.status, e3.status, e4.status])

  r = await chamar('get', '/reparos', { usuario: pro1 })
  const fPro1 = Object.fromEntries((r.body?.reparos || []).map(x => [x.id, x.salvo]))
  r = await chamar('get', '/reparos', { usuario: proSemToken })
  const fPro3 = Object.fromEntries((r.body?.reparos || []).map(x => [x.id, x.salvo]))
  ok(fPro1[R1] === true && fPro1[R2] === false && fPro3[R1] === false && fPro3[R2] === false, 'feed de reparos: salvo true só para quem salvou, false nos demais', { fPro1, fPro3 })
  r = await chamar('get', '/obras', { usuario: pintor, query: {} })
  const fPintor = Object.fromEntries((r.body?.obras || []).map(x => [x.id, x.salvo]))
  const O2 = await demanda('obras', cliente, 'Pintura do muro')
  r = await chamar('get', '/obras', { usuario: pintor, query: {} })
  const fPintor2 = Object.fromEntries((r.body?.obras || []).map(x => [x.id, x.salvo]))
  ok(fPintor[O1] === true && fPintor2[O1] === true && fPintor2[O2] === false, 'feed de obras: salvo true/false', { fPintor, fPintor2 })

  r = await chamar('get', '/reparos/minhas', { usuario: cliente })
  const cR = Object.fromEntries([...(r.body?.reparos || []), ...(r.body?.historico || [])].map(x => [x.id, x.salvos_count]))
  r = await chamar('get', '/obras/minhas', { usuario: cliente })
  const cO = Object.fromEntries([...(r.body?.obras || []), ...(r.body?.historico || [])].map(x => [x.id, x.salvos_count]))
  ok(cR[R1] === 2 && cR[R2] === 0 && cO[O1] === 2 && cO[O2] === 0, 'listas do dono: salvos_count (2 e 0) em reparos e obras', { cR, cO })
  r = await chamar('get', '/reparos/:id', { usuario: cliente, params: { id: R1 } })
  const detDono = r?.body?.reparo
  r = await chamar('get', '/reparos/:id', { usuario: pro1, params: { id: R1 } })
  const detPro = r?.body?.reparo
  ok(detDono?.salvos_count === 2 && detDono.salvo === undefined && detPro?.salvo === true && detPro.salvos_count === undefined, 'detalhe do reparo: dono vê salvos_count; profissional vê salvo', { dono: detDono?.salvos_count, pro: detPro?.salvo })

  r = await chamar('get', '/salvos', { usuario: pro1, query: {} })
  const lista = r.body?.salvos || []
  ok(r.status === 200 && lista.length === 2 && lista[0].tipo === 'obra' && lista[0].id === O1 && lista[1].tipo === 'reparo' && lista[1].id === R1 && lista.every(x => x.salvo === true && x.aberta === true),
     'GET /salvos: os dois pedidos, do salvo mais recente para o mais antigo, com aberta', lista.map(x => [x.tipo, x.titulo]))
  ok(lista[1].titulo === 'Trocar tomadas da sala' && Number(lista[1].valor) === 100 && Number(lista[0].valor) === 1000 && lista.every(x => !('descricao' in x) && !('endereco_reparo' in x) && !('latitude' in x) && !('criado_por' in x)),
     'GET /salvos: só campos de card (sem descrição, endereço, coordenadas nem dono)', Object.keys(lista[1]))
  await q(`UPDATE reparos SET status = 'cancelada' WHERE id = $1`, [R2])
  await chamar('post', '/salvos', { usuario: pro2, body: { tipo: 'reparo', demanda_id: R2 } })
  r = await chamar('get', '/salvos', { usuario: pro2, query: {} })
  ok(r.body.salvos.find(x => x.id === R2)?.aberta === false && r.body.salvos.find(x => x.id === R1)?.aberta === true, 'GET /salvos: pedido fechado segue na lista com aberta: false')

  // ─── push "termina em…" ───
  ok(S.tituloAvisoFim((4 * 60 + 30) * 60000) === '❤️ Um pedido que você salvou termina em 4 h 30 min' && S.tituloAvisoFim(45 * 60000) === '❤️ Um pedido que você salvou termina em 45 min' && S.HORAS_AVISO_FIM === 6,
     'texto do push: "❤️ Um pedido que você salvou termina em {tempo restante}"')
  const rodar = async (janela) => { silenciar(true); try { return await S.avisarSalvosTerminando(shim, janela ? { foraDoSilencio: janela } : undefined) } finally { silenciar(false) } }
  pushes.length = 0
  ok((await rodar('true')) === 0 && pushes.length === 0, 'pedido com mais de 6 h de prazo: nenhum push')
  await q(`UPDATE reparos SET expira_em = NOW() + INTERVAL '5 hours 30 minutes' WHERE id = $1`, [R1])
  await chamar('post', '/salvos', { usuario: proSemToken, body: { tipo: 'reparo', demanda_id: R1 } })
  ok((await rodar('false')) === 0 && pushes.length === 0 && (await q(`SELECT 1 FROM demandas_salvas WHERE aviso_fim_em IS NOT NULL`)).rows.length === 0,
     'silêncio noturno: nada sai e nada é marcado (espera a janela)')
  const n1 = await rodar('true')
  const paraQuem = pushes.map(p => p.to).sort()
  ok(n1 === 2 && pushes.length === 2 && JSON.stringify(paraQuem) === JSON.stringify(['ExponentPushToken[u10]', 'ExponentPushToken[u11]'])
     && pushes.every(p => /^❤️ Um pedido que você salvou termina em 5 h 2\d min$/.test(p.title) && p.body === '"Trocar tomadas da sala"' && p.data.tipo === 'pedido_salvo_terminando' && p.data.reparo_id === R1),
     'com 6 h ou menos: um push por quem salvou (título com o tempo restante, corpo com o título do pedido)', pushes.map(p => [p.to, p.title, p.body]))
  ok((await q(`SELECT 1 FROM demandas_salvas WHERE demanda_id = $1 AND aviso_fim_em IS NOT NULL`, [R1])).rows.length === 3, 'os 3 que salvaram ficam marcados (quem não tem token não recebe, e não é tentado de novo)')
  pushes.length = 0
  ok((await rodar('true')) === 0 && pushes.length === 0, 'rodar de novo: ninguém recebe duas vezes')
  // Obra com profissional escolhido, e reparo fechado: não avisam.
  await q(`UPDATE obras SET expira_em = NOW() + INTERVAL '2 hours', match_usuario_id = $2 WHERE id = $1`, [O1, pintor.id])
  await q(`UPDATE reparos SET expira_em = NOW() + INTERVAL '2 hours' WHERE id = $1`, [R2])
  ok((await rodar('true')) === 0 && pushes.length === 0, 'pedido com profissional escolhido ou fechado: nenhum push')
  await q(`UPDATE obras SET match_usuario_id = NULL WHERE id = $1`, [O1])
  ok((await rodar('true')) === 2 && pushes.every(p => p.data.obra_id === O1 && /termina em 1 h 5\d min$/.test(p.title)), 'obra aberta com 2 h de prazo: avisa quem salvou (obra_id no push)', pushes.map(p => p.title))
  // Padrão (sem parâmetro): a janela é a dos pushes (alertaService.SQL_FORA_SILENCIO).
  const fora = (await q(`SELECT (${alerta.SQL_FORA_SILENCIO}) AS f`)).rows[0].f
  await q(`UPDATE demandas_salvas SET aviso_fim_em = NULL WHERE tipo = 'obra'`)
  pushes.length = 0
  ok((await rodar()) === (fora ? 2 : 0) && /22/.test(alerta.SQL_FORA_SILENCIO) && /7/.test(alerta.SQL_FORA_SILENCIO), 'sem parâmetro: respeita o silêncio 22:00–07:00 dos pushes', { fora })

  // ═══ 2. ANÚNCIO — detecção ═════════════════════════════════════════════════════════════════
  const mt = (...t) => A.motivosDoTexto(...t)
  ok(JSON.stringify(mt('Faço pintura residencial', 'Orçamento grátis!')) === '["faço","orçamento grátis"]' && JSON.stringify(mt('Ofereço serviços de jardinagem')) === '["ofereço"]'
     && JSON.stringify(mt('Atendo a domicílio')) === '["atendo"]' && JSON.stringify(mt('Trabalho com gesso e drywall')) === '["trabalho com"]',
     'texto de quem oferece: faço, ofereço, orçamento grátis, atendo, trabalho com')
  ok(JSON.stringify(mt('Preciso de pedreiro', 'Ligar 34 99881-7102')) === '["telefone"]' && JSON.stringify(mt('Reforma', 'zap 9881 7102')) === '["telefone"]', 'telefone no texto')
  ok(mt('Preciso refazer o piso', 'Quero um bom atendimento, pago R$ 1.500,00 em 2026, CEP 38700-000, satisfaço as exigências').length === 0
     && mt('Trocar 3 tomadas', 'O que eu preciso é de alguém para o trabalho, com urgência').length === 0,
     'pedido comum não é suspeito ("refazer", "atendimento", valor, ano, CEP, "trabalho, com")')
  const av = (usuario, tabela, titulo, extra = {}) => A.avaliarSuspeitaAnuncio({ usuarioId: usuario.id, tabela, titulo, ...extra }, shim)
  let a = await av(dono, 'reparos', 'Instalar tomada', { categorias: ['eletrica'] })
  ok(a.suspeita === true && JSON.stringify(a.motivos) === '["profissional_da_especialidade"]', 'mesmo CPF com conta profissional DESSA especialidade (CPF com e sem máscara): suspeito', a)
  a = await av(dono, 'reparos', 'Limpar a casa', { categorias: ['faxina'] })
  const a2 = await av(cliente, 'reparos', 'Instalar tomada', { categorias: ['eletrica'] })
  ok(a.suspeita === false && a2.suspeita === false, 'mesma pessoa em OUTRA especialidade, ou outra pessoa: não é suspeito')
  a = await av(dono, 'obras', 'Pintura de casa com tinta acrílica')
  const a3 = await av(dono, 'obras', 'Construir um muro de arrimo')
  ok(a.suspeita === true && a.motivos[0] === 'profissional_da_especialidade' && a3.suspeita === false, 'obra: vale a especialidade INFERIDA do texto (pintor) — muro, que ele não faz, não', { a, a3 })
  a = await av(dono, 'reparos', 'Faço instalação elétrica 34 99881-7102', { categorias: ['eletrica'] })
  ok(JSON.stringify(a.motivos) === '["profissional_da_especialidade","faço","telefone"]', 'os motivos se somam', a.motivos)
  const dec = (body, suspeita) => A.decidirPublicacao(body, { suspeita, motivos: suspeita ? ['faço'] : [] })
  ok(dec({ confirmar_pedido_real: false }, true).barrar?.codigo === 'SUSPEITA_ANUNCIO' && dec({ confirmar_pedido_real: null }, true).barrar?.suspeita_anuncio === true
     && dec({ confirmar_pedido_real: true }, true).marcar === true && dec({ confirmar_pedido_real: 'true' }, true).marcar === true
     && dec({}, true).marcar === true && !dec({}, true).barrar && dec({ confirmar_pedido_real: false }, false).marcar === false && !dec({ confirmar_pedido_real: false }, false).barrar,
     'decisão: campo enviado sem ser true → barra; true → publica marcado; campo ausente (app antigo) → publica marcado; sem suspeita → nada')

  // ─── na publicação (rotas reais) ───
  const corpoReparo = (extra = {}) => ({ titulo: 'Instalar tomada na cozinha', categoria: 'eletrica', cidade: 'Patos de Minas', uf: 'MG', valor_estimado: 120, ...extra })
  const contar = async (tabela, donoX) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE criado_por = $1`, [donoX.id])).rows[0].n
  r = await chamar('post', '/reparos/dono', { usuario: dono, body: corpoReparo({ confirmar_pedido_real: false }) })
  ok(r.status === 409 && r.body.codigo === 'SUSPEITA_ANUNCIO' && r.body.suspeita_anuncio === true && JSON.stringify(r.body.motivos) === '["profissional_da_especialidade"]' && typeof r.body.erro === 'string' && (await contar('reparos', dono)) === 0,
     'POST /reparos/dono suspeito, sem confirmar: 409 SUSPEITA_ANUNCIO com a marca e os motivos, NADA gravado', r)
  r = await chamar('post', '/reparos/dono', { usuario: dono, body: corpoReparo({ confirmar_pedido_real: true }) })
  let gravado = (await q(`SELECT id, status, suspeita_anuncio, suspeita_anuncio_motivos, anuncio_em FROM reparos WHERE criado_por = $1`, [dono.id])).rows[0]
  ok(r.status === 201 && r.body.suspeita_anuncio === true && gravado?.status === 'aberta' && gravado.suspeita_anuncio === true && JSON.stringify(gravado.suspeita_anuncio_motivos) === '["profissional_da_especialidade"]' && gravado.anuncio_em === null,
     'com confirmar_pedido_real=true: publica (201) e guarda a marca + motivos para o painel', { status: r.status, gravado })
  const RA = gravado.id
  r = await chamar('post', '/reparos/dono', { usuario: cliente2, body: corpoReparo({ titulo: 'Faço instalações elétricas', descricao: 'Atendo toda a região' }) })
  gravado = (await q(`SELECT suspeita_anuncio, suspeita_anuncio_motivos FROM reparos WHERE criado_por = $1`, [cliente2.id])).rows[0]
  ok(r.status === 201 && r.body.suspeita_anuncio === true && JSON.stringify(gravado.suspeita_anuncio_motivos) === '["faço","atendo"]', 'app antigo (sem o campo): publica como sempre, com a marca gravada', { status: r.status, gravado })
  r = await chamar('post', '/reparos/dono', { usuario: cliente2, body: corpoReparo({ titulo: 'Trocar disjuntor', confirmar_pedido_real: false }) })
  ok(r.status === 201 && r.body.suspeita_anuncio === false && r.body.suspeita_anuncio_motivos == null, 'pedido comum com confirmar_pedido_real=false: publica normalmente, sem marca', r.status)
  r = await chamar('post', '/reparos/dono', { usuario: cliente2, body: corpoReparo({ titulo: 'Preciso de eletricista', descricao: 'Me ligue no 34 99881-7102', confirmar_pedido_real: true }) })
  ok(r.status === 201 && r.body.suspeita_anuncio === true && JSON.stringify(r.body.suspeita_anuncio_motivos) === '["telefone"]' && /\[contato removido\]/.test(r.body.descricao), 'telefone: marcado pelo texto ORIGINAL; a moderação segue mascarando o contato', r.body?.descricao)
  const corpoObra = (extra = {}) => ({ titulo: 'Ofereço reforma completa', descricao: 'Trabalho com acabamento fino', categoria: 'residencial', cidade: 'Patos de Minas', uf: 'MG', valor: 5000, ...extra })
  r = await chamar('post', '/obras/dono', { usuario: saiu, body: corpoObra({ confirmar_pedido_real: false }) })
  ok(r.status === 409 && r.body.codigo === 'SUSPEITA_ANUNCIO' && JSON.stringify(r.body.motivos) === '["ofereço","trabalho com"]' && (await contar('obras', saiu)) === 0, 'POST /obras/dono suspeito, sem confirmar: 409 e nada gravado', r)
  r = await chamar('post', '/obras/dono', { usuario: saiu, body: corpoObra({ confirmar_pedido_real: true }) })
  gravado = (await q(`SELECT id, suspeita_anuncio, suspeita_anuncio_motivos FROM obras WHERE criado_por = $1`, [saiu.id])).rows[0]
  ok(r.status === 201 && r.body.suspeita_anuncio === true && gravado?.suspeita_anuncio === true && JSON.stringify(gravado.suspeita_anuncio_motivos) === '["ofereço","trabalho com"]', 'obra confirmada: publica com a marca', { status: r.status, gravado })
  const OA = gravado.id
  r = await chamar('post', '/obras/dono', { usuario: cliente2, body: corpoObra({ titulo: 'Reforma do banheiro', descricao: 'Trocar piso e louças', confirmar_pedido_real: false }) })
  ok(r.status === 201 && r.body.suspeita_anuncio === false, 'obra comum: publica sem marca', r.status)

  // ═══ 3. ANÚNCIO — painel ═══════════════════════════════════════════════════════════════════
  const CAMINHO = '/admin/demandas/:tipo/:id/marcar-anuncio'
  ok(nomes('post', CAMINHO).slice(0, 2).join() === 'autenticar,exigirSuperAdmin', 'marcar-anuncio: só super-admin', nomes('post', CAMINHO))
  const marcar = (tipo, id) => chamar('post', CAMINHO, { usuario: ADM, params: { tipo, id } })
  const noFeed = async (id) => (await chamar('get', '/reparos', { usuario: pro2 })).body.reparos.some(x => x.id === id)
  ok((await noFeed(RA)) === true, 'antes: o pedido suspeito está no feed')
  r = await marcar('reparo', RA)
  let d = (await q(`SELECT status, status_aprovacao, cancelada_por, anuncio_em, anuncio_por, suspeita_anuncio, encerrado_em FROM reparos WHERE id = $1`, [RA])).rows[0]
  ok(r.status === 200 && r.body.whatsapp === 'fila' && r.body.ocorrencias === 1 && r.body.penalidade === null && d.status === 'cancelada' && d.status_aprovacao === 'cancelada' && d.cancelada_por === 'admin'
     && !!d.anuncio_em && d.anuncio_por === ADM.id && !!d.encerrado_em && (await noFeed(RA)) === false,
     'marcar como anúncio: sai do feed (cancelada pelo admin, anuncio_em), 1 ocorrência, sem penalidade', { corpo: r.body, d })
  let msgs = (await q(`SELECT tipo, usuario_id, telefone, texto, ref_tabela, ref_id, status FROM whatsapp_mensagens ORDER BY id`)).rows
  ok(msgs.length === 1 && msgs[0].tipo === 'avulsa' && msgs[0].usuario_id === dono.id && msgs[0].telefone === '+5534900000001' && msgs[0].ref_tabela === 'reparos' && msgs[0].ref_id === RA && msgs[0].status === 'fila'
     && msgs[0].texto === 'Oi, Carlos! 👋 Aqui é o *ProTudo*. Tiramos do ar o seu pedido *"Instalar tomada na cozinha"* porque ele parece um anúncio do seu trabalho, e os pedidos são para quem quer contratar. 😉 Para divulgar seus serviços, use o seu perfil de profissional no app: protudo.app.br/baixar',
     'WhatsApp na fila do robô (tipo avulsa) para o dono do pedido, com o texto aprovado e o link do app', msgs[0])
  r = await marcar('reparo', RA)
  ok(r.status === 409 && r.body.codigo === 'JA_MARCADO' && (await q(`SELECT 1 FROM anuncios_ocorrencias`)).rows.length === 1 && (await q(`SELECT 1 FROM whatsapp_mensagens`)).rows.length === 1, 'marcar de novo: 409, sem 2ª ocorrência nem 2ª mensagem', r)
  const e5 = await marcar('servico', RA), e6 = await marcar('reparo', 'xyz'), e7 = await marcar('obra', RA)
  const RM = await demanda('reparos', cliente, 'Pedido com escolhido', { match_usuario_id: pro1.id })
  const e8 = await marcar('reparo', RM)
  ok(e5.status === 400 && e6.status === 400 && e7.status === 404 && e8.status === 409 && e8.body.codigo === 'MATCH_ATIVO' && (await q(`SELECT status FROM reparos WHERE id = $1`, [RM])).rows[0].status === 'aberta',
     'tipo/id inválidos: 400; inexistente: 404; com profissional escolhido: 409 MATCH_ATIVO e nada muda', [e5.status, e6.status, e7.status, e8.status])
  r = await marcar('obra', OA)
  d = (await q(`SELECT status, cancelada_por, anuncio_em FROM obras WHERE id = $1`, [OA])).rows[0]
  ok(r.status === 200 && r.body.whatsapp === 'saiu' && d.status === 'cancelada' && d.cancelada_por === 'admin' && !!d.anuncio_em && (await q(`SELECT 1 FROM whatsapp_mensagens`)).rows.length === 1,
     'obra: tirada do ar; quem respondeu SAIR ao robô não recebe a mensagem (ocorrência conta do mesmo jeito)', r.body)

  // ─── 3ª ocorrência em 90 dias → 7 dias sem publicar ───
  pushes.length = 0; emails.length = 0
  const RB = await demanda('reparos', donoIrmao, 'Faço pintura')      // outra conta de contratante do MESMO CPF
  r = await marcar('reparo', RB)
  ok(r.status === 200 && r.body.penalidade === null && (await q(`SELECT publicacao_suspensa_ate FROM usuarios WHERE id = ANY($1::uuid[])`, [[dono.id, donoIrmao.id]])).rows.every(x => x.publicacao_suspensa_ate === null),
     '2ª ocorrência da pessoa: ainda sem bloqueio', r.body)
  const podePublicar = rota('post', '/reparos/dono').stack.find(l => l.handle.name === 'exigirPodePublicar').handle
  ok((await passar(podePublicar, dono)).passou === true, 'com 2 ocorrências: publica normalmente')
  const RC = await demanda('reparos', dono, 'Atendo em domicílio')
  r = await marcar('reparo', RC)
  const sus = (await q(`SELECT publicacao_suspensa_ate, suspenso_em FROM usuarios WHERE id = $1`, [dono.id])).rows[0]
  const dias = (new Date(sus.publicacao_suspensa_ate) - Date.now()) / 86400000
  const pen = (await q(`SELECT lado, tipo, motivo, ate FROM penalidades_auto WHERE usuario_id = $1`, [dono.id])).rows
  ok(r.status === 200 && r.body.penalidade === 'suspenso' && /3ª ocorrência/.test(r.body.mensagem) && dias > 6.99 && dias <= 7 && sus.suspenso_em === null
     && pen.length === 1 && pen[0].lado === 'cliente' && pen[0].tipo === 'suspensao' && pen[0].motivo.anuncios.length === 3,
     '3ª ocorrência em 90 dias (por pessoa): 7 dias sem publicar pelo mecanismo de penalidades (publicacao_suspensa_ate + penalidades_auto)', { corpo: r.body, dias, pen: pen.length })
  const pushPen = pushes.find(p => p.data?.tipo === 'publicacao_suspensa')
  ok(pushPen?.to === 'ExponentPushToken[u1]' && pushPen.title === P.TITULO_PUBLICACAO && /anúncios do seu trabalho/.test(pushPen.body) && pushPen.data.motivo === 'anuncios', 'push ao dono do pedido com o motivo (anúncios)', pushPen)
  const b1 = await passar(podePublicar, dono), b2 = await passar(podePublicar, donoIrmao), b3 = await passar(podePublicar, cliente)
  ok(b1.status === 403 && b1.body.codigo === 'PUBLICACAO_SUSPENSA' && /anúncios do seu trabalho/.test(b1.body.erro) && !/denúncias/.test(b1.body.erro) && b2.status === 403 && b3.passou === true,
     'publicar: 403 PUBLICACAO_SUSPENSA com o texto de anúncios (vale para a outra conta do mesmo CPF; os outros clientes publicam)', b1)
  const lp = (await P.listarPenalidades(shim)).find(x => x.usuario_id === dono.id)
  ok(lp?.lado === 'cliente' && lp.status === 'suspenso' && lp.motivo.tipo === 'anuncios' && lp.motivo.anuncios.length === 3 && /3 pedidos marcados como anúncio em 90 dias/.test(lp.motivo.resumo), 'GET /admin/penalidades mostra a suspensão com os 3 anúncios', lp?.motivo?.resumo)
  silenciar(true); await P.encerrarPenalidadesVencidas(shim); silenciar(false)
  await q(`UPDATE usuarios SET publicacao_suspensa_ate = NOW() - INTERVAL '1 minute' WHERE id = $1`, [dono.id])
  await q(`UPDATE penalidades_auto SET ate = NOW() - INTERVAL '1 minute' WHERE usuario_id = $1`, [dono.id])
  silenciar(true); await P.encerrarPenalidadesVencidas(shim); silenciar(false)
  ok((await passar(podePublicar, dono)).passou === true, 'passados os 7 dias: o cron existente levanta o bloqueio')
  // Denúncias continuam com o texto delas.
  ok(/denúncias de profissionais diferentes/.test(P.corpoPublicacaoSuspensa(new Date()).erro) && /anúncios/.test(P.corpoPublicacaoSuspensa(new Date(), true).erro), 'texto do bloqueio por denúncias inalterado')
  // Ocorrência com mais de 90 dias não conta.
  for (const t of ['Faço 1', 'Faço 2']) await marcar('reparo', await demanda('reparos', cliente2, t))
  await q(`UPDATE anuncios_ocorrencias SET criado_em = NOW() - INTERVAL '91 days' WHERE usuario_id = $1 AND titulo = 'Faço 1'`, [cliente2.id])
  r = await marcar('reparo', await demanda('reparos', cliente2, 'Faço 3'))
  ok(r.status === 200 && r.body.ocorrencias === 3 && r.body.penalidade === null && (await passar(podePublicar, cliente2)).passou === true, '3 ocorrências, uma com mais de 90 dias: sem bloqueio', r.body)
  r = await marcar('reparo', await demanda('reparos', cliente2, 'Faço 4'))
  ok(r.body.penalidade === 'suspenso' && (await passar(podePublicar, cliente2)).status === 403, 'a 3ª DENTRO dos 90 dias bloqueia')

  // Painel: as listas trazem a marca.
  r = await chamar('get', '/reparos/admin', { usuario: ADM, query: { filtro: 'canceladas' } })
  const noPainel = (r.body?.reparos || []).find(x => x.id === RA)
  ok(noPainel?.suspeita_anuncio === true && !!noPainel.anuncio_em && Array.isArray(noPainel.suspeita_anuncio_motivos), 'GET /reparos/admin: suspeita_anuncio, motivos e anuncio_em na linha', noPainel && { s: noPainel.suspeita_anuncio, m: noPainel.suspeita_anuncio_motivos })

  const inesperados = erros.filter(e => !/sem banco/.test(e))
  ok(inesperados.length === 0, 'nenhum erro inesperado no log', inesperados.slice(0, 5))
  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
