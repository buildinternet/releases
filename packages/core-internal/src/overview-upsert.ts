/**
 * Shared upsert for org overviews (knowledge_pages + knowledge_page_citations).
 *
 * One copy lives here; both `POST /v1/orgs/:slug/overview` (the agent-driven
 * write surface) and `BatchOverviewWorkflow` (the batch-API write surface)
 * call into it so the SQL doesn't drift between the two write paths.
 *
 * Semantics:
 *   - Last-write-wins on the `(scope='org', org_id)` unique index.
 *   - Citations are replace-all on every write — omitting citations clears
 *     any prior rows for the page.
 *   - Caller is responsible for any pre-validation (citation-span vs. body
 *     length, etc.). This helper trusts its inputs.
 *
 * The INSERT … ON CONFLICT statement is hand-written because Drizzle's
 * upsert helper doesn't compose with the named unique index here; the SQL
 * shape is tied to the migration that created the index.
 */

import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  knowledgePages,
  knowledgePageCitations,
  releases,
} from "@buildinternet/releases-core/schema";
import { newKnowledgePageId, newKnowledgePageCitationId } from "@buildinternet/releases-core/id";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle generic
type AnyDb = DrizzleD1Database<any>;

/** Per-page bind budget: id, page_id, start, end, source_url, title, cited_text, release_id, created_at (9). */
const CITATIONS_CHUNK_SIZE = 11;

/** Max URLs per IN-clause lookup. D1's 100-bind cap, with headroom. */
const URL_LOOKUP_CHUNK_SIZE = 90;

export interface OverviewCitationInput {
  startIndex: number;
  endIndex: number;
  sourceUrl: string;
  title: string | null;
  citedText: string;
}

export interface UpsertOrgOverviewInput {
  orgId: string;
  content: string;
  citations: OverviewCitationInput[];
  releaseCount: number;
  lastContributingReleaseAt: string | null;
}

export interface UpsertOrgOverviewResult {
  pageId: string;
  citationsWritten: number;
}

/**
 * Insert-or-update the org's overview page and (replace-all) its citations.
 * Returns the page id and the number of citation rows written.
 */
export async function upsertOrgOverview(
  db: AnyDb,
  input: UpsertOrgOverviewInput,
): Promise<UpsertOrgOverviewResult> {
  const now = new Date().toISOString();
  const id = newKnowledgePageId();

  await db.run(sql`INSERT INTO knowledge_pages (id, scope, org_id, product_id, content, release_count, last_contributing_release_at, generated_at, updated_at)
      VALUES (${id}, 'org', ${input.orgId}, NULL, ${input.content}, ${input.releaseCount}, ${input.lastContributingReleaseAt}, ${now}, ${now})
      ON CONFLICT (scope, org_id) DO UPDATE SET content = ${input.content}, release_count = ${input.releaseCount}, last_contributing_release_at = ${input.lastContributingReleaseAt}, updated_at = ${now}`);

  // The INSERT may have lost to ON CONFLICT, in which case `id` isn't the
  // row's actual id. Read the canonical id back so citations cascade off it.
  const [pageRow] = await db
    .select({ id: knowledgePages.id })
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, input.orgId)));
  if (!pageRow) {
    throw new Error(
      `upsertOrgOverview: knowledge_pages row missing after upsert for org ${input.orgId}`,
    );
  }

  await db
    .delete(knowledgePageCitations)
    .where(eq(knowledgePageCitations.knowledgePageId, pageRow.id));

  if (input.citations.length === 0) {
    return { pageId: pageRow.id, citationsWritten: 0 };
  }

  const releaseIdByUrl = await resolveReleaseIdsByUrl(
    db,
    input.citations.map((c) => c.sourceUrl),
  );

  const rows = input.citations.map((cit) => ({
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

  for (let i = 0; i < rows.length; i += CITATIONS_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CITATIONS_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- D1 chunked insert
    await db.insert(knowledgePageCitations).values(chunk);
  }

  return { pageId: pageRow.id, citationsWritten: rows.length };
}

/**
 * Case-insensitive URL → releaseId lookup for citation source resolution.
 * Chunks at 90 binds per IN-clause to stay under D1's 100-bind cap.
 */
async function resolveReleaseIdsByUrl(db: AnyDb, urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (urls.length === 0) return out;
  const lowered = Array.from(new Set(urls.map((u) => u.toLowerCase())));

  for (let i = 0; i < lowered.length; i += URL_LOOKUP_CHUNK_SIZE) {
    const chunk = lowered.slice(i, i + URL_LOOKUP_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- D1 bind-chunked SELECT
    const rows: Array<{ id: string; urlLower: string }> = await db
      .select({ id: releases.id, urlLower: sql<string>`LOWER(${releases.url})` })
      .from(releases)
      .where(sql`LOWER(${releases.url}) IN ${chunk}`);
    for (const r of rows) {
      if (!out.has(r.urlLower)) out.set(r.urlLower, r.id);
    }
  }

  return out;
}
