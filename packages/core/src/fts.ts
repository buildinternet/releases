/**
 * FTS5 query sanitizers (backend-neutral string shaping).
 *
 * FTS5's query parser treats certain ASCII punctuation as syntax (`:`, `(`,
 * `)`, `*`, `^`, `+`, `-`, `"`) and throws on others — most relevantly `/`,
 * which raises `fts5: syntax error near "/"`. Real-world queries hit those
 * characters constantly (coordinates like `org/repo`, scoped npm names like
 * `@scope/pkg`, version strings, etc.), so we wrap each whitespace-separated
 * token in a phrase quote and let FTS5 do its own internal tokenization.
 *
 * Empty input collapses to `""`, an FTS5 phrase that matches nothing — safer
 * than passing through, which would bubble a syntax error to the caller.
 *
 * ## Ownership (do not grow MATCH call sites)
 *
 * These helpers are the only shared lexical-query entry. Production
 * `releases_fts … MATCH` usage is a closed set — extend an existing site,
 * don't open a new one:
 *
 * - `workers/api/src/queries/search.ts`
 * - `workers/api/src/queries/orgs.ts`
 * - `workers/api/src/queries/sources.ts`
 * - `packages/search/src/hybrid-search-worker.ts`
 * - `workers/mcp/src/tools.ts` (prefer converging onto queries/search)
 *
 * Full seam map + future Postgres/`LexicalSearch` notes:
 * docs/architecture/storage-portability.md → Lexical search ownership.
 */
export function toFtsMatchQuery(input: string): string {
  const tokens = input
    .split(/\s+/)
    .map((tok) => tok.replace(/"/g, "").trim())
    .filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((tok) => `"${tok}"`).join(" ");
}

/**
 * Prefix-matching variant of {@link toFtsMatchQuery} — appends FTS5's `*`
 * phrase-prefix operator to each token so partial words match (e.g. typing
 * "cach" hits "caching"). Used by inline filter inputs where the user is
 * still typing; full-text search uses the exact-token helper above.
 */
export function toFtsPrefixMatchQuery(input: string): string {
  const tokens = input
    .split(/\s+/)
    .map((tok) => tok.replace(/"/g, "").trim())
    .filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((tok) => `"${tok}"*`).join(" ");
}
