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
  listOrganizations,
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

/**
 * Register the standard fixture lifecycle (createTestDb / cleanup /
 * clearAllTables + seed) inside a describe block. Returns an object whose
 * `db` getter resolves to the live fixture handle each time it's read, so
 * test bodies can keep writing `fixture.db` and `fixture.seeded` instead of
 * threading `let` bookkeeping through every block.
 */
function useFixture<T>(seedFn: (db: TestDatabase["db"]) => Promise<T>) {
  let inner: TestDatabase;
  let seeded: T;
  beforeAll(() => {
    inner = createTestDb();
  });
  afterAll(() => {
    inner.cleanup();
  });
  beforeEach(async () => {
    clearAllTables(inner.db);
    seeded = await seedFn(inner.db);
  });
  return {
    get db() {
      return inner.db;
    },
    get seeded() {
      return seeded;
    },
  };
}

describe("list_catalog", () => {
  const fixture = useFixture(seed);

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
  const fixture = useFixture(seed);

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
  const fixture = useFixture(seed);

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
  const fixture = useFixture(seed);

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
  const fixture = useFixture(seed);

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
  const fixture = useFixture(seed);

  it("surfaces org-scoped slug coordinates instead of bare slugs", async () => {
    const text = resultText(await listProducts(asD1(fixture.db), {}));
    expect(text).toContain("vercel/nextjs");
    expect(text).toContain("vercel/turborepo");
  });
});

describe("get_organization (round-trippable entity coordinates)", () => {
  const fixture = useFixture(seed);

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

describe("list_* pagination", () => {
  const fixture = useFixture(seed);

  // The shared seed gives us 2 orgs / 2 products / 3 sources / 3 catalog
  // entries. Limits below the total are enough to exercise the footer + slice
  // logic across all four list_* tools without growing the fixture.

  it("list_sources omits the footer when the page covers the total", async () => {
    const text = resultText(await listSources(asD1(fixture.db), {}));
    expect(text).not.toContain("Page ");
    expect(text).toContain("vercel/next-js");
    expect(text).toContain("anthropic/anthropic-releases");
  });

  it("list_sources renders a footer that echoes the active limit so paging is self-contained", async () => {
    const text = resultText(await listSources(asD1(fixture.db), { limit: 2 }));
    expect(text).toContain("Page 1 of 2 · Showing 2 of 3 sources.");
    expect(text).toContain("Pass `page: 2, limit: 2` to continue.");
  });

  it("list_sources page=2 returns the tail and drops the next-page hint", async () => {
    const text = resultText(await listSources(asD1(fixture.db), { limit: 2, page: 2 }));
    expect(text).toContain("Page 2 of 2 · Showing 1 of 3 sources.");
    expect(text).not.toContain("Pass `page: 3");
  });

  it("list_sources reports 'no sources on this page' beyond the last page", async () => {
    const text = resultText(await listSources(asD1(fixture.db), { limit: 2, page: 99 }));
    expect(text).toContain("No sources on this page.");
    expect(text).toContain("Page 99 of 2 · Showing 0 of 3 sources.");
  });

  it("list_sources past-end on a single-page result still shows the footer for context", async () => {
    // page=2 limit=50 against 3 rows: totalPages=1, but the caller asked for
    // page 2 — we owe them context, not a bare "no entries on this page".
    const text = resultText(await listSources(asD1(fixture.db), { page: 2 }));
    expect(text).toContain("No sources on this page.");
    expect(text).toContain("Page 2 of 1 · Showing 0 of 3 sources.");
  });

  it("list_products paginates products with a single-row limit", async () => {
    const text = resultText(await listProducts(asD1(fixture.db), { limit: 1 }));
    expect(text).toContain("Page 1 of 2 · Showing 1 of 2 products.");
    expect(text).toContain("Pass `page: 2, limit: 1` to continue.");
  });

  it("list_organizations paginates orgs with a single-row limit", async () => {
    const text = resultText(await listOrganizations(asD1(fixture.db), { limit: 1 }));
    expect(text).toContain("Page 1 of 2 · Showing 1 of 2 organizations.");
    // Filter-respecting count: query that matches one row should report 1 of 1
    // and skip the footer (single page).
    const filtered = resultText(
      await listOrganizations(asD1(fixture.db), { query: "Vercel", limit: 1 }),
    );
    expect(filtered).not.toContain("Page ");
    expect(filtered).toContain("**Vercel**");
  });

  it("list_catalog paginates merged products + standalone sources", async () => {
    const text = resultText(await listCatalog(asD1(fixture.db), { limit: 2 }));
    expect(text).toContain("Page 1 of 2 · Showing 2 of 3 catalog entries.");
    expect(text).toContain("Pass `page: 2, limit: 2` to continue.");
  });

  it("list_catalog scopes the total to the org filter", async () => {
    const text = resultText(
      await listCatalog(asD1(fixture.db), { organization: "anthropic", limit: 1 }),
    );
    // Anthropic seed contains exactly one entry — no pagination footer.
    expect(text).not.toContain("Page ");
    expect(text).toContain("anthropic/anthropic-releases");
  });

  it("list_sources empty result still returns the no-content message", async () => {
    clearAllTables(fixture.db);
    const text = resultText(await listSources(asD1(fixture.db), {}));
    expect(text).toBe("No sources indexed yet.");
  });
});

describe("list_* _meta.pagination", () => {
  const fixture = useFixture(seed);

  it("populates _meta.pagination with hasMore + nextPage on a multi-page result", async () => {
    // 3 sources, limit=2 → page 1 has more.
    const result = await listSources(asD1(fixture.db), { limit: 2 });
    expect(result._meta?.pagination).toEqual({
      kind: "page",
      page: 1,
      pageSize: 2,
      returned: 2,
      totalItems: 3,
      totalPages: 2,
      hasMore: true,
      nextPage: 2,
    });
  });

  it("omits nextPage on the last page", async () => {
    const result = await listSources(asD1(fixture.db), { limit: 2, page: 2 });
    expect(result._meta?.pagination).toMatchObject({
      page: 2,
      pageSize: 2,
      returned: 1,
      totalItems: 3,
      totalPages: 2,
      hasMore: false,
    });
    expect(result._meta?.pagination).not.toHaveProperty("nextPage");
  });

  it("carries _meta on a single-page result with hasMore=false", async () => {
    const result = await listSources(asD1(fixture.db), {});
    expect(result._meta?.pagination).toEqual({
      kind: "page",
      page: 1,
      pageSize: 50,
      returned: 3,
      totalItems: 3,
      totalPages: 1,
      hasMore: false,
    });
  });

  it("carries _meta when paging past the end (returned=0, totalItems>0)", async () => {
    const result = await listSources(asD1(fixture.db), { limit: 2, page: 99 });
    expect(result._meta?.pagination).toMatchObject({
      page: 99,
      pageSize: 2,
      returned: 0,
      totalItems: 3,
      totalPages: 2,
      hasMore: false,
    });
  });

  it("carries _meta on the empty-table case (totalItems=0)", async () => {
    clearAllTables(fixture.db);
    const result = await listSources(asD1(fixture.db), {});
    expect(resultText(result)).toBe("No sources indexed yet.");
    expect(result._meta?.pagination).toEqual({
      kind: "page",
      page: 1,
      pageSize: 50,
      returned: 0,
      totalItems: 0,
      totalPages: 1,
      hasMore: false,
    });
  });

  it("filter-aware totals: list_organizations narrows totalItems to matching rows", async () => {
    const result = await listOrganizations(asD1(fixture.db), { query: "Vercel", limit: 1 });
    expect(result._meta?.pagination).toEqual({
      kind: "page",
      page: 1,
      pageSize: 1,
      returned: 1,
      totalItems: 1,
      totalPages: 1,
      hasMore: false,
    });
  });

  it("list_products and list_catalog also expose _meta.pagination", async () => {
    const productsResult = await listProducts(asD1(fixture.db), { limit: 1 });
    expect(productsResult._meta?.pagination).toMatchObject({
      page: 1,
      pageSize: 1,
      totalItems: 2,
      hasMore: true,
      nextPage: 2,
    });

    const catalog = await listCatalog(asD1(fixture.db), { limit: 2 });
    expect(catalog._meta?.pagination).toMatchObject({
      page: 1,
      pageSize: 2,
      totalItems: 3,
      hasMore: true,
      nextPage: 2,
    });
  });
});

describe("get_latest_releases (round-trippable source coordinates)", () => {
  const fixture = useFixture(seed);

  it("includes org-scoped source coordinate in release output", async () => {
    const text = resultText(await getLatestReleases(asD1(fixture.db), {}));
    // Both sources appear in the seed data; both must show up with an org prefix.
    expect(text).toContain("vercel/next-js");
    expect(text).toContain("anthropic/anthropic-releases");
  });
});

describe("get_latest_releases _meta.pagination (cursor)", () => {
  // Six spine releases on top of the two from `seed()` → cursor with limit=3
  // walks the feed deterministically.
  const fixture = useFixture(async (db) => {
    const seeded = await seed(db);
    const extras = Array.from({ length: 6 }, (_, i) => ({
      id: newReleaseId(),
      sourceId: seeded.nextjsSrcId,
      title: `Spine release ${i + 1}`,
      content: `Body ${i + 1}`,
      url: `https://example.com/spine/${i + 1}`,
      publishedAt: `2024-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    await db.insert(releases).values(extras);
    return seeded;
  });

  it("populates cursor _meta with kind=cursor, hasMore, nextCursor on first page", async () => {
    const result = await getLatestReleases(asD1(fixture.db), { limit: 3 });
    const meta = result._meta?.pagination;
    expect(meta?.kind).toBe("cursor");
    if (meta?.kind !== "cursor") return;
    expect(meta).toMatchObject({ returned: 3, limit: 3, hasMore: true });
    expect(meta.nextCursor).toBeTruthy();
  });

  it("omits nextCursor on the last page", async () => {
    // Total = 8 (2 seed + 6 spine). limit=10 → single page, no continuation.
    const result = await getLatestReleases(asD1(fixture.db), { limit: 10 });
    expect(result._meta?.pagination).toMatchObject({
      kind: "cursor",
      returned: 8,
      limit: 10,
      hasMore: false,
    });
    expect(result._meta?.pagination).not.toHaveProperty("nextCursor");
  });

  it("walks the feed via cursor — page 1 + page 2 cover the full set without overlap", async () => {
    const page1 = await getLatestReleases(asD1(fixture.db), { limit: 4 });
    const meta1 = page1._meta?.pagination;
    expect(meta1?.kind).toBe("cursor");
    if (meta1?.kind !== "cursor" || !meta1.nextCursor) {
      throw new Error("expected first-page cursor");
    }

    const page2 = await getLatestReleases(asD1(fixture.db), {
      limit: 4,
      cursor: meta1.nextCursor,
    });
    expect(page2._meta?.pagination).toMatchObject({
      kind: "cursor",
      returned: 4,
      hasMore: false,
    });

    const text1 = resultText(page1);
    const text2 = resultText(page2);
    // Newest 4 (Claude 4 + Next.js 15 + 2 spine) → page 1; oldest 4 spine → page 2.
    // Cross-check: titles on page 2 must NOT appear on page 1.
    expect(text1).toContain("Claude 4 release");
    expect(text2).toContain("Spine release 1");
    expect(text2).not.toContain("Claude 4 release");
    expect(text1).not.toContain("Spine release 1");
  });

  it("cursor stays stable when a new release lands between calls", async () => {
    const page1 = await getLatestReleases(asD1(fixture.db), { limit: 3 });
    const meta1 = page1._meta?.pagination;
    if (meta1?.kind !== "cursor" || !meta1.nextCursor) {
      throw new Error("expected first-page cursor");
    }
    const cursor = meta1.nextCursor;

    // Insert a brand-new release at the head of the feed *after* page 1.
    await fixture.db.insert(releases).values({
      id: newReleaseId(),
      sourceId: fixture.seeded.nextjsSrcId,
      title: "Inserted between pages",
      content: "Body",
      url: "https://example.com/inserted",
      publishedAt: "2026-01-01T00:00:00Z",
    });

    const page2 = await getLatestReleases(asD1(fixture.db), { limit: 3, cursor });
    const text2 = resultText(page2);
    // The inserted release should NOT appear on page 2 — cursor encodes the
    // boundary, so the new row sits ahead of the cursor and is excluded.
    expect(text2).not.toContain("Inserted between pages");
    // Page 2 still returns the next slice from where the cursor pointed.
    expect(text2).toContain("Spine release");
  });

  it("silently ignores an unparseable cursor and returns a fresh head", async () => {
    const result = await getLatestReleases(asD1(fixture.db), {
      limit: 3,
      cursor: "not-a-valid-base64-cursor!@#$",
    });
    // Garbage cursor → no error, just returns the head of the feed.
    const text = resultText(result);
    expect(text).toContain("Claude 4 release");
    expect(result._meta?.pagination).toMatchObject({
      kind: "cursor",
      returned: 3,
      limit: 3,
      hasMore: true,
    });
  });

  it("legacy `count` input still works when `limit` is omitted", async () => {
    const result = await getLatestReleases(asD1(fixture.db), { count: 2 });
    expect(result._meta?.pagination).toMatchObject({
      kind: "cursor",
      returned: 2,
      limit: 2,
      hasMore: true,
    });
  });

  it("`limit` takes precedence over `count` when both are provided", async () => {
    const result = await getLatestReleases(asD1(fixture.db), { count: 99, limit: 2 });
    expect(result._meta?.pagination).toMatchObject({
      kind: "cursor",
      returned: 2,
      limit: 2,
    });
  });

  it("emits a continuation hint in the body so non-_meta clients can chain", async () => {
    const result = await getLatestReleases(asD1(fixture.db), { limit: 3 });
    const text = resultText(result);
    expect(text).toContain("cursor:");
    expect(text).toContain("Pass");
  });

  it("carries cursor _meta on the empty-result case", async () => {
    clearAllTables(fixture.db);
    const result = await getLatestReleases(asD1(fixture.db), { limit: 5 });
    expect(resultText(result)).toBe("No releases found.");
    expect(result._meta?.pagination).toMatchObject({
      kind: "cursor",
      returned: 0,
      limit: 5,
      hasMore: false,
    });
  });
});
