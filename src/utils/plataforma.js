const { pool } = require('./supabase')

// Plataforma do aparelho ('android' | 'ios') deduzida da requisição, ou null quando não dá
// para afirmar. O app (React Native) não define User-Agent próprio nas chamadas à API, então
// chega o default do cliente HTTP nativo de cada sistema:
//   Android → OkHttp:       "okhttp/4.12.0"
//   iOS     → NSURLSession: "ProTudo/<build> CFNetwork/<versão> Darwin/<versão>"
// O header X-Platform (ou Platform) vence o User-Agent quando traz exatamente 'android' ou
// 'ios' — o app de hoje não o envia; fica aceito para uma versão futura.
// Navegador (painel admin, site) vem como "Mozilla/..." e cai em null DE PROPÓSITO, mesmo
// contendo "Android" ou "iPhone": é navegador, não o app.
const detectarPlataforma = (req) => {
  const header = String(req.get('x-platform') || req.get('platform') || '').trim().toLowerCase()
  if (header === 'android' || header === 'ios') return header
  const ua = req.get('user-agent') || ''
  if (/^okhttp\//i.test(ua)) return 'android'
  if (/\bCFNetwork\/\S+ Darwin\//.test(ua)) return 'ios'
  return null
}

// Grava usuarios.plataforma SÓ quando foi detectada: null/desconhecida nunca sobrescreve o
// valor já gravado. Não espera nem propaga erro — é telemetria, não pode atrasar nem
// derrubar login/cadastro/perfil. IS DISTINCT FROM evita reescrever a linha a cada GET.
const registrarPlataforma = (usuarioId, req) => {
  const plataforma = detectarPlataforma(req)
  if (!plataforma || !usuarioId) return
  pool.query(
    `UPDATE usuarios SET plataforma = $1 WHERE id = $2 AND plataforma IS DISTINCT FROM $1`,
    [plataforma, usuarioId]
  ).catch(err => console.error('Erro ao registrar plataforma:', err.message))
}

module.exports = { detectarPlataforma, registrarPlataforma }
