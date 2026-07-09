---
"@buildinternet/releases-api-types": minor
---

Add optional `ogImageUrl` to `ReleaseDetailResponseSchema` / `ReleaseDetail` (#2066): the absolute `media.releases.sh` URL for a release's mirrored OpenGraph image, when one has been generated at ingest time. `null`/absent means no mirrored image exists yet — callers fall back to the on-demand `opengraph-image` route. Additive and optional; older servers omit it.
