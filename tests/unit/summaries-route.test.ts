import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import summariesRoutes from "../../workers/api/src/routes/summaries.js";
import { organizations, sources, releaseSummaries } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

function makeEnv() {
  return { DB: testDb.db as unknown as never };
}

async function post(body: unknown, init?: { contentType?: string }): Promise<Response> {
  return summariesRoutes.request(
    "/sources/acme-foo/summaries",
    {
      method: "POST",
      headers: { "content-type": init?.contentType ?? "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    makeEnv(),
  );
}

async function seedSource() {
  await testDb.db.insert(organizations).values({
    id: "org_acme",
    name: "Acme",
    slug: "acme",
    discovery: "curated",
  });
  await testDb.db.insert(sources).values({
    id: "src_acme_foo",
    name: "Acme Foo",
    slug: "acme-foo",
    type: "github",
    url: "https://github.com/acme/foo",
    orgId: "org_acme",
    discovery: "curated",
  });
}

describe("POST /v1/sources/:slug/summaries (validator pilot)", () => {
  test("upserts a rolling summary when body is valid", async () => {
    await seedSource();
    const res = await post({
      type: "rolling",
      summary: "Last 30 days: 3 features and 1 fix.",
      releaseCount: 4,
      windowDays: 30,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await testDb.db
      .select()
      .from(releaseSummaries)
      .where(eq(releaseSummaries.sourceId, "src_acme_foo"));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("rolling");
    expect(rows[0].releaseCount).toBe(4);
    expect(rows[0].windowDays).toBe(30);
  });

  test("400 with bad_request envelope on missing required field", async () => {
    await seedSource();
    const res = await post({ summary: "...", releaseCount: 1 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message.toLowerCase()).toContain("type");
  });

  test("400 with bad_request envelope when month is out of range", async () => {
    await seedSource();
    const res = await post({
      type: "monthly",
      summary: "April",
      releaseCount: 2,
      year: 2026,
      month: 13,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("month");
  });

  test("400 when windowDays is zero or negative", async () => {
    await seedSource();
    const res = await post({
      type: "rolling",
      summary: "weekly",
      releaseCount: 0,
      windowDays: 0,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("windowDays");
  });

  test("400 when releaseCount is not an integer", async () => {
    await seedSource();
    const res = await post({
      type: "rolling",
      summary: "non-int count",
      releaseCount: 1.5,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("releaseCount");
  });

  test("404 when source is unknown (validator passed, lookup failed)", async () => {
    const res = await post({
      type: "rolling",
      summary: "ok",
      releaseCount: 1,
    });
    expect(res.status).toBe(404);
  });
});
