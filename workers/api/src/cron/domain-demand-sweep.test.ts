import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { domainDemand, organizations } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDb } from "../../test/setup.js";
import { domainDemandSweep } from "./domain-demand-sweep.js";

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

const VALID_MANIFEST = JSON.stringify({
  version: 2,
  name: "Acme",
  releases: [{ url: "https://acme.com/changelog" }],
});

// fetchImpl that serves a valid manifest only for `${host}` in `served`.
function manifestFetch(served: Record<string, string>) {
  return async (input: string) => {
    const url = new URL(input);
    const body = served[url.hostname];
    if (body) {
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
}

async function seedDemand(
  db: TestDb,
  domain: string,
  over: Partial<typeof domainDemand.$inferInsert> = {},
) {
  await db.insert(domainDemand).values({
    domain,
    firstSeenAt: over.firstSeenAt ?? 1000,
    lastSeenAt: over.lastSeenAt ?? 1000,
    hitCount: over.hitCount ?? 1,
    sweptAt: over.sweptAt ?? null,
  });
}

describe("domainDemandSweep", () => {
  // oxlint-disable-next-line no-explicit-any -- test-only fetchImpl signature shim
  const enabledEnv = (db: TestDb, fetchImpl: any) => ({
    DB: {} as never,
    LISTING_SELF_SERVE_ENABLED: "true",
    _drizzleOverride: db as never,
    fetchImpl,
  });

  it("creates a stub for an unlisted domain with a valid manifest and stamps swept_at", async () => {
    const db = createTestDb();
    await seedDemand(db, "acme.com");
    const r = await domainDemandSweep(
      enabledEnv(db, manifestFetch({ "acme.com": VALID_MANIFEST })),
    );
    expect(r.created).toBe(1);
    const [org] = await db.select().from(organizations).where(eq(organizations.domain, "acme.com"));
    expect(org?.tier).toBe("stub");
    const [row] = await db.select().from(domainDemand).where(eq(domainDemand.domain, "acme.com"));
    expect(row?.sweptAt).not.toBeNull();
  });

  it("stamps swept_at but creates nothing when there is no manifest", async () => {
    const db = createTestDb();
    await seedDemand(db, "nothing.com");
    const r = await domainDemandSweep(enabledEnv(db, manifestFetch({})));
    expect(r.created).toBe(0);
    const [row] = await db
      .select()
      .from(domainDemand)
      .where(eq(domainDemand.domain, "nothing.com"));
    expect(row?.sweptAt).not.toBeNull();
  });

  it("excludes a domain that already owns an org (no fetch, not counted)", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({
      id: "org_a",
      slug: "acme",
      name: "Acme",
      domain: "acme.com",
      tier: "tracked",
    });
    await seedDemand(db, "acme.com");
    let fetched = false;
    const r = await domainDemandSweep(
      enabledEnv(db, async () => {
        fetched = true;
        return new Response("", { status: 404 });
      }),
    );
    expect(fetched).toBe(false);
    expect(r.processed).toBe(0);
  });

  it("skips a domain swept within SWEEP_RETRY_DAYS (due-filter)", async () => {
    const db = createTestDb();
    await seedDemand(db, "recent.com", { sweptAt: Date.now() });
    const r = await domainDemandSweep(
      enabledEnv(db, manifestFetch({ "recent.com": VALID_MANIFEST })),
    );
    expect(r.processed).toBe(0);
  });

  it("prunes a stale single-hit already-probed row but keeps repeat demand", async () => {
    const db = createTestDb();
    const old = Date.now() - 40 * 86_400_000; // 40d ago
    await seedDemand(db, "junk.com", { hitCount: 1, sweptAt: old, lastSeenAt: old });
    await seedDemand(db, "wanted.com", { hitCount: 3, sweptAt: old, lastSeenAt: old });
    const r = await domainDemandSweep(enabledEnv(db, manifestFetch({})));
    const junk = await db.select().from(domainDemand).where(eq(domainDemand.domain, "junk.com"));
    const wanted = await db
      .select()
      .from(domainDemand)
      .where(eq(domainDemand.domain, "wanted.com"));
    expect(junk.length).toBe(0);
    expect(wanted.length).toBe(1);
    expect(r.pruned).toBe(1);
  });

  it("no-ops when the flag is off", async () => {
    const db = createTestDb();
    await seedDemand(db, "acme.com");
    const r = await domainDemandSweep({
      DB: {} as never,
      LISTING_SELF_SERVE_ENABLED: "false",
      _drizzleOverride: db as never,
      fetchImpl: manifestFetch({ "acme.com": VALID_MANIFEST }),
    });
    expect(r.created).toBe(0);
    const orgs = await db.select().from(organizations);
    expect(orgs.length).toBe(0);
  });

  it("no-ops when CRON_ENABLED=false", async () => {
    const db = createTestDb();
    await seedDemand(db, "acme.com");
    const r = await domainDemandSweep({
      DB: {} as never,
      CRON_ENABLED: "false",
      LISTING_SELF_SERVE_ENABLED: "true",
      _drizzleOverride: db as never,
      fetchImpl: manifestFetch({ "acme.com": VALID_MANIFEST }),
    });
    expect(r.created).toBe(0);
  });
});
