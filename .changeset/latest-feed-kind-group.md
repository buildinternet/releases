---
"@buildinternet/releases-api-types": minor
---

Add `kind` (source + product) and server-resolved `groupSlug`/`groupName` to the `/v1/releases/latest` item shape (`ReleaseLatestItemSchema`). `kind` surfaces the `sources.kind`/`products.kind` classification so read surfaces can detect and deprioritize SDK releases via `resolveSourceKind`; `groupSlug`/`groupName` mirror the web feed's `product ?? source` rollup identity (#1234). All fields are additive and optional — older responses omit them.

Also add an optional server-derived `thumbnail` (`{ url, alt? } | null`) to the coverage sibling shape (`ReleaseCoverageSiblingSchema`) and to each release item in the lookup payload (`LookupResultPayloadSchema.releases`), so compact release rails can render a visual aid. Additive and optional — older responses omit it.
