import { describe, it, expect } from "bun:test";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, createTestApp } from "./setup";

describe("GET /v1/releases/:id appstore", () => {
  it("surfaces appStore {platform,iconUrl} for an appstore release", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "notion", name: "Notion", category: "cloud" });
    await db.insert(sources).values({
      id: "src_app",
      slug: "notion-ios",
      name: "Notion",
      type: "appstore",
      url: "https://apps.apple.com/us/app/id1",
      orgId: "org_a",
      metadata: JSON.stringify({
        appStore: {
          trackId: "1",
          storefront: "us",
          platform: "ios",
          artworkUrl: "https://is1-ssl.mzstatic.com/a/1024x1024bb.png",
        },
      }),
    });
    await db.insert(releases).values({
      id: "rel_app",
      sourceId: "src_app",
      title: "Notion 3.12.0",
      version: "3.12.0",
      content: "Bug fixes.",
      url: "https://apps.apple.com/us/app/id1?v=3.12.0",
      publishedAt: "2026-05-27T00:00:00Z",
    });

    const app = createTestApp(db, sourceRoutes);
    const res = await app(new Request("http://x/v1/releases/rel_app"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appStore?: unknown };
    expect(body.appStore).toEqual({
      platform: "ios",
      iconUrl: "https://is1-ssl.mzstatic.com/a/1024x1024bb.png",
    });
  });

  it("omits appStore (null) for a non-appstore release", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_b", slug: "acme", name: "Acme", category: "cloud" });
    await db.insert(sources).values({
      id: "src_feed",
      slug: "acme-feed",
      name: "Acme",
      type: "feed",
      url: "https://acme.test/feed",
      orgId: "org_b",
    });
    await db.insert(releases).values({
      id: "rel_feed",
      sourceId: "src_feed",
      title: "Acme 1.0",
      content: "Notes",
      url: "https://acme.test/1",
      publishedAt: "2026-05-27T00:00:00Z",
    });

    const app = createTestApp(db, sourceRoutes);
    const res = await app(new Request("http://x/v1/releases/rel_feed"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appStore?: unknown };
    expect(body.appStore ?? null).toBeNull();
  });
});

describe("GET /v1/releases/:id org + product", () => {
  it("surfaces org.avatarUrl and the owning product when grouped", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({
      id: "org_g",
      slug: "google",
      name: "Google",
      category: "cloud",
      avatarUrl: "https://media.releases.sh/orgs/google.png",
    });
    await db
      .insert(products)
      .values({ id: "prod_chrome", slug: "chrome", name: "Chrome", orgId: "org_g" });
    await db.insert(sources).values({
      id: "src_chrome",
      slug: "chrome-releases",
      name: "Chrome Releases",
      type: "feed",
      url: "https://chrome.test/feed",
      orgId: "org_g",
      productId: "prod_chrome",
    });
    await db.insert(releases).values({
      id: "rel_chrome",
      sourceId: "src_chrome",
      title: "Extended Stable 148",
      content: "Notes",
      url: "https://chrome.test/148",
      publishedAt: "2026-06-08T00:00:00Z",
    });

    const app = createTestApp(db, sourceRoutes);
    const res = await app(new Request("http://x/v1/releases/rel_chrome"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      org?: { slug: string; name: string; avatarUrl?: string | null };
      product?: { slug: string; name: string } | null;
    };
    expect(body.org).toMatchObject({
      slug: "google",
      name: "Google",
      avatarUrl: "https://media.releases.sh/orgs/google.png",
    });
    expect(body.product).toEqual({ slug: "chrome", name: "Chrome" });
  });

  it("returns product null when the source is not grouped under a product", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_n", slug: "acme", name: "Acme", category: "cloud" });
    await db.insert(sources).values({
      id: "src_plain",
      slug: "acme-feed",
      name: "Acme",
      type: "feed",
      url: "https://acme.test/feed",
      orgId: "org_n",
    });
    await db.insert(releases).values({
      id: "rel_plain",
      sourceId: "src_plain",
      title: "Acme 1.0",
      content: "Notes",
      url: "https://acme.test/1",
      publishedAt: "2026-05-27T00:00:00Z",
    });

    const app = createTestApp(db, sourceRoutes);
    const res = await app(new Request("http://x/v1/releases/rel_plain"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      org?: { avatarUrl?: string | null };
      product?: { slug: string; name: string } | null;
    };
    expect(body.product ?? null).toBeNull();
    expect(body.org?.avatarUrl ?? null).toBeNull();
  });
});
