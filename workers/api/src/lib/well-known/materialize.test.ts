import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../test/setup.js";
import {
  classifyLocation,
  isUrlExcluded,
  locationMatchesSource,
  reconcileDomainEntities,
} from "./materialize.js";

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
    expect(plan.sources.map((entry) => entry.action)).toEqual(["create", "skip"]);
    expect(plan.sources[1]!.note).toBe("duplicate_location");
    const rows = await db.select().from(sources).where(eq(sources.orgId, "org_a"));
    expect(rows.length).toBe(1);
  });
});
