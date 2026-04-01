import { notFound, redirect } from "next/navigation";
import { api, ApiSetupError } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { SourceTypeIcon } from "@/components/source-type-icon";
import { ReleaseListItem } from "@/components/release-item";
import { Pagination } from "@/components/pagination";
import { Sidebar } from "@/components/sidebar";
import { SourceTabs } from "@/components/source-tabs";
import { HighlightsView } from "@/components/highlights-view";
import { SourceTimeline } from "@/components/source-timeline";
import Link from "next/link";

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function shortUrl(url: string) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    return path && path !== "/" ? u.hostname + path : u.hostname;
  } catch { return url; }
}

export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; sourceSlug: string }>;
  searchParams: Promise<{ page?: string; tab?: string }>;
}) {
  const { orgSlug, sourceSlug } = await params;
  const { page: pageParam, tab } = await searchParams;
  const page = parseInt(pageParam ?? "1", 10) || 1;

  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const activityFrom = twoYearsAgo.toISOString().slice(0, 10);

  let source;
  let activity;
  try {
    [source, activity] = await Promise.all([
      api.sourceDetail(sourceSlug, page),
      api.sourceActivity(sourceSlug, activityFrom).catch(() => null),
    ]);
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

  if (source.org && source.org.slug !== orgSlug) {
    redirect(`/${source.org.slug}/${source.slug}`);
  }
  if (!source.org) {
    redirect(`/source/${source.slug}`);
  }

  const sidebarSections = [
    { items: [{ label: "Releases", value: source.releaseCount, large: true }] },
    {
      items: [
        { label: "Last 30 Days", value: source.releasesLast30Days, large: true, subtitle: "releases" },
        { label: "Avg per Week", value: Math.round(source.avgReleasesPerWeek), large: true, subtitle: "releases" },
      ],
    },
    {
      items: [
        { label: "Latest", value: source.latestVersion ?? formatDate(source.latestDate) },
        { label: "Organization", value: source.org.name, link: `/${source.org.slug}` },
        { label: "Source", value: shortUrl(source.url), externalLink: source.url },
        ...(source.changelogUrl ? [{ label: "Changelog", value: "View changelog", externalLink: source.changelogUrl }] : []),
        { label: "Tracking Since", value: formatDate(source.trackingSince) },
      ],
    },
  ];

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link href={`/${source.org.slug}`} className="hover:text-stone-600 dark:hover:text-stone-300">{source.org.name}</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{source.name}</span>
        </div>
        <div className="flex items-center gap-2.5 mt-4">
          <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">{source.name}</h1>
          <SourceTypeIcon type={source.type} size={18} />
        </div>
        {activity && (
          <SourceTimeline activity={activity} />
        )}
        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-12">
          <div className="flex-1 min-w-0">
            <SourceTabs hasHighlights={!!(source.summaries?.rolling || source.summaries?.monthly?.length)} />
            {(tab === "releases" || (!source.summaries?.rolling && !source.summaries?.monthly?.length)) ? (
              <>
                {source.releases.map((release, i) => (
                  <ReleaseListItem key={i} release={release} />
                ))}
                <Pagination page={source.pagination.page} totalPages={source.pagination.totalPages} basePath={`/${orgSlug}/${sourceSlug}`} />
              </>
            ) : (
              <HighlightsView
                rolling={source.summaries?.rolling ?? null}
                monthly={source.summaries?.monthly ?? []}
              />
            )}
          </div>
          <Sidebar sections={sidebarSections} formatPath={`/${orgSlug}/${sourceSlug}`} footnote={source.lastFetchedAt ? `Last fetched ${formatDate(source.lastFetchedAt)}` : null} footnoteTitle={source.lastFetchedAt} />
        </div>
      </div>
    </div>
  );
}
