/**
 * `attachCollectionPreviews` enriches already-merged collection search hits with
 * a small org-avatar preview, so the search card renders the same facepile as
 * the collections list page. Org-kind only, ordered by membership position,
 * capped at 3, and routed through `organizations_public` so hidden/on_demand
 * members never leak.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { organizations, collections, collectionMembers } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper";
import { asD1 } from "../../../tests/mcp-test-helpers";
import { attachCollectionPreviews } from "../src/queries/search.js";
import type { SearchCollectionHit } from "@buildinternet/releases-api-types";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = createTestDb();
  await testDb.db.insert(organizations).values([
    {
      id: "org_anth",
      slug: "anthropic",
      name: "Anthropic",
      category: "ai",
      avatarUrl: "https://x/a.png",
    },
    { id: "org_oai", slug: "openai", name: "OpenAI", category: "ai", avatarUrl: "https://x/o.png" },
    { id: "org_goog", slug: "google", name: "Google", category: "ai" },
    { id: "org_meta", slug: "meta", name: "Meta", category: "ai" },
    // on_demand parent — organizations_public filters it out, so its membership
    // must never reach the preview even though it sits at an early position.
    { id: "org_hidden", slug: "hidden", name: "Hidden", category: "ai", discovery: "on_demand" },
  ]);
  await testDb.db.insert(collections).values([
    { id: "col_ai", slug: "frontier-ai", name: "Frontier AI" },
    { id: "col_empty", slug: "empty-set", name: "Empty Set" },
  ]);
  await testDb.db.insert(collectionMembers).values([
    { collectionId: "col_ai", orgId: "org_hidden", position: 0 }, // filtered out
    { collectionId: "col_ai", orgId: "org_oai", position: 1 },
    { collectionId: "col_ai", orgId: "org_goog", position: 2 },
    { collectionId: "col_ai", orgId: "org_anth", position: 3 },
    { collectionId: "col_ai", orgId: "org_meta", position: 4 }, // past the cap of 3
  ]);
});

const hit = (slug: string, memberCount: number): SearchCollectionHit => ({
  slug,
  name: slug,
  description: null,
  memberCount,
  via: "direct",
});

describe("attachCollectionPreviews", () => {
  it("attaches an org-only preview ordered by position and capped at 3", async () => {
    const out = await attachCollectionPreviews(asD1(testDb.db), [hit("frontier-ai", 4)]);
    const preview = out[0].previewMembers!;
    expect(preview.map((m) => m.slug)).toEqual(["openai", "google", "anthropic"]);
    expect(preview.every((m) => m.kind === "org")).toBe(true);
  });

  it("excludes hidden/on_demand members via organizations_public", async () => {
    const out = await attachCollectionPreviews(asD1(testDb.db), [hit("frontier-ai", 4)]);
    expect(out[0].previewMembers!.some((m) => m.slug === "hidden")).toBe(false);
  });

  it("leaves a memberless collection without a previewMembers field", async () => {
    const out = await attachCollectionPreviews(asD1(testDb.db), [hit("empty-set", 0)]);
    expect(out[0].previewMembers).toBeUndefined();
  });

  it("short-circuits an empty hit list without a query", async () => {
    expect(await attachCollectionPreviews(asD1(testDb.db), [])).toEqual([]);
  });
});
