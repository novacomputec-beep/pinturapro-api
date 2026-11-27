#!/usr/bin/env node
// Testa o cartão de compartilhamento (GET /p/:codigo/cartao.png), a legenda (GET /p/:codigo/legenda)
// e o ?c= (indicação) na página /p/:codigo — SQL real num Postgres em memória (PGlite), chamando
// os handlers da rota. O PNG é conferido pelo cabeçalho (assinatura + 1080x1350); o conteúdo do QR
// é conferido interceptando o qrcode.
//   NODE_PATH=<pglite>/node_modules node scripts/testar-cartao-demanda.js
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite')

let db
const shim = { query: (sql, params) => db.query(sql, params), connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }), on() {} }
const urlsQr = []
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  const mod = origLoad.apply(this, arguments)
  if (request === 'qrcode' && !mod.__espiao) {
    const orig = mod.toString
    mod.toString = (texto, opts) => { urlsQr.push(texto); return orig.call(mod, texto, opts) }
    mod.__espiao = true
  }
  return mod
}
const router = require(path.join(REPO, 'src/routes/paginaPublica'))
const cartao = require(path.join(REPO, 'src/services/cartaoDemanda'))
const { slugDoGrupoCartao, ehUrgente, cache, fotoDoGrupo } = cartao._interno

const handlerDe = (p) => router.stack.find(l => l.route && l.route.path === p).route.stack[0].handle
// O cartão é pedido já com a versão atual (?v=), como depois do redirect; v: null = sem versão.
const chamar = (p, codigo, { c, ua = 'Mozilla/5.0 (Linux; Android 14)', v = cartao.VERSAO_CARTAO } = {}) => new Promise(resolve => {
  const res = {
    statusCode: 200, cabecalhos: {}, tipo: null,
    status(s) { this.statusCode = s; return this }, set(k, v) { this.cabecalhos[k] = v; return this }, type(t) { this.tipo = t; return this },
    send(corpo) { resolve({ status: this.statusCode, corpo, cab: this.cabecalhos, tipo: this.tipo }) },
    redirect(s, local) { resolve({ status: s, local, cab: this.cabecalhos }) },
  }
  handlerDe(p)({ params: { codigo }, query: { ...(c === undefined ? {} : { c }), ...(p.endsWith('cartao.png') && v != null ? { v } : {}) }, protocol: 'https', get: (h) => (h === 'host' ? 'protudo.app.br' : ua) }, res)
})
let falhas = 0
const ok = (cond, rot, extra) => { if (!cond) falhas++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const main = async () => {
  db = new PGlite()
  const cols = `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), titulo text, categoria text, cidade text, uf text, bairro text, prazo_modo text,
      expira_em timestamptz, status text DEFAULT 'aberta', status_aprovacao text DEFAULT 'aprovada', match_usuario_id uuid, codigo_publico text,
      logradouro text, numero text, dono_id uuid`
  await db.exec(`
    CREATE TABLE usuarios (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text, telefone text, codigo_indicacao text, ativo boolean DEFAULT true);
    CREATE TABLE reparos (${cols}, categorias text[], valor_estimado numeric, prazo_atendimento_horas numeric);
    CREATE TABLE obras (${cols}, valor numeric, horas_para_expirar numeric);
    CREATE TABLE interesse_reparos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reparo_id uuid, usuario_id uuid, status text DEFAULT 'pendente');
    CREATE TABLE candidaturas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), obra_id uuid, usuario_id uuid, status text DEFAULT 'pendente');
    INSERT INTO usuarios (nome, telefone, codigo_indicacao) VALUES ('Joana Dona Secreta', '34999887766', NULL), ('Pro Indicador', '34911112222', 'XYZ234');
  `)
  await db.query(`INSERT INTO reparos (titulo, categoria, categorias, cidade, uf, bairro, valor_estimado, prazo_atendimento_horas, prazo_modo, expira_em, codigo_publico, status, logradouro, numero, dono_id)
    SELECT t.titulo, t.cat, ARRAY[t.cat], 'Patos de Minas', 'MG', t.bairro, t.valor, t.janela, t.modo, now() + t.falta::interval, t.cod, t.status, 'Rua Escondida', '123', u.id
      FROM (VALUES
        ('Trocar resistência do chuveiro', 'eletrica', 'Centro', 150::numeric, 24::numeric, NULL, '5 hours', 'URGEN', 'aberta'),
        ('Faxina completa', 'faxina', NULL, NULL, 168::numeric, NULL, '6 days', 'SEMBA', 'aberta'),
        ('Cancelado', 'eletrica', 'Centro', 90::numeric, 24::numeric, NULL, '20 hours', 'CANCD', 'cancelada')
      ) AS t(titulo, cat, bairro, valor, janela, modo, falta, cod, status), usuarios u WHERE u.nome = 'Joana Dona Secreta'`)
  await db.query(`INSERT INTO obras (titulo, categoria, cidade, uf, bairro, valor, horas_para_expirar, expira_em, codigo_publico)
    VALUES ('Pintura da casa toda', 'residencial', 'Patos de Minas', 'MG', 'Lagoa', 3000, 720, now() + INTERVAL '20 days', 'XBRAA')`)

  // ── Legenda ──
  let r = await chamar('/:codigo/legenda', 'URGEN', { c: 'xyz234' })
  const esperada = '👉 protudo.app.br/p/URGEN?c=XYZ234\n\n⚡ *Trocar resistência do chuveiro*\n📍 Centro · Patos de Minas · 💰 R$ 150 · ⏰ 1 dia\n\n' +
    'Toque no link, baixe o ProTudo grátis e mande sua proposta. Sem comissão!'
  ok(r.status === 200 && r.corpo === esperada, 'legenda: texto exato com ?c= (código normalizado para maiúsculo)', r.corpo)
  ok(/text\/plain/.test(r.tipo), 'legenda: text/plain')
  r = await chamar('/:codigo/legenda', 'SEMBA')
  ok(r.corpo.startsWith('👉 protudo.app.br/p/SEMBA\n\n🧹 *Faxina completa*\n📍 Patos de Minas · 💰 A combinar · ⏰ 1 semana'), 'legenda: sem ?c=, sem bairro, valor "A combinar"', r.corpo)
  r = await chamar('/:codigo/legenda', 'SEMBA', { c: 'lixo!' })
  ok(r.corpo.startsWith('👉 protudo.app.br/p/SEMBA\n'), 'legenda: ?c= inválido é ignorado')
  r = await chamar('/:codigo/legenda', 'XBRAA')
  ok(r.corpo.includes('🏠 *Pintura da casa toda*') && r.corpo.includes('R$ 3.000') && r.corpo.includes('⏰ 30 dias'), 'legenda: obra', r.corpo)
  r = await chamar('/:codigo/legenda', 'CANCD')
  ok(r.status === 404, 'legenda: pedido cancelado → 404')
  r = await chamar('/:codigo/legenda', 'ZZZZZ')
  ok(r.status === 404, 'legenda: código desconhecido → 404')
  const tudo = [await chamar('/:codigo/legenda', 'URGEN'), await chamar('/:codigo/legenda', 'SEMBA')].map(x => x.corpo).join('\n')
  ok(!/Joana|Secreta|34999887766|Rua Escondida|123/.test(tudo), 'legenda: nunca nome, telefone nem endereço do dono')

  // ── Grupo visual e urgência ──
  ok(slugDoGrupoCartao('reparos', { categorias: ['eletrica'] }) === 'eletrica-e-tecnologia', 'grupo: elétrica → eletrica-e-tecnologia')
  ok(slugDoGrupoCartao('reparos', { categoria: 'hidraulica' }) === 'consertos-da-casa', 'grupo: hidráulica → consertos-da-casa')
  ok(slugDoGrupoCartao('reparos', { categorias: ['baba'] }) === 'cuidar-de-alguem', 'grupo: babá → cuidar-de-alguem')
  ok(slugDoGrupoCartao('reparos', { categorias: ['telhados'] }) === 'obras-construcao-civil', 'grupo: telhados → obras-construcao-civil')
  ok(slugDoGrupoCartao('reparos', { categorias: ['contabilidade'] }) === 'escritorio-e-aulas', 'grupo: contabilidade → escritorio-e-aulas')
  ok(slugDoGrupoCartao('obras', { categoria: 'residencial' }) === 'obras-construcao-civil', 'grupo: obra → obras-construcao-civil')
  ok(slugDoGrupoCartao('reparos', { categorias: ['outros'] }) === 'outros' && slugDoGrupoCartao('reparos', {}) === 'outros', 'grupo: outros / sem categoria → outros')
  ok(slugDoGrupoCartao('reparos', { categorias: ['faxina'] }) === 'limpeza-e-jardim' && typeof fotoDoGrupo('limpeza-e-jardim') === 'string', 'grupo: faxina → limpeza-e-jardim (com foto)')
  ok(fotoDoGrupo('outros') === null, 'foto: Outros sem foto → degradê')
  ok(typeof fotoDoGrupo('beleza') === 'string', 'foto: beleza.jpg carregada')
  const agora = Date.now()
  ok(ehUrgente(new Date(agora + 12 * 3600e3), agora) && !ehUrgente(new Date(agora + 13 * 3600e3), agora), 'urgente: prazo ≤ 12h sim, 13h não')

  // ── Cartão PNG ──
  const dimensoes = (buf) => ({ png: buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) })
  let t = Date.now()
  r = await chamar('/:codigo/cartao.png', 'URGEN', { c: 'XYZ234' })
  const ms1 = Date.now() - t
  let d = dimensoes(r.corpo)
  ok(r.status === 200 && d.png && d.w === 1080 && d.h === 1350 && r.tipo === 'png', 'cartão: PNG 1080x1350', { ...d, ms: ms1, bytes: r.corpo.length })
  ok(r.cab['Cache-Control'] === 'public, max-age=600', 'cartão: Cache-Control 10 min')
  ok(urlsQr.at(-1) === 'https://protudo.app.br/p/URGEN?c=XYZ234', 'cartão: QR aponta para protudo.app.br/p/{codigo}?c={ref}', urlsQr.at(-1))
  const primeiro = r.corpo
  t = Date.now()
  r = await chamar('/:codigo/cartao.png', 'URGEN', { c: 'xyz234' })
  ok(r.corpo === primeiro && Date.now() - t < 50 && urlsQr.length === 1, 'cartão: segunda chamada vem do cache (mesmo buffer, sem render)')
  r = await chamar('/:codigo/cartao.png', 'URGEN', { c: 'ABCDEF' })
  ok(r.status === 200 && urlsQr.at(-1) === 'https://protudo.app.br/p/URGEN' && cache.has(`URGEN||${cartao.VERSAO_CARTAO}`) && !cache.has(`URGEN|ABCDEF|${cartao.VERSAO_CARTAO}`), 'cartão: ?c= com formato válido mas inexistente → sem indicação (não vira chave de cache)', urlsQr.at(-1))
  r = await chamar('/:codigo/cartao.png', 'SEMBA')
  d = dimensoes(r.corpo)
  ok(r.status === 200 && d.w === 1080 && d.h === 1350, 'cartão: grupo sem foto (degradê) também renderiza')
  r = await chamar('/:codigo/cartao.png', 'XBRAA')
  ok(r.status === 200 && dimensoes(r.corpo).w === 1080, 'cartão: obra')
  r = await chamar('/:codigo/cartao.png', 'CANCD')
  ok(r.status === 404 && !cache.has(`CANCD||${cartao.VERSAO_CARTAO}`), 'cartão: cancelado → 404 e não fica no cache')
  r = await chamar('/:codigo/cartao.png', 'URGEN', { c: 'xyz234', v: null })
  ok(r.status === 302 && r.local === `/p/URGEN/cartao.png?c=XYZ234&v=${cartao.VERSAO_CARTAO}` && r.cab['Cache-Control'] === 'no-cache', 'cartão: sem ?v= → 302 para a URL com a versão atual', r.local)
  r = await chamar('/:codigo/cartao.png', 'SEMBA', { v: 'velha12' })
  ok(r.status === 302 && r.local === `/p/SEMBA/cartao.png?v=${cartao.VERSAO_CARTAO}`, 'cartão: versão de outro deploy → 302 para a atual', r.local)
  r = await chamar('/:codigo/cartao.png', 'abc')
  ok(r.status === 404, 'cartão: código malformado → 404')

  // ── ?c= na página ──
  r = await chamar('/:codigo', 'URGEN', { c: 'xyz234' })
  ok(r.corpo.includes('referrer=c%3DXYZ234') && r.corpo.includes('Seu código de indicação: XYZ234 (use no cadastro)'), 'página: ?c= vai para a Play Store como referrer e aparece na página')
  r = await chamar('/:codigo', 'URGEN', { c: 'xyz234', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })
  ok(/class="btn" href="https:\/\/apps\.apple\.com/.test(r.corpo) && r.corpo.includes('Seu código de indicação: XYZ234'), 'página iPhone: botão na App Store + código para digitar')
  r = await chamar('/:codigo', 'URGEN', { c: '<script>' })
  ok(!r.corpo.includes('referrer=') && !r.corpo.includes('Seu código de indicação') && !r.corpo.includes('<script>'), 'página: ?c= inválido é ignorado')
  r = await chamar('/:codigo', 'CANCD', { c: 'XYZ234' })
  ok(r.corpo.includes('referrer=c%3DXYZ234'), 'página encerrada: a indicação vai junto também')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
