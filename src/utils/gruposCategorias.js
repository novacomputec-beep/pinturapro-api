// Grupos de categorias RELACIONADAS do lado serviço (reparos) — o ÚNICO lugar do mapa.
//
// Uso: casamento categoria × especialidades dos avisos de reparo (alertaService: push de
// serviço novo, oferta aumentada, lembrete "ainda aberto" e o e-mail de reserva dos três).
// Com a chave configuracoes.grupos_relacionados_ativo = 'true' (semente de boot), um reparo
// de categoria X avisa quem tem X OU qualquer categoria do MESMO grupo de X em
// especialidades. Desligada ('false'), ou categoria fora de qualquer grupo, o casamento é
// o exato de sempre. 'outros' não entra em grupo nenhum: continua avisando todo mundo.
//
// Os slugs são os de CATEGORIAS_SERVICO (utils/categoriasApp, cópia verbatim do app);
// validarGrupos() confere na carga do módulo que cada slug existe e aparece em UM grupo só —
// um slug digitado errado derruba o boot em vez de silenciar um grupo inteiro.
// Lado obra: sem grupos (obras.categoria não passa por aqui).
const { pool } = require('./supabase')
const { CATEGORIAS_SERVICO } = require('./categoriasApp')

const CHAVE_GRUPOS_ATIVO = 'grupos_relacionados_ativo'

const GRUPOS_RELACIONADOS = {
  'Elétrica e tecnologia':        ['eletrica', 'eletronica', 'climatizacao'],
  'Reparos da casa':              ['alvenaria', 'hidraulica', 'marcenaria', 'montagem_moveis', 'estofamento'],
  'Limpeza e cuidados da casa':   ['faxina', 'dedetizacao', 'jardineiro'],
  'Beleza':                       ['cabelo', 'manicure', 'maquiagem', 'barbeiro', 'depilacao', 'massagem', 'podologo'],
  'Festas e eventos':             ['aluguel_festas', 'decoracao_festas', 'recreacao_infantil', 'dj', 'musico', 'garcom',
                                   'churrasqueiro', 'cozinheiro', 'confeiteiro', 'salgadeiro', 'filmagem_fotografia'],
  'Cuidado':                      ['baba', 'cuidador', 'pet'],
  'Transporte':                   ['motorista', 'motociclista', 'mudancas', 'mecanica', 'lavajato'],
  'Segurança':                    ['vigia', 'seguranca'],
  'Digital e aulas':              ['editor_video', 'social_midia', 'profissional_home_office', 'panfletagem',
                                   'aula_particular', 'personal_trainer'],
  'Arte e criação':               ['artesanato', 'costura', 'tatuagem'],
}

// slug → lista do seu grupo (ele incluído). Montado uma vez; slug sem grupo não está no mapa.
const GRUPO_DO_SLUG = {}
const validarGrupos = () => {
  const conhecidos = new Set(CATEGORIAS_SERVICO.map(c => c.slug))
  for (const [grupo, slugs] of Object.entries(GRUPOS_RELACIONADOS)) {
    for (const slug of slugs) {
      if (!conhecidos.has(slug)) throw new Error(`gruposCategorias: slug desconhecido "${slug}" no grupo "${grupo}"`)
      if (slug === 'outros') throw new Error(`gruposCategorias: "outros" não pode entrar em grupo ("${grupo}")`)
      if (GRUPO_DO_SLUG[slug]) throw new Error(`gruposCategorias: slug "${slug}" em dois grupos`)
      GRUPO_DO_SLUG[slug] = slugs
    }
  }
}
validarGrupos()

// Chave global, lida a cada uso e sem cache (como multiplas_contas). Semente 'true' no boot;
// qualquer valor que não seja 'false' conta como ligada, para a chave ausente não desligar.
const gruposRelacionadosAtivo = async (db = pool) => {
  const r = await db.query(`SELECT valor FROM configuracoes WHERE chave = $1`, [CHAVE_GRUPOS_ATIVO])
  return r.rows[0]?.valor !== 'false'
}

// Categoria da demanda → array de slugs a casar com especialidades (SEM repetição), ou null
// quando não há categoria (lado obra). Com a chave desligada ou slug fora de grupo: [slug].
const expandirCategoria = async (categoria, db = pool) => {
  if (categoria == null) return null
  const slug = String(categoria)
  const grupo = GRUPO_DO_SLUG[slug]
  if (!grupo || !(await gruposRelacionadosAtivo(db))) return [slug]
  return [...new Set([slug, ...grupo])]
}

module.exports = { GRUPOS_RELACIONADOS, CHAVE_GRUPOS_ATIVO, gruposRelacionadosAtivo, expandirCategoria }
