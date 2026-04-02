import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { api, ApiSetupError, type OrgDetail } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { SourceCard } from "@/components/source-card";
import { Sidebar } from "@/components/sidebar";
import { ReleaseTimeline } from "@/components/release-timeline";
import { OrgTabs } from "@/components/org-tabs";
import { OrgReleaseList } from "@/components/org-release-list";
import Link from "next/link";
import { OrgAvatar } from "@/components/org-avatar";

export async function generateMetadata({ params }: { params: Promise<{ orgSlug: string }> }): Promise<Metadata> {
  const { orgSlug } = await params;
  try {
    const org = await api.orgDetail(orgSlug);
    return {
      title: org.name,
      description: `${org.name} changelog releases on Released`,
      openGraph: { type: "website" },
    };
  } catch {
    return { title: orgSlug };
  }
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function SourceList({ org, orgSlug }: { org: OrgDetail; orgSlug: string }) {
  const sortedSources = [...org.sources].sort((a, b) => {
    if (a.isPrimary && !b.isPrimary) return -1;
    if (!a.isPrimary && b.isPrimary) return 1;
    if (a.type === "github" && b.type !== "github") return 1;
    if (a.type !== "github" && b.type === "github") return -1;
    return 0;
  });

  return (
    <div className="space-y-2">
      {sortedSources.map((source) => (
        <SourceCard key={source.slug} source={source} orgSlug={orgSlug} />
      ))}
    </div>
  );
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
  const showReleases = tab === "releases";

  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const activityFrom = twoYearsAgo.toISOString().slice(0, 10);

  let org;
  let activity;
  let initialReleases: import("@/lib/api").OrgReleasesResponse | null = null;
  try {
    if (showReleases) {
      [org, initialReleases] = await Promise.all([
        api.orgDetail(orgSlug),
        api.orgReleases(orgSlug).catch(() => null),
      ]);
    } else {
      [org, activity] = await Promise.all([
        api.orgDetail(orgSlug),
        api.orgActivity(orgSlug, activityFrom).catch(() => null),
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
        { label: "Sources", value: org.sourceCount, large: true },
        { label: "Total Releases", value: org.releaseCount, large: true },
      ],
    },
    {
      items: [
        { label: "Last 30 Days", value: org.releasesLast30Days, large: true, subtitle: "releases" },
        { label: "Avg per Week", value: Math.round(org.avgReleasesPerWeek), large: true, subtitle: "releases" },
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
            <OrgTabs />
            {showReleases ? (
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
            ) : activity ? (
              <ReleaseTimeline activity={activity} orgSlug={org.slug} sources={org.sources} />
            ) : (
              <div className="mt-6">
                <SourceList org={org} orgSlug={orgSlug} />
              </div>
            )}
          </div>
          <Sidebar sections={sidebarSections} accounts={org.accounts} formatPath={`/${orgSlug}`} footnote={org.lastFetchedAt ? `Last fetched ${formatDate(org.lastFetchedAt)}` : null} footnoteTitle={org.lastFetchedAt} />
        </div>
      </div>
    </div>
  );
}
