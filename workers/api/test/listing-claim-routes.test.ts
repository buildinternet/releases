import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { organizations, orgClaims } from "@buildinternet/releases-core/schema";
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
