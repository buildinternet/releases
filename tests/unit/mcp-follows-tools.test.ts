import { describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type Env } from "../../workers/mcp/src/mcp-agent.js";

/**
 * The per-user follows tools (#1520) proxy through the API worker's `/v1/me/*`
 * routes carrying the caller's own credential. These tests drive the tools via
 * an in-memory MCP client with a stub `env.API` binding that records the
 * forwarded request, so we verify (a) the user-principal gate and (b) that the
 * caller's token + the right body reach `/v1/me/*`. No D1 is touched — the
 * follows tools never read the local DB.
 */

const notCalled = () => {
  throw new Error("DB should not be touched by follows tools");
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

/** A stub API binding that records the request and returns a canned response. */
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

describe("MCP follows tools — user-principal gate", () => {
  it("follow without a user credential returns an actionable error and makes no API call", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({ API: stubApi(calls, () => ({ status: 201 })) });
    const { client, close } = await withClient(env, null);
    const res = await client.callTool({ name: "follow", arguments: { entity: "org_x" } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(firstText(res)).toContain("requires a signed-in user");
    expect(calls.length).toBe(0);
    await close();
  });

  it("list_follows without a user credential is refused", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({ API: stubApi(calls, () => ({ status: 200, json: { follows: [] } })) });
    const { client, close } = await withClient(env, null);
    const res = await client.callTool({ name: "list_follows", arguments: {} });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(calls.length).toBe(0);
    await close();
  });
});

describe("MCP follows tools — forwarding", () => {
  it("follow forwards POST /v1/me/follows with the caller's token and inferred target", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({ status: 201, json: { success: true, following: true } })),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({ name: "follow", arguments: { entity: "prod_widget" } });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(firstText(res)).toContain("Now following prod_widget");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/v1/me/follows");
    expect(calls[0]!.auth).toBe("Bearer relu_abc.secret");
    expect(JSON.parse(calls[0]!.body)).toEqual({ targetType: "product", targetId: "prod_widget" });
    await close();
  });

  it("follow rejects a non-entity id before calling the API", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({ API: stubApi(calls, () => ({ status: 201 })) });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({ name: "follow", arguments: { entity: "vercel" } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(firstText(res)).toContain("not a followable id");
    expect(calls.length).toBe(0);
    await close();
  });

  it("unfollow forwards DELETE /v1/me/follows/:type/:id", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({ status: 200, json: { success: true, following: false } })),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({ name: "unfollow", arguments: { entity: "org_acme" } });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(firstText(res)).toContain("Unfollowed org_acme");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/v1/me/follows/org/org_acme");
    await close();
  });

  it("list_follows renders the enriched list from /v1/me/follows", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({
        status: 200,
        json: {
          follows: [
            { targetType: "org", targetId: "org_acme", name: "Acme", slug: "acme", orgSlug: null },
            {
              targetType: "product",
              targetId: "prod_w",
              name: "Widget",
              slug: "widget",
              orgSlug: "acme",
            },
          ],
        },
      })),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({ name: "list_follows", arguments: {} });
    const text = firstText(res);
    expect(text).toContain("Following 2");
    expect(text).toContain("Acme");
    expect(text).toContain("acme/widget");
    expect(calls[0]!.method).toBe("GET");
    await close();
  });

  it("get_personalized_feed forwards pagination and renders items", async () => {
    const calls: Captured[] = [];
    const env = stubEnv({
      API: stubApi(calls, () => ({
        status: 200,
        json: {
          items: [
            {
              id: "rel_1",
              title: "v1.2.0",
              titleShort: "Dark mode",
              publishedAt: "2026-06-01T00:00:00Z",
              source: { name: "Acme Blog" },
            },
          ],
          pagination: { hasMore: false },
        },
      })),
    });
    const { client, close } = await withClient(env, "relu_abc.secret");
    const res = await client.callTool({
      name: "get_personalized_feed",
      arguments: { page: 2, limit: 10 },
    });
    const text = firstText(res);
    expect(text).toContain("Dark mode");
    expect(calls[0]!.url).toContain("page=2");
    expect(calls[0]!.url).toContain("limit=10");
    await close();
  });
});
