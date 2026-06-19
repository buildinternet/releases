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
const PUBLIC_HOOK_URL = "https://1.1.1.1/hook";
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
    expect(((await test.json()) as { error: string }).error).toBe("rate_limited");
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
