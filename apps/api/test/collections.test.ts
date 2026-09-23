import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import {
  organizations,
  sources,
  releases,
  products,
  collections,
  collectionMembers,
} from "@buildinternet/releases-core/schema";
import { collectionRoutes } from "../src/routes/collections.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, collectionRoutes);

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
  it("caps previewMembers at 3 while memberCount reflects the full membership (windowed fetch)", async () => {
    const db = mkDb();
    const N = 15; // > PREVIEW_FETCH (12), so the member fetch is windowed
    const orgs = Array.from({ length: N }, (_, i) => {
      const n = String(i).padStart(2, "0");
      return { id: `org_w${n}`, slug: `wide-${n}`, name: `WideOrg ${n}`, category: "ai" };
    });
    await db.insert(organizations).values(orgs);
    await db.insert(collections).values([{ id: "col_wide", slug: "test-wide", name: "Test Wide" }]);
    await db
      .insert(collectionMembers)
      .values(orgs.map((o, i) => ({ collectionId: "col_wide", orgId: o.id, position: i })));

    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      slug: string;
      memberCount: number;
      previewMembers: Array<{ slug: string }>;
    }>;
    const row = body.find((c) => c.slug === "test-wide");
    expect(row).toBeDefined();
    // Full count survives the windowed preview fetch (count query is separate).
    expect(row?.memberCount).toBe(N);
    // Preview is capped and is the top-3 by (position, name).
    expect(row?.previewMembers.map((m) => m.slug)).toEqual(["wide-00", "wide-01", "wide-02"]);
  });

  it("preview is deterministic when a tie group (all position 0) exceeds the window", async () => {
    // A single-member add defaults position to 0, so a collection can have many
    // members all at position 0 — the tie group exceeds PREVIEW_FETCH (12). The
    // windowed SQL fetch + JS interleave must agree on the order (both BINARY on
    // name, then slug), so the preview is the deterministic top-3 and never
    // drops a member it should have shown.
    const db = mkDb();
    const N = 15;
    // Mixed-case names where BINARY (uppercase < lowercase) diverges from
    // localeCompare; the result must follow SQL's BINARY order, not locale.
    const orgs = Array.from({ length: N }, (_, i) => {
      const n = String(i).padStart(2, "0");
      return { id: `org_t${n}`, slug: `tie-${n}`, name: `Org-${n}`, category: "ai" };
    });
    await db.insert(organizations).values(orgs);
    await db.insert(collections).values([{ id: "col_tie", slug: "test-tie", name: "Test Tie" }]);
    // All at the default position 0.
    await db
      .insert(collectionMembers)
      .values(orgs.map((o) => ({ collectionId: "col_tie", orgId: o.id, position: 0 })));

    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections"));
    const body = (await res.json()) as Array<{
      slug: string;
      memberCount: number;
      previewMembers: Array<{ slug: string }>;
    }>;
    const row = body.find((c) => c.slug === "test-tie");
    expect(row?.memberCount).toBe(N);
    // BINARY order on name → Org-00, Org-01, Org-02 (the SQL window's top-3).
    expect(row?.previewMembers.map((m) => m.slug)).toEqual(["tie-00", "tie-01", "tie-02"]);
  });

  it("lists collections with member counts", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // Filter past the seed migration's `frontier-ai-labs` row so the
    // assertion isn't coupled to its membership count.
    const ours = body.filter((c: { slug: string }) => c.slug.startsWith("test-"));
    // memberCount and previewMembers both join through organizations_public
    // so on_demand / soft-deleted orgs are excluded from the count *and*
    // hidden from the preview — "3 orgs" never disagrees with "showing 2".
    expect(ours).toEqual([
      {
        slug: "test-empty-set",
        name: "Test Empty Set",
        description: null,
        memberCount: 0,
        isFeatured: false,
        previewMembers: [],
        previewOrgs: [],
      },
      {
        slug: "test-frontier-labs",
        name: "Test Frontier Labs",
        description: null,
        memberCount: 2,
        isFeatured: false,
        // previewMembers carries the kind discriminator so a mixed-kind
        // collection can render product chips alongside org chips.
        previewMembers: [
          {
            kind: "org",
            slug: "anthropic",
            name: "Anthropic",
            domain: null,
            avatarUrl: null,
            githubHandle: null,
            description: null,
          },
          {
            kind: "org",
            slug: "openai",
            name: "OpenAI",
            domain: null,
            avatarUrl: null,
            githubHandle: null,
            description: null,
          },
        ],
        // Legacy previewOrgs subset (org-kind members only, no discriminator).
        previewOrgs: [
          {
            slug: "anthropic",
            name: "Anthropic",
            domain: null,
            avatarUrl: null,
            githubHandle: null,
            description: null,
          },
          {
            slug: "openai",
            name: "OpenAI",
            domain: null,
            avatarUrl: null,
            githubHandle: null,
            description: null,
          },
        ],
      },
    ]);
  });

  it("returns ordered visible org members on detail", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections/test-frontier-labs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
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
    const body = (await res.json()) as any;
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
    const body = (await res.json()) as any;
    // Strict published_at DESC interleaving across the two visible orgs.
    expect(body.releases.map((r: { id: string }) => r.id)).toEqual(["rel_a1", "rel_o1", "rel_a2"]);
  });

  it("includes full release content for the cross-org feed", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections/test-frontier-labs/releases"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
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
    const body = (await res.json()) as any;
    expect(body.releases).toEqual([]);
    expect(body.pagination.nextCursor).toBeNull();
  });

  it("honors markdown negotiation for empty-membership collections", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/collections/test-empty-set/releases", {
        headers: { accept: "text/markdown" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("collection: test-empty-set");
    expect(body).toContain("release_count: 0");
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
    const created = (await res.json()) as any;
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
    const updated = (await res.json()) as any;
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
    const body = (await detail.json()) as any;
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
    const body = (await detail.json()) as any;
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
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("not_found");
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
    const body = (await detail.json()) as any;
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

describe("collections (featured)", () => {
  it("list rows carry isFeatured, defaulting to false", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ slug: string; isFeatured: boolean }>;
    const row = body.find((c) => c.slug === "test-empty-set")!;
    expect(row.isFeatured).toBe(false);
  });

  it("?featured=1 returns only featured collections", async () => {
    const db = mkDb();
    await seed(db);
    await db
      .update(collections)
      .set({ isFeatured: true })
      .where(eq(collections.slug, "test-frontier-labs"));
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections?featured=1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      slug: string;
      isFeatured: boolean;
      previewMembers: Array<{ slug: string }>;
    }>;
    const slugs = body.map((c) => c.slug);
    expect(slugs).toContain("test-frontier-labs");
    expect(slugs).not.toContain("test-empty-set");
    expect(body.every((c) => c.isFeatured === true)).toBe(true);
    // The member queries are filtered by the same featured predicate; the
    // featured row must still carry its preview members (not be emptied).
    const row = body.find((c) => c.slug === "test-frontier-labs")!;
    expect(row.previewMembers.map((m) => m.slug)).toEqual(["anthropic", "openai"]);
  });

  it("detail payload includes isFeatured", async () => {
    const db = mkDb();
    await seed(db);
    await db
      .update(collections)
      .set({ isFeatured: true })
      .where(eq(collections.slug, "test-frontier-labs"));
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections/test-frontier-labs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isFeatured: boolean };
    expect(body.isFeatured).toBe(true);
  });

  it("PATCH { isFeatured } persists, echoes, and surfaces under ?featured=1", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/collections/test-empty-set", json("PATCH", { isFeatured: true })),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { isFeatured: boolean };
    expect(updated.isFeatured).toBe(true);

    const listed = await fetch(new Request("http://test/v1/collections?featured=1"));
    const body = (await listed.json()) as Array<{ slug: string }>;
    expect(body.map((c) => c.slug)).toContain("test-empty-set");
  });
});

// Product members let a curator pin a single product out of an org's catalog
// — the example use case from the original ticket is a "coding agents"
// collection that includes Claude Code without dragging the rest of
// Anthropic's products along.
async function seedWithProduct(db: ReturnType<typeof mkDb>) {
  await seed(db);
  await db.insert(products).values([
    {
      id: "prod_claude_code",
      orgId: "org_anth",
      slug: "claude-code",
      name: "Claude Code",
      description: "Coding agent.",
    },
    // A sibling product on the same org that should NOT appear when the
    // collection only pins Claude Code — proves product-grained membership.
    { id: "prod_messages", orgId: "org_anth", slug: "messages", name: "Messages API" },
  ]);
  await db.insert(sources).values([
    {
      id: "src_cc_releases",
      slug: "claude-code-releases",
      name: "Claude Code Releases",
      type: "github",
      url: "https://github.com/anthropics/claude-code/releases",
      orgId: "org_anth",
      productId: "prod_claude_code",
    },
    {
      id: "src_msg_releases",
      slug: "messages-changelog",
      name: "Messages Changelog",
      type: "feed",
      url: "https://docs.anthropic.com/messages/changelog",
      orgId: "org_anth",
      productId: "prod_messages",
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_cc1",
      sourceId: "src_cc_releases",
      title: "Claude Code 1.0",
      content: "First release.",
      url: "https://github.com/anthropics/claude-code/releases/tag/v1.0",
      publishedAt: "2026-05-07T18:00:00.000Z",
    },
    {
      id: "rel_msg1",
      sourceId: "src_msg_releases",
      title: "Messages API update",
      content: "Streaming fix.",
      url: "https://docs.anthropic.com/messages/changelog/2026-05-07",
      publishedAt: "2026-05-07T19:00:00.000Z",
    },
  ]);
}

describe("collections (product members)", () => {
  it("POST adds a product member with the kind discriminator", async () => {
    const db = mkDb();
    await seedWithProduct(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-empty-set/members",
        json("POST", { productId: "prod_claude_code" }),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind: string; productId: string; orgId?: string };
    expect(body.kind).toBe("product");
    expect(body.productId).toBe("prod_claude_code");
    expect(body.orgId).toBeUndefined();
  });

  it("POST resolves productSlug paired with orgSlug (per-org slugs are not globally unique)", async () => {
    const db = mkDb();
    await seedWithProduct(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-empty-set/members",
        json("POST", { orgSlug: "anthropic", productSlug: "claude-code" }),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind: string; productId: string };
    expect(body.productId).toBe("prod_claude_code");
  });

  it("POST rejects bare productSlug without an org context (400)", async () => {
    const db = mkDb();
    await seedWithProduct(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-empty-set/members",
        json("POST", { productSlug: "claude-code" }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it("PUT mixes org and product members atomically", async () => {
    const db = mkDb();
    await seedWithProduct(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-empty-set/members",
        json("PUT", {
          orgs: [{ orgSlug: "openai" }, { productId: "prod_claude_code" }],
        }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ kind: string; position: number }> };
    expect(body.members.map((m) => m.kind)).toEqual(["org", "product"]);

    // Detail page surfaces both kinds via `members`; legacy `orgs` carries
    // only the org-kind subset.
    const detail = await fetch(new Request("http://test/v1/collections/test-empty-set"));
    const detailBody = (await detail.json()) as {
      members: Array<{ kind: string; slug: string }>;
      orgs: Array<{ slug: string }>;
    };
    expect(detailBody.members.map((m) => `${m.kind}:${m.slug}`)).toEqual([
      "org:openai",
      "product:claude-code",
    ]);
    expect(detailBody.orgs.map((o) => o.slug)).toEqual(["openai"]);
  });

  it("releases feed pulls in product-source rows when a product is pinned", async () => {
    const db = mkDb();
    await seedWithProduct(db);
    await db.insert(collectionMembers).values({
      collectionId: "col_test_empty",
      productId: "prod_claude_code",
      position: 0,
    });
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections/test-empty-set/releases"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: Array<{ id: string }> };
    // Only Claude Code's release surfaces — the Messages API release is on the
    // same org but a different product, so pinning only `prod_claude_code`
    // must not pull it in.
    expect(body.releases.map((r) => r.id)).toEqual(["rel_cc1"]);
  });

  it("releases feed merges org members with product members (no dupes)", async () => {
    const db = mkDb();
    await seedWithProduct(db);
    // Pin both the whole Anthropic org AND Claude Code explicitly. A
    // release whose source is bound to the pinned product would match both
    // branches; dedup must keep it from appearing twice in the feed.
    await db.insert(collectionMembers).values([
      { collectionId: "col_test_empty", orgId: "org_anth", position: 0 },
      { collectionId: "col_test_empty", productId: "prod_claude_code", position: 1 },
    ]);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/collections/test-empty-set/releases"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: Array<{ id: string }> };
    const ids = body.releases.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Both Anthropic releases (Claude 4.7 and 4.6) plus both product
    // releases (Claude Code + Messages — Messages's source is on the org we
    // pinned, so it qualifies via the org branch).
    expect(ids.toSorted()).toEqual(["rel_a1", "rel_a2", "rel_cc1", "rel_msg1"]);
  });

  it("DELETE /members/products/:product unpins a product by id", async () => {
    const db = mkDb();
    await seedWithProduct(db);
    await db.insert(collectionMembers).values({
      collectionId: "col_test_empty",
      productId: "prod_claude_code",
      position: 0,
    });
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/collections/test-empty-set/members/products/prod_claude_code", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
    const remaining = await db
      .select()
      .from(collectionMembers)
      .where(eq(collectionMembers.collectionId, "col_test_empty"));
    expect(remaining).toEqual([]);
  });

  it("DELETE /members/products/:product rejects a bare slug (400)", async () => {
    const db = mkDb();
    await seedWithProduct(db);
    const fetch = mkApp(db);
    // Bare slugs are ambiguous post-#690 (per-org); the org-scoped delete
    // path requires a typed `prod_…` id.
    const res = await fetch(
      new Request("http://test/v1/collections/test-empty-set/members/products/claude-code", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("?products= narrows the feed to a subset of product members", async () => {
    const db = mkDb();
    await seedWithProduct(db);
    await db.insert(collectionMembers).values([
      { collectionId: "col_test_empty", productId: "prod_claude_code", position: 0 },
      { collectionId: "col_test_empty", productId: "prod_messages", position: 1 },
    ]);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/collections/test-empty-set/releases?products=claude-code"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: Array<{ id: string }> };
    expect(body.releases.map((r) => r.id)).toEqual(["rel_cc1"]);
  });

  it("POSTing a product reflects in detail (members + memberCount + previewMembers); legacy orgs stays empty", async () => {
    const db = mkDb();
    await seedWithProduct(db);
    const fetch = mkApp(db);

    const postRes = await fetch(
      new Request(
        "http://test/v1/collections/test-empty-set/members",
        json("POST", { productId: "prod_claude_code" }),
      ),
    );
    expect(postRes.status).toBe(201);

    const detailRes = await fetch(new Request("http://test/v1/collections/test-empty-set"));
    const detailBody = (await detailRes.json()) as {
      members: Array<{ kind: string; slug: string; name: string; org?: { slug: string } }>;
      orgs: Array<{ slug: string }>;
    };
    expect(detailBody.members).toHaveLength(1);
    expect(detailBody.members[0]?.kind).toBe("product");
    expect(detailBody.members[0]?.slug).toBe("claude-code");
    expect(detailBody.members[0]?.org?.slug).toBe("anthropic");
    expect(detailBody.orgs).toEqual([]);

    const listRes = await fetch(new Request("http://test/v1/collections"));
    const listBody = (await listRes.json()) as Array<{
      slug: string;
      memberCount: number;
      previewMembers: Array<{ kind: string; slug: string }>;
      previewOrgs: Array<{ slug: string }>;
    }>;
    const row = listBody.find((c) => c.slug === "test-empty-set")!;
    expect(row.memberCount).toBe(1);
    expect(row.previewMembers).toEqual([
      expect.objectContaining({ kind: "product", slug: "claude-code" }),
    ]);
    expect(row.previewOrgs).toEqual([]);
  });

  it("rejects contradictory org + product refs", async () => {
    const db = mkDb();
    await seedWithProduct(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request(
        "http://test/v1/collections/test-empty-set/members",
        json("POST", { orgSlug: "openai", productId: "prod_claude_code" }),
      ),
    );
    expect(res.status).toBe(400);
  });
});
