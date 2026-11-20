// RESUMO DIÁRIO POR E-MAIL (decisão do dono, 19/11/2026) — atrás de configuracoes.email_resumo_diario
// (padrão 'false'; GET/POST /admin/email-resumo-diario).
//
// COM A CHAVE LIGADA, quem TEM push (token na própria conta ou em conta irmã da mesma pessoa —
// alertaService.contatoDaPessoa, a regra com que o push é entregue) deixa de receber um e-mail por
// evento do dia a dia: o aviso sai por push na hora e o e-mail vira UMA linha em email_resumo_itens.
// Às 19:00 de São Paulo cada pessoa recebe UM e-mail "Seu dia no ProTudo — dd/mm" com os itens
// agrupados por pedido; quem não tem itens não recebe nada; os itens enviados são apagados.
//
// CONTINUA IMEDIATO (nunca entra aqui):
//   - qualquer e-mail a quem NÃO tem push (inclusive o lembrete "a cada ciclo" do dono sem push
//     ativo e o aviso cujo push acabou de falhar);
//   - reanúncio / lembrete "ainda aberto" ao profissional sem push (enviarEmailsNovaDemanda);
//   - demanda NOVA a quem não tem push entregável (sem token, desinstalado ou push falho). Quem
//     RECEBEU o push de demanda nova não recebe e-mail na hora: com a chave ligada o pedido entra
//     aqui como uma linha (alertaService.guardarDemandaNovaNoResumo) — dono, 20/11/2026;
//   - contrato em PDF, redefinição de senha, link para assinar, fim do período gratuito, convite do
//     canal, conta excluída e pagamento recebido (não passam por entregarPushEEmail);
//   - conta aprovada / reprovada / suspensa / liberada (TIPOS_IMEDIATOS).
//
// O cron (server.js, 1 min) roda com a chave ligada OU desligada: desligar a chave só para de
// enfileirar — o que já estava na fila ainda sai às 19:00. Claim do dia em configuracoes
// ('email_resumo_diario_em'), como o resumo do admin: réplicas e restarts nunca mandam dois.
// Cada resumo enviado grava UMA linha em email_alertas ('resumo_diario#AAAAMMDD'), que conta no
// teto diário dos e-mails de demanda (orcamentoEmailsDeDemanda). Nunca lança.
const { pool } = require('../utils/supabase')
const { enviarEmail } = require('./brevoService')
const { MARCA } = require('../utils/marca')

const CHAVE_LIGADO = 'email_resumo_diario'
const CHAVE_ULTIMO_ENVIO = 'email_resumo_diario_em'
const HORA_ENVIO_SP = 19
const TZ = 'America/Sao_Paulo'
const URL_PEDIDO = (codigo) => `https://protudo.app.br/p/${codigo}`
const TEXTO_BOTAO = `Abrir o ${MARCA}`
// Conta aprovada / reprovada / suspensa / liberada: sempre na hora.
const TIPOS_IMEDIATOS = /^(verificacao_|conta_)/
const SEM_PEDIDO = 'Sua conta'
// Linha do resumo em email_alertas (conta no teto do dia): não pertence a uma demanda.
const DEMANDA_DO_RESUMO = '00000000-0000-0000-0000-000000000000'
// CHECK de email_alertas.tipo — a ÚNICA definição (a migração de boot em routes/index.js e os testes
// usam esta): demanda nova, lembrete por fatia / reanúncio, avisos 1:1 e a linha do resumo diário.
const CHECK_TIPO_EMAIL_ALERTAS = `tipo IN ('obra', 'reparo')
                                   OR tipo ~ '^(lembrete|reaberta)_(obra|reparo)(#[0-9]+)?$'
                                   OR tipo ~ '^aviso:[a-z_]+#([0-9a-f]{8}|[0-9]+)$'
                                   OR tipo ~ '^resumo_diario#[0-9]{8}$'`

// Erro de leitura (tabela ausente num teste de mini-esquema, banco fora) = desligado: vale o
// comportamento antigo, o e-mail sai na hora.
const resumoLigado = async (db = pool) => {
  try {
    const r = await db.query(`SELECT valor FROM configuracoes WHERE chave = $1`, [CHAVE_LIGADO])
    return r.rows[0]?.valor === 'true'
  } catch (err) { return false }
}

// A pessoa tem push? Token na conta ou numa conta irmã (contatoDaPessoa). require tardio:
// alertaService importa este arquivo.
const pessoaTemPush = async (usuarioId) => {
  try {
    const { contatoDaPessoa } = require('./alertaService')
    return !!(await contatoDaPessoa(usuarioId))?.push_token
  } catch (err) { return false }
}

// Decide se ESTE e-mail vai para o resumo e, se for, enfileira. Devolve true quando enfileirou
// (o chamador não envia o e-mail). temPush: true/false quando o chamador já sabe (push acabou de
// sair / acabou de falhar); undefined = consulta a pessoa.
const guardarParaOResumo = async ({ usuario_id, tipo, demanda_tabela = null, demanda_id = null, titulo, linha, temPush }) => {
  try {
    if (!usuario_id || TIPOS_IMEDIATOS.test(String(tipo || ''))) return false
    if (!(await resumoLigado())) return false
    if (temPush === false) return false
    if (temPush !== true && !(await pessoaTemPush(usuario_id))) return false
    await pool.query(
      `INSERT INTO email_resumo_itens (usuario_id, tipo, demanda_tabela, demanda_id, titulo, linha) VALUES ($1, $2, $3, $4, $5, $6)`,
      [usuario_id, String(tipo || '') || null, demanda_tabela, demanda_id, String(titulo || '').slice(0, 300), String(linha || '').slice(0, 2000)])
    return true
  } catch (err) {
    // Não conseguiu enfileirar: o e-mail sai na hora (nunca se perde um aviso).
    console.error('[ResumoDiario] não enfileirou, e-mail sai na hora:', err.message)
    return false
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
const ddmm = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`
const assuntoResumo = (dia) => `Seu dia no ${MARCA} — ${ddmm(dia)}`

// grupos: [{ titulo, codigo, itens: [{ hora, titulo, linha }] }] — um por pedido, na ordem do dia.
const htmlResumo = (nome, dia, grupos) => `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #E8833A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
      <h1 style="color: #0a0a0a; margin: 0;">${esc(MARCA)}</h1>
    </div>
    <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; color: #222;">
      ${String(nome || '').trim() ? `<h2 style="margin-top: 0;">Olá, ${esc(String(nome).trim().split(/\s+/)[0])}!</h2>` : ''}
      <p>Veja o que aconteceu hoje (${ddmm(dia)}):</p>
      ${grupos.map(g => `
      <div style="background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 0 0 8px; font-size: 16px;"><strong>${esc(g.titulo)}</strong></p>
        <ul style="margin: 0 0 12px; padding-left: 20px;">
          ${g.itens.map(i => `<li style="margin: 6px 0;"><span style="color: #888;">${esc(i.hora)}</span> · <strong>${esc(i.titulo)}</strong>${i.linha ? ` — ${esc(i.linha)}` : ''}</li>`).join('\n          ')}
        </ul>
        ${g.codigo ? `<a href="${esc(URL_PEDIDO(g.codigo))}" style="display: inline-block; background: #E8833A; color: #000; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: bold;">${esc(TEXTO_BOTAO)}</a>` : ''}
      </div>`).join('')}
      <p style="font-size: 12px; color: #888;">Você recebe os avisos na hora pela notificação do aplicativo; este e-mail é o resumo do dia.</p>
    </div>
  </div>`
const textoResumo = (nome, dia, grupos) => [
  `${String(nome || '').trim() ? `Olá, ${String(nome).trim().split(/\s+/)[0]}! ` : ''}Veja o que aconteceu hoje (${ddmm(dia)}):`,
  ...grupos.map(g => [g.titulo, ...g.itens.map(i => `• ${i.hora} · ${i.titulo}${i.linha ? ` — ${i.linha}` : ''}`), ...(g.codigo ? [`${TEXTO_BOTAO}: ${URL_PEDIDO(g.codigo)}`] : [])].join('\n')),
].join('\n\n')

// Claim atômico do dia (só com a hora SP ≥ 19): devolve a data SP 'AAAA-MM-DD' quando ESTE tique
// ganhou o envio, ou null.
const reivindicarEnvioDoDia = async (db = pool) => {
  const r = await db.query(
    `INSERT INTO configuracoes (chave, valor)
     SELECT $1, to_char(NOW() AT TIME ZONE '${TZ}', 'YYYY-MM-DD')
      WHERE EXTRACT(HOUR FROM (NOW() AT TIME ZONE '${TZ}')) >= ${HORA_ENVIO_SP}
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()
      WHERE configuracoes.valor IS DISTINCT FROM EXCLUDED.valor
     RETURNING valor`,
    [CHAVE_ULTIMO_ENVIO])
  return r.rows[0]?.valor || null
}

// Envia UM e-mail por pessoa com tudo o que está na fila e apaga o que saiu. Falha de envio
// deixa os itens da pessoa na fila (saem no resumo do dia seguinte). dia = 'AAAA-MM-DD' (SP).
const enviarResumosPendentes = async (dia, db = pool) => {
  const { contatoDaPessoa } = require('./alertaService')
  const itens = (await db.query(
    `SELECT i.id, i.usuario_id, i.tipo, i.demanda_tabela, i.demanda_id, i.titulo, i.linha,
            to_char(i.criado_em AT TIME ZONE '${TZ}', 'HH24:MI') AS hora,
            COALESCE(r.titulo, o.titulo) AS pedido_titulo, COALESCE(r.codigo_publico, o.codigo_publico) AS codigo
       FROM email_resumo_itens i
       LEFT JOIN reparos r ON i.demanda_tabela = 'reparos' AND r.id = i.demanda_id
       LEFT JOIN obras o ON i.demanda_tabela = 'obras' AND o.id = i.demanda_id
      ORDER BY i.criado_em, i.id`)).rows
  // Uma pessoa pode ter itens em mais de uma conta (irmãs): junta pelo e-mail de entrega.
  const contatos = new Map(), pessoas = new Map()
  for (const it of itens) {
    if (!contatos.has(it.usuario_id)) contatos.set(it.usuario_id, await contatoDaPessoa(it.usuario_id, db).catch(() => null))
    const c = contatos.get(it.usuario_id)
    const email = String(c?.email || '').trim().toLowerCase()
    const chave = email || `sem-email:${it.usuario_id}`
    if (!pessoas.has(chave)) pessoas.set(chave, { email, nome: c?.nome || '', usuario_id: it.usuario_id, itens: [] })
    pessoas.get(chave).itens.push(it)
  }
  let enviados = 0, falhas = 0, semEmail = 0
  for (const p of pessoas.values()) {
    const ids = p.itens.map(i => i.id)
    if (!p.email) {
      // Conta excluída ou sem e-mail: não há para onde mandar.
      await db.query(`DELETE FROM email_resumo_itens WHERE id = ANY($1::bigint[])`, [ids])
      semEmail++
      continue
    }
    const grupos = []
    for (const it of p.itens) {
      const chave = it.demanda_id ? `${it.demanda_tabela}:${it.demanda_id}` : ''
      let g = grupos.find(x => x.chave === chave)
      if (!g) grupos.push(g = { chave, titulo: it.demanda_id ? (it.pedido_titulo || 'Pedido') : SEM_PEDIDO, codigo: it.codigo || null, itens: [] })
      g.itens.push({ hora: it.hora, titulo: it.titulo, linha: it.linha })
    }
    try {
      await enviarEmail({ para: p.email, assunto: assuntoResumo(dia), html: htmlResumo(p.nome, dia, grupos), texto: textoResumo(p.nome, dia, grupos) })
      await db.query(`DELETE FROM email_resumo_itens WHERE id = ANY($1::bigint[])`, [ids])
      // Conta no teto diário de e-mails (não é 'aviso:%'). email_alertas.demanda_id é NOT NULL e o
      // resumo não é de UMA demanda: vai o UUID nulo (DEMANDA_DO_RESUMO), e o UNIQUE (tipo, demanda,
      // usuário) passa a valer "um resumo por conta por dia". O tipo é aceito pelo CHECK desde
      // 20/11/2026 (CHECK_TIPO_EMAIL_ALERTAS) — antes este INSERT falhava sempre (demanda_id NULL e
      // tipo fora do CHECK) e nenhum resumo contava no teto.
      await db.query(`INSERT INTO email_alertas (tipo, demanda_id, usuario_id) VALUES ($1, $2::uuid, $3)
                      ON CONFLICT (tipo, demanda_id, usuario_id) DO NOTHING`, [`resumo_diario#${dia.replace(/-/g, '')}`, DEMANDA_DO_RESUMO, p.usuario_id])
        .catch(err => console.error('[ResumoDiario] registro no teto:', err.message))
      enviados++
    } catch (err) {
      falhas++
      console.error(`[ResumoDiario] e-mail a ${p.usuario_id} falhou (itens ficam para amanhã):`, err.message)
    }
  }
  return { dia, pessoas: pessoas.size, itens: itens.length, enviados, falhas, sem_email: semEmail }
}

let rodando = false
const enviarResumoDiario = async () => {
  if (rodando) return null
  rodando = true
  try {
    const dia = await reivindicarEnvioDoDia()
    if (!dia) return null
    const r = await enviarResumosPendentes(dia)
    console.log(`[ResumoDiario] ${dia}: ${r.itens} item(ns) de ${r.pessoas} pessoa(s) → ${r.enviados} e-mail(s), ${r.falhas} falha(s), ${r.sem_email} sem e-mail`)
    return r
  } catch (err) {
    console.error('[ResumoDiario]', err.message)
    return null
  } finally { rodando = false }
}

module.exports = { DEMANDA_DO_RESUMO, CHECK_TIPO_EMAIL_ALERTAS, CHAVE_LIGADO, HORA_ENVIO_SP, resumoLigado, guardarParaOResumo, enviarResumoDiario, enviarResumosPendentes, assuntoResumo }
