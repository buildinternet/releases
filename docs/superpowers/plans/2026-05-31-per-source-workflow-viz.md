# Per-source Workflow Visualization Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-source workflow drawer to the dev-only Fetch Log tab that visualizes each source's ingestion pipeline (adaptive node list) annotated with current state and last-run outcome.

**Architecture:** A pure topology function (`describeWorkflowStages`) in `@releases/adapters` decides which stages apply to a source; a dev-only `GET /status/source-workflow` endpoint combines that topology with derived state from `fetch_log` + `usage_log` + `sources`; a React drawer (opened from the existing Fetch Plan table) renders an adaptive vertical pipeline. Phase 1 derives everything from existing data — no schema change, no migration, no new dependency.

**Tech Stack:** TypeScript (strict), Bun (test), Cloudflare Worker + Hono + Drizzle (API), Next.js 16 + React 19 + Tailwind (web). Tests: `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-31-per-source-workflow-viz-design.md` (commit `5f8997a3`).

---

## Pre-flight (run once)

- [ ] **Install deps in this worktree.** Workspace packages otherwise resolve to the main checkout and tests read back stale code. Run: `bun install` (from the worktree root). Expected: completes without error.

---

## File Structure

**Create:**

- `packages/adapters/src/workflow-stages.ts` — pure topology fn (`describeWorkflowStages`) + types. Importable as `@releases/adapters/workflow-stages` (package.json `exports` is wildcarded — no manifest change).
- `packages/adapters/src/workflow-stages.test.ts` — unit tests for the topology fn.
- `web/src/components/use-source-workflow.ts` — client hook + local wire types.
- `web/src/components/workflow-pipeline-logic.ts` — pure derivation (node→data mapping, op→stage matching, content/async split).
- `web/src/components/workflow-pipeline-logic.test.ts` — bun unit tests for the derivation.
- `web/src/components/workflow-pipeline.tsx` — presentational pipeline (consumes the logic module).
- `web/src/components/source-workflow-drawer.tsx` — drawer container.

**Modify:**

- `workers/api/src/routes/status.ts` — add `GET /status/source-workflow` handler (+ two consts).
- `workers/api/test/fetch-plan-route.test.ts` sibling → new `workers/api/test/source-workflow-route.test.ts`.
- `web/src/components/org-fetch-plan-panel.tsx` — add `onSelectSource` prop; make the source-name cell clickable.
- `web/src/components/org-fetch-log-view.tsx` — own `selectedSourceId` state; render the drawer.
- `docs/architecture/web.md` — one-line pointer.

## Verified Constraints (do not relearn)

- `usage_log.operation` values are **free-form caller labels**, confirmed set: `summarize`, `compare`, `enrich-extract`, `firecrawl-extract`, `agent-ingest`, plus `extract` / `extract-toolloop` from the extract repo. **There is NO `classify` label** — the marketing classifier is not instrumented to `usage_log`, so the Classify node shows "configured" (from the `marketingFilter` flag), never a verified per-run outcome. `enrich-extract` contains the substring "extract", so the op→stage matcher MUST check `enrich` before `extract`.
- `createDb(dbOrD1)` (`workers/api/src/db.ts`) passes a pre-built drizzle handle through (`if (…select === "function") return it`), so route tests inject `createTestDb()` as `env.DB`.
- `fetch_log` has no per-stage rows and no `fetchLogId` on `usage_log`; correlate AI passes to a run by `(sourceId, createdAt ± window)`. "Hash check" outcome = `lastRun.status === "no_change" ? "unchanged" : "changed"`.
- Route auto-registers: `statusRoutes` is mounted via `v1.route("/", statusRoutes)` in `workers/api/src/v1-routes.ts`. Client reaches it through `/api/proxy/status/source-workflow` (the proxy forwards `/v1/<path>` generically and injects the admin Bearer).
- Status endpoints are dev-only and NOT in `@buildinternet/releases-api-types` — keep wire types local in the hook (same as `use-fetch-plan.ts`).
- No `schema.ts` edit in Phase 1 ⇒ no migration ⇒ the CI schema-pairing gate is not triggered.

---

## Task 1: `describeWorkflowStages()` pure topology function

**Files:**

- Create: `packages/adapters/src/workflow-stages.ts`
- Test: `packages/adapters/src/workflow-stages.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/adapters/src/workflow-stages.test.ts
import { describe, it, expect } from "bun:test";
import type { Source } from "@buildinternet/releases-core/schema";
import { describeWorkflowStages } from "./workflow-stages.js";

function mkSource(
  over: Omit<Partial<Source>, "metadata"> & { metadata?: Record<string, unknown> | null },
): Source {
  const { metadata, ...rest } = over;
  return {
    id: "src_x",
    orgId: "org_x",
    slug: "x",
    name: "X",
    url: "https://x.test",
    type: "scrape",
    fetchPriority: "normal",
    nextFetchAfter: null,
    lastPolledAt: null,
    lastFetchedAt: null,
    deletedAt: null,
    changeDetectedAt: null,
    ...rest,
    metadata: metadata == null ? null : JSON.stringify(metadata),
  } as unknown as Source;
}
const keys = (s: Source) => describeWorkflowStages(s).map((x) => x.key);

describe("describeWorkflowStages", () => {
  it("github: poll→fetch→hash→parse→upsert + async(summarize,embed,changelog,publish)", () => {
    expect(keys(mkSource({ type: "github" }))).toEqual([
      "poll",
      "fetch",
      "hash",
      "parse",
      "upsert",
      "summarize",
      "embed",
      "changelog",
      "publish",
    ]);
  });
  it("github + marketingFilter inserts classify before upsert", () => {
    expect(keys(mkSource({ type: "github", metadata: { marketingFilter: true } }))).toEqual([
      "poll",
      "fetch",
      "hash",
      "parse",
      "classify",
      "upsert",
      "summarize",
      "embed",
      "changelog",
      "publish",
    ]);
  });
  it("feed plain", () => {
    expect(keys(mkSource({ type: "feed", metadata: { feedUrl: "u", feedType: "rss" } }))).toEqual([
      "poll",
      "fetch",
      "hash",
      "parse",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
  });
  it("feed summary-only + marketingFilter inserts enrich then classify", () => {
    expect(
      keys(
        mkSource({
          type: "feed",
          metadata: {
            feedUrl: "u",
            feedType: "rss",
            feedContentDepth: "summary-only",
            marketingFilter: true,
          },
        }),
      ),
    ).toEqual([
      "poll",
      "fetch",
      "hash",
      "parse",
      "enrich",
      "classify",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
  });
  it("video has no enrich/classify/changelog even if flags set", () => {
    expect(
      keys(
        mkSource({
          type: "video",
          metadata: {
            feedUrl: "u",
            feedType: "atom",
            video: { provider: "youtube" },
            marketingFilter: true,
            feedContentDepth: "summary-only",
          },
        }),
      ),
    ).toEqual(["poll", "fetch", "hash", "parse", "upsert", "summarize", "embed", "publish"]);
  });
  it("scrape uses extract; no enrich/changelog", () => {
    expect(keys(mkSource({ type: "scrape" }))).toEqual([
      "poll",
      "fetch",
      "hash",
      "extract",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
  });
  it("scrape + crawlEnabled keeps key 'fetch' but labels it Crawl", () => {
    const s = mkSource({ type: "scrape", metadata: { crawlEnabled: true } });
    expect(keys(s)).toEqual([
      "poll",
      "fetch",
      "hash",
      "extract",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
    expect(describeWorkflowStages(s).find((x) => x.key === "fetch")!.label).toBe("Crawl");
  });
  it("appstore: no extract/enrich/classify/changelog", () => {
    expect(
      keys(
        mkSource({
          type: "appstore",
          metadata: { appStore: { trackId: "1", storefront: "us", platform: "ios" } },
        }),
      ),
    ).toEqual(["poll", "fetch", "hash", "parse", "upsert", "summarize", "embed", "publish"]);
  });
  it("agent: trigger→agent-session→parse→upsert + async", () => {
    expect(keys(mkSource({ type: "agent" }))).toEqual([
      "poll",
      "agent-session",
      "parse",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
  });
  it("firecrawl: webhook→diff→extract→upsert + async (no poll)", () => {
    expect(keys(mkSource({ type: "scrape", metadata: { firecrawl: { enabled: true } } }))).toEqual([
      "webhook",
      "diff",
      "extract",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd packages/adapters && bun test workflow-stages.test.ts`
Expected: FAIL — `Cannot find module './workflow-stages.js'`.

- [ ] **Step 3: Implement `workflow-stages.ts`**

```ts
// packages/adapters/src/workflow-stages.ts
/**
 * Pure resolver: which ingestion-pipeline stages apply to a given source, in
 * order. Drives the dev Fetch Log workflow drawer. Reuses describeFetchPlan's
 * strategy so the topology can't drift from the displayed fetch strategy.
 * No I/O — operates on a Source row.
 */
import type { Source } from "@buildinternet/releases-core/schema";
import { describeFetchPlan } from "./fetch-plan.js";
import { getSourceMeta } from "./source-meta.js";

export type StageKind = "sync" | "ai" | "async";

export interface WorkflowStage {
  /** stable id: poll|webhook|fetch|hash|parse|extract|diff|enrich|classify|upsert|agent-session|summarize|embed|changelog|publish */
  key: string;
  label: string;
  kind: StageKind;
  /** static sub-label, e.g. "Browser Rendering", "github-api", "tool-loop" */
  detailHint?: string;
}

const TAIL_COMMON: WorkflowStage[] = [
  { key: "summarize", label: "Summarize", kind: "async", detailHint: "Haiku" },
  { key: "embed", label: "Embed", kind: "async", detailHint: "Voyage" },
  { key: "publish", label: "Publish", kind: "async", detailHint: "events + webhooks" },
];
const TAIL_GITHUB: WorkflowStage[] = [
  { key: "summarize", label: "Summarize", kind: "async", detailHint: "Haiku" },
  { key: "embed", label: "Embed", kind: "async", detailHint: "Voyage" },
  { key: "changelog", label: "Changelog", kind: "async", detailHint: "discover + embed" },
  { key: "publish", label: "Publish", kind: "async", detailHint: "events + webhooks" },
];

export function describeWorkflowStages(source: Source): WorkflowStage[] {
  const meta = getSourceMeta(source);
  const { strategy } = describeFetchPlan(source);
  const marketing = meta.marketingFilter === true;
  const enrich = meta.feedContentDepth === "summary-only";
  const classify: WorkflowStage[] = marketing
    ? [{ key: "classify", label: "Classify", kind: "ai", detailHint: "marketing" }]
    : [];
  const upsert: WorkflowStage = { key: "upsert", label: "Upsert", kind: "sync" };

  switch (strategy) {
    case "github":
      return [
        { key: "poll", label: "Poll", kind: "sync", detailHint: "github-api" },
        { key: "fetch", label: "Fetch", kind: "sync", detailHint: "releases API" },
        { key: "hash", label: "Hash check", kind: "sync" },
        { key: "parse", label: "Parse", kind: "sync", detailHint: "structured" },
        ...classify,
        upsert,
        ...TAIL_GITHUB,
      ];
    case "feed":
    case "video": {
      const isVideo = strategy === "video";
      return [
        { key: "poll", label: "Poll", kind: "sync", detailHint: isVideo ? "feed" : "etag" },
        {
          key: "fetch",
          label: "Fetch",
          kind: "sync",
          detailHint: isVideo ? "YouTube" : "RSS/Atom/JSON",
        },
        { key: "hash", label: "Hash check", kind: "sync" },
        { key: "parse", label: "Parse", kind: "sync", detailHint: isVideo ? "video feed" : "feed" },
        ...(!isVideo && enrich
          ? [
              {
                key: "enrich",
                label: "Feed enrich",
                kind: "ai",
                detailHint: "article extract",
              } as WorkflowStage,
            ]
          : []),
        ...(!isVideo ? classify : []),
        upsert,
        ...TAIL_COMMON,
      ];
    }
    case "scrape":
    case "crawl": {
      const isCrawl = strategy === "crawl";
      return [
        { key: "poll", label: "Poll", kind: "sync", detailHint: "detector" },
        {
          key: "fetch",
          label: isCrawl ? "Crawl" : "Fetch",
          kind: "sync",
          detailHint: isCrawl ? "multi-page /crawl" : "Browser Rendering",
        },
        { key: "hash", label: "Hash check", kind: "sync" },
        { key: "extract", label: "Extract", kind: "ai", detailHint: "one-shot / tool-loop" },
        ...classify,
        upsert,
        ...TAIL_COMMON,
      ];
    }
    case "appstore":
      return [
        { key: "poll", label: "Poll", kind: "sync", detailHint: "iTunes lookup" },
        { key: "fetch", label: "Fetch", kind: "sync", detailHint: "iTunes API" },
        { key: "hash", label: "Hash check", kind: "sync" },
        { key: "parse", label: "Parse", kind: "sync", detailHint: "materialize" },
        upsert,
        ...TAIL_COMMON,
      ];
    case "agent":
      return [
        { key: "poll", label: "Trigger", kind: "sync", detailHint: "sweep / scheduled" },
        { key: "agent-session", label: "Agent session", kind: "ai", detailHint: "managed worker" },
        { key: "parse", label: "Parse records", kind: "ai", detailHint: "Sonnet" },
        ...classify,
        upsert,
        ...TAIL_COMMON,
      ];
    case "firecrawl":
      return [
        { key: "webhook", label: "Webhook", kind: "sync", detailHint: "monitor.page" },
        { key: "diff", label: "Diff parse", kind: "sync", detailHint: "addedContentFromDiff" },
        { key: "extract", label: "Extract", kind: "ai", detailHint: "Haiku · diff/re-scrape" },
        ...classify,
        upsert,
        ...TAIL_COMMON,
      ];
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd packages/adapters && bun test workflow-stages.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit` (from worktree root)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/workflow-stages.ts packages/adapters/src/workflow-stages.test.ts
git commit -m "feat(adapters): describeWorkflowStages adaptive pipeline topology"
```

---

## Task 2: `GET /status/source-workflow` endpoint

**Files:**

- Modify: `workers/api/src/routes/status.ts`
- Test: `workers/api/test/source-workflow-route.test.ts`

- [ ] **Step 1: Write the failing route test** (uses the verified harness from `workers/api/test/fetch-plan-route.test.ts`: `mkDb()` + `applyMigrations` + `ensureBatchShim`, statusRoutes mounted under `/v1`, full request URLs)

```ts
// workers/api/test/source-workflow-route.test.ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources, fetchLog, usageLog } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../src/db.js";

const { Hono } = await import("hono");
const { statusRoutes } = await import("../src/routes/status.js");

function mkDb(): D1Db {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb) as unknown as D1Db;
}

function mkApp(db: D1Db) {
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", statusRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, { DB: db } as never);
}

async function seed(db: D1Db) {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await db.insert(sources).values({
    id: "src_blog",
    orgId: "org_a",
    slug: "blog",
    name: "Blog",
    url: "https://acme.test",
    type: "scrape",
    fetchPriority: "normal",
    metadata: JSON.stringify({ marketingFilter: true }),
  });
  const t0 = new Date(Date.now() - 60_000).toISOString();
  await db.insert(fetchLog).values([
    {
      id: "fl_1",
      sourceId: "src_blog",
      releasesFound: 3,
      releasesInserted: 2,
      durationMs: 2400,
      status: "success",
      createdAt: t0,
    },
    {
      id: "fl_0",
      sourceId: "src_blog",
      releasesFound: 0,
      releasesInserted: 0,
      durationMs: 100,
      status: "no_change",
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    },
  ]);
  await db.insert(usageLog).values({
    operation: "extract",
    model: "x",
    inputTokens: 10,
    outputTokens: 5,
    sourceId: "src_blog",
    createdAt: t0,
  });
}

describe("GET /v1/status/source-workflow", () => {
  it("returns adaptive stages + derived lastRun/sparkline/aiPasses", async () => {
    const db = mkDb();
    await seed(db);
    const res = await mkApp(db)(
      new Request("https://x.test/v1/status/source-workflow?sourceId=src_blog"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stages: { key: string }[];
      lastRun: { status: string; releasesInserted: number };
      sparkline: string[];
      aiPasses: { operation: string }[];
    };
    expect(body.stages.map((s) => s.key)).toEqual([
      "poll",
      "fetch",
      "hash",
      "extract",
      "classify",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
    expect(body.lastRun.status).toBe("success");
    expect(body.lastRun.releasesInserted).toBe(2);
    expect(body.sparkline).toEqual(["no_change", "success"]); // oldest→newest
    expect(body.aiPasses.some((p) => p.operation === "extract")).toBe(true);
  });

  it("400 without sourceId, 404 for unknown id", async () => {
    const db = mkDb();
    await seed(db);
    const app = mkApp(db);
    expect((await app(new Request("https://x.test/v1/status/source-workflow"))).status).toBe(400);
    expect(
      (await app(new Request("https://x.test/v1/status/source-workflow?sourceId=nope"))).status,
    ).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd workers/api && bun test test/source-workflow-route.test.ts`
Expected: FAIL — 404 on the first case (route not defined yet).

- [ ] **Step 3: Add the import + handler to `status.ts`**

Add to the existing adapter import block (top of file):

```ts
import {
  describeFetchPlan,
  computeFetchState,
  computeSweepHealth,
} from "@releases/adapters/fetch-plan";
import { describeWorkflowStages } from "@releases/adapters/workflow-stages";
```

Add these consts after `const FETCH_LOG_SORT_FIELDS = …`:

```ts
// Window for correlating usage_log rows to a fetch run (usage_log has no
// fetchLogId — only sourceId + createdAt). Tunable; resolves spec open-item #2.
const AI_PASS_WINDOW_MS = 5 * 60_000;
const SPARKLINE_N = 10;
```

Add the handler (e.g. right after the `/status/fetch-plan` handler). All operators (`and, eq, isNull, desc, gte, lte, sql`) and tables (`sources, fetchLog, usageLog`) are already imported in this file:

```ts
// Dev-only: per-source ingestion-pipeline topology + derived run state for the
// Fetch Log workflow drawer. Same /api/proxy + dev-gating as /status/fetch-plan;
// not part of the published api-types wire protocol.
statusRoutes.get("/status/source-workflow", async (c) => {
  const db = createDb(c.env.DB);
  const sourceId = c.req.query("sourceId");
  if (!sourceId) return c.json({ error: "missing_sourceId" }, 400);

  const [source] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
    .limit(1);
  if (!source) return c.json({ error: "not_found" }, 404);

  const now = new Date();
  const plan = describeFetchPlan(source);
  const state = computeFetchState(source, plan, now);
  const sweep = computeSweepHealth(source, plan, now);
  const stages = describeWorkflowStages(source);

  const recent = await db
    .select({
      status: fetchLog.status,
      releasesFound: fetchLog.releasesFound,
      releasesInserted: fetchLog.releasesInserted,
      durationMs: fetchLog.durationMs,
      error: fetchLog.error,
      createdAt: fetchLog.createdAt,
    })
    .from(fetchLog)
    .where(eq(fetchLog.sourceId, sourceId))
    .orderBy(desc(fetchLog.createdAt), desc(fetchLog.id))
    .limit(SPARKLINE_N);
  const lastRun = recent[0] ?? null;
  const sparkline = recent.map((r) => r.status).reverse(); // oldest→newest

  let aiPasses: {
    operation: string;
    count: number;
    inputTokens: number;
    outputTokens: number;
  }[] = [];
  if (lastRun) {
    const lo = new Date(Date.parse(lastRun.createdAt) - AI_PASS_WINDOW_MS).toISOString();
    const hi = new Date(Date.parse(lastRun.createdAt) + AI_PASS_WINDOW_MS).toISOString();
    const rows = await db
      .select({
        operation: usageLog.operation,
        count: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${usageLog.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${usageLog.outputTokens}), 0)`,
      })
      .from(usageLog)
      .where(
        and(
          eq(usageLog.sourceId, sourceId),
          gte(usageLog.createdAt, lo),
          lte(usageLog.createdAt, hi),
        ),
      )
      .groupBy(usageLog.operation);
    aiPasses = rows.map((r) => ({
      operation: r.operation,
      count: Number(r.count),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
    }));
  }

  return c.json({
    source: {
      id: source.id,
      slug: source.slug,
      name: source.name,
      type: source.type,
      strategyLabel: plan.strategyLabel,
    },
    plan,
    state,
    sweep,
    stages,
    lastRun,
    aiPasses,
    sparkline,
  });
});
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd workers/api && bun test test/source-workflow-route.test.ts`
Expected: PASS (2 tests). If `db = createTestDb()` mismatches the helper's return shape, mirror `fetch-plan-route.test.ts` exactly (it's the canonical sibling).

- [ ] **Step 5: Worker typecheck**

Run: `cd workers/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/status.ts workers/api/test/source-workflow-route.test.ts
git commit -m "feat(api): dev /status/source-workflow endpoint (derived run state)"
```

---

## Task 3: Client hook `use-source-workflow.ts`

**Files:**

- Create: `web/src/components/use-source-workflow.ts`

- [ ] **Step 1: Create the hook + local wire types**

```ts
// web/src/components/use-source-workflow.ts
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FetchStrategy } from "./use-fetch-plan";

// Dev-only endpoint — types kept local (not in api-types), hand-synced with
// workers/api/src/routes/status.ts and @releases/adapters/workflow-stages.
export type StageKind = "sync" | "ai" | "async";
export interface WorkflowStage {
  key: string;
  label: string;
  kind: StageKind;
  detailHint?: string;
}
export type RunStatus = "success" | "error" | "no_change" | "dry_run";
export interface LastRun {
  status: RunStatus;
  releasesFound: number;
  releasesInserted: number;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}
export interface AiPass {
  operation: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
}
export interface SourceWorkflow {
  source: { id: string; slug: string; name: string; type: string; strategyLabel: string };
  plan: {
    strategy: FetchStrategy;
    strategyLabel: string;
    intervalLabel: string;
    cadence: "poll" | "firecrawl-webhook";
    paused: boolean;
  };
  state: {
    nextDueAt: string | null;
    backedOff: boolean;
    paused: boolean;
    lastPolledAt: string | null;
  };
  sweep: { sweepDriven: boolean; starved: boolean; staleHours: number | null };
  stages: WorkflowStage[];
  lastRun: LastRun | null;
  aiPasses: AiPass[];
  sparkline: RunStatus[];
}

export function useSourceWorkflow(sourceId: string | null) {
  const [data, setData] = useState<SourceWorkflow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const refresh = useCallback(async () => {
    if (!sourceId) {
      setData(null);
      setError(null);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/proxy/status/source-workflow?sourceId=${encodeURIComponent(sourceId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as SourceWorkflow;
      if (reqId.current === id) setData(body);
    } catch (e) {
      if (reqId.current === id) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reqId.current === id) setLoading(false);
    }
  }, [sourceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, loading, error, refresh };
}
```

- [ ] **Step 2: Typecheck web**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/use-source-workflow.ts
git commit -m "feat(web): useSourceWorkflow hook"
```

---

## Task 4: Pipeline derivation logic (pure) + tests

**Files:**

- Create: `web/src/components/workflow-pipeline-logic.ts`
- Test: `web/src/components/workflow-pipeline-logic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/components/workflow-pipeline-logic.test.ts
import { describe, it, expect } from "bun:test";
import { operationToStageKey, derivePipelineView } from "./workflow-pipeline-logic";
import type { WorkflowStage, LastRun, AiPass } from "./use-source-workflow";

describe("operationToStageKey", () => {
  it("maps known labels, checking enrich before extract", () => {
    expect(operationToStageKey("summarize")).toBe("summarize");
    expect(operationToStageKey("compare")).toBe("summarize");
    expect(operationToStageKey("enrich-extract")).toBe("enrich"); // not "extract"
    expect(operationToStageKey("firecrawl-extract")).toBe("extract");
    expect(operationToStageKey("extract-toolloop")).toBe("extract");
    expect(operationToStageKey("agent-ingest")).toBe("agent-session");
    expect(operationToStageKey("totally-unknown")).toBeNull();
  });
});

describe("derivePipelineView", () => {
  const stages: WorkflowStage[] = [
    { key: "poll", label: "Poll", kind: "sync" },
    { key: "hash", label: "Hash check", kind: "sync" },
    { key: "extract", label: "Extract", kind: "ai" },
    { key: "upsert", label: "Upsert", kind: "sync" },
    { key: "embed", label: "Embed", kind: "async" },
  ];
  const lastRun: LastRun = {
    status: "success",
    releasesFound: 3,
    releasesInserted: 2,
    durationMs: 2400,
    error: null,
    createdAt: "2026-05-31T00:00:00Z",
  };
  const aiPasses: AiPass[] = [
    { operation: "firecrawl-extract", count: 1, inputTokens: 9, outputTokens: 4 },
  ];

  it("splits content vs async and derives outcomes", () => {
    const v = derivePipelineView(stages, lastRun, aiPasses);
    expect(v.content.map((s) => s.key)).toEqual(["poll", "hash", "extract", "upsert"]);
    expect(v.async.map((s) => s.key)).toEqual(["embed"]);
    expect(v.content.find((s) => s.key === "upsert")!.outcome).toBe("found 3 · +2");
    expect(v.content.find((s) => s.key === "extract")!.dot).toBe("ok"); // usage matched
    expect(v.async.find((s) => s.key === "embed")!.dot).toBe("async");
  });

  it("no_change run marks hash unchanged + neutral dots", () => {
    const nc: LastRun = { ...lastRun, status: "no_change", releasesFound: 0, releasesInserted: 0 };
    const v = derivePipelineView(stages, nc, []);
    expect(v.content.find((s) => s.key === "hash")!.outcome).toBe("unchanged");
    expect(v.content.find((s) => s.key === "poll")!.dot).toBe("neutral");
  });

  it("null lastRun → all neutral, outcomes —", () => {
    const v = derivePipelineView(stages, null, []);
    expect(v.content.every((s) => s.dot === "neutral" || s.dot === "async")).toBe(true);
    expect(v.content.find((s) => s.key === "upsert")!.outcome).toBe("—");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd web && bun test src/components/workflow-pipeline-logic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the logic module**

```ts
// web/src/components/workflow-pipeline-logic.ts
import type { WorkflowStage, LastRun, AiPass, RunStatus } from "./use-source-workflow";

export type Dot = "ok" | "err" | "neutral" | "async";

export interface StageView extends WorkflowStage {
  dot: Dot;
  detail: string; // sub-label under the name
  outcome: string; // right-aligned outcome/counts
}
export interface PipelineView {
  content: StageView[];
  async: StageView[];
}

/** Map a free-form usage_log operation label to a stage key. Order matters:
 *  enrich is checked before extract because "enrich-extract" contains "extract". */
export function operationToStageKey(op: string): string | null {
  const o = op.toLowerCase();
  if (o.includes("summarize") || o === "compare") return "summarize";
  if (o.includes("enrich")) return "enrich";
  if (o.includes("agent")) return "agent-session";
  if (o.includes("extract")) return "extract";
  if (o.includes("classify")) return "classify";
  return null;
}

function dotForRun(status: RunStatus | undefined): Dot {
  if (status === "success") return "ok";
  if (status === "error") return "err";
  return "neutral"; // no_change | dry_run | undefined
}

export function derivePipelineView(
  stages: WorkflowStage[],
  lastRun: LastRun | null,
  aiPasses: AiPass[],
): PipelineView {
  const ran = new Map<string, AiPass>();
  for (const p of aiPasses) {
    const k = operationToStageKey(p.operation);
    if (k) ran.set(k, p);
  }
  const noChange = lastRun?.status === "no_change";

  const view: StageView[] = stages.map((s) => {
    const detail = s.detailHint ?? "";
    if (s.kind === "async") {
      // Embed/changelog/publish have no per-run D1 record; show best-effort.
      const ai = ran.get(s.key);
      if (ai)
        return {
          ...s,
          dot: "ok",
          detail,
          outcome: `${ai.count}× · ${ai.inputTokens + ai.outputTokens} tok`,
        };
      return { ...s, dot: lastRun ? "async" : "neutral", detail, outcome: lastRun ? "fired" : "—" };
    }
    if (s.key === "hash") {
      return {
        ...s,
        dot: dotForRun(lastRun?.status),
        detail,
        outcome: lastRun ? (noChange ? "unchanged" : "changed") : "—",
      };
    }
    if (s.key === "upsert") {
      return {
        ...s,
        dot: dotForRun(lastRun?.status),
        detail,
        outcome: lastRun ? `found ${lastRun.releasesFound} · +${lastRun.releasesInserted}` : "—",
      };
    }
    if (s.kind === "ai") {
      const ai = ran.get(s.key);
      if (ai)
        return {
          ...s,
          dot: "ok",
          detail,
          outcome: `${ai.count}× · ${ai.inputTokens + ai.outputTokens} tok`,
        };
      // classify has no usage_log label — show it as configured, not "ran".
      return {
        ...s,
        dot: "neutral",
        detail,
        outcome: lastRun ? (s.key === "classify" ? "configured" : "ran") : "—",
      };
    }
    // remaining sync nodes: poll/webhook/fetch/crawl/parse/diff
    return {
      ...s,
      dot: dotForRun(lastRun?.status),
      detail,
      outcome: lastRun ? (s.key === "fetch" ? "✓" : "") : "—",
    };
  });

  return {
    content: view.filter((v) => v.kind !== "async"),
    async: view.filter((v) => v.kind === "async"),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd web && bun test src/components/workflow-pipeline-logic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/workflow-pipeline-logic.ts web/src/components/workflow-pipeline-logic.test.ts
git commit -m "feat(web): pure pipeline-view derivation + tests"
```

---

## Task 5: Presentational `workflow-pipeline.tsx`

**Files:**

- Create: `web/src/components/workflow-pipeline.tsx`

- [ ] **Step 1: Create the component**

```tsx
// web/src/components/workflow-pipeline.tsx
"use client";
import { useState } from "react";
import { derivePipelineView, type Dot } from "./workflow-pipeline-logic";
import type { WorkflowStage, LastRun, AiPass } from "./use-source-workflow";

const DOT: Record<Dot, string> = {
  ok: "border-emerald-400 bg-emerald-500/30",
  err: "border-red-400 bg-red-500/30",
  neutral: "border-stone-500 bg-transparent",
  async: "border-amber-400 bg-amber-500/30",
};

function Step({
  s,
  last,
}: {
  s: ReturnType<typeof derivePipelineView>["content"][number];
  last: boolean;
}) {
  return (
    <div className="grid grid-cols-[14px_1fr_auto] gap-2.5 items-start relative py-1.5">
      <span className={`mt-0.5 h-2.5 w-2.5 rounded-full border-2 ${DOT[s.dot]}`} />
      {!last && (
        <span className="absolute left-[6px] top-5 bottom-[-6px] w-px bg-stone-200 dark:bg-stone-700" />
      )}
      <span>
        <span className="text-stone-900 dark:text-stone-100">{s.label}</span>
        {s.detail && <span className="block text-[10px] text-stone-400">{s.detail}</span>}
      </span>
      <span className="text-[10px] text-stone-500 text-right whitespace-nowrap">{s.outcome}</span>
    </div>
  );
}

export function WorkflowPipeline({
  stages,
  lastRun,
  aiPasses,
}: {
  stages: WorkflowStage[];
  lastRun: LastRun | null;
  aiPasses: AiPass[];
}) {
  const [open, setOpen] = useState(false);
  const { content, async: tail } = derivePipelineView(stages, lastRun, aiPasses);

  return (
    <div className="font-mono text-xs">
      {content.map((s, i) => (
        <Step key={s.key} s={s} last={i === content.length - 1 && !tail.length && !open} />
      ))}
      {tail.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1 flex items-center gap-2 text-[11px] text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
          >
            <span className="h-2.5 w-2.5 rounded-full border-2 border-amber-400 bg-amber-500/30" />
            {open ? "post-commit" : `+ post-commit (${tail.length})`} {open ? "▾" : "▸"}
          </button>
          {open && (
            <div className="mt-1.5">
              {tail.map((s, i) => (
                <Step key={s.key} s={s} last={i === tail.length - 1} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck web**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/workflow-pipeline.tsx
git commit -m "feat(web): WorkflowPipeline presentational component"
```

---

## Task 6: `source-workflow-drawer.tsx`

**Files:**

- Create: `web/src/components/source-workflow-drawer.tsx`

- [ ] **Step 1: Create the drawer**

```tsx
// web/src/components/source-workflow-drawer.tsx
"use client";
import { useEffect } from "react";
import { useSourceWorkflow, type RunStatus } from "./use-source-workflow";
import { WorkflowPipeline } from "./workflow-pipeline";

const SPARK: Record<RunStatus, string> = {
  success: "bg-emerald-500",
  error: "bg-red-500",
  no_change: "bg-stone-400",
  dry_run: "bg-sky-500",
};

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.parse(iso) - Date.now();
  const past = diff < 0;
  const m = Math.round(Math.abs(diff) / 60_000);
  const l = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return past ? `${l} ago` : `in ${l}`;
}

export function SourceWorkflowDrawer({
  sourceId,
  onClose,
}: {
  sourceId: string | null;
  onClose: () => void;
}) {
  const { data, loading, error, refresh } = useSourceWorkflow(sourceId);

  useEffect(() => {
    if (!sourceId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sourceId, onClose]);

  if (!sourceId) return null;
  const statePill = data?.state.paused
    ? "paused"
    : data?.sweep.starved
      ? "starved"
      : data?.state.backedOff
        ? "backed off"
        : "scheduled";

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 w-[420px] max-w-[90vw] bg-white dark:bg-stone-950 border-l border-stone-200 dark:border-stone-800 shadow-xl overflow-y-auto p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="font-mono text-sm text-stone-900 dark:text-stone-100">
              {data?.source.name ?? "…"}
            </h2>
            {data && (
              <div className="mt-1 flex items-center gap-2 text-[10px]">
                <span className="px-1.5 py-0.5 rounded-full border border-stone-300 dark:border-stone-700 text-stone-500">
                  {data.source.strategyLabel}
                </span>
                <span className="px-1.5 py-0.5 rounded-full border border-emerald-400 text-emerald-600 dark:text-emerald-300">
                  {statePill}
                </span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {loading && !data && <div className="text-xs text-stone-400 py-6">Loading workflow…</div>}
        {error && <div className="text-xs text-red-500 py-6">Failed to load: {error}</div>}

        {data && (
          <>
            <div className="grid grid-cols-2 gap-3 mb-4 text-[11px] font-mono">
              <div>
                <div className="text-[9px] uppercase tracking-wide text-stone-400">Next due</div>
                {data.plan.cadence === "firecrawl-webhook"
                  ? "webhook"
                  : `${relTime(data.state.nextDueAt)} · ${data.plan.intervalLabel}`}
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wide text-stone-400">Last run</div>
                {data.lastRun
                  ? `${relTime(data.lastRun.createdAt)} · ${data.lastRun.status}`
                  : "never"}
              </div>
              <div className="col-span-2">
                <div className="text-[9px] uppercase tracking-wide text-stone-400 mb-1">
                  Last {data.sparkline.length} runs
                </div>
                <div className="flex items-end gap-0.5 h-5">
                  {data.sparkline.map((s, i) => (
                    <span
                      key={i}
                      className={`w-1.5 rounded-sm ${SPARK[s]}`}
                      style={{ height: s === "no_change" ? "30%" : "80%" }}
                      title={s}
                    />
                  ))}
                </div>
              </div>
            </div>
            <WorkflowPipeline
              stages={data.stages}
              lastRun={data.lastRun}
              aiPasses={data.aiPasses}
            />
            <button
              type="button"
              onClick={() => void refresh()}
              className="mt-4 text-[11px] text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
            >
              ↻ Refresh
            </button>
          </>
        )}
      </aside>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck web**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/source-workflow-drawer.tsx
git commit -m "feat(web): SourceWorkflowDrawer container"
```

---

## Task 7: Wire into the view + clickable rows

**Files:**

- Modify: `web/src/components/org-fetch-plan-panel.tsx`
- Modify: `web/src/components/org-fetch-log-view.tsx`

- [ ] **Step 1: Add `onSelectSource` to the panel + make the name cell a trigger**

In `org-fetch-plan-panel.tsx`, thread an optional callback through both components. Change the `OrgFetchPlanPanel` signature and the `PlanRowItem` signature to accept `onSelectSource?: (id: string) => void`, pass it from panel → row, and replace the source-name `<a>` with a button (keep the `<a>` link removed — the drawer is the new primary action; a source still has its own page via the table elsewhere). Concretely, in `PlanRowItem`'s first cell:

```tsx
<div className="text-stone-900 dark:text-stone-100">
  <button
    type="button"
    onClick={() => onSelectSource?.(row.id)}
    className="text-left hover:underline"
  >
    {row.name}
  </button>
  {row.sweep.starved && <StarvedBadge staleHours={row.sweep.staleHours} />}
  {err && <div className="text-[10px] font-sans text-red-500 mt-0.5">{err}</div>}
</div>
```

Do NOT make the whole row clickable — the row's other cells contain the priority `<select>` and the Firecrawl `<button>`, which must keep working independently. In `OrgFetchPlanPanel`, add the prop and forward it:

```tsx
export function OrgFetchPlanPanel({
  orgSlug,
  onSelectSource,
}: {
  orgSlug: string;
  onSelectSource?: (id: string) => void;
}) {
  // …unchanged…
  {
    rows.map((row) => (
      <PlanRowItem
        key={row.id}
        row={row}
        orgSlug={orgSlug}
        now={now}
        onChanged={refetch}
        onSelectSource={onSelectSource}
      />
    ));
  }
}
```

And add `onSelectSource` to `PlanRowItem`'s prop type + destructure.

- [ ] **Step 2: Own the selected-source state + render the drawer in `org-fetch-log-view.tsx`**

```tsx
// add imports
import { SourceWorkflowDrawer } from "./source-workflow-drawer";
// add state inside OrgFetchLogView
const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
// pass to the panel
<OrgFetchPlanPanel orgSlug={orgSlug} onSelectSource={setSelectedSourceId} />
// render the drawer after {logBody}
<SourceWorkflowDrawer sourceId={selectedSourceId} onClose={() => setSelectedSourceId(null)} />
```

- [ ] **Step 3: Typecheck + lint web**

Run: `cd web && npx tsc --noEmit && cd .. && bun run lint`
Expected: no errors.

- [ ] **Step 4: Manual dev verification**

Run `bun run dev:web` + `bun run dev:api`. Open `https://<...>.releases.localhost/<orgSlug>/fetch-log` (dev only). Verify:

- Clicking a source name opens the drawer; the priority `<select>` and "Enable/Disable FC" button still work without opening it.
- A github source shows the `changelog` node; a feed source with `summary-only` shows `enrich`; a scrape source shows `extract` and no changelog; appstore/agent/firecrawl render their distinct shapes.
- Esc, the × button, and the overlay all close the drawer; ↻ Refresh re-fetches.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/org-fetch-plan-panel.tsx web/src/components/org-fetch-log-view.tsx
git commit -m "feat(web): open source workflow drawer from Fetch Plan rows"
```

---

## Task 8: Docs + final gate

**Files:**

- Modify: `docs/architecture/web.md`

- [ ] **Step 1: Add a one-line pointer** under the Fetch Log section of `docs/architecture/web.md`:

```markdown
- **Fetch Log workflow drawer** (dev-only): clicking a Fetch Plan row opens a per-source ingestion-pipeline drawer (adaptive stages via `describeWorkflowStages`, derived run state from `GET /status/source-workflow`). Spec: `docs/superpowers/specs/2026-05-31-per-source-workflow-viz-design.md`.
```

- [ ] **Step 2: Run the full gate** (from worktree root)

Run:

```bash
npx tsc --noEmit
cd workers/api && npx tsc --noEmit && cd ../..
cd web && npx tsc --noEmit && cd ..
bun test
cd workers/api && bun test && cd ../..
bun run lint
bun run format:check
```

Expected: all pass. (If `format:check` flags the new files, run `bun run format` and amend.)

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/web.md
git commit -m "docs(web): note the dev Fetch Log workflow drawer"
```

- [ ] **Step 4 (optional): Simplify pass.** Run `/simplify` on the branch and apply high/medium fixes so they land in the PR diff.

---

## Testing Strategy

1. **Unit (correctness-critical):** `workflow-stages.test.ts` asserts the exact ordered stage keys per strategy + flag combination.
2. **Unit (derivation):** `workflow-pipeline-logic.test.ts` covers the op→stage precedence (enrich-before-extract), content/async split, and the no_change / null-lastRun branches.
3. **Worker route:** `source-workflow-route.test.ts` exercises the endpoint against a real bun-sqlite DB — adaptive stages, derived `lastRun`/`sparkline`/`aiPasses`, plus 400/404.
4. **Manual dev:** the per-strategy walkthrough in Task 7, Step 4.

## Self-Review (done by plan author)

- **Spec coverage:** Blend topology+status ✔ (Tasks 1,4,5); side-drawer placement ✔ (Tasks 6,7); full pipeline + collapsed async tail ✔ (Task 5 expander); adaptive per source type ✔ (Task 1); Phase-1 derived fidelity ✔ (Tasks 2,4); custom vertical render, no dep ✔ (Task 5). Phase-2 instrumentation intentionally out of scope (documented in spec).
- **Corrections folded in:** real `usage_log` labels (no `classify` label → "configured"); `enrich-extract`/`extract` precedence; `createDb` passthrough for tests; `enrich_feed`→`enrich-extract` naming fix from the spec draft.
- **Type consistency:** `WorkflowStage`/`StageKind` defined in Task 1 (adapter) and re-declared in the hook (Task 3) intentionally (dev-only, not shared via api-types); `derivePipelineView`/`operationToStageKey` (Task 4) consumed unchanged by Task 5; `useSourceWorkflow` shape (Task 3) consumed by Tasks 5,6.
- **No placeholders.**

## Phase 2 (not in this plan)

Per-stage instrumentation for a true waterfall: a `fetch_log_stages` table (or `stages` JSON column on `fetch_log`) written from the `poll-and-fetch` workflow's `step.do` boundaries; `WorkflowPipeline` upgrades from outcome-dots to per-stage durations when stage rows exist, falling back to Phase 1 otherwise. Requires a paired migration (schema-gate); mind D1's 100-bind limit on batched stage inserts. See the spec's Phase 2 section.
