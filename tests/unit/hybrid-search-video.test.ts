/**
 * #1206: search release hits carry `source.video` (provider) for video sources
 * so the web search card can render the thumbnail-forward video treatment
 * (play badge + "Watch on {provider}"). The field is derived from
 * `source.metadata.video` during hydration in `buildReleaseHits`, so it covers
 * both `/v1/search` and the MCP hybrid search (they share the helper via
 * `createWorkerSearch`).
 *
 * Non-video sources (github / scrape / feed / agent / appstore) must leave
 * `video` null so the card falls back to the standard release layout.
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

async function seedVideoAndGithubReleases(db: TestDatabase["db"]): Promise<{
  videoReleaseId: string;
  ghReleaseId: string;
}> {
  const orgId = newOrgId();
  await db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });

  const videoSrcId = newSourceId();
  await db.insert(sources).values({
    id: videoSrcId,
    orgId,
    name: "Acme Channel",
    slug: "acme-channel",
    type: "video",
    url: "https://youtube.com/@acme",
    discovery: "curated",
    metadata: JSON.stringify({ video: { provider: "youtube" } }),
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

  const videoReleaseId = newReleaseId();
  const ghReleaseId = newReleaseId();
  await db.insert(releases).values([
    {
      id: videoReleaseId,
      sourceId: videoSrcId,
      title: `${TOKEN} launch walkthrough`,
      content: `${TOKEN} video body`,
      url: "https://youtube.com/watch?v=abcdefghijk",
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

  return { videoReleaseId, ghReleaseId };
}

describe("buildReleaseHits — video source info (#1206)", () => {
  it("attaches video {provider} to video hits and null otherwise", async () => {
    const { videoReleaseId, ghReleaseId } = await seedVideoAndGithubReleases(testDb.db);
    const db = asD1(testDb.db);

    const result = await runHybridSearch(minimalEnv, db, {
      query: TOKEN,
      mode: "lexical",
      topK: 20,
    });

    type Hit = (typeof result.hits)[number];
    type ReleaseHit = Extract<Hit, { kind: "release" }>;
    const releaseHits = result.hits.filter((h: Hit): h is ReleaseHit => h.kind === "release");

    const videoHit = releaseHits.find((h) => h.release.id === videoReleaseId);
    const ghHit = releaseHits.find((h) => h.release.id === ghReleaseId);

    expect(videoHit).toBeDefined();
    expect(videoHit?.release.source.video).toEqual({ provider: "youtube" });

    expect(ghHit).toBeDefined();
    // Non-video sources resolve to null (not undefined) so the wire shape is stable.
    expect(ghHit?.release.source.video ?? null).toBeNull();
  });
});
