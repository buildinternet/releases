import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { domainDemand } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../test/setup.js";
import { recordDomainDemand } from "./domain-demand.js";

describe("recordDomainDemand", () => {
  it("inserts a new row with hit_count 1", async () => {
    const db = createTestDb();
    await recordDomainDemand(db, "acme.com");
    const [row] = await db.select().from(domainDemand).where(eq(domainDemand.domain, "acme.com"));
    expect(row?.hitCount).toBe(1);
    expect(row?.firstSeenAt).toBe(row?.lastSeenAt);
    expect(row?.sweptAt).toBeNull();
  });

  it("increments hit_count and advances last_seen_at on a repeat", async () => {
    const db = createTestDb();
    await recordDomainDemand(db, "acme.com");
    const [first] = await db.select().from(domainDemand).where(eq(domainDemand.domain, "acme.com"));
    await recordDomainDemand(db, "acme.com");
    const [second] = await db
      .select()
      .from(domainDemand)
      .where(eq(domainDemand.domain, "acme.com"));
    expect(second?.hitCount).toBe(2);
    expect(second?.firstSeenAt).toBe(first?.firstSeenAt); // unchanged
    expect(second!.lastSeenAt).toBeGreaterThanOrEqual(first!.lastSeenAt);
  });
});
