/**
 * Auto-regenerate the playbook header after source mutations.
 *
 * Deterministic (no AI) — just re-assembles markdown from current source metadata.
 * Only updates the header portion. Agent notes are stored separately and untouched.
 */

import { eq, and, sql } from "drizzle-orm";
import { createDb } from "./db.js";
import {
  sources,
  organizations,
  products,
  knowledgePages,
} from "@buildinternet/releases-core/schema";
import {
  generatePlaybookHeader,
  extractNotesFromLegacyPlaybook,
} from "@releases/ai-internal/playbook";
import { newKnowledgePageId } from "./utils.js";

/**
 * Regenerate the playbook header for an org. Fire-and-forget safe — catches all errors.
 *
 * If the org has an old-format playbook (header + notes combined), this migrates it:
 * notes are extracted into the notes column and the content is replaced with header-only.
 */
export async function regeneratePlaybook(
  db: ReturnType<typeof createDb>,
  orgId: string,
): Promise<void> {
  try {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org) return;

    const orgSources = await db.select().from(sources).where(eq(sources.orgId, orgId));
    if (orgSources.length === 0) return;

    const orgProducts = await db
      .select({
        id: products.id,
        name: products.name,
        slug: products.slug,
        description: products.description,
      })
      .from(products)
      .where(eq(products.orgId, orgId));

    const header = generatePlaybookHeader({
      orgName: org.name,
      orgSlug: org.slug,
      domain: org.domain,
      sources: orgSources,
      products: orgProducts.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
      })),
    });

    // Check for existing playbook — migrate notes from old format if needed
    const [existing] = await db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "playbook"), eq(knowledgePages.orgId, orgId)));

    // Prefer stored notes; fall back to extracting from old-format content for migration
    const notes: string | null =
      existing?.notes ?? (existing ? extractNotesFromLegacyPlaybook(existing.content) : null);

    const now = new Date().toISOString();
    const id = newKnowledgePageId();

    await db.run(sql`INSERT INTO knowledge_pages (id, scope, org_id, product_id, content, notes, release_count, last_contributing_release_at, generated_at, updated_at)
      VALUES (${id}, 'playbook', ${orgId}, NULL, ${header}, ${notes}, ${orgSources.length}, NULL, ${now}, ${now})
      ON CONFLICT (scope, org_id) DO UPDATE SET content = ${header}, notes = COALESCE(knowledge_pages.notes, ${notes}), release_count = ${orgSources.length}, updated_at = ${now}`);
  } catch {
    // Fire-and-forget — don't let playbook regen failures break source mutations
  }
}
