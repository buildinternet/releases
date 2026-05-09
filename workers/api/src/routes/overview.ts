import { Hono } from "hono";
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
import type { Env } from "../index.js";

const app = new Hono<Env>();

function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

interface IncomingCitation {
  startIndex: number;
  endIndex: number;
  sourceUrl: string;
  title: string | null;
  citedText: string;
}

/**
 * Validate the citations payload before any DB work. Bad spans (negative,
 * inverted, past content end) are an authoring bug — fail loud rather than
 * persist garbage.
 */
function validateCitations(
  raw: unknown,
  contentLength: number,
): { ok: true; value: IncomingCitation[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "citations must be an array" };
  const out: IncomingCitation[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as Partial<IncomingCitation> | null;
    if (!c || typeof c !== "object") {
      return { ok: false, error: `citations[${i}] must be an object` };
    }
    if (typeof c.startIndex !== "number" || !Number.isInteger(c.startIndex) || c.startIndex < 0) {
      return { ok: false, error: `citations[${i}].startIndex invalid` };
    }
    if (
      typeof c.endIndex !== "number" ||
      !Number.isInteger(c.endIndex) ||
      c.endIndex <= c.startIndex
    ) {
      return { ok: false, error: `citations[${i}].endIndex must be > startIndex` };
    }
    if (c.endIndex > contentLength) {
      return { ok: false, error: `citations[${i}].endIndex past content length` };
    }
    if (typeof c.sourceUrl !== "string" || !c.sourceUrl) {
      return { ok: false, error: `citations[${i}].sourceUrl required` };
    }
    if (typeof c.citedText !== "string" || !c.citedText) {
      return { ok: false, error: `citations[${i}].citedText required` };
    }
    out.push({
      startIndex: c.startIndex,
      endIndex: c.endIndex,
      sourceUrl: c.sourceUrl,
      title: c.title ?? null,
      citedText: c.citedText,
    });
  }
  return { ok: true, value: out };
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

app.get("/orgs/:slug/overview", async (c) => {
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
});

app.post("/orgs/:slug/overview", async (c) => {
  const db = getDb(c);
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(orgWhere(c.req.param("slug")));
  if (!org) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json<{
    content: string;
    releaseCount: number;
    lastContributingReleaseAt?: string | null;
    citations?: unknown;
  }>();
  if (!body.content || body.releaseCount == null) {
    return c.json({ error: "Missing required fields (content, releaseCount)" }, 400);
  }

  const citationsResult = validateCitations(body.citations, body.content.length);
  if (!citationsResult.ok) {
    return c.json({ error: "bad_citations", message: citationsResult.error }, 400);
  }
  const citations = citationsResult.value;

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
      title: cit.title,
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
});

app.get("/products/:slug/overview", async (c) => {
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
});

export default app;
