import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newProductId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { listCatalog, getCatalogEntry, search } from "../../workers/mcp/src/tools.js";

function resultText(r: { content: Array<{ type: string; text?: string }> }): string {
  const first = r.content[0];
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected text result");
  }
  return first.text;
}

async function seed(db: TestDatabase["db"]) {
  const vercelId = newOrgId();
  const anthropicId = newOrgId();
  await db.insert(organizations).values([
    { id: vercelId, name: "Vercel", slug: "vercel", domain: "vercel.com" },
    { id: anthropicId, name: "Anthropic", slug: "anthropic", domain: "anthropic.com" },
  ]);

  const nextjsId = newProductId();
  const turborepoId = newProductId();
  await db.insert(products).values([
    { id: nextjsId, orgId: vercelId, name: "Next.js", slug: "nextjs" },
    { id: turborepoId, orgId: vercelId, name: "Turborepo", slug: "turborepo" },
  ]);

  const nextjsSrcId = newSourceId();
  const turborepoSrcId = newSourceId();
  const claudeSrcId = newSourceId();
  await db.insert(sources).values([
    {
      id: nextjsSrcId,
      orgId: vercelId,
      productId: nextjsId,
      name: "next.js",
      slug: "next-js",
      type: "github",
      url: "https://github.com/vercel/next.js",
    },
    {
      id: turborepoSrcId,
      orgId: vercelId,
      productId: turborepoId,
      name: "Turborepo",
      slug: "turborepo-src",
      type: "github",
      url: "https://github.com/vercel/turborepo",
    },
    {
      id: claudeSrcId,
      orgId: anthropicId,
      productId: null,
      name: "Anthropic Release Notes",
      slug: "anthropic-releases",
      type: "scrape",
      url: "https://www.anthropic.com/news",
    },
  ]);

  await db.insert(releases).values([
    {
      id: newReleaseId(),
      sourceId: nextjsSrcId,
      title: "Next.js 15 — async request APIs",
      content: "We've made cookies, headers, and params async in Next.js 15.",
      url: "https://example.com/next-15",
      publishedAt: "2024-10-21T00:00:00Z",
    },
    {
      id: newReleaseId(),
      sourceId: claudeSrcId,
      title: "Claude 4 release",
      content: "Claude 4 brings major reasoning improvements.",
      url: "https://example.com/claude-4",
      publishedAt: "2025-05-01T00:00:00Z",
    },
  ]);

  return { vercelId, anthropicId, nextjsId, nextjsSrcId, claudeSrcId };
}

describe("list_catalog", () => {
  let fixture: TestDatabase;

  beforeAll(() => {
    fixture = createTestDb();
  });
  afterAll(() => {
    fixture.cleanup();
  });
  beforeEach(async () => {
    clearAllTables(fixture.db);
    await seed(fixture.db);
  });

  it("folds products and standalone sources into one list with kind discriminator", async () => {
    const text = resultText(await listCatalog(asD1(fixture.db), {}));
    // Two products under Vercel, one standalone source under Anthropic.
    expect(text).toContain("**Next.js** _(product)_");
    expect(text).toContain("**Turborepo** _(product)_");
    expect(text).toContain("**Anthropic Release Notes** _(source)_");
  });

  it("scopes to one organization when organization is passed", async () => {
    const text = resultText(await listCatalog(asD1(fixture.db), { organization: "anthropic" }));
    expect(text).toContain("**Anthropic Release Notes** _(source)_");
    expect(text).not.toContain("Next.js");
  });

  it("returns a friendly message when the org filter doesn't match", async () => {
    const text = resultText(
      await listCatalog(asD1(fixture.db), { organization: "does-not-exist" }),
    );
    expect(text).toContain('No organization found matching "does-not-exist"');
  });
});

describe("get_catalog_entry", () => {
  let fixture: TestDatabase;

  beforeAll(() => {
    fixture = createTestDb();
  });
  afterAll(() => {
    fixture.cleanup();
  });
  beforeEach(async () => {
    clearAllTables(fixture.db);
    await seed(fixture.db);
  });

  it("resolves a product slug to product detail", async () => {
    const text = resultText(await getCatalogEntry(asD1(fixture.db), { identifier: "nextjs" }));
    expect(text).toContain("**Product: Next.js**");
    // Product detail lists its grouped sources.
    expect(text).toContain("next-js");
  });

  it("resolves a standalone source slug to source detail", async () => {
    const text = resultText(
      await getCatalogEntry(asD1(fixture.db), { identifier: "anthropic-releases" }),
    );
    expect(text).toContain("**Source: Anthropic Release Notes**");
    expect(text).toContain("Product: none");
  });

  it("returns a friendly message when the identifier doesn't resolve", async () => {
    const text = resultText(
      await getCatalogEntry(asD1(fixture.db), { identifier: "nothing-matches" }),
    );
    expect(text).toContain('No catalog entry found matching "nothing-matches"');
  });
});

describe("search (unified)", () => {
  let fixture: TestDatabase;

  beforeAll(() => {
    fixture = createTestDb();
  });
  afterAll(() => {
    fixture.cleanup();
  });
  beforeEach(async () => {
    clearAllTables(fixture.db);
    await seed(fixture.db);
  });

  it("returns all three sections by default when each has matches", async () => {
    // Lexical mode stays purely in-DB so no Vectorize bindings are needed.
    const text = resultText(await search(asD1(fixture.db), { query: "next", mode: "lexical" }));
    expect(text).toContain("## Catalog");
    expect(text).toContain("Next.js");
  });

  it("restricts to catalog only when type filter is passed", async () => {
    const text = resultText(
      await search(asD1(fixture.db), {
        query: "next",
        type: ["catalog"],
        mode: "lexical",
      }),
    );
    expect(text).toContain("## Catalog");
    expect(text).not.toContain("## Releases");
  });

  it("narrows release results via entity filter (product slug)", async () => {
    const text = resultText(
      await search(asD1(fixture.db), {
        query: "async",
        type: ["releases"],
        entity: "nextjs",
        mode: "lexical",
      }),
    );
    expect(text).toContain("Next.js 15");
    expect(text).not.toContain("Claude 4 release");
  });

  it("narrows release results via entity filter (source slug)", async () => {
    const text = resultText(
      await search(asD1(fixture.db), {
        query: "Claude",
        type: ["releases"],
        entity: "anthropic-releases",
        mode: "lexical",
      }),
    );
    expect(text).toContain("Claude 4 release");
    expect(text).not.toContain("Next.js 15");
  });

  it("returns a friendly message when the entity filter doesn't match", async () => {
    const text = resultText(
      await search(asD1(fixture.db), {
        query: "anything",
        entity: "never-heard-of-it",
        mode: "lexical",
      }),
    );
    expect(text).toContain('No catalog entry found matching "never-heard-of-it"');
  });
});
