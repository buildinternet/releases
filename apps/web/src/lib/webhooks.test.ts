import { describe, it, expect, afterEach, beforeEach } from "bun:test";

const ORIG = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";

const {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  rotateWebhookSecret,
  testWebhook,
  listWebhookDeliveries,
  listWorkspaceWebhooks,
  createWorkspaceWebhook,
  updateWorkspaceWebhook,
  deleteWorkspaceWebhook,
  rotateWorkspaceWebhookSecret,
  testWorkspaceWebhook,
  listWorkspaceWebhookDeliveries,
} = await import("./webhooks.js");

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
function mockFetch(response: unknown, ok = true, status = 200) {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      status,
      json: async () => response,
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  else process.env.NEXT_PUBLIC_BETTER_AUTH_URL = ORIG;
});

describe("webhooks client", () => {
  it("lists with credentials", async () => {
    mockFetch({ subscriptions: [{ id: "whk_1", scope: "follows" }] });
    const subs = await listWebhooks();
    expect(subs).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.test/v1/me/webhooks");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("creates follows-scoped via POST", async () => {
    mockFetch({ id: "whk_2", signingKey: "abc", scope: "follows" });
    const created = await createWebhook({ url: "https://ex.com/h", scope: "follows" });
    expect(created.signingKey).toBe("abc");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      url: "https://ex.com/h",
      scope: "follows",
    });
  });

  it("patches enabled state", async () => {
    mockFetch({ id: "whk_3", enabled: false });
    await updateWebhook("whk_3", { enabled: false });
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ enabled: false });
  });

  it("deletes via DELETE", async () => {
    mockFetch(null, true, 204);
    await deleteWebhook("whk_4");
    expect(calls[0]!.url).toBe("https://api.test/v1/me/webhooks/whk_4");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("rotates secret via POST", async () => {
    mockFetch({ signingKey: "newkey", secretVersion: 2 });
    const out = await rotateWebhookSecret("whk_5");
    expect(out.signingKey).toBe("newkey");
    expect(calls[0]!.url).toContain("/rotate-secret");
  });

  it("test enqueues via POST", async () => {
    mockFetch({ enqueued: true, eventId: "evt_1" });
    const out = await testWebhook("whk_6");
    expect(out.eventId).toBe("evt_1");
    expect(calls[0]!.url).toContain("/test");
  });

  it("lists deliveries and maps 501 to null", async () => {
    mockFetch({ error: "deliveries_unavailable" }, false, 501);
    expect(await listWebhookDeliveries("whk_7")).toBeNull();
    expect(calls[0]!.url).toContain("/deliveries");
  });

  it("lists deliveries from AE payload", async () => {
    mockFetch({ data: [{ event_id: "evt_1", outcome: "success" }] });
    const rows = await listWebhookDeliveries("whk_8", { limit: 10 });
    expect(rows?.[0]?.event_id).toBe("evt_1");
    expect(calls[0]!.url).toContain("limit=10");
  });
});

describe("workspace webhooks client (#2324)", () => {
  const WORKSPACE_ID = "ws_abc123";

  it("lists against the workspace base path, with credentials", async () => {
    mockFetch({ subscriptions: [], role: "owner", canManage: true });
    const res = await listWorkspaceWebhooks(WORKSPACE_ID);
    expect(res.role).toBe("owner");
    expect(res.canManage).toBe(true);
    expect(calls[0]!.url).toBe(`https://api.test/v1/workspaces/${WORKSPACE_ID}/webhooks`);
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("creates org-scoped via POST to the workspace path", async () => {
    mockFetch({ id: "whk_ws1", workspaceId: WORKSPACE_ID, scope: "org", signingKey: "abc" });
    const created = await createWorkspaceWebhook(WORKSPACE_ID, {
      url: "https://ex.com/h",
      orgSlug: "vercel",
    });
    expect(created.signingKey).toBe("abc");
    expect(calls[0]!.url).toBe(`https://api.test/v1/workspaces/${WORKSPACE_ID}/webhooks`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      url: "https://ex.com/h",
      orgSlug: "vercel",
    });
  });

  it("patches via PATCH to the workspace path", async () => {
    mockFetch({ id: "whk_ws2", enabled: false });
    await updateWorkspaceWebhook(WORKSPACE_ID, "whk_ws2", { enabled: false });
    expect(calls[0]!.url).toBe(`https://api.test/v1/workspaces/${WORKSPACE_ID}/webhooks/whk_ws2`);
    expect(calls[0]!.init?.method).toBe("PATCH");
  });

  it("deletes via DELETE to the workspace path", async () => {
    mockFetch(null, true, 204);
    await deleteWorkspaceWebhook(WORKSPACE_ID, "whk_ws3");
    expect(calls[0]!.url).toBe(`https://api.test/v1/workspaces/${WORKSPACE_ID}/webhooks/whk_ws3`);
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("rotates the signing key via the workspace path", async () => {
    mockFetch({ signingKey: "newkey", secretVersion: 2 });
    const out = await rotateWorkspaceWebhookSecret(WORKSPACE_ID, "whk_ws4");
    expect(out.signingKey).toBe("newkey");
    expect(calls[0]!.url).toContain(
      `/v1/workspaces/${WORKSPACE_ID}/webhooks/whk_ws4/rotate-secret`,
    );
  });

  it("sends a test via the workspace path", async () => {
    mockFetch({ enqueued: true, eventId: "evt_ws1" });
    const out = await testWorkspaceWebhook(WORKSPACE_ID, "whk_ws5");
    expect(out.eventId).toBe("evt_ws1");
    expect(calls[0]!.url).toContain(`/v1/workspaces/${WORKSPACE_ID}/webhooks/whk_ws5/test`);
  });

  it("lists deliveries and maps 501 to null on the workspace path", async () => {
    mockFetch({ error: "deliveries_unavailable" }, false, 501);
    expect(await listWorkspaceWebhookDeliveries(WORKSPACE_ID, "whk_ws6")).toBeNull();
    expect(calls[0]!.url).toContain(`/v1/workspaces/${WORKSPACE_ID}/webhooks/whk_ws6/deliveries`);
  });
});
