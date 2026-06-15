"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { remarkPlugins } from "@/lib/markdown-plugins";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { OrgAvatar } from "./org-avatar";
import { SourceTypeIcon } from "./source-type-icon";
import { ClusterChip } from "./cluster-chip";
import { FallbackImage } from "./fallback-image";
import { collapsedMarkdownComponents, markdownComponents } from "./markdown-components";
import {
  type CollectionMember,
  type CollectionMemberOrg,
  type CollectionReleaseItem,
  type CollectionDailySummary,
} from "@/lib/api";
import { memberKey } from "@/lib/member-key";
import { tabButtonClass } from "@/lib/styles";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { InfiniteScrollTrigger } from "./infinite-scroll-trigger";
import { isTag, rollupTags, type TagListItem } from "./collection-timeline-rollup";
import { Caret } from "./caret";
import { pluralReleases } from "@/lib/formatters";
import { deriveFeedTitle, normalizeVersionLabel } from "@/lib/release-title";

interface CollectionTimelineProps {
  /**
   * Internal Next.js API route that returns the same JSON shape as
   * `/v1/collections/:slug/releases` — supports `cursor` and
   * `include_prereleases` query params. Used by the prerelease toggle and
   * the "Load more" pager.
   */
  fetchEndpoint: string;
  /**
   * Path the format-suffix links append `.json` / `.md` / `.atom` to
   * (e.g. `/collections/frontier-ai-labs`, `/categories/ai`).
   */
  formatPath: string;
  initialReleases: CollectionReleaseItem[];
  initialCursor: string | null;
  /**
   * Mixed-kind member list driving the filter chips. Org-only surfaces
   * (like the category page) pass an array of `kind: "org"` entries.
   */
  members: CollectionMember[];
  /**
   * Optional map from YYYY-MM-DD (Eastern Time) to the AI-generated daily
   * summary for that day. Only the collection page passes this; the category
   * page omits it and the timeline renders fine without it.
   */
  summaryByDate?: Map<string, CollectionDailySummary>;
}

function memberAvatar(m: CollectionMember) {
  return m.kind === "org"
    ? { avatarUrl: m.avatarUrl, githubHandle: m.githubHandle, name: m.name }
    : { avatarUrl: m.org.avatarUrl, githubHandle: m.org.githubHandle, name: m.org.name };
}

type TypeFilter = "all" | "tag" | "post";

// Map the UI's tag/post toggle to the set of `source_type` values the server
// accepts. Kept here so the renderer's tag/post split (everything-but-github
// = post) stays in lockstep with the server-side narrowing.
function sourceTypesForFilter(filter: TypeFilter): string | null {
  if (filter === "tag") return "github";
  if (filter === "post") return "feed,scrape,agent";
  return null;
}

// All date bucketing and display uses Eastern Time so client-rendered day
// boundaries match the server's `summary_date` column (which the API writes
// in America/New_York).
const ET_DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const ET_WEEKDAY_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  timeZone: "America/New_York",
});
const ET_DAY_LABEL_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/New_York",
});

const dayKey = (iso: string | null) => (iso ? ET_DAY_FMT.format(new Date(iso)) : "unknown");

function fmtWeekday(iso: string) {
  return ET_WEEKDAY_FMT.format(new Date(iso));
}
function fmtDay(iso: string) {
  return ET_DAY_LABEL_FMT.format(new Date(iso));
}

const markdownClasses =
  "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13.5px] leading-relaxed [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_ul]:my-1 [&_ul]:pl-4 [&_li]:my-0 [&_p]:my-1 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none";

// Subdued link/button color used across the timeline (filter bar, post
// actions, commit-log icons). Centralized so tone tweaks happen in one place.
const subduedLinkClass =
  "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200";

const preBadgeClass =
  "text-[10px] uppercase tracking-wide text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 rounded px-1.5 py-0.5 leading-none";

function findThumbnail(release: CollectionReleaseItem) {
  return release.media?.find((m) => m.type === "image" || m.type === "gif") ?? null;
}

// Descriptive headline for a release card, matching the org feed's hierarchy
// (`deriveFeedTitle`): AI smart-brevity title → AI long title → a raw title
// that isn't merely the version → the version label → "Release". This is why
// the collection view now leads with the enriched headline instead of the raw
// `title` column.
function releaseHeading(release: CollectionReleaseItem): string {
  const { descriptive, versionLabel } = deriveFeedTitle(release);
  return descriptive ?? versionLabel ?? release.title ?? "Release";
}

// Measures whether a height-clamped element actually has hidden overflow, so
// "Show more" (and the fade) only appear when there's real content to reveal.
// `enabled` is the collapsed state — once expanded we stop measuring (the
// button is gone for good; expansion is one-way by design). A ResizeObserver
// re-measures so late-loading markdown/images/syntax highlighting that grows
// the body still flips the flag.
function useOverflowClamp<T extends HTMLElement>(enabled: boolean) {
  const ref = useRef<T>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setOverflowing(false);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight - el.clientHeight > 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);
  return { ref, overflowing };
}

export function CollectionTimeline({
  fetchEndpoint,
  formatPath,
  initialReleases,
  initialCursor,
  members,
  summaryByDate,
}: CollectionTimelineProps) {
  const [releases, setReleases] = useState(initialReleases);
  const [cursor, setCursor] = useState(initialCursor);
  const [includePrereleases, setIncludePrereleases] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  // Active filter keyed by `kind:slug` (memberKey) so org/product slug
  // collisions can't conflate the two when toggling chips.
  const allMemberKeys = useMemo(() => members.map(memberKey), [members]);
  const [activeMembers, setActiveMembers] = useState<Set<string>>(() => new Set(allMemberKeys));
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // `pristine` guards the initial mount from refetching what the server
  // already gave us. Any filter change clears it and the effect takes over.
  const [pristine, setPristine] = useState(true);
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  // Release rows resolve avatars by org slug; for product members, surface
  // the parent org so product-sourced releases get a chip avatar lookup hit.
  const orgsBySlug = useMemo(() => {
    const m = new Map<string, CollectionMemberOrg>();
    for (const member of members) {
      if (member.kind === "org") {
        const { kind: _k, ...orgOnly } = member;
        m.set(member.slug, orgOnly);
      } else if (!m.has(member.org.slug)) {
        m.set(member.org.slug, {
          slug: member.org.slug,
          name: member.org.name,
          domain: member.org.domain,
          avatarUrl: member.org.avatarUrl,
          githubHandle: member.org.githubHandle,
          description: null,
        });
      }
    }
    return m;
  }, [members]);

  // Sorted slug lists so two equivalent filter sets produce the same query
  // string — without this the fetch effect churns on Set/Array identity.
  const { orgsFilterValue, productsFilterValue } = useMemo(() => {
    const allActive =
      activeMembers.size === allMemberKeys.length &&
      allMemberKeys.every((k) => activeMembers.has(k));
    if (allActive) return { orgsFilterValue: null, productsFilterValue: null };
    const orgs: string[] = [];
    const productsList: string[] = [];
    for (const m of members) {
      if (!activeMembers.has(memberKey(m))) continue;
      if (m.kind === "org") orgs.push(m.slug);
      else productsList.push(m.slug);
    }
    return {
      orgsFilterValue: orgs.length > 0 ? orgs.toSorted().join(",") : null,
      productsFilterValue: productsList.length > 0 ? productsList.toSorted().join(",") : null,
    };
  }, [activeMembers, members, allMemberKeys]);

  const sourceTypeValue = sourceTypesForFilter(typeFilter);

  const buildQuery = useCallback(
    (cursorValue?: string) => {
      const params = new URLSearchParams();
      if (includePrereleases) params.set("include_prereleases", "true");
      if (orgsFilterValue) params.set("orgs", orgsFilterValue);
      if (productsFilterValue) params.set("products", productsFilterValue);
      if (sourceTypeValue) params.set("source_type", sourceTypeValue);
      if (cursorValue) params.set("cursor", cursorValue);
      return params.toString();
    },
    [includePrereleases, orgsFilterValue, productsFilterValue, sourceTypeValue],
  );

  // Refetch whenever any server-side filter changes. `pristine` short-circuits
  // the initial mount so we don't immediately re-request the SSR payload.
  useEffect(() => {
    if (pristine) return;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setLoading(true);
    setFetchError(null);
    fetch(`${fetchEndpoint}?${buildQuery()}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        setReleases(data.releases);
        setCursor(data.pagination.nextCursor);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setFetchError("Failed to load releases.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [fetchEndpoint, buildQuery, pristine]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`${fetchEndpoint}?${buildQuery(cursor)}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        setFetchError("Failed to load more releases.");
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      setReleases((prev) => [...prev, ...data.releases]);
      setCursor(data.pagination.nextCursor);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setFetchError("Failed to load more releases.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [cursor, fetchEndpoint, buildQuery]);

  const triggerRef = useInfiniteScroll<HTMLButtonElement>({
    hasMore: cursor !== null && !fetchError,
    loading,
    onLoadMore: loadMore,
  });

  const toggleMember = (key: string) => {
    setPristine(false);
    setActiveMembers((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      // Re-select all when the last chip toggles off so the feed never
      // collapses to empty from a single click.
      if (n.size === 0) return new Set(allMemberKeys);
      return n;
    });
  };

  const days = useMemo(() => groupByDay(releases), [releases]);

  return (
    <div>
      {members.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {members.map((m) => {
            const key = memberKey(m);
            const active = activeMembers.has(key);
            const avatar = memberAvatar(m);
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleMember(key)}
                className={`inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full border text-[13px] font-medium transition-colors ${
                  active
                    ? "border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 text-stone-800 dark:text-stone-100"
                    : "border-stone-200 dark:border-stone-800 bg-transparent text-stone-400 dark:text-stone-500 opacity-70 hover:opacity-100"
                }`}
              >
                <OrgAvatar
                  avatarUrl={avatar.avatarUrl}
                  githubHandle={avatar.githubHandle}
                  name={avatar.name}
                  size={20}
                />
                <span>{m.name}</span>
                {m.kind === "product" && (
                  <span className="text-stone-400 dark:text-stone-500 font-normal">
                    · {m.org.name}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Filter bar: type tabs + prerelease toggle + format links */}
      <div className="flex items-end flex-wrap gap-5 border-b border-stone-200 dark:border-stone-800">
        {(
          [
            { id: "all", label: "All" },
            { id: "tag", label: "Releases" },
            { id: "post", label: "Posts" },
          ] as Array<{ id: TypeFilter; label: string }>
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setPristine(false);
              setTypeFilter(t.id);
            }}
            className={tabButtonClass(typeFilter === t.id)}
          >
            {t.label}
          </button>
        ))}
        <label className="flex items-center gap-2 text-[12px] text-stone-500 dark:text-stone-400 cursor-pointer select-none pb-2.5">
          <input
            type="checkbox"
            checked={includePrereleases}
            onChange={(e) => {
              setPristine(false);
              setIncludePrereleases(e.target.checked);
            }}
            className="h-3.5 w-3.5 accent-stone-700 dark:accent-stone-300"
          />
          <span>Show prereleases</span>
        </label>
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-[12px] text-stone-500 dark:text-stone-400 pb-2.5">
          <a href={`${formatPath}.json`} className="hover:text-stone-700 dark:hover:text-stone-200">
            .json
          </a>
          <span className="opacity-50">·</span>
          <a href={`${formatPath}.md`} className="hover:text-stone-700 dark:hover:text-stone-200">
            .md
          </a>
          <span className="opacity-50">·</span>
          <a href={`${formatPath}.atom`} className="hover:text-stone-700 dark:hover:text-stone-200">
            .atom
          </a>
        </div>
      </div>

      {fetchError && releases.length > 0 && (
        <div className="text-center py-2 mt-2 text-amber-700 dark:text-amber-400 text-[12px] bg-amber-50 dark:bg-amber-950/30 rounded">
          {fetchError}
        </div>
      )}

      {releases.length === 0 ? (
        <div className="text-center py-16 text-stone-400 dark:text-stone-500 text-sm">
          {loading ? "Loading…" : (fetchError ?? "No releases match your filters.")}
        </div>
      ) : (
        <div className="mt-2">
          {days.map((day) => (
            <DaySection
              key={day.key}
              day={day}
              orgsBySlug={orgsBySlug}
              summary={summaryByDate?.get(day.key) ?? null}
            />
          ))}
        </div>
      )}

      {cursor && (
        <InfiniteScrollTrigger
          triggerRef={triggerRef}
          loading={loading}
          error={!!fetchError}
          onClick={loadMore}
        />
      )}
    </div>
  );
}

// ── Grouping helpers ─────────────────────────────────────────────

interface DayBucket {
  key: string;
  iso: string | null;
  releases: CollectionReleaseItem[];
}

function groupByDay(releases: CollectionReleaseItem[]): DayBucket[] {
  const out: DayBucket[] = [];
  let current: DayBucket | null = null;
  for (const r of releases) {
    const k = dayKey(r.publishedAt);
    if (!current || current.key !== k) {
      current = { key: k, iso: r.publishedAt, releases: [] };
      out.push(current);
    }
    current.releases.push(r);
  }
  return out;
}

function groupByOrg(releases: CollectionReleaseItem[]) {
  const map = new Map<
    string,
    { orgSlug: string; orgName: string; releases: CollectionReleaseItem[] }
  >();
  for (const r of releases) {
    const existing = map.get(r.org.slug);
    if (existing) existing.releases.push(r);
    else map.set(r.org.slug, { orgSlug: r.org.slug, orgName: r.org.name, releases: [r] });
  }
  return [...map.values()];
}

// ── Day section ─────────────────────────────────────────────────

// Distinct orgs that shipped in a day, first-appearance order, each paired with
// its avatar metadata. Feeds the day-header facepile — an at-a-glance cue for
// whether a day touches something you follow.
function dayOrgs(day: DayBucket, orgsBySlug: Map<string, CollectionMemberOrg>) {
  const seen = new Set<string>();
  const out: { slug: string; name: string; meta?: CollectionMemberOrg }[] = [];
  for (const r of day.releases) {
    if (seen.has(r.org.slug)) continue;
    seen.add(r.org.slug);
    out.push({ slug: r.org.slug, name: r.org.name, meta: orgsBySlug.get(r.org.slug) });
  }
  return out;
}

// Overlapping avatar stack of the day's orgs. Mirrors `MemberFacepile`'s ring +
// negative-margin treatment, but avatar-only (no name list) since it's a
// glanceable header cue, not a member roster.
function DayFacepile({ orgs }: { orgs: ReturnType<typeof dayOrgs> }) {
  const MAX = 6;
  const shown = orgs.slice(0, MAX);
  const extra = orgs.length - shown.length;
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex -space-x-1.5">
        {shown.map((o) => (
          <span
            key={o.slug}
            title={o.name}
            className="rounded-full ring-2 ring-white dark:ring-stone-950"
          >
            <OrgAvatar
              avatarUrl={o.meta?.avatarUrl ?? null}
              githubHandle={o.meta?.githubHandle ?? null}
              name={o.meta?.name ?? o.name}
              size={20}
            />
          </span>
        ))}
      </div>
      {extra > 0 && (
        <span className="text-[11px] text-stone-400 dark:text-stone-500 font-mono tabular-nums">
          +{extra}
        </span>
      )}
    </div>
  );
}

// Day header. The date line is the anchor; the org facepile rides its right
// edge as a glanceable "who shipped today" cue. The AI daily summary, when
// present, sits directly beneath in its own distinct card (tinted background +
// sparkle) so it reads as a special editorial block rather than just more body
// text — modeled on the org-overview card treatment.
function DayHeader({
  day,
  orgsBySlug,
  summary,
}: {
  day: DayBucket;
  orgsBySlug: Map<string, CollectionMemberOrg>;
  summary: CollectionDailySummary | null;
}) {
  const orgs = dayOrgs(day, orgsBySlug);
  return (
    <header className="pt-2 pb-3 border-b border-stone-200 dark:border-stone-800">
      <div className="flex items-center gap-3">
        <div className="flex items-baseline gap-3">
          {day.iso ? (
            <>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                {fmtWeekday(day.iso)}
              </span>
              <span className="text-[13px] font-medium text-stone-800 dark:text-stone-200">
                {fmtDay(day.iso)}
              </span>
            </>
          ) : (
            <span className="text-[13px] font-medium text-stone-800 dark:text-stone-200">
              Undated
            </span>
          )}
          <span className="text-[11px] text-stone-400 dark:text-stone-500 font-mono tabular-nums">
            {day.releases.length} {pluralReleases(day.releases.length)}
          </span>
        </div>
        <div className="flex-1" />
        {orgs.length > 0 && <DayFacepile orgs={orgs} />}
      </div>
      {summary && (
        <div className="mt-3 rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/50 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <SparkleIcon size={14} className="shrink-0 text-stone-400 dark:text-stone-500" />
            <span className="text-[11px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Daily summary
            </span>
          </div>
          <h2 className="mt-1.5 text-[15px] font-semibold tracking-tight text-stone-900 dark:text-stone-100 leading-snug">
            {summary.title}
          </h2>
          <p className="mt-1 text-[13px] text-stone-600 dark:text-stone-400 leading-relaxed">
            {summary.summary}
          </p>
          {summary.takeaways.length > 0 && (
            <ul className="mt-2.5 flex flex-col gap-1">
              {summary.takeaways.map((t, i) => (
                <li
                  key={i}
                  className="flex gap-2 text-[12.5px] text-stone-500 dark:text-stone-400 leading-relaxed"
                >
                  <span aria-hidden className="select-none text-stone-300 dark:text-stone-600">
                    —
                  </span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </header>
  );
}

function DaySection({
  day,
  orgsBySlug,
  summary,
}: {
  day: DayBucket;
  orgsBySlug: Map<string, CollectionMemberOrg>;
  summary: CollectionDailySummary | null;
}) {
  const orgGroups = groupByOrg(day.releases);
  return (
    <section className="mt-6">
      <DayHeader day={day} orgsBySlug={orgsBySlug} summary={summary} />
      <div className="flex flex-col gap-4 mt-4">
        {orgGroups.map((g) => (
          <OrgSection key={g.orgSlug} group={g} orgMeta={orgsBySlug.get(g.orgSlug)} />
        ))}
      </div>
    </section>
  );
}

function OrgSection({
  group,
  orgMeta,
}: {
  group: { orgSlug: string; orgName: string; releases: CollectionReleaseItem[] };
  orgMeta?: CollectionMemberOrg;
}) {
  // Partition once into posts (hero) and tags (commit-log rollup). Memoized so
  // the derived arrays keep a stable reference — otherwise the `tagItems` memo
  // below would re-run every render on a fresh `filter` result.
  const { posts, tags } = useMemo(() => {
    const split = { posts: [] as CollectionReleaseItem[], tags: [] as CollectionReleaseItem[] };
    for (const r of group.releases) (isTag(r) ? split.tags : split.posts).push(r);
    return split;
  }, [group.releases]);
  const tagItems = useMemo(() => rollupTags(tags), [tags]);
  // Group posts the same way tags roll up: 2+ posts sharing a product collapse
  // into one card (product named once, each version a subsection); lone posts
  // keep the full hero treatment.
  const postItems = useMemo(() => rollupTags(posts), [posts]);

  return (
    <div>
      <div className="flex items-center gap-2 pb-2">
        <Link
          href={`/${group.orgSlug}`}
          className="flex items-center gap-2 text-stone-700 dark:text-stone-200 hover:text-stone-900 dark:hover:text-stone-100"
        >
          <OrgAvatar
            avatarUrl={orgMeta?.avatarUrl ?? null}
            githubHandle={orgMeta?.githubHandle ?? null}
            name={orgMeta?.name ?? group.orgName}
            size={20}
          />
          <span className="text-[13.5px] font-semibold tracking-tight">{group.orgName}</span>
        </Link>
        <span className="text-[11px] text-stone-400 dark:text-stone-500 font-mono tabular-nums">
          {group.releases.length}
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {postItems.map((item) =>
          item.kind === "single" ? (
            <PostHero key={tagKey(item)} release={item.release} />
          ) : (
            <ProductPostGroup key={tagKey(item)} label={item.label} releases={item.releases} />
          ),
        )}

        {tagItems.length > 0 && (
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 overflow-hidden">
            {tagItems.map((item, i) => (
              <TagItem key={tagKey(item)} item={item} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function tagKey(item: TagListItem) {
  if (item.kind === "single")
    return `s:${item.release.id ?? item.release.url ?? item.release.title}`;
  return `r:${item.groupKey}`;
}

// ── Post hero ──────────────────────────────────────────────────

function PostHero({ release }: { release: CollectionReleaseItem }) {
  const [expanded, setExpanded] = useState(false);
  const thumbnail = findThumbnail(release);
  // Lead with the enriched headline (matches the org feed) instead of the raw
  // `title` column, which is often a terse "Session Folders".
  const heading = releaseHeading(release);
  const versionLabel = normalizeVersionLabel(release.version);
  // Render the full body when available so "Show more" actually reveals new
  // content. The collapsed view is height-capped; expanded unlocks it. The
  // button only appears when the body actually overflows that cap.
  const body = release.content || release.summary || "";
  const { ref: clampRef, overflowing } = useOverflowClamp<HTMLDivElement>(!expanded);

  return (
    <article
      className={`grid border border-stone-200 dark:border-stone-800 rounded-lg bg-white dark:bg-stone-900 overflow-hidden ${
        thumbnail ? "md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]" : "grid-cols-1"
      }`}
    >
      <div className="p-5 md:p-6 min-w-0">
        {release.product && (
          <div className="text-[12px] text-stone-500 dark:text-stone-400 mb-1.5">
            {release.product.name}
          </div>
        )}
        <h3 className="m-0 text-[18px] font-semibold tracking-tight text-stone-900 dark:text-stone-100 leading-snug">
          {release.id ? (
            <Link href={`/release/${release.id}`} className="hover:underline underline-offset-2">
              {heading}
            </Link>
          ) : (
            heading
          )}
        </h3>
        {versionLabel && versionLabel !== heading && (
          <div className="mt-1 font-mono text-[11.5px] text-stone-400 dark:text-stone-500">
            {versionLabel}
          </div>
        )}
        <div
          ref={clampRef}
          className={`mt-2.5 text-stone-600 dark:text-stone-400 ${
            expanded ? "" : "max-h-[6.5em] overflow-hidden relative"
          }`}
        >
          <div className={markdownClasses}>
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={[rehypeShikiPlugin]}
              components={expanded ? markdownComponents : collapsedMarkdownComponents}
            >
              {body}
            </ReactMarkdown>
          </div>
          {!expanded && overflowing && (
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-white dark:from-stone-900 to-transparent" />
          )}
        </div>
        <div className="flex items-center gap-3 mt-3 text-[12px]">
          {!expanded && overflowing && (
            <button type="button" onClick={() => setExpanded(true)} className={subduedLinkClass}>
              Show more
            </button>
          )}
          {release.url && (
            <a
              href={release.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`${subduedLinkClass} inline-flex items-center gap-1`}
            >
              Read post
              <ExternalLinkIcon size={11} />
            </a>
          )}
          {release.prerelease && (
            <span title="Pre-release (beta, rc, nightly, preview)" className={preBadgeClass}>
              pre
            </span>
          )}
          <ClusterChip count={release.coverageCount} />
        </div>
      </div>
      {thumbnail && (
        <div className="bg-stone-50 dark:bg-stone-950/50 p-4 flex items-center justify-center">
          <FallbackImage
            src={thumbnail.r2Url ?? thumbnail.url}
            alt={thumbnail.alt || heading}
            width={400}
            height={260}
            className="rounded-md object-cover w-full h-auto max-h-64"
          />
        </div>
      )}
    </article>
  );
}

// ── Grouped product posts ──────────────────────────────────────
//
// When a product ships 2+ posts in one day, collapse them into a single card:
// the product name is stated once in the header, and each release becomes a
// versioned subsection below. Makes incremental same-product updates read as a
// set instead of N repetitive hero cards.
function ProductPostGroup({
  label,
  releases,
}: {
  label: string;
  releases: CollectionReleaseItem[];
}) {
  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 overflow-hidden">
      {/* Tinted header band frames the product as the container so the (now
          bolder) per-version headlines below read as its children, not siblings. */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/40">
        <h3 className="m-0 text-[13px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          {label}
        </h3>
        <span className="text-[11px] text-stone-400 dark:text-stone-500 font-mono tabular-nums">
          {releases.length} updates
        </span>
      </div>
      {releases.map((release) => (
        <PostVersionRow key={release.id ?? release.url ?? release.title} release={release} />
      ))}
    </div>
  );
}

function PostVersionRow({ release }: { release: CollectionReleaseItem }) {
  const [expanded, setExpanded] = useState(false);
  const { descriptive, versionLabel } = deriveFeedTitle(release);
  // Lead with the descriptive headline — it's the useful part. The version is
  // secondary metadata, demoted to a small dim mono tag beside it. Falls back to
  // the version (then raw title) when there's no descriptive headline, e.g. a
  // bare "v2.1.176" release.
  const headline = descriptive ?? versionLabel ?? release.title ?? "Update";
  const versionTag = versionLabel && versionLabel !== headline ? versionLabel : null;
  const body = release.content || release.summary || "";
  const thumbnail = findThumbnail(release);
  const { ref: clampRef, overflowing } = useOverflowClamp<HTMLDivElement>(!expanded);

  return (
    <div className="px-5 py-4 border-t border-stone-200 dark:border-stone-800 first:border-t-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[15px] font-semibold tracking-tight text-stone-900 dark:text-stone-100 leading-snug">
          {release.id ? (
            <Link href={`/release/${release.id}`} className="hover:underline underline-offset-2">
              {headline}
            </Link>
          ) : (
            headline
          )}
        </span>
        {versionTag && (
          <span className="font-mono text-[11.5px] text-stone-400 dark:text-stone-500">
            {versionTag}
          </span>
        )}
        {release.prerelease && (
          <span title="Pre-release (beta, rc, nightly, preview)" className={preBadgeClass}>
            pre
          </span>
        )}
        <ClusterChip count={release.coverageCount} />
      </div>
      <div
        className={`mt-2.5 grid gap-4 ${
          thumbnail ? "md:grid-cols-[minmax(0,1fr)_minmax(0,200px)]" : ""
        }`}
      >
        <div className="min-w-0">
          <div
            ref={clampRef}
            className={`text-stone-600 dark:text-stone-400 ${
              expanded ? "" : "max-h-[6.5em] overflow-hidden relative"
            }`}
          >
            <div className={markdownClasses}>
              <ReactMarkdown
                remarkPlugins={remarkPlugins}
                rehypePlugins={[rehypeShikiPlugin]}
                components={expanded ? markdownComponents : collapsedMarkdownComponents}
              >
                {body}
              </ReactMarkdown>
            </div>
            {!expanded && overflowing && (
              <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-white dark:from-stone-900 to-transparent" />
            )}
          </div>
          <div className="flex items-center gap-3 mt-2 text-[12px]">
            {!expanded && overflowing && (
              <button type="button" onClick={() => setExpanded(true)} className={subduedLinkClass}>
                Show more
              </button>
            )}
            {release.url && (
              <a
                href={release.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`${subduedLinkClass} inline-flex items-center gap-1`}
              >
                Read post
                <ExternalLinkIcon size={11} />
              </a>
            )}
          </div>
        </div>
        {thumbnail && (
          <div className="flex items-start justify-center">
            <FallbackImage
              src={thumbnail.r2Url ?? thumbnail.url}
              alt={thumbnail.alt || headline}
              width={200}
              height={130}
              className="rounded-md object-cover w-full h-auto max-h-40 border border-stone-200 dark:border-stone-800"
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tag rows (commit-log) ──────────────────────────────────────

function TagItem({ item, index }: { item: TagListItem; index: number }) {
  const [open, setOpen] = useState(false);
  const topBorder = index === 0 ? "" : "border-t border-stone-200 dark:border-stone-800";

  if (item.kind === "single") {
    return (
      <div className={topBorder}>
        <CommitLogRow release={item.release} />
      </div>
    );
  }

  // Summary-header rollup: one line per group (product-or-source) with the
  // newest few version tags inline, expanding to every release in the bucket.
  // Replaces the older "promote newest row + N-earlier toggle" so all rollups
  // — product- and source-keyed — read the same. The day-section header above
  // already supplies the date, so the label stays date-free.
  const pills = item.releases.slice(0, 3);
  const overflow = item.releases.length - pills.length;

  return (
    <div className={topBorder}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex items-center gap-2 w-full text-left py-2.5 px-3 ${subduedLinkClass}`}
      >
        <Caret open={open} />
        <span className="text-[12.5px] font-medium text-stone-700 dark:text-stone-200">
          {item.label}
        </span>
        <span className="text-[12px] text-stone-400 dark:text-stone-500 font-mono tabular-nums">
          · {item.releases.length} {pluralReleases(item.releases.length)}
        </span>
        {!open && (
          <span className="inline-flex items-center gap-1 ml-1 flex-wrap min-w-0">
            {pills.map((r) => (
              <span
                key={r.id ?? r.url ?? r.title}
                className="font-mono text-[10.5px] px-1.5 py-px rounded bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-500 dark:text-stone-400 whitespace-nowrap"
              >
                {r.version ?? r.title}
              </span>
            ))}
            {overflow > 0 && (
              <span className="text-[11px] text-stone-400 dark:text-stone-500">+{overflow}</span>
            )}
          </span>
        )}
      </button>
      {open &&
        item.releases.map((r) => (
          <div
            key={r.id ?? r.url ?? r.title}
            className="border-t border-stone-200 dark:border-stone-800 border-l-2 border-l-stone-300 dark:border-l-stone-700"
          >
            <CommitLogRow release={r} />
          </div>
        ))}
    </div>
  );
}

function CommitLogRow({ release }: { release: CollectionReleaseItem }) {
  const [expanded, setExpanded] = useState(false);
  const versionLabel = release.version ?? release.title;
  // Prefer the server-resolved group name (#1234); fall back to deriving it
  // from product ?? source for older API responses that omit `groupName`.
  // Falling back to the source name beats an empty dash for standalone sources.
  const productLabel = release.groupName ?? release.product?.name ?? release.source.name;
  const body = release.content || release.summary || "";
  const hasBody = body.trim().length > 0;
  const thumbnail = findThumbnail(release);
  const inlineSummary = release.summary || "";

  return (
    <div className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-3 px-3 py-2.5">
      <span className="text-[12.5px] font-medium text-stone-700 dark:text-stone-200 truncate max-w-[140px]">
        {productLabel}
      </span>
      <span className="font-mono text-[12px] font-medium text-stone-900 dark:text-stone-100 bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded px-1.5 py-0.5 whitespace-nowrap">
        {versionLabel}
      </span>
      <button
        type="button"
        onClick={() => hasBody && setExpanded((v) => !v)}
        className={`text-left min-w-0 text-[12.5px] text-stone-600 dark:text-stone-400 truncate ${
          hasBody
            ? "cursor-pointer hover:text-stone-700 dark:hover:text-stone-200"
            : "cursor-default"
        }`}
        title={inlineSummary}
      >
        {inlineSummary || (release.title !== versionLabel ? release.title : "")}
      </button>
      <div className="flex items-center gap-2">
        {thumbnail && (
          <FallbackImage
            src={thumbnail.r2Url ?? thumbnail.url}
            alt={thumbnail.alt || versionLabel}
            width={56}
            height={32}
            className="rounded object-cover w-14 h-8 border border-stone-200 dark:border-stone-800"
          />
        )}
        {release.prerelease && (
          <span title="Pre-release" className={preBadgeClass}>
            pre
          </span>
        )}
        <ClusterChip count={release.coverageCount} />
        <SourceTypeIcon type={release.source.type} size={12} />
        {release.url && (
          <a
            href={release.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-200"
            aria-label="Open original source"
          >
            <ExternalLinkIcon size={12} />
          </a>
        )}
      </div>
      {expanded && hasBody && (
        <div className="col-span-4 px-1 pb-2 pt-1">
          <div className={markdownClasses}>
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={[rehypeShikiPlugin]}
              components={markdownComponents}
            >
              {body}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small icons ────────────────────────────────────────────────

// Four-point sparkle — marks the AI-generated daily summary block.
function SparkleIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 2c.3 3.6 1.4 5.6 3 7s3.4 2.4 7 3c-3.6.3-5.6 1.4-7 3s-2.4 3.4-3 7c-.3-3.6-1.4-5.6-3-7s-3.4-2.4-7-3c3.6-.3 5.6-1.4 7-3s2.4-3.4 3-7z" />
    </svg>
  );
}

function ExternalLinkIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="inline-flex"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
