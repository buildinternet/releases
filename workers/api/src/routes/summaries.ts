import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import { eq, and, desc } from "drizzle-orm";
import { createDb } from "../db.js";
import { releaseSummaries, sources } from "@buildinternet/releases-core/schema";
import { sourceMatchByIdOrSlug } from "../utils.js";
import { validateJson } from "../lib/validate.js";
import type { Env } from "../index.js";
import {
  ErrorResponseSchema,
  SourceSummariesResponseSchema,
  CreateSourceSummaryBodySchema,
  CreateSourceSummaryResponseSchema,
} from "@buildinternet/releases-api-types";

const app = new Hono<Env>();

app.get(
  "/sources/:slug/summaries",
  describeRoute({
    hide: hideInProduction,
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

app.post(
  "/sources/:slug/summaries",
  describeRoute({
    hide: hideInProduction,
    tags: ["Sources"],
    summary: "Upsert a release summary",
    description:
      "Upserts an AI-generated release summary for the source. On conflict (`UNIQUE(sourceId, orgId, type, year, month)`) updates `summary`, `releaseCount`, `windowDays`, and `generatedAt`. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
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
  validateJson(CreateSourceSummaryBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const body = c.req.valid("json");

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
