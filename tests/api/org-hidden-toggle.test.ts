import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, createTestDb, type TestDatabase } from "../db-helper";
import { organizations } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../../workers/api/src/routes/orgs.js";

describe("organizations.is_hidden column", () => {
  it("defaults to false and round-trips true", async () => {
    const sqlite = new Database(":memory:");
    try {
      applyMigrations(sqlite);
      const db = drizzle(sqlite);

      await db
        .insert(organizations)
        .values([
          { id: "org_default", slug: "default-org", name: "Default" },
          { id: "org_hidden", slug: "hidden-org", name: "Hidden", isHidden: true },
        ])
        .run();

      const [def] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, "org_default"));
      const [hid] = await db.select().from(organizations).where(eq(organizations.id, "org_hidden"));

      expect(def.isHidden).toBe(false);
      expect(hid.isHidden).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});

let testDb: TestDatabase;
beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.cleanup();
});

const noopCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

async function call(path: string, method: string, body?: unknown): Promise<Response> {
  return orgRoutes.request(
    path,
    {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { DB: testDb.db as unknown as never },
    noopCtx as unknown as Parameters<typeof orgRoutes.request>[3],
  );
}

describe("PATCH /v1/orgs/:slug { isHidden }", () => {
  it("hides and persists, and the org stays reachable via detail", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });

    const patched = await call("/orgs/acme", "PATCH", { isHidden: true });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { isHidden: boolean }).isHidden).toBe(true);

    // Reachability regression: the detail endpoint still returns the org.
    const detail = await call("/orgs/acme", "GET");
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { slug: string; isHidden: boolean }).isHidden).toBe(true);
  });

  it("unhides", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme2",
      name: "Acme 2",
      slug: "acme2",
      discovery: "curated",
      isHidden: true,
    });

    const res = await call("/orgs/acme2", "PATCH", { isHidden: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { isHidden: boolean }).isHidden).toBe(false);
  });
});
