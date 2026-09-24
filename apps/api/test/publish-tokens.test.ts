/**
 * Owner-scoped publish tokens (#2373). Drives a near-production v1 app — the
 * real namespace auth wiring from route-namespaces.ts plus every mounted route
 * module (`mountV1Routes`) — so the tests exercise the same middleware order a
 * live request sees. Better Auth is replaced by the `betterAuth` context seam.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  apiTokens,
  organizations,
  orgClaims,
  releases,
  sources,
} from "@buildinternet/releases-core/schema";
import { generateApiToken, hashSecret } from "@buildinternet/releases-core/api-token";
import {
  authMiddleware,
  isPublishBatchPath,
  publicReadAuthMiddleware,
  tokensAuthMiddleware,
} from "../src/middleware/auth.js";
import { publicRateLimitMiddleware } from "../src/middleware/rate-limit.js";
import { adminRoutes, publicReadRoutes } from "../src/route-namespaces.js";
import { mountV1Routes } from "../src/v1-routes.js";
import { createTestDb, type TestDb } from "./setup";

const ROOT = "root-secret";
const OWNER = "user_owner";
const OTHER = "user_other";
const COOKIE_OWNER = "sess=owner";
const COOKIE_OTHER = "sess=other";

const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({ fetch: async () => new Response("ok", { status: 200 }) }),
};

let db: TestDb;
let verifyApiKey: ReturnType<typeof mock>;

/**
 * Better Auth seam: a cookie maps to a session user; so does a bearer-plugin
 * style `Authorization: Bearer sess_owner` (to prove the mint gate ignores
 * that lane too). `verifyApiKey` accepts any `relu_` key as OWNER — what
 * `requireFollowsPrincipal` would honor.
 */
function betterAuthSeam() {
  return {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get("cookie");
        const authz = headers.get("authorization");
        if (cookie === COOKIE_OWNER || authz === "Bearer sess_owner")
          return { user: { id: OWNER, email: "owner@example.com", name: "Owner" } };
        if (cookie === COOKIE_OTHER)
          return { user: { id: OTHER, email: "other@example.com", name: "Other" } };
        return null;
      },
      verifyApiKey,
    },
  };
}

function buildApp(envOverrides: Record<string, unknown> = {}) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    // @ts-expect-error — test-only context seam, typed on the real Env.
    c.set("betterAuth", betterAuthSeam());
    await next();
  });
  const v1 = new Hono();
  for (const r of publicReadRoutes) {
    v1.use(`/${r}`, publicReadAuthMiddleware);
    v1.use(`/${r}/*`, publicReadAuthMiddleware);
  }
  for (const r of adminRoutes) {
    const mw = r === "tokens" ? tokensAuthMiddleware : authMiddleware;
    v1.use(`/${r}`, mw);
    v1.use(`/${r}/*`, mw);
  }
  // oxlint-disable-next-line no-explicit-any
  mountV1Routes(v1 as any);
  app.route("/v1", v1);
  const env = {
    DB: db,
    RELEASES_API_KEY: { get: () => Promise.resolve(ROOT) },
    STATUS_HUB: statusHubStub,
    ENVIRONMENT: "test",
    ...envOverrides,
  };
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  return (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`https://api.test${path}`, init), env, ctx as never);
}

let call: ReturnType<typeof buildApp>;

/** The exact web origin mint/revoke require (WEB_BASE_URL unset → prod default). */
const WEB_ORIGIN = "https://releases.sh";

function json(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", Origin: WEB_ORIGIN, ...headers },
    body: JSON.stringify(body),
  };
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function seed() {
  await db.insert(organizations).values([
    { id: "org_a", slug: "acme", name: "Acme", domain: "acme.com" },
    { id: "org_b", slug: "beta", name: "Beta", domain: "beta.com" },
  ]);
  await db.insert(sources).values([
    {
      id: "src_a1",
      slug: "acme-changelog",
      name: "Acme Changelog",
      type: "feed",
      url: "https://acme.com/changelog",
      orgId: "org_a",
    },
    {
      id: "src_a2",
      slug: "acme-blog",
      name: "Acme Blog",
      type: "feed",
      url: "https://acme.com/blog",
      orgId: "org_a",
    },
    {
      id: "src_b1",
      slug: "beta-changelog",
      name: "Beta Changelog",
      type: "feed",
      url: "https://beta.com/changelog",
      orgId: "org_b",
    },
  ]);
}

async function addClaim(
  userId: string,
  orgId: string,
  status: "pending" | "verified" | "expired" = "verified",
  id = `ocl_${userId}_${orgId}`,
) {
  await db.insert(orgClaims).values({
    id,
    orgId,
    userId,
    token: `relv_${id}`,
    status,
    method: status === "verified" ? "well-known" : null,
    verifiedAt: status === "verified" ? "2026-09-01T00:00:00.000Z" : null,
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-08T00:00:00.000Z",
  });
}

async function mint(sourceId = "src_a1", cookie = COOKIE_OWNER, name = "ci") {
  return call("/v1/me/publish-tokens", json("POST", { sourceId, name }, { Cookie: cookie }));
}

async function mintToken(sourceId = "src_a1"): Promise<{ token: string; id: string }> {
  const res = await mint(sourceId);
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; id: string };
}

function batchBody(n = 1) {
  return {
    mode: "upsert-content",
    releases: Array.from({ length: n }, (_, i) => ({
      title: `Release ${i}`,
      content: `Body ${i}`,
      url: `https://acme.com/changelog/${i}-${Math.random().toString(36).slice(2)}`,
    })),
  };
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

beforeEach(async () => {
  db = createTestDb();
  verifyApiKey = mock(async () => ({
    valid: true,
    key: { id: "k1", referenceId: OWNER, permissions: { api: ["read"] } },
  }));
  call = buildApp();
  await seed();
  await addClaim(OWNER, "org_a");
});

describe("isPublishBatchPath", () => {
  it("matches exactly the two batch route shapes", () => {
    expect(isPublishBatchPath("/v1/sources/src_a1/releases/batch")).toBe(true);
    expect(isPublishBatchPath("/v1/orgs/acme/sources/acme-changelog/releases/batch")).toBe(true);
    expect(isPublishBatchPath("/sources/src_a1/releases/batch")).toBe(true);
    expect(isPublishBatchPath("/orgs/acme/sources/x/releases/batch")).toBe(true);
  });

  it("rejects everything else", () => {
    for (const p of [
      "/v1/releases/batch",
      "/v1/sources/src_a1/releases",
      "/v1/sources/src_a1/releases/batch/",
      "/v1/sources//releases/batch",
      "/v1/sources/src_a1/releases/batch-suppress",
      "/v1/sources/src_a1/metadata",
      "/v1/orgs/acme/sources/x/releases",
      "/v1/orgs/acme/releases/batch",
      "/v1/v1/sources/src_a1/releases/batch",
      "/v1/admin/sources/x/releases/batch",
      "/v1/orgs/acme/sources/x/y/releases/batch",
      "v1/sources/src_a1/releases/batch",
      "",
    ]) {
      expect(isPublishBatchPath(p)).toBe(false);
    }
  });
});

describe("POST /v1/me/publish-tokens (mint)", () => {
  it("mints a source-bound publish token for a verified owner", async () => {
    const res = await mint("src_a1", COOKIE_OWNER, "  github-actions  ");
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as Record<string, string>;
    expect(Object.keys(body).toSorted()).toEqual(
      ["createdAt", "id", "name", "sourceId", "token"].toSorted(),
    );
    expect(body.token).toMatch(/^relk_[0-9A-Za-z]{12}_[0-9A-Za-z]{32}$/);
    expect(body.sourceId).toBe("src_a1");
    expect(body.name).toBe("github-actions");

    const row = await db.select().from(apiTokens).where(eq(apiTokens.id, body.id)).get();
    expect(row).toBeDefined();
    expect(JSON.parse(row!.scopes)).toEqual(["publish"]);
    expect(row!.principalType).toBe("user");
    expect(row!.principalId).toBe(OWNER);
    expect(row!.sourceId).toBe("src_a1");
    // Only the hash is stored.
    expect(row!.tokenHash).not.toContain(body.token.split("_")[2]!);
    expect(row!.tokenHash).toBe(await hashSecret(body.token.split("_")[2]!));
  });

  it("403s without any claim on the source's org", async () => {
    const res = await mint("src_a1", COOKIE_OTHER);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden");
  });

  it("403s with only a pending claim", async () => {
    await addClaim(OTHER, "org_a", "pending");
    expect((await mint("src_a1", COOKIE_OTHER)).status).toBe(403);
  });

  it("403s with only an expired claim", async () => {
    await addClaim(OTHER, "org_a", "expired");
    expect((await mint("src_a1", COOKIE_OTHER)).status).toBe(403);
  });

  it("403s when the verified claim is on a different org", async () => {
    await addClaim(OTHER, "org_b");
    expect((await mint("src_a1", COOKIE_OTHER)).status).toBe(403);
    // …and the same claim does cover org_b's source.
    expect((await mint("src_b1", COOKIE_OTHER)).status).toBe(201);
  });

  it("404s for an unknown or soft-deleted source", async () => {
    expect((await mint("src_nope")).status).toBe(404);
    await db
      .update(sources)
      .set({ deletedAt: "2026-09-01T00:00:00.000Z" })
      .where(eq(sources.id, "src_a2"));
    expect((await mint("src_a2")).status).toBe(404);
  });

  it("400s on a malformed body", async () => {
    const res = await call(
      "/v1/me/publish-tokens",
      json("POST", { sourceId: "src_a1" }, { Cookie: COOKIE_OWNER }),
    );
    expect(res.status).toBe(400);
  });

  it("caps active tokens per (user, source) at 5 with a 409, and revoking frees a slot", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await mintToken("src_a1")).id);
    const sixth = await mint("src_a1");
    expect(sixth.status).toBe(409);
    expect(await errorCode(sixth)).toBe("api_key_limit");
    // Other sources have their own budget.
    expect((await mint("src_a2")).status).toBe(201);

    const del = await call(`/v1/me/publish-tokens/${ids[0]}`, {
      method: "DELETE",
      headers: { Cookie: COOKIE_OWNER, Origin: WEB_ORIGIN },
    });
    expect(del.status).toBe(200);
    expect((await mint("src_a1")).status).toBe(201);
  });

  it("401s with no session", async () => {
    const res = await call(
      "/v1/me/publish-tokens",
      json("POST", { sourceId: "src_a1", name: "x" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a relu_ user key (Bearer) — cookie session only", async () => {
    const res = await call(
      "/v1/me/publish-tokens",
      json("POST", { sourceId: "src_a1", name: "x" }, bearer("relu_somekey")),
    );
    expect(res.status).toBe(401);
    // The /me/* session-or-Bearer gate never ran, so the key was never verified.
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(await db.select().from(apiTokens).all()).toHaveLength(0);
  });

  it("rejects a bearer-plugin session token too", async () => {
    const res = await call(
      "/v1/me/publish-tokens",
      json("POST", { sourceId: "src_a1", name: "x" }, bearer("sess_owner")),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a relk_ machine token, even root", async () => {
    const res = await call(
      "/v1/me/publish-tokens",
      json("POST", { sourceId: "src_a1", name: "x" }, bearer(ROOT)),
    );
    expect(res.status).toBe(401);
  });

  it("404s every route when the listing kill switch is off", async () => {
    const off = buildApp({ LISTING_SELF_SERVE_ENABLED: "false" });
    const res = await off(
      "/v1/me/publish-tokens",
      json("POST", { sourceId: "src_a1", name: "x" }, { Cookie: COOKIE_OWNER }),
    );
    expect(res.status).toBe(404);
    expect((await off("/v1/me/publish-tokens", { headers: { Cookie: COOKIE_OWNER } })).status).toBe(
      404,
    );
  });
});

describe("publish-token mutations require the exact web origin (CSRF)", () => {
  it.each([
    ["missing", undefined],
    ["a sibling releases.sh subdomain", "https://evil.releases.sh"],
    ["an unrelated site", "https://attacker.example.com"],
  ])("refuses mint with %s Origin", async (_label, origin) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      Cookie: COOKIE_OWNER,
    };
    if (origin) headers.Origin = origin;
    const res = await call("/v1/me/publish-tokens", {
      method: "POST",
      headers,
      body: JSON.stringify({ sourceId: "src_a1", name: "ci" }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses revoke from a sibling subdomain", async () => {
    const { id } = await mintToken();
    const res = await call(`/v1/me/publish-tokens/${id}`, {
      method: "DELETE",
      headers: { Cookie: COOKIE_OWNER, Origin: "https://evil.releases.sh" },
    });
    expect(res.status).toBe(403);
  });

  it("still lists tokens without an Origin (GET is read-only)", async () => {
    const res = await call("/v1/me/publish-tokens", { headers: { Cookie: COOKIE_OWNER } });
    expect(res.status).toBe(200);
  });
});

describe("GET /v1/me/publish-tokens + DELETE (list, revoke)", () => {
  it("lists the caller's tokens without secrets", async () => {
    const a = await mintToken("src_a1");
    await mintToken("src_a2");
    await addClaim(OTHER, "org_b");
    await mint("src_b1", COOKIE_OTHER);

    const res = await call("/v1/me/publish-tokens", { headers: { Cookie: COOKIE_OWNER } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(a.token);
    expect(text).not.toContain(a.token.split("_")[2]!);
    const body = JSON.parse(text) as { publishTokens: Array<Record<string, unknown>> };
    expect(body.publishTokens).toHaveLength(2);
    for (const t of body.publishTokens) {
      expect(Object.keys(t).toSorted()).toEqual(
        [
          "createdAt",
          "id",
          "lastUsedAt",
          "name",
          "orgSlug",
          "revokedAt",
          "sourceId",
          "sourceSlug",
        ].toSorted(),
      );
      expect(t.orgSlug).toBe("acme");
    }
    const first = body.publishTokens.find((t) => t.id === a.id)!;
    expect(first.sourceSlug).toBe("acme-changelog");
    expect(first.revokedAt).toBeNull();
  });

  it("revokes only the owner's token; others get 404", async () => {
    const a = await mintToken("src_a1");
    const asOther = await call(`/v1/me/publish-tokens/${a.id}`, {
      method: "DELETE",
      headers: { Cookie: COOKIE_OTHER, Origin: WEB_ORIGIN },
    });
    expect(asOther.status).toBe(404);
    expect(
      (
        await call("/v1/me/publish-tokens/atk_missing", {
          method: "DELETE",
          headers: { Cookie: COOKIE_OWNER, Origin: WEB_ORIGIN },
        })
      ).status,
    ).toBe(404);

    const res = await call(`/v1/me/publish-tokens/${a.id}`, {
      method: "DELETE",
      headers: { Cookie: COOKIE_OWNER, Origin: WEB_ORIGIN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; revokedAt: string };
    expect(body.id).toBe(a.id);
    expect(typeof body.revokedAt).toBe("string");

    const list = (await (
      await call("/v1/me/publish-tokens", { headers: { Cookie: COOKIE_OWNER } })
    ).json()) as { publishTokens: Array<{ id: string; revokedAt: string | null }> };
    expect(list.publishTokens[0]!.revokedAt).toBe(body.revokedAt);

    // Idempotent.
    const again = await call(`/v1/me/publish-tokens/${a.id}`, {
      method: "DELETE",
      headers: { Cookie: COOKIE_OWNER, Origin: WEB_ORIGIN },
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { revokedAt: string }).revokedAt).toBe(body.revokedAt);
  });

  it("can't revoke an admin-minted ladder token through this route", async () => {
    const { lookupId, secret } = generateApiToken();
    await db.insert(apiTokens).values({
      id: "atk_ladder",
      lookupId,
      tokenHash: await hashSecret(secret),
      name: "ladder",
      scopes: JSON.stringify(["write"]),
      principalType: "user",
      principalId: OWNER,
    });
    const res = await call("/v1/me/publish-tokens/atk_ladder", {
      method: "DELETE",
      headers: { Cookie: COOKIE_OWNER, Origin: WEB_ORIGIN },
    });
    expect(res.status).toBe(404);
  });
});

describe("using a publish token", () => {
  const batch = (token: string, path = "/v1/sources/src_a1/releases/batch", n = 1) =>
    call(path, json("POST", batchBody(n), bearer(token)));

  it("publishes to its own source on the bare route", async () => {
    const { token } = await mintToken();
    const res = await batch(token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inserted: number }).inserted).toBe(1);
    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_a1"));
    expect(rows).toHaveLength(1);
  });

  it("publishes to its own source on the org-scoped route", async () => {
    const { token } = await mintToken();
    const res = await batch(token, "/v1/orgs/acme/sources/acme-changelog/releases/batch");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inserted: number }).inserted).toBe(1);
  });

  it("still reads public routes (the Action's release list)", async () => {
    const { token } = await mintToken();
    const res = await call("/v1/sources/src_a1/releases", { headers: bearer(token) });
    expect(res.status).toBe(200);
  });

  it("403s on a different source in the same org (handler binding)", async () => {
    const { token } = await mintToken();
    const bare = await batch(token, "/v1/sources/src_a2/releases/batch");
    expect(bare.status).toBe(403);
    expect(await errorCode(bare)).toBe("insufficient_scope");
    const scoped = await batch(token, "/v1/orgs/acme/sources/acme-blog/releases/batch");
    expect(scoped.status).toBe(403);
    expect(await db.select().from(releases).all()).toHaveLength(0);
  });

  it("403s on a source in another org, even one its owner also claims", async () => {
    await addClaim(OWNER, "org_b");
    const { token } = await mintToken();
    expect((await batch(token, "/v1/sources/src_b1/releases/batch")).status).toBe(403);
    expect((await batch(token, "/v1/orgs/beta/sources/beta-changelog/releases/batch")).status).toBe(
      403,
    );
    expect(await db.select().from(releases).all()).toHaveLength(0);
  });

  it("403s on every non-batch write and admin route", async () => {
    const { token } = await mintToken();
    const h = bearer(token);
    const attempts: Array<[string, RequestInit]> = [
      ["/v1/sources/src_a1", json("PATCH", { name: "pwned" }, h)],
      ["/v1/orgs/acme/sources/acme-changelog", json("PATCH", { name: "pwned" }, h)],
      ["/v1/sources/src_a1/metadata", json("PATCH", { feedUrl: "https://evil.test" }, h)],
      ["/v1/sources/src_a1/releases", json("POST", { title: "t", content: "c" }, h)],
      ["/v1/sources/src_a1/releases", { method: "DELETE", headers: h }],
      ["/v1/sources/src_a1", { method: "DELETE", headers: h }],
      ["/v1/sources/src_a1/fetch", { method: "POST", headers: h }],
      ["/v1/releases/batch", json("DELETE", { ids: ["rel_x"] }, h)],
      ["/v1/releases/batch-suppress", json("POST", { ids: ["rel_x"] }, h)],
      ["/v1/orgs/acme", json("PATCH", { name: "pwned" }, h)],
      ["/v1/sources", json("POST", { name: "n" }, h)],
      ["/v1/workflows/generate-content", json("POST", { sourceId: "src_a1" }, h)],
      ["/v1/tokens", { method: "GET", headers: h }],
      ["/v1/tokens/me", { method: "GET", headers: h }],
      ["/v1/tokens", json("POST", { name: "x", scopes: ["admin"] }, h)],
      ["/v1/admin/sources", { method: "GET", headers: h }],
      ["/v1/webhooks", { method: "GET", headers: h }],
      // Right path, wrong method.
      ["/v1/sources/src_a1/releases/batch", json("PUT", batchBody(), h)],
    ];
    for (const [path, init] of attempts) {
      const res = await call(path, init);
      expect({ path, method: init.method, status: res.status }).toEqual({
        path,
        method: init.method,
        status: 403,
      });
    }
    const src = await db.select().from(sources).where(eq(sources.id, "src_a1")).get();
    expect(src!.name).toBe("Acme Changelog");
    expect(src!.deletedAt).toBeNull();
    expect(await db.select().from(apiTokens).all()).toHaveLength(1);
  });

  it("401s after the token is revoked", async () => {
    const { token, id } = await mintToken();
    expect((await batch(token)).status).toBe(200);
    await call(`/v1/me/publish-tokens/${id}`, {
      method: "DELETE",
      headers: { Cookie: COOKIE_OWNER, Origin: WEB_ORIGIN },
    });
    expect((await batch(token)).status).toBe(401);
  });

  it("401s after the owner's claim is removed", async () => {
    const { token } = await mintToken();
    expect((await batch(token)).status).toBe(200);
    await db.delete(orgClaims).where(eq(orgClaims.userId, OWNER));
    expect((await batch(token)).status).toBe(401);
  });

  it("401s after the owner's claim lapses out of verified", async () => {
    const { token } = await mintToken();
    await db.update(orgClaims).set({ status: "expired" }).where(eq(orgClaims.userId, OWNER));
    expect((await batch(token)).status).toBe(401);
  });

  it("401s after its source is soft-deleted", async () => {
    const { token } = await mintToken();
    await db
      .update(sources)
      .set({ deletedAt: "2026-09-01T00:00:00.000Z" })
      .where(eq(sources.id, "src_a1"));
    expect((await batch(token)).status).toBe(401);
  });

  it("401s after its source is hard-deleted", async () => {
    const { token } = await mintToken();
    await db.delete(releases).where(eq(releases.sourceId, "src_a1"));
    await db.delete(sources).where(eq(sources.id, "src_a1"));
    expect((await batch(token)).status).toBe(401);
  });

  it("401s after its org is soft-deleted", async () => {
    const { token } = await mintToken();
    await db
      .update(organizations)
      .set({ deletedAt: "2026-09-01T00:00:00.000Z" })
      .where(eq(organizations.id, "org_a"));
    expect((await batch(token)).status).toBe(401);
  });

  it("fails closed on a row tampered into ladder scopes", async () => {
    const { token, id } = await mintToken();
    await db
      .update(apiTokens)
      .set({ scopes: JSON.stringify(["write"]) })
      .where(eq(apiTokens.id, id));
    expect((await batch(token)).status).toBe(401);
    expect(
      (await call("/v1/sources/src_a1", json("PATCH", { name: "x" }, bearer(token)))).status,
    ).toBe(401);
    await db
      .update(apiTokens)
      .set({ scopes: JSON.stringify(["publish", "admin"]) })
      .where(eq(apiTokens.id, id));
    expect((await batch(token)).status).toBe(401);
  });

  it("fails closed on a publish scope with no source binding", async () => {
    const { token, id } = await mintToken();
    await db.update(apiTokens).set({ sourceId: null }).where(eq(apiTokens.id, id));
    expect((await batch(token)).status).toBe(401);
  });
});

describe("admin token surface with publish tokens present", () => {
  const root = bearer(ROOT);

  it("lists publish-token rows with their sourceId", async () => {
    const { id } = await mintToken();
    const res = await call("/v1/tokens", { headers: root });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Array<{ id: string; sourceId: string | null }> };
    expect(body.tokens.find((t) => t.id === id)?.sourceId).toBe("src_a1");
  });

  it("won't mint a publish-scoped token", async () => {
    const res = await call("/v1/tokens", json("POST", { name: "x", scopes: ["publish"] }, root));
    expect(res.status).toBe(400);
    const mixed = await call(
      "/v1/tokens",
      json("POST", { name: "x", scopes: ["read", "publish"] }, root),
    );
    expect(mixed.status).toBe(400);
  });

  it("won't change a publish token's scopes", async () => {
    const { id } = await mintToken();
    const res = await call(`/v1/tokens/${id}`, json("PATCH", { scopes: ["write"] }, root));
    expect(res.status).toBe(400);
    const row = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    expect(JSON.parse(row!.scopes)).toEqual(["publish"]);
  });
});

describe("rate-limit tier for publish tokens", () => {
  function limiter() {
    const calls: string[] = [];
    return {
      calls,
      async limit({ key }: { key: string }) {
        calls.push(key);
        return { success: true };
      },
    };
  }

  it("puts a publish token's public reads on the anonymous per-IP rung, not the machine rung", async () => {
    const { token } = await mintToken();
    const app = new Hono();
    app.use("*", publicRateLimitMiddleware);
    app.get("/probe", (c) => c.text("ok"));
    const ipLimiter = limiter();
    const tokenLimiter = limiter();
    const res = await app.fetch(
      new Request("https://api.test/probe", {
        headers: { ...bearer(token), "cf-connecting-ip": "203.0.113.9" },
      }),
      {
        DB: db,
        RELEASES_API_KEY: { get: () => Promise.resolve(ROOT) },
        RATE_LIMIT_ENABLED: "true",
        TOKEN_RATE_LIMIT_ENABLED: "true",
        PUBLIC_RATE_LIMITER: ipLimiter,
        TOKEN_RATE_LIMITER: tokenLimiter,
        ENVIRONMENT: "test",
      },
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    );
    expect(res.status).toBe(200);
    expect(ipLimiter.calls).toEqual(["203.0.113.9"]);
    expect(tokenLimiter.calls).toEqual([]);
  });
});
