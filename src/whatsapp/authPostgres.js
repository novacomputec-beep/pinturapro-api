// Estado de autenticação do Baileys guardado no POSTGRES (tabela whatsapp_auth), no lugar do
// useMultiFileAuthState da biblioteca: o disco do serviço na Railway é apagado a cada deploy, o
// banco não. Mesmo formato do original — uma linha por chave ('creds' e '<tipo>-<id>'), valor em
// JSON com BufferJSON (Buffers viram base64).
//
// `lib` = { BufferJSON, initAuthCreds, proto } vindos do Baileys (injetados: este arquivo não
// importa a biblioteca, e o teste roda a ida e volta sem conexão nenhuma).
const usarAuthPostgres = async (db, lib) => {
  const { BufferJSON, initAuthCreds, proto } = lib
  const ler = async (chaves) => {
    if (chaves.length === 0) return {}
    const r = await db.query(`SELECT chave, valor FROM whatsapp_auth WHERE chave = ANY($1::text[])`, [chaves])
    return Object.fromEntries(r.rows.map(l => [l.chave, JSON.parse(l.valor, BufferJSON.reviver)]))
  }
  const gravar = async (pares) => {
    if (pares.length === 0) return
    await db.query(
      `INSERT INTO whatsapp_auth (chave, valor)
       SELECT * FROM unnest($1::text[], $2::text[])
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`,
      [pares.map(p => p[0]), pares.map(p => JSON.stringify(p[1], BufferJSON.replacer))])
  }
  const apagarChaves = async (chaves) => {
    if (chaves.length === 0) return
    await db.query(`DELETE FROM whatsapp_auth WHERE chave = ANY($1::text[])`, [chaves])
  }

  const creds = (await ler(['creds'])).creds || initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          const achados = await ler(ids.map(id => `${tipo}-${id}`))
          const saida = {}
          for (const id of ids) {
            let valor = achados[`${tipo}-${id}`] ?? null
            if (tipo === 'app-state-sync-key' && valor) valor = proto.Message.AppStateSyncKeyData.fromObject(valor)
            saida[id] = valor
          }
          return saida
        },
        set: async (dados) => {
          const gravarPares = [], apagar = []
          for (const tipo of Object.keys(dados)) {
            for (const id of Object.keys(dados[tipo])) {
              const valor = dados[tipo][id]
              if (valor) gravarPares.push([`${tipo}-${id}`, valor]); else apagar.push(`${tipo}-${id}`)
            }
          }
          await gravar(gravarPares)
          await apagarChaves(apagar)
        },
      },
    },
    salvarCreds: () => gravar([['creds', creds]]),
    // Sessão encerrada (logout / "desconectar" do painel): apaga tudo → próximo início pede QR.
    apagarTudo: () => db.query(`DELETE FROM whatsapp_auth`),
  }
}

module.exports = { usarAuthPostgres }
