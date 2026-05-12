import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { eq, and, desc } from "drizzle-orm";
import { createDb } from "../db.js";
import { releaseSummaries, sources } from "@buildinternet/releases-core/schema";
import { sourceMatchByIdOrSlug } from "../utils.js";
import type { Env } from "../index.js";
import {
  ErrorResponseSchema,
  SourceSummariesResponseSchema,
  CreateSourceSummaryResponseSchema,
} from "@buildinternet/releases-api-types";

const app = new Hono<Env>();

app.get(
  "/sources/:slug/summaries",
  describeRoute({
    tags: ["Sources"],
    summary: "List release summaries for a source",
    description:
      "Returns AI-generated release summaries for the source, ordered by `generatedAt` descending. Filter by `?type=rolling|monthly`, `?year=`, `?month=`. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Summary rows",
        content: { "application/json": { schema: resolver(SourceSummariesResponseSchema) } },
      },
      404: {
        description: "Source not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const type = c.req.query("type");
    const year = c.req.query("year");
    const month = c.req.query("month");

    const [source] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(sourceMatchByIdOrSlug(slug));
    if (!source) return c.json({ error: "Source not found" }, 404);

    const conditions = [eq(releaseSummaries.sourceId, source.id)];
    if (type) conditions.push(eq(releaseSummaries.type, type as "rolling" | "monthly"));
    if (year) conditions.push(eq(releaseSummaries.year, parseInt(year)));
    if (month) conditions.push(eq(releaseSummaries.month, parseInt(month)));

    const rows = await db
      .select()
      .from(releaseSummaries)
      .where(and(...conditions))
      .orderBy(desc(releaseSummaries.generatedAt));

    return c.json(rows);
  },
);

/** Validate + extract the POST /summaries body. Returns 400 on parse/type failures. */
function parseSummaryBody(body: unknown):
  | {
      ok: true;
      data: {
        type: "rolling" | "monthly";
        year?: number | null;
        month?: number | null;
        windowDays?: number | null;
        summary: string;
        releaseCount: number;
      };
    }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (b.type !== "rolling" && b.type !== "monthly") {
    return { ok: false, error: "type must be 'rolling' or 'monthly'" };
  }
  if (typeof b.summary !== "string" || b.summary.length === 0) {
    return { ok: false, error: "summary must be a non-empty string" };
  }
  if (
    typeof b.releaseCount !== "number" ||
    !Number.isFinite(b.releaseCount) ||
    b.releaseCount < 0
  ) {
    return { ok: false, error: "releaseCount must be a non-negative number" };
  }
  return {
    ok: true,
    data: {
      type: b.type,
      year:
        b.year == null || typeof b.year === "number"
          ? (b.year as number | null | undefined)
          : undefined,
      month:
        b.month == null || typeof b.month === "number"
          ? (b.month as number | null | undefined)
          : undefined,
      windowDays:
        b.windowDays == null || typeof b.windowDays === "number"
          ? (b.windowDays as number | null | undefined)
          : undefined,
      summary: b.summary,
      releaseCount: b.releaseCount,
    },
  };
}

app.post(
  "/sources/:slug/summaries",
  describeRoute({
    tags: ["Sources"],
    summary: "Upsert a release summary",
    description:
      "Upserts an AI-generated release summary for the source. On conflict (`UNIQUE(sourceId, orgId, type, year, month)`) updates `summary`, `releaseCount`, `windowDays`, and `generatedAt`. Body: `{ type, summary, releaseCount, year?, month?, windowDays? }`. Body documented in prose — formal `requestBody` modelling is deferred to the validator-middleware phase of #894. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Summary upserted",
        content: { "application/json": { schema: resolver(CreateSourceSummaryResponseSchema) } },
      },
      400: {
        description: "Missing or invalid required fields",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Source not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);
    }
    const parsed = parseSummaryBody(rawBody);
    if (!parsed.ok) {
      return c.json({ error: "bad_request", message: parsed.error }, 400);
    }
    const body = parsed.data;

    const [source] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(sourceMatchByIdOrSlug(slug));
    if (!source) return c.json({ error: "Source not found" }, 404);

    await db
      .insert(releaseSummaries)
      .values({
        sourceId: source.id,
        orgId: null,
        type: body.type,
        year: body.year ?? null,
        month: body.month ?? null,
        windowDays: body.windowDays ?? null,
        summary: body.summary,
        releaseCount: body.releaseCount,
      })
      .onConflictDoUpdate({
        target: [
          releaseSummaries.sourceId,
          releaseSummaries.orgId,
          releaseSummaries.type,
          releaseSummaries.year,
          releaseSummaries.month,
        ],
        set: {
          summary: body.summary,
          releaseCount: body.releaseCount,
          windowDays: body.windowDays ?? null,
          generatedAt: new Date().toISOString(),
        },
      });

    return c.json({ ok: true });
  },
);

export default app;
