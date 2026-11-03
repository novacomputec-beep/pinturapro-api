const { pool } = require('./supabase')

// profissionais_avisados — campo de leitura do DONO nos detalhes GET /obras/:id e GET /reparos/:id:
// quantos profissionais DISTINTOS receberam o aviso de demanda nova ("Nova obra disponível!" /
// "Novo serviço disponível!"), por push OU por e-mail.
//
// Fontes (as duas tabelas de registro POR DESTINATÁRIO do aviso inicial — alertaService):
//   - push_entregas (tipo 'obra'/'reparo', resultado 'enviado'): uma linha por destinatário do
//     broadcast de demanda nova, PK (tipo, demanda, usuário). 'enviado' = ticket do Expo aceito
//     (o mesmo "status_ticket ok" de push_recibos). Repescagens (reenviarEntregasFalhas) só
//     reescrevem a MESMA linha, então um reenvio nunca conta duas vezes. Lembrete "ainda aberto",
//     oferta aumentada e reanúncio passam com entrega: null e NÃO entram aqui.
//   - email_alertas (tipo 'obra'/'reparo'): claim do e-mail de demanda nova, UNIQUE por
//     (tipo, demanda, usuário). Lembretes ('lembrete_%#n'), reanúncio ('reaberta_%') e avisos 1:1
//     ('aviso:%') têm tipos próprios e ficam de fora pelo filtro de tipo.
// push_recibos NÃO serve de fonte: grava data.tipo ('novo_reparo'/'nova_obra'), que é o MESMO do
// lembrete e da oferta aumentada, e é podada em 30 dias — contaria lembrete e perderia histórico.
//
// UNION (não UNION ALL) dedupe quem recebeu pelos dois canais. O criador fica fora por
// usuario_id (o broadcast já exclui a outra conta do mesmo CPF; aqui é só cinto e suspensório).
const TIPO_POR_TABELA = { obras: 'obra', reparos: 'reparo' }

const contarProfissionaisAvisados = async (tabela, demandaId, criadoPor, db = pool) => {
  const tipo = TIPO_POR_TABELA[tabela]
  if (!tipo) throw new Error(`contarProfissionaisAvisados: tabela inválida ${tabela}`)
  const r = await db.query(
    `SELECT count(*)::int AS n
       FROM (SELECT pe.usuario_id FROM push_entregas pe
              WHERE pe.tipo = $1 AND pe.demanda_id = $2::uuid AND pe.resultado = 'enviado'
             UNION
             SELECT ea.usuario_id FROM email_alertas ea
              WHERE ea.tipo = $1 AND ea.demanda_id = $2::uuid) x
      WHERE x.usuario_id IS DISTINCT FROM $3::uuid`,
    [tipo, demandaId, criadoPor || null]
  )
  return r.rows[0]?.n ?? 0
}

module.exports = { contarProfissionaisAvisados, TIPO_POR_TABELA }
