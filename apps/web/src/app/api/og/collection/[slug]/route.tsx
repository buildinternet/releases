import { buildCollectionOgProps } from "@/lib/collection-og-card";
import { OG_CACHE_FALLBACK, OG_CACHE_SUCCESS, renderOgFallback, renderOgImage } from "@/lib/og";

/**
 * Stable, explicitly-addressable collection OG card (~12 collections). The
 * weekly digest permalinks and digest index point their `og:image` here
 * instead of rendering one image per week (~230 URLs, growing weekly). Mirrors
 * `/api/og/org/[slug]`: `force-dynamic` with its own `Cache-Control` so a
 * fallback render is never cached for a day.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    return renderOgImage(await buildCollectionOgProps(slug), { headers: OG_CACHE_SUCCESS });
  } catch {
    return renderOgFallback({ headers: OG_CACHE_FALLBACK });
  }
}
