const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('ERRO: Variáveis SUPABASE_URL ou SUPABASE_SERVICE_KEY não definidas')
}

console.log('Supabase URL:', supabaseUrl)
console.log('Supabase Key inicio:', supabaseKey ? supabaseKey.substring(0, 20) : 'NULA')

const supabase = createClient(supabaseUrl, supabaseKey)

module.exports = supabase