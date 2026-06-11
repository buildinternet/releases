/**
 * Word-boundary entity matching for search.
 *
 * The entity sections of /v1/search (orgs, products, sources) candidate via
 * SQL `LIKE %query%`, which substring-matches: "ai" hits React Em·ai·l, every
 * `.ai` domain, and "mode" hits "mode·rn". These helpers post-filter those
 * candidates down to boundary-anchored matches and rank them by match
 * quality, replacing the alphabetical ordering that used to stand in for
 * relevance.
 *
 * Pure and worker-safe — no DB, no runtime bindings — so the API worker and
 * (eventually) the MCP worker's inline entity search can share it.
 */

export type WordMatchKind = "exact" | "prefix" | "word";

/** True when position `i` in `text` starts a word: string start, after a
 * non-alphanumeric character, or a camelCase lower→upper transition
 * ("OpenAI" → boundary before "AI"). */
function isWordBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (!/[a-zA-Z0-9]/.test(prev)) return true;
  return /[a-z0-9]/.test(prev) && /[A-Z]/.test(text[i]);
}

/**
 * Boundary-anchored, case-insensitive containment of `query` in `text`.
 * Returns the strongest match kind, or null when the query only appears
 * mid-word ("ai" in "Email") or not at all.
 */
export function wordMatch(text: string | null | undefined, query: string): WordMatchKind | null {
  if (!text) return null;
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const t = text.toLowerCase();
  if (t === q) return "exact";
  for (let idx = t.indexOf(q); idx !== -1; idx = t.indexOf(q, idx + 1)) {
    if (isWordBoundary(text, idx)) return idx === 0 ? "prefix" : "word";
  }
  return null;
}

/**
 * Match a query against a hostname without ever matching the TLD — the rule
 * that keeps "ai" from hitting every `.ai` domain. A dotted query matches
 * the host exactly or as a parent domain ("vercel.com" → "docs.vercel.com");
 * a plain query must prefix one of the non-TLD labels.
 */
export function domainLabelMatch(hostname: string | null | undefined, query: string): boolean {
  if (!hostname) return false;
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const host = hostname.trim().toLowerCase();
  if (q.includes(".")) return host === q || host.endsWith(`.${q}`);
  return host
    .split(".")
    .slice(0, -1)
    .some((label) => label.startsWith(q));
}

/**
 * Match a query against a URL: the host via `domainLabelMatch` (TLD never
 * matches) plus boundary-anchored matches inside each path segment. Tolerates
 * scheme-less input; unparseable strings never match.
 */
export function urlMatch(url: string | null | undefined, query: string): boolean {
  if (!url) return false;
  const q = query.trim().toLowerCase();
  if (!q) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.includes("://") ? url : `https://${url}`);
  } catch {
    return false;
  }
  if (domainLabelMatch(parsed.hostname, q)) return true;
  // Slash queries (GitHub coordinates like "org/repo") span path segments, so
  // match them against the whole path — "/" is a word boundary either way.
  if (q.includes("/")) return wordMatch(parsed.pathname, q) !== null;
  return parsed.pathname.split("/").some((segment) => wordMatch(segment, q) !== null);
}

/** Field bundle for one entity candidate. Pass whatever the entity has —
 * absent/null fields simply don't contribute. */
export interface EntityMatchFields {
  name: string;
  slug?: string | null;
  /** Hostnames: the primary domain plus any aliases. */
  domains?: Array<string | null | undefined>;
  /** Full URLs (e.g. `source.url`). */
  urls?: Array<string | null | undefined>;
  /** Taxonomy labels (e.g. org category) — weakest signal, ranked last. */
  categories?: Array<string | null | undefined>;
}

/**
 * Rank a LIKE candidate. Returns a tier (lower = more relevant) or null when
 * the candidate only substring-matched and should be dropped:
 *
 *   0 — exact name or slug
 *   1 — name starts with the query
 *   2 — query at a word boundary inside the name
 *   3 — slug word match, domain label, or URL match
 *   4 — category word match
 */
export function rankEntityCandidate(fields: EntityMatchFields, query: string): number | null {
  const nameKind = wordMatch(fields.name, query);
  if (nameKind === "exact") return 0;
  const slugKind = wordMatch(fields.slug, query);
  if (slugKind === "exact") return 0;
  if (nameKind === "prefix") return 1;
  if (nameKind === "word") return 2;
  if (slugKind !== null) return 3;
  if (fields.domains?.some((d) => domainLabelMatch(d, query))) return 3;
  if (fields.urls?.some((u) => urlMatch(u, query))) return 3;
  if (fields.categories?.some((c) => wordMatch(c, query) !== null)) return 4;
  return null;
}
