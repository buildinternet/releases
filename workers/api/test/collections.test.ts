import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
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

  it("includes full release content for the cross-org feed", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections/test-frontier-labs/releases"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // The web release card falls back from `content` to `summary` when
    // expanding — without `content` "Show more" silently shows the same
    // truncated text. Mirrors the org-feed shape on /v1/orgs/:slug/releases.
    expect(body.releases[0]).toMatchObject({
      id: "rel_a1",
      content: "Released Claude 4.7.",
      summary: "Released Claude 4.7.",
    });
  });

  it("renders the feed as markdown when Accept prefers it", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/collections/test-frontier-labs/releases", {
        headers: { accept: "text/markdown" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("collection: test-frontier-labs");
    expect(body).toContain("collection_name: Test Frontier Labs");
    expect(body).toContain("Released Claude 4.7.");
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

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("collections (writes)", () => {
  it("creates a collection (slug derived from name when omitted)", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "http://test/v1/collections",
        json("POST", { name: "Inference Providers", description: "API-first inference." }),
      ),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.slug).toBe("inference-providers");
    expect(created.name).toBe("Inference Providers");
    expect(created.description).toBe("API-first inference.");
    expect(created.id.startsWith("col_")).toBe(true);
  });

  it("rejects malformed slug with 400", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/collections", json("POST", { name: "Bad", slug: "Has Spaces" })),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate slug", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections",
        json("POST", { name: "Test Frontier Labs", slug: "test-frontier-labs" }),
      ),
    );
    expect(res.status).toBe(409);
  });

  it("patches name and description", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-frontier-labs",
        json("PATCH", { name: "Renamed Labs", description: "Updated." }),
      ),
    );
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.name).toBe("Renamed Labs");
    expect(updated.description).toBe("Updated.");
    expect(updated.slug).toBe("test-frontier-labs");
  });

  it("renames slug via PATCH and returns 404 on the old slug", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-empty-set",
        json("PATCH", { slug: "renamed-empty" }),
      ),
    );
    expect(res.status).toBe(200);
    const after = await fetch(new Request("http://test/v1/collections/test-empty-set"));
    expect(after.status).toBe(404);
    const renamed = await fetch(new Request("http://test/v1/collections/renamed-empty"));
    expect(renamed.status).toBe(200);
  });

  it("DELETEs a collection (cascade clears members)", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/collections/test-frontier-labs", { method: "DELETE" }),
    );
    expect(res.status).toBe(204);
    const after = await fetch(new Request("http://test/v1/collections/test-frontier-labs"));
    expect(after.status).toBe(404);
    const remaining = await db
      .select()
      .from(collectionMembers)
      .where(eq(collectionMembers.collectionId, "col_test_fal"));
    expect(remaining).toEqual([]);
  });

  it("PUT replaces full membership atomically (positions follow array index)", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-frontier-labs/members",
        json("PUT", { orgs: [{ orgSlug: "openai" }, { orgSlug: "anthropic" }] }),
      ),
    );
    expect(res.status).toBe(200);
    const detail = await fetch(new Request("http://test/v1/collections/test-frontier-labs"));
    const body = await detail.json();
    expect(body.orgs.map((o: { slug: string }) => o.slug)).toEqual(["openai", "anthropic"]);
  });

  it("PUT rejects duplicate orgs in the same payload", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-frontier-labs/members",
        json("PUT", {
          orgs: [{ orgSlug: "openai" }, { orgId: "org_oai" }],
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it("POST adds a single member", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-empty-set/members",
        json("POST", { orgSlug: "openai", position: 0 }),
      ),
    );
    expect(res.status).toBe(201);
    const detail = await fetch(new Request("http://test/v1/collections/test-empty-set"));
    const body = await detail.json();
    expect(body.orgs.map((o: { slug: string }) => o.slug)).toEqual(["openai"]);
  });

  it("POST returns 409 when org is already a member", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-frontier-labs/members",
        json("POST", { orgSlug: "anthropic" }),
      ),
    );
    expect(res.status).toBe(409);
  });

  it("POST returns 404 when org is unknown", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-frontier-labs/members",
        json("POST", { orgSlug: "no-such-org" }),
      ),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("DELETE removes a single member by slug", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/collections/test-frontier-labs/members/openai", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
    const detail = await fetch(new Request("http://test/v1/collections/test-frontier-labs"));
    const body = await detail.json();
    expect(body.orgs.map((o: { slug: string }) => o.slug)).toEqual(["anthropic"]);
  });

  it("DELETE on a non-member returns 404", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/collections/test-empty-set/members/openai", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(404);
  });
});
