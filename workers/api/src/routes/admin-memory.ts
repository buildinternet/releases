// Read-only observability over Anthropic managed-agents memory stores.
// Lists stores in the workspace, memories within a store, and version
// history per memory. Auth-gated via the `admin/memory` entry in the
// adminRoutes allowlist in workers/api/src/index.ts. See issue #537.

import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../index.js";

export const adminMemoryRoutes = new Hono<Env>();

const BETA_HEADER = "managed-agents-2026-04-01";

async function getClient(env: Env["Bindings"]): Promise<Anthropic> {
  const apiKey = await env.ANTHROPIC_API_KEY?.get();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not bound");
  return new Anthropic({ apiKey, defaultHeaders: { "anthropic-beta": BETA_HEADER } });
}

// ── GET /admin/memory/stores ──────────────────────────────────────────────

adminMemoryRoutes.get("/admin/memory/stores", async (c) => {
  const client = await getClient(c.env);
  const includeArchived = c.req.query("include_archived") === "true";
  const page = await client.beta.memoryStores.list({ include_archived: includeArchived });
  return c.json({ data: page.data });
});

// ── GET /admin/memory/stores/:storeId/memories ───────────────────────────

adminMemoryRoutes.get("/admin/memory/stores/:storeId/memories", async (c) => {
  const storeId = c.req.param("storeId");
  const pathPrefix = c.req.query("path_prefix") ?? "/";
  const depthRaw = c.req.query("depth");
  const depth = depthRaw ? Number(depthRaw) : undefined;

  const client = await getClient(c.env);
  const page = await client.beta.memoryStores.memories.list(storeId, {
    path_prefix: pathPrefix,
    order_by: "path",
    ...(depth !== undefined ? { depth } : {}),
  });
  return c.json({ data: page.data });
});

// ── GET /admin/memory/stores/:storeId/memories/:memoryId ─────────────────

adminMemoryRoutes.get("/admin/memory/stores/:storeId/memories/:memoryId", async (c) => {
  const storeId = c.req.param("storeId");
  const memoryId = c.req.param("memoryId");
  const client = await getClient(c.env);
  const memory = await client.beta.memoryStores.memories.retrieve(memoryId, {
    memory_store_id: storeId,
  });
  return c.json(memory);
});

// ── GET /admin/memory/stores/:storeId/memories/:memoryId/versions ────────

adminMemoryRoutes.get("/admin/memory/stores/:storeId/memories/:memoryId/versions", async (c) => {
  const storeId = c.req.param("storeId");
  const memoryId = c.req.param("memoryId");
  const client = await getClient(c.env);
  const page = await client.beta.memoryStores.memoryVersions.list(storeId, {
    memory_id: memoryId,
  });
  return c.json({ data: page.data });
});
