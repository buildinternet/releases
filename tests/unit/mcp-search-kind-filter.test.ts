/**
 * Tests for the `kind` filter in the MCP `search` tool (tools.ts).
 *
 * Covers:
 * - Catalog section: product and source rows are filtered by `p.kind` /
 *   `s.kind` when `kind` is supplied.
 * - Release section (lexical path): COALESCE(s.kind, p.kind) must match.
 *
 * Without Vectorize bindings the hybrid path degrades to lexical, so both
 * the catalog SQL and release SQL paths are exercised by the tests below.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, products, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newSourceId, newReleaseId, newProductId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { search } from "../../workers/mcp/src/tools.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

async function seedFixture(db: TestDatabase["db"]) {
  const orgId = newOrgId();
  await db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });

  // Two sources: one sdk, one tool
  const sdkSrcId = newSourceId();
  await db.insert(sources).values({
    id: sdkSrcId,
    orgId,
    name: "Acme SDK",
    slug: "acme-sdk",
    type: "github",
    url: "https://github.com/acme/sdk",
    discovery: "curated",
    kind: "sdk",
  });

  const toolSrcId = newSourceId();
  await db.insert(sources).values({
    id: toolSrcId,
    orgId,
    name: "Acme Tool",
    slug: "acme-tool",
    type: "github",
    url: "https://github.com/acme/tool",
    discovery: "curated",
    kind: "tool",
  });

  // Two products: one sdk kind, one platform kind
  const sdkProdId = newProductId();
  await db.insert(products).values({
    id: sdkProdId,
    orgId,
    name: "Acme SDK Product",
    slug: "acme-sdk-product",
    kind: "sdk",
  });

  const platformProdId = newProductId();
  await db.insert(products).values({
    id: platformProdId,
    orgId,
    name: "Acme Platform Product",
    slug: "acme-platform-product",
    kind: "platform",
  });

  // Two releases, one per source — share "quantum" for FTS hits
  const sdkReleaseId = newReleaseId();
  const toolReleaseId = newReleaseId();

  await db.insert(releases).values([
    {
      id: sdkReleaseId,
      sourceId: sdkSrcId,
      title: "quantum sdk release",
      content: "sdk quantum improvement",
      publishedAt: "2026-05-01T00:00:00Z",
      type: "feature",
    },
    {
      id: toolReleaseId,
      sourceId: toolSrcId,
      title: "quantum tool release",
      content: "tool quantum improvement",
      publishedAt: "2026-05-02T00:00:00Z",
      type: "feature",
    },
  ]);

  return { orgId, sdkSrcId, toolSrcId, sdkProdId, platformProdId, sdkReleaseId, toolReleaseId };
}

describe("search — kind filter on catalog section", () => {
  it("returns both sources when kind is unset", async () => {
    await seedFixture(testDb.db);
    const db = asD1(testDb.db);

    const out = await search(db, { query: "acme", type: ["catalog"] });
    const slugs = out.result.content[0].text;

    expect(slugs).toContain("acme-sdk");
    expect(slugs).toContain("acme-tool");
  });

  it("kind='sdk' returns only the sdk source", async () => {
    await seedFixture(testDb.db);
    const db = asD1(testDb.db);

    const out = await search(db, { query: "acme", type: ["catalog"], kind: "sdk" });
    const text = out.result.content[0].text;

    expect(text).toContain("acme-sdk");
    expect(text).not.toContain("acme-tool");
  });

  it("kind='tool' returns only the tool source", async () => {
    await seedFixture(testDb.db);
    const db = asD1(testDb.db);

    const out = await search(db, { query: "acme", type: ["catalog"], kind: "tool" });
    const text = out.result.content[0].text;

    expect(text).toContain("acme-tool");
    expect(text).not.toContain("acme-sdk");
  });

  it("kind='sdk' returns the sdk product", async () => {
    await seedFixture(testDb.db);
    const db = asD1(testDb.db);

    const out = await search(db, { query: "acme", type: ["catalog"], kind: "sdk" });
    const text = out.result.content[0].text;

    expect(text).toContain("acme-sdk-product");
    expect(text).not.toContain("acme-platform-product");
  });
});

describe("search — kind filter on releases section (lexical path)", () => {
  it("returns both releases when kind is unset", async () => {
    await seedFixture(testDb.db);
    const db = asD1(testDb.db);

    const out = await search(db, { query: "quantum", type: ["releases"], mode: "lexical" });
    const text = out.result.content[0].text;

    expect(text).toContain("quantum sdk release");
    expect(text).toContain("quantum tool release");
  });

  it("kind='sdk' excludes the tool release (lexical)", async () => {
    await seedFixture(testDb.db);
    const db = asD1(testDb.db);

    const out = await search(db, {
      query: "quantum",
      type: ["releases"],
      mode: "lexical",
      kind: "sdk",
    });
    const text = out.result.content[0].text;

    expect(text).toContain("quantum sdk release");
    expect(text).not.toContain("quantum tool release");
  });

  it("kind='tool' excludes the sdk release (lexical)", async () => {
    await seedFixture(testDb.db);
    const db = asD1(testDb.db);

    const out = await search(db, {
      query: "quantum",
      type: ["releases"],
      mode: "lexical",
      kind: "tool",
    });
    const text = out.result.content[0].text;

    expect(text).toContain("quantum tool release");
    expect(text).not.toContain("quantum sdk release");
  });
});
