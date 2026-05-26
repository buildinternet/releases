import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { Suspense } from "react";
import { ApiSetupError, ApiNotFoundError } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { SourceReleaseList } from "@/components/source-release-list";
import { RelatedRail } from "@/components/related-rail";
import {
  buildReleaseItemListJsonLd,
  buildSourceEntityJsonLd,
  currentPeriod,
} from "@/lib/schema-org";
import { getSource } from "./_lib/source-data";

const LEGACY_SOURCE_TABS = new Set(["highlights", "changelog"]);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; sourceSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug, sourceSlug } = await params;
  try {
    const source = await getSource(orgSlug, sourceSlug);
    const orgName = source.org?.name ?? orgSlug;
    return {
      title: `${source.name} — ${orgName}`,
      description: `Release notes, changelog, and version history for ${source.name} by ${orgName} — updated ${currentPeriod()}.`,
      openGraph: { type: "website", url: `/${orgSlug}/${sourceSlug}` },
      alternates: {
        canonical: `/${orgSlug}/${sourceSlug}`,
        types: {
          "application/atom+xml": [
            {
              url: `/${orgSlug}/${sourceSlug}.atom`,
              title: `${source.name} release notes — ${orgName}`,
            },
          ],
        },
      },
    };
  } catch {
    return { title: sourceSlug };
  }
}

/**
 * Two rails under the release list:
 *   1. "More from {org}" — same-org releases + sibling sources.
 *   2. "From other products" — global semantic neighbors, excluding this org.
 *
 * Server-rendered inside Suspense so a slow Vectorize roundtrip doesn't
 * hold the rest of the page hostage. Empty/degraded rails collapse to null.
 */
function RelatedRails({
  anchorReleaseId,
  orgSlug,
  orgName,
}: {
  anchorReleaseId: string | null;
  orgSlug: string | null;
  orgName: string | null;
}) {
  return (
    <>
      {orgSlug && (
        <Suspense fallback={null}>
          <RelatedRail
            anchorReleaseId={anchorReleaseId}
            scope="org"
            heading={orgName ? `More from ${orgName}` : "More from this team"}
          />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <RelatedRail
          anchorReleaseId={anchorReleaseId}
          scope="global"
          heading="From other products"
          excludeOrgSlug={orgSlug}
        />
      </Suspense>
    </>
  );
}

export default async function SourceReleasesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; sourceSlug: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { orgSlug, sourceSlug } = await params;
  const { tab } = await searchParams;
  const tabValue = Array.isArray(tab) ? tab[0] : tab;

  // See `(org)/page.tsx` — same `:orgSlug` greedy-match concern applies here.
  if (tabValue && LEGACY_SOURCE_TABS.has(tabValue)) {
    permanentRedirect(`/${orgSlug}/${sourceSlug}/${tabValue}`);
  }

  let source;
  try {
    source = await getSource(orgSlug, sourceSlug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  // Hand the client component the API's nextCursor so its "Load more" can
  // continue from where SSR left off.
  const initialCursor = source.pagination.nextCursor;

  const sourceUrl = `https://releases.sh/${orgSlug}/${sourceSlug}`;
  const releaseListId = `${sourceUrl}#releases`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      buildSourceEntityJsonLd(source, sourceUrl),
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://releases.sh" },
          ...(source.org
            ? [
                {
                  "@type": "ListItem",
                  position: 2,
                  name: source.org.name,
                  item: `https://releases.sh/${source.org.slug}`,
                },
                { "@type": "ListItem", position: 3, name: source.name, item: sourceUrl },
              ]
            : [{ "@type": "ListItem", position: 2, name: source.name, item: sourceUrl }]),
        ],
      },
      buildReleaseItemListJsonLd(source.releases, {
        listId: releaseListId,
        name: `${source.name} releases`,
        isPartOfId: sourceUrl,
      }),
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <SourceReleaseList
        orgSlug={orgSlug}
        sourceSlug={source.slug}
        initialReleases={source.releases}
        initialCursor={initialCursor}
      />
      <RelatedRails
        anchorReleaseId={source.releases[0]?.id ?? null}
        orgSlug={source.org?.slug ?? null}
        orgName={source.org?.name ?? null}
      />
    </>
  );
}
