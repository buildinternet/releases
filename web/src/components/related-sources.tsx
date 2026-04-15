import Link from "next/link";
import { api, type RelatedSourceItem } from "@/lib/api";
import { SourceTypeIcon } from "./source-type-icon";
import { formatDate } from "@/lib/formatters";

interface RelatedSourcesProps {
  /** Source slug or id to anchor the search on. */
  anchor: string;
  scope: "org" | "global";
  heading: string;
  limit?: number;
  /** Exclude sources in this org from the rendered list (de-dupes when stacked with an org rail). */
  excludeOrgSlug?: string | null;
}

/**
 * Server component. Renders nothing on empty/degraded — callers should
 * stack two rails (one `scope="org"`, one `scope="global"`) and rely on
 * the empty-hide behaviour to keep the page tidy when no neighbors exist.
 */
export async function RelatedSources({
  anchor,
  scope,
  heading,
  limit = 6,
  excludeOrgSlug = null,
}: RelatedSourcesProps) {
  let items: RelatedSourceItem[] = [];
  try {
    const res = await api.relatedSources(anchor, scope, limit + (excludeOrgSlug ? 4 : 0));
    if (res.degraded) {
      console.error(
        `[related-sources] degraded scope=${scope} anchor=${anchor} reason=${res.degradedReason ?? "unknown"}`,
      );
      return null;
    }
    items = res.items;
  } catch (err) {
    console.error(
      `[related-sources] fetch failed scope=${scope} anchor=${anchor}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  if (excludeOrgSlug) {
    items = items.filter((s) => s.orgSlug !== excludeOrgSlug);
  }
  items = items.slice(0, limit);
  if (items.length === 0) return null;

  return (
    <section className="mt-10 pt-6 border-t border-stone-200 dark:border-stone-800">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400 mb-3">
        {heading}
      </h2>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <RelatedSourceCard item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RelatedSourceCard({ item }: { item: RelatedSourceItem }) {
  const href = item.orgSlug ? `/${item.orgSlug}/${item.slug}` : `/source/${item.slug}`;
  return (
    <Link
      href={href}
      className="block bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-3 hover:border-stone-300 dark:hover:border-stone-600 transition-colors h-full"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-semibold text-[14px] text-stone-900 dark:text-stone-100 truncate">
            {item.name}
          </span>
        </div>
        <SourceTypeIcon type={item.type} size={14} />
      </div>
      <div className="text-[11px] text-stone-400 dark:text-stone-500 mt-1 truncate">
        {item.orgName && <span>{item.orgName}</span>}
        {item.orgName && (item.releaseCount > 0 || item.latestDate) && <span className="mx-1">·</span>}
        {item.releaseCount > 0 && <span>{item.releaseCount} releases</span>}
        {item.latestDate && (
          <>
            {item.releaseCount > 0 && <span className="mx-1">·</span>}
            <span>latest {formatDate(item.latestDate)}</span>
          </>
        )}
      </div>
    </Link>
  );
}
