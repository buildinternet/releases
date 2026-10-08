---
"@buildinternet/releases-core": patch
---

Declare an `idx_releases_url` index on `releases.url` so lookups by url alone use an index instead of scanning the table.
