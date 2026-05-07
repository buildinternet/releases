/**
 * FTS5's query parser treats certain ASCII punctuation as syntax (`:`, `(`,
 * `)`, `*`, `^`, `+`, `-`, `"`) and throws on others — most relevantly `/`,
 * which raises `fts5: syntax error near "/"`. Real-world queries hit those
 * characters constantly (coordinates like `org/repo`, scoped npm names like
 * `@scope/pkg`, version strings, etc.), so we wrap each whitespace-separated
 * token in a phrase quote and let FTS5 do its own internal tokenization.
 *
 * Empty input collapses to `""`, an FTS5 phrase that matches nothing — safer
 * than passing through, which would bubble a syntax error to the caller.
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
