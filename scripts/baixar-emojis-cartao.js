#!/usr/bin/env node
// Baixa (uma vez, em desenvolvimento) os SVGs do Twemoji (CC-BY 4.0) de todo emoji que o cartão
// de compartilhamento (services/cartaoDemanda) pode desenhar: os das categorias (categoriasApp)
// e os fixos do cartão. Ficam em src/assets/cartao/emoji/<codepoints>.svg e vão no commit — o
// servidor NÃO busca nada na rede na hora de renderizar. Categoria nova com emoji novo: rodar
// de novo e commitar os arquivos que aparecerem.
//   node scripts/baixar-emojis-cartao.js
const fs = require('fs')
const path = require('path')
const { CATEGORIAS_SERVICO, CATEGORIAS_OBRA, CATEGORIAS_CONSTRUCAO } = require('../src/utils/categoriasApp')
const { EMOJIS_FIXOS, codigoTwemoji } = require('../src/services/cartaoDemanda')._interno

const DIR = path.join(__dirname, '..', 'src', 'assets', 'cartao', 'emoji')
const BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg'

const main = async () => {
  fs.mkdirSync(DIR, { recursive: true })
  const emojis = new Set([...CATEGORIAS_SERVICO, ...CATEGORIAS_OBRA, ...CATEGORIAS_CONSTRUCAO].map(c => c.emoji).concat(EMOJIS_FIXOS))
  let falhas = 0
  for (const e of emojis) {
    const codigo = codigoTwemoji(e)
    const destino = path.join(DIR, `${codigo}.svg`)
    if (fs.existsSync(destino)) continue
    const r = await fetch(`${BASE}/${codigo}.svg`)
    if (!r.ok) { falhas++; console.log(`FALHA ${e} ${codigo} (${r.status})`); continue }
    fs.writeFileSync(destino, await r.text())
    console.log(`ok ${e} ${codigo}`)
  }
  console.log(`${emojis.size} emojis, ${falhas} falha(s)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
