# The API worker (remote mode)

This is the reference for the API worker at `workers/api/` — the heart of the backend. Every read and write in the system goes through it: the OSS CLI ([`buildinternet/releases-cli`](https://github.com/buildinternet/releases-cli)) is a pure HTTP client talking to `RELEASES_API_URL` (default `https://api.releases.sh`), the web frontend and MCP server are clients too, and the internal workers (MCP, discovery, webhooks, cron) bind directly to the same D1 database. There is no local-SQLite path anymore; "remote mode" — everything served from Cloudflare — is the only mode.

It's the longest doc in this directory because the worker owns a lot. Jump to what you need:

- **Who can call what** → [Auth model](#auth-model) (all the credential lanes: root key, scoped `relk_` tokens, user `relu_` keys, sessions, OAuth JWTs) and [Role provisioning](#role-provisioning-admin--curator).
- **Traffic protection** → [Rate limiting](#rate-limiting) and the [auth brute-force limiter](#auth-endpoint-brute-force-limiter-apiauth).
- **Schema changes** → [Migrations](#migrations).
- **When and how sources get fetched** → [Sessions + cron](#sessions--cron), [SourceActor](#sourceactor--per-source-fetch-scheduling-1776) / [OrgActor](#orgactor--per-org-scrapeagent-drain-1777), and [Feed change detection + retier](#feed-change-detection--retier).
- **Why a source's display URL differs from what we fetch** → [Display URL vs. fetch routing](#display-url-vs-fetch-routing).

## Auth model

GET endpoints are public (no auth required). Write operations (POST/PATCH/DELETE) require a Bearer token. The `publicReadAuthMiddleware` in `workers/api/src/middleware/auth.ts` handles this split. Admin-only routes (sessions, `admin/*`, `workflows/*`) require auth for all methods. The `GET /v1/orgs/:slug/playbook` endpoint is also admin-only (inline `authMiddleware` on the handler) since playbook content is internal.

### Scoped API tokens

Alongside the single static `RELEASES_API_KEY` (now treated as implicit **root** —
all scopes, break-glass), the API worker accepts **DB-backed scoped tokens** in
the `Authorization: Bearer relk_<lookupId>_<secret>` form. Each token (`api_tokens`
table) carries a JSON set of scopes (`read` ⊂ `write` ⊂ `admin`), can be revoked
(`active=0`) or expired (`expires_at`), records `last_used_at`, and is attributed
to a principal (`principal_type`: `internal | agent | user`, plus optional
`principal_id`). Only the `SHA-256` hash of the secret is stored; the public
`lookup_id` is the indexed handle. Validation lives in
`workers/api/src/middleware/token-store.ts` (constant-time, uniform-failure) and
`middleware/auth.ts` (scope enforcement: writes need `write`, admin routes need
`admin`). Manage via admin-gated `/v1/tokens` (mint/list/revoke/patch); mint with
`scripts/mint-token.ts`. Kill switch: `API_TOKENS_DISABLED=true` falls back to the
static key only. See `docs/superpowers/specs/2026-05-20-scoped-api-tokens-design.md`.

**User API keys (`relu_`).** Logged-in users own metered, rate-limited API keys
issued by the Better Auth `@better-auth/api-key` plugin (the `apikey` table),
distinct from the `relk_` machine lane. The auth middleware routes `relu_` →
`auth.api.verifyApiKey` (per-key rate-limit + `remaining`, deferred via
`waitUntil`); the scope ladder is encoded as cumulative actions on one `api`
permission resource, so route guards are unchanged. Gated by the
`user-api-keys-enabled` flag; rate-limit exhaustion → HTTP 429. Verification is
memoized per request so a single request meters exactly once.

User keys are capped at a **read-only ceiling** (`USER_API_KEY_MAX_SCOPE = "read"`
in `workers/api/src/auth/api-key-scope.ts`), enforced at both layers: the mint
route refuses any scope above the ceiling (a missing scope defaults to read;
write/admin → 400, via `isWithinUserKeyCeiling`), and the auth resolver clamps
every verified `relu_` key's scopes to the ceiling before route guards see them
(`clampUserKeyScopes`) — so write is unreachable for the user lane even if a
write-permissioned `relu_` key were granted out-of-band. The `relk_` machine lane
and static root key are unaffected and still use the full `read ⊂ write ⊂ admin`
ladder.

**Browser login (`releases login`, device authorization).** Users mint a `relu_`
key without copy-pasting a token via the OAuth 2.0 Device Authorization Grant
(RFC 8628). Better Auth's `deviceAuthorization()` + `bearer()` plugins are always
registered in `workers/api/src/auth/index.ts` (and, since login issues through
the user-key route, `user-api-keys-enabled` must also be on). Flow: the CLI POSTs
`/api/auth/device/code` (client id `releases-cli`; a fail-closed `validateClient`
allow-list rejects any other id), the user approves at the web `/device` page,
and the CLI polls `/api/auth/device/token` until it gets a **session access
token**. That token rides as `Authorization: Bearer` — `bearer()` is what makes
`requireSession` honor it — to the _same_ `POST /v1/api-keys` route the web panel
uses, which injects the owner and mints a read-only `relu_` key (the ceiling
above applies). The session is then discarded; the durable `relu_` key is what's
stored.

> **`verificationUri` must be an absolute URL on the WEB origin**
> (`${WEB_BASE_URL}/device`), never a relative `/device`. The approval page is
> served by the Next.js frontend (releases.sh), not the API worker — Better Auth's
> `buildVerificationUris` resolves a _relative_ value against the API `baseURL`,
> yielding `https://api.releases.sh/device`, which 404s (#1450). The
> `.releases.sh`-scoped session cookie rides across the `api.` ↔ apex subdomains,
> so only the page needed to live on the web origin. The same rule applies to any
> Better Auth redirect/verification target that points at a web page.

### Role provisioning (admin / curator)

A signed-in user's OAuth scope ceiling comes from the Better Auth admin-plugin
`user.role` column — the durable source of truth the entitlement boundary reads
(`workers/api/src/auth/entitlement.ts`: `user`→read, `curator`→read+write,
`admin`→read+write+admin; NULL/unknown → read-only, fail-closed). Roles are
managed through a **root-key-gated** admin route — no redeploy, audited via a
`role-changed` `logEvent` (component `auth`, queryable in Axiom):

- `PATCH /v1/admin/users/role` `{ email | userId, role }` — set a role
  (`workers/api/src/routes/admin-users.ts`). The accepted role set is derived
  from `ROLE_LADDER`, so the route can never drift from the scope boundary;
  unknown role → 400, missing user → 404. "Revoke" = set role back to `user`.
- `GET /v1/admin/users/role?email=|userId=` — read one user's role.
- `GET /v1/admin/users/roles` — list curator/admin users.

The OSS CLI wraps these as `releases admin user set-role | get-role |
list-roles`. **Bootstrap:** the first admin is seeded once by a direct D1 write
(`UPDATE user SET role='admin' WHERE email=…`); thereafter that admin grants
others via the route (or Better Auth's native `setRole` in the browser, which a
role=admin user is authorized for under `adminRoles: ["admin"]`). The former
`OAUTH_ADMIN_USER_IDS` env bootstrap has been removed (#1484).

### OAuth client provisioning (admin/oauth)

OAuth clients for "Sign in with Releases" are provisioned two ways: via a
root-key-gated admin surface (for first-party / `trusted` `skip_consent` clients),
and — now that agent-run MCP clients need to self-register — via **RFC 7591
dynamic client registration** at the public `/oauth2/register` endpoint
(`allowDynamicClientRegistration: true`). DCR clients are always untrusted (they
hit the consent page), PKCE-required, and their tokens are role-clamped at
issuance, so DCR grants no scope a user's role doesn't already allow. The endpoint
is rate-limited to 5 registrations/min/IP (explicit in `auth/index.ts`, enforced
in deployed prod). The admin route remains the second sanctioned exception to the
"no new `/v1/admin/*` CRUD" rule (alongside role provisioning).

- `POST /v1/admin/oauth/clients` — create a client. Body: `redirectUris`
  (required, non-empty), `scopes` (required, non-empty), optional `name`,
  `trusted` (→ `skip_consent`, first-party only), `tokenEndpointAuthMethod`
  (`none` ⇒ a secretless **public/PKCE** client, e.g. the MCP client), `type`,
  `grantTypes`, `requirePKCE`, `clientUri`, `logoUri`. Returns the
  `reloc_`-prefixed `clientSecret` **once** (null for a public client).
- `GET /v1/admin/oauth/clients` · `GET /v1/admin/oauth/clients/:clientId` —
  list/get public, secret-free client fields.
- `PATCH /v1/admin/oauth/clients/:clientId { disabled?, trusted? }` — disable is
  a true kill switch (the AS rejects disabled clients at authorize/token/
  introspect); `trusted` toggles `skip_consent`.
- `POST /v1/admin/oauth/clients/:clientId/rotate-secret` — new `reloc_` secret,
  returned once; 400 for a public client.
- `DELETE /v1/admin/oauth/clients/:clientId`.

All mutations emit an audited `logEvent` (`actor: "root-key"`). The plugin's
session-gated self-service write endpoints (`/api/auth/oauth2/{create,update,
delete}-client`, `/api/auth/oauth2/client/rotate-secret`) are restricted to `role=admin`.
The #1480 entitlement ceiling still applies regardless of client trust.

### Resource-server JWT verification (#1483)

The REST API worker and the MCP worker accept the AS's JWT access tokens as a
fifth credential lane (alongside `relk_`, `relu_`, the static root key, and — REST
only — the Better Auth session cookie). A "Sign in with Releases" token thus
grants `read`/`write`/`admin` on those surfaces.

- **Shared verifier** — `@releases/lib/oauth-jwt` (`isJwtShaped`,
  `verifyOAuthJwt`, `extractApiScopes`). Worker-safe and deliberately
  **better-auth-free**: `workers/mcp` must not import the AS (the zod-pin would
  split zod and break the MCP SDK's nested-zod tool schemas), so verification is
  `jose.jwtVerify` against a cached `createRemoteJWKSet(${issuer}/api/auth/jwks)`.
  It checks the signature, `iss`, `aud`, and `exp`, and returns `null` on any
  failure (callers treat that exactly like an invalid opaque token).
- **Scope** comes from the token's `scope` claim, intersected with the
  `read`/`write`/`admin` ladder. The claim is already clamped to the user's live
  role at issuance (`customAccessTokenClaims` → entitlement.ts), so the resource
  server **trusts it and never re-derives scope**.
- **Issuer / audience.** Issuer = the AS origin (`BETTER_AUTH_URL`,
  `https://api.releases.sh` in prod). The API worker's own audience is that same
  origin; the MCP worker's audience is its origin (`https://mcp.releases.sh`,
  already in `OAUTH_RESOURCE_AUDIENCES`), set via the MCP wrangler vars
  `OAUTH_JWT_ISSUER` / `OAUTH_JWT_AUDIENCE` (staging overrides both). A token
  minted for the MCP audience won't pass the API worker's audience check, and
  vice-versa.
- **Additive, fail-consistent.** A JWT principal carries no forwardable
  credential (`token: null`), so MCP downstream `/v1/lookups` calls fall back to
  the root key (same as the `relu_` lane) and a JWT identity does **not** open
  the mcp-staging access gate. A verification failure is ignored on a public
  read (stays public) and rejected on a write/admin route — never a new mandatory
  gate on the previously-unauthenticated MCP path (constraint carried from
  #1482). JWT principals have no `api_tokens` row, so the `last_used_at` machine
  lane is skipped for their `oauth_<sub>` token id.
- **Discovery surface.** The REST API worker is itself an OAuth resource server,
  so it serves its own RFC 9728 metadata at
  `GET /.well-known/oauth-protected-resource` (`{ resource: <API origin>,
authorization_servers: [<origin>/api/auth], scopes_supported,
bearer_methods_supported }`, built by `buildApiProtectedResourceMetadata` in
  `oauth-discovery.ts`), mirroring the MCP worker's surface (see
  [mcp.md → OAuth discovery surface](mcp.md#oauth-discovery-surface-rfc-9728)).
  `resource` is the bare origin (= the verified `aud`); the issuer carries the
  `/api/auth` basePath. The verifier fetches JWKS from
  `${issuer}/api/auth/jwks` server-to-server, so the **staging access gate
  exempts `/api/auth/jwks`** (`STAGING_GATE_EXEMPT_PATHS` in
  `middleware/staging-access.ts`) — that outbound fetch can't carry the staging
  key, and JWKS is public key material in prod anyway.

## Cached latest-releases endpoint

`GET /v1/releases/latest` is the unified feed endpoint behind CLI `tail`/`latest`
and (eventually) the public homepage activity feed. Params: `count` (1..100,
default 10), `source` (slug or id), `org` (slug or id, mutually exclusive
with `source`), and `include_coverage` (default false, hides coverage-side
rows).

Only the **default unfiltered shape** (no `source`, no `org`, default `count`,
`include_coverage=false`) is KV-cached — that's the homepage feed and the
`tail -f` hot path, and it collapses to a single key. Filtered variants fall
through to D1 directly (which handles the cardinality comfortably — see
issue #333 comments for the cost model). The handler sets
`X-Cache: HIT|MISS` on cached responses and `X-Cache: BYPASS` on
fall-through. Cache entries live in the `LATEST_CACHE` KV namespace
(`workers/api/src/lib/latest-cache.ts`) for 300 seconds; write-back on miss
is fire-and-forget via `ctx.waitUntil`. The 300s TTL is now a fallback
ceiling rather than the freshness floor: `invalidateLatestCache` purges
the cached key immediately after each publish (see
[events.md](events.md)), so typical staleness drops to seconds once
`INVALIDATION_ENABLED` is flipped to `"true"`.

Cache keys are built from the sorted filter params under prefix `latest:v1:`,
keyed on resolved source/org IDs so two callers for the same entity (slug
vs id) collapse onto the same entry. `ALLOWLISTED_CACHE_KEYS` in the cache
module is the hook for promoting specific filtered shapes (e.g., a hot org
page) into the cached set — empty by default; additions are an explicit
decision backed by analytics.

`tail --follow` polls this same cached endpoint with no extra params so every
follow-poller collapses onto the shared cache entry. Novelty detection lives
client-side via an in-memory seen-id set, not a server-side `since` filter —
a per-client `since` would fork the cache key and defeat the point.

## Rate limiting

`publicRateLimitMiddleware` (`workers/api/src/middleware/rate-limit.ts`) applies two independent Cloudflare Workers Rate Limiting bindings, each behind its own kill switch (both off by default, so initial deploys change nothing). Limit values live on the bindings in `wrangler.jsonc` — keep them out of user-facing docs. State is per-colo (CF constraint), not global. Wired only onto the public-read route group + `/graphql` in `workers/api/src/index.ts`, and only acts on safe (read) methods; admin routes are already key-gated.

- **Anonymous reads → per-IP** (`PUBLIC_RATE_LIMITER`, gated by `RATE_LIMIT_ENABLED`). An invalid/unrecognized Bearer credential falls here too, so a bogus token can't dodge the IP cap.
- **`relk_` tokens → per-token** (`TOKEN_RATE_LIMITER`, keyed by `tokenId`, gated by `TOKEN_RATE_LIMIT_ENABLED`). Closes the old "any valid token = unlimited" gap (#1100). On a 429 the response carries a distinct `"token"` policy in `RateLimit-Policy` and a `rate-limit`/`token-throttled` structured log. A flat quota for now; scope-tiered ceilings are deferred until user-facing tokens exist.
- **Exempt:** the static root key (CLI/MCP/scripts) and the trusted web-frontend proxy (`X-Releases-Proxy-Key`) bypass both limiters, so server-to-server and tooling traffic is never throttled.
- **Tier ladder:** anonymous per-IP (120/min, `PUBLIC_RATE_LIMITER`), authenticated free account per-userId (300/min, `USER_RATE_LIMITER` — `relu_` keys + OAuth-JWT users), machine per-token (600/min, `TOKEN_RATE_LIMITER`). Account-tier `relu_` verification is cached in `CREDENTIAL_CACHE` (~60s). Every limited request emits a `rate-limit`/`decision` log event (hashed `consumerRef` + `tier` + `rateLimited`) — the admin-queryable consumption stream in Axiom. Shared tier logic: `@releases/lib/rate-limit-tiers`.

Flip either var to `"true"` in `workers/api/wrangler.jsonc` and redeploy to activate.

### Auth-endpoint brute-force limiter (`/api/auth/*`)

Separate from the read-surface tiers above: Better Auth's own brute-force limiter protects the sign-in/up/credential endpoints. Originally `storage: "database"`, which made every tracked attempt a D1 read+write — a distributed credential-stuffing flood could write-amplify into the shared D1 and degrade unrelated traffic (#1728). It's now two layers, neither of which writes to D1 under flood:

- **Edge (per-IP, first gate):** a CF-native `AUTH_RATE_LIMITER` binding fronts **POST** `/api/auth/*` in the `src/index.ts` handler (`selectAuthEdgeLimiter`), rejecting abusive per-IP volume with a 429 before the auth instance is even built — no DB/KV write. GET session reads (`/get-session`, often polled behind shared NAT) are exempt. Kill switch `AUTH_EDGE_RATE_LIMIT_ENABLED` (default-on; only `"false"` opts out); absent binding (staging) → no-op.
- **Per-key (second layer, off D1):** when the dedicated `AUTH_RATE_LIMIT_KV` namespace is bound, `createAuth` wires `rateLimit.customStorage` (`auth/rate-limit-kv.ts`) so the per-key (IP+path) counters upsert to KV instead of D1; counters auto-expire (`AUTH_RATE_LIMIT_KV_TTL_SECONDS`). `customStorage` (not `secondaryStorage`) keeps sessions/verification on D1 — only the counters move. This path is the non-atomic check-then-increment (KV has no atomic `consume`), so per-key counting is best-effort under KV's eventual consistency; the strict edge limiter is the precise first gate. Absent binding → falls back to `storage: "database"` (local dev / staging). Fail-closed: `enabled` stays on in prod regardless of storage.
- **Residual (distributed botnets across many IPs):** the edge cap bounds per-IP D1/KV pressure but not aggregate volume from thousands of distinct IPs; an account-level Cloudflare WAF rate-limiting rule on the auth paths is the independent control for that (out of band, not in the worker).

## Schema + deployment

The API Worker lives at `workers/api/` and shares the Drizzle schema from `@buildinternet/releases-core/schema` (`packages/core/src/schema.ts`). D1 migrations are in `workers/api/migrations/`. Deploy with `cd workers/api && wrangler deploy`.

## Migrations

D1 schema DDL lives exclusively in `workers/api/migrations/`. Prod applies it via `wrangler d1 migrations apply --remote` (automated in the API-worker deploy). Tests apply the same files via `tests/db-helper.ts` → `applyMigrations(sqlite)`, ensuring prod and tests share a single schema history. `schema.ts` is the source of truth for drizzle ORM types and drizzle-kit introspection; `drizzle-kit generate` exists as a scaffold only — its output is gitignored under `.drizzle-out/`.

**`20260429000000_discovery_column.sql`** adds a `discovery TEXT` column (nullable, indexed) to both `organizations` and `sources`. Values: `'curated'` (backfilled on all pre-existing rows), `'agent'` (set by the discovery agent when it creates a row), `'on_demand'` (set by `POST /v1/lookups`). The column is the queryable handle for admin tooling and AI-feature gates (overviews, summarization, playbook regen all skip `discovery = 'on_demand'`). Per-source detail about on-demand materializations lives under `sources.metadata.lookup` (`{ coordinate, fetchedAt, lastRefreshedAt, emptyResult }`).

New migrations use a timestamp prefix (`YYYYMMDDHHMMSS_slug.sql`) to prevent filename collisions when two branches generate migrations concurrently. Existing numeric files (`0000..0011`) stay as-is — renaming them would break `d1_migrations` tracking state on already-migrated DBs. Wrangler sorts D1 files alphabetically and `"0011"` sorts before `"20260413..."`, so mixed ordering works. When two branches still manage to touch the same underlying table, resolve with a trivial merge of the conflicting files.

CI enforces two guardrails on every PR: `scripts/check-migration-filenames.sh` rejects new migration files added with a legacy `NNNN_` prefix, and a drift check runs `bunx drizzle-kit generate` against a clean data dir and fails if any schema change is detected (catches "edited `schema.ts` but forgot to run `bun run db:generate`"). Run the filename check locally with `bun run db:check-filenames`.

## Sessions + cron

Session management: `task list` shows active sessions, `task cancel <id>` requests cancellation. Sessions track active source slugs for duplicate detection — the CLI refuses to start a fetch if overlapping sources are already in-flight.

Cron polling: The API Worker runs an hourly `scheduled` handler that polls feed sources and fetches changed ones directly. Configure `GITHUB_TOKEN` as a Worker secret for GitHub source access. Tier intervals are controlled by `fetchPriority` on each source.

Workflows-based ingest (issue #486, follow-on to #482): the daily scrape-agent sweep at 01:00 UTC runs as a Cloudflare Workflow whenever the `SCRAPE_AGENT_WORKFLOW` binding is wired (always in prod) — each dispatch phase gets its own `step.do` boundary so a mid-sweep failure doesn't strand the tail. The hourly poll-and-fetch cron has the same treatment whenever `POLL_AND_FETCH_WORKFLOW` is bound: the cron queries due sources (tier intervals still apply — normal=4h, low=24h — so only a fraction of sources are due on any given hour) and `createBatch`es one `POLL_AND_FETCH_WORKFLOW` instance per source, with step-level retries around `fetch-and-persist`, `embed-releases`, `refresh-changelog-file`, `embed-changelog-chunks`, and `invalidate-latest-cache`. The embed steps get 5 retries × 30s exponential — the whole reason for the migration is ride-out tolerance for Voyage 429s mid-source. `packages/search/src/embed-releases.ts` and `embed-changelog-pipeline.ts` accept an opt-in `throwOnError` so the workflow can actually observe failures; default callers stay fire-and-forget. Inline `pollAndFetch()` remains the fallback when the Workflow binding is absent.

### SourceActor — per-source fetch scheduling (#1776)

A per-source Durable Object (`SOURCE_ACTOR.getByName(sourceId)`, `workers/api/src/source-actor.ts`) that owns a single source's fetch lifecycle: its own alarm-driven timer, tier cadence (normal 4h / low 24h), smart-fetch backoff, and single-threaded serialization. Each migrated source self-schedules instead of being swept up by the hourly poll cron + due-query + FNV-1a jitter smear. **Migration seam (deliberate): the DO owns the timer + mutex only — the proven `PollAndFetchWorkflow` still does all fetch/parse/embed/ingest, `create()`d from the alarm.** The actor never recomputes backoff: each alarm re-reads the source's D1 row and derives the next-due time from `computeFetchState()` (the same helper the dev fetch-plan panel uses), since the workflow already writes `last_polled_at` / `next_fetch_after` / `consecutive_no_change` to D1. Not-due ⇒ reschedule forward (alarms are ~free, so this is idempotent — a double-fire just re-reads D1); due ⇒ fire one ingest workflow + reschedule one interval out; `paused` / firecrawl (webhook-driven) / org-paused / no-longer-in-cohort ⇒ stop. A never-polled source (`null last_polled_at`) fetches on its first alarm (honoring the cron's "null ⇒ due now" semantics) rather than waiting a full interval. Double-fires are prevented by an in-flight guard (a 15-min `SAFETY_WINDOW` longer than the worst-case ingest run) plus a workflow instance id bucketed by that window, so a spurious re-alarm collides on the id instead of spawning a second run.

Cohort rollout is gated by the Flagship boolean `source-actor-enabled` (master switch / kill switch) **and** the `SOURCE_ACTOR_COHORT_PCT` wrangler var (0–100): a source is actor-managed iff the binding is present, the flag is on, and `fnv1a(sourceId) % 100 < pct` (`isSourceActorManaged` in `workers/api/src/lib/source-actor-cohort.ts`). The **same predicate gates both** the cron's fan-out split (`fanOutPollAndFetch` partitions the due list: managed sources go to the actor's idempotent `ensureScheduled` seed/heartbeat, the rest fan out as workflows — a source is never driven by both) **and** the actor's own alarm, so flipping the flag off or lowering the pct cleanly hands a source back to the cron with no double-driving (its next alarm re-checks the gate and stops; the cron re-seeds it once due). At a cohort enable, the first alarm is spread across a 5-min seed-jitter window so simultaneously-overdue sources don't thunder; after the first fetch each source's `last_polled_at` differs, so subsequent alarms land at distinct times (emergent jitter). The cron is the binding-absent fallback (mirrors the Workflow treatment above). D1 stays the system of record — DO storage holds only derived, rehydratable coordination state (re-read from D1 every alarm, so eviction is free); a best-effort write-through mirror into `metadata.sourceActor` (`{ managed, nextAlarmAt, lastAlarmAt }`, no new column/migration) keeps the dev fetch-plan panel showing actor-managed status. The three per-source coordination bolt-ons that emulate a mutex on the **MA scrape/agent delegation path** (the KV `ma:active:src:*` lock, the update session-dedup window, and the `skipDelegation` guard) are intentionally left in place — the actor does not yet own that path; their retirement is tracked in #1780. Cross-source reconciliation (`ProductActor`) is deferred (#1777). Sequencing + design: `docs/architecture/durable-objects-exploration.md`; epic #1778.

### OrgActor — per-org scrape/agent drain (#1777)

Retires the `force-drain-sweep` (#518) producer and `scrape-agent-sweep` (#482) consumer crons by moving both jobs onto the actor model the `SourceActor` established above. On its regular poll alarm, `SourceActor` self-flags a `type in (scrape, agent)` source — sets `changeDetectedAt` — when its `changeDetector` is `unreliable` or it is stale (`lastFetchedAt` older than `FORCE_DRAIN_STALE_HOURS`, default 72h), which is the same signal the retired force-drain-sweep used to set on a cron tick. The notify RPC to `ORG_ACTOR.getByName(orgId).ensureDrainScheduled(orgId)` is driven off the `Source` row `SourceActor` loads at the **top** of `alarm()` — before that same firing's workflow runs and (possibly) sets `changeDetectedAt` — so the notify that arms `OrgActor` actually fires on the alarm _following_ the one whose workflow flagged the source: first arming can lag the flag by up to one tier interval (4h/24h), not just the RPC-drop case. Once notified, `OrgActor` arms a jittered alarm on the per-org `OrgActor` DO (`workers/api/src/org-actor.ts`) if one isn't already armed. On its own alarm, `OrgActor` queries its org's flagged scrape/agent candidates (the same filter the retired sweep used: not paused/hidden/firecrawl/feed, org not `fetch_paused`) and dispatches a single `POST /update` managed-agent session for the batch — one session per org per drain pass, same as the sweep. The `OrgActor` holds no budget or lock logic of its own: the discovery `/update` endpoint already enforces the per-org ($2/day) and global ($15/day) spend cap (`checkSpendCap`) and the per-source scrape lock (#1815) before minting a session, so a rejected dispatch (cap hit or locked) is logged and dropped — the source stays flagged and re-drains on the next `SourceActor` notify, since the recurring poll alarm is the at-least-once safety net (no markers table needed).

The whole path is gated by the Flagship boolean `org-drain-actor-enabled` — a genuine kill switch, since with no in-app budget layer it is the only guard on a billable path: off ⇒ the self-flag and `OrgActor` notify are inert and `force-drain-sweep` + `scrape-agent-sweep` run exactly as before; on ⇒ the actor path drives and both crons early-return, logging `superseded-by-org-drain-actor` instead of `done`. The per-source scrape lock (#1815) also prevents a double-dispatch during a flag-flip overlap window. Rollback is a single flag flip back to off — the crons resume draining on their next scheduled tick. Design: `docs/superpowers/specs/2026-07-01-orgactor-drain-coordinator-design.md`; plan: `docs/superpowers/plans/2026-07-01-orgactor-drain-coordinator.md`.

#### Deterministic `update` path (#1878)

A routine `POST /update` is a deterministic fetch→extract pipeline: the worker agent (Haiku Managed-Agents session) only ever issued one batch of `manage_source(fetch)` calls, and every real decision (URL, crawl vs render, incremental vs seed, dedup, retry) already lives in host-side `scrapeFetch`. The agent shell paid a fixed ~19k-token prompt+skills+playbook cache-creation tax per session (~84% of the session cost), so as the drain above scaled the number of `/update` sessions, cost scaled with it. Gated by the Flagship boolean `deterministic-update-enabled` (default off): on ⇒ `ManagedAgentsSession.runSession` short-circuits the update path to `runDeterministicUpdate`, which loops `scrapeFetch` over the batch's sources directly (`deterministic-update.ts`) with **no** Anthropic session — the per-source extraction sub-calls (incremental Haiku, or the DeepSeek/OpenRouter tool-loop) still run and self-log `ai_usage`. The flag is necessary but not sufficient: the short-circuit only fires when the scrape secrets (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`) are present, since it reuses the same `scrapeHandler` closure the agent path builds — that closure is `undefined` without them. So a worker without scrape secrets falls through to the legacy managed-agent session even with the flag on. Off (or scrape secrets absent) ⇒ the legacy worker-agent session runs unchanged; rollback is a single flag flip. Trade-offs vs. the agent path: the model-driven `manage_playbook(update_notes)` reconciliation is dropped (playbook _config_ is deterministic source metadata, unaffected), and the batch's spend is no longer recorded to the KV session-spend counter (there is no session-level estimate — extraction cost is small and self-logged). A batch where every source fails is still reported as a terminal session failure, matching the agent path.

## Display URL vs. fetch routing

`source.url` is the canonical, human-readable address — what we link people to from the catalog, search results, and rendered release rows. Fetch routing lives in `source.metadata`. The two intentionally diverge: machine-friendly endpoints (RSS, GitHub APIs, raw markdown) feed ingest; the human-friendly page is the only thing users ever see.

Today's example: a `scrape` source's `source.url` points at the docs/changelog page, while `metadata.feedUrl` (auto-discovered on first add) is the actual RSS/Atom/JSON feed the cron polls and parses. The same principle applies to GitHub-backed docs pages via `metadata.githubUrl` (#831): when a docs page is generated from a GitHub-hosted CHANGELOG, set `metadata.githubUrl = "https://github.com/owner/repo"` to make the cron and onboarding paths fetch from the repo's GitHub releases API while keeping `source.url` pointed at the docs page. Each ingested release URL is rewritten through `synthesizeReleaseUrl` (default: `${sourceUrl}#${versionDashed}` — Mintlify anchor convention) so dedup against any pre-existing scrape rows lines up via `UNIQUE(source_id, url)`. Per-product anchor schemes go in `metadata.releaseUrlTemplate` (`${sourceUrl}`, `${version}`, `${versionDashed}` placeholders).

When adding a new fetch backend, the test is: would a human ever want to land on this URL directly? If no, it goes in metadata, not `source.url`.

## Feed change detection + retier

`releases admin source poll` uses HTTP HEAD requests to flag sources with upstream changes (`changeDetectedAt` column). `releases admin source fetch` uses HEAD as a pre-filter to skip unchanged feeds. Both are purely mechanical — no AI or content parsing involved. The API Worker's hourly cron polls feed sources on tier-based intervals (`fetchPriority`: normal=4h, low=24h, paused=never) and directly fetches changed sources that have a usable feed path — `feed`, `github`, and `scrape` sources whose `metadata.feedUrl` was auto-discovered on first add. Agent sources and scrape sources without a feed are flagged (`changeDetectedAt`) for processing by the daily scrape-no-feed sweep at 01:00 UTC (`workers/api/src/cron/scrape-agent-sweep.ts`) which dispatches per-org `POST /update` calls to the discovery worker, or manually via `releases admin source fetch --changed`.

Self-healing: a `feedUrl` that returns 4xx is tracked via `metadata.feed4xxStreak` (incremented on every 4xx, reset on success). After `FEED_4XX_INVALIDATE_THRESHOLD` (5) consecutive 4xx, the cron clears the feed metadata and resets `noFeedFound: false` so the next fetch re-discovers from the source URL. Sub-threshold 4xx deliberately skips the generic `consecutiveErrors` backoff — it would push the next retry out by hours and slow self-healing. 5xx remains a transient error and applies normal backoff.

A second daily cron at 03:00 UTC (`workers/api/src/cron/retier.ts`) recomputes `fetchPriority` from the median `publishedAt` gap in the last 180 days: ≤14d → normal, 14-90d → low, >90d preserves the current tier. Never auto-pauses (manual vs automatic overrides aren't tracked yet), never touches sources that are already `paused`, and skips tier changes for sources with <3 releases of signal. The retier persists its signal on every source it evaluates via `sources.medianGapDays` (REAL; null when <3 releases of signal) and `sources.lastRetieredAt` (ISO timestamp); the API returns both on `GET /v1/sources`, and the dev-gated status dashboard (`web/src/app/status/`) renders them as a Cadence column that flags mismatches between cadence and tier (e.g. a paused source still shipping on a 5-day median). The `lastPolledAt` column tracks when each source was last polled by the cron.

## List endpoints

`GET /v1/sources` supports `?limit=<n>` (default 100, hard cap 500) and either `?offset=<n>` or `?page=<n>` (1-indexed). Returns a bare `SourceWithOrg[]` by default for backward compatibility. Pass `?envelope=true` to get a paginated shape: `{ items, pagination: { page, pageSize, returned, totalItems, totalPages, hasMore } }`. The envelope path runs one extra COUNT query against the same `whereClause`, so it's cheap but not free — callers that only need one page's data can stick with the bare array. The published `@buildinternet/releases-core/cli-contracts` types (`ListResponse<T>`, `Pagination`) match this shape.

CLI-facing list endpoints added before v1 return the envelope by default: `GET /v1/orgs`, `GET /v1/sessions`, `GET /v1/admin/blocklist`, `GET /v1/orgs/:slug/ignored-urls`, `GET /v1/products`, `GET /v1/orgs/:slug/accounts`, and `GET /v1/orgs/:slug/tags`. They all accept `?limit=<n>` and `?page=<n>` with `DEFAULT_PAGE_SIZE` from `@buildinternet/releases-core/cli-contracts` (500) as both the default and hard cap. The shared API helper is `workers/api/src/lib/pagination.ts`; use it for new page/limit list endpoints unless the endpoint has an existing cursor contract. Some routes keep single-row lookup modes (`?single=true`, `?platform=...`) returning their legacy raw row/null shape.

## Discovery guardrails

The discovery worker checks `GET /v1/sessions?type=onboard&recent_minutes=10` before spawning a new session and reads `items` from the paginated response. Returns 409 if the same company (case-insensitive) is already being discovered OR finished within the last 10 minutes (the dedup window — see #656); 429 if 5+ onboard sessions are currently running. Uses a service binding (`API_WORKER`) for Worker-to-Worker communication. `GET /v1/sessions` supports `?status=`, `?type=`, and `?recent_minutes=N` filters; `recent_minutes` keeps any session that's currently `running` OR was last updated within N minutes (running sessions are always included regardless of staleness). The 5-session concurrency cap is computed from running-only sessions on the discovery worker side, so a recently finished session doesn't tie up the budget.

Per-session estimated cost (model id, cache_creation/cache_read/input/output tokens, list-price USD) is captured by the discovery DO via `@releases/lib/anthropic-pricing` on both successful completions AND error terminal events (provider `session.error`, retries-exhausted idle), then stored on `SessionState.usage`. The web `/status` page renders it under each session card with an `≈ $` qualifier so it isn't mistaken for billed cost. See #657.

## Realtime streaming

`GET /v1/releases/stream` is a public WebSocket that emits `release.created`
events as they land in D1. Backed by the global `ReleaseHub` Durable Object
with hibernation. The CLI's `tail -f` uses this stream in remote mode and
falls back to polling `/v1/releases/latest` on transport failure or
`snapshot_gap`. See [events.md](./events.md).
