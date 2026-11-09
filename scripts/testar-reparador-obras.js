#!/usr/bin/env node
// Lado profissional unificado, Fase 2a (decisão do dono, 09/11/2026): uma conta REPARADOR que marca
// ao menos uma das 4 especialidades de obra ("Obras de Construção Civil") passa a PODER TRABALHAR EM
// OBRAS — feed, pergunta, candidatura, push e e-mail de obra — sem mudar tipo_prestador. Cobre:
//   1. vocabulário (validarEspecialidades: serviços + 4 de obra para reparador, teto 5 no total; listas de
//      reparos.categoria e GRUPOS_RELACIONADOS intactas; grupo de exibição);
//   2. podeObras (JS) ≡ sqlPodeObras (SQL), linha a linha, com falha fechada para tipo NULL;
//   3. gate exigirPodeObras nas 6 rotas (cadeia REAL de middlewares, autenticar com JWT e cache),
//      incluindo cache velho de outra réplica, save do perfil e proposta em andamento;
//   4. público do push/e-mail de obra (os 2 predicados espelhados) e o de reparo, que não muda;
//   5. pode_obras / tem_candidaturas no login (montarSessao), perfil, /auth/contas e PUT /auth/perfil;
//   6. textos "pintor" → "profissional" e GET /config/grupos-categorias.
// SQL REAL num Postgres em memória (PGlite); Expo/Brevo falsos que só coletam.
//   npm i -D @electric-sql/pglite && node scripts/testar-reparador-obras.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const jwt = require(path.join(REPO, 'node_modules/jsonwebtoken'))
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
// A migração de boot (IIFE async em routes/index.js) rejeita sem banco; aqui isso é esperado.
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })
const logOrig = console.log, errOrig = console.error
console.log = () => {}; console.error = () => {}
const router = require(path.join(REPO, 'src/routes/index.js'))
console.log = logOrig; console.error = errOrig
const authCtrl = require(path.join(REPO, 'src/controllers/authController'))
const alerta = require(path.join(REPO, 'src/services/alertaService'))
const esp = require(path.join(REPO, 'src/utils/especialidades'))
const { GRUPOS_RELACIONADOS } = require(path.join(REPO, 'src/utils/gruposCategorias'))
const { podeObras, sqlPodeObras, capacidadeObras } = require(path.join(REPO, 'src/utils/capacidadeObras'))

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const assentar = () => new Promise(r => setTimeout(r, 150))
const tok = (id) => `ExponentPushToken[${id.slice(-3)}]`
const ordenado = (l) => [...l].sort()
const igual = (a, b) => JSON.stringify(ordenado(a)) === JSON.stringify(ordenado(b))

// ─── cadeia REAL da rota: todos os middlewares (autenticar incluso, com JWT) ───────────────────
const camadas = (metodo, caminho) => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  if (!layer) throw new Error(`rota ${metodo} ${caminho} não encontrada`)
  return layer.route.stack.map(l => l.handle)
}
// soGates: roda tudo MENOS o handler final → { passou: true } se todos chamaram next(), senão a resposta.
const rodar = (metodo, caminho, { id, params = {}, body = {}, soGates = true }) => new Promise(resolve => {
  const hs = soGates ? camadas(metodo, caminho).slice(0, -1) : camadas(metodo, caminho)
  const token = jwt.sign({ id, tv: 1 }, process.env.JWT_SECRET)
  const req = { headers: { authorization: `Bearer ${token}` }, params, body, query: {}, get: () => '', ip: '127.0.0.1' }
  const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  let i = 0
  const next = (err) => {
    if (err) return resolve({ erro: String(err.message || err) })
    if (i >= hs.length) return resolve({ passou: true })
    Promise.resolve(hs[i++](req, res, next)).catch(e => resolve({ erro: String(e.message || e) }))
  }
  next()
})
const chamar = (handler, { usuario, params = {}, query = {}, body = {} }) => new Promise(resolve => {
  const res = { statusCode: 200, set() { return this }, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  handler({ params, query, body, usuario, get: () => '', headers: {}, ip: '127.0.0.1' }, res)
})

// As 6 rotas que eram exigirPintor. emAndamento = aceitam também quem já é candidato NA obra.
const OBRA = D(1)
const ROTAS_OBRA = [
  { m: 'get',  c: '/obras' },
  { m: 'post', c: '/obras/:id/perguntas', params: { id: OBRA } },
  { m: 'post', c: '/obras/:id/candidatura', params: { id: OBRA } },
  { m: 'post', c: '/candidaturas' },
  { m: 'post', c: '/obras/:id/candidatura/:candidaturaId/pintor-responder', params: { id: OBRA, candidaturaId: D(99) }, emAndamento: true },
  { m: 'post', c: '/obras/:id/match', params: { id: OBRA }, emAndamento: true },
]
const gates = async (id) => {
  const saida = []
  for (const r of ROTAS_OBRA) saida.push({ ...r, r: await rodar(r.m, r.c, { id, params: r.params }) })
  return saida
}
const todasPassam = (rs) => rs.every(x => x.r.passou === true)
const todasTier = (rs) => rs.every(x => x.r.status === 403 && x.r.body?.codigo === 'TIER_INCORRETO')
const resumo = (rs) => rs.map(x => `${x.c}=${x.r.passou ? 'ok' : (x.r.status || x.r.erro)}${x.r.body?.codigo ? ':' + x.r.body.codigo : ''}`)

const main = async () => {
  // ═══ 1. Vocabulário ═══════════════════════════════════════════════════════════════════════
  const OBRA4 = ['engenheiro', 'construtor', 'pedreiro_servente', 'pintor']
  let v = esp.validarEspecialidades(['eletrica', 'pintor', 'pedreiro_servente'], true, 'reparador')
  ok(!v.erro && igual(v.valor, ['eletrica', 'pintor', 'pedreiro_servente']), 'reparador: serviço + especialidades de obra aceitos', v)
  v = esp.validarEspecialidades(OBRA4, true, 'reparador')
  ok(!v.erro && v.valor.length === 4, 'reparador: só as 4 de obra (sem serviço) é válido', v)
  v = esp.validarEspecialidades(['eletrica', 'faxina', ...OBRA4], true, 'reparador')
  ok(/no máximo 5/.test(v.erro || ''), 'reparador: 2 serviços + 4 obra = 6 → teto de 5 NO TOTAL', v)
  v = esp.validarEspecialidades(['eletrica', ...OBRA4], true, 'reparador')
  ok(!v.erro && v.valor.length === 5, 'reparador: 1 serviço + 4 obra = 5 → ok', v)
  v = esp.validarEspecialidades(['pintor', 'pintor', 'eletrica'], true, 'reparador')
  ok(!v.erro && v.valor.length === 2, 'reparador: duplicata de slug de obra colapsa', v)
  v = esp.validarEspecialidades(['residencial'], true, 'reparador')
  ok(/inválida/.test(v.erro || ''), 'reparador: categoria de OBRA (residencial) não é especialidade', v)
  // Fase 2b (simétrico): a conta pintor passou a aceitar também os serviços — ver
  // scripts/testar-profissional-mesma-pessoa.js. O que não é especialidade segue recusado.
  v = esp.validarEspecialidades(['pintor', 'eletrica'], true, 'pintor')
  ok(!v.erro && v.valor.length === 2, 'pintor: obra + serviço aceitos (Fase 2b)', v)
  v = esp.validarEspecialidades(['pintor', 'residencial'], true, 'pintor')
  ok(/inválida/.test(v.erro || ''), 'pintor: categoria de OBRA (residencial) não é especialidade', v)
  v = esp.validarEspecialidades(OBRA4, true, 'pintor')
  ok(!v.erro && v.valor.length === 4, 'pintor: as 4 de obra continuam válidas', v)
  v = esp.validarEspecialidades(['pintor'], true, null)
  ok(/inválida/.test(v.erro || ''), 'tipo NULL (legado): slug de obra continua recusado', v)
  v = esp.validarEspecialidades(['eletrica'], true, null)
  ok(!v.erro, 'tipo NULL (legado): lista de serviços como antes', v)
  ok(esp.ESPECIALIDADES_REPARADOR.length === 58 && !OBRA4.some(s => esp.ESPECIALIDADES_REPARADOR.includes(s)),
     'ESPECIALIDADES_REPARADOR (vocabulário de reparos.categoria) segue só com serviços (58) e SEM slug de obra', esp.ESPECIALIDADES_REPARADOR.length)
  ok(esp.ESPECIALIDADES_VALIDAS === esp.ESPECIALIDADES_REPARADOR, 'alias ESPECIALIDADES_VALIDAS intacto')
  ok(!Object.values(GRUPOS_RELACIONADOS).flat().some(s => OBRA4.includes(s)), 'GRUPOS_RELACIONADOS sem slug de obra (casamento de reparo não expande)')
  ok(esp.GRUPO_OBRAS_REPARADOR.nome === 'Obras de Construção Civil' && igual(esp.GRUPO_OBRAS_REPARADOR.categorias, esp.ESPECIALIDADES_OBRA),
     'grupo de exibição "Obras de Construção Civil" = as 4 de obra', esp.GRUPO_OBRAS_REPARADOR)
  ok(esp.ESPECIALIDADES_MAX === 5, 'teto de especialidades continua 5')

  // ═══ banco ════════════════════════════════════════════════════════════════════════════════
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
    ALTER TABLE usuarios ADD COLUMN avisos_todas_areas boolean NOT NULL DEFAULT true; -- preferência do aviso "fora da sua área" (migração de boot)
    CREATE TABLE assinaturas (usuario_id uuid, plano text, valor_mensal numeric, status text, tipo text, proximo_vencimento timestamptz, criado_em timestamptz DEFAULT now());
    CREATE TABLE obras (${colsDemanda}, valor numeric, horas_para_expirar numeric);
    CREATE TABLE reparos (${colsDemanda}, categorias text[], valor_estimado numeric, prazo_atendimento_horas numeric);
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, status text DEFAULT 'pendente', valor_proposto numeric,
      valor_contraproposta numeric, mensagem text, referencias text, criado_em timestamptz DEFAULT now());
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, status text DEFAULT 'pendente');
    CREATE TABLE avaliacoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contrato_tipo text, contrato_id uuid, avaliador_id uuid, avaliado_id uuid, estrelas int, etiquetas text[], criado_em timestamptz DEFAULT now());
    CREATE TABLE avisos_fora_area (tabela text, demanda_id uuid, usuario_id uuid, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE lembretes_push_enviados (tabela text, demanda_id uuid, usuario_id uuid, motivo text, enviado_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE avisos_acima_do_teto (tabela text, demanda_id uuid, usuario_id uuid, criado_em timestamptz NOT NULL DEFAULT now(), resumo_em timestamptz, PRIMARY KEY (tabela, demanda_id, usuario_id));
    CREATE TABLE push_entregas (primeira_tentativa_em timestamptz NOT NULL DEFAULT now(), tipo text, demanda_id uuid, usuario_id uuid, resultado text, tentativas int DEFAULT 1, ultima_tentativa_em timestamptz DEFAULT now(),
      criado_em timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE email_alertas (tipo text, demanda_id uuid, usuario_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (tipo, demanda_id, usuario_id));
    CREATE TABLE configuracoes (chave text PRIMARY KEY, valor text, atualizado_em timestamptz DEFAULT now());
    CREATE TABLE tentativas_contato (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid, tipo text, demanda_id uuid, campo text, criado_em timestamptz DEFAULT now());
    INSERT INTO configuracoes (chave, valor) VALUES ('grupos_relacionados_ativo', 'true'), ('multiplas_contas', 'true');
    SET search_path = public, pg_catalog;
  `)
  // n → conta. Todas em Uberlândia/MG, assinatura ativa, token e verificadas, salvo a observação.
  const CONTAS = {
    DONO:   { n: 1,  role: 'dono_obra', tipo_dono: 'pintura' },
    P:      { n: 2,  tipo: 'pintor',    esp: ['pintor'] },
    RO:     { n: 3,  tipo: 'reparador', esp: ['eletrica', 'pedreiro_servente'] },                 // reparador COM obra
    RS:     { n: 4,  tipo: 'reparador', esp: ['eletrica'] },                                      // reparador SEM obra
    RC:     { n: 5,  tipo: 'reparador', esp: ['faxina'] },                                        // sem obra, mas JÁ candidato na obra
    NL:     { n: 6,  tipo: null,        esp: ['pintor'] },                                        // legado: tipo NULL + texto que coincide
    RSUS:   { n: 7,  tipo: 'reparador', esp: ['pintor'], suspenso: true },
    RFORA:  { n: 8,  tipo: 'reparador', esp: ['pintor'], cidade: 'Uberaba' },
    RSEM:   { n: 9,  tipo: 'reparador', esp: ['pintor'], assinatura: 'cancelada' },
    RCACHE: { n: 10, tipo: 'reparador', esp: ['hidraulica'] },                                    // ganha obra "em outra réplica"
    RPERF:  { n: 11, tipo: 'reparador', esp: ['hidraulica'] },                                    // ganha/perde obra pelo PUT /auth/perfil
    RONLY:  { n: 12, tipo: 'reparador', esp: ['construtor'] },                                    // só obra, nenhum serviço
    ADM:    { n: 13, role: 'admin' },
    RNULO:  { n: 14, tipo: 'reparador', esp: null },                                              // especialidades NULL
  }
  for (const [nome, c] of Object.entries(CONTAS)) {
    c.id = U(c.n)
    const role = c.role || 'prestador'
    await db.query(
      `INSERT INTO usuarios (id, nome, email, telefone, cidade, uf, role, tipo_dono, tipo_prestador, cpf_cnpj, push_token, suspenso_em, especialidades, referencias)
       VALUES ($1::uuid, $2, $3, '34999990000', $4, 'MG', $5, $6, $7, $8, $9, ${c.suspenso ? 'now()' : 'NULL'}, $10::text[], '[]'::jsonb)`,
      [c.id, `${nome} Teste`, `${nome.toLowerCase()}@x.invalid`, c.cidade || 'Uberlândia', role, c.tipo_dono || null, c.tipo ?? null,
       String(c.n).padStart(11, '9'), tok(c.id), c.esp ?? null])
    if (role === 'prestador') await db.query(`INSERT INTO assinaturas (usuario_id, plano, valor_mensal, status, tipo) VALUES ($1::uuid, 'mensal', 49.90, $2, 'gratuito')`, [c.id, c.assinatura || 'ativa'])
  }
  const { DONO, P, RO, RS, RC, NL, RSUS, RFORA, RSEM, RCACHE, RPERF, RONLY, ADM, RNULO } = CONTAS
  await db.query(`INSERT INTO obras (id, titulo, categoria, cidade, uf, bairro, criado_por, valor, horas_para_expirar, expira_em, codigo_publico)
                  VALUES ($1::uuid, 'Reforma da casa', 'residencial', 'Uberlândia', 'MG', 'Centro', $2::uuid, 8000, 720, now() + INTERVAL '20 days', 'ABCDE')`, [OBRA, DONO.id])
  await db.query(`INSERT INTO reparos (id, titulo, categoria, categorias, cidade, uf, bairro, criado_por, valor_estimado, prazo_atendimento_horas, expira_em)
                  VALUES ($1::uuid, 'Trocar tomada', 'eletrica', '{eletrica}', 'Uberlândia', 'MG', 'Centro', $2::uuid, 150, 48, now() + INTERVAL '2 days')`, [D(2), DONO.id])
  await db.query(`INSERT INTO candidaturas (obra_id, usuario_id, status) VALUES ($1::uuid, $2::uuid, 'contraproposta_dono')`, [OBRA, RC.id])

  // ═══ 2. podeObras (JS) ≡ sqlPodeObras (SQL) ═══════════════════════════════════════════════
  const linhas = (await db.query(`SELECT u.id, u.nome, u.role, u.tipo_prestador, u.especialidades, ${sqlPodeObras('u')} AS sql_pode FROM usuarios u ORDER BY u.id`)).rows
  const divergentes = linhas.filter(l => podeObras(l) !== l.sql_pode).map(l => l.nome)
  ok(divergentes.length === 0, 'podeObras (JS) e sqlPodeObras (SQL) concordam em TODAS as contas', divergentes)
  const podem = linhas.filter(l => l.sql_pode).map(l => l.id)
  ok(igual(podem, [P.id, RO.id, RSUS.id, RFORA.id, RSEM.id, RONLY.id]),
     'capacidade: pintor + reparadores com especialidade de obra; reparador sem obra, tipo NULL, especialidades NULL, dono e admin NÃO',
     linhas.filter(l => l.sql_pode).map(l => l.nome))
  ok(podeObras({ role: 'prestador', tipo_prestador: null, especialidades: ['pintor'] }) === false, 'falha fechado: tipo_prestador NULL com "pintor" em especialidades')
  ok(podeObras({ role: 'dono_obra', tipo_prestador: 'pintor' }) === false && podeObras(null) === false && podeObras({ role: 'prestador', tipo_prestador: 'reparador' }) === false,
     'falha fechado: role errado, linha nula, reparador sem lista')
  const semAlias = (await db.query(`SELECT ${sqlPodeObras('')} AS p FROM usuarios WHERE id = $1`, [RO.id])).rows[0].p
  ok(semAlias === true, "sqlPodeObras('') (sem alias) avalia igual")

  // ═══ 4. Público do push / e-mail (ANTES de qualquer mudança de especialidade) ══════════════
  const destinatarios = () => ordenado(pushes.map(p => p.to))
  const ESPERADO_OBRA = [P, RO, RONLY].map(c => tok(c.id))
  pushes.length = 0
  await alerta.notificarPintoresSobreNovaObra(OBRA)
  ok(igual(destinatarios(), ESPERADO_OBRA), 'push NOVA OBRA: pintor + reparador com obra (RO, RONLY); fora: sem obra, tipo NULL, suspenso, outra cidade, sem assinatura',
     { recebeu: destinatarios(), esperado: ordenado(ESPERADO_OBRA) })
  ok(pushes.every(p => p.data?.tipo === 'nova_obra' && p.data?.obra_id === OBRA), 'push de obra mantém data { tipo: nova_obra, obra_id } (contrato do app)')
  const entregas = (await db.query(`SELECT usuario_id FROM push_entregas WHERE tipo = 'obra' AND demanda_id = $1`, [OBRA])).rows.map(r => r.usuario_id)
  ok(igual(entregas, [P.id, RO.id, RONLY.id]), 'push_entregas da obra registra os 3 destinatários', entregas.length)

  emails.length = 0
  await alerta.enviarEmailsNovaDemanda('obras', OBRA)
  await assentar()
  const paraQuem = ordenado((await db.query(`SELECT usuario_id FROM email_alertas WHERE demanda_id = $1 AND tipo = 'obra'`, [OBRA])).rows.map(r => r.usuario_id))
  ok(igual(paraQuem, [P.id, RO.id, RONLY.id]), 'E-MAIL nova obra: MESMO público do push (predicado espelhado)', { reivindicados: paraQuem.length, enviados: emails.length })
  ok(emails.length === 3, 'e-mail nova obra: 3 envios', emails.length)

  pushes.length = 0
  const totalOferta = await alerta.notificarOfertaAumentadaObra(OBRA)
  ok(igual(destinatarios(), ESPERADO_OBRA), 'push OFERTA AUMENTADA de obra: mesmo público', { recebeu: destinatarios().length, total: totalOferta?.enviados })

  pushes.length = 0; emails.length = 0
  await alerta.reanunciarDemanda('obras', OBRA)
  await assentar()
  ok(igual(destinatarios(), ESPERADO_OBRA), 'REANÚNCIO de obra: mesmo público (RC, já candidato e sem obra, fica fora)', destinatarios().length)
  const reab = ordenado((await db.query(`SELECT usuario_id FROM email_alertas WHERE demanda_id = $1 AND tipo = 'reaberta_obra'`, [OBRA])).rows.map(r => r.usuario_id))
  ok(igual(reab, [P.id, RO.id, RONLY.id]), 'e-mail do reanúncio de obra: mesmo público', reab.length)

  pushes.length = 0
  await alerta.notificarPrestadoresSobreNovoReparo(D(2))
  ok(igual(destinatarios(), [RO, RS].map(c => tok(c.id))),
     'push NOVO SERVIÇO (elétrica): reparadores que casam (RO, RS) — pintor NÃO, reparador só-obra NÃO, tipo NULL NÃO (lado reparo inalterado)', destinatarios())

  const fonteAlerta = fs.readFileSync(path.join(REPO, 'src/services/alertaService.js'), 'utf8')
  ok(!/u\.tipo_prestador = \$1/.test(fonteAlerta) && (fonteAlerta.match(/\$\{sqlPublicoProfissional\('\$1'\)\}/g) || []).length === 2,
     'os 2 predicados de público (push e e-mail) usam o MESMO fragmento sqlPublicoProfissional')
  // 6 desde o aviso "fora da sua área" (LADOS_FORA_AREA também nomeia o lado da demanda).
  ok((fonteAlerta.match(/publico: 'obras',/g) || []).length === 6 && !/tipoPrestador/.test(fonteAlerta),
     "as configurações do lado obra (nova, oferta, e-mail, lembrete, indicação + fora da área) passam publico: 'obras'", (fonteAlerta.match(/publico: 'obras',/g) || []).length)
  const nenhum = await alerta.broadcastPaginado({ publico: 'pintor', cidade: 'uberlandia', uf: 'MG', titulo: 't', corpo: 'c', data: {}, rotulo: 'teste', entrega: null })
  ok(nenhum.elegiveis === 0, 'público desconhecido (valor antigo "pintor") → ninguém (falha fechado)', nenhum)

  // ═══ 3. Gate nas 6 rotas ═══════════════════════════════════════════════════════════════════
  let g = await gates(P.id)
  ok(todasPassam(g), 'PINTOR passa nas 6 rotas de obra (regressão)', resumo(g))
  g = await gates(RO.id)
  ok(todasPassam(g), 'REPARADOR com especialidade de obra passa nas 6 rotas', resumo(g))
  g = await gates(RONLY.id)
  ok(todasPassam(g), 'reparador SÓ com especialidade de obra passa nas 6 rotas', resumo(g))
  g = await gates(RS.id)
  ok(todasTier(g), 'reparador SEM especialidade de obra → 403 TIER_INCORRETO nas 6 (regressão)', resumo(g))
  g = await gates(RNULO.id)
  ok(todasTier(g), 'reparador com especialidades NULL → 403 nas 6', resumo(g))
  g = await gates(NL.id)
  ok(todasTier(g), 'prestador com tipo NULL e "pintor" em especialidades → 403 nas 6 (falha fechado)', resumo(g))
  g = await gates(DONO.id)
  ok(g.every(x => x.r.status === 403), 'dono_obra → 403 nas 6', resumo(g))
  g = await gates(ADM.id)
  ok(todasPassam(g), 'admin passa (moderação)', resumo(g))
  g = await gates(RC.id)
  ok(g.filter(x => x.emAndamento).every(x => x.r.passou === true) && todasTier(g.filter(x => !x.emAndamento)),
     'reparador sem obra MAS já candidato na obra: passa só em /pintor-responder e /match (proposta em andamento); feed/pergunta/candidatura nova → 403', resumo(g))
  let r = await rodar('post', '/obras/:id/match', { id: RC.id, params: { id: D(77) } })
  ok(r.status === 403 && r.body.codigo === 'TIER_INCORRETO', 'candidato de UMA obra não passa no /match de OUTRA obra', r)
  r = await rodar('post', '/obras/:id/match', { id: RS.id, params: { id: 'nao-e-uuid' } })
  ok(r.status === 403, 'id de obra malformado no gate em andamento → 403, sem erro de banco', r)

  // Lado reparo: exigirReparador não mudou.
  r = await rodar('get', '/reparos', { id: P.id })
  ok(r.status === 403 && r.body.codigo === 'TIER_INCORRETO', 'pintor continua SEM acesso ao feed de reparos (403 TIER_INCORRETO)', r)
  r = await rodar('get', '/reparos', { id: RO.id })
  ok(r.passou === true, 'reparador com obra continua passando no feed de reparos', r)

  // Cache velho: RCACHE autentica (cache de autenticar guarda especialidades antigas) e a
  // especialidade de obra é gravada "por outra réplica" (direto no banco, sem invalidar).
  g = await gates(RCACHE.id)
  ok(todasTier(g), 'RCACHE sem obra → 403 (e o cache de autenticar fica com a lista antiga)', resumo(g))
  await db.query(`UPDATE usuarios SET especialidades = '{hidraulica,engenheiro}' WHERE id = $1`, [RCACHE.id])
  g = await gates(RCACHE.id)
  ok(todasPassam(g), 'especialidade de obra gravada em OUTRA réplica: o gate reconfere a negativa no banco e libera NA HORA', resumo(g))

  // Save do perfil: PUT /auth/perfil invalida o cache e devolve pode_obras.
  g = await gates(RPERF.id)
  ok(todasTier(g), 'RPERF sem obra → 403', resumo(g))
  const reqPerf = (await db.query(`SELECT id, nome, email, role, ativo, tipo_prestador, especialidades FROM usuarios WHERE id = $1`, [RPERF.id])).rows[0]
  r = await chamar(authCtrl.atualizarPerfil, { usuario: reqPerf, body: { especialidades: ['hidraulica', 'pintor', 'pedreiro_servente'] } })
  ok(r.status === 200 && r.body.pode_obras === true && r.body.especialidades.length === 3, 'PUT /auth/perfil marcando obra → 200 com pode_obras: true', r.body)
  g = await gates(RPERF.id)
  ok(todasPassam(g), 'depois do save, RPERF passa nas 6 rotas', resumo(g))
  r = await chamar(authCtrl.atualizarPerfil, { usuario: reqPerf, body: { especialidades: ['hidraulica', 'eletrica', 'faxina', 'pintor', 'construtor', 'engenheiro'] } })
  ok(r.status === 400 && /no máximo 5/.test(r.body.erro), 'PUT /auth/perfil com 6 (3 serviço + 3 obra) → 400 teto 5', r.body)
  r = await chamar(authCtrl.atualizarPerfil, { usuario: reqPerf, body: { especialidades: ['hidraulica'] } })
  ok(r.status === 200 && r.body.pode_obras === false, 'PUT /auth/perfil tirando obra → pode_obras: false', r.body)
  g = await gates(RPERF.id)
  ok(todasTier(g), 'depois de tirar a especialidade, RPERF volta ao 403 na mesma réplica (cache invalidado)', resumo(g))
  r = await chamar(authCtrl.atualizarPerfil, { usuario: reqPerf, body: { nome: 'RPERF Novo Nome' } })
  ok(r.status === 200 && r.body.pode_obras === false && r.body.especialidades.length === 1, 'PUT /auth/perfil sem especialidades não mexe na lista', r.body)
  const reqPintor = (await db.query(`SELECT id, nome, email, role, ativo, tipo_prestador, especialidades FROM usuarios WHERE id = $1`, [P.id])).rows[0]
  r = await chamar(authCtrl.atualizarPerfil, { usuario: reqPintor, body: { especialidades: ['pintor', 'residencial'] } })
  ok(r.status === 400, 'PUT /auth/perfil de PINTOR com slug que não é especialidade → 400', r.body)

  // Rota inteira: reparador com obra SE CANDIDATA e o dono é avisado com o texto novo.
  pushes.length = 0
  r = await rodar('post', '/obras/:id/candidatura', { id: RO.id, params: { id: OBRA }, body: { mensagem: 'Faço a alvenaria', valor_proposto: 7500 }, soGates: false })
  await assentar()
  ok(r.status === 201 && r.body.usuario_id === RO.id && r.body.obra_id === OBRA, 'POST /obras/:id/candidatura como reparador com obra → 201', r.status === 201 ? r.body.status : r)
  const aviso = pushes.find(p => p.data?.tipo === 'nova_candidatura')
  ok(aviso && aviso.to === tok(DONO.id) && /Um profissional se candidatou/.test(aviso.body) && !/pintor/i.test(aviso.body + aviso.title),
     'dono avisado: "Um profissional se candidatou…" (sem "pintor")', aviso && { titulo: aviso.title, corpo: aviso.body })
  r = await rodar('post', '/obras/:id/candidatura', { id: RO.id, params: { id: OBRA }, body: {}, soGates: false })
  ok(r.status === 409, 'segunda candidatura da mesma conta → 409 (unicidade por conta inalterada)', r)
  r = await rodar('post', '/obras/:id/candidatura', { id: RS.id, params: { id: OBRA }, body: {}, soGates: false })
  ok(r.status === 403 && r.body.codigo === 'TIER_INCORRETO', 'reparador sem obra não se candidata (403), nada gravado', r)
  const nCand = (await db.query(`SELECT count(*)::int AS n FROM candidaturas WHERE obra_id = $1`, [OBRA])).rows[0].n
  ok(nCand === 2, 'candidaturas na obra: a de RC (semente) + a de RO', nCand)

  // ═══ 5. pode_obras / tem_candidaturas nas respostas ═══════════════════════════════════════
  const linha = async (id) => (await db.query(`SELECT * FROM usuarios WHERE id = $1`, [id])).rows[0]
  const sessao = async (c) => (await authCtrl.montarSessao(await linha(c.id), { headers: {}, get: () => '' })).usuario
  let s = await sessao(P)
  ok(s.pode_obras === true && s.tem_candidaturas === false && s.tipo_prestador === 'pintor', 'login (montarSessao) PINTOR: pode_obras true, tem_candidaturas false', { pode_obras: s.pode_obras, tem_candidaturas: s.tem_candidaturas })
  s = await sessao(RO)
  ok(s.pode_obras === true && s.tem_candidaturas === true && s.tipo_prestador === 'reparador', 'login REPARADOR com obra (já candidato): pode_obras true, tem_candidaturas true; tipo_prestador segue "reparador"', { pode_obras: s.pode_obras, tem_candidaturas: s.tem_candidaturas })
  s = await sessao(RS)
  ok(s.pode_obras === false && s.tem_candidaturas === false, 'login reparador sem obra: os dois false', { pode_obras: s.pode_obras, tem_candidaturas: s.tem_candidaturas })
  s = await sessao(RC)
  ok(s.pode_obras === false && s.tem_candidaturas === true, 'login reparador sem obra com proposta em andamento: pode_obras false, tem_candidaturas TRUE', { pode_obras: s.pode_obras, tem_candidaturas: s.tem_candidaturas })
  s = await sessao(DONO)
  ok(s.pode_obras === false && s.tem_candidaturas === false, 'login dono: os dois false')
  s = await sessao(NL)
  ok(s.pode_obras === false, 'login prestador tipo NULL: pode_obras false')
  // A linha sem `especialidades` (RETURNING da conta vinculada) não engana: o valor vem do banco.
  const semEsp = { ...(await linha(RO.id)) }; delete semEsp.especialidades
  s = (await authCtrl.montarSessao(semEsp, { headers: {}, get: () => '' })).usuario
  ok(s.pode_obras === true, 'montarSessao com linha SEM especialidades (conta vinculada) lê a capacidade do banco')

  r = await chamar(authCtrl.listarContas, { usuario: await linha(RO.id) })
  ok(r.status === 200 && r.body.pode_obras === true && r.body.tem_candidaturas === true && r.body.tem_obras === false && Array.isArray(r.body.contas),
     'GET /auth/contas (reparador com obra): pode_obras + tem_candidaturas, tem_obras e contas intactos', r.body)
  r = await chamar(authCtrl.listarContas, { usuario: await linha(RS.id) })
  ok(r.status === 200 && r.body.pode_obras === false && r.body.tem_candidaturas === false, 'GET /auth/contas (reparador sem obra): false/false', r.body)
  r = await chamar(authCtrl.listarContas, { usuario: await linha(DONO.id) })
  ok(r.status === 200 && r.body.tem_obras === true && r.body.pode_obras === false, 'GET /auth/contas (dono): tem_obras true como antes, pode_obras false', r.body)

  r = await chamar(authCtrl.perfil, { usuario: await linha(RO.id) })
  ok(r.status === 200 && r.body.usuario.pode_obras === true && r.body.usuario.tem_candidaturas === true && r.body.usuario.tipo_prestador === 'reparador' && r.body.usuario.avaliacoes,
     'GET /auth/perfil (reparador com obra): usuario.pode_obras / tem_candidaturas, resto intacto', r.status === 200 ? { pode_obras: r.body.usuario.pode_obras, tem_candidaturas: r.body.usuario.tem_candidaturas } : r)
  r = await chamar(authCtrl.perfil, { usuario: await linha(P.id) })
  ok(r.status === 200 && r.body.usuario.pode_obras === true, 'GET /auth/perfil (pintor): pode_obras true', r.status)
  const cap = await capacidadeObras('aaaaaaaa-0000-4000-8000-999999999999')
  ok(cap.pode_obras === false && cap.tem_candidaturas === false, 'capacidadeObras de conta inexistente → false/false')

  // ═══ 6. Textos e config ═══════════════════════════════════════════════════════════════════
  r = await chamar(camadas('get', '/config/grupos-categorias').slice(-1)[0], { usuario: null })
  ok(r.status === 200 && r.body.grupo_obras?.nome === 'Obras de Construção Civil' && igual(r.body.grupo_obras.categorias, OBRA4)
     && !r.body.grupos.flatMap(x => x.categorias).some(c => OBRA4.includes(c)) && r.body.grupos.length === 10,
     'GET /config/grupos-categorias: grupo_obras à parte; `grupos` (seletor de serviço) com os 10 de sempre e sem slug de obra', r.body.grupo_obras)

  const ler = (f) => fs.readFileSync(path.join(REPO, f), 'utf8')
  const VELHOS = [
    ['src/routes/index.js', ['Um pintor se candidatou', 'O pintor propôs', 'O pintor recusou', 'O pintor saiu para', 'Pintor a caminho', 'Um pintor confirmou',
      'O pintor concluiu', 'O pintor não chegou', 'Um pintor fez uma oferta', 'Um pintor demonstrou', "profissional: 'pintor'", 'exigirPintor = ', 'com pintor a caminho', 'tem um pintor a caminho']],
    ['src/services/alertaService.js', ['visível para os pintores', 'O pintor ainda não chegou', "profissional: 'pintor'"]],
    ['src/services/atrasoChegadaService.js', ["profissional: 'pintor'", "'Pintor'"]],
    ['src/services/cancelamentoMatchService.js', ["profissional: 'pintor'"]],
    ['src/controllers/mensagensController.js', ['<strong>Pintor:</strong>']],
    ['server.js', ["profissional: 'o pintor'"]],
  ]
  const sobras = VELHOS.flatMap(([f, frases]) => { const t = ler(f); return frases.filter(x => t.includes(x)).map(x => `${f}: ${x}`) })
  ok(sobras.length === 0, 'textos de notificação/erro do lado obra sem "pintor" (agora "profissional")', sobras)
  ok(ler('src/routes/index.js').includes("'/obras/:id/candidatura/:candidaturaId/pintor-responder'"), 'rota /pintor-responder mantém o NOME (apps nas lojas)')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas === 0 ? 0 : 1)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
