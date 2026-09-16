import { cn } from "@/lib/utils";

/** Hide the UA search-cancel control, which sits after the typed text. */
export const SEARCH_NATIVE_CANCEL_HIDDEN =
  "[&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden [&::-moz-search-clear-button]:hidden [&::-ms-clear]:hidden";

/**
 * Right-edge clear affordance for our `type="search"` boxes. Mount only when
 * the field is non-empty. `onMouseDown` preventDefault keeps the input
 * focused so the caret doesn't flicker.
 */
export function SearchClearButton({
  onClear,
  className,
}: {
  onClear: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label="Clear search"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClear}
      className={cn(
        "absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1 text-stone-400 transition-colors hover:text-stone-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 dark:text-stone-500 dark:hover:text-stone-300 dark:focus-visible:ring-stone-500 [&_svg]:h-4 [&_svg]:w-4",
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  );
}
