/**
 * Wire-era coverage for the stateless v2 handler (#2189). These drive the real
 * `index.ts` fetch handler — not a bare McpServer — so the auth-first ordering
 * and the JSON response mode are asserted, not assumed.
 */
import { describe, it, expect } from "bun:test";
import worker from "../src/index";
import type { Env } from "../src/mcp-agent";

const notCalled = () => {
  throw new Error("binding should not be touched by tools/list");
};

/** Anonymous, prod-shaped env: no STAGING_ACCESS_KEY, no rate limiters, no FLAGS. */
export function stubEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: { prepare: notCalled, batch: notCalled, exec: notCalled } as unknown as Env["DB"],
    RELEASES_INDEX: {} as Env["RELEASES_INDEX"],
    ENTITIES_INDEX: {} as Env["ENTITIES_INDEX"],
    CHANGELOG_CHUNKS_INDEX: {} as Env["CHANGELOG_CHUNKS_INDEX"],
    ...overrides,
  };
}

export function stubCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

// SEP-2243: the 2026-07-28 wire revision has no `initialize` handshake. Each
// request names its revision and capabilities in reserved `_meta` keys and
// mirrors the method (and, for tools/call, the tool name) in standard headers.
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

let nextId = 1;

export function modernRpc(method: string, params?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  };
}

export function modernRequest(body: unknown, mcpMethod: string, mcpName?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-method": mcpMethod,
  };
  if (mcpName !== undefined) headers["mcp-name"] = mcpName;
  return new Request("https://mcp.releases.sh/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("modern (2026-07-28) requests", () => {
  it("serves tools/list from the modern envelope, as plain JSON", async () => {
    const res = await worker.fetch(
      modernRequest(modernRpc("tools/list"), "tools/list"),
      stubEnv(),
      stubCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["search", "get_latest_releases", "list_organizations"]),
    );
  });
});
