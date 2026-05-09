-- Adds content_title — a generated, self-contained news-headline-style title
-- ([Product] [version] [verb-led description]) used in context-poor surfaces
-- like highlight feeds where the source `title` field (often just a version
-- like "v2.1.128") is meaningless on its own.
--
-- Generated alongside content_summary by Haiku 4.5 in one call. Always-on:
-- every release row gets one.
ALTER TABLE releases ADD COLUMN content_title TEXT;
