import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { api, ApiSetupError, type OrgHeatmap } from "@/lib/api";
import { tryFetch } from "@/lib/ssr-fetch";
import { ReleaseTimeline } from "@/components/release-timeline";
import { OverviewView } from "@/components/overview-view";
import { JsonLd } from "@/components/json-ld";
import { lastModifiedAt } from "@/lib/schema-org";
import { getOrg } from "../_lib/org-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug } = await params;
  try {
    const org = await getOrg(orgSlug);
    const lastModified = lastModifiedAt(org);
    return {
      title: org.name,
      description: `Release activity, summary, and tracked sources for ${org.name}.`,
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

  const activityFrom = daysAgoIso(365 * 2).slice(0, 10);

  let org;
  let activityResult;
  let heatmapResult;
  try {
    [org, activityResult, heatmapResult] = await Promise.all([
      getOrg(orgSlug),
      tryFetch(api.orgActivity(orgSlug, activityFrom), {
        route: `/${orgSlug}`,
        event: "org-activity-fetch-failed",
      }),
      tryFetch(api.orgHeatmap(orgSlug), {
        route: `/${orgSlug}`,
        event: "org-heatmap-fetch-failed",
      }),
    ]);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }

  const activity = activityResult.data;
  const heatmap: OrgHeatmap | null = heatmapResult.data;

  const orgUrl = `https://releases.sh/${orgSlug}`;
  const lastModified = lastModifiedAt(org);
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: org.name,
        url: orgUrl,
        ...(org.avatarUrl ? { logo: org.avatarUrl, image: org.avatarUrl } : {}),
        ...(org.domain ? { sameAs: [`https://${org.domain}`] } : {}),
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
