export function RouteErrorFallback({ reset }: { reset: () => void }) {
  return (
    <div className="py-12 text-center">
      <p className="text-sm text-stone-500 dark:text-stone-400 mb-4">
        Couldn&apos;t load releases. The API may be temporarily unavailable.
      </p>
      <button
        onClick={reset}
        className="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 underline underline-offset-4"
      >
        Try again
      </button>
    </div>
  );
}
