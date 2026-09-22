import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { webhookSubscriptions } from "@buildinternet/releases-core/schema";
import { SEMANTIC_ALERT_QUERY_MAX_CHARS } from "@buildinternet/releases-api-types";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { semanticAlerts } from "../src/db/schema-semantic-alerts.js";
import { meHandlers } from "../src/routes/me.js";
import { meSemanticAlertHandlers } from "../src/routes/me-semantic-alerts.js";

let h: TestDatabase;

function app(opts: { userId?: string; enabled?: boolean } = {}) {
  const a = new Hono();
  const userId = opts.userId;
  if (userId) {
    a.use("*", async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set("session", {
        user: { id: userId, email: "t@e.com", name: "T" },
      });
      await next();
    });
  }
  a.route("/", meHandlers);
  a.route("/", meSemanticAlertHandlers);
  const env = {
    DB: h.db,
    SEMANTIC_ALERTS_ENABLED: opts.enabled ? "true" : "false",
    FLAGS: undefined,
  } as unknown as Record<string, unknown>;
  return { a, env };
}

async function seedUser(id: string) {
  await h.db.insert(user).values({
    id,
    name: id,
    email: `${id}@e.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(async () => {
  h = createTestDb();
  await seedUser("u1");
});

afterEach(() => h.cleanup());

describe("/v1/me/semantic-alerts", () => {
  it("returns 404 for list and create when the flag is off", async () => {
    const { a, env } = app({ userId: "u1", enabled: false });
    const list = await a.request("/me/semantic-alerts", {}, env);
    expect(list.status).toBe(404);
    const created = await a.request(
      "/me/semantic-alerts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "Slack integrations" }),
      },
      env,
    );
    expect(created.status).toBe(404);
    expect((await h.db.select().from(semanticAlerts)).length).toBe(0);
  });

  it("returns 404 when the flag var is unset", async () => {
    const { a, env } = app({ userId: "u1", enabled: false });
    delete (env as { SEMANTIC_ALERTS_ENABLED?: string }).SEMANTIC_ALERTS_ENABLED;
    const res = await a.request("/me/semantic-alerts", {}, env);
    expect(res.status).toBe(404);
  });

  it("returns 401 without a session even when the flag is on", async () => {
    const { a, env } = app({ enabled: true });
    const res = await a.request("/me/semantic-alerts", {}, env);
    expect(res.status).toBe(401);
  });

  it("creates an alert with defaults and lists only the caller's rows", async () => {
    await seedUser("u2");
    await h.db.insert(semanticAlerts).values({
      id: "sal_other",
      userId: "u2",
      query: "someone else's interest",
      enabled: true,
      threshold: 0.8,
      deliverEmail: true,
      deliverWebhook: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { a, env } = app({ userId: "u1", enabled: true });
    const createdRes = await a.request(
      "/me/semantic-alerts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "  Slack integrations with B2B software  " }),
      },
      env,
    );
    expect(createdRes.status).toBe(201);
    expect(createdRes.headers.get("cache-control")).toBe("private, no-store");
    const created = (await createdRes.json()) as {
      id: string;
      query: string;
      enabled: boolean;
      threshold: number;
      deliverEmail: boolean;
      deliverWebhook: boolean;
      webhookSubscriptionId: string | null;
    };
    expect(created.id).toMatch(/^sal_/);
    expect(created.query).toBe("Slack integrations with B2B software");
    expect(created.enabled).toBe(true);
    expect(created.threshold).toBe(0.8);
    expect(created.deliverEmail).toBe(true);
    expect(created.deliverWebhook).toBe(false);
    expect(created.webhookSubscriptionId).toBeNull();

    const listRes = await a.request("/me/semantic-alerts", {}, env);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      alerts: Array<{ id: string }>;
      candidatePool: string;
      maxAlerts: number;
    };
    expect(list.candidatePool).toBe("follows");
    expect(list.maxAlerts).toBe(5);
    expect(list.alerts.map((row) => row.id)).toEqual([created.id]);

    const foreign = await a.request("/me/semantic-alerts/sal_other", {}, env);
    expect(foreign.status).toBe(404);
  });

  it("rejects an empty query, an over-long query, and a threshold outside 0.50–1.00", async () => {
    const { a, env } = app({ userId: "u1", enabled: true });
    const post = (body: unknown) =>
      a.request(
        "/me/semantic-alerts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        env,
      );

    expect((await post({ query: "   " })).status).toBe(400);
    expect((await post({ query: "x".repeat(SEMANTIC_ALERT_QUERY_MAX_CHARS + 1) })).status).toBe(
      400,
    );
    expect((await post({ query: "ok", threshold: 0.49 })).status).toBe(400);
    expect((await post({ query: "ok", threshold: 1.01 })).status).toBe(400);
    expect((await post({ query: "ok", threshold: "0.8" })).status).toBe(400);
    expect((await post({ query: "ok", enabled: "yes" })).status).toBe(400);
    expect((await post({ query: "ok" })).status).toBe(201);
  });

  it("caps each account at 5 alerts", async () => {
    const { a, env } = app({ userId: "u1", enabled: true });
    for (let i = 0; i < 5; i++) {
      const res = await a.request(
        "/me/semantic-alerts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: `interest ${i}` }),
        },
        env,
      );
      expect(res.status).toBe(201);
    }
    const sixth = await a.request(
      "/me/semantic-alerts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "one more" }),
      },
      env,
    );
    expect(sixth.status).toBe(429);
    const body = (await sixth.json()) as { error: { code: string } };
    expect(body.error.code).toBe("limit_exceeded");
  });

  it("updates enablement, threshold, and a webhook the caller owns", async () => {
    await h.db.insert(webhookSubscriptions).values({
      id: "whk_mine",
      userId: "u1",
      scope: "follows",
      orgId: null,
      url: "https://example.com/hook",
      format: "json",
      enabled: true,
      secretVersion: 1,
      createdAt: new Date().toISOString(),
    });
    await seedUser("u2");
    await h.db.insert(webhookSubscriptions).values({
      id: "whk_theirs",
      userId: "u2",
      scope: "follows",
      orgId: null,
      url: "https://example.com/other",
      format: "json",
      enabled: true,
      secretVersion: 1,
      createdAt: new Date().toISOString(),
    });

    const { a, env } = app({ userId: "u1", enabled: true });
    const created = (await (
      await a.request(
        "/me/semantic-alerts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "B2B Slack" }),
        },
        env,
      )
    ).json()) as { id: string };

    const stolen = await a.request(
      `/me/semantic-alerts/${created.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookSubscriptionId: "whk_theirs" }),
      },
      env,
    );
    expect(stolen.status).toBe(400);

    const patched = await a.request(
      `/me/semantic-alerts/${created.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: false,
          threshold: 0.905,
          deliverWebhook: true,
          webhookSubscriptionId: "whk_mine",
        }),
      },
      env,
    );
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as {
      enabled: boolean;
      threshold: number;
      deliverWebhook: boolean;
      webhookSubscriptionId: string | null;
    };
    expect(body.enabled).toBe(false);
    expect(body.threshold).toBe(0.91);
    expect(body.deliverWebhook).toBe(true);
    expect(body.webhookSubscriptionId).toBe("whk_mine");

    await h.db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, "whk_mine"));
    const after = await a.request(`/me/semantic-alerts/${created.id}`, {}, env);
    const cleared = (await after.json()) as { webhookSubscriptionId: string | null };
    expect(cleared.webhookSubscriptionId).toBeNull();
  });

  it("deletes an owned alert and does not delete someone else's", async () => {
    await seedUser("u2");
    await h.db.insert(semanticAlerts).values({
      id: "sal_other",
      userId: "u2",
      query: "private",
      enabled: true,
      threshold: 0.8,
      deliverEmail: true,
      deliverWebhook: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { a, env } = app({ userId: "u1", enabled: true });
    const created = (await (
      await a.request(
        "/me/semantic-alerts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "mine" }),
        },
        env,
      )
    ).json()) as { id: string };

    expect(
      (await a.request(`/me/semantic-alerts/sal_other`, { method: "DELETE" }, env)).status,
    ).toBe(404);
    const removed = await a.request(`/me/semantic-alerts/${created.id}`, { method: "DELETE" }, env);
    expect(removed.status).toBe(204);
    expect((await a.request(`/me/semantic-alerts/${created.id}`, {}, env)).status).toBe(404);
    const remaining = await h.db.select().from(semanticAlerts);
    expect(remaining.map((row) => row.id)).toEqual(["sal_other"]);
  });

  it("hides alerts on the notifications bootstrap until the flag is on", async () => {
    await h.db.insert(semanticAlerts).values({
      id: "sal_saved",
      userId: "u1",
      query: "edge databases",
      enabled: true,
      threshold: 0.8,
      deliverEmail: true,
      deliverWebhook: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const off = app({ userId: "u1", enabled: false });
    const offRes = await off.a.request("/me/settings/notifications", {}, off.env);
    const offBody = (await offRes.json()) as { semanticAlerts: unknown };
    expect(offBody.semanticAlerts).toBeNull();

    const on = app({ userId: "u1", enabled: true });
    const onRes = await on.a.request("/me/settings/notifications", {}, on.env);
    const onBody = (await onRes.json()) as { semanticAlerts: Array<{ id: string }> | null };
    expect(onBody.semanticAlerts?.map((row) => row.id)).toEqual(["sal_saved"]);
  });
});
