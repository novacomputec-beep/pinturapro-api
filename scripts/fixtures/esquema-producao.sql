-- ESQUEMA DE PRODUÇÃO (tabelas, colunas, tipos e DEFAULTs) — gerado do catálogo em 16/11/2026, somente leitura,
-- pelo túnel (scripts/db-tunnel.md). Sem chaves, índices, checks nem dados. Serve aos testes que rodam as
-- rotas REAIS num Postgres em memória: a consulta falha aqui se usar coluna que a produção não tem.
-- Regerar depois de migração nova: scripts/gerar-esquema-producao.js.

-- Funções que os DEFAULTs de produção chamam (versões mínimas para o teste).
CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()';
CREATE OR REPLACE FUNCTION gerar_codigo_publico() RETURNS text LANGUAGE sql AS $f$ SELECT string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 1 + floor(random() * 31)::int, 1), '') FROM generate_series(1, 5) $f$;

CREATE TABLE IF NOT EXISTS "aberturas_detalhe" (
  "reparador_id" uuid,
  "reparo_id" uuid,
  "aberto_em" timestamp with time zone DEFAULT now() NOT NULL,
  "notificado" boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS "assinaturas" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "usuario_id" uuid,
  "plano" text DEFAULT 'mensal'::text NOT NULL,
  "valor_mensal" numeric(10,2) DEFAULT 99.90 NOT NULL,
  "status" text DEFAULT 'ativa'::text NOT NULL,
  "inicio" timestamp with time zone DEFAULT now(),
  "proximo_vencimento" timestamp with time zone,
  "criado_em" timestamp with time zone DEFAULT now(),
  "tipo" text DEFAULT 'pago'::text,
  "atualizado_em" timestamp with time zone DEFAULT now(),
  "marco_1_em" timestamp with time zone,
  "marco_2_em" timestamp with time zone,
  "marco_3_em" timestamp with time zone,
  "aviso_fim_gratuidade_em" timestamp with time zone DEFAULT now(),
  "meses_bonus_aplicados" integer DEFAULT 0 NOT NULL,
  "dias_credito_aplicados" integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "avaliacoes" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "contrato_tipo" text,
  "contrato_id" uuid,
  "avaliador_id" uuid,
  "avaliado_id" uuid,
  "estrelas" integer,
  "criado_em" timestamp without time zone DEFAULT now(),
  "etiquetas" text[] DEFAULT '{}'::text[] NOT NULL
);

CREATE TABLE IF NOT EXISTS "avisos_acima_do_teto" (
  "tabela" text,
  "demanda_id" uuid,
  "usuario_id" uuid,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL,
  "resumo_em" timestamp with time zone,
  "lembrete" boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS "avisos_fora_area" (
  "tabela" text,
  "demanda_id" uuid,
  "usuario_id" uuid,
  "enviado_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "candidaturas" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "obra_id" uuid,
  "usuario_id" uuid,
  "status" text DEFAULT 'pendente'::text,
  "referencias" text,
  "observacoes_admin" text,
  "aprovado_por" uuid,
  "criado_em" timestamp with time zone DEFAULT now(),
  "atualizado_em" timestamp with time zone DEFAULT now(),
  "valor_oferta" numeric(10,2),
  "mensagem_oferta" text,
  "valor_contraproposta" numeric,
  "mensagem" text,
  "valor_proposto" numeric,
  "cancelado_por" uuid,
  "cancelado_motivo" text,
  "cancelado_detalhe" text,
  "cancelado_em" timestamp with time zone,
  "cancelado_acordo" boolean DEFAULT false NOT NULL,
  "status_antes_match" text
);

CREATE TABLE IF NOT EXISTS "configuracoes" (
  "chave" text,
  "valor" text,
  "atualizado_em" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "contas_excluidas" (
  "id" uuid,
  "nome" text,
  "cpf_hash" text,
  "role" text,
  "excluido_em" timestamp with time zone DEFAULT now() NOT NULL,
  "por" text
);

CREATE TABLE IF NOT EXISTS "contratos" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "candidatura_id" uuid,
  "status" text DEFAULT 'enviado'::text,
  "criado_em" timestamp with time zone DEFAULT now(),
  "atualizado_em" timestamp with time zone DEFAULT now(),
  "interesse_id" uuid,
  "valor_acordado" numeric
);

CREATE TABLE IF NOT EXISTS "convites_canal" (
  "email" text,
  "status" text,
  "enviado_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "denuncias" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "contrato_tipo" text,
  "contrato_id" uuid,
  "denunciante_id" uuid,
  "denunciado_id" uuid,
  "categoria" text,
  "descricao" text,
  "status" text DEFAULT 'aberta'::text NOT NULL,
  "criado_em" timestamp without time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "desinstalacoes" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "usuario_id" uuid,
  "detectado_em" timestamp with time zone DEFAULT now() NOT NULL,
  "plataforma" text,
  "token_prefix" text,
  "reinstalado_em" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "desistencias" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tabela" text,
  "demanda_id" uuid,
  "usuario_id" uuid,
  "nome_curto" text,
  "foto_url" text,
  "genero" text,
  "motivo" text,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "dicas" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "lado" text,
  "tema" text,
  "tema_icone" text,
  "tema_ordem" integer DEFAULT 0 NOT NULL,
  "ordem" integer DEFAULT 0 NOT NULL,
  "texto" text,
  "acao" text,
  "novo_ate" date,
  "ativo" boolean DEFAULT true NOT NULL,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "email_alertas" (
  "tipo" text,
  "demanda_id" uuid,
  "usuario_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "email_resumo_itens" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY,
  "usuario_id" uuid NOT NULL,
  "tipo" text,
  "demanda_tabela" text,
  "demanda_id" uuid,
  "titulo" text NOT NULL,
  "linha" text,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "eventos_demanda" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY,
  "tabela" text,
  "demanda_id" uuid,
  "campo" text,
  "valor_antes" text,
  "valor_depois" text,
  "origem" text DEFAULT 'desconhecida'::text NOT NULL,
  "usuario_id" uuid,
  "rota" text,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "eventos_responsabilidade" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tipo_evento" text,
  "usuario_id" uuid,
  "outro_usuario_id" uuid,
  "tabela" text,
  "demanda_id" uuid,
  "motivo" text,
  "bloqueio_ate" timestamp with time zone,
  "credito_dias" integer DEFAULT 0 NOT NULL,
  "credito_aplicado_em" timestamp with time zone,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "faltas_profissional" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "usuario_id" uuid,
  "tabela" text,
  "demanda_id" uuid,
  "criado_em" timestamp with time zone DEFAULT now(),
  "perdoada_em" timestamp with time zone,
  "perdoada_por" uuid,
  "motivo" text
);

CREATE TABLE IF NOT EXISTS "feed_visualizacoes" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "usuario_id" uuid,
  "item_tipo" text,
  "item_id" uuid,
  "notificado" boolean DEFAULT false,
  "criado_em" timestamp without time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "interesse_reparos" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "reparo_id" uuid,
  "usuario_id" uuid,
  "mensagem" text,
  "status" text DEFAULT 'pendente'::text,
  "criado_em" timestamp with time zone DEFAULT now(),
  "valor_proposto" numeric,
  "rodada" integer DEFAULT 1,
  "valor_contraproposta" numeric,
  "cancelado_por" uuid,
  "cancelado_motivo" text,
  "cancelado_detalhe" text,
  "cancelado_em" timestamp with time zone,
  "cancelado_acordo" boolean DEFAULT false NOT NULL,
  "status_antes_match" text
);

CREATE TABLE IF NOT EXISTS "lembretes_push_enviados" (
  "tabela" text,
  "demanda_id" uuid,
  "usuario_id" uuid,
  "motivo" text,
  "enviado_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "links_assinatura" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "usuario_id" uuid,
  "token_hash" text,
  "expira_em" timestamp with time zone,
  "usado_em" timestamp with time zone,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL,
  "order_id" text,
  "init_point" text,
  "plano" text
);

CREATE TABLE IF NOT EXISTS "localizacoes_prestadores" (
  "usuario_id" uuid,
  "latitude" double precision,
  "longitude" double precision,
  "atualizado_em" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "mensagens" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "obra_id" uuid,
  "autor_id" uuid,
  "conteudo" text,
  "resposta" text,
  "respondido" boolean DEFAULT false,
  "criado_em" timestamp with time zone DEFAULT now(),
  "respondido_por" uuid,
  "respondido_em" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "mensagens_prontas_enviadas" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tipo" text,
  "demanda_id" uuid,
  "remetente_id" uuid,
  "papel" text,
  "profissional_id" uuid,
  "fase" text,
  "frase_id" text,
  "texto" text,
  "enviado_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "midias" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "obra_id" uuid,
  "tipo" text,
  "url" text,
  "url_thumbnail" text,
  "ordem" integer DEFAULT 0,
  "criado_em" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "midias_orfas" (
  "url" text,
  "tipo" text,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "midias_reparos" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "reparo_id" uuid,
  "tipo" text DEFAULT 'foto'::text NOT NULL,
  "url" text,
  "ordem" integer DEFAULT 1,
  "criado_em" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "notificacoes_envios" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL,
  "tipo" text,
  "turmas" text[] DEFAULT '{}'::text[] NOT NULL,
  "titulo" text,
  "mensagem" text,
  "teste" boolean DEFAULT false NOT NULL,
  "total_destinatarios" integer DEFAULT 0 NOT NULL,
  "enviados" integer DEFAULT 0 NOT NULL,
  "falhas" integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "obras" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "criado_por" uuid,
  "titulo" text,
  "categoria" text,
  "valor" numeric(12,2),
  "cidade" text,
  "estado" text DEFAULT 'MG'::text,
  "bairro" text,
  "metragem" double precision,
  "prazo_execucao_dias" integer,
  "expira_em" timestamp with time zone,
  "descricao" text,
  "tags" text[],
  "status" text DEFAULT 'rascunho'::text,
  "criado_em" timestamp with time zone DEFAULT now(),
  "atualizado_em" timestamp with time zone DEFAULT now(),
  "latitude" double precision,
  "longitude" double precision,
  "enviada_por_dono" boolean DEFAULT false,
  "status_aprovacao" text DEFAULT 'aprovada'::text,
  "total_visitas" integer DEFAULT 0,
  "alerta_enviado_em" timestamp with time zone,
  "alerta_sem_interessados_em" timestamp with time zone,
  "uf" character varying(2),
  "match_feito_em" timestamp with time zone,
  "pedido_tempo_status" character varying(50),
  "pedido_tempo_minutos" integer,
  "match_usuario_id" uuid,
  "endereco_obra" text,
  "pedido_tempo_motivo" text,
  "client_request_id" text,
  "contrato_enviado" boolean DEFAULT false,
  "encerrado_em" timestamp with time zone,
  "cancelada_por" text,
  "motivo_cancelamento" text,
  "horas_para_expirar" numeric,
  "publicado_em" timestamp with time zone,
  "marco_6h_em" timestamp with time zone,
  "marco_60_em" timestamp with time zone,
  "marco_30_em" timestamp with time zone,
  "marco_15_em" timestamp with time zone,
  "notif_5min_enviada" boolean DEFAULT false,
  "marco_1_em" timestamp with time zone,
  "marco_2_em" timestamp with time zone,
  "marco_3_em" timestamp with time zone,
  "coordenadas_origem" text,
  "ponto_referencia" text,
  "encerramento_solicitado_por" uuid,
  "encerramento_solicitado_em" timestamp with time zone,
  "chegada_janela" text,
  "chegada_prevista_em" timestamp with time zone,
  "chegada_declarada_por" uuid,
  "chegada_declarada_em" timestamp with time zone,
  "chegada_confirmada_em" timestamp with time zone,
  "prestadores_bloqueados" uuid[],
  "chegada_pendente_janela" text,
  "chegada_pendente_em" timestamp with time zone,
  "chegada_recusada_em" timestamp with time zone,
  "aval_marco_1_em" timestamp with time zone,
  "aval_marco_2_em" timestamp with time zone,
  "aval_dispensada_em" timestamp with time zone,
  "ultima_extensao_em" timestamp with time zone,
  "ultima_extensao_horas" numeric,
  "prazo_modo" text,
  "prazo_timezone" text,
  "push_novo_enviado_em" timestamp with time zone,
  "push_aprovada_enviado_em" timestamp with time zone,
  "valor_aumentado_em" timestamp with time zone,
  "lembrete_enviado_em" timestamp with time zone,
  "lembretes_enviados" integer DEFAULT 0 NOT NULL,
  "codigo_publico" text DEFAULT gerar_codigo_publico(),
  "aviso_match_enviado_em" timestamp with time zone,
  "lembrete_chegada_enviado_em" timestamp with time zone,
  "chegada_proposta_por" uuid,
  "chegada_pendente_rodada" integer DEFAULT 0 NOT NULL,
  "lembrete_agenda_vespera_em" timestamp with time zone,
  "lembrete_agenda_2h_em" timestamp with time zone,
  "lembrete_agenda_hora_em" timestamp with time zone,
  "vigia_comparecimento_em" timestamp with time zone,
  "comparecimento_resposta" text,
  "comparecimento_respondido_em" timestamp with time zone,
  "a_caminho_em" timestamp with time zone,
  "lembrete_agendar_offsets" integer[] DEFAULT '{}'::integer[] NOT NULL,
  "chegada_proposta_em" timestamp with time zone,
  "lembrete_resposta_1h_em" timestamp with time zone,
  "lembrete_resposta_antes_em" timestamp with time zone,
  "sugestoes_horario_dono" integer DEFAULT 0 NOT NULL,
  "sugestoes_horario_profissional" integer DEFAULT 0 NOT NULL,
  "cancelamento_pedido_por" uuid,
  "cancelamento_pedido_motivo" text,
  "cancelamento_pedido_detalhe" text,
  "cancelamento_pedido_em" timestamp with time zone,
  "cancelamento_pedido_expira_em" timestamp with time zone,
  "prazo_chegada_extra_em" timestamp with time zone,
  "aviso_atraso_enviado_em" timestamp with time zone,
  "pedido_atraso_minutos" integer,
  "pedido_atraso_motivo" text,
  "pedido_atraso_em" timestamp with time zone,
  "pedido_atraso_status" character varying(20),
  "pedido_atraso_respondido_em" timestamp with time zone,
  "pedidos_atraso_usados" integer DEFAULT 0 NOT NULL,
  "lembrete_encerramento_30m_em" timestamp with time zone,
  "lembrete_encerramento_2h_em" timestamp with time zone,
  "lembrete_conclusao_em" timestamp with time zone,
  "lembrete_agendar_ultimo_em" timestamp with time zone,
  "lembrete_agendar_ciclo" integer DEFAULT 0 NOT NULL,
  "lembrete_agendar_dono_em" timestamp with time zone,
  "lembrete_resposta_ultimo_em" timestamp with time zone,
  "lembrete_resposta_ciclo" integer DEFAULT 0 NOT NULL,
  "escolha_lembrete_em" timestamp with time zone,
  "escolha_aviso_24h_em" timestamp with time zone,
  "escolha_aviso_2h_em" timestamp with time zone,
  "escolha_expirou_em" timestamp with time zone,
  "indicacao_enviada_em" timestamp with time zone,
  "lembrete_perguntas_ultimo_em" timestamp with time zone,
  "lembrete_perguntas_ciclo" integer DEFAULT 0 NOT NULL,
  "lembrete_agenda_dono_vespera_em" timestamp with time zone,
  "lembrete_agenda_dono_2h_em" timestamp with time zone,
  "lembrete_agendar_enviados" integer DEFAULT 0 NOT NULL,
  "desfazer_aviso_em" timestamp with time zone,
  "aviso_fora_area_em" timestamp with time zone,
  "email_novo_pendente_em" timestamp with time zone,
  "lembrete_agendar_sem_proposta" integer DEFAULT 0 NOT NULL,
  "horario_vencido_em" timestamp with time zone,
  "horarios_vencidos" integer DEFAULT 0 NOT NULL,
  "aviso_resposta_final_em" timestamp with time zone,
  "especialidades_inferidas" text[],
  "aviso_reabertura_em" timestamp with time zone,
  "reanuncio_pendente_em" timestamp with time zone,
  "aviso_desinstalou_em" timestamp with time zone,
  "valor_a_combinar" boolean DEFAULT false NOT NULL,
  "suspeita_anuncio" boolean DEFAULT false NOT NULL,
  "suspeita_anuncio_motivos" text[],
  "anuncio_em" timestamp with time zone,
  "anuncio_por" uuid
);

CREATE TABLE IF NOT EXISTS "pedidos_suporte" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "usuario_id" uuid,
  "whatsapp" text,
  "mensagem" text,
  "status" text DEFAULT 'aberto'::text NOT NULL,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL,
  "atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "perguntas_demanda" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tipo" text,
  "demanda_id" uuid,
  "autor_id" uuid,
  "pergunta" text,
  "resposta" text,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL,
  "respondido_em" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "prestadores_bloqueados_dono" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "dono_id" uuid,
  "prestador_id" uuid,
  "criado_em" timestamp without time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "proximidade_notificacoes" (
  "prestador_id" uuid,
  "demanda_tipo" text,
  "demanda_id" uuid,
  "notificado_em" timestamp with time zone DEFAULT now() NOT NULL,
  "envios" integer DEFAULT 1 NOT NULL
);

CREATE TABLE IF NOT EXISTS "push_entregas" (
  "tipo" text,
  "demanda_id" uuid,
  "usuario_id" uuid,
  "resultado" text,
  "tentativas" integer DEFAULT 1 NOT NULL,
  "primeira_tentativa_em" timestamp with time zone DEFAULT now() NOT NULL,
  "ultima_tentativa_em" timestamp with time zone DEFAULT now() NOT NULL,
  "resumo_em" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "push_recibos" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY,
  "usuario_id" uuid,
  "tipo" text,
  "demanda_id" uuid,
  "ticket_id" text,
  "enviado_em" timestamp with time zone DEFAULT now() NOT NULL,
  "status_ticket" text,
  "erro_ticket" text,
  "status_recibo" text,
  "erro_recibo" text,
  "recibo_em" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "reparos" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "criado_por" uuid,
  "titulo" text,
  "categoria" text,
  "descricao" text,
  "valor_estimado" numeric(10,2),
  "cidade" text,
  "bairro" text,
  "status" text DEFAULT 'rascunho'::text,
  "status_aprovacao" text DEFAULT 'pendente'::text,
  "expira_em" timestamp with time zone,
  "tags" text[] DEFAULT '{}'::text[],
  "criado_em" timestamp with time zone DEFAULT now(),
  "atualizado_em" timestamp with time zone DEFAULT now(),
  "total_visitas" integer DEFAULT 0,
  "alerta_enviado_em" timestamp with time zone,
  "prazo_atendimento_horas" integer,
  "match_feito_em" timestamp with time zone,
  "match_usuario_id" uuid,
  "prestadores_bloqueados" uuid[] DEFAULT '{}'::uuid[],
  "pedido_tempo_status" text,
  "pedido_tempo_motivo" text,
  "pedido_tempo_minutos" integer,
  "prazo_estimado_horas" integer,
  "latitude" double precision,
  "longitude" double precision,
  "endereco_obra" text,
  "alerta_sem_interessados_em" timestamp with time zone,
  "endereco_reparo" text,
  "uf" character varying(2),
  "client_request_id" text,
  "notif_5min_enviada" boolean DEFAULT false,
  "contrato_enviado" boolean DEFAULT false,
  "encerrado_em" timestamp with time zone,
  "cancelada_por" text,
  "motivo_cancelamento" text,
  "marco_6h_em" timestamp with time zone,
  "marco_60_em" timestamp with time zone,
  "marco_30_em" timestamp with time zone,
  "marco_15_em" timestamp with time zone,
  "marco_1_em" timestamp with time zone,
  "marco_2_em" timestamp with time zone,
  "marco_3_em" timestamp with time zone,
  "coordenadas_origem" text,
  "ponto_referencia" text,
  "encerramento_solicitado_por" uuid,
  "encerramento_solicitado_em" timestamp with time zone,
  "ultima_extensao_em" timestamp with time zone,
  "ultima_extensao_horas" numeric,
  "chegada_janela" text,
  "chegada_prevista_em" timestamp with time zone,
  "chegada_declarada_por" uuid,
  "chegada_declarada_em" timestamp with time zone,
  "chegada_confirmada_em" timestamp with time zone,
  "chegada_pendente_janela" text,
  "chegada_pendente_em" timestamp with time zone,
  "chegada_recusada_em" timestamp with time zone,
  "aval_marco_1_em" timestamp with time zone,
  "aval_marco_2_em" timestamp with time zone,
  "aval_dispensada_em" timestamp with time zone,
  "prazo_modo" text,
  "prazo_timezone" text,
  "push_novo_enviado_em" timestamp with time zone,
  "valor_aumentado_em" timestamp with time zone,
  "lembrete_enviado_em" timestamp with time zone,
  "lembretes_enviados" integer DEFAULT 0 NOT NULL,
  "codigo_publico" text DEFAULT gerar_codigo_publico(),
  "aviso_match_enviado_em" timestamp with time zone,
  "lembrete_chegada_enviado_em" timestamp with time zone,
  "chegada_proposta_por" uuid,
  "chegada_pendente_rodada" integer DEFAULT 0 NOT NULL,
  "lembrete_agenda_vespera_em" timestamp with time zone,
  "lembrete_agenda_2h_em" timestamp with time zone,
  "lembrete_agenda_hora_em" timestamp with time zone,
  "vigia_comparecimento_em" timestamp with time zone,
  "comparecimento_resposta" text,
  "comparecimento_respondido_em" timestamp with time zone,
  "a_caminho_em" timestamp with time zone,
  "lembrete_agendar_offsets" integer[] DEFAULT '{}'::integer[] NOT NULL,
  "chegada_proposta_em" timestamp with time zone,
  "lembrete_resposta_1h_em" timestamp with time zone,
  "lembrete_resposta_antes_em" timestamp with time zone,
  "sugestoes_horario_dono" integer DEFAULT 0 NOT NULL,
  "sugestoes_horario_profissional" integer DEFAULT 0 NOT NULL,
  "categorias" text[],
  "cancelamento_pedido_por" uuid,
  "cancelamento_pedido_motivo" text,
  "cancelamento_pedido_detalhe" text,
  "cancelamento_pedido_em" timestamp with time zone,
  "cancelamento_pedido_expira_em" timestamp with time zone,
  "prazo_chegada_extra_em" timestamp with time zone,
  "aviso_atraso_enviado_em" timestamp with time zone,
  "pedido_atraso_minutos" integer,
  "pedido_atraso_motivo" text,
  "pedido_atraso_em" timestamp with time zone,
  "pedido_atraso_status" character varying(20),
  "pedido_atraso_respondido_em" timestamp with time zone,
  "pedidos_atraso_usados" integer DEFAULT 0 NOT NULL,
  "lembrete_encerramento_30m_em" timestamp with time zone,
  "lembrete_encerramento_2h_em" timestamp with time zone,
  "lembrete_conclusao_em" timestamp with time zone,
  "lembrete_agendar_ultimo_em" timestamp with time zone,
  "lembrete_agendar_ciclo" integer DEFAULT 0 NOT NULL,
  "lembrete_agendar_dono_em" timestamp with time zone,
  "lembrete_resposta_ultimo_em" timestamp with time zone,
  "lembrete_resposta_ciclo" integer DEFAULT 0 NOT NULL,
  "escolha_lembrete_em" timestamp with time zone,
  "escolha_aviso_24h_em" timestamp with time zone,
  "escolha_aviso_2h_em" timestamp with time zone,
  "escolha_expirou_em" timestamp with time zone,
  "indicacao_enviada_em" timestamp with time zone,
  "lembrete_perguntas_ultimo_em" timestamp with time zone,
  "lembrete_perguntas_ciclo" integer DEFAULT 0 NOT NULL,
  "lembrete_agenda_dono_vespera_em" timestamp with time zone,
  "lembrete_agenda_dono_2h_em" timestamp with time zone,
  "lembrete_agendar_enviados" integer DEFAULT 0 NOT NULL,
  "desfazer_aviso_em" timestamp with time zone,
  "aviso_fora_area_em" timestamp with time zone,
  "email_novo_pendente_em" timestamp with time zone,
  "lembrete_agendar_sem_proposta" integer DEFAULT 0 NOT NULL,
  "horario_vencido_em" timestamp with time zone,
  "horarios_vencidos" integer DEFAULT 0 NOT NULL,
  "aviso_resposta_final_em" timestamp with time zone,
  "aviso_reabertura_em" timestamp with time zone,
  "reanuncio_pendente_em" timestamp with time zone,
  "aviso_desinstalou_em" timestamp with time zone,
  "local_atendimento" text,
  "valor_a_combinar" boolean DEFAULT false NOT NULL,
  "suspeita_anuncio" boolean DEFAULT false NOT NULL,
  "suspeita_anuncio_motivos" text[],
  "anuncio_em" timestamp with time zone,
  "anuncio_por" uuid
);

CREATE TABLE IF NOT EXISTS "respostas_equipe" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "usuario_id" uuid,
  "origem" text,
  "origem_id" uuid,
  "pergunta" text,
  "resposta" text,
  "acao" text,
  "lida_em" timestamp with time zone,
  "criada_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "sugestoes" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "usuario_id" uuid,
  "texto" text,
  "criado_em" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "tentativas_auth" (
  "acao" text,
  "identificador" text,
  "tentativas" integer DEFAULT 0 NOT NULL,
  "janela_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tentativas_contato" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY,
  "usuario_id" uuid,
  "tipo" text,
  "demanda_id" uuid,
  "campo" text,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL,
  "conta" boolean DEFAULT true NOT NULL
);

CREATE TABLE IF NOT EXISTS "usuarios" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "nome" text,
  "email" text,
  "telefone" text,
  "senha_hash" text,
  "cidade" text,
  "estado" text DEFAULT 'MG'::text,
  "especialidades" text[],
  "anos_experiencia" integer DEFAULT 0,
  "tamanho_equipe" integer DEFAULT 1,
  "cpf_cnpj" text,
  "role" text DEFAULT 'assinante'::text,
  "ativo" boolean DEFAULT true,
  "avatar_url" text,
  "criado_em" timestamp with time zone DEFAULT now(),
  "atualizado_em" timestamp with time zone DEFAULT now(),
  "push_token" text,
  "categorias_servico" text[] DEFAULT '{}'::text[],
  "reset_token" text,
  "reset_token_expira" timestamp with time zone,
  "foto_url" text,
  "pix_reembolso" text,
  "verificacao_status" text DEFAULT 'nao_solicitada'::text,
  "verificacao_doc_frente_url" text,
  "verificacao_doc_verso_url" text,
  "verificacao_selfie_url" text,
  "referencias" jsonb DEFAULT '[]'::jsonb,
  "tipo_dono" text,
  "uf" character varying(2),
  "plano" character varying(20) DEFAULT 'mensal'::character varying,
  "rg" character varying(20),
  "rg_orgao" character varying(20),
  "rg_estado" character varying(2),
  "dois_fa_secret" character varying(100),
  "dois_fa_ativo" boolean DEFAULT false,
  "tipo_prestador" character varying(20),
  "aprovado_automaticamente" boolean,
  "cep" character varying(8),
  "latitude" numeric,
  "longitude" numeric,
  "logradouro" character varying(200),
  "numero" character varying(20),
  "complemento" character varying(100),
  "bairro" character varying(100),
  "boas_vindas_exibida" boolean DEFAULT false,
  "acordo_etico_aceito_em" timestamp with time zone,
  "push_status" character varying(50) DEFAULT 'desconhecido'::character varying,
  "push_status_em" timestamp with time zone,
  "suspenso_em" timestamp with time zone,
  "suspenso_motivo" text,
  "token_version" integer DEFAULT 1 NOT NULL,
  "aviso_aprovacao_em" timestamp with time zone DEFAULT now(),
  "push_plataforma" text,
  "aceita_promocoes" boolean DEFAULT true NOT NULL,
  "verificacao_enviada_em" timestamp with time zone,
  "plataforma" text,
  "plataforma_em" timestamp with time zone,
  "codigo_indicacao" text,
  "indicado_por" uuid,
  "meses_bonus_indicacao" integer DEFAULT 0 NOT NULL,
  "embaixador" boolean DEFAULT false NOT NULL,
  "oficial" boolean DEFAULT false NOT NULL,
  "desinstalado_em" timestamp with time zone,
  "referencias_alteradas_em" timestamp with time zone,
  "outros_descricao" text,
  "indicacao_pedida_em" timestamp with time zone,
  "google_sub" text,
  "apple_sub" text,
  "avisos_todas_areas" boolean DEFAULT true NOT NULL,
  "raio_km_escolhido" numeric,
  "dias_credito_compensacao" integer DEFAULT 0 NOT NULL,
  "atende_casa_cliente" boolean DEFAULT true NOT NULL,
  "atende_local_proprio" boolean DEFAULT true NOT NULL
);

CREATE TABLE IF NOT EXISTS "versoes_app_vistas" (
  "usuario_id" uuid,
  "plataforma" text,
  "versao" text,
  "primeiro_em" timestamp with time zone DEFAULT now() NOT NULL,
  "ultimo_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "webhook_eventos_pagbank" (
  "charge_id" text,
  "status" text,
  "reference_id" text,
  "valor_centavos" integer,
  "recebido_em" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "whatsapp_envios" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "campanha" text,
  "usuario_id" uuid,
  "admin_id" uuid,
  "enviado_em" timestamp with time zone DEFAULT now() NOT NULL
);

-- Pedidos salvos e ocorrências de anúncio (24/11/2026).
CREATE TABLE IF NOT EXISTS "demandas_salvas" (
  "usuario_id" uuid NOT NULL,
  "tipo" text NOT NULL,
  "demanda_id" uuid NOT NULL,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL,
  "aviso_fim_em" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "anuncios_ocorrencias" (
  "id" bigserial,
  "usuario_id" uuid NOT NULL,
  "tabela" text NOT NULL,
  "demanda_id" uuid NOT NULL,
  "titulo" text,
  "admin_id" uuid,
  "criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
