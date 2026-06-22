"use client";

import { type Ref } from "react";

interface InfiniteScrollTriggerProps {
  /** Callback ref from `useInfiniteScroll`. */
  triggerRef: Ref<HTMLButtonElement>;
  loading: boolean;
  error: boolean;
  onClick: () => void;
}

/**
 * Trailing "Load more" button that doubles as the IO sentinel for
 * `useInfiniteScroll`. The button preserves the prior visual + gives keyboard
 * users a tab-stop to advance the list; IO auto-clicks it when scrolled into
 * view. Errors collapse to a Retry label so failed fetches don't loop.
 */
export function InfiniteScrollTrigger({
  triggerRef,
  loading,
  error,
  onClick,
}: InfiniteScrollTriggerProps) {
  return (
    <div className="text-center py-6">
      <button
        ref={triggerRef}
        type="button"
        onClick={onClick}
        disabled={loading}
        className="px-5 py-2 text-[13px] font-medium text-stone-500 dark:text-stone-400 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-md hover:border-stone-300 dark:hover:border-stone-600 transition-[color,border-color,transform] active:scale-[0.96] disabled:opacity-50"
      >
        {error ? "Retry" : loading ? "Loading..." : "Load more"}
      </button>
    </div>
  );
}
