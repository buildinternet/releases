import { describe, it, expect, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../test/setup.js";
import { restoreGlobalFetch } from "../../../../../tests/global-fetch";
import {
  consumeDomainManifestProbeBudget,
  DOMAIN_MANIFEST_PROBE_MAX,
  DOMAIN_MANIFEST_PROBE_WINDOW_SECONDS,
  tryDomainManifestJit,
} from "./domain-jit.js";

afterEach(() => {
  restoreGlobalFetch();
});

const MANIFEST = JSON.stringify({
  version: 2,
  name: "Beta Corp",
  products: [{ name: "Beta", releases: [{ feed: "https://beta.com/beta.xml" }] }],
  releases: [{ url: "https://beta.com/changelog" }],
});

const okLimiter = { limit: async () => ({ success: true }) };
const noLimiter = { limit: async () => ({ success: false }) };

function makeKv() {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  return {
    store,
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, { value, expirationTtl: opts?.expirationTtl });
    },
  };
}

describe("consumeDomainManifestProbeBudget", () => {
  it("allows when KV is unbound", async () => {
    expect(await consumeDomainManifestProbeBudget(undefined, "acme.com")).toBe("allow");
  });

  it(`allows ${DOMAIN_MANIFEST_PROBE_MAX} probes then exhausts`, async () => {
    const kv = makeKv();
    for (let i = 0; i < DOMAIN_MANIFEST_PROBE_MAX; i++) {
      expect(await consumeDomainManifestProbeBudget(kv as never, "acme.com")).toBe("allow");
    }
    expect(await consumeDomainManifestProbeBudget(kv as never, "acme.com")).toBe("exhausted");
    const entry = kv.store.get("lookup:domain-manifest:acme.com");
    expect(entry?.expirationTtl).toBe(DOMAIN_MANIFEST_PROBE_WINDOW_SECONDS);
    expect(JSON.parse(entry!.value).count).toBe(DOMAIN_MANIFEST_PROBE_MAX);
  });

  it("case-folds the domain key", async () => {
    const kv = makeKv();
    await consumeDomainManifestProbeBudget(kv as never, "Acme.COM");
    expect(kv.store.has("lookup:domain-manifest:acme.com")).toBe(true);
  });
});

describe("tryDomainManifestJit", () => {
  it("materializes a stub from a valid manifest", async () => {
    const db = createTestDb();
    const r = await tryDomainManifestJit(
      {
        LISTING_SELF_SERVE_ENABLED: "true",
        LISTING_RATE_LIMITER: okLimiter,
        LATEST_CACHE: makeKv() as never,
        fetchImpl: async () =>
          new Response(MANIFEST, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
      db as never,
      "beta.com",
      { ip: "1.2.3.4" },
    );
    expect(r).toBe("materialized");
    const [org] = await db.select().from(organizations).where(eq(organizations.domain, "beta.com"));
    expect(org?.tier).toBe("stub");
    expect(org?.name).toBe("Beta Corp");
  });

  it("returns miss when the listing gate is off (no fetch)", async () => {
    const db = createTestDb();
    let fetched = 0;
    const r = await tryDomainManifestJit(
      {
        LISTING_SELF_SERVE_ENABLED: "false",
        fetchImpl: async () => {
          fetched++;
          return new Response(MANIFEST, { status: 200 });
        },
      },
      db as never,
      "beta.com",
    );
    expect(r).toBe("miss");
    expect(fetched).toBe(0);
  });

  it("returns rate_limited when the per-IP limiter says no", async () => {
    const db = createTestDb();
    let fetched = 0;
    const r = await tryDomainManifestJit(
      {
        LISTING_SELF_SERVE_ENABLED: "true",
        LISTING_RATE_LIMITER: noLimiter,
        fetchImpl: async () => {
          fetched++;
          return new Response(MANIFEST, { status: 200 });
        },
      },
      db as never,
      "beta.com",
      { ip: "9.9.9.9" },
    );
    expect(r).toBe("rate_limited");
    expect(fetched).toBe(0);
  });

  it("returns miss after the per-domain probe budget is exhausted", async () => {
    const db = createTestDb();
    const kv = makeKv();
    const env = {
      LISTING_SELF_SERVE_ENABLED: "true",
      LISTING_RATE_LIMITER: okLimiter,
      LATEST_CACHE: kv as never,
      fetchImpl: async () => new Response("nope", { status: 404 }),
    };
    for (let i = 0; i < DOMAIN_MANIFEST_PROBE_MAX; i++) {
      expect(await tryDomainManifestJit(env, db as never, "missing.com")).toBe("miss");
    }
    let fetched = 0;
    const blocked = await tryDomainManifestJit(
      {
        ...env,
        fetchImpl: async () => {
          fetched++;
          return new Response("nope", { status: 404 });
        },
      },
      db as never,
      "missing.com",
    );
    expect(blocked).toBe("miss");
    expect(fetched).toBe(0);
  });

  it("treats org_exists as materialized so the caller re-resolves", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_x", name: "X", slug: "x", domain: "taken.com" });
    const r = await tryDomainManifestJit(
      {
        LISTING_SELF_SERVE_ENABLED: "true",
        LISTING_RATE_LIMITER: okLimiter,
        LATEST_CACHE: makeKv() as never,
        fetchImpl: async () => new Response(MANIFEST, { status: 200 }),
      },
      db as never,
      "taken.com",
    );
    expect(r).toBe("materialized");
  });
});
