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

  // Legacy `?tab=` deep-links → path-based tab URLs (308). Handled here so the
  // org/product/source pages don't have to read `searchParams` — which would
  // force them into per-request dynamic rendering and defeat ISR (#1607).
  const tabRedirect = legacyTabRedirect(request);
  if (tabRedirect) return tabRedirect;

  // IndexNow ownership file. Served from the site root because the protocol
  // forces submitted URLs to live under the key file's directory when
  // `keyLocation` is used; root placement keeps every URL on releases.sh
  // submittable. The key is held in env (not committed) so rotation is just
  // a Vercel env update.
  const keyMatch = pathname.match(INDEXNOW_KEY_PATH);
  if (keyMatch) {
    const expected = process.env.INDEXNOW_KEY;
    if (expected && keyMatch[1] === expected) {
      return new NextResponse(expected, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
    // Fall through to Next.js so unrelated `.txt` paths (none today) keep working.
  }

  // `/auth.md` is the agent-auth instruction file (served from `public/`), not a
  // markdown representation of an `/auth` page. Without this guard the suffix
  // matcher below would rewrite it to `/api/format/auth` and try to render a
  // (non-existent) "auth" org as markdown. Let it fall through to the static file.
  if (pathname === "/auth.md") {
    return NextResponse.next();
  }

  // `/schemas/*.json` are static JSON Schema files served from `public/schemas/`
  // (e.g. the releases.json schema that owner-declared configs point `$schema`
  // at). Without this guard the `.json` suffix matcher below rewrites them to
  // `/api/format/schemas/<name>` and 404s, so the static file never serves.
  if (pathname.startsWith("/schemas/")) {
    return NextResponse.next();
  }

  // `/openapi.json` proxies the REST API's generated OpenAPI 3.1 spec (served by
  // `app/openapi.json/route.ts`). Without this guard the `.json` suffix matcher
  // below rewrites it to `/api/format/openapi` and 404s — same trap as
  // `/schemas/*.json` above.
  if (pathname === "/openapi.json") {
    return NextResponse.next();
  }

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

const ORG_LEGACY_TABS = new Set(["releases", "sources", "playbook", "fetch-log", "admin"]);
const SOURCE_LEGACY_TABS = new Set(["highlights", "changelog"]);

// First path segments that name a real top-level route, not an org slug. The
// `[orgSlug]` dynamic segment is the App Router catch-all, so the router itself
// never lets `/login` etc. reach the org page — but middleware runs *before*
// routing, so the org-slug `?tab=` redirect below must exclude these by hand or
// `/login?tab=releases` would 308 to a dead `/login/releases`. Keep in sync with
// the directories under `web/src/app/`.
const RESERVED_FIRST_SEGMENT = new Set([
  "account",
  "actions",
  "admin",
  "api",
  "bot",
  "catalog",
  "categories",
  "collections",
  "device",
  "docs",
  "following",
  "forgot-password",
  "gh",
  "live",
  "login",
  "oauth",
  "privacy",
  "release",
  "reset-password",
  "search",
  "security",
  "signup",
  "source",
  "sources",
  "submit",
  "tags",
  "terms",
  "updates",
]);

/**
 * Resolve a legacy `?tab=` deep-link to its path-based equivalent, or `null`
 * when the request isn't one. These URLs predate the path-based tab routes and
 * were previously redirected inside the page components via `permanentRedirect`,
 * but reading `searchParams` there opted the whole org/product/source tree into
 * dynamic rendering. The redirect target drops the query (matching the old
 * page-component behavior) and uses 308 to mirror `permanentRedirect`.
 */
function legacyTabRedirect(request: NextRequest): NextResponse | null {
  const tab = request.nextUrl.searchParams.get("tab");
  if (!tab) return null;

  const parts = request.nextUrl.pathname.slice(1).split("/").filter(Boolean);
  if (parts.length === 0) return null;

  // /sources/:id?tab=highlights|changelog → /sources/:id/:tab
  if (parts.length === 2 && parts[0] === "sources" && SOURCE_LEGACY_TABS.has(tab)) {
    return redirectToPath(request, `/sources/${parts[1]}/${tab}`);
  }

  // Past this point the first segment must be an org slug, never a top-level route.
  if (RESERVED_FIRST_SEGMENT.has(parts[0])) return null;

  // /:org?tab=releases|sources|playbook|fetch-log|admin → /:org/:tab
  if (parts.length === 1 && ORG_LEGACY_TABS.has(tab)) {
    return redirectToPath(request, `/${parts[0]}/${tab}`);
  }

  // /:org/:slug?tab=highlights|changelog → /:org/:slug/:tab
  if (parts.length === 2 && SOURCE_LEGACY_TABS.has(tab)) {
    return redirectToPath(request, `/${parts[0]}/${parts[1]}/${tab}`);
  }

  return null;
}

function redirectToPath(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return NextResponse.redirect(url, 308);
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

// IndexNow key files: 8–128 chars from [a-zA-Z0-9-], `.txt` suffix, at root.
// See https://www.indexnow.org/documentation.
const INDEXNOW_KEY_PATH = /^\/([a-zA-Z0-9-]{8,128})\.txt$/;

const OFFERED_WITH_MARKDOWN = ["text/html", "text/markdown"] as const;

export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico$).*)"],
};
