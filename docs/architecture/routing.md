# REST route surface

How the API worker's route namespace is organized: where CRUD vs. job triggers vs. admin telemetry live, how resources resolve (IDs vs. slugs, org-scoped vs. bare), the `/v1/lookups` resolver family, pagination shape, and the OpenAPI coverage gate.

## Route naming buckets (#494)

Three buckets, by intent:

- **Resource CRUD** → canonical path `/v1/<resource>/...`, auth gated by the `adminRoutes` allowlist in `workers/api/src/index.ts` (this includes `/v1/lookups`).
- **Job / side-effect triggers** (batch-summarize, batch-enrich, embed backfills, notifications-test) → `/v1/workflows/<job-name>` in `workers/api/src/routes/workflows.ts`.
- **Admin-only telemetry** that fits neither bucket (cron-runs list/detail, embed/status, `admin/logs/*`, search-queries, the cross-org overview manifest under `admin/overviews`) → stays under `/v1/admin/...`.

Do **not** add new `/v1/admin/*` endpoints for CRUD or for async triggers — those belong on the canonical path or under `/v1/workflows/*` respectively. Existing `/v1/admin/*` CRUD is tech debt (#494).

> **Sanctioned exception: `/v1/admin/users/role` (#1484).** User-role provisioning (the OAuth scope-entitlement source of truth) lives under `/v1/admin/*` on purpose, not as tech debt. Users are Better Auth principals, not catalog resources, so there is no canonical `/v1/<resource>` path for them; the only built-in alternative is Better Auth's native `admin/set-role`, which requires a browser admin session the CLI/scripts don't have. The route is root-key-gated, fail-closed (role validated against `ROLE_LADDER`), and audited (`role-changed` logEvent). See [remote-mode.md → Role provisioning](remote-mode.md).

A fourth, narrower bucket exists for **self-serve, session-authed** resources:
`/v1/api-keys` (user-owned `relu_` API key management — minted read-only, the
write/admin scope is refused; see remote-mode.md) is gated by `requireSession`
(Better Auth session cookie), not by the Bearer-token middleware. It is intentionally
absent from both `publicReadRoutes` and `adminRoutes` in
`workers/api/src/route-namespaces.ts` (so neither the public-read nor admin auth loop
touches it) and from the public-read OpenAPI coverage gate. Its credentialed CORS is
carved out alongside `/api/auth/*` in `index.ts`. This bucket is for first-party,
current-user browser operations; it is not a general extension point.

The `/v1/me/*` user-follows and personalized-feed surface sits in its own
principal-gated bucket (`requireFollowsPrincipal`), absent from both
`publicReadRoutes` and `adminRoutes` and using the same credentialed CORS carve-out
in `index.ts`. Unlike `/v1/api-keys` it is **not** behind a feature flag — follows is
enabled by default.

The gate resolves a user from **either** a Better Auth session (cookie, or a
device-login Bearer session token via the `bearer()` plugin) **or** a Bearer **user**
credential — a `relu_` user key (whose `userId` the verify returns) or a "Sign in with
Releases" OAuth JWT (whose `sub` is the user id). This lets the CLI and MCP server —
which authenticate by Bearer, not a cookie — manage a user's follows. Unlike the
catalog API it is **not** scope-gated: a read-only `relu_` key still manages its
OWNER'S follows, exactly as that user's session would (follows are personal account
state, not a catalog write). Machine principals (`relk_`) and root have no owning user
and are refused (401); a presented-but-unresolvable Bearer credential gets a 401 with
`WWW-Authenticate: …error="invalid_token"`. Endpoints:

- `GET /v1/me/follows` — list the signed-in user's follows, enriched with each target's display fields (name, slug, avatarUrl, orgSlug for products), newest first.
- `POST /v1/me/follows { targetType, targetId }` — add a follow (idempotent; `targetType` is `"org"` or `"product"`).
- `DELETE /v1/me/follows/:targetType/:targetId` — remove a follow (idempotent).
- `GET /v1/me/feed` — paginated release feed across all followed entities; an org follow implicitly includes all of that org's products (org follow = its products too). Cursor-paginated (`?cursor=&limit=`, `{ items, pagination: { nextCursor, limit } }`), newest-first.
- `/v1/me/webhooks` — self-serve outbound webhook subscriptions (`GET/POST`, per-id `GET/PATCH/DELETE`, `rotate-secret`, `test`, `deliveries`). Default `scope: "org"` (requires `orgId`/`orgSlug`, optional source filter, max 10). `scope: "follows"` delivers releases matching the caller's `user_follows` graph (max 1, separate from the org cap). Same principal gate as follows. Subscriber contract: [docs/webhooks.md](../webhooks.md).

## Entity resolution: IDs over slugs

Entity resolution prefers IDs over slugs; IDs are immutable, so prefer them in new clients.

- **Org and release** lookups accept `org_…` / `rel_…` IDs or slugs interchangeably.
- **Source and product** lookups accept the typed ID (`src_…` / `prod_…`) on the bare path (`/v1/sources/:slug`, `/v1/products/:slug`), but slug-only callers must use the org-scoped path or a `/v1/lookups/*-by-slug` resolver (#698, below).

## Org-scoped routes (#690 + #698)

Per-org slug uniqueness for sources and products is enforced by `idx_sources_org_slug` / `idx_products_org_slug`; the global `UNIQUE(slug)` index has been dropped.

Source and product detail endpoints are **dual-registered** — the legacy bare form (`/v1/sources/:slug`, `/v1/products/:slug`) and the canonical org-scoped form (`/v1/orgs/:orgSlug/sources/:sourceSlug`, `/v1/orgs/:orgSlug/products/:productSlug`) share a single handler.

Post-#698 the bare form rejects bare _slugs_ with `400 bare_slug_rejected` (thrown as `BareSlugRejected` from `resolveSourceFromContext` / `resolveProductFromContext`); only typed IDs work on the bare path because IDs stay globally unique. Prefer the org-scoped path. The OSS CLI's `findSource`/`findProduct` already branch on identifier shape (typed-ID → bare path, `org/slug` → split locally, bare slug → resolve). For a **bare source slug**, `findSource` enumerates `GET /v1/sources?slug=…` (exact-slug filter, all orgs) and resolves only when exactly one source matches; >1 throws `AmbiguousSourceError` listing the `org/slug` + `src_…` candidates instead of silently picking the oldest, since per-org uniqueness (#690) means a bare slug isn't a globally unambiguous handle (releases-cli#264).

**Creation requires an org.** `POST /v1/sources` and `POST /v1/products` both require `orgId` or `orgSlug` — silent orphan creation is gone. Resolution-failure responses differ:

- `POST /v1/sources` collapses missing-and-unresolvable into one `400 bad_request` (the org guard checks resolution before validating shape).
- `POST /v1/products` returns `400 bad_request` only when both fields are omitted, and `404 not_found` when one is supplied but doesn't resolve.

## The `/v1/lookups` resolver family

The whole `lookups` namespace lives in `publicReadRoutes` (`workers/api/src/route-namespaces.ts`), so auth is gated by method, not by route:

- **Public-read (no auth, rate-limited, cacheable):** `GET /v1/lookups/source-by-slug`, `GET /v1/lookups/product-by-slug`, `GET /v1/lookups/by-domain` — pure resolution primitives.
- **Write (Bearer required):** `POST /v1/lookups` (the on-demand GitHub indexer) — gated by `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.

None of the lookup routes are `adminRoutes`-protected.

### Slug resolvers (#698)

`GET /v1/lookups/source-by-slug?slug=…` and `GET /v1/lookups/product-by-slug?slug=…` return the canonical home (`{sourceId|productId, sourceSlug|productSlug, orgSlug}`) for old bookmarks and slug-only callers. They pick the oldest match by `(createdAt, id)` and carry `Sunset: Sun, 01 Nov 2026 00:00:00 GMT` (a deprecation signal — these are migration aids, not auth-gated; see auth note above). The oldest-match tie-break makes these unsuitable for disambiguating a bare slug that exists under multiple orgs; the CLI's `findSource` no longer routes through `source-by-slug` and instead enumerates the exact-slug `GET /v1/sources?slug=…` filter to detect that ambiguity (releases-cli#264, above).

### Domain resolution

Domain aliases (`domain_aliases` table) map alternate domains to orgs/products; globally unique; matched in `findOrg()`/`findProduct()` fallback and in search LEFT JOINs.

`GET /v1/lookups/by-domain?domain=…` resolves a normalized domain to its owning org (matched on `organizations.domain` for primary or `domain_aliases.domain` for aliases) and any products whose alias targets the same domain. Pure resolution — unlike the GitHub coordinate path, an unknown domain just returns `404 not_found`; there is no probing. Mirrored on MCP as `lookup_domain` and on the OSS CLI as `releases lookup domain <domain>`. The normalizer `normalizeDomain` (`@buildinternet/releases-core/domain`) is shared with `/v1/search?domain=…` and the MCP `search` tool's `domain` input to scope a query to one org by URL-shaped input.

### On-demand GitHub source creation (#662)

`POST /v1/lookups { provider: "github", coordinate: "org/repo" }` materializes a hidden source row from a coordinate. Sources and orgs created this way carry `discovery = 'on_demand'` and `isHidden = true`. AI features (overviews, summarization, playbook regen) skip them; embeddings still run via `waitUntil` so semantic search works on the second hit. Negative results are cached in KV (`lookup:github:{org}/{repo}` in `LATEST_CACHE`, 24h for `not_found`, 6h for empty). The existing-source check inside `runLookup` is case-insensitive against `sources.url`.

Trigger points: MCP `search` and `/v1/search` (lexical + hybrid) fire the lookup whenever a coordinate-shaped query produces no entity match — release / chunk hits don't suppress it (a coordinate is a precise question about one repo). MCP `search_releases` always attempts the lookup on coordinate-shaped input. Design: `docs/superpowers/specs/2026-04-29-on-demand-github-lookup-design.md`.

`parseCoordinate()` (`@buildinternet/releases-core/lookup-coordinate`) parses `"org/repo"` (optional `github:`/`GitHub:` prefix) into `{ provider: "github", org, repo }`, returning `null` on miss. Other provider prefixes (`npm:`, `gitlab:`, …) are explicitly rejected. The `GITHUB_SEGMENT` regex (`/^[A-Za-z0-9._-]+$/`) constrains each segment. Org/repo case is preserved on the parsed object — `runLookup` does the case-folding (`LOWER(sources.url) = LOWER(?)`), so `shopify/toxiproxy` and `Shopify/Toxiproxy` resolve to the same row.

The `discovery` column (text, NOT NULL DEFAULT `'curated'`, indexed) on `organizations` and `sources` records how the row was created: `'curated'` (default, backfilled for pre-existing rows), `'agent'` (discovery agent), `'on_demand'` (this endpoint). It's the queryable handle for admin tooling and AI-feature gates; per-source detail lives under `metadata.lookup`.

## Org catalog (#690)

`GET /v1/orgs/:slug/catalog` returns a single payload mixing the org's products and direct sources, ordered for UI consumption. Use it instead of round-tripping `/v1/orgs/:slug/products` + `/v1/sources?orgSlug=…&productId=NULL` from the web frontend.

The org-scoped `GET /v1/orgs/:slug/products` (#1225) is the canonical products-only list — slug-or-`org_…`-id-scoped, `?kind=`-filterable. The bare `/v1/products` query form is `?orgId=`-only and does **not** honor `?orgSlug=`.

Catalog wire shapes live in `@buildinternet/releases-api-types`; the catalog payload will grow a `kind` discriminator when #693 Phase 3 adds rollups (the right time to export the union type).

## Upgrade intelligence — `whats-changed` (#1697, beta)

> **Beta — subject to change.**

`GET /v1/whats-changed?package=&from=&to=&ecosystem=npm|pypi|github` (`workers/api/src/routes/whats-changed.ts`) returns the changelog entries in the half-open version range `(from, to]` for a package — summaries + breaking verdicts (#1696) + migration notes, composed by the pure `resolveUpgradeRange` (`@buildinternet/releases-core/upgrade-range`) over **already-ingested** releases (no live fetch; no per-request AI — the summaries/verdicts are read from columns generated at ingest). Resolution is **read-only**: exact source-slug match, then a non-materializing GitHub `owner/repo` coordinate match (mirrors `/v1/lookups/source-by-coordinate`, never the materializing `POST /v1/lookups`) — a read tool must not write, so an unresolvable package returns `status: "unknown"` at **HTTP 200** (a valid answer, not a 404). Bare npm/PyPI names resolve to `unknown` until #1345 lands a name→source map. Wide ranges are token-budgeted against `CHANGELOG_TOKEN_BRACKETS` (newest kept, `truncated` flagged). The MCP `whats_changed` tool proxies this route over the `API` binding (single source of truth). Phase 2 (`upgrade_plan` over a manifest) fans this out per dependency.

## Pagination shape

Pick the shape from the data, not the surface:

- **Page-based** — catalog-shaped surfaces (stable, sortable, mostly non-mutating between calls): the four MCP `list_*` tools, `/v1/sources`, `/v1/orgs`, `/v1/products`. Inputs `page` + `limit`; output `Pagination { page, pageSize, returned, totalItems, totalPages, hasMore }`. This is the **default** when a surface is bounded and stable.
- **Cursor-based** — feed-shaped surfaces (append-only, mutates between calls): `/v1/me/feed`, `/v1/orgs/:slug/releases`, `/v1/status/fetch-log`, MCP `get_latest_releases`. Opaque `cursor` input, `nextCursor` output. Pick cursor **only** when the data shape forces it.
- **Ranking-bounded** — `search` attaches `_meta.search` instead of pagination. `hitCap: true` means "we returned `limit` matches; refine the query to see different ones" — distinct from "fetch the next slice".

MCP `list_*` results expose pagination via `_meta.pagination` (page variant matches the REST `Pagination` shape; cursor variant adds a `kind: "cursor"` discriminator) plus an LLM-readable markdown footer.

Audited 2026-05-05: `get_latest_releases` is the only feed-shaped MCP tool — every other tool is catalog (`list_*`), single-row (`get_*`), search, or AI generation. **New feed-shaped tools must use cursor + `_meta.pagination { kind: "cursor" }`.**

## Read-path freshness (Cache-Control)

Public GET routes advertise per-route `Cache-Control` headers (registered in `workers/api/src/index.ts`; `cacheControl()` is headers-only — there is no worker-side response cache to invalidate, so the header IS the freshness contract any downstream HTTP cache may honor). Single-entity reads — including `GET /v1/releases/:id` (#1580) — use `public, max-age=60, stale-while-revalidate=30`, so a just-written field (e.g. generate-content's `title_short`/`summary`) can read stale for up to ~90s through a caching intermediary; read back through an uncached route (the source-releases list) or wait out the window before concluding a write failed.

## OpenAPI coverage gate (#894 Phase 3)

Every method registered under a `publicReadRoutes` prefix (defined in `workers/api/src/route-namespaces.ts`) must appear in `/v1/openapi.json`. Enforced by `scripts/check-openapi-coverage.ts`, run as a step in the CI `test` job.

Add `describeRoute(...)` annotations from `hono-openapi` to new public-read routes. If a public-read route is genuinely meant to stay undocumented, add an explicit entry to the script's `ALLOWLIST` set with a rationale comment (stale entries log a warning so they don't accumulate). Admin-only routes (`adminRoutes` in the same module) are intentionally outside the gate's scope.
