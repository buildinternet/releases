/**
 * GET/PUT /v1/admin/marketing-classifier — operator control of the marketing
 * classifier's suppression threshold, plus a read-only list of sources with
 * `metadata.marketingFilter` on. Per-source opt-in/opt-out and hint edits go
 * through the existing `PATCH /v1/sources/:id` route (metadata merge) — this
 * route does not duplicate that write path.
 *
 * Modeled on `routes/ai-models.ts` (same admin gate, same site_settings
 * overlay pattern via `lib/marketing-classifier-settings.ts`).
 */
import { Hono } from "hono";
import { MarketingClassifierThresholdPutSchema } from "@buildinternet/releases-api-types";
import { DEFAULT_MARKETING_THRESHOLD } from "@releases/core-internal/marketing-classifier-settings";
import { logEvent } from "@releases/lib/log-event";
import { ForbiddenError } from "@releases/lib/releases-error";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { isValidBearerAuth, resolveAuthIdentity } from "../middleware/auth.js";
import { validateJson } from "../lib/validate.js";
import { respondError } from "../lib/error-response.js";
import { clearMarketingThresholdCache } from "../lib/marketing-classifier-settings.js";
import {
  getStoredMarketingThreshold,
  putStoredMarketingThreshold,
  type StoredMarketingThreshold,
} from "../queries/site-settings.js";
import {
  getMarketingFilteredSources,
  type MarketingFilteredSource,
} from "../queries/marketing-classifier-sources.js";

export const adminMarketingClassifierRoutes = new Hono<Env>();

async function requireAdmin(c: Parameters<typeof isValidBearerAuth>[0]) {
  if (!(await isValidBearerAuth(c))) {
    return respondError(c, new ForbiddenError("Admin scope required."));
  }
  return null;
}

function buildState(stored: StoredMarketingThreshold, sources: MarketingFilteredSource[]) {
  return {
    threshold: stored.threshold,
    defaultThreshold: DEFAULT_MARKETING_THRESHOLD,
    updatedAt: stored.updatedAt,
    sources,
  };
}

adminMarketingClassifierRoutes.get("/admin/marketing-classifier", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;

  const db = createDb(c.env.DB);
  const [stored, sources] = await Promise.all([
    getStoredMarketingThreshold(db),
    getMarketingFilteredSources(db),
  ]);
  c.header("Cache-Control", "private, no-store");
  return c.json(buildState(stored, sources));
});

adminMarketingClassifierRoutes.put(
  "/admin/marketing-classifier",
  async (c, next) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    await next();
  },
  validateJson(MarketingClassifierThresholdPutSchema),
  async (c) => {
    // Range is enforced by MarketingClassifierThresholdPutSchema.
    const { threshold } = c.req.valid("json");
    const db = createDb(c.env.DB);
    const previous = await getStoredMarketingThreshold(db);
    const stored = await putStoredMarketingThreshold(db, threshold);
    clearMarketingThresholdCache();

    const identity = await resolveAuthIdentity(c);
    const actor =
      identity?.kind === "root"
        ? "root-key"
        : identity?.kind === "token"
          ? identity.tokenId
          : "unknown";
    logEvent("info", {
      component: "marketing-classifier-settings",
      event: "threshold-changed",
      actor,
      previousThreshold: previous.threshold,
      threshold: stored.threshold,
    });

    return c.json(buildState(stored, await getMarketingFilteredSources(db)));
  },
);
