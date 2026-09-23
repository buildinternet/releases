import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources, releaseLocations } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDb } from "../../test/setup.js";
import { sweepStubDemotions } from "./stub-demotion.js";

async function seedOrg(db: TestDb, overrides: Partial<typeof organizations.$inferInsert> = {}) {
  const id = overrides.id ?? `org_${Math.random().toString(36).slice(2)}`;
  await db.insert(organizations).values({
    id,
    slug: overrides.slug ?? id,
    name: overrides.name ?? "Acme",
    tier: "tracked",
    ...overrides,
  });
  return id;
}

async function seedSource(
  db: TestDb,
  orgId: string,
  overrides: Partial<typeof sources.$inferInsert> = {},
) {
  const id = overrides.id ?? `src_${Math.random().toString(36).slice(2)}`;
  await db.insert(sources).values({
    id,
    orgId,
    name: overrides.name ?? "Feed",
    slug: overrides.slug ?? id,
    type: overrides.type ?? "feed",
    url: overrides.url ?? "https://acme.com/feed.xml",
    ...overrides,
  });
  return id;
}

async function seedLocator(
  db: TestDb,
  orgId: string,
  overrides: Partial<typeof releaseLocations.$inferInsert> = {},
) {
  const id = overrides.id ?? `loc_${Math.random().toString(36).slice(2)}`;
  await db.insert(releaseLocations).values({
    id,
    orgId,
    feed: overrides.feed ?? "https://acme.com/feed.xml",
    basis: overrides.basis ?? "curator",
    matchKey: overrides.matchKey ?? `feed:https://acme.com/feed.xml:${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

describe("sweepStubDemotions", () => {
  it("flips a qualifying org (zero live sources, has a live locator) back to stub", async () => {
    const db = createTestDb();
    const orgId = await seedOrg(db);
    const srcId = await seedSource(db, orgId);
    // Soft-delete the only source — zero live sources remain.
    await db
      .update(sources)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(sources.id, srcId));
    const locId = await seedLocator(db, orgId, { sourceId: srcId });

    const res = await sweepStubDemotions({ DB: {} as never, _drizzleOverride: db as never });
    expect(res.demoted).toBe(1);
    expect(res.stampsCleared).toBe(1);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org!.tier).toBe("stub");
    const [loc] = await db.select().from(releaseLocations).where(eq(releaseLocations.id, locId));
    expect(loc!.sourceId).toBeNull();
  });

  it("does not demote an org with a live source", async () => {
    const db = createTestDb();
    const orgId = await seedOrg(db);
    await seedSource(db, orgId);
    await seedLocator(db, orgId);

    const res = await sweepStubDemotions({ DB: {} as never, _drizzleOverride: db as never });
    expect(res.demoted).toBe(0);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org!.tier).toBe("tracked");
  });

  it("does not demote an org whose only source is merely paused", async () => {
    const db = createTestDb();
    const orgId = await seedOrg(db);
    await seedSource(db, orgId, { fetchPriority: "paused" });
    await seedLocator(db, orgId);

    const res = await sweepStubDemotions({ DB: {} as never, _drizzleOverride: db as never });
    expect(res.demoted).toBe(0);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org!.tier).toBe("tracked");
  });

  it("does not demote an org with zero live sources but no locators (protects legacy orgs)", async () => {
    const db = createTestDb();
    const orgId = await seedOrg(db);
    const srcId = await seedSource(db, orgId);
    await db
      .update(sources)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(sources.id, srcId));
    // No locator rows at all — legacy tracked org, must not demote.

    const res = await sweepStubDemotions({ DB: {} as never, _drizzleOverride: db as never });
    expect(res.demoted).toBe(0);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org!.tier).toBe("tracked");
  });

  it("leaves an already-stub org untouched", async () => {
    const db = createTestDb();
    const orgId = await seedOrg(db, { tier: "stub" });
    await seedLocator(db, orgId);

    const res = await sweepStubDemotions({ DB: {} as never, _drizzleOverride: db as never });
    expect(res.demoted).toBe(0);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org!.tier).toBe("stub");
  });

  it("no-ops when the well-known-materialization flag is off", async () => {
    const db = createTestDb();
    const orgId = await seedOrg(db);
    const srcId = await seedSource(db, orgId);
    await db
      .update(sources)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(sources.id, srcId));
    await seedLocator(db, orgId, { sourceId: srcId });

    const res = await sweepStubDemotions({
      DB: {} as never,
      _drizzleOverride: db as never,
      WELL_KNOWN_MATERIALIZATION_ENABLED: "false",
    });
    expect(res.demoted).toBe(0);
    expect(res.scanned).toBe(0);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org!.tier).toBe("tracked");
  });

  it("no-ops when CRON_ENABLED=false", async () => {
    const db = createTestDb();
    const orgId = await seedOrg(db);
    const srcId = await seedSource(db, orgId);
    await db
      .update(sources)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(sources.id, srcId));
    await seedLocator(db, orgId, { sourceId: srcId });

    const res = await sweepStubDemotions({
      DB: {} as never,
      _drizzleOverride: db as never,
      CRON_ENABLED: "false",
    });
    expect(res.demoted).toBe(0);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org!.tier).toBe("tracked");
  });
});
