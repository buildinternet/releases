"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { useFollows } from "@/components/follows-provider";
import { OrgAvatar } from "@/components/org-avatar";
import { InfiniteScrollTrigger } from "@/components/infinite-scroll-trigger";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { listFollows, getFeed } from "@/lib/follows";
import { formatRelativeDate, pluralReleases } from "@/lib/formatters";
import { FeedTokenCard } from "./feed-token-card";
import type { Follow, ReleaseLatestItem } from "@buildinternet/releases-api-types";

const FEED_PAGE_SIZE = 30;

// Avatar/name resolved from the follows list for a release's owning org.
interface OrgChip {
  name: string;
  avatarUrl: string | null;
}

// ── Day grouping (mirrors collection-timeline's local helpers; kept
//    self-contained so we don't reach into that component's internals) ──

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

interface DayBucket {
  key: string;
  iso: string | null;
  items: ReleaseLatestItem[];
}

function groupByDay(items: ReleaseLatestItem[]): DayBucket[] {
  const out: DayBucket[] = [];
  let current: DayBucket | null = null;
  for (const item of items) {
    const k = dayKey(item.publishedAt);
    if (!current || current.key !== k) {
      current = { key: k, iso: item.publishedAt, items: [] };
      out.push(current);
    }
    current.items.push(item);
  }
  return out;
}

export function FollowingClient() {
  const { data: session, isPending } = useSession();
  const follows = useFollows();

  const [feedItems, setFeedItems] = useState<ReleaseLatestItem[]>([]);
  const [followsList, setFollowsList] = useState<Follow[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial load: follows + first feed page.
  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([listFollows(), getFeed(1, FEED_PAGE_SIZE)])
      .then(([fl, feedResp]) => {
        if (cancelled) return;
        setFollowsList(fl);
        setFeedItems(feedResp.items);
        setPage(1);
        setHasMore(feedResp.pagination.hasMore);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load your feed.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError(null);
    const next = page + 1;
    try {
      const resp = await getFeed(next, FEED_PAGE_SIZE);
      setFeedItems((prev) => [...prev, ...resp.items]);
      setPage(next);
      setHasMore(resp.pagination.hasMore);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load more.");
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, page]);

  // IntersectionObserver auto-load + a keyboard-reachable trailing button,
  // shared with the collection/category timelines.
  const triggerRef = useInfiniteScroll<HTMLButtonElement>({
    hasMore,
    loading: loadingMore,
    onLoadMore: () => void loadMore(),
  });

  // Map org-slug → { name, avatarUrl } from the follows list so each release's
  // byline can show a logo without a backend join. Org follows key by their own
  // slug with the org's name/avatar; product follows fall back to keying by
  // their parent `orgSlug` with the product's own name/avatar (we don't carry
  // the org's), used only until an org follow supplies a better chip.
  const orgChips = useMemo(() => {
    const m = new Map<string, OrgChip>();
    for (const f of followsList) {
      if (f.targetType === "org") {
        m.set(f.slug, { name: f.name, avatarUrl: f.avatarUrl });
      } else if (f.orgSlug && !m.has(f.orgSlug)) {
        // Product follow: we have the product's avatar/name but the row resolves
        // by the owning org slug. Use the product avatar/name as a best-effort
        // chip for that org until an org follow supplies a better one.
        m.set(f.orgSlug, { name: f.name, avatarUrl: f.avatarUrl });
      }
    }
    return m;
  }, [followsList]);

  const days = useMemo(() => groupByDay(feedItems), [feedItems]);

  if (isPending) {
    return <p className="py-12 text-sm text-stone-400 dark:text-stone-500">Loading…</p>;
  }

  if (!session?.user) {
    return (
      <div className="py-12">
        <h1 className="text-[34px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
          Following
        </h1>
        <p className="mt-3 text-[15px] text-stone-500 dark:text-stone-400">
          <Link
            href="/account"
            className="underline underline-offset-2 hover:text-stone-700 dark:hover:text-stone-300"
          >
            Sign in
          </Link>{" "}
          to see your personalized release feed.
        </p>
      </div>
    );
  }

  return (
    <div className="pb-16">
      {/* Header treatment — mirrors the collection page shell. */}
      <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
        <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">
          Home
        </Link>
        <span className="mx-1.5">/</span>
        <span className="font-medium text-stone-600 dark:text-stone-300">Following</span>
      </div>

      <h1 className="mt-4 text-[34px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
        Following
      </h1>
      <p className="mt-1 text-[15px] text-stone-500 dark:text-stone-400">
        Releases from the organizations and products you follow.
      </p>

      <div className="mt-8 grid gap-8 md:grid-cols-[1fr_260px]">
        {/* Left: timeline feed */}
        <section className="min-w-0">
          {loading && <p className="text-sm text-stone-400 dark:text-stone-500">Loading…</p>}

          {error && feedItems.length === 0 && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          {!loading && !error && feedItems.length === 0 && (
            <div className="rounded-lg border border-stone-200 bg-white px-5 py-10 text-center dark:border-stone-800 dark:bg-stone-900">
              <p className="text-sm text-stone-500 dark:text-stone-400">
                {followsList.length === 0
                  ? "You're not following any organizations or products yet."
                  : "No releases yet from the organizations and products you follow."}
              </p>
              <Link
                href="/"
                className="mt-3 inline-block text-[13px] text-stone-600 underline underline-offset-2 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-200"
              >
                Browse the catalog
              </Link>
            </div>
          )}

          {feedItems.length > 0 && (
            <div>
              {days.map((day) => (
                <DaySection key={day.key} day={day} orgChips={orgChips} />
              ))}

              {error && (
                <p className="mt-4 text-center text-[12px] text-amber-700 dark:text-amber-400">
                  {error}
                </p>
              )}

              {hasMore && (
                <InfiniteScrollTrigger
                  triggerRef={triggerRef}
                  loading={loadingMore}
                  error={!!error}
                  onClick={() => void loadMore()}
                />
              )}
            </div>
          )}
        </section>

        {/* Right: feed card + manage follows */}
        <aside className="space-y-6">
          <FeedTokenCard />

          <div>
            <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
              Your follows
            </h2>

            {followsList.length === 0 && !loading ? (
              <p className="text-sm text-stone-400 dark:text-stone-500">
                Not following anything yet.
              </p>
            ) : (
              <ul className="space-y-1">
                {followsList.map((f) => (
                  <FollowRow
                    key={`${f.targetType}:${f.targetId}`}
                    follow={f}
                    onUnfollow={async () => {
                      // Optimistically drop from the sidebar; restore on failure so
                      // the local list stays in sync with the provider's rollback.
                      setFollowsList((prev) =>
                        prev.filter(
                          (x) => !(x.targetType === f.targetType && x.targetId === f.targetId),
                        ),
                      );
                      try {
                        await follows?.toggle(f.targetType, f.targetId);
                      } catch {
                        setFollowsList((prev) => [...prev, f]);
                      }
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── Day section ──────────────────────────────────────────────────

function DaySection({ day, orgChips }: { day: DayBucket; orgChips: Map<string, OrgChip> }) {
  return (
    <section className="mt-6 first:mt-0">
      <div className="flex items-baseline gap-3 border-b border-stone-200 pb-2 pt-2 dark:border-stone-800">
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
        <span className="font-mono text-[11px] tabular-nums text-stone-400 dark:text-stone-500">
          {day.items.length} {pluralReleases(day.items.length)}
        </span>
      </div>

      <ul className="mt-3 flex flex-col gap-3">
        {day.items.map((item) => (
          <FeedRow key={item.id} item={item} orgChips={orgChips} />
        ))}
      </ul>
    </section>
  );
}

// ── Feed row ─────────────────────────────────────────────────────

function FeedRow({ item, orgChips }: { item: ReleaseLatestItem; orgChips: Map<string, OrgChip> }) {
  const displayTitle = item.titleShort ?? item.titleGenerated ?? item.title;
  const bylineName = item.product?.name ?? item.source.name;
  const orgSlug = item.source.orgSlug;
  const chip = orgSlug ? orgChips.get(orgSlug) : undefined;
  const bylineHref = orgSlug ? `/${orgSlug}/${item.product?.slug ?? item.source.slug}` : null;

  return (
    <li className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <Link
        href={`/release/${item.id}`}
        className="text-[15px] font-semibold leading-snug text-stone-900 underline-offset-2 hover:underline dark:text-stone-100"
      >
        {displayTitle}
      </Link>

      {item.summary && (
        <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-stone-500 dark:text-stone-400">
          {item.summary}
        </p>
      )}

      <div className="mt-2.5 flex items-center gap-2 text-[12px] text-stone-400 dark:text-stone-500">
        <OrgAvatar
          avatarUrl={chip?.avatarUrl ?? null}
          githubHandle={null}
          name={chip?.name ?? bylineName}
          size={18}
        />
        {bylineHref ? (
          <Link
            href={bylineHref}
            className="font-medium text-stone-600 hover:text-stone-900 dark:text-stone-300 dark:hover:text-stone-100"
          >
            {bylineName}
          </Link>
        ) : (
          <span className="font-medium text-stone-600 dark:text-stone-300">{bylineName}</span>
        )}
        {item.publishedAt && (
          <>
            <span aria-hidden>·</span>
            <time dateTime={item.publishedAt}>{formatRelativeDate(item.publishedAt)}</time>
          </>
        )}
      </div>
    </li>
  );
}

// ── Follow row (sidebar chip) ────────────────────────────────────

function FollowRow({
  follow: f,
  onUnfollow,
}: {
  follow: Follow;
  onUnfollow: () => void | Promise<void>;
}) {
  const href = f.targetType === "product" && f.orgSlug ? `/${f.orgSlug}/${f.slug}` : `/${f.slug}`;

  return (
    <li className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900">
      <Link href={href} className="flex min-w-0 items-center gap-2">
        <OrgAvatar avatarUrl={f.avatarUrl} githubHandle={null} name={f.name} size={20} />
        <span className="min-w-0 truncate text-sm text-stone-700 group-hover:text-stone-900 dark:text-stone-300 dark:group-hover:text-stone-100">
          {f.name}
          {f.targetType === "product" && f.orgSlug && (
            <span className="font-normal text-stone-400 dark:text-stone-500"> · {f.orgSlug}</span>
          )}
        </span>
      </Link>
      <button
        type="button"
        onClick={() => void onUnfollow()}
        aria-label={`Unfollow ${f.name}`}
        className="shrink-0 text-[12px] text-stone-400 opacity-0 transition-opacity hover:text-stone-700 group-hover:opacity-100 focus-visible:opacity-100 dark:text-stone-500 dark:hover:text-stone-300"
      >
        Unfollow
      </button>
    </li>
  );
}
