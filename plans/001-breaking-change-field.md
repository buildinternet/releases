# Plan 001: Add a structured breaking-change + migration-notes field to releases

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 8f811cb5..HEAD -- packages/core/src/schema.ts packages/ai/src/release-content.ts workers/api/migrations`
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (schema migration + ingest-path AI change + a backfill)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `8f811cb5`, 2026-06-20
- **Issue**: https://github.com/buildinternet/releases/issues/1696

## Why this matters

The single most valuable question an agent asks about a release is "can I take
this upgrade safely, and if not, what changes?" Today nothing answers it: the
taxonomy is `kind` + `type` (`feature`/`rollup`) + tags, and "breaking" exists
only as prose in `src/shared/rubrics/overview.md`. A machine-readable `breaking`
classification + extracted `migration_notes` is the data layer the upgrade-plan
feature (plan 002 / #1697) stands on, and it doubles as first-party editorial
value (the thing the March-2026 core update rewards over republished text —
#1601).

This is a **spike-then-build** plan: the schema + plumbing are mechanical, but
the classification prompt + its eval are the real work. Do the plumbing behind a
fail-open default so a wrong classification is never worse than today's absence.

## Current state

- `packages/core/src/schema.ts:429-487` — the `releases` table (source of truth;
  composite Drizzle schema). Relevant columns today:
  ```ts
  type: text("type", { enum: RELEASE_TYPES }).notNull().default("feature"), // :443
  summary: text("summary"),                                                  // :446
  titleGenerated: text("title_generated"),                                   // :447
  titleShort: text("title_short"),                                           // :448
  metadata: text("metadata").default("{}"),                                  // :459
  ```
  `Release` / `NewRelease` types are inferred at `:571-572`.
- `packages/ai/src/release-content.ts` — the shared ingest-time summarization
  lane (Haiku, `MODEL` at `:22 = "claude-haiku-4-5"`). It already produces
  `title`/`titleShort`/`summary` per release:
  - `SummarizeReleaseInput` — `:358` (`orgSlug, sourceName, productName, title, version, url, content`).
  - `SummarizeReleaseResult` — `:378` (`title, titleShort, summary, composition, usage, skipped`).
  - `SYSTEM_PROMPT` — `:84`; `buildReleaseBlock(input)` — `:393` (renders the user message).
  - `isEmptyContent()` — `:65` (empty-body short-circuit; `skipped: true`).
- Ingest call sites (where the result is written): `workers/api/src/workflows/poll-and-fetch.ts`,
  `workers/api/src/workflows/batch-summarize.ts`, and the agent/script path
  `scripts/generate-release-content.ts`.
- Migration convention — every `schema.ts` change needs a **paired migration**
  (CI gate). Exemplar (an additive ALTER): `workers/api/migrations/20260614000000_add_collection_daily_summaries.sql`:
  ```sql
  ALTER TABLE collections ADD COLUMN daily_summary_enabled INTEGER NOT NULL DEFAULT 1;
  ```
  Migration filenames are `YYYYMMDDHHMMSS_<slug>.sql`, time-ordered.
- Eval convention — `packages/ai/src/collection-summary.ts` (+ `collection-summary.test.ts`)
  and the rubric in `src/shared/rubrics/` (e.g. `overview.md`) are the pattern
  for a model-graded quality check with real prod fixtures.
- **Project rule (memory):** reuse the existing summarization model lane with a
  distinct `generationName`; do **NOT** add a per-feature `*_MODEL` env var.

## Commands you will need

| Purpose                       | Command                              | Expected on success               |
| ----------------------------- | ------------------------------------ | --------------------------------- |
| Worktree bootstrap (run once) | `./scripts/setup-worktree.sh`        | exit 0 (`bun install` + env copy) |
| Typecheck (root)              | `npx tsc --noEmit`                   | exit 0, no errors                 |
| Typecheck (api worker)        | `cd workers/api && npx tsc --noEmit` | exit 0                            |
| Tests                         | `bun test`                           | all pass                          |
| Lint                          | `bun run lint`                       | exit 0                            |
| Format check                  | `bun run format:check`               | exit 0                            |

## Scope

**In scope:**

- `packages/core/src/schema.ts` — add the column(s).
- `workers/api/migrations/<new>.sql` — paired additive migration.
- `packages/ai/src/release-content.ts` — extend the lane to classify (or a
  sibling module if the executor judges the prompt is cleaner separate; keep it
  on the same model lane either way).
- The ingest write sites above — persist the new field.
- `packages/api-types/` — add the field to the wire release shape (additive).
- A new eval rubric + fixtures mirroring `collection-summary`.

**Out of scope (do NOT touch):**

- Web rendering of the chip and the webhook filter — those are follow-ups in
  #1696, not this plan. (This plan lands the _field_; surfacing is separate.)
- The `releases.metadata` JSON blob — use a real column (see README rejected
  finding).
- Any change to `type` / `RELEASE_TYPES` — breaking is orthogonal to feature/rollup.

## Git workflow

- Branch: `advisor/001-breaking-change-field` (or continue on this worktree's branch).
- Conventional commits, matching `git log` (e.g. `feat(ai): classify breaking changes at ingest`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Decide the column shape, then add it to the schema

Add to the `releases` table in `packages/core/src/schema.ts` (after `:464`):

```ts
breaking: text("breaking", { enum: BREAKING_LEVELS }).notNull().default("unknown"),
migrationNotes: text("migration_notes"),
```

Define `BREAKING_LEVELS = ["unknown", "none", "minor", "major"] as const` near
`RELEASE_TYPES` (~`:40`). **`"unknown"` is the fail-open default** — every
existing row and every un-classified row reads `unknown`, never a false verdict.

**Verify**: `cd /<repo root> && npx tsc --noEmit` → exit 0.

### Step 2: Write the paired migration

Create `workers/api/migrations/<YYYYMMDDHHMMSS>_add_release_breaking.sql`:

```sql
ALTER TABLE releases ADD COLUMN breaking TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE releases ADD COLUMN migration_notes TEXT;
```

Use a timestamp later than the newest file in `workers/api/migrations/`.

**Verify**: filename sorts last (`ls workers/api/migrations | tail -3`), and the
schema↔migration CI gate is satisfied (run the repo's migration-pairing check if
one exists; otherwise confirm the column names match step 1 exactly).

### Step 3: Extend the AI lane to classify (the real work)

In `packages/ai/src/release-content.ts`, add breaking/migration extraction.
Two acceptable shapes — pick the cleaner one and note which in the commit:

1. Extend `SYSTEM_PROMPT` + `SummarizeReleaseResult` so the existing single call
   also returns `breaking` + `migrationNotes` (one model call, cheapest), OR
2. A sibling `classifyBreaking()` on the same model lane with its own
   `generationName` (clearer prompt, second call).

Requirements regardless of shape:

- **Same model lane**, distinct `generationName`. No new `*_MODEL` var.
- **Fail-open**: any parse failure, empty body (`isEmptyContent`), or low
  confidence → `breaking: "unknown"`, `migrationNotes: null`. Never throw into
  the ingest path.
- `migrationNotes` is null unless the body explicitly describes upgrade steps.

**Verify**: `bun test packages/ai` → existing tests pass; add a unit test
asserting empty/garbled input yields `unknown`/null.

### Step 4: Persist at the ingest write sites

Thread the two new fields through `poll-and-fetch.ts`, `batch-summarize.ts`, and
`scripts/generate-release-content.ts` so they're written on the same upsert that
writes `summary`. Match the existing field-write pattern exactly.

**Verify**: `cd workers/api && npx tsc --noEmit` → exit 0; `bun test workers/api` → pass.

### Step 5: Add the field to the wire shape

In `packages/api-types/`, add `breaking` + `migrationNotes` to the release
response type (additive, optional for back-compat). Do not rename anything.

**Verify**: `npx tsc --noEmit` at root and in each worker → exit 0.

### Step 6: Eval rubric + fixtures

Mirror `packages/ai/src/collection-summary.ts` + its rubric. Create a
breaking-classification rubric and 4–6 **real prod fixtures** (mix of clearly
breaking, clearly not, and ambiguous). The bar: **precision first** — penalize
false-`major`/false-`minor` harder than false-`unknown`.

**Verify**: the eval runs and reports per-fixture verdicts (evals are manual /
on-demand — do not wire into CI).

## Test plan

- `release-content` unit test: empty/garbled body → `breaking: "unknown"`, `migrationNotes: null`.
- `release-content` unit test: a fixture with an explicit "Migration" section →
  `migrationNotes` non-null and `breaking !== "none"`.
- Ingest write test (model after an existing `workers/api/src/workflows/*.test.ts`):
  the new columns are persisted on upsert.
- Eval fixtures (manual): precision/recall over the 4–6 fixtures.
- Pattern to follow: `packages/ai/src/collection-summary.test.ts`.

## Done criteria

- [ ] `npx tsc --noEmit` exits 0 at root and in `workers/api`.
- [ ] `bun test` exits 0; new unit tests for the fail-open path exist and pass.
- [ ] `workers/api/migrations/<new>.sql` exists, sorts last, and its column names
      match `schema.ts` exactly.
- [ ] `grep -n "breaking" packages/api-types/src/*.ts` shows the additive field.
- [ ] No per-feature `*_MODEL` env var was added (`git diff` shows none).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The `releases` table or `release-content.ts` excerpts don't match "Current
  state" (schema drifted since `8f811cb5`).
- The schema↔migration CI gate has a bespoke marker-migration requirement you
  can't satisfy mechanically — report what it expects.
- Classifying inline (step 3 option 1) measurably degrades the existing
  title/summary quality in the eval — fall back to option 2 and report.
- The backfill of ~40K existing rows is implied to run inside a worker — it must
  go through the agent-driven, cost-gated batch path (memory: "Pause before
  billable/bulk MA work"); STOP and surface a cost estimate before any backfill.

## Maintenance notes

- The webhook `breaking` per-event filter (#1683 pattern) and the web "breaking"
  chip are deliberate follow-ups — wire them after this field is populated.
- Backfill is out of this plan; the field defaults `unknown` until a separate,
  cost-estimated batch run populates history. New ingests are classified live.
- Reviewer should scrutinize: the fail-open default holds on every error path;
  no new model var; the migration is additive-only (no rewrite of `type`).
