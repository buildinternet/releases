import { cache, Suspense } from "react";
import type { Metadata } from "next";
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
import { ChangelogView, ChangelogSkeleton } from "@/components/changelog-view";
import { SourceTimeline } from "@/components/source-timeline";
import Link from "next/link";

const getSource = cache((slug: string, page = 1) => api.sourceDetail(slug, page));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  try {
    const source = await getSource(slug);
    return {
      title: source.name,
      description: `Release notes and changelog for ${source.name}`,
      openGraph: { type: "website" },
    };
  } catch {
    return { title: slug };
  }
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function shortUrl(url: string) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    return path && path !== "/" ? u.hostname + path : u.hostname;
  } catch { return url; }
}

function githubRepoHandle(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const [owner, repo] = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!owner || !repo) return null;
    return `@${owner}/${repo}`;
  } catch { return null; }
}

export default async function IndependentSourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; tab?: string }>;
}) {
  const { slug } = await params;
  const { page: pageParam, tab } = await searchParams;
  const page = parseInt(pageParam ?? "1", 10) || 1;

  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const activityFrom = twoYearsAgo.toISOString().slice(0, 10);

  let source;
  let activity;
  try {
    [source, activity] = await Promise.all([
      getSource(slug, page),
      api.sourceActivity(slug, activityFrom).catch(() => null),
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

  if (source.org) {
    redirect(`/${source.org.slug}/${source.slug}`);
  }

  const sidebarSections = [
    { items: [{ label: "Releases", value: source.releaseCount, large: true }] },
    {
      items: [
        { label: "Last 30 Days", value: source.releasesLast30Days, large: true, subtitle: "releases", tooltip: "Total releases published in the last 30 days." },
        { label: "Avg per Week", value: Math.round(source.avgReleasesPerWeek), large: true, subtitle: "releases", tooltip: "Average releases per week over the last 90 days, or since tracking began if shorter." },
      ],
    },
    {
      items: [
        { label: "Latest", value: source.latestVersion, subtitle: formatDate(source.latestDate) },
        (() => {
          const ghHandle = source.type === "github" ? githubRepoHandle(source.url) : null;
          if (ghHandle) {
            return {
              label: "Source",
              value: (
                <span className="inline-flex items-center gap-1.5">
                  <SourceTypeIcon type="github" size={13} />
                  <span>{ghHandle}</span>
                </span>
              ),
              externalLink: source.url,
            };
          }
          return { label: "Source", value: shortUrl(source.url), externalLink: source.url };
        })(),
        ...(source.changelogUrl ? [{ label: "Changelog", value: "View changelog", externalLink: source.changelogUrl }] : []),
        { label: "Tracking Since", value: formatDate(source.trackingSince) },
      ],
    },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": source.name,
    "softwareVersion": source.latestVersion ?? undefined,
    "url": `https://releases.sh/source/${slug}`,
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
            <SourceTabs
              hasHighlights={!!(source.summaries?.rolling || source.summaries?.monthly?.length)}
              hasChangelog={!!source.hasChangelogFile}
            />
            {tab === "changelog" && source.hasChangelogFile ? (
              <Suspense key={source.slug} fallback={<ChangelogSkeleton />}>
                <ChangelogView sourceSlug={source.slug} />
              </Suspense>
            ) : (tab === "releases" || (!source.summaries?.rolling && !source.summaries?.monthly?.length)) ? (
              <>
                {source.releases.map((release, i) => (
                  <ReleaseListItem key={i} release={release} hideDate={i > 0 && release.publishedAt?.slice(0, 10) === source.releases[i - 1].publishedAt?.slice(0, 10)} />
                ))}
                <Pagination page={source.pagination.page} totalPages={source.pagination.totalPages} basePath={`/source/${slug}`} />
              </>
            ) : (
              <HighlightsView
                rolling={source.summaries?.rolling ?? null}
                monthly={source.summaries?.monthly ?? []}
              />
            )}
          </div>
          <Sidebar sections={sidebarSections} formatPath={`/source/${slug}`} footnote={source.lastFetchedAt ? `Last fetched ${formatDate(source.lastFetchedAt)}` : null} footnoteTitle={source.lastFetchedAt} />
        </div>
      </div>
    </div>
  );
}
