import { NextResponse, type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { FORMATS, type Format } from "@/lib/request";

const isFormat = (v: string | null): v is Format =>
  v !== null && (FORMATS as readonly string[]).includes(v);

/**
 * Legacy bare-slug format target. The `/source/{slug}.atom|.md|.json` URLs
 * are rewritten here by `src/proxy.ts`. Resolves the bare slug to an
 * org-scoped path via the dedicated bookmark resolver and 308s. Same
 * lifetime constraint as the `/source/[slug]/page.tsx` redirect — both
 * lean on `/v1/lookups/source-by-slug` until the bookmark window elapses.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const rawFormat = request.nextUrl.searchParams.get("format");
  // Allow-list against the canonical FORMATS set — the proxy populates this
  // from a fixed alternation, but the route is routable directly too, so
  // refuse anything off-list rather than splicing it into the redirect path.
  const format: Format = isFormat(rawFormat) ? rawFormat : "md";

  const resolved = await api.sourceLegacyResolve(slug);
  if (!resolved) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const target = new URL(request.url);
  target.pathname = `/${resolved.orgSlug}/${resolved.sourceSlug}.${format}`;
  // Preserve the format suffix in the redirect URL so the proxy's rewrite
  // catches the org-scoped path on the next hop.
  return NextResponse.redirect(target, 308);
}
