import { describe, it, expect } from "bun:test";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { fetchLog, organizations, sources } from "@buildinternet/releases-core/schema";
import { mkDb, mkApp } from "./admin-cron-runs-helpers";

describe("GET /v1/admin/cron-runs/:id", () => {
  it("returns 404 for unknown id", async () => {
    const db = mkDb();
    const app = mkApp(db);
    const res = await app.request("/v1/admin/cron-runs/crun_missing");
    expect(res.status).toBe(404);
  });

  it("inlines fetch-log status breakdown per session", async () => {
    const db = mkDb();

    // Seed org + sources required by fetchLog FK
    db.insert(organizations)
      .values({ id: "org_test", slug: "test-org", name: "Test Org", category: "developer-tools" })
      .run();
    db.insert(sources)
      .values([
        {
          id: "src_1",
          slug: "s-1",
          name: "S1",
          type: "scrape",
          orgId: "org_test",
          url: "https://example.com/1",
        },
        {
          id: "src_2",
          slug: "s-2",
          name: "S2",
          type: "scrape",
          orgId: "org_test",
          url: "https://example.com/2",
        },
        {
          id: "src_3",
          slug: "s-3",
          name: "S3",
          type: "scrape",
          orgId: "org_test",
          url: "https://example.com/3",
        },
      ])
      .run();

    await db.insert(cronRuns).values({
      id: "crun_1",
      cronName: "scrape-agent-sweep",
      startedAt: "2026-04-18T01:00:00Z",
      endedAt: "2026-04-18T01:00:02Z",
      durationMs: 2000,
      status: "done",
      candidates: 2,
      dispatched: 2,
      skippedOverCap: 0,
      dispatchErrors: 0,
      sessionsStarted: JSON.stringify(["ma-1", "ma-2"]),
      dispatchErrorDetail: null,
    });

    await db.insert(fetchLog).values([
      {
        sourceId: "src_1",
        sessionId: "ma-1",
        status: "success",
        releasesFound: 3,
        releasesInserted: 3,
        durationMs: 500,
      },
      {
        sourceId: "src_2",
        sessionId: "ma-1",
        status: "error",
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: 800,
        error: "boom",
      },
      {
        sourceId: "src_3",
        sessionId: "ma-2",
        status: "no_change",
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: 400,
      },
    ] as any);

    const app = mkApp(db);
    const res = await app.request("/v1/admin/cron-runs/crun_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: any;
      sessionBreakdown: Record<string, Record<string, number>>;
    };
    expect(body.run.id).toBe("crun_1");
    expect(body.sessionBreakdown["ma-1"]).toEqual({ success: 1, error: 1 });
    expect(body.sessionBreakdown["ma-2"]).toEqual({ no_change: 1 });
  });
});
