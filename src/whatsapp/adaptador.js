// CONTRATO do adaptador de envio. O worker (fila.js, entrada.js, worker.js) só fala com este
// contrato — nunca com o Baileys. Trocar pela Cloud API oficial = escrever outro arquivo que
// cumpra os mesmos métodos e trocar a linha do worker que cria o adaptador.
//
//   conectar()                      → inicia a conexão (e reconecta sozinho quando cair).
//   desconectar({ apagarSessao })   → fecha; com apagarSessao = true encerra a sessão (novo QR).
//   estado()                        → { conexao, qr, numero }
//                                     conexao: 'desligado' | 'conectando' | 'aguardando_qr' | 'conectado'
//                                     qr: texto do QR (só em 'aguardando_qr'); numero: +55… conectado.
//   existeNoWhatsapp(telefoneE164)  → { existe, jid } — jid é o DESTINO REAL devolvido pelo
//                                     WhatsApp (pode não ter o nono dígito); é para ele que se envia.
//   enviarTexto(jid, texto)         → { id } — id da mensagem no WhatsApp.
//   aoReceber(fn)                   → fn({ id, jid, telefone, texto, quando, citada, midia }) a cada
//                                     mensagem recebida. citada = id da mensagem que a pessoa citou
//                                     (ou null); midia = 'audio' | 'imagem' | … (null quando é texto).
//   aoAtualizarStatus(fn)           → fn({ id, status }) com status 'entregue' | 'lida'.
//   aoMudarEstado(fn)               → fn(estado()) a cada mudança de conexão/QR.
const METODOS = ['conectar', 'desconectar', 'estado', 'existeNoWhatsapp', 'enviarTexto', 'aoReceber', 'aoAtualizarStatus', 'aoMudarEstado']
const CONEXOES = ['desligado', 'conectando', 'aguardando_qr', 'conectado']

const validarAdaptador = (adaptador) => {
  const faltando = METODOS.filter(m => typeof adaptador?.[m] !== 'function')
  if (faltando.length) throw new Error(`adaptador de WhatsApp incompleto: falta ${faltando.join(', ')}`)
  return adaptador
}

module.exports = { METODOS, CONEXOES, validarAdaptador }
