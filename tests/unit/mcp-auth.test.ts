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
import { resolveMcpAuth } from "../../workers/mcp/src/auth.js";
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
    RELEASED_API_KEY: mockSecret("root-secret"),
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
