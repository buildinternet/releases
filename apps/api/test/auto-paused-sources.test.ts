import { describe, expect, it } from "bun:test";
import { organizations, sources, fetchLog } from "@buildinternet/releases-core/schema";
import type { AutoPausedSourcesResponse } from "@buildinternet/releases-api-types";
import { createTestDb, type TestDb } from "../../../tests/db-helper";
import { createTestApp } from "./setup";
import { listAutoPausedSources } from "../src/queries/auto-paused-sources.js";
import { adminSourcesRoutes } from "../src/routes/admin-sources.js";
import type { D1Db } from "../src/db.js";

const NOW = new Date("2026-11-27T12:00:00.000Z");

async function addOrg(db: TestDb) {
  await db.insert(organizations).values({
    id: "org_a",
    slug: "acme",
    name: "Acme",
    category: "developer-tools",
  });
}

async function addSource(
  db: TestDb,
  id: string,
  slug: string,
  fields: {
    fetchPriority?: "normal" | "paused";
    pausedReason?: "manual" | "unproductive_drains" | "extraction_errors" | null;
    pausedAt?: string | null;
    unproductiveDrains?: number;
  },
) {
  await db.insert(sources).values({
    id,
    orgId: "org_a",
    slug,
    name: slug,
    url: `https://${slug}.test/changelog`,
    type: "scrape",
    fetchPriority: fields.fetchPriority ?? "paused",
    pausedReason: fields.pausedReason ?? null,
    pausedAt: fields.pausedAt ?? null,
    unproductiveDrains: fields.unproductiveDrains ?? 0,
  });
}

describe("listAutoPausedSources", () => {
  it("returns auto-pauses from the window with the latest fetch counts", async () => {
    const { db } = createTestDb();
    await addOrg(db);
    await addSource(db, "src_recent", "recent", {
      pausedReason: "unproductive_drains",
      pausedAt: "2026-11-25T10:06:00.000Z",
      unproductiveDrains: 5,
    });
    await addSource(db, "src_errors", "errors", {
      pausedReason: "extraction_errors",
      pausedAt: "2026-11-22T00:00:00.000Z",
      unproductiveDrains: 0,
    });
    await addSource(db, "src_old", "old", {
      pausedReason: "unproductive_drains",
      pausedAt: "2026-11-01T00:00:00.000Z",
      unproductiveDrains: 5,
    });
    await addSource(db, "src_manual", "manual", {
      pausedReason: "manual",
      pausedAt: "2026-11-26T00:00:00.000Z",
    });
    await addSource(db, "src_live", "live", { fetchPriority: "normal" });

    await db.insert(fetchLog).values([
      {
        id: "fl_old",
        sourceId: "src_recent",
        releasesFound: 0,
        releasesInserted: 0,
        status: "no_change",
        createdAt: "2026-11-24T00:00:00.000Z",
      },
      {
        id: "fl_dry",
        sourceId: "src_recent",
        releasesFound: 99,
        releasesInserted: 99,
        status: "dry_run",
        createdAt: "2026-11-26T00:00:00.000Z",
      },
      {
        id: "fl_new",
        sourceId: "src_recent",
        releasesFound: 0,
        releasesInserted: 0,
        status: "no_change",
        createdAt: "2026-11-25T10:00:00.000Z",
      },
    ]);

    const result = await listAutoPausedSources(db as unknown as D1Db, { days: 7, now: NOW });

    expect(result.since).toBe("2026-11-20T12:00:00.000Z");
    expect(result.sources.map((s) => s.sourceSlug)).toEqual(["recent", "errors"]);
    const recent = result.sources[0]!;
    expect(recent.pausedReason).toBe("unproductive_drains");
    expect(recent.pausedAt).toBe("2026-11-25T10:06:00.000Z");
    expect(recent.unproductiveDrains).toBe(5);
    expect(recent.orgSlug).toBe("acme");
    expect(recent.lastReleasesFound).toBe(0);
    expect(recent.lastReleasesInserted).toBe(0);
    expect(recent.lastFetchAt).toBe("2026-11-25T10:00:00.000Z");
    expect(recent.lastFetchStatus).toBe("no_change");
  });
});

describe("GET /v1/admin/sources/auto-paused", () => {
  it("lists the week's auto-pauses", async () => {
    const { db } = createTestDb();
    await addOrg(db);
    await addSource(db, "src_recent", "recent", {
      pausedReason: "unproductive_drains",
      pausedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      unproductiveDrains: 5,
    });
    const app = createTestApp(db, adminSourcesRoutes);
    const res = await app(new Request("https://x.test/v1/admin/sources/auto-paused?days=7"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AutoPausedSourcesResponse;
    expect(body.days).toBe(7);
    expect(body.truncated).toBe(false);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]?.sourceSlug).toBe("recent");
    expect(body.sources[0]?.pausedReason).toBe("unproductive_drains");
  });
});
