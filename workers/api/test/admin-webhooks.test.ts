import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { adminWebhooksRoutes } from "../src/routes/admin-webhooks.js";

// ---------------------------------------------------------------------------
// Minimal in-memory fake for the drizzle D1Db subset used by the route.
// ---------------------------------------------------------------------------
type FakeSub = {
  id: string;
  orgId: string;
  url: string;
  sourceId: string | null;
  description: string | null;
  enabled: boolean;
  secretVersion: number;
  createdAt: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMsg: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
};

// A valid 64-char hex master key for tests (32 bytes of known data).
const TEST_MASTER_KEY = "a".repeat(64);

function makeApp(opts?: { masterKey?: string | null }) {
  const store: FakeSub[] = [];
  let nextId = 1;

  // Fake db matching the drizzle API surface used in the route.
  const fakeDb = {
    insert: (_table: unknown) => ({
      values: (vals: Partial<FakeSub>) => ({
        returning: async () => {
          const row: FakeSub = {
            id: `whk_test${String(nextId++).padStart(4, "0")}`,
            orgId: vals.orgId!,
            url: vals.url!,
            sourceId: vals.sourceId ?? null,
            description: vals.description ?? null,
            enabled: true,
            secretVersion: 1,
            createdAt: new Date().toISOString(),
            lastSuccessAt: null,
            lastErrorAt: null,
            lastErrorMsg: null,
            consecutiveFailures: 0,
            disabledReason: null,
          };
          store.push(row);
          return [row];
        },
      }),
    }),
    select: () => ({
      from: (_table: unknown) => ({
        where: (cond: unknown) => ({
          limit: async (_n: number) => {
            // Used by getWebhookSubscriptionById — returns first matching row.
            // We can't inspect `cond` easily, so we return the full store;
            // the helper then picks `rows[0] ?? null`. This works correctly
            // when the store is empty (returns null → 404) or has a match.
            return store;
          },
          // Used by listWebhookSubscriptionsByOrg — returns all rows.
          then: (resolve: (v: FakeSub[]) => void, reject: (e: unknown) => void) => {
            Promise.resolve(store).then(resolve, reject);
            return { catch: (fn: (e: unknown) => void) => Promise.resolve(store).catch(fn) };
          },
        }),
      }),
    }),
  };

  const masterKey = opts === undefined
    ? TEST_MASTER_KEY
    : opts.masterKey ?? TEST_MASTER_KEY;

  // Build the fake env that will be passed to app.fetch(req, env, ctx).
  const fakeEnv: Record<string, unknown> = {
    WEBHOOK_HMAC_MASTER: masterKey !== null
      ? { get: async () => masterKey }
      : undefined,
  };

  const app = new Hono();
  // Inject db via context variable so the route's getDb() picks it up.
  app.use("*", async (c, next) => {
    c.set("db" as any, fakeDb);
    await next();
  });
  app.route("/", adminWebhooksRoutes);

  // Wrap fetch to always pass fakeEnv as the Worker env argument.
  const fetch = (req: Request) => app.fetch(req, fakeEnv);

  return { fetch, store };
}

// ---------------------------------------------------------------------------

describe("POST /v1/admin/webhooks", () => {
  it("creates a subscription and returns id + signing key", async () => {
    const { fetch } = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { id?: string; signingKey?: string };
    expect(body.id).toMatch(/^whk_/);
    expect(body.signingKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns 400 for http (non-HTTPS) URL", async () => {
    const { fetch } = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "http://insecure/u" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when orgId is missing", async () => {
    const { fetch } = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/hook" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when url is missing", async () => {
    const { fetch } = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/admin/webhooks", () => {
  it("returns 200 with subscriptions array for a known org", async () => {
    const { fetch } = makeApp();

    // Seed one subscription first.
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );

    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks?org=org_test"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { subscriptions?: unknown[] };
    expect(Array.isArray(body.subscriptions)).toBe(true);
  });

  it("returns 400 when org param is missing", async () => {
    const { fetch } = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks"),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/admin/webhooks/:id", () => {
  it("returns 404 for an unknown id (empty store)", async () => {
    const { fetch } = makeApp();
    // Store is empty so rows[0] will be undefined → 404
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks/whk_nonexistent"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 with the subscription for a known id", async () => {
    const { fetch, store } = makeApp();

    // Seed one subscription.
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const id = store[0].id;

    const res = await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { id?: string };
    expect(body.id).toBe(id);
  });
});
