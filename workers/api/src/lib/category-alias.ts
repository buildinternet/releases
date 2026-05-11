import { categories } from "@buildinternet/releases-core/schema";
import {
  parseCategoryAliases,
  resolveCategorySlug,
  type Category,
} from "@buildinternet/releases-core/categories";
import type { createDb } from "../db.js";

type Db = ReturnType<typeof createDb>;

/**
 * Load every category row's aliases into a single alias-slug → canonical-slug
 * map. Used by the PATCH handler (conflict detection), the alias 301 redirect
 * paths, and `resolveCategoryInput` below. The categories table is tiny — one
 * row per customized category — and writes are infrequent, so we re-read on
 * each call rather than caching.
 */
export async function loadAliasMap(db: Db): Promise<Map<string, string>> {
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
 * Resolve a user-supplied category input (from POST/PATCH bodies) to a
 * canonical slug. Returns `{ ok: true, slug }` when the input is canonical or
 * a known alias; `{ ok: false }` otherwise. Caller surfaces the 400 with its
 * own message so it can include the original field name (e.g. `category`).
 */
export async function resolveCategoryInput(
  db: Db,
  input: string,
): Promise<{ ok: true; slug: Category } | { ok: false }> {
  const aliasMap = await loadAliasMap(db);
  const slug = resolveCategorySlug(input, aliasMap);
  return slug ? { ok: true, slug } : { ok: false };
}
