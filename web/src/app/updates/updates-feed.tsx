"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { OrgReleaseItemView } from "@/lib/release-view";
import { buildFeedEntries, type FeedEntry } from "@/components/org-release-entries";
import { deriveFeedTitle } from "@/lib/release-title";
import { formatDate } from "@/lib/formatters";
import { FallbackImage } from "@/components/fallback-image";
import { releaseThumbUrl, IMG_TRANSFORM_ON } from "@/lib/media";
import { GlyphCounts, CompositionLegend } from "./composition-glyphs";
import {
  buildMonthBuckets,
  buildAreaBuckets,
  monthKeyOf,
  entryPublishedAt,
  entryComposition,
  entryAreaGroup,
  entryVersionLabel,
  isFixOnlyComposition,
  type AreaGroup,
} from "./updates-logic";

// Safety cap on eager cursor-following (see the loading effect below) — the
// org is small today (~100 releases across 2 sources), but this keeps a
// pathological future org from turning /updates into an unbounded fetch loop.
const MAX_EAGER_PAGES = 25;

/** Uppercase mono date label ("JUL 3, 2026") for a feed entry's meta line. */
function metaDateLabel(iso: string | null): string {
  if (!iso) return "UNDATED";
  return formatDate(iso).toUpperCase();
}

const proseSummaryClasses =
  "prose prose-sm prose-stone dark:prose-invert max-w-none break-words text-[13.5px] leading-relaxed text-stone-600 dark:text-stone-400 [&_p]:my-0 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline [&_code]:text-[12.5px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none";

/**
 * `/updates`-specific chronological feed (design option 8a): a two-column
 * rail (Timeline / Area / Legend) plus a one-meta-line-per-entry feed, hairline
 * dividers, no cards. Deliberately NOT `OrgReleaseList` — that component's
 * left date-rail layout is shared with every org page and stays untouched
 * (see the brief's do-not-modify constraint); this is a fresh presentation
 * over the same wire data.
 */
export function UpdatesFeed({
  orgSlug,
  initialReleases,
  initialCursor,
}: {
  orgSlug: string;
  initialReleases: OrgReleaseItemView[];
  initialCursor: string | null;
}) {
  const [releases, setReleases] = useState(initialReleases);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadingFull, setLoadingFull] = useState(!!initialCursor);
  const [loadError, setLoadError] = useState(false);
  const [monthFilter, setMonthFilter] = useState<string | null>(null);
  const [areaFilter, setAreaFilter] = useState<string | null>(null);

  // Eagerly follow the cursor to load the org's full release history client-
  // side. The month/area filters need accurate counts and complete buckets
  // over the whole dataset, not just the first (API-capped, currently 100)
  // page — decision documented in the implementation report. Small orgs like
  // releases-sh (~100 releases total) resolve this in one extra request.
  useEffect(() => {
    if (!cursor) {
      setLoadingFull(false);
      return;
    }
    let cancelled = false;
    (async () => {
      let next = cursor;
      let pages = 0;
      while (next && pages < MAX_EAGER_PAGES) {
        pages++;
        try {
          const res = await fetch(
            `/api/org-releases/${orgSlug}?cursor=${encodeURIComponent(next)}`,
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (cancelled) return;
          // Dedupe by id: a page boundary shift (new release published
          // mid-walk) or a fail-open cursor can re-serve rows already held.
          setReleases((prev) => {
            const seen = new Set(prev.map((r) => r.id));
            const fresh = (data.releases as typeof prev).filter((r) => !seen.has(r.id));
            return fresh.length > 0 ? [...prev, ...fresh] : prev;
          });
          next = data.pagination?.nextCursor ?? null;
          setCursor(next);
        } catch {
          if (!cancelled) setLoadError(true);
          break;
        }
      }
      if (!cancelled) setLoadingFull(false);
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount only — `cursor` is read via closure
    // inside the loop rather than as a re-triggering dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug]);

  const areaBuckets = useMemo(() => buildAreaBuckets(releases), [releases]);

  // Timeline counts respect the active Area filter (switching Area updates
  // the per-month counts) but never the active month filter — that would make
  // the Timeline list reflow every time you click a month in it.
  const areaFiltered = useMemo(
    () =>
      areaFilter
        ? releases.filter((r) => entryAreaGroup({ kind: "row", release: r }).slug === areaFilter)
        : releases,
    [releases, areaFilter],
  );
  const monthBuckets = useMemo(() => buildMonthBuckets(areaFiltered), [areaFiltered]);

  // An Area switch can leave the selected month with zero releases — its
  // Timeline row (the only way to clear it) disappears with it, stranding the
  // feed on an empty filter. Treat a vanished bucket as "no month selected".
  const effectiveMonthFilter =
    monthFilter && monthBuckets.some((b) => b.key === monthFilter) ? monthFilter : null;

  const visibleReleases = useMemo(
    () =>
      effectiveMonthFilter
        ? areaFiltered.filter((r) => monthKeyOf(r.publishedAt) === effectiveMonthFilter)
        : areaFiltered,
    [areaFiltered, effectiveMonthFilter],
  );

  const entries = useMemo(() => buildFeedEntries(visibleReleases), [visibleReleases]);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-9 pb-8 lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start">
      {/* Mobile: Timeline + Area collapse to horizontal scroll chip rows;
          Legend hides entirely (per brief). Desktop: vertical rail. */}
      <MonthAreaChips
        monthBuckets={monthBuckets}
        monthFilter={effectiveMonthFilter}
        onMonthFilter={setMonthFilter}
        areaBuckets={areaBuckets}
        areaFilter={areaFilter}
        onAreaFilter={setAreaFilter}
        className="flex flex-col gap-3 lg:hidden"
      />

      <aside className="hidden flex-col gap-5 lg:flex">
        <div>
          <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.1em] text-stone-400 dark:text-stone-500">
            Timeline
          </h3>
          <div className="flex flex-col">
            {monthBuckets.map((bucket) => {
              const active = effectiveMonthFilter === bucket.key;
              return (
                <button
                  key={bucket.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setMonthFilter(active ? null : bucket.key)}
                  className={
                    "flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors " +
                    (active
                      ? "bg-stone-100 font-semibold text-stone-900 dark:bg-stone-800 dark:text-stone-100"
                      : "text-stone-600 hover:bg-stone-50 dark:text-stone-400 dark:hover:bg-stone-900")
                  }
                >
                  {bucket.label}
                  <span className="text-stone-400 dark:text-stone-500">{bucket.count}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.1em] text-stone-400 dark:text-stone-500">
            Area
          </h3>
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              aria-pressed={areaFilter === null}
              onClick={() => setAreaFilter(null)}
              className={
                "rounded-md px-2.5 py-1 text-left text-[13px] transition-colors " +
                (areaFilter === null
                  ? "bg-stone-100 font-semibold text-stone-900 dark:bg-stone-800 dark:text-stone-100"
                  : "text-stone-600 hover:bg-stone-50 dark:text-stone-400 dark:hover:bg-stone-900")
              }
            >
              All
            </button>
            {areaBuckets.map((area) => {
              const active = areaFilter === area.slug;
              return (
                <button
                  key={area.slug}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setAreaFilter(active ? null : area.slug)}
                  className={
                    "rounded-md px-2.5 py-1 text-left text-[13px] transition-colors " +
                    (active
                      ? "bg-stone-100 font-semibold text-stone-900 dark:bg-stone-800 dark:text-stone-100"
                      : "text-stone-600 hover:bg-stone-50 dark:text-stone-400 dark:hover:bg-stone-900")
                  }
                >
                  {area.label}
                </button>
              );
            })}
          </div>
        </div>
        <CompositionLegend />
      </aside>

      <div>
        {entries.length === 0 ? (
          <div className="py-12 text-center text-sm text-stone-400 dark:text-stone-500">
            {loadingFull ? "Loading…" : "No releases match these filters."}
          </div>
        ) : (
          entries.map((entry, i) => <FeedEntryRow key={entryKey(entry, i)} entry={entry} />)
        )}

        {loadingFull && (
          <div className="pt-4 text-center text-[12px] text-stone-400 dark:text-stone-500">
            Loading full history…
          </div>
        )}
        {loadError && (
          <div className="pt-4 text-center text-[12px] text-amber-700 dark:text-amber-400">
            Some releases may be missing — failed to load the full history.
          </div>
        )}
      </div>
    </div>
  );
}

function entryKey(entry: FeedEntry, i: number): string {
  return entry.kind === "rollup"
    ? `rollup:${entry.item.groupKey}:${i}`
    : (entry.release.id ?? `row:${i}`);
}

// ── Rail (mobile chip rows) ──

function MonthAreaChips({
  monthBuckets,
  monthFilter,
  onMonthFilter,
  areaBuckets,
  areaFilter,
  onAreaFilter,
  className,
}: {
  monthBuckets: { key: string; label: string; count: number }[];
  monthFilter: string | null;
  onMonthFilter: (key: string | null) => void;
  areaBuckets: AreaGroup[];
  areaFilter: string | null;
  onAreaFilter: (slug: string | null) => void;
  className?: string;
}) {
  const chipClass = (active: boolean) =>
    "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[12.5px] transition-colors " +
    (active
      ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
      : "border-stone-200 text-stone-600 hover:border-stone-300 dark:border-stone-700 dark:text-stone-400 dark:hover:border-stone-600");

  return (
    <div className={className}>
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {monthBuckets.map((bucket) => (
          <button
            key={bucket.key}
            type="button"
            aria-pressed={monthFilter === bucket.key}
            onClick={() => onMonthFilter(monthFilter === bucket.key ? null : bucket.key)}
            className={chipClass(monthFilter === bucket.key)}
          >
            {bucket.label} · {bucket.count}
          </button>
        ))}
      </div>
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1">
        <button
          type="button"
          aria-pressed={areaFilter === null}
          onClick={() => onAreaFilter(null)}
          className={chipClass(areaFilter === null)}
        >
          All
        </button>
        {areaBuckets.map((area) => (
          <button
            key={area.slug}
            type="button"
            aria-pressed={areaFilter === area.slug}
            onClick={() => onAreaFilter(areaFilter === area.slug ? null : area.slug)}
            className={chipClass(areaFilter === area.slug)}
          >
            {area.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Feed entries ──

function FeedEntryRow({ entry }: { entry: FeedEntry }) {
  const composition = entryComposition(entry);
  const publishedAt = entryPublishedAt(entry);
  const area = entryAreaGroup(entry);
  const version = entryVersionLabel(entry);

  if (entry.kind === "rollup") {
    return (
      <RollupEntry
        item={entry.item}
        publishedAt={publishedAt}
        area={area}
        version={version}
        composition={composition}
      />
    );
  }

  const release = entry.release;
  if (isFixOnlyComposition(composition)) {
    return (
      <FixOnlyRow
        release={release}
        publishedAt={publishedAt}
        area={area}
        version={version}
        composition={composition}
      />
    );
  }

  return (
    <FullEntry
      release={release}
      publishedAt={publishedAt}
      area={area}
      version={version}
      composition={composition}
    />
  );
}

function MetaLine({
  publishedAt,
  area,
  version,
  composition,
}: {
  publishedAt: string | null;
  area: { label: string };
  version: string | null;
  composition: ReturnType<typeof entryComposition>;
}) {
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-2.5 font-mono text-[11px] text-stone-400 dark:text-stone-500">
      <span className="uppercase tracking-[0.08em]">{metaDateLabel(publishedAt)}</span>
      <span className="text-stone-300 dark:text-stone-700">·</span>
      <span>{area.label.toLowerCase()}</span>
      {version && (
        <>
          <span className="text-stone-300 dark:text-stone-700">·</span>
          <span>{version}</span>
        </>
      )}
      {composition && (
        <>
          <span className="text-stone-300 dark:text-stone-700">·</span>
          <GlyphCounts composition={composition} />
        </>
      )}
    </div>
  );
}

function FullEntry({
  release,
  publishedAt,
  area,
  version,
  composition,
}: {
  release: OrgReleaseItemView;
  publishedAt: string | null;
  area: { label: string };
  version: string | null;
  composition: ReturnType<typeof entryComposition>;
}) {
  const { descriptive, versionLabel } = deriveFeedTitle(release);
  const heading = descriptive || versionLabel || release.title;
  const thumbnail = release.media?.find((m) => m.type === "image" || m.type === "gif") ?? null;
  const thumbSrc = thumbnail ? (thumbnail.r2Url ?? thumbnail.url) : null;

  return (
    <article className="border-b border-stone-200 py-5 last:border-b-0 dark:border-stone-800">
      <MetaLine publishedAt={publishedAt} area={area} version={version} composition={composition} />
      <h3 className="m-0 text-[18px] font-semibold leading-tight tracking-tight text-stone-900 dark:text-stone-100">
        {release.id ? (
          <Link href={`/release/${release.id}`} className="hover:underline underline-offset-2">
            {heading}
          </Link>
        ) : (
          heading
        )}
      </h3>
      {release.bodyHtml && (
        <div
          className={`mt-1.5 max-w-[70ch] ${proseSummaryClasses}`}
          dangerouslySetInnerHTML={{ __html: release.bodyHtml }}
        />
      )}
      {thumbSrc && (
        <div className="mt-3 max-w-[660px]">
          <FallbackImage
            src={releaseThumbUrl(thumbSrc, 1320)}
            alt={thumbnail?.alt || ""}
            width={660}
            height={180}
            className="h-auto w-full rounded-lg border border-stone-200 object-cover dark:border-stone-800"
            unoptimized={IMG_TRANSFORM_ON || undefined}
          />
        </div>
      )}
    </article>
  );
}

function FixOnlyRow({
  release,
  publishedAt,
  area,
  version,
  composition,
}: {
  release: OrgReleaseItemView;
  publishedAt: string | null;
  area: { label: string };
  version: string | null;
  composition: ReturnType<typeof entryComposition>;
}) {
  const { descriptive, versionLabel } = deriveFeedTitle(release);
  const heading = descriptive || versionLabel || release.title;

  return (
    <div className="flex items-center gap-3 border-b border-stone-200 py-3 dark:border-stone-800">
      <span className="flex shrink-0 items-center gap-2.5 font-mono text-[11px] text-stone-400 dark:text-stone-500">
        <span className="w-[70px] uppercase tracking-[0.08em]">{shortDateLabel(publishedAt)}</span>
        <span>{area.label.toLowerCase()}</span>
        {version && (
          <>
            <span className="text-stone-300 dark:text-stone-700">·</span>
            <span>{version}</span>
          </>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-stone-700 dark:text-stone-300">
        {release.id ? (
          <Link href={`/release/${release.id}`} className="hover:underline underline-offset-2">
            {heading}
          </Link>
        ) : (
          heading
        )}
      </span>
      <GlyphCounts
        composition={composition}
        className="shrink-0 font-mono text-[11px] text-stone-400 dark:text-stone-500"
      />
    </div>
  );
}

function shortDateLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso)
    .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .toUpperCase();
}

function RollupEntry({
  item,
  publishedAt,
  area,
  version,
  composition,
}: {
  item: Extract<FeedEntry, { kind: "rollup" }>["item"];
  publishedAt: string | null;
  area: { label: string };
  version: string | null;
  composition: ReturnType<typeof entryComposition>;
}) {
  const [open, setOpen] = useState(false);
  const newest = item.releases[0];
  const { descriptive, versionLabel } = deriveFeedTitle(newest);
  const heading = descriptive || versionLabel || newest.title;

  return (
    <article className="border-b border-stone-200 py-5 last:border-b-0 dark:border-stone-800">
      <MetaLine publishedAt={publishedAt} area={area} version={version} composition={composition} />
      <h3 className="m-0 text-[18px] font-semibold leading-tight tracking-tight text-stone-900 dark:text-stone-100">
        {newest.id ? (
          <Link href={`/release/${newest.id}`} className="hover:underline underline-offset-2">
            {heading}
          </Link>
        ) : (
          heading
        )}
      </h3>
      {newest.bodyHtml && (
        <div
          className={`mt-1.5 max-w-[70ch] ${proseSummaryClasses}`}
          dangerouslySetInnerHTML={{ __html: newest.bodyHtml }}
        />
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-3 inline-flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-[12px] font-semibold text-stone-600 transition-colors hover:bg-stone-100 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400 dark:hover:bg-stone-800"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={`h-2.5 w-2.5 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        {item.releases.length} versions today
      </button>
      {open && (
        <div className="mt-2.5 flex flex-col gap-1.5 border-l-2 border-stone-200 pl-3 dark:border-stone-800">
          {item.releases.map((r, i) => {
            const parts = deriveFeedTitle(r);
            const label = parts.descriptive || r.title;
            return (
              <div
                key={r.id ?? `${item.groupKey}:${i}`}
                className="flex items-center gap-3 font-mono text-[12px] text-stone-500 dark:text-stone-400"
              >
                <span className="w-[90px] shrink-0">{parts.versionLabel ?? "—"}</span>
                <span className="min-w-0 flex-1 truncate">
                  {r.id ? (
                    <Link href={`/release/${r.id}`} className="hover:underline underline-offset-2">
                      {label}
                    </Link>
                  ) : (
                    label
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}
