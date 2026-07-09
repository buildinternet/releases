/**
 * Hybrid release hydration omits full markdown `content` by default.
 * Callers that need the body pass `includeContent: true` (API route maps
 * `?include_content=true`). Summary always remains.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { runHybridSearch } from "../../workers/mcp/src/lib/search-hybrid.js";
import type { HybridSearchEnv } from "../../workers/mcp/src/lib/search-hybrid.js";

const minimalEnv: HybridSearchEnv = {};
const BODY = "full markdown body that must not ship on list hits by default";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

describe("hybrid content projection", () => {
  it("omits content by default; includes when opted in", async () => {
    const orgId = newOrgId();
    const sourceId = newSourceId();
    const releaseId = newReleaseId();
    await testDb.db.insert(organizations).values({
      id: orgId,
      slug: "acme",
      name: "Acme",
      category: "cloud",
    });
    await testDb.db.insert(sources).values({
      id: sourceId,
      slug: "changelog",
      name: "Changelog",
      type: "feed",
      url: "https://acme.test/c",
      orgId,
    });
    await testDb.db.insert(releases).values({
      id: releaseId,
      sourceId,
      title: "Ship it",
      summary: "Short summary",
      content: BODY,
      url: "https://acme.test/1",
      publishedAt: "2026-04-20T00:00:00Z",
    });

    const db = asD1(testDb.db);
    const off = await runHybridSearch(minimalEnv, db, {
      query: "Ship",
      mode: "lexical",
      topK: 5,
    });
    const hit = off.hits.find((h) => h.kind === "release");
    expect(hit?.kind).toBe("release");
    if (hit?.kind === "release") {
      expect(hit.release.content).toBeUndefined();
      expect(hit.release.summary).toBe("Short summary");
    }

    const on = await runHybridSearch(minimalEnv, db, {
      query: "Ship",
      mode: "lexical",
      topK: 5,
      includeContent: true,
    });
    const hitOn = on.hits.find((h) => h.kind === "release");
    expect(hitOn?.kind).toBe("release");
    if (hitOn?.kind === "release") {
      expect(hitOn.release.content).toBe(BODY);
    }
  });
});
