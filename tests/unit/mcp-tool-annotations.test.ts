import { describe, it, expect, beforeAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type Env } from "../../workers/mcp/src/mcp-agent.js";

/**
 * Stub Env wired so that `createServer()` can initialize without touching D1,
 * Vectorize, or Anthropic. `tools/list` doesn't invoke any tool handler, so the
 * bindings only need to satisfy the TypeScript shape — we cast through
 * `unknown` to avoid pulling `@cloudflare/workers-types` into the root tests
 * tsconfig.
 */
const notCalled = () => {
  throw new Error("tool handler should not run during tools/list");
};

function stubEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: { prepare: notCalled, batch: notCalled, exec: notCalled } as unknown as Env["DB"],
    ANTHROPIC_API_KEY: { get: async () => "" },
    RELEASES_INDEX: {} as Env["RELEASES_INDEX"],
    ENTITIES_INDEX: {} as Env["ENTITIES_INDEX"],
    CHANGELOG_CHUNKS_INDEX: {} as Env["CHANGELOG_CHUNKS_INDEX"],
    ...overrides,
  };
}

async function listTools(env: Env) {
  const server = createServer(env);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe("MCP tool annotations", () => {
  let tools: Awaited<ReturnType<typeof listTools>>;

  beforeAll(async () => {
    tools = await listTools(stubEnv());
  });

  it("exposes the public read-only tool surface", () => {
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toEqual([
      "get_latest_releases",
      "get_organization",
      "get_organization_overview",
      "get_product",
      "get_release",
      "get_source",
      "get_source_changelog",
      "list_organizations",
      "list_products",
      "list_sources",
      "search_registry",
      "search_releases",
    ]);
  });

  it("marks every data-read tool as read-only, idempotent, closed-world", () => {
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
      expect(tool.annotations?.title).toBeString();
      expect(tool.title).toBeString();
    }
  });

  it("flips idempotentHint off for AI tools (LLM output varies)", async () => {
    const aiTools = await listTools(stubEnv({ ENABLE_AI_TOOLS: "true" }));
    const summarize = aiTools.find((t) => t.name === "summarize_changes");
    const compare = aiTools.find((t) => t.name === "compare_products");
    expect(summarize).toBeDefined();
    expect(compare).toBeDefined();
    for (const tool of [summarize!, compare!]) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(false);
      expect(tool.annotations?.openWorldHint).toBe(false);
      expect(tool.title).toBeString();
      expect(tool.annotations?.title).toBe(tool.title);
    }
  });
});
