---
"@buildinternet/releases-core": patch
---

Add `idx_releases_feed_order` (`published_at, fetched_at, id`) to the `releases` schema so the cross-source latest feed can walk in its own order.
