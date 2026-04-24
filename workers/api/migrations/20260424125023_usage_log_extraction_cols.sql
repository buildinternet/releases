-- Add extraction-mode and cache-token columns to usage_log for tool-loop instrumentation.
-- See packages/core/src/schema.ts for type definitions (USAGE_EXTRACTION_MODES, USAGE_FALLBACK_REASONS).
ALTER TABLE usage_log ADD COLUMN extraction_mode TEXT;
ALTER TABLE usage_log ADD COLUMN tool_rounds INTEGER;
ALTER TABLE usage_log ADD COLUMN tool_chars INTEGER;
ALTER TABLE usage_log ADD COLUMN fallback_reason TEXT;
ALTER TABLE usage_log ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE usage_log ADD COLUMN cache_write_tokens INTEGER;
