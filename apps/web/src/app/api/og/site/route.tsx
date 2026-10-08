import { OG_CACHE_SUCCESS, renderOgImage } from "@/lib/og";
import { SITE_OG_PROPS } from "@/lib/site-og-card";

/**
 * Stable site-level OG card (a single URL). Docs pages and the static legal
 * pages (privacy/security/terms) point their `og:image` here — their own
 * `openGraph` replaces the root layout's, and the root `opengraph-image.tsx`
 * file convention is served at a build-hashed URL that can't be linked to by
 * hand. No upstream lookup, so it can't fail into a fallback.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return renderOgImage(SITE_OG_PROPS, { headers: OG_CACHE_SUCCESS });
}
