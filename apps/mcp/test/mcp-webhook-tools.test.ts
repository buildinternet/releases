import { describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer, type Env } from "../../apps/mcp/src/mcp-agent.js";

/**
 * The per-user/per-workspace webhook tools (#1678, #2326) proxy through the
 * API worker's `/v1/me/webhooks` and `/v1/workspaces/:id/webhooks` routes
 * carrying the caller's own credential — same pattern as the follows tools
 * (see mcp-follows-tools.test.ts). These tests drive `list_webhooks` and
 * `manage_webhook` via an in-memory MCP client with a stub `env.API` binding
 * that records every forwarded request and responds per-route.
 */

const notCalled = () => {
  throw new Error("DB should not be touched by webhook tools");
};

type Captured = { url: string; method: string; auth: string | null; body: string };

function stubEnv(over: Partial<Env> = {}): Env {
  return {
    DB: { prepare: notCalled, batch: notCalled, exec: notCalled } as unknown as Env["DB"],
    RELEASES_INDEX: {} as Env["RELEASES_INDEX"],
    ENTITIES_INDEX: {} as Env["ENTITIES_INDEX"],
    CHANGELOG_CHUNKS_INDEX: {} as Env["CHANGELOG_CHUNKS_INDEX"],
    ...over,
  };
}

/** A stub API binding that records every request and routes per (method, path). */
function stubApi(calls: Captured[], respond: (req: Request) => { status: number; json?: unknown }) {
  return {
    fetch: async (req: Request) => {
      calls.push({
        url: req.url,
        method: req.method,
        auth: req.headers.get("authorization"),
        body: await req.clone().text(),
      });
      const { status, json } = respond(req);
      return new Response(json === undefined ? null : JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Env["API"];
}

async function withClient(env: Env, userToken: string | null) {
  const server = await createServer(env, undefined, { userToken });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: () => client.close() };
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.find((c) => c.type === "text")?.text ?? "";
}

function isErr(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

const WORKSPACES = [
  {
    id: "org_ws1",
    name: "Acme HQ",
    slug: "acme-hq",
    logo: null,
    role: "owner",
    active: true,
    createdAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "org_ws2",
    name: "Skunkworks",
    slug: "skunkworks",
    logo: null,
    role: "member",
    active: false,
    createdAt: "2026-02-01T00:00:00Z",
  },
];

describe("MCP webhook tools — user-principal gate", () => {
  it("list_webhooks without a user credential returns an actionable error and makes no API call", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({ status: 200, json: { subscriptions: [] } })),
    });
    const { client, close } = await withClient(env, null);
    const res = await client.callTool({ name: "list_webhooks", arguments: {} });
    expect(isErr(res)).toBe(true);
    expect(firstText(res)).toContain("signed-in user");
    expect(calls.length).toBe(0);
    await close();
  });

  it("manage_webhook without a user credential returns an actionable error and makes no API call", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({ API: stubApi(calls, () => ({ status: 201 })) });
    const { client, close } = await withClient(env, null);
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: { action: "delete", id: "whk_1" },
    });
    expect(isErr(res)).toBe(true);
    expect(firstText(res)).toContain("signed-in user");
    expect(calls.length).toBe(0);
    await close();
  });
});

describe("MCP webhook tools — personal CRUD", () => {
  it("list_webhooks lists personal webhooks and appends the caller's workspaces", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/me/workspaces")
          return { status: 200, json: { workspaces: WORKSPACES } };
        return {
          status: 200,
          json: {
            subscriptions: [
              {
                id: "whk_1",
                scope: "org",
                url: "https://example.com/hook",
                format: "json",
                enabled: true,
                description: null,
                orgName: "Acme",
                productName: null,
                sourceName: null,
                deliveryHealth: "healthy",
                deliveryHealthSummary: "Delivering fine",
              },
            ],
          },
        };
      }),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({ name: "list_webhooks", arguments: {} });
    const text = firstText(res);
    expect(text).toContain("Personal webhooks (1)");
    expect(text).toContain("whk_1");
    expect(text).toContain("Acme");
    expect(text).toContain("Your workspaces");
    expect(text).toContain("Skunkworks");
    expect(calls.some((c) => c.url.includes("/v1/me/webhooks") && c.method === "GET")).toBe(true);
    await close();
  });

  it("list_webhooks omits the workspaces section when that call fails", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/me/workspaces") return { status: 500 };
        return { status: 200, json: { subscriptions: [] } };
      }),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({ name: "list_webhooks", arguments: {} });
    const text = firstText(res);
    expect(text).toContain("No personal webhooks yet.");
    expect(text).not.toContain("Your workspaces");
    await close();
  });

  it("list_webhooks with an id fetches the webhook and its recent deliveries", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/me/webhooks/whk_1/deliveries") {
          return {
            status: 200,
            json: {
              data: [{ timestamp: "2026-01-01T00:00:00Z", outcome: "ok", http_status: 200 }],
            },
          };
        }
        if (url.pathname === "/v1/me/webhooks/whk_1") {
          return {
            status: 200,
            json: {
              id: "whk_1",
              scope: "follows",
              url: "https://example.com/hook",
              format: "slack",
              enabled: true,
              description: null,
              deliveryHealth: "healthy",
              deliveryHealthSummary: "Delivering fine",
            },
          };
        }
        throw new Error(`unexpected ${url.pathname}`);
      }),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({ name: "list_webhooks", arguments: { id: "whk_1" } });
    const text = firstText(res);
    expect(text).toContain("everything you follow");
    expect(text).toContain("Recent deliveries");
    expect(text).toContain("2026-01-01T00:00:00Z");
    await close();
  });

  it("manage_webhook create (org-scoped) posts to /v1/me/webhooks and warns about the signing key", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({
        status: 201,
        json: {
          id: "whk_new",
          scope: "org",
          url: "https://example.com/hook",
          format: "json",
          orgName: "Acme",
          signingKey: "whsec_abc123",
        },
      })),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: { action: "create", url: "https://example.com/hook", format: "json", org: "acme" },
    });
    expect(isErr(res)).toBeFalsy();
    const text = firstText(res);
    expect(text).toContain("Created webhook whk_new");
    expect(text).toContain("shown once");
    expect(text).toContain("whsec_abc123");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/v1/me/webhooks");
    expect(calls[0]!.auth).toBe("Bearer relu_abc.secret");
    const body = JSON.parse(calls[0]!.body);
    expect(body).toMatchObject({
      url: "https://example.com/hook",
      format: "json",
      orgSlug: "acme",
    });
    await close();
  });

  it("manage_webhook create maps a typed org_ id to orgId instead of orgSlug", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({
        status: 201,
        json: { id: "whk_new", scope: "org", url: "https://x", format: "json" },
      })),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    await client.callTool({
      name: "manage_webhook",
      arguments: {
        action: "create",
        url: "https://example.com/hook",
        format: "json",
        org: "org_acme123",
      },
    });
    const body = JSON.parse(calls[0]!.body);
    expect(body.orgId).toBe("org_acme123");
    expect(body.orgSlug).toBeUndefined();
    await close();
  });

  it("manage_webhook create (follows scope) has no signing-key note for slack format", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({
        status: 201,
        json: {
          id: "whk_new",
          scope: "follows",
          url: "https://hooks.slack.com/x",
          format: "slack",
        },
      })),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: {
        action: "create",
        url: "https://hooks.slack.com/x",
        format: "slack",
        scope: "follows",
      },
    });
    const text = firstText(res);
    expect(text).toContain("no signing key");
    expect(text).not.toContain("shown once");
    const body = JSON.parse(calls[0]!.body);
    expect(body).toMatchObject({ scope: "follows" });
    await close();
  });

  it("manage_webhook create rejects follows scope combined with org/product/source before calling the API", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({ API: stubApi(calls, () => ({ status: 201 })) });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: {
        action: "create",
        url: "https://x",
        format: "json",
        scope: "follows",
        org: "acme",
      },
    });
    expect(isErr(res)).toBe(true);
    expect(calls.length).toBe(0);
    await close();
  });

  it("manage_webhook update sends only the changed fields, with null clearing a filter", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({
        status: 200,
        json: {
          id: "whk_1",
          scope: "org",
          url: "https://new",
          format: "json",
          enabled: false,
          deliveryHealth: "paused",
          deliveryHealthSummary: "off",
        },
      })),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: { action: "update", id: "whk_1", enabled: false, source: null },
    });
    expect(isErr(res)).toBeFalsy();
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/v1/me/webhooks/whk_1");
    expect(JSON.parse(calls[0]!.body)).toEqual({ enabled: false, sourceId: null });
    await close();
  });

  it("manage_webhook update with no fields is rejected before calling the API", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({ API: stubApi(calls, () => ({ status: 200 })) });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: { action: "update", id: "whk_1" },
    });
    expect(isErr(res)).toBe(true);
    expect(calls.length).toBe(0);
    await close();
  });

  it("manage_webhook delete sends DELETE and reports success on 204", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({ API: stubApi(calls, () => ({ status: 204 })) });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: { action: "delete", id: "whk_1" },
    });
    expect(isErr(res)).toBeFalsy();
    expect(firstText(res)).toContain("Deleted webhook whk_1");
    expect(calls[0]!.method).toBe("DELETE");
    await close();
  });

  it("manage_webhook test queues a delivery", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({ status: 200, json: { enqueued: true, eventId: "evt_1" } })),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: { action: "test", id: "whk_1" },
    });
    expect(isErr(res)).toBeFalsy();
    expect(firstText(res)).toContain("Test delivery queued");
    expect(calls[0]!.url).toContain("/v1/me/webhooks/whk_1/test");
    await close();
  });

  it("manage_webhook rotate_secret returns the new signing key with a one-time warning", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({
        status: 200,
        json: { secretVersion: 2, signingKey: "whsec_new" },
      })),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: { action: "rotate_secret", id: "whk_1" },
    });
    expect(isErr(res)).toBeFalsy();
    const text = firstText(res);
    expect(text).toContain("shown once");
    expect(text).toContain("whsec_new");
    expect(calls[0]!.url).toContain("/v1/me/webhooks/whk_1/rotate-secret");
    await close();
  });
});

describe("MCP webhook tools — workspace resolution", () => {
  it("resolves a workspace by exact id and calls the workspace route", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/me/workspaces")
          return { status: 200, json: { workspaces: WORKSPACES } };
        return { status: 200, json: { subscriptions: [], role: "owner", canManage: true } };
      }),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "list_webhooks",
      arguments: { workspace: "org_ws1" },
    });
    expect(isErr(res)).toBeFalsy();
    expect(firstText(res)).toContain("Acme HQ");
    expect(calls.some((c) => c.url.includes("/v1/workspaces/org_ws1/webhooks"))).toBe(true);
    await close();
  });

  it("resolves a workspace by exact slug", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/me/workspaces")
          return { status: 200, json: { workspaces: WORKSPACES } };
        return { status: 200, json: { subscriptions: [], role: "member", canManage: false } };
      }),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "list_webhooks",
      arguments: { workspace: "skunkworks" },
    });
    expect(isErr(res)).toBeFalsy();
    expect(calls.some((c) => c.url.includes("/v1/workspaces/org_ws2/webhooks"))).toBe(true);
    await close();
  });

  it("a workspace miss lists the caller's workspaces and makes no webhook call", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/me/workspaces")
          return { status: 200, json: { workspaces: WORKSPACES } };
        throw new Error(`unexpected ${url.pathname}`);
      }),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({ name: "list_webhooks", arguments: { workspace: "nope" } });
    expect(isErr(res)).toBe(true);
    expect(firstText(res)).toContain("No workspace matches");
    expect(firstText(res)).toContain("Skunkworks");
    expect(calls).toHaveLength(1);
    await close();
  });

  it("manage_webhook rejects scope: follows with a workspace before calling the API", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/me/workspaces")
          return { status: 200, json: { workspaces: WORKSPACES } };
        throw new Error(`unexpected ${url.pathname}`);
      }),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: {
        action: "create",
        workspace: "org_ws1",
        url: "https://x",
        format: "json",
        scope: "follows",
      },
    });
    expect(isErr(res)).toBe(true);
    expect(firstText(res)).toContain("org-scoped");
    // Only the workspace-resolution call happened, no webhook create call.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/v1/me/workspaces");
    await close();
  });
});

describe("MCP webhook tools — status mapping", () => {
  it("maps a 403 on a workspace write to a plain owner/admin message", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/me/workspaces")
          return { status: 200, json: { workspaces: WORKSPACES } };
        return {
          status: 403,
          json: {
            error: { code: "forbidden", type: "forbidden", message: "Owner or admin required" },
          },
        };
      }),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: { action: "delete", workspace: "org_ws2", id: "whk_1" },
    });
    expect(isErr(res)).toBe(true);
    expect(firstText(res)).toContain(
      "Only workspace owners and admins can change workspace webhooks.",
    );
    await close();
  });

  it("maps a 404 on a workspace :id route to a workspace-scoped not-found message", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/me/workspaces")
          return { status: 200, json: { workspaces: WORKSPACES } };
        return {
          status: 404,
          json: { error: { code: "not_found", type: "not_found", message: "Not found" } },
        };
      }),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: { action: "delete", workspace: "org_ws1", id: "whk_missing" },
    });
    expect(isErr(res)).toBe(true);
    expect(firstText(res)).toBe("Webhook not found in this workspace.");
    await close();
  });

  it("maps a 404 on a personal route to a plain not-found message", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({
        status: 404,
        json: { error: { code: "not_found", type: "not_found", message: "Not found" } },
      })),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: { action: "delete", id: "whk_missing" },
    });
    expect(isErr(res)).toBe(true);
    expect(firstText(res)).toBe("Webhook not found.");
    await close();
  });

  it("maps a 429 on test to the API's message plus a retry hint", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({
        status: 429,
        json: {
          error: {
            code: "rate_limited",
            type: "rate_limited",
            message: "Too many test deliveries",
          },
        },
      })),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "manage_webhook",
      arguments: { action: "test", id: "whk_1" },
    });
    expect(isErr(res)).toBe(true);
    expect(firstText(res)).toContain("Too many test deliveries");
    expect(firstText(res)).toContain("Try again");
    await close();
  });
});
