import type { DrizzleD1Database } from "drizzle-orm/d1";
import { categories } from "@buildinternet/releases-core/schema";
import {
  parseCategoryAliases,
  resolveCategorySlug,
  type Category,
} from "@buildinternet/releases-core/categories";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle generic
type AnyDb = DrizzleD1Database<any>;

/**
 * Load every category row's aliases into a single alias-slug → canonical-slug
 * map. Used by the PATCH handler (conflict detection), the alias 301 redirect
 * paths, and `resolveCategoryInput` below. The categories table is tiny — one
 * row per customized category — and writes are infrequent, so we re-read on
 * each call rather than caching.
 *
 * Lives in `@releases/core-internal` (not the API worker) so the API and MCP
 * workers resolve aliases through one copy — the REST `/v1/orgs` read filter
 * and the MCP `list_organizations` filter can't drift (#1277).
 */
export async function loadAliasMap(db: AnyDb): Promise<Map<string, string>> {
  const rows = await db
    .select({ slug: categories.slug, aliases: categories.aliases })
    .from(categories);
  const map = new Map<string, string>();
  for (const r of rows) {
    for (const a of parseCategoryAliases(r.aliases)) {
      map.set(a, r.slug);
    }
  }
  return map;
}

/**
 * Resolve a user-supplied category input (from POST/PATCH bodies or a read
 * filter) to a canonical slug. Returns `{ ok: true, slug }` when the input is
 * canonical or a known alias; `{ ok: false }` otherwise. Write callers surface
 * the 400 with their own message (so it can name the original field); read
 * callers fail open to unfiltered.
 */
export async function resolveCategoryInput(
  db: AnyDb,
  input: string,
): Promise<{ ok: true; slug: Category } | { ok: false }> {
  const aliasMap = await loadAliasMap(db);
  const slug = resolveCategorySlug(input, aliasMap);
  return slug ? { ok: true, slug } : { ok: false };
}
