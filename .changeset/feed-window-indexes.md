---
"@buildinternet/releases-core": patch
---

Update `releases` index definitions: `idx_releases_scored_feed` (feed-order partial index for `minImportance`) replaces `idx_releases_importance_published`, and the covering `idx_releases_published_source` replaces `idx_releases_published`.
