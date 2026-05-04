import { describe, it, expect } from "bun:test";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { mkDb, mkApp } from "./admin-cron-runs-helpers";

describe("GET /admin/cron-runs", () => {
  it("returns rows for the named cron ordered by startedAt desc", async () => {
    const db = mkDb();
    await db.insert(cronRuns).values([
      {
        id: "crun_1",
        cronName: "scrape-agent-sweep",
        startedAt: "2026-04-17T01:00:00Z",
        status: "done",
        candidates: 5,
        dispatched: 5,
      },
      {
        id: "crun_2",
        cronName: "scrape-agent-sweep",
        startedAt: "2026-04-18T01:00:00Z",
        status: "done",
        candidates: 3,
        dispatched: 3,
      },
      { id: "crun_3", cronName: "retier", startedAt: "2026-04-18T03:00:00Z", status: "done" },
    ]);

    const app = mkApp(db);
    const res = await app.request(
      "/admin/cron-runs?cron=scrape-agent-sweep&limit=50&since=2000-01-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((r) => r.id)).toEqual(["crun_2", "crun_1"]);
  });

  it("filters by status CSV", async () => {
    const db = mkDb();
    await db.insert(cronRuns).values([
      {
        id: "crun_1",
        cronName: "scrape-agent-sweep",
        startedAt: "2026-04-17T01:00:00Z",
        status: "done",
      },
      {
        id: "crun_2",
        cronName: "scrape-agent-sweep",
        startedAt: "2026-04-18T01:00:00Z",
        status: "degraded",
      },
      {
        id: "crun_3",
        cronName: "scrape-agent-sweep",
        startedAt: "2026-04-18T02:00:00Z",
        status: "aborted",
      },
    ]);

    const app = mkApp(db);
    const res = await app.request(
      "/admin/cron-runs?status=degraded,aborted&since=2000-01-01T00:00:00Z",
    );
    const body = (await res.json()) as Array<{ status: string }>;
    expect(body.map((r) => r.status).toSorted()).toEqual(["aborted", "degraded"]);
  });

  it("wraps the response in the canonical ListResponse envelope when ?envelope=true", async () => {
    const db = mkDb();
    await db.insert(cronRuns).values([
      { id: "crun_1", cronName: "retier", startedAt: "2026-04-18T01:00:00Z", status: "done" },
      { id: "crun_2", cronName: "retier", startedAt: "2026-04-18T02:00:00Z", status: "done" },
    ]);

    const app = mkApp(db);
    const res = await app.request(
      "/admin/cron-runs?cron=retier&limit=2&since=2000-01-01T00:00:00Z&envelope=true",
    );
    const body = (await res.json()) as {
      items: Array<{ id: string }>;
      pagination: { page: number; pageSize: number; returned: number; hasMore: boolean };
    };
    expect(body.items.map((r) => r.id).toSorted()).toEqual(["crun_1", "crun_2"]);
    expect(body.pagination).toMatchObject({ page: 1, pageSize: 2, returned: 2, hasMore: true });
  });
});
