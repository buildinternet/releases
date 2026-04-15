---
"@buildinternet/releases": patch
---

Search results now render release hits with the same markdown body, thumbnail, and expand behavior used in the org and source feeds. The `/v1/search` API returns `content`, `media`, and `sourceType` on each release hit so the web can reuse `<ReleaseListItem>` instead of a plain summary card.
