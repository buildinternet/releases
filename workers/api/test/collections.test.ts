import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import {
  organizations,
  sources,
  releases,
  collections,
  collectionMembers,
} from "@buildinternet/releases-core/schema";
import { Hono } from "hono";
import { collectionRoutes } from "../src/routes/collections.js";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>) {
  const fakeEnv = { DB: db };
  const fakeCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", collectionRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv, fakeCtx);
}

async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values([
    { id: "org_anth", slug: "anthropic", name: "Anthropic", category: "ai" },
    { id: "org_oai", slug: "openai", name: "OpenAI", category: "ai" },
    // on_demand should be filtered out by organizations_public.
    {
      id: "org_hidden",
      slug: "hidden-lab",
      name: "Hidden Lab",
      category: "ai",
      discovery: "on_demand",
    },
  ]);
  await db.insert(sources).values([
    {
      id: "src_anth",
      slug: "news",
      name: "News",
      type: "feed",
      url: "https://www.anthropic.com/news",
      orgId: "org_anth",
    },
    {
      id: "src_oai",
      slug: "blog",
      name: "Blog",
      type: "feed",
      url: "https://openai.com/blog",
      orgId: "org_oai",
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_a1",
      sourceId: "src_anth",
      title: "Claude 4.7",
      content: "Released Claude 4.7.",
      url: "https://www.anthropic.com/news/claude-4-7",
      publishedAt: "2026-05-06T18:00:00.000Z",
    },
    {
      id: "rel_o1",
      sourceId: "src_oai",
      title: "GPT-5 Preview",
      content: "GPT-5 enters preview.",
      url: "https://openai.com/blog/gpt5",
      publishedAt: "2026-05-05T17:00:00.000Z",
      prerelease: true,
    },
    {
      id: "rel_a2",
      sourceId: "src_anth",
      title: "Claude 4.6",
      content: "Released Claude 4.6.",
      url: "https://www.anthropic.com/news/claude-4-6",
      publishedAt: "2026-04-15T18:00:00.000Z",
    },
  ]);
  // The seed migration (20260507000003) creates `frontier-ai-labs` as part of
  // applyMigrations(). Use `test-`-prefixed slugs so its membership (keyed on
  // org slug) doesn't collide with these fixtures.
  await db.insert(collections).values([
    { id: "col_test_fal", slug: "test-frontier-labs", name: "Test Frontier Labs" },
    { id: "col_test_empty", slug: "test-empty-set", name: "Test Empty Set" },
  ]);
  await db.insert(collectionMembers).values([
    { collectionId: "col_test_fal", orgId: "org_anth", position: 0 },
    { collectionId: "col_test_fal", orgId: "org_oai", position: 1 },
    { collectionId: "col_test_fal", orgId: "org_hidden", position: 2 },
  ]);
}

describe("collections", () => {
  it("lists collections with member counts", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Filter past the seed migration's `frontier-ai-labs` row so the
    // assertion isn't coupled to its membership count.
    const ours = body.filter((c: { slug: string }) => c.slug.startsWith("test-"));
    expect(ours).toEqual([
      // Hidden orgs still count against memberCount — the join is to the
      // base collection_members row, not the visibility-filtered org view.
      { slug: "test-empty-set", name: "Test Empty Set", description: null, memberCount: 0 },
      {
        slug: "test-frontier-labs",
        name: "Test Frontier Labs",
        description: null,
        memberCount: 3,
      },
    ]);
  });

  it("returns ordered visible org members on detail", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections/test-frontier-labs"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe("test-frontier-labs");
    // Hidden Lab is filtered out by organizations_public; the remaining two
    // come back in position order.
    expect(body.orgs.map((o: { slug: string }) => o.slug)).toEqual(["anthropic", "openai"]);
  });

  it("404s on unknown collection", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections/nope"));
    expect(res.status).toBe(404);
  });

  it("returns interleaved release feed across member orgs", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections/test-frontier-labs/releases"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Default: prereleases hidden — GPT-5 Preview is filtered out, leaving
    // Claude 4.7 and Claude 4.6 (both Anthropic). Both rows carry the org
    // discriminator the cross-org UI uses for byline labels.
    expect(body.releases.map((r: { id: string }) => r.id)).toEqual(["rel_a1", "rel_a2"]);
    expect(body.releases[0].org).toEqual({ slug: "anthropic", name: "Anthropic" });
  });

  it("includes prereleases when flag is set", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-frontier-labs/releases?include_prereleases=true",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Strict published_at DESC interleaving across the two visible orgs.
    expect(body.releases.map((r: { id: string }) => r.id)).toEqual(["rel_a1", "rel_o1", "rel_a2"]);
  });

  it("returns an empty feed (not 500) for membership-empty collections", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections/test-empty-set/releases"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.releases).toEqual([]);
    expect(body.pagination.nextCursor).toBeNull();
  });
});
