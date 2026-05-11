import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ApiSetupError } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { SourceReleaseList } from "@/components/source-release-list";
import { RelatedRail } from "@/components/related-rail";
import { getSource } from "./_lib/source-data";

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
      description: `Release notes and version history for ${source.name} by ${orgName}.`,
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
  sourceSlug,
  orgSlug,
  orgName,
}: {
  anchorReleaseId: string | null;
  sourceSlug: string;
  orgSlug: string | null;
  orgName: string | null;
}) {
  return (
    <>
      {orgSlug && (
        <Suspense fallback={null}>
          <RelatedRail
            anchorReleaseId={anchorReleaseId}
            anchorSourceSlug={sourceSlug}
            scope="org"
            heading={orgName ? `More from ${orgName}` : "More from this team"}
          />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <RelatedRail
          anchorReleaseId={anchorReleaseId}
          anchorSourceSlug={sourceSlug}
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
}: {
  params: Promise<{ orgSlug: string; sourceSlug: string }>;
}) {
  const { orgSlug, sourceSlug } = await params;

  let source;
  try {
    source = await getSource(orgSlug, sourceSlug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }

  // Hand the client component a cursor so its "Load more" can continue from
  // where SSR left off. Format must match `parseFeedCursor` on the API.
  const last = source.releases[source.releases.length - 1];
  const initialCursor =
    source.pagination.hasMore && last ? `${last.publishedAt ?? ""}|${last.id ?? ""}` : null;

  const sourceUrl = `https://releases.sh/${orgSlug}/${sourceSlug}`;
  const lastModified = source.lastFetchedAt ?? source.lastPolledAt ?? undefined;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: source.name,
        softwareVersion: source.latestVersion ?? undefined,
        url: sourceUrl,
        ...(source.org ? { publisher: { "@type": "Organization", name: source.org.name } } : {}),
        ...(lastModified ? { dateModified: lastModified } : {}),
      },
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
        sourceSlug={source.slug}
        orgSlug={source.org?.slug ?? null}
        orgName={source.org?.name ?? null}
      />
    </>
  );
}
