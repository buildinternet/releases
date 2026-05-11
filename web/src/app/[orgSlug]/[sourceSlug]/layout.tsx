import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { ApiSetupError } from "@/lib/api";
import { ViewTransition } from "react";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { Sidebar } from "@/components/sidebar";
import { SourceTabs } from "@/components/source-tabs";
import { SourceTypeIcon } from "@/components/source-type-icon";
import { StateBadge, getHiddenStateBadge } from "@/components/source-table";
import { PromoteSourceButton } from "@/components/promote-source-button";
import { isPromoteSourceEnabled } from "@/lib/promote-source-flag";
import { SourceTimeline } from "@/components/source-timeline";
import { CliCommand } from "@/components/cli-command";
import { api } from "@/lib/api";
import { formatSourceDate, sourceUrlSidebarItem } from "@/lib/source-display";
import { getSource } from "./_lib/source-data";

const formatDate = formatSourceDate;

export default async function SourceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string; sourceSlug: string }>;
}) {
  const { orgSlug, sourceSlug } = await params;

  const activityFrom = daysAgoIso(365 * 2).slice(0, 10);

  let source;
  let activity;
  let heatmap;
  try {
    [source, activity, heatmap] = await Promise.all([
      getSource(orgSlug, sourceSlug),
      api.sourceActivity({ orgSlug, sourceSlug }, activityFrom).catch(() => null),
      api.sourceHeatmap({ orgSlug, sourceSlug }).catch(() => null),
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
        ...(source.changelogUrl
          ? [{ label: "Changelog", value: "View changelog", externalLink: source.changelogUrl }]
          : []),
      ],
    },
  ];

  const hiddenBadge = getHiddenStateBadge(source);
  const showPromoteButton =
    source.discovery === "on_demand" && source.isHidden && isPromoteSourceEnabled();
  const hasHighlights = !!(source.summaries?.rolling || source.summaries?.monthly?.length);
  const hasChangelog = !!source.hasChangelogFile;

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link
            href={`/${source.org.slug}`}
            className="hover:text-stone-600 dark:hover:text-stone-300"
          >
            {source.org.name}
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{source.name}</span>
        </div>
        <div className="flex items-center gap-2.5 mt-4">
          <ViewTransition name={`src-${source.org.slug}-${source.slug}`} default="none">
            <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
              {source.name}
            </h1>
          </ViewTransition>
          <SourceTypeIcon type={source.type} size={18} />
          {hiddenBadge && <StateBadge label={hiddenBadge.label} title={hiddenBadge.title} />}
          {showPromoteButton && (
            <PromoteSourceButton orgSlug={source.org.slug} sourceSlug={source.slug} />
          )}
        </div>
        <CliCommand identifier={source.slug} />
        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-12">
          <div className="flex-1 min-w-0">
            {activity && (
              <SourceTimeline
                activity={activity}
                heatmap={heatmap}
                trackingSince={source.trackingSince}
              />
            )}
            <SourceTabs
              orgSlug={orgSlug}
              sourceSlug={sourceSlug}
              hasHighlights={hasHighlights}
              hasChangelog={hasChangelog}
            />
            {children}
          </div>
          <Sidebar
            sections={sidebarSections}
            formatPath={`/${orgSlug}/${sourceSlug}`}
            lastCheckedAt={source.lastPolledAt ?? source.lastFetchedAt}
            lastFetchedAt={source.lastFetchedAt}
            trackingSince={source.trackingSince}
          />
        </div>
      </div>
    </div>
  );
}
