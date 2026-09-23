import Link from "next/link";

/**
 * Prev/next digest cards — reuses the related-rail card chrome so adjacent
 * weeks read like the "More from / From other products" cards on release pages.
 */

const CARD_CLASS =
  "flex h-full flex-col gap-1 rounded-lg border border-stone-200 bg-white p-3 transition-colors hover:border-stone-300 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-600";
const EYEBROW_CLASS =
  "text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400";
const HEADLINE_CLASS =
  "text-balance text-[14px] font-semibold text-stone-900 dark:text-stone-100 line-clamp-2";

export type DigestAdjacentItem = {
  href: string;
  weekLabel: string;
  title: string;
};

export function DigestAdjacentNav({
  prev,
  next,
}: {
  prev: DigestAdjacentItem | null;
  next: DigestAdjacentItem | null;
}) {
  if (!prev && !next) return null;

  return (
    <nav
      aria-label="Adjacent digests"
      className="mt-12 border-t border-stone-200 pt-6 dark:border-stone-800"
    >
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {prev ? (
          <li>
            <Link href={prev.href} className={CARD_CLASS}>
              <span className={EYEBROW_CLASS}>← Previous week</span>
              <span className="text-[11px] text-stone-400 dark:text-stone-500">
                {prev.weekLabel}
              </span>
              <span className={HEADLINE_CLASS}>{prev.title}</span>
            </Link>
          </li>
        ) : (
          <li className="hidden sm:block" aria-hidden />
        )}
        {next ? (
          <li className={prev ? "" : "sm:col-start-2"}>
            <Link href={next.href} className={`${CARD_CLASS} sm:items-end sm:text-right`}>
              <span className={EYEBROW_CLASS}>Next week →</span>
              <span className="text-[11px] text-stone-400 dark:text-stone-500">
                {next.weekLabel}
              </span>
              <span className={HEADLINE_CLASS}>{next.title}</span>
            </Link>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
