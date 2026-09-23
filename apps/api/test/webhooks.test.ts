/**
 * Admin `/v1/webhooks` route tests.
 *
 * Uses a real migrated `createTestDb()` handle — the same seam as
 * `me-webhooks.test.ts`. A previous in-memory FakeSub + `mock.module` of
 * `webhooks/queries.js` leaked process-globally (Bun cannot restore it) and
 * made `/v1/me/webhooks` create-vs-read split-brain whenever Linux loaded
 * this file first.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { organizations, webhookSubscriptions } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { webhooksRoutes } from "../src/routes/webhooks.js";

const TEST_MASTER_KEY = "a".repeat(64);
const IDEMPOTENCY_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const TEST_IDEMPOTENCY_KEY = "webhook-test-idem-02";
const PUBLIC_HOOK_URL = "https://1.1.1.1/hook";
const ORG_ID = "org_test";

const queueMessages: unknown[] = [];

let h: TestDatabase;

function makeApp(opts?: {
  masterKey?: string | null;
  withQueue?: boolean;
  queue?: { send(message: unknown): Promise<void> };
}) {
  const masterKey = opts === undefined ? TEST_MASTER_KEY : (opts.masterKey ?? TEST_MASTER_KEY);
  const withQueue = opts?.withQueue !== false;
  const fakeEnv: Record<string, unknown> = {
    DB: h.db,
    WEBHOOK_HMAC_MASTER: masterKey !== null ? { get: async () => masterKey } : undefined,
    IDEMPOTENCY_ENCRYPTION_KEY: { get: async () => IDEMPOTENCY_SECRET },
  };
  if (withQueue) {
    fakeEnv.WEBHOOK_DELIVERY_QUEUE = opts?.queue ?? {
      send: async (msg: unknown) => {
        queueMessages.push(msg);
      },
    };
  }
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("localAuthSkip", true);
    await next();
  });
  const v1 = new Hono();
  v1.route("/", webhooksRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv);
}

async function createSub(
  fetch: (req: Request) => Promise<Response> | Response,
  body: Record<string, unknown> = {},
): Promise<{ id: string; signingKey: string }> {
  const res = await fetch(
    new Request("https://x.test/v1/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId: ORG_ID, url: PUBLIC_HOOK_URL, ...body }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; signingKey: string };
}

beforeEach(async () => {
  h = createTestDb();
  queueMessages.length = 0;
  await h.db.insert(organizations).values({ id: ORG_ID, name: "Test Org", slug: "test-org" });
});

afterEach(() => h.cleanup());

describe("POST /v1/webhooks", () => {
  it("creates a subscription and returns id + signing key", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: ORG_ID, url: PUBLIC_HOOK_URL }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string; signingKey?: string };
    expect(body.id).toMatch(/^whk_/);
    expect(body.signingKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns 400 for non-HTTPS URL", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: ORG_ID, url: "http://insecure/u" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for a private IP target", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: ORG_ID, url: "https://10.0.0.1/hook" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed URL", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: ORG_ID, url: "not-a-url" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when orgId is missing", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: PUBLIC_HOOK_URL }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when url is missing", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: ORG_ID }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/webhooks", () => {
  it("returns 200 with the subscriptions seeded for an org", async () => {
    const fetch = makeApp();
    await createSub(fetch);
    const res = await fetch(new Request(`https://x.test/v1/webhooks?org=${ORG_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscriptions: { id: string; orgId: string }[] };
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0]!.orgId).toBe(ORG_ID);
  });

  it("returns 400 when org param is missing", async () => {
    const fetch = makeApp();
    const res = await fetch(new Request("https://x.test/v1/webhooks"));
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/webhooks/:id", () => {
  it("returns 404 for an unknown id even when other subscriptions exist", async () => {
    const fetch = makeApp();
    await createSub(fetch);
    const res = await fetch(new Request("https://x.test/v1/webhooks/whk_nonexistent"));
    expect(res.status).toBe(404);
  });

  it("returns 200 with the subscription for a known id", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);
    const res = await fetch(new Request(`https://x.test/v1/webhooks/${id}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string };
    expect(body.id).toBe(id);
  });
});

describe("PATCH /v1/webhooks/:id", () => {
  it("returns 404 for an unknown id", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/webhooks/whk_nope", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "hi" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when url is invalid", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);
    const res = await fetch(
      new Request(`https://x.test/v1/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "not-a-url" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when url is HTTP (not HTTPS)", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);
    const res = await fetch(
      new Request(`https://x.test/v1/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://insecure.example.com/hook" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when no recognized fields are provided", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);
    const res = await fetch(
      new Request(`https://x.test/v1/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unknownField: "whatever" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("resets consecutiveFailures and clears disabledReason when enabled:true", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);
    await h.db
      .update(webhookSubscriptions)
      .set({ enabled: false, consecutiveFailures: 5, disabledReason: "auto disabled" })
      .where(eq(webhookSubscriptions.id, id));

    const res = await fetch(
      new Request(`https://x.test/v1/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      consecutiveFailures: number;
      disabledReason: string | null;
    };
    expect(body.enabled).toBe(true);
    expect(body.consecutiveFailures).toBe(0);
    expect(body.disabledReason).toBeNull();
  });

  it("sets disabledReason to 'manually disabled' when enabled:false with no reason", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);

    const res = await fetch(
      new Request(`https://x.test/v1/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; disabledReason: string | null };
    expect(body.enabled).toBe(false);
    expect(body.disabledReason).toBe("manually disabled");
  });

  it("updates description and returns fresh subscription", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);

    const res = await fetch(
      new Request(`https://x.test/v1/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "updated description" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; description: string | null };
    expect(body.id).toBe(id);
    expect(body.description).toBe("updated description");
  });
});

describe("DELETE /v1/webhooks/:id", () => {
  it("returns 204 for an existing subscription", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);
    const res = await fetch(
      new Request(`https://x.test/v1/webhooks/${id}`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
  });

  it("subscription is gone after delete (GET returns 404)", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);
    await fetch(
      new Request(`https://x.test/v1/webhooks/${id}`, {
        method: "DELETE",
      }),
    );
    const getRes = await fetch(new Request(`https://x.test/v1/webhooks/${id}`));
    expect(getRes.status).toBe(404);
  });

  it("returns 204 even for an unknown id (idempotent)", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/webhooks/whk_doesnotexist", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
  });
});

describe("POST /v1/webhooks/:id/rotate-secret", () => {
  it("returns 404 for an unknown id", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/webhooks/whk_nope/rotate-secret", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("bumps secretVersion to 2 and returns a valid 64-hex signing key", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);
    const [before] = await h.db
      .select({ secretVersion: webhookSubscriptions.secretVersion })
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, id));
    expect(before!.secretVersion).toBe(1);

    const res = await fetch(
      new Request(`https://x.test/v1/webhooks/${id}/rotate-secret`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secretVersion: number; signingKey: string };
    expect(body.secretVersion).toBe(2);
    expect(body.signingKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different signing key after rotation", async () => {
    const fetch = makeApp();
    const original = await createSub(fetch);

    const rotateRes = await fetch(
      new Request(`https://x.test/v1/webhooks/${original.id}/rotate-secret`, {
        method: "POST",
      }),
    );
    const rotated = (await rotateRes.json()) as { secretVersion: number; signingKey: string };
    expect(rotated.signingKey).not.toBe(original.signingKey);
  });
});

describe("POST /v1/webhooks/:id/test", () => {
  it("returns 404 for an unknown id", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/webhooks/whk_nope/test", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns { enqueued: true, eventId } and sends the message to the queue", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);

    const res = await fetch(
      new Request(`https://x.test/v1/webhooks/${id}/test`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: boolean; eventId: string };
    expect(body.enqueued).toBe(true);
    expect(body.eventId).toMatch(/^evt_/);

    expect(queueMessages).toHaveLength(1);
    const msg = queueMessages[0] as {
      subscriptionId: string;
      url: string;
      secretVersion: number;
      event: { id: string; type: string };
      attempt: number;
    };
    expect(msg.subscriptionId).toBe(id);
    expect(msg.url).toBe(PUBLIC_HOOK_URL);
    expect(msg.event.type).toBe("release.created");
    expect(msg.attempt).toBe(1);
  });

  it("test idempotency queues once and replays the original event", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);
    const init = {
      method: "POST",
      headers: { "Idempotency-Key": TEST_IDEMPOTENCY_KEY },
    };

    const first = await fetch(new Request(`https://x.test/v1/webhooks/${id}/test`, init));
    const replay = await fetch(new Request(`https://x.test/v1/webhooks/${id}/test`, init));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    expect(queueMessages).toHaveLength(1);
  });

  it("test idempotency keeps headerless requests independent", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);

    await fetch(new Request(`https://x.test/v1/webhooks/${id}/test`, { method: "POST" }));
    await fetch(new Request(`https://x.test/v1/webhooks/${id}/test`, { method: "POST" }));

    expect(queueMessages).toHaveLength(2);
  });

  it("test idempotency conflicts when its key targets another subscription", async () => {
    const fetch = makeApp();
    const first = await createSub(fetch);
    const second = await createSub(fetch, { url: "https://1.1.1.1/another-hook" });

    await fetch(
      new Request(`https://x.test/v1/webhooks/${first.id}/test`, {
        method: "POST",
        headers: { "Idempotency-Key": TEST_IDEMPOTENCY_KEY },
      }),
    );
    const conflict = await fetch(
      new Request(`https://x.test/v1/webhooks/${second.id}/test`, {
        method: "POST",
        headers: { "Idempotency-Key": TEST_IDEMPOTENCY_KEY },
      }),
    );

    expect(conflict.status).toBe(409);
    expect(queueMessages).toHaveLength(1);
  });

  it("test idempotency reports an admin retry as in progress while queueing", async () => {
    let signalStarted!: () => void;
    let releaseSend!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const fetch = makeApp({
      queue: {
        send: async (message) => {
          queueMessages.push(message);
          signalStarted();
          await release;
        },
      },
    });
    const { id } = await createSub(fetch);
    const init = {
      method: "POST",
      headers: { "Idempotency-Key": TEST_IDEMPOTENCY_KEY },
    };
    const first = fetch(new Request(`https://x.test/v1/webhooks/${id}/test`, init));
    await started;
    const pending = await fetch(new Request(`https://x.test/v1/webhooks/${id}/test`, init));
    releaseSend();

    expect(pending.status).toBe(409);
    expect((await pending.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "idempotency_in_progress" },
    });
    expect((await first).status).toBe(200);
    expect(queueMessages).toHaveLength(1);
  });

  it("test idempotency rejects an admin request body before enqueue", async () => {
    const fetch = makeApp();
    const { id } = await createSub(fetch);

    const response = await fetch(
      new Request(`https://x.test/v1/webhooks/${id}/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": TEST_IDEMPOTENCY_KEY,
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(400);
    expect(queueMessages).toHaveLength(0);
  });

  it("returns 503 when WEBHOOK_DELIVERY_QUEUE binding is missing", async () => {
    const fetch = makeApp({ withQueue: false });
    const { id } = await createSub(fetch);

    const res = await fetch(
      new Request(`https://x.test/v1/webhooks/${id}/test`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(503);
  });
});

describe("GET /v1/webhooks/:id/deliveries", () => {
  it("returns 503 (unavailable) when CLOUDFLARE_API_TOKEN is absent", async () => {
    const fetch = makeApp();
    const res = await fetch(new Request("https://x.test/v1/webhooks/whk_test0001/deliveries"));
    // #1830 item 2: off-map 501 folds to `unavailable` (503); the operational
    // code survives on the nested envelope.
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("deliveries_unavailable");
    expect(body.error.type).toBe("unavailable");
  });

  it("returns 400 when id is malformed (does not match whk_ pattern)", async () => {
    const fakeEnv: Record<string, unknown> = {
      DB: h.db,
      WEBHOOK_HMAC_MASTER: { get: async () => TEST_MASTER_KEY },
      WEBHOOK_DELIVERY_QUEUE: { send: async () => {} },
      CLOUDFLARE_API_TOKEN: { get: async () => "fake-token" },
      CLOUDFLARE_ACCOUNT_ID: { get: async () => "fake-account" },
    };
    const app = new Hono();
    const v1 = new Hono();
    v1.route("/", webhooksRoutes);
    app.route("/v1", v1);
    const fetch = (req: Request) => app.fetch(req, fakeEnv);

    const res = await fetch(new Request("https://x.test/v1/webhooks/not-a-real-id/deliveries"));
    expect(res.status).toBe(400);
  });
});
