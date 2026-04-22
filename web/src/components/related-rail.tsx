import Link from "next/link";
import { api, type RelatedReleaseItem, type RelatedSourceItem } from "@/lib/api";
import { SourceTypeIcon } from "./source-type-icon";
import { formatDate } from "@/lib/formatters";
import { clamp, stripMarkdown } from "@/lib/og-helpers";

interface RelatedRailProps {
  anchorReleaseId: string | null;
  anchorSourceSlug: string;
  scope: "org" | "global";
  heading: string;
  /** Drop items in this org from the rendered list. Used on the global rail to
   * avoid overlap with the org-scoped rail stacked above it. */
  excludeOrgSlug?: string | null;
  limit?: number;
}

type RailItem =
  | { kind: "release"; item: RelatedReleaseItem }
  | { kind: "source"; item: RelatedSourceItem };

/** Half-life (in days) of the recency boost applied to raw semantic score. */
const RECENCY_HALF_LIFE_DAYS = 75;
/** Score multiplier for items with no usable date — keeps them eligible but demoted. */
const UNDATED_PENALTY = 0.25;

/**
 * Merged "related" rail. Fetches releases and sources in parallel and
 * reranks each by semantic score blended with a recency boost, then
 * interleaves them into a single row. Used in two flavors:
 *   - `scope="org"` — "More from {org}" (same-org neighbors)
 *   - `scope="global"` — "From other products" (semantic neighbors elsewhere)
 *
 * Renders null when both fetches degrade or return empty, so callers can
 * stack both rails and let the empty one collapse.
 */
export async function RelatedRail({
  anchorReleaseId,
  anchorSourceSlug,
  scope,
  heading,
  excludeOrgSlug = null,
  limit = 2,
}: RelatedRailProps) {
  // Enough headroom for the recency rerank to have real choice without
  // hydrating 20 neighbors we'll throw away. Matches the backend's
  // Math.max(limit * 3, 25) floor when limit defaults to ~8.
  const fetchLimit = Math.max(limit * 3, 10);

  const [releasesRes, sourcesRes] = await Promise.all([
    anchorReleaseId
      ? api.relatedReleases(anchorReleaseId, scope, fetchLimit).catch((err) => {
          console.error(
            `[related-rail] releases fetch failed scope=${scope} anchor=${anchorReleaseId}:`,
            err instanceof Error ? err.message : err,
          );
          return null;
        })
      : Promise.resolve(null),
    api.relatedSources(anchorSourceSlug, scope, fetchLimit).catch((err) => {
      console.error(
        `[related-rail] sources fetch failed scope=${scope} anchor=${anchorSourceSlug}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }),
  ]);

  let releases = releasesRes && !releasesRes.degraded ? releasesRes.items : [];
  let sources = sourcesRes && !sourcesRes.degraded ? sourcesRes.items : [];
  if (excludeOrgSlug) {
    releases = releases.filter((r) => r.source.orgSlug !== excludeOrgSlug);
    sources = sources.filter((s) => s.orgSlug !== excludeOrgSlug);
  }

  const items = rerankAndInterleave(releases, sources, limit);
  if (items.length === 0) return null;

  return (
    <section className="mt-10 pt-6 border-t border-stone-200 dark:border-stone-800">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400 mb-3">
        {heading}
      </h2>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {items.map((entry) =>
          entry.kind === "release" ? (
            <li key={`r-${entry.item.id}`}>
              <ReleaseCard item={entry.item} scope={scope} />
            </li>
          ) : (
            <li key={`s-${entry.item.id}`}>
              <SourceCard item={entry.item} scope={scope} />
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

/**
 * Blend semantic score with an exponential recency decay. The half-life is
 * set so that a 75-day-old item is worth half a brand-new one at the same
 * cosine score — enough to move 6-month-old matches behind fresh ones
 * without flattening score entirely. Items without a usable date still
 * compete, but at a fixed penalty so they can't dominate the rail.
 */
function recencyRank(score: number, date: string | null): number {
  if (!date) return score * UNDATED_PENALTY;
  const ms = Date.parse(date);
  if (!Number.isFinite(ms)) return score * UNDATED_PENALTY;
  const ageDays = Math.max(0, (Date.now() - ms) / 86_400_000);
  return score * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Rerank each list by recency-weighted score, then zip them so the rail
 * reads "release, source, release, source". We intentionally don't merge
 * into a single global ranking — mixing card types gives the rail visual
 * variety even when one kind dominates the raw similarity scores.
 */
function rerankAndInterleave(
  releases: RelatedReleaseItem[],
  sources: RelatedSourceItem[],
  limit: number,
): RailItem[] {
  const rankedReleases = releases
    .map((item) => ({ item, rank: recencyRank(item.score, item.publishedAt) }))
    .toSorted((a, b) => b.rank - a.rank);
  const rankedSources = sources
    .map((item) => ({ item, rank: recencyRank(item.score, item.latestDate) }))
    .toSorted((a, b) => b.rank - a.rank);

  const out: RailItem[] = [];
  const max = Math.max(rankedReleases.length, rankedSources.length);
  for (let i = 0; i < max && out.length < limit; i++) {
    if (i < rankedReleases.length && out.length < limit) {
      out.push({ kind: "release", item: rankedReleases[i]!.item });
    }
    if (i < rankedSources.length && out.length < limit) {
      out.push({ kind: "source", item: rankedSources[i]!.item });
    }
  }
  return out;
}

/**
 * Decide which subtitle line to show below the card heading:
 *   - scope="org": nothing — the rail heading already names the org.
 *   - scope="global": show the org name when it adds context (i.e. differs
 *     from the source/product name). Drop the leading "via" — saying
 *     "via Anthropic" under a card called "Claude Code" adds no information.
 */
function subtitleForSource(
  orgName: string | null,
  sourceName: string,
  scope: "org" | "global",
): string | null {
  if (scope === "org") return null;
  if (!orgName) return null;
  if (orgName === sourceName) return null;
  return orgName;
}

function ReleaseCard({ item, scope }: { item: RelatedReleaseItem; scope: "org" | "global" }) {
  const href = `/release/${item.id}`;
  const heading = item.version ?? item.title;
  const showSubtitle = !!item.version && item.title && item.title !== item.version;
  const source = subtitleForSource(item.source.orgName, item.source.name, scope);
  const preview = releasePreview(item, showSubtitle ? item.title : null);
  return (
    <Link
      href={href}
      className="flex gap-3 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-3 hover:border-stone-300 dark:hover:border-stone-600 transition-colors h-full"
    >
      <div className="flex-1 min-w-0">
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
        {preview && (
          <p className="text-[12px] text-stone-500 dark:text-stone-400 mt-1 line-clamp-2">
            {preview}
          </p>
        )}
        <div className="text-[11px] text-stone-400 dark:text-stone-500 mt-1 truncate">
          {source ? `${source} · ${item.source.name}` : item.source.name}
        </div>
      </div>
      {item.thumbnail && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={item.thumbnail.url}
          alt={item.thumbnail.alt ?? ""}
          className="shrink-0 w-14 h-14 rounded-md object-cover bg-stone-100 dark:bg-stone-800"
          loading="lazy"
        />
      )}
    </Link>
  );
}

/**
 * Strip markdown from the release summary and drop the leading copy if it's
 * just the title repeated (common for tagged GitHub releases where the title
 * is the first line of the body). Returns null when there's no usable copy
 * — callers skip the preview block entirely in that case.
 */
function releasePreview(
  item: RelatedReleaseItem,
  titleShownAsSubtitle: string | null,
): string | null {
  const stripped = stripMarkdown(item.summary);
  if (!stripped) return null;
  const deduped =
    titleShownAsSubtitle && stripped.startsWith(titleShownAsSubtitle)
      ? stripped.slice(titleShownAsSubtitle.length).trimStart()
      : stripped;
  if (!deduped) return null;
  return clamp(deduped, 140);
}

function SourceCard({ item, scope }: { item: RelatedSourceItem; scope: "org" | "global" }) {
  const href = item.orgSlug ? `/${item.orgSlug}/${item.slug}` : `/source/${item.slug}`;
  const org = subtitleForSource(item.orgName, item.name, scope);
  const latest = item.latestVersion ?? item.latestTitle;
  // `recentCount` includes the latest release, so subtract 1 for the "others"
  // phrasing. A count of 0 or 1 means the latest stands alone.
  const othersThisMonth = Math.max(0, item.recentCount - 1);
  return (
    <Link
      href={href}
      className="flex gap-3 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-3 hover:border-stone-300 dark:hover:border-stone-600 transition-colors h-full"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-semibold text-[14px] text-stone-900 dark:text-stone-100 truncate">
              {item.name}
            </span>
            {org && (
              <span className="text-[11px] text-stone-400 dark:text-stone-500 shrink-0">{org}</span>
            )}
          </div>
          <SourceTypeIcon type={item.type} size={14} />
        </div>
        {latest && (
          <div className="flex items-baseline justify-between gap-2 mt-1">
            <span className="text-[12px] text-stone-600 dark:text-stone-400 truncate">
              {latest}
            </span>
            {item.latestDate && (
              <span className="text-[11px] text-stone-400 dark:text-stone-500 shrink-0 tabular-nums">
                {formatDate(item.latestDate)}
              </span>
            )}
          </div>
        )}
        {othersThisMonth > 0 && (
          <div className="text-[11px] text-stone-400 dark:text-stone-500 mt-0.5 truncate">
            and {othersThisMonth} {othersThisMonth === 1 ? "other" : "others"} this month
          </div>
        )}
      </div>
      {item.orgAvatarUrl && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={item.orgAvatarUrl}
          alt=""
          className="shrink-0 w-14 h-14 rounded-md object-cover bg-stone-100 dark:bg-stone-800"
          loading="lazy"
        />
      )}
    </Link>
  );
}
