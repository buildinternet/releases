import { describe, it, expect } from "bun:test";
import { createTestDb } from "../../../test/setup.js";
import { createStubOrg } from "../well-known/stub.js";
import { validateListing, normalizeListingDomain } from "./validate.js";

const WEB = { webBaseUrl: "https://releases.sh" };

/** fetchImpl that serves a manifest for https://<domain>/.well-known/releases.json */
const manifestFetch = (manifest: unknown) => async () =>
  new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const VALID_MANIFEST = {
  version: 2,
  name: "Acme",
  products: [{ name: "Widget", releases: [{ feed: "https://acme.com/widget.xml" }] }],
  releases: [{ url: "https://acme.com/blog" }],
};

describe("normalizeListingDomain", () => {
  it("lowercases, strips trailing dots, rejects junk", () => {
    expect(normalizeListingDomain("Acme.COM.")).toBe("acme.com");
    expect(normalizeListingDomain("not a domain!")).toBeNull();
  });
});

describe("validateListing", () => {
  it("returns a valid unlisted preview with classified locations", async () => {
    const db = createTestDb();
    const res = await validateListing(db as never, "acme.com", {
      ...WEB,
      fetchImpl: manifestFetch(VALID_MANIFEST),
    });
    expect(res.valid).toBe(true);
    expect(res.domainStatus).toBe("unlisted");
    expect(res.identity).toEqual({ name: "Acme", slug: "acme", domain: "acme.com" });
    expect(res.locations).toEqual([
      {
        locator: "https://acme.com/widget.xml",
        kind: "feed",
        classification: "tier1-live",
        becomes: "Live source when tracked",
        productName: "Widget",
      },
      {
        locator: "https://acme.com/blog",
        kind: "url",
        classification: "tier2-paused-review",
        becomes: "Queued for curator review when tracked",
      },
    ]);
  });

  it("reports schema issues with paths, still resolving domainStatus", async () => {
    const db = createTestDb();
    const res = await validateListing(db as never, "acme.com", {
      ...WEB,
      fetchImpl: manifestFetch({ version: 2, products: [{ releases: [{}] }] }),
    });
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors[0]).toHaveProperty("path");
    expect(res.errors[0]).toHaveProperty("message");
    expect(res.locations).toEqual([]);
  });

  it("maps fetch failures to a single actionable error", async () => {
    const db = createTestDb();
    const res = await validateListing(db as never, "acme.com", {
      ...WEB,
      fetchImpl: async () => new Response("nope", { status: 404 }),
    });
    expect(res.valid).toBe(false);
    expect(res.errors[0]!.path).toBe("");
    expect(res.errors[0]!.message).toContain("releases.json");
  });

  it("flags a stub domain with the org pointer", async () => {
    const db = createTestDb();
    await createStubOrg(
      db as never,
      { name: "Acme", slug: "acme", domain: "acme.com", products: [], locations: [] },
      { basis: "curator" },
    );
    const res = await validateListing(db as never, "acme.com", {
      ...WEB,
      fetchImpl: manifestFetch(VALID_MANIFEST),
    });
    expect(res.domainStatus).toBe("stub");
    expect(res.org).toEqual({ slug: "acme", name: "Acme", webUrl: "https://releases.sh/acme" });
  });

  it("flags a tracked domain as listed", async () => {
    const db = createTestDb();
    const { org } = await createStubOrg(
      db as never,
      { name: "Acme", slug: "acme", domain: "acme.com", products: [], locations: [] },
      { basis: "curator" },
    );
    const { organizations } = await import("@buildinternet/releases-core/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(organizations).set({ tier: "tracked" }).where(eq(organizations.id, org.id));
    const res = await validateListing(db as never, "acme.com", {
      ...WEB,
      fetchImpl: manifestFetch(VALID_MANIFEST),
    });
    expect(res.domainStatus).toBe("listed");
  });
});
