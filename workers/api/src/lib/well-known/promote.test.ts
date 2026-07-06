import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import {
  organizations,
  products,
  sources,
  releaseLocations,
} from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../test/setup.js";
import { createStubOrg } from "./stub.js";
import { promoteStubOrg } from "./promote.js";

// A probe that approves every locator without touching the network — lets the
// tier-1 feed path create a source in-process.
const okProbe = async () => ({ ok: true });

describe("promoteStubOrg", () => {
  it("materializes locators into sources, stamps source_id, and flips tier", async () => {
    const db = createTestDb();
    const { org } = await createStubOrg(
      db as never,
      {
        name: "Acme",
        slug: "acme",
        domain: "acme.com",
        locations: [
          { feed: "https://acme.com/feed.xml" }, // tier-1 → live source
          { url: "https://acme.com/blog" }, // tier-2 → paused source
        ],
      },
      { basis: "curator" },
    );

    const res = await promoteStubOrg(db as never, org.id, { probe: okProbe });
    expect(res.promoted).toBe(true);
    expect(res.sourcesCreated).toBe(2);
    expect(res.locatorsStamped).toBe(2);

    const [after] = await db.select().from(organizations).where(eq(organizations.id, org.id));
    expect(after!.tier).toBe("tracked");

    const srcs = await db.select().from(sources).where(eq(sources.orgId, org.id));
    expect(srcs.length).toBe(2);
    // The bare-url locator is a paused tier-2 source; the feed is live.
    expect(srcs.filter((s) => s.fetchPriority === "paused").length).toBe(1);
    expect(srcs.filter((s) => s.type === "feed").length).toBe(1);

    // Every locator now points at the source it became — and is still present
    // (not consumed), so demotion stays symmetric.
    const locs = await db.select().from(releaseLocations).where(eq(releaseLocations.orgId, org.id));
    expect(locs.length).toBe(2);
    expect(locs.every((l) => l.sourceId !== null)).toBe(true);
  });

  it("is a no-op on an already-tracked org", async () => {
    const db = createTestDb();
    const { org } = await createStubOrg(
      db as never,
      { name: "Beta", slug: "beta", locations: [{ url: "https://beta.com/x" }] },
      { basis: "curator" },
    );
    await promoteStubOrg(db as never, org.id, { probe: okProbe });
    const second = await promoteStubOrg(db as never, org.id, { probe: okProbe });
    expect(second.promoted).toBe(false);
    expect(second.alreadyTracked).toBe(true);
    // No duplicate sources from the re-run.
    const srcs = await db.select().from(sources).where(eq(sources.orgId, org.id));
    expect(srcs.length).toBe(1);
  });

  it("re-run of a partially-promoted stub matches existing sources without duplicating", async () => {
    const db = createTestDb();
    const { org } = await createStubOrg(
      db as never,
      { name: "Gamma", slug: "gamma", locations: [{ feed: "https://gamma.com/f.xml" }] },
      { basis: "curator" },
    );
    // First promote creates the source but we simulate a failed tier-flip by
    // resetting the org back to stub afterwards.
    await promoteStubOrg(db as never, org.id, { probe: okProbe });
    await db.update(organizations).set({ tier: "stub" }).where(eq(organizations.id, org.id));

    const rerun = await promoteStubOrg(db as never, org.id, { probe: okProbe });
    expect(rerun.promoted).toBe(true);
    expect(rerun.sourcesCreated).toBe(0);
    expect(rerun.sourcesMatched).toBe(1);
    const srcs = await db.select().from(sources).where(eq(sources.orgId, org.id));
    expect(srcs.length).toBe(1);
  });

  it("materializes a locator whose product was soft-deleted (reclassified top-level)", async () => {
    const db = createTestDb();
    const { org } = await createStubOrg(
      db as never,
      {
        name: "Epsilon",
        slug: "epsilon",
        domain: "epsilon.com",
        products: [{ name: "Widget", locations: [{ feed: "https://epsilon.com/widget.xml" }] }],
      },
      { basis: "curator" },
    );
    // Soft-delete the product AFTER the locator was written against it. The
    // locator's product_id still points at the tombstoned product (only a HARD
    // delete nulls it), so a naive "productId === null → top-level" filter would
    // drop it entirely. The fix reclassifies it as top-level.
    await db
      .update(products)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(products.orgId, org.id));

    const res = await promoteStubOrg(db as never, org.id, { probe: okProbe });
    expect(res.promoted).toBe(true);
    expect(res.sourcesCreated).toBe(1);
    expect(res.locatorsStamped).toBe(1);

    const srcs = await db.select().from(sources).where(eq(sources.orgId, org.id));
    expect(srcs.length).toBe(1);
    const locs = await db.select().from(releaseLocations).where(eq(releaseLocations.orgId, org.id));
    expect(locs.every((l) => l.sourceId !== null)).toBe(true);
  });

  it("dryRun returns a plan and writes nothing", async () => {
    const db = createTestDb();
    const { org } = await createStubOrg(
      db as never,
      { name: "Delta", slug: "delta", locations: [{ url: "https://delta.com/x" }] },
      { basis: "curator" },
    );
    const res = await promoteStubOrg(db as never, org.id, { dryRun: true, probe: okProbe });
    expect(res.promoted).toBe(false);
    expect(res.plan).toBeDefined();
    const [after] = await db.select().from(organizations).where(eq(organizations.id, org.id));
    expect(after!.tier).toBe("stub");
    const srcs = await db.select().from(sources).where(eq(sources.orgId, org.id));
    expect(srcs.length).toBe(0);
  });
});
