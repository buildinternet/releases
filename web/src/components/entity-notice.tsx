import Link from "next/link";
import type { Notice } from "@buildinternet/releases-core/notice";

/**
 * Small curator-set advisory shown on org / product / source pages. Renders an
 * optional pointer — an internal registry coordinate ("org" / "org/slug") as a
 * Next Link, or an external URL. SVG icon only (no emoji, per the web UI
 * convention). Renders nothing when there is no notice.
 */
export function EntityNotice({ notice }: { notice?: Notice | null }) {
  if (!notice) return null;
  const internalHref = notice.coordinate ? `/${notice.coordinate}` : null;
  const label = notice.linkText ?? notice.coordinate ?? notice.href ?? null;
  return (
    <div className="mt-4 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-[13px] text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300">
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 flex-shrink-0 opacity-70"
      >
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9a1 1 0 012 0v4a1 1 0 11-2 0V9zm1-4a1 1 0 100 2 1 1 0 000-2z"
          clipRule="evenodd"
        />
      </svg>
      <span>
        {notice.message}
        {internalHref && label ? (
          <>
            {" "}
            <Link
              href={internalHref}
              className="font-medium underline underline-offset-2 hover:no-underline"
            >
              {label}
            </Link>
          </>
        ) : notice.href && label ? (
          <>
            {" "}
            <a
              href={notice.href}
              rel="noopener noreferrer"
              className="font-medium underline underline-offset-2 hover:no-underline"
            >
              {label}
            </a>
          </>
        ) : null}
      </span>
    </div>
  );
}
