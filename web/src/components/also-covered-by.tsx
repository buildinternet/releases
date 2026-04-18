import Link from "next/link";
import { api, type ReleaseCoverageResponse, type ReleaseDetail } from "@/lib/api";
import { formatDate } from "@/lib/formatters";

interface AlsoCoveredByProps {
  anchorReleaseId: string;
}

/**
 * Server component. Renders the release_coverage grouping relationship
 * for the anchor release. Mirrors related-releases.tsx — self-hides on
 * standalone, empty, or error. Follow that pattern so behavior stays
 * consistent across the detail-page rails.
 */
export async function AlsoCoveredBy({ anchorReleaseId }: AlsoCoveredByProps) {
  let coverage: ReleaseCoverageResponse;
  try {
    coverage = await api.coverage(anchorReleaseId);
  } catch (err) {
    console.error(
      `[also-covered-by] fetch failed anchor=${anchorReleaseId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  // v1: when we're on a coverage row, show just the canonical. Fetching
  // the canonical's full sibling list would cost another round-trip per
  // render — the user can click through to see the rest of the cluster.
  const siblingIds =
    coverage.role === "canonical"
      ? coverage.covers.map((c) => c.coverageId)
      : coverage.role === "coverage"
        ? [coverage.canonical.canonicalId]
        : [];

  if (siblingIds.length === 0) return null;

  const siblings = await Promise.all(
    siblingIds.map(async (id) => {
      try {
        return await api.release(id);
      } catch (err) {
        console.error(
          `[also-covered-by] sibling fetch failed id=${id}:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    }),
  );
  const items = siblings.filter((r): r is ReleaseDetail => r !== null);
  if (items.length === 0) return null;

  const heading =
    coverage.role === "canonical"
      ? items.length === 1
        ? "1 other post covers this launch"
        : `${items.length} other posts cover this launch`
      : "Covered elsewhere";

  return (
    <section className="mt-10 pt-6 border-t border-stone-200 dark:border-stone-800">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400 mb-3">
        {heading}
      </h2>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id}>
            <CoverageItem item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CoverageItem({ item }: { item: ReleaseDetail }) {
  const heading = item.version ?? item.title;
  const byline = item.org?.name
    ? `${item.org.name} · ${item.sourceName}`
    : item.sourceName;

  return (
    <Link
      href={`/release/${item.id}`}
      className="flex items-baseline justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-stone-100 dark:hover:bg-stone-900 transition-colors"
    >
      <div className="min-w-0 flex-1 truncate">
        <span className="text-[14px] text-stone-900 dark:text-stone-100">
          {heading}
        </span>
        <span className="ml-2 text-[12px] text-stone-500 dark:text-stone-400">
          {byline}
        </span>
      </div>
      {item.publishedAt && (
        <span className="text-[11px] text-stone-400 dark:text-stone-500 shrink-0 tabular-nums">
          {formatDate(item.publishedAt)}
        </span>
      )}
    </Link>
  );
}
