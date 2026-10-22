/**
 * Recency weighting reads `COALESCE(published_at, fetched_at)`. A query against
 * `created_at` throws on the real schema; `hybridSearch` swallows that error
 * and the boost never applies. Both rows below are undated on purpose so only
 * `fetched_at` can move the newer ingest ahead of the vector-ranked older one.
 */

import { afterEach, expect, test } from "bun:test";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { newOrgId, newReleaseId, newSourceId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { asD1 } from "../../../tests/mcp-test-helpers.js";
import { createWorkerSearch, type ResolvedEmbedConfig } from "./hybrid-search-worker.js";

const DAY_MS = 86_400_000;
const BODY =
  "Ships a documented workflow for scheduling recurring exports and notifying the owning team.";

let testDb: TestDatabase | undefined;

afterEach(() => {
  testDb?.cleanup();
  testDb = undefined;
});

const embedConfig: ResolvedEmbedConfig = {
  provider: "workers-ai",
  model: "@cf/baai/bge-base-en-v1.5",
  workersAi: {
    async run() {
      return { data: [[0.1, 0.2, 0.3]] };
    },
  },
};

test("recency boost ranks an undated release by fetched_at", async () => {
  testDb = createTestDb();
  const db = testDb.db;
  const orgId = newOrgId();
  const sourceId = newSourceId();
  const freshId = newReleaseId();
  const staleId = newReleaseId();
  const now = Date.now();

  await db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });
  await db.insert(sources).values({
    id: sourceId,
    orgId,
    name: "Acme",
    slug: "acme-releases",
    type: "github",
    url: "https://github.com/acme/acme",
    discovery: "curated",
  });
  await db.insert(releases).values([
    {
      id: freshId,
      sourceId,
      title: "Fresh export workflow",
      content: BODY,
      summary: BODY,
      url: "https://example.com/releases/fresh",
      publishedAt: null,
      fetchedAt: new Date(now - DAY_MS).toISOString(),
      type: "feature",
    },
    {
      id: staleId,
      sourceId,
      title: "Stale export workflow",
      content: BODY,
      summary: BODY,
      url: "https://example.com/releases/stale",
      publishedAt: null,
      fetchedAt: new Date(now - 800 * DAY_MS).toISOString(),
      type: "feature",
    },
  ]);

  const { runHybridSearch } = createWorkerSearch(async () => null);
  const result = await runHybridSearch(
    {
      RELEASES_INDEX: {
        async query() {
          return {
            matches: [
              { id: staleId, score: 0.99 },
              { id: freshId, score: 0.98 },
            ],
          };
        },
      },
      CHANGELOG_CHUNKS_INDEX: {
        async query() {
          return { matches: [] };
        },
      },
    },
    asD1(db),
    { query: "export workflow", mode: "semantic" },
    { embedConfig },
  );

  expect(result.degraded).toBe(false);
  expect(result.hits.filter((hit) => hit.kind === "release").map((hit) => hit.release.id)).toEqual([
    freshId,
    staleId,
  ]);
});
