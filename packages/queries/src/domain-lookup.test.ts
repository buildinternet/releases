import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { domainAliases, organizations, products } from "@buildinternet/releases-core/schema";
import { clearAllTables, createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { findOrgByDomain, findProductsByDomain } from "./domain-lookup.js";

describe("domain lookup", () => {
  let tdb: TestDatabase;

  beforeAll(() => {
    tdb = createTestDb();
  });
  afterAll(() => tdb.cleanup());

  beforeEach(async () => {
    clearAllTables(tdb.db);
    await tdb.db.insert(organizations).values([
      { id: "org_acme", name: "Acme", slug: "acme", domain: "acme.example.com" },
      {
        id: "org_gone",
        name: "Gone",
        slug: "gone",
        domain: "gone.example.com",
        deletedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    await tdb.db.insert(products).values([
      { id: "prod_b", name: "Beta", slug: "beta", orgId: "org_acme" },
      { id: "prod_a", name: "Alpha", slug: "alpha", orgId: "org_acme" },
    ]);
    await tdb.db.insert(domainAliases).values([
      { domain: "acme.dev", orgId: "org_acme" },
      { domain: "gone.dev", orgId: "org_gone" },
      { domain: "beta.acme.example.com", productId: "prod_b" },
      { domain: "alpha.acme.example.com", productId: "prod_a" },
    ]);
  });

  it("matches an org by primary domain", async () => {
    const row = await findOrgByDomain(tdb.db, "acme.example.com");
    expect(row).toMatchObject({ id: "org_acme", slug: "acme", matchedVia: "primary" });
  });

  it("matches an org by alias domain", async () => {
    const row = await findOrgByDomain(tdb.db, "acme.dev");
    expect(row).toMatchObject({ id: "org_acme", matchedVia: "alias" });
  });

  it("never matches a soft-deleted org, by primary or alias", async () => {
    expect(await findOrgByDomain(tdb.db, "gone.example.com")).toBeNull();
    expect(await findOrgByDomain(tdb.db, "gone.dev")).toBeNull();
  });

  it("returns null for an unknown domain", async () => {
    expect(await findOrgByDomain(tdb.db, "nobody.example.com")).toBeNull();
    expect(await findProductsByDomain(tdb.db, "nobody.example.com")).toEqual([]);
  });

  it("returns products that own the domain, with the parent org", async () => {
    const rows = await findProductsByDomain(tdb.db, "beta.acme.example.com");
    expect(rows).toEqual([
      {
        id: "prod_b",
        slug: "beta",
        name: "Beta",
        orgId: "org_acme",
        orgSlug: "acme",
        orgName: "Acme",
        category: null,
      },
    ]);
  });
});
