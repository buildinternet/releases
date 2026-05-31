import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { sources, organizations, releases, fetchLog } from "@buildinternet/releases-core/schema";
import { applyMigrations, ensureBatchShim } from "../db-helper";
import {
  FirecrawlIngestWorkflow,
  type FirecrawlIngestEnv,
} from "../../workers/api/src/workflows/firecrawl-ingest";
import { mkFakeStep } from "./_workflow-test-helpers";
import { FirecrawlError } from "@releases/lib/errors";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations)
    .values({ id: "org_fc", name: "Acme FC", slug: "acme-fc", category: "cloud" })
    .run();
  db.insert(sources)
    .values({
      id: "src_fc1",
      orgId: "org_fc",
      slug: "acme-fc-changelog",
      name: "Acme FC Changelog",
      url: "https://acme.com/changelog",
      type: "scrape",
      metadata: JSON.stringify({ firecrawl: { enabled: true, proxy: "auto" } }),
    })
    .run();
  return db;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkEnv(db: any, overrides: Record<string, unknown> = {}): FirecrawlIngestEnv {
  return {
    DB: {},
    _drizzleOverride: db,
    FIRECRAWL_API_KEY: { get: async () => "fc-key" },
    _firecrawlClientOverride: {
      scrapeOnce: async () => "# v1.0.0\nInitial release.",
      createMonitor: async () => "m",
      getMonitor: async () => ({ id: "m" }),
      updateMonitor: async () => {},
      deleteMonitor: async () => {},
      runMonitor: async () => {},
    },
    _extractOverride: async () => [
      {
        title: "v1.0.0",
        content: "Initial release.",
        url: "https://acme.com/changelog#v1-0-0",
        version: "v1.0.0",
      },
    ],
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function runWorkflow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env: FirecrawlIngestEnv,
  params: { sourceId: string; url: string; checkId: string; status: string },
) {
  const { step } = mkFakeStep();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as any;
  const wf = new FirecrawlIngestWorkflow(ctx, env);
  try {
    await wf.run(
      {
        payload: params,
        instanceId: "test",
        timestamp: new Date(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      step as any,
    );
  } catch (err) {
    return { thrown: err };
  }
  return { thrown: undefined };
}

describe("FirecrawlIngestWorkflow", () => {
  it("happy path: scrape → extract → insert → fetch_log success", async () => {
    const db = mkDb();
    const env = mkEnv(db);

    const { thrown } = await runWorkflow(env, {
      sourceId: "src_fc1",
      url: "https://acme.com/changelog",
      checkId: "chk_1",
      status: "new",
    });

    expect(thrown).toBeUndefined();

    // A release was inserted for the source.
    const rows = db.select().from(releases).where(eq(releases.sourceId, "src_fc1")).all();
    expect(rows.length).toBeGreaterThan(0);

    // A fetch_log row with status=success and sessionId=firecrawl:chk_1 was written.
    const logs = db.select().from(fetchLog).where(eq(fetchLog.sourceId, "src_fc1")).all();
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("success");
    expect(logs[0].sessionId).toBe("firecrawl:chk_1");
  });

  it("crawl monitor: threads the per-page url into extraction so the release lands on the discovered page URL", async () => {
    const db = mkDb();
    // A crawl-target monitor: Firecrawl reports each discovered entry page on its
    // own URL, distinct from the index (source.url).
    db.update(sources)
      .set({ metadata: JSON.stringify({ firecrawl: { enabled: true, target: "crawl" } }) })
      .where(eq(sources.id, "src_fc1"))
      .run();

    const pageUrl = "https://acme.com/changelog/2026/05/15/entry";
    let seenPageUrl: string | undefined = "UNSET";
    const env = mkEnv(db, {
      _extractOverride: async (_md: string, _src: unknown, pUrl?: string) => {
        seenPageUrl = pUrl;
        return [{ title: "Entry", content: "Shipped X.", url: pUrl ?? "x", version: "" }];
      },
    });

    const { thrown } = await runWorkflow(env, {
      sourceId: "src_fc1",
      url: pageUrl,
      checkId: "chk_crawl",
      status: "new",
    });

    expect(thrown).toBeUndefined();
    // The workflow threads the per-page url through to extraction (gap #2).
    expect(seenPageUrl).toBe(pageUrl);

    // The release is attributed to the discovered page's bare URL.
    const rows = db.select().from(releases).where(eq(releases.sourceId, "src_fc1")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe(pageUrl);
  });

  it("scrape monitor: does NOT thread a pageUrl (keeps source.url anchor attribution)", async () => {
    const db = mkDb();
    // Default source has firecrawl.enabled with no target → scrape monitor.
    let seenPageUrl: string | undefined = "UNSET";
    const env = mkEnv(db, {
      _extractOverride: async (_md: string, _src: unknown, pUrl?: string) => {
        seenPageUrl = pUrl;
        return [
          {
            title: "v1.0.0",
            content: "Initial release.",
            url: "https://acme.com/changelog#v1-0-0",
            version: "v1.0.0",
          },
        ];
      },
    });

    const { thrown } = await runWorkflow(env, {
      sourceId: "src_fc1",
      url: "https://acme.com/changelog",
      checkId: "chk_scrape",
      status: "new",
    });

    expect(thrown).toBeUndefined();
    // A scrape monitor must not force bare attribution — pageUrl stays undefined.
    expect(seenPageUrl).toBeUndefined();
  });

  it("no_change: duplicate URL → fetch_log status=no_change with 0 inserted", async () => {
    const db = mkDb();

    // Seed the same release URL that _extractOverride will return on both runs.
    const duplicateUrl = "https://acme.com/changelog#v1-0-0";
    db.insert(releases)
      .values({
        id: "rel_existing",
        sourceId: "src_fc1",
        title: "v1.0.0",
        content: "Initial release.",
        url: duplicateUrl,
      })
      .run();

    const env = mkEnv(db, {
      _extractOverride: async () => [
        {
          title: "v1.0.0",
          content: "Initial release.",
          url: duplicateUrl,
          version: "v1.0.0",
        },
      ],
    });

    const { thrown } = await runWorkflow(env, {
      sourceId: "src_fc1",
      url: "https://acme.com/changelog",
      checkId: "chk_2",
      status: "new",
    });

    expect(thrown).toBeUndefined();

    // Only the original seeded release; no new insertion.
    const rows = db.select().from(releases).where(eq(releases.sourceId, "src_fc1")).all();
    expect(rows).toHaveLength(1);

    // fetch_log should show no_change.
    const logs = db.select().from(fetchLog).where(eq(fetchLog.sourceId, "src_fc1")).all();
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("no_change");
    expect(logs[0].sessionId).toBe("firecrawl:chk_2");
  });

  it("source not found: ends cleanly with NonRetryableError (no fetch_log row)", async () => {
    const db = mkDb();
    const env = mkEnv(db);

    await runWorkflow(env, {
      sourceId: "src_nonexistent",
      url: "https://acme.com/changelog",
      checkId: "chk_3",
      status: "new",
    });

    // NonRetryableError is not re-thrown by the workflow (load-source catches it cleanly).
    // The mkFakeStep harness re-throws from the step.do call, so it will be caught.
    // What matters: no fetch_log row was written.
    const logs = db.select().from(fetchLog).all();
    expect(logs).toHaveLength(0);
  });

  it("firecrawl not enabled: NonRetryableError from load-source guard", async () => {
    const db = mkDb();
    // Update source to have firecrawl.enabled = false.
    db.update(sources)
      .set({ metadata: JSON.stringify({ firecrawl: { enabled: false } }) })
      .where(eq(sources.id, "src_fc1"))
      .run();

    const env = mkEnv(db);

    const { thrown } = await runWorkflow(env, {
      sourceId: "src_fc1",
      url: "https://acme.com/changelog",
      checkId: "chk_4",
      status: "new",
    });

    // NonRetryableError is thrown — the step fails and bubbles up.
    expect(thrown).toBeDefined();
    const logs = db.select().from(fetchLog).all();
    expect(logs).toHaveLength(0);
  });

  it("scrape failure (out of credits) records an error fetch_log row + bumps consecutiveErrors", async () => {
    const db = mkDb();
    const env = mkEnv(db, {
      _firecrawlClientOverride: {
        scrapeOnce: async () => {
          throw new FirecrawlError(402, "POST", "/v2/scrape", "insufficient credits");
        },
        createMonitor: async () => "m",
        getMonitor: async () => ({ id: "m" }),
        updateMonitor: async () => {},
        deleteMonitor: async () => {},
        runMonitor: async () => {},
      },
    });

    const { thrown } = await runWorkflow(env, {
      sourceId: "src_fc1",
      url: "https://acme.com/changelog",
      checkId: "chk_5",
      status: "changed",
    });

    // Re-thrown so the instance is still marked failed for the CF dashboard.
    expect(thrown).toBeDefined();

    // The failure is recorded in the source's own health instead of being
    // invisible: an error fetch_log row + a bumped consecutiveErrors counter.
    const logs = db.select().from(fetchLog).where(eq(fetchLog.sourceId, "src_fc1")).all();
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("error");
    expect(logs[0].sessionId).toBe("firecrawl:chk_5");

    const [src] = db.select().from(sources).where(eq(sources.id, "src_fc1")).all();
    expect(src.consecutiveErrors).toBe(1);

    // Nothing was inserted.
    const rows = db.select().from(releases).where(eq(releases.sourceId, "src_fc1")).all();
    expect(rows).toHaveLength(0);
  });
});
