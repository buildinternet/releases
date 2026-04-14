import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { api, ApiSetupError, type OrgHeatmap, type OrgReleasesResponse } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { Sidebar } from "@/components/sidebar";
import { ReleaseTimeline } from "@/components/release-timeline";
import { OrgTabs } from "@/components/org-tabs";
import { OrgReleaseList } from "@/components/org-release-list";
import Link from "next/link";
import { OrgAvatar } from "@/components/org-avatar";
import { OverviewView } from "@/components/overview-view";
import { PlaybookView } from "@/components/playbook-view";
import { SourceTable } from "@/components/source-table";

const getOrg = cache((slug: string) => api.orgDetail(slug));

export async function generateMetadata({ params }: { params: Promise<{ orgSlug: string }> }): Promise<Metadata> {
  const { orgSlug } = await params;
  try {
    const org = await getOrg(orgSlug);
    return {
      title: org.name,
      description: `${org.name} changelog releases on Releases`,
      openGraph: { type: "website" },
    };
  } catch {
    return { title: orgSlug };
  }
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export default async function OrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { orgSlug } = await params;
  const { tab } = await searchParams;
  const activeTab = tab ?? "overview";

  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const activityFrom = twoYearsAgo.toISOString().slice(0, 10);

  let org;
  let activity;
  let heatmap: OrgHeatmap | null = null;
  let initialReleases: OrgReleasesResponse | null = null;
  let sparklines: { sources: { slug: string; name: string; sparkline: number[] }[] } | null = null;
  try {
    if (activeTab === "releases") {
      [org, initialReleases] = await Promise.all([
        getOrg(orgSlug),
        api.orgReleases(orgSlug).catch(() => null),
      ]);
    } else if (activeTab === "sources") {
      [org, sparklines] = await Promise.all([
        getOrg(orgSlug),
        api.orgSparklines(orgSlug).catch(() => null),
      ]);
    } else if (activeTab === "guide") {
      org = await getOrg(orgSlug);
    } else {
      [org, activity, heatmap] = await Promise.all([
        getOrg(orgSlug),
        api.orgActivity(orgSlug, activityFrom).catch(() => null),
        api.orgHeatmap(orgSlug).catch(() => null),
      ]);
    }
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    notFound();
  }

  const sidebarSections = [
    {
      items: [
        ...(org.domain ? [{ label: "Domain", value: org.domain }] : []),
      ],
    },
    {
      items: [
        { label: "Last 30 Days", value: org.releasesLast30Days, large: true, subtitle: "releases", tooltip: "Total releases published in the last 30 days across all sources." },
        { label: "Avg per Week", value: Math.round(org.avgReleasesPerWeek), large: true, subtitle: "releases", tooltip: "Average releases per week over the last 90 days, or since tracking began if shorter." },
      ],
    },
    {
      items: [
        { label: "Tracking Since", value: formatDate(org.trackingSince) },
      ],
    },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": org.name,
    "url": `https://releases.sh/${orgSlug}`,
  };

  return (
    <div className="min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">Home</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{org.name}</span>
        </div>
        {org.avatarUrl || org.accounts.some(a => a.platform === "github") ? (
          <div className="flex items-center gap-3 mt-4">
            <OrgAvatar
              avatarUrl={org.avatarUrl}
              githubHandle={org.accounts.find(a => a.platform === "github")?.handle ?? null}
              name={org.name}
              size={40}
            />
            <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">{org.name}</h1>
          </div>
        ) : (
          <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mt-4">{org.name}</h1>
        )}
        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-6">
          <div className="flex-1 min-w-0">
            <OrgTabs hasPlaybook={process.env.NODE_ENV === 'development' && !!org.playbook} />

            {activeTab === "releases" ? (
              initialReleases ? (
                <OrgReleaseList
                  orgSlug={orgSlug}
                  initialReleases={initialReleases.releases}
                  initialCursor={initialReleases.pagination.nextCursor}
                  multipleSourcesExist={org.sources.length > 1}
                />
              ) : (
                <div className="text-center py-12 text-stone-400 dark:text-stone-500 text-sm">
                  No releases yet.
                </div>
              )
            ) : activeTab === "sources" ? (
              <SourceTable sources={org.sources} products={org.products} orgSlug={orgSlug} sourceSparklines={(() => {
                const map: Record<string, number[]> = {};
                if (sparklines) {
                  for (const s of sparklines.sources) {
                    map[s.slug] = s.sparkline;
                  }
                }
                return Object.keys(map).length > 0 ? map : undefined;
              })()} />
            ) : activeTab === "playbook" && process.env.NODE_ENV === 'development' && org.playbook ? (
              <PlaybookView playbook={org.playbook} />
            ) : (
              <>
                {activity && (
                  <ReleaseTimeline activity={activity} heatmap={heatmap} orgSlug={orgSlug} sources={org.sources} products={org.products} trackingSince={org.trackingSince} />
                )}
                {org.overview && <OverviewView page={org.overview} />}
              </>
            )}
          </div>
          <Sidebar sections={sidebarSections} accounts={org.accounts} formatPath={`/${orgSlug}`} footnote={org.lastFetchedAt ? `Last fetched ${formatDate(org.lastFetchedAt)}` : null} footnoteTitle={org.lastFetchedAt} />
        </div>
      </div>
    </div>
  );
}
