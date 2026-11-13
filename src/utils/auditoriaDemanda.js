// CAIXA-PRETA dos pedidos (dono, 13/11/2026): toda mudança de status, status_aprovacao,
// match_usuario_id, match_feito_em, expira_em e cancelamento_pedido_* em reparos/obras, e de status
// nos interesses (interesse_reparos / candidaturas), vira UMA linha em eventos_demanda — gravada
// por TRIGGER do Postgres (AFTER UPDATE), então nada muda um pedido sem deixar rastro, venha de
// rota, job, migração, script ou SQL solto.
//
// Quem/de onde: o trigger lê current_setting('app.origem' | 'app.rota' | 'app.usuario_id', true);
// vazio → origem 'desconhecida' (SQL solto, console do Railway, script externo).
//   - origem 'rota': método + caminho da rota Express (req.route) e o usuário do token, via
//     AsyncLocalStorage (middlewareAuditoria, registrado em server.js depois do express.json);
//   - origem 'job': nome do job (comOrigem em server.js iniciarAgendador e em
//     alertaService.semSobreposicao); origem 'boot': a migração de boot.
// O helper é o pool instrumentado (instrumentarPool, em utils/supabase): todo UPDATE nessas quatro
// tabelas leva set_config(…, true) — local à transação — na MESMA transação do UPDATE: dentro de
// um BEGIN do código (logo depois do BEGIN) ou, fora dele, num BEGIN/COMMIT só daquele statement.
// Sem contexto (nem rota nem job) nada muda: o UPDATE roda como sempre e a origem fica 'desconhecida'.
//
// O trigger NUNCA derruba o UPDATE: falha ao gravar o evento vira WARNING e o pedido segue.
const { AsyncLocalStorage } = require('async_hooks')

const als = new AsyncLocalStorage()

// ctx: { origem: 'job'|'boot'|…, rota: nome, usuarioId? }. Devolve o que fn devolver (promise).
const comOrigem = (ctx, fn) => als.run(ctx, fn)
// Envolve uma função de job para rodar com { origem: 'job', rota: nome }.
const job = (nome, fn) => (...args) => comOrigem({ origem: 'job', rota: nome }, () => fn(...args))
// Express: guarda a req; rota e usuário são lidos na hora da query (req.route e req.usuario só
// existem depois do roteamento e do autenticar).
const middlewareAuditoria = (req, res, next) => als.run({ req }, next)

const contextoAtual = () => {
  const s = als.getStore()
  if (!s) return null
  if (s.req) {
    const req = s.req
    const caminho = req.route ? `${req.baseUrl || ''}${req.route.path}` : String(req.originalUrl || req.url || '').split('?')[0]
    return { origem: 'rota', rota: `${req.method} ${caminho}`, usuarioId: req.usuario?.id || null }
  }
  return s
}

const ALVO = /\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?(reparos|obras|interesse_reparos|candidaturas)\b/i
const INICIO_TX = /^\s*(BEGIN|START\s+TRANSACTION)\b/i
const FIM_TX = /^\s*(COMMIT|END|ROLLBACK)\b(?!\s+TO\b)/i
const SQL_SET = `SELECT set_config('app.origem', $1, true), set_config('app.rota', $2, true), set_config('app.usuario_id', $3, true)`
const paramsSet = (ctx) => [String(ctx.origem || ''), String(ctx.rota || '').slice(0, 300), ctx.usuarioId ? String(ctx.usuarioId) : '']
const simples = (texto, valores, cb) => typeof texto === 'string' && typeof valores !== 'function' && typeof cb !== 'function'

// Um statement fora de transação, dentro de BEGIN/SET/COMMIT próprios (q = query crua do cliente).
const emTransacaoPropria = async (q, ctx, texto, valores) => {
  await q('BEGIN')
  try {
    await q(SQL_SET, paramsSet(ctx))
    const r = await q(texto, valores)
    await q('COMMIT')
    return r
  } catch (err) {
    try { await q('ROLLBACK') } catch {}
    throw err
  }
}

const instrumentarCliente = (client) => {
  if (client.__auditoria) return client
  const q = client.query.bind(client)
  let emTx = false
  client.query = function (texto, valores, cb) {
    if (!simples(texto, valores, cb)) return q(...arguments)
    const ctx = contextoAtual()
    if (INICIO_TX.test(texto)) {
      return (async () => {
        const r = await q(texto, valores)
        emTx = true
        if (ctx) await q(SQL_SET, paramsSet(ctx))
        return r
      })()
    }
    if (FIM_TX.test(texto)) { emTx = false; return q(texto, valores) }
    if (!emTx && ctx && ALVO.test(texto)) return emTransacaoPropria(q, ctx, texto, valores)
    return q(texto, valores)
  }
  client.__auditoria = true
  return client
}

const instrumentarPool = (pool) => {
  if (pool.__auditoria) return pool
  const q0 = pool.query.bind(pool)
  const c0 = pool.connect.bind(pool)
  pool.query = function (texto, valores, cb) {
    if (!simples(texto, valores, cb) || !ALVO.test(texto)) return q0(...arguments)
    const ctx = contextoAtual()
    if (!ctx) return q0(texto, valores)
    return (async () => {
      const client = await c0()
      try {
        return await emTransacaoPropria((t, v) => client.query(t, v), ctx, texto, valores)
      } finally {
        client.release()
      }
    })()
  }
  pool.connect = function (cb) {
    if (typeof cb === 'function') return c0((err, client, done) => cb(err, client && instrumentarCliente(client), done))
    return c0().then(instrumentarCliente)
  }
  pool.__auditoria = true
  return pool
}

// ---------- banco ----------
const CAMPOS_DEMANDA = ['status', 'status_aprovacao', 'match_usuario_id', 'match_feito_em', 'expira_em',
  'cancelamento_pedido_por', 'cancelamento_pedido_motivo', 'cancelamento_pedido_detalhe', 'cancelamento_pedido_em', 'cancelamento_pedido_expira_em']
// interesse_reparos → reparos (reparo_id); candidaturas → obras (obra_id).
const INTERESSES = [{ tabela: 'interesse_reparos', demanda: 'reparos', fk: 'reparo_id' }, { tabela: 'candidaturas', demanda: 'obras', fk: 'obra_id' }]
// Nome versionado: mudar a lista de campos = trigger novo (o boot só cria o que falta).
const VERSAO = 'v1'

const corpoComum = `
    orig := COALESCE(NULLIF(current_setting('app.origem', true), ''), 'desconhecida');
    rt := NULLIF(current_setting('app.rota', true), '');
    BEGIN uid := NULLIF(current_setting('app.usuario_id', true), '')::uuid; EXCEPTION WHEN others THEN uid := NULL; END;
    o := to_jsonb(OLD); n := to_jsonb(NEW);`

const SQL_FUNCAO_DEMANDA = `
  CREATE OR REPLACE FUNCTION auditar_demanda() RETURNS trigger LANGUAGE plpgsql AS $fn$
  DECLARE o jsonb; n jsonb; c text; orig text; rt text; uid uuid;
  BEGIN
    BEGIN
      ${corpoComum}
      FOREACH c IN ARRAY ARRAY[${CAMPOS_DEMANDA.map(c => `'${c}'`).join(', ')}] LOOP
        IF (o -> c) IS DISTINCT FROM (n -> c) THEN
          INSERT INTO eventos_demanda (tabela, demanda_id, campo, valor_antes, valor_depois, origem, usuario_id, rota)
          VALUES (TG_TABLE_NAME, NEW.id, c, o ->> c, n ->> c, orig, uid, rt);
        END IF;
      END LOOP;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'auditar_demanda %: %', TG_TABLE_NAME, SQLERRM;
    END;
    RETURN NULL;
  END $fn$`

// TG_ARGV[0] = tabela da demanda, TG_ARGV[1] = coluna da FK. campo = 'interesse:<usuario_id>:status'.
const SQL_FUNCAO_INTERESSE = `
  CREATE OR REPLACE FUNCTION auditar_interesse() RETURNS trigger LANGUAGE plpgsql AS $fn$
  DECLARE o jsonb; n jsonb; orig text; rt text; uid uuid;
  BEGIN
    BEGIN
      ${corpoComum}
      INSERT INTO eventos_demanda (tabela, demanda_id, campo, valor_antes, valor_depois, origem, usuario_id, rota)
      VALUES (TG_ARGV[0], (n ->> TG_ARGV[1])::uuid, 'interesse:' || COALESCE(n ->> 'usuario_id', '?') || ':status',
              o ->> 'status', n ->> 'status', orig, uid, rt);
    EXCEPTION WHEN others THEN
      RAISE WARNING 'auditar_interesse %: %', TG_TABLE_NAME, SQLERRM;
    END;
    RETURN NULL;
  END $fn$`

const migrarEventosDemanda = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS eventos_demanda (
      id           BIGSERIAL PRIMARY KEY,
      tabela       TEXT NOT NULL CHECK (tabela IN ('reparos', 'obras')),
      demanda_id   UUID NOT NULL,
      campo        TEXT NOT NULL,
      valor_antes  TEXT,
      valor_depois TEXT,
      origem       TEXT NOT NULL DEFAULT 'desconhecida',
      usuario_id   UUID,
      rota         TEXT,
      criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  await client.query(`CREATE INDEX IF NOT EXISTS eventos_demanda_demanda_idx ON eventos_demanda (demanda_id, criado_em)`)
  await client.query(SQL_FUNCAO_DEMANDA)
  await client.query(SQL_FUNCAO_INTERESSE)
  const existe = async (nome, tabela) => (await client.query(
    `SELECT 1 FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass`, [nome, tabela])).rows.length > 0
  for (const tabela of ['reparos', 'obras']) {
    const nome = `auditar_${tabela}_${VERSAO}`
    if (await existe(nome, tabela)) continue
    const quando = CAMPOS_DEMANDA.map(c => `OLD.${c} IS DISTINCT FROM NEW.${c}`).join(' OR ')
    await client.query(`CREATE TRIGGER ${nome} AFTER UPDATE ON ${tabela} FOR EACH ROW WHEN (${quando}) EXECUTE PROCEDURE auditar_demanda()`)
  }
  for (const i of INTERESSES) {
    const nome = `auditar_${i.tabela}_${VERSAO}`
    if (await existe(nome, i.tabela)) continue
    await client.query(`CREATE TRIGGER ${nome} AFTER UPDATE ON ${i.tabela} FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE PROCEDURE auditar_interesse('${i.demanda}', '${i.fk}')`)
  }
}

module.exports = {
  comOrigem, job, middlewareAuditoria, contextoAtual, instrumentarPool, instrumentarCliente,
  migrarEventosDemanda, CAMPOS_DEMANDA,
}
