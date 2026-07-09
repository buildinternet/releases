import { releaseWebBase } from "@buildinternet/releases-core/release-slug";

export interface ReleaseOgInput {
  publishedAt?: string | null;
  /** `release.source.org?.slug ?? null` — null for an independent source. */
  orgSlug?: string | null;
}

/**
 * Builds the release detail page's `openGraph` metadata fields. Factored out
 * of `generateMetadata` (page.tsx) so this logic is unit-testable without
 * pulling in the page's full component tree (React `ViewTransition` and
 * friends don't survive a plain `bun test` import — see page.test.ts).
 *
 * `og:image` points at the shared, low-cardinality ORG OG card
 * (`/api/og/org/[slug]`) rather than rendering one image per release: ~40k
 * releases means ~40k distinct OG URLs, which no cache layer can ever get a
 * hit against, while there are only ~100 orgs.
 *
 * When the release has no org (an independent source), `images` is omitted
 * from the returned object ENTIRELY — not set to `undefined` — so the page
 * falls back to the root `opengraph-image.tsx` file-convention card. Next's
 * `mergeStaticMetadata` (next/dist/lib/metadata/resolve-metadata.js) only
 * merges in the co-located file convention when `openGraph.images` is not
 * already an own property of the returned object; `{ images: undefined }`
 * still counts as "already set" and would suppress that fallback.
 */
export function buildReleaseOpenGraph(
  releasePathValue: string,
  input: ReleaseOgInput,
  env: { WEB_BASE_URL?: string } = { WEB_BASE_URL: process.env.WEB_BASE_URL },
) {
  return {
    type: "article" as const,
    url: releasePathValue,
    publishedTime: input.publishedAt ?? undefined,
    ...(input.orgSlug ? { images: [`${releaseWebBase(env)}/api/og/org/${input.orgSlug}`] } : {}),
  };
}
