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
} from "@/lib/api";
import { memberKey } from "@/lib/member-key";
import { tabButtonClass } from "@/lib/styles";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { InfiniteScrollTrigger } from "./infinite-scroll-trigger";

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
}

function memberAvatar(m: CollectionMember) {
  return m.kind === "org"
    ? { avatarUrl: m.avatarUrl, githubHandle: m.githubHandle, name: m.name }
    : { avatarUrl: m.org.avatarUrl, githubHandle: m.org.githubHandle, name: m.org.name };
}

type TypeFilter = "all" | "tag" | "post";

// GitHub releases are tag drops; everything else (RSS, scrape, agent, atom)
// is treated as a marketing post and gets the richer hero treatment. The
// server understands these as `source_type` values directly — see
// `sourceTypesForFilter` below.
function isTag(r: CollectionReleaseItem): boolean {
  return r.source.type === "github";
}

// Map the UI's tag/post toggle to the set of `source_type` values the server
// accepts. Kept here so the renderer's tag/post split (everything-but-github
// = post) stays in lockstep with the server-side narrowing.
function sourceTypesForFilter(filter: TypeFilter): string | null {
  if (filter === "tag") return "github";
  if (filter === "post") return "feed,scrape,agent";
  return null;
}

const dayKey = (iso: string | null) => (iso ? iso.slice(0, 10) : "unknown");

function fmtWeekday(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}
function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
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

function pluralReleases(n: number): string {
  return n === 1 ? "release" : "releases";
}

export function CollectionTimeline({
  fetchEndpoint,
  formatPath,
  initialReleases,
  initialCursor,
  members,
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
            <DaySection key={day.key} day={day} orgsBySlug={orgsBySlug} />
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

type TagListItem =
  | { kind: "single"; release: CollectionReleaseItem }
  | {
      kind: "rollup";
      productSlug: string;
      productName: string;
      orgSlug: string;
      latest: CollectionReleaseItem;
      older: CollectionReleaseItem[];
      rollupId: string;
    };

// Within a list of tag releases, collapse 2+ same-product tags into a
// rollup. Posts and lone tags stay as singles.
function rollupSameProduct(tags: CollectionReleaseItem[], scopeKey: string): TagListItem[] {
  const buckets = new Map<
    string,
    { productSlug: string; productName: string; orgSlug: string; releases: CollectionReleaseItem[] }
  >();
  const order: string[] = [];
  const singles: TagListItem[] = [];

  for (const r of tags) {
    if (r.product) {
      const k = `${r.org.slug}::${r.product.slug}`;
      if (!buckets.has(k)) {
        buckets.set(k, {
          productSlug: r.product.slug,
          productName: r.product.name,
          orgSlug: r.org.slug,
          releases: [],
        });
        order.push(k);
      }
      buckets.get(k)!.releases.push(r);
    } else {
      singles.push({ kind: "single", release: r });
    }
  }

  const out: TagListItem[] = [];
  for (const k of order) {
    const b = buckets.get(k)!;
    if (b.releases.length >= 2) {
      const [latest, ...older] = b.releases;
      out.push({
        kind: "rollup",
        productSlug: b.productSlug,
        productName: b.productName,
        orgSlug: b.orgSlug,
        latest,
        older,
        rollupId: `rollup:${scopeKey}:${k}`,
      });
    } else {
      out.push({ kind: "single", release: b.releases[0] });
    }
  }
  // Append no-product singles after rollups so contiguous product groups
  // surface together.
  return [...out, ...singles];
}

// ── Day section ─────────────────────────────────────────────────

function DaySection({
  day,
  orgsBySlug,
}: {
  day: DayBucket;
  orgsBySlug: Map<string, CollectionMemberOrg>;
}) {
  const orgGroups = groupByOrg(day.releases);
  return (
    <section className="mt-6">
      <div className="flex items-baseline gap-3 pt-2 pb-2 border-b border-stone-200 dark:border-stone-800">
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
      <div className="flex flex-col gap-4 mt-4">
        {orgGroups.map((g) => (
          <OrgSection
            key={g.orgSlug}
            group={g}
            scopeKey={day.key}
            orgMeta={orgsBySlug.get(g.orgSlug)}
          />
        ))}
      </div>
    </section>
  );
}

function OrgSection({
  group,
  scopeKey,
  orgMeta,
}: {
  group: { orgSlug: string; orgName: string; releases: CollectionReleaseItem[] };
  scopeKey: string;
  orgMeta?: CollectionMemberOrg;
}) {
  const posts = group.releases.filter((r) => !isTag(r));
  const tags = group.releases.filter((r) => isTag(r));
  const tagItems = useMemo(
    () => rollupSameProduct(tags, `${scopeKey}:${group.orgSlug}`),
    [tags, scopeKey, group.orgSlug],
  );

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
        {posts.map((r) => (
          <PostHero key={r.id ?? r.url ?? r.title} release={r} />
        ))}

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
  return item.rollupId;
}

// ── Post hero ──────────────────────────────────────────────────

function PostHero({ release }: { release: CollectionReleaseItem }) {
  const [expanded, setExpanded] = useState(false);
  const thumbnail = findThumbnail(release);
  const heading = release.title || release.version || "Release";
  // Render the full body when available so "Show more" actually reveals new
  // content. The collapsed view is height-capped via line-clamp; expanded
  // unlocks it.
  const body = release.content || release.summary || "";

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
        <div
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
          {!expanded && (
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-white dark:from-stone-900 to-transparent" />
          )}
        </div>
        <div className="flex items-center gap-3 mt-3 text-[12px]">
          <button type="button" onClick={() => setExpanded((v) => !v)} className={subduedLinkClass}>
            {expanded ? "Show less" : "Show more"}
          </button>
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

  return (
    <>
      <div className={topBorder}>
        <CommitLogRow release={item.latest} />
      </div>
      <div className="border-t border-dashed border-stone-200 dark:border-stone-800 bg-stone-50/60 dark:bg-stone-950/40">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`flex items-center gap-2 w-full text-left py-1.5 px-3 text-[12px] ${subduedLinkClass}`}
        >
          <Caret open={open} />
          <span>
            {open
              ? `Hide ${item.older.length} earlier ${item.productName} ${pluralReleases(item.older.length)}`
              : `${item.older.length} earlier ${item.productName} ${pluralReleases(item.older.length)} today`}
          </span>
          {!open && (
            <span className="inline-flex items-center gap-1 ml-1 flex-wrap">
              {item.older.slice(0, 4).map((r) => (
                <span
                  key={r.id ?? r.url ?? r.title}
                  className="font-mono text-[10.5px] px-1.5 py-px rounded bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-500 dark:text-stone-400 whitespace-nowrap"
                >
                  {r.version ?? r.title}
                </span>
              ))}
              {item.older.length > 4 && (
                <span className="text-[11px] text-stone-400 dark:text-stone-500">
                  +{item.older.length - 4}
                </span>
              )}
            </span>
          )}
        </button>
      </div>
      {open &&
        item.older.map((r) => (
          <div
            key={r.id ?? r.url ?? r.title}
            className="border-t border-stone-200 dark:border-stone-800 border-l-2 border-l-stone-300 dark:border-l-stone-700"
          >
            <CommitLogRow release={r} />
          </div>
        ))}
    </>
  );
}

function CommitLogRow({ release }: { release: CollectionReleaseItem }) {
  const [expanded, setExpanded] = useState(false);
  const versionLabel = release.version ?? release.title;
  // Fall back to source name when an org/source isn't bound to a product
  // (single-product orgs and standalone sources). Beats an empty dash.
  const productLabel = release.product?.name ?? release.source.name;
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

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 9 9"
      fill="none"
      aria-hidden="true"
      className="flex-none transition-transform"
      style={{ transform: open ? "rotate(90deg)" : "none" }}
    >
      <path
        d="M2.5 1.5 L6 4.5 L2.5 7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
