import Link from "next/link";

export type Crumb = { label: string; href?: string };

/**
 * Page title block with a parent-trail breadcrumb. Pass only ancestors —
 * the H1 is the current page and should not be repeated as a leaf crumb.
 * A final crumb without `href` is treated as current (rare leaf case).
 * JSON-LD `BreadcrumbList` is separate and should still include the current page.
 */
export function PageHeader({
  breadcrumb,
  title,
  description,
}: {
  breadcrumb: Crumb[];
  title: string;
  description: string;
}) {
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4 text-[13px] text-stone-400 dark:text-stone-500">
        <ol className="flex flex-wrap items-center">
          {breadcrumb.map((c, i) => {
            const isCurrent = i === breadcrumb.length - 1 && !c.href;
            return (
              <li key={`${c.label}-${i}`} className="flex items-center">
                {i > 0 && (
                  <span aria-hidden="true" className="mx-1.5">
                    /
                  </span>
                )}
                {c.href ? (
                  <Link href={c.href} className="hover:text-stone-600 dark:hover:text-stone-300">
                    {c.label}
                  </Link>
                ) : (
                  <span
                    aria-current={isCurrent ? "page" : undefined}
                    className={
                      isCurrent ? "font-medium text-stone-600 dark:text-stone-300" : undefined
                    }
                  >
                    {c.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <h1 className="mb-2 text-balance text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100">
        {title}
      </h1>
      <p className="mb-8 max-w-[65ch] text-pretty text-sm text-stone-600 dark:text-stone-400">
        {description}
      </p>
    </>
  );
}
