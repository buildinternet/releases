import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
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
