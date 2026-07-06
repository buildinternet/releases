/**
 * Read surface for stub-tier orgs (#1947): `status` + `locations[]` on
 * GET /v1/lookups/by-domain and GET /v1/orgs/:slug, and the stub badge +
 * inclusion in GET /v1/orgs.
 */
import { describe, it, expect } from "bun:test";
import { orgRoutes } from "../src/routes/orgs.js";
import { lookupRoutes } from "../src/routes/lookups.js";
import { createStubOrg } from "../src/lib/well-known/stub.js";
import { organizations } from "@buildinternet/releases-core/schema";
import { createTestDb, createTestApp } from "./setup";

async function seedStub(
  db: ReturnType<typeof createTestDb>,
  over: { slug: string; domain?: string },
) {
  return createStubOrg(
    db as never,
    {
      name: over.slug,
      slug: over.slug,
      domain: over.domain,
      locations: [
        { feed: "https://x.com/feed.xml", canonical: true },
        { url: "https://x.com/blog" },
      ],
    },
    { basis: "declared", evidence: { domain: over.domain } },
  );
}

describe("GET /v1/lookups/by-domain (stub)", () => {
  it("returns status:stub + locations for a stub org", async () => {
    const db = createTestDb();
    await seedStub(db, { slug: "acme", domain: "acme.com" });
    const app = createTestApp(db, lookupRoutes);
    const res = await app(new Request("https://x/v1/lookups/by-domain?domain=acme.com"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      org: { status: string; locations?: { basis: string; canonical: boolean }[] };
    };
    expect(body.org.status).toBe("stub");
    expect(body.org.locations?.length).toBe(2);
    // Canonical first in the deterministic ordering.
    expect(body.org.locations?.[0]!.canonical).toBe(true);
    expect(body.org.locations?.every((l) => l.basis === "declared")).toBe(true);
  });

  it("returns status:tracked and no locations for a normal org", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_t", name: "Tracked", slug: "tracked", domain: "tracked.com" });
    const app = createTestApp(db, lookupRoutes);
    const res = await app(new Request("https://x/v1/lookups/by-domain?domain=tracked.com"));
    const body = (await res.json()) as { org: { status: string; locations?: unknown } };
    expect(body.org.status).toBe("tracked");
    expect(body.org.locations).toBeUndefined();
  });
});

describe("GET /v1/orgs/:slug (stub)", () => {
  it("adds status + locations for a stub", async () => {
    const db = createTestDb();
    await seedStub(db, { slug: "beta", domain: "beta.com" });
    const app = createTestApp(db, orgRoutes);
    const res = await app(new Request("https://x/v1/orgs/beta"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      locations?: unknown[];
      sources: unknown[];
    };
    expect(body.status).toBe("stub");
    expect(body.locations?.length).toBe(2);
    expect(body.sources.length).toBe(0);
  });

  it("omits locations for a tracked org", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_g", name: "Gamma", slug: "gamma" });
    const app = createTestApp(db, orgRoutes);
    const res = await app(new Request("https://x/v1/orgs/gamma"));
    const body = (await res.json()) as { status: string; locations?: unknown };
    expect(body.status).toBe("tracked");
    expect(body.locations).toBeUndefined();
  });
});

describe("GET /v1/orgs (stub badge + inclusion)", () => {
  it("includes a zero-release stub in the default list with status:stub", async () => {
    const db = createTestDb();
    await seedStub(db, { slug: "delta", domain: "delta.com" });
    const app = createTestApp(db, orgRoutes);
    // No ?includeEmpty — a stub must still appear (coverage breadth is the product).
    const res = await app(new Request("https://x/v1/orgs"));
    const body = (await res.json()) as {
      items: { slug: string; status?: string }[];
      meta?: { emptyOrgCount: number };
    };
    const delta = body.items.find((o) => o.slug === "delta");
    expect(delta).toBeDefined();
    expect(delta!.status).toBe("stub");
    // A stub is not counted as a hidden "empty org".
    expect(body.meta?.emptyOrgCount).toBe(0);
  });
});
