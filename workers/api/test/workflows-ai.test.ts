import { describe, it, expect, beforeEach } from "bun:test";
import { mockModule } from "../../../tests/mock-module.ts";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources, releases, usageLog } from "@buildinternet/releases-core/schema";

type AnthropicCall = { model: string; messages: unknown; system: string };
const anthropicCalls: AnthropicCall[] = [];
let nextResponseText = "generated text";

await mockModule(
  "../src/lib/anthropic.js",
  () => ({
    callAnthropic: async (
      _apiKey: string,
      req: {
        model: string;
        system: string;
        messages: unknown;
      },
    ) => {
      anthropicCalls.push({ model: req.model, system: req.system, messages: req.messages });
      return { text: nextResponseText, inputTokens: 100, outputTokens: 50 };
    },
    getAnthropicKey: async (env: { ANTHROPIC_API_KEY?: { get(): Promise<string> } }) => {
      const k = await env.ANTHROPIC_API_KEY?.get();
      return k && k.length > 0 ? k : null;
    },
    resolveGatewayOpts: async () => ({}),
  }),
  import.meta.url,
);

const { Hono } = await import("hono");
const { workflowsRoutes } = await import("../src/routes/workflows.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>, opts?: { apiKey?: string | null }) {
  const apiKey = opts?.apiKey === undefined ? "test-key" : opts.apiKey;
  const fakeEnv = {
    DB: db,
    ANTHROPIC_API_KEY: apiKey !== null ? { get: async () => apiKey } : undefined,
  };
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", workflowsRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv);
}

async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values([
    { id: "org_a", slug: "acme", name: "Acme", category: "cloud" },
    { id: "org_b", slug: "other", name: "Other", category: "cloud" },
  ]);
  await db.insert(sources).values([
    {
      id: "src_a1",
      orgId: "org_a",
      slug: "acme-one",
      name: "Acme One",
      url: "https://a.test/1",
      type: "feed",
    },
    {
      id: "src_a2",
      orgId: "org_a",
      slug: "acme-two",
      name: "Acme Two",
      url: "https://a.test/2",
      type: "feed",
    },
    {
      id: "src_b1",
      orgId: "org_b",
      slug: "other-one",
      name: "Other One",
      url: "https://b.test/1",
      type: "feed",
    },
  ]);
  const now = new Date().toISOString();
  await db.insert(releases).values([
    {
      id: "rel_1",
      sourceId: "src_a1",
      title: "A1 r1",
      content: "A1 body 1",
      url: "https://a.test/1/r1",
      publishedAt: now,
      fetchedAt: now,
      contentHash: "h1",
    },
    {
      id: "rel_2",
      sourceId: "src_a1",
      title: "A1 r2",
      content: "A1 body 2",
      url: "https://a.test/1/r2",
      publishedAt: now,
      fetchedAt: now,
      contentHash: "h2",
    },
    {
      id: "rel_3",
      sourceId: "src_a2",
      title: "A2 r1",
      content: "A2 body 1",
      url: "https://a.test/2/r1",
      publishedAt: now,
      fetchedAt: now,
      contentHash: "h3",
    },
    {
      id: "rel_4",
      sourceId: "src_b1",
      title: "B1 r1",
      content: "B1 body 1",
      url: "https://b.test/1/r1",
      publishedAt: now,
      fetchedAt: now,
      contentHash: "h4",
    },
  ]);
}

beforeEach(() => {
  anthropicCalls.length = 0;
  nextResponseText = "generated text";
});

describe("POST /v1/workflows/summarize", () => {
  it("generates a summary for a source by slug", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    nextResponseText = "# Acme One\n- thing happened";

    const res = await fetch(
      new Request("https://x.test/v1/workflows/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "acme-one" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: string;
      releaseCount: number;
      scope: { kind: string; slug: string };
    };
    expect(body.summary).toBe("# Acme One\n- thing happened");
    expect(body.releaseCount).toBe(2);
    expect(body.scope).toMatchObject({ kind: "source", slug: "acme-one" });
    expect(anthropicCalls).toHaveLength(1);
  });

  it("accepts a source ID", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "src_a1" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scope: { id: string } };
    expect(body.scope.id).toBe("src_a1");
  });

  it("aggregates across an org when `org` is provided", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org: "acme" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releaseCount: number;
      scope: { kind: string; slug: string };
    };
    expect(body.releaseCount).toBe(3);
    expect(body.scope).toMatchObject({ kind: "org", slug: "acme" });
  });

  it("returns 400 when neither source nor org is provided", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when both source and org are provided", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "acme-one", org: "acme" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for out-of-range days", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "acme-one", days: 9999 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown source", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "ghost" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown org", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org: "ghost-org" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 503 when ANTHROPIC_API_KEY is missing", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db, { apiKey: null });

    const res = await fetch(
      new Request("https://x.test/v1/workflows/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "acme-one" }),
      }),
    );
    expect(res.status).toBe(503);
  });

  it("returns releaseCount=0 without calling AI when no releases in window", async () => {
    const db = mkDb();
    await db.insert(organizations).values({ id: "org_x", slug: "x", name: "X", category: "cloud" });
    await db.insert(sources).values({
      id: "src_x",
      orgId: "org_x",
      slug: "x-src",
      name: "X",
      url: "https://x.test",
      type: "feed",
    });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "x-src" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: unknown; releaseCount: number };
    expect(body.releaseCount).toBe(0);
    expect(body.summary).toBeNull();
    expect(anthropicCalls).toHaveLength(0);
  });

  it("records a usage_log row on success", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    await fetch(
      new Request("https://x.test/v1/workflows/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "acme-one" }),
      }),
    );

    const rows = await db.select().from(usageLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe("summarize");
    expect(rows[0].sourceId).toBe("src_a1");
    expect(rows[0].releaseCount).toBe(2);
  });

  it("records sourceId as null for org-scoped summarize (no single source)", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    await fetch(
      new Request("https://x.test/v1/workflows/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org: "acme" }),
      }),
    );

    const rows = await db.select().from(usageLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBeNull();
  });
});

describe("POST /v1/workflows/compare", () => {
  it("generates a comparison between two sources", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    nextResponseText = "## Compare\n- diff";

    const res = await fetch(
      new Request("https://x.test/v1/workflows/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceA: "acme-one", sourceB: "other-one" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comparison: string;
      releaseCountA: number;
      releaseCountB: number;
      sources: { a: { slug: string }; b: { slug: string } };
    };
    expect(body.comparison).toBe("## Compare\n- diff");
    expect(body.releaseCountA).toBe(2);
    expect(body.releaseCountB).toBe(1);
    expect(body.sources.a.slug).toBe("acme-one");
    expect(body.sources.b.slug).toBe("other-one");
  });

  it("returns 400 when either source is missing", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceA: "acme-one" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when sourceB is unknown", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceA: "acme-one", sourceB: "ghost" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("skips AI when neither source has releases in window", async () => {
    const db = mkDb();
    await db.insert(organizations).values({ id: "org_x", slug: "x", name: "X", category: "cloud" });
    await db.insert(sources).values([
      {
        id: "src_x1",
        orgId: "org_x",
        slug: "x-one",
        name: "X1",
        url: "https://x.test/1",
        type: "feed",
      },
      {
        id: "src_x2",
        orgId: "org_x",
        slug: "x-two",
        name: "X2",
        url: "https://x.test/2",
        type: "feed",
      },
    ]);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceA: "x-one", sourceB: "x-two" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comparison: unknown;
      releaseCountA: number;
      releaseCountB: number;
    };
    expect(body.comparison).toBeNull();
    expect(body.releaseCountA).toBe(0);
    expect(body.releaseCountB).toBe(0);
    expect(anthropicCalls).toHaveLength(0);
  });

  it("records a usage_log row on success", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    await fetch(
      new Request("https://x.test/v1/workflows/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceA: "acme-one", sourceB: "other-one" }),
      }),
    );

    const rows = await db.select().from(usageLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe("compare");
    expect(rows[0].releaseCount).toBe(3);
  });

  it("returns 503 when ANTHROPIC_API_KEY is missing", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db, { apiKey: null });

    const res = await fetch(
      new Request("https://x.test/v1/workflows/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceA: "acme-one", sourceB: "other-one" }),
      }),
    );
    expect(res.status).toBe(503);
  });
});
