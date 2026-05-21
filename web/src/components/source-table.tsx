import Link from "next/link";
import type { SourceListItem, OrgDetail } from "@/lib/api";
import { formatRelativeDate } from "@/lib/formatters";
import { Sparkline } from "@/components/sparkline";
import { partitionSdkSources, sdkPreview } from "@/lib/sdk-grouping";
import { SdkSourceGroup } from "@/components/sdk-source-group";

const TYPE_LABELS: Record<string, string> = {
  github: "GitHub",
  feed: "Feed",
  scrape: "Website",
  agent: "Agent",
};

const TYPE_COLORS: Record<string, string> = {
  github: "bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400",
  feed: "bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400",
  scrape: "bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400",
  agent: "bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400",
};

const HEADER_CELL_CLASS =
  "px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 whitespace-nowrap";

function TypeBadge({ type }: { type: string }) {
  return (
    <span
      className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${TYPE_COLORS[type] ?? TYPE_COLORS.github}`}
    >
      {TYPE_LABELS[type] ?? type}
    </span>
  );
}

export function StateBadge({ label, title }: { label: string; title: string }) {
  return (
    <span
      title={title}
      className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wider bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 border border-stone-200 dark:border-stone-700"
    >
      {label}
    </span>
  );
}

export const HIDDEN_BADGE = {
  label: "Hidden",
  title:
    "Hidden by an admin. Excluded from listings, sitemap, and AI features. Still fetched and queryable by direct lookup.",
} as const;

export const ON_DEMAND_BADGE = {
  label: "On-demand",
  title:
    "Materialized by a direct lookup. Awaiting curation — un-hide to surface in listings, sitemap, and AI features.",
} as const;

/**
 * Pick the badge for a source's hidden state. On-demand rows (`discovery ===
 * "on_demand"`) are awaiting curation — they're hidden but reversible — so
 * they get a distinct label from admin-hidden rows. `discovery` may be
 * undefined on older API responses; treat that as `"curated"`.
 */
export function getHiddenStateBadge(
  source: Pick<SourceListItem, "isHidden" | "discovery">,
): { label: string; title: string } | null {
  if (!source.isHidden) return null;
  if (source.discovery === "on_demand") return ON_DEMAND_BADGE;
  return HIDDEN_BADGE;
}

function getSourceState(source: SourceListItem): { label: string; title: string } | null {
  const hidden = getHiddenStateBadge(source);
  if (hidden) return hidden;
  if (source.fetchPriority === "paused") {
    return { label: "Paused", title: "Fetching is paused for this source" };
  }
  return null;
}

function isInactive(source: SourceListItem): boolean {
  return Boolean(source.isHidden) || source.fetchPriority === "paused" || source.releaseCount === 0;
}

function sortByImportance(a: SourceListItem, b: SourceListItem): number {
  if (a.isPrimary && !b.isPrimary) return -1;
  if (!a.isPrimary && b.isPrimary) return 1;
  return b.releaseCount - a.releaseCount;
}

export function SourceTable({
  sources,
  products,
  orgSlug,
  sourceSparklines,
}: {
  sources: SourceListItem[];
  products: OrgDetail["products"];
  orgSlug: string;
  sourceSparklines?: Record<string, number[]>;
}) {
  const { flat, sdk } = partitionSdkSources(sources, products);

  const active: SourceListItem[] = [];
  const inactive: SourceListItem[] = [];
  for (const s of flat) {
    (isInactive(s) ? inactive : active).push(s);
  }
  active.sort(sortByImportance);
  inactive.sort(sortByImportance);

  const sdkActive: SourceListItem[] = [];
  const sdkInactive: SourceListItem[] = [];
  for (const s of sdk) {
    (isInactive(s) ? sdkInactive : sdkActive).push(s);
  }
  sdkActive.sort(sortByImportance);
  sdkInactive.sort(sortByImportance);

  const productMap = new Map(products.map((p) => [p.slug, p.name]));
  const hasProducts = products.length > 0;
  const hasOnDemand = sources.some((s) => s.discovery === "on_demand");
  const columnCount = 4 + (hasProducts ? 1 : 0) + (sourceSparklines ? 1 : 0);

  const renderRow = (source: SourceListItem, muted: boolean, indent = false) => {
    const state = getSourceState(source);
    return (
      <tr
        key={source.slug}
        className={`hover:bg-stone-50 dark:hover:bg-stone-900/50 transition-colors ${muted ? "opacity-55 hover:opacity-90" : ""}`}
      >
        <td className={`${indent ? "pl-7 pr-3" : "px-3"} py-3 max-w-0`}>
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href={`/${orgSlug}/${source.slug}`}
              className="text-stone-800 dark:text-stone-200 font-medium hover:text-stone-900 dark:hover:text-stone-100 truncate min-w-0"
            >
              {source.name}
            </Link>
            {state && <StateBadge label={state.label} title={state.title} />}
          </div>
          {source.url && (
            <div
              className="text-[12px] text-stone-400 dark:text-stone-500 truncate"
              title={source.url}
            >
              {source.url.replace(/^https?:\/\//, "")}
            </div>
          )}
        </td>
        <td className="px-3 py-3 whitespace-nowrap">
          <TypeBadge type={source.type} />
        </td>
        {hasProducts && (
          <td className="px-3 py-3 text-stone-500 dark:text-stone-400 text-[13px] hidden sm:table-cell whitespace-nowrap">
            {source.productSlug ? (productMap.get(source.productSlug) ?? "—") : "—"}
          </td>
        )}
        <td className="px-3 py-3 text-right font-mono tabular-nums text-stone-700 dark:text-stone-300 whitespace-nowrap">
          {source.releaseCount}
        </td>
        {sourceSparklines && (
          <td
            className={`px-3 py-3 hidden lg:table-cell ${source.releaseCount > 0 ? "text-stone-500 dark:text-stone-400" : "text-stone-300 dark:text-stone-700"}`}
          >
            <Sparkline
              data={sourceSparklines[source.slug] ?? []}
              width={64}
              height={20}
              id={source.slug}
            />
          </td>
        )}
        <td
          className="px-3 py-3 text-right text-stone-500 dark:text-stone-400 text-[13px] hidden sm:table-cell whitespace-nowrap overflow-hidden text-ellipsis"
          title={source.latestAddedAt ?? undefined}
        >
          {formatRelativeDate(source.latestAddedAt ?? null)}
        </td>
      </tr>
    );
  };

  return (
    <div className="mt-5">
      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-x-auto">
        <table className="w-full text-sm table-fixed border-collapse min-w-[520px]">
          <thead>
            <tr className="bg-stone-50 dark:bg-stone-900 border-b border-stone-200 dark:border-stone-800">
              <th className={`text-left ${HEADER_CELL_CLASS}`}>Source</th>
              <th className={`text-left w-[84px] ${HEADER_CELL_CLASS}`}>Type</th>
              {hasProducts && (
                <th className={`text-left hidden sm:table-cell w-[120px] ${HEADER_CELL_CLASS}`}>
                  Product
                </th>
              )}
              <th className={`text-right w-[72px] ${HEADER_CELL_CLASS}`}>Releases</th>
              {sourceSparklines && (
                <th className="px-3 py-2.5 hidden lg:table-cell w-[72px]">
                  <span className="sr-only">Activity</span>
                </th>
              )}
              <th className={`text-right hidden sm:table-cell w-[96px] ${HEADER_CELL_CLASS}`}>
                Last update
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 dark:divide-stone-800/50">
            {active.map((s) => renderRow(s, false))}
            {sdk.length > 0 && (
              <SdkSourceGroup colSpan={columnCount} count={sdk.length} preview={sdkPreview(sdk)}>
                {sdkActive.map((s) => renderRow(s, false, true))}
                {sdkInactive.map((s) => renderRow(s, true, true))}
              </SdkSourceGroup>
            )}
            {inactive.map((s) => renderRow(s, true))}
          </tbody>
        </table>
      </div>
      {hasOnDemand && (
        <p className="mt-2 text-[12px] text-stone-500 dark:text-stone-400">
          Includes community-sourced results, which may have less detail than curated ones.
        </p>
      )}
    </div>
  );
}
