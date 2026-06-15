import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { ApiSetupError, ApiNotFoundError } from "@/lib/api";
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
import { EntityNotice } from "@/components/entity-notice";
import { api } from "@/lib/api";
import { formatSourceDate, sourceUrlSidebarItem } from "@/lib/source-display";
import { getResolved } from "./_lib/resolve";

const formatDate = formatSourceDate;

export default async function OrgSlugLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string; slug: string }>;
}) {
  const { orgSlug, slug } = await params;

  let resolved;
  try {
    resolved = await getResolved(orgSlug, slug);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  // Products carry their own chrome (ProductView). The layout only wraps the
  // source render with the tab-chrome shell; the resolver is already org-scoped,
  // so the old `source.org.slug !== orgSlug` slug-correction redirect is moot.
  if (resolved.kind === "product") {
    return <>{children}</>;
  }

  const source = resolved.source;
  const sourceSlug = source.slug;
  const base = `/${orgSlug}/${sourceSlug}`;
  const activityFrom = daysAgoIso(365 * 2).slice(0, 10);

  const [activityResult, heatmapResult] = await Promise.all([
    tryFetch(api.sourceActivity({ orgSlug, sourceSlug }, activityFrom), {
      route: base,
      event: "source-activity-fetch-failed",
    }),
    tryFetch(api.sourceHeatmap({ orgSlug, sourceSlug }), {
      route: base,
      event: "source-heatmap-fetch-failed",
    }),
  ]);

  const activity = activityResult.data;
  const heatmap = heatmapResult.data;

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
  const orgName = source.org?.name ?? orgSlug;
  const orgHref = source.org ? `/${source.org.slug}` : `/${orgSlug}`;

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link href={orgHref} className="hover:text-stone-600 dark:hover:text-stone-300">
            {orgName}
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{source.name}</span>
        </div>
        <div className="flex items-center gap-2.5 mt-4">
          {appInfo && <AppIcon iconUrl={appInfo.iconUrl} name={source.name} size={32} />}
          <ViewTransition name={`src-${source.org?.slug ?? orgSlug}-${source.slug}`} default="none">
            <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
              {source.name}
            </h1>
          </ViewTransition>
          <SourceTypeIcon type={source.type} size={18} />
          {appInfo && <PlatformBadge label={appInfo.label} />}
          {hiddenBadge && <StateBadge label={hiddenBadge.label} title={hiddenBadge.title} />}
          <AdminOnly devAdmin={devAdmin}>
            <SourceAdminMenu
              orgSlug={source.org?.slug ?? orgSlug}
              sourceSlug={source.slug}
              name={source.name}
              marketingFilter={sourceMeta.marketingFilter === true}
              marketingFilterHint={sourceMeta.marketingFilterHint ?? null}
              feedContentDepth={sourceMeta.feedContentDepth ?? null}
              discovery={source.discovery}
              isHidden={source.isHidden ?? false}
              notice={source.notice}
            />
          </AdminOnly>
        </div>
        <CliCommand identifier={source.slug} />
        <EntityNotice notice={source.notice} />
        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-12">
          <div className="flex-1 min-w-0">
            {activity && (
              <SourceTimeline
                activity={activity}
                heatmap={heatmap}
                trackingSince={source.trackingSince}
              />
            )}
            <SourceTabs base={base} hasHighlights={hasHighlights} hasChangelog={hasChangelog} />
            {children}
          </div>
          <Sidebar
            sections={sidebarSections}
            formatPath={base}
            lastCheckedAt={source.lastPolledAt ?? source.lastFetchedAt}
            lastFetchedAt={source.lastFetchedAt}
            trackingSince={source.trackingSince}
          />
        </div>
      </div>
    </div>
  );
}
