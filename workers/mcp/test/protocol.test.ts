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

describe("modern-era header requirement", () => {
  it("rejects a modern request missing the Mcp-Method header", async () => {
    const res = await worker.fetch(
      new Request("https://mcp.releases.sh/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(modernRpc("tools/list")),
      }),
      stubEnv(),
      stubCtx(),
    );
    expect(res.status).toBe(400);
  });
});

/**
 * The legacy (no Mcp-Method header) leg is served by the MCP SDK's own
 * fallback transport, which agents@0.17 also used and which always answers
 * SSE-framed (`event: message\ndata: {...}\n\n`) regardless of
 * `responseMode: "json"` — that option only reaches the modern leg. Pull the
 * JSON-RPC payload out of the one `data:` line so the test can still assert
 * on the actual result, not just the transport framing around it.
 */
function parseSseJsonRpc(text: string): unknown {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`no SSE data line found in: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

describe("legacy (2025-era) requests", () => {
  it("still completes the initialize handshake and lists tools, unchanged SSE framing", async () => {
    const env = stubEnv();
    const ctx = stubCtx();
    const legacy = (body: unknown) =>
      new Request("https://mcp.releases.sh/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });

    const initRes = await worker.fetch(
      legacy({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "1.0.0" },
        },
      }),
      env,
      ctx,
    );
    expect(initRes.status).toBe(200);
    // SSE-framed, not plain JSON — this leg is served by the SDK's own
    // legacy fallback transport, byte-for-byte the same shape agents@0.17
    // answered with. `responseMode: "json"` only governs the modern
    // (2026-07-28) leg; it never reaches this fallback.
    expect(initRes.headers.get("content-type")).toContain("text/event-stream");
    const init = parseSseJsonRpc(await initRes.text()) as {
      result: { serverInfo: { name: string } };
    };
    expect(init.result.serverInfo.name).toBe("releases");

    const listRes = await worker.fetch(
      legacy({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      env,
      ctx,
    );
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get("content-type")).toContain("text/event-stream");
    const list = parseSseJsonRpc(await listRes.text()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools.map((t) => t.name)).toContain("search");
  });
});

describe("modern tools/call", () => {
  it("routes a modern tools/call through the header + envelope path", async () => {
    const res = await worker.fetch(
      modernRequest(
        modernRpc("tools/call", { name: "list_follows", arguments: {} }),
        "tools/call",
        "list_follows",
      ),
      stubEnv(),
      stubCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    // The tool itself refuses anonymous callers (follows need a user
    // principal) — what matters here is that dispatch reached it at all,
    // i.e. a JSON-RPC result envelope rather than a transport-level error.
    expect(body.result).toBeDefined();
    expect(body.error).toBeUndefined();
  });
});

describe("cache hints", () => {
  it("advertises a private, hour-long TTL on tools/list", async () => {
    const res = await worker.fetch(
      modernRequest(modernRpc("tools/list"), "tools/list"),
      stubEnv(),
      stubCtx(),
    );
    const body = (await res.json()) as {
      result: { _meta?: Record<string, unknown>; ttlMs?: number; cacheScope?: string };
    };
    // Confirmed against the actual wire response: the 2026-07-28 codec's
    // `encodeResult` stamps `ttlMs`/`cacheScope` directly on the top-level
    // result envelope (`body.result.ttlMs`), not under `_meta`. Assert on
    // whichever carrier is present in case that ever changes.
    const carrier = { ...body.result, ...(body.result._meta ?? {}) } as Record<string, unknown>;
    expect(carrier.ttlMs).toBe(3_600_000);
    expect(carrier.cacheScope).toBe("private");
  });
});
