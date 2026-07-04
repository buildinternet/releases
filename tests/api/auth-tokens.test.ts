import { describe, it, expect, afterEach } from "bun:test";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { generateApiToken, hashSecret } from "@buildinternet/releases-core/api-token";

const { authMiddleware, publicReadAuthMiddleware, isValidBearerAuth } =
  (await import("../../workers/api/src/middleware/auth.js")) as unknown as {
    authMiddleware: MiddlewareHandler;
    publicReadAuthMiddleware: MiddlewareHandler;
    isValidBearerAuth: (c: Context) => Promise<boolean>;
  };

function mockSecret(value: string) {
  return { get: () => Promise.resolve(value) };
}

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

async function seed(db: TestDatabase["db"], scopes: string[], extra: Record<string, unknown> = {}) {
  const { token, lookupId, secret } = generateApiToken();
  db.insert(apiTokens)
    .values({
      id: (extra.id as string) ?? `tok_${lookupId}`,
      lookupId,
      tokenHash: await hashSecret(secret),
      name: "t",
      scopes: JSON.stringify(scopes),
      ...extra,
    })
    .run();
  return token;
}

describe("authMiddleware with DB tokens (requires admin)", () => {
  function call(db: TestDatabase["db"]) {
    const a = new Hono();
    a.use("*", authMiddleware);
    a.get("/admin-thing", (c) => c.json({ ok: true }));
    return (token: string) =>
      a.request(
        "/admin-thing",
        { headers: { Authorization: `Bearer ${token}` } },
        { DB: db, RELEASES_API_KEY: mockSecret("root-secret") },
      );
  }

  it("admin-scoped token passes", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["admin"]);
    expect((await call(h.db)(token)).status).toBe(200);
  });

  it("read-only token gets 403 insufficient_scope", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"]);
    const res = await call(h.db)(token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("insufficient_scope");
    expect(body.error.type).toBe("insufficient_scope");
  });

  it("revoked token gets 401", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["admin"], { id: "tok_rev", active: false });
    expect((await call(h.db)(token)).status).toBe(401);
  });

  it("static root key still passes", async () => {
    h = createTestDb();
    expect((await call(h.db)("root-secret")).status).toBe(200);
  });

  it("unknown token is 401 (same as wrong secret)", async () => {
    h = createTestDb();
    expect((await call(h.db)(generateApiToken().token)).status).toBe(401);
  });

  it("valid lookupId with a wrong secret is 401 (uniform failure)", async () => {
    h = createTestDb();
    const real = generateApiToken();
    h.db
      .insert(apiTokens)
      .values({
        id: "tok_wrongsecret",
        lookupId: real.lookupId,
        tokenHash: await hashSecret(real.secret),
        name: "t",
        scopes: JSON.stringify(["admin"]),
      })
      .run();
    // Real, known lookupId but a different secret — exercises the hash-compare
    // false branch on an existing row; must be indistinguishable from unknown.
    const wrong = `relk_${real.lookupId}_${generateApiToken().secret}`;
    expect((await call(h.db)(wrong)).status).toBe(401);
  });
});

describe("publicReadAuthMiddleware with DB tokens (write needs `write`)", () => {
  function makeApp() {
    const a = new Hono();
    a.use("*", publicReadAuthMiddleware);
    a.get("/thing", (c) => c.json({ ok: true }));
    a.post("/thing", (c) => c.json({ ok: true }));
    return a;
  }
  const env = (db: TestDatabase["db"]) => ({ DB: db, RELEASES_API_KEY: mockSecret("root-secret") });

  it("GET passes with no token", async () => {
    h = createTestDb();
    const res = await makeApp().request("/thing", {}, env(h.db));
    expect(res.status).toBe(200);
  });

  it("GET passes with a read-only token (safe-method fast path)", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"]);
    const res = await makeApp().request(
      "/thing",
      { headers: { Authorization: `Bearer ${token}` } },
      env(h.db),
    );
    expect(res.status).toBe(200);
  });

  it("attaches token identity on a safe public read (so read-only usage is recorded)", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"], { id: "tok_pubread" });
    const a = new Hono<{ Variables: { auth?: { kind: string; tokenId?: string } } }>();
    a.use("*", publicReadAuthMiddleware);
    a.get("/thing", (c) => c.json({ auth: c.get("auth") ?? null }));
    const res = await a.request(
      "/thing",
      { headers: { Authorization: `Bearer ${token}` } },
      env(h.db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth: { kind: string; tokenId: string } | null };
    expect(body.auth?.kind).toBe("token");
    expect(body.auth?.tokenId).toBe("tok_pubread");
  });

  it("ignores an invalid token on a safe public read (stays public, no 401)", async () => {
    h = createTestDb();
    const res = await makeApp().request(
      "/thing",
      { headers: { Authorization: `Bearer ${generateApiToken().token}` } },
      env(h.db),
    );
    expect(res.status).toBe(200);
  });

  it("POST with write-scoped token passes", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["write"]);
    const res = await makeApp().request(
      "/thing",
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      env(h.db),
    );
    expect(res.status).toBe(200);
  });

  it("POST with read-only token gets 403", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"]);
    const res = await makeApp().request(
      "/thing",
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      env(h.db),
    );
    expect(res.status).toBe(403);
  });
});

describe("isValidBearerAuth (admin-level predicate)", () => {
  // Mount the predicate directly behind a passthrough handler — no auth
  // middleware — so we assert the boolean it returns in isolation, proving the
  // admin-vs-lower split that gates internal-field unlocks and the GraphQL
  // resolver. This is the most important contract in the change.
  function probe(db: TestDatabase["db"]) {
    const a = new Hono();
    a.get("/probe", async (c) => c.json({ ok: await isValidBearerAuth(c as Context) }));
    return (token: string) =>
      a.request(
        "/probe",
        { headers: { Authorization: `Bearer ${token}` } },
        { DB: db, RELEASES_API_KEY: mockSecret("root-secret") },
      );
  }

  async function probeOk(db: TestDatabase["db"], token: string): Promise<boolean> {
    const res = await probe(db)(token);
    return ((await res.json()) as { ok: boolean }).ok;
  }

  it("read-only DB token is NOT admin-level (false)", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"]);
    expect(await probeOk(h.db, token)).toBe(false);
  });

  it("admin DB token is admin-level (true)", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["admin"]);
    expect(await probeOk(h.db, token)).toBe(true);
  });

  it("static root key is admin-level (true)", async () => {
    h = createTestDb();
    expect(await probeOk(h.db, "root-secret")).toBe(true);
  });
});
