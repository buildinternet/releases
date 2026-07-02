import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import { eq, and } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  knowledgePages,
  knowledgePageCitations,
  organizations,
  products,
} from "@buildinternet/releases-core/schema";
import { orgWhere, productMatchByIdOrSlug } from "../utils.js";
import { upsertOrgOverview } from "@releases/core-internal/overview-upsert";
import { validateJson } from "../lib/validate.js";
import {
  OrgOverviewResponseSchema,
  RegenerateOverviewBodySchema,
  RegenerateOverviewResponseSchema,
  ProductOverviewResponseSchema,
  ErrorResponseSchema,
} from "@buildinternet/releases-api-types";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { NotFoundError, ValidationError } from "@releases/lib/releases-error";

const app = new Hono<Env>();

function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

app.get(
  "/orgs/:slug/overview",
  describeRoute({
    tags: ["Overviews"],
    summary: "Get org overview",
    description:
      "Returns the AI-generated knowledge page for the org, including inline citations ordered by character position. Returns `null` when no overview has been generated yet. The org is resolved by slug or typed `org_…` ID.",
    responses: {
      200: {
        description: "Org overview page, or null when none exists",
        content: { "application/json": { schema: resolver(OrgOverviewResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = getDb(c);
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(c.req.param("slug")));
    if (!org) return c.json(null);

    const [row] = await db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, org.id)));
    if (!row) return c.json(null);

    const citationRows = await db
      .select({
        startIndex: knowledgePageCitations.startIndex,
        endIndex: knowledgePageCitations.endIndex,
        sourceUrl: knowledgePageCitations.sourceUrl,
        title: knowledgePageCitations.title,
        citedText: knowledgePageCitations.citedText,
        releaseId: knowledgePageCitations.releaseId,
      })
      .from(knowledgePageCitations)
      .where(eq(knowledgePageCitations.knowledgePageId, row.id))
      .orderBy(knowledgePageCitations.startIndex);

    return c.json({ ...row, citations: citationRows });
  },
);

app.post(
  "/orgs/:slug/overview",
  describeRoute({
    hide: hideInProduction,
    tags: ["Overviews"],
    summary: "Upsert org overview",
    description:
      "Creates or replaces the org's AI-generated knowledge page. Accepts the markdown `content`, the `releaseCount` it was derived from, the ISO timestamp of the most-recent contributing release (`lastContributingReleaseAt`), and an optional `citations` array of character-span objects. Citations are replace-all — omitting the field clears any existing citations. Requires Bearer auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Overview upserted",
        content: { "application/json": { schema: resolver(RegenerateOverviewResponseSchema) } },
      },
      400: {
        description: "Missing required fields, malformed body, or invalid citations",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Org not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(RegenerateOverviewBodySchema),
  async (c) => {
    const db = getDb(c);
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(c.req.param("slug")));
    if (!org) return respondError(c, new NotFoundError());

    const body = c.req.valid("json");
    const citations = body.citations ?? [];

    // Content-aware cross-field check that the schema can't express on its own.
    // Bad spans (past the content end) are an authoring bug — fail loud rather
    // than persist garbage.
    for (let i = 0; i < citations.length; i++) {
      if (citations[i].endIndex > body.content.length) {
        return respondError(
          c,
          new ValidationError(`citations[${i}].endIndex past content length`, {
            code: "bad_request",
          }),
        );
      }
    }

    const result = await upsertOrgOverview(db, {
      orgId: org.id,
      content: body.content,
      citations: citations.map((cit) => ({
        startIndex: cit.startIndex,
        endIndex: cit.endIndex,
        sourceUrl: cit.sourceUrl,
        title: cit.title ?? null,
        citedText: cit.citedText,
      })),
      releaseCount: body.releaseCount,
      lastContributingReleaseAt: body.lastContributingReleaseAt ?? null,
    });

    return c.json({ ok: true, citations: result.citationsWritten });
  },
);

app.get(
  "/products/:slug/overview",
  describeRoute({
    tags: ["Overviews"],
    summary: "Get product overview",
    description:
      "Returns the AI-generated knowledge page for the product, or `null` when no overview has been generated yet. The product is resolved by typed `prod_…` ID or slug via `productMatchByIdOrSlug`.",
    responses: {
      200: {
        description: "Product overview page, or null when none exists",
        content: { "application/json": { schema: resolver(ProductOverviewResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = getDb(c);
    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(productMatchByIdOrSlug(c.req.param("slug")));
    if (!product) return c.json(null);

    const [row] = await db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "product"), eq(knowledgePages.productId, product.id)));

    return c.json(row ?? null);
  },
);

export default app;
