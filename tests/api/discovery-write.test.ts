/**
 * Tests for the discovery write path (#1317):
 * PATCH /v1/orgs/:slug and PATCH /v1/orgs/:slug/sources/:slug both accept
 * a `discovery` field and persist it to the database.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { orgRoutes } from "../../workers/api/src/routes/orgs.js";
import { sourceRoutes } from "../../workers/api/src/routes/sources.js";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { makeJsonCaller } from "./route-test-helpers.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

const callOrg = makeJsonCaller(orgRoutes, () => ({ DB: testDb.db as unknown as never }));
const callSource = makeJsonCaller(sourceRoutes, () => ({ DB: testDb.db as unknown as never }));

async function seedOrg(slug = "acme", discovery: "curated" | "agent" | "on_demand" = "on_demand") {
  await testDb.db.insert(organizations).values({
    id: `org_${slug}`,
    name: slug,
    slug,
    discovery,
  });
}

async function seedSource(
  id: string,
  slug: string,
  orgSlug: string,
  discovery: "curated" | "agent" | "on_demand" = "on_demand",
) {
  await testDb.db.insert(sources).values({
    id,
    orgId: `org_${orgSlug}`,
    slug,
    name: slug,
    url: `https://example.com/${slug}`,
    type: "github",
    metadata: "{}",
    discovery,
  });
}

describe("PATCH /v1/orgs/:slug { discovery }", () => {
  it("promotes on_demand org to curated", async () => {
    await seedOrg("acme", "on_demand");

    const res = await callOrg("/orgs/acme", "PATCH", { discovery: "curated" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.discovery).toBe("curated");

    // Read back from DB to confirm persistence
    const [row] = await testDb.db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, "acme"));
    expect(row.discovery).toBe("curated");
  });

  it("demotes curated org to on_demand", async () => {
    await seedOrg("acme2", "curated");

    const res = await callOrg("/orgs/acme2", "PATCH", { discovery: "on_demand" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.discovery).toBe("on_demand");
  });

  it("rejects an invalid discovery value", async () => {
    await seedOrg("acme3", "curated");

    const res = await callOrg("/orgs/acme3", "PATCH", { discovery: "invalid_value" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /v1/orgs/:slug/sources/:slug { discovery }", () => {
  it("promotes on_demand source to curated", async () => {
    await seedOrg("acme", "curated");
    await seedSource("src_test", "acme-gh", "acme", "on_demand");

    const res = await callSource("/orgs/acme/sources/acme-gh", "PATCH", {
      discovery: "curated",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.discovery).toBe("curated");

    // Read back from DB to confirm persistence
    const [row] = await testDb.db.select().from(sources).where(eq(sources.slug, "acme-gh"));
    expect(row.discovery).toBe("curated");
  });

  it("demotes curated source to on_demand", async () => {
    await seedOrg("acme4", "curated");
    await seedSource("src_test2", "acme-gh2", "acme4", "curated");

    const res = await callSource("/orgs/acme4/sources/acme-gh2", "PATCH", {
      discovery: "on_demand",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.discovery).toBe("on_demand");
  });

  it("rejects an invalid discovery value", async () => {
    await seedOrg("acme5", "curated");
    await seedSource("src_test3", "acme-gh3", "acme5", "curated");

    const res = await callSource("/orgs/acme5/sources/acme-gh3", "PATCH", {
      discovery: "bad_value",
    });
    expect(res.status).toBe(400);
  });
});
