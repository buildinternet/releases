import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { api, ApiSetupError, type OrgHeatmap } from "@/lib/api";
import { ReleaseTimeline } from "@/components/release-timeline";
import { OverviewView } from "@/components/overview-view";
import { JsonLd } from "@/components/json-ld";
import { getOrg } from "./_lib/org-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug } = await params;
  try {
    const org = await getOrg(orgSlug);
    const lastModified = org.lastFetchedAt ?? org.lastPolledAt ?? undefined;
    return {
      title: org.name,
      description: `${org.name} changelog releases on Releases`,
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

  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const activityFrom = twoYearsAgo.toISOString().slice(0, 10);

  let org;
  let activity;
  let heatmap: OrgHeatmap | null = null;
  try {
    [org, activity, heatmap] = await Promise.all([
      getOrg(orgSlug),
      api.orgActivity(orgSlug, activityFrom).catch(() => null),
      api.orgHeatmap(orgSlug).catch(() => null),
    ]);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }

  const orgUrl = `https://releases.sh/${orgSlug}`;
  const lastModified = org.lastFetchedAt ?? org.lastPolledAt ?? undefined;
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
    </>
  );
}
