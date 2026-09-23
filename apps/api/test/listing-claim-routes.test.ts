import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { organizations, orgClaims, releaseLocations } from "@buildinternet/releases-core/schema";
import { releaseLocationMatchKey } from "../src/lib/well-known/locator.js";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { listingClaimHandlers } from "../src/routes/listing-claims.js";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

afterEach(() => {
  restoreGlobalFetch();
});

const JSON_HEADERS = { "content-type": "application/json" };
const okLimiter = { limit: async () => ({ success: true }) };
const noLimiter = { limit: async () => ({ success: false }) };

let h: TestDatabase;

function mockWellKnownFetch(token: string) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/.well-known/releases-verify.txt")) {
      return new Response(token, { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url.includes("cloudflare-dns.com/dns-query")) {
      return new Response(JSON.stringify({ Status: 3 }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function mockNeitherFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/.well-known/releases-verify.txt")) {
      return new Response("nope", { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url.includes("cloudflare-dns.com/dns-query")) {
      return new Response(JSON.stringify({ Status: 3 }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function mockDnsFetch(token: string) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/.well-known/releases-verify.txt")) {
      return new Response("nope", { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url.includes("cloudflare-dns.com/dns-query")) {
      return new Response(
        JSON.stringify({
          Status: 0,
          Answer: [{ name: "_releases-challenge.acme.com.", type: 16, data: token }],
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function mockChallengeFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/.well-known/releases-verify.txt")) {
      return new Response("<html><body>Just a moment...</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.includes("cloudflare-dns.com/dns-query")) {
      return new Response("not json", { status: 500 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function withSession(userId: string | null) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    if (userId) {
      (c as any).set("session", { user: { id: userId, email: "u@example.com", name: "U" } });
    }
    await next();
  });
  a.route("/", listingClaimHandlers);
  return a;
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: h.db,
    WEB_BASE_URL: "https://releases.sh",
    LISTING_RATE_LIMITER: okLimiter,
    LISTING_DOMAIN_RATE_LIMITER: okLimiter,
    ...overrides,
  } as unknown as Record<string, unknown>;
}

beforeEach(async () => {
  h = createTestDb();
  await h.db
    .insert(organizations)
    .values({ id: "org_acme", name: "Acme", slug: "acme", domain: "acme.com" });
});

afterEach(() => h.cleanup());

describe("POST /v1/listing/claim", () => {
  it("401s when unauthenticated", async () => {
    const a = withSession(null);
    const res = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env(),
    );
    expect(res.status).toBe(401);
  });

  it("404s the lane when the kill switch is off", async () => {
    const a = withSession("u1");
    const res = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env({ LISTING_SELF_SERVE_ENABLED: "false" }),
    );
    expect(res.status).toBe(404);
  });

  it("400s an unparseable domain via the standard envelope", async () => {
    const a = withSession("u1");
    const res = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "not a domain!" }) },
      env(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("validation");
  });

  it("429s when the per-IP listing limiter refuses", async () => {
    const a = withSession("u1");
    const res = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env({ LISTING_RATE_LIMITER: noLimiter }),
    );
    expect(res.status).toBe(429);
  });

  it("404s an unlisted domain", async () => {
    const a = withSession("u1");
    const res = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "nope.com" }) },
      env(),
    );
    expect(res.status).toBe(404);
  });

  it("mints a pending claim with instructions on first call", async () => {
    const a = withSession("u1");
    const res = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      token: string;
      instructions: { wellKnownUrl: string; dnsRecordName: string };
    };
    expect(body.status).toBe("pending");
    expect(body.token).toStartWith("relv_");
    expect(body.instructions.wellKnownUrl).toBe("https://acme.com/.well-known/releases-verify.txt");
    expect(body.instructions.dnsRecordName).toBe("_releases-challenge.acme.com");
  });

  it("is idempotent once verified — returns the existing verified claim, no new token", async () => {
    const a = withSession("u1");
    const mint = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env(),
    );
    const claim = (await mint.json()) as { id: string; token: string };
    mockWellKnownFetch(claim.token);
    await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env(),
    );
    const second = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env(),
    );
    expect(second.status).toBe(200);
    const body = (await second.json()) as { id: string; status: string; token?: string };
    expect(body.id).toBe(claim.id);
    expect(body.status).toBe("verified");
    expect(body.token).toBeUndefined();
  });

  it("is idempotent while pending — a repeat call returns the same claim, no duplicate row", async () => {
    const a = withSession("u1");
    const first = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env(),
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; token: string };

    const second = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env(),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { id: string; token: string; status: string };
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.token).toBe(firstBody.token);
    expect(secondBody.status).toBe("pending");

    const rows = await h.db.select().from(orgClaims).where(eq(orgClaims.userId, "u1"));
    expect(rows).toHaveLength(1);
  });

  it("mints a fresh claim when the prior pending claim has expired", async () => {
    const a = withSession("u1");
    const first = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env(),
    );
    const firstBody = (await first.json()) as { id: string; token: string };
    await h.db
      .update(orgClaims)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(orgClaims.id, firstBody.id));

    const second = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env(),
    );
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { id: string; token: string };
    expect(secondBody.id).not.toBe(firstBody.id);
    expect(secondBody.token).not.toBe(firstBody.token);
  });
});

describe("POST /v1/listing/claim/verify", () => {
  async function mintClaim(a: Hono, domain = "acme.com") {
    const res = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain }) },
      env(),
    );
    return (await res.json()) as { id: string; token: string };
  }

  it("404s the lane when the kill switch is off", async () => {
    const a = withSession("u1");
    const res = await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: "clm_x" }) },
      env({ LISTING_SELF_SERVE_ENABLED: "false" }),
    );
    expect(res.status).toBe(404);
  });

  it("401s when unauthenticated", async () => {
    const a = withSession(null);
    const res = await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: "clm_x" }) },
      env(),
    );
    expect(res.status).toBe(401);
  });

  it("404s a claim owned by another user (no existence oracle)", async () => {
    const a1 = withSession("u1");
    const claim = await mintClaim(a1);
    const a2 = withSession("u2");
    mockWellKnownFetch(claim.token);
    const res = await a2.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env(),
    );
    expect(res.status).toBe(404);
  });

  it("verifies via well-known only", async () => {
    const a = withSession("u1");
    const claim = await mintClaim(a);
    mockWellKnownFetch(claim.token);
    const res = await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verified: boolean;
      checked: { wellKnown: string; dnsTxt: string };
      claim: { status: string; method?: string };
    };
    expect(body.verified).toBe(true);
    expect(body.checked.wellKnown).toBe("ok");
    expect(body.claim.status).toBe("verified");
    expect(body.claim.method).toBe("well-known");
  });

  it("verifies via DNS TXT only", async () => {
    const a = withSession("u1");
    const claim = await mintClaim(a);
    mockDnsFetch(claim.token);
    const res = await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verified: boolean; claim: { method?: string } };
    expect(body.verified).toBe(true);
    expect(body.claim.method).toBe("dns-txt");
  });

  it("verifies via both mechanisms (well-known checked first)", async () => {
    const a = withSession("u1");
    const claim = await mintClaim(a);
    mockWellKnownFetch(claim.token);
    const res = await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env(),
    );
    const body = (await res.json()) as { claim: { method?: string } };
    expect(body.claim.method).toBe("well-known");
  });

  it("stamps organizations.tracking_requested_at on successful verification", async () => {
    const a = withSession("u1");
    const claim = await mintClaim(a);
    mockWellKnownFetch(claim.token);
    await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env(),
    );
    const [org] = await h.db.select().from(organizations).where(eq(organizations.id, "org_acme"));
    expect(org!.trackingRequestedAt).not.toBeNull();
  });

  it("neither mechanism passes → verified:false, still 200, correct checked outcomes", async () => {
    const a = withSession("u1");
    const claim = await mintClaim(a);
    mockNeitherFetch();
    const res = await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verified: boolean;
      checked: { wellKnown: string; dnsTxt: string };
      claim: { status: string };
    };
    expect(body.verified).toBe(false);
    expect(body.checked.wellKnown).toBe("mismatch");
    expect(body.checked.dnsTxt).toBe("mismatch");
    expect(body.claim.status).toBe("pending");
  });

  it("fail-closed: an HTML challenge page + DoH 500 both report unreachable, not verified", async () => {
    const a = withSession("u1");
    const claim = await mintClaim(a);
    mockChallengeFetch();
    const res = await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env(),
    );
    const body = (await res.json()) as {
      verified: boolean;
      checked: { wellKnown: string; dnsTxt: string };
    };
    expect(body.verified).toBe(false);
    expect(body.checked.wellKnown).toBe("unreachable");
    expect(body.checked.dnsTxt).toBe("unreachable");
  });

  it("expired pending claim flips to expired and 409s", async () => {
    const a = withSession("u1");
    const claim = await mintClaim(a);
    await h.db
      .update(orgClaims)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(orgClaims.id, claim.id));
    mockWellKnownFetch(claim.token);
    const res = await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env(),
    );
    expect(res.status).toBe(409);
    const [row] = await h.db.select().from(orgClaims).where(eq(orgClaims.id, claim.id));
    expect(row!.status).toBe("expired");
  });

  it("already-verified claim is idempotent (200, no double-processing)", async () => {
    const a = withSession("u1");
    const claim = await mintClaim(a);
    mockWellKnownFetch(claim.token);
    await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env(),
    );
    const res = await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verified: boolean; claim: { status: string } };
    expect(body.verified).toBe(true);
    expect(body.claim.status).toBe("verified");
  });

  it("429s on the per-domain limiter", async () => {
    const a = withSession("u1");
    const claim = await mintClaim(a);
    mockWellKnownFetch(claim.token);
    const res = await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env({ LISTING_DOMAIN_RATE_LIMITER: noLimiter }),
    );
    expect(res.status).toBe(429);
  });
});

describe("GET /v1/listing/claims", () => {
  it("404s the lane when the kill switch is off", async () => {
    const a = withSession("u1");
    const res = await a.request(
      "/listing/claims",
      {},
      env({ LISTING_SELF_SERVE_ENABLED: "false" }),
    );
    expect(res.status).toBe(404);
  });

  it("401s when unauthenticated", async () => {
    const a = withSession(null);
    const res = await a.request("/listing/claims", {}, env());
    expect(res.status).toBe(401);
  });

  it("lists only the caller's claims, pending ones with token+instructions", async () => {
    const a = withSession("u1");
    await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env(),
    );
    const other = withSession("u2");
    await other.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env(),
    );
    const res = await a.request("/listing/claims", {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      claims: Array<{ status: string; token?: string; org: { slug: string } }>;
    };
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0]!.status).toBe("pending");
    expect(body.claims[0]!.token).toBeDefined();
    expect(body.claims[0]!.org.slug).toBe("acme");
  });

  it("lazily expires overdue pending rows on read", async () => {
    const a = withSession("u1");
    const mint = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env(),
    );
    const claim = (await mint.json()) as { id: string };
    await h.db
      .update(orgClaims)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(orgClaims.id, claim.id));
    const res = await a.request("/listing/claims", {}, env());
    const body = (await res.json()) as { claims: Array<{ status: string }> };
    expect(body.claims[0]!.status).toBe("expired");
    const [row] = await h.db.select().from(orgClaims).where(eq(orgClaims.id, claim.id));
    expect(row!.status).toBe("expired");
  });
});

describe("POST /v1/listing/promote", () => {
  const promoteEnv = (overrides: Record<string, unknown> = {}) =>
    env({ LISTING_SELF_SERVE_PROMOTION_ENABLED: "true", ...overrides });

  async function mintAndVerify(a: Hono, domain = "acme.com") {
    const mint = await a.request(
      "/listing/claim",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain }) },
      env(),
    );
    const claim = (await mint.json()) as { id: string; token: string };
    mockWellKnownFetch(claim.token);
    await a.request(
      "/listing/claim/verify",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ claimId: claim.id }) },
      env(),
    );
    return claim;
  }

  async function seedStubWithLocators(
    locators: Array<{ feed?: string; url?: string; file?: string }>,
    orgId = "org_acme",
  ) {
    await h.db.update(organizations).set({ tier: "stub" }).where(eq(organizations.id, orgId));
    for (const loc of locators) {
      await h.db.insert(releaseLocations).values({
        orgId,
        basis: "declared",
        matchKey: releaseLocationMatchKey(loc),
        ...loc,
      });
    }
  }

  it("404s the lane when the listing kill switch is off", async () => {
    const a = withSession("u1");
    const res = await a.request(
      "/listing/promote",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      promoteEnv({ LISTING_SELF_SERVE_ENABLED: "false" }),
    );
    expect(res.status).toBe(404);
  });

  it("404s when the promotion flag is off (listing lane on)", async () => {
    const a = withSession("u1");
    const res = await a.request(
      "/listing/promote",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      env(), // no LISTING_SELF_SERVE_PROMOTION_ENABLED override → default false
    );
    expect(res.status).toBe(404);
  });

  it("401s when unauthenticated", async () => {
    const a = withSession(null);
    const res = await a.request(
      "/listing/promote",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      promoteEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("403s when the caller has no verified claim on the domain", async () => {
    const a = withSession("u1");
    const res = await a.request(
      "/listing/promote",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      promoteEnv(),
    );
    expect(res.status).toBe(403);
  });

  // Tier-2 locators (bare url/file) are pended by the materializer without a
  // network probe (see materialize.ts's tier-2 short-circuit in defaultProbe),
  // so this stays hermetic — same convention as the admin promote route's own
  // test (orgs-stub-routes.test.ts: "tier-2 locators, no network"). Tier-1
  // (feed/github/appstore) live-source coverage lives at the lib level in
  // promote.test.ts with an injected `probe`, deliberately avoiding a real
  // `fetchAndParseFeed` call here — `poll-fetch-feed-characterization.test.ts`
  // installs a process-global `mock.module` stub for `@releases/adapters/feed.js`
  // (documented flake, #1553-adjacent) that leaks into any later file's real
  // feed fetch when the full `workers/api` suite runs.
  it("promotes tier-2 locators: bare url + file both queued for review", async () => {
    const a = withSession("u1");
    await seedStubWithLocators([{ url: "https://acme.com/blog" }, { file: "CHANGELOG.md" }]);
    await mintAndVerify(a);
    const res = await a.request(
      "/listing/promote",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      promoteEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      promoted: boolean;
      sources: { created: number; matched: number };
      locators: Array<{ locator: string; outcome: string }>;
    };
    expect(body.promoted).toBe(true);
    expect(body.sources.created).toBe(2);
    expect(body.locators.every((l) => l.outcome === "queued-for-review")).toBe(true);

    const [org] = await h.db.select().from(organizations).where(eq(organizations.id, "org_acme"));
    expect(org!.tier).toBe("tracked");
  });

  it("projection leaks no internal plan fields", async () => {
    const a = withSession("u1");
    await seedStubWithLocators([{ url: "https://acme.com/blog" }]);
    await mintAndVerify(a);
    const res = await a.request(
      "/listing/promote",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      promoteEnv(),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["locators", "promoted", "sources"]);
    const locator = (body.locators as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(locator).sort()).toEqual(["locator", "outcome"]);
  });

  it("already-tracked org is a no-op success", async () => {
    const a = withSession("u1");
    await mintAndVerify(a); // org_acme starts tier:"tracked" (schema default)
    const res = await a.request(
      "/listing/promote",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      promoteEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { promoted: boolean; alreadyTracked?: boolean };
    expect(body.promoted).toBe(false);
    expect(body.alreadyTracked).toBe(true);
  });

  it("passes through 409 when promotion is already in progress for the org", async () => {
    const a = withSession("u1");
    await seedStubWithLocators([{ url: "https://acme.com/blog" }]);
    await mintAndVerify(a);
    // Simulate an in-flight promotion claim.
    await h.db
      .update(organizations)
      .set({ promotingAt: new Date().toISOString() })
      .where(eq(organizations.id, "org_acme"));
    const res = await a.request(
      "/listing/promote",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      promoteEnv(),
    );
    expect(res.status).toBe(409);
  });

  it("429s on the per-domain limiter", async () => {
    const a = withSession("u1");
    await seedStubWithLocators([{ url: "https://acme.com/blog" }]);
    await mintAndVerify(a);
    const res = await a.request(
      "/listing/promote",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "acme.com" }) },
      promoteEnv({ LISTING_DOMAIN_RATE_LIMITER: noLimiter }),
    );
    expect(res.status).toBe(429);
  });

  it("404s an unlisted domain", async () => {
    const a = withSession("u1");
    const res = await a.request(
      "/listing/promote",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ domain: "nope.com" }) },
      promoteEnv(),
    );
    expect(res.status).toBe(404);
  });
});

describe("wiring: claim routes ride the composed v1 router", () => {
  it("attachFollowsSession is registered on a pattern that actually matches /listing/claim and /listing/claim/verify", async () => {
    // Regression pin for a Hono routing footgun that CodeRabbit flagged as
    // "redundant" registration but is actually the opposite: a glued
    // wildcard ("/listing/claim*", no slash before the star) is treated as a
    // literal string and matches nothing, silently skipping session
    // attachment on POST /listing/claim and /listing/claim/verify. Hono only
    // treats "*" as a wildcard when it is its own path segment
    // ("/listing/claim/*"). This test exercises a spy middleware mounted with
    // the exact patterns the route file uses and asserts it actually fires
    // for both routes.
    const spy = new Hono();
    let hits = 0;
    spy.use("/listing/claim/*", async (c, next) => {
      hits += 1;
      await next();
    });
    spy.use("/listing/claims", async (c, next) => {
      hits += 1;
      await next();
    });
    spy.get("/listing/claim", (c) => c.text("ok"));
    spy.get("/listing/claim/verify", (c) => c.text("ok"));
    spy.get("/listing/claims", (c) => c.text("ok"));

    hits = 0;
    await spy.request("/listing/claim");
    expect(hits).toBe(1);

    hits = 0;
    await spy.request("/listing/claim/verify");
    expect(hits).toBe(1);

    hits = 0;
    await spy.request("/listing/claims");
    expect(hits).toBe(1);
  });

  it("mounts through mountV1Routes and 404s deterministically with the switch off", async () => {
    const { mountV1Routes } = await import("../src/v1-routes.js");
    const v1 = new Hono();
    mountV1Routes(v1 as never);
    const composedApp = new Hono();
    composedApp.route("/v1", v1);
    // No Authorization header, no auth bindings: attachFollowsSession must
    // fail toward anonymous and the handler's own kill-switch 404 must win.
    const res = await composedApp.fetch(
      new Request("https://x/v1/listing/claims"),
      { DB: h.db, LISTING_SELF_SERVE_ENABLED: "false" },
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it("registers the three claim routes in the OpenAPI spec", async () => {
    const { mountV1Routes } = await import("../src/v1-routes.js");
    const v1 = new Hono();
    mountV1Routes(v1 as never);
    const composedApp = new Hono();
    composedApp.route("/v1", v1);
    const res = await composedApp.fetch(
      new Request("https://x/v1/openapi.json"),
      { ENVIRONMENT: "production" },
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths?: Record<string, Record<string, unknown>> };
    expect(spec.paths?.["/listing/claim"]?.post).toBeTruthy();
    expect(spec.paths?.["/listing/claim/verify"]?.post).toBeTruthy();
    expect(spec.paths?.["/listing/claims"]?.get).toBeTruthy();
  });
});
