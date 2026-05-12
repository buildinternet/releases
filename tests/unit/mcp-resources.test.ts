import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { newOrgId, newProductId, newSourceId } from "@buildinternet/releases-core/id";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { asD1, createMcpTestClient } from "../mcp-test-helpers.js";
import { registerResources } from "../../workers/mcp/src/resources.js";

const linkResources = (db: TestDatabase["db"]) =>
  createMcpTestClient(registerResources, asD1(db), "");

async function seed(db: TestDatabase["db"]) {
  const vercel = { id: newOrgId(), name: "Vercel", slug: "vercel" };
  const supabase = { id: newOrgId(), name: "Supabase", slug: "supabase" };
  const verbatim = { id: newOrgId(), name: "Verbatim", slug: "verbatim" };
  // Display name "Cloudflare" diverges from slug "cf-workers" — lets us test
  // name-only matches that slug-only completion would miss.
  const cloudflare = { id: newOrgId(), name: "Cloudflare", slug: "cf-workers" };
  await db.insert(organizations).values([
    { id: vercel.id, name: vercel.name, slug: vercel.slug },
    { id: supabase.id, name: supabase.name, slug: supabase.slug },
    { id: verbatim.id, name: verbatim.name, slug: verbatim.slug },
    { id: cloudflare.id, name: cloudflare.name, slug: cloudflare.slug },
  ]);
  await db.insert(products).values([
    { id: newProductId(), orgId: vercel.id, name: "Next.js", slug: "nextjs" },
    { id: newProductId(), orgId: vercel.id, name: "Turborepo", slug: "turborepo" },
    { id: newProductId(), orgId: supabase.id, name: "Supabase", slug: "supabase-product" },
    // Mid-string "turbo" — lets us assert prefix matches rank ahead of substring.
    { id: newProductId(), orgId: vercel.id, name: "Alphaturbo", slug: "alphaturbo" },
  ]);
  await db.insert(sources).values([
    {
      id: newSourceId(),
      orgId: vercel.id,
      name: "Next.js Releases",
      slug: "nextjs-releases",
      type: "github",
      url: "https://github.com/vercel/next.js/releases",
    },
    {
      id: newSourceId(),
      orgId: vercel.id,
      name: "Next.js Canary",
      slug: "nextjs-canary",
      type: "github",
      url: "https://github.com/vercel/next.js/commits/canary",
    },
    {
      id: newSourceId(),
      orgId: supabase.id,
      name: "Supabase Changelog",
      slug: "supabase-changelog",
      type: "scrape",
      url: "https://supabase.com/changelog",
    },
  ]);
}

describe("MCP resources + completion", () => {
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

  it("advertises org, product, and source templates with URI patterns", async () => {
    const link = await linkResources(fixture.db);
    try {
      const { resourceTemplates } = await link.client.listResourceTemplates();
      const byName = new Map(resourceTemplates.map((t) => [t.name, t.uriTemplate]));
      expect(byName.get("organization")).toBe("releases://org/{orgSlug}");
      expect(byName.get("product")).toBe("releases://product/{productSlug}");
      expect(byName.get("source")).toBe("releases://source/{sourceSlug}");
    } finally {
      await link.close();
    }
  });

  it("serves the release-feed UI bundle as a UI resource", async () => {
    const link = await linkResources(fixture.db);
    try {
      const result = await link.client.readResource({
        uri: "ui://releases/release-feed.html",
      });
      expect(result.contents).toHaveLength(1);
      const first = result.contents[0];
      expect(first.mimeType).toBe("text/html;profile=mcp-app");
      if (!("text" in first)) throw new Error("expected text content, got blob");
      expect(first.text).toContain("<!doctype html>");
      // Smoke-check that the bundled JS made it in (root mount lives here).
      expect(first.text).toContain('<div id="root">');
    } finally {
      await link.close();
    }
  });

  it("lists only the MCP App UI resources — entity discovery is completion-only", async () => {
    // The four entity resource templates (org / catalog / product / source) are
    // intentionally absent from `resources/list` — the catalog scales beyond
    // what a static list can carry, so callers reach them through completion.
    // MCP App UI resources are different: there's exactly one per app, and
    // hosts pre-resolve them at connect time, so they DO appear here.
    const link = await linkResources(fixture.db);
    try {
      const { resources } = await link.client.listResources();
      const uiResources = resources.filter((r) => r.uri.startsWith("ui://"));
      expect(uiResources.length).toBeGreaterThan(0);
      const nonUi = resources.filter((r) => !r.uri.startsWith("ui://"));
      expect(nonUi).toEqual([]);
    } finally {
      await link.close();
    }
  });

  it("reads an organization by releases://org/{slug}", async () => {
    const link = await linkResources(fixture.db);
    try {
      const result = await link.client.readResource({ uri: "releases://org/vercel" });
      expect(result.contents).toHaveLength(1);
      const first = result.contents[0];
      expect(first.uri).toBe("releases://org/vercel");
      expect(first.mimeType).toBe("text/markdown");
      if (!("text" in first)) throw new Error("expected text content, got blob");
      expect(first.text).toContain("Vercel");
    } finally {
      await link.close();
    }
  });

  it("completes orgSlug by prefix (ver → vercel, verbatim)", async () => {
    const link = await linkResources(fixture.db);
    try {
      const result = await link.client.complete({
        ref: { type: "ref/resource", uri: "releases://org/{orgSlug}" },
        argument: { name: "orgSlug", value: "ver" },
      });
      const values = result.completion.values.toSorted();
      expect(values).toEqual(["verbatim", "vercel"]);
    } finally {
      await link.close();
    }
  });

  it("completes sourceSlug even though the template has no list callback", async () => {
    const link = await linkResources(fixture.db);
    try {
      const result = await link.client.complete({
        ref: { type: "ref/resource", uri: "releases://source/{sourceSlug}" },
        argument: { name: "sourceSlug", value: "nextjs" },
      });
      const values = result.completion.values.toSorted();
      expect(values).toEqual(["vercel/nextjs-canary", "vercel/nextjs-releases"]);
    } finally {
      await link.close();
    }
  });

  it("returns an empty completion when nothing matches", async () => {
    const link = await linkResources(fixture.db);
    try {
      const result = await link.client.complete({
        ref: { type: "ref/resource", uri: "releases://org/{orgSlug}" },
        argument: { name: "orgSlug", value: "zzzz" },
      });
      expect(result.completion.values).toEqual([]);
    } finally {
      await link.close();
    }
  });

  it("returns an empty completion on empty / whitespace-only input", async () => {
    const link = await linkResources(fixture.db);
    try {
      const ref = { type: "ref/resource" as const, uri: "releases://org/{orgSlug}" };
      const results = await Promise.all(
        ["", "   "].map((value) =>
          link.client.complete({ ref, argument: { name: "orgSlug", value } }),
        ),
      );
      for (const result of results) {
        expect(result.completion.values).toEqual([]);
      }
    } finally {
      await link.close();
    }
  });

  it("matches the display name when the slug does not contain the needle", async () => {
    // "cf-workers" does not contain "cloud" but its display name is "Cloudflare".
    const link = await linkResources(fixture.db);
    try {
      const result = await link.client.complete({
        ref: { type: "ref/resource", uri: "releases://org/{orgSlug}" },
        argument: { name: "orgSlug", value: "cloud" },
      });
      expect(result.completion.values).toEqual(["cf-workers"]);
    } finally {
      await link.close();
    }
  });

  it("matches substrings anywhere, not just prefixes", async () => {
    // "base" appears mid-slug for supabase-product and at-end for supabase.
    const link = await linkResources(fixture.db);
    try {
      const result = await link.client.complete({
        ref: { type: "ref/resource", uri: "releases://product/{productSlug}" },
        argument: { name: "productSlug", value: "base" },
      });
      expect(result.completion.values.toSorted()).toEqual(["supabase/supabase-product"]);
    } finally {
      await link.close();
    }
  });

  it("ranks prefix matches ahead of mid-string substring matches", async () => {
    // "turborepo" (prefix) should come before "alphaturbo" (substring).
    const link = await linkResources(fixture.db);
    try {
      const result = await link.client.complete({
        ref: { type: "ref/resource", uri: "releases://product/{productSlug}" },
        argument: { name: "productSlug", value: "turbo" },
      });
      expect(result.completion.values).toEqual(["vercel/turborepo", "vercel/alphaturbo"]);
    } finally {
      await link.close();
    }
  });

  it("narrows to one org when input is coordinate-form", async () => {
    // "vercel/" without a slug needle returns every product under vercel.
    const link = await linkResources(fixture.db);
    try {
      const result = await link.client.complete({
        ref: { type: "ref/resource", uri: "releases://product/{productSlug}" },
        argument: { name: "productSlug", value: "vercel/" },
      });
      const values = result.completion.values.toSorted();
      expect(values).toEqual(["vercel/alphaturbo", "vercel/nextjs", "vercel/turborepo"]);
    } finally {
      await link.close();
    }
  });

  it("filters by org segment + slug prefix when input is `org/slug-prefix`", async () => {
    // "vercel/turbo" should match turborepo and alphaturbo under vercel only.
    const link = await linkResources(fixture.db);
    try {
      const result = await link.client.complete({
        ref: { type: "ref/resource", uri: "releases://product/{productSlug}" },
        argument: { name: "productSlug", value: "vercel/turbo" },
      });
      // Order: prefix match (turborepo) before substring match (alphaturbo).
      expect(result.completion.values).toEqual(["vercel/turborepo", "vercel/alphaturbo"]);
    } finally {
      await link.close();
    }
  });

  it("strips LIKE wildcards so user-supplied % / _ cannot widen the match", async () => {
    const link = await linkResources(fixture.db);
    try {
      // Stripping `%` and `_` leaves "bc", which no org/name contains.
      const result = await link.client.complete({
        ref: { type: "ref/resource", uri: "releases://org/{orgSlug}" },
        argument: { name: "orgSlug", value: "%_b_c%" },
      });
      expect(result.completion.values).toEqual([]);
    } finally {
      await link.close();
    }
  });
});
