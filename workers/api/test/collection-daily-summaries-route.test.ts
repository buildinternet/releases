import { describe, it, expect } from "bun:test";
import { collections, collectionDailySummaries } from "@buildinternet/releases-core/schema";
import { collectionRoutes } from "../src/routes/collections.js";
import { workflowsRoutes } from "../src/routes/workflows.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, collectionRoutes);

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(collections).values([
    {
      id: "col_ds_test",
      slug: "ds-test-collection",
      name: "DS Test Collection",
    },
  ]);
  await db.insert(collectionDailySummaries).values([
    {
      id: "cds_test_a",
      collectionId: "col_ds_test",
      summaryDate: "2026-06-10",
      title: "Day summary June 10",
      summary: "Summary text for June 10.",
      takeaways: JSON.stringify(["Takeaway one", "Takeaway two"]),
      releaseCount: 3,
      generatedAt: "2026-06-11T05:00:00.000Z",
      updatedAt: "2026-06-11T05:00:00.000Z",
    },
    {
      id: "cds_test_b",
      collectionId: "col_ds_test",
      summaryDate: "2026-06-11",
      title: "Day summary June 11",
      summary: "Summary text for June 11.",
      takeaways: JSON.stringify(["Alpha", "Beta", "Gamma"]),
      releaseCount: 5,
      generatedAt: "2026-06-12T05:00:00.000Z",
      updatedAt: "2026-06-12T05:00:00.000Z",
    },
  ]);
}

describe("GET /v1/collections/:slug/daily-summaries", () => {
  it("returns summaries newest-first with parsed takeaways", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "http://test/v1/collections/ds-test-collection/daily-summaries?from=2026-06-01&to=2026-06-30",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.summaries)).toBe(true);
    // Newest-first ordering: June 11 before June 10
    const dates = body.summaries.map((s: { date: string }) => s.date);
    expect(dates).toEqual(["2026-06-11", "2026-06-10"]);
    // Takeaways are parsed arrays, not raw JSON strings
    expect(body.summaries[0].takeaways).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(body.summaries[1].takeaways).toEqual(["Takeaway one", "Takeaway two"]);
    // releaseCount carried through
    expect(body.summaries[0].releaseCount).toBe(5);
    expect(body.summaries[1].releaseCount).toBe(3);
  });

  it("returns 404 for an unknown collection slug", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("http://test/v1/collections/nope/daily-summaries"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe("not_found");
  });

  it("returns 400 for a malformed from/to date", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("http://test/v1/collections/ds-test-collection/daily-summaries?from=garbage"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("bad_date");
  });

  it("returns an empty summaries array when no rows match the window", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "http://test/v1/collections/ds-test-collection/daily-summaries?from=2026-01-01&to=2026-01-31",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.summaries).toEqual([]);
  });
});

describe("PATCH /v1/collections/:slug (dailySummaryEnabled toggle)", () => {
  it("persists dailySummaryEnabled: false and round-trips it in the response", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "http://test/v1/collections/ds-test-collection",
        json("PATCH", { dailySummaryEnabled: false }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.dailySummaryEnabled).toBe(false);
  });

  it("can re-enable dailySummaryEnabled", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    // Disable first
    await fetch(
      new Request(
        "http://test/v1/collections/ds-test-collection",
        json("PATCH", { dailySummaryEnabled: false }),
      ),
    );
    // Re-enable
    const res = await fetch(
      new Request(
        "http://test/v1/collections/ds-test-collection",
        json("PATCH", { dailySummaryEnabled: true }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.dailySummaryEnabled).toBe(true);
  });
});

describe("POST /v1/workflows/collection-summaries", () => {
  // The admin-auth gate for /v1/workflows/* lives in the worker's index.ts
  // (the `workflows` namespace in route-namespaces.ts), not in the route
  // module — so mounting workflowsRoutes directly under /v1 here is the same
  // harness the sibling workflows route tests use. The dryRun path is checked
  // before model resolution, so it returns 200 with no model bound.
  it("dryRun: true returns 200 with the resolved date and no model required", async () => {
    const db = mkDb();
    const fetch = createTestApp(db, workflowsRoutes);

    const res = await fetch(
      new Request(
        "http://test/v1/workflows/collection-summaries",
        json("POST", { date: "2026-06-11", dryRun: true }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({
      date: "2026-06-11",
      dryRun: true,
      collectionId: undefined,
      force: false,
    });
  });

  it("returns 400 for a malformed date", async () => {
    const db = mkDb();
    const fetch = createTestApp(db, workflowsRoutes);

    const res = await fetch(
      new Request(
        "http://test/v1/workflows/collection-summaries",
        json("POST", { date: "2026-13-99", dryRun: true }),
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("bad_date");
  });

  it("dryRun: true echoes force: true", async () => {
    const db = mkDb();
    const fetch = createTestApp(db, workflowsRoutes);

    const res = await fetch(
      new Request(
        "http://test/v1/workflows/collection-summaries",
        json("POST", { date: "2026-06-11", dryRun: true, force: true }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.force).toBe(true);
  });

  it("dryRun: true echoes the collectionId scope", async () => {
    const db = mkDb();
    const fetch = createTestApp(db, workflowsRoutes);

    const res = await fetch(
      new Request(
        "http://test/v1/workflows/collection-summaries",
        json("POST", { date: "2026-06-11", dryRun: true, collectionId: "col_xyz" }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.collectionId).toBe("col_xyz");
    expect(body.dryRun).toBe(true);
  });
});
