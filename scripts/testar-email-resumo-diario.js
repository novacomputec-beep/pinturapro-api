#!/usr/bin/env node
// RESUMO DIÁRIO POR E-MAIL (services/emailResumoDiarioService, chave email_resumo_diario).
// ESQUEMA DE PRODUÇÃO (PGlite), Expo e Brevo FALSOS (nada sai de verdade). Cobre:
//   chave LIGADA: quem tem push (na conta ou em conta irmã) não recebe e-mail na hora — o aviso
//   vira item do resumo; quem NÃO tem push recebe na hora; demanda nova ao profissional sai na
//   hora; avisos de conta saem na hora; lembrete "a cada ciclo" do dono sem push sai na hora;
//   push que falhou → e-mail na hora; o mesmo aviso não entra duas vezes;
//   cron: antes das 19:00 SP nada; às 19:00 UM e-mail por pessoa ("Seu dia no ProTudo — dd/mm"),
//   agrupado por pedido, com o link /p/{codigo}; a fila é apagada; conta no teto diário; não repete
//   no mesmo dia; dia sem itens não manda nada;
//   chave DESLIGADA = comportamento antigo (e o que já estava na fila ainda sai às 19:00);
//   painel: GET/POST /admin/email-resumo-diario.
//   npm i -D @electric-sql/pglite && node scripts/testar-email-resumo-diario.js
process.env.JWT_SECRET = 'segredo-de-teste'
const fs = require('fs')
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

const pushes = []
const emails = []
class FakeExpo {
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
  chunkPushNotifications(m) { return [m] }
  async sendPushNotificationsAsync(chunk) {
    pushes.push(...chunk)
    return chunk.map((m, i) => (m.to === 'ExponentPushToken[quebrado]' ? { status: 'error', message: 'falhou', details: { error: 'MessageRateExceeded' } } : { status: 'ok', id: `t${pushes.length}-${i}` }))
  }
  chunkPushNotificationReceiptIds(ids) { return [ids] }
  async getPushNotificationReceiptsAsync() { return {} }
}
let db = null
const comRowCount = (r) => { if (r && r.rowCount === undefined) r.rowCount = r.affectedRows || (r.rows ? r.rows.length : 0); return r }
const q = async (sql, params) => { if (!db) throw new Error('sem banco (boot)'); return comRowCount(await db.query(sql, params)) }
const shim = { query: q, connect: async () => { if (!db) throw new Error('sem banco (boot)'); return { query: q, release() {} } }, on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'expo-server-sdk') return { Expo: FakeExpo }
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  if (/pushRecibos$/.test(request)) return { registrarTickets() {}, registrarRecibos() {} }
  if (/brevoService$/.test(request)) return { enviarEmail: async (m) => { emails.push(m) }, enviarEmailComAnexo: async () => {} }
  return origLoad.apply(this, arguments)
}
process.on('unhandledRejection', (e) => { if (!/sem banco/.test(String(e?.message))) { console.error('unhandled', e); process.exit(1) } })

// Relógio: T0 = 19/11/2026 10:00 em São Paulo (13:00Z); minutos a partir de T0.
const T0 = Date.parse('2026-11-19T13:00:00Z')
const RealDate = Date
let relogio = T0
global.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [relogio])) }
  static now() { return relogio }
}
const fixarAgora = (min) => {
  relogio = T0 + min * 60000
  return db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${new RealDate(relogio).toISOString()}'::timestamptz $$`)
}
const logOrig = console.log, errOrig = console.error, warnOrig = console.warn
const silenciar = (v) => { console.log = v ? () => {} : logOrig; console.warn = v ? () => {} : warnOrig; console.error = v ? () => {} : errOrig }
silenciar(true)
const router = require(path.join(REPO, 'src/routes/index.js'))
const A = require(path.join(REPO, 'src/services/alertaService'))
const R = require(path.join(REPO, 'src/services/emailResumoDiarioService'))
silenciar(false)

let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; logOrig(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const D = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const chamar = (metodo, caminho, body = {}) => new Promise(resolve => {
  const layer = router.stack.find(l => l.route && l.route.path === caminho && l.route.methods[metodo])
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { resolve({ status: this.statusCode, body: b }) } }
  const pilha = layer.route.stack
  Promise.resolve(pilha[pilha.length - 1].handle({ body, query: {}, params: {}, usuario: { id: U(99), role: 'admin' } }, res)).catch(e => resolve({ status: 599, body: { erro: e.message } }))
})

const DONO_PUSH = U(1), DONO_SEM = U(2), DONA_IRMA = U(3), DONA_IRMA_TOKEN = U(4), DONO_QUEBRADO = U(5), PROF = U(10)
const R1 = D(1), R2 = D(2), R3 = D(3), R4 = D(4), R5 = D(5)

const main = async () => {
  db = new PGlite()
  await db.exec(fs.readFileSync(path.join(REPO, 'scripts/fixtures/esquema-producao.sql'), 'utf8'))
  // O esquema de produção vem sem chaves: as UNIQUE que o código usa em ON CONFLICT entram aqui.
  await db.exec(`
    CREATE UNIQUE INDEX email_alertas_teste_key ON email_alertas (tipo, demanda_id, usuario_id);
    CREATE UNIQUE INDEX configuracoes_teste_key ON configuracoes (chave);
    INSERT INTO configuracoes (chave, valor) VALUES ('email_resumo_diario', 'true'), ('grupos_relacionados_ativo', 'true');
    SET search_path = public, pg_catalog;
  `)
  await fixarAgora(0)
  const usr = (id, nome, role, extra = {}) => {
    const cols = { id, nome, email: `${nome.toLowerCase().replace(/\s/g, '')}@x.invalid`, role, cidade: 'Uberlândia', uf: 'MG', cpf_cnpj: id.slice(-11), ativo: true, ...extra }
    const ks = Object.keys(cols)
    return q(`INSERT INTO usuarios (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map(k => cols[k]))
  }
  await usr(DONO_PUSH, 'Dono Push', 'dono_obra', { push_token: 'ExponentPushToken[dono]' })
  await usr(DONO_SEM, 'Dono Sem', 'dono_obra')
  // A conta que criou o pedido não tem token; a outra conta contratante da mesma pessoa (mesmo CPF) tem.
  await usr(DONA_IRMA, 'Dona Irma', 'dono_obra', { cpf_cnpj: '123.456.789-09', tipo_dono: 'dono_reparo' })
  await usr(DONA_IRMA_TOKEN, 'Dona Irma', 'dono_obra', { cpf_cnpj: '12345678909', tipo_dono: 'dono_obra', email: null, push_token: 'ExponentPushToken[irma]' })
  await usr(DONO_QUEBRADO, 'Dono Quebrado', 'dono_obra', { push_token: 'ExponentPushToken[quebrado]' })
  await usr(PROF, 'Prof Eletrica', 'prestador', { tipo_prestador: 'reparador', especialidades: ['eletrica'], push_token: 'ExponentPushToken[prof]', avisos_todas_areas: false })
  await q(`INSERT INTO assinaturas (usuario_id, status) VALUES ($1, 'ativa')`, [PROF])
  const reparo = (id, titulo, dono, codigo) => q(
    `INSERT INTO reparos (id, titulo, descricao, categoria, categorias, cidade, uf, bairro, criado_por, status, status_aprovacao, valor_estimado, prazo_atendimento_horas, expira_em, push_novo_enviado_em, codigo_publico)
     VALUES ($1, $2, 'x', 'eletrica', ARRAY['eletrica'], 'Uberlândia', 'MG', 'Centro', $3, 'aberta', 'aprovada', 150, 240, now() + INTERVAL '10 days', now(), $4)`, [id, titulo, dono, codigo])
  await reparo(R1, 'Trocar tomada', DONO_PUSH, 'AAAA1')
  await reparo(R2, 'Instalar chuveiro', DONO_PUSH, 'BBBB2')
  await reparo(R3, 'Pedido do sem push', DONO_SEM, 'CCCC3')
  await reparo(R4, 'Pedido da irmã', DONA_IRMA, 'DDDD4')
  await reparo(R5, 'Pedido do quebrado', DONO_QUEBRADO, 'EEEE5')

  const avisar = async (usuario, tipo, reparoId, titulo, corpo, extra = {}) => {
    silenciar(true)
    const v = await A.avisarUsuario(usuario, { titulo, corpo, data: { tipo, ...(reparoId ? { reparo_id: reparoId } : {}), ...extra }, rotulo: `teste ${tipo}` })
    silenciar(false)
    return v
  }
  const itens = async (usuario) => (await q(`SELECT tipo, demanda_id, titulo, linha FROM email_resumo_itens ${usuario ? 'WHERE usuario_id = $1' : ''} ORDER BY id`, usuario ? [usuario] : [])).rows
  const para = (e) => emails.filter(m => m.para === e)
  const cron = async () => { silenciar(true); const r = await R.enviarResumoDiario(); silenciar(false); return r }

  // ═══════════ CHAVE LIGADA — 10:00 ═══════════
  let v = await avisar(DONO_PUSH, 'novo_interesse', R1, '🙋 Novo interessado', 'Carlos se interessou pelo seu pedido.', { interesse_id: 'i1' })
  ok(v === 'push+e-mail no resumo' && emails.length === 0 && pushes.filter(p => p.to === 'ExponentPushToken[dono]').length === 1 && (await itens(DONO_PUSH)).length === 1,
     'quem tem push: push na hora, NENHUM e-mail na hora, 1 item no resumo', [v, emails.length])
  v = await avisar(DONO_PUSH, 'novo_interesse', R1, '🙋 Novo interessado', 'Carlos se interessou pelo seu pedido.', { interesse_id: 'i1' })
  ok(v === 'push+e-mail já enviado' && (await itens(DONO_PUSH)).length === 1, 'o MESMO aviso de novo: não entra duas vezes no resumo', v)
  await fixarAgora(30)
  await avisar(DONO_PUSH, 'nova_pergunta', R1, '❓ Nova pergunta', 'Larissa perguntou: tem disjuntor?', { pergunta_id: 'p1' })
  await avisar(DONO_PUSH, 'novo_interesse', R2, '🙋 Novo interessado', 'Beto se interessou pelo seu pedido.', { interesse_id: 'i2' })
  silenciar(true)
  const vl = await A.entregarLembrete({ usuario_id: DONO_PUSH, push_token: 'ExponentPushToken[dono]', email: 'donopush@x.invalid', nome: 'Dono Push', titulo: '👥 2 profissionais aguardam sua escolha', corpo: 'Escolha um profissional.', data: { tipo: 'escolha_pendente', reparo_id: R2 }, rotulo: 'teste lembrete' })
  silenciar(false)
  ok(vl === 'push+e-mail no resumo' && emails.length === 0 && (await itens(DONO_PUSH)).length === 4, 'lembrete a quem tem push também vai para o resumo (4 itens do dono)', [vl, (await itens(DONO_PUSH)).length])

  v = await avisar(DONO_SEM, 'novo_interesse', R3, '🙋 Novo interessado', 'Carlos se interessou pelo seu pedido.')
  ok(v === 'e-mail' && para('donosem@x.invalid').length === 1 && (await itens(DONO_SEM)).length === 0, 'quem NÃO tem push: e-mail na hora, nada no resumo', v)
  silenciar(true)
  const vc = await A.entregarLembrete({ usuario_id: DONO_SEM, push_token: null, email: 'donosem@x.invalid', nome: 'Dono Sem', emailCadaCiclo: true, titulo: '❓ 1 pergunta aguarda sua resposta', corpo: 'Responda.', data: { tipo: 'nova_pergunta', reparo_id: R3 }, rotulo: 'teste ciclo' })
  silenciar(false)
  ok(vc === 'e-mail' && para('donosem@x.invalid').length === 2 && (await itens(DONO_SEM)).length === 0, 'lembrete "a cada ciclo" do dono sem push: e-mail na hora', vc)

  v = await avisar(DONA_IRMA, 'novo_interesse', R4, '🙋 Novo interessado', 'Ana se interessou pelo seu pedido.')
  ok(v === 'push+e-mail no resumo' && para('donairma@x.invalid').length === 0 && (await itens(DONA_IRMA)).length === 1 && pushes.some(p => p.to === 'ExponentPushToken[irma]'),
     'token só na conta IRMÃ da mesma pessoa: conta como "tem push" → resumo', v)

  v = await avisar(DONO_QUEBRADO, 'novo_interesse', R5, '🙋 Novo interessado', 'Ana se interessou pelo seu pedido.')
  ok(!/push/.test(v) && /e-mail$/.test(v) && para('donoquebrado@x.invalid').length === 1 && (await itens(DONO_QUEBRADO)).length === 0, 'push FALHOU agora: o e-mail sai na hora (o aviso não fica só para as 19:00)', v)

  v = await avisar(PROF, 'conta_suspensa', null, 'Conta suspensa', 'Sua conta foi suspensa por 7 dias.')
  const v2 = await avisar(PROF, 'verificacao_aprovada', null, 'Cadastro aprovado', 'Seu cadastro foi aprovado.')
  ok(v === 'push+e-mail' && v2 === 'push+e-mail' && para('profeletrica@x.invalid').length === 2 && (await itens(PROF)).length === 0, 'avisos de conta (suspensa, aprovada): e-mail na hora mesmo com push', [v, v2])

  silenciar(true)
  const antes = para('profeletrica@x.invalid').length
  await A.enviarEmailsNovaDemanda('reparos', R1)
  await new Promise(r => setTimeout(r, 300))
  silenciar(false)
  const novos = para('profeletrica@x.invalid').slice(antes)
  const claimsR1 = async () => (await q(`SELECT 1 FROM email_alertas WHERE tipo = 'reparo' AND demanda_id = $1 AND usuario_id = $2`, [R1, PROF])).rows.length
  ok(novos.length === 0 && (await itens(PROF)).length === 0 && await claimsR1() === 0,
     'demanda nova ao profissional COM token, antes de o push sair: nenhum e-mail na hora e nada no resumo', novos.map(m => m.assunto))
  // O push da demanda nova SAIU para ele: o pedido vira UMA linha do resumo das 19:00 (sem e-mail na hora).
  await q(`INSERT INTO push_entregas (tipo, demanda_id, usuario_id, resultado) VALUES ('reparo', $1, $2, 'enviado')`, [R1, PROF])
  silenciar(true)
  await A.enviarEmailsNovaDemanda('reparos', R1)
  await A.enviarEmailsNovaDemanda('reparos', R1) // de novo (cron do dia seguinte, categorias adicionadas): não duplica
  await new Promise(r => setTimeout(r, 300))
  silenciar(false)
  const linhasR1 = (await itens(PROF))
  ok(para('profeletrica@x.invalid').length === antes && await claimsR1() === 0 && linhasR1.length === 1,
     'demanda nova a quem RECEBEU o push: sem e-mail na hora, UMA linha no resumo (repetir o caminho não duplica)', linhasR1.length)
  const linhaR1 = (await q(`SELECT tipo, demanda_tabela, demanda_id, titulo, linha FROM email_resumo_itens WHERE usuario_id = $1`, [PROF])).rows[0]
  ok(linhaR1 && linhaR1.tipo === 'novo_reparo' && linhaR1.demanda_tabela === 'reparos' && linhaR1.demanda_id === R1 && /Novo serviço disponível!$/.test(linhaR1.titulo) && /Uberlândia/.test(linhaR1.linha || ''),
     'a linha do resumo leva o texto do aviso de demanda nova e o pedido (o resumo mostra o botão dele)', linhaR1)

  v = await avisar(PROF, 'interesse_aceito', R1, '✅ Proposta aceita', 'O dono aceitou sua proposta.')
  ok(v === 'push+e-mail no resumo' && (await itens(PROF)).length === 2, 'aviso do dia a dia ao profissional com push: resumo (2ª linha dele)', v)

  // As DUAS restrições de produção que barravam a linha do resumo em email_alertas (demanda_id NOT NULL e o
  // CHECK de tipo): sem elas este teste passava enquanto em produção o INSERT falhava sempre. Entram só AQUI
  // porque a chave do lembrete "a cada ciclo" testada acima (aviso:lembrete#AAAAMMDD#k) também é recusada por
  // esse CHECK em produção — defeito separado, relatado ao dono em 20/11/2026 e ainda não corrigido.
  await db.exec(`ALTER TABLE email_alertas ALTER COLUMN demanda_id SET NOT NULL;
                 ALTER TABLE email_alertas ADD CONSTRAINT email_alertas_tipo_check CHECK (${require(path.join(REPO, 'src/services/emailResumoDiarioService')).CHECK_TIPO_EMAIL_ALERTAS}) NOT VALID;`)
  // ═══════════ CRON ═══════════
  emails.length = 0
  await fixarAgora(8 * 60 + 59) // 18:59 SP
  let r = await cron()
  ok(r === null && emails.length === 0 && (await itens()).length === 7, '18:59: o cron não manda nada', [(await itens()).length])
  const orcAntes = (await A.orcamentoEmailsDeDemanda()).restante
  await fixarAgora(9 * 60) // 19:00 SP
  r = await cron()
  ok(r && r.enviados === 3 && r.falhas === 0 && emails.length === 3 && emails.every(m => m.assunto === 'Seu dia no ProTudo — 19/11'),
     '19:00: UM e-mail por pessoa com itens (dono, dona irmã, profissional), assunto "Seu dia no ProTudo — 19/11"', [r, emails.map(m => m.para)])
  const md = para('donopush@x.invalid')[0]
  const pos = (s) => md.html.indexOf(s)
  ok(md && md.html.split('Trocar tomada').length === 2 && md.html.split('Instalar chuveiro').length === 2
     && pos('Trocar tomada') < pos('Carlos se interessou') && pos('Carlos se interessou') < pos('Larissa perguntou') && pos('Larissa perguntou') < pos('Instalar chuveiro')
     && pos('Instalar chuveiro') < pos('Beto se interessou') && pos('Beto se interessou') < pos('Escolha um profissional'),
     'resumo do dono: agrupado por pedido — título do pedido UMA vez e, embaixo, os avisos dele em ordem')
  ok(md.html.includes('href="https://protudo.app.br/p/AAAA1"') && md.html.includes('href="https://protudo.app.br/p/BBBB2"') && md.html.split('Abrir o ProTudo').length === 3
     && md.html.includes('10:00') && md.html.includes('10:30') && md.texto.includes('• 10:30 · ❓ Nova pergunta — Larissa perguntou: tem disjuntor?') && md.texto.includes('Abrir o ProTudo: https://protudo.app.br/p/AAAA1'),
     'resumo do dono: botão "Abrir o ProTudo" com o link /p/{codigo} de cada pedido, hora de cada aviso, versão em texto')
  ok(para('donairma@x.invalid').length === 1 && para('donairma@x.invalid')[0].html.includes('/p/DDDD4') && para('donosem@x.invalid').length === 0 && para('donoquebrado@x.invalid').length === 0,
     'a pessoa com token na conta irmã recebe o dela; quem recebeu tudo na hora (sem push) não recebe resumo')
  const contados = (await q(`SELECT usuario_id FROM email_alertas WHERE tipo = 'resumo_diario#20261119'`)).rows.length
  ok((await itens()).length === 0 && contados === 3 && (await A.orcamentoEmailsDeDemanda()).restante === orcAntes - 3, 'depois do envio: fila apagada e os 3 resumos contam no teto diário', [contados, orcAntes])
  await fixarAgora(9 * 60 + 5)
  r = await cron()
  ok(r === null && emails.length === 3, '19:05: não repete no mesmo dia (claim do dia)')

  // Dia seguinte SEM itens: nada.
  emails.length = 0
  await fixarAgora(24 * 60 + 9 * 60)
  r = await cron()
  ok(r && r.enviados === 0 && r.pessoas === 0 && emails.length === 0, 'dia sem itens: às 19:00 ninguém recebe nada', r)

  // ═══════════ CHAVE DESLIGADA = comportamento antigo ═══════════
  await fixarAgora(24 * 60 + 10 * 60) // dia 20, 20:00: um aviso ainda com a chave ligada
  await avisar(DONO_PUSH, 'novo_interesse', R1, '🙋 Novo interessado', 'Davi se interessou pelo seu pedido.', { interesse_id: 'i9' })
  const g1 = await chamar('get', '/admin/email-resumo-diario')
  const p0 = await chamar('post', '/admin/email-resumo-diario', { ativo: 'sim' })
  const p1 = await chamar('post', '/admin/email-resumo-diario', { ativo: false })
  const g2 = await chamar('get', '/admin/email-resumo-diario')
  ok(g1.body.ativo === true && g1.body.pendentes === 1 && p0.status === 400 && p1.status === 200 && p1.body.ativo === false && g2.body.ativo === false && g2.body.pendentes === 1,
     'painel: GET/POST /admin/email-resumo-diario liga e desliga a chave (valor inválido → 400)', [g1.body, p0.status, g2.body])
  emails.length = 0
  v = await avisar(DONO_PUSH, 'novo_interesse', R2, '🙋 Novo interessado', 'Eva se interessou pelo seu pedido.', { interesse_id: 'i10' })
  ok(v === 'push+e-mail' && para('donopush@x.invalid').length === 1 && para('donopush@x.invalid')[0].assunto === '🙋 Novo interessado' && (await itens()).length === 1,
     'chave DESLIGADA: quem tem push volta a receber o e-mail na hora (comportamento antigo), nada novo na fila', v)
  emails.length = 0
  await fixarAgora(2 * 24 * 60 + 9 * 60) // dia 21, 19:00
  r = await cron()
  ok(r && r.enviados === 1 && emails.length === 1 && emails[0].assunto === 'Seu dia no ProTudo — 21/11' && emails[0].html.includes('Davi se interessou') && (await itens()).length === 0,
     'o que já estava na fila quando a chave foi desligada ainda sai no próximo resumo (nada se perde)', r)

  logOrig(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { errOrig('ERRO', e); process.exit(1) })
