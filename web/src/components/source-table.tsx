import Link from "next/link";
import type { SourceListItem, OrgDetail } from "@/lib/api";
import { formatRelativeDate } from "@/lib/formatters";
import { Sparkline } from "@/components/sparkline";

const typeBadgeClass = "text-[11px] px-1.5 py-0.5 rounded font-medium";

const typeLabels: Record<string, string> = {
  github: "GitHub",
  feed: "Feed",
  scrape: "Webpage",
  agent: "Agent",
};

function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    github: "bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400",
    feed: "bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400",
    scrape: "bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400",
    agent: "bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400",
  };
  return (
    <span className={`${typeBadgeClass} ${colors[type] ?? colors.github}`}>
      {typeLabels[type] ?? type}
    </span>
  );
}

function StateBadge({ label, title }: { label: string; title?: string }) {
  return (
    <span
      title={title}
      className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wider bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 border border-stone-200 dark:border-stone-700"
    >
      {label}
    </span>
  );
}

function getSourceState(
  source: SourceListItem,
): { label: string; title: string } | null {
  if (source.isHidden) {
    return { label: "Ignored", title: "This source is hidden from public listings" };
  }
  if (source.fetchPriority === "paused") {
    return { label: "Paused", title: "Fetching is paused for this source" };
  }
  return null;
}

function isInactive(source: SourceListItem): boolean {
  return (
    source.isHidden === true ||
    source.fetchPriority === "paused" ||
    source.releaseCount === 0
  );
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
  const active: SourceListItem[] = [];
  const inactive: SourceListItem[] = [];
  for (const s of sources) {
    (isInactive(s) ? inactive : active).push(s);
  }

  const sortByImportance = (a: SourceListItem, b: SourceListItem) => {
    if (a.isPrimary && !b.isPrimary) return -1;
    if (!a.isPrimary && b.isPrimary) return 1;
    return b.releaseCount - a.releaseCount;
  };
  active.sort(sortByImportance);
  inactive.sort(sortByImportance);

  const productMap = new Map(products.map((p) => [p.slug, p.name]));
  const hasProducts = products.length > 0;

  const renderRow = (source: SourceListItem, muted: boolean) => {
    const state = getSourceState(source);
    return (
      <tr
        key={source.slug}
        className={`hover:bg-stone-50 dark:hover:bg-stone-900/50 transition-colors ${muted ? "opacity-55 hover:opacity-90" : ""}`}
      >
        <td className="px-3 py-3 max-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href={`/${orgSlug}/${source.slug}`}
              className="text-stone-800 dark:text-stone-200 font-medium hover:text-stone-900 dark:hover:text-stone-100 truncate min-w-0"
            >
              {source.name}
            </Link>
            {state && <span className="shrink-0"><StateBadge label={state.label} title={state.title} /></span>}
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
            {source.productSlug ? productMap.get(source.productSlug) ?? "—" : "—"}
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
              <th className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 whitespace-nowrap">Source</th>
              <th className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 whitespace-nowrap w-[84px]">Type</th>
              {hasProducts && (
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 whitespace-nowrap hidden sm:table-cell w-[120px]">Product</th>
              )}
              <th className="text-right px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 whitespace-nowrap w-[72px]">Releases</th>
              {sourceSparklines && (
                <th className="px-3 py-2.5 hidden lg:table-cell w-[72px]"><span className="sr-only">Activity</span></th>
              )}
              <th className="text-right px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 whitespace-nowrap hidden sm:table-cell w-[96px]">Last update</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 dark:divide-stone-800/50">
            {active.map((s) => renderRow(s, false))}
            {inactive.map((s) => renderRow(s, true))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
