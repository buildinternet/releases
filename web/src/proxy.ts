import { NextResponse, type NextRequest } from "next/server";
import { FORMATS, type Format } from "@/lib/request";

/**
 * Route requests to format API handlers either by URL suffix or by
 * `Accept: text/markdown` content negotiation.
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
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

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

  // Accept: text/markdown negotiation for agents.
  if (prefersMarkdown(request.headers.get("accept"))) {
    const target = mapPathToMarkdownRoute(pathname);
    if (target) {
      return target.startsWith("/api/docs/")
        ? rewriteTo(request, target)
        : rewriteToFormat(request, target, "md");
    }
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

const SUFFIX_PATTERN = new RegExp(`^(\\/[^.]+)\\.(${FORMATS.join("|")})$`);

// Top-level segments that aren't org slugs — skip Accept negotiation on these.
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
  // /{orgSlug} or /{orgSlug}/{sourceSlug} — /api/format handles both shapes.
  if (parts.length === 1 || parts.length === 2) {
    return `/api/format/${parts.join("/")}`;
  }
  return null;
}

function prefersMarkdown(accept: string | null): boolean {
  if (!accept || !accept.includes("text/markdown")) return false;
  const mdPos = accept.indexOf("text/markdown");
  const htmlPos = accept.indexOf("text/html");
  return htmlPos === -1 || mdPos < htmlPos;
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico$).*)"],
};
