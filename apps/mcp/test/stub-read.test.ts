/**
 * MCP read surface for stub-tier orgs (#1947): get_organization and
 * lookup_domain render the stub status + its declared release locations
 * instead of an empty sources list, and list_organizations badges stubs.
 */
import { describe, it, expect } from "bun:test";
import { organizations, releaseLocations } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../tests/db-helper";
import { getOrganization, lookupDomain, listOrganizations } from "../src/tools";

const now = "2026-07-05T00:00:00.000Z";

function seedStub(db: ReturnType<typeof createTestDb>["db"]) {
  return (async () => {
    await db.insert(organizations).values({
      id: "org_s",
      name: "Stubby",
      slug: "stubby",
      domain: "stubby.com",
      tier: "stub",
    });
    await db.insert(releaseLocations).values({
      id: "loc_1",
      orgId: "org_s",
      feed: "https://stubby.com/feed.xml",
      canonical: true,
      basis: "declared",
      matchKey: "feed:https://stubby.com/feed.xml",
      createdAt: now,
      updatedAt: now,
    });
  })();
}

function firstText(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => c.text ?? "").join("\n");
}

describe("MCP stub read surface", () => {
  it("get_organization renders stub status + declared locations, not empty sources", async () => {
    const { db } = createTestDb();
    await seedStub(db);
    const out = firstText(await getOrganization(db as never, { identifier: "stubby" }));
    expect(out).toContain("Status: stub");
    expect(out).toContain("Declared release locations");
    expect(out).toContain("stubby.com/feed.xml");
    expect(out).not.toContain("Sources: none");
  });

  it("lookup_domain surfaces the stub status + locations", async () => {
    const { db } = createTestDb();
    await seedStub(db);
    const out = firstText(await lookupDomain(db as never, { domain: "stubby.com" }));
    expect(out).toContain("Status: stub");
    expect(out).toContain("stubby.com/feed.xml");
  });

  it("list_organizations includes the stub with a badge (no include_empty)", async () => {
    const { db } = createTestDb();
    await seedStub(db);
    const out = firstText(await listOrganizations(db as never, {}));
    expect(out).toContain("Stubby");
    expect(out).toContain("_(stub)_");
  });
});
