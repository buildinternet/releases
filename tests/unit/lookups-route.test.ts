import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { lookupRoutes } from "../../workers/api/src/routes/lookups.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";

let testDb: TestDatabase;
const realFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => Response) {
  globalThis.fetch = mock((url: string | URL) =>
    Promise.resolve(handler(url.toString())),
  ) as unknown as typeof fetch;
}

interface FakeKv {
  store: Map<string, string>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
function makeKv(): FakeKv {
  const store = new Map<string, string>();
  return {
    store,
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v) {
      store.set(k, v);
    },
  };
}

function makeEnv(kv: FakeKv) {
  return {
    DB: testDb.db as unknown as never,
    LATEST_CACHE: kv as unknown as KVNamespace,
    GITHUB_TOKEN: { get: async () => "test-token" },
    MEDIA_ORIGIN: "",
  };
}

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
  globalThis.fetch = realFetch;
});

async function callRoute(env: ReturnType<typeof makeEnv>, body: unknown): Promise<Response> {
  return lookupRoutes.request(
    "/lookups",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /v1/lookups", () => {
  test("400 on bad coordinate", async () => {
    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "not-a-coord" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("E_LOOKUP_BAD_COORDINATE");
  });

  test("400 on unsupported provider", async () => {
    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "npm", coordinate: "acme/foo" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("E_LOOKUP_UNSUPPORTED_PROVIDER");
  });

  test("returns existing source when one already matches", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_existing",
      name: "Acme Foo",
      slug: "acme-foo",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "curated",
    });

    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "acme/foo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; source: { id: string } };
    expect(body.status).toBe("existing");
    expect(body.source.id).toBe("src_existing");
  });

  test("prefers an exact-case row over a case-folded match when both exist", async () => {
    // sources.url is not UNIQUE, so two rows with case-variant URLs can
    // coexist (curated row + a stray on-demand row from before the
    // case-fold dedup landed). The user's typed case should win to keep
    // results stable across calls.
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    // Older lowercase row inserted first.
    await testDb.db.insert(sources).values({
      id: "src_lowercase",
      name: "acme/Foo",
      slug: "acme-foo-lower",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "on_demand",
    });
    // Canonical-case row inserted later.
    await testDb.db.insert(sources).values({
      id: "src_canonical",
      name: "Acme/Foo",
      slug: "acme-foo-canonical",
      type: "github",
      url: "https://github.com/Acme/Foo",
      orgId: "org_acme",
      discovery: "curated",
    });

    const env = makeEnv(makeKv());
    // User types the canonical case → canonical row wins on exact-case
    // preference even though the lowercase row was created first.
    const res = await callRoute(env, { provider: "github", coordinate: "Acme/Foo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; source: { id: string } };
    expect(body.status).toBe("existing");
    expect(body.source.id).toBe("src_canonical");
  });

  test("matches an existing source case-insensitively", async () => {
    // Existing row stored with canonical case (Shopify/toxiproxy). User
    // types it lowercased — should still resolve to the same source row,
    // not insert a duplicate.
    await testDb.db.insert(organizations).values({
      id: "org_shopify",
      name: "Shopify",
      slug: "shopify",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_canonical",
      name: "Shopify/toxiproxy",
      slug: "shopify-toxiproxy",
      type: "github",
      url: "https://github.com/Shopify/toxiproxy",
      orgId: "org_shopify",
      discovery: "curated",
    });

    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "shopify/TOXIPROXY" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; source: { id: string } };
    expect(body.status).toBe("existing");
    expect(body.source.id).toBe("src_canonical");
  });

  test("returns not_found and writes neg-cache on 404 from GitHub", async () => {
    mockFetch(() => new Response("", { status: 404 }));
    const kv = makeKv();
    const env = makeEnv(kv);

    const res = await callRoute(env, { provider: "github", coordinate: "acme/missing" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("not_found");
    expect(kv.store.has("lookup:github:acme/missing")).toBe(true);
  });

  test("returns empty status when repo exists but has no releases or changelog", async () => {
    mockFetch((url) => {
      if (url.endsWith("/repos/acme/quiet")) {
        return new Response(JSON.stringify({ archived: false, default_branch: "main" }), {
          status: 200,
        });
      }
      if (url.endsWith("/releases?per_page=1")) return new Response("[]", { status: 200 });
      return new Response("", { status: 404 });
    });

    const kv = makeKv();
    const env = makeEnv(kv);
    const res = await callRoute(env, { provider: "github", coordinate: "acme/quiet" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; source: { discovery: string } };
    expect(body.status).toBe("empty");
    expect(body.source.discovery).toBe("on_demand");

    const stored = await testDb.db
      .select()
      .from(sources)
      .where(eq(sources.url, "https://github.com/acme/quiet"));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.discovery).toBe("on_demand");
    // isHidden is a boolean mode column — Drizzle returns true/false
    expect(stored[0]?.isHidden).toBe(true);
    expect(kv.store.has("lookup:github:acme/quiet")).toBe(true);
  });

  test("indexed path: creates org, source, ingests releases", async () => {
    mockFetch((url) => {
      if (url.endsWith("/repos/acme/foo")) {
        return new Response(JSON.stringify({ archived: false, default_branch: "main" }), {
          status: 200,
        });
      }
      if (url.endsWith("/releases?per_page=1")) {
        return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
      }
      if (url.includes("/contents/CHANGELOG.md")) {
        return new Response("", { status: 404 });
      }
      // The full ingest call to /releases (paginated) returns one release.
      if (url.includes("/releases?per_page=100")) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              tag_name: "v1.0.0",
              name: "v1.0.0",
              body: "first release",
              html_url: "https://github.com/acme/foo/releases/tag/v1.0.0",
              published_at: "2026-04-01T00:00:00Z",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });

    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "acme/foo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      source: { discovery: string };
      releases: Array<{ version: string }>;
    };
    expect(body.status).toBe("indexed");
    expect(body.source.discovery).toBe("on_demand");
    expect(body.releases.length).toBeGreaterThan(0);

    const orgs = await testDb.db.select().from(organizations).where(eq(organizations.slug, "acme"));
    expect(orgs).toHaveLength(1);
    expect(orgs[0]?.discovery).toBe("on_demand");
  });

  test("empty stub gets promoted to indexed when repo gains releases", async () => {
    // Pre-seed an empty stub (mimicking a previous lookup that found no
    // releases). emptyResult=true marks it as eligible for re-probe.
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "acme",
      slug: "acme",
      discovery: "on_demand",
    });
    await testDb.db.insert(sources).values({
      id: "src_stub",
      name: "acme/foo",
      slug: "acme-foo",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "on_demand",
      isHidden: true,
      metadata: JSON.stringify({
        lookup: {
          coordinate: "acme/foo",
          fetchedAt: "2026-04-01T00:00:00Z",
          lastRefreshedAt: "2026-04-01T00:00:00Z",
          emptyResult: true,
        },
      }),
    });

    // GitHub now has a release — probe + ingest should promote the stub.
    mockFetch((url) => {
      if (url.endsWith("/repos/acme/foo")) {
        return new Response(JSON.stringify({ archived: false, default_branch: "main" }), {
          status: 200,
        });
      }
      if (url.endsWith("/releases?per_page=1")) {
        return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
      }
      if (url.includes("/contents/CHANGELOG.md")) return new Response("", { status: 404 });
      if (url.includes("/releases?per_page=100")) {
        return new Response(
          JSON.stringify([
            {
              tag_name: "v1.0.0",
              name: "v1.0.0",
              body: "first release",
              html_url: "https://github.com/acme/foo/releases/tag/v1.0.0",
              published_at: "2026-04-29T00:00:00Z",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });

    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "acme/foo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; source: { id: string } };
    expect(body.status).toBe("indexed");
    // Reused the existing source row — no duplicate insert.
    expect(body.source.id).toBe("src_stub");

    const allSources = await testDb.db
      .select()
      .from(sources)
      .where(eq(sources.url, "https://github.com/acme/foo"));
    expect(allSources).toHaveLength(1);
    const refreshed = allSources[0]!;
    const meta = JSON.parse(refreshed.metadata ?? "{}") as {
      lookup?: { emptyResult?: boolean };
    };
    expect(meta.lookup?.emptyResult).toBe(false);

    const ingested = await testDb.db
      .select()
      .from(releases)
      .where(eq(releases.sourceId, "src_stub"));
    expect(ingested.length).toBeGreaterThan(0);
  });

  test("returns deferred on GitHub 5xx without writing neg-cache", async () => {
    mockFetch(() => new Response("", { status: 503 }));
    const kv = makeKv();
    const env = makeEnv(kv);
    const res = await callRoute(env, { provider: "github", coordinate: "acme/server-err" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("deferred");
    expect(kv.store.has("lookup:github:acme/server-err")).toBe(false);
  });

  test("attaches relatedOrg on not_found when org segment is known", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_one",
      name: "Acme Foo",
      slug: "acme-foo",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "curated",
    });
    mockFetch(() => new Response("", { status: 404 }));

    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "acme/missing" });
    const body = (await res.json()) as {
      status: string;
      relatedOrg: { org: { slug: string }; sources: unknown[] } | null;
    };
    expect(body.status).toBe("not_found");
    expect(body.relatedOrg?.org.slug).toBe("acme");
    expect(body.relatedOrg?.sources.length).toBe(1);
  });
});
