import { OG_CACHE_FALLBACK, OG_CACHE_SUCCESS, renderOgFallback, renderOgImage } from "@/lib/og";
import { buildOrgOgProps } from "@/lib/org-og-card";

/**
 * Stable, explicitly-addressable org OG card (superseding #2076's per-release
 * R2 mirror — see that revert's commit message). The file-convention route at
 * `[orgSlug]/(org)/opengraph-image.tsx` renders the SAME card but only at a
 * build-hashed URL (`/anthropic/opengraph-image-s61euv?...`) that can't be
 * constructed by hand, so it can't be linked to from another entity's
 * metadata. This route exists so the release detail page can point its
 * `og:image` at a shared, low-cardinality (~100 orgs) URL instead of
 * rendering — and asking a cache to store — one image per release.
 *
 * `force-dynamic` (no `revalidate`) so this handler's own `Cache-Control`
 * ships verbatim: a transient upstream failure must render the generic
 * fallback card WITHOUT the CDN pinning it there for a day. See
 * `OG_CACHE_SUCCESS`/`OG_CACHE_FALLBACK` in `@/lib/og`.
 *
 * `ImageResponse` (a `Response` subclass) defaults `Content-Type` to
 * `image/png` on its own — `contentType`/`size`/`alt` are only meaningful as
 * exports of the `opengraph-image.tsx` FILE CONVENTION, not a Route Handler,
 * so this route doesn't declare them.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const props = await buildOrgOgProps(slug);
    return renderOgImage(props, { headers: OG_CACHE_SUCCESS });
  } catch {
    return renderOgFallback({ headers: OG_CACHE_FALLBACK });
  }
}
