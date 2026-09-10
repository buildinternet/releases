/**
 * GET/PUT /v1/ai/models — operator overlay of OpenRouter model ids per cheap-call
 * lane. Wrangler vars remain the fallback; an empty overlay is a no-op.
 *
 * Lives on the existing `ai` admin namespace (same bucket as POST /v1/ai/lanes).
 * Admin namespaces are not in the public OpenAPI coverage gate; the PUT body is
 * still validated through the shared wire schema.
 */
import { Hono } from "hono";
import { AiLaneModelsPutSchema } from "@buildinternet/releases-api-types";
import {
  AI_LANES,
  parseOpenRouterModelId,
  type AiLaneModels,
} from "@releases/core-internal/ai-lane-models";
import { logEvent } from "@releases/lib/log-event";
import { ForbiddenError, ValidationError } from "@releases/lib/releases-error";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { isValidBearerAuth, resolveAuthIdentity } from "../middleware/auth.js";
import { validateJson } from "../lib/validate.js";
import { respondError } from "../lib/error-response.js";
import {
  buildLaneStates,
  clearAiLaneModelCache,
  fetchOpenRouterCatalog,
} from "../lib/ai-lane-models.js";
import { getStoredAiLaneModels, putStoredAiLaneModels } from "../queries/site-settings.js";

export const aiModelRoutes = new Hono<Env>();

async function requireAdmin(c: Parameters<typeof isValidBearerAuth>[0]) {
  if (!(await isValidBearerAuth(c))) {
    return respondError(c, new ForbiddenError("Admin scope required."));
  }
  return null;
}

aiModelRoutes.get("/ai/models", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;

  const [{ lanes, updatedAt }, catalog] = await Promise.all([
    buildLaneStates(c.env),
    fetchOpenRouterCatalog(c.env),
  ]);
  c.header("Cache-Control", "private, no-store");
  return c.json({
    lanes,
    catalog: catalog.catalog,
    catalogFetchedAt: catalog.catalogFetchedAt,
    catalogError: catalog.catalogError,
    updatedAt,
  });
});

aiModelRoutes.put(
  "/ai/models",
  async (c, next) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    await next();
  },
  validateJson(AiLaneModelsPutSchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const current = await getStoredAiLaneModels(db);
    const next: AiLaneModels = { ...current.models };
    const body = c.req.valid("json").models;

    for (const lane of AI_LANES) {
      if (!(lane in body)) continue;
      const raw = body[lane];
      if (raw === null || raw === undefined || raw.trim() === "") {
        delete next[lane];
        continue;
      }
      const id = parseOpenRouterModelId(raw);
      if (!id) {
        return respondError(
          c,
          new ValidationError(`${lane}: must be an OpenRouter model id (vendor/model)`),
        );
      }
      next[lane] = id;
    }

    const stored = await putStoredAiLaneModels(db, next);
    clearAiLaneModelCache();

    const identity = await resolveAuthIdentity(c);
    const actor =
      identity?.kind === "root"
        ? "root-key"
        : identity?.kind === "token"
          ? identity.tokenId
          : "unknown";
    const changed = AI_LANES.filter((lane) => current.models[lane] !== stored.models[lane]);
    logEvent("info", {
      component: "ai-lane-models",
      event: "models-changed",
      actor,
      changed,
      models: stored.models,
    });

    const [{ lanes, updatedAt }, catalog] = await Promise.all([
      buildLaneStates(c.env),
      fetchOpenRouterCatalog(c.env),
    ]);
    return c.json({
      lanes,
      catalog: catalog.catalog,
      catalogFetchedAt: catalog.catalogFetchedAt,
      catalogError: catalog.catalogError,
      updatedAt,
    });
  },
);
