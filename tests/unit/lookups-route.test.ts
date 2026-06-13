import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { lookupRoutes } from "../../workers/api/src/routes/lookups.js";
import {
  domainAliases,
  organizations,
  products,
  sources,
  releases,
} from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { restoreGlobalFetch } from "../global-fetch";

let testDb: TestDatabase;

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
  restoreGlobalFetch();
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
    // User types mixed-case "ACME/FOO" but GitHub returns canonical
    // owner.login + repo.name. We assert the lookup uses the canonical
    // case for display names, lowercases the org slug, and slugs the
    // source by repo segment only (no `acme-foo` prefix).
    mockFetch((url) => {
      if (url.toLowerCase().endsWith("/repos/acme/foo")) {
        return new Response(
          JSON.stringify({
            archived: false,
            default_branch: "main",
            name: "Foo",
            owner: { login: "Acme" },
          }),
          { status: 200 },
        );
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
              html_url: "https://github.com/Acme/Foo/releases/tag/v1.0.0",
              published_at: "2026-04-01T00:00:00Z",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });

    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "ACME/FOO" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      source: { discovery: string; name: string; slug: string };
      releases: Array<{ version: string }>;
    };
    expect(body.status).toBe("indexed");
    expect(body.source.discovery).toBe("on_demand");
    // Canonical repo name from the probe, not the user-typed "FOO".
    expect(body.source.name).toBe("Foo");
    // Slug is the repo segment only — `/acme/foo`, not `/acme/acme-foo`.
    expect(body.source.slug).toBe("foo");
    expect(body.releases.length).toBeGreaterThan(0);

    // Org slug is lowercased; org name uses the canonical owner.login
    // even though the user typed "ACME".
    const orgs = await testDb.db.select().from(organizations).where(eq(organizations.slug, "acme"));
    expect(orgs).toHaveLength(1);
    expect(orgs[0]?.discovery).toBe("on_demand");
    expect(orgs[0]?.name).toBe("Acme");
    // On-demand orgs must be hidden so they don't leak into the sitemap or
    // public listings (#1603).
    expect(orgs[0]?.isHidden).toBe(true);
  });

  test("bare repo slug wins under per-org uniqueness even if another org has the same slug", async () => {
    // Pre-seed an unrelated source that already owns the bare slug `cli`
    // under a different org. After #690 Phase C, slug uniqueness is per-org,
    // so a new `foo/cli` lookup should materialize with bare slug `cli` under
    // a fresh `foo` org rather than falling back to `foo-cli`.
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_acme_cli",
      name: "cli",
      slug: "cli",
      type: "github",
      url: "https://github.com/acme/cli",
      orgId: "org_acme",
      discovery: "curated",
    });

    mockFetch((url) => {
      if (url.toLowerCase().endsWith("/repos/foo/cli")) {
        return new Response(
          JSON.stringify({
            archived: false,
            default_branch: "main",
            name: "cli",
            owner: { login: "foo" },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/releases?per_page=1")) return new Response("[]", { status: 200 });
      if (url.includes("/contents/CHANGELOG.md")) return new Response("", { status: 404 });
      return new Response("", { status: 404 });
    });

    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "foo/cli" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; source: { slug: string } };
    expect(body.status).toBe("empty");
    expect(body.source.slug).toBe("cli");
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

// #698: clients holding a bare slug (legacy bookmarks, OSS CLI's `findSource`)
// resolve via these endpoints once the bare API path stops accepting slugs.
describe("GET /v1/lookups/source-by-slug", () => {
  async function getByslug(slug: string | undefined): Promise<Response> {
    const env = makeEnv(makeKv());
    const path =
      slug === undefined
        ? "/lookups/source-by-slug"
        : `/lookups/source-by-slug?slug=${encodeURIComponent(slug)}`;
    return lookupRoutes.request(path, { method: "GET" }, env);
  }

  test("400 when slug param is missing", async () => {
    const res = await getByslug(undefined);
    expect(res.status).toBe(400);
  });

  test("400 when slug is an empty string", async () => {
    const res = await getByslug("   ");
    expect(res.status).toBe(400);
  });

  test("404 when no source matches", async () => {
    const res = await getByslug("nope");
    expect(res.status).toBe(404);
  });

  test("200 with the org-scoped triple when a source matches", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_one",
      name: "Acme CLI",
      slug: "cli",
      type: "github",
      url: "https://github.com/acme/cli",
      orgId: "org_acme",
      discovery: "curated",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await getByslug("cli");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sourceId: string;
      sourceSlug: string;
      orgSlug: string;
    };
    expect(body).toEqual({
      sourceId: "src_one",
      sourceSlug: "cli",
      orgSlug: "acme",
    });
    // Sunset header signals to clients that this is a migration aid.
    expect(res.headers.get("Sunset")).toBe("Sun, 01 Nov 2026 00:00:00 GMT");
  });

  test("returns the oldest match deterministically when the slug appears under multiple orgs", async () => {
    await testDb.db.insert(organizations).values([
      { id: "org_acme", name: "Acme", slug: "acme", discovery: "curated" },
      { id: "org_beta", name: "Beta", slug: "beta", discovery: "curated" },
    ]);
    await testDb.db.insert(sources).values([
      {
        id: "src_newer",
        name: "Newer CLI",
        slug: "cli",
        type: "github",
        url: "https://github.com/beta/cli",
        orgId: "org_beta",
        discovery: "curated",
        createdAt: "2026-03-01T00:00:00.000Z",
      },
      {
        id: "src_older",
        name: "Older CLI",
        slug: "cli",
        type: "github",
        url: "https://github.com/acme/cli",
        orgId: "org_acme",
        discovery: "curated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const res = await getByslug("cli");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sourceId: string; orgSlug: string };
    // The bookmark resolver picks the oldest row by createdAt — the contract
    // is "deterministic, not necessarily right." Repeated calls land here.
    expect(body.sourceId).toBe("src_older");
    expect(body.orgSlug).toBe("acme");
  });

  test("excludes tombstoned (soft-deleted) sources via sourcesActive", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_dead",
      name: "Dead CLI",
      slug: "cli",
      type: "github",
      url: "https://github.com/acme/cli",
      orgId: "org_acme",
      discovery: "curated",
      deletedAt: "2026-04-01T00:00:00.000Z",
    });

    const res = await getByslug("cli");
    expect(res.status).toBe(404);
  });
});

// Read-only "is this repo indexed?" check that backs the local-dev
// /gh/owner/repo viewer's "we also index this" banner. Unlike POST /v1/lookups
// it must never materialize a stub, and must ignore hidden on-demand rows.
describe("GET /v1/lookups/source-by-coordinate", () => {
  async function getByCoord(coordinate: string | undefined): Promise<Response> {
    const env = makeEnv(makeKv());
    const path =
      coordinate === undefined
        ? "/lookups/source-by-coordinate"
        : `/lookups/source-by-coordinate?coordinate=${encodeURIComponent(coordinate)}`;
    return lookupRoutes.request(path, { method: "GET" }, env);
  }

  test("400 when coordinate param is missing", async () => {
    const res = await getByCoord(undefined);
    expect(res.status).toBe(400);
  });

  test("400 when coordinate is unparseable", async () => {
    const res = await getByCoord("not-a-coordinate");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("404 when no source matches", async () => {
    const res = await getByCoord("acme/nope");
    expect(res.status).toBe(404);
  });

  test("200 with the org-scoped triple for a visible match, case-insensitively", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_shopify",
      name: "Shopify",
      slug: "shopify",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_canonical",
      name: "Shopify/toxiproxy",
      slug: "toxiproxy",
      type: "github",
      url: "https://github.com/Shopify/toxiproxy",
      orgId: "org_shopify",
      discovery: "curated",
    });

    // User types lowercased; should still resolve to the canonical row.
    const res = await getByCoord("shopify/TOXIPROXY");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sourceId: string;
      sourceSlug: string;
      orgSlug: string;
    };
    expect(body).toEqual({
      sourceId: "src_canonical",
      sourceSlug: "toxiproxy",
      orgSlug: "shopify",
    });
  });

  test("accepts the github: prefix", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_one",
      name: "Acme CLI",
      slug: "cli",
      type: "github",
      url: "https://github.com/acme/cli",
      orgId: "org_acme",
      discovery: "curated",
    });

    const res = await getByCoord("github:acme/cli");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sourceId: string };
    expect(body.sourceId).toBe("src_one");
  });

  test("ignores a hidden on-demand stub (no false 'indexed' answer)", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "acme",
      slug: "acme",
      discovery: "on_demand",
    });
    await testDb.db.insert(sources).values({
      id: "src_stub",
      name: "acme/foo",
      slug: "foo",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "on_demand",
      isHidden: true,
    });

    const res = await getByCoord("acme/foo");
    expect(res.status).toBe(404);
  });

  test("prefers the exact-case row over a case-folded match", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_lowercase",
      name: "acme/Foo",
      slug: "foo-lower",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "curated",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await testDb.db.insert(sources).values({
      id: "src_canonical",
      name: "Acme/Foo",
      slug: "foo-canonical",
      type: "github",
      url: "https://github.com/Acme/Foo",
      orgId: "org_acme",
      discovery: "curated",
      createdAt: "2026-02-01T00:00:00.000Z",
    });

    const res = await getByCoord("Acme/Foo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sourceId: string };
    expect(body.sourceId).toBe("src_canonical");
  });
});

describe("GET /v1/lookups/product-by-slug", () => {
  async function getByslug(slug: string | undefined): Promise<Response> {
    const env = makeEnv(makeKv());
    const path =
      slug === undefined
        ? "/lookups/product-by-slug"
        : `/lookups/product-by-slug?slug=${encodeURIComponent(slug)}`;
    return lookupRoutes.request(path, { method: "GET" }, env);
  }

  test("400 when slug param is missing", async () => {
    const res = await getByslug(undefined);
    expect(res.status).toBe(400);
  });

  test("404 when no product matches", async () => {
    const res = await getByslug("nope");
    expect(res.status).toBe(404);
  });

  test("200 with the org-scoped triple when a product matches", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(products).values({
      id: "prod_widget",
      name: "Widget",
      slug: "widget",
      orgId: "org_acme",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await getByslug("widget");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      productId: string;
      productSlug: string;
      orgSlug: string;
    };
    expect(body).toEqual({
      productId: "prod_widget",
      productSlug: "widget",
      orgSlug: "acme",
    });
    expect(res.headers.get("Sunset")).toBe("Sun, 01 Nov 2026 00:00:00 GMT");
  });
});

describe("GET /v1/lookups/by-domain", () => {
  async function getByDomain(domain: string | undefined): Promise<Response> {
    const env = makeEnv(makeKv());
    const path =
      domain === undefined
        ? "/lookups/by-domain"
        : `/lookups/by-domain?domain=${encodeURIComponent(domain)}`;
    return lookupRoutes.request(path, { method: "GET" }, env);
  }

  test("400 when domain param is missing", async () => {
    const res = await getByDomain(undefined);
    expect(res.status).toBe(400);
  });

  test("400 when domain doesn't normalize", async () => {
    const res = await getByDomain("not a domain");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("404 when no org or product owns the domain", async () => {
    const res = await getByDomain("nope.example");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("200 with org when domain matches organizations.domain (primary)", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      domain: "acme.com",
      discovery: "curated",
    });

    const res = await getByDomain("acme.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      domain: string;
      org: { id: string; matchedVia: string } | null;
      products: unknown[];
    };
    expect(body.domain).toBe("acme.com");
    expect(body.org?.id).toBe("org_acme");
    expect(body.org?.matchedVia).toBe("primary");
    expect(body.products).toHaveLength(0);
  });

  test("200 with org when domain matches a domain_alias (alias)", async () => {
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

    const res = await getByDomain("old-acme.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      org: { id: string; matchedVia: string } | null;
    };
    expect(body.org?.id).toBe("org_acme");
    expect(body.org?.matchedVia).toBe("alias");
  });

  test("normalizes input — strips https://, www., trailing slash", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      domain: "acme.com",
      discovery: "curated",
    });

    const res = await getByDomain("https://www.acme.com/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domain: string; org: { id: string } | null };
    expect(body.domain).toBe("acme.com");
    expect(body.org?.id).toBe("org_acme");
  });

  test("returns products whose alias targets the domain", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(products).values({
      id: "prod_widget",
      name: "Widget",
      slug: "widget",
      orgId: "org_acme",
    });
    await testDb.db.insert(domainAliases).values({
      id: "da_widget",
      domain: "widget.io",
      productId: "prod_widget",
    });

    const res = await getByDomain("widget.io");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      org: unknown | null;
      products: Array<{ id: string; orgSlug: string }>;
    };
    // Org alias and product alias share the same column — querying by
    // domain.orgId only matches when domainAliases.orgId is set, so a
    // product-only alias surfaces as products without an org.
    expect(body.org).toBeNull();
    expect(body.products).toHaveLength(1);
    expect(body.products[0]?.id).toBe("prod_widget");
    expect(body.products[0]?.orgSlug).toBe("acme");
  });

  test("excludes tombstoned orgs", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_dead",
      name: "Dead",
      slug: "dead",
      domain: "dead.com",
      discovery: "curated",
      deletedAt: "2026-04-01T00:00:00.000Z",
    });
    const res = await getByDomain("dead.com");
    expect(res.status).toBe(404);
  });
});
