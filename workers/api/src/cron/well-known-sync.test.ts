import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources, products } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../test/setup.js";
import { wellKnownSync } from "./well-known-sync.js";

function fileFor(map: Record<string, unknown>) {
  return async (url: string) => {
    for (const [needle, body] of Object.entries(map)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response("nope", { status: 404 });
  };
}

describe("wellKnownSync cron", () => {
  it("runs both passes: org identity + repo grouping", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", domain: "acme.com" });
    await db.insert(sources).values({
      id: "src_1",
      orgId: "org_a",
      name: "Cloud",
      slug: "cloud",
      type: "github",
      url: "https://github.com/acme/cloud",
    });

    await wellKnownSync({
      DB: {} as any,
      MEDIA: { put: async () => undefined } as any,
      MEDIA_ORIGIN: "https://media.test",
      _drizzleOverride: db as any,
      fetchImpl: fileFor({
        "acme.com/.well-known/releases.json": { description: "CI for teams." },
        "raw.githubusercontent.com/acme/cloud/HEAD/releases.json": {
          product: { name: "Acme Cloud" },
        },
      }),
    });

    const [o] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    expect(o!.description).toBe("CI for teams.");
    const [p] = await db.select().from(products).where(eq(products.slug, "acme-cloud"));
    expect(p).toBeDefined();
    const [s] = await db.select().from(sources).where(eq(sources.id, "src_1"));
    expect(s!.productId).toBe(p!.id);
  });

  it("skips when CRON_ENABLED=false", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "o", slug: "s", name: "S", domain: "s.com" });
    let called = false;
    await wellKnownSync({
      DB: {} as any,
      MEDIA: {} as any,
      MEDIA_ORIGIN: "x",
      CRON_ENABLED: "false",
      _drizzleOverride: db as any,
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    });
    expect(called).toBe(false);
  });

  it("skips soft-deleted orgs in Pass 1", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({
      id: "org_dead",
      slug: "dead",
      name: "Dead",
      domain: "dead.com",
      deletedAt: "2020-01-01T00:00:00.000Z",
    });
    let hitDead = false;
    await wellKnownSync({
      DB: {} as any,
      MEDIA: {} as any,
      MEDIA_ORIGIN: "x",
      _drizzleOverride: db as any,
      fetchImpl: async (url: string) => {
        if (url.includes("dead.com")) {
          hitDead = true;
        }
        return new Response("nope", { status: 404 });
      },
    });
    expect(hitDead).toBe(false);
  });

  it("skips Pass 2 sources whose org is paused or deleted", async () => {
    const db = createTestDb();
    await db.insert(organizations).values([
      { id: "org_paused", slug: "paused", name: "Paused", fetchPaused: true },
      { id: "org_gone", slug: "gone", name: "Gone", deletedAt: "2020-01-01T00:00:00.000Z" },
    ]);
    // Sources left with deletedAt = null so the exclusion can only come from the
    // org-level join, not the source's own deletedAt.
    await db.insert(sources).values([
      {
        id: "src_p",
        orgId: "org_paused",
        name: "P",
        slug: "p",
        type: "github",
        url: "https://github.com/paused/repo",
      },
      {
        id: "src_g",
        orgId: "org_gone",
        name: "G",
        slug: "g",
        type: "github",
        url: "https://github.com/gone/repo",
      },
    ]);
    const hits: string[] = [];
    await wellKnownSync({
      DB: {} as any,
      MEDIA: {} as any,
      MEDIA_ORIGIN: "x",
      _drizzleOverride: db as any,
      fetchImpl: async (url: string) => {
        hits.push(url);
        return new Response("nope", { status: 404 });
      },
    });
    expect(hits.some((u) => u.includes("paused/repo"))).toBe(false);
    expect(hits.some((u) => u.includes("gone/repo"))).toBe(false);
  });
});
