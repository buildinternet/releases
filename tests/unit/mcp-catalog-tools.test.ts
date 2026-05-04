import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
  organizations,
  products,
  sources,
  releases,
  knowledgePages,
  sourceChangelogFiles,
} from "@buildinternet/releases-core/schema";
import {
  newOrgId,
  newProductId,
  newSourceId,
  newReleaseId,
  newKnowledgePageId,
  newSourceChangelogFileId,
} from "@buildinternet/releases-core/id";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import {
  listCatalog,
  getCatalogEntry,
  getOrganization,
  getLatestReleases,
  listSources,
  listProducts,
  search,
} from "../../workers/mcp/src/tools.js";

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

  it("surfaces org-scoped coordinates so agents can round-trip identifiers", async () => {
    const text = resultText(await listCatalog(asD1(fixture.db), {}));
    // Products should use org/slug form, not bare slug.
    expect(text).toContain("vercel/nextjs");
    expect(text).toContain("vercel/turborepo");
    // Standalone source should also use org/slug.
    expect(text).toContain("anthropic/anthropic-releases");
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

  it("resolves an org-scoped product coordinate to product detail", async () => {
    const text = resultText(
      await getCatalogEntry(asD1(fixture.db), { identifier: "vercel/nextjs" }),
    );
    expect(text).toContain("**Product: Next.js**");
    // Product detail lists its grouped sources with org-scoped slugs.
    expect(text).toContain("vercel/next-js");
  });

  it("resolves an org-scoped source coordinate to source detail", async () => {
    const text = resultText(
      await getCatalogEntry(asD1(fixture.db), { identifier: "anthropic/anthropic-releases" }),
    );
    expect(text).toContain("**Source: Anthropic Release Notes**");
    expect(text).toContain("Product: none");
    // Source detail slug field must be org-scoped.
    expect(text).toContain("anthropic/anthropic-releases");
  });

  it("resolves a prod_ id to product detail", async () => {
    const [prodRow] = await fixture.db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.slug, "nextjs"))
      .limit(1);
    const text = resultText(await getCatalogEntry(asD1(fixture.db), { identifier: prodRow.id }));
    expect(text).toContain("**Product: Next.js**");
  });

  it("resolves a src_ id to source detail", async () => {
    const [srcRow] = await fixture.db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.slug, "anthropic-releases"))
      .limit(1);
    const text = resultText(await getCatalogEntry(asD1(fixture.db), { identifier: srcRow.id }));
    expect(text).toContain("**Source: Anthropic Release Notes**");
  });

  it("rejects a bare slug with a friendly migration hint", async () => {
    const text = resultText(await getCatalogEntry(asD1(fixture.db), { identifier: "nextjs" }));
    expect(text).toContain("Bare slug");
    expect(text).toContain("org-scoped");
    expect(text).toContain("vercel/nextjs");
  });

  it("returns a friendly message when the org-scoped identifier doesn't resolve", async () => {
    const text = resultText(
      await getCatalogEntry(asD1(fixture.db), { identifier: "vercel/nothing-matches" }),
    );
    expect(text).toContain('No catalog entry found matching "vercel/nothing-matches"');
  });

  it("lists tracked changelog files for a source without embedding content by default", async () => {
    const [srcRow] = await fixture.db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.slug, "anthropic-releases"))
      .limit(1);
    await fixture.db.insert(sourceChangelogFiles).values([
      {
        id: newSourceChangelogFileId(),
        sourceId: srcRow.id,
        path: "CHANGELOG.md",
        filename: "CHANGELOG.md",
        url: "https://github.com/anthropic/example/blob/main/CHANGELOG.md",
        rawUrl: "https://raw.githubusercontent.com/anthropic/example/main/CHANGELOG.md",
        content: "# CHANGELOG\n\n## v1.0.0\n\n- UNIQUE_MARKER_ROOT body line\n",
        contentHash: "hash-root",
        bytes: 128,
      },
      {
        id: newSourceChangelogFileId(),
        sourceId: srcRow.id,
        path: "packages/core/CHANGELOG.md",
        filename: "CHANGELOG.md",
        url: "https://github.com/anthropic/example/blob/main/packages/core/CHANGELOG.md",
        rawUrl:
          "https://raw.githubusercontent.com/anthropic/example/main/packages/core/CHANGELOG.md",
        content: "# core CHANGELOG\n\n## v0.1.0\n\n- UNIQUE_MARKER_CORE body line\n",
        contentHash: "hash-core",
        bytes: 64,
      },
    ]);

    const text = resultText(
      await getCatalogEntry(asD1(fixture.db), {
        identifier: "anthropic/anthropic-releases",
      }),
    );
    expect(text).toContain("CHANGELOG.md");
    expect(text).toContain("packages/core/CHANGELOG.md");
    // Sizes surface in the listing.
    expect(text).toContain("128");
    // Body content must NOT be embedded in the default response.
    expect(text).not.toContain("UNIQUE_MARKER_ROOT");
    expect(text).not.toContain("UNIQUE_MARKER_CORE");
    // Advertise how to expand.
    expect(text).toContain("include_changelog");
  });

  it("embeds the root changelog slice when include_changelog is true", async () => {
    const [srcRow] = await fixture.db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.slug, "anthropic-releases"))
      .limit(1);
    await fixture.db.insert(sourceChangelogFiles).values({
      id: newSourceChangelogFileId(),
      sourceId: srcRow.id,
      path: "CHANGELOG.md",
      filename: "CHANGELOG.md",
      url: "https://github.com/anthropic/example/blob/main/CHANGELOG.md",
      rawUrl: "https://raw.githubusercontent.com/anthropic/example/main/CHANGELOG.md",
      content: "# CHANGELOG\n\n## v1.0.0\n\n- UNIQUE_MARKER_ROOT body line\n",
      contentHash: "hash-root",
      bytes: 64,
    });

    const text = resultText(
      await getCatalogEntry(asD1(fixture.db), {
        identifier: "anthropic/anthropic-releases",
        include_changelog: true,
      }),
    );
    expect(text).toContain("UNIQUE_MARKER_ROOT");
  });

  it("routes to a specific path when changelog_path is passed", async () => {
    const [srcRow] = await fixture.db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.slug, "anthropic-releases"))
      .limit(1);
    await fixture.db.insert(sourceChangelogFiles).values([
      {
        id: newSourceChangelogFileId(),
        sourceId: srcRow.id,
        path: "CHANGELOG.md",
        filename: "CHANGELOG.md",
        url: "https://example.com/CHANGELOG.md",
        rawUrl: "https://example.com/CHANGELOG.md",
        content: "# root\n\n- UNIQUE_MARKER_ROOT\n",
        contentHash: "h1",
        bytes: 32,
      },
      {
        id: newSourceChangelogFileId(),
        sourceId: srcRow.id,
        path: "packages/core/CHANGELOG.md",
        filename: "CHANGELOG.md",
        url: "https://example.com/packages/core/CHANGELOG.md",
        rawUrl: "https://example.com/packages/core/CHANGELOG.md",
        content: "# core\n\n- UNIQUE_MARKER_CORE\n",
        contentHash: "h2",
        bytes: 32,
      },
    ]);

    const text = resultText(
      await getCatalogEntry(asD1(fixture.db), {
        identifier: "anthropic/anthropic-releases",
        changelog_path: "packages/core/CHANGELOG.md",
      }),
    );
    // Passing a slicing param is sufficient to embed; no need to also pass include_changelog.
    expect(text).toContain("UNIQUE_MARKER_CORE");
    expect(text).not.toContain("UNIQUE_MARKER_ROOT");
  });

  it("does not show changelog sections for product-kind entries", async () => {
    const text = resultText(
      await getCatalogEntry(asD1(fixture.db), { identifier: "vercel/nextjs" }),
    );
    expect(text).not.toContain("include_changelog");
    expect(text).not.toContain("CHANGELOG.md");
  });
});

describe("get_organization (overview consolidation)", () => {
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

  const longOverview = [
    "Vercel has shipped a wave of infrastructure updates across the last quarter.",
    "",
    "In particular, the team has focused on Next.js 15 async APIs, Turbopack stability",
    "improvements, and a new observability surface called OTEL_MARKER_LATE that only",
    "appears deep in the overview body. The briefing then continues with a long list",
    "of smaller rollouts that would not fit in an inline preview.",
  ].join("\n");

  it("shows a preview of the overview by default and hints at the expand flag", async () => {
    const [org] = await fixture.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, "vercel"))
      .limit(1);
    await fixture.db.insert(knowledgePages).values({
      id: newKnowledgePageId(),
      scope: "org",
      orgId: org.id,
      content: longOverview,
      releaseCount: 12,
    });

    const text = resultText(await getOrganization(asD1(fixture.db), { identifier: "vercel" }));
    expect(text).toContain("**Overview**");
    // Preview includes the opening sentence.
    expect(text).toContain("Vercel has shipped");
    // The late marker lives past the first paragraph and must be trimmed.
    expect(text).not.toContain("OTEL_MARKER_LATE");
    // Tell the caller how to expand.
    expect(text).toContain("include_overview");
  });

  it("inlines the full overview when include_overview is true", async () => {
    const [org] = await fixture.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, "vercel"))
      .limit(1);
    await fixture.db.insert(knowledgePages).values({
      id: newKnowledgePageId(),
      scope: "org",
      orgId: org.id,
      content: longOverview,
      releaseCount: 12,
    });

    const text = resultText(
      await getOrganization(asD1(fixture.db), {
        identifier: "vercel",
        include_overview: true,
      }),
    );
    expect(text).toContain("OTEL_MARKER_LATE");
    // When fully inlined, the preview-expansion hint should not appear.
    expect(text).not.toContain("Pass `include_overview`");
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
    const text = resultText(
      (await search(asD1(fixture.db), { query: "next", mode: "lexical" })).result,
    );
    expect(text).toContain("## Catalog");
    expect(text).toContain("Next.js");
  });

  it("restricts to catalog only when type filter is passed", async () => {
    const text = resultText(
      (
        await search(asD1(fixture.db), {
          query: "next",
          type: ["catalog"],
          mode: "lexical",
        })
      ).result,
    );
    expect(text).toContain("## Catalog");
    expect(text).not.toContain("## Releases");
  });

  it("narrows release results via entity filter (org-scoped product coordinate)", async () => {
    const text = resultText(
      (
        await search(asD1(fixture.db), {
          query: "async",
          type: ["releases"],
          entity: "vercel/nextjs",
          mode: "lexical",
        })
      ).result,
    );
    expect(text).toContain("Next.js 15");
    expect(text).not.toContain("Claude 4 release");
  });

  it("narrows release results via entity filter (org-scoped source coordinate)", async () => {
    const text = resultText(
      (
        await search(asD1(fixture.db), {
          query: "Claude",
          type: ["releases"],
          entity: "anthropic/anthropic-releases",
          mode: "lexical",
        })
      ).result,
    );
    expect(text).toContain("Claude 4 release");
    expect(text).not.toContain("Next.js 15");
  });

  it("narrows release results via entity filter (prod_ id)", async () => {
    const [prodRow] = await fixture.db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.slug, "nextjs"))
      .limit(1);
    const text = resultText(
      (
        await search(asD1(fixture.db), {
          query: "async",
          type: ["releases"],
          entity: prodRow.id,
          mode: "lexical",
        })
      ).result,
    );
    expect(text).toContain("Next.js 15");
  });

  it("rejects a bare slug entity filter with a migration hint", async () => {
    const text = resultText(
      (
        await search(asD1(fixture.db), {
          query: "anything",
          entity: "nextjs",
          mode: "lexical",
        })
      ).result,
    );
    expect(text).toContain("Bare slug");
    expect(text).toContain("org-scoped");
  });

  it("returns a friendly message when the org-scoped entity filter doesn't match", async () => {
    const text = resultText(
      (
        await search(asD1(fixture.db), {
          query: "anything",
          entity: "vercel/never-heard-of-it",
          mode: "lexical",
        })
      ).result,
    );
    expect(text).toContain('No catalog entry found matching "vercel/never-heard-of-it"');
  });

  it("populates per-section hit counts", async () => {
    const out = await search(asD1(fixture.db), { query: "next", mode: "lexical" });
    expect(out.counts.orgHits).toBeGreaterThanOrEqual(0);
    expect(out.counts.catalogHits).toBeGreaterThan(0);
    expect(out.counts.releaseHits).toBeGreaterThanOrEqual(0);
    expect(out.counts.chunkHits).toBe(0);
  });

  it("emits org-scoped coordinates in catalog section", async () => {
    const text = resultText(
      (await search(asD1(fixture.db), { query: "next", type: ["catalog"], mode: "lexical" }))
        .result,
    );
    // Bare "nextjs" must not appear without an org prefix in the catalog lines.
    expect(text).toContain("vercel/nextjs");
  });
});

describe("list_sources (round-trippable slugs)", () => {
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

  it("surfaces org-scoped slug coordinates instead of bare slugs", async () => {
    const text = resultText(await listSources(asD1(fixture.db), {}));
    expect(text).toContain("vercel/next-js");
    expect(text).toContain("vercel/turborepo-src");
    expect(text).toContain("anthropic/anthropic-releases");
  });

  it("still scopes correctly when filtered by org", async () => {
    const text = resultText(await listSources(asD1(fixture.db), { organization: "vercel" }));
    expect(text).toContain("vercel/next-js");
    expect(text).not.toContain("anthropic");
  });
});

describe("list_products (round-trippable slugs)", () => {
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

  it("surfaces org-scoped slug coordinates instead of bare slugs", async () => {
    const text = resultText(await listProducts(asD1(fixture.db), {}));
    expect(text).toContain("vercel/nextjs");
    expect(text).toContain("vercel/turborepo");
  });
});

describe("get_organization (round-trippable entity coordinates)", () => {
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

  it("emits org-scoped product coordinates in org detail", async () => {
    const text = resultText(await getOrganization(asD1(fixture.db), { identifier: "vercel" }));
    expect(text).toContain("vercel/nextjs");
    expect(text).toContain("vercel/turborepo");
  });

  it("emits org-scoped source coordinates in org detail", async () => {
    const text = resultText(await getOrganization(asD1(fixture.db), { identifier: "vercel" }));
    expect(text).toContain("vercel/next-js");
    expect(text).toContain("vercel/turborepo-src");
  });

  it("resolves a typed org_ id via the PK fast-path", async () => {
    const [org] = await fixture.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, "vercel"))
      .limit(1);
    const text = resultText(await getOrganization(asD1(fixture.db), { identifier: org.id }));
    // Same record reaches the same renderer regardless of identifier shape.
    expect(text).toContain("Vercel");
  });
});

describe("get_latest_releases (round-trippable source coordinates)", () => {
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

  it("includes org-scoped source coordinate in release output", async () => {
    const text = resultText(await getLatestReleases(asD1(fixture.db), {}));
    // Both sources appear in the seed data; both must show up with an org prefix.
    expect(text).toContain("vercel/next-js");
    expect(text).toContain("anthropic/anthropic-releases");
  });
});
