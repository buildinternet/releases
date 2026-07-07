import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { api, ApiSetupError, type OrgHeatmap } from "@/lib/api";
import { tryFetch } from "@/lib/ssr-fetch";
import { OverviewView } from "@/components/overview-view";
import { LatestReleasesTeaser } from "@/components/org/latest-releases-teaser";
import { OrgActivityPanel } from "@/components/org/org-activity-panel";
import { StubLocations } from "@/components/org/stub-locations";
import { ClaimPanel } from "@/components/org/claim-panel";
import { JsonLd } from "@/components/json-ld";

import {
  buildOverviewCitationJsonLd,
  buildReleaseItemListJsonLd,
  currentPeriod,
  lastModifiedAt,
} from "@/lib/schema-org";
import { domainHref } from "@/lib/source-display";
import { enableOnDemandIsr } from "@/lib/static-params";
import { getOrg, getOrgOverview } from "../_lib/org-data";
import { getOrgReleases } from "../_lib/org-releases-data";

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
    // A stub is a thin, near-duplicate page (no releases yet) — noindex AND
    // nofollow it (#1947), stronger than the index:false/follow:true posture
    // used for on_demand / hidden orgs.
    const isStub = org.status === "stub";
    const shouldNoIndex = isStub || org.discovery === "on_demand" || org.isHidden === true;
    return {
      title: `${org.name} Releases & Latest Updates · ${currentPeriod()}`,
      description: `Latest releases, product updates, and tracked sources for ${org.name} — updated ${currentPeriod()}.`,
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
  try {
    org = await getOrg(orgSlug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }

  const orgUrl = `https://releases.sh/${orgSlug}`;
  const orgNodeId = `${orgUrl}#org`;
  const lastModified = lastModifiedAt(org);

  // A stub org has no processed sources — skip the activity/heatmap/releases
  // fetches entirely (they'd be discarded) and render declared locations.
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

  let activityResult;
  let heatmapResult;
  let releaseItems: Awaited<ReturnType<typeof getOrgReleases>>["releases"];
  let overview: Awaited<ReturnType<typeof getOrgOverview>>;
  try {
    [activityResult, heatmapResult, releaseItems, overview] = await Promise.all([
      tryFetch(api.orgActivity(orgSlug, activityFrom), {
        route: `/${orgSlug}`,
        event: "org-activity-fetch-failed",
      }),
      tryFetch(api.orgHeatmap(orgSlug), {
        route: `/${orgSlug}`,
        event: "org-heatmap-fetch-failed",
      }),
      // Drives the JSON-LD release ItemList only; a failure just drops the list.
      getOrgReleases(orgSlug, 20)
        .then((r) => r.releases)
        .catch(() => []),
      getOrgOverview(orgSlug),
    ]);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }

  const activity = activityResult.data;
  const heatmap: OrgHeatmap | null = heatmapResult.data;

  const releaseListId = `${orgUrl}#releases`;
  // Declare the overview's provenance as internal release-page citations (#1934).
  const overviewCitationNode = overview
    ? buildOverviewCitationJsonLd(overview.citations, {
        orgName: org.name,
        aboutId: orgNodeId,
        dateModified: lastModified,
      })
    : null;
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
      ...(overviewCitationNode ? [overviewCitationNode] : []),
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
      {overview && <OverviewView page={overview} variant="org" />}
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
      {!activity && !overview && activityResult.error && (
        <p className="py-4 text-sm text-[var(--fg-3)]">
          Couldn&apos;t load release activity. Try refreshing.
        </p>
      )}
    </>
  );
}
