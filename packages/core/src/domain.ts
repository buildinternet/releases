/**
 * Pure normalizer for domain inputs. Centralized so the API search filter,
 * the by-domain lookup endpoint, the MCP tool, and the CLI all agree on
 * what counts as the same domain. Output is the form stored in
 * `organizations.domain` and `domain_aliases.domain` — lowercased host with
 * no scheme, port, path, query, fragment, userinfo, or trailing dot. The
 * leading `www.` is stripped (we don't store that variant).
 *
 * Returns `null` when the input doesn't look like a hostname at all
 * (whitespace inside, no dot, missing TLD, IP-only, etc.) so callers can
 * distinguish "no match in DB" from "the operator typed something we
 * couldn't normalize."
 */

const HOST_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  // Try to parse the input as a URL. If it has a scheme already, only
  // http/https are accepted (no `mailto:`, `ftp:`, etc.). If it's a bare
  // host (or host:port, or host/path), assume `https://` so URL parsing
  // gives us hostname extraction for free.
  let host: string | null = null;
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//);
  if (schemeMatch) {
    if (schemeMatch[1] !== "http" && schemeMatch[1] !== "https") return null;
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return null;
    }
  } else if (
    /^[a-z][a-z0-9+.-]*:/.test(trimmed) &&
    !/^[a-z0-9.-]+:\d+(?:[/?#].*)?$/.test(trimmed)
  ) {
    // `mailto:foo@bar.com`, `ftp:host`, etc. — anything with a non-`://`
    // scheme prefix that isn't shaped like `host:port`. Reject rather than
    // guess at intent.
    return null;
  } else {
    try {
      host = new URL(`https://${trimmed}`).hostname;
    } catch {
      return null;
    }
  }

  if (!host) return null;

  // URL keeps a trailing dot when the input had one; strip it to canonicalize.
  if (host.endsWith(".")) host = host.slice(0, -1);
  // Strip a leading `www.` so we match the canonical apex/subdomain form
  // we actually store.
  if (host.startsWith("www.")) host = host.slice(4);

  if (!host) return null;

  const parts = host.split(".");
  if (parts.length < 2) return null;
  for (const part of parts) {
    if (!HOST_SEGMENT.test(part)) return null;
  }
  // Bare IPv4 — `1.2.3.4` passes the segment regex but isn't a domain we'd
  // ever own. Reject.
  if (parts.every((p) => /^\d+$/.test(p))) return null;

  return host;
}
