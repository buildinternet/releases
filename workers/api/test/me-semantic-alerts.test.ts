import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { releasePath } from "@buildinternet/releases-core/release-slug";
import {
  organizations,
  releases,
  sources,
  webhookSubscriptions,
} from "@buildinternet/releases-core/schema";
import { SEMANTIC_ALERT_QUERY_MAX_CHARS } from "@buildinternet/releases-api-types";
import type { SemanticAlertActivity } from "@buildinternet/releases-api-types";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { semanticAlertMatches, semanticAlerts } from "../src/db/schema-semantic-alerts.js";
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
    const onBody = (await onRes.json()) as {
      semanticAlerts: Array<{ id: string; activity: SemanticAlertActivity }> | null;
    };
    expect(onBody.semanticAlerts?.map((row) => row.id)).toEqual(["sal_saved"]);
    expect(onBody.semanticAlerts?.[0]?.activity).toEqual({
      matches7d: 0,
      matches30d: 0,
      lastMatchedAt: null,
      lastMatch: null,
    });
  });

  it("omits activity on create, update, and single-get", async () => {
    const { a, env } = app({ userId: "u1", enabled: true });
    const createdRes = await a.request(
      "/me/semantic-alerts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "edge databases" }),
      },
      env,
    );
    const created = (await createdRes.json()) as { id: string; activity?: unknown };
    expect(created).not.toHaveProperty("activity");

    const patched = await a.request(
      `/me/semantic-alerts/${created.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "edge databases in production" }),
      },
      env,
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).not.toHaveProperty("activity");

    const one = await a.request(`/me/semantic-alerts/${created.id}`, {}, env);
    expect(await one.json()).not.toHaveProperty("activity");
  });

  it("attaches batched match activity on the list", async () => {
    const recentId = "rel_0123456789abcdefghijk";
    const olderId = "rel_abcdefghijklmnopqrstu";
    const quietId = "rel_zzzzzzzzzzzzzzzzzzzzz";
    await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
    await h.db.insert(sources).values({
      id: "src_a",
      name: "Changelog",
      slug: "changelog",
      type: "feed",
      url: "https://example.com/changelog",
      orgId: "org_a",
    });
    await h.db.insert(releases).values([
      {
        id: recentId,
        sourceId: "src_a",
        title: "A very long changelog title about Slack",
        titleShort: "Slack finance",
        content: "notes",
        url: "https://example.com/slack-recent",
        publishedAt: new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
      },
      {
        id: olderId,
        sourceId: "src_a",
        title: "Older note",
        content: "notes",
        url: "https://example.com/older",
        publishedAt: new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
      },
      {
        id: quietId,
        sourceId: "src_a",
        title: "Quiet release",
        content: "notes",
        url: "https://example.com/quiet",
        publishedAt: new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
      },
    ]);

    const recentAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    await h.db.insert(semanticAlerts).values([
      {
        id: "sal_active",
        userId: "u1",
        query: "Slack integrations",
        enabled: true,
        threshold: 0.8,
        deliverEmail: true,
        deliverWebhook: false,
        createdAt: new Date("2026-09-20T00:00:00.000Z"),
        updatedAt: new Date("2026-09-20T00:00:00.000Z"),
      },
      {
        id: "sal_quiet",
        userId: "u1",
        query: "quiet interest",
        enabled: true,
        threshold: 0.8,
        deliverEmail: true,
        deliverWebhook: false,
        createdAt: new Date("2026-09-19T00:00:00.000Z"),
        updatedAt: new Date("2026-09-19T00:00:00.000Z"),
      },
      {
        id: "sal_gone",
        userId: "u1",
        query: "missing release",
        enabled: true,
        threshold: 0.8,
        deliverEmail: true,
        deliverWebhook: false,
        createdAt: new Date("2026-09-18T00:00:00.000Z"),
        updatedAt: new Date("2026-09-18T00:00:00.000Z"),
      },
    ]);
    await seedUser("u2");
    await h.db.insert(semanticAlerts).values({
      id: "sal_other",
      userId: "u2",
      query: "someone else",
      enabled: true,
      threshold: 0.8,
      deliverEmail: true,
      deliverWebhook: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await h.db.insert(semanticAlertMatches).values([
      {
        alertId: "sal_active",
        releaseId: recentId,
        probability: 0.91,
        createdAt: recentAt,
      },
      {
        alertId: "sal_active",
        releaseId: olderId,
        probability: 0.88,
        createdAt: tenDaysAgo,
      },
      {
        alertId: "sal_quiet",
        releaseId: quietId,
        probability: 0.95,
        createdAt: fortyDaysAgo,
      },
      {
        alertId: "sal_gone",
        releaseId: "rel_missingmissingmissing1",
        probability: 0.9,
        createdAt: fiveDaysAgo,
      },
      {
        alertId: "sal_other",
        releaseId: recentId,
        probability: 0.99,
        createdAt: recentAt,
      },
    ]);

    const { a, env } = app({ userId: "u1", enabled: true });
    const listRes = await a.request("/me/semantic-alerts", {}, env);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      alerts: Array<{ id: string; activity: SemanticAlertActivity }>;
    };
    const byId = new Map(list.alerts.map((row) => [row.id, row.activity]));

    const active = byId.get("sal_active");
    expect(active?.matches7d).toBe(1);
    expect(active?.matches30d).toBe(2);
    expect(Math.floor(new Date(active?.lastMatchedAt ?? 0).getTime() / 1000)).toBe(
      Math.floor(recentAt.getTime() / 1000),
    );
    expect(active?.lastMatch).toEqual({
      releaseId: recentId,
      title: "Slack finance",
      path: releasePath({
        id: recentId,
        titleShort: "Slack finance",
        title: "A very long changelog title about Slack",
      }),
    });
    expect(JSON.stringify(active)).not.toContain("probability");

    const quiet = byId.get("sal_quiet");
    expect(quiet?.matches7d).toBe(0);
    expect(quiet?.matches30d).toBe(0);
    expect(quiet?.lastMatch?.title).toBe("Quiet release");
    expect(Math.floor(new Date(quiet?.lastMatchedAt ?? 0).getTime() / 1000)).toBe(
      Math.floor(fortyDaysAgo.getTime() / 1000),
    );

    const gone = byId.get("sal_gone");
    expect(gone?.matches7d).toBe(1);
    expect(gone?.matches30d).toBe(1);
    expect(gone?.lastMatchedAt).not.toBeNull();
    expect(gone?.lastMatch).toBeNull();

    expect(byId.has("sal_other")).toBe(false);
  });

  it("plans match activity reads on (alert_id, created_at)", async () => {
    const indexes = await h.db.all<{ name: string }>(sql`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_semantic_alert_matches_alert_created'
    `);
    expect(indexes.map((row) => row.name)).toEqual(["idx_semantic_alert_matches_alert_created"]);

    const latestPlan = await h.db.all<{ detail: string }>(sql`
      EXPLAIN QUERY PLAN
      SELECT alert_id, release_id, created_at
      FROM semantic_alert_matches
      WHERE alert_id = 'sal_saved'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    expect(latestPlan.map((row) => row.detail).join("\n")).toContain(
      "idx_semantic_alert_matches_alert_created",
    );

    const countPlan = await h.db.all<{ detail: string }>(sql`
      EXPLAIN QUERY PLAN
      SELECT alert_id, COUNT(*)
      FROM semantic_alert_matches
      WHERE alert_id = 'sal_saved' AND created_at >= 0
      GROUP BY alert_id
    `);
    expect(countPlan.map((row) => row.detail).join("\n")).toContain(
      "idx_semantic_alert_matches_alert_created",
    );
  });
});
