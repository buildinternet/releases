"use client";

import Link from "next/link";

/**
 * Shared client fallback for segment `error.tsx` boundaries.
 *
 * Intentionally does NOT import the full site Header — that tree pulls
 * `server-only` helpers (`isLocalAdminEnabled`) and can't render inside a
 * client error boundary. A minimal brand link keeps navigation available so
 * a failed data load doesn't feel like a full app crash.
 */
export function RouteErrorFallback({
  reset,
  title = "Something went wrong",
  message = "This page couldn't load. The API may be temporarily unavailable, or a recent deploy is still catching up.",
}: {
  reset: () => void;
  title?: string;
  message?: string;
  /** @deprecated No longer used — Header isn't safe in client error boundaries. */
  showHeader?: boolean;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 px-6 py-4 dark:border-stone-800">
        <Link
          href="/"
          className="text-base font-bold tracking-tight text-stone-900 dark:text-stone-100"
        >
          releases.sh
        </Link>
      </header>
      <div className="mx-auto flex max-w-lg flex-col items-center px-6 py-16 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
          Error
        </p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          {title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-stone-500 dark:text-stone-400">{message}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex min-h-9 items-center rounded-full bg-stone-900 px-4 text-sm font-medium text-white transition-colors hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
          >
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex min-h-9 items-center rounded-full px-4 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800/60 dark:hover:text-stone-100"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
