import { NextRequest, NextResponse } from "next/server";

/**
 * Intercept requests ending in .json or .md and rewrite them to the
 * format API routes so we can return raw JSON / Markdown responses.
 *
 * /inngest.json                    → /api/format/inngest  (format: json)
 * /inngest.md                      → /api/format/inngest  (format: md)
 * /inngest/inngest-changelog.json  → /api/format/inngest/inngest-changelog
 * /inngest/inngest-changelog.md    → /api/format/inngest/inngest-changelog
 * /source/my-source.md             → /api/format/source/my-source
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only match paths with .json or .md extension
  const match = pathname.match(/^(\/[^.]+)\.(json|md)$/);
  if (!match) return NextResponse.next();

  const basePath = match[1];
  const format = match[2]; // json or md

  const url = request.nextUrl.clone();
  url.pathname = `/api/format${basePath}`;
  url.searchParams.set("format", format);

  // Pass format as a header too — rewrites don't always preserve added
  // search params in the route handler's `request.nextUrl`.
  const headers = new Headers(request.headers);
  headers.set("x-format", format);

  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico).*)"],
};
