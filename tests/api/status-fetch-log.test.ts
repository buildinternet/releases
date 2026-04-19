import { describe, it, expect } from "bun:test";
import { sources, organizations, fetchLog } from "@releases/core-internal/schema";
import { decodeCursor } from "../../workers/api/src/routes/fetch-log-cursor";
import { mkDb, mkApp } from "./status-fetch-log-helpers";

type Envelope = {
  entries: Array<{ id: string; status: string; createdAt: string }>;
  nextCursor: string | null;
  totalCount?: number;
  statusCounts?: { success: number; error: number; no_change: number; dry_run: number };
};

async function seed(
  db: any,
  count: number,
  status: "success" | "error" | "no_change" | "dry_run" = "success",
) {
  await db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" });
  await db.insert(sources).values({
    id: "src_1", name: "S", slug: "s", type: "feed", url: "https://x", orgId: "org_1",
  });
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `fl_${String(i).padStart(4, "0")}`,
    sourceId: "src_1",
    releasesFound: 0,
    releasesInserted: 0,
    status,
    createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, i)).toISOString(),
  }));
  await db.insert(fetchLog).values(rows);
}

describe("GET /v1/status/fetch-log", () => {
  it("returns envelope with entries, nextCursor, totalCount, statusCounts", async () => {
    const db = mkDb();
    await seed(db, 5);
    const app = mkApp(db);
    const res = await app.request("/v1/status/fetch-log?limit=3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.entries.length).toBe(3);
    expect(body.totalCount).toBe(5);
    expect(body.statusCounts).toEqual({ success: 5, error: 0, no_change: 0, dry_run: 0 });
    expect(body.nextCursor).not.toBeNull();
  });

  it("paginates via cursor until nextCursor is null", async () => {
    const db = mkDb();
    await seed(db, 5);
    const app = mkApp(db);
    const first = (await (await app.request("/v1/status/fetch-log?limit=3")).json()) as Envelope;
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await app.request(
        `/v1/status/fetch-log?limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`,
      )
    ).json()) as Envelope;
    expect(second.entries.length).toBe(2);
    expect(second.nextCursor).toBeNull();
    const ids1 = first.entries.map((e) => e.id);
    const ids2 = second.entries.map((e) => e.id);
    expect(ids1.some((i) => ids2.includes(i))).toBe(false);
  });

  it("omits totalCount and statusCounts on cursor pages", async () => {
    const db = mkDb();
    await seed(db, 5);
    const app = mkApp(db);
    const first = (await (await app.request("/v1/status/fetch-log?limit=3")).json()) as Envelope;
    const second = (await (
      await app.request(
        `/v1/status/fetch-log?limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`,
      )
    ).json()) as Envelope;
    expect(second.totalCount).toBeUndefined();
    expect(second.statusCounts).toBeUndefined();
  });

  it("filters entries by status but totalCount/statusCounts reflect full scope", async () => {
    const db = mkDb();
    await db.insert(organizations).values({ id: "org_1", name: "A", slug: "a" });
    await db.insert(sources).values({
      id: "src_1", name: "S", slug: "s", type: "feed", url: "https://x", orgId: "org_1",
    });
    await db.insert(fetchLog).values([
      { id: "fl_1", sourceId: "src_1", releasesFound: 0, releasesInserted: 0, status: "success", createdAt: "2026-04-01T00:00:00Z" },
      { id: "fl_2", sourceId: "src_1", releasesFound: 0, releasesInserted: 0, status: "success", createdAt: "2026-04-01T00:00:01Z" },
      { id: "fl_3", sourceId: "src_1", releasesFound: 0, releasesInserted: 0, status: "error", createdAt: "2026-04-01T00:00:02Z", error: "boom" },
    ]);
    const app = mkApp(db);
    const res = (await (await app.request("/v1/status/fetch-log?status=error&limit=10")).json()) as Envelope;
    expect(res.entries.length).toBe(1);
    expect(res.entries[0].status).toBe("error");
    expect(res.totalCount).toBe(3);
    expect(res.statusCounts).toEqual({ success: 2, error: 1, no_change: 0, dry_run: 0 });
  });

  it("emits a valid next cursor pointing at the last returned row", async () => {
    const db = mkDb();
    await seed(db, 3);
    const app = mkApp(db);
    const body = (await (await app.request("/v1/status/fetch-log?limit=2")).json()) as Envelope;
    const decoded = decodeCursor(body.nextCursor!);
    expect(decoded).not.toBeNull();
    const last = body.entries[body.entries.length - 1];
    expect(decoded!.id).toBe(last.id);
    expect(decoded!.createdAt).toBe(last.createdAt);
  });

  it("respects after/before and org filters in counts", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      { id: "org_1", name: "Acme", slug: "acme" },
      { id: "org_2", name: "Other", slug: "other" },
    ]);
    await db.insert(sources).values([
      { id: "src_1", name: "S1", slug: "s1", type: "feed", url: "https://a", orgId: "org_1" },
      { id: "src_2", name: "S2", slug: "s2", type: "feed", url: "https://b", orgId: "org_2" },
    ]);
    await db.insert(fetchLog).values([
      { id: "fl_1", sourceId: "src_1", releasesFound: 0, releasesInserted: 0, status: "success", createdAt: "2026-04-01T00:00:00Z" },
      { id: "fl_2", sourceId: "src_2", releasesFound: 0, releasesInserted: 0, status: "success", createdAt: "2026-04-01T00:00:01Z" },
      { id: "fl_3", sourceId: "src_1", releasesFound: 0, releasesInserted: 0, status: "error", createdAt: "2026-03-01T00:00:00Z" },
    ]);
    const app = mkApp(db);
    const body = (await (
      await app.request("/v1/status/fetch-log?org=acme&after=2026-03-15T00:00:00Z")
    ).json()) as Envelope;
    expect(body.totalCount).toBe(1);
    expect(body.entries.map((e) => e.id)).toEqual(["fl_1"]);
  });
});
