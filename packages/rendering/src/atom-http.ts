/**
 * Runtime-agnostic helpers for building an Atom HTTP response.
 *
 * The actual `NextResponse` wrapper lives in the web app because it binds
 * to the Next.js runtime. Everything testable without a server framework —
 * ETag generation, conditional-request matching, header formatting — lives
 * here so both the unit tests and any non-Next consumer (workers, CLI
 * tooling) can reuse it.
 */

/**
 * djb2 hash — fast, deterministic, non-cryptographic. Good enough for an
 * ETag tied to exact feed body content, and safe for any runtime (no
 * `node:crypto` dependency).
 */
export function atomEtag(body: string): string {
  let h = 5381;
  for (let i = 0; i < body.length; i++) {
    h = ((h << 5) + h + body.charCodeAt(i)) | 0;
  }
  return `W/"${(h >>> 0).toString(16)}"`;
}

/** Format a date as an RFC 7231 `Last-Modified` header value. */
export function formatLastModified(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toUTCString();
}

/**
 * Decide whether the caller's validators warrant a `304 Not Modified`.
 * Per RFC 7232: a matching `If-None-Match` overrides `If-Modified-Since`;
 * either match is sufficient on a GET.
 */
export function shouldReturn304(
  etag: string,
  lastModifiedHeader: string | null,
  ifNoneMatch: string | null,
  ifModifiedSince: string | null,
): boolean {
  if (ifNoneMatch) {
    const strongEtag = etag.replace(/^W\//, "");
    const matched = ifNoneMatch
      .split(",")
      .map((tag: string) => tag.trim())
      .some((tag: string) => tag === etag || tag === strongEtag || tag === "*");
    if (matched) return true;
  }

  if (lastModifiedHeader && ifModifiedSince) {
    const since = new Date(ifModifiedSince).getTime();
    const mod = new Date(lastModifiedHeader).getTime();
    if (!isNaN(since) && !isNaN(mod) && mod <= since) {
      return true;
    }
  }

  return false;
}
