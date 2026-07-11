"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { OrgAvatar } from "./org-avatar";
import { SourceTypeIcon } from "./source-type-icon";
import { ClusterChip } from "./cluster-chip";
import { FallbackImage } from "./fallback-image";
import { ExternalLinkIcon } from "./external-link-icon";
import {
  type CollectionMember,
  type CollectionMemberOrg,
  type CollectionDailySummary,
} from "@/lib/api";
import { type CollectionReleaseItemView } from "@/lib/release-view";
import { memberKey } from "@/lib/member-key";
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
   * (e.g. `/categories/ai`). Omit when the parent surfaces exports in a
   * context rail instead (collection pages).
   */
  formatPath?: string;
  initialReleases: CollectionReleaseItemView[];
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

function findThumbnail(release: CollectionReleaseItemView) {
  return release.media?.find((m) => m.type === "image" || m.type === "gif") ?? null;
}

// Descriptive headline for a release card, matching the org feed's hierarchy
// (`deriveFeedTitle`): AI smart-brevity title → AI long title → a raw title
// that isn't merely the version → the version label → "Release". This is why
// the collection view now leads with the enriched headline instead of the raw
// `title` column.
function releaseHeading(release: CollectionReleaseItemView): string {
  const { descriptive, versionLabel } = deriveFeedTitle(release);
  return descriptive ?? versionLabel ?? release.title ?? "Release";
}

const TYPE_FILTERS: ReadonlyArray<{ id: TypeFilter; label: string }> = [
  { id: "all", label: "All types" },
  { id: "tag", label: "Releases" },
  { id: "post", label: "Posts" },
];

/**
 * Compact filters menu matching {@link ReleaseFilterInput}'s dropdown — used
 * here without a search field because the collection feed has no `q` param.
 * Source-type scope + prereleases live here so the feed chrome stays one row.
 */
function CollectionFiltersMenu({
  typeFilter,
  onTypeFilterChange,
  includePrereleases,
  onIncludePrereleasesChange,
}: {
  typeFilter: TypeFilter;
  onTypeFilterChange: (value: TypeFilter) => void;
  includePrereleases: boolean;
  onIncludePrereleasesChange: (checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasActiveFilter = typeFilter !== "all" || includePrereleases;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Release filters"
        title="Filters"
        className="relative inline-flex h-7 items-center gap-1 rounded-md border border-stone-200 bg-white px-2 text-stone-500 transition-colors hover:text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400 dark:hover:text-stone-200"
      >
        <FilterIcon />
        {hasActiveFilter && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-stone-500 dark:bg-stone-300"
          />
        )}
        <Caret open={open} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-md border border-stone-200 bg-white py-1 shadow-lg dark:border-stone-800 dark:bg-stone-950"
        >
          <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
            Type
          </div>
          <div role="group" aria-label="Release type">
            {TYPE_FILTERS.map((opt) => {
              const active = typeFilter === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => onTypeFilterChange(opt.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-stone-600 hover:bg-stone-50 dark:text-stone-300 dark:hover:bg-stone-800"
                >
                  <span>{opt.label}</span>
                  {active && <CheckMark className="ml-auto text-stone-500 dark:text-stone-300" />}
                </button>
              );
            })}
          </div>
          <div className="my-1 border-t border-stone-100 dark:border-stone-800" />
          <label className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-[12px] text-stone-600 hover:bg-stone-50 dark:text-stone-300 dark:hover:bg-stone-800">
            <input
              type="checkbox"
              checked={includePrereleases}
              onChange={(e) => onIncludePrereleasesChange(e.target.checked)}
              className="h-3.5 w-3.5 accent-stone-700 dark:accent-stone-300"
            />
            <span>Show prereleases</span>
          </label>
        </div>
      )}
    </div>
  );
}

function CheckMark({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`flex-none ${className ?? ""}`}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="flex-none"
    >
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

// Lazily fetch a release's full-body HTML (server-rendered) the first time a
// card expands. Keeps the verbatim body out of the initial crawlable HTML
// (#1606) and — crucially — keeps shiki + react-markdown out of this client
// bundle: no markdown is ever parsed in the browser. Once fetched, the HTML is
// held in state, so collapse/re-expand doesn't refetch.
function useFullBodyHtml(id: string | undefined, expanded: boolean) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // Guards against a double-fetch without living in the effect deps — keeping
  // `loading` out of the deps is deliberate: a state change that re-ran the
  // effect would trip its cleanup (`aborted = true`) and suppress the in-flight
  // response's `setHtml`, leaving the card stuck on "Loading…".
  const startedRef = useRef(false);

  useEffect(() => {
    if (!expanded || startedRef.current || !id) return;
    startedRef.current = true;
    let aborted = false;
    setError(false);
    fetch(`/api/release-body/${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (!aborted) setHtml(typeof data?.bodyHtml === "string" ? data.bodyHtml : "");
      })
      .catch(() => {
        if (aborted) return;
        setError(true);
        startedRef.current = false; // allow a retry on a later expand
      });
    return () => {
      aborted = true;
    };
  }, [expanded, id]);

  return { html, error };
}

// Renders a release body from pre-rendered, sanitized HTML — never react-markdown
// on the client. Collapsed shows the server-rendered excerpt shipped in the
// payload (`release.bodyHtml`); expanded lazily fetches and injects the full
// body. The HTML comes from the server pipeline (`@/lib/render-release-body`),
// which drops raw HTML and strips unsafe links/images, so `dangerouslySetInnerHTML`
// adds no injection surface.
function CardBody({
  release,
  expanded,
}: {
  release: CollectionReleaseItemView;
  expanded: boolean;
}) {
  const { html: fullHtml, error } = useFullBodyHtml(release.id, expanded);

  if (expanded) {
    if (fullHtml === null) {
      return (
        <div className="text-[12.5px] text-stone-400 dark:text-stone-500">
          {error ? "Couldn’t load the full notes." : "Loading…"}
        </div>
      );
    }
    return fullHtml ? (
      <div className={markdownClasses} dangerouslySetInnerHTML={{ __html: fullHtml }} />
    ) : null;
  }

  const excerptHtml = release.bodyHtml ?? "";
  return excerptHtml ? (
    <div className={markdownClasses} dangerouslySetInnerHTML={{ __html: excerptHtml }} />
  ) : null;
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

  const allMembersActive =
    activeMembers.size === allMemberKeys.length && allMemberKeys.every((k) => activeMembers.has(k));

  const selectAllMembers = () => {
    setPristine(false);
    setActiveMembers(new Set(allMemberKeys));
  };

  const toggleMember = (key: string) => {
    setPristine(false);
    setActiveMembers((prev) => {
      // From the "all selected" state, a chip click solos that member — same
      // feel as flipping an "All" → single product chip on the org feed.
      if (prev.size === allMemberKeys.length && allMemberKeys.every((k) => prev.has(k))) {
        return new Set([key]);
      }
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

  // Quiet chip chrome — one height, one weight. Active = filled stone (not a
  // second accent "All" competing with the type menu).
  const chipBase =
    "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors";
  const chipActive = "bg-stone-900 font-medium text-white dark:bg-stone-100 dark:text-stone-900";
  const chipIdle =
    "bg-stone-100 text-stone-600 hover:bg-stone-200 hover:text-stone-900 dark:bg-stone-800/80 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100";

  return (
    <div>
      {/* Single filter row: member chips (when multi-member) + type/prerelease
          menu. Type scope used to be a second pill row and made the chrome
          read as two competing "All" toolbars. */}
      <div className="mb-4 mt-1 flex flex-wrap items-center gap-1.5">
        {members.length > 1 && (
          <>
            <button
              type="button"
              aria-pressed={allMembersActive}
              onClick={selectAllMembers}
              className={`${chipBase} ${allMembersActive ? chipActive : chipIdle}`}
            >
              All
            </button>
            {members.map((m) => {
              const key = memberKey(m);
              // When everything is selected, no individual chip reads as the
              // active filter — "All" carries that state.
              const active = !allMembersActive && activeMembers.has(key);
              const avatar = memberAvatar(m);
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleMember(key)}
                  title={m.kind === "product" ? `${m.name} · ${m.org.name}` : m.name}
                  className={`${chipBase} ${active ? chipActive : chipIdle}`}
                >
                  <OrgAvatar
                    avatarUrl={avatar.avatarUrl}
                    githubHandle={avatar.githubHandle}
                    name={avatar.name}
                    size={14}
                  />
                  <span className="max-w-[9rem] truncate">{m.name}</span>
                </button>
              );
            })}
            <div className="min-w-2 flex-1" />
          </>
        )}
        {members.length <= 1 && <div className="flex-1" />}
        <CollectionFiltersMenu
          typeFilter={typeFilter}
          onTypeFilterChange={(value) => {
            setPristine(false);
            setTypeFilter(value);
          }}
          includePrereleases={includePrereleases}
          onIncludePrereleasesChange={(checked) => {
            setPristine(false);
            setIncludePrereleases(checked);
          }}
        />
        {formatPath && (
          <div className="flex items-center gap-1.5 text-[11.5px] text-stone-400 dark:text-stone-500">
            <a
              href={`${formatPath}.json`}
              className="hover:text-stone-600 dark:hover:text-stone-300"
            >
              .json
            </a>
            <span className="opacity-40">·</span>
            <a href={`${formatPath}.md`} className="hover:text-stone-600 dark:hover:text-stone-300">
              .md
            </a>
            <span className="opacity-40">·</span>
            <a
              href={`${formatPath}.atom`}
              className="hover:text-stone-600 dark:hover:text-stone-300"
            >
              .atom
            </a>
          </div>
        )}
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
  releases: CollectionReleaseItemView[];
}

function groupByDay(releases: CollectionReleaseItemView[]): DayBucket[] {
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

function groupByOrg(releases: CollectionReleaseItemView[]) {
  const map = new Map<
    string,
    { orgSlug: string; orgName: string; releases: CollectionReleaseItemView[] }
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
          <h2 className="mt-1.5 text-[15px] font-semibold tracking-tight text-stone-900 dark:text-stone-100 leading-snug text-balance">
            {summary.title}
          </h2>
          <p className="mt-1 text-[13px] text-stone-600 dark:text-stone-400 leading-relaxed text-pretty">
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
  group: { orgSlug: string; orgName: string; releases: CollectionReleaseItemView[] };
  orgMeta?: CollectionMemberOrg;
}) {
  // Partition once into posts (hero) and tags (commit-log rollup). Memoized so
  // the derived arrays keep a stable reference — otherwise the `tagItems` memo
  // below would re-run every render on a fresh `filter` result.
  const { posts, tags } = useMemo(() => {
    const split = {
      posts: [] as CollectionReleaseItemView[],
      tags: [] as CollectionReleaseItemView[],
    };
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

function tagKey(item: TagListItem<CollectionReleaseItemView>) {
  if (item.kind === "single")
    return `s:${item.release.id ?? item.release.url ?? item.release.title}`;
  return `r:${item.groupKey}`;
}

// ── Post hero ──────────────────────────────────────────────────

function PostHero({ release }: { release: CollectionReleaseItemView }) {
  const [expanded, setExpanded] = useState(false);
  const thumbnail = findThumbnail(release);
  // Lead with the enriched headline (matches the org feed) instead of the raw
  // `title` column, which is often a terse "Session Folders".
  const heading = releaseHeading(release);
  const versionLabel = normalizeVersionLabel(release.version);
  // Collapsed cards show only an excerpt (summary, else a capped body slice) so
  // the full verbatim body never reaches server HTML — that lives on the
  // canonical /release/{id} page (#1606). "Show more" swaps in the full body
  // client-side; it appears only when there's more than the excerpt to reveal.
  // The raw content/summary fields are stripped from this timeline's payload
  // (#1918), so `hasMore` arrives precomputed server-side.
  const hasMore = !!release.hasMore;

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
        <div className="mt-2.5 text-stone-600 dark:text-stone-400">
          <CardBody release={release} expanded={expanded} />
        </div>
        <div className="flex items-center gap-3 mt-3 text-[12px]">
          {!expanded && hasMore && (
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
  releases: CollectionReleaseItemView[];
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

function PostVersionRow({ release }: { release: CollectionReleaseItemView }) {
  const [expanded, setExpanded] = useState(false);
  const { descriptive, versionLabel } = deriveFeedTitle(release);
  // Lead with the descriptive headline — it's the useful part. The version is
  // secondary metadata, demoted to a small dim mono tag beside it. Falls back to
  // the version (then raw title) when there's no descriptive headline, e.g. a
  // bare "v2.1.176" release.
  const headline = descriptive ?? versionLabel ?? release.title ?? "Update";
  const versionTag = versionLabel && versionLabel !== headline ? versionLabel : null;
  // "Show more" swaps the excerpt for the full body, fetched on demand. The raw
  // content/summary fields are stripped from this timeline's payload (#1918),
  // so `hasMore` arrives precomputed server-side.
  const hasMore = !!release.hasMore;
  const thumbnail = findThumbnail(release);

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
          <div className="text-stone-600 dark:text-stone-400">
            <CardBody release={release} expanded={expanded} />
          </div>
          <div className="flex items-center gap-3 mt-2 text-[12px]">
            {!expanded && hasMore && (
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
              className="rounded-md object-cover w-full h-auto max-h-40 outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tag rows (commit-log) ──────────────────────────────────────

function TagItem({ item, index }: { item: TagListItem<CollectionReleaseItemView>; index: number }) {
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

function CommitLogRow({ release }: { release: CollectionReleaseItemView }) {
  const [expanded, setExpanded] = useState(false);
  const versionLabel = release.version ?? release.title;
  // Prefer the server-resolved group name (#1234); fall back to deriving it
  // from product ?? source for older API responses that omit `groupName`.
  // Falling back to the source name beats an empty dash for standalone sources.
  const productLabel = release.groupName ?? release.product?.name ?? release.source.name;
  // Expand reveals the full body, fetched on demand — so it needs both a body
  // and an id to fetch by. The raw content/summary fields are stripped from
  // this timeline's payload (#1918), so `hasBody` arrives precomputed
  // server-side (presence, not "exceeds excerpt").
  const hasBody = !!release.hasBody;
  const thumbnail = findThumbnail(release);
  // Plain-text AI summary for the always-visible inline preview line — never
  // HTML-rendered (distinct from `bodyHtml`, which backs the expanded body).
  const inlineSummary = release.summaryText ?? "";

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
            className="rounded-md object-cover w-14 h-8 outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
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
          <CardBody release={release} expanded />
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
