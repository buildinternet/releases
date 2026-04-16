---
"@buildinternet/releases": patch
---

Add `GET /v1/sitemap` bulk endpoint returning orgs + sources + products in a single response. The web sitemap now uses this to avoid a per-org fan-out that was timing out Vercel builds, and the route is rendered on-demand instead of at build time.
