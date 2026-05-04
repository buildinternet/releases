// URL-safe base64 helpers for opaque pagination cursors. Workers (API + MCP)
// share these so cursor-token encoding stays consistent across surfaces; the
// per-cursor field layout (e.g. `createdAt|id` vs `publishedAt|id`) lives at
// each call site.

export function toBase64Url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): string | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    return atob(padded + pad);
  } catch {
    return null;
  }
}
