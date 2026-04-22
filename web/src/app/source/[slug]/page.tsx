import { cache } from "react";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { api, ApiSetupError } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { SourceTypeIcon } from "@/components/source-type-icon";
import { Sidebar } from "@/components/sidebar";
import { SourceTabs } from "@/components/source-tabs";
import { SourceMainContent } from "@/components/source-main-content";
import { RelatedRail } from "@/components/related-rail";
import { Suspense } from "react";
import { SourceTimeline } from "@/components/source-timeline";
import { CliCommand } from "@/components/cli-command";
import { formatSourceDate, sourceUrlSidebarItem } from "@/lib/source-display";
import Link from "next/link";

const getSource = cache((slug: string, page = 1) => api.sourceDetail(slug, page));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const source = await getSource(slug);
    return {
      title: source.name,
      description: `Release notes and changelog for ${source.name}`,
      openGraph: { type: "website", url: `/source/${slug}` },
      alternates: {
        canonical: `/source/${slug}`,
        types: {
          "application/atom+xml": [
            { url: `/source/${slug}.atom`, title: `${source.name} release notes` },
          ],
        },
      },
    };
  } catch {
    return { title: slug };
  }
}

const formatDate = formatSourceDate;

export default async function IndependentSourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; tab?: string; path?: string; offset?: string }>;
}) {
  const { slug } = await params;
  const { page: pageParam, tab, path: changelogPath, offset: offsetParam } = await searchParams;
  const page = parseInt(pageParam ?? "1", 10) || 1;
  // `offset` arrives from search chunk deep-links. Parse defensively —
  // a malformed query string should fall back to the full-file view.
  const changelogOffset = (() => {
    if (!offsetParam) return undefined;
    const n = parseInt(offsetParam, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();

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
    // Preserve search-relevant query params (tab/path/offset) across the
    // canonical redirect so search chunk deep-links keep working when the
    // source happens to live under an org. Drop `page` since the target
    // page handles pagination the same way.
    const forward = new URLSearchParams();
    if (tab) forward.set("tab", tab);
    if (changelogPath) forward.set("path", changelogPath);
    if (offsetParam) forward.set("offset", offsetParam);
    const qs = forward.toString();
    redirect(`/${source.org.slug}/${source.slug}${qs ? `?${qs}` : ""}`);
  }

  const sidebarSections = [
    { items: [{ label: "Releases", value: source.releaseCount, large: true }] },
    {
      items: [
        { label: "Latest", value: source.latestVersion, subtitle: formatDate(source.latestDate) },
        sourceUrlSidebarItem(source),
        ...(source.changelogUrl
          ? [{ label: "Changelog", value: "View changelog", externalLink: source.changelogUrl }]
          : []),
        { label: "Tracking Since", value: formatDate(source.trackingSince) },
      ],
    },
  ];

  const sourceUrl = `https://releases.sh/source/${slug}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: source.name,
        softwareVersion: source.latestVersion ?? undefined,
        url: sourceUrl,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://releases.sh" },
          { "@type": "ListItem", position: 2, name: source.name, item: sourceUrl },
        ],
      },
    ],
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
          <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{source.name}</span>
        </div>
        <div className="flex items-center gap-2.5 mt-4">
          <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
            {source.name}
          </h1>
          <SourceTypeIcon type={source.type} size={18} />
        </div>
        <CliCommand identifier={source.slug} />
        {activity && <SourceTimeline activity={activity} />}
        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-12">
          <div className="flex-1 min-w-0">
            <SourceTabs
              hasHighlights={!!(source.summaries?.rolling || source.summaries?.monthly?.length)}
              hasChangelog={!!source.hasChangelogFile}
            />
            <SourceMainContent
              source={source}
              tab={tab}
              basePath={`/source/${slug}`}
              changelogPath={changelogPath}
              changelogOffset={changelogOffset}
            />
            {(!tab || tab === "releases") && (
              <Suspense fallback={null}>
                <RelatedRail
                  anchorReleaseId={source.releases[0]?.id ?? null}
                  anchorSourceSlug={source.slug}
                  scope="global"
                  heading="From other products"
                />
              </Suspense>
            )}
          </div>
          <Sidebar
            sections={sidebarSections}
            formatPath={`/source/${slug}`}
            lastCheckedAt={source.lastPolledAt ?? source.lastFetchedAt}
            lastFetchedAt={source.lastFetchedAt}
          />
        </div>
      </div>
    </div>
  );
}
