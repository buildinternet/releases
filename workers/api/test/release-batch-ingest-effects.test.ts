/**
 * `runBatchIngestEffects` — generate-before-embed on the HTTP `/batch` path.
 *
 * Poll already runs generate → embed via `runContentAndEmbedSteps`. `/batch`
 * (local ingest, discovery persist) used to embed immediately and never
 * summarize. These tests lock the new order + skip flags so a scrape persist
 * does not double-generate (DeterministicUpdate runs generate as a later step).
 *
 * The summarizer and embedder are injected (`generateContent` / `embedReleases`)
 * the same way `runGenerateContent` takes `deps.generate` — no `mock.module`,
 * no AI calls.
 */
import { describe, it, expect } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import {
  runBatchIngestEffects,
  type BatchEffectsEnv,
  type BatchEmbedRow,
  type BatchIngestResult,
} from "../src/lib/release-batch-ingest.js";
import type { D1Db } from "../src/db.js";
import { createTestDb, type TestDb } from "./setup";

const ORG_ID = "org_bfx00000000000000001";
const SRC_ID = "src_bfx00000000000000001";
const REL_ID = "rel_bfx00000000000000001";

async function seed(db: TestDb, opts: { autoGen?: boolean } = {}) {
  await db.insert(organizations).values({
    id: ORG_ID,
    slug: "batchco",
    name: "Batch Co",
    category: "developer-tools",
    autoGenerateContent: opts.autoGen ?? true,
  });
  await db.insert(sources).values({
    id: SRC_ID,
    orgId: ORG_ID,
    slug: "batchco-changelog",
    name: "Batch Co Changelog",
    type: "feed",
    url: "https://batchco.test/changelog",
  });
  await db.insert(releases).values({
    id: REL_ID,
    sourceId: SRC_ID,
    title: "v1.0.0",
    content: "Shipped the thing.",
    url: "https://batchco.test/changelog#v1",
    titleGenerated: null,
    summary: null,
  });
  const [src] = await db.select().from(sources).where(eq(sources.id, SRC_ID));
  return src as Source;
}

function resultOf(ids: string[] = [REL_ID]): BatchIngestResult {
  return {
    inserted: ids.length,
    total: ids.length,
    insertedIds: ids,
    visiblePublishRows: ids.map((id) => ({
      id,
      title: "v1.0.0",
      version: "1.0.0",
      publishedAt: null,
      media: null,
    })),
  };
}

const hubStub = {
  idFromName: () => "hub",
  get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
};
const bareEnv = { RELEASES_INDEX: {}, RELEASE_HUB: hubStub } as unknown as BatchEffectsEnv;

function makeGenerate(db: TestDb) {
  const calls: string[][] = [];
  const fn = async (_db: D1Db, _env: BatchEffectsEnv, _src: Source, ids: string[]) => {
    calls.push(ids);
    if (ids.length > 0) {
      await db
        .update(releases)
        .set({ titleGenerated: "GEN", titleShort: "G", summary: "generated summary" })
        .where(inArray(releases.id, ids));
    }
    return ids.length;
  };
  return { fn, calls };
}

describe("runBatchIngestEffects generate-before-embed", () => {
  it("runs generate before embed and embed sees the new summary", async () => {
    const db = createTestDb();
    const src = await seed(db);
    const g = makeGenerate(db);
    const order: string[] = [];
    let embedded: BatchEmbedRow[] = [];

    await runBatchIngestEffects(db as unknown as D1Db, bareEnv, src, resultOf(), {
      skipInvalidate: true,
      generateContent: async (d, e, s, ids) => {
        order.push("generate");
        return g.fn(d, e, s, ids);
      },
      embedReleases: async (rows) => {
        order.push("embed");
        embedded = rows;
      },
    });

    expect(order).toEqual(["generate", "embed"]);
    expect(g.calls).toEqual([[REL_ID]]);
    expect(embedded).toHaveLength(1);
    expect(embedded[0]!.id).toBe(REL_ID);
    expect(embedded[0]!.summary).toBe("generated summary");
  });

  it("skips generate when skipSummarize is set", async () => {
    const db = createTestDb();
    const src = await seed(db);
    const g = makeGenerate(db);
    const order: string[] = [];

    await runBatchIngestEffects(db as unknown as D1Db, bareEnv, src, resultOf(), {
      skipInvalidate: true,
      skipSummarize: true,
      generateContent: async (d, e, s, ids) => {
        order.push("generate");
        return g.fn(d, e, s, ids);
      },
      embedReleases: async () => {
        order.push("embed");
      },
    });

    expect(order).toEqual(["embed"]);
    expect(g.calls).toEqual([]);
    const [row] = await db.select().from(releases).where(eq(releases.id, REL_ID));
    expect(row!.titleGenerated).toBeNull();
    expect(row!.summary).toBeNull();
  });

  it("skips generate and embed when insertedIds is empty", async () => {
    const db = createTestDb();
    const src = await seed(db);
    const g = makeGenerate(db);
    let embedCalled = false;

    await runBatchIngestEffects(
      db as unknown as D1Db,
      bareEnv,
      src,
      { inserted: 0, total: 0, insertedIds: [], visiblePublishRows: [] },
      {
        skipInvalidate: true,
        generateContent: g.fn,
        embedReleases: async () => {
          embedCalled = true;
        },
      },
    );

    expect(g.calls).toEqual([]);
    expect(embedCalled).toBe(false);
  });

  it("still embeds when generate throws", async () => {
    const db = createTestDb();
    const src = await seed(db);
    const order: string[] = [];

    await runBatchIngestEffects(db as unknown as D1Db, bareEnv, src, resultOf(), {
      skipInvalidate: true,
      generateContent: async () => {
        order.push("generate");
        throw new Error("summarizer down");
      },
      embedReleases: async (rows) => {
        order.push("embed");
        expect(rows[0]!.summary).toBeNull();
      },
    });

    expect(order).toEqual(["generate", "embed"]);
  });
});
