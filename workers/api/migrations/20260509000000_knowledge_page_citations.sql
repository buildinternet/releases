-- Inline citations for org overviews (#846). Each row maps a character span
-- in `knowledge_pages.content` back to the release post it summarizes.
-- Populated by the regenerating-overviews skill from Anthropic search_result
-- citation blocks; consumed by the web frontend to render anchors over the
-- markdown body.
CREATE TABLE knowledge_page_citations (
  id TEXT PRIMARY KEY,
  knowledge_page_id TEXT NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
  -- Inclusive start / exclusive end character offsets into the page body.
  start_index INTEGER NOT NULL,
  end_index INTEGER NOT NULL,
  -- The release URL the model cited. Stored verbatim so the renderer doesn't
  -- need to round-trip through release_id (which may be null on miss).
  source_url TEXT NOT NULL,
  -- Display label — release title or version. Optional; renderer falls back
  -- to source_url when empty.
  title TEXT,
  -- Verbatim quote from the source's content, returned by Anthropic. Used for
  -- hover previews + auditability.
  cited_text TEXT NOT NULL,
  -- Best-effort backlink. Resolved at write time via case-insensitive
  -- releases.url match; nullable when the URL doesn't correspond to a known
  -- release row (e.g. the source was deleted, or the model cited a synthetic
  -- source we passed it).
  release_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_knowledge_page_citations_page
  ON knowledge_page_citations(knowledge_page_id);
