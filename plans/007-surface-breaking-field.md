# Plan 007: Surface the breaking-change field on read routes + web (issue #1710, part 1)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3238d540..HEAD -- workers/api/src/queries/ workers/api/src/routes/sources.ts packages/api-types/src/ web/src/components/release-item.tsx "web/src/app/release/[id]/release-content.tsx"`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW–MED (additive wire change to a published types package; UI change)
- **Depends on**: none (plan 001 of the 2026-06-20 run — the `breaking` column + ingest classification — is already merged, #1703)
- **Category**: direction (product — agent-native wedge, umbrella #1701)
- **Planned at**: commit `3238d540`, 2026-07-02
- **Issue**: https://github.com/buildinternet/releases/issues/1710

## Why this matters

Since #1703 merged, every qualifying ingest classifies releases into
`releases.breaking` (`unknown`/`none`/`minor`/`major`) plus `migration_notes`
— but the data is effectively write-only: only the `whats_changed` route
returns it. Agents hitting `GET /v1/releases/:id` or the list feeds, and every
human on the web UI, can't see the single field the agent-native pivot
(#1701) is built around. This plan closes the read-side gap: the field rides
the general release read paths and the web shows a "Breaking" chip +
migration notes. **Deliberately out of this plan:** the webhook `breaking`
filter from issue #1710's third checkbox (it needs a subscription-storage
design of its own) and the historical backfill (#1711, cost-gated).

## Current state

Where the data lives and who already reads it:

- Column: `releases.breaking` (text enum) + `releases.migration_notes` —
  schema in `packages/core/src/schema.ts`; level type
  `BreakingLevel` from `@buildinternet/releases-core/breaking`
  (`BREAKING_LEVELS` enum array lives there too).
- The one existing read: `workers/api/src/routes/whats-changed.ts:256`
  selects `breaking: releases.breaking` — use it as the select exemplar.
- Wire types (`packages/api-types/src/api-types.ts`, verbatim at `3238d540`):

```ts
// api-types.ts:811-819 — ReleaseDetail already carries the fields, optional:
   * Machine-readable breaking-change level (#1696). `.optional()` for mid-deploy
   ...
  breaking?: BreakingLevel;
  ...
  migrationNotes?: string | null;
```

  So the DETAIL wire type needs no change. Check whether the LIST item type
  (the shape returned by `/v1/releases/latest`, org/source release lists —
  find it by grepping `titleShort` or `title_short` in
  `packages/api-types/src/`) already has `breaking`; if not, add it there as
  an optional field with the same comment style. Both api-types zod schemas
  and any plain interfaces must stay in sync.
- Read queries that build release rows — the fields should ride wherever
  `title_short` rides. Find every select to extend with:

```
grep -rn "title_short" workers/api/src/queries/*.ts workers/api/src/routes/sources.ts
```

  At `3238d540` that is: `queries/releases.ts` (the `getLatestReleasesAcross`
  select ~line 118 + `mapLatestRowToReleaseItem` ~line 152 +
  `getFollowedReleases` ~line 228), `queries/sources.ts` (~238, ~267, ~324),
  `queries/orgs.ts` (~484, ~585), `queries/search.ts` (~50), and the
  `GET /releases/:id` handler in `routes/sources.ts` (~line 3436 region).
- Web:
  - Release card: `web/src/components/release-item.tsx` (the timeline/list card).
  - Release detail: `web/src/app/release/[id]/release-content.tsx`.
  - Chip exemplar: `web/src/components/cluster-chip.tsx` (21 lines — copy its
    styling approach). **Repo rule: NO emojis or unicode glyph icons in web
    UI** — use text chips / icon components only.
  - The web API transport is `web/src/lib/api.ts`; its local response types
    may mirror api-types — grep it for `titleShort` and extend the same way.
- OpenAPI: routes are documented via `describeRoute` +
  `resolver(<schema>)` from the api-types zod schemas, so schema edits in
  api-types propagate. CI has an OpenAPI coverage gate (#894) — no new routes
  are added here, so it should stay green.
- Convention: wire changes are **additive by default** (AGENTS.md); optional
  fields, never renames. `packages/api-types` is published — do NOT bump its
  version or touch its changelog here; publishing is a separate, manual,
  operator-owned step (the monorepo consumes it via `workspace:*`, so the web
  and workers see the field immediately).

## Commands you will need

| Purpose        | Command                                        | Expected on success |
|----------------|------------------------------------------------|---------------------|
| Install        | `bun install` (repo root; only if needed)      | exit 0              |
| Lint + types   | `bun run check`                                | exit 0              |
| API tests      | `bun test workers/api`                         | all pass            |
| Web leg        | `bun test web/`                                | all pass            |
| Full suite     | `bun run test`                                 | all pass            |

## Scope

**In scope** (the only files you should modify):
- `workers/api/src/queries/releases.ts`, `queries/sources.ts`, `queries/orgs.ts`, `queries/search.ts`
- `workers/api/src/routes/sources.ts` (the `GET /releases/:id` select/response only)
- `packages/api-types/src/api-types.ts` + the release schemas file it re-exports (find via `grep -rln "titleShort" packages/api-types/src/`)
- `web/src/lib/api.ts` (type mirror only)
- `web/src/components/release-item.tsx`
- `web/src/app/release/[id]/release-content.tsx`
- `web/src/components/breaking-chip.tsx` (create)
- One new test file per surface (see Test plan)

**Out of scope** (do NOT touch, even though they look related):
- The webhook `breaking` filter (issue #1710 checkbox 3) — needs its own
  design for where the filter lives on `user_follows`/webhook config; defer.
- Backfill of historical rows (#1711) — cost-gated, operator-owned.
- The classifier itself (`packages/ai`, `summarizeRelease`, eval fixtures) —
  read-only consumers here.
- `workers/mcp` — its read tools query D1 directly and its `whats_changed`
  already carries the field; MCP parity for list tools is a follow-up.
- Version bumps / publishing of `@buildinternet/releases-api-types`.
- `web/src/lib/graphql/__generated__/` — generated, never hand-edit.

## Git workflow

- Branch: `advisor/007-surface-breaking-field`
- Conventional commits, e.g. `feat(api): return breaking/migrationNotes on release read paths (#1710)`, `feat(web): breaking chip + migration notes (#1710)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: API — add the fields to the release read paths

For every select found by the Step-0 grep (`title_short` sites), add
`r.breaking` and — detail route only — `r.migration_notes`, and thread them
through the corresponding row-mapper (e.g. `mapLatestRowToReleaseItem`) as
`breaking` / `migrationNotes`. List paths carry `breaking` only (keep list
payloads slim; migration notes can be long — detail-only). Preserve the
existing null/undefined convention: rows ingested before #1703 hold
`"unknown"` or NULL — map NULL to `undefined` (field absent), never invent a
value.

**Verify**: `bun run check` → exit 0; `bun test workers/api` → all pass.

### Step 2: api-types — extend the LIST item schema (detail already done)

Add optional `breaking` to the list-item zod schema + TS type (mirror the
existing `ReleaseDetail` comment style, referencing #1696/#1710). Do not make
it required — mid-deploy and pre-#1703 rows lack it.

**Verify**: `bun run check` → exit 0 (api-types is type-checked via the root oxlint run); `bun test packages/` → all pass.

### Step 3: API tests

Extend/add route tests in `workers/api/test/` (model after an existing
releases-list route test — find one with
`grep -l "releases/latest" workers/api/test/*.test.ts`): seed a release row
with `breaking: "major"`, `migration_notes: "…"` via the test DB, assert:

1. `GET /v1/releases/:id` response contains `breaking: "major"` and `migrationNotes`.
2. The latest/list endpoint carries `breaking` on the item and does NOT carry `migrationNotes`.
3. A row with NULL breaking → both fields absent from JSON (not `null`, absent — match whatever the mapper produces and pin it).

**Verify**: `bun test workers/api` → all pass including new cases.

### Step 4: Web — chip + migration notes

1. Create `web/src/components/breaking-chip.tsx`: a small presentational
   component taking `level: "minor" | "major"` and rendering a text chip
   ("Breaking" for major, "Breaking (minor)" for minor — or match existing
   chip label conventions in `cluster-chip.tsx`). Render NOTHING for
   `none`/`unknown`/absent. No emojis, no unicode arrows.
2. In `release-item.tsx`, render the chip next to the title/version metadata
   when `breaking` is `major` or `minor`.
3. In `release-content.tsx`, when `migrationNotes` is present render a
   clearly-labeled "Migration notes" block (match the page's existing section
   styling; the notes are plain text ≤3 sentences — render as text, not
   markdown-parsed HTML).
4. Mirror the new optional fields in `web/src/lib/api.ts`'s local types if it
   declares its own release shapes.

**Verify**: `bun run check` → exit 0; `bun test web/` → all pass. Add a
component-logic test only if a pure function is extracted (e.g. label
selection); do not build a DOM-render harness — the existing web tests are
logic-level (see `web/src/components/org-release-entries.test.ts` for the
pattern).

### Step 5: Full suite

**Verify**: `bun run test` → all pass; `bun run check` → exit 0.

## Test plan

- `workers/api/test/`: 3 cases from Step 3 (detail carries both fields; list
  carries `breaking` only; NULL row omits both).
- `web/`: 1 small logic test for the chip's level→label/visibility mapping
  (extract the mapping as a pure function so it is testable without DOM).
- Regression: full suite green.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run check` exits 0 and `bun run test` exits 0
- [ ] `curl`-shaped proof via tests: detail response asserts `breaking` + `migrationNotes`; list response asserts `breaking` present / `migrationNotes` absent
- [ ] `grep -n "breaking" workers/api/src/queries/releases.ts` shows the field in the select and the mapper
- [ ] New `breaking-chip.tsx` exists; `grep -rn "breaking" web/src/components/release-item.tsx` shows the chip wired
- [ ] No emoji characters in any new web code
- [ ] No changes under `workers/mcp/`, `packages/ai/`, or webhook files (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The list-item wire type turns out to be shared with the CLI in a way that
  makes the addition non-additive (a required field, a discriminated union) —
  wire changes must be additive; report instead of forcing it.
- `title_short` grep surfaces selects in files not on the in-scope list
  (drift) — report the new sites rather than silently widening scope.
- The web release card already renders a conflicting badge/chip in the same
  slot and placement needs a design call.
- Anything requires touching the summarize prompt, classifier, or evals.

## Maintenance notes

- **Operator follow-ups after this lands** (recorded in issue #1710): the
  webhook `breaking` filter (needs subscription-storage design), MCP list-tool
  parity, the #1711 backfill (until it runs, most historical rows show no
  chip — expected), and an api-types publish + CLI pin bump when the CLI wants
  the field.
- Reviewers should scrutinize: list payload size (only `breaking` added, not
  `migrationNotes`), and that `unknown` renders nothing (an "Unknown" chip on
  every legacy row would be noise).
- If a future change makes `breaking` required on the wire, it must wait one
  minor-version deprecation cycle per the api-types policy in AGENTS.md.
