/**
 * Admin-only read-back for recommendations, plus the opt-in
 * "your source was added" notify. Gated by authMiddleware via
 * the "admin/recommendations" entry in route-namespaces.ts.
 *
 * CLI: `releases admin recommendations notify-added <rec_id> --org <slug> [--source <slug>]`
 */
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import {
  RecommendationNotifyAddedBodySchema,
  RecommendationNotifyAddedResultSchema,
} from "@buildinternet/releases-api-types";
import {
  organizations,
  recommendations,
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_TYPES,
} from "@buildinternet/releases-core/schema";
import { releaseWebBase } from "@buildinternet/releases-core/release-slug";
import {
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
  ValidationError,
} from "@releases/lib/releases-error";
import { createDb } from "../db.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { errorResponse } from "../lib/openapi-error.js";
import { recommendationRegistryUrl, sendRecommendationAdded } from "../lib/recommendation-email.js";
import { validateJson } from "../lib/validate.js";
import { findSourceForOrgSlug, orgWhere } from "../utils.js";

export const adminRecommendationRoutes = new Hono<Env>();

function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

function parseLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  return Math.max(1, Math.min(Number.isFinite(n) ? n : 50, 200));
}

function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(`${createdAt}:${id}`).toString("base64url");
}

function decodeCursor(raw: string | undefined): { createdAt: number; id: string } | null {
  if (!raw) return null;
  try {
    const [ts, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split(":");
    const createdAt = parseInt(ts ?? "", 10);
    const id = rest.join(":");
    if (!Number.isFinite(createdAt) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

adminRecommendationRoutes.get("/admin/recommendations", async (c) => {
  const db = getDb(c);
  const limit = parseLimit(c.req.query("limit"));
  const conditions: SQL[] = [];

  const status = c.req.query("status");
  if (status && (RECOMMENDATION_STATUSES as readonly string[]).includes(status)) {
    conditions.push(eq(recommendations.status, status));
  }
  const type = c.req.query("type");
  if (type && (RECOMMENDATION_TYPES as readonly string[]).includes(type)) {
    conditions.push(eq(recommendations.type, type));
  }
  if (c.req.query("includeArchived") !== "true") {
    conditions.push(eq(recommendations.archived, false));
  }

  const cursor = decodeCursor(c.req.query("cursor"));
  if (cursor) {
    conditions.push(
      or(
        lt(recommendations.createdAt, cursor.createdAt),
        and(eq(recommendations.createdAt, cursor.createdAt), lt(recommendations.id, cursor.id)),
      )!,
    );
  }

  const rows = await db
    .select()
    .from(recommendations)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(recommendations.createdAt), desc(recommendations.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return c.json({ items, nextCursor });
});

function webOrigin(env: Env["Bindings"]): string {
  const raw = releaseWebBase(env);
  try {
    return new URL(raw).origin;
  } catch {
    return "https://releases.sh";
  }
}

const ADDED_RATE_LIMIT_WINDOW_SECONDS = 3600;

adminRecommendationRoutes.post(
  "/admin/recommendations/:id/notify-added",
  describeRoute({
    tags: ["Recommendations"],
    summary: "Email the submitter that their source was added",
    description:
      "Opt-in operator action. Sends a “your submission was added” email to the recommendation’s contact address, naming the onboarded org/source and linking its live releases.sh URL. Does not run on triage, close, or archive. Idempotent: a second call returns `sent: false, reason: already_notified` and does not email again. CLI: `releases admin recommendations notify-added <rec_id> --org <slug> [--source <slug>]`.",
    responses: {
      200: {
        description: "Sent, or already notified (idempotent replay).",
        content: {
          "application/json": { schema: resolver(RecommendationNotifyAddedResultSchema) },
        },
      },
      400: errorResponse("No contact email, or missing orgSlug"),
      404: errorResponse("Recommendation, organization, or source not found"),
      429: errorResponse("Hourly submitter-email budget exhausted"),
      503: errorResponse("Transactional email is not configured"),
    },
  }),
  validateJson(RecommendationNotifyAddedBodySchema),
  async (c) => {
    const id = c.req.param("id");
    const { orgSlug, sourceSlug } = c.req.valid("json");
    const db = getDb(c);

    const [row] = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.id, id))
      .limit(1);
    if (!row) return respondError(c, new NotFoundError("Recommendation not found"));
    if (!row.contactEmail) {
      return respondError(
        c,
        new ValidationError("This recommendation has no contact email.", { code: "bad_request" }),
      );
    }

    if (row.addedNotifiedAt != null) {
      return c.json({
        ok: true as const,
        sent: false,
        reason: "already_notified" as const,
        notifiedAt: row.addedNotifiedAt,
        contactEmail: row.contactEmail,
      });
    }

    const [org] = await db
      .select({ name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(orgWhere(orgSlug))
      .limit(1);
    if (!org) return respondError(c, new NotFoundError("Organization not found"));

    let sourceName: string | undefined;
    let resolvedSourceSlug: string | undefined;
    if (sourceSlug) {
      const source = await findSourceForOrgSlug(db, org.slug, sourceSlug);
      if (!source) return respondError(c, new NotFoundError("Source not found"));
      sourceName = source.name;
      resolvedSourceSlug = source.slug;
    }

    const listing = {
      orgName: org.name,
      orgSlug: org.slug,
      sourceName,
      sourceSlug: resolvedSourceSlug,
    };
    const origin = webOrigin(c.env);
    const registryUrl = recommendationRegistryUrl(origin, listing);

    const result = await sendRecommendationAdded(c.env, row, listing);
    if (!result.sent) {
      if (result.reason === "rate_capped") {
        c.header("Retry-After", String(ADDED_RATE_LIMIT_WINDOW_SECONDS));
        return respondError(
          c,
          new RateLimitedError("Too many added-notification emails this hour. Retry later."),
        );
      }
      if (result.reason === "no_binding") {
        return respondError(
          c,
          new ServiceUnavailableError("Transactional email is not configured."),
        );
      }
      return respondError(c, new ServiceUnavailableError("Could not send the added notification."));
    }

    await db
      .update(recommendations)
      .set({ addedNotifiedAt: result.notifiedAt })
      .where(eq(recommendations.id, id));

    return c.json({
      ok: true as const,
      sent: true,
      notifiedAt: result.notifiedAt,
      registryUrl,
      contactEmail: row.contactEmail,
    });
  },
);
