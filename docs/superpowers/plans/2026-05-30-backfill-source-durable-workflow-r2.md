# Durable backfill Workflow + R2 raw snapshot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a deep Firecrawl backfill durable: persist the raw page to R2 (pointer in D1), then extract window-by-window inside a Cloudflare `BackfillSourceWorkflow` so it survives client disconnect, retries per-window, and never loses completed work.

**Architecture:** Save-raw-to-R2 first (steps pass a small key, not the blob) → precompute window offsets without the LLM → one durable step per window (read R2 → extract slice → idempotent upsert) → finalize/embed/bookkeep. The existing synchronous endpoint stays as the fast path for supplied-markdown/small; the Firecrawl/deep path routes to the Workflow behind `BACKFILL_WORKFLOW_ENABLED` (default off → zero change to today's behavior).

**Tech Stack:** TypeScript (strict), Bun test, Cloudflare Workers + Workflows, R2, Drizzle/D1, Hono.

**Spec:** `docs/superpowers/specs/2026-05-30-backfill-source-durable-workflow-r2-design.md` · **Issue:** #1281

**Model files to mirror:**

- Workflow shape + retries + `_drizzleOverride`/`_extractOverride`/`_firecrawlClientOverride` test hooks: `workers/api/src/workflows/firecrawl-ingest.ts` (+ its test).
- Trigger + status route pair: `batch-summarize` in `workers/api/src/routes/workflows.ts`.
- R2 put/get: `workers/api/src/lib/media-ingest.ts` (`bucket.put(key, buf, { httpMetadata })`).
- Table style + schema/migration pairing: `sourceChangelogFiles` (`packages/core/src/schema.ts:877`).
- FLAGS registry: `packages/lib/src/flags.ts` (`FLAGS.pollFetchUseWorkflow`).

---

## Phase 1 — Raw-snapshot persistence (R2 + D1 pointer)

Foundational, self-contained, fully unit-testable with a fake R2. No workflow yet.

### Task 1.1: `source_raw_snapshots` table + id helper

**Files:** Modify `packages/core/src/schema.ts`, `packages/core/src/id.ts`; Create `workers/api/migrations/NNNN_source_raw_snapshots.sql`.

- [ ] **Step 1:** Add the id helper to `packages/core/src/id.ts` (mirror the existing one-liners):

```ts
export const newRawSnapshotId = () => `snap_${nanoid()}`;
```

- [ ] **Step 2:** Add the table to `packages/core/src/schema.ts` (mirror `sourceChangelogFiles` at line 877 for column/index style; reference `sources.id`):

```ts
export const sourceRawSnapshots = sqliteTable(
  "source_raw_snapshots",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull(),
    contentHash: text("content_hash").notNull(),
    format: text("format").notNull(), // "markdown" | "html"
    bytes: integer("bytes").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("idx_raw_snapshots_source").on(t.sourceId, t.createdAt),
    uniqueIndex("uq_raw_snapshots_source_hash").on(t.sourceId, t.contentHash),
  ],
);

export type SourceRawSnapshot = typeof sourceRawSnapshots.$inferSelect;
```

(Ensure `index`, `uniqueIndex`, `sql` are already imported in schema.ts — they are, used by sibling tables.)

- [ ] **Step 3:** Generate the paired migration. Find the highest-numbered file in `workers/api/migrations/`, then create the next one `NNNN_source_raw_snapshots.sql` with the matching DDL:

```sql
CREATE TABLE source_raw_snapshots (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  format TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_raw_snapshots_source ON source_raw_snapshots (source_id, created_at);
CREATE UNIQUE INDEX uq_raw_snapshots_source_hash ON source_raw_snapshots (source_id, content_hash);
```

- [ ] **Step 4:** Verify the schema/migration pair is consistent with the test DB helper: `cd workers/api && bun test test/` against any one schema-touching test, and `npx tsc --noEmit` at root. Expected: clean (the CI schema-pairing gate is satisfied because both schema.ts and a migration changed).

- [ ] **Step 5:** Commit: `feat(core): source_raw_snapshots table + snap_ id (#1281)`.

### Task 1.2: `saveRawSnapshot` / `loadRawSnapshot` helpers

**Files:** Create `workers/api/src/lib/raw-snapshot.ts`; Create `workers/api/src/lib/raw-snapshot.test.ts`.

- [ ] **Step 1 (failing test):** `raw-snapshot.test.ts` with a fake R2 (`{ store: Map; put; get; head }`) + `createTestDb()`:

```ts
import { describe, it, expect } from "bun:test";
import { createTestDb } from "../../../tests/db-helper";
import { sourceRawSnapshots } from "@buildinternet/releases-core/schema";
import { saveRawSnapshot, loadRawSnapshot } from "./raw-snapshot.js";

function fakeR2() {
  const store = new Map<string, string>();
  return {
    store,
    put: async (k: string, v: ArrayBuffer | string) => {
      store.set(k, typeof v === "string" ? v : new TextDecoder().decode(v));
    },
    get: async (k: string) =>
      store.has(k) ? { text: async () => store.get(k)! } : null,
    head: async (k: string) => (store.has(k) ? {} : null),
  };
}

describe("saveRawSnapshot", () => {
  it("writes R2 by content-hash key, upserts a pointer row, and round-trips", async () => {
    const { db } = createTestDb();
    await db.insert(/* sources */ ...).values(/* a scrape source src_x */ ...);
    const r2 = fakeR2();
    const res = await saveRawSnapshot({ R2: r2, db }, {
      sourceId: "src_x", body: "# v1\nhello", format: "markdown",
    });
    expect(res.r2Key).toBe(`sources/src_x/raw/${res.contentHash}.md`);
    expect(r2.store.get(res.r2Key)).toBe("# v1\nhello");
    const rows = await db.select().from(sourceRawSnapshots);
    expect(rows.length).toBe(1);
    expect(await loadRawSnapshot({ R2: r2 }, res.r2Key)).toBe("# v1\nhello");
  });

  it("is content-hash idempotent — same body does not re-store or duplicate pointer", async () => {
    const { db } = createTestDb();
    await db.insert(/* sources */ ...).values(/* src_x */ ...);
    const r2 = fakeR2();
    const deps = { R2: r2, db };
    const a = await saveRawSnapshot(deps, { sourceId: "src_x", body: "same", format: "markdown" });
    const b = await saveRawSnapshot(deps, { sourceId: "src_x", body: "same", format: "markdown" });
    expect(b.r2Key).toBe(a.r2Key);
    expect((await db.select().from(sourceRawSnapshots)).length).toBe(1);
  });
});
```

(Implementer: fill the source-insert with the minimal valid `sources` row per `tests/db-helper` conventions; reuse `contentHash` from `@releases/adapters/content-hash`.)

- [ ] **Step 2:** Run → FAIL (module missing).

- [ ] **Step 3 (implement `raw-snapshot.ts`):**

```ts
import { eq, and } from "drizzle-orm";
import { contentHash } from "@releases/adapters/content-hash";
import { sourceRawSnapshots } from "@buildinternet/releases-core/schema";
import { newRawSnapshotId } from "@buildinternet/releases-core/id";

interface R2Like {
  put(key: string, value: ArrayBuffer | string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  head(key: string): Promise<unknown | null>;
}
const EXT: Record<string, string> = { markdown: "md", html: "html" };

export async function saveRawSnapshot(
  deps: { R2: R2Like; db: any },
  input: { sourceId: string; body: string; format: "markdown" | "html" },
): Promise<{ r2Key: string; contentHash: string; bytes: number }> {
  const hash = contentHash(input.body);
  const ext = EXT[input.format] ?? "txt";
  const r2Key = `sources/${input.sourceId}/raw/${hash}.${ext}`;
  const bytes = new TextEncoder().encode(input.body).length;
  // Skip the R2 write if this exact content already exists (content-hash key).
  if (!(await deps.R2.head(r2Key))) {
    await deps.R2.put(r2Key, input.body);
  }
  // Upsert the pointer (unique on source_id+content_hash).
  const existing = await deps.db
    .select({ id: sourceRawSnapshots.id })
    .from(sourceRawSnapshots)
    .where(
      and(
        eq(sourceRawSnapshots.sourceId, input.sourceId),
        eq(sourceRawSnapshots.contentHash, hash),
      ),
    );
  if (existing.length === 0) {
    await deps.db.insert(sourceRawSnapshots).values({
      id: newRawSnapshotId(),
      sourceId: input.sourceId,
      r2Key,
      contentHash: hash,
      format: input.format,
      bytes,
    });
  }
  return { r2Key, contentHash: hash, bytes };
}

export async function loadRawSnapshot(deps: { R2: R2Like }, r2Key: string): Promise<string | null> {
  const obj = await deps.R2.get(r2Key);
  return obj ? obj.text() : null;
}
```

- [ ] **Step 4:** Run → PASS. `npx tsc --noEmit` in `workers/api` → clean.
- [ ] **Step 5:** Commit: `feat(api): saveRawSnapshot/loadRawSnapshot R2 helpers (#1281)`.

### Task 1.3: Wire the R2 binding + flag (config only)

**Files:** Modify `workers/api/src/index.ts` (Env type), `workers/api/wrangler.jsonc` (r2 bucket + workflow placeholder + var), `packages/lib/src/flags.ts`.

- [ ] **Step 1:** Add to the Env `Bindings` in `index.ts`: `RAW_SNAPSHOTS?: R2Bucket;` and `BACKFILL_WORKFLOW_ENABLED?: string;`.
- [ ] **Step 2:** Add to `wrangler.jsonc` an `r2_buckets` entry `{ "binding": "RAW_SNAPSHOTS", "bucket_name": "released-raw" }` (+ the staging block) and a var `"BACKFILL_WORKFLOW_ENABLED": "false"`. Add a comment: requires one-time `wrangler r2 bucket create released-raw` (prod + staging) + a 90-day lifecycle rule.
- [ ] **Step 3:** Add the flag to `FLAGS` in `packages/lib/src/flags.ts`:

```ts
  backfillWorkflow: {
    key: "backfill-workflow-enabled",
    env: "BACKFILL_WORKFLOW_ENABLED",
    default: false,
  },
```

- [ ] **Step 4:** `npx tsc --noEmit` (root + workers/api) → clean. Commit: `chore(api): RAW_SNAPSHOTS R2 binding + BACKFILL_WORKFLOW_ENABLED flag (#1281)`.

---

## Phase 2 — `BackfillSourceWorkflow`

### Task 2.1: `plan-windows` offset walk (pure, no LLM)

**Files:** Modify `workers/api/src/lib/firecrawl-extract.ts` (add `planWindowOffsets`); add unit tests to its test file (or a new one).

- [ ] **Step 1 (failing test):** assert `planWindowOffsets(markdown, { maxWindows })` walks `sliceChangelog` offsets deterministically and stops at `maxWindows` (returns `{ offsets: number[]; cappedAtWindow; droppedChars }`). Multi-window fixture → N offsets; cap clamps; tiny doc → 1 offset.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `planWindowOffsets` by extracting the loop control from `extractChangelogAllWindows` (walk `sliceChangelog({tokens, offset})` chaining `nextOffset`, no `extractFromBody` call). Keep `extractChangelogAllWindows` working (it can be reimplemented on top of `planWindowOffsets` + a per-offset extract, or left as-is — DRY it if low-risk).
- [ ] **Step 4:** Run → PASS; tsc clean. Commit: `feat(api): planWindowOffsets — LLM-free window offset walk (#1281)`.

### Task 2.2: The workflow class

**Files:** Create `workers/api/src/workflows/backfill-source.ts`; Create `workers/api/src/workflows/backfill-source.test.ts`; Modify `workers/api/src/index.ts` (export + Env binding), `workers/api/wrangler.jsonc` (workflow entry).

- [ ] **Step 1 (failing test):** Mirror `firecrawl-ingest.test.ts`. Provide `_drizzleOverride`, a fake `RAW_SNAPSHOTS` R2, `_firecrawlClientOverride` (returns markdown), and `_extractOverride` (per-window: returns fixed entries). Assert, on a 3-window fixture, dryRun:false: raw saved to R2 once; 3 `extract-window-i` steps ran; entries upserted; finalize report aggregates counts. Then a variant where window 2's extract throws once → the workflow retries window 2 only and windows 1+3 results persist (resumability) — assert via the drizzle override capturing upserts.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3 (implement `BackfillSourceWorkflow`):** `extends WorkflowEntrypoint<BackfillSourceEnv, BackfillSourceParams>`. Steps exactly per spec Component 2 (`resolve-and-save-raw` → `plan-windows` → looped `extract-window-{i}` → `finalize`). Reuse: `getSourceMeta`, `createFirecrawlClient`/`scrapeOnce`, `getSecret(FIRECRAWL_API_KEY)`, `saveRawSnapshot`/`loadRawSnapshot`, `planWindowOffsets`, `extractFromBody`+`mapEntries`, `ingestRawReleases`, `embedReleasesForSource`, `generateContentForReleases`, `effectiveBackfillWindows`, `resolveFetchEnv`. `NonRetryableError` for not-found/non-scrape. Build the `SourceBackfillReport` from per-window aggregation; include `firecrawlCapGuidance(...)`.
- [ ] **Step 4:** Export `BackfillSourceWorkflow` in `index.ts`; add Env `BACKFILL_SOURCE_WORKFLOW?: Workflow;`; add the `wrangler.jsonc` workflow entry `{ name: "backfill-source", binding: "BACKFILL_SOURCE_WORKFLOW", class_name: "BackfillSourceWorkflow" }`.
- [ ] **Step 5:** Run → PASS; tsc clean. Commit: `feat(api): BackfillSourceWorkflow — R2 raw + per-window resumable extract (#1281)`.

---

## Phase 3 — Adaptive trigger + status routes

### Task 3.1: Route the deep Firecrawl path to the workflow

**Files:** Modify `workers/api/src/routes/workflows.ts` (the `backfill-source` POST + a new status GET); Modify `workers/api/test/workflows-backfill.test.ts`.

- [ ] **Step 1 (failing tests):** (a) firecrawl-`via` source + `_backfillBodyOverride{via:"firecrawl"}` + `BACKFILL_WORKFLOW_ENABLED` on + a fake `BACKFILL_SOURCE_WORKFLOW.create()` → POST returns `202 { instanceId, async: true }` and the workflow was created with `{ sourceId, maxWindows, dryRun }`. (b) supplied-markdown → still synchronous report (unchanged). (c) flag off → synchronous even for firecrawl (current behavior). (d) `GET /v1/workflows/backfill-source/status/:id` → pass-through `status()` (404 unknown).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: after body-`via` is known, if `via === "firecrawl"` **and** the flag is on (`await flag(env.FLAGS, env.BACKFILL_WORKFLOW_ENABLED, FLAGS.backfillWorkflow)`) **and** `env.BACKFILL_SOURCE_WORKFLOW` is bound, call `env.BACKFILL_SOURCE_WORKFLOW.create(...)` with the params and an id of the form `backfill-<sourceId>-<scheduledTime>`, then return `202` with body `{ instanceId, statusUrl, async: true }`. Otherwise fall through to the existing synchronous `runSourceBackfill`. Add the status `GET` mirroring `batch-summarize/status` (reuse `WORKFLOW_NOT_FOUND_RE`). Note: `scheduledTime` must come from a request param or `Date.now()` at request time — not inside a workflow step.
- [ ] **Step 4:** Run → PASS; tsc clean. Commit: `feat(api): route deep firecrawl backfill to BackfillSourceWorkflow (#1281)`.

---

## Phase 4 — Cap demotion + docs

### Task 4.1: Correct the rationale + document the new flow

**Files:** Modify `workers/api/src/lib/source-backfill.ts` (JSDoc on the cap helpers); Modify `docs/architecture/firecrawl-monitoring.md`; Modify `AGENTS.md` (one-line pointer).

- [ ] **Step 1:** Rewrite the `FIRECRAWL_BACKFILL_MAX_WINDOWS` / `effectiveBackfillWindows` JSDoc: remove "the ~106s scrapeOnce is the long pole"; state it's an upper bound on the _number of extraction windows_ (cost is ~1.8s/entry of Haiku output, not the scrape) used inside the workflow's `plan-windows`.
- [ ] **Step 2:** Rewrite the `firecrawl-monitoring.md` backfill section: corrected root cause (scrape ~0.2s; extraction ~1.8s/entry), the R2-snapshot + `BackfillSourceWorkflow` flow, per-window resumability/idempotency, trigger→poll ergonomics, the `BACKFILL_WORKFLOW_ENABLED` flag, and the supplied-markdown sync fast path. Update the AGENTS.md backfill conventions line.
- [ ] **Step 3:** `bun run format:check`. Commit: `docs(firecrawl): correct backfill root cause + document durable workflow (#1281)`.

---

## Phase 5 — Full gate sweep + draft PR

- [ ] **Step 1:** `npx tsc --noEmit` (root + workers/api) → clean.
- [ ] **Step 2:** `bun run test` (split gate) → 0 fail. (Raw `bun test` shows the known `packages/` mock-leak; `bun run test` is the authoritative gate.)
- [ ] **Step 3:** `bun run lint` (0 errors) + `bun run format:check`.
- [ ] **Step 4:** Push branch; open a **DRAFT** PR (do NOT merge) titled "Durable backfill: Workflow + R2 raw snapshot (#1281)", body linking #1281, summarizing the corrected root cause + the design + the deploy prereqs (`wrangler r2 bucket create released-raw`, lifecycle rule, Flagship key), and a checklist of any phases not completed.

---

## Self-Review

- **Spec coverage:** raw→R2 (1.1–1.2), binding/flag (1.3), plan-windows (2.1), workflow (2.2), adaptive route + status (3.1), cap demotion + docs (4.1), gates + draft PR (5). All acceptance rows map to a task.
- **Type consistency:** `saveRawSnapshot(deps,{sourceId,body,format})→{r2Key,contentHash,bytes}`, `loadRawSnapshot(deps,r2Key)→string|null`, `planWindowOffsets(md,{maxWindows})→{offsets,cappedAtWindow,droppedChars}`, `newRawSnapshotId()`, table `sourceRawSnapshots`, binding `RAW_SNAPSHOTS`, workflow binding `BACKFILL_SOURCE_WORKFLOW`, flag `FLAGS.backfillWorkflow`/`BACKFILL_WORKFLOW_ENABLED` — used consistently across tasks.
- **No prod infra created from the PR:** R2 bucket + lifecycle + Flagship key are documented deploy prereqs, not executed.
- **Risk gate:** every phase is independently committable; flag default off means main is unaffected until deliberately enabled.
