// Admin write surface for per-org errata memories. See #537.
//
// Canonical path `/v1/errata/:orgId` gated by the `errata` adminRoutes entry
// (not `/v1/admin/errata/*`, per #494). Accepts { content } and upserts
// `/orgs/<orgId>/errata.md` in the managed-agents errata store. Promotion
// target for observations that have proved stable across runs.

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { getSecret } from "@releases/lib/secrets";
import { validateJson } from "../lib/validate.js";
import { hideInProduction } from "../openapi.js";
import type { Env } from "../index.js";

export const errataRoutes = new Hono<Env>();

const MAX_CONTENT_BYTES = 100_000;
const BETA_HEADER = "managed-agents-2026-04-01";

/**
 * Body shape for `PUT /v1/errata/:orgId`. Admin-only, so kept local rather
 * than published through `@buildinternet/releases-api-types`. The byte-cap
 * lives in the handler because the schema constraint (`content.length`) is
 * in UTF-16 code units, not the UTF-8 bytes the store charges against.
 */
const ErrataBodySchema = z.object({
  content: z.string().min(1),
});

errataRoutes.put(
  "/errata/:orgId",
  describeRoute({
    hide: hideInProduction,
    tags: ["Admin"],
    summary: "Upsert per-org errata memory",
    description:
      "Admin-only write surface for the managed-agents errata store. Promotes stable observations from agent runs into the org's errata.md.",
    security: [{ bearerAuth: [] }],
  }),
  validateJson(ErrataBodySchema),
  async (c) => {
    const orgId = c.req.param("orgId");
    if (!orgId.startsWith("org_")) {
      return c.json({ error: "bad_request", message: "orgId must be an org_... identifier" }, 400);
    }

    const storeId = c.env.MEMORY_STORE_ERRATA_ID;
    if (!storeId) {
      return c.json(
        { error: "internal_error", message: "MEMORY_STORE_ERRATA_ID not configured" },
        500,
      );
    }

    const { content } = c.req.valid("json");
    if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES) {
      return c.json(
        { error: "payload_too_large", message: `content exceeds ${MAX_CONTENT_BYTES}-byte cap` },
        413,
      );
    }

    const apiKey = await getSecret(c.env.ANTHROPIC_API_KEY);
    if (!apiKey) {
      return c.json({ error: "internal_error", message: "ANTHROPIC_API_KEY not bound" }, 500);
    }
    // Memory-store CRUD isn't Messages-API inference, so skip the AI Gateway
    // (the SDK would otherwise auto-pick up `ANTHROPIC_BASE_URL` from env). The
    // gateway runs in authenticated mode and rejects non-Messages paths with 401
    // when the cf-aig-authorization header is absent. Hit Anthropic directly.
    // See docs/architecture/ai-gateway.md.
    const client = buildAnthropicClient({
      apiKey,
      baseURL: "https://api.anthropic.com",
      defaultHeaders: { "anthropic-beta": BETA_HEADER },
    });

    const path = `/orgs/${orgId}/errata.md`;
    // Listing with `depth` requires `order_by` per the Anthropic API. Drop both —
    // a single path_prefix scan ordered by path is fine here, since each org's
    // errata directory holds at most a handful of memories.
    const existing = await client.beta.memoryStores.memories
      .list(storeId, { path_prefix: path, order_by: "path" })
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
  },
);
