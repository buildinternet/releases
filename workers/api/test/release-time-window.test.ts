/**
 * `since` / `until` time-window filter across the three release-bearing API
 * query helpers: the cross-source latest feed, the org feed, and the lexical
 * search path. ISO bounds filter `published_at`; a NULL-dated row drops out of
 * any window (a release with no date can't be placed in one).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper";
import { asD1 } from "../../../tests/mcp-test-helpers";
import { getLatestReleasesAcross } from "../src/queries/releases.js";
import { getOrgReleasesFeed } from "../src/queries/orgs.js";
import { searchReleasesFts } from "../src/queries/search.js";

const noCursor = { cursorWhere: "", cursorBindings: [] };
const TOKEN = "quantumflux";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = createTestDb();
  await testDb.db.insert(organizations).values({
    id: "org_a",
    slug: "acme",
    name: "Acme",
    category: "cloud",
  });
  await testDb.db.insert(sources).values({
    id: "src_a",
    slug: "feed",
    name: "Feed",
    type: "feed",
    url: "https://acme.test/feed",
    orgId: "org_a",
  });
  await testDb.db.insert(releases).values([
    {
      id: "rel_jan",
      sourceId: "src_a",
      title: `${TOKEN} jan`,
      content: TOKEN,
      url: "https://acme.test/jan",
      publishedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "rel_mar",
      sourceId: "src_a",
      title: `${TOKEN} mar`,
      content: TOKEN,
      url: "https://acme.test/mar",
      publishedAt: "2026-03-01T00:00:00Z",
    },
    {
      id: "rel_may",
      sourceId: "src_a",
      title: `${TOKEN} may`,
      content: TOKEN,
      url: "https://acme.test/may",
      publishedAt: "2026-05-01T00:00:00Z",
    },
    {
      id: "rel_undated",
      sourceId: "src_a",
      title: `${TOKEN} undated`,
      content: TOKEN,
      url: "https://acme.test/undated",
      publishedAt: null,
    },
  ]);
});

afterEach(() => testDb.cleanup());

describe("getLatestReleasesAcross — since/until", () => {
  const d1 = () => testDb.db as unknown as D1Database;

  it("returns all rows (including undated) with no window", async () => {
    const ids = (await getLatestReleasesAcross(d1(), { limit: 50 })).map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set(["rel_jan", "rel_mar", "rel_may", "rel_undated"]));
  });

  it("`since` keeps rows at or after the bound and drops the undated row", async () => {
    const ids = (
      await getLatestReleasesAcross(d1(), { since: "2026-02-01T00:00:00.000Z", limit: 50 })
    ).map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set(["rel_mar", "rel_may"]));
  });

  it("`until` keeps rows at or before the bound and drops the undated row", async () => {
    const ids = (
      await getLatestReleasesAcross(d1(), { until: "2026-04-01T00:00:00.000Z", limit: 50 })
    ).map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set(["rel_jan", "rel_mar"]));
  });

  it("`since` + `until` bound both ends", async () => {
    const ids = (
      await getLatestReleasesAcross(d1(), {
        since: "2026-02-01T00:00:00.000Z",
        until: "2026-04-01T00:00:00.000Z",
        limit: 50,
      })
    ).map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set(["rel_mar"]));
  });
});

describe("getOrgReleasesFeed — since/until", () => {
  const d1 = () => testDb.db as unknown as D1Database;

  it("returns all rows (including undated) with no window", async () => {
    const ids = (await getOrgReleasesFeed(d1(), "org_a", noCursor, 50)).map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set(["rel_jan", "rel_mar", "rel_may", "rel_undated"]));
  });

  it("`since` keeps rows at or after the bound and drops the undated row", async () => {
    const ids = (
      await getOrgReleasesFeed(d1(), "org_a", noCursor, 50, { since: "2026-02-01T00:00:00.000Z" })
    ).map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set(["rel_mar", "rel_may"]));
  });

  it("`since` + `until` bound both ends", async () => {
    const ids = (
      await getOrgReleasesFeed(d1(), "org_a", noCursor, 50, {
        since: "2026-02-01T00:00:00.000Z",
        until: "2026-04-01T00:00:00.000Z",
      })
    ).map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set(["rel_mar"]));
  });
});

describe("searchReleasesFts — since/until (lexical search path)", () => {
  it("returns all dated + undated matches with no window", async () => {
    const ids = (await searchReleasesFts(asD1(testDb.db), TOKEN, 50, 0)).map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set(["rel_jan", "rel_mar", "rel_may", "rel_undated"]));
  });

  it("`since` + `until` bound the FTS result window and drop the undated row", async () => {
    const ids = (
      await searchReleasesFts(asD1(testDb.db), TOKEN, 50, 0, {
        since: "2026-02-01T00:00:00.000Z",
        until: "2026-04-01T00:00:00.000Z",
      })
    ).map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set(["rel_mar"]));
  });
});
