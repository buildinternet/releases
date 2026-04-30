# On-Demand GitHub Repo Lookup

**Status:** Proposed
**Date:** 2026-04-29
**Owner:** zach@buildinternet.com

## Goal

When a user searches for a GitHub coordinate (`org/repo`) we don't already index, return useful results within a single request — both an inline preview from GitHub and a persisted, hidden source so subsequent searches resolve as normal cache hits. Distinguish three outcomes cleanly: valid repo with releases, valid but empty (no releases / no `CHANGELOG.md`), and not-found / private / archived. When the org is already known but the specific repo isn't, surface a "did you mean" rail listing the org's existing sources.

This increases search utility for the long tail of repos we haven't curated, without paying for the full AI pipeline (overviews, summarization) on every speculative lookup.

## Non-goals (v1)

- **Promotion workflow.** Flipping `discovery` from `on_demand` → `curated` and clearing `isHidden` is the entire promotion ceremony. We make the column writeable; we do not build an admin UI or auto-promotion in this spec.
- **Provider expansion.** `/v1/lookups` accepts a `provider` field, but only `github` is implemented. npm, GitLab, PyPI, etc. follow the same shape but are not in scope here.
- **Async "indexing now, check back later" UX.** Every lookup blocks until the GitHub probe completes (sub-second) and ingest completes for repos with reasonable release counts. Large-repo timeouts fall back to a `deferred` status the client can poll.
- **Auto-overview generation when an on-demand source becomes popular.** Search-volume thresholds, threshold-triggered AI features, etc. are deferred.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Search request hits /v1/search (or MCP search/search_releases)  │
│  → no entity match                                              │
│  → query parses as `org/repo`?  ──no──→ normal empty response   │
│                  │ yes                                          │
│                  ▼                                              │
│  POST /v1/lookups { provider:"github", coordinate:"org/repo" }  │
│  (called inline, awaited)                                       │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ /v1/lookups handler                                             │
│                                                                 │
│  Step 0: Resolve org context (always run, cheap DB lookup)      │
│    • Match `org` segment against:                               │
│        - orgs.slug                                              │
│        - orgs.githubOrg (parsed from existing source URLs       │
│          where unset)                                           │
│        - domain_aliases for github.com/{org}                    │
│    • If unambiguous match → attach `relatedOrg` + a few         │
│      sibling sources to every response below ("did you mean")   │
│                                                                 │
│  Step 1: Negative-result cache hit?                             │
│    → return { status:"not_found"|"empty", relatedOrg? }         │
│                                                                 │
│  Step 2: Existing source for coordinate?                        │
│    → return existing + inline preview + relatedOrg?             │
│                                                                 │
│  Step 3: GitHub probe: HEAD /repos/{org}/{repo}                 │
│    ├─ 404/403/archived → cache negative; return                 │
│    │     { status:"not_found", relatedOrg? }                    │
│    ├─ 200, no releases & no CHANGELOG → empty stub source;      │
│    │     return { status:"empty", source, relatedOrg? }         │
│    └─ 200, has data    → full path                              │
│                                                                 │
│  Step 4: Full path:                                             │
│    • Reuse existing org if Step 0 matched; else insert hidden   │
│      org with discovery="on_demand"                             │
│    • Insert source: discovery="on_demand", isHidden=true,       │
│      metadata.lookup = { coordinate, fetchedAt, ... }           │
│    • Run github adapter inline → ingest releases                │
│    • waitUntil: embed releases; skip overview + summarization   │
│    • Return source + inline release preview + relatedOrg?       │
└─────────────────────────────────────────────────────────────────┘
```

### Did-you-mean precision

Return `relatedOrg` only when the org match is unambiguous (exact slug match, exact `githubOrg` match, or single domain alias). Multi-match → no rail. Avoids "did you mean Apple Inc?" when someone typed `apple/foo`.

## Components

### 1. `packages/adapters/src/github-probe.ts` — `probeRepo` helper

New function: `probeRepo(org, repo) → { exists, archived, hasReleases, defaultBranch, hasChangelog }`. Single `HEAD /repos/{owner}/{repo}` call (existing auth/rate-limit handling). For repos that exist, follow up with a lightweight content listing to detect `CHANGELOG.md`. Used by Step 3.

### 2. `workers/api/src/routes/lookups.ts` (new) — `POST /v1/lookups`

Owns the orchestration in the diagram above. Public route, rate-limited per IP/key. Writes go through the existing `findOrCreateOrg` and `RELEASE_URL_UPSERT` helpers so dedup, primary-source rules, and existing migrations all apply unchanged.

Request body:

```json
{ "provider": "github", "coordinate": "acme/random-sdk" }
```

Response shape (success):

```json
{
  "status": "indexed" | "existing" | "empty" | "not_found" | "deferred",
  "source": { /* source row, present except on not_found */ },
  "releases": [ /* inline preview, present on indexed/existing */ ],
  "relatedOrg": {
    "id": "org_...",
    "slug": "acme",
    "name": "Acme",
    "sources": [ /* top 3-5 by recent activity */ ]
  } | null
}
```

### 3. `packages/core/src/lookup-coordinate.ts` (importable as `@buildinternet/releases-core/lookup-coordinate`)

Pure parser: `"acme/random-sdk"` → `{ provider: "github", org: "acme", repo: "random-sdk" }` or `null`. Centralizes the regex (`^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`) so search routes and the lookup handler stay in sync.

### 4. `workers/api/src/lib/lookup-related-org.ts` (new)

Performs the Step 0 org resolution. Returns `{ org, sources }` or `null`. Reused by the search-fallback path even when no on-demand action is taken (a bare `acme/` query can also surface the rail).

### 5. Negative-result cache

KV namespace (reuse `LATEST_CACHE`). Key: `lookup:{provider}:{org}/{repo}` (lowercased). Value: `{ status: "not_found" | "empty", checkedAt }` — expiry is enforced via the KV `expirationTtl` (no in-payload `expiresAt`). TTLs: **24h** for `not_found`, **6h** for `empty` (empty repos are more likely to gain content). Step 1 short-circuits on hit. Implementation in `workers/api/src/lib/lookup-neg-cache.ts`.

### 6. Search wiring

In `workers/api/src/routes/search.ts`, after the existing fallback enrichment misses, parse the query as a coordinate and call into the lookup handler in-process. The MCP wiring lives in `workers/mcp/src/mcp-agent.ts`: a single `maybeLookup(out, query)` helper is invoked from the `search` and `search_releases` tool registrations after `searchTool(...)` reports zero hits. It POSTs to the API service binding (`env.API.fetch("https://internal/v1/lookups", ...)`) with `Authorization: Bearer ${RELEASED_API_KEY}` (and the staging gate header in staging). The lookup payload is rendered into the tool's text response so MCP clients see the result inline.

### 7. Schema migration

Add `sources.discovery` (`text`, NOT NULL DEFAULT `'curated'`, indexed) with allowed values `curated` / `agent` / `on_demand`. The DEFAULT clause backfills existing rows to `curated`. No change to `metadata` shape — on-demand details land under `metadata.lookup`:

```json
{
  "lookup": {
    "coordinate": "acme/random-sdk",
    "fetchedAt": "2026-04-29T12:34:56Z",
    "lastRefreshedAt": "2026-04-29T12:34:56Z",
    "emptyResult": false
  }
}
```

The same `discovery` column lands on `orgs` (so on-demand orgs are filterable too).

## Data flow

### Cold first hit (`acme/random-sdk` exists, has releases)

```
client → /v1/search?q=acme/random-sdk
  → no FTS / entity match
  → coordinate parses → POST /v1/lookups internally
    → resolveRelatedOrg(acme) → null (acme unknown)
    → KV neg-cache miss
    → no existing source row
    → github.probeRepo → { exists: true, hasReleases: true }
    → insert org "acme" (hidden, discovery=on_demand)
    → insert source "acme/random-sdk" (hidden, discovery=on_demand)
    → adapter.fetch → ingest 12 releases
    → waitUntil(embedReleases)
    → return { status: "indexed", source, releases, relatedOrg: null }
  → /v1/search merges lookup payload into response
client renders: source card + inline releases + "indexed just now" badge
```

### Cold first hit (`acme/random-sdk` doesn't exist, but acme is known)

```
client → /v1/search?q=acme/random-sdk
  → no match
  → POST /v1/lookups
    → resolveRelatedOrg(acme) → { org: acme, sources: [acme/foo, acme/bar] }
    → github.probeRepo → 404
    → KV neg-cache write (24h TTL)
    → return { status: "not_found", relatedOrg: { ... } }
client renders: "we couldn't find acme/random-sdk" + "from acme: acme/foo, acme/bar"
```

### Warm second hit

```
client → /v1/search?q=acme/random-sdk
  → entity match on source slug (acme/random-sdk lives in DB now)
  → normal search path returns hits
  → no /v1/lookups call needed
```

### Refresh cadence

On-demand sources fold into the existing smart-fetch cron. Default tier: `low` (24h interval) so they don't compete with curated sources for cron budget. Empty-result stubs polled at the long end of the no-change backoff (up to 48h). Existing exponential backoff on `consecutiveNoChange` / `consecutiveErrors` applies unchanged.

## AI feature gating

On-demand sources get **embeddings only** in v1:

- **Embeddings:** yes. Releases get embedded via the existing `waitUntil(embedReleases)` path so semantic search works on the second hit. Without this, the warm-search experience would be worse than the cold one.
- **Org overviews:** no. The overview workflow already gates on staleness; we add a check that skips orgs where `discovery = 'on_demand'`.
- **Release summarization:** no. Same gate applied wherever summarization is triggered.

The `discovery = 'on_demand'` column is the single queryable handle that admin tooling, cron jobs, and AI-feature gates all read from. `metadata.lookup` carries the per-source detail (coordinate, timestamps, empty-flag).

## Error handling

| Case                                          | Behavior                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub rate-limit hit during probe            | Return `{ status: "deferred", relatedOrg? }`. Do **not** write a negative cache entry. Web shows "indexing — try again shortly".                                 |
| GitHub 5xx                                    | Same as rate-limit: retryable, no negative cache.                                                                                                                |
| Adapter ingest fails _after_ source insert    | Source row stays (it's hidden). Log error. Return `status: "indexed"` with empty `releases` array. Next cron tick retries via existing smart-fetch loop.         |
| Embed failure                                 | Already best-effort via `waitUntil`; logged, doesn't fail the response.                                                                                          |
| Coordinate parse fails / unsupported provider | `400` with explicit error code (`E_LOOKUP_BAD_COORDINATE` / `E_LOOKUP_UNSUPPORTED_PROVIDER`). Callers must not retry.                                            |
| `/v1/lookups` rate-limit                      | Per-IP and per-key budget separate from search budget — one search shouldn't exhaust the lookup budget. Default: 60/hour per IP, 600/hour per authenticated key. |

## Testing

- **Unit:** coordinate parser — valid, invalid, edge cases (`org/repo.with.dots`, `org/repo-`, leading/trailing slashes, double slashes, unicode).
- **Unit:** `resolveRelatedOrg` — exact slug match, githubOrg match, domain alias, multi-match (returns null), no-match (returns null).
- **Integration (mocked GitHub):**
  - Cold path with releases.
  - Cold path with empty repo (200 but no releases / no CHANGELOG).
  - 404 / 403 / archived.
  - Rate-limit response → deferred.
  - 5xx → deferred.
- **Integration:** idempotency — calling `/v1/lookups` twice in quick succession produces one `sources` row. Note: the existing `UNIQUE(source_id, url)` constraint is on the `releases` table (per-source release dedup); it does **not** cover the `sources` table itself. The handler is responsible for guarding against a double source insert (currently: a `SELECT … WHERE url = ?` short-circuit at the top of `runLookup` plus an `onConflictDoNothing` slug-collision retry on the insert).
- **Integration:** `relatedOrg` rail appears in 404 and `empty` responses when the org is known.
- **Integration:** AI gating — on-demand source insert does not trigger overview generation; verify by asserting no row in `knowledge_pages` with `scope='org'` for the on-demand org.
- **Smoke (CLI):** `releases search 'vercel/next.js'` against a fresh staging DB → expect inline preview + cache promotion on second search.

## Open questions

None blocking. The promotion path, async UX, and provider expansion are listed as explicit non-goals above.
