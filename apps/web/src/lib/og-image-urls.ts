import { releaseWebBase } from "@buildinternet/releases-core/release-slug";

/**
 * Stable, explicitly-addressable OG card URLs for pages that cannot (or should
 * not) render their own image. Every URL here has a tiny, bounded URL space so
 * it stays cache-friendly:
 *
 * - `/api/og/site`            — 1 URL (docs, privacy/security/terms, …)
 * - `/api/og/docs/<slug>`     — one per docs page with `og` frontmatter (a handful)
 * - `/api/og/collection/<s>`  — one per collection (~12), shared by the
 *   collection page's weekly digests and digest index (a per-week image would
 *   be ~230 URLs growing weekly, each requested ~once, so it could never hit
 *   a cache).
 * - `/api/og/org/<slug>`      — see release-og.ts.
 *
 * File-convention `opengraph-image` URLs are build-hashed and can't be linked
 * to from another page's metadata, which is why these are explicit routes.
 */
type WebEnv = { WEB_BASE_URL?: string };

const defaultEnv = (): WebEnv => ({ WEB_BASE_URL: process.env.WEB_BASE_URL });

export function siteOgImageUrl(env: WebEnv = defaultEnv()): string {
  return `${releaseWebBase(env)}/api/og/site`;
}

/** Card for a docs page that declares `og` frontmatter (`index` is the `/docs` root). */
export function docOgImageUrl(slug: string, env: WebEnv = defaultEnv()): string {
  return `${releaseWebBase(env)}/api/og/docs/${slug}`;
}

export function collectionOgImageUrl(slug: string, env: WebEnv = defaultEnv()): string {
  return `${releaseWebBase(env)}/api/og/collection/${encodeURIComponent(slug)}`;
}

/**
 * `openGraph.images` / `twitter.images` fields for a page that sets its own
 * `openGraph` (which replaces the parent's wholesale). Always a concrete
 * array — never `images: undefined`, which Next's `mergeStaticMetadata` treats
 * as "already set" and so suppresses BOTH the explicit and file-convention
 * image.
 */
export function ogImageFields(
  url: string,
  details?: { alt: string; width: number; height: number; type: string },
) {
  const image = details ? { url, ...details } : url;
  return {
    openGraph: { images: [image] },
    twitter: { card: "summary_large_image" as const, images: [image] },
  };
}
