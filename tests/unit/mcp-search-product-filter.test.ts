/**
 * MCP `search` — `product` input parameter (#1218).
 *
 * Tests cover:
 *  - prod_ typed ID → resolves and scopes release results
 *  - org/slug coordinate → resolves and scopes release results
 *  - bare slug → rejected with a clear error message
 *  - unknown product → "not found" message
 *  - product with no sources → "no sources yet" message
 *  - productEcho on counts (flows into _meta.search.product via withSearchLog)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newProductId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { search } from "../../workers/mcp/src/tools.js";
import type { HybridSearchEnv } from "../../workers/mcp/src/lib/search-hybrid.js";

/** No Vectorize/embedder → hybrid/semantic degrade to lexical. */
const minimalEnv: HybridSearchEnv = {};

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

type SeedResult = {
  orgSlug: string;
  productSlug: string;
  productId: string;
  sourceId: string;
};

async function seedProductWithRelease(db: TestDatabase["db"], label: string): Promise<SeedResult> {
  const orgId = newOrgId();
  const orgSlug = `org-${label}`;
  await db.insert(organizations).values({ id: orgId, name: `Org ${label}`, slug: orgSlug });

  const productId = newProductId();
  const productSlug = `product-${label}`;
  await db.insert(products).values({
    id: productId,
    orgId,
    name: `Product ${label}`,
    slug: productSlug,
  });

  const sourceId = newSourceId();
  await db.insert(sources).values({
    id: sourceId,
    orgId,
    productId,
    name: `Source ${label}`,
    slug: `source-${label}`,
    type: "github",
    url: `https://github.com/org-${label}/repo-${label}`,
    discovery: "curated",
  });

  const relId = newReleaseId();
  await db.insert(releases).values({
    id: relId,
    sourceId,
    title: `release ${label} feature`,
    content: `shipped ${label} widget improvements`,
    publishedAt: "2026-04-01T00:00:00Z",
    type: "feature",
  });

  return { orgSlug, productSlug, productId, sourceId };
}

describe("MCP search — product filter (#1218)", () => {
  describe("prod_ typed ID", () => {
    it("scopes release results to the product when a valid prod_ ID is supplied", async () => {
      const { productId, productSlug, orgSlug } = await seedProductWithRelease(testDb.db, "alpha");
      // Seed a second product/release that should NOT appear.
      await seedProductWithRelease(testDb.db, "beta");

      const ret = await search(
        asD1(testDb.db),
        { query: "widget", mode: "lexical", type: ["releases"], product: productId },
        minimalEnv,
      );
      const out = ret.result.content[0].text as string;
      expect(out).toContain("alpha widget");
      expect(out).not.toContain("beta widget");
      // productEcho lands in counts.product for withSearchLog/_meta.search.product
      expect(ret.counts.product).toBe(`${orgSlug}/${productSlug}`);
    });
  });

  describe("orgSlug/productSlug coordinate", () => {
    it("scopes release results to the product via coordinate", async () => {
      const { orgSlug, productSlug } = await seedProductWithRelease(testDb.db, "gamma");
      await seedProductWithRelease(testDb.db, "delta");

      const coordinate = `${orgSlug}/${productSlug}`;
      const ret = await search(
        asD1(testDb.db),
        { query: "widget", mode: "lexical", type: ["releases"], product: coordinate },
        minimalEnv,
      );
      const out = ret.result.content[0].text as string;
      expect(out).toContain("gamma widget");
      expect(out).not.toContain("delta widget");
      expect(ret.counts.product).toBe(coordinate);
    });
  });

  describe("bare slug rejection", () => {
    it("returns an error message for a bare slug (no / and no prod_ prefix)", async () => {
      const ret = await search(
        asD1(testDb.db),
        { query: "widget", mode: "lexical", product: "nextjs" },
        minimalEnv,
      );
      const out = ret.result.content[0].text as string;
      expect(out).toContain("ambiguous");
      expect(ret.counts.product).toBeUndefined();
    });
  });

  describe("unknown product", () => {
    it("returns a 'not found' message for an unrecognized prod_ ID", async () => {
      const ret = await search(
        asD1(testDb.db),
        { query: "widget", mode: "lexical", product: "prod_doesnotexist" },
        minimalEnv,
      );
      const out = ret.result.content[0].text as string;
      expect(out).toContain("No product found");
      expect(ret.counts.product).toBeUndefined();
    });

    it("returns a 'not found' message for an unrecognized coordinate", async () => {
      const ret = await search(
        asD1(testDb.db),
        { query: "widget", mode: "lexical", product: "unknown-org/unknown-product" },
        minimalEnv,
      );
      const out = ret.result.content[0].text as string;
      expect(out).toContain("No product found");
    });
  });

  describe("product with no sources", () => {
    it("returns a 'no sources yet' message for an empty product", async () => {
      const orgId = newOrgId();
      await testDb.db
        .insert(organizations)
        .values({ id: orgId, name: "Empty Org", slug: "empty-org" });
      const productId = newProductId();
      await testDb.db
        .insert(products)
        .values({ id: productId, orgId, name: "Empty Product", slug: "empty-product" });

      const ret = await search(
        asD1(testDb.db),
        { query: "anything", mode: "lexical", product: productId },
        minimalEnv,
      );
      const out = ret.result.content[0].text as string;
      expect(out).toContain("no sources yet");
    });
  });

  describe("entity takes precedence over product", () => {
    it("ignores product when entity is also supplied", async () => {
      const { orgSlug, productSlug, sourceId } = await seedProductWithRelease(testDb.db, "epsilon");
      const coordinate = `${orgSlug}/${`source-epsilon`}`;
      // The entity filter (scoped to the source) takes precedence; product is ignored.
      const ret = await search(
        asD1(testDb.db),
        {
          query: "widget",
          mode: "lexical",
          type: ["releases"],
          entity: sourceId,
          product: `${orgSlug}/${productSlug}`,
        },
        minimalEnv,
      );
      // Should still find the release (entity correctly resolves to the same source)
      const out = ret.result.content[0].text as string;
      expect(out).toContain("epsilon widget");
      // product echo not set because entity took precedence
      expect(ret.counts.product).toBeUndefined();
      void coordinate; // suppress unused var warning
    });
  });

  describe("hybrid mode degrades to lexical with product filter", () => {
    it("still returns scoped results when hybrid degrades", async () => {
      const { orgSlug, productSlug } = await seedProductWithRelease(testDb.db, "zeta");
      await seedProductWithRelease(testDb.db, "omega"); // use a label without a substring of "zeta"

      const ret = await search(
        asD1(testDb.db),
        {
          query: "widget",
          mode: "hybrid",
          type: ["releases"],
          product: `${orgSlug}/${productSlug}`,
        },
        minimalEnv, // No Vectorize → degrades to lexical
      );
      const out = ret.result.content[0].text as string;
      expect(out).toContain("release zeta feature");
      expect(out).not.toContain("release omega feature");
      expect(ret.counts.product).toBe(`${orgSlug}/${productSlug}`);
    });
  });
});
