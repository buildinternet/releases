import { NextRequest } from "next/server";

const PRODUCTION_BASE_URL = "https://releases.sh";

/**
 * Canonical base URL for statically-generated files (sitemap.xml, robots.txt,
 * llms.txt). Reflects env config or falls back to the production URL — no
 * request context is available in these contexts.
 */
export function getStaticBaseUrl(): string {
  return process.env.RELEASED_BASE_URL?.replace(/\/$/, "") ?? PRODUCTION_BASE_URL;
}

/**
 * Derive the base URL for canonical links from the incoming request.
 * In production this is always releases.sh; in dev it reflects localhost.
 */
export function getBaseUrl(request: NextRequest): string {
  if (process.env.RELEASED_BASE_URL) {
    return process.env.RELEASED_BASE_URL.replace(/\/$/, "");
  }

  const host = request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  const productionHost = new URL(PRODUCTION_BASE_URL).hostname;

  if (host === productionHost) {
    return PRODUCTION_BASE_URL;
  }

  if (host && !host.includes("localhost") && !host.startsWith("127.")) {
    // Preview / staging deployment — use the actual host
    return `${proto}://${host}`;
  }

  return `${proto}://${host ?? "localhost:3000"}`;
}
