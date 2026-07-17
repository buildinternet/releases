import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApiSetupError, ApiNotFoundError } from "@/lib/api";
import { OrgReleaseList } from "@/components/org-release-list";
import { withReleaseBodyHtml, orgRowVariant } from "@/lib/render-release-body";
import { OrgReleaseProductLinks } from "@/components/org/org-release-product-links";
import { StubLocations } from "@/components/org/stub-locations";
import { ClaimPanel } from "@/components/org/claim-panel";
import { orgAvatarSrc } from "@/components/org-avatar";
import { JsonLd } from "@/components/json-ld";
import { buildReleaseItemListJsonLd, currentPeriod, lastModifiedAt } from "@/lib/schema-org";
import { domainHref } from "@/lib/source-display";
import { getOrg } from "../_lib/org-data";
import { getOrgReleases } from "../_lib/org-releases-data";
import { enableOnDemandIsr } from "@/lib/static-params";

// On-demand ISR: render once per org on first request, then serve from cache
// (revalidated every 15 min). See `enableOnDemandIsr`. (#1607)
// Keep in sync with applyCacheInit's default (src/lib/api.ts): the route
// revalidates at the min() of this and every fetch revalidate on it.
export const revalidate = 900;
export const generateStaticParams = enableOnDemandIsr;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug } = await params;
  try {
    const org = await getOrg(orgSlug);
    const lastModified = lastModifiedAt(org);
    const period = currentPeriod();
    // A stub is a thin, near-duplicate page (no releases yet) — noindex AND
    // nofollow it (#1947), stronger than the index:false/follow:true posture
    // used for on_demand / hidden orgs.
    const isStub = org.status === "stub";
    const shouldNoIndex = isStub || org.discovery === "on_demand" || org.isHidden === true;
    return {
      title: `${org.name} Release Notes & Changelog · ${period}`,
      description: `Every ${org.name} release note, changelog, and product update across all tracked sources — version history refreshed ${period}.`,
      ...(shouldNoIndex ? { robots: { index: false, follow: !isStub } } : {}),
      openGraph: {
        type: "website",
        url: `/${orgSlug}`,
        ...(lastModified ? { modifiedTime: lastModified } : {}),
      },
      alternates: {
        canonical: `/${orgSlug}`,
        types: {
          "application/atom+xml": [{ url: `/${orgSlug}.atom`, title: `${org.name} release notes` }],
        },
      },
    };
  } catch {
    return { title: orgSlug };
  }
}

/**
 * Org landing page — the Releases feed is the default tab (homepage links and
 * bare `/:org` URLs land here). Overview lives at `/:org/overview`; the old
 * `/:org/releases` path 308s back here for bookmarks and sitemap entries.
 */
export default async function OrgReleasesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  // Legacy `?tab=` deep-links are redirected to the path-based tab routes in the
  // routing middleware (`src/proxy.ts`) so this page can render statically.

  let org;
  try {
    org = await getOrg(orgSlug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }

  const orgUrl = `https://releases.sh/${orgSlug}`;
  const orgNodeId = `${orgUrl}#org`;
  const lastModified = lastModifiedAt(org);

  // A stub org has no processed sources — skip the releases feed and render
  // declared locations + claim CTA instead of an empty list.
  if (org.status === "stub") {
    const jsonLd = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": orgNodeId,
          name: org.name,
          url: orgUrl,
          ...(org.avatarUrl ? { logo: org.avatarUrl, image: org.avatarUrl } : {}),
          ...(org.domain ? { sameAs: [domainHref(org.domain)] } : {}),
          ...(lastModified ? { dateModified: lastModified } : {}),
        },
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://releases.sh" },
            { "@type": "ListItem", position: 2, name: org.name, item: orgUrl },
          ],
        },
      ],
    };
    return (
      <>
        <JsonLd data={jsonLd} />
        <StubLocations orgName={org.name} locations={org.locations ?? []} />
        <ClaimPanel orgSlug={orgSlug} domain={org.domain} />
      </>
    );
  }

  let initialReleases: Awaited<ReturnType<typeof getOrgReleases>>;
  try {
    initialReleases = await getOrgReleases(orgSlug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  // Resolved org avatar (incl. GitHub fallback) for the image-lightbox byline.
  const orgGithubHandle = org.accounts?.find((a) => a.platform === "github")?.handle ?? null;
  const orgAvatarUrl = orgAvatarSrc(org.avatarUrl, orgGithubHandle, 24);
  const releaseListId = `${orgUrl}#releases`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: `${org.name} Releases`,
        url: orgUrl,
        ...(lastModified ? { dateModified: lastModified } : {}),
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
        initialCursor={initialReleases.nextCursor}
        multipleSourcesExist={org.sources.length > 1}
        availableSourceTypes={Array.from(new Set(org.sources.map((s) => s.type)))}
        orgAvatarUrl={orgAvatarUrl}
        productLinks={<OrgReleaseProductLinks orgSlug={orgSlug} products={org.products} />}
      />
    </>
  );
}
