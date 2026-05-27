/**
 * #1195: MCP `search` should surface a release's owning product (parity with
 * /v1/search, whose SearchReleaseHit carries `productSlug`). The MCP surface is
 * markdown, so parity = an additive `product: <orgSlug>/<productSlug>` line on
 * release hits when the source belongs to a product — across both the lexical
 * inline-SQL path and the hybrid (degraded-to-lexical) path.
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

async function seedProductRelease(db: TestDatabase["db"]) {
  const orgId = newOrgId();
  await db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });
  const productId = newProductId();
  await db.insert(products).values({ id: productId, orgId, name: "Widgets", slug: "widgets" });
  const srcId = newSourceId();
  // Source slug intentionally does NOT overlap the product slug ("widgets") so
  // a `toContain("acme/widgets")` assertion can't be satisfied by the source
  // coordinate (`acme/sdk-lib`) — only by the rendered product coordinate.
  await db.insert(sources).values({
    id: srcId,
    orgId,
    productId,
    name: "SDK Lib",
    slug: "sdk-lib",
    type: "github",
    url: "https://github.com/acme/sdk-lib",
    discovery: "curated",
  });
  const relId = newReleaseId();
  await db.insert(releases).values({
    id: relId,
    sourceId: srcId,
    title: "quantum widget release",
    content: "shipped quantum widget improvements",
    publishedAt: "2026-04-01T00:00:00Z",
    type: "feature",
  });
  return { relId };
}

async function seedOrphanRelease(db: TestDatabase["db"]) {
  const orgId = newOrgId();
  await db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });
  const srcId = newSourceId();
  await db.insert(sources).values({
    id: srcId,
    orgId,
    name: "Acme Orphan",
    slug: "acme-orphan",
    type: "github",
    url: "https://github.com/acme/orphan",
    discovery: "curated",
  });
  const relId = newReleaseId();
  await db.insert(releases).values({
    id: relId,
    sourceId: srcId,
    title: "quantum orphan release",
    content: "shipped quantum orphan improvements",
    publishedAt: "2026-04-01T00:00:00Z",
    type: "feature",
  });
  return { relId };
}

describe("MCP search — productSlug parity (#1195)", () => {
  it("lexical: surfaces orgSlug/productSlug for a release whose source belongs to a product", async () => {
    await seedProductRelease(testDb.db);
    const ret = await search(asD1(testDb.db), {
      query: "quantum",
      mode: "lexical",
      type: ["releases"],
    });
    const out = ret.result.content[0].text as string;
    expect(out).toContain("quantum widget release");
    expect(out).toContain("acme/widgets");
  });

  it("lexical: no product line for an orphan source (productSlug null)", async () => {
    await seedOrphanRelease(testDb.db);
    const ret = await search(asD1(testDb.db), {
      query: "quantum",
      mode: "lexical",
      type: ["releases"],
    });
    const out = ret.result.content[0].text as string;
    expect(out).toContain("quantum orphan release");
    expect(out).not.toContain("product:");
  });

  it("hybrid (degraded to lexical): also surfaces the product coordinate — parity across modes", async () => {
    await seedProductRelease(testDb.db);
    const ret = await search(
      asD1(testDb.db),
      { query: "quantum", mode: "hybrid", type: ["releases"] },
      minimalEnv,
    );
    const out = ret.result.content[0].text as string;
    expect(out).toContain("quantum widget release");
    expect(out).toContain("acme/widgets");
  });
});
