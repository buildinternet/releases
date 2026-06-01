/**
 * #1324: the remote MCP worker's `resolveSource` / `resolveProduct` bare-slug
 * fallback used `.limit(1)` with no ambiguity check, so a bare slug owned by
 * more than one org (slugs are unique per-org, not globally — #690) silently
 * resolved to an arbitrary match. These tests pin the defensive contract:
 *   0 matches → null   ·   1 → resolve   ·   >1 → throw AmbiguousEntityError
 * carrying every `org/slug` + typed-id candidate so the tool can echo them
 * back for self-correction. Mirrors the CLI fix (releases-cli#267).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { newOrgId, newProductId, newSourceId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import {
  resolveSource,
  resolveProduct,
  AmbiguousEntityError,
  ambiguousEntityToolResult,
} from "../../workers/mcp/src/tools.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

async function seedOrg(db: TestDatabase["db"], slug: string) {
  const orgId = newOrgId();
  await db.insert(organizations).values({ id: orgId, name: slug, slug });
  return orgId;
}

async function seedSource(db: TestDatabase["db"], orgId: string, slug: string) {
  const id = newSourceId();
  await db.insert(sources).values({
    id,
    orgId,
    name: slug,
    slug,
    type: "github",
    url: `https://github.com/${slug}/${slug}`,
    discovery: "curated",
  });
  return id;
}

async function seedProduct(db: TestDatabase["db"], orgId: string, slug: string) {
  const id = newProductId();
  await db.insert(products).values({ id, orgId, name: slug, slug });
  return id;
}

describe("resolveSource bare-slug ambiguity (#1324)", () => {
  it("returns null when no source matches the bare slug", async () => {
    await seedOrg(testDb.db, "acme");
    expect(await resolveSource(asD1(testDb.db), "nope")).toBeNull();
  });

  it("resolves the single source when exactly one org owns the slug", async () => {
    const orgId = await seedOrg(testDb.db, "acme");
    const srcId = await seedSource(testDb.db, orgId, "blog");
    const src = await resolveSource(asD1(testDb.db), "blog");
    expect(src?.id).toBe(srcId);
  });

  it("throws AmbiguousEntityError listing every candidate when two orgs own the slug", async () => {
    const orgA = await seedOrg(testDb.db, "vitest");
    const orgB = await seedOrg(testDb.db, "windsurf");
    const srcA = await seedSource(testDb.db, orgA, "blog");
    const srcB = await seedSource(testDb.db, orgB, "blog");

    let thrown: unknown;
    try {
      await resolveSource(asD1(testDb.db), "blog");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(AmbiguousEntityError);
    const err = thrown as AmbiguousEntityError;
    expect(err.entity).toBe("source");
    expect(err.slug).toBe("blog");
    expect(err.candidates.map((c) => c.id).toSorted()).toEqual([srcA, srcB].toSorted());
    // The model-readable message lists both org/slug coordinates + typed ids.
    expect(err.message).toContain("vitest/blog");
    expect(err.message).toContain("windsurf/blog");
    expect(err.message).toContain(srcA);
    expect(err.message).toContain(srcB);
  });

  it("a src_ typed id never triggers the ambiguity path", async () => {
    const orgA = await seedOrg(testDb.db, "vitest");
    const orgB = await seedOrg(testDb.db, "windsurf");
    const srcA = await seedSource(testDb.db, orgA, "blog");
    await seedSource(testDb.db, orgB, "blog");
    const src = await resolveSource(asD1(testDb.db), srcA);
    expect(src?.id).toBe(srcA);
  });

  it("an org/slug coordinate resolves to that org's source, not an ambiguity error", async () => {
    const orgA = await seedOrg(testDb.db, "vitest");
    const orgB = await seedOrg(testDb.db, "windsurf");
    await seedSource(testDb.db, orgA, "blog");
    const srcB = await seedSource(testDb.db, orgB, "blog");
    const src = await resolveSource(asD1(testDb.db), "windsurf/blog");
    expect(src?.id).toBe(srcB);
  });
});

describe("resolveProduct bare-slug ambiguity (#1324)", () => {
  it("returns null when no product matches", async () => {
    await seedOrg(testDb.db, "acme");
    expect(await resolveProduct(asD1(testDb.db), "nope")).toBeNull();
  });

  it("resolves the single product when exactly one org owns the slug", async () => {
    const orgId = await seedOrg(testDb.db, "acme");
    const prodId = await seedProduct(testDb.db, orgId, "cli");
    const prod = await resolveProduct(asD1(testDb.db), "cli");
    expect(prod?.id).toBe(prodId);
  });

  it("throws AmbiguousEntityError with prod_ candidates when two orgs own the slug", async () => {
    const orgA = await seedOrg(testDb.db, "vercel");
    const orgB = await seedOrg(testDb.db, "netlify");
    const prodA = await seedProduct(testDb.db, orgA, "cli");
    const prodB = await seedProduct(testDb.db, orgB, "cli");

    let thrown: unknown;
    try {
      await resolveProduct(asD1(testDb.db), "cli");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(AmbiguousEntityError);
    const err = thrown as AmbiguousEntityError;
    expect(err.entity).toBe("product");
    expect(err.slug).toBe("cli");
    expect(err.candidates.map((c) => c.id).toSorted()).toEqual([prodA, prodB].toSorted());
    expect(err.message).toContain("vercel/cli");
    expect(err.message).toContain("netlify/cli");
  });
});

describe("ambiguousEntityToolResult (#1324)", () => {
  it("renders the error as a non-error text tool result for the model to self-correct", () => {
    const err = new AmbiguousEntityError("source", "blog", [
      { orgSlug: "vitest", slug: "blog", id: "src_aaa" },
      { orgSlug: "windsurf", slug: "blog", id: "src_bbb" },
    ]);
    const result = ambiguousEntityToolResult(err);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(err.message);
    expect(result.content[0].text).toContain("vitest/blog  (src_aaa)");
    expect(result.content[0].text).toContain("windsurf/blog  (src_bbb)");
  });
});
