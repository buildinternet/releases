"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { useFollows } from "@/components/follows-provider";
import { listFollows, getFeed } from "@/lib/follows";
import { formatDate } from "@/lib/formatters";
import type { Follow, ReleaseLatestItem } from "@buildinternet/releases-api-types";

export function FollowingClient() {
  const { data: session, isPending } = useSession();
  const follows = useFollows();

  const [feedItems, setFeedItems] = useState<ReleaseLatestItem[]>([]);
  const [followsList, setFollowsList] = useState<Follow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.user) return;
    setLoading(true);
    setError(null);
    Promise.all([listFollows(), getFeed(1, 30)])
      .then(([fl, feedResp]) => {
        setFollowsList(fl);
        setFeedItems(feedResp.items);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load your feed.");
      })
      .finally(() => setLoading(false));
  }, [session?.user?.id]);

  if (isPending) {
    return <p className="text-stone-400 dark:text-stone-500 text-sm">Loading…</p>;
  }

  if (!session?.user) {
    return (
      <p className="text-stone-500 dark:text-stone-400 text-sm">
        <Link
          href="/account"
          className="underline underline-offset-2 hover:text-stone-700 dark:hover:text-stone-300"
        >
          Sign in
        </Link>{" "}
        to see your personalized release feed.
      </p>
    );
  }

  return (
    <div className="grid gap-8 md:grid-cols-[1fr_260px]">
      {/* Left: feed */}
      <section>
        <h1 className="text-xl font-semibold text-stone-900 dark:text-stone-100 mb-6">Following</h1>

        {loading && <p className="text-stone-400 dark:text-stone-500 text-sm">Loading…</p>}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {!loading && !error && feedItems.length === 0 && (
          <p className="text-stone-400 dark:text-stone-500 text-sm">
            Follow some organizations or products to build your feed.
          </p>
        )}

        {!loading && feedItems.length > 0 && (
          <ul className="divide-y divide-stone-200 dark:divide-stone-800">
            {feedItems.map((item) => (
              <FeedRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>

      {/* Right: manage follows */}
      <aside>
        <h2 className="text-sm font-semibold text-stone-700 dark:text-stone-300 mb-4 uppercase tracking-wide">
          Your follows
        </h2>

        {followsList.length === 0 && !loading ? (
          <p className="text-stone-400 dark:text-stone-500 text-sm">Not following anything yet.</p>
        ) : (
          <ul className="space-y-2">
            {followsList.map((f) => (
              <FollowRow
                key={`${f.targetType}:${f.targetId}`}
                follow={f}
                onUnfollow={() => {
                  follows?.toggle(f.targetType, f.targetId).catch(() => {
                    /* ignore — provider handles rollback */
                  });
                  setFollowsList((prev) =>
                    prev.filter(
                      (x) => !(x.targetType === f.targetType && x.targetId === f.targetId),
                    ),
                  );
                }}
              />
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

function FeedRow({ item }: { item: ReleaseLatestItem }) {
  const displayTitle = item.titleShort ?? item.titleGenerated ?? item.title;
  const bylineName = item.product?.name ?? item.source.name;
  const bylineHref = item.source.orgSlug
    ? `/${item.source.orgSlug}/${item.product?.slug ?? item.source.slug}`
    : null;

  return (
    <li className="py-3">
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <Link
          href={`/release/${item.id}`}
          className="font-semibold text-[15px] text-stone-900 dark:text-stone-100 hover:underline underline-offset-2"
        >
          {displayTitle}
        </Link>
      </div>

      {item.summary && (
        <p className="mt-0.5 text-[13px] text-stone-500 dark:text-stone-400 line-clamp-2 leading-relaxed">
          {item.summary}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2 text-[12px] text-stone-400 dark:text-stone-500">
        {item.publishedAt && (
          <time dateTime={item.publishedAt}>{formatDate(item.publishedAt)}</time>
        )}
        {bylineName && (
          <>
            <span aria-hidden>·</span>
            {bylineHref ? (
              <Link href={bylineHref} className="hover:text-stone-600 dark:hover:text-stone-300">
                {bylineName}
              </Link>
            ) : (
              <span>{bylineName}</span>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function FollowRow({ follow: f, onUnfollow }: { follow: Follow; onUnfollow: () => void }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="text-sm text-stone-700 dark:text-stone-300 truncate">{f.name}</span>
      <button
        type="button"
        onClick={onUnfollow}
        className="shrink-0 text-[12px] text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors"
      >
        Unfollow
      </button>
    </li>
  );
}
