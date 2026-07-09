import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { webhookSubscriptions } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { meHandlers } from "../src/routes/me.js";

let h: TestDatabase;

function app(envExtras: Record<string, unknown> = {}) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    (c as any).set("session", { user: { id: "u1", email: "t@e.com", name: "T" } });
    await next();
  });
  a.route("/", meHandlers);
  return {
    a,
    env: {
      DB: h.db,
      USER_API_KEYS_ENABLED: "false",
      FLAGS: undefined,
      ...envExtras,
    } as unknown as Record<string, unknown>,
  };
}

const BASE = "https://api.releases.sh";

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});
afterEach(() => h.cleanup());

describe("GET /v1/me/settings/notifications", () => {
  it("returns empty defaults when nothing is configured", async () => {
    const { a, env } = app();
    const res = await a.request(`${BASE}/me/settings/notifications`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as {
      cadence: string;
      feedToken: unknown;
      webhooks: unknown[];
    };
    expect(body).toEqual({
      cadence: "off",
      feedToken: null,
      webhooks: [],
    });
  });

  it("composes digest + feed token + webhooks in one response", async () => {
    const { a, env } = app();

    await a.request(
      `${BASE}/me/digest`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cadence: "daily" }),
      },
      env,
    );

    const minted = (await (
      await a.request(`${BASE}/me/feed/token`, { method: "POST" }, env)
    ).json()) as { feedUrl: string; lookupId: string };

    await h.db.insert(webhookSubscriptions).values({
      id: "whk_slack1",
      userId: "u1",
      scope: "follows",
      orgId: null,
      url: "https://hooks.slack.com/services/T00/B00/xxx",
      format: "slack",
      enabled: true,
      description: "Slack channel",
      secretVersion: 1,
      createdAt: new Date().toISOString(),
    });

    const res = await a.request(`${BASE}/me/settings/notifications`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cadence: string;
      feedToken: { feedUrl: string; lookupId: string } | null;
      webhooks: Array<{ id: string; scope: string; format: string }>;
    };
    expect(body.cadence).toBe("daily");
    expect(body.feedToken?.feedUrl).toBe(minted.feedUrl);
    expect(body.feedToken?.lookupId).toBe(minted.lookupId);
    expect(body.webhooks).toHaveLength(1);
    expect(body.webhooks[0]!.id).toBe("whk_slack1");
    expect(body.webhooks[0]!.scope).toBe("follows");
    expect(body.webhooks[0]!.format).toBe("slack");
  });

  it("returns 401 without a session", async () => {
    const a = new Hono();
    a.route("/", meHandlers);
    const res = await a.request(`${BASE}/me/settings/notifications`, {}, {
      DB: h.db,
    } as unknown as Record<string, unknown>);
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/me/settings/developer", () => {
  it("returns webhooks and null apiKeys when user keys are disabled", async () => {
    const { a, env } = app({ USER_API_KEYS_ENABLED: "false" });
    await h.db.insert(webhookSubscriptions).values({
      id: "whk_dev1",
      userId: "u1",
      scope: "follows",
      orgId: null,
      url: "https://example.com/hook",
      format: "json",
      enabled: true,
      secretVersion: 1,
      createdAt: new Date().toISOString(),
    });

    const res = await a.request(`${BASE}/me/settings/developer`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as {
      webhooks: Array<{ id: string }>;
      apiKeys: unknown;
    };
    expect(body.webhooks).toHaveLength(1);
    expect(body.webhooks[0]!.id).toBe("whk_dev1");
    expect(body.apiKeys).toBeNull();
  });

  it("returns empty webhooks + empty apiKeys when keys enabled and nothing configured", async () => {
    const { a, env } = app({ USER_API_KEYS_ENABLED: "true" });
    const res = await a.request(`${BASE}/me/settings/developer`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webhooks: unknown[]; apiKeys: unknown[] | null };
    expect(body.webhooks).toEqual([]);
    expect(body.apiKeys).toEqual([]);
  });

  it("returns 401 without a session", async () => {
    const a = new Hono();
    a.route("/", meHandlers);
    const res = await a.request(`${BASE}/me/settings/developer`, {}, {
      DB: h.db,
      USER_API_KEYS_ENABLED: "false",
    } as unknown as Record<string, unknown>);
    expect(res.status).toBe(401);
  });
});
