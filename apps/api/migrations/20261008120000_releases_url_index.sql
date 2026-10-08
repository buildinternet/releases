-- Index releases by url alone. The only url index was the (source_id, url)
-- unique pair, which a lookup by url without a source can't use, so
-- `releases_visible WHERE url = ?` (GraphQL `release(idOrUrl:)` with a url)
-- scanned the whole releases table — about 3.5s per call on prod D1.
CREATE INDEX IF NOT EXISTS idx_releases_url ON releases (url);
