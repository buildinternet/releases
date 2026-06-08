/**
 * Per-tool scope enforcement for the MCP worker (scoped API tokens — Phase 2).
 * Read tools stay open to an anonymous (implicit read) caller. The only
 * write-gated path left is the on-demand `/v1/lookups` fallback inside `search`
 * (gated directly via `scopeSatisfies`), exercised elsewhere.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type Env } from "../../workers/mcp/src/mcp-agent.js";
import { applyMigrations, makeD1Shim } from "../db-helper.js";

let sqlite: Database;
beforeAll(() => {
  sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
});
afterAll(() => sqlite.close());

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: makeD1Shim(sqlite),
    RELEASES_INDEX: {} as Env["RELEASES_INDEX"],
    ENTITIES_INDEX: {} as Env["ENTITIES_INDEX"],
    CHANGELOG_CHUNKS_INDEX: {} as Env["CHANGELOG_CHUNKS_INDEX"],
    SEARCH_QUERY_LOG_DISABLED: "true",
    ...overrides,
  } as unknown as Env;
}

async function callTool(
  env: Env,
  opts: { authScopes?: string[]; authToken?: string | null },
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }> {
  const server = await createServer(env, undefined, opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  await client.close();
  return res;
}

describe("MCP scope enforcement", () => {
  it("read tools work for an anonymous (default read) caller", async () => {
    const res = await callTool(makeEnv(), {}, "list_organizations", {});
    expect(res.isError).toBeFalsy();
  });
});
