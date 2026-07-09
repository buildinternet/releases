import Link from "next/link";
import { api, type ReleaseCoverageResponse, type ReleaseCoverageSibling } from "@/lib/api";
import { formatDate } from "@/lib/formatters";
import { ReleaseThumb } from "./release-thumb";

interface AlsoCoveredByProps {
  anchorReleaseId: string;
}

/**
 * Server component. Renders the release_coverage grouping relationship
 * for the anchor release. Mirrors related-rail.tsx — self-hides on
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

  // Sibling display fields ride along on the coverage response (one query),
  // so there's no per-sibling round-trip here. v1 product scope: when we're on
  // a coverage row, show just the canonical — the user clicks through to see
  // the rest of the cluster.
  const siblings: (ReleaseCoverageSibling | null | undefined)[] =
    coverage.role === "canonical"
      ? coverage.covers.map((c) => c.sibling)
      : coverage.role === "coverage"
        ? [coverage.canonical.sibling]
        : [];

  const items = siblings.filter((s): s is ReleaseCoverageSibling => s != null);
  if (items.length === 0) return null;

  // On the canonical page, the siblings are coverage-side rows. Those are
  // intentionally hidden by the `releases_visible` view, so GET /releases/:id
  // 404s for them — linking would land on a dead page. Render them as plain
  // text instead. When we're on a coverage row, the single item IS the
  // canonical (a visible row), so it stays a link.
  const linkToItem = coverage.role === "coverage";

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
            <CoverageItem item={item} asLink={linkToItem} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CoverageItem({ item, asLink }: { item: ReleaseCoverageSibling; asLink: boolean }) {
  const heading = item.version ?? item.title;
  const byline = item.org?.name ? `${item.org.name} · ${item.sourceName}` : item.sourceName;

  const inner = (
    <>
      {item.thumbnail && (
        <ReleaseThumb src={item.thumbnail.url} alt={item.thumbnail.alt ?? ""} size="sm" />
      )}
      <div className="min-w-0 flex-1 truncate">
        <span className="text-[14px] text-stone-900 dark:text-stone-100">{heading}</span>
        <span className="ml-2 text-[12px] text-stone-500 dark:text-stone-400">{byline}</span>
      </div>
      {item.publishedAt && (
        <span className="text-[11px] text-stone-400 dark:text-stone-500 shrink-0 tabular-nums">
          {formatDate(item.publishedAt)}
        </span>
      )}
    </>
  );

  // Coverage-side rows have no reachable detail page (suppressed by
  // `releases_visible`), so they render as a non-interactive row.
  if (!asLink) {
    return <div className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2">{inner}</div>;
  }

  return (
    <Link
      href={`/release/${item.id}`}
      className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-stone-100 dark:hover:bg-stone-900 transition-colors"
    >
      {inner}
    </Link>
  );
}
