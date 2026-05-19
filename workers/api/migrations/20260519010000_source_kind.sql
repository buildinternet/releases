-- Adds nullable `kind` enum column to products and sources. Validated in app
-- code against KIND_VALUES from @buildinternet/releases-core (no CHECK
-- constraint — keeping the SQL forgiving so an enum-list change doesn't
-- require a follow-up migration).
ALTER TABLE products ADD COLUMN kind TEXT;
ALTER TABLE sources ADD COLUMN kind TEXT;

CREATE INDEX IF NOT EXISTS idx_products_kind ON products(kind) WHERE kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind) WHERE kind IS NOT NULL;
