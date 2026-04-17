import { NextResponse, type NextRequest } from "next/server";

/**
 * Intercept requests ending in .json or .md and rewrite them:
 *
 * Docs pages:
 *   /docs.md                         → /api/docs/index
 *   /docs/api/mcp.md                 → /api/docs/api/mcp
 *
 * Org/source data (existing behavior):
 *   /inngest.json                    → /api/format/inngest   (format: json)
 *   /inngest.md                      → /api/format/inngest   (format: md)
 *   /inngest.atom                    → /api/format/inngest   (format: atom)
 *   /inngest/inngest-changelog.json  → /api/format/inngest/inngest-changelog
 *   /source/my-source.md             → /api/format/source/my-source
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === "/docs.md") {
    const url = request.nextUrl.clone();
    url.pathname = "/api/docs/index";
    return NextResponse.rewrite(url);
  }
  if (pathname.startsWith("/docs/") && pathname.endsWith(".md")) {
    const slug = pathname.slice("/docs/".length, -".md".length);
    const url = request.nextUrl.clone();
    url.pathname = `/api/docs/${slug}`;
    return NextResponse.rewrite(url);
  }

  const match = pathname.match(/^(\/[^.]+)\.(json|md|atom)$/);
  if (!match) return NextResponse.next();

  const basePath = match[1];
  const format = match[2];

  const url = request.nextUrl.clone();
  url.pathname = `/api/format${basePath}`;
  url.searchParams.set("format", format);

  const headers = new Headers(request.headers);
  headers.set("x-format", format);

  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico$).*)"],
};
