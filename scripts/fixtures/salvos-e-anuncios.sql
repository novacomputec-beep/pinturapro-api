-- Pedidos salvos (utils/demandasSalvas) e pedido que parece anúncio (utils/suspeitaAnuncio) — 24/11/2026.
-- O mesmo que as migrações de boot criam, para os testes com esquema feito à mão. Idempotente.
ALTER TABLE IF EXISTS reparos ADD COLUMN IF NOT EXISTS suspeita_anuncio boolean NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS reparos ADD COLUMN IF NOT EXISTS suspeita_anuncio_motivos text[];
ALTER TABLE IF EXISTS reparos ADD COLUMN IF NOT EXISTS anuncio_em timestamptz;
ALTER TABLE IF EXISTS reparos ADD COLUMN IF NOT EXISTS anuncio_por uuid;
ALTER TABLE IF EXISTS obras ADD COLUMN IF NOT EXISTS suspeita_anuncio boolean NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS obras ADD COLUMN IF NOT EXISTS suspeita_anuncio_motivos text[];
ALTER TABLE IF EXISTS obras ADD COLUMN IF NOT EXISTS anuncio_em timestamptz;
ALTER TABLE IF EXISTS obras ADD COLUMN IF NOT EXISTS anuncio_por uuid;
CREATE TABLE IF NOT EXISTS demandas_salvas (
  usuario_id uuid NOT NULL, tipo text NOT NULL, demanda_id uuid NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(), aviso_fim_em timestamptz,
  PRIMARY KEY (usuario_id, tipo, demanda_id));
CREATE TABLE IF NOT EXISTS anuncios_ocorrencias (
  id bigserial PRIMARY KEY, usuario_id uuid NOT NULL, tabela text NOT NULL, demanda_id uuid NOT NULL,
  titulo text, admin_id uuid, criado_em timestamptz NOT NULL DEFAULT now(), UNIQUE (tabela, demanda_id));
