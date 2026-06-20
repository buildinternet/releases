# Plan 002: Upgrade intelligence Phase 1 — `whats_changed` (single package, version-bounded diff)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Honor
> the "STOP conditions". When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 8f811cb5..HEAD -- packages/core/src/changelog-slice.ts packages/core/src/version-sort.ts workers/api/src/routes workers/mcp/src/tools.ts`
> Compare the "Current state" excerpts against live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (new public endpoint + name→source resolution coverage is fuzzy)
- **Depends on**: plan 001 (soft — see below)
- **Category**: direction
- **Planned at**: commit `8f811cb5`, 2026-06-20
- **Issue**: https://github.com/buildinternet/releases/issues/1697

## Why this matters

This is the wedge feature for the agent-native channel (#1701). An agent can't
visit N changelog pages to plan an upgrade, but it can make one call. Phase 1 is
the smallest end-to-end slice that delivers it: **given one package and a
`from`/`to` version, return the ordered changelog entries in that range, their
summaries, and (when available) their breaking flags.** It reuses primitives
that already exist; the net-new part is composing them behind one endpoint and
resolving a package name to a tracked source. Phase 2 (`upgrade_plan` over a
whole manifest, #1697) builds on this — do not attempt it here.

**Soft dependency on plan 001**: ship the response with an optional `breaking`
field from day one. If 001 has landed, populate it from the column; if not,
return `"unknown"`. Either way the contract doesn't change when 001 lands.

## Current state

- `packages/core/src/version-sort.ts:30` — `computeVersionSort(version): string | null`,
  the lexicographically-sortable semver key. The `releases` table already stores
  it: `versionSort: text("version_sort")` (`packages/core/src/schema.ts:442`),
  indexed by `idx_releases_source_version_sort` (`schema.ts:485`). This is how
  you order/bound releases by version without parsing semver at query time.
- `packages/core/src/changelog-slice.ts` — version-range slicing of a CHANGELOG
  body: `resolveChangelogRangeParams()` (`:212`), `sliceChangelog()` (`:127`),
  `buildChangelogResponse()` (`:317`), `CHANGELOG_TOKEN_BRACKETS` (`:36`). Used
  today by the `get_catalog_entry` MCP path and the changelog REST route.
- `packages/core/src/changelog-range.ts` — `parseRangeParam()` (`:9`),
  `DEFAULT_CHANGELOG_SLICE_LIMIT` (`:7`).
- REST route exemplars: `workers/api/src/routes/changelog.ts` (changelog slice
  endpoint) and `workers/api/src/routes/releases.ts` (release list/get). Follow
  their Hono handler shape, pagination, and error conventions.
- MCP tool registration: `workers/mcp/src/tools.ts` (+ `mcp-agent.ts`). New tools
  are registered here; read tools are public (no token).
- Source resolution today: `workers/api/src/routes/lookups.ts` materializes a
  GitHub `org/repo` coordinate on demand. There is **no** npm/PyPI name→source
  map yet — that's #1345, a precursor. Phase 1 resolves only what's already
  resolvable (exact catalog match + GitHub coordinate); npm/PyPI names that
  aren't in the catalog return `unknown` (see STOP conditions).
- CLI is **out of tree** — `~/Code/releases-cli` (`@buildinternet/releases`). Do
  not add CLI commands in this repo; note the CLI surface as a follow-up in the
  issue instead.

## Commands you will need

| Purpose                   | Command                                                                     | Expected on success |
| ------------------------- | --------------------------------------------------------------------------- | ------------------- |
| Worktree bootstrap (once) | `./scripts/setup-worktree.sh`                                               | exit 0              |
| Typecheck (root)          | `npx tsc --noEmit`                                                          | exit 0              |
| Typecheck (api / mcp)     | `cd workers/api && npx tsc --noEmit` ; `cd workers/mcp && npx tsc --noEmit` | exit 0              |
| Tests                     | `bun test`                                                                  | all pass            |
| Lint                      | `bun run lint`                                                              | exit 0              |

## Scope

**In scope:**

- `packages/core/src/` — a pure `resolveUpgradeRange()` helper (compose
  version-sort + slice) + unit tests. Keep it runtime-neutral (core is
  zod-free; see AGENTS.md).
- `workers/api/src/routes/` — a new `GET /v1/whats-changed` (or `/v1/releases/whats-changed`)
  route. Match the route-naming buckets in `docs/architecture/routing.md`.
- `packages/api-types/` — request/response types for the endpoint (additive).
- `workers/mcp/src/tools.ts` — register a `whats_changed` read tool that proxies
  the API route over the existing `API` service binding.

**Out of scope (do NOT touch):**

- Manifest parsing / `upgrade_plan` (Phase 2).
- npm/PyPI name→source ingestion (#1345) — resolve only what's resolvable today.
- The CLI (separate repo).
- Any change to `changelog-slice.ts` internals — call them, don't refactor them.

## Git workflow

- Branch: `advisor/002-whats-changed`.
- Conventional commits (`feat(api): whats_changed upgrade-range endpoint`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Core helper — `resolveUpgradeRange`

In `packages/core/src/`, add `upgrade-range.ts` exporting a pure function that,
given a source's releases (`{version, versionSort, publishedAt, summary,
breaking?, content}[]`) and `{from, to}`, returns the ordered subset in
`(from, to]` using `versionSort` for bounds (fall back to `publishedAt` order
when a version lacks numeric content / `versionSort` is null). No DB, no fetch —
inputs in, structured result out. Mirror the style of `changelog-slice.ts`.

**Verify**: `bun test packages/core` → new unit tests pass (see Test plan).

### Step 2: API route

Add `GET /v1/whats-changed?package=<name>&from=<v>&to=<v>&ecosystem=<npm|pypi|github>`
in a new `workers/api/src/routes/whats-changed.ts`, registered like the other
routes. It:

1. Resolves `package`(+`ecosystem`) → a source id (exact catalog match first;
   GitHub coordinate via the existing lookup path; else `status: "unknown"`).
2. Loads that source's releases, calls `resolveUpgradeRange`.
3. Returns `{ status: "resolved"|"unknown", source?, from, to, entries: [{version, publishedAt, summary, breaking, url}], truncatedAtTokens? }`.

Respect `CHANGELOG_TOKEN_BRACKETS` for body budgeting. Return `breaking` from the
column if plan 001 landed, else `"unknown"`.

**Verify**: `cd workers/api && npx tsc --noEmit` → exit 0; route smoke test (see
Test plan) passes.

### Step 3: api-types

Add the request/response shapes to `packages/api-types/` (additive). Re-use
existing release sub-shapes where possible.

**Verify**: `npx tsc --noEmit` at root + workers → exit 0.

### Step 4: MCP tool

Register `whats_changed` in `workers/mcp/src/tools.ts` as a public read tool
that forwards to the API route over the `API` service binding (mirror how an
existing read tool proxies). Keep the input schema small: `package`, `from`,
`to`, optional `ecosystem`.

**Verify**: `cd workers/mcp && npx tsc --noEmit` → exit 0; `bun test workers/mcp` → pass.

## Test plan

- `resolveUpgradeRange` unit tests (`packages/core`): in-range subset correct;
  `to` inclusive / `from` exclusive; version with null `versionSort` falls back
  to date order; empty range → empty entries, not error.
- API route smoke test (model after `workers/api/src/routes/health.test.ts` /
  the in-process route harness in memory `reference_worker_route_inprocess_smoke`):
  resolved package returns entries; unknown package returns `status: "unknown"`
  with HTTP 200 (not 404 — unknown is a valid answer).
- MCP tool test: tool registered, forwards, returns the resolved shape.
- Verification: `bun test` → all pass incl. the new tests.

## Done criteria

- [ ] `npx tsc --noEmit` exits 0 at root, `workers/api`, `workers/mcp`.
- [ ] `bun test` exits 0; new core + route + tool tests pass.
- [ ] `GET /v1/whats-changed` returns ordered, version-bounded entries for a
      catalog package and `status:"unknown"` (HTTP 200) for an unresolvable one.
- [ ] The response carries a `breaking` field (populated if 001 landed, else `"unknown"`).
- [ ] No change to `changelog-slice.ts` internals (`git diff` shows none).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- `version-sort.ts` / `changelog-slice.ts` signatures differ from "Current state".
- More than ~half of common test packages resolve to `unknown` — that means
  name→source coverage (#1345) is the real blocker and Phase 1's value is gated
  on it; report before adding any bespoke name-mapping hacks.
- The route would need to fan out live fetches to build a range (it must read
  already-ingested releases only; live fetching is out of scope).
- Resolving a package requires writing/materializing a source as a side effect of
  a _read_ tool — STOP (that's the confused-deputy pattern the MCP auth model
  guards against; see `docs/architecture/mcp.md`).

## Maintenance notes

- Phase 2 (`upgrade_plan` over a manifest) fans this out per dependency and
  aggregates — design the Phase 1 response so a manifest result is just a map of
  these. Cache by `(sourceId, from, to)`.
- When #1345 lands npm/PyPI coordinates, the resolver's `unknown` rate drops —
  revisit the resolution step then.
- The CLI surface (`releases whats-changed <pkg> <from> <to>`) is a follow-up in
  the separate CLI repo.
- Reviewer should scrutinize: unknown packages return 200 (a valid answer, not an
  error); the read tool performs no writes; token budgeting honored on big bodies.
