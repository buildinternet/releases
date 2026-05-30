# Full-History Backfill Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable, admin-triggered full-history backfill for windowed scrape/Firecrawl sources via `POST /v1/workflows/backfill-source`, plus fix the latent `/releases/batch` media-bind bug.

**Architecture:** A synchronous endpoint mirroring `enrich-feed-content`. The whole ingest pipeline already runs in-worker (`FirecrawlIngestWorkflow`); the only new behavior is _loop-all-windows_ extraction. A new `extractChangelogAllWindows()` primitive loops `sliceChangelog` over the whole document; a DI core `runSourceBackfill()` dedups by synthesized URL and feeds `ingestRawReleases` → inline embed + summary regen. Body comes from (1) agent-supplied `markdown`, (2) Firecrawl `scrapeOnce`, or (3) plain fetch + `htmlToMarkdown`.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Worker + Hono, Drizzle/D1, Anthropic SDK (Haiku 4.5 temp-0), `bun test` with `bun:sqlite` fixtures.

**Spec:** `docs/superpowers/specs/2026-05-30-backfill-source-primitive-design.md`
**Issue:** https://github.com/buildinternet/releases/issues/1265

---

## File structure

- **Create** `workers/api/src/lib/source-backfill.ts` — DI core (`runSourceBackfill`, types, `dedupeByUrl`, `dateRange`).
- **Create** `workers/api/src/lib/source-backfill.test.ts` — unit tests for the core.
- **Create** `workers/api/src/lib/media-bind.ts` — `normalizeMediaBind` helper.
- **Create** `workers/api/src/lib/media-bind.test.ts` — unit tests for the helper.
- **Create** `workers/api/test/workflows-backfill.test.ts` — route smoke tests.
- **Modify** `workers/api/src/lib/firecrawl-extract.ts` — add `extractChangelogAllWindows`.
- **Modify** `workers/api/src/lib/firecrawl-extract.test.ts` — add all-windows tests.
- **Modify** `workers/api/src/routes/workflows.ts` — add the route + imports.
- **Modify** `workers/api/src/routes/sources.ts` — use `normalizeMediaBind` at the batch insert.
- **Modify** `docs/architecture/firecrawl-monitoring.md` — document the endpoint.
- **Modify** `AGENTS.md` — one-line convention pointer.

---

## Task 0: Worktree setup

A fresh git worktree has no `node_modules`; package edits otherwise resolve to the main checkout and tests read back `undefined`.

- [ ] **Step 1: Install deps in the worktree**

Run: `bun install`
Expected: completes; `node_modules/` present in the worktree root.

- [ ] **Step 2: Confirm the baseline test harness works**

Run: `bun test workers/api/src/lib/firecrawl-extract.test.ts`
Expected: PASS (3 tests). This is the file Task 1 extends.

---

## Task 1: `extractChangelogAllWindows` primitive

**Files:**

- Modify: `workers/api/src/lib/firecrawl-extract.ts`
- Test: `workers/api/src/lib/firecrawl-extract.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `workers/api/src/lib/firecrawl-extract.test.ts` (after the existing `describe` block). It adds a counting fake client (distinct version per window) and imports the new function — update the import on line 3 to include it:

Change line 3 from:

```ts
import { extractFirecrawlMarkdown } from "./firecrawl-extract.js";
```

to:

```ts
import { extractFirecrawlMarkdown, extractChangelogAllWindows } from "./firecrawl-extract.js";
```

Then append:

```ts
// Fake whose every extract call returns a distinct version, so accumulation
// across windows is observable (N windows -> N pre-dedup releases).
function makeCountingFakeClient() {
  let n = 0;
  const client = {
    messages: {
      stream: (_args: { messages: Array<{ role: string; content: string }> }) => {
        n++;
        const v = `v1.${n}.0`;
        return {
          finalMessage: async () => ({
            content: [
              {
                type: "tool_use" as const,
                name: "extract_releases",
                input: { releases: [{ title: v, content: `body ${v}`, version: v }] },
                id: `tu_${n}`,
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            stop_reason: "tool_use",
          }),
        };
      },
    },
  };
  return { client };
}

// ~2000 short newest-first sections => well past one 10K-token window.
const deepChangelog = Array.from(
  { length: 2000 },
  (_, i) =>
    `## Entry ${i}\n\nChangelog body text for entry number ${i} describing assorted fixes and features in adequate detail.`,
).join("\n\n");

describe("extractChangelogAllWindows", () => {
  it("loops all windows of a deep changelog and accumulates entries", async () => {
    const { client } = makeCountingFakeClient();
    const result = await extractChangelogAllWindows(deepChangelog, fakeSource, {
      anthropicClient: client as never,
      agentModel: "claude-haiku-4-5-20251001",
      logger: fakeLogger,
    });

    expect(result.windows).toBeGreaterThan(1);
    expect(result.cappedAtWindow).toBe(false);
    expect(result.droppedChars).toBe(0);
    // The counting fake returns one (distinct) release per window.
    expect(result.releases.length).toBe(result.windows);
  });

  it("respects maxWindows and reports the dropped tail", async () => {
    const { client } = makeCountingFakeClient();
    const result = await extractChangelogAllWindows(
      deepChangelog,
      fakeSource,
      {
        anthropicClient: client as never,
        agentModel: "claude-haiku-4-5-20251001",
        logger: fakeLogger,
      },
      { maxWindows: 1 },
    );

    expect(result.windows).toBe(1);
    expect(result.cappedAtWindow).toBe(true);
    expect(result.droppedChars).toBeGreaterThan(0);
    expect(result.releases.length).toBe(1);
  });

  it("completes a single small window uncapped", async () => {
    const { client } = makeCountingFakeClient();
    const result = await extractChangelogAllWindows("# v1.2.0\nAdded X.", fakeSource, {
      anthropicClient: client as never,
      agentModel: "claude-haiku-4-5-20251001",
      logger: fakeLogger,
    });

    expect(result.windows).toBe(1);
    expect(result.cappedAtWindow).toBe(false);
    expect(result.droppedChars).toBe(0);
    expect(result.releases.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test workers/api/src/lib/firecrawl-extract.test.ts`
Expected: FAIL — `extractChangelogAllWindows` is not exported (import error / undefined).

- [ ] **Step 3: Implement `extractChangelogAllWindows`**

Append to `workers/api/src/lib/firecrawl-extract.ts` (after `extractFirecrawlMarkdown`):

```ts
export interface ExtractAllWindowsResult {
  /** mapEntries output across all processed windows, PRE-dedup. */
  releases: RawRelease[];
  /** Windows actually processed. */
  windows: number;
  /** True when `maxWindows` stopped the loop before reaching the end. */
  cappedAtWindow: boolean;
  /** Chars in the untouched tail when capped; 0 when the whole doc was covered. */
  droppedChars: number;
  totalInput: number;
  totalOutput: number;
}

/** Backstop so a pathological doc (or a heading-snap that fails to advance)
 *  can't loop unbounded. Overridable per call. */
const DEFAULT_MAX_WINDOWS = 50;

/**
 * Full-history variant of {@link extractFirecrawlMarkdown}: instead of slicing
 * to the recent window and dropping the tail, walk the whole document one
 * `DEFAULT_CHANGELOG_SLICE_TOKENS` window at a time (chaining `sliceChangelog`'s
 * `nextOffset`) and accumulate the extracted entries. Each window is a one-shot
 * `extractFromBody` call (windowing keeps every call under the output cap), so
 * this is the dedup-safe primitive a backfill reuses. Caller dedups by URL.
 */
export async function extractChangelogAllWindows(
  markdown: string,
  source: Source,
  deps: FirecrawlExtractDeps,
  opts: { maxWindows?: number } = {},
): Promise<ExtractAllWindowsResult> {
  const maxWindows = Math.max(1, opts.maxWindows ?? DEFAULT_MAX_WINDOWS);

  const extractDeps: ExtractDeps = {
    anthropicClient: deps.anthropicClient,
    agentModel: deps.agentModel,
    logger: deps.logger,
    cloudflare: null,
    extractToolLoopEnabled: false,
    repo: {
      peekContentHash: async () => false,
      commitContentHash: async () => {},
      updateSourceMeta: async () => {},
      getOrgPlaybook: async () => null,
      logUsage: async () => {},
    },
  };

  const releases: RawRelease[] = [];
  let offset: number | null = 0;
  let windows = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let lastProcessedEnd = 0;

  while (offset !== null && windows < maxWindows) {
    const sliced = sliceChangelog(markdown, {
      tokens: DEFAULT_CHANGELOG_SLICE_TOKENS,
      offset,
    });
    // oxlint-disable-next-line no-await-in-loop -- sequential by design; each window is bounded + cheap (Haiku t0)
    const result = await extractFromBody(
      {
        body: sliced.content,
        systemPrompt: CLOUDFLARE_SYSTEM_PROMPT,
        userMessage: `Extract all changelog/release entries from this page (source URL: ${source.url}):`,
        sourceUrl: source.url,
        fetchUrl: source.url,
      },
      extractDeps,
    );
    releases.push(...(mapEntries(result.entries, { sourceUrl: source.url }) as RawRelease[]));
    totalInput += result.totalInput;
    totalOutput += result.totalOutput;
    windows++;
    lastProcessedEnd = sliced.offset + sliced.content.length;
    offset = sliced.nextOffset;
  }

  const cappedAtWindow = offset !== null;
  const droppedChars = cappedAtWindow ? Math.max(0, markdown.length - lastProcessedEnd) : 0;

  return { releases, windows, cappedAtWindow, droppedChars, totalInput, totalOutput };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test workers/api/src/lib/firecrawl-extract.test.ts`
Expected: PASS (6 tests: 3 existing + 3 new).

- [ ] **Step 5: Type-check and commit**

Run: `cd workers/api && npx tsc --noEmit && cd ../..`
Expected: no errors.

```bash
git add workers/api/src/lib/firecrawl-extract.ts workers/api/src/lib/firecrawl-extract.test.ts
git commit -m "feat(backfill): add extractChangelogAllWindows loop-all-windows primitive"
```

---

## Task 2: `runSourceBackfill` core

**Files:**

- Create: `workers/api/src/lib/source-backfill.ts`
- Test: `workers/api/src/lib/source-backfill.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `workers/api/src/lib/source-backfill.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import type { RawRelease } from "@releases/adapters/types.js";
import { runSourceBackfill, type SourceBackfillDeps } from "./source-backfill.js";

const SOURCE = { id: "src_1", slug: "acme" };

function rel(url: string, publishedAt?: Date): RawRelease {
  return { title: url, content: "body", url, publishedAt };
}

function baseDeps(over: Partial<SourceBackfillDeps> = {}): SourceBackfillDeps {
  return {
    resolveBody: async () => ({ markdown: "md", via: "supplied" }),
    extract: async () => ({
      releases: [
        rel("https://x#a", new Date("2024-01-01T00:00:00Z")),
        rel("https://x#b", new Date("2024-03-01T00:00:00Z")),
        rel("https://x#a", new Date("2024-02-01T00:00:00Z")), // dup url
      ],
      windows: 2,
      cappedAtWindow: false,
      droppedChars: 0,
    }),
    ingest: async () => ({ insertedIds: [], found: 0, inserted: 0, visiblePublishRows: [] }),
    embedAndGenerate: async () => {},
    ...over,
  };
}

describe("runSourceBackfill", () => {
  it("dryRun: reports counts + date range and never ingests", async () => {
    let ingestCalls = 0;
    const deps = baseDeps({
      ingest: async () => {
        ingestCalls++;
        return { insertedIds: ["x"], found: 1, inserted: 1, visiblePublishRows: [] };
      },
    });

    const report = await runSourceBackfill(SOURCE, { dryRun: true }, deps);

    expect(ingestCalls).toBe(0);
    expect(report.dryRun).toBe(true);
    expect(report.extracted).toBe(3);
    expect(report.deduped).toBe(2); // #a collapsed
    expect(report.dateRange.from).toBe("2024-01-01T00:00:00.000Z");
    expect(report.dateRange.to).toBe("2024-03-01T00:00:00.000Z");
    expect(report.inserted).toBe(0);
    expect(report.via).toBe("supplied");
    expect(report.windows).toBe(2);
  });

  it("real run: ingests deduped rows then enriches inserted ids", async () => {
    const ingested: RawRelease[][] = [];
    const enriched: string[][] = [];
    const deps = baseDeps({
      ingest: async (rows) => {
        ingested.push(rows);
        return { insertedIds: ["r1", "r2"], found: 2, inserted: 2, visiblePublishRows: [] };
      },
      embedAndGenerate: async (ids) => {
        enriched.push(ids);
      },
    });

    const report = await runSourceBackfill(SOURCE, { dryRun: false }, deps);

    expect(ingested.length).toBe(1);
    expect(ingested[0].length).toBe(2); // deduped before ingest
    expect(enriched).toEqual([["r1", "r2"]]);
    expect(report.inserted).toBe(2);
    expect(report.found).toBe(2);
  });

  it("real run: skips enrichment when nothing was inserted", async () => {
    let enrichCalls = 0;
    const deps = baseDeps({
      ingest: async () => ({ insertedIds: [], found: 2, inserted: 0, visiblePublishRows: [] }),
      embedAndGenerate: async () => {
        enrichCalls++;
      },
    });

    const report = await runSourceBackfill(SOURCE, { dryRun: false }, deps);

    expect(enrichCalls).toBe(0);
    expect(report.inserted).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test workers/api/src/lib/source-backfill.test.ts`
Expected: FAIL — module `./source-backfill.js` not found.

- [ ] **Step 3: Implement the core**

Create `workers/api/src/lib/source-backfill.ts`:

```ts
import type { RawRelease } from "@releases/adapters/types.js";
// Type-only: erased at compile time, so this does NOT pull poll-fetch's runtime
// deps into the route module's import graph.
import type { IngestResult } from "../cron/poll-fetch.js";

export type BackfillBodyVia = "supplied" | "firecrawl" | "fetch";

export interface SourceBackfillExtractResult {
  releases: RawRelease[];
  windows: number;
  cappedAtWindow: boolean;
  droppedChars: number;
}

export interface SourceBackfillDeps {
  /** Acquire the full-page markdown (supplied / firecrawl / fetch). */
  resolveBody: () => Promise<{ markdown: string; via: BackfillBodyVia }>;
  /** Loop-all-windows extraction over the markdown. */
  extract: (markdown: string) => Promise<SourceBackfillExtractResult>;
  /** Upsert deduped rows via the standard ingest tail. */
  ingest: (rows: RawRelease[]) => Promise<IngestResult>;
  /** Embed + (re)generate summaries/titles for the inserted ids. */
  embedAndGenerate: (insertedIds: string[]) => Promise<void>;
}

export interface SourceBackfillReport {
  source: { id: string; slug: string };
  via: BackfillBodyVia;
  windows: number;
  cappedAtWindow: boolean;
  droppedChars: number;
  /** Pre-dedup mapEntries count. */
  extracted: number;
  /** Unique-by-url count submitted to ingest. */
  deduped: number;
  dateRange: { from: string | null; to: string | null };
  /** rawReleases.length reported by ingest (0 on dryRun). */
  found: number;
  /** Rows actually inserted (0 on dryRun). */
  inserted: number;
  dryRun: boolean;
}

/** Collapse rows sharing a synthesized dedup URL, keeping the first occurrence.
 *  A single D1 `INSERT ... ON CONFLICT` cannot touch the same `(source_id, url)`
 *  twice, so within-batch dupes must be removed before ingest chunks them. */
function dedupeByUrl(rows: RawRelease[]): RawRelease[] {
  const seen = new Set<string>();
  const out: RawRelease[] = [];
  for (const r of rows) {
    const key = r.url ?? "";
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

function dateRange(rows: RawRelease[]): { from: string | null; to: string | null } {
  let from: number | null = null;
  let to: number | null = null;
  for (const r of rows) {
    if (!r.publishedAt) continue;
    const t = r.publishedAt.getTime();
    if (Number.isNaN(t)) continue;
    if (from === null || t < from) from = t;
    if (to === null || t > to) to = t;
  }
  return {
    from: from === null ? null : new Date(from).toISOString(),
    to: to === null ? null : new Date(to).toISOString(),
  };
}

export async function runSourceBackfill(
  source: { id: string; slug: string },
  opts: { dryRun: boolean },
  deps: SourceBackfillDeps,
): Promise<SourceBackfillReport> {
  const { markdown, via } = await deps.resolveBody();
  const extracted = await deps.extract(markdown);
  const deduped = dedupeByUrl(extracted.releases);

  const report: SourceBackfillReport = {
    source,
    via,
    windows: extracted.windows,
    cappedAtWindow: extracted.cappedAtWindow,
    droppedChars: extracted.droppedChars,
    extracted: extracted.releases.length,
    deduped: deduped.length,
    dateRange: dateRange(deduped),
    found: 0,
    inserted: 0,
    dryRun: opts.dryRun,
  };

  if (opts.dryRun) return report;

  const result = await deps.ingest(deduped);
  if (result.insertedIds.length > 0) {
    await deps.embedAndGenerate(result.insertedIds);
  }
  report.found = result.found;
  report.inserted = result.inserted;
  return report;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test workers/api/src/lib/source-backfill.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Type-check and commit**

Run: `cd workers/api && npx tsc --noEmit && cd ../..`
Expected: no errors.

```bash
git add workers/api/src/lib/source-backfill.ts workers/api/src/lib/source-backfill.test.ts
git commit -m "feat(backfill): add runSourceBackfill DI core with url dedup"
```

---

## Task 3: `normalizeMediaBind` helper + batch-route fix

**Files:**

- Create: `workers/api/src/lib/media-bind.ts`
- Test: `workers/api/src/lib/media-bind.test.ts`
- Modify: `workers/api/src/routes/sources.ts`

- [ ] **Step 1: Write the failing tests**

Create `workers/api/src/lib/media-bind.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { normalizeMediaBind } from "./media-bind.js";

describe("normalizeMediaBind", () => {
  it("passes a JSON string through unchanged", () => {
    expect(normalizeMediaBind('[{"type":"image","url":"https://x/a.png"}]')).toBe(
      '[{"type":"image","url":"https://x/a.png"}]',
    );
  });

  it("maps null/undefined to an empty JSON array", () => {
    expect(normalizeMediaBind(null)).toBe("[]");
    expect(normalizeMediaBind(undefined)).toBe("[]");
  });

  it("stringifies an array value instead of binding a non-primitive", () => {
    expect(normalizeMediaBind([{ type: "image", url: "https://x/a.png" }])).toBe(
      '[{"type":"image","url":"https://x/a.png"}]',
    );
  });

  it("stringifies an object value", () => {
    expect(normalizeMediaBind({ url: "https://x/a.png" })).toBe('{"url":"https://x/a.png"}');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test workers/api/src/lib/media-bind.test.ts`
Expected: FAIL — module `./media-bind.js` not found.

- [ ] **Step 3: Implement the helper**

Create `workers/api/src/lib/media-bind.ts`:

```ts
/**
 * Normalize a release's `media` field to a JSON string safe to bind to D1.
 *
 * `POST /v1/sources/:id/releases/batch` documents `media` as a JSON string, but
 * a misbehaving caller (or LLM agent) may send an array/object. Binding a
 * non-primitive makes D1 reject the prepared statement; because the batch insert
 * is chunked + non-transactional, that 500s mid-batch after partially inserting
 * earlier chunks. Coercing here (stringify the array/object) keeps the insert
 * forgiving instead of silently half-applying.
 */
export function normalizeMediaBind(media: unknown): string {
  if (typeof media === "string") return media;
  if (media == null) return "[]";
  return JSON.stringify(media);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test workers/api/src/lib/media-bind.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Use the helper in the batch route**

In `workers/api/src/routes/sources.ts`, add the import near the other `../lib/*` imports (top of file):

```ts
import { normalizeMediaBind } from "../lib/media-bind.js";
```

Then replace the `mediaJsonByIndex` line (currently `sources.ts:725`):

```ts
const mediaJsonByIndex = body.releases.map((r) => r.media ?? "[]");
```

with:

```ts
// Coerce array/object media to a JSON string so a non-primitive bind can't
// 500 the chunked, non-transactional insert mid-batch. See media-bind.ts.
const mediaJsonByIndex = body.releases.map((r) => normalizeMediaBind(r.media));
```

- [ ] **Step 6: Type-check and commit**

Run: `cd workers/api && npx tsc --noEmit && cd ../..`
Expected: no errors.

```bash
git add workers/api/src/lib/media-bind.ts workers/api/src/lib/media-bind.test.ts workers/api/src/routes/sources.ts
git commit -m "fix(sources): stringify array-valued media before D1 bind in /releases/batch"
```

---

## Task 4: `POST /v1/workflows/backfill-source` route + smoke tests

**Files:**

- Modify: `workers/api/src/routes/workflows.ts`
- Test: `workers/api/test/workflows-backfill.test.ts`

- [ ] **Step 1: Write the failing smoke tests**

Create `workers/api/test/workflows-backfill.test.ts`:

```ts
// Smoke tests for POST /v1/workflows/backfill-source.
//
// Covers the gates (typed-id, 404, non-scrape, 503-no-key) and a supplied-
// markdown dry-run via the `_backfillExtractOverride` test hook. The deep
// extract/ingest logic is unit-tested in source-backfill.test.ts and
// firecrawl-extract.test.ts; this file only proves the HTTP wiring.
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";

const { Hono } = await import("hono");
const { workflowsRoutes } = await import("../src/routes/workflows.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  sqlite.exec("DELETE FROM collections");
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>, extra: Record<string, unknown> = {}) {
  const fakeEnv = { DB: db, ...extra };
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", workflowsRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv);
}

async function seedScrapeSource(db: ReturnType<typeof mkDb>): Promise<void> {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "developer-tools" });
  await db.insert(sources).values({
    id: "src_scrape",
    orgId: "org_a",
    slug: "acme-blog",
    name: "Acme Blog",
    type: "scrape",
    url: "https://acme.test/changelog",
  });
}

function post(fetch: (r: Request) => Promise<Response>, body: unknown) {
  return fetch(
    new Request("https://x.test/v1/workflows/backfill-source", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /v1/workflows/backfill-source", () => {
  it("rejects a bare slug with bare_slug_rejected", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    const res = await post(mkApp(db), { sourceSlug: "acme-blog" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bare_slug_rejected");
  });

  it("404s an unknown source id", async () => {
    const db = mkDb();
    const res = await post(mkApp(db), { sourceId: "src_missing" });
    expect(res.status).toBe(404);
  });

  it("400s a non-scrape source", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_g", slug: "gh", name: "GH", category: "developer-tools" });
    await db.insert(sources).values({
      id: "src_gh",
      orgId: "org_g",
      slug: "gh-src",
      name: "GH Source",
      type: "github",
      url: "https://github.com/gh/gh",
    });
    const res = await post(mkApp(db), { sourceId: "src_gh" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
  });

  it("503s when no Anthropic key and no extract override", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    const res = await post(mkApp(db), {
      sourceId: "src_scrape",
      markdown: "# v1\nstuff",
      dryRun: true,
    });
    expect(res.status).toBe(503);
  });

  it("dryRun with supplied markdown reports deduped counts + date range", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    const override = async () => ({
      releases: [
        { title: "v1", content: "b", url: "https://x#a", publishedAt: new Date("2024-01-01") },
        { title: "v2", content: "b", url: "https://x#b", publishedAt: new Date("2024-03-01") },
        { title: "v1again", content: "b", url: "https://x#a" },
      ],
      windows: 1,
      cappedAtWindow: false,
      droppedChars: 0,
    });
    const fetch = mkApp(db, { _backfillExtractOverride: override });

    const res = await post(fetch, {
      sourceId: "src_scrape",
      markdown: "# v1\nstuff",
      dryRun: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      via: string;
      extracted: number;
      deduped: number;
      inserted: number;
      dryRun: boolean;
      dateRange: { from: string | null; to: string | null };
    };
    expect(body.via).toBe("supplied");
    expect(body.extracted).toBe(3);
    expect(body.deduped).toBe(2);
    expect(body.inserted).toBe(0);
    expect(body.dryRun).toBe(true);
    expect(body.dateRange.from).toBe("2024-01-01T00:00:00.000Z");
    expect(body.dateRange.to).toBe("2024-03-01T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test workers/api/test/workflows-backfill.test.ts`
Expected: FAIL — route not registered (bare-slug test 404s instead of 400, or 404 path returns the wrong shape; the dryRun test gets 404).

- [ ] **Step 3: Add imports to `workflows.ts`**

In `workers/api/src/routes/workflows.ts`, add these imports (group with the existing `@releases/*` / `../lib/*` / `../cron/*` imports near the top):

```ts
import type { Source } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types.js";
import { getSourceMeta, htmlToMarkdown } from "@releases/adapters/feed.js";
import { createFirecrawlClient } from "@releases/adapters/firecrawl.js";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { getSecret } from "@releases/lib/secrets";
import { FirecrawlError } from "@releases/lib/errors";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { ingestRawReleases, embedReleasesForSource } from "../cron/poll-fetch.js";
import { extractChangelogAllWindows } from "../lib/firecrawl-extract.js";
import {
  runSourceBackfill,
  type BackfillBodyVia,
  type SourceBackfillDeps,
  type SourceBackfillExtractResult,
} from "../lib/source-backfill.js";
```

Notes:

- `ingestRawReleases` / `embedReleasesForSource` come from `../cron/poll-fetch.js`, which is already top-level-imported in this file (line ~47) and is Bun-safe. `resolveFetchEnv` + `generateContentForReleases` live in `../workflows/poll-and-fetch.js`, which pulls `cloudflare:workers` — those MUST stay lazy-imported (Step 4), only on the non-dryRun path, so the Bun-loaded smoke tests never trigger that import.
- `getAnthropicKey`, `resolveGatewayOpts`, `createDb`, `sources`, `isSourceId`, `sourceMatchByIdOrSlug`, `parsePositiveInt`, `logEvent` are already imported.

- [ ] **Step 4: Add the route handler to `workflows.ts`**

Append after the `enrich-feed-content` handler (end of file):

```ts
// ── POST /workflows/backfill-source ──────────────────────────────────────────
//
// Operator/agent-triggered full-history backfill for a windowed scrape source.
// Acquires the full page (supplied markdown / Firecrawl / plain fetch), loops
// extraction over every window, dedups by synthesized url, then upserts via the
// standard ingest tail and (inline) embeds + regenerates summaries. dryRun
// (default) previews counts + date range without writing. Idempotent.
//
// Body: { sourceId?, sourceSlug?, markdown?, maxWindows?, dryRun? }

const BACKFILL_DEFAULT_MAX_WINDOWS = 50;
const BACKFILL_MAX_MAX_WINDOWS = 200;
// Per-call summary chunk. generateContentForReleases bails entirely above
// MAX_AUTOGEN_ROWS_PER_FIRE (20) in poll-and-fetch.ts; chunk under it so a
// large backfill still gets every row summarized.
const BACKFILL_SUMMARY_CHUNK = 20;
// Matches FirecrawlIngestWorkflow's FIRECRAWL_EXTRACT_MODEL: cheap, deterministic.
const BACKFILL_EXTRACT_MODEL = "claude-haiku-4-5-20251001";

const backfillLogger = {
  info: (msg: string) =>
    logEvent("info", { component: "backfill-source", event: "extract-info", message: msg }),
  warn: (msg: string) =>
    logEvent("warn", { component: "backfill-source", event: "extract-warn", message: msg }),
  debug: (msg: string) =>
    logEvent("info", { component: "backfill-source", event: "extract-debug", message: msg }),
  error: (msg: string) =>
    logEvent("error", { component: "backfill-source", event: "extract-error", message: msg }),
};

interface BackfillSourceBody {
  sourceId?: string;
  sourceSlug?: string;
  markdown?: string;
  maxWindows?: number;
  dryRun?: boolean;
}

// TEST-ONLY hook (kept off the production Env type): inject the all-windows
// extraction result instead of calling Anthropic. Read via a local cast.
type BackfillExtractOverride = (
  markdown: string,
  source: Source,
) => Promise<SourceBackfillExtractResult>;

workflowsRoutes.post("/workflows/backfill-source", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<BackfillSourceBody>().catch(() => ({}) as BackfillSourceBody);

  const ident = body.sourceId?.trim() || body.sourceSlug?.trim();
  if (!ident) {
    return c.json({ error: "bad_request", message: "Provide `sourceId` or `sourceSlug`" }, 400);
  }
  if (!isSourceId(ident)) {
    return c.json(
      {
        error: "bare_slug_rejected",
        message:
          "Pass a typed source ID (src_…). Bare slugs are ambiguous across orgs — resolve via /v1/orgs/{orgSlug}/sources/{sourceSlug} or /v1/lookups/source-by-slug first.",
      },
      400,
    );
  }

  const [src] = await db.select().from(sources).where(sourceMatchByIdOrSlug(ident));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);
  if (src.type !== "scrape") {
    return c.json(
      {
        error: "bad_request",
        message: `Backfill supports scrape sources; this source is type=${src.type}`,
      },
      400,
    );
  }

  const rawMax = Number(body.maxWindows ?? BACKFILL_DEFAULT_MAX_WINDOWS);
  const maxWindows = Number.isFinite(rawMax)
    ? Math.min(Math.max(Math.floor(rawMax), 1), BACKFILL_MAX_MAX_WINDOWS)
    : BACKFILL_DEFAULT_MAX_WINDOWS;
  const dryRun = body.dryRun !== false; // default to a dry run for safety
  const suppliedMarkdown =
    typeof body.markdown === "string" && body.markdown.trim().length > 0 ? body.markdown : null;
  const meta = getSourceMeta(src);

  // ── Body acquisition (errors mapped to HTTP here) ──────────────────────────
  let resolved: { markdown: string; via: BackfillBodyVia };
  if (suppliedMarkdown) {
    resolved = { markdown: suppliedMarkdown, via: "supplied" };
  } else if (meta.firecrawl?.enabled) {
    const apiKey = await getSecret(c.env.FIRECRAWL_API_KEY);
    if (!apiKey) {
      return c.json(
        { error: "service_unavailable", message: "FIRECRAWL_API_KEY not configured" },
        503,
      );
    }
    try {
      const client = createFirecrawlClient({ apiKey });
      const md = await client.scrapeOnce(src.url, { proxy: meta.firecrawl?.proxy });
      if (!md) {
        return c.json(
          { error: "bad_gateway", message: `Empty Firecrawl scrape for ${src.url}` },
          502,
        );
      }
      resolved = { markdown: md, via: "firecrawl" };
    } catch (err) {
      const status = err instanceof FirecrawlError ? err.status : null;
      return c.json(
        {
          error: "bad_gateway",
          message: `Firecrawl scrape failed${status ? ` (${status})` : ""}`,
          firecrawlStatus: status,
        },
        502,
      );
    }
  } else {
    try {
      const res = await fetch(src.url, { headers: { "User-Agent": RELEASES_BOT_UA } });
      const md = res.ok ? htmlToMarkdown(await res.text()) : "";
      if (!md.trim()) {
        return c.json(
          {
            error: "bad_request",
            message: `Could not fetch a usable body for ${src.url}. Supply \`markdown\` or enable Firecrawl on this source.`,
          },
          400,
        );
      }
      resolved = { markdown: md, via: "fetch" };
    } catch {
      return c.json(
        {
          error: "bad_request",
          message: `Could not fetch ${src.url}. Supply \`markdown\` or enable Firecrawl on this source.`,
        },
        400,
      );
    }
  }

  // ── Extraction (override in tests; else Haiku t0 all-windows) ──────────────
  const override = (c.env as { _backfillExtractOverride?: BackfillExtractOverride })
    ._backfillExtractOverride;
  let anthropicClient: ReturnType<typeof buildAnthropicClient> | null = null;
  if (!override) {
    const apiKey = await getAnthropicKey(c.env);
    if (!apiKey) {
      return c.json(
        { error: "service_unavailable", message: "ANTHROPIC_API_KEY not configured" },
        503,
      );
    }
    anthropicClient = buildAnthropicClient({ apiKey, ...(await resolveGatewayOpts(c.env)) });
  }
  const extract = async (markdown: string): Promise<SourceBackfillExtractResult> => {
    if (override) return override(markdown, src);
    const r = await extractChangelogAllWindows(
      markdown,
      src,
      {
        anthropicClient: anthropicClient!,
        agentModel: BACKFILL_EXTRACT_MODEL,
        logger: backfillLogger,
      },
      { maxWindows },
    );
    return {
      releases: r.releases,
      windows: r.windows,
      cappedAtWindow: r.cappedAtWindow,
      droppedChars: r.droppedChars,
    };
  };

  // ── Ingest + enrich deps (lazy import only on the write path) ──────────────
  const deps: SourceBackfillDeps = {
    resolveBody: async () => resolved,
    extract,
    ingest: async () => {
      throw new Error("ingest unavailable on dryRun");
    },
    embedAndGenerate: async () => {},
  };
  if (!dryRun) {
    // poll-and-fetch.js pulls `cloudflare:workers` — import it only here so the
    // Bun-loaded OpenAPI coverage check / route smoke tests never trip on it.
    const { resolveFetchEnv, generateContentForReleases } =
      await import("../workflows/poll-and-fetch.js");
    const fetchEnv = await resolveFetchEnv(c.env as never);
    deps.ingest = (rows: RawRelease[]) =>
      ingestRawReleases(db as never, src as never, rows, fetchEnv);
    deps.embedAndGenerate = async (ids: string[]) => {
      if (c.env.RELEASES_INDEX) {
        await embedReleasesForSource(db as never, src as never, ids, fetchEnv, {
          throwOnError: false,
        });
      }
      for (let i = 0; i < ids.length; i += BACKFILL_SUMMARY_CHUNK) {
        // oxlint-disable-next-line no-await-in-loop -- bounded chunks under the autogen row cap
        await generateContentForReleases(
          db as never,
          c.env as never,
          src as never,
          ids.slice(i, i + BACKFILL_SUMMARY_CHUNK),
        );
      }
    };
  }

  const report = await runSourceBackfill({ id: src.id, slug: src.slug }, { dryRun }, deps);
  if (report.cappedAtWindow || report.droppedChars > 0) {
    logEvent("info", {
      component: "backfill-source",
      event: "windowed-cap",
      sourceId: src.id,
      windows: report.windows,
      droppedChars: report.droppedChars,
    });
  }
  return c.json(report);
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test workers/api/test/workflows-backfill.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Type-check and commit**

Run: `cd workers/api && npx tsc --noEmit && cd ../..`
Expected: no errors.

```bash
git add workers/api/src/routes/workflows.ts workers/api/test/workflows-backfill.test.ts
git commit -m "feat(backfill): add POST /v1/workflows/backfill-source endpoint"
```

---

## Task 5: Docs

**Files:**

- Modify: `docs/architecture/firecrawl-monitoring.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Add a backfill section to the firecrawl architecture doc**

Append to `docs/architecture/firecrawl-monitoring.md`:

```markdown
## Full-history backfill (`POST /v1/workflows/backfill-source`)

The steady-state ingest windows a baseline scrape to the recent
`DEFAULT_CHANGELOG_SLICE_TOKENS` slice (`extractFirecrawlMarkdown`), so older
history is dropped on onboard. To recover it, an operator or local sub-agent
POSTs `{ sourceId, markdown?, maxWindows?, dryRun? }` to
`/v1/workflows/backfill-source` (admin-gated, sibling of `enrich-feed-content`).

- **Body acquisition ladder:** supplied `markdown` (any scrape source, incl.
  JS/CF-blocked pages the worker can't fetch) → Firecrawl `scrapeOnce` (when
  `metadata.firecrawl.enabled`) → plain `fetch` + `htmlToMarkdown`.
- **Extraction:** `extractChangelogAllWindows` loops `sliceChangelog` over the
  whole document (Haiku 4.5, temp 0, one-shot per window), bounded by
  `maxWindows` (default 50, max 200). `cappedAtWindow` / `droppedChars` report
  any untouched tail — no silent caps.
- **Dedup contract:** reuses the exact prod `extractFromBody` + `mapEntries`, so
  synthesized `${sourceUrl}#${slug(version ?? title)}` URLs match already-stored
  rows. `RELEASE_URL_UPSERT` no-ops them; an in-memory dedup collapses
  within-batch duplicates (a single D1 `ON CONFLICT` can't touch one
  `(source_id, url)` twice). Re-running is idempotent.
- **`dryRun` (default true):** returns `windows`, `extracted`, `deduped`,
  `dateRange` without writing. A real run upserts via `ingestRawReleases`, then
  embeds + regenerates summaries (summary calls chunked at 20 to clear the
  `MAX_AUTOGEN_ROWS_PER_FIRE` autogen cap).
```

- [ ] **Step 2: Add a one-line convention pointer to AGENTS.md**

In `AGENTS.md`, under the Conventions list (near the Firecrawl monitoring bullet), add:

```markdown
- **Full-history backfill** for windowed scrape sources: `POST /v1/workflows/backfill-source { sourceId, markdown?, maxWindows?, dryRun? }` loops extraction over every window and upserts idempotently (dedup-safe via the prod `extractFromBody`+`mapEntries` slugs). Body comes from supplied markdown → Firecrawl → plain fetch. See [firecrawl-monitoring.md](docs/architecture/firecrawl-monitoring.md).
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/firecrawl-monitoring.md AGENTS.md
git commit -m "docs(backfill): document the backfill-source endpoint + convention pointer"
```

---

## Task 6: Full verification

- [ ] **Step 1: Root type-check**

Run: `npx tsc --noEmit`
Expected: no errors (root checks `src/`).

- [ ] **Step 2: Worker type-check**

Run: `cd workers/api && npx tsc --noEmit && cd ../..`
Expected: no errors.

- [ ] **Step 3: Run the new + adjacent tests**

Run: `bun test workers/api/src/lib/firecrawl-extract.test.ts workers/api/src/lib/source-backfill.test.ts workers/api/src/lib/media-bind.test.ts workers/api/test/workflows-backfill.test.ts`
Expected: all PASS.

- [ ] **Step 4: Full test suite**

Run: `bun test`
Expected: PASS (no regressions). If the monorepo split runs `packages/` separately, that's expected per repo conventions.

- [ ] **Step 5: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean. If `format:check` flags the new files, run `bun run format` and re-commit.

- [ ] **Step 6: Final commit (only if Step 5 reformatted anything)**

```bash
git add -A
git commit -m "chore(backfill): formatting"
```

---

## Self-review notes (resolved during planning)

- **Spec coverage:** loop-all-windows (Task 1), dryRun + dedup + date range (Task 2), body ladder + route + auth + clamps (Task 4), inline embed/summarize with the 20-row chunk fix (Task 4 Step 4), batch media-bind fix (Task 3), docs (Task 5). All acceptance rows in the spec map to a task.
- **`generateContentForReleases` 20-row cap:** it returns early (generating nothing) above `MAX_AUTOGEN_ROWS_PER_FIRE`; the backfill chunks inserted ids at `BACKFILL_SUMMARY_CHUNK = 20` so a 70–119-row backfill still gets every row summarized.
- **Bun import safety:** `poll-and-fetch.js` (pulls `cloudflare:workers`) is lazy-imported only on the `!dryRun` path; smoke tests exercise only gates + dryRun, so they never trigger it. `poll-fetch.js` is already Bun-safe and top-level-imported in `workflows.ts`.
- **Type names are consistent across tasks:** `SourceBackfillExtractResult`, `SourceBackfillDeps`, `SourceBackfillReport`, `BackfillBodyVia`, `ExtractAllWindowsResult`, `normalizeMediaBind` are used with identical signatures in their definitions, the route, and the tests.
