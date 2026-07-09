/**
 * MCP lexical search must use the shared `searchReleasesFts` helper
 * (`@releases/search/releases-fts`) — same filters as `/v1/search`:
 * sources_active, is_hidden, suppressed, releases_visible (coverage),
 * kind / since / until / sourceIds.
 *
 * These cases lock API-correctness alignment after removing the inline
 * `releases_fts MATCH` in workers/mcp/src/tools.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newProductId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { releaseCoverage } from "@releases/core-internal/schema-coverage.js";
import { searchReleasesFts } from "@releases/search/releases-fts.js";
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

async function seedOrgSource(opts: {
  title: string;
  content?: string;
  publishedAt?: string | null;
  isHidden?: boolean;
  deletedAt?: string | null;
  kind?: string | null;
  suppressed?: boolean;
  type?: "feature" | "rollup";
}): Promise<{ orgId: string; sourceId: string; releaseId: string; orgSlug: string }> {
  const orgId = newOrgId();
  const orgSlug = "acme";
  await testDb.db.insert(organizations).values({ id: orgId, name: "Acme", slug: orgSlug });
  const sourceId = newSourceId();
  await testDb.db.insert(sources).values({
    id: sourceId,
    orgId,
    name: "Changelog",
    slug: "changelog",
    type: "feed",
    url: "https://acme.example/changelog",
    discovery: "curated",
    isHidden: opts.isHidden ?? false,
    deletedAt: opts.deletedAt ?? null,
    kind: opts.kind ?? null,
  });
  const releaseId = newReleaseId();
  await testDb.db.insert(releases).values({
    id: releaseId,
    sourceId,
    title: opts.title,
    content: opts.content ?? opts.title,
    publishedAt: opts.publishedAt === undefined ? "2026-04-01T00:00:00Z" : opts.publishedAt,
    type: opts.type ?? "feature",
    suppressed: opts.suppressed ?? false,
  });
  return { orgId, sourceId, releaseId, orgSlug };
}

describe("MCP lexical search — shared searchReleasesFts semantics", () => {
  it("MCP lexical and searchReleasesFts return the same release ids for a query", async () => {
    const { releaseId } = await seedOrgSource({ title: "quantum widget launch" });
    const d1 = asD1(testDb.db);
    const helperIds = (await searchReleasesFts(d1, "quantum", 20, 0)).map((r) => r.id);
    expect(helperIds).toEqual([releaseId]);

    const ret = await search(d1, {
      query: "quantum",
      mode: "lexical",
      type: ["releases"],
    });
    const out = ret.result.content[0].text as string;
    expect(out).toContain(releaseId);
    expect(out).toContain("quantum widget launch");
  });

  it("excludes hidden sources (is_hidden=1)", async () => {
    await seedOrgSource({ title: "quantum hidden release", isHidden: true });
    const d1 = asD1(testDb.db);
    expect(await searchReleasesFts(d1, "quantum", 20, 0)).toEqual([]);

    const ret = await search(d1, {
      query: "quantum",
      mode: "lexical",
      type: ["releases"],
    });
    expect(ret.result.content[0].text as string).toContain("No results found");
  });

  it("excludes soft-deleted sources (sources_active)", async () => {
    await seedOrgSource({
      title: "quantum deleted source release",
      deletedAt: "2026-05-01T00:00:00Z",
    });
    const d1 = asD1(testDb.db);
    expect(await searchReleasesFts(d1, "quantum", 20, 0)).toEqual([]);

    const ret = await search(d1, {
      query: "quantum",
      mode: "lexical",
      type: ["releases"],
    });
    expect(ret.result.content[0].text as string).toContain("No results found");
  });

  it("excludes suppressed releases", async () => {
    await seedOrgSource({ title: "quantum suppressed release", suppressed: true });
    const d1 = asD1(testDb.db);
    expect(await searchReleasesFts(d1, "quantum", 20, 0)).toEqual([]);

    const ret = await search(d1, {
      query: "quantum",
      mode: "lexical",
      type: ["releases"],
    });
    expect(ret.result.content[0].text as string).toContain("No results found");
  });

  it("excludes coverage-side releases by default (releases_visible)", async () => {
    const orgId = newOrgId();
    await testDb.db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });
    const sourceId = newSourceId();
    await testDb.db.insert(sources).values({
      id: sourceId,
      orgId,
      name: "Blog",
      slug: "blog",
      type: "scrape",
      url: "https://acme.example/blog",
      discovery: "curated",
    });
    const canonicalId = newReleaseId();
    const coverageId = newReleaseId();
    await testDb.db.insert(releases).values([
      {
        id: canonicalId,
        sourceId,
        title: "quantum canonical release",
        content: "canonical quantum body",
        publishedAt: "2026-04-01T00:00:00Z",
        type: "feature",
      },
      {
        id: coverageId,
        sourceId,
        title: "quantum coverage sibling",
        content: "coverage quantum body",
        publishedAt: "2026-04-02T00:00:00Z",
        type: "feature",
      },
    ]);
    await testDb.db.insert(releaseCoverage).values({
      coverageId,
      canonicalId,
      reason: "test",
      decidedBy: "test",
      decidedAt: "2026-04-02T00:00:00Z",
    });

    const d1 = asD1(testDb.db);
    const helperIds = (await searchReleasesFts(d1, "quantum", 20, 0)).map((r) => r.id);
    expect(helperIds).toEqual([canonicalId]);

    const withCoverage = (
      await searchReleasesFts(d1, "quantum", 20, 0, { includeCoverage: true })
    ).map((r) => r.id);
    expect(new Set(withCoverage)).toEqual(new Set([canonicalId, coverageId]));

    const ret = await search(d1, {
      query: "quantum",
      mode: "lexical",
      type: ["releases"],
    });
    const out = ret.result.content[0].text as string;
    expect(out).toContain(canonicalId);
    expect(out).not.toContain(coverageId);
  });

  it("honors since/until on published_at (drops undated)", async () => {
    const orgId = newOrgId();
    await testDb.db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });
    const sourceId = newSourceId();
    await testDb.db.insert(sources).values({
      id: sourceId,
      orgId,
      name: "Changelog",
      slug: "changelog",
      type: "feed",
      url: "https://acme.example/changelog",
      discovery: "curated",
    });
    const inWindow = newReleaseId();
    const outWindow = newReleaseId();
    const undated = newReleaseId();
    await testDb.db.insert(releases).values([
      {
        id: inWindow,
        sourceId,
        title: "quantum march release",
        content: "march",
        publishedAt: "2026-03-15T00:00:00Z",
        type: "feature",
      },
      {
        id: outWindow,
        sourceId,
        title: "quantum january release",
        content: "january",
        publishedAt: "2026-01-15T00:00:00Z",
        type: "feature",
      },
      {
        id: undated,
        sourceId,
        title: "quantum undated release",
        content: "undated",
        publishedAt: null,
        type: "feature",
      },
    ]);

    const d1 = asD1(testDb.db);
    const opts = {
      since: "2026-02-01T00:00:00.000Z",
      until: "2026-04-01T00:00:00.000Z",
    };
    const helperIds = (await searchReleasesFts(d1, "quantum", 20, 0, opts)).map((r) => r.id);
    expect(helperIds).toEqual([inWindow]);

    const ret = await search(d1, {
      query: "quantum",
      mode: "lexical",
      type: ["releases"],
      since: opts.since,
      until: opts.until,
    });
    const out = ret.result.content[0].text as string;
    expect(out).toContain(inWindow);
    expect(out).not.toContain(outWindow);
    expect(out).not.toContain(undated);
  });

  it("honors kind filter via COALESCE(source.kind, product.kind)", async () => {
    const orgId = newOrgId();
    await testDb.db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });
    const productId = newProductId();
    await testDb.db.insert(products).values({
      id: productId,
      orgId,
      name: "SDK",
      slug: "sdk",
      kind: "sdk",
    });
    const srcSdk = newSourceId();
    const srcMobile = newSourceId();
    await testDb.db.insert(sources).values([
      {
        id: srcSdk,
        orgId,
        productId,
        name: "SDK Changelog",
        slug: "sdk-changelog",
        type: "github",
        url: "https://github.com/acme/sdk",
        discovery: "curated",
        // inherit product kind via COALESCE
        kind: null,
      },
      {
        id: srcMobile,
        orgId,
        name: "App Notes",
        slug: "app-notes",
        type: "appstore",
        url: "https://apps.apple.com/app/acme",
        discovery: "curated",
        kind: "mobile",
      },
    ]);
    const sdkRel = newReleaseId();
    const mobileRel = newReleaseId();
    await testDb.db.insert(releases).values([
      {
        id: sdkRel,
        sourceId: srcSdk,
        title: "quantum sdk update",
        content: "sdk",
        publishedAt: "2026-04-01T00:00:00Z",
        type: "feature",
      },
      {
        id: mobileRel,
        sourceId: srcMobile,
        title: "quantum mobile update",
        content: "mobile",
        publishedAt: "2026-04-01T00:00:00Z",
        type: "feature",
      },
    ]);

    const d1 = asD1(testDb.db);
    const helperIds = (await searchReleasesFts(d1, "quantum", 20, 0, { kind: "sdk" })).map(
      (r) => r.id,
    );
    expect(helperIds).toEqual([sdkRel]);

    const ret = await search(d1, {
      query: "quantum",
      mode: "lexical",
      type: ["releases"],
      kind: "sdk",
    });
    const out = ret.result.content[0].text as string;
    expect(out).toContain(sdkRel);
    expect(out).not.toContain(mobileRel);
  });
});
