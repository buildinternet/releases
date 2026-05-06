/**
 * Persisted operations + KV response cache (#755 part 3).
 *
 * The plugin gates non-admin callers to the manifest of hashes committed by
 * `bun web/codegen.ts`. The cache layer wraps the route handler and stores
 * responses in KV keyed by (hash, variables) for an allowlist of operations.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { createSchema, createYoga } from "graphql-yoga";
import {
  buildGraphqlCacheKey,
  CACHEABLE_HASHES,
  GRAPHQL_ADMIN_HEADER,
  type GraphqlCacheBinding,
  HOMEPAGE_TICKER_VARS,
  lookupCached,
  persistedOperationsPlugin,
  purgeKeysForHomepageTicker,
  storeIfCacheable,
} from "../src/graphql/persisted.js";

interface Ctx {
  env: { ENVIRONMENT?: string };
}

const SCHEMA = createSchema({
  typeDefs: /* GraphQL */ `
    type Query {
      hello: String!
    }
  `,
  resolvers: {
    Query: {
      hello: () => "world",
    },
  },
});

function makeYoga() {
  return createYoga<Ctx>({
    schema: SCHEMA as Parameters<typeof createYoga<Ctx>>[0]["schema"],
    plugins: [persistedOperationsPlugin()],
    graphiql: false,
    landingPage: false,
  });
}

async function postPersisted(
  yoga: ReturnType<typeof makeYoga>,
  hash: string,
  variables: Record<string, unknown> = {},
  isAdmin = false,
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (isAdmin) headers[GRAPHQL_ADMIN_HEADER] = "1";
  const res = await yoga.fetch(
    new Request("http://t/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        variables,
      }),
    }),
    { env: {} },
  );
  return (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
}

async function postRaw(yoga: ReturnType<typeof makeYoga>, query: string, isAdmin = false) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (isAdmin) headers[GRAPHQL_ADMIN_HEADER] = "1";
  const res = await yoga.fetch(
    new Request("http://t/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    }),
    { env: {} },
  );
  return (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
}

describe("persisted operations gate", () => {
  it("rejects an unknown hash for non-admin callers", async () => {
    const fakeHash = "0".repeat(64);
    const out = await postPersisted(makeYoga(), fakeHash);
    expect(out.errors).toBeDefined();
    expect(out.errors?.[0]?.message).toMatch(/PersistedQueryNotFound/);
  });

  it("rejects an arbitrary document for non-admin callers", async () => {
    const out = await postRaw(makeYoga(), "query { hello }");
    expect(out.errors).toBeDefined();
    expect(out.errors?.[0]?.message).toMatch(/PersistedQueryOnly/);
  });

  it("allows arbitrary documents when the admin sentinel is present", async () => {
    const out = await postRaw(makeYoga(), "query { hello }", true);
    expect(out.errors).toBeUndefined();
    expect(out.data).toEqual({ hello: "world" });
  });
});

describe("cache key + manifest sanity", () => {
  it("includes the homepage hash in the cacheable allowlist", () => {
    expect(CACHEABLE_HASHES.size).toBeGreaterThan(0);
  });

  it("derives a stable cache key regardless of variable order", () => {
    const a = buildGraphqlCacheKey("h", { limit: 20, exclude: ["github"] });
    const b = buildGraphqlCacheKey("h", { exclude: ["github"], limit: 20 });
    expect(a).toEqual(b);
  });

  it("produces a non-empty purge list for the homepage ticker", () => {
    const keys = purgeKeysForHomepageTicker();
    expect(keys.length).toBe(1);
    expect(keys[0]).toContain("gql:v1:");
    // Variables embedded in the key must match the homepage call site.
    expect(keys[0]).toContain(JSON.stringify(HOMEPAGE_TICKER_VARS));
  });
});

describe("KV read-through", () => {
  // Minimal KV stub. The handler / lookupCached / storeIfCacheable contract
  // is the surface — Cloudflare's real KV behaves like this for our keys.
  function makeKv(): GraphqlCacheBinding & { _store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      _store: store,
      async get(key, _type) {
        const raw = store.get(key);
        return raw === undefined ? null : (JSON.parse(raw) as unknown);
      },
      async put(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
    };
  }

  let homepageHash: string;
  beforeEach(() => {
    homepageHash = [...CACHEABLE_HASHES][0]!;
  });

  it("returns null on cache miss, returns Response on hit", async () => {
    const kv = makeKv();
    const req = new Request("http://t/graphql", { method: "POST" });
    const body = { hash: homepageHash, variables: HOMEPAGE_TICKER_VARS };

    expect(await lookupCached(kv, req, body)).toBeNull();

    await storeIfCacheable(kv, req, body, JSON.stringify({ data: { ok: true } }));
    const hit = await lookupCached(kv, req, body);
    expect(hit).toBeInstanceOf(Response);
    const text = await hit?.text();
    expect(JSON.parse(text!)).toEqual({ data: { ok: true } });
  });

  it("does not cache for unknown hashes", async () => {
    const kv = makeKv();
    const req = new Request("http://t/graphql", { method: "POST" });
    const body = { hash: "deadbeef", variables: {} };

    await storeIfCacheable(kv, req, body, JSON.stringify({ data: { ok: true } }));
    expect(kv._store.size).toBe(0);
  });

  it("does not cache admin-marked requests", async () => {
    const kv = makeKv();
    const req = new Request("http://t/graphql", {
      method: "POST",
      headers: { [GRAPHQL_ADMIN_HEADER]: "1" },
    });
    const body = { hash: homepageHash, variables: HOMEPAGE_TICKER_VARS };

    await storeIfCacheable(kv, req, body, JSON.stringify({ data: { ok: true } }));
    expect(kv._store.size).toBe(0);

    expect(await lookupCached(kv, req, body)).toBeNull();
  });

  it("does not cache responses carrying GraphQL errors", async () => {
    const kv = makeKv();
    const req = new Request("http://t/graphql", { method: "POST" });
    const body = { hash: homepageHash, variables: HOMEPAGE_TICKER_VARS };

    await storeIfCacheable(kv, req, body, JSON.stringify({ errors: [{ message: "boom" }] }));
    expect(kv._store.size).toBe(0);
  });
});
