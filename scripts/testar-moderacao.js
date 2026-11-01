// Casos do filtro de contato (utils/moderacaoDemanda). Puro, sem banco:
//   node scripts/testar-moderacao.js
// Cada caso: texto → espera "[contato removido]" (true) ou texto intacto (false).
// Os casos de telefone partido passam [mensagens anteriores] + nova por mascararDigitosPartidos.
const { sanitizarTexto, mascararDigitosPartidos, MARCA_CONTATO } = require('../src/utils/moderacaoDemanda')

const casos = [
  // ── deve MASCARAR ──
  ['me chama no zap 34 99881-7102', true],
  ['(34)99881-7102', true],
  ['9.9.8.8.1.7.1.0.2', true],
  ['nove nove oito oito um sete um zero dois', true],
  ['34 nove nove 881 7102', true],
  ['whats 9881 7102', true],
  ['zap: 98817102', true],
  ['email joao.silva@gmail.com', true],
  ['meu insta @jo', true],
  ['insta @joão_pinta', true],
  ['fala comigo @a', true],
  ['site casa.xyz', true],
  ['t.me/joaopinta', true],
  ['meusite.online/orcamento', true],
  ['loja.com.br', true],
  ['pinturasjoao.pro', true],
  ['https://wa.me/5534998817102', true],
  ['me chama no direct', true],
  ['manda mensagem no whatsapp', true],
  // ── deve PASSAR (legítimo) ──
  ['Pintura de 3 quartos, 120 m², R$ 1.500,00', false],
  ['Orçamento de 150 reais o metro', false],
  ['Parede 3x4 metros, 2,5 m de altura', false],
  ['Entrega até 15/11/2026 às 14h30', false],
  ['CEP 38700-000, portão azul', false],
  ['Preciso de 12 portas e 20 janelas', false],
  ['Fim da obra.Preciso de nota fiscal', false],
  ['p.ex. 2 demãos', false],
  ['Tinta de 18 litros, 25 kg de massa', false],
  ['R$ 15.000.000 de valor venal', false],
  ['uns 10 m lineares de rodapé', false],
  ['nº 1234, apto 5', false],
  ['Preço 1.500 por 2 dias', false],
  ['dois quartos e uma sala', false],
]

// [anteriores], nova, espera
const partidos = [
  [['34 9988'], '1 7102 me liga', true],
  [['meu número começa com 34 99'], 'e termina com 881 7102', true],
  [['trinta e quatro nove nove'], 'oito oito um sete um zero dois', true],
  [['Pintura de 3 quartos, 120 m²', 'Pode ser 15/11?'], 'Sim, 20 dias e R$ 3.000', false],
  [['Tenho 12 portas'], 'e 20 janelas, 10 m de rodapé', false],
  [['Casa nº 1234'], 'apto 5, bloco 2', false],
  [[], '34 9988', false],
  [['R$ 4.500 à vista'], 'ou 10 x 450', false],
  [['Entrega 15/11 às 14h'], 'até 20/11 às 18:30', false],
]

let falhas = 0
const marca = (t) => t.includes(MARCA_CONTATO)
for (const [texto, espera] of casos) {
  const saida = sanitizarTexto(texto)
  const ok = marca(saida) === espera
  if (!ok) falhas++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${espera ? 'mascara' : 'passa  '} | ${JSON.stringify(texto)} → ${JSON.stringify(saida)}`)
}
console.log('── telefone partido ──')
for (const [anteriores, nova, espera] of partidos) {
  const r = mascararDigitosPartidos(anteriores, sanitizarTexto(nova))
  const ok = r.removido === espera
  if (!ok) falhas++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${espera ? 'mascara' : 'passa  '} | ${JSON.stringify(anteriores)} + ${JSON.stringify(nova)} → ${JSON.stringify(r.texto)}`)
}
console.log(`\n${casos.length + partidos.length} casos, ${falhas} falha(s)`)
process.exit(falhas ? 1 : 0)
