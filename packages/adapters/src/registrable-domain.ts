import { getDomain } from "tldts";

/**
 * Public-suffix-aware registrable domain (e.g. "blog.example.co.uk" ->
 * "example.co.uk"). Falls back to the naive last-two-label heuristic when
 * `tldts` can't determine one (localhost, bare IPs, single-label hosts) —
 * those aren't on a public suffix list, so there's nothing to look up.
 */
export function registrableDomain(host: string): string {
  const lower = host.toLowerCase();
  const domain = getDomain(lower);
  if (domain) return domain;
  const parts = lower.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}
