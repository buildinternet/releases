-- Denormalize effective category onto releases for category-feed index seeks (#886).
-- effective_category = COALESCE(product.category, org.category) via the source.
-- Without this, getCategoryReleasesFeed full-scans releases (~100k rows_read per
-- LIMIT 21) because the filter is on joined org/product columns after ORDER BY.

ALTER TABLE releases ADD COLUMN effective_category TEXT;

-- Hand-authored DESC so the category feed can SEARCH + walk published order
-- without a full table scan + TEMP B-TREE. Drizzle's index() helper cannot emit
-- direction modifiers (same pattern as idx_releases_published_id).
CREATE INDEX IF NOT EXISTS idx_releases_eff_cat_published
  ON releases (effective_category, published_at DESC, id DESC);

-- One-shot backfill. ~tens of thousands of rows is fine on D1; re-run is
-- idempotent (same COALESCE). New inserts stamp via app write path.
UPDATE releases
SET effective_category = (
  SELECT COALESCE(p.category, o.category)
  FROM sources s
  INNER JOIN organizations o ON o.id = s.org_id
  LEFT JOIN products p ON p.id = s.product_id
  WHERE s.id = releases.source_id
);
