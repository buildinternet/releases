/**
 * GET/PUT /v1/admin/marketing-classifier — operator control of the marketing
 * classifier's suppression threshold, plus a read-only list of sources with
 * `metadata.marketingFilter` on. Per-source opt-in/opt-out and hint edits go
 * through the existing `PATCH /v1/sources/:id` route (metadata merge) — this
 * route does not duplicate that write path.
 *
 * POST /v1/admin/marketing-classifier/reclassify re-runs the classifier on
 * rows that are already stored (a bulk import that skipped the ingest pass,
 * or a cleanup after a threshold change). Bounded and synchronous — not a
 * workflow. `dryRun` defaults to true.
 *
 * Modeled on `routes/ai-models.ts` (same admin gate, same site_settings
 * overlay pattern via `lib/classification/marketing-classifier-settings.ts`).
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { sources as sourcesTable } from "@buildinternet/releases-core/schema";
import { MarketingClassifierThresholdPutSchema } from "@buildinternet/releases-api-types";
import { DEFAULT_MARKETING_THRESHOLD } from "@releases/core-internal/marketing-classifier-settings";
import { logEvent } from "@releases/lib/log-event";
import {
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@releases/lib/releases-error";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { isValidBearerAuth, resolveAuthIdentity } from "../middleware/auth.js";
import { validateJson } from "../lib/validate.js";
import { respondError } from "../lib/error-response.js";
import { clearMarketingThresholdCache } from "../lib/classification/marketing-classifier-settings.js";
import {
  RECLASSIFY_MAX,
  reclassifyReleaseIds,
  reclassifySourcePage,
} from "../lib/classification/reclassify-marketing.js";
import { invalidateLatestCache } from "../lib/latest-cache.js";
import { buildFetchOneEnv } from "../workflows/_fetch-env.js";
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

const ReclassifySchema = z
  .object({
    releaseId: z.string().min(1).optional(),
    releaseIds: z.array(z.string().min(1)).min(1).max(RECLASSIFY_MAX).optional(),
    sourceId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(RECLASSIFY_MAX).optional(),
    after: z.string().min(1).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

type ReclassifyBody = z.infer<typeof ReclassifySchema>;

/** Exactly one selector. `limit` / `after` page a source and nothing else. */
function reclassifySelectorError(body: ReclassifyBody): string | null {
  const selectors = [body.releaseId, body.releaseIds, body.sourceId].filter((v) => v !== undefined);
  if (selectors.length !== 1) {
    return "Provide exactly one of releaseId, releaseIds, or sourceId.";
  }
  if (body.sourceId === undefined && (body.limit !== undefined || body.after !== undefined)) {
    return "limit and after are only valid with sourceId.";
  }
  return null;
}

adminMarketingClassifierRoutes.post(
  "/admin/marketing-classifier/reclassify",
  async (c, next) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    await next();
  },
  validateJson(ReclassifySchema),
  async (c) => {
    const body = c.req.valid("json");
    const selectorError = reclassifySelectorError(body);
    if (selectorError) return respondError(c, new ValidationError(selectorError));

    const db = createDb(c.env.DB);
    const dryRun = body.dryRun ?? true;
    const fetchEnv = await buildFetchOneEnv(c.env);

    let report;
    if (body.sourceId) {
      const [src] = await db
        .select({ id: sourcesTable.id })
        .from(sourcesTable)
        .where(eq(sourcesTable.id, body.sourceId))
        .limit(1);
      if (!src) return respondError(c, new NotFoundError("Source not found"));
      report = await reclassifySourcePage(db, fetchEnv, body.sourceId, {
        dryRun,
        limit: body.limit ?? RECLASSIFY_MAX,
        ...(body.after ? { after: body.after } : {}),
      });
    } else {
      const ids = body.releaseId ? [body.releaseId] : [...new Set(body.releaseIds ?? [])];
      report = await reclassifyReleaseIds(db, fetchEnv, ids, { dryRun });
      if (body.releaseId && report.missing.includes(body.releaseId)) {
        return respondError(c, new NotFoundError("Release not found"));
      }
    }

    if (report.providerMissing) {
      return respondError(
        c,
        new ServiceUnavailableError("No model provider configured for the marketing classifier"),
      );
    }

    const applied = report.results.reduce((n, row) => n + (row.applied ? 1 : 0), 0);
    if (applied > 0) {
      // Same latest-feed purge as batch-suppress. Awaited so a cleanup curl
      // has dropped the rows from `/v1/releases/latest` before it returns.
      // The flag-off path returns immediately.
      await invalidateLatestCache(c.env, { nReleases: applied, cause: "marketing-reclassify" });
    }

    c.header("Cache-Control", "private, no-store");
    return c.json(report);
  },
);
