/**
 * Tests for BackfillSourceWorkflow — mirrors firecrawl-ingest-workflow.test.ts's
 * harness pattern exactly: fake step, drizzle-override, Map-backed R2.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { sources, organizations, releases } from "@buildinternet/releases-core/schema";
import { applyMigrations, ensureBatchShim } from "../../../../tests/db-helper.js";
import { BackfillSourceWorkflow, type BackfillSourceEnv } from "./backfill-source.js";
import { mkFakeStep } from "../../../../tests/api/_workflow-test-helpers.js";
import type { RawRelease } from "@releases/adapters/types.js";
import type { Source } from "@buildinternet/releases-core/schema";

// ~2000 short entries to span multiple planWindowOffsets windows.
// Each window is DEFAULT_CHANGELOG_SLICE_TOKENS (~10K tokens, ~40K chars).
const MULTI_WINDOW_MARKDOWN = Array.from(
  { length: 2000 },
  (_, i) =>
    `## Entry ${i}\n\nChangelog body text for entry number ${i} describing assorted fixes and features in adequate detail.`,
).join("\n\n");

// Larger fixture (~4000 entries → well over FIRECRAWL_BACKFILL_MAX_WINDOWS=8
// windows) so a firecrawl request deeper than the ceiling caps the run with an
// untouched tail, exercising the firecrawlCapGuidance branch in finalize.
const DEEP_MARKDOWN = Array.from(
  { length: 4000 },
  (_, i) =>
    `## Entry ${i}\n\nChangelog body text for entry number ${i} describing assorted fixes and features in adequate detail.`,
).join("\n\n");

function fakeR2() {
  const store = new Map<string, string>();
  return {
    store,
    put: async (k: string, v: ArrayBuffer | string) => {
      store.set(k, typeof v === "string" ? v : new TextDecoder().decode(v));
    },
    get: async (k: string) => (store.has(k) ? { text: async () => store.get(k)! } : null),
    head: async (k: string) => (store.has(k) ? {} : null),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkDb(): any {
  const sqlite = new Database(":memory:");
  const db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations)
    .values({ id: "org_bf", name: "Acme BF", slug: "acme-bf", category: "developer-tools" })
    .run();
  db.insert(sources)
    .values({
      id: "src_x",
      orgId: "org_bf",
      slug: "acme-bf-changelog",
      name: "Acme BF Changelog",
      url: "https://acme-bf.com/changelog",
      type: "scrape",
      metadata: JSON.stringify({ firecrawl: { enabled: true, proxy: "auto" } }),
    })
    .run();
  return db;
}

/**
 * Per-window extract override that returns 2 distinct entries per window,
 * keyed by window index so totals add up distinctly.
 */
function makeWindowExtractOverride() {
  // Per-override window counter, scoped to the closure so it can't leak across
  // runs/envs (each mkEnv() builds a fresh override with its own count).
  let windowCallCount = 0;
  const override = async (_markdown: string, _source: Source): Promise<RawRelease[]> => {
    const n = windowCallCount++;
    return [
      {
        title: `Entry win${n} a`,
        content: `Body win${n} a`,
        url: `https://acme-bf.com/changelog#win${n}a`,
        version: `v${n}.0.0`,
        publishedAt: new Date(`2025-01-${String(n + 1).padStart(2, "0")}T00:00:00Z`),
      },
      {
        title: `Entry win${n} b`,
        content: `Body win${n} b`,
        url: `https://acme-bf.com/changelog#win${n}b`,
        version: `v${n}.0.1`,
        publishedAt: new Date(`2025-01-${String(n + 1).padStart(2, "0")}T12:00:00Z`),
      },
    ] as RawRelease[];
  };
  return override;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkEnv(
  db: any,
  r2: ReturnType<typeof fakeR2>,
  overrides: Record<string, unknown> = {},
): BackfillSourceEnv {
  return {
    DB: {} as never,
    _drizzleOverride: db,
    RAW_SNAPSHOTS: r2 as never,
    FIRECRAWL_API_KEY: { get: async () => "fc-key-test" },
    _firecrawlClientOverride: {
      scrapeOnce: async () => MULTI_WINDOW_MARKDOWN,
      createMonitor: async () => "m",
      getMonitor: async () => ({ id: "m" }),
      updateMonitor: async () => {},
      deleteMonitor: async () => {},
      runMonitor: async () => {},
    },
    _extractOverride: makeWindowExtractOverride(),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function runWorkflow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env: BackfillSourceEnv,
  params: { sourceId: string; maxWindows?: number; dryRun?: boolean; suppliedMarkdown?: string },
) {
  const { step, records } = mkFakeStep();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as any;
  const wf = new BackfillSourceWorkflow(ctx, env);
  let result: unknown;
  let thrown: unknown;
  try {
    result = await wf.run(
      {
        payload: {
          sourceId: params.sourceId,
          maxWindows: params.maxWindows ?? 50,
          dryRun: params.dryRun !== undefined ? params.dryRun : true,
          suppliedMarkdown: params.suppliedMarkdown,
        },
        instanceId: "test",
        timestamp: new Date(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      step as any,
    );
  } catch (err) {
    thrown = err;
  }
  return { result, thrown, stepNames: records.map((r) => r.name) };
}

describe("BackfillSourceWorkflow", () => {
  it("dryRun happy path: saves raw to R2 once, plans windows, skips inserts, returns report", async () => {
    const db = mkDb();
    const r2 = fakeR2();
    const env = mkEnv(db, r2);

    const { result, thrown, stepNames } = await runWorkflow(env, {
      sourceId: "src_x",
      dryRun: true,
      maxWindows: 50,
    });

    expect(thrown).toBeUndefined();

    // R2 received exactly one key (content-addressed dedup)
    expect(r2.store.size).toBe(1);

    // Each extract-window-N step is present
    const windowSteps = stepNames.filter((n) => n.startsWith("extract-window-"));
    expect(windowSteps.length).toBeGreaterThanOrEqual(2);
    // Indices must be sequential from 0
    for (let i = 0; i < windowSteps.length; i++) {
      expect(windowSteps).toContain(`extract-window-${i}`);
    }

    // No releases inserted on dryRun
    const rows = db.select().from(releases).where(eq(releases.sourceId, "src_x")).all();
    expect(rows).toHaveLength(0);

    // Report shape
    const report = result as Record<string, unknown>;
    expect(report.via).toBe("firecrawl");
    expect(report.dryRun).toBe(true);
    expect(typeof report.windows).toBe("number");
    expect(report.windows as number).toBeGreaterThanOrEqual(2);
    expect(report.extracted as number).toBeGreaterThan(0);
    expect(report.deduped as number).toBeGreaterThan(0);
    expect(report.inserted).toBe(0);
    expect(report.found).toBe(0);
    // dateRange from the per-window entries
    expect(report.dateRange).toBeDefined();
    const dr = report.dateRange as { from: string | null; to: string | null };
    expect(dr.from).not.toBeNull();
    expect(dr.to).not.toBeNull();
  });

  it("real run: inserts rows, running again inserts no duplicates (idempotent)", async () => {
    const db = mkDb();
    const r2 = fakeR2();
    const env = mkEnv(db, r2);

    // First run — real write
    const first = await runWorkflow(env, {
      sourceId: "src_x",
      dryRun: false,
      maxWindows: 50,
    });
    expect(first.thrown).toBeUndefined();
    const firstReport = first.result as Record<string, unknown>;
    expect(firstReport.inserted as number).toBeGreaterThan(0);

    const afterFirst = db.select().from(releases).where(eq(releases.sourceId, "src_x")).all();
    expect(afterFirst.length).toBeGreaterThan(0);

    // Second run — same Firecrawl scrape body, same extract override → all URLs
    // already exist → no new inserts (RELEASE_URL_UPSERT idempotent)
    const env2 = mkEnv(db, r2);
    const second = await runWorkflow(env2, {
      sourceId: "src_x",
      dryRun: false,
      maxWindows: 50,
    });
    expect(second.thrown).toBeUndefined();
    const secondReport = second.result as Record<string, unknown>;
    expect(secondReport.inserted).toBe(0);

    // Row count unchanged
    const afterSecond = db.select().from(releases).where(eq(releases.sourceId, "src_x")).all();
    expect(afterSecond.length).toBe(afterFirst.length);
  });

  it("per-window step isolation: each window is a separate step.do with distinct name", async () => {
    const db = mkDb();
    const r2 = fakeR2();
    const env = mkEnv(db, r2);

    const { stepNames } = await runWorkflow(env, {
      sourceId: "src_x",
      dryRun: true,
      maxWindows: 50,
    });

    const windowSteps = stepNames.filter((n) => n.startsWith("extract-window-"));
    // Must be multiple windows (structural assertion)
    expect(windowSteps.length).toBeGreaterThanOrEqual(2);
    // Each name must be unique
    const unique = new Set(windowSteps);
    expect(unique.size).toBe(windowSteps.length);
    // extract-window-0 and extract-window-1 are both present
    expect(windowSteps).toContain("extract-window-0");
    expect(windowSteps).toContain("extract-window-1");
  });

  it("not-found: throws NonRetryableError when sourceId doesn't exist", async () => {
    const db = mkDb();
    const r2 = fakeR2();
    const env = mkEnv(db, r2);

    const { thrown } = await runWorkflow(env, { sourceId: "src_nonexistent", dryRun: true });
    expect(thrown).toBeDefined();
    expect((thrown as Error).constructor.name).toBe("NonRetryableError");
  });

  it("non-scrape source: throws NonRetryableError for type=github", async () => {
    const db = mkDb();
    // Seed a github-type source
    db.insert(sources)
      .values({
        id: "src_gh",
        orgId: "org_bf",
        slug: "acme-github",
        name: "Acme GitHub",
        url: "https://github.com/acme/releases",
        type: "github",
        metadata: "{}",
      })
      .run();

    const r2 = fakeR2();
    const env = mkEnv(db, r2);

    const { thrown } = await runWorkflow(env, { sourceId: "src_gh", dryRun: true });
    expect(thrown).toBeDefined();
    expect((thrown as Error).constructor.name).toBe("NonRetryableError");
  });

  it("suppliedMarkdown path: uses supplied body (via=supplied), no Firecrawl call", async () => {
    const db = mkDb();
    const r2 = fakeR2();
    // Override Firecrawl to throw so we confirm it's never called
    const env = mkEnv(db, r2, {
      _firecrawlClientOverride: {
        scrapeOnce: async () => {
          throw new Error("Firecrawl should not be called");
        },
        createMonitor: async () => "m",
        getMonitor: async () => ({ id: "m" }),
        updateMonitor: async () => {},
        deleteMonitor: async () => {},
        runMonitor: async () => {},
      },
    });

    const { result, thrown } = await runWorkflow(env, {
      sourceId: "src_x",
      dryRun: true,
      maxWindows: 2,
      suppliedMarkdown: MULTI_WINDOW_MARKDOWN,
    });

    expect(thrown).toBeUndefined();
    const report = result as Record<string, unknown>;
    expect(report.via).toBe("supplied");
    expect(report.dryRun).toBe(true);
  });

  it("firecrawl cap: deep doc + maxWindows over the ceiling → cappedAtWindow + guidance", async () => {
    const db = mkDb();
    const r2 = fakeR2();
    // Firecrawl scrape returns the deep (>8-window) fixture; request 20 windows.
    // The firecrawl ceiling (FIRECRAWL_BACKFILL_MAX_WINDOWS=8) clamps the run,
    // so it stops with an untouched tail (cappedAtWindow) and 8 < 20 → guidance.
    const env = mkEnv(db, r2, {
      _firecrawlClientOverride: {
        scrapeOnce: async () => DEEP_MARKDOWN,
        createMonitor: async () => "m",
        getMonitor: async () => ({ id: "m" }),
        updateMonitor: async () => {},
        deleteMonitor: async () => {},
        runMonitor: async () => {},
      },
    });

    const { result, thrown } = await runWorkflow(env, {
      sourceId: "src_x",
      dryRun: true,
      maxWindows: 20,
    });

    expect(thrown).toBeUndefined();
    const report = result as Record<string, unknown>;
    expect(report.via).toBe("firecrawl");
    expect(report.cappedAtWindow).toBe(true);
    // Clamped to the firecrawl ceiling (8 windows), not the requested 20.
    expect(report.windows).toBe(8);
    expect(typeof report.guidance).toBe("string");
    expect((report.guidance as string).length).toBeGreaterThan(0);
    expect(report.guidance as string).toContain("8 windows");
  });
});
