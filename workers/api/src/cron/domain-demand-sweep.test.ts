import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { domainDemand } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../test/setup.js";

describe("domain_demand table", () => {
  it("applies the migration and round-trips a row", async () => {
    const db = createTestDb();
    await db.insert(domainDemand).values({
      domain: "acme.com",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
    });
    const [row] = await db.select().from(domainDemand).where(eq(domainDemand.domain, "acme.com"));
    expect(row?.hitCount).toBe(1);
    expect(row?.sweptAt).toBeNull();
  });
});
