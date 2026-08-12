---
"@buildinternet/releases-api-types": patch
---

Deprecate `SitemapReleaseSchema` / `SitemapReleasesPayloadSchema` (and the `SitemapRelease` / `SitemapReleasesPayload` types). `GET /v1/sitemap/releases` was retired (#2219) as consumer-less after `sitemap-releases.xml` was removed from web in #2218. The exports stay for one minor version per the deprecation lane before removal.
