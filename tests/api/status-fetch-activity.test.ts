import { describe, expect, it } from "bun:test";
import { sources, organizations, fetchLog, orgAccounts } from "@buildinternet/releases-core/schema";
import { mkDb, mkApp } from "./status-fetch-log-helpers";

async function seedActivity(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values([
    { id: "org_1", name: "Acme", slug: "acme", avatarUrl: "https://example.com/a.png" },
    { id: "org_2", name: "Beta", slug: "beta" },
  ]);
  await db.insert(orgAccounts).values({
    id: "oa_1",
    orgId: "org_1",
    platform: "github",
    handle: "acme",
  });
  await db.insert(sources).values([
    {
      id: "src_1",
      name: "Acme CL",
      slug: "acme-cl",
      type: "feed",
      url: "https://acme.example/cl",
      orgId: "org_1",
    },
    {
      id: "src_2",
      name: "Beta CL",
      slug: "beta-cl",
      type: "feed",
      url: "https://beta.example/cl",
      orgId: "org_2",
    },
  ]);

  // Two hours of activity on 2026-04-01 UTC.
  await db.insert(fetchLog).values([
    // 10:00 hour — mostly no_change, one success for acme
    {
      id: "fl_100",
      sourceId: "src_1",
      releasesFound: 1,
      releasesInserted: 1,
      status: "success",
      createdAt: "2026-04-01T10:15:00.000Z",
    },
    {
      id: "fl_101",
      sourceId: "src_1",
      releasesFound: 0,
      releasesInserted: 0,
      status: "no_change",
      createdAt: "2026-04-01T10:20:00.000Z",
    },
    {
      id: "fl_102",
      sourceId: "src_2",
      releasesFound: 0,
      releasesInserted: 0,
      status: "no_change",
      createdAt: "2026-04-01T10:25:00.000Z",
    },
    // 11:00 hour — error for beta, success for acme
    {
      id: "fl_110",
      sourceId: "src_2",
      releasesFound: 0,
      releasesInserted: 0,
      status: "error",
      error: "timeout",
      createdAt: "2026-04-01T11:05:00.000Z",
    },
    {
      id: "fl_111",
      sourceId: "src_1",
      releasesFound: 2,
      releasesInserted: 2,
      status: "success",
      createdAt: "2026-04-01T11:40:00.000Z",
    },
  ]);
}

type ActivityBody = {
  bucket: "hour" | "day";
  after: string;
  before: string;
  buckets: Array<{
    t: string;
    success: number;
    error: number;
    no_change: number;
    total: number;
    releasesInserted: number;
    topOrgs: Array<{ slug: string; name: string; githubHandle: string | null; count: number }>;
    orgCount: number;
  }>;
};

describe("GET /v1/status/fetch-activity", () => {
  it("returns continuous hourly buckets with status counts and topOrgs", async () => {
    const db = mkDb();
    await seedActivity(db);
    const app = mkApp(db);
    const res = await app.request(
      "/v1/status/fetch-activity?after=2026-04-01T10:00:00.000Z&before=2026-04-01T11:59:00.000Z&bucket=hour",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActivityBody;
    expect(body.bucket).toBe("hour");
    expect(body.buckets.length).toBe(2);

    const h10 = body.buckets.find((b) => b.t.startsWith("2026-04-01T10:"));
    const h11 = body.buckets.find((b) => b.t.startsWith("2026-04-01T11:"));
    expect(h10).toBeDefined();
    expect(h11).toBeDefined();

    expect(h10!.success).toBe(1);
    expect(h10!.no_change).toBe(2);
    expect(h10!.total).toBe(3);
    expect(h10!.releasesInserted).toBe(1);
    // Facepile is signal-only (no_change excluded) — only acme success.
    expect(h10!.orgCount).toBe(1);
    expect(h10!.topOrgs.map((o) => o.slug)).toEqual(["acme"]);
    // Facepile skips the org_accounts join for cost; avatar_url is enough.
    expect(h10!.topOrgs[0]!.avatarUrl).toBe("https://example.com/a.png");

    expect(h11!.success).toBe(1);
    expect(h11!.error).toBe(1);
    expect(h11!.total).toBe(2);
    expect(h11!.releasesInserted).toBe(2);
    expect(h11!.orgCount).toBe(2);
    expect(new Set(h11!.topOrgs.map((o) => o.slug))).toEqual(new Set(["acme", "beta"]));
  });

  it("fills zero buckets across a sparse range", async () => {
    const db = mkDb();
    await seedActivity(db);
    const app = mkApp(db);
    const res = await app.request(
      "/v1/status/fetch-activity?after=2026-04-01T09:00:00.000Z&before=2026-04-01T12:30:00.000Z&bucket=hour",
    );
    const body = (await res.json()) as ActivityBody;
    // 09, 10, 11, 12
    expect(body.buckets.length).toBe(4);
    expect(body.buckets[0]!.total).toBe(0);
    expect(body.buckets[3]!.total).toBe(0);
  });

  it("day bucket collapses the same window", async () => {
    const db = mkDb();
    await seedActivity(db);
    const app = mkApp(db);
    const res = await app.request(
      "/v1/status/fetch-activity?after=2026-04-01T00:00:00.000Z&before=2026-04-01T23:59:00.000Z&bucket=day",
    );
    const body = (await res.json()) as ActivityBody;
    expect(body.bucket).toBe("day");
    expect(body.buckets.length).toBe(1);
    expect(body.buckets[0]!.success).toBe(2);
    expect(body.buckets[0]!.error).toBe(1);
    expect(body.buckets[0]!.no_change).toBe(2);
    expect(body.buckets[0]!.releasesInserted).toBe(3);
  });
});

describe("GET /v1/status/fetch-log?excludeStatus=", () => {
  it("drops excluded statuses from the page and statusCounts", async () => {
    const db = mkDb();
    await seedActivity(db);
    const app = mkApp(db);
    const res = await app.request(
      "/v1/status/fetch-log?after=2026-04-01T00:00:00.000Z&excludeStatus=no_change&limit=50",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ status: string }>;
      totalCount?: number;
      statusCounts?: Record<string, number>;
    };
    expect(body.entries.every((e) => e.status !== "no_change")).toBe(true);
    expect(body.totalCount).toBe(3); // 2 success + 1 error
    expect(body.statusCounts?.no_change).toBe(0);
    expect(body.statusCounts?.success).toBe(2);
    expect(body.statusCounts?.error).toBe(1);
  });
});
