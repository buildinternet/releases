import Link from "next/link";

/**
 * Breadcrumb root: house icon instead of the word "Home". Still a real link
 * with an accessible name; the icon is decorative.
 */
export function BreadcrumbHome({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="Home"
      title="Home"
      className={`inline-flex items-center transition-colors hover:text-[var(--fg-2)] ${className}`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
      >
        <path
          d="M2.5 7.25 8 2.5l5.5 4.75V13.5a.75.75 0 0 1-.75.75H9.5V10.5H6.5v3.75H3.25a.75.75 0 0 1-.75-.75V7.25Z"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinejoin="round"
        />
      </svg>
    </Link>
  );
}
