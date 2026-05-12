import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import { eq, and, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  knowledgePages,
  knowledgePageCitations,
  organizations,
  products,
  releases,
} from "@buildinternet/releases-core/schema";
import { newKnowledgePageCitationId } from "@buildinternet/releases-core/id";
import { newKnowledgePageId, orgWhere, productMatchByIdOrSlug } from "../utils.js";
import { KNOWLEDGE_PAGE_CITATIONS_CHUNK_SIZE } from "../lib/d1-limits.js";
import { validateJson } from "../lib/validate.js";
import {
  OrgOverviewResponseSchema,
  RegenerateOverviewBodySchema,
  RegenerateOverviewResponseSchema,
  ProductOverviewResponseSchema,
  ErrorResponseSchema,
} from "@buildinternet/releases-api-types";
import type { Env } from "../index.js";

const app = new Hono<Env>();

function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

/**
 * Resolve incoming citation source URLs to release IDs in one batched lookup.
 * Case-insensitive — releases.url is stored case-preserved so we LOWER() in
 * the predicate. Returns Map<lowercased URL, releaseId>; misses are absent.
 * With ~50 citations max per page the candidate set is small.
 */
async function resolveReleaseIds(
  db: ReturnType<typeof createDb>,
  urls: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (urls.length === 0) return out;
  const lowered = Array.from(new Set(urls.map((u) => u.toLowerCase())));
  const rows = await db
    .select({ id: releases.id, urlLower: sql<string>`LOWER(${releases.url})` })
    .from(releases)
    .where(sql`LOWER(${releases.url}) IN ${lowered}`);
  for (const r of rows) {
    if (!out.has(r.urlLower)) out.set(r.urlLower, r.id);
  }
  return out;
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
    if (!org) return c.json({ error: "not_found" }, 404);

    const body = c.req.valid("json");
    const citations = body.citations ?? [];

    // Content-aware cross-field check that the schema can't express on its own.
    // Bad spans (past the content end) are an authoring bug — fail loud rather
    // than persist garbage.
    for (let i = 0; i < citations.length; i++) {
      if (citations[i].endIndex > body.content.length) {
        return c.json(
          {
            error: "bad_citations",
            message: `citations[${i}].endIndex past content length`,
          },
          400,
        );
      }
    }

    const now = new Date().toISOString();
    const id = newKnowledgePageId();
    await db.run(sql`INSERT INTO knowledge_pages (id, scope, org_id, product_id, content, release_count, last_contributing_release_at, generated_at, updated_at)
      VALUES (${id}, 'org', ${org.id}, NULL, ${body.content}, ${body.releaseCount}, ${body.lastContributingReleaseAt ?? null}, ${now}, ${now})
      ON CONFLICT (scope, org_id) DO UPDATE SET content = ${body.content}, release_count = ${body.releaseCount}, last_contributing_release_at = ${body.lastContributingReleaseAt ?? null}, updated_at = ${now}`);

    // Look up the canonical page id — the INSERT may have lost to ON CONFLICT
    // and the existing row carries its own id. Citations cascade off it.
    const [pageRow] = await db
      .select({ id: knowledgePages.id })
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, org.id)));
    if (!pageRow) {
      return c.json({ error: "internal" }, 500);
    }

    // Citations are replace-all on every write. Omitting the field on the
    // wire == clearing them; explicit and predictable.
    await db
      .delete(knowledgePageCitations)
      .where(eq(knowledgePageCitations.knowledgePageId, pageRow.id));

    if (citations.length > 0) {
      const releaseIdByUrl = await resolveReleaseIds(
        db,
        citations.map((cit) => cit.sourceUrl),
      );
      const rows = citations.map((cit) => ({
        id: newKnowledgePageCitationId(),
        knowledgePageId: pageRow.id,
        startIndex: cit.startIndex,
        endIndex: cit.endIndex,
        sourceUrl: cit.sourceUrl,
        title: cit.title ?? null,
        citedText: cit.citedText,
        releaseId: releaseIdByUrl.get(cit.sourceUrl.toLowerCase()) ?? null,
        createdAt: now,
      }));
      for (let i = 0; i < rows.length; i += KNOWLEDGE_PAGE_CITATIONS_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + KNOWLEDGE_PAGE_CITATIONS_CHUNK_SIZE);
        // oxlint-disable-next-line no-await-in-loop -- D1 chunked insert
        await db.insert(knowledgePageCitations).values(chunk);
      }
    }

    return c.json({ ok: true, citations: citations.length });
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
