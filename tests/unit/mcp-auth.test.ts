/**
 * Boundary auth resolution for the MCP worker (scoped API tokens — Phase 2).
 * Covers identity resolution (anonymous / token / root / invalid / disabled)
 * and the staging access gate, including the relk-token bridge that lets a
 * managed agent authenticate to staging with a Bearer token.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { generateApiToken, hashSecret } from "@buildinternet/releases-core/api-token";
import {
  resolveMcpAuth,
  isMeteredMcpMethod,
  machineTokenIdForUsage,
} from "../../workers/mcp/src/auth.js";
import type { Env } from "../../workers/mcp/src/mcp-agent.js";

const mockSecret = (v: string) => ({ get: () => Promise.resolve(v) });

// createTestDb returns a drizzle handle with a D1-shaped `prepare` patched on,
// so it serves both seed writes and the query-builder reads verifyApiToken does
// (the makeD1Shim path can't — its `.raw()` always returns []). MCP's createDb
// short-circuits when handed this handle, so resolveMcpAuth reads it directly.
let h: TestDatabase;

async function seed(scopes: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const { token, lookupId, secret } = generateApiToken();
  h.db
    .insert(apiTokens)
    .values({
      id: (extra.id as string) ?? `tok_${lookupId}`,
      lookupId,
      tokenHash: await hashSecret(secret),
      name: "t",
      scopes: JSON.stringify(scopes),
      ...extra,
    } as typeof apiTokens.$inferInsert)
    .run();
  return token;
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://mcp.releases.sh/mcp", { method: "POST", headers });
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: h.db,
    RELEASES_API_KEY: mockSecret("root-secret"),
    ...overrides,
  } as unknown as Env;
}

beforeAll(() => {
  h = createTestDb();
});
afterAll(() => h.cleanup());

describe("resolveMcpAuth — identity (prod, no staging gate)", () => {
  it("no credential ⇒ anonymous read", async () => {
    const r = await resolveMcpAuth(req(), baseEnv());
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.identity).toMatchObject({ kind: "anonymous", scopes: ["read"], token: null });
  });

  it("valid write token ⇒ token identity with its scopes + raw token", async () => {
    const token = await seed(["read", "write"], { id: "tok_w" });
    const r = await resolveMcpAuth(req({ Authorization: `Bearer ${token}` }), baseEnv());
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.identity).toEqual({
        kind: "token",
        scopes: ["read", "write"],
        tokenId: "tok_w",
        token,
      });
  });

  it("invalid relk token ⇒ anonymous (reads stay public, never 401)", async () => {
    const bogus = generateApiToken().token; // unknown lookupId
    const r = await resolveMcpAuth(req({ Authorization: `Bearer ${bogus}` }), baseEnv());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
  });

  it("static root key ⇒ root identity, wildcard scope, no raw token", async () => {
    const r = await resolveMcpAuth(req({ Authorization: "Bearer root-secret" }), baseEnv());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toMatchObject({ kind: "root", scopes: ["*"], token: null });
  });

  it("API_TOKENS_DISABLED ⇒ relk token treated as anonymous", async () => {
    const token = await seed(["write"], { id: "tok_disabled" });
    const r = await resolveMcpAuth(
      req({ Authorization: `Bearer ${token}` }),
      baseEnv({ API_TOKENS_DISABLED: "true" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
  });
});

describe("resolveMcpAuth — staging gate", () => {
  const staging = (o: Partial<Env> = {}) =>
    baseEnv({ STAGING_ACCESS_KEY: mockSecret("stg-key"), ...o });

  it("rejects anonymous when the staging gate is bound", async () => {
    const r = await resolveMcpAuth(req(), staging());
    expect(r.ok).toBe(false);
  });

  it("passes with X-Releases-Staging-Key", async () => {
    const r = await resolveMcpAuth(req({ "X-Releases-Staging-Key": "stg-key" }), staging());
    expect(r.ok).toBe(true);
  });

  it("passes with Bearer staging-key (managed-agent legacy form)", async () => {
    const r = await resolveMcpAuth(req({ Authorization: "Bearer stg-key" }), staging());
    expect(r.ok).toBe(true);
    // staging key opens the gate but identity stays anonymous read.
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
  });

  it("passes with a valid staging-DB relk token (token bridge)", async () => {
    const token = await seed(["read"], { id: "tok_stg" });
    const r = await resolveMcpAuth(req({ Authorization: `Bearer ${token}` }), staging());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toMatchObject({ kind: "token", tokenId: "tok_stg" });
  });

  it("lets OPTIONS through the gate (CORS preflight)", async () => {
    const r = await resolveMcpAuth(
      new Request("https://mcp.releases.sh/mcp", { method: "OPTIONS" }),
      staging(),
    );
    expect(r.ok).toBe(true);
  });
});

describe("isMeteredMcpMethod", () => {
  const post = (body: unknown) =>
    new Request("https://mcp.releases.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("tools/call ⇒ billable", async () => {
    expect(await isMeteredMcpMethod(post({ jsonrpc: "2.0", id: 1, method: "tools/call" }))).toBe(
      true,
    );
  });

  it("protocol-overhead methods ⇒ not billable", async () => {
    for (const m of [
      "initialize",
      "tools/list",
      "resources/list",
      "resources/templates/list",
      "prompts/list",
      "ping",
      "logging/setLevel",
      "completion/complete",
    ]) {
      expect(await isMeteredMcpMethod(post({ method: m }))).toBe(false);
    }
  });

  it("notifications/* ⇒ not billable", async () => {
    expect(await isMeteredMcpMethod(post({ method: "notifications/initialized" }))).toBe(false);
  });

  it("unknown method ⇒ billable (fail-toward-metering)", async () => {
    expect(await isMeteredMcpMethod(post({ method: "tools/weird" }))).toBe(true);
  });

  it("missing/non-string method ⇒ billable", async () => {
    expect(await isMeteredMcpMethod(post({ id: 1 }))).toBe(true);
  });

  it("unparseable body ⇒ billable", async () => {
    const r = new Request("https://mcp.releases.sh/mcp", { method: "POST", body: "{not json" });
    expect(await isMeteredMcpMethod(r)).toBe(true);
  });

  it("non-POST ⇒ not billable", async () => {
    expect(
      await isMeteredMcpMethod(new Request("https://mcp.releases.sh/mcp", { method: "GET" })),
    ).toBe(false);
  });

  it("batch with any billable entry ⇒ billable", async () => {
    expect(
      await isMeteredMcpMethod(post([{ method: "tools/list" }, { method: "tools/call" }])),
    ).toBe(true);
  });

  it("batch of only overhead ⇒ not billable", async () => {
    expect(await isMeteredMcpMethod(post([{ method: "tools/list" }]))).toBe(false);
  });
});

type MeCall = { url: string; auth: string | null; stagingKey: string | null };

/** Stub the API service binding's /v1/tokens/me response. */
function stubMeApi(calls: MeCall[], response: { status: number; scopes?: string[] }): Env["API"] {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const r = input instanceof Request ? input : new Request(input as RequestInfo | URL);
      calls.push({
        url: r.url,
        auth: r.headers.get("Authorization"),
        stagingKey: r.headers.get("X-Releases-Staging-Key"),
      });
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 });
      }
      if (response.status !== 200) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: response.status });
      }
      return new Response(
        JSON.stringify({
          kind: "token",
          name: "user-api-key",
          scopes: response.scopes ?? [],
          principalType: "user",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  } as unknown as Env["API"];
}

/** POST request carrying a single JSON-RPC method (default: a billable tools/call). */
function rpcReq(method: string, headers: Record<string, string> = {}): Request {
  return new Request("https://mcp.releases.sh/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  });
}

describe("resolveMcpAuth — relu_ user keys", () => {
  const RELU = "relu_testkey000000000000000000000000";
  const enabled = (api: Env["API"], o: Partial<Env> = {}) =>
    baseEnv({ USER_API_KEYS_ENABLED: "true", API: api, ...o });

  it("billable tool call ⇒ verifies via /v1/tokens/me, meters once, token identity (token=null)", async () => {
    const calls: MeCall[] = [];
    const api = stubMeApi(calls, { status: 200, scopes: ["read", "write"] });
    const r = await resolveMcpAuth(
      rpcReq("tools/call", { Authorization: `Bearer ${RELU}` }),
      enabled(api),
    );
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.identity).toEqual({
        kind: "token",
        scopes: ["read", "write"],
        tokenId: "relu_",
        token: null,
      });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/v1/tokens/me");
    expect(calls[0].auth).toBe(`Bearer ${RELU}`);
  });

  it("non-billable method (tools/list) ⇒ anonymous, NOT metered (no /me call)", async () => {
    const calls: MeCall[] = [];
    const api = stubMeApi(calls, { status: 200, scopes: ["read"] });
    const r = await resolveMcpAuth(
      rpcReq("tools/list", { Authorization: `Bearer ${RELU}` }),
      enabled(api),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
    expect(calls.length).toBe(0);
  });

  it("invalid relu_ (401 from /me) ⇒ anonymous read", async () => {
    const calls: MeCall[] = [];
    const api = stubMeApi(calls, { status: 401 });
    const r = await resolveMcpAuth(
      rpcReq("tools/call", { Authorization: `Bearer ${RELU}` }),
      enabled(api),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
    expect(calls.length).toBe(1);
  });

  it("rate-limited relu_ (429 from /me) ⇒ 429 response", async () => {
    const calls: MeCall[] = [];
    const api = stubMeApi(calls, { status: 429 });
    const r = await resolveMcpAuth(
      rpcReq("tools/call", { Authorization: `Bearer ${RELU}` }),
      enabled(api),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(429);
  });

  it("flag off ⇒ relu_ inert (anonymous), no /me call", async () => {
    const calls: MeCall[] = [];
    const api = stubMeApi(calls, { status: 200, scopes: ["read"] });
    const r = await resolveMcpAuth(
      rpcReq("tools/call", { Authorization: `Bearer ${RELU}` }),
      baseEnv({ API: api }), // USER_API_KEYS_ENABLED unset → flag() default false
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
    expect(calls.length).toBe(0);
  });

  it("no API binding ⇒ relu_ resolves anonymous (cannot verify)", async () => {
    const r = await resolveMcpAuth(
      rpcReq("tools/call", { Authorization: `Bearer ${RELU}` }),
      baseEnv({ USER_API_KEYS_ENABLED: "true" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
  });

  it("forwards the staging key to /me when bound", async () => {
    const calls: MeCall[] = [];
    const api = stubMeApi(calls, { status: 200, scopes: ["read"] });
    const r = await resolveMcpAuth(
      rpcReq("tools/call", {
        Authorization: `Bearer ${RELU}`,
        "X-Releases-Staging-Key": "stg-key",
      }),
      enabled(api, { STAGING_ACCESS_KEY: mockSecret("stg-key") }),
    );
    expect(r.ok).toBe(true);
    expect(calls[0].stagingKey).toBe("stg-key");
  });

  it("method peek leaves the original request body readable for createMcpHandler", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    const request = new Request("https://mcp.releases.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    await resolveMcpAuth(request, baseEnv());
    expect(await request.text()).toBe(body);
  });
});

describe("machineTokenIdForUsage", () => {
  it("relk_ token ⇒ returns the tokenId (record last_used)", () => {
    expect(
      machineTokenIdForUsage({
        kind: "token",
        scopes: ["read"],
        tokenId: "tok_x",
        token: "relk_x",
      }),
    ).toBe("tok_x");
  });

  it("relu_ user key ⇒ null (metered by Better Auth, no api_tokens row)", () => {
    expect(
      machineTokenIdForUsage({ kind: "token", scopes: ["read"], tokenId: "relu_", token: null }),
    ).toBeNull();
  });

  it("root ⇒ null", () => {
    expect(
      machineTokenIdForUsage({ kind: "root", scopes: ["*"], tokenId: null, token: null }),
    ).toBeNull();
  });

  it("anonymous ⇒ null", () => {
    expect(
      machineTokenIdForUsage({ kind: "anonymous", scopes: ["read"], tokenId: null, token: null }),
    ).toBeNull();
  });
});
