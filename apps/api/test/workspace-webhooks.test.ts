import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { eq } from "drizzle-orm";
import { organizations, sources, webhookSubscriptions } from "@buildinternet/releases-core/schema";
import { user, authOrganization, authMember } from "../src/db/schema-auth.js";

import { workspaceWebhookHandlers } from "../src/routes/workspace-webhooks.js";
import { meWebhookHandlers } from "../src/routes/me-webhooks.js";

const TEST_MASTER_KEY = "a".repeat(64);
const IDEMPOTENCY_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const PUBLIC_HOOK_URL = "https://1.1.1.1/hook";
const WORKSPACE_ID = "org_ws1";
const OWNER_ID = "u_owner";
const ADMIN_ID = "u_admin";
const MEMBER_ID = "u_member";
const OUTSIDER_ID = "u_outsider";

let h: TestDatabase;
let queueMessages: unknown[];

function app(userId: string) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    (c as any).set("session", { user: { id: userId, email: `${userId}@e.com`, name: userId } });
    await next();
  });
  a.route("/", workspaceWebhookHandlers);
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

async function seedUser(id: string) {
  await h.db.insert(user).values({
    id,
    name: id,
    email: `${id}@e.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(async () => {
  h = createTestDb();
  queueMessages = [];
  await seedUser(OWNER_ID);
  await seedUser(ADMIN_ID);
  await seedUser(MEMBER_ID);
  await seedUser(OUTSIDER_ID);

  await h.db
    .insert(authOrganization)
    .values({ id: WORKSPACE_ID, name: "Acme Workspace", slug: "acme-ws" });
  await h.db.insert(authMember).values([
    { id: "mem_owner", organizationId: WORKSPACE_ID, userId: OWNER_ID, role: "owner" },
    { id: "mem_admin", organizationId: WORKSPACE_ID, userId: ADMIN_ID, role: "admin" },
    { id: "mem_member", organizationId: WORKSPACE_ID, userId: MEMBER_ID, role: "member" },
  ]);

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

describe("/v1/workspaces/:workspaceId/webhooks", () => {
  it("404s for a non-member", async () => {
    const { a, env } = app(OUTSIDER_ID);
    const res = await a.request(`/workspaces/${WORKSPACE_ID}/webhooks`, {}, env);
    expect(res.status).toBe(404);
  });

  it("owner can create, list, get, patch, rotate, test, and delete", async () => {
    const { a, env } = app(OWNER_ID);
    const createRes = await a.request(
      `/workspaces/${WORKSPACE_ID}/webhooks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL, description: "team hook" }),
      },
      env,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      workspaceId: string;
      scope: string;
      signingKey: string;
    };
    expect(created.workspaceId).toBe(WORKSPACE_ID);
    expect(created.scope).toBe("org");
    expect(created.signingKey).toMatch(/^[0-9a-f]{64}$/);

    const listRes = await a.request(`/workspaces/${WORKSPACE_ID}/webhooks`, {}, env);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      subscriptions: Array<{ id: string; workspaceId: string }>;
      role: string;
      canManage: boolean;
    };
    expect(list.subscriptions).toHaveLength(1);
    expect(list.subscriptions[0]!.workspaceId).toBe(WORKSPACE_ID);
    expect(list.role).toBe("owner");
    expect(list.canManage).toBe(true);

    const getRes = await a.request(`/workspaces/${WORKSPACE_ID}/webhooks/${created.id}`, {}, env);
    expect(getRes.status).toBe(200);

    const patchRes = await a.request(
      `/workspaces/${WORKSPACE_ID}/webhooks/${created.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "updated" }),
      },
      env,
    );
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { description: string }).description).toBe("updated");

    const rotateRes = await a.request(
      `/workspaces/${WORKSPACE_ID}/webhooks/${created.id}/rotate-secret`,
      { method: "POST" },
      env,
    );
    expect(rotateRes.status).toBe(200);

    const testRes = await a.request(
      `/workspaces/${WORKSPACE_ID}/webhooks/${created.id}/test`,
      { method: "POST" },
      env,
    );
    expect(testRes.status).toBe(200);
    expect(queueMessages).toHaveLength(1);

    const deleteRes = await a.request(
      `/workspaces/${WORKSPACE_ID}/webhooks/${created.id}`,
      { method: "DELETE" },
      env,
    );
    expect(deleteRes.status).toBe(204);
    expect((await h.db.select().from(webhookSubscriptions)).length).toBe(0);
  });

  it("admin has the same manage rights as owner", async () => {
    const { a, env } = app(ADMIN_ID);
    const res = await a.request(
      `/workspaces/${WORKSPACE_ID}/webhooks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    expect(res.status).toBe(201);
  });

  it("member can list/get/test but not create/patch/delete/rotate", async () => {
    const owner = app(OWNER_ID);
    const createRes = await owner.a.request(
      `/workspaces/${WORKSPACE_ID}/webhooks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      owner.env,
    );
    const created = (await createRes.json()) as { id: string };

    const { a, env } = app(MEMBER_ID);
    expect((await a.request(`/workspaces/${WORKSPACE_ID}/webhooks`, {}, env)).status).toBe(200);
    expect(
      (await a.request(`/workspaces/${WORKSPACE_ID}/webhooks/${created.id}`, {}, env)).status,
    ).toBe(200);
    expect(
      (
        await a.request(
          `/workspaces/${WORKSPACE_ID}/webhooks/${created.id}/test`,
          { method: "POST" },
          env,
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await a.request(
          `/workspaces/${WORKSPACE_ID}/webhooks`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orgSlug: "acme", url: "https://1.1.1.1/other" }),
          },
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await a.request(
          `/workspaces/${WORKSPACE_ID}/webhooks/${created.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ description: "nope" }),
          },
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await a.request(
          `/workspaces/${WORKSPACE_ID}/webhooks/${created.id}`,
          { method: "DELETE" },
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await a.request(
          `/workspaces/${WORKSPACE_ID}/webhooks/${created.id}/rotate-secret`,
          { method: "POST" },
          env,
        )
      ).status,
    ).toBe(403);
  });

  it("rejects scope: follows with 400 bad_request", async () => {
    const { a, env } = app(OWNER_ID);
    const res = await a.request(
      `/workspaces/${WORKSPACE_ID}/webhooks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "follows", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("enforces the 10-subscription cap per workspace", async () => {
    await h.db.insert(webhookSubscriptions).values(
      Array.from({ length: 10 }, (_, index) => ({
        id: `whk_seed_${index}`,
        scope: "org" as const,
        workspaceId: WORKSPACE_ID,
        orgId: "org_a",
        url: `https://1.1.1.1/seed-${index}`,
        description: null,
      })),
    );
    const { a, env } = app(OWNER_ID);
    const res = await a.request(
      `/workspaces/${WORKSPACE_ID}/webhooks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("limit_exceeded");
  });

  it("404s a webhook accessed through another workspace's path", async () => {
    const otherWorkspaceId = "org_ws2";
    await h.db
      .insert(authOrganization)
      .values({ id: otherWorkspaceId, name: "Other", slug: "other-ws" });
    await h.db.insert(authMember).values({
      id: "mem_owner2",
      organizationId: otherWorkspaceId,
      userId: OWNER_ID,
      role: "owner",
    });

    const { a, env } = app(OWNER_ID);
    const createRes = await a.request(
      `/workspaces/${WORKSPACE_ID}/webhooks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    const created = (await createRes.json()) as { id: string };

    const crossRes = await a.request(
      `/workspaces/${otherWorkspaceId}/webhooks/${created.id}`,
      {},
      env,
    );
    expect(crossRes.status).toBe(404);
  });

  it("workspace-owned rows are absent from /v1/me/webhooks", async () => {
    const { a, env } = app(OWNER_ID);
    await a.request(
      `/workspaces/${WORKSPACE_ID}/webhooks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );

    const meRes = await a.request("/me/webhooks", {}, env);
    const meList = (await meRes.json()) as { subscriptions: unknown[] };
    expect(meList.subscriptions).toHaveLength(0);
  });

  it("cascades delete when the workspace is deleted", async () => {
    const { a, env } = app(OWNER_ID);
    const createRes = await a.request(
      `/workspaces/${WORKSPACE_ID}/webhooks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug: "acme", url: PUBLIC_HOOK_URL }),
      },
      env,
    );
    expect(createRes.status).toBe(201);
    expect((await h.db.select().from(webhookSubscriptions)).length).toBe(1);

    await h.db.delete(authOrganization).where(eq(authOrganization.id, WORKSPACE_ID));
    expect((await h.db.select().from(webhookSubscriptions)).length).toBe(0);
  });
});
