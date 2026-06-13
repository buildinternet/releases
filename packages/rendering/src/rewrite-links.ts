/**
 * Absolutize relative URLs in markdown content.
 *
 * Vendors author `<a href="/docs/…">` / `<img src="/img/…">` relative to
 * their own domain. When we render the ingested markdown on releases.sh those
 * root-relative paths resolve against *our* domain, producing 404s.
 *
 * This module rewrites relative URLs to absolute ones against a base URL
 * (typically derived from the source's canonical URL or the release's own
 * `url` field). Three relative forms are handled:
 *
 *   - Root-relative:        `/path/to/page`
 *   - Protocol-relative:    `//host/path`
 *   - Bare-relative:        `./path` or `../path`
 *
 * Already-absolute URLs (`http://`, `https://`), mailto links, fragment-only
 * links (`#anchor`), and data URIs are passed through untouched.
 *
 * When `baseUrl` is absent or unparseable the content is returned unchanged —
 * fail-safe: we'd rather leave a root-relative link than corrupt the body.
 */

/**
 * Parse the scheme-and-authority prefix from a URL-like string found in
 * markdown content.  Returns `{ origin, protocol }` on success, `null` if the
 * string is not an http(s) URL.
 */
function parseHttpOrigin(url: string): { origin: string; protocol: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return { origin: parsed.origin, protocol: parsed.protocol };
  } catch {
    return null;
  }
}

/**
 * Resolve a single URL token found inside markdown against `base`.
 *
 * Returns the absolute URL string, or `null` if the token should be stripped
 * (currently we never strip — callers keep the raw token on a null return).
 */
function resolveUrl(token: string, base: { origin: string; protocol: string }): string | null {
  // Already absolute or special scheme — leave alone
  if (/^https?:\/\//i.test(token)) return null;
  if (/^(mailto:|data:|tel:|#)/i.test(token)) return null;

  // Protocol-relative: `//host/path`
  if (token.startsWith("//")) {
    return `${base.protocol}${token}`;
  }

  // Root-relative: `/path`
  if (token.startsWith("/")) {
    return `${base.origin}${token}`;
  }

  // Bare-relative: `./path` or `../path`
  if (token.startsWith("./") || token.startsWith("../")) {
    try {
      return new URL(token, base.origin + "/").href;
    } catch {
      return null;
    }
  }

  // Anything else (no scheme, no leading slash, not relative) — leave alone
  return null;
}

/**
 * Rewrite relative `href` / `src` values in markdown (and inline HTML) to
 * absolute URLs against `baseUrl`.
 *
 * Patterns handled:
 *   1. Markdown links:  `[text](URL)` and `[text](URL "title")`
 *   2. Markdown images: `![alt](URL)` and `![alt](URL "title")`
 *   3. HTML attributes: `href="URL"`, `href='URL'`, `src="URL"`, `src='URL'`
 *
 * The rewrite is pure-string (regex-based) to stay runtime-neutral (no DOM,
 * no HTML parser, no `rehype` dependency). It operates on the raw markdown
 * string before it reaches any parser so there's no need to walk an AST.
 *
 * @param content  Raw markdown string (may include inline HTML).
 * @param baseUrl  Absolute URL whose origin is used as the rewrite base.
 *                 When absent / unparseable the original content is returned.
 */
export function rewriteRelativeLinks(content: string, baseUrl: string | null | undefined): string {
  if (!content) return content;
  if (!baseUrl) return content;

  const parsedBase = parseHttpOrigin(baseUrl);
  if (!parsedBase) return content;

  // Capture as a typed non-nullable const so the nested closure can use it
  // without TypeScript complaining about the original nullable type.
  const base: { origin: string; protocol: string } = parsedBase;

  /**
   * Replace a single URL token found in a regex match.
   * `token` is the raw URL string captured from the match.
   * Returns the rewritten URL, or the original token if no rewrite applies.
   */
  function rewrite(token: string): string {
    const absolute = resolveUrl(token, base);
    return absolute ?? token;
  }

  let out = content;

  // ── 1. Markdown image/link syntax: ![alt](URL) or [text](URL) ──────
  //
  // Match `](URL)` or `](URL "title")`. We accept the URL part as a
  // non-empty sequence that stops at whitespace, `"`, or `)`, then
  // optionally followed by a quoted title before the closing `)`.
  //
  // We intentionally do NOT touch bare URLs (autolinks) — those almost
  // always come from absolute markdown and the regex would be very wide.
  //
  // Positive-lookbehind `(?<=\]\()` matches the `](` opener without
  // consuming it so the replacement covers only the URL token.
  out = out.replace(/(?<=\]\()([^\s"')][^\s"')]*?)(?=(?:\s+"[^"]*")?\))/g, (_, url) =>
    rewrite(url),
  );

  // ── 2. HTML href / src attributes (single- or double-quoted) ────────
  //
  // Matches: href="URL", href='URL', src="URL", src='URL'
  // The quote characters must match (we use two passes, one per quote style).
  out = out.replace(/\b(href|src)="([^"]+)"/g, (_, attr, url) => `${attr}="${rewrite(url)}"`);
  out = out.replace(/\b(href|src)='([^']+)'/g, (_, attr, url) => `${attr}='${rewrite(url)}'`);

  return out;
}

/**
 * Extract the HTTP(S) origin from a URL string.
 * Returns `null` when the input is absent, unparseable, or not http(s).
 *
 * Convenience helper for call-sites that derive `baseUrl` from a release's
 * `url` field (e.g. `https://elevenlabs.io/changelog/1` → `https://elevenlabs.io`).
 */
export function originFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const parsed = parseHttpOrigin(url);
  return parsed ? parsed.origin : null;
}
