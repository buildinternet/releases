/**
 * Anonymous sign-in step-up challenge (#2408): a caller with NO credential at
 * all invoking a user-gated tool (`follow`, `manage_webhook`, …, see
 * `src/user-required-tools.ts`) gets an HTTP-layer 401 + `WWW-Authenticate`
 * instead of silently falling through to anonymous read and a plain
 * tool-result error. Public reads, `initialize`, `tools/list`, and
 * notifications must stay open with no credential; a `relk_`/root caller
 * (authenticated, just missing a user) must keep the existing tool-result
 * behavior rather than being challenged.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { generateApiToken } from "@buildinternet/releases-core/api-token";
import { resolveMcpAuth } from "../src/auth.js";
import { USER_REQUIRED_TOOLS } from "../src/user-required-tools.js";
import type { Env } from "../src/mcp-agent.js";

const mockSecret = (v: string) => ({ get: () => Promise.resolve(v) });

let h: TestDatabase;
beforeAll(() => {
  h = createTestDb();
});
afterAll(() => h.cleanup());

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: h.db,
    RELEASES_API_KEY: mockSecret("root-secret"),
    ...overrides,
  } as unknown as Env;
}

function rpcBody(method: string, params?: Record<string, unknown>) {
  return { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) };
}

function req(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function toolCallReq(url: string, name: string, headers: Record<string, string> = {}): Request {
  return req(url, rpcBody("tools/call", { name, arguments: {} }), headers);
}

describe("USER_REQUIRED_TOOLS", () => {
  it("lists exactly the six tools follows-tools.ts and webhook-tools.ts register", () => {
    // The runtime enforcement lives in `userRequired()` (lib/user-api-proxy.ts),
    // which throws if a tool calls it under a name missing from this set — see
    // "userRequired() rejects an unlisted tool name" below. This assertion pins
    // the set's current membership so an addition/removal here is a deliberate,
    // reviewed diff rather than a silent drift.
    expect([...USER_REQUIRED_TOOLS].sort()).toEqual(
      [
        "follow",
        "unfollow",
        "list_follows",
        "get_personalized_feed",
        "list_webhooks",
        "manage_webhook",
      ].sort(),
    );
  });

  it("userRequired() throws for a tool name missing from the set — a new user-gated tool can't silently skip the challenge", async () => {
    const { userRequired } = await import("../src/lib/user-api-proxy.js");
    expect(() => userRequired("some_new_tool", "nope")).toThrow(/USER_REQUIRED_TOOLS/);
    // And the reverse: every name actually in the set is accepted.
    for (const name of USER_REQUIRED_TOOLS) {
      expect(() => userRequired(name, "ok")).not.toThrow();
    }
  });
});

describe("anonymous sign-in challenge on a user-required tool", () => {
  for (const name of USER_REQUIRED_TOOLS) {
    it(`challenges a credential-less tools/call for '${name}' with 401 + WWW-Authenticate`, async () => {
      const r = await resolveMcpAuth(toolCallReq("https://mcp.releases.sh/mcp", name), baseEnv());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(401);
        const challenge = r.response.headers.get("WWW-Authenticate");
        expect(challenge).toContain("Bearer");
        expect(challenge).not.toContain("error=");
        expect(challenge).toContain(
          'resource_metadata="https://mcp.releases.sh/.well-known/oauth-protected-resource"',
        );
      }
    });
  }

  it("uses the request's own host in resource_metadata (agents.releases.sh)", async () => {
    const r = await resolveMcpAuth(
      toolCallReq("https://agents.releases.sh/mcp", "follow"),
      baseEnv(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect(r.response.headers.get("WWW-Authenticate")).toContain(
        'resource_metadata="https://agents.releases.sh/.well-known/oauth-protected-resource"',
      );
    }
  });

  it("handles a JSON-RPC batch containing a user-required call", async () => {
    const batch = [rpcBody("tools/list"), rpcBody("tools/call", { name: "follow", arguments: {} })];
    const r = await resolveMcpAuth(req("https://mcp.releases.sh/mcp", batch), baseEnv());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("does not challenge a batch with no user-required call", async () => {
    const batch = [rpcBody("tools/list"), rpcBody("tools/call", { name: "search", arguments: {} })];
    const r = await resolveMcpAuth(req("https://mcp.releases.sh/mcp", batch), baseEnv());
    expect(r.ok).toBe(true);
  });

  it("does not challenge an unparseable body", async () => {
    const r = await resolveMcpAuth(
      new Request("https://mcp.releases.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      baseEnv(),
    );
    expect(r.ok).toBe(true);
  });
});

describe("anonymous reads and protocol overhead stay open with no credential", () => {
  it("tools/list is never challenged", async () => {
    const r = await resolveMcpAuth(
      req("https://mcp.releases.sh/mcp", rpcBody("tools/list")),
      baseEnv(),
    );
    expect(r.ok).toBe(true);
  });

  it("initialize is never challenged", async () => {
    const r = await resolveMcpAuth(
      req("https://mcp.releases.sh/mcp", rpcBody("initialize", { protocolVersion: "2025-06-18" })),
      baseEnv(),
    );
    expect(r.ok).toBe(true);
  });

  it("a tools/call for a read tool is never challenged", async () => {
    const r = await resolveMcpAuth(toolCallReq("https://mcp.releases.sh/mcp", "search"), baseEnv());
    expect(r.ok).toBe(true);
  });

  it("a notification is never challenged", async () => {
    const r = await resolveMcpAuth(
      req("https://mcp.releases.sh/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }),
      baseEnv(),
    );
    expect(r.ok).toBe(true);
  });

  it("a GET request (SSE stream) is never challenged", async () => {
    const r = await resolveMcpAuth(
      new Request("https://mcp.releases.sh/mcp", { method: "GET" }),
      baseEnv(),
    );
    expect(r.ok).toBe(true);
  });
});

describe("only the truly credential-less lane is challenged", () => {
  it("an unknown relk_-shaped token is NOT challenged (falls open to anonymous, matching existing reads-stay-public behavior)", async () => {
    const bogus = generateApiToken().token; // well-formed relk_, unknown lookupId
    const r = await resolveMcpAuth(
      toolCallReq("https://mcp.releases.sh/mcp", "follow", { Authorization: `Bearer ${bogus}` }),
      baseEnv(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
  });

  it("the root caller is NOT challenged", async () => {
    const r = await resolveMcpAuth(
      toolCallReq("https://mcp.releases.sh/mcp", "manage_webhook", {
        Authorization: "Bearer root-secret",
      }),
      baseEnv(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("root");
  });
});

describe("staging gate precedes the sign-in challenge", () => {
  it("no staging key -> generic 401, no WWW-Authenticate leaked", async () => {
    const stagingEnv = baseEnv({ STAGING_ACCESS_KEY: mockSecret("stage-key") as never });
    const r = await resolveMcpAuth(
      toolCallReq("https://mcp-staging.releases.sh/mcp", "follow"),
      stagingEnv,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect(r.response.headers.get("WWW-Authenticate")).toBeNull();
    }
  });

  it("with the staging key -> the gate passes and the sign-in challenge fires", async () => {
    const stagingEnv = baseEnv({ STAGING_ACCESS_KEY: mockSecret("stage-key") as never });
    const r = await resolveMcpAuth(
      toolCallReq("https://mcp-staging.releases.sh/mcp", "follow", {
        "X-Releases-Staging-Key": "stage-key",
      }),
      stagingEnv,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect(r.response.headers.get("WWW-Authenticate")).toContain("Bearer");
    }
  });
});
