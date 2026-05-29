/**
 * #1206: search release hits carry `source.appStore` (platform + icon) for
 * App Store sources so the web search card can render the compact app-update
 * treatment. The field is derived from `source.metadata.appStore` during
 * hydration in `buildReleaseHits`, so it covers both `/v1/search` and the MCP
 * hybrid search (they share the helper via `createWorkerSearch`).
 *
 * Non-app sources (github / scrape / feed / agent) must leave `appStore`
 * null so the card falls back to the standard release layout.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { runHybridSearch } from "../../workers/mcp/src/lib/search-hybrid.js";
import type { HybridSearchEnv } from "../../workers/mcp/src/lib/search-hybrid.js";

const minimalEnv: HybridSearchEnv = {};

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

const TOKEN = "zorptastic";
const ARTWORK = "https://is1-ssl.mzstatic.com/image/thumb/abc/1024x1024bb.png";

async function seedAppAndGithubReleases(db: TestDatabase["db"]): Promise<{
  appReleaseId: string;
  ghReleaseId: string;
}> {
  const orgId = newOrgId();
  await db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });

  const appSrcId = newSourceId();
  await db.insert(sources).values({
    id: appSrcId,
    orgId,
    name: "Acme App",
    slug: "acme-app",
    type: "appstore",
    url: "https://apps.apple.com/app/id123",
    discovery: "curated",
    metadata: JSON.stringify({ appStore: { platform: "ios", artworkUrl: ARTWORK } }),
  });

  const ghSrcId = newSourceId();
  await db.insert(sources).values({
    id: ghSrcId,
    orgId,
    name: "Acme Releases",
    slug: "acme-releases",
    type: "github",
    url: "https://github.com/acme/releases",
    discovery: "curated",
  });

  const appReleaseId = newReleaseId();
  const ghReleaseId = newReleaseId();
  await db.insert(releases).values([
    {
      id: appReleaseId,
      sourceId: appSrcId,
      title: `${TOKEN} app update`,
      content: `${TOKEN} app body`,
      version: "5.0.0",
      publishedAt: "2026-05-01T00:00:00Z",
      type: "feature" as const,
    },
    {
      id: ghReleaseId,
      sourceId: ghSrcId,
      title: `${TOKEN} library release`,
      content: `${TOKEN} library body`,
      version: "1.2.3",
      publishedAt: "2026-05-01T00:00:00Z",
      type: "feature" as const,
    },
  ]);

  return { appReleaseId, ghReleaseId };
}

describe("buildReleaseHits — App Store source info (#1206)", () => {
  it("attaches appStore {platform, iconUrl} to App Store hits and null otherwise", async () => {
    const { appReleaseId, ghReleaseId } = await seedAppAndGithubReleases(testDb.db);
    const db = asD1(testDb.db);

    const result = await runHybridSearch(minimalEnv, db, {
      query: TOKEN,
      mode: "lexical",
      topK: 20,
    });

    type Hit = (typeof result.hits)[number];
    type ReleaseHit = Extract<Hit, { kind: "release" }>;
    const releaseHits = result.hits.filter((h: Hit): h is ReleaseHit => h.kind === "release");

    const appHit = releaseHits.find((h) => h.release.id === appReleaseId);
    const ghHit = releaseHits.find((h) => h.release.id === ghReleaseId);

    expect(appHit).toBeDefined();
    expect(appHit?.release.source.appStore).toEqual({ platform: "ios", iconUrl: ARTWORK });

    expect(ghHit).toBeDefined();
    // Non-app sources resolve to null (not undefined) so the wire shape is stable.
    expect(ghHit?.release.source.appStore ?? null).toBeNull();
  });
});
