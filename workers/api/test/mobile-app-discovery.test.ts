import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createTestDb, createTestApp, type TestDb } from "./setup.js";
import { orgRoutes } from "../src/routes/orgs.js";
import { mobileAppDiscoverySweep } from "../src/cron/mobile-app-discovery.js";
import { discoverMobileApps } from "../src/lib/well-known/mobile-apps.js";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

// The in-memory bun:sqlite handle is structurally a drizzle DB but not the
// DrizzleD1 type the lib signatures name; cast at the boundary (as sibling
// cron/lib tests do) so the direct calls typecheck.
type ProdDb = Parameters<typeof discoverMobileApps>[0];
const asProd = (d: TestDb): ProdDb => d as unknown as ProdDb;

const AASA = {
  applinks: {
    apps: [],
    details: [{ appID: "9JA89QQLNQ.com.acme.ios", paths: ["*"] }],
  },
};
const ASSETLINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: "com.acme.android" },
  },
];
const LISTING = {
  resultCount: 1,
  results: [
    {
      trackId: 555,
      bundleId: "com.acme.ios",
      trackName: "Acme",
      version: "3.1.0",
      trackViewUrl: "https://apps.apple.com/us/app/acme/id555?uo=4",
      currentVersionReleaseDate: "2026-06-01T00:00:00Z",
      releaseNotes: "bug fixes",
    },
  ],
};

/** Route a single global-fetch mock across the two well-known files + iTunes. */
function installFetch(opts?: { aasaStatus?: number; itunesEmpty?: boolean }) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("apple-app-site-association")) {
      return new Response(JSON.stringify(AASA), { status: opts?.aasaStatus ?? 200 });
    }
    if (url.includes("assetlinks.json")) {
      return new Response(JSON.stringify(ASSETLINKS), { status: 200 });
    }
    if (url.includes("itunes.apple.com/lookup")) {
      return new Response(
        JSON.stringify(opts?.itunesEmpty ? { resultCount: 0, results: [] } : LISTING),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

describe("mobile-app discovery", () => {
  let db: TestDb;
  afterEach(() => {
    restoreGlobalFetch();
  });
  beforeEach(async () => {
    db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", domain: "acme.com" });
  });

  function app() {
    return createTestApp(db, orgRoutes, {
      env: { WELL_KNOWN_MATERIALIZATION_ENABLED: "true" },
    });
  }

  it("creates a paused+hidden iOS candidate and stores an Android hint", async () => {
    installFetch();
    const res = await app()(new Request("http://x/v1/orgs/acme/discover-apps", { method: "POST" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ios: { action: string; trackId?: string; sourceId?: string }[];
      android: { packageName: string; playUrl: string }[];
      applied: boolean;
    };
    expect(json.applied).toBe(true);
    expect(json.ios).toHaveLength(1);
    expect(json.ios[0]!.action).toBe("created");
    expect(json.android).toEqual([
      {
        packageName: "com.acme.android",
        playUrl: "https://play.google.com/store/apps/details?id=com.acme.android",
      },
    ]);

    // The candidate source is paused + hidden + on_demand.
    const [src] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.orgId, "org_a"), eq(sources.type, "appstore")));
    expect(src).toBeDefined();
    expect(src!.isHidden).toBe(true);
    expect(src!.fetchPriority).toBe("paused");
    expect(src!.discovery).toBe("on_demand");
    expect(src!.kind).toBe("mobile");

    // Android hint landed on org metadata without clobbering.
    const [org] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    const meta = JSON.parse(org!.metadata ?? "{}");
    expect(meta.discoveredApps.android[0].packageName).toBe("com.acme.android");
    expect(meta.discoveredApps.ios[0].trackId).toBe("555");
  });

  it("dryRun previews without writing", async () => {
    installFetch();
    const res = await app()(
      new Request("http://x/v1/orgs/acme/discover-apps?dryRun=1", { method: "POST" }),
    );
    const json = (await res.json()) as { ios: { action: string }[]; applied: boolean };
    expect(json.ios[0]!.action).toBe("created");
    expect(json.applied).toBe(false);
    const rows = await db.select().from(sources).where(eq(sources.orgId, "org_a"));
    expect(rows).toHaveLength(0);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    expect(org!.metadata ?? "{}").not.toContain("discoveredApps");
  });

  it("is idempotent — a second run reports existing, no duplicate", async () => {
    installFetch();
    await discoverMobileApps(asProd(db), "org_a", { domain: "acme.com", enabled: true });
    const second = await discoverMobileApps(asProd(db), "org_a", {
      domain: "acme.com",
      enabled: true,
    });
    expect(second.ios[0]!.action).toBe("existing");
    const rows = await db.select().from(sources).where(eq(sources.type, "appstore"));
    expect(rows).toHaveLength(1);
  });

  it("gated (flag off): declares apps but resolves nothing and writes nothing", async () => {
    const calls = installFetch();
    const r = await discoverMobileApps(asProd(db), "org_a", { domain: "acme.com", enabled: false });
    expect(r.ios[0]!.action).toBe("gated");
    expect(r.applied).toBe(false);
    // No iTunes lookup when gated.
    expect(calls.some((u) => u.includes("itunes.apple.com"))).toBe(false);
    const rows = await db.select().from(sources).where(eq(sources.orgId, "org_a"));
    expect(rows).toHaveLength(0);
  });

  it("not_found when iTunes has no listing", async () => {
    installFetch({ itunesEmpty: true });
    const r = await discoverMobileApps(asProd(db), "org_a", { domain: "acme.com", enabled: true });
    expect(r.ios[0]!.action).toBe("not_found");
    const rows = await db.select().from(sources).where(eq(sources.orgId, "org_a"));
    expect(rows).toHaveLength(0);
  });

  it("skips a missing AASA file gracefully", async () => {
    installFetch({ aasaStatus: 404 });
    const r = await discoverMobileApps(asProd(db), "org_a", { domain: "acme.com", enabled: true });
    expect(r.fetched.aasa).toBe(false);
    expect(r.ios).toHaveLength(0);
    // Android hint still lands from assetlinks.
    expect(r.android).toHaveLength(1);
  });
});

describe("mobileAppDiscoverySweep cron", () => {
  let db: TestDb;
  afterEach(() => {
    restoreGlobalFetch();
  });
  beforeEach(async () => {
    db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", domain: "acme.com" });
  });

  it("processes a due org, creates a candidate, and stamps the clock", async () => {
    installFetch();
    await mobileAppDiscoverySweep({
      DB: {} as D1Database,
      CRON_ENABLED: "true",
      WELL_KNOWN_MATERIALIZATION_ENABLED: "true",
      _drizzleOverride: db,
    });
    const rows = await db.select().from(sources).where(eq(sources.type, "appstore"));
    expect(rows).toHaveLength(1);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    const meta = JSON.parse(org!.metadata ?? "{}");
    expect(typeof meta.mobileAppsSweptAt).toBe("string");
  });

  it("skips a recently-swept org (due-filter)", async () => {
    installFetch();
    // Pre-stamp with a fresh timestamp so the org is not due.
    await db
      .update(organizations)
      .set({ metadata: JSON.stringify({ mobileAppsSweptAt: new Date().toISOString() }) })
      .where(eq(organizations.id, "org_a"));
    await mobileAppDiscoverySweep({
      DB: {} as D1Database,
      CRON_ENABLED: "true",
      WELL_KNOWN_MATERIALIZATION_ENABLED: "true",
      MOBILE_DISCOVERY_INTERVAL_HOURS: "720",
      _drizzleOverride: db,
    });
    const rows = await db.select().from(sources).where(eq(sources.type, "appstore"));
    expect(rows).toHaveLength(0);
  });

  it("is a no-op when CRON_ENABLED=false", async () => {
    installFetch();
    await mobileAppDiscoverySweep({
      DB: {} as D1Database,
      CRON_ENABLED: "false",
      _drizzleOverride: db,
    });
    const rows = await db.select().from(sources).where(eq(sources.type, "appstore"));
    expect(rows).toHaveLength(0);
  });

  it("skips fetchPaused, soft-deleted, and domain-less orgs", async () => {
    installFetch();
    await db.insert(organizations).values([
      { id: "org_paused", slug: "paused", name: "Paused", domain: "paused.com", fetchPaused: true },
      {
        id: "org_deleted",
        slug: "deleted",
        name: "Deleted",
        domain: "deleted.com",
        deletedAt: "2026-06-01T00:00:00.000Z",
      },
      { id: "org_nodomain", slug: "nodomain", name: "NoDomain", domain: null },
    ]);
    await mobileAppDiscoverySweep({
      DB: {} as D1Database,
      CRON_ENABLED: "true",
      WELL_KNOWN_MATERIALIZATION_ENABLED: "true",
      _drizzleOverride: db,
    });

    // No candidate created for any of the excluded orgs.
    const excludedSources = await db
      .select()
      .from(sources)
      .where(inArray(sources.orgId, ["org_paused", "org_deleted", "org_nodomain"]));
    expect(excludedSources).toHaveLength(0);

    // fetchPaused + soft-deleted orgs aren't due-selected, so they're never stamped.
    const [paused] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, "org_paused"));
    expect(JSON.parse(paused!.metadata ?? "{}").mobileAppsSweptAt).toBeUndefined();
    const [deleted] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, "org_deleted"));
    expect(JSON.parse(deleted!.metadata ?? "{}").mobileAppsSweptAt).toBeUndefined();

    // The domain-less org IS due, so it flows through the one probe path (no I/O,
    // no source) and still gets stamped.
    const [noDomain] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, "org_nodomain"));
    expect(typeof JSON.parse(noDomain!.metadata ?? "{}").mobileAppsSweptAt).toBe("string");
  });
});
