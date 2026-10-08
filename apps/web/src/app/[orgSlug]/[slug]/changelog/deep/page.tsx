import type { Metadata } from "next";
import { ChangelogPage, changelogMetadata } from "../_lib/changelog-page";

/**
 * Deep-link variant of the changelog view: a non-default file (`?path=`) or a
 * search hit (`?offset=`). The routing proxy rewrites
 * `/[org]/[slug]/changelog?path=…&offset=…` here so the plain changelog URL
 * can stay ISR-cached. Renders per request; its canonical is the plain URL.
 */
export const dynamic = "force-dynamic";

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
}): Promise<Metadata> {
  const { orgSlug, slug } = await params;
  return changelogMetadata(orgSlug, slug);
}

export default async function SourceChangelogDeepLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
  // Next.js delivers repeated query params as `string[]`; collapse to the
  // first value so `?path=a&path=b` doesn't reach the API as an array.
  searchParams: Promise<{ path?: string | string[]; offset?: string | string[] }>;
}) {
  const { orgSlug, slug } = await params;
  const sp = await searchParams;
  const offsetParam = firstParam(sp.offset);
  // `offset` arrives from search chunk deep links so the view can start its
  // initial slice at byte N (the range API snaps forward to the next heading).
  const parsed = offsetParam ? parseInt(offsetParam, 10) : NaN;
  return (
    <ChangelogPage
      orgSlug={orgSlug}
      slug={slug}
      changelogPath={firstParam(sp.path)}
      changelogOffset={Number.isFinite(parsed) && parsed > 0 ? parsed : undefined}
    />
  );
}
