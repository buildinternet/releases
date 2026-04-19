# Scrape-no-feed Agent Cron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a daily 01:00 UTC cron on the API worker that drains `changeDetectedAt`-flagged scrape-no-feed sources through the existing managed-agents `/update` pipeline, with `cron_runs` observability on `/status` and Anthropic auth/credits pre-flight.

**Architecture:** API worker gains a third cron trigger and a dispatcher module. The dispatcher groups flagged sources by org, fires per-org `/update` calls via the existing `DISCOVERY_WORKER` service binding at concurrency 3, and records each run into a new `cron_runs` table. The managed-agents path (`claude-haiku-4-5`) is unchanged — we're plumbing in front of what already ships.

**Tech Stack:** Cloudflare Workers, D1, Drizzle ORM, Bun, TypeScript, Hono, React (Next.js) for the dashboard tab.

**Spec:** `docs/superpowers/specs/2026-04-18-scrape-agent-cron-design.md` (#327).

**Tracking issue:** #328. **Parent issue:** #319 (part 3).

---

## File structure

**New files:**

- `workers/api/src/db/schema-cron.ts` — Drizzle schema for `cron_runs`. Worker-scoped, mirrors `src/db/schema-coverage.ts` pattern.
- `workers/api/migrations/YYYYMMDDHHMMSS_cron_runs.sql` — D1 migration (timestamp prefix per AGENTS.md convention).
- `src/db/migrations/YYYYMMDDHHMMSS_cron_runs.sql` + `meta/` snapshot — Drizzle migration (generated via `bun run db:generate`).
- `workers/api/src/lib/concurrency.ts` — Extracted `runWithConcurrency` helper.
- `workers/api/src/cron/scrape-agent-sweep.ts` — The sweep orchestrator. Exports `scrapeAgentSweep(env)` plus pure helpers (`classifyPreflightResponse`, `deriveSweepStatus`, `groupByOrg`) for test isolation.
- `workers/api/src/db/cron-runs-dao.ts` — Typed insert/update helpers for `cron_runs` + stale-running reconciler.
- `workers/api/src/routes/admin-cron-runs.ts` — `GET /v1/admin/cron-runs{,/:id,/recent/:cron_name}`.
- `web/src/app/status/cron-runs-tab.tsx` — The Cron tab component on the dev-gated `/status` page.
- Tests:
  - `tests/unit/scrape-agent-preflight.test.ts`
  - `tests/unit/scrape-agent-status-derivation.test.ts`
  - `tests/unit/scrape-agent-candidates.test.ts`
  - `tests/api/cron-runs-migration.test.ts`
  - `tests/api/cron-runs-dao.test.ts`
  - `tests/api/cron-runs-bind-budget.test.ts`
  - `tests/api/stale-running-reconciler.test.ts`
  - `tests/api/scrape-agent-candidate-query.test.ts`
  - `tests/api/scrape-agent-sweep.test.ts` (E2E with mocked boundaries)

**Modified files:**

- `packages/core/src/id.ts` — add `newCronRunId()`.
- `tests/unit/id.test.ts` — one assertion for `crun_` prefix.
- `workers/api/src/cron/poll-fetch.ts` — import `runWithConcurrency` from new shared location; drop local definition.
- `workers/api/src/index.ts` — new scheduled-handler branch for `0 1 * * *`.
- `workers/api/wrangler.jsonc` — third cron trigger + two new env vars + ANTHROPIC_API_KEY binding.
- `workers/api/worker-configuration.d.ts` — regenerated after wrangler.jsonc change.
- `AGENTS.md` — runbook paragraph under a new "Cron observability" subsection.
- `.env.example` — document the new worker vars.

---

## Working conventions for every task

- **TDD:** Write the failing test, run it red, write the minimal code, run it green, commit.
- **Typecheck after any TS change:** `bunx tsc --noEmit` at repo root; also `bunx tsc --noEmit` inside `workers/api` for worker-specific changes.
- **Always run the targeted test suite before committing:** `bun test tests/unit tests/api` as a final check once a task touches multiple files.
- **Commit message style (from git log):** `feat(cron): …`, `test(cron): …`, `chore(cron): …`. Scope is `cron` for this plan.
- **Co-authored-by tag** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Branch:** `feat/scrape-agent-cron` off latest `main`. One branch for the whole plan; PR at the end.

---

## Task 1: ID helper — `newCronRunId()`

**Files:**

- Modify: `packages/core/src/id.ts`
- Test: `tests/unit/id.test.ts`

- [ ] **Step 1.1: Read the existing ID helper file**

Run: `cat packages/core/src/id.ts | head -40`

Expected: a list of functions like `newSourceId`, `newReleaseId`, each using `nanoid` with a specific prefix. Note the exact pattern — probably `const alphabet = customAlphabet(...)` and `id_ => prefix + alphabet()`.

- [ ] **Step 1.2: Write the failing test**

Append to `tests/unit/id.test.ts`:

```ts
import { newCronRunId } from "@buildinternet/releases-core/id";

describe("newCronRunId", () => {
  it("produces IDs with the crun_ prefix", () => {
    const id = newCronRunId();
    expect(id.startsWith("crun_")).toBe(true);
  });

  it("produces unique IDs across calls", () => {
    const a = newCronRunId();
    const b = newCronRunId();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 1.3: Run test, confirm fail**

Run: `bun test tests/unit/id.test.ts -t "newCronRunId" -v`

Expected: FAIL — `newCronRunId` not exported from `@buildinternet/releases-core/id`.

- [ ] **Step 1.4: Add the helper**

In `packages/core/src/id.ts`, mirroring the pattern used by other helpers (copy the shape of `newSourceId` exactly):

```ts
export function newCronRunId(): string {
  return `crun_${alphabet()}`;
}
```

(If the existing helpers use a different alphabet-per-prefix pattern, follow that pattern — don't introduce a new one.)

- [ ] **Step 1.5: Run test, confirm pass**

Run: `bun test tests/unit/id.test.ts -t "newCronRunId" -v`

Expected: 2 pass.

- [ ] **Step 1.6: Commit**

```bash
git add packages/core/src/id.ts tests/unit/id.test.ts
git commit -m "$(cat <<'EOF'
feat(cron): newCronRunId helper with crun_ prefix

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Schema — `cron_runs` Drizzle definition

**Files:**

- Create: `workers/api/src/db/schema-cron.ts`

- [ ] **Step 2.1: Read the comparable existing schema**

Run: `cat src/db/schema-coverage.ts`

Expected: a short file that declares one `sqliteTable`, an index or two, and exports the types. This is the pattern to mirror.

- [ ] **Step 2.2: Create the schema file**

Create `workers/api/src/db/schema-cron.ts`:

```ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { newCronRunId } from "@buildinternet/releases-core/id";

/**
 * Records one row per scheduled-event execution. Generic over `cronName` so
 * future crons (retier, poll-fetch) can be retrofitted into the same table
 * without a new migration. See docs/superpowers/specs/2026-04-18-scrape-agent-cron-design.md.
 */
export const cronRuns = sqliteTable(
  "cron_runs",
  {
    id: text("id").primaryKey().$defaultFn(newCronRunId),
    cronName: text("cron_name").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    durationMs: integer("duration_ms"),
    status: text("status", {
      enum: ["running", "done", "degraded", "dispatch_failed", "aborted"],
    }).notNull(),
    candidates: integer("candidates").notNull().default(0),
    dispatched: integer("dispatched").notNull().default(0),
    skippedOverCap: integer("skipped_over_cap").notNull().default(0),
    dispatchErrors: integer("dispatch_errors").notNull().default(0),
    sessionsStarted: text("sessions_started"),
    dispatchErrorDetail: text("dispatch_error_detail"),
    abortReason: text("abort_reason"),
    notes: text("notes"),
  },
  (table) => [index("idx_cron_runs_name_started").on(table.cronName, table.startedAt)],
);

export type CronRun = typeof cronRuns.$inferSelect;
export type NewCronRun = typeof cronRuns.$inferInsert;
```

- [ ] **Step 2.3: Typecheck**

Run: `cd workers/api && bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 2.4: Commit**

```bash
git add workers/api/src/db/schema-cron.ts
git commit -m "$(cat <<'EOF'
feat(cron): cron_runs Drizzle schema

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Migration pair

**Files:**

- Create: `workers/api/migrations/YYYYMMDDHHMMSS_cron_runs.sql` (timestamp from step 3.1)
- Auto-generate: `src/db/migrations/YYYYMMDDHHMMSS_cron_runs.sql` + meta snapshot

- [ ] **Step 3.1: Add the schema to the local `packages/core/src/schema.ts`**

Wait — re-read the spec: `cron_runs` is defined in `workers/api/src/db/schema-cron.ts`, NOT in `packages/core/src/schema.ts`. So `bun run db:generate` won't see it. We must hand-write the Drizzle migration + the D1 migration AND add a no-op entry to the Drizzle journal OR use `drizzle-kit generate` scoped to the worker schema.

Check which pattern the repo uses for worker-scoped tables:

Run: `grep -n "schema-coverage\|release_coverage" src/db/migrations/*.sql 2>/dev/null | head`

Expected: either a migration exists for `release_coverage` (meaning precedent is to include it in `drizzle-kit generate`) OR it doesn't (meaning precedent is to hand-write).

**If `release_coverage` has a Drizzle-generated migration:**

Update `drizzle.config.ts` (or wherever the schema array is declared) to include the new worker schema path `workers/api/src/db/schema-cron.ts`. Re-run `bun run db:generate` — it'll produce the timestamp-prefixed migration automatically.

**If `release_coverage` has no Drizzle-generated migration (hand-written only):**

Hand-write both migrations with the same timestamp prefix. Generate the timestamp:

```bash
date -u +"%Y%m%d%H%M%S"
```

Use that exact string as the prefix for both files.

- [ ] **Step 3.2: Create the D1 migration**

Create `workers/api/migrations/<TIMESTAMP>_cron_runs.sql`:

```sql
-- Records one row per scheduled-event execution. Generic over cron_name so
-- future crons can reuse this table. See
-- docs/superpowers/specs/2026-04-18-scrape-agent-cron-design.md.
CREATE TABLE cron_runs (
  id TEXT PRIMARY KEY NOT NULL,
  cron_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  status TEXT NOT NULL,
  candidates INTEGER NOT NULL DEFAULT 0,
  dispatched INTEGER NOT NULL DEFAULT 0,
  skipped_over_cap INTEGER NOT NULL DEFAULT 0,
  dispatch_errors INTEGER NOT NULL DEFAULT 0,
  sessions_started TEXT,
  dispatch_error_detail TEXT,
  abort_reason TEXT,
  notes TEXT
);

CREATE INDEX idx_cron_runs_name_started ON cron_runs (cron_name, started_at);
```

- [ ] **Step 3.3: Create or regenerate the Drizzle migration**

Either run `bun run db:generate` (if drizzle is configured to see the worker schema) and verify the produced SQL matches step 3.2, OR hand-write `src/db/migrations/<SAME_TIMESTAMP>_cron_runs.sql` with the same content and append an entry to `src/db/migrations/meta/_journal.json`:

```json
{
  "idx": <next idx>,
  "version": "7",
  "when": <millis matching timestamp>,
  "tag": "<TIMESTAMP>_cron_runs",
  "breakpoints": true
}
```

Adjust `idx` and `when` to match the rest of the journal — inspect it first.

- [ ] **Step 3.4: Run the migration filename linter**

Run: `bun run db:check-filenames`

Expected: exits 0 (no legacy `NNNN_` prefixes introduced).

- [ ] **Step 3.5: Commit**

```bash
git add workers/api/migrations/*_cron_runs.sql src/db/migrations/*_cron_runs.sql src/db/migrations/meta/_journal.json src/db/migrations/meta/*_snapshot.json 2>/dev/null
git commit -m "$(cat <<'EOF'
feat(cron): add cron_runs table migrations

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Migration integration test

**Files:**

- Create: `tests/api/cron-runs-migration.test.ts`

- [ ] **Step 4.1: Write the test**

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { sql } from "drizzle-orm";

describe("cron_runs migration", () => {
  it("creates the table with all columns and the composite index", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: "src/db/migrations" });

    const tables = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_runs'")
      .all();
    expect(tables.length).toBe(1);

    const indexes = sqlite
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cron_runs' AND name='idx_cron_runs_name_started'",
      )
      .all();
    expect(indexes.length).toBe(1);

    // Round-trip a row to confirm the column set matches the Drizzle schema
    db.insert(cronRuns)
      .values({
        id: "crun_testfixture",
        cronName: "scrape-agent-sweep",
        startedAt: "2026-04-18T01:00:00Z",
        status: "running",
      })
      .run();

    const [row] = db
      .select()
      .from(cronRuns)
      .where(sql`${cronRuns.id} = 'crun_testfixture'`)
      .all();
    expect(row.cronName).toBe("scrape-agent-sweep");
    expect(row.status).toBe("running");
    expect(row.candidates).toBe(0);
  });
});
```

- [ ] **Step 4.2: Run**

Run: `bun test tests/api/cron-runs-migration.test.ts -v`

Expected: PASS.

- [ ] **Step 4.3: Commit**

```bash
git add tests/api/cron-runs-migration.test.ts
git commit -m "$(cat <<'EOF'
test(cron): cron_runs migration applies and round-trips

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Bind-budget guardrail

**Files:**

- Create: `tests/api/cron-runs-bind-budget.test.ts`

- [ ] **Step 5.1: Write the test**

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { D1_MAX_BINDINGS } from "../../workers/api/src/lib/d1-limits";

const db = drizzle(new Database(":memory:"));

describe("cron_runs bind budget", () => {
  it("INSERT (initial running row) stays well under D1's 100-bind cap", () => {
    const q = db
      .insert(cronRuns)
      .values({
        id: "crun_x",
        cronName: "scrape-agent-sweep",
        startedAt: "2026-04-18T01:00:00Z",
        status: "running",
      })
      .toSQL();
    expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
    expect(q.params.length).toBeLessThan(10);
  });

  it("UPDATE (final row with all observability columns set) stays under cap", () => {
    const q = db
      .update(cronRuns)
      .set({
        endedAt: "2026-04-18T01:00:02Z",
        durationMs: 2000,
        status: "done",
        candidates: 14,
        dispatched: 14,
        skippedOverCap: 0,
        dispatchErrors: 0,
        sessionsStarted: JSON.stringify(["ma-1", "ma-2"]),
        dispatchErrorDetail: null,
        abortReason: null,
        notes: "ok",
      })
      .where(eq(cronRuns.id, "crun_x"))
      .toSQL();
    expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
    expect(q.params.length).toBeLessThan(20);
  });
});
```

- [ ] **Step 5.2: Run**

Run: `bun test tests/api/cron-runs-bind-budget.test.ts -v`

Expected: 2 pass.

- [ ] **Step 5.3: Commit**

```bash
git add tests/api/cron-runs-bind-budget.test.ts
git commit -m "$(cat <<'EOF'
test(cron): lock cron_runs INSERT/UPDATE bind count under D1 cap

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extract `runWithConcurrency`

**Files:**

- Create: `workers/api/src/lib/concurrency.ts`
- Modify: `workers/api/src/cron/poll-fetch.ts`

- [ ] **Step 6.1: Read the current definition**

Run: `sed -n '749,765p' workers/api/src/cron/poll-fetch.ts`

Expected: the `runWithConcurrency<T, R>` generic function.

- [ ] **Step 6.2: Create the shared module**

Create `workers/api/src/lib/concurrency.ts`:

```ts
/**
 * Run an async function over an array of items with bounded concurrency.
 * Workers share a FIFO queue; results are returned in completion order, not
 * input order. Callers that need stable ordering should pair by key.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      results.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 6.3: Update `poll-fetch.ts` to import it**

In `workers/api/src/cron/poll-fetch.ts`:

1. Add an import near the top (next to other local imports):

   ```ts
   import { runWithConcurrency } from "../lib/concurrency.js";
   ```

2. Delete the local `async function runWithConcurrency<T, R>(...) { ... }` definition (lines ~749–765).

- [ ] **Step 6.4: Typecheck + full test run**

Run: `cd workers/api && bunx tsc --noEmit && cd ../.. && bun test tests/unit tests/api`

Expected: typecheck clean, all tests still pass.

- [ ] **Step 6.5: Commit**

```bash
git add workers/api/src/lib/concurrency.ts workers/api/src/cron/poll-fetch.ts
git commit -m "$(cat <<'EOF'
refactor(cron): extract runWithConcurrency to shared lib

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Pure helper — `classifyPreflightResponse`

**Files:**

- Create: `workers/api/src/cron/scrape-agent-sweep.ts` (partial — add more exports in later tasks)
- Test: `tests/unit/scrape-agent-preflight.test.ts`

- [ ] **Step 7.1: Write the failing tests**

```ts
import { describe, it, expect } from "bun:test";
import { classifyPreflightResponse } from "../../workers/api/src/cron/scrape-agent-sweep";

describe("classifyPreflightResponse", () => {
  it("proceeds on 200", () => {
    expect(classifyPreflightResponse({ status: 200, body: "" })).toEqual({ action: "proceed" });
  });

  it("aborts on 401 with anthropic_auth", () => {
    expect(classifyPreflightResponse({ status: 401, body: "" })).toEqual({
      action: "abort",
      abortReason: "anthropic_auth",
    });
  });

  it("aborts on 403 with anthropic_auth", () => {
    expect(classifyPreflightResponse({ status: 403, body: "" })).toEqual({
      action: "abort",
      abortReason: "anthropic_auth",
    });
  });

  it("aborts on 402 with anthropic_credits", () => {
    expect(classifyPreflightResponse({ status: 402, body: "" })).toEqual({
      action: "abort",
      abortReason: "anthropic_credits",
    });
  });

  it("aborts on 429 with credit_balance_too_low body", () => {
    const body = JSON.stringify({ error: { type: "credit_balance_too_low", message: "…" } });
    expect(classifyPreflightResponse({ status: 429, body })).toEqual({
      action: "abort",
      abortReason: "anthropic_credits",
    });
  });

  it("warns (proceed) on 429 with unrelated body", () => {
    const body = JSON.stringify({ error: { type: "rate_limit_error" } });
    expect(classifyPreflightResponse({ status: 429, body })).toEqual({ action: "warn" });
  });

  it("warns (proceed) on 429 with non-JSON body", () => {
    expect(classifyPreflightResponse({ status: 429, body: "<html>…</html>" })).toEqual({
      action: "warn",
    });
  });

  it("warns (proceed) on 5xx", () => {
    expect(classifyPreflightResponse({ status: 503, body: "" })).toEqual({ action: "warn" });
  });
});
```

- [ ] **Step 7.2: Run, confirm fail**

Run: `bun test tests/unit/scrape-agent-preflight.test.ts -v`

Expected: FAIL — `classifyPreflightResponse` not found.

- [ ] **Step 7.3: Start the sweep module with the helper**

Create `workers/api/src/cron/scrape-agent-sweep.ts`:

```ts
/**
 * Daily cron that drains `changeDetectedAt`-flagged scrape-no-feed sources
 * through the managed-agents /update pipeline. See the design spec:
 * docs/superpowers/specs/2026-04-18-scrape-agent-cron-design.md.
 */

export type PreflightAction =
  | { action: "proceed" }
  | { action: "warn" }
  | { action: "abort"; abortReason: "anthropic_auth" | "anthropic_credits" };

/**
 * Classifies an Anthropic /v1/models pre-flight response. Single source of
 * truth for the preflight matrix in the design spec. Pure function — no
 * fetch, no side effects.
 */
export function classifyPreflightResponse(input: {
  status: number;
  body: string;
}): PreflightAction {
  const { status, body } = input;
  if (status === 200) return { action: "proceed" };
  if (status === 401 || status === 403) return { action: "abort", abortReason: "anthropic_auth" };
  if (status === 402) return { action: "abort", abortReason: "anthropic_credits" };
  if (status === 429) {
    // Narrow: 429 with a credit_balance_too_low error payload is permanent
    // (account out of credits). Any other 429 is transient rate-limiting;
    // per-session inference will surface real problems.
    try {
      const parsed = JSON.parse(body.slice(0, 1024)) as { error?: { type?: string } };
      if (parsed?.error?.type === "credit_balance_too_low") {
        return { action: "abort", abortReason: "anthropic_credits" };
      }
    } catch {
      // Non-JSON or malformed body: fall through to warn.
    }
    return { action: "warn" };
  }
  // 5xx or anything else unexpected: proceed but flag the run.
  return { action: "warn" };
}
```

- [ ] **Step 7.4: Run, confirm pass**

Run: `bun test tests/unit/scrape-agent-preflight.test.ts -v`

Expected: 8 pass.

- [ ] **Step 7.5: Commit**

```bash
git add workers/api/src/cron/scrape-agent-sweep.ts tests/unit/scrape-agent-preflight.test.ts
git commit -m "$(cat <<'EOF'
feat(cron): classifyPreflightResponse helper + tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Pure helper — `deriveSweepStatus`

**Files:**

- Modify: `workers/api/src/cron/scrape-agent-sweep.ts`
- Create: `tests/unit/scrape-agent-status-derivation.test.ts`

- [ ] **Step 8.1: Write the failing tests**

```ts
import { describe, it, expect } from "bun:test";
import { deriveSweepStatus } from "../../workers/api/src/cron/scrape-agent-sweep";

describe("deriveSweepStatus", () => {
  it("returns done with zero-candidate note when candidates=0", () => {
    const out = deriveSweepStatus({ candidates: 0, dispatchResults: [] });
    expect(out.status).toBe("done");
    expect(out.notes).toBe("no flagged sources");
  });

  it("returns done when all dispatches succeeded", () => {
    const out = deriveSweepStatus({
      candidates: 3,
      dispatchResults: [
        { orgSlug: "a", ok: true, sessionId: "ma-1" },
        { orgSlug: "b", ok: true, sessionId: "ma-2" },
        { orgSlug: "c", ok: true, sessionId: "ma-3" },
      ],
    });
    expect(out.status).toBe("done");
    expect(out.abortReason).toBeUndefined();
  });

  it("returns degraded when some dispatches failed", () => {
    const out = deriveSweepStatus({
      candidates: 3,
      dispatchResults: [
        { orgSlug: "a", ok: true, sessionId: "ma-1" },
        { orgSlug: "b", ok: false, error: "500 boom" },
      ],
    });
    expect(out.status).toBe("degraded");
  });

  it("returns dispatch_failed when all dispatches failed", () => {
    const out = deriveSweepStatus({
      candidates: 2,
      dispatchResults: [
        { orgSlug: "a", ok: false, error: "500 boom" },
        { orgSlug: "b", ok: false, error: "timeout" },
      ],
    });
    expect(out.status).toBe("dispatch_failed");
  });

  it("propagates an aborted preflight regardless of dispatch results", () => {
    const out = deriveSweepStatus({
      candidates: 0,
      dispatchResults: [],
      abortedPreflight: { action: "abort", abortReason: "anthropic_auth" },
    });
    expect(out.status).toBe("aborted");
    expect(out.abortReason).toBe("anthropic_auth");
  });
});
```

- [ ] **Step 8.2: Run, confirm fail**

Run: `bun test tests/unit/scrape-agent-status-derivation.test.ts -v`

Expected: FAIL — `deriveSweepStatus` not found.

- [ ] **Step 8.3: Add the helper to `scrape-agent-sweep.ts`**

Append to `workers/api/src/cron/scrape-agent-sweep.ts`:

```ts
export type DispatchResult =
  | { orgSlug: string; ok: true; sessionId: string }
  | { orgSlug: string; ok: false; error: string };

export type SweepStatus = "done" | "degraded" | "dispatch_failed" | "aborted";

export type DerivedStatus = {
  status: SweepStatus;
  abortReason?: "anthropic_auth" | "anthropic_credits";
  notes?: string;
};

/**
 * Pure reducer from candidates + dispatch outcomes (+ optional aborted
 * preflight) to the final cron_runs status. Single source of truth for the
 * status matrix in the design spec.
 */
export function deriveSweepStatus(input: {
  candidates: number;
  dispatchResults: DispatchResult[];
  abortedPreflight?: Extract<PreflightAction, { action: "abort" }>;
}): DerivedStatus {
  if (input.abortedPreflight) {
    return { status: "aborted", abortReason: input.abortedPreflight.abortReason };
  }
  if (input.candidates === 0) {
    return { status: "done", notes: "no flagged sources" };
  }
  const errored = input.dispatchResults.filter((r) => !r.ok).length;
  if (errored === 0) return { status: "done" };
  if (errored === input.dispatchResults.length) return { status: "dispatch_failed" };
  return { status: "degraded" };
}
```

- [ ] **Step 8.4: Run, confirm pass**

Run: `bun test tests/unit/scrape-agent-status-derivation.test.ts -v`

Expected: 5 pass.

- [ ] **Step 8.5: Commit**

```bash
git add workers/api/src/cron/scrape-agent-sweep.ts tests/unit/scrape-agent-status-derivation.test.ts
git commit -m "$(cat <<'EOF'
feat(cron): deriveSweepStatus helper + tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Pure helper — `groupByOrg`

**Files:**

- Modify: `workers/api/src/cron/scrape-agent-sweep.ts`
- Create: `tests/unit/scrape-agent-candidates.test.ts`

- [ ] **Step 9.1: Write the failing tests**

```ts
import { describe, it, expect } from "bun:test";
import { groupByOrg, type Candidate } from "../../workers/api/src/cron/scrape-agent-sweep";

const c = (overrides: Partial<Candidate>): Candidate => ({
  id: "src_1",
  slug: "s-1",
  orgId: "org_a",
  orgSlug: "a",
  orgName: "Org A",
  changeDetectedAt: "2026-04-18T00:00:00Z",
  ...overrides,
});

describe("groupByOrg", () => {
  it("returns an empty map for empty input", () => {
    expect(groupByOrg([])).toEqual(new Map());
  });

  it("groups sources by orgId preserving input order within each group", () => {
    const rows = [
      c({ id: "src_1", orgId: "org_a", changeDetectedAt: "2026-04-18T00:00:00Z" }),
      c({ id: "src_2", orgId: "org_b", changeDetectedAt: "2026-04-18T00:01:00Z" }),
      c({ id: "src_3", orgId: "org_a", changeDetectedAt: "2026-04-18T00:02:00Z" }),
    ];
    const out = groupByOrg(rows);
    expect(out.size).toBe(2);
    expect(out.get("org_a")!.sources.map((s) => s.id)).toEqual(["src_1", "src_3"]);
    expect(out.get("org_b")!.sources.map((s) => s.id)).toEqual(["src_2"]);
  });

  it("exposes orgSlug and orgName on each group", () => {
    const out = groupByOrg([c({ orgId: "org_x", orgSlug: "x", orgName: "Org X" })]);
    const group = out.get("org_x")!;
    expect(group.orgSlug).toBe("x");
    expect(group.orgName).toBe("Org X");
  });
});
```

- [ ] **Step 9.2: Run, confirm fail**

Run: `bun test tests/unit/scrape-agent-candidates.test.ts -v`

Expected: FAIL — `groupByOrg` / `Candidate` not exported.

- [ ] **Step 9.3: Add the helper + type to `scrape-agent-sweep.ts`**

Append to `workers/api/src/cron/scrape-agent-sweep.ts`:

```ts
export type Candidate = {
  id: string;
  slug: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  changeDetectedAt: string;
};

export type OrgGroup = {
  orgId: string;
  orgSlug: string;
  orgName: string;
  sources: Candidate[];
};

/**
 * Group candidates by `orgId`. Preserves input order within each group
 * (the SQL caller orders by `changeDetectedAt ASC` so oldest flags drain
 * first within the org).
 */
export function groupByOrg(rows: Candidate[]): Map<string, OrgGroup> {
  const groups = new Map<string, OrgGroup>();
  for (const row of rows) {
    const existing = groups.get(row.orgId);
    if (existing) {
      existing.sources.push(row);
    } else {
      groups.set(row.orgId, {
        orgId: row.orgId,
        orgSlug: row.orgSlug,
        orgName: row.orgName,
        sources: [row],
      });
    }
  }
  return groups;
}
```

- [ ] **Step 9.4: Run, confirm pass**

Run: `bun test tests/unit/scrape-agent-candidates.test.ts -v`

Expected: 3 pass.

- [ ] **Step 9.5: Commit**

```bash
git add workers/api/src/cron/scrape-agent-sweep.ts tests/unit/scrape-agent-candidates.test.ts
git commit -m "$(cat <<'EOF'
feat(cron): groupByOrg candidate helper + tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `cron_runs` DAO — insert + update

**Files:**

- Create: `workers/api/src/db/cron-runs-dao.ts`
- Create: `tests/api/cron-runs-dao.test.ts`

- [ ] **Step 10.1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { insertRunningRow, finalizeRunRow } from "../../workers/api/src/db/cron-runs-dao";

function makeDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/db/migrations" });
  return { db, sqlite };
}

describe("cron_runs DAO", () => {
  it("inserts a running row and returns its id", async () => {
    const { db } = makeDb();
    const id = await insertRunningRow(db, {
      cronName: "scrape-agent-sweep",
      startedAt: "2026-04-18T01:00:00Z",
    });
    expect(id.startsWith("crun_")).toBe(true);
    const [row] = db.select().from(cronRuns).where(eq(cronRuns.id, id)).all();
    expect(row.status).toBe("running");
    expect(row.cronName).toBe("scrape-agent-sweep");
  });

  it("finalizes a running row with computed duration_ms", async () => {
    const { db } = makeDb();
    const id = await insertRunningRow(db, {
      cronName: "scrape-agent-sweep",
      startedAt: "2026-04-18T01:00:00Z",
    });
    await finalizeRunRow(db, id, {
      endedAt: "2026-04-18T01:00:02.500Z",
      status: "done",
      candidates: 5,
      dispatched: 5,
      skippedOverCap: 0,
      dispatchErrors: 0,
      sessionsStarted: ["ma-1", "ma-2"],
      dispatchErrorDetail: [],
      notes: "ok",
    });
    const [row] = db.select().from(cronRuns).where(eq(cronRuns.id, id)).all();
    expect(row.status).toBe("done");
    expect(row.durationMs).toBe(2500);
    expect(row.sessionsStarted).toBe(JSON.stringify(["ma-1", "ma-2"]));
    expect(row.dispatchErrorDetail).toBeNull();
  });

  it("writes dispatchErrorDetail as JSON when non-empty", async () => {
    const { db } = makeDb();
    const id = await insertRunningRow(db, {
      cronName: "scrape-agent-sweep",
      startedAt: "2026-04-18T01:00:00Z",
    });
    await finalizeRunRow(db, id, {
      endedAt: "2026-04-18T01:00:01Z",
      status: "degraded",
      candidates: 2,
      dispatched: 1,
      skippedOverCap: 0,
      dispatchErrors: 1,
      sessionsStarted: ["ma-1"],
      dispatchErrorDetail: [{ orgSlug: "bad-org", error: "500 boom" }],
      notes: null,
    });
    const [row] = db.select().from(cronRuns).where(eq(cronRuns.id, id)).all();
    expect(JSON.parse(row.dispatchErrorDetail!)).toEqual([
      { orgSlug: "bad-org", error: "500 boom" },
    ]);
  });

  it("truncates dispatchErrorDetail and sessionsStarted arrays to 20 entries", async () => {
    const { db } = makeDb();
    const id = await insertRunningRow(db, {
      cronName: "scrape-agent-sweep",
      startedAt: "2026-04-18T01:00:00Z",
    });
    const sessions = Array.from({ length: 30 }, (_, i) => `ma-${i}`);
    const errors = Array.from({ length: 30 }, (_, i) => ({ orgSlug: `o-${i}`, error: "e" }));
    await finalizeRunRow(db, id, {
      endedAt: "2026-04-18T01:00:01Z",
      status: "degraded",
      candidates: 30,
      dispatched: 20,
      skippedOverCap: 0,
      dispatchErrors: 10,
      sessionsStarted: sessions,
      dispatchErrorDetail: errors,
      notes: null,
    });
    const [row] = db.select().from(cronRuns).where(eq(cronRuns.id, id)).all();
    expect(JSON.parse(row.sessionsStarted!).length).toBe(20);
    expect(JSON.parse(row.dispatchErrorDetail!).length).toBe(20);
  });
});
```

- [ ] **Step 10.2: Run, confirm fail**

Run: `bun test tests/api/cron-runs-dao.test.ts -v`

Expected: FAIL — DAO not found.

- [ ] **Step 10.3: Write the DAO**

Create `workers/api/src/db/cron-runs-dao.ts`:

```ts
import { eq } from "drizzle-orm";
import { cronRuns } from "./schema-cron.js";
import { newCronRunId } from "@buildinternet/releases-core/id";

type Drizzled = Parameters<typeof cronRuns.$inferInsert>[0] extends never ? never : any;

/** Cap on JSON arrays stored in dispatch_error_detail / sessions_started. */
export const CRON_RUNS_JSON_ARRAY_CAP = 20;

export async function insertRunningRow(
  db: { insert: Function },
  params: { cronName: string; startedAt: string },
): Promise<string> {
  const id = newCronRunId();
  (await (db as any)
    .insert(cronRuns)
    .values({
      id,
      cronName: params.cronName,
      startedAt: params.startedAt,
      status: "running",
    })
    .run?.()) ??
    (await (db as any).insert(cronRuns).values({
      id,
      cronName: params.cronName,
      startedAt: params.startedAt,
      status: "running",
    }));
  return id;
}

export type FinalizeRunParams = {
  endedAt: string;
  status: "done" | "degraded" | "dispatch_failed" | "aborted";
  candidates: number;
  dispatched: number;
  skippedOverCap: number;
  dispatchErrors: number;
  sessionsStarted: string[];
  dispatchErrorDetail: Array<{ orgSlug: string; error: string }>;
  abortReason?:
    | "anthropic_auth"
    | "anthropic_credits"
    | "stale_running"
    | "cron_disabled"
    | "config_missing";
  notes: string | null;
};

export async function finalizeRunRow(
  db: any,
  id: string,
  params: FinalizeRunParams,
): Promise<void> {
  // Compute duration from the running row's startedAt to avoid trusting callers.
  const [row] =
    (await db
      .select({ startedAt: cronRuns.startedAt })
      .from(cronRuns)
      .where(eq(cronRuns.id, id))
      .all?.()) ??
    (await db.select({ startedAt: cronRuns.startedAt }).from(cronRuns).where(eq(cronRuns.id, id)));
  const durationMs = row
    ? new Date(params.endedAt).getTime() - new Date(row.startedAt).getTime()
    : null;

  const sessionsArr = params.sessionsStarted.slice(0, CRON_RUNS_JSON_ARRAY_CAP);
  const errorsArr = params.dispatchErrorDetail.slice(0, CRON_RUNS_JSON_ARRAY_CAP);

  await db
    .update(cronRuns)
    .set({
      endedAt: params.endedAt,
      durationMs,
      status: params.status,
      candidates: params.candidates,
      dispatched: params.dispatched,
      skippedOverCap: params.skippedOverCap,
      dispatchErrors: params.dispatchErrors,
      sessionsStarted: sessionsArr.length > 0 ? JSON.stringify(sessionsArr) : null,
      dispatchErrorDetail: errorsArr.length > 0 ? JSON.stringify(errorsArr) : null,
      abortReason: params.abortReason ?? null,
      notes: params.notes,
    })
    .where(eq(cronRuns.id, id));
}
```

Note: the `any` casts around `db` accommodate both the bun-sqlite driver (used by tests) and the d1 driver (used in the worker) — their return shapes are slightly different. If this looks too loose, consider a generic parameter: `<D extends { insert: ...; update: ...; select: ... }>`. Pick whichever reads cleaner after running the tests.

- [ ] **Step 10.4: Run, confirm pass**

Run: `bun test tests/api/cron-runs-dao.test.ts -v`

Expected: 4 pass.

- [ ] **Step 10.5: Commit**

```bash
git add workers/api/src/db/cron-runs-dao.ts tests/api/cron-runs-dao.test.ts
git commit -m "$(cat <<'EOF'
feat(cron): cron_runs DAO insert/finalize helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Stale-running reconciler

**Files:**

- Modify: `workers/api/src/db/cron-runs-dao.ts`
- Create: `tests/api/stale-running-reconciler.test.ts`

- [ ] **Step 11.1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { reconcileStaleRunning } from "../../workers/api/src/db/cron-runs-dao";
import { eq } from "drizzle-orm";

function makeDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/db/migrations" });
  return db;
}

describe("reconcileStaleRunning", () => {
  it("marks a >10min-old running row as aborted with stale_running", async () => {
    const db = makeDb();
    const now = new Date("2026-04-18T01:00:00Z");
    const staleStart = new Date(now.getTime() - 20 * 60 * 1000).toISOString();

    await db
      .insert(cronRuns)
      .values({
        id: "crun_stale",
        cronName: "scrape-agent-sweep",
        startedAt: staleStart,
        status: "running",
      })
      .run();

    const reconciled = await reconcileStaleRunning(db, {
      cronName: "scrape-agent-sweep",
      now,
      thresholdMs: 10 * 60 * 1000,
    });
    expect(reconciled).toBe(1);

    const [row] = db.select().from(cronRuns).where(eq(cronRuns.id, "crun_stale")).all();
    expect(row.status).toBe("aborted");
    expect(row.abortReason).toBe("stale_running");
    expect(row.endedAt).toBe(now.toISOString());
  });

  it("leaves running rows younger than the threshold alone", async () => {
    const db = makeDb();
    const now = new Date("2026-04-18T01:00:00Z");
    const freshStart = new Date(now.getTime() - 2 * 60 * 1000).toISOString();

    await db
      .insert(cronRuns)
      .values({
        id: "crun_fresh",
        cronName: "scrape-agent-sweep",
        startedAt: freshStart,
        status: "running",
      })
      .run();

    const reconciled = await reconcileStaleRunning(db, {
      cronName: "scrape-agent-sweep",
      now,
      thresholdMs: 10 * 60 * 1000,
    });
    expect(reconciled).toBe(0);

    const [row] = db.select().from(cronRuns).where(eq(cronRuns.id, "crun_fresh")).all();
    expect(row.status).toBe("running");
  });

  it("only touches rows of the matching cron_name", async () => {
    const db = makeDb();
    const now = new Date("2026-04-18T01:00:00Z");
    const staleStart = new Date(now.getTime() - 20 * 60 * 1000).toISOString();

    await db
      .insert(cronRuns)
      .values({
        id: "crun_other",
        cronName: "retier",
        startedAt: staleStart,
        status: "running",
      })
      .run();

    const reconciled = await reconcileStaleRunning(db, {
      cronName: "scrape-agent-sweep",
      now,
      thresholdMs: 10 * 60 * 1000,
    });
    expect(reconciled).toBe(0);

    const [row] = db.select().from(cronRuns).where(eq(cronRuns.id, "crun_other")).all();
    expect(row.status).toBe("running");
  });
});
```

- [ ] **Step 11.2: Run, confirm fail**

Run: `bun test tests/api/stale-running-reconciler.test.ts -v`

Expected: FAIL — `reconcileStaleRunning` not found.

- [ ] **Step 11.3: Add the reconciler to the DAO**

Append to `workers/api/src/db/cron-runs-dao.ts`:

```ts
import { and, lt, sql } from "drizzle-orm";

export async function reconcileStaleRunning(
  db: any,
  params: { cronName: string; now: Date; thresholdMs: number },
): Promise<number> {
  const cutoff = new Date(params.now.getTime() - params.thresholdMs).toISOString();
  const result = await db
    .update(cronRuns)
    .set({
      status: "aborted",
      abortReason: "stale_running",
      endedAt: params.now.toISOString(),
      notes: "reconciled by next sweep",
    })
    .where(
      and(
        eq(cronRuns.cronName, params.cronName),
        eq(cronRuns.status, "running"),
        lt(cronRuns.startedAt, cutoff),
      ),
    )
    .returning({ id: cronRuns.id });
  return Array.isArray(result) ? result.length : 0;
}
```

Update the top-of-file imports to include `and, lt` alongside the existing `eq`.

- [ ] **Step 11.4: Run, confirm pass**

Run: `bun test tests/api/stale-running-reconciler.test.ts -v`

Expected: 3 pass.

- [ ] **Step 11.5: Commit**

```bash
git add workers/api/src/db/cron-runs-dao.ts tests/api/stale-running-reconciler.test.ts
git commit -m "$(cat <<'EOF'
feat(cron): stale-running row reconciler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Candidate query

**Files:**

- Modify: `workers/api/src/cron/scrape-agent-sweep.ts` (add `queryCandidates` function)
- Create: `tests/api/scrape-agent-candidate-query.test.ts`

- [ ] **Step 12.1: Write the failing integration test**

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { sources, organizations } from "@buildinternet/releases-core/schema";
import { queryCandidates } from "../../workers/api/src/cron/scrape-agent-sweep";

function seed() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/db/migrations" });

  db.insert(organizations)
    .values([
      { id: "org_a", name: "Org A", slug: "a", category: "developer-tools" },
      { id: "org_b", name: "Org B", slug: "b", category: "developer-tools" },
    ])
    .run();

  db.insert(sources)
    .values([
      // Eligible: scrape, flagged, no feedUrl, not paused, not hidden
      {
        id: "src_1",
        name: "S1",
        slug: "s-1",
        type: "scrape",
        url: "https://a.com/changelog",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: JSON.stringify({ noFeedFound: true }),
      },
      {
        id: "src_2",
        name: "S2",
        slug: "s-2",
        type: "scrape",
        url: "https://b.com/changelog",
        orgId: "org_b",
        changeDetectedAt: "2026-04-17T00:00:00Z",
        metadata: "{}",
      },
      // Ineligible: has feedUrl
      {
        id: "src_3",
        name: "S3",
        slug: "s-3",
        type: "scrape",
        url: "https://a.com/releases",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: JSON.stringify({ feedUrl: "https://a.com/rss.xml", feedType: "rss" }),
      },
      // Ineligible: paused
      {
        id: "src_4",
        name: "S4",
        slug: "s-4",
        type: "scrape",
        url: "https://a.com/notes",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        fetchPriority: "paused",
        metadata: "{}",
      },
      // Ineligible: not flagged
      {
        id: "src_5",
        name: "S5",
        slug: "s-5",
        type: "scrape",
        url: "https://a.com/news",
        orgId: "org_a",
        changeDetectedAt: null,
        metadata: "{}",
      },
      // Ineligible: github type
      {
        id: "src_6",
        name: "S6",
        slug: "s-6",
        type: "github",
        url: "https://github.com/a/b",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: "{}",
      },
      // Ineligible: hidden
      {
        id: "src_7",
        name: "S7",
        slug: "s-7",
        type: "scrape",
        url: "https://a.com/hidden",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        isHidden: true,
        metadata: "{}",
      },
      // Ineligible: no org
      {
        id: "src_8",
        name: "S8",
        slug: "s-8",
        type: "scrape",
        url: "https://orphan.com",
        orgId: null,
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: "{}",
      },
    ])
    .run();

  return db;
}

describe("queryCandidates", () => {
  it("returns only eligible rows, ordered by changeDetectedAt ASC, under the cap", async () => {
    const db = seed();
    const result = await queryCandidates(db, { cap: 10 });
    expect(result.rows.map((r) => r.id)).toEqual(["src_2", "src_1"]);
    expect(result.skippedOverCap).toBe(0);
  });

  it("slices to cap and sets skippedOverCap when more than cap matched", async () => {
    const db = seed();
    const result = await queryCandidates(db, { cap: 1 });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].id).toBe("src_2"); // oldest first
    expect(result.skippedOverCap).toBe(1);
  });

  it("returns empty when nothing is flagged", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: "src/db/migrations" });
    const result = await queryCandidates(db, { cap: 10 });
    expect(result.rows).toEqual([]);
    expect(result.skippedOverCap).toBe(0);
  });
});
```

- [ ] **Step 12.2: Run, confirm fail**

Run: `bun test tests/api/scrape-agent-candidate-query.test.ts -v`

Expected: FAIL — `queryCandidates` not found.

- [ ] **Step 12.3: Add the query function**

Append to `workers/api/src/cron/scrape-agent-sweep.ts`:

```ts
import { sql } from "drizzle-orm";

export type CandidateQueryResult = {
  rows: Candidate[];
  skippedOverCap: number;
};

/**
 * Query flagged scrape-no-feed sources. Returns up to `cap` rows; if more
 * than `cap` matched, runs a follow-up COUNT(*) to populate skippedOverCap.
 * Most sweeps take the fast path (no count query).
 */
export async function queryCandidates(
  db: any,
  params: { cap: number },
): Promise<CandidateQueryResult> {
  const rows =
    (await db.all?.(sql`
    SELECT
      s.id AS id, s.slug AS slug, s.org_id AS org_id,
      o.slug AS org_slug, o.name AS org_name,
      s.change_detected_at AS change_detected_at
    FROM sources s
    INNER JOIN organizations o ON o.id = s.org_id
    WHERE
      s.type = 'scrape'
      AND s.fetch_priority != 'paused'
      AND s.change_detected_at IS NOT NULL
      AND (json_extract(s.metadata, '$.feedUrl') IS NULL OR s.metadata IS NULL)
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
    ORDER BY s.change_detected_at ASC
    LIMIT ${params.cap + 1}
  `)) ?? [];

  let skippedOverCap = 0;
  let sliced: typeof rows = rows;
  if (rows.length > params.cap) {
    sliced = rows.slice(0, params.cap);
    const countRes = await db.all?.(sql`
      SELECT COUNT(*) AS c FROM sources s
      INNER JOIN organizations o ON o.id = s.org_id
      WHERE s.type = 'scrape'
        AND s.fetch_priority != 'paused'
        AND s.change_detected_at IS NOT NULL
        AND (json_extract(s.metadata, '$.feedUrl') IS NULL OR s.metadata IS NULL)
        AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
    `);
    skippedOverCap = (countRes?.[0]?.c ?? sliced.length) - params.cap;
  }

  return {
    rows: sliced.map((r: any) => ({
      id: r.id,
      slug: r.slug,
      orgId: r.org_id,
      orgSlug: r.org_slug,
      orgName: r.org_name,
      changeDetectedAt: r.change_detected_at,
    })),
    skippedOverCap,
  };
}
```

(If the bun-sqlite driver doesn't support `db.all(sql``)` directly, use the drizzle approach: build the query with `db.select(...).from(sources).innerJoin(...).where(...).orderBy(...).limit(...)`. Check how `workers/api/src/queries/sources.ts` phrases similar raw queries — mirror that.)

- [ ] **Step 12.4: Run, confirm pass**

Run: `bun test tests/api/scrape-agent-candidate-query.test.ts -v`

Expected: 3 pass.

- [ ] **Step 12.5: Commit**

```bash
git add workers/api/src/cron/scrape-agent-sweep.ts tests/api/scrape-agent-candidate-query.test.ts
git commit -m "$(cat <<'EOF'
feat(cron): queryCandidates with cap + skippedOverCap accounting

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Anthropic pre-flight fetcher + dispatcher + `scrapeAgentSweep` composition

**Files:**

- Modify: `workers/api/src/cron/scrape-agent-sweep.ts` (add main `scrapeAgentSweep` function + private fetchers)
- Create: `tests/api/scrape-agent-sweep.test.ts`

- [ ] **Step 13.1: Write the E2E test**

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { sources, organizations } from "@buildinternet/releases-core/schema";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { scrapeAgentSweep } from "../../workers/api/src/cron/scrape-agent-sweep";
import { eq, desc } from "drizzle-orm";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/db/migrations" });
  db.insert(organizations)
    .values([
      { id: "org_a", name: "Org A", slug: "a", category: "developer-tools" },
      { id: "org_b", name: "Org B", slug: "b", category: "developer-tools" },
      { id: "org_c", name: "Org C", slug: "c", category: "developer-tools" },
    ])
    .run();
  db.insert(sources)
    .values([
      {
        id: "src_1",
        name: "S1",
        slug: "s-1",
        type: "scrape",
        url: "https://a.com/c",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: "{}",
      },
      {
        id: "src_2",
        name: "S2",
        slug: "s-2",
        type: "scrape",
        url: "https://a.com/d",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:01:00Z",
        metadata: "{}",
      },
      {
        id: "src_3",
        name: "S3",
        slug: "s-3",
        type: "scrape",
        url: "https://b.com/c",
        orgId: "org_b",
        changeDetectedAt: "2026-04-18T00:02:00Z",
        metadata: "{}",
      },
      {
        id: "src_4",
        name: "S4",
        slug: "s-4",
        type: "scrape",
        url: "https://c.com/c",
        orgId: "org_c",
        changeDetectedAt: "2026-04-18T00:03:00Z",
        metadata: "{}",
      },
    ])
    .run();
  return db;
}

function mkEnv(overrides: Partial<Parameters<typeof scrapeAgentSweep>[0]> = {}) {
  return {
    DB: {} as any, // not used when drizzle instance passed directly (see arg signature)
    CRON_ENABLED: "true",
    SCRAPE_AGENT_CRON_ENABLED: "true",
    SCRAPE_AGENT_MAX_SESSIONS: "20",
    DISCOVERY_WORKER: {
      fetch: async () => new Response(JSON.stringify({ sessionId: "ma-auto" }), { status: 202 }),
    },
    RELEASED_API_KEY: "test-key",
    ANTHROPIC_API_KEY: "test-anthropic-key",
    ...overrides,
  };
}

describe("scrapeAgentSweep (E2E)", () => {
  it("happy path: 3 orgs → 3 dispatches → status done", async () => {
    const db = mkDb();
    let dispatchCount = 0;
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async () => {
          dispatchCount++;
          return new Response(JSON.stringify({ sessionId: `ma-${dispatchCount}` }), {
            status: 202,
          });
        },
      },
    });
    // Stub global fetch for the Anthropic pre-flight
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      await scrapeAgentSweep({ ...env, _drizzleOverride: db } as any);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(dispatchCount).toBe(3);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("done");
    expect(run.dispatched).toBe(3);
    expect(run.candidates).toBe(4);
    expect(JSON.parse(run.sessionsStarted!).length).toBe(3);
  });

  it("pre-flight auth failure: aborts with no dispatches", async () => {
    const db = mkDb();
    let dispatchCount = 0;
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async () => {
          dispatchCount++;
          return new Response("{}", { status: 202 });
        },
      },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    try {
      await scrapeAgentSweep({ ...env, _drizzleOverride: db } as any);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(dispatchCount).toBe(0);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("aborted");
    expect(run.abortReason).toBe("anthropic_auth");
  });

  it("mixed dispatch: 2 succeed, 1 errors → degraded", async () => {
    const db = mkDb();
    let callCount = 0;
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async () => {
          callCount++;
          if (callCount === 2) return new Response("500 boom", { status: 500 });
          return new Response(JSON.stringify({ sessionId: `ma-${callCount}` }), { status: 202 });
        },
      },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      await scrapeAgentSweep({ ...env, _drizzleOverride: db } as any);
    } finally {
      globalThis.fetch = realFetch;
    }
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("degraded");
    expect(run.dispatched).toBe(2);
    expect(run.dispatchErrors).toBe(1);
    expect(JSON.parse(run.dispatchErrorDetail!)).toHaveLength(1);
  });

  it("cap enforcement: 25 candidates + cap=20 → 20 dispatched, skipped=5", async () => {
    const db = mkDb();
    // Add 21 more single-source orgs
    for (let i = 0; i < 21; i++) {
      db.insert(organizations)
        .values({
          id: `org_extra_${i}`,
          name: `Org ${i}`,
          slug: `extra-${i}`,
          category: "developer-tools",
        })
        .run();
      db.insert(sources)
        .values({
          id: `src_extra_${i}`,
          name: `S${i}`,
          slug: `se-${i}`,
          type: "scrape",
          url: `https://extra-${i}.com/c`,
          orgId: `org_extra_${i}`,
          changeDetectedAt: `2026-04-18T01:${String(i).padStart(2, "0")}:00Z`,
          metadata: "{}",
        })
        .run();
    }
    let dispatchCount = 0;
    const env = mkEnv({
      SCRAPE_AGENT_MAX_SESSIONS: "20",
      DISCOVERY_WORKER: {
        fetch: async () => {
          dispatchCount++;
          return new Response(JSON.stringify({ sessionId: `ma-${dispatchCount}` }), {
            status: 202,
          });
        },
      },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      await scrapeAgentSweep({ ...env, _drizzleOverride: db } as any);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(dispatchCount).toBe(20);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.candidates).toBe(20);
    expect(run.skippedOverCap).toBe(5);
  });

  it("no candidates: writes a done row with notes", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: "src/db/migrations" });
    const env = mkEnv();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      await scrapeAgentSweep({ ...env, _drizzleOverride: db } as any);
    } finally {
      globalThis.fetch = realFetch;
    }
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("done");
    expect(run.candidates).toBe(0);
    expect(run.notes).toBe("no flagged sources");
  });
});
```

Note the `_drizzleOverride` escape-hatch in the test — this is the interface the test needs. In the implementation, when `_drizzleOverride` is provided, use it instead of constructing `drizzle(env.DB)`. Otherwise construct from `env.DB`. Mark the option clearly as test-only in a code comment.

- [ ] **Step 13.2: Run, confirm fail**

Run: `bun test tests/api/scrape-agent-sweep.test.ts -v`

Expected: FAIL — `scrapeAgentSweep` not exported.

- [ ] **Step 13.3: Implement `scrapeAgentSweep` and its private fetchers**

Append to `workers/api/src/cron/scrape-agent-sweep.ts`:

```ts
import { drizzle } from "drizzle-orm/d1";
import { runWithConcurrency } from "../lib/concurrency.js";
import { insertRunningRow, finalizeRunRow, reconcileStaleRunning } from "../db/cron-runs-dao.js";

const CRON_NAME = "scrape-agent-sweep";
const PREFLIGHT_TIMEOUT_MS = 3000;
const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 20;
const CONCURRENCY = 3;

export type SweepEnv = {
  DB: D1Database;
  CRON_ENABLED?: string;
  SCRAPE_AGENT_CRON_ENABLED?: string;
  SCRAPE_AGENT_MAX_SESSIONS?: string;
  DISCOVERY_WORKER: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  RELEASED_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
  _drizzleOverride?: any;
};

export async function scrapeAgentSweep(env: SweepEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    console.log("[scrape-agent-cron] CRON_ENABLED=false; skipping");
    return;
  }
  if (env.SCRAPE_AGENT_CRON_ENABLED === "false") {
    console.log("[scrape-agent-cron] SCRAPE_AGENT_CRON_ENABLED=false; skipping");
    return;
  }

  const db = env._drizzleOverride ?? drizzle(env.DB);
  const now = new Date();
  const sweepCorrelationId = crypto.randomUUID();
  const cap = parseMaxSessions(env.SCRAPE_AGENT_MAX_SESSIONS);

  await reconcileStaleRunning(db, {
    cronName: CRON_NAME,
    now,
    thresholdMs: STALE_RUNNING_THRESHOLD_MS,
  });

  const runId = await insertRunningRow(db, { cronName: CRON_NAME, startedAt: now.toISOString() });

  // Pre-flight
  let aborted: Extract<PreflightAction, { action: "abort" }> | undefined;
  if (env.ANTHROPIC_API_KEY) {
    const preflight = await runPreflight(env.ANTHROPIC_API_KEY);
    if (preflight.action === "abort") aborted = preflight;
  } else {
    console.warn(
      "[scrape-agent-cron] ANTHROPIC_API_KEY missing — skipping pre-flight; sessions may fail",
    );
  }

  if (aborted) {
    await finalizeRunRow(db, runId, {
      endedAt: new Date().toISOString(),
      status: "aborted",
      abortReason: aborted.abortReason,
      candidates: 0,
      dispatched: 0,
      skippedOverCap: 0,
      dispatchErrors: 0,
      sessionsStarted: [],
      dispatchErrorDetail: [],
      notes: `preflight aborted: ${aborted.abortReason}`,
    });
    return;
  }

  const { rows, skippedOverCap } = await queryCandidates(db, { cap });
  const groups = groupByOrg(rows);

  const dispatchResults: DispatchResult[] = await runWithConcurrency(
    Array.from(groups.values()),
    CONCURRENCY,
    (group) => dispatchOne(env, sweepCorrelationId, group),
  );

  const derived = deriveSweepStatus({ candidates: rows.length, dispatchResults });
  const sessionsStarted = dispatchResults
    .filter((r) => r.ok)
    .map((r) => (r as any).sessionId as string);
  const dispatchErrors = dispatchResults.filter((r) => !r.ok) as Array<{
    orgSlug: string;
    ok: false;
    error: string;
  }>;

  await finalizeRunRow(db, runId, {
    endedAt: new Date().toISOString(),
    status: derived.status,
    abortReason: derived.abortReason,
    candidates: rows.length,
    dispatched: sessionsStarted.length,
    skippedOverCap,
    dispatchErrors: dispatchErrors.length,
    sessionsStarted,
    dispatchErrorDetail: dispatchErrors.map((e) => ({ orgSlug: e.orgSlug, error: e.error })),
    notes: derived.notes ?? null,
  });

  console.log(
    `[scrape-agent-cron] done: run=${runId} status=${derived.status} candidates=${rows.length} dispatched=${sessionsStarted.length} errors=${dispatchErrors.length} skipped=${skippedOverCap}`,
  );
}

function parseMaxSessions(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_SESSIONS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[scrape-agent-cron] invalid SCRAPE_AGENT_MAX_SESSIONS=${raw}; using default ${DEFAULT_MAX_SESSIONS}`,
    );
    return DEFAULT_MAX_SESSIONS;
  }
  return n;
}

async function runPreflight(apiKey: string): Promise<PreflightAction> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: controller.signal,
    });
    const body = await res.text().catch(() => "");
    return classifyPreflightResponse({ status: res.status, body });
  } catch (err) {
    // Timeout or network error → warn (proceed anyway).
    console.warn(
      `[scrape-agent-cron] preflight failed: ${err instanceof Error ? err.message : err}`,
    );
    return { action: "warn" };
  } finally {
    clearTimeout(timeout);
  }
}

async function dispatchOne(
  env: SweepEnv,
  sweepCorrelationId: string,
  group: OrgGroup,
): Promise<DispatchResult> {
  try {
    const res = await env.DISCOVERY_WORKER.fetch("https://discovery/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RELEASED_API_KEY}`,
      },
      body: JSON.stringify({
        company: group.orgName,
        sourceIdentifiers: group.sources.map((s) => s.id),
        orgId: group.orgId,
        correlationId: `${sweepCorrelationId}:${group.orgSlug}`,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { orgSlug: group.orgSlug, ok: false, error: `${res.status} ${body.slice(0, 200)}` };
    }
    const { sessionId } = (await res.json()) as { sessionId: string };
    return { orgSlug: group.orgSlug, ok: true, sessionId };
  } catch (err) {
    return {
      orgSlug: group.orgSlug,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 13.4: Run the E2E test, iterate until it passes**

Run: `bun test tests/api/scrape-agent-sweep.test.ts -v`

Expected: 5 pass. If any fail, read the error, fix the imports / types / SQL in the implementation (not the test), and re-run.

- [ ] **Step 13.5: Run the whole test suite to confirm no regressions**

Run: `bun test tests/unit tests/api && cd workers/api && bunx tsc --noEmit`

Expected: all tests pass (totals go up by ~25), typecheck clean.

- [ ] **Step 13.6: Commit**

```bash
git add workers/api/src/cron/scrape-agent-sweep.ts tests/api/scrape-agent-sweep.test.ts
git commit -m "$(cat <<'EOF'
feat(cron): scrapeAgentSweep orchestrator with pre-flight + dispatch

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Wrangler config

**Files:**

- Modify: `workers/api/wrangler.jsonc`

- [ ] **Step 14.1: Read current config**

Run: `cat workers/api/wrangler.jsonc | head -80`

Note the `"triggers"` block (has `crons` array), the `"vars"` block, and the existing `secrets_store_secrets` bindings (specifically the `ANTHROPIC_API_KEY` binding on the discovery worker, for reference).

- [ ] **Step 14.2: Add the cron trigger, env vars, and secret binding**

Edit `workers/api/wrangler.jsonc`:

1. In `triggers.crons`, add the new pattern with an explanatory comment:

   ```jsonc
   "crons": [
     "0 * * * *",     // hourly: poll + fetch feed/github
     "0 3 * * *",     // daily 03:00 UTC: fetchPriority retier
     "0 1 * * *"      // daily 01:00 UTC: scrape-no-feed agent sweep
   ]
   ```

2. In `vars`, add:

   ```jsonc
   "SCRAPE_AGENT_CRON_ENABLED": "true",
   "SCRAPE_AGENT_MAX_SESSIONS": "5"
   ```

   (start at 5 for the bounded-blast-radius initial deploy; the PR body notes to bump to 20 after 2-3 healthy sweeps)

3. In `secrets_store_secrets`, add a binding for `ANTHROPIC_API_KEY` pointing at the same store/key used by the discovery worker. Inspect `workers/discovery/wrangler.jsonc` first to get the exact `store_id`/`secret_name` shape to mirror.

- [ ] **Step 14.3: Regenerate the worker types**

Run: `cd workers/api && bunx wrangler types`

Expected: updates `workers/api/worker-configuration.d.ts`. Commit the diff.

- [ ] **Step 14.4: Typecheck**

Run: `cd workers/api && bunx tsc --noEmit`

Expected: clean (the new env types should be available).

- [ ] **Step 14.5: Commit**

```bash
git add workers/api/wrangler.jsonc workers/api/worker-configuration.d.ts
git commit -m "$(cat <<'EOF'
feat(cron): wrangler config for scrape-agent-sweep (01:00 UTC)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Scheduled-handler dispatch

**Files:**

- Modify: `workers/api/src/index.ts`

- [ ] **Step 15.1: Read the current handler**

Run: `grep -n "scheduled\|ScheduledEvent\|event.cron" workers/api/src/index.ts`

Note how the existing retier branch is structured (from #322): it checks `event.cron === "0 3 * * *"` and returns after dispatching.

- [ ] **Step 15.2: Add the new branch**

In `workers/api/src/index.ts`, add an import:

```ts
import { scrapeAgentSweep } from "./cron/scrape-agent-sweep.js";
```

Then in the `scheduled(event, env, ctx)` function, add the new branch BEFORE the retier branch (or any order — branching is exclusive on `event.cron`). Example shape:

```ts
if (event.cron === "0 1 * * *") {
  ctx.waitUntil(
    scrapeAgentSweep({
      DB: env.DB,
      CRON_ENABLED: env.CRON_ENABLED,
      SCRAPE_AGENT_CRON_ENABLED: env.SCRAPE_AGENT_CRON_ENABLED,
      SCRAPE_AGENT_MAX_SESSIONS: env.SCRAPE_AGENT_MAX_SESSIONS,
      DISCOVERY_WORKER: env.DISCOVERY_WORKER,
      RELEASED_API_KEY: await env.RELEASED_API_KEY.get(),
      ANTHROPIC_API_KEY: await env.ANTHROPIC_API_KEY?.get(),
    }),
  );
  return;
}
```

The `await env.RELEASED_API_KEY.get()` and `env.ANTHROPIC_API_KEY?.get()` pulls are lazy (only on this branch); hourly poll-fetch ticks don't load them.

- [ ] **Step 15.3: Typecheck**

Run: `cd workers/api && bunx tsc --noEmit`

Expected: clean.

- [ ] **Step 15.4: Commit**

```bash
git add workers/api/src/index.ts
git commit -m "$(cat <<'EOF'
feat(cron): wire scheduled handler to scrapeAgentSweep

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Admin API — `GET /v1/admin/cron-runs` list

**Files:**

- Create: `workers/api/src/routes/admin-cron-runs.ts`
- Modify: `workers/api/src/index.ts` (mount the route)
- Create: `tests/api/admin-cron-runs-list.test.ts`

- [ ] **Step 16.1: Write the failing test for the list route**

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { Hono } from "hono";
import { adminCronRunsRoutes } from "../../workers/api/src/routes/admin-cron-runs";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/db/migrations" });
  return db;
}

function mkApp(db: any) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/v1/admin", adminCronRunsRoutes);
  return app;
}

describe("GET /v1/admin/cron-runs", () => {
  it("returns rows for the named cron ordered by startedAt desc", async () => {
    const db = mkDb();
    db.insert(cronRuns)
      .values([
        {
          id: "crun_1",
          cronName: "scrape-agent-sweep",
          startedAt: "2026-04-17T01:00:00Z",
          status: "done",
          candidates: 5,
          dispatched: 5,
        },
        {
          id: "crun_2",
          cronName: "scrape-agent-sweep",
          startedAt: "2026-04-18T01:00:00Z",
          status: "done",
          candidates: 3,
          dispatched: 3,
        },
        { id: "crun_3", cronName: "retier", startedAt: "2026-04-18T03:00:00Z", status: "done" },
      ])
      .run();

    const app = mkApp(db);
    const res = await app.request("/v1/admin/cron-runs?cron=scrape-agent-sweep&limit=50");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((r) => r.id)).toEqual(["crun_2", "crun_1"]);
  });

  it("filters by status CSV", async () => {
    const db = mkDb();
    db.insert(cronRuns)
      .values([
        {
          id: "crun_1",
          cronName: "scrape-agent-sweep",
          startedAt: "2026-04-17T01:00:00Z",
          status: "done",
        },
        {
          id: "crun_2",
          cronName: "scrape-agent-sweep",
          startedAt: "2026-04-18T01:00:00Z",
          status: "degraded",
        },
        {
          id: "crun_3",
          cronName: "scrape-agent-sweep",
          startedAt: "2026-04-18T02:00:00Z",
          status: "aborted",
        },
      ])
      .run();

    const app = mkApp(db);
    const res = await app.request("/v1/admin/cron-runs?status=degraded,aborted");
    const body = (await res.json()) as Array<{ status: string }>;
    expect(body.map((r) => r.status).sort()).toEqual(["aborted", "degraded"]);
  });
});
```

- [ ] **Step 16.2: Run, confirm fail**

Run: `bun test tests/api/admin-cron-runs-list.test.ts -v`

Expected: FAIL.

- [ ] **Step 16.3: Implement the routes**

Create `workers/api/src/routes/admin-cron-runs.ts`:

```ts
import { Hono } from "hono";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { cronRuns } from "../db/schema-cron.js";

type Ctx = { Variables: { db: any } };

export const adminCronRunsRoutes = new Hono<Ctx>();

adminCronRunsRoutes.get("/cron-runs", async (c) => {
  const db = c.get("db");
  const cron = c.req.query("cron");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const statusCsv = c.req.query("status");
  const since = c.req.query("since");

  const conditions: any[] = [];
  if (cron) conditions.push(eq(cronRuns.cronName, cron));
  if (statusCsv) {
    const statuses = statusCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (statuses.length > 0) conditions.push(inArray(cronRuns.status, statuses as any));
  }
  if (since) conditions.push(gt(cronRuns.startedAt, since));
  else {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    conditions.push(gt(cronRuns.startedAt, thirtyDaysAgo));
  }

  const rows = await db
    .select()
    .from(cronRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(cronRuns.startedAt))
    .limit(limit);

  return c.json(rows);
});
```

- [ ] **Step 16.4: Mount the route in `workers/api/src/index.ts`**

Add import:

```ts
import { adminCronRunsRoutes } from "./routes/admin-cron-runs.js";
```

Mount under the same admin auth group as `admin-embed`:

```ts
// ... after existing admin-gated mounts
v1.route("/admin", adminCronRunsRoutes);
```

Ensure the `authMiddleware` covers this path (mirror how `admin-embed` is wired).

- [ ] **Step 16.5: Run the list test, iterate until pass**

Run: `bun test tests/api/admin-cron-runs-list.test.ts -v`

Expected: 2 pass.

- [ ] **Step 16.6: Commit**

```bash
git add workers/api/src/routes/admin-cron-runs.ts workers/api/src/index.ts tests/api/admin-cron-runs-list.test.ts
git commit -m "$(cat <<'EOF'
feat(cron): GET /v1/admin/cron-runs list route

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Admin API — `GET /v1/admin/cron-runs/:id` drill-down

**Files:**

- Modify: `workers/api/src/routes/admin-cron-runs.ts`
- Create: `tests/api/admin-cron-runs-detail.test.ts`

- [ ] **Step 17.1: Write the test**

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { fetchLog } from "@buildinternet/releases-core/schema";
import { Hono } from "hono";
import { adminCronRunsRoutes } from "../../workers/api/src/routes/admin-cron-runs";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/db/migrations" });
  return db;
}
function mkApp(db: any) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/v1/admin", adminCronRunsRoutes);
  return app;
}

describe("GET /v1/admin/cron-runs/:id", () => {
  it("returns 404 for unknown id", async () => {
    const db = mkDb();
    const app = mkApp(db);
    const res = await app.request("/v1/admin/cron-runs/crun_missing");
    expect(res.status).toBe(404);
  });

  it("inlines fetch-log status breakdown per session", async () => {
    const db = mkDb();
    db.insert(cronRuns)
      .values({
        id: "crun_1",
        cronName: "scrape-agent-sweep",
        startedAt: "2026-04-18T01:00:00Z",
        endedAt: "2026-04-18T01:00:02Z",
        durationMs: 2000,
        status: "done",
        candidates: 2,
        dispatched: 2,
        skippedOverCap: 0,
        dispatchErrors: 0,
        sessionsStarted: JSON.stringify(["ma-1", "ma-2"]),
        dispatchErrorDetail: null,
      })
      .run();
    db.insert(fetchLog)
      .values([
        {
          sourceId: "src_1",
          sessionId: "ma-1",
          status: "success",
          releasesFound: 3,
          releasesInserted: 3,
          durationMs: 500,
        },
        {
          sourceId: "src_2",
          sessionId: "ma-1",
          status: "error",
          releasesFound: 0,
          releasesInserted: 0,
          durationMs: 800,
          error: "boom",
        },
        {
          sourceId: "src_3",
          sessionId: "ma-2",
          status: "no_change",
          releasesFound: 0,
          releasesInserted: 0,
          durationMs: 400,
        },
      ] as any)
      .run();

    const app = mkApp(db);
    const res = await app.request("/v1/admin/cron-runs/crun_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: any;
      sessionBreakdown: Record<string, Record<string, number>>;
    };
    expect(body.run.id).toBe("crun_1");
    expect(body.sessionBreakdown["ma-1"]).toEqual({ success: 1, error: 1 });
    expect(body.sessionBreakdown["ma-2"]).toEqual({ no_change: 1 });
  });
});
```

- [ ] **Step 17.2: Run, confirm fail**

Run: `bun test tests/api/admin-cron-runs-detail.test.ts -v`

Expected: FAIL.

- [ ] **Step 17.3: Add the detail route**

Append to `workers/api/src/routes/admin-cron-runs.ts`:

```ts
import { fetchLog } from "@buildinternet/releases-core/schema";

adminCronRunsRoutes.get("/cron-runs/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const [run] = await db.select().from(cronRuns).where(eq(cronRuns.id, id));
  if (!run) return c.json({ error: "not_found" }, 404);

  const sessionIds: string[] = run.sessionsStarted ? JSON.parse(run.sessionsStarted) : [];
  const sessionBreakdown: Record<string, Record<string, number>> = {};

  if (sessionIds.length > 0) {
    const logs = await db
      .select({
        sessionId: fetchLog.sessionId,
        status: fetchLog.status,
        count: sql<number>`count(*)`,
      })
      .from(fetchLog)
      .where(inArray(fetchLog.sessionId, sessionIds))
      .groupBy(fetchLog.sessionId, fetchLog.status);
    for (const row of logs) {
      if (!row.sessionId) continue;
      (sessionBreakdown[row.sessionId] ??= {})[row.status] = Number(row.count);
    }
  }

  return c.json({ run, sessionBreakdown });
});
```

- [ ] **Step 17.4: Run, confirm pass**

Run: `bun test tests/api/admin-cron-runs-detail.test.ts -v`

Expected: 2 pass.

- [ ] **Step 17.5: Commit**

```bash
git add workers/api/src/routes/admin-cron-runs.ts tests/api/admin-cron-runs-detail.test.ts
git commit -m "$(cat <<'EOF'
feat(cron): GET /v1/admin/cron-runs/:id with session breakdown

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Dashboard Cron tab

**Files:**

- Create: `web/src/app/status/cron-runs-tab.tsx`
- Modify: `web/src/app/status/dashboard.tsx`

- [ ] **Step 18.1: Read the existing tab infrastructure**

Run: `grep -n "tab\|Tab\|setActiveTab" web/src/app/status/dashboard.tsx | head -20`

Note the pattern: how tabs are declared (probably an array or union of tab names), how the active-tab state is held, and how tab content is conditionally rendered.

- [ ] **Step 18.2: Create the tab component**

Create `web/src/app/status/cron-runs-tab.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { FetchStatusBadge } from "@/components/fetch-log-shared";
import { LocalTimestamp } from "@/components/local-timestamp";
import { formatFetchDuration } from "@/components/fetch-log-shared";

type CronRun = {
  id: string;
  cronName: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "running" | "done" | "degraded" | "dispatch_failed" | "aborted";
  candidates: number;
  dispatched: number;
  skippedOverCap: number;
  dispatchErrors: number;
  sessionsStarted: string | null;
  dispatchErrorDetail: string | null;
  abortReason: string | null;
  notes: string | null;
};

export function CronRunsTab({ apiUrl, apiKey }: { apiUrl: string; apiKey?: string }) {
  const [rows, setRows] = useState<CronRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    fetch(`${apiUrl}/v1/admin/cron-runs?limit=50`, { headers })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data: CronRun[]) => setRows(data))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [apiUrl, apiKey]);

  if (err) return <div className="text-red-500 text-xs">Error loading cron runs: {err}</div>;
  if (!rows) return <div className="text-stone-500 text-xs">Loading...</div>;
  if (rows.length === 0)
    return <div className="text-stone-500 text-xs">No cron runs recorded yet.</div>;

  return (
    <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
      <div className="grid grid-cols-[1.5fr_1.5fr_0.8fr_1fr_1.5fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400">
        <div>Cron</div>
        <div>Started</div>
        <div>Duration</div>
        <div>Status</div>
        <div>Outcome</div>
      </div>
      {rows.map((r) => (
        <CronRunRow key={r.id} row={r} />
      ))}
    </div>
  );
}

function CronRunRow({ row }: { row: CronRun }) {
  const statusBadgeKind =
    row.status === "done"
      ? "success"
      : row.status === "running"
        ? "running"
        : row.status === "degraded"
          ? "no_change"
          : "error";
  const outcome =
    row.status === "aborted" && row.abortReason
      ? row.abortReason
      : `${row.dispatched}/${row.candidates}${row.skippedOverCap > 0 ? ` · +${row.skippedOverCap} skipped` : ""}${row.dispatchErrors > 0 ? ` · ${row.dispatchErrors} err` : ""}`;

  return (
    <div className="grid grid-cols-[1.5fr_1.5fr_0.8fr_1fr_1.5fr] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 items-center">
      <div className="text-stone-900 dark:text-stone-100 truncate">{row.cronName}</div>
      <div className="text-stone-500">
        <LocalTimestamp ts={row.startedAt} />
      </div>
      <div className="text-stone-500">
        {row.durationMs != null ? formatFetchDuration(row.durationMs) : "—"}
      </div>
      <div>
        <FetchStatusBadge status={statusBadgeKind as any} />
      </div>
      <div className="text-stone-500" title={row.notes ?? undefined}>
        {outcome}
      </div>
    </div>
  );
}
```

(Adjust the import paths for `FetchStatusBadge`, `LocalTimestamp`, `formatFetchDuration` to match what `dashboard.tsx` already uses — look at dashboard.tsx's imports to confirm.)

- [ ] **Step 18.3: Wire the tab into `dashboard.tsx`**

1. Import the component: `import { CronRunsTab } from "./cron-runs-tab";`
2. Add `"cron"` to the tab-name union / array.
3. Add a tab button with label "Cron".
4. Render `<CronRunsTab apiUrl={...} apiKey={...} />` when `activeTab === "cron"`.

Keep the tab dev-gated — it should be inside whatever check already gates the `/status` page.

- [ ] **Step 18.4: Typecheck**

Run: `cd web && bunx tsc --noEmit`

Expected: clean.

- [ ] **Step 18.5: Visual smoke-check locally**

Run: `cd web && bun dev` and open the `/status` page. Click the Cron tab; it should render "No cron runs recorded yet." (if the local DB has none). Kill the dev server once confirmed.

- [ ] **Step 18.6: Commit**

```bash
git add web/src/app/status/cron-runs-tab.tsx web/src/app/status/dashboard.tsx
git commit -m "$(cat <<'EOF'
feat(cron): /status Cron tab showing cron_runs history

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Docs — AGENTS.md runbook + `.env.example`

**Files:**

- Modify: `AGENTS.md`
- Modify: `.env.example`

- [ ] **Step 19.1: Add the runbook paragraph to `AGENTS.md`**

Find the existing "Cron" / "Feed change detection" section (around the paragraph updated in #321/#322). Append a new subsection after the retier description:

```
**Cron observability:** The `cron_runs` table records every scheduled-event execution. `/status` → Cron tab shows the last 50 rows across all crons; filter `?status=aborted,dispatch_failed` for "things worth looking at." Two consecutive `dispatch_failed` rows for the same `cron_name` means escalate — the likely cause is a bad deploy of the downstream worker. `aborted` with `abort_reason='anthropic_auth'` means replace the ANTHROPIC_API_KEY secret; `anthropic_credits` means top up the account. Stale-running rows (reconciled by next sweep with `abort_reason='stale_running'`) are informational. The scrape-no-feed sweep fires daily at 01:00 UTC; caps via `SCRAPE_AGENT_MAX_SESSIONS` env var (default 20).
```

- [ ] **Step 19.2: Update `.env.example`**

Find the section documenting worker-only env vars (if separated from CLI vars) — likely near `CRON_ENABLED`. Append:

```
# Per-cron toggle for the scrape-no-feed agent sweep (workers/api only).
# Both CRON_ENABLED and SCRAPE_AGENT_CRON_ENABLED must be truthy for the
# daily 01:00 UTC sweep to fire.
# SCRAPE_AGENT_CRON_ENABLED=true

# Max managed-agent sessions dispatched per sweep. Default 20 once live;
# first deploy ships with 5 for bounded blast radius.
# SCRAPE_AGENT_MAX_SESSIONS=5
```

- [ ] **Step 19.3: Commit**

```bash
git add AGENTS.md .env.example
git commit -m "$(cat <<'EOF'
docs(cron): runbook + env vars for scrape-agent-sweep

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Full-suite verification + typecheck sweep

- [ ] **Step 20.1: Run the whole test suite**

Run: `bun test tests/unit tests/api`

Expected: all tests pass; totals ~26 higher than main.

- [ ] **Step 20.2: Run all three typechecks**

Run: `bunx tsc --noEmit && cd workers/api && bunx tsc --noEmit && cd ../../web && bunx tsc --noEmit`

Expected: all three clean.

- [ ] **Step 20.3: Run the migration filename linter**

Run: `bun run db:check-filenames`

Expected: exits 0.

- [ ] **Step 20.4: If anything fails, fix before moving on.**

Do NOT skip. A red suite here means something regressed earlier and can't be caught in review.

---

## Task 21: Open the PR

- [ ] **Step 21.1: Push the branch**

Run: `git push -u origin feat/scrape-agent-cron`

- [ ] **Step 21.2: Open the PR**

```bash
cat > /tmp/pr-body.md <<'EOF'
## Summary
Closes part 3 of #319 (tracked in #328). Adds a daily 01:00 UTC cron on the API worker that drains `changeDetectedAt`-flagged scrape-no-feed sources through the existing managed-agents `/update` pipeline.

Design: #327 — `docs/superpowers/specs/2026-04-18-scrape-agent-cron-design.md`.

## Highlights
- **Managed-agents reuse only.** No new agent, no new tools, no direct Anthropic Messages API calls for the work. The cron is plumbing in front of `workers/discovery/`'s existing `/update` endpoint.
- **Anthropic pre-flight** (`GET /v1/models`) catches auth / 402-credits / 403 / 429-credit-balance-too-low before any dispatch. 3s timeout; 5xx/network errors warn-then-proceed.
- **New `cron_runs` observability table** — generic over `cron_name`. New Cron tab on `/status` (dev-gated). Admin API at `GET /v1/admin/cron-runs{,/:id}`.
- **Env-var cap** `SCRAPE_AGENT_MAX_SESSIONS` — shipping at **5** for bounded initial blast radius (~$1/sweep worst case). Bump to 20 in a follow-up once healthy sweeps are verified.
- **Stale-running reconciler** at the top of each sweep catches crash-mid-sweep orphans.
- **Extracted `runWithConcurrency`** to `workers/api/src/lib/concurrency.ts`; re-imported from poll-fetch — side-effect of this PR, clearly documented.

## Tests
~26 new cases across unit / integration / E2E. See `tests/unit/scrape-agent-*`, `tests/api/cron-runs-*`, `tests/api/scrape-agent-*`.

## Follow-ups (not in this PR)
- Bump `SCRAPE_AGENT_MAX_SESSIONS=20` after 2–3 healthy sweeps.
- Circuit breaker on sustained `dispatch_failed` (comment-only in v1).
- Per-`fetchPriority` cap differentiation.
- Retrofit `retier` + `poll-fetch` into `cron_runs` (schema already supports it).
EOF
gh pr create --title "feat(cron): daily scrape-no-feed agent sweep (part 3 of #319)" --body-file /tmp/pr-body.md
```

- [ ] **Step 21.3: Post the PR URL back in the tracking issue**

Run: `gh issue comment 328 --body "Implementation PR: <URL>"`

---

## Task 22: Post-deploy smoke test

This runs AFTER the PR is merged (auto-deploy on merge to main triggers worker deploy) OR against the branch via `wrangler dev --remote` before merge. Pattern matches #322's smoke test.

- [ ] **Step 22.1: Apply the migration to prod D1**

Run: `cd workers/api && bunx wrangler d1 migrations apply released-db --remote`

Expected: the new `cron_runs` migration applies cleanly (1-2ms).

- [ ] **Step 22.2: Verify the table exists**

Run: `bunx wrangler d1 execute released-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='cron_runs';"`

Expected: returns one row.

- [ ] **Step 22.3: Spin up the worker in remote dev mode from this branch**

Run: `cd workers/api && bunx wrangler dev --remote --test-scheduled --port 8799` (runs in background)

Wait for `Ready on http://localhost:8799`.

- [ ] **Step 22.4: Fire the cron manually**

Run: `curl -X POST 'http://localhost:8799/__scheduled?cron=0+1+*+*+*'`

Expected: returns `Ran scheduled event` status 200.

Watch the wrangler logs for `[scrape-agent-cron] done: run=... status=...`.

- [ ] **Step 22.5: Verify the `cron_runs` row**

Run:

```bash
bunx wrangler d1 execute released-db --remote --command "SELECT id, status, candidates, dispatched, skipped_over_cap, abort_reason, notes FROM cron_runs ORDER BY started_at DESC LIMIT 1;"
```

Expected: one row. Status should be `done` (if candidates > 0, with `dispatched` matching) or `done` with `notes='no flagged sources'` (if nothing was flagged at the time).

If `status='aborted'` with a specific `abort_reason`, fix the underlying cause (replace API key / top up credits / debug discovery worker) and re-test.

- [ ] **Step 22.6: Spot-check downstream fetch_log activity**

Wait ~2–3 minutes for the dispatched managed-agent sessions to complete. Then:

```bash
bunx wrangler d1 execute released-db --remote --command "SELECT session_id, source_id, status, error FROM fetch_log WHERE session_id IN (SELECT value FROM json_each((SELECT sessions_started FROM cron_runs ORDER BY started_at DESC LIMIT 1))) ORDER BY id DESC LIMIT 20;"
```

Expected: one row per source per session, with statuses distributed across `success` / `no_change` / `error`. Errors are OK at this stage; the cron's job is just to fire the sessions.

- [ ] **Step 22.7: Kill the dev server and post results**

```
pkill -f "wrangler dev.*8799"
```

Post the results as a comment on the PR (same shape as #322's smoke-test comment).

---

## Self-review (plan author)

Spec coverage check:

- Architecture & control flow → Tasks 13, 15 ✓
- Upstream-failure handling (pre-flight + dispatch errors) → Tasks 7, 13 ✓
- `cron_runs` table → Tasks 2, 3, 4, 5 ✓
- Candidate selection → Task 12 ✓
- Dispatch + concurrency + extract shared helper → Tasks 6, 13 ✓
- Stuck `running` rows (§5.1) → Task 11 ✓
- Pre-flight edge classifications (§5.2) → Task 7 ✓
- Dispatch-failure runbook-only posture → noted in PR body (Task 21) ✓
- `CRON_ENABLED=false` short-circuit → Task 13 (inside `scrapeAgentSweep`) ✓
- Observability API routes → Tasks 16, 17 ✓
- Dashboard tab → Task 18 ✓
- Runbook & env docs → Task 19 ✓
- Config (wrangler, scheduled handler branch) → Tasks 14, 15 ✓
- Rollout (initial `MAX=5`) → Task 14 + PR body ✓
- Testing strategy (all three layers) → Tasks 7, 8, 9, 10, 11, 12, 13, 16, 17 ✓
- Post-deploy smoke test → Task 22 ✓

Placeholder scan: no TBDs / "implement later" / "similar to Task N". Code in every code step.

Type consistency: `Candidate`, `OrgGroup`, `DispatchResult`, `DerivedStatus`, `PreflightAction`, `SweepEnv` all declared in Task 7–13 and referenced consistently downstream. `insertRunningRow` / `finalizeRunRow` / `reconcileStaleRunning` signatures match between Task 10/11 and Task 13 usage. `classifyPreflightResponse` input shape `{ status, body }` matches between Task 7 and Task 13's `runPreflight`.

**Optional convenience route** `GET /v1/admin/cron-runs/recent/:cron_name` was flagged in the spec as cuttable. Cut from the plan in the interest of lean scope. The dashboard's list+detail routes cover the operator-observability need. Add in a follow-up only if a real script needs it.

---

## References

- Design spec: `docs/superpowers/specs/2026-04-18-scrape-agent-cron-design.md` (#327)
- Parent issue: #319
- Tracking issue: #328
- Pattern precedents: #320 (scrape-with-feed cron), #321 (retier cron), #322 (retier observability), #324 (feed rediscovery)
- Existing helpers to reuse: `FetchStatusBadge`, `LocalTimestamp`, `formatFetchDuration` from `web/src/components/fetch-log-shared.tsx`; `runWithConcurrency` (being extracted in Task 6); D1 bind constants from `workers/api/src/lib/d1-limits.ts`.
