import type { Context, MiddlewareHandler } from "hono";

/**
 * Check whether the request prefers markdown over JSON.
 *
 * Follows the convention from Cloudflare's "Markdown for Agents" —
 * agents like Claude Code send `Accept: text/markdown` to signal they
 * can consume markdown directly rather than HTML/JSON.
 */
export function acceptPrefersMarkdown(accept: string | null | undefined): boolean {
  const value = accept ?? "";
  // Simple check: if text/markdown appears before application/json
  // (or json is absent entirely), the client prefers markdown.
  if (!value.includes("text/markdown")) return false;
  const mdPos = value.indexOf("text/markdown");
  const jsonPos = value.indexOf("application/json");
  return jsonPos === -1 || mdPos < jsonPos;
}

export function wantsMarkdown(c: Context): boolean {
  return acceptPrefersMarkdown(c.req.header("accept"));
}

/** Rough token estimate: ~4 chars per token (conservative). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Return a text/markdown response with standard agent headers. */
export function markdownResponse(c: Context, body: string): Response {
  return c.body(body, 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "x-markdown-tokens": String(estimateTokens(body)),
  });
}

/**
 * Middleware that adds `Vary: Accept` to GET responses on routes that
 * support content negotiation, so CDN caches key on the Accept header.
 */
export function varyOnAccept(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.method === "GET") {
      c.res.headers.append("Vary", "Accept");
    }
  };
}
