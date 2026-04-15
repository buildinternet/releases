---
"@buildinternet/releases": minor
---

Surface semantic similarity on source detail pages with "Related releases" and "Related sources" rails, powered by the existing Vectorize indexes. Two new read-only REST routes back the rails:

- `GET /v1/related/releases?release=<id>&scope=org|global&limit=N`
- `GET /v1/related/sources?source=<slug|id>&scope=org|global&limit=N`

Both routes pull the anchor's existing vector via `Vectorize.getByIds` (no re-embedding), run one similarity query, exclude the anchor from its own results, and degrade gracefully with `degraded: true` when the binding or embedding provider is unavailable. `scope=org` filters via Vectorize metadata.

To enable scope filtering on older entity vectors, the entity upsert path now writes `org_id` into Vectorize metadata. Existing orgs/products/sources need a one-time re-embed to populate the new metadata key:

```bash
releases admin embed entities
```

Releases already carry `org_id` in metadata, so no backfill is required for the releases rail. Until `entities` are re-embedded, `/v1/related/sources?scope=org` filters return empty; the frontend hides the rail in that state.
