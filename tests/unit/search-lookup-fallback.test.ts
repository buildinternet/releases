import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { searchRoutes } from "../../workers/api/src/routes/search.js";
import {
  domainAliases,
  organizations,
  releases,
  sources,
} from "@buildinternet/releases-core/schema";

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
    // Vectorize is absent so hybrid mode degrades to lexical — that's fine for
    // these tests which focus on the lookup fallback, not on vector ranking.
  };
}

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
  globalThis.fetch = realFetch;
});

/** Minimal stub that satisfies Hono's ExecutionContext requirement. */
function makeExecutionCtx() {
  return {
    waitUntil: (_promise: Promise<unknown>) => {
      /* no-op in tests */
    },
    passThroughOnException: () => {
      /* no-op in tests */
    },
  } as never;
}

async function callSearch(
  env: ReturnType<typeof makeEnv>,
  query: string,
  mode = "lexical",
): Promise<Response> {
  return searchRoutes.request(
    `/search?q=${encodeURIComponent(query)}&mode=${mode}`,
    { method: "GET" },
    env,
    makeExecutionCtx(),
  );
}

describe("GET /search — coordinate lookup fallback", () => {
  test("parseable org/repo coordinate with zero results triggers lookup (indexed)", async () => {
    // Mock GitHub probe: repo exists with releases.
    // Order matters — more specific patterns must come before broader ones.
    mockFetch((url) => {
      // Full ingest: GET /repos/acme/newlib/releases?per_page=100
      if (url.includes("/releases?per_page=100")) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              tag_name: "v1.0.0",
              name: "Initial release",
              body: "First release of newlib.",
              html_url: "https://github.com/acme/newlib/releases/tag/v1.0.0",
              published_at: "2026-04-01T00:00:00Z",
            },
          ]),
          { status: 200 },
        );
      }
      // Probe: GET /repos/acme/newlib/releases?per_page=1
      if (url.includes("/releases?per_page=1")) {
        return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
      }
      // Probe: GET /repos/acme/newlib/contents/CHANGELOG.md
      if (url.includes("/contents/CHANGELOG.md")) {
        return new Response("", { status: 404 });
      }
      // Probe: GET /repos/acme/newlib (base repo endpoint)
      if (url.includes("/repos/acme/newlib")) {
        return new Response(JSON.stringify({ archived: false, default_branch: "main" }), {
          status: 200,
        });
      }
      return new Response("", { status: 404 });
    });

    const res = await callSearch(makeEnv(makeKv()), "acme/newlib");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      query: string;
      orgs: unknown[];
      releases: unknown[];
      lookup: { status: string; source: { id: string } } | null;
    };

    // No existing entities matched
    expect(body.orgs).toHaveLength(0);
    expect(body.releases).toHaveLength(0);
    // Lookup was triggered and returned indexed
    expect(body.lookup).not.toBeNull();
    expect(body.lookup?.status).toBe("indexed");
    expect(body.lookup?.source).toBeDefined();
  });

  test("non-parseable query does not trigger lookup (lookup field is null)", async () => {
    // No fetch mock needed — parseCoordinate will return null and skip the lookup entirely
    const res = await callSearch(makeEnv(makeKv()), "just a plain search query");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      lookup?: { status: string } | null;
    };

    // lookup should be absent or null — NOT a lookup result
    expect(body.lookup == null).toBe(true);
  });

  test("parseable coordinate that matches an existing org does NOT trigger lookup", async () => {
    // Seed an org and a matching GitHub source
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_existing",
      name: "Acme / existingrepo",
      slug: "acme-existingrepo",
      type: "github",
      url: "https://github.com/acme/existingrepo",
      orgId: "org_acme",
      discovery: "curated",
    });

    // No GitHub mock — the lookup path should never be called because the
    // entity search returns catalog/orgs hits.
    const res = await callSearch(makeEnv(makeKv()), "acme/existingrepo");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      orgs: unknown[];
      catalog: unknown[];
      lookup?: unknown;
    };

    // The existing source is surfaced via the catalog
    expect(body.catalog.length).toBeGreaterThan(0);
    // lookup must be absent or null — not triggered when entities match
    expect(body.lookup == null).toBe(true);
  });

  test("coordinate with 404 from GitHub returns not_found in lookup", async () => {
    mockFetch(() => new Response("", { status: 404 }));

    const res = await callSearch(makeEnv(makeKv()), "acme/ghost");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      lookup: { status: string } | null;
    };

    expect(body.lookup).not.toBeNull();
    expect(body.lookup?.status).toBe("not_found");
  });
});

describe("GET /search — domain filter", () => {
  async function callSearchWithDomain(
    env: ReturnType<typeof makeEnv>,
    query: string,
    domain: string,
  ): Promise<Response> {
    return searchRoutes.request(
      `/search?q=${encodeURIComponent(query)}&domain=${encodeURIComponent(domain)}&mode=lexical`,
      { method: "GET" },
      env,
      makeExecutionCtx(),
    );
  }

  test("400 when domain doesn't normalize", async () => {
    const res = await callSearchWithDomain(makeEnv(makeKv()), "anything", "not a domain");
    expect(res.status).toBe(400);
  });

  test("returns empty result envelope with domainStatus=not_found when domain isn't owned", async () => {
    const res = await callSearchWithDomain(makeEnv(makeKv()), "anything", "nope.example");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      domainStatus: string;
      domain: string;
      orgs: unknown[];
      releases: unknown[];
      lookup: unknown;
    };
    expect(body.domainStatus).toBe("not_found");
    expect(body.domain).toBe("nope.example");
    expect(body.orgs).toHaveLength(0);
    expect(body.releases).toHaveLength(0);
    // Domain miss does not trigger the GitHub on-demand lookup.
    expect(body.lookup).toBeNull();
  });

  test("scopes orgs and releases to the org owning the primary domain", async () => {
    await testDb.db.insert(organizations).values([
      {
        id: "org_acme",
        name: "Acme",
        slug: "acme",
        domain: "acme.com",
        discovery: "curated",
      },
      // A second org that would otherwise match the FTS query — proves the
      // domain filter does scope, not just expand.
      { id: "org_other", name: "Other", slug: "other", discovery: "curated" },
    ]);
    await testDb.db.insert(sources).values([
      {
        id: "src_acme",
        name: "Acme Foo",
        slug: "foo",
        type: "github",
        url: "https://github.com/acme/foo",
        orgId: "org_acme",
        discovery: "curated",
      },
      {
        id: "src_other",
        name: "Other Foo",
        slug: "foo-other",
        type: "github",
        url: "https://github.com/other/foo",
        orgId: "org_other",
        discovery: "curated",
      },
    ]);
    await testDb.db.insert(releases).values([
      {
        id: "rel_acme_1",
        sourceId: "src_acme",
        title: "Acme login flow",
        content: "shipped login auth",
        publishedAt: "2026-04-01T00:00:00Z",
      },
      {
        id: "rel_other_1",
        sourceId: "src_other",
        title: "Other login flow",
        content: "shipped login auth",
        publishedAt: "2026-04-02T00:00:00Z",
      },
    ]);

    const res = await callSearchWithDomain(makeEnv(makeKv()), "login", "acme.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      domain: string;
      domainStatus: string;
      orgs: Array<{ slug: string }>;
      releases: Array<{ id: string; orgSlug: string | null }>;
    };
    expect(body.domain).toBe("acme.com");
    expect(body.domainStatus).toBe("matched");
    // Only the acme org should appear; the FTS query alone would also match
    // "Other Foo" without the scope.
    expect(body.orgs.map((o) => o.slug)).toEqual(["acme"]);
    expect(body.releases.map((r) => r.id)).toEqual(["rel_acme_1"]);
  });

  test("matches via domain_aliases (alias domain)", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      domain: "acme.com",
      discovery: "curated",
    });
    await testDb.db.insert(domainAliases).values({
      id: "da_old",
      domain: "old-acme.com",
      orgId: "org_acme",
    });
    await testDb.db.insert(sources).values({
      id: "src_acme",
      name: "Acme Foo",
      slug: "foo",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "curated",
    });

    const res = await callSearchWithDomain(makeEnv(makeKv()), "Foo", "old-acme.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      domainStatus: string;
      orgs: Array<{ slug: string }>;
    };
    expect(body.domainStatus).toBe("matched");
    expect(body.orgs.map((o) => o.slug)).toEqual(["acme"]);
  });
});
