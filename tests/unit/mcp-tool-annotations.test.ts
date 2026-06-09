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
    RELEASES_INDEX: {} as Env["RELEASES_INDEX"],
    ENTITIES_INDEX: {} as Env["ENTITIES_INDEX"],
    CHANGELOG_CHUNKS_INDEX: {} as Env["CHANGELOG_CHUNKS_INDEX"],
    ...overrides,
  };
}

async function listTools(env: Env) {
  const server = await createServer(env);
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

  // The per-user follows tools (#1520) mutate the caller's account, so they are
  // NOT read-only. They're still listed in tools/list (gating is at call time via
  // the user credential), so the surface includes them.
  const MUTATION_TOOLS = new Set(["follow", "unfollow"]);

  it("exposes the full tool surface (read-only catalog + per-user follows)", () => {
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toEqual([
      "follow",
      "get_catalog_entry",
      "get_collection",
      "get_collection_releases",
      "get_latest_releases",
      "get_organization",
      "get_personalized_feed",
      "get_release",
      "list_catalog",
      "list_collections",
      "list_follows",
      "list_organizations",
      "lookup_domain",
      "search",
      "unfollow",
    ]);
  });

  it("marks every data-read tool as read-only, idempotent, closed-world", () => {
    for (const tool of tools) {
      if (MUTATION_TOOLS.has(tool.name)) continue;
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
      expect(tool.annotations?.title).toBeString();
      expect(tool.title).toBeString();
    }
  });

  it("marks the follows mutation tools as non-read-only but idempotent", () => {
    for (const name of MUTATION_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `expected ${name} in tools list`).toBeDefined();
      expect(tool!.annotations?.readOnlyHint).toBe(false);
      expect(tool!.annotations?.destructiveHint).toBe(false);
      expect(tool!.annotations?.idempotentHint).toBe(true);
      expect(tool!.annotations?.openWorldHint).toBe(false);
      expect(tool!.annotations?.title).toBeString();
      expect(tool!.title).toBeString();
    }
  });

  it("advertises an MCP App UI for the release-feed tools", () => {
    const expectedUri = "ui://releases/release-feed.html";
    const feedTools = ["get_latest_releases", "get_collection_releases"];
    for (const name of feedTools) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `expected ${name} in tools list`).toBeDefined();
      // Set both the current nested key (`_meta.ui.resourceUri`) AND the
      // legacy flat key (`_meta["ui/resourceUri"]`). MCP Inspector and some
      // hosts only recognize the flat form — assert both to prevent regression.
      const meta = tool!._meta as
        | { ui?: { resourceUri?: string }; "ui/resourceUri"?: string }
        | undefined;
      expect(meta?.ui?.resourceUri).toBe(expectedUri);
      expect(meta?.["ui/resourceUri"]).toBe(expectedUri);
    }
  });
});
