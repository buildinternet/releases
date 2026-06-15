import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { api, ApiSetupError, type OrgHeatmap } from "@/lib/api";
import { tryFetch } from "@/lib/ssr-fetch";
import { ReleaseTimeline } from "@/components/release-timeline";
import { OverviewView } from "@/components/overview-view";
import { JsonLd } from "@/components/json-ld";
import { ProductGrid } from "@/components/product-grid";
import { buildReleaseItemListJsonLd, currentPeriod, lastModifiedAt } from "@/lib/schema-org";
import { domainHref } from "@/lib/source-display";
import { getOrg } from "../_lib/org-data";

const LEGACY_ORG_TABS = new Set(["releases", "sources", "playbook", "fetch-log"]);

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
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { orgSlug } = await params;
  const { tab } = await searchParams;
  const tabValue = Array.isArray(tab) ? tab[0] : tab;

  // Handled here rather than in next.config.ts so `:orgSlug` can't greedy-match
  // top-level routes like /status, /docs, etc.
  if (tabValue && LEGACY_ORG_TABS.has(tabValue)) {
    permanentRedirect(`/${orgSlug}/${tabValue}`);
  }

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
      <ProductGrid orgSlug={orgSlug} products={org.products} />
      {activity && (
        <ReleaseTimeline
          activity={activity}
          heatmap={heatmap}
          orgSlug={orgSlug}
          sources={org.sources}
          products={org.products}
          trackingSince={org.trackingSince}
          overview={org.overview}
        />
      )}
      {!activity && org.overview && <OverviewView page={org.overview} />}
      {!activity && !org.overview && activityResult.error && (
        <p className="text-sm text-stone-400 dark:text-stone-500 py-4">
          Couldn&apos;t load release activity. Try refreshing.
        </p>
      )}
    </>
  );
}
