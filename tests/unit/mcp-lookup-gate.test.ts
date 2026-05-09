/**
 * Gate-logic tests for MCP search tools' on-demand lookup fallback.
 *
 * Verifies that:
 * 1. `env.API.fetch` is called when search returns zero results AND the query
 *    parses as a valid `org/repo` coordinate.
 * 2. `env.API.fetch` is NOT called when the query is not a coordinate (even
 *    though results are empty).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type Env } from "../../workers/mcp/src/mcp-agent.js";
import { applyMigrations, makeD1Shim } from "../db-helper.js";

// Minimal stub response returned by the mock API binding.
const STUB_LOOKUP = { status: "not_found", relatedOrg: null };

function buildStubApi(calls: string[]): Env["API"] {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return new Response(JSON.stringify(STUB_LOOKUP), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Env["API"];
}

async function callSearchTool(
  env: Env,
  toolName: "search" | "search_releases",
  query: string,
): Promise<unknown> {
  const server = createServer(env);
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

  const makeEnv = (apiCalls: string[]): Env => ({
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

  describe("search tool", () => {
    it("calls API.fetch and renders lookup rail when query is a coordinate and search returns no results", async () => {
      const calls: string[] = [];
      const result = await callSearchTool(makeEnv(calls), "search", "acme/some-sdk");
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain("/v1/lookups");
      // Stub returns status="not_found" — assert the rendered text carries
      // the lookup rail. This is what proves the fallback actually surfaces
      // to the MCP client (regression: previously written to wrapper.lookup).
      const text = firstText(result);
      expect(text).toContain("On-demand lookup");
      expect(text).toContain("Repo not found on GitHub");
    });

    it("does NOT call API.fetch when query is not a coordinate", async () => {
      const calls: string[] = [];
      await callSearchTool(makeEnv(calls), "search", "some plain query");
      expect(calls.length).toBe(0);
    });

    it("does NOT call API.fetch when API binding is absent", async () => {
      const env = makeEnv([]);
      delete (env as Partial<Env>).API;
      await expect(callSearchTool(env, "search", "acme/some-sdk")).resolves.toBeDefined();
    });
  });

  describe("search_releases tool", () => {
    it("calls API.fetch and renders lookup rail when query is a coordinate and search returns no results", async () => {
      const calls: string[] = [];
      const result = await callSearchTool(makeEnv(calls), "search_releases", "acme/some-sdk");
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain("/v1/lookups");
      const text = firstText(result);
      expect(text).toContain("On-demand lookup");
    });

    it("does NOT call API.fetch when query is not a coordinate", async () => {
      const calls: string[] = [];
      await callSearchTool(makeEnv(calls), "search_releases", "some plain query");
      expect(calls.length).toBe(0);
    });
  });
});
