import Link from "next/link";
import { api, type RelatedReleaseItem } from "@/lib/api";
import { formatDate } from "@/lib/formatters";

interface RelatedReleasesProps {
  /** Release ID to anchor the search on (usually the latest release for the source). */
  anchorReleaseId: string;
  scope: "org" | "global";
  heading: string;
  limit?: number;
}

/**
 * Server component. Renders nothing when the backend degrades, errors, or
 * returns an empty list — the rail is only worth showing when it has real
 * neighbors. Callers should stack multiple instances (e.g. one org-scoped +
 * one global) and let the empty path hide the ones that don't apply.
 */
export async function RelatedReleases({
  anchorReleaseId,
  scope,
  heading,
  limit = 8,
}: RelatedReleasesProps) {
  let items: RelatedReleaseItem[] = [];
  try {
    const res = await api.relatedReleases(anchorReleaseId, scope, limit);
    if (res.degraded) {
      // Not an error — just no neighbors yet. Log once at info level so
      // we can spot unexpectedly-common degradations in the web logs.
      console.error(
        `[related-releases] degraded scope=${scope} anchor=${anchorReleaseId} reason=${res.degradedReason ?? "unknown"}`,
      );
      return null;
    }
    items = res.items;
  } catch (err) {
    // Swallow to hide the rail — but log to stderr so prod issues are
    // debuggable from the Next.js server logs.
    console.error(
      `[related-releases] fetch failed scope=${scope} anchor=${anchorReleaseId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  if (items.length === 0) return null;

  return (
    <section className="mt-10 pt-6 border-t border-stone-200 dark:border-stone-800">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400 mb-3">
        {heading}
      </h2>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <RelatedReleaseCard item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RelatedReleaseCard({ item }: { item: RelatedReleaseItem }) {
  const href = `/release/${item.id}`;
  const heading = item.version ?? item.title;
  const showSubtitle = !!item.version && item.title && item.title !== item.version;

  return (
    <Link
      href={href}
      className="block bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-3 hover:border-stone-300 dark:hover:border-stone-600 transition-colors h-full"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-[14px] text-stone-900 dark:text-stone-100 truncate">
          {heading}
        </span>
        {item.publishedAt && (
          <span className="text-[11px] text-stone-400 dark:text-stone-500 shrink-0 tabular-nums">
            {formatDate(item.publishedAt)}
          </span>
        )}
      </div>
      {showSubtitle && (
        <div className="text-[12px] text-stone-600 dark:text-stone-400 truncate mt-0.5">
          {item.title}
        </div>
      )}
      {/*
        The source name is shown as plain text (not a nested link) because
        the outer card is already an <a> and HTML disallows nested anchors.
        Users can navigate to the source from the release detail page.
      */}
      <div className="text-[11px] text-stone-400 dark:text-stone-500 mt-1 truncate">
        via{" "}
        <span className="text-stone-500 dark:text-stone-400">
          {item.source.orgName ? `${item.source.orgName} · ${item.source.name}` : item.source.name}
        </span>
      </div>
    </Link>
  );
}
