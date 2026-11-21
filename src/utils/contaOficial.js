// CONTA OFICIAL DO PROTUDO (dono, 21/11/2026). Uma conta de contratante (role 'dono_obra') marcada
// em usuarios.oficial publica pedidos em nome da plataforma:
//   - POST /admin/conta-oficial (super-admin) marca UMA conta — a anterior, se houver, é desmarcada;
//   - POST /admin/pedidos-oficiais (super-admin) cria um reparo NORMAL dela, pelo mesmo handler do
//     POST /reparos/dono (mesmas regras, avisos e teto de qualquer reparo);
//   - feed e detalhe devolvem dono_oficial: true nas demandas dela (sqlDonoOficial);
//   - só ela pode ter "ProTudo" no nome (cadastro e edição de perfil recusam os demais).
// Mora em utils/ pela convenção do repo (constante e SQL compartilhados; a migração roda no boot).
const { MARCA } = require('./marca')

const migrarContaOficial = async (client) => {
  await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS oficial BOOLEAN NOT NULL DEFAULT false`)
}

// Minúsculas, sem acento e só letras/números: "Pro-Tudo", "PRÓ TUDO" e "pro.tudo" são a marca.
const normalizarNome = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
const MARCA_NORMALIZADA = normalizarNome(MARCA)
const nomeUsaMarca = (nome) => typeof nome === 'string' && normalizarNome(nome).includes(MARCA_NORMALIZADA)
const ERRO_NOME_RESERVADO = { erro: `O nome "${MARCA}" é reservado à conta oficial. Use o seu nome.`, codigo: 'nome_reservado' }

// Expressão booleana (nunca NULL): a conta `coluna` (criado_por da demanda) é a oficial?
const sqlDonoOficial = (coluna) => `COALESCE((SELECT uo.oficial FROM usuarios uo WHERE uo.id = ${coluna}), false)`

// A conta marcada (contratante ativa), ou null. db: pool ou client.
const buscarContaOficial = async (db) => {
  const r = await db.query(
    `SELECT id, nome, email, role, tipo_dono, cidade, uf FROM usuarios
      WHERE oficial IS TRUE AND role = 'dono_obra' AND ativo IS NOT FALSE
      ORDER BY criado_em, id LIMIT 1`)
  return r.rows[0] || null
}

module.exports = { migrarContaOficial, normalizarNome, nomeUsaMarca, ERRO_NOME_RESERVADO, sqlDonoOficial, buscarContaOficial }
