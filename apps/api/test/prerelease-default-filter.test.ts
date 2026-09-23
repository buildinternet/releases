import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { getSourceActivityBuckets, getSourceReleasesPaginated } from "../src/queries/sources";
import { getLatestReleasesAcross } from "../src/queries/releases";
import { applyMigrations, makeD1Shim } from "../../../tests/db-helper";
import { createTestDb } from "./setup";

async function seed(db: ReturnType<typeof createTestDb>) {
  await db
    .insert(organizations)
    .values([{ id: "org_demo", slug: "demo", name: "Demo", category: "ai" }]);
  await db.insert(sources).values([
    {
      id: "src_demo",
      slug: "demo",
      name: "Demo",
      type: "feed",
      url: "https://example.com/feed",
      orgId: "org_demo",
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_stable_early",
      sourceId: "src_demo",
      title: "2.0.0",
      content: "stable bump",
      version: "2.0.0",
      url: "https://example.com/r/1",
      publishedAt: "2026-05-01T12:00:00.000Z",
    },
    {
      id: "rel_pre",
      sourceId: "src_demo",
      title: "3.0.0-beta.1",
      content: "prerelease bump",
      version: "3.0.0-beta.1",
      url: "https://example.com/r/2",
      publishedAt: "2026-05-03T12:00:00.000Z",
      prerelease: true,
    },
    {
      id: "rel_stable_late",
      sourceId: "src_demo",
      title: "2.1.0",
      content: "stable bump",
      version: "2.1.0",
      url: "https://example.com/r/3",
      publishedAt: "2026-05-05T12:00:00.000Z",
    },
  ]);
}

describe("getSourceActivityBuckets", () => {
  it("excludes prerelease versions when computing earliest/latest version per week", async () => {
    const db = createTestDb();
    await seed(db);

    const rows = await getSourceActivityBuckets(
      db as never,
      "src_demo",
      "2026-04-27",
      "2026-05-11",
    );

    expect(rows.length).toBeGreaterThan(0);
    const versions = rows.flatMap((r) => [r.earliest_version, r.latest_version]).filter(Boolean);
    expect(versions).toContain("2.0.0");
    expect(versions).toContain("2.1.0");
    expect(versions).not.toContain("3.0.0-beta.1");
  });

  it("still counts prereleases toward the bucket total", async () => {
    const db = createTestDb();
    await seed(db);

    const rows = await getSourceActivityBuckets(
      db as never,
      "src_demo",
      "2026-04-27",
      "2026-05-11",
    );

    const total = rows.reduce((sum, r) => sum + Number(r.cnt), 0);
    expect(total).toBe(3);
  });
});

describe("getSourceReleasesPaginated", () => {
  it("hides prereleases by default so SSR matches the cursor feed", async () => {
    const db = createTestDb();
    await seed(db);

    const rows = await getSourceReleasesPaginated(db as never, "src_demo", 20, 0);

    const versions = rows.map((r) => r.version);
    expect(versions).toContain("2.0.0");
    expect(versions).toContain("2.1.0");
    expect(versions).not.toContain("3.0.0-beta.1");
  });

  it("includes prereleases when explicitly requested", async () => {
    const db = createTestDb();
    await seed(db);

    const rows = await getSourceReleasesPaginated(db as never, "src_demo", 20, 0, {
      includePrereleases: true,
    });

    const versions = rows.map((r) => r.version);
    expect(versions).toContain("3.0.0-beta.1");
  });
});

// `getLatestReleasesAcross` takes a raw D1Database (uses .prepare().bind()
// directly), so we drop down to bun:sqlite + makeD1Shim like
// `release-feed-future-dated.test.ts` rather than going through drizzle.
async function seedD1(): Promise<D1Database> {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  const db = drizzle(sqlite);
  await db.insert(organizations).values({
    id: "org_demo",
    slug: "demo",
    name: "Demo",
    category: "ai",
  });
  await db.insert(sources).values({
    id: "src_demo",
    slug: "demo",
    name: "Demo",
    type: "feed",
    url: "https://example.com/feed",
    orgId: "org_demo",
  });
  await db.insert(releases).values([
    {
      id: "rel_stable_early",
      sourceId: "src_demo",
      title: "2.0.0",
      content: "stable bump",
      version: "2.0.0",
      url: "https://example.com/r/1",
      publishedAt: "2026-05-01T12:00:00.000Z",
    },
    {
      id: "rel_pre",
      sourceId: "src_demo",
      title: "3.0.0-beta.1",
      content: "prerelease bump",
      version: "3.0.0-beta.1",
      url: "https://example.com/r/2",
      publishedAt: "2026-05-03T12:00:00.000Z",
      prerelease: true,
    },
    {
      id: "rel_stable_late",
      sourceId: "src_demo",
      title: "2.1.0",
      content: "stable bump",
      version: "2.1.0",
      url: "https://example.com/r/3",
      publishedAt: "2026-05-05T12:00:00.000Z",
    },
  ]);
  return makeD1Shim(sqlite);
}

describe("getLatestReleasesAcross", () => {
  it("hides prereleases by default across the unified latest feed", async () => {
    const d1 = await seedD1();
    const rows = await getLatestReleasesAcross(d1, { limit: 50 });

    const versions = rows.map((r) => r.version);
    expect(versions).toContain("2.0.0");
    expect(versions).toContain("2.1.0");
    expect(versions).not.toContain("3.0.0-beta.1");
  });

  it("includes prereleases when explicitly requested", async () => {
    const d1 = await seedD1();
    const rows = await getLatestReleasesAcross(d1, { limit: 50, includePrereleases: true });

    const versions = rows.map((r) => r.version);
    expect(versions).toContain("3.0.0-beta.1");
  });
});
