import { describe, it, expect } from "bun:test";
import type { RawRelease } from "@releases/adapters/types.js";
import {
  runSourceBackfill,
  effectiveBackfillWindows,
  firecrawlCapGuidance,
  FIRECRAWL_BACKFILL_MAX_WINDOWS,
  type SourceBackfillDeps,
} from "./source-backfill.js";

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
