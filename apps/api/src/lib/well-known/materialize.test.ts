import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  orgClaims,
  organizations,
  productTags,
  products,
  sources,
  tags,
} from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../test/setup.js";
import {
  classifyLocation,
  isUrlExcluded,
  locationMatchesSource,
  reconcileDomainEntities,
} from "./materialize.js";

const PUSH = {
  github: "acme/docs",
  path: "changelog/**/*.mdx",
  publish: "push" as const,
};

async function verifyOrg(db: ReturnType<typeof createTestDb>, orgId: string) {
  await db.insert(orgClaims).values({
    id: `clm_${orgId}`,
    orgId,
    userId: "user_owner",
    token: "relv_test",
    status: "verified",
    method: "well-known",
    verifiedAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-08T00:00:00.000Z",
  });
}

describe("well-known materialization helpers", () => {
  it("classifies MA-free and pending locator tiers", () => {
    expect(classifyLocation({ feed: "https://acme.com/feed.xml" })).toMatchObject({
      type: "feed",
      tier: 1,
      paused: false,
    });
    expect(classifyLocation({ github: "acme/repo" })).toMatchObject({
      type: "github",
      tier: 1,
      paused: false,
    });
    expect(classifyLocation(PUSH)).toMatchObject({
      type: "github",
      tier: 1,
      paused: false,
      locator: "acme/docs",
      publish: "push",
    });
    expect(
      classifyLocation({ appstore: "https://apps.apple.com/us/app/acme/id123" }),
    ).toMatchObject({
      type: "appstore",
      tier: 1,
      paused: false,
    });
    expect(classifyLocation({ url: "https://acme.com/updates" })).toMatchObject({
      type: "scrape",
      tier: 2,
      paused: true,
    });
    expect(classifyLocation({ file: "https://acme.com/CHANGELOG.md" })).toMatchObject({
      type: "scrape",
      tier: 2,
      paused: true,
    });
  });

  it("matches sources by every canonical locator and never by slug", () => {
    const source = {
      id: "src_one",
      type: "feed",
      url: "https://acme.com/updates",
      slug: "not-a-locator",
      metadata: JSON.stringify({
        feedUrl: "https://acme.com/feed.xml",
        githubUrl: "https://github.com/acme/repo",
        appStore: { trackId: "123" },
        declaredFileUrl: "https://acme.com/CHANGELOG.md",
      }),
    };
    expect(locationMatchesSource({ url: source.url }, source)).toBe(true);
    expect(locationMatchesSource({ feed: "https://acme.com/feed.xml" }, source)).toBe(true);
    expect(locationMatchesSource({ github: "acme/repo" }, source)).toBe(true);
    expect(
      locationMatchesSource({ appstore: "https://apps.apple.com/us/app/acme/id123" }, source),
    ).toBe(true);
    expect(locationMatchesSource({ file: "https://acme.com/CHANGELOG.md" }, source)).toBe(true);
    expect(locationMatchesSource({ url: "not-a-locator" }, source)).toBe(false);
  });

  it("honors org ignores plus global exact and domain blocks", () => {
    const policy = {
      ignored: ["https://acme.com/private"],
      blocked: [
        { pattern: "https://blocked.example/item", type: "exact" as const },
        { pattern: "evil.example", type: "domain" as const },
      ],
    };
    expect(isUrlExcluded("https://acme.com/private", policy)).toBe(true);
    expect(isUrlExcluded("https://blocked.example/item", policy)).toBe(true);
    expect(isUrlExcluded("https://evil.example/releases", policy)).toBe(true);
    expect(isUrlExcluded("https://safe.example/releases", policy)).toBe(false);
  });

  it("refuses to probe a feed on a private or internal host", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    const { plan } = await reconcileDomainEntities(
      db as any,
      "org_a",
      { version: 2, releases: [{ feed: "https://169.254.169.254/feed.xml" }] },
      {
        dryRun: false,
        enabled: true,
        source: "well-known",
        // Would parse fine if the screen were skipped — the note proves the skip source.
        fetchImpl: (async () =>
          new Response("<rss><channel><title>x</title></channel></rss>", {
            status: 200,
          })) as unknown as typeof fetch,
        resolveCategory: async () => null,
      },
    );
    expect(plan.sources[0]).toMatchObject({ action: "skip", note: "feed_private_host" });
    const rows = await db.select().from(sources).where(eq(sources.orgId, "org_a"));
    expect(rows.length).toBe(0);
  });

  it("creates a location declared twice in one manifest only once", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    const { plan } = await reconcileDomainEntities(
      db as any,
      "org_a",
      {
        version: 2,
        products: [{ name: "Acme Cloud", releases: [{ feed: "https://acme.com/feed.xml" }] }],
        releases: [{ feed: "https://acme.com/feed.xml" }],
      },
      {
        dryRun: false,
        enabled: true,
        source: "well-known",
        probe: async () => ({ ok: true }),
        resolveCategory: async () => null,
      },
    );
    // The second declaration matches the source the first one just created,
    // so the manifest still lands a single row.
    expect(plan.sources.map((entry) => entry.action)).toEqual(["create", "match"]);
    const rows = await db.select().from(sources).where(eq(sources.orgId, "org_a"));
    expect(rows.length).toBe(1);
  });

  it("associates declared product tags into product_tags additively", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    const { plan, applied } = await reconcileDomainEntities(
      db as any,
      "org_a",
      {
        version: 2,
        products: [
          {
            name: "Acme Cloud",
            tags: ["ci", "cloud"],
            releases: [{ feed: "https://acme.com/feed.xml" }],
          },
        ],
      },
      {
        dryRun: false,
        enabled: true,
        source: "well-known",
        probe: async () => ({ ok: true }),
        resolveCategory: async () => null,
      },
    );
    expect(applied).toBe(true);
    expect(plan.products[0]).toMatchObject({ action: "create", tags: ["ci", "cloud"] });

    const [product] = await db.select().from(products).where(eq(products.orgId, "org_a"));
    const links = await db
      .select({ slug: tags.slug })
      .from(productTags)
      .innerJoin(tags, eq(productTags.tagId, tags.id))
      .where(eq(productTags.productId, product!.id));
    expect(links.map((r) => r.slug).toSorted()).toEqual(["ci", "cloud"]);

    // Dry-run must never write tag associations.
    const dry = await reconcileDomainEntities(
      db as any,
      "org_a",
      {
        version: 2,
        products: [{ name: "Acme Two", tags: ["x"], releases: [{ github: "acme/x" }] }],
      },
      {
        dryRun: true,
        enabled: true,
        source: "well-known",
        probe: async () => ({ ok: true }),
        resolveCategory: async () => null,
      },
    );
    expect(dry.plan.products[0]).toMatchObject({ tags: ["x"] });
    const allLinks = await db.select().from(productTags);
    expect(allLinks.length).toBe(2); // still only ci + cloud from the applied run
  });

  it("creates a push-fed github source for a verified owner", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    await verifyOrg(db, "org_a");
    const { plan } = await reconcileDomainEntities(
      db as any,
      "org_a",
      { version: 2, releases: [PUSH] },
      {
        dryRun: false,
        enabled: true,
        source: "well-known",
        probe: async () => ({ ok: true, url: "https://github.com/acme/docs", title: "docs" }),
        resolveCategory: async () => null,
      },
    );
    expect(plan.sources[0]).toMatchObject({
      action: "create",
      type: "github",
      locator: "acme/docs",
      paused: false,
    });
    const [row] = await db.select().from(sources).where(eq(sources.orgId, "org_a"));
    expect(row!.type).toBe("github");
    expect(row!.url).toBe("https://github.com/acme/docs");
    expect(row!.fetchPriority).not.toBe("paused");
    const meta = JSON.parse(row!.metadata ?? "{}") as { ingestMode?: string; publishPath?: string };
    expect(meta.ingestMode).toBe("push");
    expect(meta.publishPath).toBe("changelog/**/*.mdx");
  });

  it("leaves a push locator unmaterialized when the domain is unverified", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    await db.insert(orgClaims).values({
      id: "clm_pending",
      orgId: "org_a",
      userId: "user_owner",
      token: "relv_pending",
      status: "pending",
      createdAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-08T00:00:00.000Z",
    });
    await db.insert(sources).values({
      id: "src_docs",
      orgId: "org_a",
      name: "Docs",
      slug: "docs",
      type: "github",
      url: "https://github.com/acme/docs",
      metadata: JSON.stringify({ curatorNote: "untouched" }),
    });
    const { plan } = await reconcileDomainEntities(
      db as any,
      "org_a",
      { version: 2, releases: [PUSH] },
      {
        dryRun: false,
        enabled: true,
        source: "well-known",
        probe: async () => ({ ok: true }),
        resolveCategory: async () => null,
      },
    );
    expect(plan.sources[0]).toMatchObject({ action: "skip", note: "unverified_owner" });
    const [row] = await db.select().from(sources).where(eq(sources.orgId, "org_a"));
    expect(JSON.parse(row!.metadata ?? "{}")).toEqual({ curatorNote: "untouched" });
  });

  it("does not overwrite a curator poll opt-out when matching a push locator", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    await verifyOrg(db, "org_a");
    await db.insert(sources).values({
      id: "src_docs",
      orgId: "org_a",
      name: "Docs",
      slug: "docs",
      type: "github",
      url: "https://github.com/acme/docs",
      metadata: JSON.stringify({ ingestMode: "poll", curatorNote: "keep polling" }),
      fetchPriority: "normal",
    });
    const { plan } = await reconcileDomainEntities(
      db as any,
      "org_a",
      { version: 2, releases: [PUSH] },
      {
        dryRun: false,
        enabled: true,
        source: "well-known",
        probe: async () => {
          throw new Error("matched sources are not probed");
        },
        resolveCategory: async () => null,
      },
    );
    expect(plan.sources[0]).toMatchObject({ action: "match", sourceId: "src_docs" });
    const [row] = await db.select().from(sources).where(eq(sources.id, "src_docs"));
    const meta = JSON.parse(row!.metadata ?? "{}") as {
      ingestMode?: string;
      publishPath?: string;
      curatorNote?: string;
    };
    expect(meta.ingestMode).toBe("poll");
    expect(meta.publishPath).toBe("changelog/**/*.mdx");
    expect(meta.curatorNote).toBe("keep polling");
    expect(row!.fetchPriority).toBe("normal");
    expect(row!.url).toBe("https://github.com/acme/docs");
  });
});
