# @releases/core-internal

DB-coupled and worker-only helpers shared across the monorepo's workers — the counterpart to the published `@buildinternet/releases-core` for things the thin OSS CLI doesn't need.

## Exports

Imported as `@releases/core-internal/<subpath>`.

| Subpath                | Purpose                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `api-token-store`      | D1-backed verification for opaque `relk_…` API tokens (API + MCP workers).             |
| `category-alias`       | Loads category alias → canonical-slug mappings for conflict detection and redirects.   |
| `release-upsert`       | Drizzle conflict-resolution config for upserting release rows on `(source_id, url)`.   |
| `hash`                 | SHA-256 hex digest helper.                                                             |
| `webhook-sign`         | Web Crypto HMAC signing for outbound webhook deliveries.                               |
| `webhook-resilience`   | Auto-disable thresholds and delivery-health classification for webhook subscriptions.  |
| `webhook-url-safety`   | SSRF gates for webhook targets (HTTPS, blocked hosts, private IP / DNS re-check).      |
| `webhook-delivery`     | `DeliveryMessage` queue wire type shared by API fan-out and the webhooks worker.       |
| `release-event`        | `ReleaseEvent` / `ReleaseEventPayload` wire shape + `newEventId` / `padSeq` helpers.   |
| `web-bot-auth-sign`    | RFC 9421 request signing for Web Bot Auth (Cloudflare-compatible component set).       |
| `collection-feed`      | Aggregated, cursor-paginated release feed for a collection's member orgs/products.     |
| `category-feed`        | Aggregated, cursor-paginated release feed for all orgs/products in a category.         |
| `feed-cursor`          | Shared cursor primitives (tie-break ordering, encode/decode) for the feeds above.      |
| `changesets-cluster`   | Detects changesets-style cascade releases and demotes near-empty siblings to coverage. |
| `release-coverage-sql` | Correlated-subquery SQL fragment counting a release's demoted coverage siblings.       |
| `schema-coverage`      | Drizzle table definition for `release_coverage`.                                       |
| `batch-run`            | Persistence helpers for the `batch_runs` table (submit/progress/finalize lifecycle).   |
| `eligibility`          | Eligibility query selecting releases due for batch content generation.                 |
| `overview-eligibility` | Eligibility + input assembly for batch org-overview generation.                        |
| `overview-upsert`      | Shared upsert for org overviews (`knowledge_pages` + citations), agent + regen paths.  |
| `composition-metadata` | SQL fragment that sets/clears a release's `metadata.composition`.                      |

**Private, workspace-only — not published to npm.**
