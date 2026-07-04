import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { api, ApiSetupError, type OrgHeatmap } from "@/lib/api";
import { tryFetch } from "@/lib/ssr-fetch";
import { OverviewView } from "@/components/overview-view";
import { LatestReleasesTeaser } from "@/components/org/latest-releases-teaser";
import { OrgActivityPanel } from "@/components/org/org-activity-panel";
import { JsonLd } from "@/components/json-ld";

import { buildReleaseItemListJsonLd, currentPeriod, lastModifiedAt } from "@/lib/schema-org";
import { domainHref } from "@/lib/source-display";
import { enableOnDemandIsr } from "@/lib/static-params";
import { getOrg } from "../_lib/org-data";

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
    const lastModified = lastModifiedAt(org);
    const shouldNoIndex = org.discovery === "on_demand" || org.isHidden === true;
    return {
      title: `${org.name} Releases & Latest Updates · ${currentPeriod()}`,
      description: `Latest releases, product updates, and tracked sources for ${org.name} — updated ${currentPeriod()}.`,
      ...(shouldNoIndex ? { robots: { index: false, follow: true } } : {}),
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

export default async function OrgOverviewPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  // Legacy `?tab=` deep-links are redirected to the path-based tab routes in the
  // routing middleware (`src/proxy.ts`) so this page can render statically.

  const activityFrom = daysAgoIso(365 * 2).slice(0, 10);

  let org;
  let activityResult;
  let heatmapResult;
  let releasesResult;
  try {
    [org, activityResult, heatmapResult, releasesResult] = await Promise.all([
      getOrg(orgSlug),
      tryFetch(api.orgActivity(orgSlug, activityFrom), {
        route: `/${orgSlug}`,
        event: "org-activity-fetch-failed",
      }),
      tryFetch(api.orgHeatmap(orgSlug), {
        route: `/${orgSlug}`,
        event: "org-heatmap-fetch-failed",
      }),
      // Drives the JSON-LD release ItemList only; a failure just drops the list.
      tryFetch(api.orgReleases(orgSlug, { limit: 20 }), {
        route: `/${orgSlug}`,
        event: "org-releases-fetch-failed",
      }),
    ]);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }

  const activity = activityResult.data;
  const heatmap: OrgHeatmap | null = heatmapResult.data;

  const orgUrl = `https://releases.sh/${orgSlug}`;
  const orgNodeId = `${orgUrl}#org`;
  const releaseListId = `${orgUrl}#releases`;
  const lastModified = lastModifiedAt(org);
  const releaseItems = releasesResult.data?.releases ?? [];
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
        "@type": "CollectionPage",
        name: `${org.name} Releases & Latest Updates`,
        url: orgUrl,
        ...(lastModified ? { dateModified: lastModified } : {}),
        about: { "@id": orgNodeId },
        ...(releaseItems.length > 0 ? { mainEntity: { "@id": releaseListId } } : {}),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://releases.sh" },
          { "@type": "ListItem", position: 2, name: org.name, item: orgUrl },
        ],
      },
      ...(releaseItems.length > 0
        ? [
            buildReleaseItemListJsonLd(releaseItems, {
              listId: releaseListId,
              name: `${org.name} Releases`,
              isPartOfId: orgNodeId,
            }),
          ]
        : []),
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      {org.overview && <OverviewView page={org.overview} variant="org" />}
      {releaseItems.length > 0 && (
        <LatestReleasesTeaser orgSlug={orgSlug} releases={releaseItems} />
      )}
      {activity && (
        <OrgActivityPanel
          orgSlug={orgSlug}
          activity={activity}
          heatmap={heatmap}
          products={org.products}
          sources={org.sources}
          totalReleases={org.releaseCount}
          avgPerWeek={org.avgReleasesPerWeek}
          trackingSince={org.trackingSince}
        />
      )}
      {!activity && !org.overview && activityResult.error && (
        <p className="py-4 text-sm text-[var(--fg-3)]">
          Couldn&apos;t load release activity. Try refreshing.
        </p>
      )}
    </>
  );
}
