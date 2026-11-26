#!/usr/bin/env node
// Chamada DE VERDADE à camada 2 do anti-contato (services/contatoIAService) — conferência manual.
// Precisa da ANTHROPIC_API_KEY no ambiente (a chave nunca é impressa):
//   railway run -s pinturapro-api node scripts/chamar-contato-ia.js
//   railway run -s pinturapro-api node scripts/chamar-contato-ia.js "texto para testar"
// Sem argumento, usa exemplos que as REGRAS (camada 1) não pegam e um texto comum. Não toca o banco.
const path = require('path')
const REPO = path.join(__dirname, '..')
const IA = require(path.join(REPO, 'src/services/contatoIAService'))
// Só a camada 1 pura: o módulo de regras importa o cliente do banco, que aqui não é usado.
const { detectarContato } = require(path.join(REPO, 'src/utils/contatoNoTexto'))

const EXEMPLOS = [
  'Preciso pintar a sala. Me procura no face como Zé das Tintas de Patos que eu passo os detalhes',
  'Meu numero ao contrario: 2017 1889 9 43, liga depois das 18h',
  'Trocar duas torneiras e o sifão da pia da cozinha, tenho as peças',
]

const main = async () => {
  if (!IA.iaDisponivel()) { console.log('ANTHROPIC_API_KEY ausente: nada a chamar (a camada 2 fica desligada, fail-open).'); process.exit(2) }
  const textos = process.argv.slice(2).length ? process.argv.slice(2) : EXEMPLOS
  for (const t of textos) {
    const regras = detectarContato(t)
    const inicio = Date.now()
    const r = await IA.verificarContatoIA(t)
    console.log(JSON.stringify({ texto: t, camada1: regras ? regras.trecho : null, camada2: r ? r.trecho : null, ms: Date.now() - inicio }))
  }
  console.log('contadores', JSON.stringify(IA.lerContadores()))
  process.exit(0)
}
main().catch((e) => { console.error('ERRO', e?.name || 'erro', e?.status || ''); process.exit(1) })
