// Detail fields the CLI reads off the wire: org `createdAt`/`updatedAt`
// (`releases org get`) and source `fetchPriority` (`releases source show`).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { makeCaller } from "./route-test-helpers.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

const env = () => ({ DB: testDb.db as unknown as never, MEDIA_ORIGIN: "" });
const callOrg = makeCaller(orgRoutes, env);
const callSource = makeCaller(sourceRoutes, env);

async function seed() {
  await testDb.db.insert(organizations).values({
    id: "org_acme",
    slug: "acme",
    name: "Acme",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
  });
  await testDb.db.insert(sources).values({
    id: "src_acme",
    orgId: "org_acme",
    slug: "acme-changelog",
    name: "Acme Changelog",
    type: "scrape",
    url: "https://acme.test/changelog",
    fetchPriority: "paused",
    pausedReason: "unproductive_drains",
    pausedAt: "2026-11-25T10:06:00.000Z",
    unproductiveDrains: 5,
    metadata: "{}",
  });
}

describe("entity detail fields", () => {
  it("org detail carries createdAt and updatedAt", async () => {
    await seed();
    const res = await callOrg("/orgs/acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; createdAt?: string; updatedAt?: string };
    expect(body.id).toBe("org_acme");
    expect(body.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(body.updatedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("source detail carries fetchPriority and the recorded pause", async () => {
    await seed();
    const res = await callSource("/sources/src_acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fetchPriority?: string | null;
      pausedReason?: string | null;
      pausedAt?: string | null;
      unproductiveDrains?: number | null;
    };
    expect(body.fetchPriority).toBe("paused");
    expect(body.pausedReason).toBe("unproductive_drains");
    expect(body.pausedAt).toBe("2026-11-25T10:06:00.000Z");
    expect(body.unproductiveDrains).toBe(5);
  });

  it("source list carries the recorded pause", async () => {
    await seed();
    const res = await callSource("/sources");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      pausedReason?: string | null;
      pausedAt?: string | null;
      unproductiveDrains?: number | null;
    }>;
    const row = body.find((s) => s.id === "src_acme");
    expect(row?.pausedReason).toBe("unproductive_drains");
    expect(row?.pausedAt).toBe("2026-11-25T10:06:00.000Z");
    expect(row?.unproductiveDrains).toBe(5);
  });
});
