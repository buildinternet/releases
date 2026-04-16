---
"@buildinternet/releases": patch
---

fix: clean up orphaned Vectorize vectors on --force delete, detect title-only RSS feeds

- Delete release vectors from Vectorize when `--force` fetch deletes D1 rows, preventing orphaned entries from consuming topK slots in search (#235)
- Detect title-only RSS feeds (empty content) and mark as `summary-only` so the scrape adapter falls through to crawl/single-page extraction (#234)
