// Normaliza o telefone de cadastro para o formato do link wa.me: 55 + DDD + número (só dígitos).
// Usado pela lista "WhatsApp em 1 clique" do painel (GET /admin/whatsapp-lista). Função pura.
//
// status:
//   'ok'         celular de 11 dígitos nacionais (DDD + 9 + 8), com ou sem 55/máscara/0 de tronco
//   'corrigido'  celular antigo de 8 dígitos (começa 6–9): o 9 que faltava foi inserido
//   'fixo'       fixo de 8 dígitos (começa 2–5). telefone_wa vem preenchido: fixo pode ter
//                WhatsApp Business, o painel decide se usa
//   'incompleto' sem DDD, DDD inexistente, curto/longo demais ou celular de 11 sem o 9 → telefone_wa null
const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
])

const INCOMPLETO = { telefone_wa: null, status_numero: 'incompleto' }

const normalizarTelefoneWhatsapp = (telefone) => {
  let d = String(telefone ?? '').replace(/\D/g, '')
  // 12/13 dígitos começando em 55 = código do país (nacional tem no máximo 11; 11 dígitos
  // começando em 55 é DDD 55 do RS, não país).
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2)
  // 0 de tronco (034 9…) só quando sobra um número nacional de 10/11 dígitos.
  else if (d.startsWith('0') && (d.length === 11 || d.length === 12)) d = d.slice(1)
  if (d.length !== 10 && d.length !== 11) return INCOMPLETO
  const ddd = Number(d.slice(0, 2))
  if (!DDDS_VALIDOS.has(ddd)) return INCOMPLETO
  const local = d.slice(2)
  if (local.length === 9) {
    return local[0] === '9' ? { telefone_wa: `55${d}`, status_numero: 'ok' } : INCOMPLETO
  }
  if (/^[6-9]/.test(local)) return { telefone_wa: `55${d.slice(0, 2)}9${local}`, status_numero: 'corrigido' }
  if (/^[2-5]/.test(local)) return { telefone_wa: `55${d}`, status_numero: 'fixo' }
  return INCOMPLETO
}

// Primeiro nome para a saudação ("JOÃO pedro" → "João").
const primeiroNome = (nome) => {
  const p = String(nome ?? '').trim().split(/\s+/)[0] || ''
  return p ? p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1).toLocaleLowerCase('pt-BR') : ''
}

module.exports = { normalizarTelefoneWhatsapp, primeiroNome, DDDS_VALIDOS }
