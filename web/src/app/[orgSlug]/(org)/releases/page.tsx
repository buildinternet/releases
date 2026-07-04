import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { api, ApiSetupError, ApiNotFoundError, type OrgReleasesFeedResponse } from "@/lib/api";
import { OrgReleaseList } from "@/components/org-release-list";
import { withReleaseBodyHtml, orgRowVariant } from "@/lib/render-release-body";
import { OrgReleaseProductLinks } from "@/components/org/org-release-product-links";
import { orgAvatarSrc } from "@/components/org-avatar";
import { JsonLd } from "@/components/json-ld";
import { buildReleaseItemListJsonLd, currentPeriod, lastModifiedAt } from "@/lib/schema-org";
import { domainHref } from "@/lib/source-display";
import { getOrg } from "../../_lib/org-data";
import { enableOnDemandIsr } from "@/lib/static-params";

// On-demand ISR: render once per org on first request, then serve from cache
// (revalidated every 60s). See `enableOnDemandIsr`. (#1607)
export const revalidate = 60;
export const generateStaticParams = enableOnDemandIsr;

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

  // Resolved org avatar (incl. GitHub fallback) for the image-lightbox byline.
  const orgGithubHandle = org.accounts?.find((a) => a.platform === "github")?.handle ?? null;
  const orgAvatarUrl = orgAvatarSrc(org.avatarUrl, orgGithubHandle, 24);
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
        initialReleases={withReleaseBodyHtml(initialReleases.releases, orgRowVariant)}
        initialCursor={initialReleases.pagination.nextCursor}
        multipleSourcesExist={org.sources.length > 1}
        availableSourceTypes={Array.from(new Set(org.sources.map((s) => s.type)))}
        orgAvatarUrl={orgAvatarUrl}
        productLinks={<OrgReleaseProductLinks orgSlug={orgSlug} products={org.products} />}
      />
    </>
  );
}
