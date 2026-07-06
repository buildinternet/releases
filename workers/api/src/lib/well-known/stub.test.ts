import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import {
  organizations,
  products,
  sources,
  releaseLocations,
} from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../test/setup.js";
import { releaseLocationMatchKey } from "./locator.js";
import { createStubOrg, createStubFromManifest } from "./stub.js";

describe("releaseLocationMatchKey", () => {
  it("follows feed ?? github ?? appstore ?? file ?? url precedence", () => {
    expect(releaseLocationMatchKey({ feed: "https://a.com/f", url: "https://a.com/b" })).toBe(
      "feed:https://a.com/f",
    );
    expect(releaseLocationMatchKey({ github: "Owner/Repo", url: "https://a.com/b" })).toBe(
      "github:owner/repo",
    );
    expect(releaseLocationMatchKey({ url: "https://a.com/b" })).toBe("url:https://a.com/b");
  });

  it("normalizes host case, trailing slash, and .git; keeps a field prefix", () => {
    // Host lowercased + trailing slash stripped; path case preserved.
    expect(releaseLocationMatchKey({ feed: "https://A.COM/Feed/" })).toBe(
      "feed:https://a.com/Feed",
    );
    expect(releaseLocationMatchKey({ github: "Acme/Repo.git" })).toBe("github:acme/repo");
    // A bare url and a feed with the same string stay distinct declared facts.
    expect(releaseLocationMatchKey({ url: "https://a.com/x" })).not.toBe(
      releaseLocationMatchKey({ feed: "https://a.com/x" }),
    );
  });
});

describe("createStubOrg", () => {
  it("creates a stub org with products + locators and NO sources", async () => {
    const db = createTestDb();
    const res = await createStubOrg(
      db as never,
      {
        name: "Acme",
        slug: "acme",
        domain: "acme.com",
        category: null,
        products: [{ name: "Widget", locations: [{ feed: "https://acme.com/widget.xml" }] }],
        locations: [{ url: "https://acme.com/blog" }, { feed: "https://acme.com/feed.xml" }],
      },
      { basis: "curator", evidence: { curator: true } },
    );

    expect(res.org.tier).toBe("stub");
    expect(res.org.discovery).toBe("curated");
    expect(res.org.autoGenerateContent).toBe(false);
    expect(res.productCount).toBe(1);
    expect(res.locationCount).toBe(3);

    // No sources for a stub.
    const srcs = await db.select().from(sources).where(eq(sources.orgId, res.org.id));
    expect(srcs.length).toBe(0);

    const locs = await db
      .select()
      .from(releaseLocations)
      .where(eq(releaseLocations.orgId, res.org.id));
    expect(locs.length).toBe(3);
    expect(locs.every((l) => l.basis === "curator")).toBe(true);
    expect(locs.every((l) => (l.evidence as { curator?: boolean })?.curator === true)).toBe(true);
    // The product-scoped locator carries the product id; org-level ones don't.
    const [prod] = await db.select().from(products).where(eq(products.orgId, res.org.id));
    expect(locs.filter((l) => l.productId === prod!.id).length).toBe(1);
    expect(locs.filter((l) => l.productId === null).length).toBe(2);
  });

  it("dedups by match_key within a single create (first wins)", async () => {
    const db = createTestDb();
    const res = await createStubOrg(
      db as never,
      {
        name: "Dup",
        slug: "dup",
        locations: [
          { feed: "https://dup.com/feed.xml" },
          { feed: "https://DUP.com/feed.xml/" }, // same normalized match_key
        ],
      },
      { basis: "declared" },
    );
    expect(res.locationCount).toBe(1);
  });

  it("chunks locator inserts past the D1 bind cap (>6 rows)", async () => {
    const db = createTestDb();
    const locations = Array.from({ length: 8 }, (_, i) => ({ feed: `https://c.com/${i}.xml` }));
    const res = await createStubOrg(
      db as never,
      { name: "Chunk", slug: "chunk", locations },
      { basis: "detected" },
    );
    expect(res.locationCount).toBe(8);
    const locs = await db
      .select()
      .from(releaseLocations)
      .where(eq(releaseLocations.orgId, res.org.id));
    expect(locs.length).toBe(8);
  });

  it("throws on a slug collision (mapped to 409 by the route)", async () => {
    const db = createTestDb();
    await createStubOrg(db as never, { name: "One", slug: "taken" }, { basis: "curator" });
    let threw = false;
    try {
      await createStubOrg(db as never, { name: "Two", slug: "taken" }, { basis: "curator" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("createStubFromManifest", () => {
  const manifest = JSON.stringify({
    version: 2,
    name: "Beta Corp",
    description: "Makers of Beta.",
    products: [{ name: "Beta", releases: [{ feed: "https://beta.com/beta.xml" }] }],
    releases: [{ url: "https://beta.com/changelog" }],
  });

  it("creates a stub (basis: declared) from a valid unlisted-domain manifest", async () => {
    const db = createTestDb();
    const res = await createStubFromManifest(db as never, "beta.com", {
      fetchImpl: async () =>
        new Response(manifest, { status: 200, headers: { "content-type": "application/json" } }),
    });
    expect(res.created).toBe(true);
    expect(res.locationCount).toBe(2);
    expect(res.productCount).toBe(1);

    const [org] = await db.select().from(organizations).where(eq(organizations.domain, "beta.com"));
    expect(org!.tier).toBe("stub");
    const locs = await db
      .select()
      .from(releaseLocations)
      .where(eq(releaseLocations.orgId, org!.id));
    expect(locs.every((l) => l.basis === "declared")).toBe(true);
  });

  it("skips a domain that already resolves to an org", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_x", name: "X", slug: "x", domain: "taken.com" });
    const res = await createStubFromManifest(db as never, "taken.com", {
      fetchImpl: async () => new Response(manifest, { status: 200 }),
    });
    expect(res.created).toBe(false);
    expect(res.skippedReason).toBe("org_exists");
  });

  it("skips an invalid manifest without writing", async () => {
    const db = createTestDb();
    const res = await createStubFromManifest(db as never, "bad.com", {
      fetchImpl: async () =>
        new Response(JSON.stringify({ version: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(res.created).toBe(false);
    expect(res.skippedReason).toBe("invalid_schema");
    const orgs = await db.select().from(organizations).where(eq(organizations.domain, "bad.com"));
    expect(orgs.length).toBe(0);
  });

  it("skips a manifest that names a registry org", async () => {
    const db = createTestDb();
    const res = await createStubFromManifest(db as never, "claimed.com", {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            version: 2,
            name: "C",
            registries: { "releases.sh": { org: "org_abc" } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    expect(res.created).toBe(false);
    expect(res.skippedReason).toBe("registry_org_declared");
  });

  it("dryRun returns the mapped plan and writes nothing", async () => {
    const db = createTestDb();
    const res = await createStubFromManifest(db as never, "beta.com", {
      dryRun: true,
      fetchImpl: async () => new Response(manifest, { status: 200 }),
    });
    expect(res.created).toBe(false);
    expect(res.skippedReason).toBe("dry_run");
    expect(res.plan?.name).toBe("Beta Corp");
    const orgs = await db.select().from(organizations).where(eq(organizations.domain, "beta.com"));
    expect(orgs.length).toBe(0);
  });
});
