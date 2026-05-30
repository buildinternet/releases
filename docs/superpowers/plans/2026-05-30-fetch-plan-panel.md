# Fetch-strategy & interval panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each source's fetch strategy, interval, and live timing state at the top of the org Fetch Log tab, with inline controls to change fetch priority/interval and toggle Firecrawl.

**Architecture:** A pure resolver in `packages/adapters` (`describeFetchPlan` + `computeFetchState`) is the single source of truth for strategy/interval, reused by the poll cron (which currently owns `TIER_INTERVALS`). A dev-only worker endpoint `GET /v1/status/fetch-plan?org=` resolves each org source server-side and returns ready-to-render rows. The web Fetch Log tab fetches it through the existing flag-gated `/api/proxy` and renders a summary panel; edit controls call admin server actions that reuse the existing source PATCH and the Firecrawl sync route.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Workers + Hono, Drizzle/D1, Next.js (React client components + server actions), Tailwind.

**Spec:** `docs/superpowers/specs/2026-05-30-fetch-plan-panel-design.md`

---

## File structure

**New**

- `packages/adapters/src/fetch-plan.ts` — pure resolver: `TIER_INTERVALS`, `FIRECRAWL_DEFAULT_SCHEDULE`, `FetchStrategy`, `FetchPlan`, `FetchState`, `describeFetchPlan`, `computeFetchState`.
- `packages/adapters/src/fetch-plan.test.ts` — unit tests for the resolver.
- `workers/api/test/fetch-plan-route.test.ts` — in-process route test for `/status/fetch-plan`.
- `web/src/components/use-fetch-plan.ts` — client hook + local wire types (mirrors the `/status/*` dev-endpoint pattern; not part of published api-types).
- `web/src/components/org-fetch-plan-panel.tsx` — the summary table + inline edit controls.

**Modified**

- `packages/adapters/package.json` — add `"./fetch-plan": "./src/fetch-plan.ts"` subpath export.
- `workers/api/src/cron/poll-fetch.ts` — import `TIER_INTERVALS` from `@releases/adapters/fetch-plan` instead of the local const.
- `workers/api/src/routes/status.ts` — add `GET /status/fetch-plan`.
- `web/src/app/actions/source-admin.ts` — add `setFetchPriorityAction` + `syncFirecrawlAction`.
- `web/src/components/org-fetch-log-view.tsx` — always render the panel above the log body.

---

## Task 0: Ensure the worktree has dependencies

A linked worktree needs its own `node_modules` for the new adapters subpath export to resolve in tests.

- [ ] **Step 1: Install deps in the worktree**

Run from the worktree root:

```bash
bun install
```

Expected: completes without error (may be a no-op if already hoisted).

---

## Task 1: Pure resolver in `packages/adapters`

**Files:**

- Create: `packages/adapters/src/fetch-plan.ts`
- Create: `packages/adapters/src/fetch-plan.test.ts`
- Modify: `packages/adapters/package.json`

- [ ] **Step 1: Add the subpath export**

In `packages/adapters/package.json`, add to the `"exports"` map (alongside `"./source-meta"`):

```json
    "./fetch-plan": "./src/fetch-plan.ts",
```

- [ ] **Step 2: Write the failing tests**

Create `packages/adapters/src/fetch-plan.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import type { Source } from "@buildinternet/releases-core/schema";
import {
  describeFetchPlan,
  computeFetchState,
  TIER_INTERVALS,
  FIRECRAWL_DEFAULT_SCHEDULE,
} from "./fetch-plan.js";

// Build a Source row with sane defaults; override per test.
function mkSource(over: Partial<Source> & { metadata?: Record<string, unknown> | null }): Source {
  const { metadata, ...rest } = over;
  return {
    id: "src_x",
    orgId: "org_x",
    productId: null,
    slug: "x",
    name: "X",
    url: "https://x.test",
    type: "scrape",
    kind: null,
    discovery: "curated",
    metadata: metadata === undefined ? null : metadata === null ? null : JSON.stringify(metadata),
    fetchPriority: "normal",
    isHidden: false,
    consecutiveNoChange: 0,
    consecutiveErrors: 0,
    nextFetchAfter: null,
    changeDetectedAt: null,
    lastPolledAt: null,
    lastFetchedAt: null,
    medianGapDays: null,
    lastRetieredAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Source;
}

describe("describeFetchPlan — strategy", () => {
  it("github type → GitHub API", () => {
    expect(describeFetchPlan(mkSource({ type: "github" })).strategy).toBe("github");
    expect(describeFetchPlan(mkSource({ type: "github" })).strategyLabel).toBe("GitHub API");
  });

  it("scrape with githubUrl override → github", () => {
    const s = mkSource({ type: "scrape", metadata: { githubUrl: "https://github.com/a/b" } });
    expect(describeFetchPlan(s).strategy).toBe("github");
  });

  it("appstore type → App Store", () => {
    expect(describeFetchPlan(mkSource({ type: "appstore" })).strategyLabel).toBe("App Store");
  });

  it("video type → Video feed", () => {
    expect(describeFetchPlan(mkSource({ type: "video" })).strategyLabel).toBe("Video feed");
  });

  it("feedUrl present → feed label refines by feedType", () => {
    expect(
      describeFetchPlan(mkSource({ type: "feed", metadata: { feedUrl: "u", feedType: "rss" } }))
        .strategyLabel,
    ).toBe("RSS feed");
    expect(
      describeFetchPlan(mkSource({ type: "feed", metadata: { feedUrl: "u", feedType: "atom" } }))
        .strategyLabel,
    ).toBe("Atom feed");
    expect(
      describeFetchPlan(
        mkSource({ type: "feed", metadata: { feedUrl: "u", feedType: "jsonfeed" } }),
      ).strategyLabel,
    ).toBe("JSON Feed");
  });

  it("scrape with crawlEnabled → Multi-page crawl", () => {
    expect(
      describeFetchPlan(mkSource({ type: "scrape", metadata: { crawlEnabled: true } }))
        .strategyLabel,
    ).toBe("Multi-page crawl");
  });

  it("agent type with no feed → Agent extraction", () => {
    expect(describeFetchPlan(mkSource({ type: "agent" })).strategyLabel).toBe("Agent extraction");
  });

  it("plain scrape → Browser scrape", () => {
    expect(describeFetchPlan(mkSource({ type: "scrape" })).strategyLabel).toBe("Browser scrape");
  });

  it("firecrawl.enabled wins over type and uses its schedule + webhook cadence", () => {
    const s = mkSource({
      type: "scrape",
      metadata: { firecrawl: { enabled: true, schedule: "every 12 hours" } },
    });
    const plan = describeFetchPlan(s);
    expect(plan.strategy).toBe("firecrawl");
    expect(plan.cadence).toBe("firecrawl-webhook");
    expect(plan.intervalHours).toBeNull();
    expect(plan.intervalLabel).toBe("every 12 hours");
    expect(plan.firecrawlSchedule).toBe("every 12 hours");
  });

  it("firecrawl without an explicit schedule falls back to the default", () => {
    const s = mkSource({ type: "scrape", metadata: { firecrawl: { enabled: true } } });
    expect(describeFetchPlan(s).intervalLabel).toBe(FIRECRAWL_DEFAULT_SCHEDULE);
  });
});

describe("describeFetchPlan — interval", () => {
  it("normal → every 4 hours", () => {
    const plan = describeFetchPlan(mkSource({ fetchPriority: "normal" }));
    expect(plan.intervalHours).toBe(TIER_INTERVALS.normal);
    expect(plan.intervalLabel).toBe("every 4 hours");
  });

  it("low → every 24 hours", () => {
    const plan = describeFetchPlan(mkSource({ fetchPriority: "low" }));
    expect(plan.intervalHours).toBe(24);
    expect(plan.intervalLabel).toBe("every 24 hours");
  });

  it("paused → null interval, paused label, paused flag", () => {
    const plan = describeFetchPlan(mkSource({ fetchPriority: "paused" }));
    expect(plan.intervalHours).toBeNull();
    expect(plan.intervalLabel).toBe("paused");
    expect(plan.paused).toBe(true);
  });
});

describe("computeFetchState", () => {
  const now = new Date("2026-01-02T00:00:00.000Z");

  it("paused source has no next-due", () => {
    const s = mkSource({ fetchPriority: "paused", lastPolledAt: "2026-01-01T00:00:00.000Z" });
    const state = computeFetchState(s, describeFetchPlan(s), now);
    expect(state.nextDueAt).toBeNull();
    expect(state.paused).toBe(true);
  });

  it("firecrawl source has no local next-due", () => {
    const s = mkSource({ metadata: { firecrawl: { enabled: true } } });
    const state = computeFetchState(s, describeFetchPlan(s), now);
    expect(state.nextDueAt).toBeNull();
    expect(state.backedOff).toBe(false);
  });

  it("normal source next-due = lastPolledAt + 4h", () => {
    const s = mkSource({ fetchPriority: "normal", lastPolledAt: "2026-01-01T20:00:00.000Z" });
    const state = computeFetchState(s, describeFetchPlan(s), now);
    expect(state.nextDueAt).toBe("2026-01-02T00:00:00.000Z");
    expect(state.backedOff).toBe(false);
  });

  it("backoff (nextFetchAfter beyond the tier interval) sets backedOff and pushes next-due out", () => {
    const s = mkSource({
      fetchPriority: "normal",
      lastPolledAt: "2026-01-01T20:00:00.000Z", // tier-due at 2026-01-02T00:00
      nextFetchAfter: "2026-01-02T06:00:00.000Z", // backed off later
    });
    const state = computeFetchState(s, describeFetchPlan(s), now);
    expect(state.backedOff).toBe(true);
    expect(state.nextDueAt).toBe("2026-01-02T06:00:00.000Z");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:

```bash
bun test packages/adapters/src/fetch-plan.test.ts
```

Expected: FAIL — `Cannot find module './fetch-plan.js'` (file not yet created).

- [ ] **Step 4: Implement the resolver**

Create `packages/adapters/src/fetch-plan.ts`:

```ts
/**
 * Pure resolver describing HOW and HOW OFTEN a source is fetched. Single source
 * of truth for the poll cron's tier intervals (imported back into poll-fetch.ts)
 * and the dev-only fetch-plan endpoint. No I/O — operates on a Source row.
 */

import type { Source } from "@buildinternet/releases-core/schema";
import {
  getSourceMeta,
  isGitHubFetched,
  isAppStoreFetched,
  isVideoFetched,
  type SourceMetadata,
} from "./source-meta.js";

/** Hours between polls per fetch-priority tier. `paused` is never polled. */
export const TIER_INTERVALS = { normal: 4, low: 24 } as const;

/** Default Firecrawl monitor cadence when `metadata.firecrawl.schedule` is unset. */
export const FIRECRAWL_DEFAULT_SCHEDULE = "every 6 hours";

export type FetchStrategy =
  | "github"
  | "feed"
  | "appstore"
  | "video"
  | "crawl"
  | "scrape"
  | "agent"
  | "firecrawl";

export interface FetchPlan {
  strategy: FetchStrategy;
  strategyLabel: string;
  /** Base poll interval in hours; null for firecrawl (external cadence) and paused. */
  intervalHours: number | null;
  /** Human-readable cadence: "every 4 hours", a firecrawl schedule, or "paused". */
  intervalLabel: string;
  cadence: "poll" | "firecrawl-webhook";
  paused: boolean;
  /** Present only when strategy === "firecrawl". */
  firecrawlSchedule?: string;
}

export interface FetchState {
  lastPolledAt: string | null;
  /** ISO time the source is next eligible to poll; null for firecrawl & paused. */
  nextDueAt: string | null;
  /** True when smart-fetch backoff (nextFetchAfter) pushes the next poll past the tier interval. */
  backedOff: boolean;
  paused: boolean;
}

function resolveStrategy(source: Source, meta: SourceMetadata): FetchStrategy {
  // Precedence mirrors queryDueSources / the fetch dispatcher in poll-fetch.ts.
  if (isGitHubFetched(source, meta)) return "github";
  if (isAppStoreFetched(source)) return "appstore";
  if (isVideoFetched(source)) return "video";
  if (meta.feedUrl) return "feed";
  if (meta.crawlEnabled) return "crawl";
  if (source.type === "agent") return "agent";
  return "scrape";
}

function strategyLabel(strategy: FetchStrategy, meta: SourceMetadata): string {
  switch (strategy) {
    case "github":
      return "GitHub API";
    case "appstore":
      return "App Store";
    case "video":
      return "Video feed";
    case "feed":
      return meta.feedType === "atom"
        ? "Atom feed"
        : meta.feedType === "jsonfeed"
          ? "JSON Feed"
          : "RSS feed";
    case "crawl":
      return "Multi-page crawl";
    case "agent":
      return "Agent extraction";
    case "firecrawl":
      return "Firecrawl";
    case "scrape":
      return "Browser scrape";
  }
}

function tierHours(priority: Source["fetchPriority"]): number | null {
  if (priority === "normal") return TIER_INTERVALS.normal;
  if (priority === "low") return TIER_INTERVALS.low;
  return null; // paused
}

function formatInterval(hours: number): string {
  return `every ${hours} hours`;
}

export function describeFetchPlan(source: Source): FetchPlan {
  const meta = getSourceMeta(source);
  const paused = source.fetchPriority === "paused";

  // Firecrawl wins: these sources are excluded from the poll cron and run on
  // their own external schedule (ingested via the inbound webhook + workflow).
  if (meta.firecrawl?.enabled) {
    const schedule = meta.firecrawl.schedule ?? FIRECRAWL_DEFAULT_SCHEDULE;
    return {
      strategy: "firecrawl",
      strategyLabel: "Firecrawl",
      intervalHours: null,
      intervalLabel: schedule,
      cadence: "firecrawl-webhook",
      paused,
      firecrawlSchedule: schedule,
    };
  }

  const strategy = resolveStrategy(source, meta);
  const hours = paused ? null : tierHours(source.fetchPriority);
  return {
    strategy,
    strategyLabel: strategyLabel(strategy, meta),
    intervalHours: hours,
    intervalLabel: paused ? "paused" : hours == null ? "—" : formatInterval(hours),
    cadence: "poll",
    paused,
  };
}

export function computeFetchState(source: Source, plan: FetchPlan, now: Date): FetchState {
  const lastPolledAt = source.lastPolledAt ?? null;

  // No local cadence to project for firecrawl (webhook-driven) or paused sources.
  if (plan.paused || plan.cadence === "firecrawl-webhook" || plan.intervalHours == null) {
    return { lastPolledAt, nextDueAt: null, backedOff: false, paused: plan.paused };
  }

  const tierDueMs = lastPolledAt
    ? Date.parse(lastPolledAt) + plan.intervalHours * 3_600_000
    : now.getTime(); // never polled → due now
  const backoffMs = source.nextFetchAfter ? Date.parse(source.nextFetchAfter) : null;
  const backedOff = backoffMs != null && backoffMs > tierDueMs;
  const nextDueMs = backedOff ? backoffMs! : tierDueMs;

  return {
    lastPolledAt,
    nextDueAt: new Date(nextDueMs).toISOString(),
    backedOff,
    paused: false,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:

```bash
bun test packages/adapters/src/fetch-plan.test.ts
```

Expected: PASS — all describe blocks green.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/fetch-plan.ts packages/adapters/src/fetch-plan.test.ts packages/adapters/package.json
git commit -m "feat(adapters): pure fetch-plan resolver (strategy + interval + state)"
```

---

## Task 2: Reuse `TIER_INTERVALS` in the poll cron (single source of truth)

**Files:**

- Modify: `workers/api/src/cron/poll-fetch.ts:94-101`

- [ ] **Step 1: Replace the local const with the shared import**

In `workers/api/src/cron/poll-fetch.ts`, delete the local declaration (lines ~94-101):

```ts
// ── Tier intervals (hours) ──

type PollTier = "normal" | "low";

const TIER_INTERVALS: Record<PollTier, number> = {
  normal: 4,
  low: 24,
};
```

Replace with:

```ts
// ── Tier intervals (hours) ──
// Shared with the dev-only fetch-plan endpoint so the displayed cadence can
// never drift from what the cron actually enforces.
import { TIER_INTERVALS } from "@releases/adapters/fetch-plan";

type PollTier = keyof typeof TIER_INTERVALS;
```

(Move the `import` to the top with the other `@releases/adapters/*` imports if the linter requires imports-first; `PollTier` stays where the const was.)

- [ ] **Step 2: Type-check the worker**

Run:

```bash
cd workers/api && npx tsc --noEmit && cd ../..
```

Expected: no errors. `Object.keys(TIER_INTERVALS) as PollTier[]` at the `tierConditions` map still resolves (`normal`/`low`).

- [ ] **Step 3: Run the poll-fetch tests to confirm no regression**

Run:

```bash
bun test workers/api/test/fetch-log.test.ts
```

Expected: PASS (unchanged behavior — same interval values).

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/cron/poll-fetch.ts
git commit -m "refactor(cron): source TIER_INTERVALS from @releases/adapters/fetch-plan"
```

---

## Task 3: Worker endpoint `GET /status/fetch-plan`

**Files:**

- Modify: `workers/api/src/routes/status.ts`
- Create: `workers/api/test/fetch-plan-route.test.ts`

- [ ] **Step 1: Write the failing route test**

Create `workers/api/test/fetch-plan-route.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
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

interface PlanRow {
  slug: string;
  plan: { strategy: string; intervalLabel: string; cadence: string; paused: boolean };
  state: { nextDueAt: string | null; paused: boolean };
}

async function seed(db: D1Db) {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await db.insert(sources).values([
    {
      id: "src_fc",
      orgId: "org_a",
      slug: "acme-firecrawl",
      name: "Acme Firecrawl",
      url: "https://a.test/fc",
      type: "scrape",
      metadata: JSON.stringify({ firecrawl: { enabled: true, schedule: "every 12 hours" } }),
      fetchPriority: "normal",
    },
    {
      id: "src_paused",
      orgId: "org_a",
      slug: "acme-paused",
      name: "Acme Paused",
      url: "https://a.test/p",
      type: "feed",
      metadata: JSON.stringify({ feedUrl: "https://a.test/feed", feedType: "rss" }),
      fetchPriority: "paused",
    },
  ]);
}

describe("GET /v1/status/fetch-plan", () => {
  it("returns one row per org source with resolved strategy + state", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/status/fetch-plan?org=acme"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: PlanRow[] };
    expect(body.sources).toHaveLength(2);

    const fc = body.sources.find((s) => s.slug === "acme-firecrawl")!;
    expect(fc.plan.strategy).toBe("firecrawl");
    expect(fc.plan.intervalLabel).toBe("every 12 hours");
    expect(fc.plan.cadence).toBe("firecrawl-webhook");
    expect(fc.state.nextDueAt).toBeNull();

    const paused = body.sources.find((s) => s.slug === "acme-paused")!;
    expect(paused.plan.strategy).toBe("feed");
    expect(paused.plan.intervalLabel).toBe("paused");
    expect(paused.plan.paused).toBe(true);
    expect(paused.state.nextDueAt).toBeNull();
  });

  it("returns 400 when org is missing", async () => {
    const db = mkDb();
    const fetch = mkApp(db);
    const res = await fetch(new Request("https://x.test/v1/status/fetch-plan"));
    expect(res.status).toBe(400);
  });

  it("returns an empty list for an unknown org", async () => {
    const db = mkDb();
    const fetch = mkApp(db);
    const res = await fetch(new Request("https://x.test/v1/status/fetch-plan?org=nope"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: PlanRow[] };
    expect(body.sources).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test workers/api/test/fetch-plan-route.test.ts
```

Expected: FAIL — route returns 404 (handler not yet added), so `res.status` is 404 not 200.

- [ ] **Step 3: Add the route handler**

In `workers/api/src/routes/status.ts`, add the import near the top (with the other imports):

```ts
import { describeFetchPlan, computeFetchState } from "@releases/adapters/fetch-plan";
```

Add `asc` is already imported from `drizzle-orm` (line 2). Then add this handler after the `/status/fetch-log` handler (after line 128):

```ts
// Dev-only operator view: per-source fetch strategy, interval, and live timing
// state for an org. Reachable only through the flag-gated /api/proxy and the
// dev-gated Fetch Log tab (NODE_ENV check on the page). Mirrors the plain-route
// shape of /status/fetch-log — not part of the published api-types wire protocol.
statusRoutes.get("/status/fetch-plan", async (c) => {
  const db = createDb(c.env.DB);
  const org = c.req.query("org");
  if (!org) return c.json({ error: "missing_org" }, 400);

  const [orgRow] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, org))
    .limit(1);
  if (!orgRow) return c.json({ sources: [] });

  const rows = await db
    .select()
    .from(sources)
    .where(eq(sources.orgId, orgRow.id))
    .orderBy(asc(sources.name));

  const now = new Date();
  const result = rows.map((s) => {
    const plan = describeFetchPlan(s);
    return {
      id: s.id,
      slug: s.slug,
      name: s.name,
      type: s.type,
      plan,
      state: computeFetchState(s, plan, now),
    };
  });
  return c.json({ sources: result });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
bun test workers/api/test/fetch-plan-route.test.ts
```

Expected: PASS — all three cases green.

- [ ] **Step 5: Type-check the worker**

Run:

```bash
cd workers/api && npx tsc --noEmit && cd ../..
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/status.ts workers/api/test/fetch-plan-route.test.ts
git commit -m "feat(api): GET /status/fetch-plan — per-source strategy + interval + state"
```

---

## Task 4: Web read side — hook + read-only panel

**Files:**

- Create: `web/src/components/use-fetch-plan.ts`
- Create: `web/src/components/org-fetch-plan-panel.tsx`
- Modify: `web/src/components/org-fetch-log-view.tsx`

- [ ] **Step 1: Create the hook + local wire types**

Create `web/src/components/use-fetch-plan.ts`:

```ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Wire shape mirrors packages/adapters/src/fetch-plan.ts. Kept local because
// /status/* is a dev-only endpoint, not part of the published api-types contract
// (same hand-synced pattern as fetch-log-shared.tsx). Update both together.
export type FetchStrategy =
  | "github"
  | "feed"
  | "appstore"
  | "video"
  | "crawl"
  | "scrape"
  | "agent"
  | "firecrawl";

export interface FetchPlan {
  strategy: FetchStrategy;
  strategyLabel: string;
  intervalHours: number | null;
  intervalLabel: string;
  cadence: "poll" | "firecrawl-webhook";
  paused: boolean;
  firecrawlSchedule?: string;
}

export interface FetchState {
  lastPolledAt: string | null;
  nextDueAt: string | null;
  backedOff: boolean;
  paused: boolean;
}

export interface FetchPlanRow {
  id: string;
  slug: string;
  name: string;
  type: string;
  plan: FetchPlan;
  state: FetchState;
}

interface State {
  rows: FetchPlanRow[];
  loading: boolean;
  error: string | null;
}

export function useFetchPlan(orgSlug: string) {
  const [state, setState] = useState<State>({ rows: [], loading: true, error: null });
  const reqId = useRef(0);

  const refetch = useCallback(async () => {
    const id = ++reqId.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`/api/proxy/status/fetch-plan?org=${encodeURIComponent(orgSlug)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { sources: FetchPlanRow[] };
      if (reqId.current !== id) return;
      setState({ rows: body.sources, loading: false, error: null });
    } catch (e) {
      if (reqId.current !== id) return;
      setState((s) => ({
        ...s,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, [orgSlug]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { ...state, refetch };
}
```

- [ ] **Step 2: Create the read-only panel**

Create `web/src/components/org-fetch-plan-panel.tsx` (edit controls land in Task 6; this step renders read-only):

```tsx
"use client";

import { useFetchPlan, type FetchPlanRow } from "./use-fetch-plan";

function relative(iso: string | null, now: number): string {
  if (!iso) return "—";
  const diffMs = Date.parse(iso) - now;
  const past = diffMs < 0;
  const mins = Math.round(Math.abs(diffMs) / 60_000);
  const label =
    mins < 60
      ? `${mins}m`
      : mins < 1440
        ? `${Math.round(mins / 60)}h`
        : `${Math.round(mins / 1440)}d`;
  return past ? `${label} ago` : `in ${label}`;
}

function NextDueCell({ row, now }: { row: FetchPlanRow; now: number }) {
  if (row.plan.cadence === "firecrawl-webhook")
    return <span className="text-stone-400">webhook</span>;
  if (row.plan.paused) return <span className="text-stone-400">—</span>;
  return (
    <span className="text-stone-500">
      {relative(row.state.nextDueAt, now)}
      {row.state.backedOff && (
        <span className="ml-1.5 text-[10px] font-sans uppercase tracking-wide text-amber-500">
          backed off
        </span>
      )}
    </span>
  );
}

export function OrgFetchPlanPanel({ orgSlug }: { orgSlug: string }) {
  const { rows, loading, error } = useFetchPlan(orgSlug);
  const now = Date.now();

  if (loading && rows.length === 0) {
    return (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-4">Loading fetch plan…</div>
    );
  }
  if (error && rows.length === 0) {
    return <div className="text-sm text-red-500 py-4">Failed to load fetch plan: {error}</div>;
  }
  if (rows.length === 0) return null;

  return (
    <div className="mb-6">
      <h2 className="text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-2">
        Fetch plan
      </h2>
      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[2fr_1.5fr_1.2fr_1fr_1fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
          <div>Source</div>
          <div>Strategy</div>
          <div>Interval</div>
          <div>Last poll</div>
          <div>Next due</div>
        </div>
        {rows.map((row) => (
          <div
            key={row.id}
            className="grid grid-cols-[2fr_1.5fr_1.2fr_1fr_1fr] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 last:border-b-0 items-center"
          >
            <div className="text-stone-900 dark:text-stone-100">
              <a href={`/source/${row.slug}`} className="hover:underline">
                {row.name}
              </a>
            </div>
            <div className="text-stone-500">{row.plan.strategyLabel}</div>
            <div className="text-stone-500">{row.plan.intervalLabel}</div>
            <div className="text-stone-400">{relative(row.state.lastPolledAt, now)}</div>
            <div>
              <NextDueCell row={row} now={now} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Mount the panel above the log body**

Rewrite `web/src/components/org-fetch-log-view.tsx` so the panel always renders (the log's loading/empty states must not hide it):

```tsx
"use client";

import { useState } from "react";
import { type FetchLogStatusFilter } from "./fetch-log-shared";
import { FetchLogList } from "./fetch-log-list";
import { OrgFetchPlanPanel } from "./org-fetch-plan-panel";
import { useFetchLog, type FetchLogSortField } from "./use-fetch-log";
import type { SortState } from "./sort-header";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

export function OrgFetchLogView({ orgSlug }: { orgSlug: string }) {
  const [filter, setFilter] = useState<FetchLogStatusFilter>("all");
  const [sort, setSort] = useState<SortState<FetchLogSortField>>({
    field: "createdAt",
    dir: "desc",
  });
  const { entries, totalCount, statusCounts, hasMore, loading, error, loadMore } = useFetchLog({
    org: orgSlug,
    status: filter,
    sort: sort.field,
    dir: sort.dir,
  });

  let logBody;
  if (loading && entries.length === 0) {
    logBody = (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
        Loading fetch log…
      </div>
    );
  } else if (error && entries.length === 0) {
    logBody = (
      <div className="text-sm text-red-500 py-8 text-center">Failed to load fetch log: {error}</div>
    );
  } else if (!loading && totalCount === 0) {
    logBody = (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
        No fetch log entries for this organization.
      </div>
    );
  } else {
    logBody = (
      <FetchLogList
        entries={entries}
        totalCount={totalCount}
        statusCounts={statusCounts}
        hasMore={hasMore}
        loading={loading}
        filter={filter}
        onFilterChange={setFilter}
        onLoadMore={loadMore}
        sort={sort}
        onSortChange={setSort}
        formatTime={formatTime}
      />
    );
  }

  return (
    <div className="mt-5">
      <OrgFetchPlanPanel orgSlug={orgSlug} />
      {logBody}
    </div>
  );
}
```

- [ ] **Step 4: Type-check the web app**

Run:

```bash
cd web && npx tsc --noEmit && cd ..
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/use-fetch-plan.ts web/src/components/org-fetch-plan-panel.tsx web/src/components/org-fetch-log-view.tsx
git commit -m "feat(web): read-only fetch-plan panel on the org Fetch Log tab"
```

---

## Task 5: Edit server actions

**Files:**

- Modify: `web/src/app/actions/source-admin.ts`

- [ ] **Step 1: Add the two actions**

Append to `web/src/app/actions/source-admin.ts` (reuse the existing `ActionResult`, `adminActionEnv`, `webApiHeaders`, `revalidatePath` imports already at the top of the file):

```ts
/**
 * Change a source's fetch priority/interval tier via
 * `PATCH /v1/orgs/:orgSlug/sources/:sourceSlug`. `normal` → poll every 4h,
 * `low` → every 24h, `paused` → never polled.
 */
export async function setFetchPriorityAction(input: {
  orgSlug: string;
  sourceSlug: string;
  priority: "normal" | "low" | "paused";
}): Promise<ActionResult> {
  const env = adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  const path = `/v1/orgs/${encodeURIComponent(input.orgSlug)}/sources/${encodeURIComponent(input.sourceSlug)}`;
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify({ fetchPriority: input.priority }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  revalidatePath(`/${input.orgSlug}`);
  return { ok: true };
}

/**
 * Enable/disable Firecrawl monitoring for a source via
 * `POST /v1/sources/:sourceId/firecrawl/sync`. This route — not a raw metadata
 * write — provisions the external monitor on enable and deletes it on disable
 * (with orphan-compensation). Pass the typed `src_…` id; the route rejects bare
 * slugs. Enabling bills Firecrawl credits, so the caller confirms first.
 */
export async function syncFirecrawlAction(input: {
  orgSlug: string;
  sourceId: string;
  enabled: boolean;
  schedule?: string;
}): Promise<ActionResult> {
  const env = adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  const path = `/v1/sources/${encodeURIComponent(input.sourceId)}/firecrawl/sync`;
  const payload: { enabled: boolean; schedule?: string } = { enabled: input.enabled };
  if (input.schedule) payload.schedule = input.schedule;

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      method: "POST",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  revalidatePath(`/${input.orgSlug}`);
  return { ok: true };
}
```

- [ ] **Step 2: Type-check the web app**

Run:

```bash
cd web && npx tsc --noEmit && cd ..
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/actions/source-admin.ts
git commit -m "feat(web): server actions to set fetch priority + sync Firecrawl"
```

---

## Task 6: Wire edit controls into the panel

**Files:**

- Modify: `web/src/components/org-fetch-plan-panel.tsx`

- [ ] **Step 1: Add the priority dropdown + Firecrawl toggle to each row**

Update `web/src/components/org-fetch-plan-panel.tsx`. Add imports at the top:

```tsx
import { useState, useTransition } from "react";
import { setFetchPriorityAction, syncFirecrawlAction } from "@/app/actions/source-admin";
```

Add `orgSlug` + `onChanged` to the panel→row data flow by replacing the row `.map(...)` body with a `<PlanRowItem>` component, and add the component below `OrgFetchPlanPanel`. Replace the `{rows.map((row) => ( … ))}` block with:

```tsx
{
  rows.map((row) => (
    <PlanRowItem key={row.id} row={row} orgSlug={orgSlug} now={now} onChanged={refetch} />
  ));
}
```

and pull `refetch` out of the hook destructure:

```tsx
const { rows, loading, error, refetch } = useFetchPlan(orgSlug);
```

Then add the component (the Interval cell becomes the editable control; Strategy column gains a Firecrawl toggle):

```tsx
const PRIORITIES = ["normal", "low", "paused"] as const;

function PlanRowItem({
  row,
  orgSlug,
  now,
  onChanged,
}: {
  row: FetchPlanRow;
  orgSlug: string;
  now: number;
  onChanged: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const isFirecrawl = row.plan.strategy === "firecrawl";

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setErr(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setErr(res.error);
      else onChanged();
    });
  }

  function onPriorityChange(priority: (typeof PRIORITIES)[number]) {
    run(() => setFetchPriorityAction({ orgSlug, sourceSlug: row.slug, priority }));
  }

  function onFirecrawlToggle(next: boolean) {
    if (
      next &&
      !window.confirm(
        `Enable Firecrawl for "${row.name}"? This provisions an external monitor that bills Firecrawl credits.`,
      )
    ) {
      return;
    }
    run(() => syncFirecrawlAction({ orgSlug, sourceId: row.id, enabled: next }));
  }

  return (
    <div className="grid grid-cols-[2fr_1.5fr_1.2fr_1fr_1fr] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 last:border-b-0 items-center">
      <div className="text-stone-900 dark:text-stone-100">
        <a href={`/source/${row.slug}`} className="hover:underline">
          {row.name}
        </a>
        {err && <div className="text-[10px] font-sans text-red-500 mt-0.5">{err}</div>}
      </div>
      <div className="text-stone-500 flex items-center gap-2">
        {row.plan.strategyLabel}
        <button
          type="button"
          disabled={pending}
          onClick={() => onFirecrawlToggle(!isFirecrawl)}
          className="text-[10px] font-sans px-1.5 py-0.5 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-40"
          title="Toggle Firecrawl monitoring"
        >
          {isFirecrawl ? "Disable FC" : "Enable FC"}
        </button>
      </div>
      <div className="text-stone-500">
        {isFirecrawl ? (
          row.plan.intervalLabel
        ) : (
          <select
            value={row.plan.paused ? "paused" : row.plan.intervalHours === 24 ? "low" : "normal"}
            disabled={pending}
            onChange={(e) => onPriorityChange(e.target.value as (typeof PRIORITIES)[number])}
            className="bg-transparent border border-stone-200 dark:border-stone-700 rounded px-1 py-0.5 disabled:opacity-40"
          >
            <option value="normal">every 4 hours</option>
            <option value="low">every 24 hours</option>
            <option value="paused">paused</option>
          </select>
        )}
      </div>
      <div className="text-stone-400">{relative(row.state.lastPolledAt, now)}</div>
      <div>
        <NextDueCell row={row} now={now} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check the web app**

Run:

```bash
cd web && npx tsc --noEmit && cd ..
```

Expected: no errors. (`PRIORITIES`, `relative`, `NextDueCell`, `FetchPlanRow` are all in scope within the file.)

- [ ] **Step 3: Lint + format the changed files**

Run:

```bash
bun run lint
bun run format:check
```

Expected: clean. If `format:check` flags files, run `bun run format` and re-stage.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/org-fetch-plan-panel.tsx
git commit -m "feat(web): inline edit — fetch priority dropdown + Firecrawl toggle"
```

---

## Task 7: Full verification

- [ ] **Step 1: Run the full gates**

Run from the worktree root:

```bash
npx tsc --noEmit
cd workers/api && npx tsc --noEmit && cd ../..
cd web && npx tsc --noEmit && cd ..
bun test
bun run lint
bun run format:check
```

Expected: all green. `bun test` includes `fetch-plan.test.ts`, `fetch-plan-route.test.ts`, and the unchanged `fetch-log.test.ts`.

- [ ] **Step 2: Manual smoke (dev servers)**

In separate terminals:

```bash
bun run dev:api
bun run dev:web
```

Then:

1. Open `https://<branch>.releases.localhost/<an-org-slug>/fetch-log` (dev-only tab).
2. Confirm the **Fetch plan** panel lists each source with strategy, interval, last-poll, next-due. Verify a known Firecrawl source shows "Firecrawl / <schedule> / webhook" and a paused source shows "paused / —".
3. Change a source's interval dropdown to **paused**; confirm the panel re-fetches and the row flips to paused.
4. Set it back to **every 4 hours**; confirm next-due recomputes.
5. (Optional, costs credits) Click **Enable FC** on a non-Firecrawl source, accept the confirm, and verify the strategy flips to Firecrawl; then **Disable FC** to tear the monitor back down. Prefer doing this against staging.

- [ ] **Step 3: Push the branch and open a PR**

```bash
git push -u origin worktree-fetch-plan-panel
gh pr create --title "feat: fetch-strategy & interval panel on the org Fetch Log tab" --body-file <(cat <<'BODY'
Adds a per-source **Fetch plan** panel (strategy · interval · last-poll · next-due, with a backed-off badge) to the top of the dev-only org Fetch Log tab, plus inline controls to change fetch priority/interval and toggle Firecrawl.

- Pure `describeFetchPlan` / `computeFetchState` resolver in `@releases/adapters/fetch-plan` is the single source of truth; the poll cron now imports `TIER_INTERVALS` from it so display can't drift from reality.
- `GET /v1/status/fetch-plan?org=` (dev-only, flag-gated proxy) returns resolved rows.
- Firecrawl toggle calls `POST /v1/sources/:id/firecrawl/sync` (provisions/tears down the external monitor), guarded by a confirm; priority uses the existing source PATCH.

Spec + plan: `docs/superpowers/specs/2026-05-30-fetch-plan-panel-design.md`, `docs/superpowers/plans/2026-05-30-fetch-plan-panel.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)
```

---

## Self-review notes

- **Spec coverage:** resolver (Task 1) ✓; single-source-of-truth refactor (Task 2) ✓; endpoint (Task 3) ✓; read panel + mount (Task 4) ✓; edit actions (Task 5) ✓; edit controls + confirm (Task 6) ✓; deferred metadata edits left read-only ✓. The spec's api-types section was intentionally dropped — `/status/*` is not part of the published wire protocol (fetch-log defines its type locally), so the web side mirrors the shape locally per existing convention.
- **Signature note:** `computeFetchState(source, plan, now)` takes the precomputed `plan` (vs. the spec's `(source, now)`) so the endpoint resolves the plan once; tests and the endpoint both pass it.
- **Type consistency:** `FetchStrategy` / `FetchPlan` / `FetchState` / `FetchPlanRow` names and fields match across `fetch-plan.ts`, the route, and `use-fetch-plan.ts`. `setFetchPriorityAction` / `syncFirecrawlAction` names match between Task 5 and Task 6.
- **No placeholders:** every code/test/command step is concrete.
