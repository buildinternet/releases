import { NextResponse, type NextRequest } from "next/server";
import { negotiate } from "@/lib/accept";
import { FORMATS, type Format } from "@/lib/request";
import { routeMap } from "@/lib/route-map";

/**
 * URL-suffix routes (`/inngest.md`, `/docs.md`, `/inngest.atom`, etc.) dispatch
 * explicitly. Otherwise, if the request targets a path with a markdown
 * representation AND the client explicitly prefers markdown, rewrite to the
 * markdown variant. Anything else falls through to Next.js.
 *
 * We intentionally do NOT return 406 when the Accept header doesn't match
 * `text/html` / `text/markdown`. Strict negotiation was breaking real clients
 * that hit this middleware on non-HTML paths: Facebook's OG image crawler
 * (`Accept: image/png,image/*;q=0.8`), the MCP registry publisher fetching
 * `/.well-known/mcp-registry-auth` (`Accept: text/plain`), and XML-aware
 * sitemap clients all got a 406 instead of the asset they wanted. `routeMap()`
 * can't tell `/vercel/nextjs` (org+source, markdown-capable) apart from
 * `/vercel/opengraph-image` (Next.js-generated image, definitely not), so
 * preferring HTML over 406 is the safer default. Explicit `.md` / `.atom` /
 * `.json` suffix routes remain the reliable way to get a specific format.
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

  const mdTarget = routeMap(pathname);
  if (mdTarget) {
    const chosen = negotiate(request.headers.get("accept"), OFFERED_WITH_MARKDOWN);
    if (chosen === "text/markdown") {
      return mdTarget.startsWith("/api/docs/")
        ? rewriteTo(request, mdTarget)
        : rewriteToFormat(request, mdTarget, "md");
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

const OFFERED_WITH_MARKDOWN = ["text/html", "text/markdown"] as const;

export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico$).*)"],
};
