// Robô de WhatsApp — Etapa 1 (dono, 17/11/2026). Constantes e funções puras, sem banco e sem rede.
//
// O robô roda num serviço SEPARADO da Railway (src/whatsapp/worker.js): a API só insere linhas em
// whatsapp_mensagens (services/whatsappFilaService) e quem envia é o worker. Redeploy da API não
// derruba a conexão do WhatsApp.
const TZ = 'America/Sao_Paulo'
// Janela de envio: 08:00 (inclusive) até 21:00 (exclusive), horário de São Paulo.
const HORA_INICIO = 8
const HORA_FIM = 21
// 1 mensagem a cada 20–40 s, sorteado a cada envio.
const INTERVALO_MIN_MS = 20000
const INTERVALO_MAX_MS = 40000
// Sem nada para enviar, o worker olha a fila de novo depois disto.
const ESPERA_FILA_VAZIA_MS = 5000
const MAX_TENTATIVAS = 3
const ESPERA_ENTRE_TENTATIVAS_MIN = 5
// Vários itens pendentes da mesma pessoa viram UMA mensagem (até este tanto por vez).
const MAX_ITENS_POR_MENSAGEM = 10

const STATUS = ['fila', 'enviada', 'entregue', 'lida', 'respondida', 'falha', 'sem_whatsapp', 'saiu']

// Tipos de mensagem, na ordem em que a aba do painel mostra (GET /admin/whatsapp/tipos devolve
// sempre estes slugs). Implementados: 'teste' (painel), 'pergunta_sem_resposta' (Etapa 2,
// services/whatsappPerguntasService) e 'novo_interessado' (19/11/2026,
// services/whatsappInteressadosService). Os demais já existem para o painel (implementado: false)
// e NÃO entram na fila (services/whatsappFilaService recusa). Cada tipo tem a chave liga/desliga
// em configuracoes; `padrao` vale enquanto a chave não existir.
//   limitePorPessoa: no máximo UMA mensagem desses tipos (somados) por pessoa a cada INTERVALO_PESSOA_HORAS.
//   dica: linha de ajuda que o painel mostra embaixo do rótulo (opcional).
const TIPOS = {
  pergunta_sem_resposta: { rotulo: 'Pergunta sem resposta', padrao: false, implementado: true, limitePorPessoa: true },
  novo_interessado: { rotulo: '🙋 Novo interessado', dica: 'Só para quem está sem notificação', padrao: false, implementado: true, limitePorPessoa: true },
  prazo_acabando: { rotulo: 'Prazo acabando', padrao: false, implementado: false },
  escolhido: { rotulo: 'Profissional escolhido', padrao: false, implementado: false },
  horario_aguardando: { rotulo: 'Horário aguardando resposta', padrao: false, implementado: false },
  teste: { rotulo: 'Mensagem de teste (painel)', padrao: true, implementado: true },
  // 'avulsa' (dono, 19/11/2026 — POST /admin/whatsapp/avulsa): mensagem escrita à mão pelo
  // super-admin para o dono de UM pedido. sempreLigado = fora do liga/desliga por tipo (não aparece
  // em /tipos); continua atrás da pausa global, da janela 08–21h e da trava de teste.
  // sozinho = cada linha é UMA mensagem, com o texto exatamente como foi escrito (nunca agrupada).
  avulsa: { rotulo: 'Mensagem avulsa (painel)', padrao: true, implementado: true, sempreLigado: true, sozinho: true },
}
const TIPO_AVULSA = 'avulsa'
const MAX_TEXTO_AVULSA = 1000
const DEDUPE_AVULSA_HORAS = 24            // o mesmo texto para a mesma pessoa não entra de novo antes disto
// Tipo INTERNO (fora do painel de tipos): a resposta automática do robô a quem escreveu
// ("✅ Pronto!…", "Não entendi…"). Sai na frente da fila e fora da janela 08–21h (a pessoa acabou
// de escrever), mas continua atrás da trava de teste, da pausa global e do intervalo de 20–40 s.
// Não enviada em RESPOSTA_VALIDADE_MIN minutos, é descartada (resposta atrasada confunde).
const TIPO_RESPOSTA = 'resposta'
const ROTULO_RESPOSTA = 'Resposta automática'
const RESPOSTA_VALIDADE_MIN = 15
// Etapa 2 — pergunta sem resposta.
const INTERVALO_PESSOA_HORAS = 3          // no máximo uma mensagem por pessoa a cada 3 h
const MAX_PERGUNTAS_POR_MENSAGEM = 5      // perguntas agrupadas numa mensagem (numeradas 1–5)
const ESPERA_PERGUNTA_MIN = 30            // minutos sem resposta do dono até avisar
const IDADE_MAXIMA_PERGUNTA_HORAS = 24    // pergunta mais velha que isso não gera aviso
// Novo interessado (dono SEM push): espera para juntar os interesses da pessoa numa mensagem só.
const ESPERA_INTERESSADO_MIN = 15
const IDADE_MAXIMA_INTERESSADO_HORAS = 24 // interesse mais velho que isso não gera aviso
const MAX_INTERESSADOS_POR_MENSAGEM = 50
const CHAVE_PAUSADO = 'whatsapp_pausado'
const chaveTipo = (tipo) => `whatsapp_tipo_${tipo}`

// Chave do pg_advisory_lock que garante UM worker conectado por vez (duas conexões com a mesma
// sessão derrubam uma à outra).
const CHAVE_LOCK = 734001

// Arquivos de que o worker depende — os "Watch Paths" do serviço na Railway. O teste
// scripts/testar-whatsapp-fila.js percorre os require() a partir de worker.js e falha se algum
// módulo importado ficar fora desta lista.
const WATCH_PATHS = [
  'src/whatsapp/**',
  'src/utils/supabase.js',
  'src/utils/auditoriaDemanda.js',
  'package.json',
  'package-lock.json',
]

// Telefone em E.164 do Brasil (+55DDDNÚMERO) ou null. Aceita com/sem +55, com máscara.
const normalizarTelefone = (bruto) => {
  let d = String(bruto ?? '').replace(/\D/g, '')
  if (!d) return null
  d = d.replace(/^0+/, '')
  if (d.length === 10 || d.length === 11) d = `55${d}`
  if (!/^55\d{10,11}$/.test(d)) return null
  return `+${d}`
}

// O WhatsApp identifica muitos números brasileiros SEM o nono dígito (e o cadastro tem com).
// Devolve as formas E.164 equivalentes de um número: com e sem o 9 depois do DDD.
const variantesTelefone = (e164) => {
  const t = normalizarTelefone(e164)
  if (!t) return []
  const d = t.slice(1)
  const saida = [t]
  if (d.length === 13 && d[4] === '9') saida.push(`+${d.slice(0, 4)}${d.slice(5)}`)
  if (d.length === 12) saida.push(`+${d.slice(0, 4)}9${d.slice(4)}`)
  return saida
}

// TRAVA DE TESTE (WHATSAPP_SOMENTE_PARA). O worker NÃO envia nada sem ela:
//   ausente / vazia / inválida → modo 'ausente' (nada sai);
//   'TODOS'                    → modo 'todos' (aberto a todos — tem de ser explícito);
//   um ou mais números (vírgula) → modo 'lista' (só esses números recebem).
const lerTrava = (env = process.env) => {
  const bruto = String(env.WHATSAPP_SOMENTE_PARA ?? '').trim()
  if (!bruto) return { modo: 'ausente', numeros: [], texto: '' }
  if (bruto.toUpperCase() === 'TODOS') return { modo: 'todos', numeros: [], texto: 'TODOS' }
  const partes = bruto.split(',').map(s => s.trim()).filter(Boolean)
  const numeros = partes.map(normalizarTelefone)
  if (numeros.length === 0 || numeros.some(n => !n)) return { modo: 'ausente', numeros: [], texto: bruto }
  return { modo: 'lista', numeros, texto: numeros.join(',') }
}
// Compara nas duas grafias (com e sem o nono dígito): a resposta automática vai para o número
// como o WhatsApp o informa, que costuma vir sem o 9.
const travaPermite = (trava, telefone) =>
  trava.modo === 'todos' || (trava.modo === 'lista' && variantesTelefone(telefone).some(t => trava.numeros.some(n => variantesTelefone(n).includes(t))))

const horaEmSaoPaulo = (data) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(data))
const dentroDaJanela = (data = new Date()) => {
  const h = horaEmSaoPaulo(data)
  return h >= HORA_INICIO && h < HORA_FIM
}

const intervaloMs = (sorteio = Math.random) =>
  Math.floor(INTERVALO_MIN_MS + sorteio() * (INTERVALO_MAX_MS - INTERVALO_MIN_MS + 1))

// "SAIR" (qualquer caixa, com acento/pontuação/espaços em volta) = pedido de saída.
const ehPedidoDeSaida = (texto) =>
  String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z]/g, '').toUpperCase() === 'SAIR'

module.exports = {
  TZ, HORA_INICIO, HORA_FIM, INTERVALO_MIN_MS, INTERVALO_MAX_MS, ESPERA_FILA_VAZIA_MS, MAX_TENTATIVAS,
  ESPERA_ENTRE_TENTATIVAS_MIN, MAX_ITENS_POR_MENSAGEM, STATUS, TIPOS, CHAVE_PAUSADO, chaveTipo, CHAVE_LOCK,
  TIPO_RESPOSTA, ROTULO_RESPOSTA, RESPOSTA_VALIDADE_MIN, TIPO_AVULSA, MAX_TEXTO_AVULSA, DEDUPE_AVULSA_HORAS, INTERVALO_PESSOA_HORAS, MAX_PERGUNTAS_POR_MENSAGEM,
  ESPERA_PERGUNTA_MIN, IDADE_MAXIMA_PERGUNTA_HORAS, ESPERA_INTERESSADO_MIN, IDADE_MAXIMA_INTERESSADO_HORAS, MAX_INTERESSADOS_POR_MENSAGEM,
  WATCH_PATHS, normalizarTelefone, variantesTelefone, lerTrava, travaPermite, dentroDaJanela, intervaloMs, ehPedidoDeSaida,
}
