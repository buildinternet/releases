import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TestDatabase } from "./db-helper.js";
import type { D1Db } from "../workers/mcp/src/db.js";

/** MCP code paths are DB-shape agnostic; bun:sqlite fixtures satisfy the drizzle query surface. */
export function asD1(db: TestDatabase["db"]): D1Db {
  return db as unknown as D1Db;
}

/**
 * Boot an `McpServer`, call `register(server, ...rest)` against it, and link
 * it to an MCP `Client` via an in-memory transport pair.
 *
 * `workers/mcp` is excluded from the root workspaces and installs its own
 * copy of `@modelcontextprotocol/sdk`, so the `McpServer` class from this
 * test's copy is nominally distinct from the one the worker's `register*`
 * helpers were typed against. This helper bridges the two with an internal
 * `unknown` cast so call sites don't have to repeat it.
 */
export async function createMcpTestClient<R extends (server: never, ...rest: never[]) => void>(
  register: R,
  ...rest: R extends (server: never, ...rest: infer Tail) => void ? Tail : never
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = new McpServer({ name: "releases-test", version: "0.0.0" });
  (register as unknown as (s: unknown, ...args: unknown[]) => void)(server, ...rest);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}
