// Grupos de categorias RELACIONADAS do lado serviço (reparos) — o ÚNICO lugar do mapa.
//
// Uso: casamento categoria × especialidades dos avisos de reparo (alertaService: push de
// serviço novo, oferta aumentada, lembrete "ainda aberto" e o e-mail de reserva dos três).
// Com a chave configuracoes.grupos_relacionados_ativo = 'true' (semente de boot), um reparo
// de categoria X avisa quem tem X OU qualquer categoria do MESMO grupo de X em
// especialidades. Desligada ('false'), ou categoria fora de qualquer grupo, o casamento é
// o exato de sempre. 'outros' não entra em grupo nenhum: SOZINHO avisa todo mundo; junto de
// outra categoria é descartado (ver expandirCategoria).
//
// Os slugs são os de CATEGORIAS_SERVICO (utils/categoriasApp, cópia verbatim do app);
// validarGrupos() confere na carga do módulo que cada slug existe e aparece em UM grupo só —
// um slug digitado errado derruba o boot em vez de silenciar um grupo inteiro.
// Lado obra: sem grupos (obras.categoria não passa por aqui).
const { pool } = require('./supabase')
const { CATEGORIAS_SERVICO } = require('./categoriasApp')

const CHAVE_GRUPOS_ATIVO = 'grupos_relacionados_ativo'

// Reagrupamento (dono, 13/11/2026): "Elétrica e tecnologia" + "Reparos da casa" viram "Consertos da
// casa" (seguranca_eletronica, a única que sobrava em Elétrica e tecnologia, vai junto com a
// elétrica); "Limpeza e cuidados da casa" vira "Limpeza e jardim"; "Divulgação e publicidade" nasce
// com locucao/jingles_vinhetas/marketing_publicidade + social_midia, panfletagem, placas_fachadas e
// editor_video (que saem de Digital e aulas / Arte e criação). Nenhum slug renomeado.
const GRUPOS_RELACIONADOS = {
  'Consertos da casa':            ['eletrica', 'eletronica', 'climatizacao', 'hidraulica', 'alvenaria', 'gesseiro',
                                   'marcenaria', 'serralheria', 'vidraceiro', 'chaveiro', 'estofamento', 'montagem_moveis',
                                   'seguranca_eletronica'],
  'Limpeza e jardim':             ['faxina', 'dedetizacao', 'jardineiro'],
  'Beleza':                       ['cabelo', 'manicure', 'maquiagem', 'barbeiro', 'depilacao', 'massagem', 'podologo',
                                   'design_sobrancelhas'],
  'Festas e eventos':             ['aluguel_festas', 'decoracao_festas', 'recreacao_infantil', 'dj', 'musico', 'garcom',
                                   'churrasqueiro', 'cozinheiro', 'confeiteiro', 'salgadeiro', 'filmagem_fotografia'],
  'Cuidado':                      ['baba', 'cuidador', 'pet'],
  'Transporte':                   ['motorista', 'motociclista', 'mudancas', 'mecanica', 'lavajato', 'borracheiro'],
  'Segurança':                    ['vigia', 'seguranca'],
  'Digital e aulas':              ['profissional_home_office', 'aula_particular', 'personal_trainer', 'tradutor', 'informatica'],
  'Arte e criação':               ['artesanato', 'costura', 'tatuagem'],
  'Divulgação e publicidade':     ['locucao', 'jingles_vinhetas', 'marketing_publicidade', 'social_midia', 'panfletagem',
                                   'placas_fachadas', 'editor_video'],
}

// Chave curta e estável de cada grupo (API: /admin/crescimento-nichos, etiquetas de avaliação).
// Nome novo em GRUPOS_RELACIONADOS exige chave aqui — validarGrupos() derruba o boot sem ela.
const CHAVE_DO_GRUPO = {
// Consertos da casa e Limpeza e jardim herdam as chaves dos grupos que sucederam (reparos_casa,
// limpeza); eletrica_tec deixou de existir.
  'Consertos da casa': 'reparos_casa', 'Limpeza e jardim': 'limpeza',
  'Beleza': 'beleza', 'Festas e eventos': 'festas',
  'Cuidado': 'cuidado', 'Transporte': 'transporte', 'Segurança': 'seguranca',
  'Digital e aulas': 'digital_aulas', 'Arte e criação': 'arte', 'Divulgação e publicidade': 'divulgacao',
}

// slug → lista do seu grupo (ele incluído). Montado uma vez; slug sem grupo não está no mapa.
const GRUPO_DO_SLUG = {}
// slug → chave do grupo (CHAVE_DO_GRUPO). Mesmo preenchimento de validarGrupos().
const CHAVE_DO_SLUG = {}
const validarGrupos = () => {
  const conhecidos = new Set(CATEGORIAS_SERVICO.map(c => c.slug))
  for (const [grupo, slugs] of Object.entries(GRUPOS_RELACIONADOS)) {
    if (!CHAVE_DO_GRUPO[grupo]) throw new Error(`gruposCategorias: grupo "${grupo}" sem chave em CHAVE_DO_GRUPO`)
    for (const slug of slugs) {
      if (!conhecidos.has(slug)) throw new Error(`gruposCategorias: slug desconhecido "${slug}" no grupo "${grupo}"`)
      if (slug === 'outros') throw new Error(`gruposCategorias: "outros" não pode entrar em grupo ("${grupo}")`)
      if (GRUPO_DO_SLUG[slug]) throw new Error(`gruposCategorias: slug "${slug}" em dois grupos`)
      GRUPO_DO_SLUG[slug] = slugs
      CHAVE_DO_SLUG[slug] = CHAVE_DO_GRUPO[grupo]
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

// Categoria(s) da demanda → array de slugs a casar com especialidades (SEM repetição), ou null
// quando não há categoria (lado obra). Aceita um slug (reparo antigo) ou a lista `categorias`
// (até 3): a saída é a UNIÃO de cada slug com o seu grupo. Chave desligada ou slug fora de
// grupo: só os próprios slugs. A chave é lida UMA vez por chamada.
// 'outros' só vale SOZINHO (→ casa com quem marcou 'outros' em especialidades, via
// sqlCasaCategorias). Acompanhado de outra categoria é DESCARTADO: a lista passa a ser só
// as categorias escolhidas + seus grupos (decisão do dono, 28/10/2026). O público por CANAL
// (push × e-mail) é publicoDemanda, abaixo — o push com 'outros' vai a todos.
const expandirCategoria = async (categoria, db = pool) => {
  if (categoria == null) return null
  let slugs = (Array.isArray(categoria) ? categoria : [categoria]).filter(s => s != null).map(String)
  if (slugs.length === 0) return null
  const semOutros = slugs.filter(s => s !== 'outros')
  if (semOutros.length > 0) slugs = semOutros
  const ativo = await gruposRelacionadosAtivo(db)
  const saida = new Set()
  for (const slug of slugs) {
    saida.add(slug)
    const grupo = GRUPO_DO_SLUG[slug]
    if (ativo && grupo) grupo.forEach(s => saida.add(s))
  }
  return [...saida]
}

// Público de uma demanda por canal (decisão do dono, 01/11/2026): { push, email }, cada um uma
// lista de slugs para sqlCasaCategorias ou null (= sem filtro de especialidade).
//   - sem categoria (lado obra, reparo antigo sem nada): push e e-mail sem filtro;
//   - COM 'outros' entre as categorias: PUSH a TODO profissional elegível da cidade (null);
//     E-MAIL só aos grupos das outras categorias escolhidas (expandirCategoria descarta o
//     'outros') ou, 'outros' sozinho, só a quem marcou 'outros' em especialidades;
//   - sem 'outros': push e e-mail iguais, categorias + grupos (expandirCategoria).
// É a única porta dos públicos de demanda (demanda nova, rede de segurança, oferta aumentada,
// lembrete, reanúncio e os e-mails de cada um), então a regra não diverge entre caminhos.
const publicoDemanda = async (categoria, db = pool) => {
  const email = await expandirCategoria(categoria, db)
  if (email === null) return { push: null, email: null }
  const slugs = (Array.isArray(categoria) ? categoria : [categoria]).filter(s => s != null).map(String)
  const temOutros = slugs.includes('outros')
  return { push: temOutros ? null : email, email }
}

module.exports = { GRUPOS_RELACIONADOS, CHAVE_DO_GRUPO, CHAVE_DO_SLUG, CHAVE_GRUPOS_ATIVO, gruposRelacionadosAtivo, expandirCategoria, publicoDemanda }
