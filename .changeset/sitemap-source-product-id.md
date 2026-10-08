---
"@buildinternet/releases-api-types": patch
---

`SitemapSourceSchema` gains an optional `productId` (`string | null`), so the web sitemap can list each source at the URL the site actually links it from.
