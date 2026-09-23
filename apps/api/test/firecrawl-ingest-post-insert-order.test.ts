/**
 * Post-insert step ORDER + latest-cache invalidation for FirecrawlIngestWorkflow.
 *
 * Two drift fixes vs. the poll path (poll-and-fetch.ts), decoupled from the
 * #1946 phase-3 fold-in:
 *   1. `generate-content` must run BEFORE `embed-releases` (the firecrawl path
 *      previously ran them reversed) so the AI headline isn't embedded and the
 *      content_* fields land before release-event observers.
 *   2. an `invalidate-latest-cache` step must run when rows were inserted (the
 *      firecrawl path previously never purged the latest-cache).
 *
 * The test drives the real `run()` with a step-spy that records `step.do` names
 * in order and executes their bodies. Bodies are harmless no-ops here: the
 * `delta` payload skips Firecrawl, `_extractOverride` skips the LLM, embed
 * short-circuits without a VOYAGE key, and cache-invalidation short-circuits
 * without a LATEST_CACHE binding — so the assertion is purely on step ordering.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types";
import type { WorkflowStep } from "cloudflare:workers";
import { FirecrawlIngestWorkflow } from "../src/workflows/firecrawl-ingest.js";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations)
    .values({ id: "org_fc", slug: "acme", name: "Acme", category: "productivity" })
    .run();
  db.insert(sources)
    .values({
      id: "src_fc",
      orgId: "org_fc",
      slug: "acme-changelog",
      name: "Acme Changelog",
      type: "scrape",
      url: "https://acme.example/changelog",
      // firecrawl.enabled is required by the load-source step.
      metadata: JSON.stringify({ firecrawl: { enabled: true, target: "scrape" } }),
    })
    .run();
  return db;
}

/** Records `step.do` names in order and runs each body (handles the 2- and
 *  3-arg `step.do(name, fn)` / `step.do(name, config, fn)` shapes). */
function mkStepSpy() {
  const names: string[] = [];
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name);
      const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      return await fn();
    },
    sleep: async () => {},
  } as unknown as WorkflowStep;
  return { names, step };
}

const ONE_RELEASE: RawRelease[] = [
  {
    title: "Acme 2.0",
    content: "Big new release with real body content.",
    url: "https://acme.example/changelog/acme-2-0",
    publishedAt: new Date("2026-05-18T10:00:00Z"),
    isBreaking: false,
    media: [],
  },
];

function mkEnv(db: ReturnType<typeof mkDb>): unknown {
  return {
    DB: {} as unknown,
    _drizzleOverride: db,
    // Skip the LLM extraction — return one release straight through.
    _extractOverride: async () => ONE_RELEASE,
    // Truthy so the embed step is REACHED (order assertion needs it); with no
    // VOYAGE_API_KEY, embedReleasesForSource short-circuits without embedding.
    RELEASES_INDEX: {},
    // No LATEST_CACHE binding → invalidateLatestCache is a logged no-op, but the
    // step still runs (and is recorded) so we can assert it fires.
  };
}

describe("FirecrawlIngestWorkflow — post-insert step order (drift fixes)", () => {
  it("runs generate-content before embed-releases, then invalidate-latest-cache", async () => {
    const db = mkDb();
    const { names, step } = mkStepSpy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = new (FirecrawlIngestWorkflow as any)({}, mkEnv(db));

    await wf.run(
      {
        payload: {
          sourceId: "src_fc",
          url: "https://acme.example/changelog",
          checkId: "chk_1",
          status: "changed",
          // delta present → resolve-body returns it, no Firecrawl scrape.
          delta: "## Acme 2.0\n\nBig new release with real body content.",
        },
      },
      step,
    );

    // The row landed, so the post-insert steps all fire.
    const inserted = db.select().from(releases).where(eq(releases.sourceId, "src_fc")).all();
    expect(inserted.length).toBe(1);

    const gen = names.indexOf("generate-content");
    const embed = names.indexOf("embed-releases");
    const invalidate = names.indexOf("invalidate-latest-cache");
    const dedup = names.indexOf("dedup-insert");

    // Bug 1: generate-content precedes embed-releases (both present).
    expect(gen).toBeGreaterThanOrEqual(0);
    expect(embed).toBeGreaterThanOrEqual(0);
    expect(gen).toBeLessThan(embed);
    // Both run after the insert.
    expect(dedup).toBeGreaterThanOrEqual(0);
    expect(dedup).toBeLessThan(gen);

    // Bug 2: the latest-cache purge fires on an insert.
    expect(invalidate).toBeGreaterThanOrEqual(0);
  });

  it("skips generate/embed/invalidate when nothing is inserted (idempotent re-delivery)", async () => {
    const db = mkDb();
    // Pre-seed the release so the re-delivery dedups to zero inserts.
    db.insert(releases)
      .values({
        sourceId: "src_fc",
        title: "Acme 2.0",
        content: "Big new release with real body content.",
        url: "https://acme.example/changelog/acme-2-0",
      })
      .run();

    const { names, step } = mkStepSpy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = new (FirecrawlIngestWorkflow as any)({}, mkEnv(db));
    await wf.run(
      {
        payload: {
          sourceId: "src_fc",
          url: "https://acme.example/changelog",
          checkId: "chk_2",
          status: "changed",
          delta: "## Acme 2.0\n\nBig new release with real body content.",
        },
      },
      step,
    );

    expect(names).not.toContain("generate-content");
    expect(names).not.toContain("embed-releases");
    expect(names).not.toContain("invalidate-latest-cache");
    // Still records the run.
    expect(names).toContain("bookkeep");
  });
});
