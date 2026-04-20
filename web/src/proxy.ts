import { NextResponse, type NextRequest } from "next/server";
import { negotiate } from "@/lib/accept";
import { FORMATS, type Format } from "@/lib/request";
import { routeMap } from "@/lib/route-map";

/**
 * URL-suffix routes (`/inngest.md`, `/docs.md`, `/inngest.atom`, etc.)
 * dispatch explicitly; everything else negotiates on the Accept header
 * per RFC 9110 §12.5.1. The set of paths with a markdown representation
 * lives in `routeMap()` — paths it doesn't match only offer `text/html`,
 * and an Accept that matches nothing gets a 406 instead of HTML.
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

export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico$).*)"],
};
