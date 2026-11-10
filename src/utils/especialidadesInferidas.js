// ESPECIALIDADES INFERIDAS DAS OBRAS (dono, 10/11/2026). obras.categoria é o TIPO do imóvel
// (residencial/comercial/…), não um ofício: o aviso "Nova obra" só alcançava o público genérico de
// obras (pintor/construtor e reparador com especialidade de obra). "Instalação de ponto de água e
// esgoto" (YS5XR) nunca chegou a um encanador. Aqui o servidor deduz, do TÍTULO + DESCRIÇÃO, os
// slugs de serviço/obra relacionados e grava em obras.especialidades_inferidas (TEXT[]):
//   - aviso de obra nova (push + e-mail, alertaService): o público genérico CONTINUA o mesmo; quem
//     tem alguma especialidade na lista inferida é ACRESCENTADO (mesmo alcance por cidade/raio,
//     mesmo teto diário, mesmos filtros);
//   - feed GET /obras: quem não é do público genérico vê SÓ as obras cuja lista casa com as suas
//     especialidades (obrasController.listar); pode_obras (capacidadeObras) fica true enquanto houver
//     uma obra assim aberta, para o app mostrar a aba e deixar candidatar.
//
// REGRAS: cada regra tem termos (comparados sem acento/caixa, palavra inteira com plural opcional —
// "tomada" casa "tomadas", mas "agua" não casa "aguardo"; termo com * no fim é prefixo: "eletric*"
// casa "elétrica", "eletricista", "elétrico") e os slugs que entram quando algum termo aparece. A
// expansão é CURADA por regra (água/esgoto → hidraulica + alvenaria + pedreiro_servente; papel de
// parede → pintor + gesseiro), não o grupo inteiro de utils/gruposCategorias ("Reparos da casa"
// tem 9 ofícios — chaveiro e estofador não têm o que fazer num ponto de esgoto). Além delas, as
// `palavras` declaradas em CATEGORIAS_SERVICO (utils/categoriasApp) viram regra da própria
// categoria, menos as da lista TERMOS_GENERICOS ("manutenção" marcaria toda obra).
// Todo slug é validado no boot contra ESPECIALIDADES_REPARADOR_COM_OBRA.
const { CATEGORIAS_SERVICO } = require('./categoriasApp')
const { ESPECIALIDADES_REPARADOR_COM_OBRA } = require('./especialidades')
const { sqlProfissionalDaPessoa } = require('./tipoConta')

const TERMOS_GENERICOS = new Set(['manutencao', 'reforma geral', 'servico', 'conserto'])
const REGRAS_BASE = [
  { termos: ['agua', 'esgoto', 'cano', 'encanamento', 'encanador', 'hidraulic*', 'torneira', 'vazamento', 'caixa d', 'ralo', 'sifao', 'descarga', 'vaso sanitario', 'tubulacao', 'ponto de agua', 'bomba d', 'registro de agua', 'infiltracao'],
    slugs: ['hidraulica', 'alvenaria', 'pedreiro_servente'] },
  { termos: ['chuveiro'], slugs: ['hidraulica', 'eletrica'] },
  { termos: ['eletric*', 'tomada', 'disjuntor', 'fiacao', 'quadro de luz', 'quadro de distribuicao', 'ponto de luz', 'luminaria', 'interruptor', 'padrao de entrada', 'aterramento'],
    slugs: ['eletrica'] },
  { termos: ['camera', 'cftv', 'alarme', 'interfone', 'cerca eletrica', 'portao eletronico', 'portoes eletronicos', 'motor de portao'], slugs: ['seguranca_eletronica', 'eletrica'] },
  { termos: ['papel de parede'], slugs: ['pintor', 'gesseiro'] },
  { termos: ['pintura', 'pintar', 'tinta', 'textura', 'grafiato', 'massa corrida', 'verniz', 'repintura', 'pintor'], slugs: ['pintor'] },
  { termos: ['gesso', 'drywall', 'forro', 'sanca', 'gesseiro'], slugs: ['gesseiro'] },
  { termos: ['pedreiro', 'alvenaria', 'reboco', 'muro', 'laje', 'contrapiso', 'azulejo', 'revestimento', 'ceramica', 'porcelanato', 'rejunte', 'assentamento', 'demolicao', 'concreto', 'fundacao', 'calcada', 'piso', 'telhado', 'telha', 'calha', 'impermeabiliza*', 'reforma'],
    slugs: ['alvenaria', 'pedreiro_servente'] },
  { termos: ['marcenaria', 'marceneiro', 'armario', 'madeira', 'deck', 'rodape de madeira'], slugs: ['marcenaria'] },
  { termos: ['vidro', 'vidraca', 'box de vidro', 'espelho'], slugs: ['vidraceiro'] },
  { termos: ['serralheria', 'serralheiro', 'portao', 'portoes', 'grade', 'estrutura metalica', 'solda', 'corrimao'], slugs: ['serralheria'] },
  { termos: ['ar condicionado', 'ar-condicionado', 'split', 'climatiza*', 'refrigera*'], slugs: ['climatizacao'] },
  { termos: ['faxina', 'limpeza'], slugs: ['faxina'] },
  { termos: ['jardim', 'grama', 'poda', 'paisagismo'], slugs: ['jardineiro'] },
  { termos: ['fechadura', 'chaveiro'], slugs: ['chaveiro'] },
  { termos: ['montagem de moveis', 'montar moveis'], slugs: ['montagem_moveis'] },
  { termos: ['dedetiza*', 'cupim', 'cupins', 'descupiniza*'], slugs: ['dedetizacao'] },
  { termos: ['engenheiro', 'projeto estrutural', 'laudo'], slugs: ['engenheiro'] },
]
// Normalização igual à da cidade (utils/localidade): minúsculas, sem acento, espaços dobrados.
const normalizar = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()

const REGRAS = [
  ...REGRAS_BASE,
  ...CATEGORIAS_SERVICO.filter(c => Array.isArray(c.palavras) && c.palavras.length > 0)
    .map(c => ({ termos: c.palavras.map(normalizar).filter(t => t.length >= 4 && !TERMOS_GENERICOS.has(t)), slugs: [c.slug] })),
].map(r => ({ termos: r.termos.map(t => (t.endsWith('*') ? `${normalizar(t.slice(0, -1))}*` : normalizar(t))), slugs: r.slugs }))
for (const r of REGRAS) {
  for (const s of r.slugs) if (!ESPECIALIDADES_REPARADOR_COM_OBRA.includes(s)) throw new Error(`especialidadesInferidas: slug desconhecido "${s}"`)
}
const escapar = (t) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
// Termo com * no fim: prefixo (qualquer continuação). Sem *: palavra inteira, plural -s/-es opcional.
const padrao = (t) => (t.endsWith('*') ? escapar(t.slice(0, -1)) : `${escapar(t)}(s|es)?(?![a-z])`)
const REGEX = REGRAS.map(r => ({ re: new RegExp(`(^|[^a-z0-9])(${r.termos.map(padrao).join('|')})`), slugs: r.slugs }))

// Título + descrição → slugs únicos, na ordem do vocabulário (estável). Sem termo → [].
const inferirEspecialidades = ({ titulo, descricao } = {}) => {
  const texto = normalizar(`${titulo || ''} ${descricao || ''}`)
  if (!texto) return []
  const achados = new Set()
  for (const r of REGEX) if (r.re.test(texto)) r.slugs.forEach(s => achados.add(s))
  return ESPECIALIDADES_REPARADOR_COM_OBRA.filter(s => achados.has(s))
}

// Grava a lista na obra (criação, publicação, backfill). Nunca lança: a obra já existe.
const gravarEspecialidadesInferidas = async (db, obraId, obra) => {
  try {
    const slugs = inferirEspecialidades(obra)
    await db.query(`UPDATE obras SET especialidades_inferidas = $2::text[] WHERE id = $1`, [obraId, slugs])
    return slugs
  } catch (err) {
    console.error(`[Inferidas] obra ${obraId}:`, err.message)
    return null
  }
}

// Backfill: obras abertas (qualquer aprovação) ainda sem lista (NULL). Idempotente; devolve quantas.
const backfillEspecialidadesInferidas = async (db) => {
  const r = await db.query(`SELECT id, titulo, descricao FROM obras WHERE especialidades_inferidas IS NULL AND status = 'aberta'`)
  let n = 0
  for (const o of r.rows) { if (await gravarEspecialidadesInferidas(db, o.id, o)) n++ }
  return n
}

// Especialidades da PESSOA de `param` (todas as contas profissionais do CPF), como text[].
const sqlEspecialidadesDaPessoa = (param = '$1') => `(SELECT COALESCE(array_agg(DISTINCT e), '{}'::text[])
          FROM usuarios pes CROSS JOIN LATERAL unnest(COALESCE(pes.especialidades, '{}'::text[])) AS e
         WHERE ${sqlProfissionalDaPessoa('pes.id', param)})`
// Há obra ABERTA no feed cuja lista inferida casa com as especialidades da pessoa?
const sqlPessoaTemObrasInferidas = (param = '$1') => `EXISTS (
        SELECT 1 FROM obras oi
         WHERE oi.status = 'aberta' AND oi.status_aprovacao = 'aprovada' AND oi.expira_em > NOW()
           AND oi.match_usuario_id IS NULL
           AND oi.especialidades_inferidas && ${sqlEspecialidadesDaPessoa(param)})`

const migrarEspecialidadesInferidas = async (client) => {
  await client.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS especialidades_inferidas TEXT[]`)
  await client.query(`CREATE INDEX IF NOT EXISTS obras_especialidades_inferidas_idx ON obras USING GIN (especialidades_inferidas)`)
}

module.exports = {
  REGRAS, TERMOS_GENERICOS, normalizar, inferirEspecialidades, gravarEspecialidadesInferidas, backfillEspecialidadesInferidas,
  sqlEspecialidadesDaPessoa, sqlPessoaTemObrasInferidas, migrarEspecialidadesInferidas,
}
