import type { Metadata } from "next";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { api } from "@/lib/api";
import { tryFetch } from "@/lib/ssr-fetch";
import { ReleaseTimeline } from "@/components/release-timeline";
import { OverviewView } from "@/components/overview-view";
import { JsonLd } from "@/components/json-ld";
import { Header } from "@/components/header";

// releases.sh publishes its own product changelog through its own registry.
// The `releases-sh` org is the canonical home; `/updates` is the branded face
// of it. Keep the slug here in sync with the seeded org (see
// docs/superpowers/specs/2026-06-10-self-published-changelog-design.md).
const ORG_SLUG = "releases-sh";
const TITLE = "What's New";
const DESCRIPTION =
  "Product updates and changelog for releases.sh — new features, fixes, and improvements, rolled up by day.";

export const metadata: Metadata = {
  title: `${TITLE} · releases.sh`,
  description: DESCRIPTION,
  alternates: {
    canonical: "/updates",
    types: {
      "application/atom+xml": [{ url: `/${ORG_SLUG}.atom`, title: "releases.sh changelog" }],
    },
  },
  openGraph: {
    title: `${TITLE} · releases.sh`,
    description: DESCRIPTION,
    url: "/updates",
    type: "website",
  },
  twitter: { title: `${TITLE} · releases.sh`, description: DESCRIPTION },
};

export default async function UpdatesPage() {
  const activityFrom = daysAgoIso(365 * 2).slice(0, 10);

  // Our own org must exist; let a hard failure surface rather than a 404.
  const [org, activityResult, heatmapResult] = await Promise.all([
    api.orgDetail(ORG_SLUG),
    tryFetch(api.orgActivity(ORG_SLUG, activityFrom), {
      route: "/updates",
      event: "updates-activity-fetch-failed",
    }),
    tryFetch(api.orgHeatmap(ORG_SLUG), {
      route: "/updates",
      event: "updates-heatmap-fetch-failed",
    }),
  ]);

  const activity = activityResult.data;
  const heatmap = heatmapResult.data;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${TITLE} — releases.sh`,
    url: "https://releases.sh/updates",
    description: DESCRIPTION,
  };

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <JsonLd data={jsonLd} />
        <header className="pt-8 pb-4 border-b border-stone-200 dark:border-stone-800">
          <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
            {TITLE}
          </h1>
          <p className="mt-1.5 max-w-[60ch] text-sm text-stone-500 dark:text-stone-400">
            {DESCRIPTION}
          </p>
        </header>
        {activity ? (
          <ReleaseTimeline
            activity={activity}
            heatmap={heatmap}
            orgSlug={ORG_SLUG}
            sources={org.sources}
            products={org.products}
            trackingSince={org.trackingSince}
            overview={org.overview}
          />
        ) : org.overview ? (
          <OverviewView page={org.overview} />
        ) : (
          <p className="py-6 text-sm text-stone-400 dark:text-stone-500">
            Couldn&apos;t load updates. Try refreshing.
          </p>
        )}
      </div>
    </div>
  );
}
