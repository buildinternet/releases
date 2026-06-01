import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { api, ApiSetupError, ApiNotFoundError, type OrgReleasesFeedResponse } from "@/lib/api";
import { OrgReleaseList } from "@/components/org-release-list";
import { JsonLd } from "@/components/json-ld";
import { buildReleaseItemListJsonLd, currentPeriod, lastModifiedAt } from "@/lib/schema-org";
import { domainHref } from "@/lib/source-display";
import { getOrg } from "../../_lib/org-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug } = await params;
  try {
    const org = await getOrg(orgSlug);
    const modifiedTime = lastModifiedAt(org);
    const period = currentPeriod();
    return {
      title: `${org.name} Release Notes & Changelog · ${period}`,
      description: `Every ${org.name} release note, changelog, and product update across all tracked sources — version history refreshed ${period}.`,
      openGraph: {
        type: "website",
        url: `/${orgSlug}/releases`,
        ...(modifiedTime ? { modifiedTime } : {}),
      },
      alternates: {
        canonical: `/${orgSlug}/releases`,
        types: {
          "application/atom+xml": [{ url: `/${orgSlug}.atom`, title: `${org.name} release notes` }],
        },
      },
    };
  } catch {
    return { title: orgSlug };
  }
}

export default async function OrgReleasesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  let org;
  let initialReleases: OrgReleasesFeedResponse;
  try {
    [org, initialReleases] = await Promise.all([getOrg(orgSlug), api.orgReleases(orgSlug)]);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  const orgUrl = `https://releases.sh/${orgSlug}`;
  const pageUrl = `${orgUrl}/releases`;
  const orgNodeId = `${orgUrl}#org`;
  const releaseListId = `${pageUrl}#releases`;
  const dateModified = lastModifiedAt(org);
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: `${org.name} Releases`,
        url: pageUrl,
        ...(dateModified ? { dateModified } : {}),
        mainEntity: { "@id": releaseListId },
        about: {
          "@type": "Organization",
          "@id": orgNodeId,
          name: org.name,
          url: orgUrl,
          ...(org.domain ? { sameAs: [domainHref(org.domain)] } : {}),
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://releases.sh" },
          { "@type": "ListItem", position: 2, name: org.name, item: orgUrl },
          { "@type": "ListItem", position: 3, name: "Releases", item: pageUrl },
        ],
      },
      buildReleaseItemListJsonLd(initialReleases.releases, {
        listId: releaseListId,
        name: `${org.name} Releases`,
        isPartOfId: orgNodeId,
      }),
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <OrgReleaseList
        orgSlug={orgSlug}
        initialReleases={initialReleases.releases}
        initialCursor={initialReleases.pagination.nextCursor}
        multipleSourcesExist={org.sources.length > 1}
        availableSourceTypes={Array.from(new Set(org.sources.map((s) => s.type)))}
      />
    </>
  );
}
