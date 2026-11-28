// PERGUNTAS-GUIA (GET /perguntas-guia) — ajudam o dono a escrever uma descrição melhor do pedido.
// Dado ESTÁTICO, para editar à mão: 2 ou 3 perguntas curtas (até ~45 caracteres) por grupo e por
// especialidade. Especialidade listada aqui SUBSTITUI as do seu grupo; as demais usam as do grupo.
// Chaves de grupo = CHAVE_DO_GRUPO (utils/gruposCategorias); chaves de especialidade = slugs de
// utils/categoriasApp. Nada de pedir telefone, WhatsApp, e-mail ou endereço: o contato só sai
// pelo app. scripts/testar-perguntas-guia.js confere chaves, tamanho e palavras de contato.

const GRUPOS = {
  reparos_casa: [
    'O que quebrou ou precisa ser feito?',
    'Desde quando está assim?',
    'Já tem o material ou peça?',
  ],
  limpeza: [
    'Qual o tamanho do local (cômodos ou m²)?',
    'É limpeza comum ou pesada?',
    'Com que frequência precisa?',
  ],
  beleza: [
    'Qual serviço você quer fazer?',
    'Em casa ou no local do profissional?',
    'Para que dia e horário?',
  ],
  festas: [
    'Qual o tipo de festa ou evento?',
    'Quantos convidados, mais ou menos?',
    'Qual a data e a duração?',
  ],
  cuidado: [
    'Quem vai receber o cuidado?',
    'Quais dias e horários?',
    'Precisa de algum cuidado especial?',
  ],
  transporte: [
    'O que precisa ser feito ou levado?',
    'Para qual cidade ou região?',
    'Para quando você precisa?',
  ],
  seguranca: [
    'Que tipo de local vai ser vigiado?',
    'Quais dias e horários?',
    'Por quanto tempo precisa?',
  ],
  digital_aulas: [
    'O que você precisa que seja feito?',
    'Presencial ou a distância?',
    'Qual o prazo para entregar?',
  ],
  arte: [
    'O que você quer que seja feito?',
    'Tem medidas ou referência de modelo?',
    'Para quando precisa?',
  ],
  divulgacao: [
    'O que você quer divulgar?',
    'Onde vai ser usado (rede, rua, rádio)?',
    'Qual o prazo para ficar pronto?',
  ],
  obras_construcao_civil: [
    'O que vai ser construído ou reformado?',
    'Qual o tamanho da área em m²?',
    'Já tem projeto ou material?',
  ],
}

const ESPECIALIDADES = {
  pintor: [
    'Quantos cômodos ou metros quadrados?',
    'Parede interna, externa ou as duas?',
    'Precisa raspar, massa corrida ou só pintar?',
  ],
  pedreiro_servente: [
    'O que precisa construir ou consertar?',
    'Qual o tamanho da área em m²?',
    'O material já está comprado?',
  ],
  hidraulica: [
    'É vazamento, entupimento ou instalação?',
    'Em qual cômodo é o problema?',
    'A água está vazando agora?',
  ],
  eletrica: [
    'É instalação nova ou conserto?',
    'O que parou de funcionar?',
    'Quantos pontos (tomadas, luzes)?',
  ],
  faxina: [
    'Quantos cômodos e banheiros?',
    'É faxina comum ou pós-obra?',
    'Precisa levar produtos de limpeza?',
  ],
  climatizacao: [
    'É instalação, limpeza ou conserto?',
    'Quantos aparelhos e de quantos BTUs?',
    'O aparelho já está no local?',
  ],
  marcenaria: [
    'Que móvel precisa fazer ou consertar?',
    'Tem as medidas do espaço?',
    'Qual material ou acabamento prefere?',
  ],
  montagem_moveis: [
    'Quais móveis precisam ser montados?',
    'Os móveis ainda estão na caixa?',
    'Precisa fixar algo na parede?',
  ],
  jardineiro: [
    'Qual o tamanho do jardim ou quintal?',
    'Corte de grama, poda ou plantio?',
    'Precisa retirar o lixo verde?',
  ],
  mudancas: [
    'Quais móveis e quantas caixas?',
    'Tem escada ou elevador nos dois lados?',
    'Precisa desmontar e montar móveis?',
  ],
  desentupimento: [
    'O que está entupido (pia, vaso, ralo)?',
    'Está transbordando agora?',
    'Já tentou desentupir antes?',
  ],
  telhados: [
    'É goteira, troca ou telhado novo?',
    'Qual o tipo de telha?',
    'Qual o tamanho do telhado em m²?',
  ],
  gesseiro: [
    'Forro, sanca, parede ou reparo?',
    'Qual o tamanho da área em m²?',
    'O gesso precisa de pintura depois?',
  ],
  serralheria: [
    'Portão, grade, janela ou conserto?',
    'Tem as medidas aproximadas?',
    'Precisa de pintura ou só a peça?',
  ],
  dedetizacao: [
    'Qual praga apareceu (barata, cupim…)?',
    'Qual o tamanho do local?',
    'Tem crianças ou animais no local?',
  ],
  eletrodomesticos: [
    'Qual aparelho e qual a marca?',
    'Qual o defeito que ele apresenta?',
    'O aparelho ainda está na garantia?',
  ],
}

const deepFreeze = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.freeze([...v])])))
const PERGUNTAS_GUIA = Object.freeze({ grupos: deepFreeze(GRUPOS), especialidades: deepFreeze(ESPECIALIDADES) })
const MAX_CARACTERES = 45

module.exports = { PERGUNTAS_GUIA, MAX_CARACTERES }
