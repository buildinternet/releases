import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { eq } from "drizzle-orm";
import {
  organizations,
  products,
  sources,
  webhookSubscriptions,
} from "@buildinternet/releases-core/schema";
import { user } from "../src/db/schema-auth.js";

import { meWebhookHandlers } from "../src/routes/me-webhooks.js";

const TEST_MASTER_KEY = "a".repeat(64);
const IDEMPOTENCY_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const IDEMPOTENCY_KEY = "webhook-create-01";
const TEST_IDEMPOTENCY_KEY = "webhook-test-idem-01";
const PUBLIC_HOOK_URL = "https://1.1.1.1/hook";
const SLACK_HOOK_URL = "https://hooks.slack.com/services/T012AB/B034CD/Xy7zSecret";
const queueMessages: unknown[] = [];

let h: TestDatabase;

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    (c as any).set("session", { user: { id: "u1", email: "t@e.com", name: "T" } });
    await next();
  });
  a.route("/", meWebhookHandlers);
  const env = {
    DB: h.db,
    IDEMPOTENCY_ENCRYPTION_KEY: { get: async () => IDEMPOTENCY_SECRET },
    WEBHOOK_HMAC_MASTER: { get: async () => TEST_MASTER_KEY },
    WEBHOOK_DELIVERY_QUEUE: {
      send: async (msg: unknown) => {
        queueMessages.push(msg);
      },
    },
  } as unknown as Record<string, unknown>;
  return { a, env };
}

beforeEach(async () => {
  h = createTestDb();
  queueMessages.length = 0;
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db.insert(sources).values({
    id: "src_s",
    name: "Changelog",
    slug: "changelog",
    orgId: "org_a",
    url: "https://acme.test/changelog",
    type: "scrape",
  });
});

afterEach(() => h.cleanup());

describe("/v1/me/webhooks", () => {
  it("POST creates a subscription by orgSlug and returns signing key", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgSlug: "acme",
          url: PUBLIC_HOOK_URL,
          description: "my hook",
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      userId: string;
      orgId: string;
      orgSlug: string;
      signingKey: string;
    };
    expect(body.id).toMatch(/^whk_/);
    expect(body.userId).toBe("u1");
    expect(body.orgId).toBe("org_a");
    expect(body.orgSlug).toBe("acme");
    expect(body.signingKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("idempotency replays a webhook signing key and creates only one subscription", async () => {
    const { a, env } = app();
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
    };
    const first = await a.request("/me/webhooks", init, env);
    const firstText = await first.clone().text();
    const replay = await a.request("/me/webhooks", init, env);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.text()).toBe(firstText);
    expect((await h.db.select().from(webhookSubscriptions)).length).toBe(1);
  });

  it("idempotency replays a follows subscription after its quota is full", async () => {
    const { a, env } = app();
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "webhook-follows-01" },
      body: JSON.stringify({ scope: "follows", url: PUBLIC_HOOK_URL }),
    };
    expect((await a.request("/me/webhooks", init, env)).status).toBe(201);
    const replay = await a.request("/me/webhooks", init, env);

    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await h.db.select().from(webhookSubscriptions)).length).toBe(1);
  });

  it("idempotency replays the tenth org subscription after its quota is full", async () => {
    await h.db.insert(webhookSubscriptions).values(
      Array.from({ length: 9 }, (_, index) => ({
        id: `whk_seed_${index}`,
        scope: "org" as const,
        userId: "u1",
        orgId: "org_a",
        url: `https://1.1.1.1/seed-${index}`,
        description: null,
      })),
    );
    const { a, env } = app();
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "webhook-org-tenth" },
      body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
    };
    expect((await a.request("/me/webhooks", init, env)).status).toBe(201);
    const replay = await a.request("/me/webhooks", init, env);

    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await h.db.select().from(webhookSubscriptions)).length).toBe(10);
  });

  it("idempotency conflicts on a changed webhook target and leaves validation failures reusable", async () => {
    const { a, env } = app();
    const headers = { "Content-Type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY };
    expect(
      (
        await a.request(
          "/me/webhooks",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ orgSlug: "acme", url: "http://invalid.test/hook" }),
          },
          env,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await a.request(
          "/me/webhooks",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
          },
          env,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await a.request(
          "/me/webhooks",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ orgSlug: "acme", url: "https://1.1.1.1/changed" }),
          },
          env,
        )
      ).status,
    ).toBe(409);
  });

  it("idempotency requires encryption before creating a webhook", async () => {
    const { a, env } = app();
    const { IDEMPOTENCY_ENCRYPTION_KEY: _secret, ...withoutSecret } = env;
    const response = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "webhook-create-02" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      withoutSecret,
    );
    expect(response.status).toBe(503);
    expect((await h.db.select().from(webhookSubscriptions)).length).toBe(0);
  });

  it("enforces exact UTF-8 byte boundaries for webhook URLs and descriptions", async () => {
    const { a, env } = app();
    expect(
      (
        await a.request(
          "/me/webhooks",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orgSlug: "acme", url: `https://1.1.1.1/${"a".repeat(2032)}` }),
          },
          env,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await a.request(
          "/me/webhooks",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orgSlug: "acme", url: `https://1.1.1.1/${"a".repeat(2033)}` }),
          },
          env,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await a.request(
          "/me/webhooks",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orgSlug: "acme",
              url: PUBLIC_HOOK_URL,
              description: "é".repeat(500),
            }),
          },
          env,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await a.request(
          "/me/webhooks",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orgSlug: "acme",
              url: PUBLIC_HOOK_URL,
              description: "é".repeat(500) + "a",
            }),
          },
          env,
        )
      ).status,
    ).toBe(400);
  });

  it("POST with productSlug and releaseType stores filters", async () => {
    await h.db.insert(products).values({
      id: "prd_app",
      name: "App",
      slug: "app",
      orgId: "org_a",
    });
    const { a, env } = app();
    const res = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgSlug: "acme",
          productSlug: "app",
          releaseType: "feature",
          url: PUBLIC_HOOK_URL,
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { productId: string; releaseType: string };
    expect(body.productId).toBe("prd_app");
    expect(body.releaseType).toBe("feature");
  });

  it("POST with sourceSlug scopes to that source", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgSlug: "acme",
          sourceSlug: "changelog",
          url: PUBLIC_HOOK_URL,
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sourceId: string };
    expect(body.sourceId).toBe("src_s");
  });

  it("POST unknown org → 404", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "nope", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("POST non-HTTPS url → 400", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: "http://insecure/hook" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("POST scope follows creates a follows-scoped subscription", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "follows", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      scope: string;
      orgId: string | null;
      orgSlug: string | null;
    };
    expect(body.scope).toBe("follows");
    expect(body.orgId).toBeNull();
    expect(body.orgSlug).toBeNull();
  });

  it("POST scope follows rejects org/source fields", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "follows", orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("POST scope follows is capped at one per account", async () => {
    const { a, env } = app();
    const first = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "follows", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    expect(first.status).toBe(201);

    const second = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "follows", url: "https://8.8.8.8/hook" }),
      },
      env,
    );
    expect(second.status).toBe(429);
  });

  it("POST private IP url → 400", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: "https://127.0.0.1/hook" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("POST format slack with a non-Slack host → 400", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL, format: "slack" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("POST format slack → 201 with format slack and no signingKey", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: SLACK_HOOK_URL, format: "slack" }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { format: string; signingKey?: string };
    expect(body.format).toBe("slack");
    expect(body.signingKey).toBeUndefined();
  });

  it("PATCH format slack re-validates the Slack host", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };

    const bad = await a.request(
      `/me/webhooks/${id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "slack" }),
      },
      env,
    );
    expect(bad.status).toBe(400);

    const ok = await a.request(
      `/me/webhooks/${id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "slack", url: SLACK_HOOK_URL }),
      },
      env,
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { format: string }).format).toBe("slack");
  });

  it("PATCH url on an existing slack subscription re-validates the host", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: SLACK_HOOK_URL, format: "slack" }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };

    const bad = await a.request(
      `/me/webhooks/${id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    expect(bad.status).toBe(400);

    const ok = await a.request(
      `/me/webhooks/${id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://hooks.slack-gov.com/services/T1/B2/secret" }),
      },
      env,
    );
    expect(ok.status).toBe(200);
  });

  it("GET lists only the caller's subscriptions with enriched fields", async () => {
    const { a, env } = app();
    await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const list = await a.request("/me/webhooks", {}, env);
    const body = (await list.json()) as {
      subscriptions: Array<{ orgSlug: string; sourceSlug: string | null }>;
    };
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].orgSlug).toBe("acme");
    expect(body.subscriptions[0].sourceSlug).toBeNull();
  });

  it("another user cannot read or delete a subscription", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };

    const other = new Hono();
    other.use("*", async (c, next) => {
      (c as any).set("session", { user: { id: "u2", email: "x@e.com", name: "X" } });
      await next();
    });
    other.route("/", meWebhookHandlers);
    const otherEnv = { ...env };

    const getRes = await other.request(`/me/webhooks/${id}`, {}, otherEnv);
    expect(getRes.status).toBe(404);

    const delRes = await other.request(`/me/webhooks/${id}`, { method: "DELETE" }, otherEnv);
    expect(delRes.status).toBe(404);
  });

  it("PATCH enable clears failure counters", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };

    await a.request(
      `/me/webhooks/${id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
      env,
    );
    const enable = await a.request(
      `/me/webhooks/${id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
      env,
    );
    const body = (await enable.json()) as {
      enabled: boolean;
      consecutiveFailures: number;
      disabledReason: string | null;
    };
    expect(body.enabled).toBe(true);
    expect(body.consecutiveFailures).toBe(0);
    expect(body.disabledReason).toBeNull();
  });

  it("POST test enqueues a synthetic delivery", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };

    const test = await a.request(`/me/webhooks/${id}/test`, { method: "POST" }, env);
    expect(test.status).toBe(200);
    expect(queueMessages).toHaveLength(1);
  });

  it("POST test idempotency replays one queued event", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };
    const init = { method: "POST", headers: { "Idempotency-Key": TEST_IDEMPOTENCY_KEY } };

    const first = await a.request(`/me/webhooks/${id}/test`, init, env);
    const replay = await a.request(`/me/webhooks/${id}/test`, init, env);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    expect(queueMessages).toHaveLength(1);
  });

  it("POST test idempotency rejects an opted-in non-empty body before enqueue", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };

    const res = await a.request(
      `/me/webhooks/${id}/test`,
      {
        method: "POST",
        headers: { "Idempotency-Key": TEST_IDEMPOTENCY_KEY, "Content-Type": "application/json" },
        body: "{}",
      },
      env,
    );

    expect(res.status).toBe(400);
    expect(queueMessages).toHaveLength(0);
  });

  it("POST test idempotency conflicts when its key targets another subscription", async () => {
    const { a, env } = app();
    const create = async () => {
      const res = await a.request(
        "/me/webhooks",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
        },
        env,
      );
      return (await res.json()) as { id: string };
    };
    const firstSub = await create();
    const secondSub = await create();

    await a.request(
      `/me/webhooks/${firstSub.id}/test`,
      { method: "POST", headers: { "Idempotency-Key": TEST_IDEMPOTENCY_KEY } },
      env,
    );
    const conflict = await a.request(
      `/me/webhooks/${secondSub.id}/test`,
      { method: "POST", headers: { "Idempotency-Key": TEST_IDEMPOTENCY_KEY } },
      env,
    );

    expect(conflict.status).toBe(409);
    expect(queueMessages).toHaveLength(1);
  });

  it("POST test idempotency applies its winner-only limiter once", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };
    let limits = 0;
    const limitedEnv = {
      ...env,
      WEBHOOK_TEST_SUB_RATE_LIMITER: {
        limit: async () => {
          limits++;
          return { success: true };
        },
      },
    };
    const init = { method: "POST", headers: { "Idempotency-Key": TEST_IDEMPOTENCY_KEY } };

    await a.request(`/me/webhooks/${id}/test`, init, limitedEnv);
    await a.request(`/me/webhooks/${id}/test`, init, limitedEnv);

    expect(limits).toBe(1);
  });

  it("POST test idempotency reports a matching queued request as in progress", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };
    let signalStarted!: () => void;
    let releaseSend!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const pendingEnv = {
      ...env,
      WEBHOOK_DELIVERY_QUEUE: {
        send: async (message: unknown) => {
          queueMessages.push(message);
          signalStarted();
          await release;
        },
      },
    };
    const init = { method: "POST", headers: { "Idempotency-Key": TEST_IDEMPOTENCY_KEY } };
    const first = a.request(`/me/webhooks/${id}/test`, init, pendingEnv);
    await started;
    const pending = await a.request(`/me/webhooks/${id}/test`, init, pendingEnv);
    releaseSend();

    expect(pending.status).toBe(409);
    expect(
      (await pending.json()) as {
        error: { code: string; type: string; message: string };
      },
    ).toEqual({
      error: {
        code: "idempotency_in_progress",
        type: "conflict",
        message: "A matching request is already in progress",
      },
    });
    expect((await first).status).toBe(200);
    expect(queueMessages).toHaveLength(1);
  });

  it("POST test returns 429 when the per-subscription limiter rejects", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };

    const limitedEnv = {
      ...env,
      WEBHOOK_TEST_SUB_RATE_LIMITER: { limit: async () => ({ success: false }) },
      WEBHOOK_TEST_USER_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };

    const test = await a.request(`/me/webhooks/${id}/test`, { method: "POST" }, limitedEnv);
    expect(test.status).toBe(429);
    const body = (await test.json()) as {
      error: { code: string; type: string; message: string };
    };
    expect(body).toEqual({
      error: {
        code: "rate_limited",
        type: "rate_limited",
        message: "Webhook test limit exceeded for this subscription (5 per minute)",
      },
    });
    expect(test.headers.get("Retry-After")).toBe("60");
    expect(queueMessages).toHaveLength(0);
  });

  it("GET detail includes delivery health from summary columns", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };

    const detail = await a.request(`/me/webhooks/${id}`, {}, env);
    const body = (await detail.json()) as {
      deliveryHealth: string;
      deliveryHealthSummary: string;
    };
    expect(body.deliveryHealth).toBe("never_delivered");
    expect(body.deliveryHealthSummary).toContain("No deliveries");
  });

  it("GET list reports degraded health after failures", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };

    await h.db
      .update(webhookSubscriptions)
      .set({
        consecutiveFailures: 2,
        lastErrorAt: new Date().toISOString(),
        lastErrorMsg: "timeout",
        failureStreakStartedAt: new Date().toISOString(),
      })
      .where(eq(webhookSubscriptions.id, id));

    const list = await a.request("/me/webhooks", {}, env);
    const body = (await list.json()) as {
      subscriptions: Array<{ deliveryHealth: string; deliveryHealthSummary: string }>;
    };
    expect(body.subscriptions[0].deliveryHealth).toBe("degraded");
    expect(body.subscriptions[0].deliveryHealthSummary).toContain("Intermittent");
  });

  it("DELETE removes the subscription", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };

    const del = await a.request(`/me/webhooks/${id}`, { method: "DELETE" }, env);
    expect(del.status).toBe(204);

    const list = await a.request("/me/webhooks", {}, env);
    expect(((await list.json()) as { subscriptions: unknown[] }).subscriptions).toHaveLength(0);
  });
});

describe("POST /v1/me/webhooks/:id/rotate-secret", () => {
  async function createSubscription() {
    const { a, env } = app();
    const response = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    return { a, env, id: ((await response.json()) as { id: string }).id };
  }

  it("idempotency replays the rotated signing key and increments once", async () => {
    const { a, env, id } = await createSubscription();
    const init = { method: "POST", headers: { "Idempotency-Key": "webhook-rotate-01" } };
    const first = await a.request(`/me/webhooks/${id}/rotate-secret`, init, env);
    const replay = await a.request(`/me/webhooks/${id}/rotate-secret`, init, env);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.text()).toBe(await first.clone().text());
    expect(
      (await h.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).get())
        ?.secretVersion,
    ).toBe(2);
  });

  it("idempotency rejects a rotation body before version change and fails closed without encryption", async () => {
    const { a, env, id } = await createSubscription();
    const bodyRejected = await a.request(
      `/me/webhooks/${id}/rotate-secret`,
      { method: "POST", headers: { "Idempotency-Key": "webhook-rotate-02" }, body: "unexpected" },
      env,
    );
    expect(bodyRejected.status).toBe(400);
    expect(
      (await h.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).get())
        ?.secretVersion,
    ).toBe(1);

    const { IDEMPOTENCY_ENCRYPTION_KEY: _secret, ...withoutSecret } = env;
    const unavailable = await a.request(
      `/me/webhooks/${id}/rotate-secret`,
      { method: "POST", headers: { "Idempotency-Key": "webhook-rotate-03" } },
      withoutSecret,
    );
    expect(unavailable.status).toBe(503);
    expect(
      (await h.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).get())
        ?.secretVersion,
    ).toBe(1);
  });

  it("keeps headerless rotations non-idempotent", async () => {
    const { a, env, id } = await createSubscription();
    expect(
      (await a.request(`/me/webhooks/${id}/rotate-secret`, { method: "POST" }, env)).status,
    ).toBe(200);
    expect(
      (await a.request(`/me/webhooks/${id}/rotate-secret`, { method: "POST" }, env)).status,
    ).toBe(200);
    expect(
      (await h.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).get())
        ?.secretVersion,
    ).toBe(3);
  });
});

describe("GET /v1/me/webhooks/:id/deliveries", () => {
  it("accepts nanoid ids that contain hyphens", async () => {
    const { a, env } = app();
    const hyphenId = "whk_Ab-c123XYZ01234";
    await h.db.insert(webhookSubscriptions).values({
      id: hyphenId,
      userId: "u1",
      orgId: "org_a",
      url: PUBLIC_HOOK_URL,
      secretVersion: 1,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;

    try {
      const res = await a.request(
        `/me/webhooks/${hyphenId}/deliveries`,
        {},
        {
          ...env,
          CLOUDFLARE_API_TOKEN: { get: async () => "token" },
          CLOUDFLARE_ACCOUNT_ID: { get: async () => "acct" },
        },
      );
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns 503 (unavailable) when Cloudflare Analytics creds are absent", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };

    const res = await a.request(`/me/webhooks/${id}/deliveries`, {}, env);
    // #1830 item 2: off-map 501 folds to `unavailable` (503); the operational
    // code survives on the nested envelope.
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("deliveries_unavailable");
    expect(body.error.type).toBe("unavailable");
  });

  it("returns delivery rows when Analytics Engine responds", async () => {
    const { a, env } = app();
    const create = await a.request(
      "/me/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const { id } = (await create.json()) as { id: string };
    expect(id).toMatch(/^whk_[A-Za-z0-9_-]+$/);

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              timestamp: "2026-06-19 12:00:00",
              event_id: "evt_test",
              outcome: "success",
              format: "slack",
              http_status: 200,
              latency_ms: 42,
              attempt: 1,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    try {
      const res = await a.request(
        `/me/webhooks/${id}/deliveries`,
        {},
        {
          ...env,
          CLOUDFLARE_API_TOKEN: { get: async () => "token" },
          CLOUDFLARE_ACCOUNT_ID: { get: async () => "acct" },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ event_id: string; format: string }> };
      expect(body.data[0]?.event_id).toBe("evt_test");
      expect(body.data[0]?.format).toBe("slack");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
