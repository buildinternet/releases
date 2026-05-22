/**
 * `since` / `until` time-window filter on the MCP `search` (lexical path) and
 * `get_latest_releases` tools. Mirrors the API: ISO or relative shorthand
 * resolves to a published_at bound, undated rows drop out of any window, and
 * unparseable input returns a model-readable error rather than throwing.
 *
 * Without Vectorize bindings `search` runs its lexical SQL path; the hybrid
 * post-filter is covered separately in hybrid-search-time-window.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { search, getLatestReleases } from "../../workers/mcp/src/tools.js";

const TOKEN = "chronowindow";
let testDb: TestDatabase;
let ids: { jan: string; mar: string; may: string; undated: string };

beforeEach(async () => {
  testDb = createTestDb();
  const orgId = newOrgId();
  await testDb.db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });
  const srcId = newSourceId();
  await testDb.db.insert(sources).values({
    id: srcId,
    orgId,
    name: "Acme Releases",
    slug: "acme-releases",
    type: "github",
    url: "https://github.com/acme/releases",
    discovery: "curated",
  });
  ids = {
    jan: newReleaseId(),
    mar: newReleaseId(),
    may: newReleaseId(),
    undated: newReleaseId(),
  };
  await testDb.db.insert(releases).values([
    {
      id: ids.jan,
      sourceId: srcId,
      title: `${TOKEN} january feature`,
      content: TOKEN,
      publishedAt: "2026-01-01T00:00:00Z",
      type: "feature",
    },
    {
      id: ids.mar,
      sourceId: srcId,
      title: `${TOKEN} march feature`,
      content: TOKEN,
      publishedAt: "2026-03-01T00:00:00Z",
      type: "feature",
    },
    {
      id: ids.may,
      sourceId: srcId,
      title: `${TOKEN} may feature`,
      content: TOKEN,
      publishedAt: "2026-05-01T00:00:00Z",
      type: "feature",
    },
    {
      id: ids.undated,
      sourceId: srcId,
      title: `${TOKEN} undated feature`,
      content: TOKEN,
      publishedAt: null,
      type: "feature",
    },
  ]);
});

afterEach(() => testDb.cleanup());

describe("search — since/until on releases (lexical path)", () => {
  it("`since` keeps rows at or after the bound and drops the undated row", async () => {
    const out = await search(asD1(testDb.db), {
      query: TOKEN,
      type: ["releases"],
      mode: "lexical",
      since: "2026-02-01T00:00:00.000Z",
    });
    const text = out.result.content[0].text;
    expect(text).not.toContain("january feature");
    expect(text).toContain("march feature");
    expect(text).toContain("may feature");
    expect(text).not.toContain("undated feature");
  });

  it("`since` + `until` bound both ends of the window", async () => {
    const out = await search(asD1(testDb.db), {
      query: TOKEN,
      type: ["releases"],
      mode: "lexical",
      since: "2026-02-01T00:00:00.000Z",
      until: "2026-04-01T00:00:00.000Z",
    });
    const text = out.result.content[0].text;
    expect(text).toContain("march feature");
    expect(text).not.toContain("january feature");
    expect(text).not.toContain("may feature");
  });

  it("accepts relative shorthand (resolved server-side)", async () => {
    // `100000d` ≈ 274 years back — every dated row is in-window, undated drops.
    const out = await search(asD1(testDb.db), {
      query: TOKEN,
      type: ["releases"],
      mode: "lexical",
      since: "100000d",
    });
    const text = out.result.content[0].text;
    expect(text).toContain("january feature");
    expect(text).toContain("may feature");
    expect(text).not.toContain("undated feature");
  });

  it("returns a model-readable error for unparseable input", async () => {
    const out = await search(asD1(testDb.db), {
      query: TOKEN,
      type: ["releases"],
      since: "not-a-date",
    });
    expect(out.result.content[0].text).toContain("Invalid `since`");
    expect(out.counts.releaseHits).toBe(0);
  });
});

describe("get_latest_releases — since/until", () => {
  it("`since` keeps rows at or after the bound and drops the undated row", async () => {
    const out = await getLatestReleases(asD1(testDb.db), { since: "2026-02-01T00:00:00.000Z" });
    const text = out.content[0].text;
    expect(text).not.toContain("january feature");
    expect(text).toContain("march feature");
    expect(text).toContain("may feature");
    expect(text).not.toContain("undated feature");
  });

  it("`since` + `until` bound both ends of the window", async () => {
    const out = await getLatestReleases(asD1(testDb.db), {
      since: "2026-02-01T00:00:00.000Z",
      until: "2026-04-01T00:00:00.000Z",
    });
    const text = out.content[0].text;
    expect(text).toContain("march feature");
    expect(text).not.toContain("january feature");
    expect(text).not.toContain("may feature");
  });

  it("returns a model-readable error for unparseable input", async () => {
    const out = await getLatestReleases(asD1(testDb.db), { until: "garbage" });
    expect(out.content[0].text).toContain("Invalid `until`");
  });
});
