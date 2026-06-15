import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { ApiSetupError } from "@/lib/api";
import { tryFetch } from "@/lib/ssr-fetch";
import { ViewTransition } from "react";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { Sidebar } from "@/components/sidebar";
import { SourceTabs } from "@/components/source-tabs";
import { SourceTypeIcon } from "@/components/source-type-icon";
import { AppIcon } from "@/components/app-icon";
import { PlatformBadge } from "@/components/platform-badge";
import { getAppInfo } from "@/lib/app-source";
import { StateBadge, getHiddenStateBadge } from "@/components/source-table";
import { SourceAdminMenu } from "@/components/source-admin-menu";
import { AdminOnly } from "@/components/admin-only";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { SourceTimeline } from "@/components/source-timeline";
import { CliCommand } from "@/components/cli-command";
import { api } from "@/lib/api";
import { formatSourceDate, sourceUrlSidebarItem } from "@/lib/source-display";
import { getSourceById } from "./_lib/source-by-id";

/**
 * Canonical for this route: member sources (productId set) are authoritative at
 * /sources/:id; orphan sources (no productId, has org) redirect in page.tsx but
 * the layout still emits a canonical for sub-pages (changelog, highlights).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const source = await getSourceById(id);
    const canonicalPath = source.productId
      ? `/sources/${id}`
      : source.org
        ? `/${source.org.slug}/${source.slug}`
        : `/sources/${id}`;
    return { alternates: { canonical: canonicalPath } };
  } catch {
    return {};
  }
}

const formatDate = formatSourceDate;

export default async function SourceByIdLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const activityFrom = daysAgoIso(365 * 2).slice(0, 10);

  let source;
  let activityResult;
  let heatmapResult;
  try {
    source = await getSourceById(id);
    const orgSlug = source.org?.slug ?? "";
    const sourceSlug = source.slug;
    [activityResult, heatmapResult] = await Promise.all([
      tryFetch(api.sourceActivity({ orgSlug, sourceSlug }, activityFrom), {
        route: `/sources/${id}`,
        event: "source-activity-fetch-failed",
      }),
      tryFetch(api.sourceHeatmap({ orgSlug, sourceSlug }), {
        route: `/sources/${id}`,
        event: "source-heatmap-fetch-failed",
      }),
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

  const activity = activityResult.data;
  const heatmap = heatmapResult.data;

  const orgSlug = source.org?.slug ?? "";
  const sourceSlug = source.slug;

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
  const devAdmin = isLocalAdminEnabled();
  const sourceMeta = (() => {
    try {
      return JSON.parse(source.metadata || "{}") as {
        marketingFilter?: boolean;
        marketingFilterHint?: string;
        feedContentDepth?: "full" | "summary-only";
      };
    } catch {
      return {};
    }
  })();
  const hasHighlights = !!(source.summaries?.rolling || source.summaries?.monthly?.length);
  const hasChangelog = !!source.hasChangelogFile;
  const appInfo = getAppInfo(source);

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          {source.org ? (
            <Link
              href={`/${source.org.slug}`}
              className="hover:text-stone-600 dark:hover:text-stone-300"
            >
              {source.org.name}
            </Link>
          ) : null}
          {source.org && <span className="mx-1.5">/</span>}
          <span className="text-stone-600 dark:text-stone-300 font-medium">{source.name}</span>
        </div>
        <div className="flex items-center gap-2.5 mt-4">
          {appInfo && <AppIcon iconUrl={appInfo.iconUrl} name={source.name} size={32} />}
          <ViewTransition name={`src-${orgSlug}-${sourceSlug}`} default="none">
            <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
              {source.name}
            </h1>
          </ViewTransition>
          <SourceTypeIcon type={source.type} size={18} />
          {appInfo && <PlatformBadge label={appInfo.label} />}
          {hiddenBadge && <StateBadge label={hiddenBadge.label} title={hiddenBadge.title} />}
          {source.org && (
            <AdminOnly devAdmin={devAdmin}>
              <SourceAdminMenu
                orgSlug={source.org.slug}
                sourceSlug={source.slug}
                name={source.name}
                marketingFilter={sourceMeta.marketingFilter === true}
                marketingFilterHint={sourceMeta.marketingFilterHint ?? null}
                feedContentDepth={sourceMeta.feedContentDepth ?? null}
                discovery={source.discovery}
                isHidden={source.isHidden ?? false}
              />
            </AdminOnly>
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
              base={`/sources/${id}`}
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
