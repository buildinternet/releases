/**
 * Gate-logic tests for the MCP search tool's on-demand lookup fallback.
 *
 * Verifies that the fallback fires only when ALL hold:
 * 1. the query parses as a valid `org/repo` coordinate,
 * 2. the primary search returned zero entity hits, and
 * 3. the caller carries `write` scope — and that the caller's OWN token is
 *    forwarded to the API (confused-deputy fix), never a borrowed root key.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type Env } from "../../workers/mcp/src/mcp-agent.js";
import { applyMigrations, makeD1Shim } from "../db-helper.js";

// Minimal stub response returned by the mock API binding.
const STUB_LOOKUP = { status: "not_found", relatedOrg: null };

type ApiCall = { url: string; auth: string | null };

// Capture both URL and forwarded Authorization so we can assert the fix.
function buildStubApi(calls: ApiCall[]): Env["API"] {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input as RequestInfo | URL);
      calls.push({ url: request.url, auth: request.headers.get("Authorization") });
      return new Response(JSON.stringify(STUB_LOOKUP), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Env["API"];
}

async function callSearchTool(
  env: Env,
  toolName: "search",
  query: string,
  opts: { authScopes?: string[]; authToken?: string | null } = {},
): Promise<unknown> {
  const server = await createServer(env, undefined, opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const result = await client.callTool({ name: toolName, arguments: { query } });
  await client.close();
  return result;
}

describe("MCP lookup gate", () => {
  let sqlite: Database;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    sqlite.run("PRAGMA journal_mode=WAL");
    sqlite.run("PRAGMA foreign_keys=ON");
    applyMigrations(sqlite);
  });

  afterAll(() => {
    sqlite.close();
  });

  const makeEnv = (apiCalls: ApiCall[]): Env => ({
    DB: makeD1Shim(sqlite),
    ANTHROPIC_API_KEY: { get: async () => "" },
    RELEASES_INDEX: {} as Env["RELEASES_INDEX"],
    ENTITIES_INDEX: {} as Env["ENTITIES_INDEX"],
    CHANGELOG_CHUNKS_INDEX: {} as Env["CHANGELOG_CHUNKS_INDEX"],
    SEARCH_QUERY_LOG_DISABLED: "true",
    API: buildStubApi(apiCalls),
  });

  type ToolCallResult = { content: Array<{ type: string; text?: string }> };

  function firstText(result: unknown): string {
    const r = result as ToolCallResult;
    return r.content[0]?.text ?? "";
  }

  // A write-scoped caller forwarding its own opaque token.
  const WRITE = {
    authScopes: ["write"],
    authToken: "relk_clienttoken0_clientsecret0000000000000000",
  };

  describe("search tool", () => {
    it("fires the lookup for a write caller and forwards the caller's token (not root)", async () => {
      const calls: ApiCall[] = [];
      const result = await callSearchTool(makeEnv(calls), "search", "acme/some-sdk", WRITE);
      expect(calls.length).toBe(1);
      expect(calls[0].url).toContain("/v1/lookups");
      // Confused-deputy fix: the caller's token is forwarded verbatim.
      expect(calls[0].auth).toBe(`Bearer ${WRITE.authToken}`);
      // Stub returns status="not_found" — assert the rendered text carries the
      // lookup rail, proving the fallback surfaces to the MCP client.
      const text = firstText(result);
      expect(text).toContain("On-demand lookup");
      expect(text).toContain("Repo not found on GitHub");
    });

    it("does NOT fire the lookup for an anonymous/read caller (confused-deputy closed)", async () => {
      const calls: ApiCall[] = [];
      await callSearchTool(makeEnv(calls), "search", "acme/some-sdk"); // default read scope
      expect(calls.length).toBe(0);
    });

    it("does NOT call API.fetch when query is not a coordinate", async () => {
      const calls: ApiCall[] = [];
      await callSearchTool(makeEnv(calls), "search", "some plain query", WRITE);
      expect(calls.length).toBe(0);
    });

    it("does NOT call API.fetch when API binding is absent", async () => {
      const env = makeEnv([]);
      delete (env as Partial<Env>).API;
      await expect(callSearchTool(env, "search", "acme/some-sdk", WRITE)).resolves.toBeDefined();
    });
  });
});
