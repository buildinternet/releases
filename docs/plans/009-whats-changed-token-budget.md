# Plan 009: Fix whats-changed token budget bypass for empty summaries

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b1c2e87a..HEAD -- workers/api/src/routes/whats-changed.ts workers/api/test/whats-changed-route.test.ts packages/core/src/tokens.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b1c2e87a`, 2026-07-03

## Why this matters

`GET /v1/whats-changed` token-budgets the returned entries so agents don't get unbounded JSON on wide version ranges. The budget loop uses `estimateTokens(summary ?? titleGenerated ?? title ?? "")`, and `estimateTokens("")` returns `0` (`packages/core/src/tokens.ts:49-51`). Releases without summaries/titles accumulate zero cost, never trigger truncation, and return the full range with `truncated: false` — undermining upgrade-intelligence safety for historical or un-summarized catalog rows.

## Current state

Budget loop in `workers/api/src/routes/whats-changed.ts` (~271-285):

```ts
const cost = estimateTokens(r.summary ?? r.titleGenerated ?? r.title ?? "");
if (spent + cost > TOKEN_BUDGET && kept.length > 0) {
  truncated = true;
  break;
}
spent += cost;
kept.push(r);
```

`TOKEN_BUDGET` is the largest `CHANGELOG_TOKEN_BRACKETS` entry (line 40).

Tests: `workers/api/test/whats-changed-route.test.ts` — no truncation case for empty-text rows.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint + format | `bun run check` | exit 0 |
| Route tests | `bun test workers/api/test/whats-changed-route.test.ts` | all pass |
| API tests | `bun test workers/api` | all pass |

## Scope

**In scope**:
- `workers/api/src/routes/whats-changed.ts`
- `workers/api/test/whats-changed-route.test.ts`

**Out of scope**:
- Wire type changes in `@buildinternet/releases-api-types` (response shape unchanged)
- MCP `whats_changed` tool (proxies API; inherits fix)
- SQL version-bounding path (separate concern)

## Git workflow

- Branch: `advisor/009-whats-changed-token-budget`
- Commit: `fix(api): floor whats-changed budget cost for empty entry text`

## Steps

### Step 1: Add per-entry floor cost

In `whats-changed.ts`, near `TOKEN_BUDGET`, add:

```ts
/** Minimum token charge per entry so rows with empty summary/title still
 *  count toward the budget (estimateTokens("") === 0 otherwise). */
const MIN_ENTRY_TOKEN_COST = 64;
```

In the budget loop, replace cost calculation with:

```ts
const text = r.summary ?? r.titleGenerated ?? r.title ?? "";
const cost = Math.max(estimateTokens(text), MIN_ENTRY_TOKEN_COST);
```

**Verify**: `grep -n MIN_ENTRY_TOKEN_COST workers/api/src/routes/whats-changed.ts` → two matches (const + use).

### Step 2: Add count cap as backstop

Even with a floor, an enormous range could return too many entries if `TOKEN_BUDGET / MIN_ENTRY_TOKEN_COST` is large. Add:

```ts
const MAX_ENTRIES = Math.floor(TOKEN_BUDGET / MIN_ENTRY_TOKEN_COST);
```

After the reverse iteration loop, if `kept.length` was limited by count (not just tokens), ensure `truncated: true`. Simplest approach: inside the loop, also break when `kept.length >= MAX_ENTRIES` (after pushing), set `truncated = true`.

**Verify**: `bun run check` → exit 0.

### Step 3: Add regression test

In `whats-changed-route.test.ts`, add test `truncates when entries have empty summaries (budget floor)`:

1. Seed org + source.
2. Insert many releases (e.g. 30) with `summary: null`, `titleGenerated: null`, `title: null` but distinct versions in range.
3. Call `package=...&from=1.0.0&to=9.0.0` (or similar wide range).
4. Assert `body.truncated === true`.
5. Assert `body.entries.length < 30` and `body.count === body.entries.length`.

Use `relRow` helper pattern; override summary/title fields to null.

**Verify**: `bun test workers/api/test/whats-changed-route.test.ts` → new test passes.

### Step 4: Confirm existing tests still pass

Run full whats-changed test file — resolved range, breaking flow-through, unknown package cases must be unchanged.

**Verify**: `bun test workers/api/test/whats-changed-route.test.ts` → all pass.

## Test plan

- New: wide range + empty text → `truncated: true`, bounded `entries.length`.
- Existing: ascending order, breaking verdict, unknown package — unchanged.

## Done criteria

- [ ] `MIN_ENTRY_TOKEN_COST` and `MAX_ENTRIES` enforced in budget loop
- [ ] New regression test passes
- [ ] `bun run check` and `bun test workers/api` exit 0
- [ ] `plans/README.md` updated

## STOP conditions

- `TOKEN_BUDGET` or `CHANGELOG_TOKEN_BRACKETS` moved/refactored — re-read and adjust constants.
- New test cannot seed enough rows in sqlite fixture — reduce count but keep truncation provable.
- Product wants zero truncation for small ranges — if `MAX_ENTRIES` breaks a test with 4 seeded rows, lower floor or only apply count cap when `inRange.length > MAX_ENTRIES`.

## Maintenance notes

- If `summarizeRelease` backfill (#1711) fills summaries, truncation becomes rarer — floor still protects title-less historical rows.
- Reviewers: check `truncatedAtTokens` still set when `truncated: true`.