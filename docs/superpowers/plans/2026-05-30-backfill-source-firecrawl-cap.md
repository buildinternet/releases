# Bound the Firecrawl-auto backfill path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the Firecrawl auto-scrape path of `POST /v1/workflows/backfill-source` to a hard window ceiling so a default run reliably returns under a client timeout, surface the cap with a `guidance` hint, and document supplied-markdown as the deep-history path.

**Architecture:** Two pure helpers (`effectiveBackfillWindows`, `firecrawlCapGuidance`) live in `source-backfill.ts` and are unit-tested in isolation. The route (`workers/api/src/routes/workflows.ts`) computes the effective window budget from `resolved.via`, passes it to extraction, and attaches `guidance` to the response when the ceiling reduced a capped run. A test-only `_backfillBodyOverride` hook lets the route's firecrawl path be exercised without a live scrape. No new infrastructure, no Workflow; the write path's existing idempotency/self-heal is documented rather than re-engineered.

**Tech Stack:** TypeScript (strict), Bun test, Hono, Cloudflare Workers, Drizzle.

**Spec:** `docs/superpowers/specs/2026-05-30-backfill-source-firecrawl-cap-design.md`

---

## File Structure

- **Modify** `workers/api/src/lib/source-backfill.ts` — add `FIRECRAWL_BACKFILL_MAX_WINDOWS`, `effectiveBackfillWindows()`, `firecrawlCapGuidance()`, and an optional `guidance?: string` field on `SourceBackfillReport`. (Pure, runtime-neutral; no new imports.)
- **Modify** `workers/api/src/lib/source-backfill.test.ts` — unit tests for the two new pure helpers (colocated, the existing home for `runSourceBackfill` tests).
- **Modify** `workers/api/src/routes/workflows.ts` — import the helpers; add the `_backfillBodyOverride` test hook; extend the `_backfillExtractOverride` signature with `maxWindows`; compute `effectiveMaxWindows`; pass it to extraction; attach `guidance` to the response.
- **Modify** `workers/api/test/workflows-backfill.test.ts` — two route tests: supplied-markdown is **not** clamped (no guidance); firecrawl `via` (via body-override) **is** clamped to 8 (guidance present).
- **Modify** `docs/architecture/firecrawl-monitoring.md` — update the backfill section with the cap + supplied-markdown deep-path + idempotent-re-run guidance.

---

## Task 1: Pure helpers + report field in `source-backfill.ts`

**Files:**

- Modify: `workers/api/src/lib/source-backfill.ts`
- Test: `workers/api/src/lib/source-backfill.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `workers/api/src/lib/source-backfill.test.ts` (add the two new names to the existing import on line 3):

```ts
// line 3 becomes:
import {
  runSourceBackfill,
  effectiveBackfillWindows,
  firecrawlCapGuidance,
  FIRECRAWL_BACKFILL_MAX_WINDOWS,
  type SourceBackfillDeps,
} from "./source-backfill.js";
```

Append these blocks at the end of the file:

```ts
describe("effectiveBackfillWindows", () => {
  it("clamps the firecrawl path to the hard ceiling", () => {
    expect(effectiveBackfillWindows("firecrawl", 50)).toBe(FIRECRAWL_BACKFILL_MAX_WINDOWS);
    expect(effectiveBackfillWindows("firecrawl", 200)).toBe(FIRECRAWL_BACKFILL_MAX_WINDOWS);
  });

  it("leaves a firecrawl request below the ceiling untouched", () => {
    expect(effectiveBackfillWindows("firecrawl", 3)).toBe(3);
  });

  it("never clamps supplied or fetch paths", () => {
    expect(effectiveBackfillWindows("supplied", 50)).toBe(50);
    expect(effectiveBackfillWindows("fetch", 200)).toBe(200);
  });
});

describe("firecrawlCapGuidance", () => {
  it("returns guidance when the firecrawl ceiling capped a deeper request", () => {
    const msg = firecrawlCapGuidance({
      via: "firecrawl",
      cappedAtWindow: true,
      effectiveMaxWindows: 8,
      requestedMaxWindows: 50,
    });
    expect(msg).toContain("8 windows");
    expect(msg).toContain("markdown");
  });

  it("returns undefined when the run finished within the ceiling (no tail)", () => {
    expect(
      firecrawlCapGuidance({
        via: "firecrawl",
        cappedAtWindow: false,
        effectiveMaxWindows: 8,
        requestedMaxWindows: 50,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the request was already at/under the ceiling", () => {
    expect(
      firecrawlCapGuidance({
        via: "firecrawl",
        cappedAtWindow: true,
        effectiveMaxWindows: 5,
        requestedMaxWindows: 5,
      }),
    ).toBeUndefined();
  });

  it("returns undefined for non-firecrawl paths even when capped", () => {
    expect(
      firecrawlCapGuidance({
        via: "supplied",
        cappedAtWindow: true,
        effectiveMaxWindows: 50,
        requestedMaxWindows: 50,
      }),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd workers/api && bun test src/lib/source-backfill.test.ts`
Expected: FAIL — `effectiveBackfillWindows`/`firecrawlCapGuidance` are not exported.

- [ ] **Step 3: Implement the helpers + report field**

In `workers/api/src/lib/source-backfill.ts`, add the optional field to the report interface (inside `SourceBackfillReport`, after `dryRun: boolean;`):

```ts
  dryRun: boolean;
  /** Set only when the Firecrawl ceiling reduced a deeper request and the run
   *  was capped with untouched tail — tells the caller how to backfill deeper. */
  guidance?: string;
}
```

Then append the helpers at the end of the file:

```ts
/** Hard ceiling on extraction windows when the body came from a Firecrawl
 *  `scrapeOnce` (~106s). The single scrape is the long pole; bounding the
 *  windows on top of it keeps a default run under a normal client timeout.
 *  Supplied-markdown / plain-fetch paths have no scrape and are not clamped —
 *  they remain the path for arbitrarily-deep histories. See issue #1271. */
export const FIRECRAWL_BACKFILL_MAX_WINDOWS = 8;

/** The window budget actually handed to extraction: clamped to the hard
 *  ceiling on the firecrawl path, passed through verbatim otherwise. */
export function effectiveBackfillWindows(via: BackfillBodyVia, requested: number): number {
  return via === "firecrawl" ? Math.min(requested, FIRECRAWL_BACKFILL_MAX_WINDOWS) : requested;
}

/** Human/agent-facing hint, set only when the firecrawl ceiling actually
 *  reduced a deeper request AND the run stopped with untouched tail. No silent
 *  caps: the caller is told the page wasn't fully covered and how to go deeper. */
export function firecrawlCapGuidance(input: {
  via: BackfillBodyVia;
  cappedAtWindow: boolean;
  effectiveMaxWindows: number;
  requestedMaxWindows: number;
}): string | undefined {
  if (input.via !== "firecrawl") return undefined;
  if (!input.cappedAtWindow) return undefined;
  if (input.effectiveMaxWindows >= input.requestedMaxWindows) return undefined;
  return `Capped at ${input.effectiveMaxWindows} windows to fit the Firecrawl scrape budget. Re-run with \`markdown\` supplied (render the page yourself) to backfill deeper history.`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd workers/api && bun test src/lib/source-backfill.test.ts`
Expected: PASS (all `runSourceBackfill`, `effectiveBackfillWindows`, `firecrawlCapGuidance` tests green).

- [ ] **Step 5: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/lib/source-backfill.ts workers/api/src/lib/source-backfill.test.ts
git commit -m "feat(api): add firecrawl backfill window-cap helpers (#1271)"
```

---

## Task 2: Wire the cap + guidance into the route

**Files:**

- Modify: `workers/api/src/routes/workflows.ts` (backfill-source route, ~lines 71-76 import, ~1843-2056)
- Test: `workers/api/test/workflows-backfill.test.ts`

- [ ] **Step 1: Write the failing route tests**

Append to `workers/api/test/workflows-backfill.test.ts` (inside the existing `describe("POST /v1/workflows/backfill-source", ...)` block, before its closing `});`):

```ts
it("does not clamp the supplied-markdown path and emits no guidance", async () => {
  const db = mkDb();
  await seedScrapeSource(db);
  let seenMaxWindows = -1;
  const override = async (_md: string, _src: unknown, maxWindows: number) => {
    seenMaxWindows = maxWindows;
    return { releases: [], windows: 1, cappedAtWindow: false, droppedChars: 0 };
  };
  const fetch = mkApp(db, { _backfillExtractOverride: override });

  const res = await post(fetch, {
    sourceId: "src_scrape",
    markdown: "# v1\nstuff",
    maxWindows: 50,
    dryRun: true,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { via: string; guidance?: string };
  expect(body.via).toBe("supplied");
  expect(seenMaxWindows).toBe(50);
  expect(body.guidance).toBeUndefined();
});

it("clamps the firecrawl path to the hard ceiling and emits guidance", async () => {
  const db = mkDb();
  await seedScrapeSource(db);
  let seenMaxWindows = -1;
  const override = async (_md: string, _src: unknown, maxWindows: number) => {
    seenMaxWindows = maxWindows;
    // Report a capped run with untouched tail so guidance fires.
    return { releases: [], windows: maxWindows, cappedAtWindow: true, droppedChars: 999 };
  };
  const fetch = mkApp(db, {
    _backfillExtractOverride: override,
    _backfillBodyOverride: { markdown: "# lots of history", via: "firecrawl" },
  });

  const res = await post(fetch, {
    sourceId: "src_scrape",
    maxWindows: 50,
    dryRun: true,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { via: string; guidance?: string };
  expect(body.via).toBe("firecrawl");
  expect(seenMaxWindows).toBe(8);
  expect(body.guidance).toContain("8 windows");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd workers/api && bun test test/workflows-backfill.test.ts`
Expected: BOTH new tests FAIL. The route still calls `override(markdown, src)` with no third arg, so `seenMaxWindows` is `undefined` (≠ 50 and ≠ 8). The firecrawl test also fails on `via` (no `_backfillBodyOverride` support yet → falls through to a real-fetch/`firecrawl` acquisition error rather than `via: "firecrawl"`) and on the missing `guidance`.

- [ ] **Step 3: Extend the import**

In `workers/api/src/routes/workflows.ts`, replace the existing `source-backfill` import (lines 71-76):

```ts
import {
  runSourceBackfill,
  effectiveBackfillWindows,
  firecrawlCapGuidance,
  type BackfillBodyVia,
  type SourceBackfillDeps,
  type SourceBackfillExtractResult,
} from "../lib/source-backfill.js";
```

- [ ] **Step 4: Extend the extract-override type to carry `maxWindows`**

Replace the `BackfillExtractOverride` type (currently ~lines 1873-1876):

```ts
// TEST-ONLY hook (kept off the production Env type): inject the all-windows
// extraction result instead of calling Anthropic. Receives the *effective*
// (post-clamp) window budget so a test can assert the firecrawl ceiling.
type BackfillExtractOverride = (
  markdown: string,
  source: Source,
  maxWindows: number,
) => Promise<SourceBackfillExtractResult>;

// TEST-ONLY hook: inject the resolved body, bypassing the acquisition ladder
// (supplied / firecrawl / fetch) so the firecrawl `via` can be exercised in a
// unit test without a live Firecrawl scrape.
type BackfillBodyOverride = { markdown: string; via: BackfillBodyVia };
```

- [ ] **Step 5: Honor the body override in acquisition**

In the route, the body-acquisition block currently opens with `let resolved: ...; if (suppliedMarkdown) { ... }`. Replace the declaration + first branch so the override short-circuits (insert the override read and the new first `if`; keep the existing `suppliedMarkdown` / `firecrawl` / `fetch` branches as the `else if` chain):

```ts
  // ── Body acquisition (errors mapped to HTTP here) ──────────────────────────
  const bodyOverride = (c.env as { _backfillBodyOverride?: BackfillBodyOverride })
    ._backfillBodyOverride;
  let resolved: { markdown: string; via: BackfillBodyVia };
  if (bodyOverride) {
    resolved = bodyOverride;
  } else if (suppliedMarkdown) {
    resolved = { markdown: suppliedMarkdown, via: "supplied" };
  } else if (meta.firecrawl?.enabled) {
```

(The remaining `else if (meta.firecrawl?.enabled)` body and the final `else` plain-fetch branch are unchanged.)

- [ ] **Step 6: Compute the effective window budget and pass it to extraction**

Immediately after the body-acquisition block closes (right before the `// ── Extraction ...` comment, ~line 1976), add:

```ts
// Hard-cap the firecrawl path: the ~106s scrape is the long pole, so bound the
// windows on top of it to keep a default run under a client timeout. Supplied/
// fetch bodies have no scrape and keep the full 1–200 budget.
const effectiveMaxWindows = effectiveBackfillWindows(resolved.via, maxWindows);
```

Then in the `extract` closure, pass `effectiveMaxWindows` (replace the override call and the `extractChangelogAllWindows` `opts`):

```ts
  const extract = async (markdown: string): Promise<SourceBackfillExtractResult> => {
    if (override) return override(markdown, src, effectiveMaxWindows);
    const r = await extractChangelogAllWindows(
      markdown,
      src,
      {
        anthropicClient: anthropicClient!,
        agentModel: BACKFILL_EXTRACT_MODEL,
        logger: backfillLogger,
      },
      { maxWindows: effectiveMaxWindows },
    );
```

- [ ] **Step 7: Attach guidance to the response**

Replace the tail of the handler (currently `const report = await runSourceBackfill(...)` through `return c.json(report);`, ~lines 2045-2055):

```ts
  const report = await runSourceBackfill({ id: src.id, slug: src.slug }, { dryRun }, deps);
  const guidance = firecrawlCapGuidance({
    via: resolved.via,
    cappedAtWindow: report.cappedAtWindow,
    effectiveMaxWindows,
    requestedMaxWindows: maxWindows,
  });
  if (report.cappedAtWindow || report.droppedChars > 0) {
    logEvent("info", {
      component: "backfill-source",
      event: "windowed-cap",
      sourceId: src.id,
      windows: report.windows,
      droppedChars: report.droppedChars,
    });
  }
  return c.json(guidance ? { ...report, guidance } : report);
});
```

- [ ] **Step 8: Run the route tests to verify they pass**

Run: `cd workers/api && bun test test/workflows-backfill.test.ts`
Expected: PASS — both new tests plus the 5 existing gate/dry-run tests.

- [ ] **Step 9: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add workers/api/src/routes/workflows.ts workers/api/test/workflows-backfill.test.ts
git commit -m "feat(api): cap firecrawl backfill window budget + guidance (#1271)"
```

---

## Task 3: Documentation

**Files:**

- Modify: `docs/architecture/firecrawl-monitoring.md` (backfill section, ~lines 117-126)

- [ ] **Step 1: Update the extraction + dry-run bullets**

In the "Full-history backfill" section, replace the **Extraction** bullet and the **`dryRun`** bullet with:

```markdown
- **Extraction:** `extractChangelogAllWindows` loops `sliceChangelog` over the whole document (Haiku 4.5, temp 0, one-shot per window), bounded by `maxWindows` (default 50, max 200). **The Firecrawl auto-scrape path is additionally hard-capped at `FIRECRAWL_BACKFILL_MAX_WINDOWS` (8):** the ~106s `scrapeOnce` is the long pole, so the window budget on top of it is bounded to keep a default run under a client timeout. Supplied-markdown and plain-fetch bodies have no scrape and keep the full 1–200 budget — **supplied markdown is the path for arbitrarily-deep histories** (a local agent renders the page; the worker does cheap Haiku extraction over the supplied text). When the firecrawl ceiling reduces a deeper request and the run stops with untouched tail, the report carries a `guidance` string telling the caller to supply `markdown` to go deeper. `cappedAtWindow` / `droppedChars` report any untouched tail — no silent caps.
- **Durability:** the endpoint runs synchronously in one request, so a caller that disconnects mid-run cancels the work. This is safe by construction: the write path upserts idempotently (`RELEASE_URL_UPSERT` on matching `mapEntries` slugs), embeds with `throwOnError:false`, and leaves missing summaries for the autogen drain — so a partial run **self-heals on re-run**. The Firecrawl cap above keeps the default (dry-run) path returning well within a timeout; a durable `BackfillSourceWorkflow` was evaluated (issue #1271) and deferred as a future escalation only if real Firecrawl-auto deep histories prove necessary.
- **`dryRun` (default true):** returns `windows`, `extracted`, `deduped`, `dateRange` (and `guidance` when capped) without writing. A real run upserts via `ingestRawReleases`, then embeds + regenerates summaries (summary calls chunked at 20 to clear the `MAX_AUTOGEN_ROWS_PER_FIRE` autogen cap).
```

- [ ] **Step 2: Verify formatting**

Run: `bun run format:check` (from repo root)
Expected: no changes needed (or run `bun run format` and re-stage if prettier reflows the doc).

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/firecrawl-monitoring.md
git commit -m "docs(firecrawl): document backfill window cap + deep-history path (#1271)"
```

---

## Task 4: Full gate sweep

- [ ] **Step 1: Root + worker type-check**

Run: `npx tsc --noEmit && cd workers/api && npx tsc --noEmit && cd ../..`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: PASS (no regressions; new helper + route tests green).

- [ ] **Step 3: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean.

- [ ] **Step 4: Push branch + open PR**

```bash
git push -u origin worktree-backfill-firecrawl-cap
gh pr create --title "Bound the Firecrawl-auto backfill path (#1271)" --body-file <(cat <<'EOF'
Closes #1271.

Caps the Firecrawl auto-scrape path of `POST /v1/workflows/backfill-source`
at `FIRECRAWL_BACKFILL_MAX_WINDOWS = 8` so a default run returns under a
client timeout (the ~106s `scrapeOnce` is the long pole). Supplied-markdown
and plain-fetch paths are unchanged (50/200) and remain the path for
arbitrarily-deep histories. When the ceiling caps a deeper firecrawl request
with untouched tail, the response carries a `guidance` hint to supply
markdown.

The write path's existing idempotency (`RELEASE_URL_UPSERT`) + self-healing
embeds/summaries are documented in lieu of a durable Workflow, which was
evaluated and deferred (see the design spec).

Spec: `docs/superpowers/specs/2026-05-30-backfill-source-firecrawl-cap-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```

---

## Self-Review

**Spec coverage:**

- Hard ceiling on firecrawl path → Task 1 (`effectiveBackfillWindows` + constant) + Task 2 (wiring). ✓
- No silent cap / `guidance` field → Task 1 (`firecrawlCapGuidance` + report field) + Task 2 (attach to response). ✓
- Supplied-markdown / fetch unchanged → asserted in Task 1 helper tests + Task 2 supplied-path route test. ✓
- Docs (cap + deep path + idempotent re-run) → Task 3. ✓
- Tests (firecrawl clamp to 8 + guidance; supplied not clamped) → Task 2. ✓
- Gates → Task 4. ✓

**Placeholder scan:** none — every step shows the exact code/command.

**Type consistency:** `effectiveBackfillWindows(via, requested)`, `firecrawlCapGuidance({via, cappedAtWindow, effectiveMaxWindows, requestedMaxWindows})`, `FIRECRAWL_BACKFILL_MAX_WINDOWS`, and the `_backfillExtractOverride(markdown, source, maxWindows)` / `_backfillBodyOverride {markdown, via}` shapes are used identically across Task 1 and Task 2. The report's optional `guidance?: string` is defined in Task 1 and consumed in Task 2/Task 3.
