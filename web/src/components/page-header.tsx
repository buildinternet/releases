import Link from "next/link";

export type Crumb = { label: string; href?: string };

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
      <nav aria-label="Breadcrumb" className="text-[13px] text-stone-400 dark:text-stone-500 mb-4">
        <ol className="flex flex-wrap items-center">
          {breadcrumb.map((c, i) => {
            const isLast = i === breadcrumb.length - 1;
            return (
              <li key={`${c.label}-${i}`} className="flex items-center">
                {i > 0 && (
                  <span aria-hidden="true" className="mx-1.5">
                    /
                  </span>
                )}
                {c.href && !isLast ? (
                  <Link href={c.href} className="hover:text-stone-600 dark:hover:text-stone-300">
                    {c.label}
                  </Link>
                ) : (
                  <span
                    aria-current={isLast ? "page" : undefined}
                    className={
                      isLast ? "text-stone-600 dark:text-stone-300 font-medium" : undefined
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
      <h1 className="text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100 mb-2">
        {title}
      </h1>
      <p className="text-sm text-stone-600 dark:text-stone-400 mb-8">{description}</p>
    </>
  );
}
