"use client";

import { useCallback, useEffect, useRef } from "react";

interface UseInfiniteScrollOptions {
  /** Whether more pages exist. */
  hasMore: boolean;
  /** True while a fetch is in flight. Used to gate auto-fires. */
  loading: boolean;
  /**
   * Should be idempotent against re-entry — the hook also locks a `loadingRef`
   * synchronously before invoking, so the consumer's own setState-loading flip
   * isn't relied on to prevent duplicate fires within the same task.
   */
  onLoadMore: () => void;
  /**
   * IO root margin. Only the **vertical** component is used by the fallback
   * viewport check, and the string is expected in `"<v>px <h>px"` form.
   */
  rootMargin?: string;
}

/**
 * Attaches an IntersectionObserver to a sentinel element (button or div) and
 * invokes `onLoadMore` when it enters the viewport. Returns a callback ref —
 * pass it as the `ref` prop on the element. The callback form is what handles
 * sentinel remounts (e.g. when the consumer briefly unmounts the list during
 * a filter refetch); a `RefObject` wouldn't trigger re-observation.
 */
export function useInfiniteScroll<T extends HTMLElement = HTMLDivElement>({
  hasMore,
  loading,
  onLoadMore,
  rootMargin = "600px 0px",
}: UseInfiniteScrollOptions) {
  const onLoadMoreRef = useRef(onLoadMore);
  const hasMoreRef = useRef(hasMore);
  // `loadingRef` is the *synchronous* in-flight lock — it's set true by
  // `fireLoadMore` before invoking the consumer (which then calls setState),
  // so a second intersection event in the same task can't slip through before
  // React commits the consumer's `loading=true`. The no-deps mirror below
  // resyncs it from the prop after every render, which is safe because
  // setState batching keeps the lock-set and the prop-set in the same commit.
  const loadingRef = useRef(loading);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
    hasMoreRef.current = hasMore;
    loadingRef.current = loading;
  });

  const fireLoadMore = useCallback(() => {
    if (loadingRef.current || !hasMoreRef.current) return;
    loadingRef.current = true;
    onLoadMoreRef.current();
  }, []);

  const elementRef = useRef<T | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const sentinelRef = useCallback(
    (el: T | null) => {
      elementRef.current = el;
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!el) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) fireLoadMore();
        },
        { rootMargin },
      );
      observer.observe(el);
      observerRef.current = observer;
    },
    [rootMargin, fireLoadMore],
  );

  // IntersectionObserver only fires on threshold changes, so if a freshly
  // appended page is short enough that the sentinel stays in view we'd stall
  // until the user scrolled. After every `loading=false` transition, re-check
  // the sentinel's viewport position and fire again if it's still inside the
  // pre-load margin. `fireLoadMore` re-asserts the guard so this can't race
  // the in-flight lock.
  useEffect(() => {
    if (loading || !hasMore) return;
    const el = elementRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = parseInt(rootMargin, 10) || 0;
    const viewportBottom = window.innerHeight + margin;
    if (rect.top < viewportBottom && rect.bottom > -margin) {
      fireLoadMore();
    }
  }, [loading, hasMore, rootMargin, fireLoadMore]);

  return sentinelRef;
}
