// Admin write surface for per-org errata memories. See #537.
//
// Canonical path `/v1/errata/:orgId` gated by the `errata` adminRoutes entry
// (not `/v1/admin/errata/*`, per #494). Accepts { content } and upserts
// `/orgs/<orgId>/errata.md` in the managed-agents errata store. Promotion
// target for observations that have proved stable across runs.

import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../index.js";

export const errataRoutes = new Hono<Env>();

const MAX_CONTENT_BYTES = 100_000;
const BETA_HEADER = "managed-agents-2026-04-01";

errataRoutes.put("/errata/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  if (!orgId.startsWith("org_")) {
    return c.json({ error: "orgId must be an org_... identifier" }, 400);
  }

  const storeId = c.env.MEMORY_STORE_ERRATA_ID;
  if (!storeId) {
    return c.json({ error: "MEMORY_STORE_ERRATA_ID not configured" }, 500);
  }

  let body: { content?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const content = body.content;
  if (typeof content !== "string" || content.length === 0) {
    return c.json({ error: "content must be a non-empty string" }, 400);
  }
  if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES) {
    return c.json({ error: `content exceeds ${MAX_CONTENT_BYTES}-byte cap` }, 413);
  }

  const apiKey = await c.env.ANTHROPIC_API_KEY?.get();
  if (!apiKey) return c.json({ error: "ANTHROPIC_API_KEY not bound" }, 500);
  const client = new Anthropic({ apiKey, defaultHeaders: { "anthropic-beta": BETA_HEADER } });

  const path = `/orgs/${orgId}/errata.md`;
  const existing = await client.beta.memoryStores.memories
    .list(storeId, { path_prefix: path, depth: 1 })
    .then((page) => page.data.find((m) => m.type === "memory" && m.path === path));

  if (existing && "id" in existing && existing.id) {
    const updated = await client.beta.memoryStores.memories.update(existing.id, {
      memory_store_id: storeId,
      content,
    });
    return c.json({ status: "updated", memory_id: updated.id, path });
  }

  const created = await client.beta.memoryStores.memories.create(storeId, {
    path,
    content,
  });
  return c.json({ status: "created", memory_id: created.id, path });
});
