import { NextResponse, type NextRequest } from "next/server";
import { negotiate } from "@/lib/accept";
import { FORMATS, type Format } from "@/lib/request";

/**
 * Route requests to format API handlers either by URL suffix or by
 * `Accept` header content negotiation (RFC 9110 §12.5.1).
 *
 * Docs pages:
 *   /docs.md                         → /api/docs/index
 *   /docs/api/mcp.md                 → /api/docs/api/mcp
 *
 * Org/source data:
 *   /inngest.json                    → /api/format/inngest   (format: json)
 *   /inngest.md                      → /api/format/inngest   (format: md)
 *   /inngest.atom                    → /api/format/inngest   (format: atom)
 *   /inngest/inngest-changelog.json  → /api/format/inngest/inngest-changelog
 *   /source/my-source.md             → /api/format/source/my-source
 *
 * For all other requests we negotiate on the Accept header. Paths with a
 * markdown representation offer `text/html` + `text/markdown`; everything
 * else offers only `text/html`. When the client accepts none of the offered
 * types we return 406 Not Acceptable instead of silently serving HTML.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Explicit suffix routes — skip Accept negotiation.
  if (pathname === "/docs.md") {
    return rewriteTo(request, "/api/docs/index");
  }
  if (pathname.startsWith("/docs/") && pathname.endsWith(".md")) {
    const slug = pathname.slice("/docs/".length, -".md".length);
    return rewriteTo(request, `/api/docs/${slug}`);
  }
  const suffixMatch = pathname.match(SUFFIX_PATTERN);
  if (suffixMatch) {
    const [, basePath, format] = suffixMatch;
    return rewriteToFormat(request, `/api/format${basePath}`, format as Format);
  }

  const mdTarget = mapPathToMarkdownRoute(pathname);
  const offered = mdTarget ? OFFERED_WITH_MARKDOWN : OFFERED_HTML_ONLY;
  const chosen = negotiate(request.headers.get("accept"), offered);

  if (chosen === null) {
    return notAcceptable(offered);
  }
  if (chosen === "text/markdown" && mdTarget) {
    return mdTarget.startsWith("/api/docs/")
      ? rewriteTo(request, mdTarget)
      : rewriteToFormat(request, mdTarget, "md");
  }
  return NextResponse.next();
}

function rewriteTo(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  return NextResponse.rewrite(url);
}

function rewriteToFormat(request: NextRequest, pathname: string, format: Format) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.searchParams.set("format", format);
  const headers = new Headers(request.headers);
  headers.set("x-format", format);
  return NextResponse.rewrite(url, { request: { headers } });
}

function notAcceptable(offered: readonly string[]) {
  return new NextResponse(
    `406 Not Acceptable\n\nThis resource can produce: ${offered.join(", ")}\n`,
    {
      status: 406,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Vary: "Accept",
      },
    },
  );
}

const SUFFIX_PATTERN = new RegExp(`^(\\/[^.]+)\\.(${FORMATS.join("|")})$`);

const OFFERED_WITH_MARKDOWN = ["text/html", "text/markdown"] as const;
const OFFERED_HTML_ONLY = ["text/html"] as const;

// Top-level segments that aren't org slugs — these have no markdown variant.
const RESERVED_TOP_SEGMENTS = new Set([
  "api",
  "_next",
  "search",
  "status",
  "release",
  "docs",
  "source",
  ".well-known",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  "manifest.json",
  "sw.js",
  "opengraph-image",
]);

function mapPathToMarkdownRoute(pathname: string): string | null {
  if (pathname === "/docs") return "/api/docs/index";
  if (pathname.startsWith("/docs/")) {
    return `/api/docs/${pathname.slice("/docs/".length)}`;
  }
  if (pathname.startsWith("/source/")) {
    return `/api/format${pathname}`;
  }
  const parts = pathname.slice(1).split("/").filter(Boolean);
  if (parts.length === 0) return null; // homepage — no md equivalent yet
  if (RESERVED_TOP_SEGMENTS.has(parts[0])) return null;
  if (parts.length === 1 || parts.length === 2) {
    return `/api/format/${parts.join("/")}`;
  }
  return null;
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico$).*)"],
};
