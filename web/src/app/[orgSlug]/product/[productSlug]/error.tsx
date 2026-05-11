"use client";

export default function ProductPageError({
  error: _error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 pt-24 text-center">
        <p className="text-[15px] text-stone-500 dark:text-stone-400 mb-6">
          Couldn&apos;t load this product page. The API may be temporarily unavailable.
        </p>
        <button
          onClick={reset}
          className="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 underline underline-offset-4"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
