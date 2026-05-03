import { NextResponse, type NextRequest } from "next/server";
import { api } from "@/lib/api";

/**
 * Legacy bare-slug format target. The `/source/{slug}.atom|.md|.json` URLs
 * are rewritten here by `src/proxy.ts`. Every source has an org now (#690
 * Phase C made `sources.orgId` NOT NULL), so we resolve once and 308 to the
 * canonical org-scoped format URL. Same lifetime constraint as the
 * `/source/[slug]/page.tsx` redirect — delete when the API's bare path
 * starts returning 400 (#698).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const format = request.nextUrl.searchParams.get("format");

  let source;
  try {
    source = await api.sourceLegacyResolve(slug);
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!source.org) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const target = new URL(request.url);
  target.pathname = `/${source.org.slug}/${source.slug}.${format ?? "md"}`;
  // Preserve the format suffix in the redirect URL so the proxy's rewrite
  // catches the org-scoped path on the next hop.
  return NextResponse.redirect(target, 308);
}
