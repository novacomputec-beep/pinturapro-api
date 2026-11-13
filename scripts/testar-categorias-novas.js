#!/usr/bin/env node
// Testa as categorias de serviço informatica / gesseiro / placas_fachadas em todos os pontos que
// leem a lista: vocabulário de especialidades (validarEspecialidades, lado reparador × obra),
// apresentação (emoji/rótulo de push e contrato), grupos relacionados dos avisos (expandirCategoria
// e publicoDemanda com a chave ligada/desligada, num PGlite) e as chaves de grupo.
//   npm i -D @electric-sql/pglite && node scripts/testar-categorias-novas.js
const path = require('path')
const Module = require('module')
const REPO = path.join(__dirname, '..')
const { PGlite } = require('@electric-sql/pglite') // npm i -D @electric-sql/pglite (não vai para produção)

let db
const shim = { query: (sql, params) => db.query(sql, params), connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }), on() {} }
const origLoad = Module._load
Module._load = function (request) {
  if (/(^|[\\/])supabase$/.test(request)) return { pool: shim }
  return origLoad.apply(this, arguments)
}
let falhas = 0
const ok = (c, rot, extra) => { if (!c) falhas++; console.log(`${c ? 'OK  ' : 'FAIL'} ${rot}${extra !== undefined ? ' | ' + JSON.stringify(extra) : ''}`) }

const NOVAS = {
  informatica:     { rotulo: 'Informática',       emoji: '🖥️', grupo: 'Digital e aulas',       chave: 'digital_aulas', irmao: 'aula_particular' },
  gesseiro:        { rotulo: 'Gesseiro',          emoji: '🪜', grupo: 'Consertos da casa',     chave: 'reparos_casa', irmao: 'alvenaria' },
  placas_fachadas: { rotulo: 'Placas e fachadas', emoji: '🪧', grupo: 'Divulgação e publicidade', chave: 'divulgacao', irmao: 'panfletagem' },
  borracheiro:     { rotulo: 'Borracheiro',       emoji: '🚙', grupo: 'Transporte',            chave: 'transporte',   irmao: 'mecanica' },
  seguranca_eletronica: { rotulo: 'Segurança eletrônica', emoji: '📹', grupo: 'Consertos da casa', chave: 'reparos_casa', irmao: 'eletrica' },
  locucao:         { rotulo: 'Locução',           emoji: '🎙️', grupo: 'Divulgação e publicidade', chave: 'divulgacao', irmao: 'social_midia' },
  jingles_vinhetas: { rotulo: 'Jingles e vinhetas', emoji: '🎵', grupo: 'Divulgação e publicidade', chave: 'divulgacao', irmao: 'editor_video' },
  marketing_publicidade: { rotulo: 'Marketing e publicidade', emoji: '📈', grupo: 'Divulgação e publicidade', chave: 'divulgacao', irmao: 'panfletagem' },
}
// Reagrupamento aprovado (13/11/2026): os 10 grupos finais, slugs na ordem do mapa.
const GRUPOS_FINAIS = {
  'Consertos da casa': ['eletrica', 'eletronica', 'climatizacao', 'hidraulica', 'alvenaria', 'gesseiro', 'marcenaria', 'serralheria', 'vidraceiro', 'chaveiro', 'estofamento', 'montagem_moveis', 'seguranca_eletronica'],
  'Limpeza e jardim': ['faxina', 'dedetizacao', 'jardineiro'],
  'Beleza': ['cabelo', 'manicure', 'maquiagem', 'barbeiro', 'depilacao', 'massagem', 'podologo', 'design_sobrancelhas'],
  'Festas e eventos': ['aluguel_festas', 'decoracao_festas', 'recreacao_infantil', 'dj', 'musico', 'garcom', 'churrasqueiro', 'cozinheiro', 'confeiteiro', 'salgadeiro', 'filmagem_fotografia'],
  'Cuidado': ['baba', 'cuidador', 'pet'],
  'Transporte': ['motorista', 'motociclista', 'mudancas', 'mecanica', 'lavajato', 'borracheiro'],
  'Segurança': ['vigia', 'seguranca'],
  'Digital e aulas': ['profissional_home_office', 'aula_particular', 'personal_trainer', 'tradutor', 'informatica'],
  'Arte e criação': ['artesanato', 'costura', 'tatuagem'],
  'Divulgação e publicidade': ['locucao', 'jingles_vinhetas', 'marketing_publicidade', 'social_midia', 'panfletagem', 'placas_fachadas', 'editor_video'],
}

const main = async () => {
  db = new PGlite()
  await db.exec(`CREATE TABLE configuracoes (chave text, valor text); INSERT INTO configuracoes VALUES ('grupos_relacionados_ativo', 'true');`)
  const E = require(path.join(REPO, 'src/utils/especialidades'))
  const C = require(path.join(REPO, 'src/utils/categoriasApp'))
  const G = require(path.join(REPO, 'src/utils/gruposCategorias')) // validarGrupos() roda na carga: slug errado derrubaria aqui

  // ---- listas
  const slugsApp = C.CATEGORIAS_SERVICO.map(c => c.slug)
  ok(E.ESPECIALIDADES_REPARADOR.length === 62 && slugsApp.length === 62 && JSON.stringify(E.ESPECIALIDADES_REPARADOR) === JSON.stringify(slugsApp),
     'ESPECIALIDADES_REPARADOR e CATEGORIAS_SERVICO: 62 slugs, mesma ordem', { n: E.ESPECIALIDADES_REPARADOR.length })
  ok(E.ESPECIALIDADES_REPARADOR.slice(-5).join() === 'seguranca_eletronica,locucao,jingles_vinhetas,marketing_publicidade,outros', "as novas entram antes de 'outros', na ordem em que chegaram", E.ESPECIALIDADES_REPARADOR.slice(-5))
  ok(new Set(E.ESPECIALIDADES_REPARADOR).size === 62, 'nenhum slug repetido')
  ok(JSON.stringify(G.GRUPOS_RELACIONADOS) === JSON.stringify(GRUPOS_FINAIS), 'os 10 grupos finais, exatamente (nomes, ordem e slugs)', Object.keys(G.GRUPOS_RELACIONADOS))
  ok(E.ESPECIALIDADES_REPARADOR.filter(s => s !== 'outros').every(s => Object.values(G.GRUPOS_RELACIONADOS).flat().includes(s)), "toda especialidade de serviço (menos 'outros') está em um grupo")
  ok(JSON.stringify(G.CHAVE_DO_GRUPO) === JSON.stringify({ 'Consertos da casa': 'reparos_casa', 'Limpeza e jardim': 'limpeza', 'Beleza': 'beleza', 'Festas e eventos': 'festas', 'Cuidado': 'cuidado', 'Transporte': 'transporte', 'Segurança': 'seguranca', 'Digital e aulas': 'digital_aulas', 'Arte e criação': 'arte', 'Divulgação e publicidade': 'divulgacao' }),
     'chaves: Consertos herda reparos_casa, Limpeza e jardim herda limpeza, divulgacao nova, eletrica_tec some', G.CHAVE_DO_GRUPO)
  ok(!(await G.expandirCategoria('eletrica')).includes('informatica') && (await G.expandirCategoria('eletrica')).includes('hidraulica') && !(await G.expandirCategoria('faxina')).includes('eletrica'),
     'eletrica alcança hidráulica (Consertos), não informática nem faxina')
  ok(!(await G.expandirCategoria('editor_video')).includes('aula_particular') && (await G.expandirCategoria('editor_video')).includes('locucao'), 'editor_video saiu de Digital e aulas e foi para Divulgação')
  // Etiquetas de avaliação: os 10 grupos (+ obra) e, SÓ nas etiquetas, Elétrica e tecnologia separada de
  // Consertos (dono, 13/11/2026); Divulgação reusa o conjunto de Digital e aulas.
  const ET = require(path.join(REPO, 'src/utils/etiquetasAvaliacao'))
  ok(ET.GRUPOS_AVALIACAO.length === 12 && ET.GRUPOS_AVALIACAO.map(g => g.chave).join() === 'reparos_casa,eletrica_tec,limpeza,beleza,festas,cuidado,transporte,seguranca,digital_aulas,arte,divulgacao,construcao_pintura',
     'etiquetas: Consertos, Elétrica e tecnologia, os outros 9 de serviço + obra', ET.GRUPOS_AVALIACAO.map(g => `${g.chave}:${g.nome}`))
  const gEle = ET.GRUPOS_AVALIACAO.find(g => g.chave === 'eletrica_tec'), gCons = ET.GRUPOS_AVALIACAO.find(g => g.chave === 'reparos_casa')
  ok(gEle.nome === 'Elétrica e tecnologia' && gEle.especialidades.join() === 'eletrica,eletronica,climatizacao,seguranca_eletronica'
     && gCons.especialidades.join() === 'hidraulica,alvenaria,gesseiro,marcenaria,serralheria,vidraceiro,chaveiro,estofamento,montagem_moveis',
     'catálogo: elétrica/eletrônica/climatização/segurança eletrônica no grupo de etiquetas elétrico; Consertos com os outros 9', { ele: gEle.especialidades, cons: gCons.especialidades })
  ok(JSON.stringify(ET.ETIQUETAS_POR_GRUPO.eletrica_tec[5]) === '["Resolveu de vez","Serviço muito seguro","Super organizado"]' && JSON.stringify(ET.ETIQUETAS_POR_GRUPO.eletrica_tec[1]) === '["Não resolveu","Serviço perigoso","Estragou algo"]',
     'conjunto elétrico de antes restaurado ("Serviço muito seguro"…)')
  ok(JSON.stringify(ET.ETIQUETAS_POR_GRUPO.divulgacao) === JSON.stringify(ET.ETIQUETAS_POR_GRUPO.digital_aulas), 'etiquetas: Divulgação = conjunto de Digital e aulas')
  for (const s of ET.SLUGS_ELETRICOS) ok(JSON.stringify(ET.gruposDaDemanda('reparos', { categorias: [s] })) === '["eletrica_tec"]', `avaliação de ${s}: só o conjunto elétrico (não o de Consertos)`)
  ok(JSON.stringify(ET.gruposDaDemanda('reparos', { categoria: 'eletrica' })) === '["eletrica_tec"]', 'reparo antigo (só categoria) elétrico: conjunto elétrico')
  ok(JSON.stringify(ET.gruposDaDemanda('reparos', { categorias: ['hidraulica'] })) === '["reparos_casa"]' && JSON.stringify(ET.gruposDaDemanda('reparos', { categorias: ['gesseiro'] })) === '["reparos_casa"]',
     'outros Consertos (hidráulica, gesseiro): conjunto de Consertos')
  ok(JSON.stringify(ET.gruposDaDemanda('reparos', { categorias: ['eletrica', 'locucao'] })) === '["eletrica_tec","divulgacao"]', 'elétrica + locução: elétrico e Divulgação')
  ok(JSON.stringify(ET.gruposDaDemanda('reparos', { categorias: ['eletrica', 'hidraulica'] })) === '["reparos_casa","eletrica_tec"]', 'elétrica + hidráulica: os dois conjuntos (mesma regra do app)')
  ok(JSON.stringify(ET.gruposDaDemanda('obras', {})) === '["construcao_pintura"]' && ET.gruposDaDemanda('reparos', { categorias: ['outros'] }).length === 0, 'obra e "outros" inalterados')
  ok(ET.validarEtiquetas(['Serviço muito seguro'], ET.gruposDaDemanda('reparos', { categorias: ['eletrica'] }), 5).valor?.length === 1
     && !!ET.validarEtiquetas(['Serviço impecável'], ET.gruposDaDemanda('reparos', { categorias: ['eletrica'] }), 5).erro
     && ET.validarEtiquetas(['Serviço impecável'], ET.gruposDaDemanda('reparos', { categorias: ['hidraulica'] }), 5).valor?.length === 1
     && !!ET.validarEtiquetas(['Serviço muito seguro'], ET.gruposDaDemanda('reparos', { categorias: ['hidraulica'] }), 5).erro,
     'validação: elétrica aceita "Serviço muito seguro" e recusa "Serviço impecável"; hidráulica o contrário')
  // Push intocado: Consertos segue um grupo só e largo.
  ok((await G.expandirCategoria('eletrica')).includes('hidraulica') && (await G.expandirCategoria('hidraulica')).includes('eletrica') && !G.CHAVE_DO_GRUPO['Elétrica e tecnologia'],
     'push intocado: elétrica e hidráulica seguem no mesmo grupo (Consertos da casa)')
  const cat = ET.catalogoEtiquetas()
  ok(cat.grupos.find(g => g.chave === 'eletrica_tec')?.etiquetas?.[5]?.includes('Serviço muito seguro'), 'GET /config/etiquetas-avaliacao traz o grupo elétrico (o app aplica a mesma regra)')
  ok(!E.ESPECIALIDADES_OBRA.includes('borracheiro') && !C.CATEGORIAS_OBRA.some(c => c.slug === 'borracheiro') && !C.CATEGORIAS_CONSTRUCAO.some(c => c.slug === 'borracheiro'),
     'borracheiro é SERVIÇO: fora das especialidades e das categorias de obra')
  ok(!E.ESPECIALIDADES_OBRA.some(s => NOVAS[s]), 'lado obra intacto (4 papéis)', E.ESPECIALIDADES_OBRA)

  for (const [slug, n] of Object.entries(NOVAS)) {
    // ---- apresentação (push "novo serviço", contrato)
    const a = C.apresentacaoReparo(slug, '🛠️')
    ok(a.emoji === n.emoji && a.rotulo === n.rotulo, `${slug}: apresentacaoReparo → ${n.emoji} ${n.rotulo}`, a)
    ok(E.rotuloCategoria(slug, 'Serviço') === n.rotulo, `${slug}: rotuloCategoria (contrato)`)
    const lista = C.apresentacaoReparoLista({ categorias: [slug, 'faxina'] }, '🛠️')
    ok(lista.rotulo === `${n.rotulo} +1` && lista.emoji === n.emoji, `${slug}: apresentacaoReparoLista com +1`, lista)

    // ---- validação de especialidades (cadastro/perfil do reparador) e do lado obra
    const v = E.validarEspecialidades([slug, slug, 'faxina'], true, 'reparador')
    ok(!v.erro && JSON.stringify(v.valor) === JSON.stringify([slug, 'faxina']), `${slug}: válida para reparador (duplicata colapsada)`, v)
    // Fase 2b: a conta pintor também pode declarar serviços (capacidade simétrica); tipo NULL não muda.
    const vo = E.validarEspecialidades([slug, 'pintor'], true, 'pintor')
    ok(!vo.erro && vo.valor.length === 2, `${slug}: válida também para a conta pintor (Fase 2b)`, vo)

    // ---- grupos dos avisos
    ok(G.GRUPOS_RELACIONADOS[n.grupo].includes(slug) && G.CHAVE_DO_SLUG[slug] === n.chave, `${slug}: no grupo "${n.grupo}" (chave ${n.chave})`)
    ok(Object.values(G.GRUPOS_RELACIONADOS).filter(l => l.includes(slug)).length === 1, `${slug}: em exatamente 1 grupo`)
    const exp = await G.expandirCategoria(slug)
    ok(exp.includes(slug) && exp.includes(n.irmao) && exp.length === G.GRUPOS_RELACIONADOS[n.grupo].length,
       `${slug}: expandirCategoria (chave ligada) = o grupo inteiro`, exp)
    const inv = await G.expandirCategoria(n.irmao)
    ok(inv.includes(slug), `${n.irmao} (já existente) agora alcança ${slug}`)
    const pub = await G.publicoDemanda([slug, 'outros'])
    ok(pub.push === null && pub.email.includes(n.irmao) && !pub.email.includes('outros'), `${slug} + outros: push a todos, e-mail ao grupo`, pub)
  }
  // Chave desligada: só o próprio slug
  await db.query(`UPDATE configuracoes SET valor = 'false'`)
  ok(JSON.stringify(await G.expandirCategoria('gesseiro')) === '["gesseiro"]', 'chave desligada: expandirCategoria = só o slug')
  // POST /reparos: a validação de categorias usa ESPECIALIDADES_REPARADOR.includes — coberto pela lista
  ok(['informatica', 'gesseiro', 'placas_fachadas', 'borracheiro', 'locucao', 'jingles_vinhetas', 'marketing_publicidade'].every(s => E.ESPECIALIDADES_REPARADOR.includes(s)), 'categorias de reparo (POST/PUT /reparos) aceitam as novas')
  // Conta pintor com especialidade de serviço (Fase 2b) e o grupo de exibição de obras não mudam.
  const vp = E.validarEspecialidades(['pintor', 'borracheiro'], true, 'pintor')
  ok(!vp.erro && vp.valor.length === 2, 'pintor pode marcar borracheiro como especialidade de serviço', vp)
  ok(!E.GRUPO_OBRAS_REPARADOR.categorias.includes('borracheiro'), 'grupo "Obras de Construção Civil" intacto')

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`)
  process.exit(falhas ? 1 : 0)
}
main().catch(e => { console.error('ERRO', e); process.exit(1) })
