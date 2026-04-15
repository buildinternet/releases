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
import { RelatedReleases } from "@/components/related-releases";
import { RelatedSources } from "@/components/related-sources";
import { Suspense } from "react";
import { SourceTimeline } from "@/components/source-timeline";
import { CliCommand } from "@/components/cli-command";
import { formatSourceDate, sourceUrlSidebarItem } from "@/lib/source-display";
import Link from "next/link";

const getSource = cache((slug: string, page = 1) => api.sourceDetail(slug, page));

/**
 * Stacks related rails under the release list:
 *   1. Related releases — within the same org (when the source has an org).
 *   2. Related releases — global, minus anything we already rendered.
 *   3. Related sources — within the same org (siblings).
 *   4. Related sources — global, minus the current org.
 *
 * Each rail server-renders inside a Suspense boundary so a slow Vectorize
 * roundtrip doesn't hold the rest of the page hostage. Empty / degraded
 * rails collapse to null inside the component.
 */
function RelatedRails({
  anchorReleaseId,
  sourceSlug,
  orgSlug,
}: {
  anchorReleaseId: string | null;
  sourceSlug: string;
  orgSlug: string | null;
}) {
  return (
    <>
      {anchorReleaseId && orgSlug && (
        <Suspense fallback={null}>
          <RelatedReleases
            anchorReleaseId={anchorReleaseId}
            scope="org"
            heading="More from this team"
          />
        </Suspense>
      )}
      {anchorReleaseId && (
        <Suspense fallback={null}>
          <RelatedReleases
            anchorReleaseId={anchorReleaseId}
            scope="global"
            heading="Similar releases"
          />
        </Suspense>
      )}
      {orgSlug && (
        <Suspense fallback={null}>
          <RelatedSources anchor={sourceSlug} scope="org" heading="Other sources from this team" />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <RelatedSources
          anchor={sourceSlug}
          scope="global"
          heading="Similar sources"
          excludeOrgSlug={orgSlug}
        />
      </Suspense>
    </>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ orgSlug: string; sourceSlug: string }> }): Promise<Metadata> {
  const { orgSlug, sourceSlug } = await params;
  try {
    const source = await getSource(sourceSlug);
    const orgName = source.org?.name ?? orgSlug;
    return {
      title: `${source.name} — ${orgName}`,
      description: `Release notes and changelog for ${source.name} by ${orgName}`,
      openGraph: { type: "website" },
    };
  } catch {
    return { title: sourceSlug };
  }
}

const formatDate = formatSourceDate;

export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; sourceSlug: string }>;
  searchParams: Promise<{ page?: string; tab?: string; path?: string; offset?: string }>;
}) {
  const { orgSlug, sourceSlug } = await params;
  const { page: pageParam, tab, path: changelogPath, offset: offsetParam } = await searchParams;
  const page = parseInt(pageParam ?? "1", 10) || 1;
  // `offset` arrives from search chunk deep-links — see the independent
  // source page for the same parsing rationale.
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
  let heatmap;
  try {
    [source, activity, heatmap] = await Promise.all([
      getSource(sourceSlug, page),
      api.sourceActivity(sourceSlug, activityFrom).catch(() => null),
      api.sourceHeatmap(sourceSlug).catch(() => null),
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
    {
      items: [
        { label: "Latest", value: source.latestVersion ?? formatDate(source.latestDate) },
        sourceUrlSidebarItem(source),
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
    "url": `https://releases.sh/${orgSlug}/${sourceSlug}`,
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
          <Link href={`/${source.org.slug}`} className="hover:text-stone-600 dark:hover:text-stone-300">{source.org.name}</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{source.name}</span>
        </div>
        <div className="flex items-center gap-2.5 mt-4">
          <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">{source.name}</h1>
          <SourceTypeIcon type={source.type} size={18} />
        </div>
        <CliCommand identifier={source.slug} />
        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-12">
          <div className="flex-1 min-w-0">
            {activity && (
              <SourceTimeline activity={activity} heatmap={heatmap} trackingSince={source.trackingSince} />
            )}
            <SourceTabs
              hasHighlights={!!(source.summaries?.rolling || source.summaries?.monthly?.length)}
              hasChangelog={!!source.hasChangelogFile}
            />
            <SourceMainContent
              source={source}
              tab={tab}
              basePath={`/${orgSlug}/${sourceSlug}`}
              changelogPath={changelogPath}
              changelogOffset={changelogOffset}
            />
            {(!tab || tab === "releases") && (
              <RelatedRails
                anchorReleaseId={source.releases[0]?.id ?? null}
                sourceSlug={source.slug}
                orgSlug={source.org?.slug ?? null}
              />
            )}
          </div>
          <Sidebar sections={sidebarSections} formatPath={`/${orgSlug}/${sourceSlug}`} footnote={source.lastFetchedAt ? `Last fetched ${formatDate(source.lastFetchedAt)}` : null} footnoteTitle={source.lastFetchedAt} />
        </div>
      </div>
    </div>
  );
}
