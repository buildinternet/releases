# @releases/core-internal

DB-coupled and worker-only helpers shared across the monorepo's workers — the counterpart to the published `@buildinternet/releases-core` for things the thin OSS CLI doesn't need.

## Exports

- `@releases/core-internal/api-token-store` — D1-backed verification for opaque `relk_…` API tokens, shared by the API and MCP workers.
- `@releases/core-internal/category-alias` — loads category alias → canonical-slug mappings for conflict detection and alias redirects.
- `@releases/core-internal/release-upsert` — Drizzle conflict-resolution config for upserting release rows keyed on `(source_id, url)`.
- `@releases/core-internal/hash` — SHA-256 hex digest helper.
- `@releases/core-internal/webhook-sign` — Web Crypto HMAC signing for outbound webhook deliveries.
- `@releases/core-internal/webhook-resilience` — auto-disable thresholds and delivery-health classification for webhook subscriptions.
- `@releases/core-internal/web-bot-auth-sign` — RFC 9421 request signing for Web Bot Auth (Cloudflare-compatible component set).
- `@releases/core-internal/collection-feed` — aggregated, cursor-paginated release feed for a collection's member orgs/products.
- `@releases/core-internal/category-feed` — aggregated, cursor-paginated release feed for all orgs/products in a category.
- `@releases/core-internal/feed-cursor` — shared cursor primitives (tie-break ordering, cursor encode/decode) reused by the collection and category feeds.
- `@releases/core-internal/changesets-cluster` — detects changesets-style cascade releases within a fetch batch and demotes near-empty siblings to coverage rows.
- `@releases/core-internal/release-coverage-sql` — correlated-subquery SQL fragment for counting a release's demoted coverage siblings.
- `@releases/core-internal/schema-coverage` — Drizzle table definition for `release_coverage`.
- `@releases/core-internal/batch-run` — persistence helpers for the `batch_runs` table (submit/progress/finalize lifecycle for Anthropic Message Batches).
- `@releases/core-internal/eligibility` — eligibility query selecting releases due for batch content generation.
- `@releases/core-internal/overview-eligibility` — eligibility + input assembly for batch org-overview generation.
- `@releases/core-internal/overview-upsert` — shared upsert for org overviews (`knowledge_pages` + citations), used by both the agent write path and the automated regen workflow.
- `@releases/core-internal/composition-metadata` — builds the SQL fragment that sets/clears a release's `metadata.composition`, shared by both ingest workflows and the PATCH handler.

**Private, workspace-only — imported via `@releases/core-internal`, not published to npm.**
