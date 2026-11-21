// DICA DE FOTO (dono, 20/11/2026): quando um profissional pergunta num pedido SEM foto nem vídeo,
// o aviso ao dono (push/e-mail "Nova pergunta sobre seu pedido") ganha a dica de adicionar mídia.
// Vale para toda OBRA e para o REPARO que tenha ao menos uma categoria de CATEGORIAS_PEDE_FOTO —
// serviços em que a foto do problema muda o orçamento. Slugs REAIS de CATEGORIAS_SERVICO
// (utils/categoriasApp).
const { categoriasDoReparo } = require('./categoriasApp')

const CATEGORIAS_PEDE_FOTO = Object.freeze([
  'hidraulica', 'eletrica', 'alvenaria', 'marcenaria', 'montagem_moveis', 'estofamento', 'vidraceiro',
  'serralheria', 'gesseiro', 'climatizacao', 'eletronica', 'informatica', 'mecanica', 'jardineiro',
  'conserto_celular',
])
const DICA_FOTO = ' · Dica: adicione uma foto ou vídeo 📸'

// Tabela de mídias de cada lado (a FK tem o nome da chave do lado: obra_id / reparo_id).
const TABELA_MIDIAS = Object.freeze({ obras: 'midias', reparos: 'midias_reparos' })

// A demanda é do tipo em que foto ajuda? Obra: sempre. Reparo ({ categoria, categorias } ou array
// de slugs): alguma categoria da lista.
const pedeFoto = (tabela, categoriasOuReparo) => {
  if (tabela === 'obras') return true
  if (tabela !== 'reparos') return false
  const lista = Array.isArray(categoriasOuReparo) ? categoriasOuReparo : categoriasDoReparo(categoriasOuReparo)
  return lista.some(c => CATEGORIAS_PEDE_FOTO.includes(c))
}

// Sufixo do texto do aviso: a dica quando a demanda pede foto e não tem mídia; senão ''.
const dicaFoto = (tabela, categoriasOuReparo, semMidia) =>
  semMidia === true && pedeFoto(tabela, categoriasOuReparo) ? DICA_FOTO : ''

module.exports = { CATEGORIAS_PEDE_FOTO, DICA_FOTO, TABELA_MIDIAS, pedeFoto, dicaFoto }
