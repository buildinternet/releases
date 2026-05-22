/**
 * Time-window (`since` / `until`) post-filter on release hits in the shared
 * hybrid-search worker. `runHybridSearch` with an empty env degrades to the
 * lexical path, which still routes through `buildReleaseHits` — the single
 * post-filter that backs both the API and MCP hybrid/semantic surfaces. A
 * NULL `published_at` row verifies undated releases drop out of any window.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { runHybridSearch } from "../../workers/mcp/src/lib/search-hybrid.js";
import type { HybridSearchEnv } from "../../workers/mcp/src/lib/search-hybrid.js";

const minimalEnv: HybridSearchEnv = {};
const TOKEN = "quantumflux";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

async function seed(db: TestDatabase["db"]) {
  const orgId = newOrgId();
  await db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });
  const srcId = newSourceId();
  await db.insert(sources).values({
    id: srcId,
    orgId,
    name: "Acme Releases",
    slug: "acme-releases",
    type: "github",
    url: "https://github.com/acme/releases",
    discovery: "curated",
  });

  const jan = newReleaseId();
  const mar = newReleaseId();
  const may = newReleaseId();
  const undated = newReleaseId();
  await db.insert(releases).values([
    {
      id: jan,
      sourceId: srcId,
      title: `${TOKEN} jan`,
      content: `${TOKEN}`,
      publishedAt: "2026-01-01T00:00:00Z",
      type: "feature",
    },
    {
      id: mar,
      sourceId: srcId,
      title: `${TOKEN} mar`,
      content: `${TOKEN}`,
      publishedAt: "2026-03-01T00:00:00Z",
      type: "feature",
    },
    {
      id: may,
      sourceId: srcId,
      title: `${TOKEN} may`,
      content: `${TOKEN}`,
      publishedAt: "2026-05-01T00:00:00Z",
      type: "feature",
    },
    {
      id: undated,
      sourceId: srcId,
      title: `${TOKEN} undated`,
      content: `${TOKEN}`,
      publishedAt: null,
      type: "feature",
    },
  ]);
  return { jan, mar, may, undated };
}

async function searchIds(opts: { since?: string; until?: string }): Promise<Set<string>> {
  const result = await runHybridSearch(minimalEnv, asD1(testDb.db), {
    query: TOKEN,
    mode: "lexical",
    topK: 50,
    ...opts,
  });
  type Hit = (typeof result.hits)[number];
  type ReleaseHit = Extract<Hit, { kind: "release" }>;
  return new Set(
    result.hits
      .filter((h: Hit): h is ReleaseHit => h.kind === "release")
      .map((h: ReleaseHit) => h.release.id),
  );
}

describe("runHybridSearch — since/until post-filter", () => {
  it("returns all dated rows plus the undated row when no window is set", async () => {
    const { jan, mar, may, undated } = await seed(testDb.db);
    const ids = await searchIds({});
    expect(ids).toEqual(new Set([jan, mar, may, undated]));
  });

  it("`since` keeps rows at or after the bound and drops the undated row", async () => {
    const { mar, may } = await seed(testDb.db);
    const ids = await searchIds({ since: "2026-02-01T00:00:00.000Z" });
    expect(ids).toEqual(new Set([mar, may]));
  });

  it("`until` keeps rows at or before the bound and drops the undated row", async () => {
    const { jan, mar } = await seed(testDb.db);
    const ids = await searchIds({ until: "2026-04-01T00:00:00.000Z" });
    expect(ids).toEqual(new Set([jan, mar]));
  });

  it("`since` + `until` bound both ends of the window", async () => {
    const { mar } = await seed(testDb.db);
    const ids = await searchIds({
      since: "2026-02-01T00:00:00.000Z",
      until: "2026-04-01T00:00:00.000Z",
    });
    expect(ids).toEqual(new Set([mar]));
  });
});
